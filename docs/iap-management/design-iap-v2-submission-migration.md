# Design: IAP Submission Migration to reviewSubmissions (v2) + Rate-Limit Fix

Status: **RESOLVED — all blocking empirical questions verified against real Apple API + official docs. Design decisions locked (Manager, 2026-07-17). NO CODE WRITTEN.** A build prompt follows approval.

Scope: One-time IAPs only (consumable / non-consumable / non-renewing-subscription-as-IAP-type). Subscriptions explicitly deferred. Submit mechanism only — IAP images/localizations v1→v2 migration is a separate backlog (§6).

Locked constraint: the old `POST /v1/inAppPurchaseSubmissions` endpoint still works and Apple has not announced a sunset date. This is a **planned, rollback-safe migration** — the new mechanism is added **alongside** the old code behind a toggle, not a replacement.

---

## 0. Resolution summary (2026-07-17 follow-up)

All four blocking empirical questions from §7 are now resolved with evidence. This supersedes the "depends on unverified fact" framing in §5 and the optioned branches in §7 of the original investigation.

| # | Question | Resolution | Evidence |
|---|---|---|---|
| 1 | Does a version pre-exist for `READY_TO_SUBMIT` IAPs? | **Yes.** Confirmed on 5 real IAPs — all had exactly 1 `inAppPurchaseVersion` in `PREPARE_FOR_SUBMISSION`. | Live `GET /v2/inAppPurchases/{id}/versions` against production data, app `com.vng.passsdktest` |
| 2 | One open reviewSubmission per app, or more? | **Up to 2** per (app, platform): one with an app version, one items-only (no app version). CPP and IAP submissions are **both items-only — they share the same single slot.** | Apple official Help: [Overview of submitting for review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review/) |
| 3 | Is an orphaned `inAppPurchaseVersion` harmful? | **Not confirmed either way by Apple.** No DELETE endpoint exists (confirmed via official docs, not just the spec). Circumstantial evidence (sibling `AppStoreVersion` resource rejects a second in-flight version; this repo's own CPP `reviewSubmission` blind-POST already 409s the same way) leans toward treating it as unsafe to ignore. **Design already mitigates this by construction** (fetch-then-reuse, never blind-create — see §4.1), so it doesn't block build, but is not empirically closed. | Apple docs: [Working with In-App Purchase Versions](https://developer.apple.com/documentation/appstoreconnectapi/working-with-in-app-purchase-versions); repo precedent at old §1 |
| 4 | Is 200/submission official, and per what unit? | **Yes — Apple's own literal wording**, stated twice, specifically on the IAP/subscription submission page (not the generic API reference, which has no descriptive text at all). Per-submission, not per-app or per-day. | Apple official Help: [Submit an In-App Purchase](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase/) |

**Net effect on the design:**
- The rate-limit fix **works** — no per-item version-create needed in the common case, so call count drops from `2N` to roughly `N+3` (§5, revised).
- Decision A's conflict dialog is now a **hard requirement**, not a fallback for an unlikely branch — because CPP and IAP share the one items-only submission slot per app, any app actively used for both CPP pages and IAP batches *will* hit this path routinely, not as an edge case.
- Rollout granularity recommendation flips to **per-app dogfood-first** (§4.3, revised) — justified by the combination of (a) confirmed real collision risk with CPP on shared apps, and (b) unresolved orphaned-version risk under partial failure.

---

## 1. CPP's current submission pattern (the reference implementation)

CPP already submits via `reviewSubmissions` / `reviewSubmissionItems`. Two parallel code paths exist in `lib/asc-client.ts`:

- **Legacy all-in-one**: `submitCpps()` (`lib/asc-client.ts:294-348`) — not wired to the current UI, but still a live route (`app/api/asc/cpps/submit/route.ts:13`).
- **Current UI path**: `prepareCppSubmission()` + `confirmCppSubmission()` + `rollbackCppSubmission()` (`lib/asc-client.ts:375-472`), triggered from `components/cpp/CppList.tsx:642` (`handlePrepare`) via `app/api/asc/cpps/submit/{prepare,confirm}/route.ts` and `app/api/asc/cpps/submit/[submissionId]/route.ts`.

### Call sequence (current path)

| Step | Call | File:line |
|---|---|---|
| 1. Create submission | `POST /v1/reviewSubmissions` — `{attributes:{platform:"IOS"}, relationships:{app}}` | `lib/asc-client.ts:380-393` |
| 2. Add items | `POST /v1/reviewSubmissionItems` × N — `{relationships:{reviewSubmission, appCustomProductPageVersion}}`, sequential, 200ms gap, 3 blind retries per item | `lib/asc-client.ts:398-434` |
| 3. Submit | `PATCH /v1/reviewSubmissions/{id}` — `{attributes:{submitted:true}}` | `lib/asc-client.ts:442-458` |
| 4. Rollback (on partial failure) | `DELETE /v1/reviewSubmissions/{id}` | `lib/asc-client.ts:463-472` |

**No find-or-reuse of an existing OPEN reviewSubmission** — both paths always POST a new one (`lib/asc-client.ts:300-313`, `380-393`). If Apple already has an open reviewSubmission for the app, this 409s with no pre-check or recovery — it just surfaces as a generic error.

State gating is **client-side only**: `SUBMITTABLE_STATES` (`components/cpp/CppList.tsx:56`) filters which CPPs can be selected; nothing on the server re-validates version state before calling Apple.

Error surfacing is fragile: `ascFetch` throws a plain `Error` string (`lib/asc-client.ts:74`), and routes do substring sniffing (`message.includes("409")` etc., e.g. `app/api/asc/cpps/submit/route.ts:33-39`) to pick a response status — **none of the CPP routes check for 429**, so a rate-limit error falls through to a generic 500.

### Rate-limit handling: **none**

This is the important finding: CPP's shared fetch primitive, `ascFetch()` (`lib/asc-client.ts:43-82`), has zero rate-limit awareness — it never inspects `res.status === 429`, never reads `Retry-After`, never reads Apple's rate-budget header. The only pacing that exists is:
- `submitCpps` (legacy): unbounded `Promise.all` over all items (`lib/asc-client.ts:317-333`) — no cap at all.
- `prepareCppSubmission` (current): fixed 200ms sleep between items + 3 retries that fire on **any** error, not just 429, with no backoff and no delay between attempts (`lib/asc-client.ts:405-425`).

Neither is real 429 handling. CPP has gotten away with this so far because its submission volumes are small (a handful of CPPs at a time), not because the pattern is sound.

Critically, a **proper** rate-limit wrapper already exists in the codebase — just not used by CPP:

```
lib/iap-management/apple/fetch.ts:1-17 (header comment):
"Separate from lib/asc-client.ts (CPP-side) because Manager Q-IAP.7 requires
429 detection + Retry-After honoring + exponential backoff for IAP bulk
operations... CPP-side ascFetch doesn't have this — its call patterns are
sequential and user-paced."
```

This module provides `AppleRateLimitError` (`fetch.ts:53-66`), `withRetry()` (`fetch.ts:103-134`, backoff ladder `[500,1000,2000]ms` capped at 10s, retries only on 429, honors `Retry-After`), and `iapFetch()` (`fetch.ts:202-270`, the primitive that detects 429 and throws the typed error).

**Types**: `types/asc.ts` has no `ReviewSubmission`/`ReviewSubmissionItem` interfaces at all — every request/response shape in this flow is inline/untyped (`lib/asc-client.ts:300`, `380`).

---

## 2. IAP's current (deprecated) submission — and why 52→9 fails

Entry point: `app/api/iap-management/apps/[appId]/iaps/submit-batch/route.ts` — two-phase (`execute:false` preflight, `execute:true` execute).

### Per-item Apple calls

Unlike CPP's bulk container model, the old IAP flow is genuinely **per-item, 2 Apple calls each**:

```
lib/iap-management/apple/client.ts:357-376 — submitInAppPurchase()
  POST /v1/inAppPurchaseSubmissions
  { relationships: { inAppPurchaseV2: { data: { type:"inAppPurchases", id } } } }
```
called via `withRetry(() => submitInAppPurchase(...))` at `submit-batch/route.ts:333`, immediately followed by a status refetch `withRetry(() => getInAppPurchase(...))` at `route.ts:337-339` (`GET /v2/inAppPurchases/{id}`).

So for N items: **2N Apple calls**, no shared container, no batching primitive at all — every IAP is its own independent submission.

### It already has retry/backoff — and it's still not enough

This module already has what CPP lacks: `iapFetch`/`withRetry`/`AppleRateLimitError` (same file cited above), and bounded concurrency via a hand-rolled worker pool `withConcurrency()` (`lib/iap-management/concurrency.ts:12-35`), set to `SUBMIT_CONCURRENCY = 2` (`submit-batch/route.ts:65`, deliberately cut down from 5 in a prior incident per the route's own header comment).

Yet **there is no inter-item delay** — workers pull the next item immediately when a slot frees, so at concurrency 2 with 2 calls/item, Apple sees a near-continuous stream. When Apple's limiter trips on an item's submit POST, `withRetry` retries 3 times (backoff ladder + `Retry-After`, capped at 10s per sleep) — but if the sustained-budget breach doesn't clear within that window (or Apple gives a longer `Retry-After` than the ladder), the error re-throws, lands in the per-row `catch` (`route.ts:369-387`), and the row is marked **permanently failed** for that batch run — no auto-retry at the batch level, no queued re-drive. Manager has to reselect and resubmit the failed subset manually.

**This is exactly the 52→9 mechanism**: 52 items × 2 calls = up to ~104 Apple calls in one batch window at concurrency 2 with zero pacing between items. When a burst trips Apple's sustained rate budget for that ASC key (shared across all API surfaces, per the module's own prior incident notes), the items unlucky enough to land in that window exhaust their retries and permanently fail — while the rest, spread out by the concurrency cap, squeak through. 9/52 is consistent with a transient budget dip, not a systemic full-outage.

**Key implication for the migration**: IAP submission is *not* failing due to missing retry logic (it has good retry logic already) — it's failing because of **raw call volume** (2N calls, no pacing) against Apple's sustained budget. Any fix must reduce call volume, not just retry harder.

### Other findings (for completeness)

- Standalone single-item route `app/api/iap-management/apps/[appId]/iaps/[iapId]/submit/route.ts:123` hits the same underlying function, independent of the batch path.
- `checkSubmitEligibility` (`lib/iap-management/apple/submit-eligibility.ts:48`) is **not** in the batch-submit call graph — it's used only by the bulk-import create→submit flow (`app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts:65,863`). Batch-submit uses `bucketSelection` (preflight) + `partitionByStateGuard` (execute) directly — same underlying state-guard primitive (`lib/iap-management/submit-batch/bucket.ts:139-157`).
- `SubmitBatchModal.tsx:80` has a stale doc comment claiming concurrency 5 — cosmetic drift worth fixing whenever this file is touched, unrelated to the migration itself.

---

## 3. Spec verification — what the new mechanism actually requires

Verified against `docs/openapi.oas.v20260717.json` (ASC API v4.4.1). Note: this generated spec has **zero description text anywhere** (0/1263 ops, 0/1393 schemas) — everything below is derived from schema/enum structure, not prose, so treat business-rule claims (like item caps) as unconfirmed by this file.

- **`ReviewSubmissionItemCreateRequest.data.relationships`** — confirmed `inAppPurchaseVersion` (→ `inAppPurchaseVersions`) exists as a sibling to `appCustomProductPageVersion` (→ `appCustomProductPageVersions`), alongside `appStoreVersion`, `appEvent`, `subscriptionVersion`, etc. Only `reviewSubmission` itself is required. **This confirms the core premise: IAP submission is a drop-in variant of CPP's existing mechanism — same request schema, different relationship key.**
- **`POST /v1/inAppPurchaseVersions`** (`InAppPurchaseVersionCreateRequest`) — requires only `relationships.inAppPurchase`. **No writable `attributes` at creation** — version number/state are server-assigned, read-only on the resource schema.
- **`GET /v2/inAppPurchases/{id}/versions`** — confirmed, returns `InAppPurchaseVersion[]`, supports `filter[state]`.
- **`PATCH /v1/reviewSubmissions/{id}`** (`ReviewSubmissionUpdateRequest`) — attributes are `{platform, submitted: boolean, canceled: boolean}`. **No client-settable `state` field** — `state` (`READY_FOR_REVIEW, WAITING_FOR_REVIEW, IN_REVIEW, UNRESOLVED_ISSUES, CANCELING, COMPLETING, COMPLETE`) is read-only/server-computed. This **exactly matches** what CPP's code already does (`attributes:{submitted:true}`) — good sign for reuse.
- **`GET /v1/reviewSubmissions/{id}/items`** — confirmed, returns polymorphic `included` covering whichever item types are attached.
- **200-item cap: NOT present in this spec** — only generic JSON:API pagination `limit` max on unrelated list endpoints. **Resolved via Apple's prose docs, not the spec (§0):** confirmed official, "up to 200 items per submission at a time," stated verbatim twice on Apple's [Submit an In-App Purchase](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase/) help page. Enforce as a hard client-side cap per Decision B (§4.1a).
- **`InAppPurchaseState` (v2)**: `MISSING_METADATA → WAITING_FOR_UPLOAD → PROCESSING_CONTENT → READY_TO_SUBMIT → WAITING_FOR_REVIEW → IN_REVIEW → DEVELOPER_ACTION_NEEDED / PENDING_BINARY_APPROVAL → APPROVED / REMOVED_FROM_SALE variants / REJECTED`. (Older v1 `InAppPurchase.attributes.state` enum is longer/differently-ordered and includes now-irrelevant values like `CREATED`, `DELETION_IN_PROGRESS` — a footnote, not a blocker, since the module already reads v2 state.)
- **`deprecated` flags, confirmed unreliable as stated**: `POST /v1/inAppPurchaseSubmissions` and its create-request schema are **not** flagged deprecated, while `GET /v1/inAppPurchases/{id}` and `GET /v1/apps/{id}/inAppPurchases` **are** flagged `deprecated:true`. Even the "old" submission schema's relationship key is already named `inAppPurchaseV2` internally — Apple's own old endpoint already points at the v2 IAP resource. Treat the announcement, not the spec flags, as authoritative on submission-endpoint deprecation.
- **Backlog resources** (§6): v1 `inAppPurchaseLocalizations`, v1 `inAppPurchaseAppStoreReviewScreenshots`, plus their v2 counterparts, all exist, none flagged deprecated in the spec.

---

## 4. Migration plan

### 4.1 Reuse CPP's mechanism, IAP-specific delta only — RESOLVED

The new IAP submit flow is CPP's `prepareCppSubmission` / `confirmCppSubmission` / `rollbackCppSubmission` shape, with:

1. **Version step — confirmed fetch-only, not create-then-fetch**: an `inAppPurchaseVersion` already exists (state `PREPARE_FOR_SUBMISSION`) for every `READY_TO_SUBMIT` IAP, confirmed empirically (§0, Q1) against 5 real IAPs. The submit flow only needs `GET /v2/inAppPurchases/{id}/versions` to read the existing version's `id`; `POST /v1/inAppPurchaseVersions` is *not* a required step in the common path. Keep the create-call as a defensive fallback (an IAP somehow missing a version) but expect it to be rare-to-never hit in practice.
2. **Same as CPP, but create-or-reuse is now mandatory, not optional**: check for an app's existing open items-only `reviewSubmission` first (`GET` — filter by app/platform, non-terminal state), reuse it if present, only `POST /v1/reviewSubmissions` if none exists. This is required because Apple allows only **one** items-only submission per (app, platform) — confirmed §0 Q2 — and CPP's own submission occupies that same slot. See §4.1a for the conflict-handling UX this requires (Decision A).
3. Add `reviewSubmissionItems` pointing at `inAppPurchaseVersion` (not `appCustomProductPageVersion`), then `PATCH .../reviewSubmissions/{id}` with `submitted:true`.
4. **Item cap — confirmed official, enforce as hard limit**: 200 items per reviewSubmission (§0 Q4). See §4.1a (Decision B) for exactly where this is enforced.
5. **Carries over unchanged**: `bucketSelection` (preflight bucketing), `partitionByStateGuard` (state-guard recheck before execute), the two-phase preflight/execute UX in `SubmitBatchModal`, and `actions_log` write-per-row for audit.

### 4.1a Conflict dialog (Decision A) + 200-item cap enforcement (Decision B)

**Decision A — never silently co-submit items the user didn't select:**

1. Before creating anything, `GET` the app's existing open items-only `reviewSubmission` (if any) and, if one exists, `GET /v1/reviewSubmissions/{id}/items` to enumerate what's already in it.
2. If that existing submission is **empty**, or contains only items from the user's *own current batch* (e.g. resuming a partial-failure retry), proceed silently — no dialog, nothing to conflict with.
3. If it contains **anything else** (other IAPs not in this selection, CPP custom product pages, app events, etc.), show a conflict dialog **before any write call**, stating explicitly what's already in the submission: item count, item types (grouped — "3 Custom Product Pages," "2 other In-App Purchases"), and who/when if that metadata is available from Apple's response or the app's own `actions_log`. Two explicit choices, nothing automatic:
   - **"Add my items and submit everything"** — user knowingly opts into co-submitting the full container (their selected IAPs + whatever else is already there).
   - **"Cancel"** — abort, no Apple writes at all.
4. This dialog is a **hard requirement**, not a nice-to-have fallback — because CPP and IAP share the one items-only slot per app (§0 Q2), any app used for both will hit this routinely on real batches, not as a rare edge case.
5. **Backport to CPP**: CPP's own submission flow (§1) has the identical blind-create gap today — extend the same create-or-reuse + conflict-check logic there too (shared implementation, §4.2), so CPP submissions stop blind-409ing and stop silently able to collide with an IAP batch either.

**Decision B — 200-item cap, blocked client-side, never reaches Apple:**

1. **Select-all case** (selection > 200 after "select all" or a large filter): block submit entirely with a clear message — "N selected, Apple allows max 200 items per submission. Submit in batches of 200 or fewer." No partial-submit-then-stop; the whole action is blocked pre-flight.
2. **Multi-select case**: once 200 items are selected, further selection is disabled/capped with an inline notice, rather than allowing 201+ then rejecting at submit time.
3. **Optional v2 enhancement (not required for v1)**: offer "submit first 200 now, queue the rest for a follow-up batch" as a guided action — note in the build plan as a nice-to-have, not a blocker.
4. This check is pure client-side arithmetic on the current selection — no Apple call needed to enforce it, and it must run before the create-or-reuse check in §4.1a (no point checking for conflicts on a submission that's invalid on size alone).

### 4.2 What to share with CPP vs. keep IAP-specific

**Share** (extract, don't duplicate):
- The retry/backoff primitive currently living in `lib/iap-management/apple/fetch.ts` (`AppleRateLimitError`, `withRetry`, 429 detection, `Retry-After` parsing) should become the fetch layer for **both** the new IAP v2 submission code *and* CPP's `ascFetch`. CPP has zero 429 protection today (§1) and will be making the identical `reviewSubmissions`/`reviewSubmissionItems`/PATCH-submit calls the new IAP flow makes — leaving `ascFetch` unprotected while building a second, protected implementation for IAP means CPP stays exposed and the two code paths silently diverge again. This is a plain HTTP-utility extraction (e.g. a shared `lib/shared/apple-fetch.ts`), not a DB-schema-isolation violation — the module-isolation rule in CLAUDE.md is about `public.*` vs `store_mgmt.*` Postgres schemas and route/UI boundaries, not about sharing a generic Apple API client helper.
- A typed `ReviewSubmission`/`ReviewSubmissionItem` model (currently absent from `types/asc.ts` entirely, §1) — worth introducing once, used by both the CPP and IAP submit code, rather than continuing with inline untyped shapes.
- The create-or-reuse-open-reviewSubmission logic — CPP doesn't have this today either (always creates blind, §1); building it once for IAP and backporting to CPP closes a real gap in both.

**Keep IAP-specific**:
- The version-create-or-reuse step (`inAppPurchaseVersions`) — no CPP equivalent needed since CPP already operates on a always-precreated `AppCustomProductPageVersion`.
- `bucketSelection` / `partitionByStateGuard` / `SUBMIT_CONCURRENCY` / `actions_log` — these are IAP's existing state-guard and audit infrastructure, unrelated to the submission mechanism swap, and should not move.

### 4.3 Rollback-safe toggle — RESOLVED: per-app dogfood-first, not global

Original recommendation (global env-var flag) is **superseded** by the resolved facts in §0. Two things changed the calculus:

1. **Confirmed real collision risk** (§0 Q2): CPP and IAP share the one items-only reviewSubmission slot per app. A global flip-it-on-everywhere cutover means the *first* time this collides in practice is in production, across every app at once, right when the conflict-dialog code path is newest and least battle-tested.
2. **Unresolved orphaned-version risk** (§0 Q3): partial-failure cleanup behavior isn't confirmed safe by Apple's docs. Limiting blast radius to one app at a time while this is being observed in practice is cheap insurance.

**Recommended toggle**: `IAP_SUBMIT_V2_ENABLED` scoped **per app** (e.g. a column/flag on the app's row in `iap_mgmt.apps`, or a simple allowlist env var of app IDs), not a single global boolean. Rollout: enable on one low-traffic app first, run several real batches (including at least one that deliberately collides with an open CPP submission, to exercise the conflict dialog on purpose), then expand to more apps once the conflict dialog and version-reuse path have been observed working on real data. Graduate to a global default once confidence is established — the per-app flag doesn't need to be permanent, just the safer starting posture.

---

## 5. Rate-limit plan — does the new mechanism actually fix 52→9?

**Resolved: yes.** §0 Q1 confirms versions pre-exist for `READY_TO_SUBMIT` IAPs — the "must-create" branch below is now the defensive-fallback case, not the expected path.

**Call-count for N=52 items, confirmed path (version pre-exists):**

| Step | Calls | Notes |
|---|---|---|
| Check for existing open reviewSubmission (Decision A) | 1 GET | New — didn't exist in either old flow or the original draft design |
| Enumerate existing items if one is found (conflict dialog data) | 0-1 GET | Only if step 1 finds an open submission |
| Create reviewSubmission (if none reused) | 0-1 POST | Mutually exclusive with reuse |
| Add `reviewSubmissionItems` | N POST | One per IAP, pointing at its existing `inAppPurchaseVersion` |
| Submit | 1 PATCH | `{submitted:true}` |
| **Total for N=52** | **~55 (N+3)** | vs. old **104 (2N)** — roughly halved |

This is a best-case-confirmed number assuming the version `id` for each IAP can be read from the same preflight/state-guard listing call the batch flow already makes (needs confirming during build whether the existing `listInAppPurchases`-style call can be parameterized to include version relationship data in one shot, e.g. via `include=`/`fields[]`). **Worst case**, if a separate per-item `GET /v2/inAppPurchases/{id}/versions` is needed because the list call can't be extended, that adds N calls — `~2N+3` total — which no longer halves the raw count, but still eliminates the old flow's redundant post-submit status-refetch GET, and still collapses N independent submission-trigger actions down to 1. Confirm which case applies during build; either way, the mitigations below are what actually prevent 52→9 from recurring, not the call-count reduction alone.

This must ship with:
1. **The `withRetry`/`AppleRateLimitError` wrapper already used by IAP** — proven code, reuse as-is (or its shared extraction, §4.2) for every new call site (version-create, item-add, submit PATCH).
2. **Inter-item pacing, not just concurrency cap** — the current gap is exactly this: `SUBMIT_CONCURRENCY=2` with zero delay between pulls. Add a small fixed delay between item-adds (the bulk-import execute route already does this — `INTER_ROW_DELAY_MS=1000`, per the KB — reuse that constant/pattern rather than inventing a new one).
3. **Batch-level partial-failure recovery**, matching CPP's existing UX: if some `reviewSubmissionItem` adds fail after retries, don't silently drop them — surface a "retry failed items" affordance (CPP's `CppList.tsx:684-696` already has this pattern for partial-fail: prompt to proceed-with-partial or roll back). Extend/reuse rather than reinvent.

---

## 6. Out of scope (backlog)

- **IAP images/localizations v1→v2**: `createInAppPurchaseLocalization`/`updateInAppPurchaseLocalization`/`deleteInAppPurchaseLocalization` (`lib/iap-management/apple/client.ts:201-251`, hitting v1 `/v1/inAppPurchaseLocalizations`) and the screenshot reserve/confirm/delete trio (`client.ts:266-317`, hitting v1 `/v1/inAppPurchaseAppStoreReviewScreenshots`) are the remaining v1-only holdouts — the IAP resource itself already moved to v2 (`client.ts:43-179`). None are spec-flagged deprecated yet. Track as a separate migration once submission lands.
- **Subscriptions**: confirmed out of scope — the module's `NON_RENEWING_SUBSCRIPTION` type is a one-time-IAP variant, not auto-renewable subscriptions; the latter has an explicit in-code lock comment (`components/iap-management/iap-form/IapForm.tsx:503`, "managed separately (Q1 lock)") and no code path touches Apple's actual Subscriptions API.

---

## 7. Open questions + risks — status after 2026-07-17 follow-up

1. ~~Does a `READY_TO_SUBMIT` IAP already have an `inAppPurchaseVersion`?~~ **RESOLVED — yes** (§0 Q1). Confirmed live against 5 real IAPs on `com.vng.passsdktest`. Residual caveat: all 5 samples came from one app/account; the underlying mechanism (Apple auto-provisions the version alongside IAP creation) is expected to be account-independent, but a spot-check on a second app is cheap insurance, not a blocker.
2. ~~200-item cap unconfirmed~~ **RESOLVED — yes, official, per-submission** (§0 Q4). Sourced from Apple's IAP/subscription submission help page specifically (not the generic `reviewSubmissionItems` API reference, which has no descriptive text at all) — cite it as "Apple's stated IAP-submission-flow cap," not a universal claim about every item type sharing the same 200 limit, when documenting this internally.
3. ~~Does old + new coexist cleanly?~~ **RESOLVED — no, they share one slot, by design** (§0 Q2). Apple allows exactly one items-only reviewSubmission per (app, platform); CPP and IAP both fall in that category. This isn't a conflict to prevent — it's an expected shared-resource contention to handle gracefully, which is exactly what Decision A's conflict dialog (§4.1a) is for. Confirmed as a **routine** path, not a rare edge case, given both modules are used on the same apps.
4. ~~Toggle granularity~~ **RESOLVED — per-app dogfood-first** (§4.3), reversing the original global-flag recommendation, directly because of #3 (routine cross-module contention) and #5 below (unresolved partial-failure safety).
5. **Still open — version orphaning after partial failure.** Not resolved by Apple's official docs or the machine spec (§0 Q3): no DELETE endpoint exists for `inAppPurchaseVersion`, and Apple's docs don't state whether an idle, never-superseded draft causes problems later. Circumstantial evidence (sibling `AppStoreVersion` resource behavior; this repo's own CPP `reviewSubmission` blind-create precedent) leans toward "treat as unsafe to ignore." **Mitigated by construction, not resolved empirically**: since §4.1 confirms versions are essentially always pre-existing (not created by this flow in the common path), the actual exposure surface for this risk is small — it only matters in the rare defensive-fallback case where the flow itself creates a version and then the batch fails before submission completes. Recommend one manual sandbox test before build (create a version, abandon it, attempt a second create for the same IAP, observe the actual response) to close this out with real evidence rather than inference — cheap to do, and removes the last real unknown.
