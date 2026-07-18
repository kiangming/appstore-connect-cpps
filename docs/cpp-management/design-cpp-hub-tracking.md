# Design: VNGGames Hub Run Tracking for CPP Bulk Import

**Status: IMPLEMENTED — design signed off, all 6 open questions resolved (see §H), built and shipped. Gauntlet 4/4 green (typecheck/tests/lint/build).**

This is the 4th Hub-tracking integration. The prior three (all shipped) are the
reference set:

1. `docs/iap-management/design-iap-submit-hub-tracking.md` — Apple IAP Submit
2. `docs/iap-management/design-iap-v2-submission-migration.md` — reviewSubmissions v2 migration context
3. `docs/integrate-rest-vnggames-hub.md` — the Hub's own REST contract (repo-root `docs/`, **not** under `docs/iap-management/` — corrected path)
4. `docs/iap-management/IAP-MANAGEMENT-KNOWLEDGE-BASE.md` §9 / §10.13.K / §10.15 — the crystallized meta-rules (P1–P9)

**Scope note:** this doc covers CPP **Bulk Import** upload tracking only — the
gap the KB itself already flags at `IAP-MANAGEMENT-KNOWLEDGE-BASE.md:2732-2737`:
*"Backlog — NOT yet built: CPP Upload tracking. CPP's asset-upload flow is
client-orchestrated per-file (no existing batch-level server endpoint the way
bulk-import/submit-batch have one) — adding Hub tracking there needs a new
batch-level server endpoint first, not just another `startXTracking`/
`finalizeXTracking` pair."* CPP's separate Submit-for-Review flow
(`prepare`/`confirm`/rollback, `CppList.tsx:646-729`) is **out of scope** here
— see §0 below for why it matters that the two are not confused.

---

## 0. Scope correction — the task's own file:line pointer was wrong

The task description assumed the "existing partial-fail UX (CppList.tsx
~684–696)" belongs to **Bulk Import**. It does not. `CppList.tsx:684-702` is
inside `handlePrepare()` (`:646-702`), part of the **Submit for Review**
feature (`POST /api/asc/cpps/submit/prepare` → `confirm`/rollback) — a
separate feature, separate trigger button, separate API routes, entirely
unrelated to the Bulk Import dialog this design targets.

The actual CPP Bulk Import flow lives in **`components/cpp/CppBulkImportDialog.tsx`**
(triggered from `CppList.tsx:743-749` and `:832-838`). There is also an
**older, different** `components/cpp/BulkImportDialog.tsx` that imports assets
into ONE existing CPP from inside `CppEditor` → `LocalizationManager` —
not the subject of this design (it's a different unit: single-CPP asset
import, not multi-CPP creation). Everything below concerns
`CppBulkImportDialog.tsx` unless stated otherwise.

---

## 1. Investigation findings (evidence-backed)

### 1.1 End-to-end flow map

Entry: `app/(dashboard)/apps/[appId]/cpps/page.tsx:10` (`CppsPage`, Server
Component) → renders `components/cpp/CppList.tsx:450` (`CppList`) → two
trigger buttons (`CppList.tsx:743-749` empty-state, `:832-838` header action)
both do `setShowBulkImport(true)`, mounting `CppBulkImportDialog` at
`CppList.tsx:1034-1041`.

Wizard steps (`CppBulkImportDialog.tsx:39`):
`"drop" → "validating" → "preview" → "uploading" → "done"`.

1. **`"drop"`** (`:898-960`) — dropzone / `webkitdirectory` folder picker. `handleDrop`/`handleInputChange` (`:790-797`) call `processFiles`.
2. **`processFiles`** (`:183-410`) — sets `step="validating"` immediately (`:184`), parses the folder + builds the import plan (client-side, but with real network calls — see §1.8), sets `step="preview"` at `:409`.
3. **`"preview"`** (`:971`+) — review/exclude UI. Footer **"Import All"** button (`:1327-1334`) calls `startUpload` directly.
4. **`startUpload`** (`:756-785`) — sets `step="uploading"` (`:771`), runs a 2-worker pool over the CPP plans, sets `step="done"` (`:784`) when `Promise.all([worker(), worker()])` resolves.
5. **`"done"`** (`:1338`+) — summary; `Done` → `onComplete(); onClose()` (`:886`), `onComplete` does `window.location.reload()` (`CppList.tsx:1039`).

API routes called during upload, in order (from `uploadCpp`/`uploadLocale`,
`CppBulkImportDialog.tsx:598-753` and `:415-596`): app-info-localizations
(GET/POST), `POST /api/asc/cpps` (create CPP), `GET /api/asc/cpps/{id}`,
`PATCH /api/asc/versions/{id}` (deep link), screenshot/preview-set GET/POST,
`POST /api/asc/cpps/{id}/localizations`, `PATCH /api/asc/localizations/{id}`,
and per-asset `POST /api/asc/upload` / `POST /api/asc/upload-preview`.

### 1.2 Upload orchestration — `Promise.all`, but functions like `allSettled`

`CppBulkImportDialog.tsx:775-784`:
```ts
async function worker() {
  while (queue.length > 0) {
    const plan = queue.shift()!;
    await uploadCpp(plan);
  }
}
await Promise.all([worker(), worker()]);
setStep("done");
```
`uploadCpp` wraps its whole body in try/catch (`:601...749-752`) and on error
calls `updateCppProgress(plan.name, { status: "error", error })` instead of
rethrowing — so `worker()` never rejects, and `Promise.all` never short-circuits
on a CPP failure. Same pattern one level down for locales (`:722-746`,
catch at `:738-745`).

**A per-CPP (and per-locale) result set already exists** — but as React
component state (`cppProgress: CppProgress[]`, `:80-85,149`), not as the
return value of the `Promise.all`. `doneCount`/`errorCount` are derived from
this state array at render time (`:859-860`). This is the load-bearing fact
for §2.A/§2.C below: **PARTIAL is already distinguishable from FAIL today**,
client-side, with zero new instrumentation — the gap is only that nothing
reads this state and reports it to Hub.

### 1.3 Unit of a bulk import — recommend per-CPP

One root folder → **N CPPs**, each with its own locales, each with its own
assets (`lib/parseCppFolderStructure.ts:10-14`, `CppImportPlan` at
`CppBulkImportDialog.tsx:58-71`). Real hierarchy: 1 folder → N CPPs → M
locales each → up to 4 asset buckets each (iPhone/iPad × screenshot/preview).

**Recommendation: per-CPP is the natural success unit**, not per-asset or
per-locale, for three reasons grounded in the evidence: (a) the existing
`cppProgress` state array — the only per-item result structure that already
exists — is keyed per-CPP, not per-asset; (b) the existing "done" step UX
already surfaces `doneCount`/`errorCount` at CPP granularity
(`CppBulkImportDialog.tsx:859-860,881`), so reusing it for Hub-terminal-status
computation requires zero new aggregation logic; (c) per-CPP mirrors the
established precedent directly — IAP Bulk Import's unit is per-row (per-IAP),
i.e. per deliverable business object, not per underlying API call. A CPP is
the deliverable; a screenshot upload is an implementation step within it, just
as an IAP price-tier write is an implementation step within a row.

*(Correction of the task's own framing: `docs/feature-cpp-bulk-import-design.md:133,158`
claims `parseCppFolderStructure` delegates per-CPP parsing to the single-CPP
`parseFolderStructure`. It doesn't — `lib/parseCppFolderStructure.ts:62-182`
has its own independent, duplicated locale/file-grouping logic; grep confirms
`parseFolderStructure` is imported only by the older `BulkImportDialog.tsx:22,124`.
Not load-bearing for this design, but worth a docs fix separately.)*

### 1.4 The prior partial-fail UX is Submit-for-Review, not Bulk Import

See §0. `CppList.tsx:684-702` computes `successItems.length === data.items.length`
from `POST /api/asc/cpps/submit/prepare`'s response, auto-confirms on
all-success, else shows `PartialFailDialog` (`:350-447`) with
Proceed/Rollback. This is a genuinely different flow — it has the mid-flight
conflict/pause-resume shape Bulk Import lacks (see §1.5) — and is out of
scope for this design (§0).

### 1.5 No mid-flight conflict/pause dialog in Bulk Import

`startUpload` (`CppBulkImportDialog.tsx:756`) is a single fire-and-forget
action with no server-side pause point requiring a client decision.
"Preview" lets the user exclude rows *before* upload; "done" is
informational only, no retry/rollback offered there. This confirms Bulk
Import is structurally the **simple, single-commit-to-completion** case —
the same shape as IAP Bulk Import (per `IAP-MANAGEMENT-KNOWLEDGE-BASE.md:2720-2725`
row "Start point"/"Cancel guard" column 2), **not** the multi-request
conflict/partial-fail shape of IAP Submit. This directly decides §2.D
(two-state guard, not three-state).

(A conflict/pause dialog *does* exist elsewhere in this codebase — CPP's own
Submit-for-Review, §1.4 — and is the closest in-repo analog if Hub tracking
is ever extended to CPP Submit. Out of scope here.)

### 1.6 CPP config storage — `public` schema, no CPP-specific settings page yet

ASC credentials: `public.asc_accounts` (`supabase/migrations/20260407000000_create_asc_accounts.sql:5-15`,
no schema prefix — confirmed no CPP-specific schema exists; `grep CREATE SCHEMA`
across all migrations only finds `store_mgmt`, `iap_mgmt`, `google_iap_mgmt`).
RLS enabled, no policies (service-role only). Read via
`lib/asc-account-repository.ts` → `lib/get-active-account.ts:21-26`.

The only existing CPP settings page is `app/(dashboard)/settings/page.tsx`
(admin-only, ASC-account management) — **not** a hub-tracking config surface,
and CPP has no `/cpp-management/*` route prefix the way IAP/Google do
(CPP kept its original `/apps/*`, `/api/asc/*` routes — see §2.G).

Precedent tables, for direct comparison:
`supabase/migrations/20260715000000_iap_mgmt_hub_tracking_config.sql:15-24`
(`iap_mgmt.hub_tracking_config`) and `20260716000000_google_iap_mgmt_hub_tracking_config.sql`
(`google_iap_mgmt.hub_tracking_config`) — identical shape, each in its own
module schema, singleton row (`id='default'`), `workflow_id`, `token_enc`
(AES-256-GCM via `lib/asc-crypto.ts` — the same helper `asc_accounts.private_key_enc`
already uses), `enabled`, `is_active`, audit columns.

### 1.7 Reuse surface

Directly reusable **as literal shared code** (module-agnostic, no per-module
coupling): `lib/asc-crypto.ts` (already shared — no new crypto needed), the
Hub REST contract itself (`docs/integrate-rest-vnggames-hub.md`), and the
`computeBulkImportTerminalStatus`-style pure function
(`failed===0`→SUCCESS / `succeeded===0`→FAILED / else PARTIAL) — generic,
no bulk-import-specific logic despite the name.

**Not literally shared today, by established precedent**: IAP and Google IAP
each keep their **own copy** of `config.ts`/`hub-client.ts`/`tracking.ts`/
`status-mapping.ts` under `lib/{module}/hub-tracking/`, rather than one
module importing the other's. Google did not import Apple's hub-client; it
has its own file with the same logic. CPP should follow this precedent —
copy the pattern into a new CPP-owned tree, not cross-import from
`lib/iap-management/...` (see §2.G — this also surfaces a real placement
wrinkle, since CPP's `lib/` isn't namespaced like IAP/Google's).

**Must be wired fresh, not reused as-is**: the settings-page UI itself can be
a near-verbatim clone of `HubTrackingClient.tsx`, but its *route location*
cannot mirror `/iap-management/settings/hub-tracking/` since CPP has no
module-prefixed route tree (§2.E, §2.G). The lifecycle wiring (§2.A) must be
client-triggered rather than living inside one server request, because no
batch-level server route exists for CPP uploads (per the KB backlog note
quoted at the top).

### 1.8 Race check — plausible, same shape as Google's `ce169a8`, same fix applies

`processFiles` (running during `"validating"`) is **not** synchronous-only —
it always includes at least one real network round trip
(`GET /api/asc/apps/{appId}/app-info-localizations`, `:219`) before locale
classification can proceed, plus one parallel fetch per **existing**-CPP match
(`GET /api/asc/cpps/{existingCppId}`, `:269`, inside the `Promise.all` at
`:234`) — 0 extra for an all-new-CPPs import. For most real folders this
gives comfortable buffer for a Hub `START` call fired at the
`"validating"→"preview"` transition to resolve before the user can reach and
click "Import All". But for a **small, all-new-CPPs, no-assets** folder, the
buffer collapses and the same race Google hit in `ce169a8` is plausible here:
`START` still in flight when `startUpload` fires.

This exact race, and its fix, is already committed precedent in this
codebase — `app/(dashboard)/iap-management/apps/[appId]/bulk-import/BulkImportWizard.tsx:222-252`:
fire `START` on the step transition, never block the UI on its response;
if the response arrives *after* `executeStartedRef.current` is already
`true`, drop it silently and best-effort-cancel the orphaned run rather than
adopting it into state (P7 — prefer a missed signal over a wrong one). The
same guard (permanent ref + bounded `Promise.race` cap, §2.D) must be copied
into `CppBulkImportDialog.tsx`, gated on `startUpload` rather than
`handleExecute`.

---

## 2. Design

### A. Finalize placement — RECOMMEND Option A (client-driven lifecycle + server-proxied Hub calls)

**Option A** (recommended): new slim server routes
`/api/asc/hub-tracking/{start,cancel,finalize}` that do nothing but
proxy to Hub (token stays server-side, never reaches the browser).
`CppBulkImportDialog.tsx` calls `start` on the `"validating"→"preview"`
transition, computes the terminal status **client-side** from the existing
`cppProgress` state array once `Promise.all([worker(), worker()])` resolves
(§1.2), and POSTs the result to `finalize`. `cancel` fires via the
`executeStartedRef`-style guard (§D) plus `beforeunload`+`sendBeacon`.

**Option B** (rejected): build a new batch-level server endpoint that
orchestrates the per-CPP/per-locale uploads server-side, giving a single
request-scoped try/finally like IAP Bulk Import's execute route.

**Why A, not B:**
1. **§1.2 already answers the deciding question** — per-CPP results already
   exist (as client state); Option B's main justification (get a
   server-observable per-item result set) is not needed, it's already there.
2. **Blast radius.** `CppBulkImportDialog.tsx`'s worker-pool upload path is
   large (64KB), proven, and drives **live per-CPP/per-locale progress bars**
   during upload via `updateCppProgress`/`updateLocaleProgress` calls that
   fire *during* each `uploadCpp`/`uploadLocale` call, not after. Moving this
   server-side would either kill that live-progress UX or require adding
   polling/streaming just to preserve it — a large, unforced re-architecture
   of a working feature, for a tracking side-feature.
3. **Tab-close risk is real either way, but not worse under A.** CPP asset
   uploads (screenshots, and especially video previews) can run considerably
   longer than IAP's JSON-only batch execute. Under A, a tab closed mid-upload
   leaves the Hub run `RUNNING` with no closer — but this is **the same
   accepted edge case** IAP Submit already ships with for its state-3
   partial-fail window (`IAP-MANAGEMENT-KNOWLEDGE-BASE.md:2725`, "Known
   accepted limitation"). Option B would reduce (not eliminate — a server
   process can still die) this risk, at a cost (point 2) disproportionate to
   a rare, low-volume, already-accepted-elsewhere failure mode.
4. The STATUS PRINCIPLE (P5) is satisfied identically either way — the
   terminal status is computed from what actually reached Apple
   (`cppProgress` per-CPP outcomes), not from the button clicked, regardless
   of where that computation runs.

**Explicitly accepted limitation to carry forward** (mirrors
`IAP-MANAGEMENT-KNOWLEDGE-BASE.md:2725`): abandoning the tab during
`"uploading"` (after `startUpload` has fired) leaves the Hub run `RUNNING`
with no closer. Accepted as rare/low-volume rather than building Option B or
a server-side stale-run sweep.

### B. Success unit

Per-CPP, not per-asset or per-locale. See §1.3 for the full reasoning
(existing state shape, existing UX granularity, precedent parity with
IAP's per-row unit).

### C. Status-mapping table

| Trigger | Terminal status |
|---|---|
| Folder finishes loading into the tool (`"validating"→"preview"` transition, `processFiles` resolves, `CppBulkImportDialog.tsx:409`) | `START` |
| User abandons/closes the dialog or tab at any point **before** clicking "Import All" (`"drop"`, `"validating"`, or `"preview"` steps) | `CANCEL` — nothing written to Apple yet |
| `startUpload`'s `Promise.all([worker(), worker()])` resolves, all CPPs `status: "done"` (0 `"error"`) | `SUCCESS` |
| ≥1 CPP `"done"` and ≥1 CPP `"error"` | `PARTIAL` |
| 0 CPPs `"done"` (all `"error"`) | `FAILED` |

Terminal status is computed from `cppProgress`'s actual per-CPP outcomes —
what actually reached Apple — never from which step the user was on or a
same-named-but-different-meaning per-locale field (STATUS PRINCIPLE, P5).
The `finalize` payload must carry `{ succeeded, failed, total }` counts in
the message, mirroring submit-batch's convention
(`` `${failed}/${total} rows failed` ``-style, `status-mapping.ts:30-43`) —
here counted in CPPs, e.g. `` `${errorCount}/${cppProgress.length} CPPs failed` ``.

### D. Guard design — two-state, not three-state

Finding §1.5 confirms Bulk Import has **no** mid-flight pause/conflict point
— unlike Submit's three-state `executeCommittedRef`, this is the simple
single-boundary case IAP/Google Bulk Import already use. Recommend a direct
port of that shape:

- A permanent ref (e.g. `uploadStartedRef`, mirroring `executeStartedRef`),
  set to `true` the instant `startUpload` is invoked
  (`CppBulkImportDialog.tsx:756`), never reset within a single dialog mount.
- Every cancel/cleanup site — `beforeunload`+`sendBeacon`, explicit dialog
  close/back-out from `"drop"`/`"validating"`/`"preview"` — checks
  `!uploadStartedRef.current` before firing `cancel`. Once `startUpload` has
  fired, client-side `CANCEL` is **suppressed** — writes may already have
  reached Apple for some CPPs even while others are still in flight, so the
  same reasoning as Submit's state-3 suppression applies, even though this is
  structurally a two-state (not three-state) guard: there is no intermediate
  "paused, awaiting user decision, zero writes yet" state here the way
  Submit's conflict dialog has one.
- Race hardening per §1.8: store the in-flight `start` fetch promise in a
  second ref (e.g. `hubStartPromiseRef`); if `startUpload` fires before it
  resolves, race it against a hard **1000ms** cap (well under the 3000ms
  server-side `HUB_TIMEOUT_MS`) to decide whether to thread the real `run_id`
  through to `finalize`/`cancel`, or proceed with a missed (never wrong)
  signal. If the `start` response arrives *after* `uploadStartedRef.current`
  is already `true` and past the cap, drop it silently and best-effort-cancel
  the orphaned run — never adopt it, never send a guessed status (P7).

**Open question flagged for sign-off** (not resolved by the investigation):
does the `"preview"` step offer a "back"/"start over" action that returns to
`"drop"` before `startUpload` fires? If so, the guard must cancel the
first-fired `START` run before issuing a second one, to avoid orphaning it.
Needs an implementer check against the actual "preview" step UI before
coding the guard.

### E. Config design

- New table, same shape as the two precedents (`iap_mgmt.hub_tracking_config`,
  `google_iap_mgmt.hub_tracking_config`): `id TEXT PRIMARY KEY DEFAULT 'default'`,
  `workflow_id TEXT NOT NULL`, `token_enc TEXT NOT NULL` (via
  `lib/asc-crypto.ts` — reused as-is, no new crypto), `enabled BOOLEAN NOT NULL DEFAULT true`,
  `is_active BOOLEAN NOT NULL DEFAULT true`, `created_by TEXT`, `created_at`/`updated_at`.
  RLS enabled, no policies (service-role only), `updated_at` trigger — identical
  to the precedent migrations. **Migration written at implementation time, not now.**
- **Schema recommendation:** a new dedicated schema, e.g. `cpp_mgmt`, holding
  only `hub_tracking_config` (not `public`, where `asc_accounts` and other
  shared-shell state already live). Rationale: every prior Hub-tracking table
  lives in its own module schema by convention; `public` is CPP's legacy
  home from before the schema-isolation convention existed (CLAUDE.md
  invariant #9), and continuing to add new module-specific tables there
  compounds that inconsistency rather than following the now-established
  pattern. This is a one-line `CREATE SCHEMA` addition to the migration — low
  risk — but flagged as a genuine open decision for Manager sign-off since it
  is the one place this design deliberately does **not** mirror CPP's
  existing (pre-convention) storage location.
- **Workflow ID**: admin-entered via the Settings page (not hardcoded), same
  as all three precedents. Proposed default value to register in Hub Admin →
  Workflows, for naming consistency with the existing illustrative fixtures
  (`"iap-bulk-import"`, `"google-iap-bulk-import"`): **`"appstore:cpp-bulk-import"`**.
- **Settings page**: the *component* (`HubTrackingClient.tsx`-equivalent) is
  a straight mirror — same badge/checkbox/workflow_id-input/token-input/
  validation-banner shape, no new UI element needed. The *route location*
  is genuinely new (not a mirror) because CPP has no `/cpp-management/*`
  route prefix the way IAP/Google do (§2.G) — recommend
  `app/(dashboard)/settings/hub-tracking/page.tsx` as a sibling page to the
  existing `app/(dashboard)/settings/page.tsx` (ASC accounts), rather than
  folding it into that page as a tab, to keep each settings page
  single-purpose like the precedent modules do. No new mockup needed.

### F. Cross-cutting

- Feature tag: `"cpp-hub-tracking"` for every `log(...)` call in the new
  CPP hub-tracking lib tree, with the `[hub-tracking]` message prefix on
  every log line (greppable across all four integrations via
  `grep '\[hub-tracking\]'`, per the established convention). Token is never
  logged, matching every existing decrypt/config-read error path.
- Hard AbortController timeout: `3000ms` (`HUB_TIMEOUT_MS`), a genuine abort
  of the in-flight request — not a `Promise.race` that leaves it running —
  identical to the existing `hub-client.ts:24,38-39` implementation.
- Config reads: **no cache**, full stop, on every read — per P6 / the
  `9ed7845` incident. This is a cold path (read a handful of times per bulk
  import), and Railway rolling deploys run two instances side by side during
  a deploy; a cache would reintroduce exactly the staleness bug that fix
  removed. Do not reintroduce it here "just for CPP."

### G. Twin-asymmetry summary

**Reused as literal shared code** (no new implementation, module-agnostic):
`lib/asc-crypto.ts` encryption helpers; the Hub REST contract itself;
the pure status-computation logic (ported, not imported — see below).

**Reused as a pattern, copied fresh (not cross-imported)**: per established
precedent, IAP and Google each keep their own copy of
`config.ts`/`hub-client.ts`/`tracking.ts`/`status-mapping.ts` rather than one
importing the other's. CPP should get its own copy too — but **where** it
lives is itself a new asymmetry to resolve: IAP/Google namespace their lib
code under `lib/{module}/hub-tracking/` because their whole `lib/` tree is
already module-namespaced (`lib/iap-management/...`,
`lib/google-iap-management/...`). CPP's `lib/` is **flat** — `lib/asc-client.ts`,
`lib/asc-jwt.ts`, `lib/asc-crypto.ts`, `lib/parseCppFolderStructure.ts` all
sit directly under `lib/`, with no `lib/cpp-management/` subfolder anywhere
in the existing codebase. Recommend a flat `lib/cpp-hub-tracking/{config,hub-client,tracking,status-mapping}.ts`
tree, matching CPP's own existing organizational convention, rather than
introducing a nested module folder CPP has never used — mirroring the
sibling *pattern* while re-validating the *placement* against CPP's actual
structure (P8's own instruction, applied to itself).

**Wired fresh, with re-validated timing/ordering (not just copied)**:
- The whole lifecycle is client-driven with server-proxied calls (§A) — a
  genuine architectural divergence from all three precedents, which each had
  a server route that could own `start`→finalize in one request (or, for
  Submit, a bounded number of explicit finalize sites within server routes).
  CPP has none — this was re-validated against CPP's actual flow (§1.1, §1.2),
  not assumed from the API shape alone (P8's central instruction).
- `START` timing: fires at `"validating"→"preview"`, analogous to Google's
  upload→preview transition — but CPP's own timing was independently
  re-checked (§1.8) rather than assumed identical to Google's, and the same
  race is plausible here for a different reason (existing-CPP-fetch count
  varies per folder, not a fixed shape).
- The guard is two-state (§D), matching Bulk Import's shape, **not**
  Submit's three-state shape — this was decided from CPP's own confirmed
  absence of a mid-flight pause point (§1.5), not assumed from surface
  similarity to either precedent.
- Finalize computation happens **client-side**, then POSTed to a slim
  `finalize` route — no precedent integration does this; all three run
  finalize logic inside a server request. This is the single largest
  structural departure and the reason Option A ≠ "just copy Bulk Import."

### H. Open questions — RESOLVED at implementation (Manager review)

1. **Schema placement** — **RESOLVED: `public`, table `public.cpp_hub_tracking_config`.**
   Manager chose `public` over a new dedicated `cpp_mgmt` schema, alongside
   the existing `public.asc_accounts` — the table name itself is
   CPP-prefixed to disambiguate, since `public` doesn't provide the isolation
   a dedicated schema would. Same column shape as `iap_mgmt.hub_tracking_config`.
   Migration: `supabase/migrations/20260718000000_cpp_hub_tracking_config.sql`.
2. **Settings page route** — **RESOLVED: sibling page, not a tab.**
   `app/(dashboard)/settings/hub-tracking/page.tsx`, admin-only (redirects
   non-admins, matching the existing `/settings` ASC-accounts page's own
   convention rather than IAP/Google's member-visible-read-only pattern).
   Client component is a near-verbatim clone of `HubTrackingClient.tsx`
   (badge/checkbox/workflow_id-input/token-input/validation-banner) with the
   admin-only distinction simplified away, since the page itself already
   gates. Cross-links added both ways (`/settings` ↔ `/settings/hub-tracking`)
   per the twin-structure-asymmetry precedent (Google's landing-page nav-card
   gap, `b5265c2`) — CPP's `/settings` page had no multi-page nav affordance
   before this, so one was added.
3. **"Preview" back-navigation** — **RESOLVED (code-checked): no such
   affordance exists.** Read the full `"preview"` step render
   (`CppBulkImportDialog.tsx:971-1233` at investigation time) and its footer
   (`:1303-1337`): the only actions are per-row/per-CPP "Remove"/"Include"
   toggles, a `Cancel` button (closes the dialog entirely, does not return to
   `"drop"`), and `Import All`. `setStep("drop")` appears exactly once in the
   whole component, inside `processFiles`'s metadata.xlsx-parse-failure early
   return (`:197`) — which fires *before* `"preview"` is ever reached, not
   from it. No multi-START hygiene branch is needed; the simple two-state
   guard (§D) is sufficient as designed, unmodified.
4. **Accepted tab-close-mid-upload limitation** — **RESOLVED: accepted**,
   same posture as IAP Submit's state-3 window. See finding 4 below (R4) for
   the Hub-side bound on this edge case, now documented.
5. **`lib/cpp-hub-tracking/` flat placement** — **RESOLVED: confirmed.**
   Built as `lib/cpp-hub-tracking/{config,hub-client,tracking,status-mapping}.ts`,
   matching CPP's existing flat `lib/` convention. No `lib/cpp-management/`
   folder was introduced.
6. **Workflow ID value** — **RESOLVED: `"cpp-bulk-import"`**, dropping the
   `"appstore:"` prefix this doc originally proposed — Manager flagged it as
   inconsistent with the existing unprefixed `"iap-bulk-import"` /
   `"google-iap-bulk-import"` test-fixture convention. Still admin-entered
   via the Settings page, not hardcoded in application code — this is only
   the value to register in Hub Admin → Workflows.

### Implementation findings (R1–R4, resolved during the build)

**R1 — finalize-in-finally.** The client-side terminal-status computation
and `/finalize` POST are wrapped in a `try/finally` around the whole upload
phase in `startUpload` (`components/cpp/CppBulkImportDialog.tsx`). Even if
`Promise.all([worker(), worker()])` rejects unexpectedly (`uploadCpp` never
throws by construction — every per-CPP failure is caught internally and
converted to a normal `"error"` return — so this is a defensive backstop,
not a reachable path in practice), the run still finalizes rather than being
left `RUNNING`. The naive "`failed===0` → SUCCESS" mapping is deliberately
NOT reused for this case — an unexpected mid-batch throw with 0 recorded
successes and 0 recorded failures does not mean nothing failed, it means we
don't know what happened to whatever hadn't settled yet. This decision was
pulled into its own pure, unit-tested function,
`deriveTerminalStatusOnUnexpectedError` (`lib/cpp-hub-tracking/status-mapping.ts`):
`succeededCount > 0` → `PARTIAL`, else → `FAILED`. Never `SUCCESS`, never
`CANCELLED` — never left undecided.

**R2 — cancel-guard precision.** Two refs guard cancel eligibility, matching
the exact shape asked for: `hubRunStartedRef` (true the instant the
`/start` fetch is *fired*, at the `"validating"→"preview"` transition — not
when it resolves) and `uploadStartedRef` (permanent, true the instant
`startUpload` is invoked). Cancel — via explicit close (backdrop/header-X/
footer Cancel), or `beforeunload`+`sendBeacon` — fires only when
`hubRunStartedRef.current && !uploadStartedRef.current`. Before any run has
started (`"drop"`/`"validating"`), no cancel call is sent at all, not even a
no-op one — P7 in spirit: nothing to report, so nothing is sent.

**R3 — preview back-navigation code-check.** See §H.3 above — confirmed no
such path exists; the guard did not need the extra branch the refinement
anticipated.

**R4 — Hub run-TTL.** Read `docs/integrate-rest-vnggames-hub.md` in full: it
documents no auto-expiry/TTL for a `RUNNING` run — the four terminal
statuses (`SUCCESS`/`FAILED`/`CANCELLED`/`PARTIAL`) are only ever set by an
explicit `PATCH /runs/:id` call; nothing in the contract describes the Hub
itself ever timing out or auto-closing a run left open. **This means the
accepted tab-close-mid-upload orphan (§2.A, §H.4) has no automatic
self-resolution on the Hub side** — an orphaned run from this edge case
would show `RUNNING` on the Hub dashboard indefinitely, until a human closes
it manually or a future session adds a server-side stale-run sweep. This is
a strictly informational bound on an already-accepted edge case, not a
blocker — flagged here so it's documented rather than assumed away.

### Build summary

Shipped: migration (`public.cpp_hub_tracking_config`), `lib/cpp-hub-tracking/`
(config/hub-client/tracking/status-mapping, each with tests), four routes
under `app/api/asc/hub-tracking/{start,cancel,finalize,config}`, a sibling
Settings page + client at `app/(dashboard)/settings/hub-tracking/`, and the
client wiring in `CppBulkImportDialog.tsx` (START on validating→preview,
race-hardened bounded 1s cap, R1 finalize-in-finally, R2 two-ref cancel
guard). New/updated tests: `lib/cpp-hub-tracking/*.test.ts` (67 tests) and
`components/cpp/CppBulkImportDialog.test.tsx` (9 tests) covering the
SUCCESS/PARTIAL/FAILED mapping, the race-drop hardening, R1's unexpected-
error backstop, and all three cancel-guard windows. Gauntlet: typecheck
clean, 2888/2888 tests passing, lint zero errors, production build green.
