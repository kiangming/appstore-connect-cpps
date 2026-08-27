# Apple IAP Management — Knowledge Base

> **Purpose.** Self-contained reference for the IAP Management feature. Read this first to understand *what is built and why*. For operational specifics see `apple-api-reference.md` (endpoint contracts), `pricing-templates-guide.md` (pricing Manager UX), `operational-guide.md` (Bulk Import results/error detail + Hub tracking Manager UX), and the `SESSION-ARC-*` files (chronological "what happened when").
>
> **Authoritative as of** commit `f81032c` (2026-05-20, post-Cycle 34 / IAP.q.3). All file paths verified against the working tree.
>
> **Addendum (2026-07-17):** §§4.10-4.11, 10.15-10.16, and §10.13.K **P5-P9**
> added to capture the reviewSubmissions v2 submit migration and the
> three Hub-tracking integrations (Cycles 45-46) — verified against the
> working tree at the time of writing. Cycles 35-44 predate this
> addendum and were not re-verified as part of it.
>
> **Addendum (2026-07-22):** §4.12 (new landmark), §10.15 extended to the
> 6th+7th Hub-tracking integrations (Apple Set Availabilities / Remove
> from Sales) + its Accepted Limitations table, and §10.17 (new — Cycle
> 47, Bulk Import Notes-cell full Apple error detail) — verified against
> the working tree at the time of writing.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Feature Capabilities Matrix](#2-feature-capabilities-matrix)
3. [Architectural Decisions (Q-IAP Locks)](#3-architectural-decisions-q-iap-locks)
4. [Apple Integration Insights](#4-apple-integration-insights)
5. [Database Schema](#5-database-schema)
6. [Code Architecture](#6-code-architecture)
7. [Operational Guide](#7-operational-guide)
8. [Production Verification](#8-production-verification)
9. [Memory Patterns Crystallized](#9-memory-patterns-crystallized)
10. [Future Development Guidance](#10-future-development-guidance)
11. [Cumulative Metrics](#11-cumulative-metrics-post-cycle-34)
12. [Glossary](#12-glossary)
13. [References](#13-references)
14. [Sign-off](#14-sign-off)
15. [Apple ASC key pool — SHIPPED DARK](#15-apple-asc-key-pool--shipped-dark-2026-08-25)
16. [C3 — PARTIAL at the row level](#16-c3--partial-at-the-row-level-2026-08-25)

---

## 1. Executive Summary

**IAP Management** is an internal tool that lets the team manage Apple App Store In-App Purchases (IAPs) without going through the App Store Connect web UI. It covers the full lifecycle: create, edit, bulk import, configure pricing, submit for review, and view detail with Apple-Connect parity.

### Scope

| Capability | Status |
|---|---|
| Create IAP (single or bulk via Excel) | ✅ |
| Edit attributes (name, reviewNote, familySharable) | ✅ |
| Edit localizations (add / update / delete) | ✅ |
| Edit review screenshot (DELETE + 3-step upload) | ✅ |
| Edit pricing schedule (replace-all) | ✅ |
| Submit for Apple review (single + bulk) | ✅ |
| Pricing templates (Default global + per-app override) | ✅ |
| View detail with 4-section Apple-Connect parity | ✅ |
| Apple state authoritative validation (`MISSING_METADATA` etc.) | ✅ |

### Strategic context

The IAP Management feature is the third deliverable in a five-arc strategic trajectory that closed cohesively on 2026-05-19, then continued with three post-trajectory hardening cycles through 2026-05-20:

| # | Arc | Cycle | Span |
|---|---|---|---|
| 1 | Phase E — Reports analytics (Store Submission) | Pre-IAP | Closed pre-arc |
| 2 | ForwardDedup — Inbox forward dedup (Store Submission) | Pre-IAP | Closed pre-arc |
| 3 | **IAP Management MVP** | 29 | 2026-05-15 → 2026-05-16 |
| 4 | **IAP Pricing Templates** | 30 | 2026-05-17 → 2026-05-18 |
| 5 | **IAP View Detail UI Apple Parity** | 31 | 2026-05-18 → 2026-05-19 |
| Hardening | IAP.q.1 submit validation | 32 | 2026-05-20 |
| Hardening | IAP.q.2 parser tolerance + visibility (cross-module) | 33 | 2026-05-20 |
| Hardening | IAP.q.3 pagination (cross-module) | 34 | 2026-05-20 |

Cycles 33-34 are technically cross-module (touch Store Submissions Apple Reports surface) but inherit the IAP.q.* hardening cadence and share the same Pattern 10 reuse #19 discipline as Cycle 32.

### Current production state

| Metric | Value |
|---|---|
| Total IAP arc commits | ~65 |
| Migrations | 7 (`iap_mgmt` schema) |
| Active routes | 12 route.ts files under `/api/iap-management/` |
| Tests | 1346 → 1815 (+469 net) |
| Memory patterns crystallized | 60+ |
| Q-IAP architectural locks | ~30 |
| Apple V2 IAP trap classes documented | 4 |

---

## 2. Feature Capabilities Matrix

Each capability ties to an Apple endpoint (or composite) and a tool entry point.

| Capability | Tool entry point | Apple endpoint(s) | Cycle |
|---|---|---|---|
| List apps with IAP support | `/iap-management/apps` | `GET /v1/apps` + `asc-apps` proxy | 29 |
| List IAPs for an app | `/iap-management/apps/[appId]` | `GET /v2/inAppPurchases` (paginated) | 29 / 30 (multi-tier filters) |
| Sync IAP states from Apple | `POST /api/iap-management/apps/[appId]/iaps/sync-states` | `GET /v2/inAppPurchases` | 29 (IAP.o.6c) |
| Create IAP (single) | `New IAP` form | `POST /v2/inAppPurchases` + pricing + localizations + screenshot | 29 / 30 |
| Create IAPs (bulk Excel) | `Bulk Import` 4-step wizard | Multiple per row | 29 (IAP.i) |
| Edit attributes | `Edit IAP` form → `Update on Apple` | `PATCH /v2/inAppPurchases/{id}` | 29 (IAP.o.12) |
| Edit localizations | Same form | `POST` / `PATCH` / `DELETE /v1/inAppPurchaseLocalizations` | 29 (IAP.o.12) |
| Edit review screenshot | Same form | `DELETE` then 3-step upload on `/v1/inAppPurchaseAppStoreReviewScreenshots` | 29 (IAP.o.8a / o.9b) |
| Edit pricing schedule | Same form | `POST /v1/inAppPurchasePriceSchedules` (replace-all) | 29 (IAP.o.11d) / 30 |
| Submit single IAP | `Submit` button | `POST /v1/inAppPurchaseSubmissions` | 29 (IAP.o.6a) |
| Submit batch | `Submit Selected` modal | Same endpoint, looped + bucketed | 29 (IAP.o.6b) / 32 |
| Pricing templates (Default global) | `Settings → Pricing Tiers → Default` | Bulk-applied via orchestrator | 30 (IAP.p1.c) |
| Pricing templates (Per-app) | `Settings → Pricing Tiers → Per-App` | Bulk-applied via orchestrator | 30 (IAP.p1.c) |
| Apply template at IAP create | `PricingSourceSelector` on form | Resolved server-side at orchestration | 30 (IAP.p1.f) |
| View detail (Apple parity) | `/iap-management/apps/[appId]/iaps/[iapId]/view` | `GET /v2/inAppPurchases/{id}` + 2-stage `/v1/inAppPurchasePriceSchedules/{id}/manualPrices` | 31 |
| Submit state guard (defence-in-depth) | Server-side recheck in submit-batch route (preflight + execute) | `listAllInAppPurchases` → `GET /v1/apps/{id}/inAppPurchasesV2?limit=200` **paginated (follow `links.next`)** | 32 (IAP.q.1); paginated fix (submit-guard false-NOT_FOUND, IAP.o.7a-class re-break) |
| Export IAP catalog (xlsx) | `Export list` button on IAP list page | Live per-IAP fetch reusing View Detail's price-schedule read (§4.1) | 44 (commit `fbea49a`) |
| Submit batch — reviewSubmissions v2 (per-app toggle) | Same `Submit Selected` modal | `POST/PATCH /v1/reviewSubmissions`, `POST /v1/reviewSubmissionItems` → `inAppPurchaseVersion` | 46 (§4.10/§4.11/§10.16, commit `6bb7023`) |
| Hub run tracking — Bulk Import | Automatic (no UI toggle; Settings page controls config) | N/A (external VNGGames Hub REST API) | 45 (§10.15, commits `95d9413`/`613a9c3`/`4ba8e6f`/`9ed7845`) |
| Hub run tracking — Submit batch | Automatic, reuses Bulk Import's config | N/A (external) | 45 (§10.15, commit `867386a`) |

---

## 3. Architectural Decisions (Q-IAP Locks)

The "Q-IAP" prefix marks an architectural decision locked by Manager prior to or during a sub-chunk. Locks are enforced by tests where possible; otherwise documented in the relevant code module.

### 3.1 Cycle 29 — IAP Management MVP (Q1–Q12 + Q-IAP.1–8)

Initial scope locks taken before any code. Established the boundaries (production-only, Apple sandbox excluded), the type taxonomy (CONSUMABLE / NON_CONSUMABLE / NON_RENEWING_SUBSCRIPTION — no auto-renewable), reuse strategy (CPP Manager's `asc_accounts`), and the workflow shape (Save-as-Draft default + explicit Submit).

| Lock | Decision | Rationale |
|---|---|---|
| **Q1** | Types: CONSUMABLE / NON_CONSUMABLE / NON_RENEWING_SUBSCRIPTION | Auto-renewable subscriptions require Subscription Group / Pricing — different lifecycle, scoped out |
| **Q2** | Production only (no Apple sandbox), metadata validation pre-submit | Tool is for live App Store, not test consoles |
| **Q3** | Independent module, reuse infrastructure but NOT Store Submission App Registry | Different domain — IAPs are App-scoped, not platform-submission-scoped |
| **Q6** | Reuse CPP `asc_accounts` | Single source of truth for Apple credentials |
| **Q-IAP.1** | Reuse `asc_accounts` as-is, thin link to `/settings` | Avoid duplicate credential management |
| **Q-IAP.6** | Save-as-Draft default + explicit Submit button | Apple submission is irreversible; explicit gesture required |
| **Q-IAP.8** | Reuse global admin/member RBAC (no module whitelist) | Internal tool, low risk of unauthorized access |

### 3.2 Cycle 29 — IAP.h overrides (Q-IAP.h.1–3)

Surface-design overrides during the IAP form chunk.

| Lock | Decision |
|---|---|
| **Q-IAP.h.1** | Create IAP = dedicated route (NOT modal — CPP Manager precedent consistency) |
| **Q-IAP.h.2** | Locale UX = sidebar within page (240px, search + 39 locales + has-data dot) |
| **Q-IAP.h.3** | Submit gate = Hybrid live checklist (6 prerequisites) + Apple validation safety net |

**Q-IAP.h.3 is load-bearing.** Apple is the authoritative state source; the local 6-prerequisite checklist is informational only. If Apple changes the IAP state asynchronously (Manager edits in App Store Connect web), the local checklist becomes stale — Cycle 32's submit guard is the defence-in-depth answer.

### 3.3 Cycle 29 — IAP.h2 follow-ups

| Lock | Decision |
|---|---|
| Tier-count contradiction (Alternates) | Include Alternate Tiers; `iap_mgmt.iaps.tier_id` migrated `INT → TEXT` |
| Screenshot filename matcher | Robust both-forms: literal preferred, dots-as-underscores fallback |
| Type column in Excel template | Optional column; empty/absent → CONSUMABLE default; invalid → row error. **Restored by Hotfix 27** after the parser was discovered to be doing strict positional validation that violated this lock — header lookup is now name-based, only `Product ID` + `Reference Name` are required. |
| Tier inference | Price (USD) lookup → `tier_id` from `price_tier_territories` cache; no separate Tier column needed in v2 template |

### 3.4 Cycle 29 — IAP.o.* hotfix-driven locks

Surfaced during MV28-30 hotfix run.

| Lock | Decision | Sub-chunk |
|---|---|---|
| Apple 2-stage workflow | Create + Submit are separate operations | IAP.o.6a |
| ~~`existsOnApple_validated` tri-state~~ | ⚠ **PHANTOM — this column was never built.** No migration defines it, no code reads or writes it. The lock's *intent* (never a silent "unknown" sync state) shipped as `apple_iap_id IS NULL` + the `not_synced` 409. See [§4.15](#415-landmark--existsonapple_validated-does-not-exist-either--phantom-field-2-in-this-module) | IAP.o.6 |
| Screenshot endpoint family | `appStoreReviewScreenshot` (NOT `inAppPurchaseAppStoreReviewScreenshot`) | IAP.o.9b |
| Pricing match by USD `customerPrice` | Replace tier-number matching with customer-price lookup | IAP.o.10a / o.11d |
| Multi-stage update orchestration | Attributes → Localizations → Screenshot → Pricing, each with audit log | IAP.o.12 |

### 3.5 Cycle 30 — Pricing Templates (Q-IAP.p1.A–K)

Strategic upgrade to the 3-source pricing model (Apple / Default Template / Per-App Template). All locks enforced by tests in `lib/iap-management/queries/templates.ts` and `lib/iap-management/apple/pricing-orchestration.ts`.

| Lock | Decision | Rationale |
|---|---|---|
| **Q-A** | REPLACE-ONLY template versioning v1 (no history) | YAGNI — Manager can re-upload; version history adds storage + UI complexity not yet needed |
| **Q-B** | Atomic migration with defensive `price_tier_territories` backup retention | Rollback safety — legacy table kept until production stability period elapses |
| **Q-C** | Per-territory price-point fetch acknowledged as documented overhead | Apple opaque price-point IDs require per-territory lookup; not a bug to optimise |
| **Q-D** | Most-specific default for pricing source (app → default → Apple) | Predictable Manager UX — overrides cascade narrowest-first |
| **Q-E** | Batch-level pricing-source selector in Bulk Import (not per-row v1) | Per-row override deferred; one-source-per-batch is the 80% case |
| **Q-F** | Update-on-Apple source threading runs pricing stage on source-only change | Source change is a meaningful edit even without attribute change |
| **Q-G** | Apply pricing template to existing IAPs bulk action — deferred post-MVP | Risky bulk operation; defer until Manager explicitly needs it |
| **Q-H** | Apple intermittent 500 retry budget extended to 5 attempts with jitter | Empirical: Apple pricing endpoint 500s happen during their busy hours |
| **Q-I** | Same Tier × Territory matrix format (sparse XLSX, blank cells = no override) | Manager-friendly format; parser handles sparsity |
| **Q-J** | Per-creation explicit selection | Manager confirms pricing source per IAP, no implicit inheritance |
| **Q-K** | `partial-template-fail` graceful degradation (fail-soft outcome) | Template entry with no Apple match → log + continue, don't abort |

### 3.6 Cycle 31 — View Detail UI (Q-IAP.p2.A–K)

UI design locks during the Apple-Connect parity view detail surface.

| Lock | Decision | Rationale |
|---|---|---|
| **Q-A** | Inline edit deferred to IAP.p3; view-only v1 with Edit button navigation | Scope discipline — read-then-write is two cohesive arcs, not one |
| **Q-B** | Price detail SUMMARY default + "Show all" expansion | 175 territories is too many for default view; summary = key territories only |
| **Q-C** | Single-round-trip relationship traversal (later proved impossible, pivoted to 2-stage at p2.j) | Apple's V2 `?include` whitelist enforced strict | (later disproved by p2.j) |
| **Q-D** | 5-color status palette simplified from Apple's full enum | UX clarity — collapse semantically-equivalent states (READY_FOR_SALE ≈ APPROVED) into one color |
| **Q-E** | Screenshot click-to-enlarge modal + locale link navigation | Manager workflow: spot-check screenshot, click locale to inspect |
| **Q-F** | Refresh from Apple — manual button + auto on mount | Default-fresh on first render; manual button for re-sync |
| **Q-G** | Top-right action bar cluster (Refresh · Apple Connect · Edit) | Apple Connect convention |
| **Q-H** | Single Apple Connect deep link (no per-section links) | Deep-link cardinality discipline; users follow one link, not seven |
| **Q-I** | Tooltips as pre-written string-map (i18n-ready) | Centralized lookup in `lib/iap-management/tooltips.ts`, no JSX-embedded copy |
| **Q-J** | Responsive — md+ two-col, below md stack | Manager works on laptop primarily; mobile is fallback |
| **Q-K** | Price section IN p2.d scope (not deferred) | Bundled — price detail is what Manager looks at most |

### 3.7 Post-trajectory hardening locks (Cycles 32–34)

Production-observation-driven cycles. Same Pattern 10 reuse #19 discipline, narrower scope.

| Cycle | Trigger | Decision |
|---|---|---|
| **32 (IAP.q.1)** | MISSING_METADATA items still checkbox-selectable on IAP list | Option II (UX): gate `eligible` by Apple state + tooltip surface blocker. Option IV (server): defence-in-depth state recheck in submit-batch route + `?skipCheck=true` bypass for internal callers |
| **33 (IAP.q.2)** | TICKET-10021 reports "4 reasons couldn't be parsed" on Apple Reports (cross-module) | Option I (parser): widen regex to 1-3 numeric levels + optional sub-letter `(a)/(b)/(c)`. Option V (visibility): expandable footer surfacing unparsed entries with Inbox deep-links |
| **34 (IAP.q.3)** | Manager wants paginated display above 20 items on Apple Reports | Both surfaces paginated at 20/page, hide-controls-when-≤20 threshold, component-local state, SQL `.order('created_at', desc)` for boundary determinism |

---

## 4. Apple Integration Insights

**These four trap classes account for ~80% of the Cycle 29-31 hotfix volume. Read before wiring any new Apple V2 endpoint.** Each is enforced by a test in `lib/iap-management/apple/api-schemas.integration.test.ts` where contract-shape pinning is possible.

### 4.1 LANDMARK — Apple V2 `?include` relationship truncation (IAP.p2.m)

**Symptom**: tool renders fewer rows than the Apple Connect web UI. Diagnostic fingerprint: Railway log shows Stage 1 `manualRel_count` < Stage 2 `apple_total`.

**Behavior**: Apple's V2 endpoints with `?include=manualPrices` cap the relationship enumeration at **10 IDs** even when the schedule actually has more (observed 12 at MV30). The included `data` array contains the full set; only the **relationship pointer** is truncated.

**Mitigation**: never trust `relationships.{rel}.data` as the authoritative ID list for an included relation. Use the V1 sub-resource endpoint (`/v1/inAppPurchasePriceSchedules/{id}/manualPrices`) for the full set, or iterate the merged `included` payload directly.

**Pattern crystallized**: Apple API specification ≠ Apple API behavior. Railway logs = ground truth.

### 4.2 customerPrice match discipline (IAP.o.10a / o.11d)

**Symptom**: pricing schedule POST silently does nothing on Apple side. Diagnostic fingerprint: tool's `price_tier_id` doesn't appear in any Apple price-point list.

**Behavior**: Apple's price points are **opaque IDs** referenced by `(territory, customerPrice)` rather than the historical numeric tier (Tier 1 / Tier 2 / …). Apple's 2024 tier rollover changed the numbering; tools relying on tier numbers silently mismatch.

**Mitigation**: fetch `/v2/inAppPurchases/{id}/pricePoints?filter[territory]=USA` and match by `customerPrice` (USD amount). Cache per-orchestration via `territory-price-points-cache.ts` to avoid N+1 fetches in bulk paths.

**See**: `lib/iap-management/apple/price-points.ts`, `lib/iap-management/apple/territory-price-points-cache.ts`.

### 4.3 Screenshot 3-step upload (IAP.o.8a / o.9b)

Apple's IAP review screenshot upload is a 3-step protocol, NOT a single multipart POST. Resource path is `appStoreReviewScreenshot` (singular, NOT `inAppPurchaseAppStoreReviewScreenshot`).

**Protocol**:
1. **DELETE existing** (if any) — `DELETE /v1/appStoreReviewScreenshots/{id}`
2. **POST asset reservation** — `POST /v1/appStoreReviewScreenshots` with `fileSize` + `fileName` → returns `uploadOperations[].url` (presigned S3-like URL)
3. **PUT to upload URL** — `PUT <uploadOperations[].url>` with raw bytes + headers
4. **PATCH to commit** — `PATCH /v1/appStoreReviewScreenshots/{id}` with `{ uploaded: true, sourceFileChecksum }`

**Mitigation**: see `lib/iap-management/apple/screenshot-upload.ts` for the canonical implementation. Edit flow replaces existing → bulk path's 3-step uploader is reused (single-IAP create path catches-22: reserve needs `apple_iap_id`, hence Cycle 29 D1 deferral).

### 4.4 Multi-stage update orchestration (IAP.o.12)

Apple's `InAppPurchaseV2UpdateRequest` does NOT accept localizations, screenshot, or pricing in one call. Updating a synced IAP requires sequencing 4 stages, each with its own audit-log action_type.

**Pipeline** (in `lib/iap-management/apple/update-orchestration.ts`):
1. **Precheck** — Apple state validation via `state-edit-blocked.ts` (refuse if `WAITING_FOR_REVIEW` / `IN_REVIEW`)
2. **Attributes** — `PATCH /v2/inAppPurchases/{id}` with name / reviewNote / familySharable
3. **Localizations** — `POST` / `PATCH` / `DELETE /v1/inAppPurchaseLocalizations` driven by diff-detector
4. **Screenshot** — DELETE + 3-step upload pattern if changed
5. **Pricing** — `POST /v1/inAppPurchasePriceSchedules` (replace-all schedule)

Each stage has per-stage try/catch + Railway log + audit-log write. Failure in stage N doesn't abort N+1 (each is independently audited); UI surfaces stage-level success/failure.

**Action types** — ⚠ **CORRECTED (Aug 2026).** The previous list had 4 of 5 names wrong; these are the values the code actually emits, verified against `lib/audit-constraints/registry.ts` (which the guard test holds against the live CHECK):

| Stage | action_type actually emitted | Emitted at |
|---|---|---|
| 2 Attributes | `UPDATE_ATTRIBUTES_ON_APPLE` | `update-orchestration.ts:169,258,269` |
| 3 Localizations | `UPDATE_LOCALIZATION_ON_APPLE` (**singular**), plus `ADD_LOCALIZATION_ON_APPLE` and `DELETE_LOCALIZATION_ON_APPLE` — three types, one per diff verb, not one `UPDATE_LOCALIZATIONS_ON_APPLE` | `update-orchestration.ts:335-442` |
| 4 Screenshot | `REPLACE_SCREENSHOT_ON_APPLE` (not `UPDATE_SCREENSHOT_ON_APPLE`) | `update-orchestration.ts:470,485,503` |
| 5 Pricing | `SET_PRICE_SCHEDULE` — **reused** from IAP.o.11d. There is no `UPDATE_PRICING_ON_APPLE`; migration `20260518000000`'s own header states pricing reuses the existing type. | `pricing-orchestration.ts:423` |
| 6 Availability | `AVAILABILITY_SET_ALL_TERRITORIES` / `AVAILABILITY_REMOVE_FROM_SALES` — was missing from this list entirely, and from the CHECK until `20260811000000` | `update-orchestration.ts:577-608` |

There is **no `UPDATE_ON_APPLE` parent rollup**, and none is needed. Checked before writing it off as a doc error: the string appeared in exactly one place repo-wide — this KB line. `actions_log` has **zero code readers** (insert-only; every read is a Manager SQL query), the diagnostic SQL reads only `SET_PRICE_SCHEDULE` / `CREATE_ON_APPLE` (`queries/pricing-diagnostic.sql`), and the result UI renders `outcome.stages.*` from the route response, not the audit log. Nothing reads or expects a rollup row, and the per-stage rows already carry the full picture (each stage is independently audited by design). ⇒ documentation inaccuracy, not a missing feature.

### 4.5 Apple state machine (relevance to tool)

States Apple exposes via `inAppPurchaseState`:

```
MISSING_METADATA → PREPARE_FOR_SUBMISSION → READY_TO_SUBMIT → WAITING_FOR_REVIEW
                                                                ↓
                                          (Apple review)        ↓
                                                                ↓
                                                IN_REVIEW → APPROVED / REJECTED
                                                                ↓
                                                  REMOVED_FROM_SALE / DEVELOPER_ACTION_NEEDED
```

**Tool gating** (load-bearing rules):

| State | Tool behavior |
|---|---|
| `MISSING_METADATA` | Manager must complete metadata; submit guarded (Cycle 32) |
| `PREPARE_FOR_SUBMISSION` | Editable; submit not yet allowed |
| `READY_TO_SUBMIT` | ONLY state that the submit-batch route permits without `?skipCheck=true` |
| `WAITING_FOR_REVIEW` / `IN_REVIEW` | Edit-blocked via `state-edit-blocked.ts` (Q-IAP.o.6) |
| `APPROVED` / `REJECTED` | Edit permitted; re-submit cycle |

### 4.6 V2 `?include` whitelist (IAP.p2.j)

Apple's V2 schedule endpoint enforces a **strict whitelist** on `?include`. Nested or unsupported chains return `400 PARAMETER_ERROR.INVALID`. Whitelist for `/v1/inAppPurchasePriceSchedules/{id}`: `[baseTerritory, manualPrices, automaticPrices]`. Nested `?include=manualPrices.priceTier` is rejected.

**Mitigation**: 2-stage fetch — V2 endpoint for header + top-level relationships; V1 sub-resource endpoint for deep traversal (e.g. price-point details).

### 4.7 Sub-letter Apple guideline notation (Cycle 33, cross-module)

Apple's reject-reason emails cite sub-clauses with letter suffix:
- `Guideline 2.1(b) - Information Needed`
- `Guideline 4.3(a) - Design - Spam`
- `Guideline 3.1.2(c) - Business - Payments - Subscriptions`
- `Guideline 3 - Business` (bare top-level)

**Mitigation in `lib/store-submissions/queries/reports.ts:extractGuidelines`**:
```
/^Guideline\s+(\d+(?:\.\d+){0,2})(?:\(([a-z])\))?\s*[-–—]\s*(.+?)\s*$/gm
```
- 1-3 numeric levels (was 2-3 pre-IAP.q.2)
- Optional lowercase sub-letter capture
- Canonical code preserves sub-letter: `2.1(b)` and `2.1(c)` aggregate as distinct buckets

### 4.8 Orchestrator-bypass-retry trap class (Cycle 40 Phase A)

**Pattern.** A multi-row orchestrator wraps each row in `withConcurrency`
but the per-row work calls Apple via a *helper* (e.g.
`setAvailabilityToAllTerritories`) that internally uses `iapFetch`
*bare* — no `withRetry`. Helpers are intentionally retry-naive so
callers compose retry policy; if a caller forgets, every 429 surfaces as
a per-row failure with no backoff attempt and no `onRetry` telemetry.

**Symptom.** Manager-visible: "rate limit hitting, no retry signal."
Audit logs show ERROR rows with raw Apple 429 bodies, no `rate_limit`
counters present. Railway logs show `[iap-apple] ... → 429
rate-limited (retry-after=...ms)` followed by nothing — the orchestrator
caught the throw and moved on.

**Diagnostic fingerprint.** Grep `lib/iap-management/orchestrators/`
for direct invocations of Apple helper functions; ensure every such
call site is wrapped in `withRetry` (or the per-row tracked variant).
At Cycle 40 Phase A only one orchestrator was leaking: the Cycle 39
Phase 2 bulk-availability orchestrator. The Cycle 29 Bulk Import path
was already covered by `trackedWithRetry` (Hotfix 26).

**Fix.** Either thread `withRetry` through the orchestrator, or wrap
helper internals — Phase A picked the orchestrator-side wrap to match
the established Hotfix 26 pattern (`trackedWithRetry(counters, () =>
helper(...))`). Future orchestrator additions should treat
orchestrator-side retry as the default; helpers stay retry-naive so
single-call routes can still tune backoff per use case.

**Forensic.** Phase A's investigation found 2 bare call sites in
`lib/iap-management/orchestrators/bulk-availability.ts:113-114`. Every
other Apple-helper call site project-wide is already covered
(create-on-apple, submit, submit-batch, sync-states, single-IAP
availability lazy-load, all 10 bulk-import sites). Audit script:
`grep -rn "setAvailability\|createInAppPurchase\|submitInAppPurchase"
app/api lib/iap-management/orchestrators | grep -v withRetry`.

### 4.9 X-Rate-Limit budget header (Cycle 40 Phase A institutional knowledge)

Apple's ASC API emits a budget header on most (not all) responses:

```
X-Rate-Limit: user-hour-lim:3600;user-hour-rem:1450;
```

Format is semicolon-delimited key/value pairs. Two documented fields:

| Field | Meaning |
|---|---|
| `user-hour-lim` | Hourly request budget for the ASC token (typically 3600) |
| `user-hour-rem` | Remaining requests in the current hour window |

**Parser discipline.** `parseRateLimit` now lives in
`lib/shared/apple-fetch.ts` (re-exported unchanged from
`lib/iap-management/apple/fetch.ts`). It is *defensive*: returns null
when the header is absent, when only one of the two fields is present,
or when a value is anything other than a run of digits. The parser MUST
NOT throw out of a successful Apple response just because the header
changed shape — this is a read-only observability surface.

⚠ **"Unreadable" and "zero" are different answers** (pre-E2 hardening,
Aug 2026). The guard used to be `Number.isFinite(Number(value))`, and
`Number("")` is **0**, not NaN — so an empty component
(`user-hour-rem:;`) parsed as `remaining: 0`, i.e. "budget exhausted",
when the truth was "could not read it". Same for `-5` (finite, and
meaningless as a budget). The guard is now `/^\d+$/`, so every shape
that cannot be a reading stays a non-reading. A **real** `0` still
parses — swallowing it would trade a false "exhausted" for a false
"unknown" and be equally wrong.

This mattered ahead of any consumer: today `remaining` only reaches a
log line, but the moment a pacing layer reads it to decide whether to
keep dispatching, the same confusion freezes a job for no reason. Fixed
before that consumer exists, not after.

**Phase A surface.** `iapFetch` emits a structured Railway log line on
every response that carries the header:

```
[asc-client] GET /v2/inAppPurchases/abc → 200 budget=1234/3600 duration=180ms key=2X9R4HXF34
```

Grep-friendly tag: `[asc-client] budget=`. The trailing `key=` field
(pre-E2 hardening, Aug 2026) names **which** ASC key spent the budget —
required to attribute consumption once more than one key is in play, and
**appended** rather than inserted so the pre-existing
`[asc-client] … budget=` grep keeps matching unchanged. Manager can audit budget
consumption across a workflow by tailing Railway logs and filtering on
this prefix. Endpoints that omit the header produce no `[asc-client]`
line — the existing `[iap-apple]` line still records status + endpoint.

**Phase B contingency.** A future Phase B (token bucket throttler +
universal `ascFetch` refactor) is justified only if Phase A's empirical
data shows persistent low budget remaining or 429 cascades that
`withRetry` can't recover from. The X-Rate-Limit visibility added in
Phase A is the gate that decides Phase B's go/no-go.

**Cap-figure conflict — ✅ RESOLVED BY MEASUREMENT (2026-08-25).**

KB §10.8 carried two inconsistent claims about Apple's hourly request
budget, differing by an order of magnitude:

| Source | Claim | Verdict |
|---|---|---|
| Hotfix 25 | "Apple's 250 req/hour cap" | ❌ **WRONG** |
| Hotfix 26 | "~1 req/sec/token" (≈ 3,600/hour) | ✅ **CORRECT** |

**`user-hour-lim` = 3,600.** Read straight off a live Apple response:

```
x-rate-limit: user-hour-lim:3600;user-hour-rem:3599;
```

Three facts land at once, and all three had been open:

1. **The header exists on the wire, under exactly this name and shape.**
   Until this measurement, every `X-Rate-Limit` fixture in the repo was
   hand-written from Apple's docs and asserted against our own parser —
   a tautology that could not tell a correct parser from one reading a
   header that does not exist. It reads a real one. Every historical
   `[asc-client] … budget=` line was genuine.
2. **The cap is 3,600/hour, not 250.** Every calculation in this repo
   built on 250 is obsolete — see the "obsolete" annotations in §10.8
   and in the three design docs that modelled both scenarios.
3. **The window really is rolling.** `rem` opened at 3,599 = `lim − 1`
   on a key that had been idle ~60 min, and moved 3,599 → 3,598 across
   two requests 5 s apart (delta exactly −1). A fixed window would not
   have been full mid-hour.

⚠ **AND THE HEADER IS ABSENT FROM THE ENDPOINTS THAT ACTUALLY SPEND THE
BUDGET** (measured 2026-08-25, same session). This section used to say Apple
emits it "on most (not all) responses". The real distribution is worse than
that phrasing suggests:

| Endpoint | `x-rate-limit` |
|---|---|
| `GET /v1/territories` | ✅ present |
| `GET /v2/inAppPurchases/{id}` | ❌ **absent** |
| `GET /v1/inAppPurchasePriceSchedules/{id}/manualPrices` | ❌ **absent** |

Verified by dumping the full response header list, not by a parser returning
null — the other 18 headers arrive normally on all three; `x-rate-limit` is
simply not among them on the V2 IAP read or the price-schedule read.

Those two are **2 of the 3 requests every exported item costs**. So the
endpoints whose volume creates the problem are exactly the ones that report
nothing. Three consequences, all of which contradict earlier assumptions in
this file:

1. **The `[asc-client] budget=` production log is far sparser than assumed.**
   It fires on territory/app reads, essentially never during a large export
   or a bulk import. A quiet log does NOT mean a quiet budget.
2. **Budget-aware pacing (Phase B / E2) is weakened at its root.** It would
   be pacing off a `remaining` value last refreshed by an unrelated endpoint
   minutes earlier. Not useless — the value is still Apple's own count, not
   ours — but it cannot be treated as live during the jobs that matter.
3. **Budget-aware KEY SELECTION has the same problem**, and it is why the
   pool design should not assume it can pick "the key with the most budget
   left" (see `[RATELIMIT-keypool-design]`).

This also *strengthens* the case for the key pool over pacing: you cannot
pace precisely against a number you cannot read, but you can add headroom
without reading anything.

### ⏳ OPEN — does a 429 carry `Retry-After` when `x-rate-limit` is absent?

**Status: awaiting the first natural 429. Nothing to decide until then.**

The key-pool cooldown (K3) has to choose how long a spent key stays out of
rotation. It currently uses a conservative **rolling hour**, derived from the
`user-hour-rem` definition measured above. Apple's `Retry-After` would be
better — it is Apple's own number — but the endpoints the pool actually
serves are the ones proven above NOT to send `x-rate-limit`, and assuming
they send a *different* optional header would be the Hotfix 25 mistake with
the serial numbers filed off.

**Why this is not being measured on demand.** Provoking a 429 means
deliberately burning an hour of a real key's budget on a live team, to learn
something that will arrive for free the first time a large export or bulk
import runs into a real limit.

**How the answer arrives.** `appleFetch`'s 429 branch prints the complete
header list. Grep Railway for:

```
[key-pool] 429-headers
```

The line carries `retry-after=<value|ABSENT>`, `x-rate-limit=<value|ABSENT>`
and every header name on the response.

**What to do with it.** Record the observation here. Then:
- `Retry-After` **present** → it already shortens the cooldown automatically
  (`cooldownDurationMs` prefers it, clamped to one hour). Nothing to change;
  just delete the now-answered question and the DEBUG line.
- `Retry-After` **absent** → the hour is the only signal there is. Say so
  here, so nobody re-opens this as a possible optimisation later.

**Method — repeat this if you ever doubt the number.** Two read-only
`GET /v1/territories?limit=200`, ~5 s apart, signed with the **production
signing path** (`lib/asc-jwt.ts` — jose, ES256, `kid`, `exp = +20 min`)
and parsed with the **production parser** (`parseRateLimit`,
`lib/shared/apple-fetch.ts`). Using the real code on both ends is the
point: a hand-rolled probe would only prove that a hand-rolled probe
works. `/v1/territories` is the cheapest idempotent GET in the API —
no app, no IAP, no write. Total cost: 2 requests out of 3,600.

⚠ Measured on the **first** account in `ASC_ACCOUNTS`. Whether 3,600 is
per-key or per-team is a **separate, still-unmeasured** question — it
needs a second key on the same team — that is **K4**, tracked under
`[RATELIMIT-keypool-design]` in TODO.md. (⚠ This paragraph used to cite
`[RATELIMIT-keypool-if-demand]`, a tag that was never registered anywhere;
the work was folded into the keypool-design item when the pool was designed.
Corrected 2026-08-26 by the registry sweep.) Do not read this number as
"3,600 per key" until that is measured.

### 4.10 LANDMARK — CPP and IAP share ONE items-only reviewSubmission slot per (app, platform)

Apple allows **up to two** open `reviewSubmissions` per (app, platform) at
a time: one that includes an app version, and one **items-only**
submission (no app version) that carries things like Custom Product
Pages, In-App Events, or (as of the v2 migration, §10.16) In-App
Purchases. **CPP submissions and IAP submissions are BOTH items-only —
they compete for the exact same single slot.**

Source: Apple's official Help doc, [Overview of submitting for
review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review/)
— "Each platform can have one app version submission under review at a
time. A platform can have a maximum of two submissions under review at a
time: one that includes an app version and one that includes items... 200
items per submission" is Apple's own stated cap ([Submit an In-App
Purchase](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase/)).

**Consequence — any submission code for EITHER module must create-or-reuse
the app's open items-only `reviewSubmission`, never blind-create.**
Blind-creating 409s whenever the other module (or a prior partial batch)
already has the slot occupied. This was a **latent, pre-existing bug in
CPP** — CPP's `reviewSubmissions` implementation always POSTed a new
container and had no pre-check — only surfaced and fixed when the IAP v2
migration made the slot-sharing collision routine rather than rare
(`6bb7023`; shared fix in `lib/shared/review-submission.ts`, backported to
CPP's `prepareCppSubmission`). See §10.16 for the full migration and
§10.15/Decision A for the conflict-dialog UX this enables (never silently
co-submit the other module's items).

### 4.11 LANDMARK — IAP submission migrated to the reviewSubmissions mechanism (v2)

IAPs are now submitted via the same `reviewSubmissions` /
`reviewSubmissionItems` container mechanism CPP already used — a new
`reviewSubmissionItem` relationship (`inAppPurchaseVersion` →
`inAppPurchaseVersions`) sits alongside CPP's
`appCustomProductPageVersion`, confirmed directly against Apple's OpenAPI
spec schema for `ReviewSubmissionItemCreateRequest`. The old
`POST /v1/inAppPurchaseSubmissions` mechanism was announced deprecated by
Apple on 2026-07-15 with **no sunset date** — kept fully intact behind a
toggle for rollback (§10.16), not removed.

**Confirmed empirically** (live `GET /v2/inAppPurchases/{id}/versions`
against 5 real production IAPs): a `READY_TO_SUBMIT` IAP already has an
`inAppPurchaseVersion` in state `PREPARE_FOR_SUBMISSION` — the new submit
flow only needs to **read** the version id, not create one, in the common
path (`POST /v1/inAppPurchaseVersions` exists only as a rare defensive
fallback with no observed real-world trigger yet).

**Caveat inherited from §4.9's pattern (spec vs. behavior)**: the OpenAPI
spec's `deprecated` flag is **not reliably set** — `/v1/inAppPurchaseSubmissions`
shows `deprecated:false` in the spec despite Apple's own announcement
saying otherwise, while unrelated old GET endpoints (`GET
/v1/inAppPurchases/{id}`) DO show `deprecated:true`. **Treat Apple's
announcement as authoritative on deprecation status; treat the spec as
authoritative on new endpoint request/response shapes.** Full migration
design: §10.16 and [design-iap-v2-submission-migration.md](design-iap-v2-submission-migration.md).

### 4.12 LANDMARK — Apple exposes IAP availability through ONE write endpoint; "Remove from Sales" is a re-POST with an empty territory list

`POST /v1/inAppPurchaseAvailabilities` is the **only** write path for an
IAP's territory availability — confirmed against `openapi.oas.json`:
`/v1/inAppPurchaseAvailabilities` exposes `createInstance` (POST) only,
and `/v1/inAppPurchaseAvailabilities/{id}` exposes `getInstance` (GET)
only. **No PATCH, no DELETE anywhere on this resource.**

⚠ *Historical for the bulk modal only — see §4.14. Arbitrary subsets ship on
the Edit form and Bulk Import; the bulk modal itself is still all-or-nothing.*

Both "Set Availabilities" (all territories) and "Remove from Sales" (zero
territories) are therefore the exact same call —
`setAvailabilityToAllTerritories` / `setAvailabilityRemoveFromSales`
(`lib/iap-management/apple/availabilities.ts`) both POST fresh, replacing
whatever availability snapshot existed before:

| | `availableInNewTerritories` | `availableTerritories.data` |
|---|---|---|
| Set Availabilities (ALL) | `true` | full territory list (`getAllTerritoryIds`) |
| Remove from Sales (NONE) | `false` | `[]` — the OpenAPI schema requires the relationship's `data` array but sets no `minItems`, so empty satisfies the contract |

First confirmed at the original edit-form implementation (§10.8, Cycle
39 Phase 1); re-confirmed and reused unchanged by the Hub-tracking
integration over the bulk-actions path (§10.15, 6th+7th integrations) —
tracking wraps the SAME two calls, it doesn't introduce a third Apple
operation.

### 4.13 LANDMARK — `availableInAllTerritories` does not exist; the real flag is forward-looking, and "All" ≠ "175 ticked by hand"

**Symptom.** Three docs (this KB's backlog row, `apple-api-reference.md`,
two session archives) named a field `availableInAllTerritories` as the
thing standing between the tool and territory editing. Anyone planning
from those docs looks for a boolean that is not there.

**Behavior.** `availableInAllTerritories` appears **zero times** in OAS
4.3.1 (`docs/iap-management/openapi.oas.json`) *and* 4.4.1
(`docs/openapi.oas.v20260717.json`). The only attribute on
`InAppPurchaseAvailabilityCreateRequest` is **`availableInNewTerritories`**
(required, boolean) — and it means something different:

| Field | Meaning |
|---|---|
| ~~`availableInAllTerritories`~~ | **does not exist** |
| `availableInNewTerritories` | **forward-looking** — auto-include markets Apple launches *later*. Says nothing about the current set. |

**Consequence that must reach the UI.** Because the flag is independent
of the list, two selections that look identical send different bodies:

| Manager intent | `availableInNewTerritories` | `availableTerritories.data` |
|---|---|---|
| "All countries or regions" | `true` | all ~175 |
| all 175 ticked by hand | `false` | all ~175 (same ids) |
| a subset | `false` | the chosen N |
| Remove from Sales | `false` | `[]` |

⇒ **A UI that renders those first two states identically is lying about
what it will send.** This is pinned by a test, not left to convention
(`territory-selection.test.ts` — "All vs 175-ticked-by-hand").

**Pattern crystallized.** *A doc naming a field is not evidence the field
exists.* The code was right all along
(`lib/iap-management/apple/availabilities.ts:5-18` has said so since
Cycle 37); the docs propagated the phantom for three cycles because
nobody grepped the spec. Grep the OAS before planning around any field
name you first met in prose.

---

## 5. Database Schema

### 4.14 Per-territory availability — as shipped (arc `19051e8..6f206f8`)

Summary only; procedures live in `operational-guide.md` §4 and the request
shape in `apple-api-reference.md`.

**What shipped.** Arbitrary territory subsets on two reachable surfaces: the
Edit form for one synced item (defaults to the item's CURRENT territories) and
Bulk Import step 4 for a whole batch (defaults to ALL). One selection per
batch; no per-row override. All writes funnel through
`setAvailabilityTerritories` — a single choke point with a structural guard.
Action type is derived from **what was sent**, never the control clicked:
`AVAILABILITY_SET_ALL_TERRITORIES` survives only for all-plus-flag, so old rows
stay true; everything else is `AVAILABILITY_SET_TERRITORIES`, and the empty set
is `AVAILABILITY_REMOVE_FROM_SALES`.

**Three latent defects the arc surfaced — all pre-existing, all now fixed:**

1. **A complete feature unreachable behind a stale zod enum (LAYER-GAP #5).**
   SC2 shipped a selection-driven orchestrator and SC3 shipped stop-and-resume
   on top of it. Both were correct and **neither could be invoked**: the route
   schema still read `z.enum(["set-all","remove"])` and rejected the third
   action at the HTTP boundary. Undetected for two chunks because every test
   below the route called the orchestrator *directly* — no test ever put a
   request body through the real schema. **Rule: a feature reached over HTTP
   needs at least one test that crosses the HTTP boundary.** Unit tests on both
   sides of a schema prove nothing about the schema.

2. **A stopped run reported to the hub as SUCCESS (status principle).** The
   shared terminal-status mapping keys off `failed`, and a rate-limit stop
   typically ends with `failed === 0` plus a large NOT_ATTEMPTED remainder — so
   it mapped to SUCCESS and the hub row claimed a 50-item batch completed while
   N items were never attempted. A stopped run is PARTIAL by definition: some
   work landed, some was deliberately abandoned. **Rule: any roll-up that
   buckets by success/failure must account for a third "not attempted" state
   before it can be trusted.**

3. **A rate-limit guarantee resting on a cache TTL.** Bulk Import's per-row
   availability step called `setAvailabilityToAllTerritories`, which resolves
   the catalogue internally — so the catalogue lookup was *invoked per row* and
   stayed one Apple request only because the module-scope 1 h cache absorbed the
   repeats. A cold process mid-run, or a batch crossing the hour, would have
   become N reads on top of N writes. Now resolved once before the row loop and
   passed down. **Rule: if "we only call this once" is load-bearing, make it
   structural — a cache making it true is a coincidence, not a design.**

**Two defects found during the closing docs pass, still open** (see `TODO.md`):

- The bulk modal's subset picker has **no UI entry point** — nothing sets
  `bulkMode = "set-territories"`. Same layer-gap shape as #1, one layer further
  out: HTTP fixed, entry point never added. A build-it-then-wire-it sequence
  needs the wiring step tracked as its own deliverable, or it evaporates.
- `set-all` / `remove` render `NOT_ATTEMPTED` as **"Failed"** — those modes
  still use the legacy `ProgressList`, which keys off `ok` alone, and a
  never-attempted row carries `ok: false`. SC3 gave the *shared* orchestrator a
  third state without updating the legacy view that consumes it. **Adding a
  state to a shared producer obliges an audit of every consumer.**

### 4.15 LANDMARK — `existsOnApple_validated` does not exist either — phantom field #2 in this module

**Symptom.** Three places in this KB (§3.4 lock table, §9.2 integration-depth
list, §12 glossary) plus one session archive
(`SESSION-ARC-2026-05-15-FINAL-summary.md:289`) described
`existsOnApple_validated` as a **tri-state column on `iap_mgmt.iaps`**
(`NEVER_SYNCED` / `OK` / `FAILED`). A session planning the Set Availabilities
item-list redesign went looking for it to classify "not yet synced to Apple"
and found nothing.

**Behavior — the column has never existed.** Verified exhaustively, not
sampled:

| Search | Result |
|---|---|
| `grep -rn "exists_on_apple\|existsOnApple" supabase/migrations/` | **0 hits** |
| `grep -rni "exists_on_apple\|existsonapple"` repo-wide (excl. `node_modules`, `.git`) | **0 hits outside `docs/`** |
| `grep -rn "NEVER_SYNCED"` repo-wide | **0 hits outside the same KB lines** — the enum values are phantom too |
| `iap_mgmt.iaps` column list ([20260515000000:82-102](../../supabase/migrations/20260515000000_iap_mgmt_init.sql#L82-L102)) | no such column; later `ALTER`s add only `pricing_source` and three `custom_prices_baseline_*` |

**What actually shipped for the lock's intent.** The requirement — *never a
silent "unknown" sync state* — is real and is satisfied, by a different and
simpler mechanism:

| Question | Real mechanism |
|---|---|
| Is this IAP on Apple? | **`apple_iap_id IS NULL`** — [`listDraftIaps`](../../lib/iap-management/queries/iaps.ts#L325-L335), the partial index [20260515000000:106](../../supabase/migrations/20260515000000_iap_mgmt_init.sql#L106), and the availability route's `409 not_synced` ([route.ts:89](../../app/api/iap-management/iaps/%5BiapId%5D/availability/route.ts#L89)) |
| Did the last sync fail? | not persisted per-row; surfaced per-run in `iap_mgmt.actions_log` |
| Is an edit likely blocked? | `state-edit-blocked.ts` — a *different* concern, and its own header attributes it to IAP.o.12a, not IAP.o.6 |

⚠ Note the ambiguity that helped this survive: `IAP.o.6` is cited in this KB
for **two unrelated things** — this phantom column (§3.4, §9.2) and the
Apple-state edit guard (§5-area file map, `state-edit-blocked.ts`). Only the
second one exists.

**Pattern — SECOND INSTANCE, so it is a pattern, not an accident.**
[§4.13](#413-landmark--availableinallterritories-does-not-exist-the-real-flag-is-forward-looking-and-all--175-ticked-by-hand)
recorded exactly this for `availableInAllTerritories`: a field name that lived
only in prose, propagated across docs for three cycles, and cost a planning
session. **`existsOnApple_validated` is the same failure in the same module,
found the same way — by grepping instead of trusting.**

⇒ **The lookup source is generating field names.** §4.13's rule was *"grep the
OAS before planning around any field name you first met in prose."* Widen it:

> **Grep the OAS *and* the migrations before planning around ANY field name
> you first met in this KB.** Two for two. A field named only in docs is a
> hypothesis, and in this module the base rate on that hypothesis is now 0/2.
> When you confirm one is phantom, correct **every** site — §4.13 corrected the
> backlog row but left the glossary and the archives alone, which is part of
> why this one took a third cycle to catch.

---

### 5.1 Schema isolation

All IAP Management tables live in the `iap_mgmt` Postgres schema. CLAUDE.md invariant #9 forbids cross-schema FKs; references to `public.*` (CPP) or `store_mgmt.*` (Store Submission) tables are TEXT-typed soft references (e.g. `iap_mgmt.apps.asc_account_id`).

**Access pattern**: all queries go through `lib/iap-management/db.ts` which returns `iapDb()` — a Supabase client wrapper bound to `.schema('iap_mgmt')`.

### 5.2 Tables (12 total — verified Aug 2026 by counting `CREATE TABLE iap_mgmt.*` across all migrations)

```
iap_mgmt.price_tiers                — global cache, replace-on-import (Q-IAP.7)
iap_mgmt.price_tier_territories     — denormalized legacy cache (~16,800 rows)
                                      Q-B defensive backup retention
iap_mgmt.price_tier_templates       — Cycle 30: scope_type 'GLOBAL' | 'APP'
iap_mgmt.price_tier_template_entries — Cycle 30: per-territory override entries (sparse)
iap_mgmt.apps                       — IAP-scoped app registry + asc_account_id (IAP.p1.j)
iap_mgmt.iaps                       — IAP rows + pricing_source + tier_id
iap_mgmt.iap_localizations          — per-locale display_name + description
iap_mgmt.iap_screenshots            — Apple screenshot reference
iap_mgmt.import_batches             — bulk import audit
iap_mgmt.actions_log                — append-only event log (CLAUDE.md invariant #2)
```

### 5.3 Key invariants

1. **Schema isolation** — all queries via `iapDb()`; no cross-schema FK; CPP/Store linkage is soft via TEXT columns
2. **Append-only audit log** — `iap_mgmt.actions_log` never UPDATEd, only INSERTed (CLAUDE.md invariant #2)
3. **Forward-only migrations** — no down migrations; revert = new forward migration that reverses (CLAUDE.md invariant)
4. **action_type CHECK constraint** — extended per cycle via migration; never add a new action_type in code without the matching migration. This has been violated **twice** (Cycle 29 IAP.o.11d; Cycle 37/39/40 `AVAILABILITY_*`), the second time after the rule was written down — so it is now enforced structurally by `lib/audit-constraints/` (parity against the newest migration + a source scan with per-shape sentinels), cross-module. A rule that relies on memory is not a guard.
5. **`pricing_source` enum** — `'APPLE'` | `'DEFAULT_TEMPLATE'` | `'APP_TEMPLATE'` (Cycle 30)
6. **`tier_id` is TEXT** — was `INT` pre-IAP.h2; Apple Alternate Tiers required string IDs

### 5.4 Migrations (chronological, 10 `iap_mgmt` migrations — verified Aug 2026)

| Migration | Purpose | Cycle |
|---|---|---|
| `20260515000000_iap_mgmt_init.sql` | Initial 8-table schema | 29 (IAP.c) |
| `20260515010000_iap_mgmt_tier_id_text.sql` | `tier_id INT → TEXT` for Alternate Tiers | 29 (IAP.f-prep) |
| `20260515020000_iap_mgmt_rls_grants_fix.sql` | RLS disable + service_role/authenticated GRANTs | 29 (IAP.o.1 hotfix) |
| `20260517000000_iap_mgmt_actions_log_action_type_expand.sql` | action_type CHECK adds `CREATE_PRICING_ON_APPLE` etc. | 29 (IAP.o.11d) |
| `20260518000000_iap_mgmt_actions_log_update_on_apple.sql` | action_type CHECK adds 5 `*_ON_APPLE` rows for IAP.o.12 | 29 (IAP.o.12a) |
| `20260519000000_iap_mgmt_pricing_templates.sql` | `price_tier_templates` + entries + Q-B legacy migration | 30 (IAP.p1.a) |
| `20260520000000_iap_mgmt_p1j_hotfix.sql` | `iaps.pricing_source` + `apps.asc_account_id` columns | 30 (IAP.p1.j) |
| `20260715000000_iap_mgmt_hub_tracking_config.sql` | `hub_tracking_config` singleton (encrypted token) | 42 (Hub tracking) |
| `20260811000000_iap_mgmt_actions_log_availability.sql` | **P2 fix** — CHECK adds the two `AVAILABILITY_*` values that had been emitted since Cycle 37 with no constraint entry, so every one of those audit inserts was silently rejected in production | Audit pass (Aug 2026) |
| `20260812000000_iap_mgmt_custom_prices.sql` | `iap_custom_prices` (PK `(iap_id, territory_code)`) + 3 `iaps.custom_prices_baseline_*` columns + CHECK adds `CUSTOM_PRICES_SAVED` / `_CLEARED` / `_REBASELINE` | Custom prices SC1 |

Cycles 32-34 added no IAP migrations (parser + UI + helper changes only).

---

## 6. Code Architecture

### 6.1 Backend modules — `lib/iap-management/`

```
db.ts                                       iapDb() Supabase wrapper, .schema('iap_mgmt')
auth.ts                                     requireIapSession / requireIapAdmin
validation.ts                               IapFormState + 6-prerequisite checklist (Q-IAP.h.3)
concurrency.ts                              withConcurrency<T,R>() bounded semaphore
tooltips.ts                                 pre-written tooltip string-map (Q-I, i18n-ready)

apple/
  fetch.ts                                  iapFetch + withRetry + AppleApiError + AppleRateLimitError
  client.ts                                 Apple endpoint wrappers
  screenshot-upload.ts                      3-step reserve → PUT → confirm (IAP.o.8a + o.9b)
  poll-iap-ready.ts                         Stage 1→2 propagation guard (IAP.o.11a)
  price-points.ts                           per-IAP price-point lookup
  price-schedules.ts                        2-stage View Detail fetch + setPriceSchedule POST
  territory-price-points-cache.ts           per-orchestration cache (Cycle 30 Q-C)
  pricing-orchestration.ts                  3-source logic (APPLE/DEFAULT/APP) + Q-K fail-soft
  state-edit-blocked.ts                     Apple state guard for edit-on-Apple (Q-IAP.o.6)
  diff-detector.ts                          local-vs-Apple diff driving update-orchestration stages
  update-orchestration.ts                   multi-stage update push (IAP.o.12)

bulk-import/
  conflict-resolution.ts                    two-pass pipeline (resolve + enrich)
  result-hints.ts                           UX copy mapping for per-row outcomes
  will-submit.ts                            pre-execute eligibility predicate

pagination/
  page-slice.ts                             list-page client pagination math (IAP.o.7b)

parsers/
  iap-items.ts                              84-col XLSX parser (with Type column)
  price-tiers.ts                            sparse template parser (Cycle 30 Q-I)
  screenshot-matcher.ts                     literal + normalized matching (Q-IAP.h2)

queries/
  iaps.ts                                   findApp, createDraft, getIapWithRelations
  iap-detail.ts                             View Detail composer + unpackPriceSchedule (Cycle 31)
  price-tiers.ts                            tier lookup + USD price resolution
  templates.ts                              template scope queries

submit-batch/
  bucket.ts                                 bucketSelection + partitionByStateGuard (Cycle 32)

sync-states/
  classify.ts                               Apple state → tool classification
```

### 6.2 Frontend modules

**Page routes** under `app/(dashboard)/iap-management/`:

```
layout.tsx                                  module auth guard + Toaster
page.tsx                                    redirect → /apps
error.tsx                                   route segment error boundary

apps/page.tsx + AppsListClient.tsx          App grid
apps/[appId]/
  page.tsx + IapListClient.tsx              IAPs + drafts + AppPricingTemplateSection
  iaps/new/page.tsx                         New IAP form (Save as Draft default)
  iaps/[iapId]/page.tsx                     Edit IAP (Update on Apple via diff modal)
  iaps/[iapId]/view/page.tsx                View Detail (Apple-Connect parity)
  bulk-import/page.tsx + BulkImportWizard   4-step wizard + source selector

settings/pricing-tiers/page.tsx +
  PricingTiersClient.tsx +
  DefaultTemplateTab.tsx +
  PerAppTemplateTab.tsx                     Settings UI (2-tab)
```

**Reusable components** under `components/iap-management/`:

```
IapDetailView.tsx                           Page composition + sticky action bar (Q-G)
SubmitBatchModal.tsx                        Bulk Submit Selected flow + SKIPPED_BY_STATE_GUARD render

iap-form/
  IapForm.tsx                               Shared shell (create + edit modes)
  LocaleSidebar.tsx                         240px locale picker (Q-IAP.h.2)
  LocaleEditor.tsx                          Right-canvas locale fields
  SubmitChecklist.tsx                       6-prerequisite live indicator (Q-IAP.h.3)
  ScreenshotUpload.tsx                      Dropzone + 8MB validation
  PricingSourceSelector.tsx                 3-source dropdown (Cycle 30 Q-D)
  UpdateChangesPreviewModal.tsx             Diff confirmation before update-on-Apple

pricing-tiers/
  AppPricingTemplateSection.tsx             Per-app template empty/populated states
  TemplateEntriesTable.tsx                  Per-territory entries table

view-detail/
  IapHeaderSection.tsx                      Cycle 31 p2.c — status + 2-col grid
  IapPriceScheduleSection.tsx               p2.d — base territory + current prices summary
  IapLocalizationSection.tsx                p2.e — DataTable + locale links
  IapReviewInfoSection.tsx                  p2.f — screenshot preview + notes
  PricesTableExpandable.tsx                 p2.d Show All / Summary toggle
  UpcomingChangesTable.tsx                  p2.d future-dated entries
  SectionErrorBoundary.tsx                  p2.g per-section render boundary
```

**7-primitive UI library** under `components/ui/iap/` (Cycle 31 p2.b, reused across all 4 view-detail sections):

| Primitive | Purpose |
|---|---|
| `StatusDot` | Q-D 5-tone palette (success / warning / info / neutral / danger) |
| `TooltipBadge` | "?" badge + hover popover |
| `LabeledField` | Label + tooltip + value row |
| `SectionShell` | Card wrapper with title + description + trailing slots |
| `DataTable` | Bordered table primitive |
| `ExpandablePanel` | Disclosure with chevron + default-open prop |
| `ScreenshotPreview` | Q-E thumbnail + click-to-enlarge modal |

### 6.3 Routes — 12 active route.ts files under `/api/iap-management/`

```
asc-apps/route.ts                           Live Apple fetch behind Per-App dropdown (IAP.p1.j)
pricing-tiers/route.ts                      POST upload + replace cache
pricing-templates/route.ts                  GET/POST scope-aware (GLOBAL + APP)
pricing-templates/[templateId]/route.ts     GET/PATCH/DELETE per-template
apps/[appId]/iaps/route.ts                  POST create draft
apps/[appId]/iaps/[iapId]/create-on-apple/route.ts  Single IAP create orchestration
apps/[appId]/iaps/[iapId]/update-on-apple/route.ts  Single IAP update orchestration
apps/[appId]/iaps/[iapId]/submit/route.ts            Single IAP submit
apps/[appId]/iaps/submit-batch/route.ts              Bulk submit + state-guard partition (Cycle 32)
apps/[appId]/iaps/sync-states/route.ts               Refresh Apple states for app's IAPs
apps/[appId]/bulk-import/execute/route.ts            Bulk import orchestration (concurrency 5)
iaps/[iapId]/route.ts                                GET/PATCH/DELETE single IAP record
```

### 6.4 Cross-cutting reuse (from CPP / Store Submissions)

| What | From | Notes |
|---|---|---|
| Apple credentials (`asc_accounts`) | `lib/asc-account-repository.ts` + `asc-jwt.ts` | Q-IAP.1 — same table; `generateAscToken()` shared |
| Active account resolution | `lib/get-active-account.ts` | Shared `session.activeAccountId` |
| Locale display utilities | `lib/locale-utils.ts:localeNameFromCode` | Reused in View Detail localization section |
| `xlsx` library | Already installed | Dynamic import pattern from CPP |
| `withRetry` shape | `lib/store-submissions/gmail/client.ts` | Adapted for Apple 429 + AppleApiError |
| Schema isolation pattern | `lib/store-submissions/db.ts` | `iapDb()` mirrors `storeDb()` |
| RBAC | Global `admin` / `member` roles | Q-IAP.8 — no module whitelist |
| `withConcurrency<T,R>` | `lib/iap-management/concurrency.ts` | Bounded semaphore, replaces `p-limit` dep; mirrored pattern from `lib/store-submissions/` |
| Dropzone + upload UI | ~~`components/upload/AssetUploader.tsx`~~ | ⚠️ **Planned reuse never shipped** — this file has ZERO importers (verified 2026-07-27, see `docs/performance-review-2026-07-27.md` Tier-2). The live Dropzone/upload UI is in `components/cpp/BulkImportDialog.tsx` + `components/cpp/LocalizationManager.tsx`; re-target any reuse (and the "CPP Upload per-file tracking" backlog) there. |

---

## 7. Operational Guide

### 7.1 Create IAP (single) workflow

1. Manager goes to `/iap-management/apps/[appId]` and clicks "New IAP"
2. Form opens at `/iap-management/apps/[appId]/iaps/new` with 6-prerequisite live checklist
3. Manager picks `Pricing Source`:
   - **APPLE** — passthrough, no template
   - **DEFAULT_TEMPLATE** — apply global default
   - **APP_TEMPLATE** — apply per-app override (only available if app has a template)
4. Manager fills Reference Name, Product ID, Type, Tier, ≥1 Localization, Screenshot
5. **Save as Draft** (Q-IAP.6) preserves the form state locally; `Create on Apple` orchestrates:
   1. `POST /v2/inAppPurchases` (create)
   2. Per-locale `POST /v1/inAppPurchaseLocalizations`
   3. 3-step screenshot upload (deferred behavior — see D1 below)
   4. `POST /v1/inAppPurchasePriceSchedules` (pricing per `pricing_source`)
6. Manager then clicks "Submit" — `POST /v1/inAppPurchaseSubmissions` after Apple state validation (Cycle 32 guard)

### 7.2 Bulk import workflow (4-step wizard)

`/iap-management/apps/[appId]/bulk-import` → stepper labels
`Excel → Screenshots → Preview → Result` (BulkImportWizard.tsx). (This
list previously said "Step 1 — Pricing source / Step 2 — Upload Excel" —
stale vs the shipped stepper; corrected during the template-download
work, which found the drift.)

1. **Step 1 — Excel**: upload/parse of the 84-column template
   client-side. Template download is offered in the wizard HEADER (every
   step) and on the apps-list page — one shared component
   (`components/ui/shared/DownloadTemplateButton.tsx`) across all four
   call sites in both modules; generated from
   `parsers/template-spec.ts`, the same spec consts the parser reads,
   so template and parser cannot drift. Both buttons open a **locale
   picker** first: `<module>IapTemplateSpec(selectedNames?)` emits core
   columns ALWAYS + one pair per selected locale (`undefined` = full
   set, `[]` = core-only). Nothing is pre-ticked and the selection is
   not remembered, so core-only is the default one-click output;
   filenames differentiate (`-core`, `-<N>-locales`, base name for the
   full set). Subset/zero-locale files need NO parser change — both
   parsers discover locale pairs from the file's header row rather than
   iterating the expected set (gate verdict,
   design-bulk-import-locale-picker.md Part 1). Data sheet "IAP Items"
   (selected BY NAME, Sheet1 fallback for legacy files) ships 3 sample
   rows that the parser SKIPS by ID (shared
   `TEMPLATE_SAMPLE_PRODUCT_IDS` in `lib/xlsx-template.ts`) as an
   explicit `sample_rows_skipped` outcome; an all-samples file parses
   to 0 items and the wizard's Next stays disabled. Operator-facing
   detail lives in the docs site (apple-bulk-import section) and, for
   Google, operational-guide §6 — this KB entry deliberately stays a
   summary.
2. **Step 2 — Screenshots** (screenshot folder matching)
3. **Step 3 — Preview + validate** (two-pass conflict resolution:
   resolve + enrich; batch-level pricing source Q-E and submit-on-create
   live HERE, not in a separate step)
4. **Step 4 — Execute/Result** with `withConcurrency<T,R>` of 5; per-row result hints

Execute orchestrator at `app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts`. Each row is independently audited; failures don't abort the batch.

### 7.3 Edit synced IAP workflow

`/iap-management/apps/[appId]/iaps/[iapId]` →

1. State validation: if Apple state ∈ {WAITING_FOR_REVIEW, IN_REVIEW}, edit blocked via `state-edit-blocked.ts`
2. Manager edits fields (Reference Name, locales, screenshot, pricing, reviewNote, familySharable)
3. Click "Update on Apple" → `UpdateChangesPreviewModal` shows the diff
4. Confirm → multi-stage update (see [§4.4](#44-multi-stage-update-orchestration-iapo12))
5. UI surfaces per-stage success/failure; audit-log captures each stage independently

### 7.4 View detail workflow (Apple-Connect parity)

`/iap-management/apps/[appId]/iaps/[iapId]/view` →

Page composition (Cycle 31):
- **Header section** (p2.c) — status row + 2-col grid (Product ID, Apple ID, Reference Name + char counter, Type)
- **Price Schedule section** (p2.d) — base territory + current prices summary + upcoming changes split
- **App Store Localization section** (p2.e) — DataTable with locale links + Q-D status dots
- **Review Information section** (p2.f) — ScreenshotPreview (click-to-enlarge) + read-only notes with X/4000 counter

Top-right action cluster (Q-G): Refresh from Apple · View on Apple Connect · Edit
Each section has its own `SectionErrorBoundary` (Q-G p2.g) so one section failing doesn't crash the whole page.

### 7.5 Pricing templates (Settings) workflow

`/iap-management/settings/pricing-tiers` →

- **Default Tab** — global template applied when `pricing_source = DEFAULT_TEMPLATE`. Upload sparse XLSX (blank cells = no override).
- **Per-App Tab** — per-app templates with ASC Account column. Live `/api/iap-management/asc-apps` fetch behind the dropdown (IAP.p1.j live-fetch fix).

Q-B atomic migration: legacy `price_tier_territories` data was migrated to a GLOBAL Default Template at migration time. Defensive backup table retained until production stability period.

See [pricing-templates-guide.md](pricing-templates-guide.md) for the full Manager-facing UX guide.

### 7.6 Common production issues

| Symptom | Likely cause | Action |
|---|---|---|
| Tool state ≠ Apple Connect | Async edit on Apple Connect web | Click "Refresh from Apple" — re-fetch state |
| Submit silently no-ops | Apple state ≠ READY_TO_SUBMIT | Check Cycle 32 modal — tooltip surfaces blocker |
| Template entry not applied | Template territory has no Apple match | Q-K fail-soft outcome — check audit log + `pricing-diagnostic.sql` |
| Screenshot upload partial fail | 3-step protocol step 2 or 3 failed | Retry via "Edit" — DELETE + re-upload is idempotent |
| View Detail fewer rows than Apple Connect | V2 ?include relationship truncation | Check Railway log `stage1 manualRel_count` vs `stage2 apple_total` |

---

## 8. Production Verification

### 8.1 Diagnostic SQL queries (Manager runs)

Ship-ready queries are in `docs/iap-management/queries/` directory and the Manager-facing `pricing-templates-guide.md`:

- **Q1 — Pricing source distribution**: how many IAPs use APPLE vs DEFAULT_TEMPLATE vs APP_TEMPLATE
- **Q2 — Template entry count**: per-template entry count (post-IAP.p1.j accurate via `count: 'exact'`)
- **Q3 — Submit attempts by Apple state**: count submit-batch rows by result type (SUBMITTED / SKIPPED_BY_STATE_GUARD)
- **Q4 — Update-on-Apple stage breakdown**: per-stage action_log analysis

### 8.2 Railway logs = ground truth (instrumentation-first pattern)

The IAP.o.11a instrumentation pattern: every Apple call writes `[component] action_id ATTEMPT/SUCCESS/FAILURE` to Railway logs at orchestrator + endpoint boundaries.

> ⚠ **CORRECTED (Aug 2026).** This section previously claimed "audit-log writes happen in the same transaction as the data write so log + DB row are consistent." **That is false for `iap_mgmt` and `google_iap_mgmt`**, and believing it leads to exactly the wrong severity read on a constraint failure. Verified positions:
>
> - There is **no transaction and no RPC** on either module's audit path — supabase-js exposes neither (noted at `queries/templates.ts:460`, `queries/price-tiers.ts:6`). Every audit write is a **separate `.insert()` issued after the external API call already succeeded**.
> - The write **cannot fail the user-visible operation**: `pricing-orchestration.ts:417-487`, `update-orchestration.ts:714-730` and `bulk-availability.ts:298-311` check `{error}`, `console.error` it and return; the bare inserts (`create-on-apple/route.ts:377`, `bulk-import/execute/route.ts:846`) discard it entirely. supabase-js returns `{error}` rather than throwing, so nothing propagates. Google's single choke point `appendAction` (`repository/actions-log.ts:32-49`) does the same, deliberately — its comment says so.
> - ⇒ A rejected audit insert loses **only the audit row**. Apple/Google state and the local DB row are unaffected. This is precisely why the missing `AVAILABILITY_*` CHECK values (migration `20260811000000`) survived a successful Manager UAT of `bd54826`.
>
> **`store_mgmt` is the opposite** and the claim IS true there: `ticket_entries` INSERTs run *inside* the `*_tx` plpgsql functions that also perform the `tickets` UPDATE (`20260423000000_store_mgmt_ticket_engine_rpc.sql` + 7 more, called via `storeDb().rpc('…_tx')` — `tickets/user-actions.ts:190-231`, `tickets/engine.ts:125`). A plpgsql function is one implicit transaction, so a CHECK violation raises and **rolls back the data write too**. Higher severity — but self-announcing, so it cannot hide in production the way the silent modules' drift did.
>
> Cross-module guard: `lib/audit-constraints/` (see §10.13.K P2).

**Canonical traces** to grep when investigating an issue:
```
[create-iap] start / attempt / success / failure
[set-price-schedule] start / attempt / success / retry / giving-up
[get-schedule] stage1 manualRel_count=N
[get-schedule] stage2 page=N got=N has_next=… apple_total=N
[update-orchestration] stage=attributes / localizations / screenshot / pricing
```

**Pattern**: when Apple's documented API behavior differs from observed behavior, Railway logs (raw response bodies + headers + counts) win over Apple Docs.

### 8.3 Apple API integration test layer

`lib/iap-management/apple/api-schemas.integration.test.ts` pins:
- Request URL shape per endpoint
- Method (GET / POST / PATCH / DELETE)
- `?include` whitelist enum (Trap 2 prevention)
- Body shape (POST / PATCH)

Regression fails at test time, not Manager UAT. Mandatory pin point for any new Apple endpoint.

### 8.4 Apple Connect web UI parity check

For every cycle's UAT (MV28-30 + post-cycle hardening):
1. Manager creates / edits IAP in tool
2. Manager opens "View on Apple Connect" deep link (Q-H)
3. Manager compares tool state vs Apple Connect ground truth
4. Discrepancies → Railway log inspection → root cause → forward-only fix

Iris API (`/iris/v1/`) — Apple Connect Web's undocumented internal API — is used **only for diagnosis**, never in production (cookie auth, undocumented, unstable). Iris ground truth disproved Cycle 31's Stage 3 base-price hypothesis at IAP.p2.l.

---

## 9. Memory Patterns Crystallized

The IAP arc crystallized 60+ reusable patterns. Documented in MEMORY.md feedback entries; this is a curated subset for fast reference.

### 9.1 Foundation discipline

- **Investigation-first response** — when Manager reports a silent prod issue, schema-audit + grep-audit before code (IAP.p2.i wrong-path-segment incident)
- **Apple integration silent-failure mitigation** — UI maps clean 404 to empty state, so Manager won't see stack traces; instrumentation = ground truth (IAP.p2.i)
- **Two-stage architectural lock** — single-round-trip optimism repeatedly invalidated by Apple's actual behavior (Q-IAP.p2.C disproved at p2.j)
- **Manager domain knowledge supremacy** — iris API ground truth disproved 2 successive p2.k / p2.l hypotheses
- **Authoritative source triangulation** — when Apple Docs ≠ tool behavior ≠ Apple Connect ground truth, run all three to find which is wrong

### 9.2 Apple integration depth

- **Apple Docs specification ≠ Apple API behavior** (recurring theme through IAP arc)
- **V2 `?include` relationship truncation** — 10-ID cap; LANDMARK from IAP.p2.m
- **V1 endpoints authoritative** — V2 endpoints are metadata-only
- **`customerPrice` match discipline** — over `priceTier` numbering (Apple's 2024 tier rollover, IAP.o.11d)
- **Per-territory price-point fetch cost** — documented overhead, NOT a bug to optimise (Q-IAP.p1.C)
- **3-step screenshot upload** — reserve → PUT presigned → confirm (IAP.o.8a + IAP.o.9b)
- **Never a silent "unknown" sync state** — as shipped this is `apple_iap_id IS NULL` (draft) + the availability route's `not_synced` 409, **not** a tri-state column. ⚠ This bullet previously named `existsOnApple_validated`; **that column does not exist** — see [§4.15](#415-landmark--existsonapple_validated-does-not-exist-either--phantom-field-2-in-this-module) (IAP.o.6)
- **Stage 1 truncation, Stage 2 authoritative** (IAP.p2.m)
- **Sub-letter notation in reject reasons** — `Guideline 2.1(b)` etc. (Cycle 33 cross-module)

### 9.3 Architectural discipline

- **F8 backward compatibility preservation** — APPLE source path bit-for-bit identical pre/post Cycle 30 refactor
- **Q-K graceful degradation (fail-soft)** — `partial-template-fail`, `skipped-not-ready`, never abort the batch
- **Q-B atomic migration with defensive backup retention** — legacy table kept until stability period
- **Per-stage error boundaries** — route → composer → render, each with its own try/catch
- **Reusable component library investment** — 7 p2.b primitives reused across 4 sections
- **Tooltip i18n-ready string-map foresight** — centralized lookup, no JSX-embedded copy
- **Schema isolation via `iapDb()`** — CLAUDE.md invariant #9 enforcement at code level
- **Forward-only migrations** — revert = new forward migration that reverses
- **Identity-based hook reset pattern** — `useEffect([items])` resets internal state on input identity change (Cycle 34)

### 9.4 Process discipline

- **Sub-chunked sequential delivery** — gauntlet 4/4 per sub-chunk; never accumulate WIP
- **Mid-arc checkpoint verification** — Manager UAT after each cycle's last sub-chunk
- **Two-session strategic discipline** — Q-decisions reach lock before code
- **Pre-flight parallel work execution** — Manager UAT + Claude implementation interleaved
- **Fresh session strategic kickoff pattern** — each new arc gets clean context
- **Mockup-first design review** — HTML mockup → Manager review → component scaffold
- **Recommended defaults alignment** — Manager rarely overrides recommendations when justified
- **Manager refinement iteration ROI compound** — each MV iteration crystallizes ~5 patterns
- **Narrow polish iteration discipline** — visual balance, column heights, padding consistency
- **4-options proposal discipline scales** — even narrow Cycle 32-34 used 4-5 option framings
- **Cohesive commit per cycle** — bundle related fixes; one commit history per Pattern 10 reuse #19 cycle

### 9.5 Production-grade insights

- **External system integration depth >> initial MVP estimate** — 4 successive Apple traps in p2.i-m alone
- **Strategic feature continuum pattern** — cycles 29 → 30 → 31 built on each other
- **Trajectory milestone recognition** — 5 cohesive deliverables = milestone, not just 5 commits
- **Closure ceremony cohesive discipline** — this document is itself a pattern
- **Continuous improvement signal post-data accumulation** — Cycle 33 emerged 2 weeks after Phase E shipped clean on tiny corpus
- **Multi-cycle hardening discipline sustainable** — Cycles 32-34 demonstrate post-milestone narrow scope works

---

## 10. Future Development Guidance

### 10.1 Pre-flight checklist for any IAP-related work

1. **Read this knowledge base** (start here)
2. **Read [`SESSION-ARC-2026-05-15-FINAL-summary.md`](SESSION-ARC-2026-05-15-FINAL-summary.md)** for chronological context (cycles 29-34)
3. **Read [`apple-api-reference.md`](apple-api-reference.md)** for endpoint contracts + the 15+ gotchas
4. **Inspect the latest module code** — state may have evolved since this doc; `git log` for recent IAP commits
5. **Verify Railway logs current state** — production behavior may differ from local
6. **Cross-check Apple Connect web UI** — Manager ground truth verification

### 10.2 Strategic feature kickoff pattern

1. **Investigation-first phase** (~30min-2h based on scope) — schema audit, grep audit, code reads
2. **SQL diagnostic queries** if data layer is involved — Manager runs, surfaces ground truth
3. **Q-clarification structured** — Q-locks before code, recommended defaults
4. **HTML mockup** if UI-heavy — Manager review before component scaffold
5. **Sub-chunked development plan** — gauntlet 4/4 per sub-chunk
6. **Manager checkpoint verification gates** between sub-chunks
7. **Closure ceremony post-Manager verification** — doc updates, memory pattern extraction

### 10.3 Apple API new-endpoint integration checklist

Before wiring ANY new Apple V2 IAP endpoint:

1. **Use V1 for authoritative data** (V2 `?include` truncates at 10 IDs — Trap 4)
2. **Verify path segment uses relationship name, not resource type** — grep `openapi.oas.json` for the `operationId` BEFORE writing the path (Trap 1)
3. **Verify the `include` whitelist enum** — Apple V2 enforces strict whitelist (Trap 2)
4. **Verify which resource carries each attribute** — InAppPurchasePrice vs PricePoint vs Territory (Trap 3)
5. **Verify pagination scheme** — keyset cursor, offset, or hybrid
6. **Add per-stage error boundary** — route + orchestrator + render layers
7. **Instrumentation per IAP.o.11a pattern** — `[component] action ATTEMPT/SUCCESS/FAILURE` to Railway
8. **Audit log payload comprehensive** — capture enough to reconstruct intent post-failure
9. **Pin contract shape in `api-schemas.integration.test.ts`** — request URL + method + body + include params
10. **Verify relationship enumeration vs sub-resource fetch returns same count** — Trap 4 prevention
11. **Tests cover happy path + error states + Apple 429 + Apple 500**
12. **Document Manager re-test scenarios** explicitly before shipping

### 10.4 Deferrals + backlog (post-Cycle 34)

#### Priority 1 — Manager-driven if surfaces

| ID | Item | Notes |
|---|---|---|
| **IAP.p3** | Inline edit Reference Name in view mode | Q-A deferral from Cycle 31 |
| **IAP.p2+** | `contentHosting` edit | Separate Apple endpoint; not in `InAppPurchaseV2UpdateRequest`. ⚠ This row previously said "`availableInAllTerritories`" — **that field does not exist** (0 occurrences in OAS 4.3.1 and 4.4.1); see §4.13. Territory availability is FULLY UNBLOCKED: binary ALL/NONE by Cycle 39 Phase 1 (§10.8), arbitrary subsets by the per-territory availability cycle. |
| **IAP.p2+** | Apply pricing template to existing IAPs bulk action | Q-G deferral from Cycle 30 |
| **IAP.p2+** | Per-row pricing source override in Bulk Import | Q-E deferral from Cycle 30 (batch-level v1 shipped) |
| **IAP.p2+** | Pricing template versioning + history | Q-A REPLACE-ONLY locked v1 |
| **IAP.p2+** | `price_tier_territories` legacy table cleanup decision | Q-B defensive backup — keep or drop after stability period |

#### Priority 2 — Other strategic arcs (non-IAP)

| Item | Notes |
|---|---|
| Multi-platform extractor (Google Play / Huawei / Facebook) | Store Submission scope |
| Auto-archive empty unclassified buckets | Store Submission post-Phase E enhancement |
| Dark mode full token migration | D4 backlog — current dual-class shim covers IAP only; CPP + Store + HubPage still light-only |

#### Priority 3 — External Manager process parallel

| Item | Notes |
|---|---|
| OAuth verification with Google Workspace | External process |

### 10.5 Resumption template (use in fresh session)

```
Project: appstore-connect-cpps (Next.js 14 + TS + Supabase).
Module: IAP Management (cycles 29-34 closed).
  - Knowledge base: docs/iap-management/IAP-MANAGEMENT-KNOWLEDGE-BASE.md
  - Latest commit: <git log --oneline | head -1>
  - Tests: 1815 baseline
  - Backlog: see knowledge base §10.4
Current task: <task description>
```

Standard Manager protocol applies: read CLAUDE.md, surface findings before implementing, surface mid-flow trigger-condition events, gauntlet 4/4 per sub-chunk.

### 10.6 Cycle 37 Phase 1 — IAP availability default + read display

Cycle 37 ships in two phases. Phase 1 (this commit) unblocks half of the §10.4 `availableInAllTerritories` deferral by wiring Apple's separate `/v1/inAppPurchaseAvailabilities` resource into the create flows and surfacing the result in the View Detail page.

**Apple semantic correction.** Apple's IAP V2 has no `availableInAllTerritories` boolean. The "All countries or regions" radio in Apple Connect maps to a `POST /v1/inAppPurchaseAvailabilities` with the full ~175-entry `availableTerritories` list plus `availableInNewTerritories: true`. Read path is the linked-resource lookup `GET /v2/inAppPurchases/{id}/inAppPurchaseAvailability?include=availableTerritories`; 404 = no resource yet (= "Removed from Sale"). No `PATCH` exists — replace by re-POST.

**Phase 1 scope (Manager Q&A defaults locked 2026-05-23):**

| Surface | Behaviour |
|---|---|
| `lib/iap-management/apple/availabilities.ts` | `listTerritories` / `getAllTerritoryIds` (cached 1h per process) / `setAvailabilityToAllTerritories` / `getAvailabilityForIap`. Pure helper `collectIncludedTerritoryIds` unit-tested. |
| Single create route (`/iaps/[iapId]/create-on-apple`) | Inserts step 11.5: `setAvailabilityToAllTerritories(appleIapId)` after screenshot, before final state fetch. Non-fatal; `action_type=AVAILABILITY_SET_ALL_TERRITORIES` audit log entry every attempt (success or fail). Response shape gains `availability_set: boolean` + optional `availability_error`. |
| Bulk Import (`/bulk-import/execute`) | `runCreate` only — `runOverwrite` deliberately untouched (Q5.A no migration on existing IAPs). Per-row audit log; `PerIapResult` gains `availability_set` + `availability_error` fields for UI surfacing. |
| `getIapViewData` (View Detail composer) | Adds parallel fetch of availability + total-territory count alongside the existing IAP and price-schedule fetches. Resilient per-stage: 404 → null surfaced; non-404 error → `availabilityError` populated. |
| `IapAvailabilitiesSection` | New section between PriceSchedule and Localization. Read-only count badge: "All countries or regions" / "N of M countries or regions" / "Removed from Sale" / "Couldn't fetch availability." No Edit affordance (Q4.C). |

**What Phase 2 will add (deferred):**

- Edit affordance on the section trailing slot (territory picker UI).
- "Set All Territories" backfill button for existing IAPs.
- Per-row Excel override column for Bulk Import (Q2.B opted out for now).
- Apple Connect web's "Remove from Sale" toggle parity.

**Manager re-test scenarios (Phase 1 ship):**

1. Create a new IAP via single create → confirm Apple Connect web shows "All countries or regions" on the IAP availability page.
2. Bulk-import a batch → confirm each new row shows "All countries or regions" on Apple Connect web.
3. Open View Detail for any existing IAP → confirm the Availability section renders the matching Apple-side state (no migration means most pre-Cycle-37 items will show "Removed from Sale").
4. Open View Detail for a freshly-created IAP from scenario 1 → confirm "All countries or regions" with the full territory count.

**Audit-log SQL for fleet-wide check:**

```sql
SELECT
  payload->>'apple_iap_id' AS apple_iap_id,
  payload->>'product_id'   AS product_id,
  (payload->>'success')::boolean AS success,
  payload->>'error'        AS error,
  created_at
FROM iap_mgmt.actions_log
WHERE action_type = 'AVAILABILITY_SET_ALL_TERRITORIES'
ORDER BY created_at DESC
LIMIT 100;
```

### 10.7 Cycle 38 — Apple pricing-template matrix view

Apple sibling of the Cycle 36 Google IAP matrix view (commit 677ad73). Same UX language (sticky Tier column 180 px, horizontal scroll markets, search + currency dropdown + 5-continent toggle pills, row hover, ★ diff highlighting Per-App vs Default, CSV export of the active filter set, Server Component render) — separate Apple components per the Cycle 36 Q4.B discipline (visual consistency, code isolation).

**Apple-specific divergences from the Google composer:**

- **Territory codes** are ISO 3166-1 alpha-3 (`USA` / `VNM` / `JPN`). The Cycle 31 `components/iap-management/view-detail/territory-name` resolver handles the country-name lookup (already in use elsewhere); the new `lib/iap-management/apple/territory-continent.ts` mirrors the Cycle 36 alpha-2 continent map but keyed by alpha-3.
- **Customer price** is `NUMERIC(18,4)` — no micros conversion at the composer or CSV layer.
- **Alternate tiers** are identified by `tier_id.startsWith("ALT_")`. The composer surfaces them after primary tiers and the table renders an "Alt" badge next to the tier name.

**New surfaces:**

| File | Purpose |
|---|---|
| `lib/iap-management/apple/territory-continent.ts` | Alpha-3 → 5-continent bucket map (~250 entries inline). |
| `lib/iap-management/queries/template-matrix.ts` | Pure `composeMatrix` + DB-bound `fetchDefaultMatrix` / `fetchPerAppMatrix` (loads Default in parallel for diff annotation). |
| `lib/iap-management/csv-export.ts` | RFC 4180 + UTF-8 BOM CSV writer for the active filter set; adds `default_customer_price` column on Per-App. |
| `components/iap-management/pricing-templates/{MatrixBreadcrumb,MatrixFilterBar,MatrixTable,DefaultMatrixView,PerAppMatrixView}.tsx` | Apple-specific matrix primitives + view shells. |
| `app/(dashboard)/iap-management/settings/pricing-tiers/default-matrix/page.tsx` | New route — Default matrix view. |
| `app/(dashboard)/iap-management/settings/pricing-tiers/per-app-matrix/[appId]/page.tsx` | New route — Per-App matrix view with empty-state when no template uploaded. |

**Existing Settings tabs touched (CTA wiring only — upload/replace/remove preserved):**

- `DefaultTemplateTab` — adds "Open matrix view" link beside Replace/Remove (and as the only non-Lock affordance for non-admin readers).
- `PerAppTemplateTab` — adds "View matrix" link beside the per-row Remove icon button.

**Cycle 36 → Cycle 38 ROI compound:** mockup phase skipped, same Q&A defaults reused, ship time ~3.5 h vs Cycle 36's ~6.5 h. Structurally identical component tree means future matrix-view tweaks (virtual scrolling, per-tier expansion, batch actions) land in both modules with parallel diffs.

**Phase 2 deferred (Cycle 30 Q-G):** "Apply pricing template to existing IAPs" bulk action — still in §10.4 backlog, Cycle 38 surfaces the data so the bulk action can target it later.

### 10.8 Cycle 39 Phase 1 — Apple IAP Availabilities edit + Remove from Sales

Unblocks the two Cycle 37 Phase 1 deferred items tracked in §10.6:

1. **Edit affordance on the trailing slot** — replaced with a full Section 5 on the Edit Item form (Manager Q6.C "full Edit page" default locked over the simpler "trailing-slot affordance" of Cycle 37 Q4.C).
2. **"Remove from Sale" toggle parity** — the 2-radio (Q3.A) flip wires through the orchestrator's new Stage 5, which calls either `setAvailabilityToAllTerritories` (existing Cycle 37 helper) or the new `setAvailabilityRemoveFromSales`.

**Apple "Remove from Sales" semantic verified via openapi.oas.json:**

- `/v1/inAppPurchaseAvailabilities/{id}` supports **GET only** — no PATCH, no DELETE.
- `/v1/inAppPurchaseAvailabilities` supports **POST only**.
- The only path to "no salable territories" is therefore a fresh POST with `availableInNewTerritories: false` + `availableTerritories.data: []`. Apple's replace-by-re-POST pattern (already documented for the "ALL" path in availabilities.ts:103-105) applies symmetrically.

**Multi-stage orchestration extended 4 → 5 stages.** Pipeline is now:

> Stage 0 precheck · Stage 1 attributes · Stage 2 localizations · Stage 3 screenshot · Stage 4 pricing · **Stage 5 availability (NEW)**

Per the §4.4 discipline, the stage runs only when `diff.availability_changed !== null` and a failure never cascades to siblings. Audit rows: `AVAILABILITY_SET_ALL_TERRITORIES` (reused from Cycle 37) and the new `AVAILABILITY_REMOVE_FROM_SALES` action type.

**View Detail Unit A red emphasis.** The Cycle 37 IapAvailabilitiesSection now flips to a red left-border + red text presentation when Apple reports a "Removed from Sale" surface (404 metadata OR explicit zero-territories availability). Pure helper `pickDisplayState` returns a new `removed: boolean` flag so the JSX swap stays declarative.

**Edit form Section 5 pre-fill path:**

```
Edit page server component (app/.../iaps/[iapId]/page.tsx)
  └── getAvailabilityForIap (Hotfix-22 V1 sub-resource path)
  └── getAllTerritoryIds (cached)
  └── Resolves AvailabilityTarget: "ALL" | "NONE" | null (unknown/subset)
       └── IapForm.cachedAvailabilityTarget prop
            └── AvailabilitiesSection renders 2-radio + CURRENT badge
                 └── On change → form.availability_target dirties
                      └── detectIapChanges populates availability_changed bucket
                           └── Update on Apple → orchestrator Stage 5
```

**Edit isolation discipline preserved.** Other field edits never touch availability — Stage 5 fires only when the radio target actually flips. Manager's confirmation modal (`UpdateChangesPreviewModal`) renders the availability bucket with destructive red emphasis when the target is `NONE`.

**Phase 2 shipped — Cycle 39 Phase 2 (Units C + D):** see §10.8 Phase 2 sub-entry below.

**Files touched (Phase 1):**

| File | Change |
|---|---|
| `lib/iap-management/apple/availabilities.ts` | + `setAvailabilityRemoveFromSales` (re-POST empty list). |
| `lib/iap-management/validation.ts` | + `AvailabilityTarget` type + `availability_target` form field. |
| `lib/iap-management/apple/diff-detector.ts` | + `availability_changed` bucket + `availability_target` on CachedIapState. |
| `lib/iap-management/apple/update-orchestration.ts` | + Stage 5 (`runAvailabilityStage`); aggregate extended. |
| `app/(dashboard)/iap-management/apps/[appId]/iaps/[iapId]/page.tsx` | Fetches Apple availability for prefill; passes `cachedAvailabilityTarget`. |
| `app/api/iap-management/apps/[appId]/iaps/[iapId]/update-on-apple/route.ts` | Server-side availability refetch when building CachedIapState. |
| `components/iap-management/iap-form/AvailabilitiesSection.tsx` | **NEW** 2-radio Section 5 with CURRENT badge + change-pending caption. |
| `components/iap-management/iap-form/IapForm.tsx` | Threads `availability_target` through saveBody + renders Section 5 for synced edits only. |
| `components/iap-management/iap-form/UpdateChangesPreviewModal.tsx` | + Availability change preview (destructive red copy for NONE). |
| `components/iap-management/view-detail/IapAvailabilitiesSection.tsx` | Unit A red emphasis when `removed === true`. |

Tests +9 (availabilities +2, diff-detector +5, orchestration +4, view-detail +2 reused — net new assertions).

#### Phase 2 (Units C + D) — Bulk Availabilities actions + list column

Manager scope addition mid-cycle: cohesive ship of toolbar bulk actions
(Unit C) + IAP list view column (Unit D). Single fetch serves both via
shared data-layer ROI.

**Strategy A locked — Server Component fetch on mount.** Per-page-render
parallel Apple availability fetch (`fetchAvailabilityStatesForIaps`,
concurrency 5). Mirrors the Cycle 37 Phase 1 View Detail freshness pattern
— manager-tolerable ~5–10s latency for 25-item lists in exchange for
parity with what's currently on Apple. Rejected alternatives: cached
state (stale risk), lazy/on-click fetch (blank column UX gap).

**Shared data layer.** One `fetchAvailabilityStatesForIaps(creds, iapIds)`
call drives:
- Unit D — per-row column rendering via `classifyAvailability(state, hasError)` → `available | removed | unknown`.
- Unit C — bulk-modal filter via the same classifier, mode-aware: `set-all` keeps `removed`, `remove` keeps `available`, both modes drop `unknown` so Manager doesn't act on stale state. (SC6 added a third branch `set-territories` with **no** bucket restriction — an explicit list is meaningful for available AND removed items — while the `unknown` drop still applies and is now NAMED in the confirm dialog rather than silent.)

The pre-fetched `Map<appleIapId, AvailabilityForIap | null>` plus an
error Map thread from the Server Component → IapListClient prop →
AvailabilitiesBulkModal prop. No client-side re-fetch on modal open.

**API + orchestrator.** New `POST /api/iap-management/iaps/bulk-availability`
delegates to `executeBulkAvailability` which iterates input IAP UUIDs at
concurrency 5, resolves each row's `apple_iap_id` from `iap_mgmt.iaps`,
calls the Phase 1 helper (`setAvailabilityToAllTerritories` or
`setAvailabilityRemoveFromSales`), and writes one `actions_log` row per
IAP using the Phase 1 audit action types (no new types — bulk + single
edits surface under the same dashboard filters).

**Q-K fail-soft.** A single Apple rejection (e.g. 409 STATE_ERROR on a
MISSING_METADATA IAP) never cancels siblings. Per-row results stream back
on the response; the modal's progress view (mockup State 6) shows
successes + failures side-by-side. Aggregate severity surfaces as a toast
on close (`SUCCESS` / `PARTIAL` / `FAILURE` / `NO_OP`).

**Confirm popup discipline (Q5.C).** Only the destructive *Remove from
Sales* mode shows the confirm popup with Manager's locked verbatim copy
("This action will perform the remove from sales for items, do you
confirm?"). The non-destructive *Set Availabilities* mode submits
directly from the modal footer.

**Files touched (Phase 2):**

| File | Change |
|---|---|
| `lib/iap-management/apple/bulk-availability-fetch.ts` | **NEW** — `fetchAvailabilityStatesForIaps` (withConcurrency 5) + `classifyAvailability` pure helper. |
| `lib/iap-management/orchestrators/bulk-availability.ts` | **NEW** — `executeBulkAvailability` + per-IAP audit + Q-K fail-soft aggregate. |
| `app/api/iap-management/iaps/bulk-availability/route.ts` | **NEW** — POST endpoint with zod-validated body schema. |
| `components/iap-management/AvailabilitiesBulkModal.tsx` | **NEW** — 7-state modal (list / empty / progress) + Q5.C confirm popup; pure `filterEligible` exported for tests. |
| `app/(dashboard)/iap-management/apps/[appId]/page.tsx` | Server Component — Apple availability prefetch; threads serializable per-IAP array to client. |
| `app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx` | New `Availabilities` column + Set/Remove toolbar buttons (left-most, teal-300 / red-300 borders) + bulk-modal mount. |
| `docs/iap-management/design/availabilities-bulk-mockup.html` | **NEW** — 7-state mockup; Manager-approved before implementation. |

Tests +18 (bulk-availability-fetch +8 covering pure classifier +
concurrency + per-IAP failure isolation; bulk-availability orchestrator
+8 covering action routing + audit shape + fail-soft + local-draft path;
modal filterEligible +6 covering both modes + error/unsynced exclusion).

**Phase 3 candidates (deferred, tracked here):**

- ~~Server-side cache for `fetchAvailabilityStatesForIaps`~~ — **superseded by Hotfix 25 Strategy A → D pivot** (see Hotfix 25 entry below).
- Bulk-action progress streaming (Server-Sent Events) so the modal updates per-row as the orchestrator works instead of after the response. Current v1 batches results in one shot.
- Auto-retry on rate-limited cells after a cool-down window. Hotfix 25 ships click-to-retry only; auto-retry adds clock-management complexity without strong production demand yet.

#### Hotfix 25 — Strategy A → D pivot (lazy-load client cells)

**Production verification result.** Phase 2 Strategy A (Server Component
bulk prefetch on mount) cascaded into Apple ASC 429 rate-limit hits the
moment Manager workflows fanned across multiple apps. Railway logs:

```
[iap-apple] [F28D5J857Z] GET /v2/inAppPurchases/.../inAppPurchaseAvailability
  rate-limited (retry-after=nullms)
```

`retry-after=null` is the Apple-side signal that the limiter cooled with
no explicit recovery window. With N items × M apps × short-window
manager workflows fanning out from each list-page render, Apple's 250
req/hour cap drops the tail of every render → many cells "(fetch
failed)" + degraded Manager UX.

**Pivot — Strategy A → Strategy D (client-side lazy load).**

| Aspect | Strategy A (Phase 2 shipped) | Strategy D (Hotfix 25) |
|---|---|---|
| Page render | Blocks on Apple fetch (~5–10s) | Returns immediately |
| Fetch trigger | All rows on mount | Per-row IntersectionObserver |
| Concurrency | Server-side `withConcurrency` 5 | Client-side queue 3 |
| Rate-limit recovery | Cascade fail | Per-cell click retry |
| Bulk modal | Reuses prefetched Map | Fetches on open |

**New surfaces:**

| File | Role |
|---|---|
| `app/api/iap-management/iaps/[iapId]/availability/route.ts` | Per-IAP GET endpoint, wraps `getAvailabilityForIap` in `withRetry` so Apple 429 backoff honours Retry-After automatically. Returns `{ state, error?, reason? }` with 200 wrapping rate-limited / fetch-failed cases so the client can render without `fetch` rejecting. |
| `lib/iap-management/client-fetch-queue.ts` | Singleton concurrency-bounded queue, cap 3. FIFO drain. Module-scoped state ⇒ per-tab rate-limit protection. |
| `components/iap-management/AvailabilityCell.tsx` | Lazy-load cell. IntersectionObserver with `rootMargin: 100px` so the row fetches slightly before scroll-in. Six states (`pending` / `loading` / `available` / `removed` / `failed` / `rate_limited`). Click-to-retry on the two failure states flips back to `pending` so the observer re-fires. |

**Bulk modal refactor.** `AvailabilitiesBulkModal` no longer accepts
prefetched `availabilityStates` / `availabilityErrors` props. On open
the modal fetches each filtered IAP's availability via the new per-IAP
API route through the same client-fetch-queue (concurrency 3). Manager
sees an explicit progress indicator while the fetch runs — bulk action
is an explicit Manager workflow, so the wait is acceptable.

**Deletions.** `lib/iap-management/apple/bulk-availability-fetch.ts` +
its test removed — the server-side bulk prefetch is orphaned by the
pivot. No backwards-compat shims (per project Don'ts).

**Apple ASC institutional trap class — NEW.** Strategy A's "bulk
prefetch on render" pattern is now documented as an anti-pattern for
Apple-rate-limited integrations. Apple's per-hour cap [^h25cap] is
shared across all API surfaces under a single ASC key; any pattern that
fans out N requests per page render compounds across pages, apps, and
manager tabs. Lazy-load + per-cell observers + client-side concurrency
ceiling is the institutional answer.

[^h25cap]: ⚠ **OBSOLETE FIGURE — Hotfix 25's "250 req/hour" was WRONG.**
    Measured 2026-08-25: `user-hour-lim` = **3,600** (§4.9). The
    sentence above is corrected to "per-hour cap"; the surrounding
    Hotfix 25 reasoning still stands, because lazy-load + per-cell
    observers + a client concurrency ceiling are right at either figure
    — only the urgency was overstated.
    <br>*Superseded original, kept for the trail:* "Cap figure conflicts
    with Hotfix 26's '~1 req/sec/token' (= 3,600/hour) claim. See §4.9 —
    both figures pre-date Cycle 40 Phase A's `[asc-client] budget=`
    Railway log. Authoritative `user-hour-lim` value will be revealed
    empirically from production telemetry; Phase B subset selection
    (B2/B3/B4) depends on the resolution." — that resolution has since
    happened; it is 3,600.

Cumulative Apple ASC rate-limit pattern stack (Hotfix-derived):
- Hotfix 20 — cursor pagination over hardcoded limit=50.
- Hotfix 22 — V1 sub-resource pattern to dodge the V2 ?include 50-cap.
- Hotfix 25 — lazy-load + client queue + per-cell retry.
- **Hotfix 26 — Bulk Import concurrency + per-row throttle + onRetry telemetry** (next subsection).

**Cycle 39 Phase 2 closure status post Hotfix 25:**

| Deliverable | Status |
|---|---|
| List view Availabilities column (Unit D) | ✅ Shipped (Phase 2) · ✅ Hardened (Hotfix 25 lazy-load) |
| Bulk Set Availabilities (Unit C) | ✅ Shipped (Phase 2) · ✅ Hardened (Hotfix 25 on-demand fetch) |
| Bulk Remove from Sales + confirm popup (Unit C) | ✅ Shipped (Phase 2) · ✅ Hardened (Hotfix 25 on-demand fetch) |
| Apple ASC rate-limit handling | ✅ Hotfix 25 |

**Tests added (Hotfix 25).** client-fetch-queue +4 (concurrency cap +
FIFO drain + zero-floor + sustained-load peak). AvailabilityCell +7
(inert no-UUID + each terminal state + click-to-retry round-trip).

#### Hotfix 26 — Bulk Import rate-limit hardening + onRetry telemetry hook

**Production verification.** Hotfix 25 successfully mitigated rate-limit
cascade for *View* flows (column + bulk modal lazy-load + concurrency 3),
but **Bulk Import** still cascaded — Manager's primary pain workflow.
Each row generates ~6 sequential Apple calls (create → state → locales →
screenshot → pricing → availability); with `CONCURRENCY_LIMIT = 5` the
peak in-flight rate burst past Apple's documented ~1 req/sec/token cap [^h26cap].

[^h26cap]: ✅ **CONFIRMED BY MEASUREMENT (2026-08-25).** Hotfix 26's
    "~1 req/sec/token" ≈ 3,600/hour is the **correct** figure —
    `user-hour-lim` read live off Apple = **3,600** (§4.9 carries the
    method). Hotfix 25's competing "250 req/hour" is obsolete. The
    conflict that stood here since Cycle 40 is closed; nothing in this
    hotfix needs revisiting.
Items pushed to Apple incomplete (availability not set, pricing schedule
silently failed).

**Fix scope (Manager workflow unblock).**

| Knob | Phase 2 ship | Hotfix 26 |
|---|---|---|
| `CONCURRENCY_LIMIT` | 5 | **2** |
| Inter-row delay | 0 | **1000ms** (skipped on the worker's last row) |
| `withRetry` coverage | All 10 bulk-import call sites | unchanged — already universal |
| Telemetry | none | per-row 429 / retry / backoff counters; batch-level roll-up |

**`withRetry.onRetry` telemetry hook (NEW).** Extended
`RetryOptions` with an optional callback fired once per 429 backoff:

```ts
withRetry(fn, {
  onRetry: ({ attempt, delayMs, retryAfterMs }) => {
    counters.rate429_count += 1;
    counters.backoff_total_ms += delayMs;
  },
});
```

Per-row in the bulk-import orchestrator, a `RetryCounters` bag is
created at the worker boundary and threaded through `trackedWithRetry`
at every Apple call site. The wrapper mutates the bag in place; the bag
is then attached to:

1. The returned `PerIapResult.rate_limit` (visible in the wizard table).
2. The per-row `actions_log.payload.rate_limit` (audit trail).
3. The batch-level `ExecuteSummary.rate_limit_total` (wizard chip + `BULK_IMPORT_BATCH` audit payload).

The wizard renders an amber summary chip ONLY when `rate429_count > 0`,
so clean runs stay visually quiet. The chip surfaces:

- `rows_throttled / total` — how many rows hit at least one 429.
- `rate429_count` — total retry attempts across the batch.
- `backoff_total_ms` — cumulative time spent sleeping.
- `longest_backoff_ms` — single worst stall (helps gauge Apple's mood).

**Tradeoff (Manager-locked).** ~50-item batch wall time moves from ~1 min
(burst-and-fail) to ~4-5 min (steady-pace-and-survive). Q-K fail-soft
preserved — a row that exhausts retries gets its existing
`stage`/`error` fields plus rate-limit counters so Manager can identify
exactly which rows fell off after the rate-limit recovery budget.

**Files touched (Hotfix 26):**

| File | Change |
|---|---|
| `lib/iap-management/apple/fetch.ts` | + `onRetry?: (info: RetryAttemptInfo) => void` option on `withRetry`. Non-breaking — absent in every existing call site. |
| `lib/iap-management/apple/fetch.test.ts` | +6 tests pinning the onRetry hook (invocation count, payload shape, accumulator-style usage, suppressed when no retry, suppressed for non-rate-limit errors). |
| `app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts` | `CONCURRENCY_LIMIT 5 → 2`; new `INTER_ROW_DELAY_MS = 1000`; `RetryCounters` + `trackedWithRetry` helpers; all 10 `withRetry(() => …)` callsites replaced with `trackedWithRetry(args.rateCounters, () => …)`; `persistResult` attaches counters; batch summary includes `rate_limit_total`. |
| `app/(dashboard)/iap-management/apps/[appId]/bulk-import/BulkImportWizard.tsx` | `ExecuteResult.rate_limit_total` typed; conditional amber summary chip rendered when `rate429_count > 0`. |

**Cycle 40 prerequisite.** The `onRetry` hook is the smallest piece of
"systematic infrastructure" surfaced early because Hotfix 26 needs the
telemetry now. Cycle 40 Phase A (see §10.9) shipped the highest-ROI
follow-on:

- ✅ bulk-availability orchestrator `withRetry` coverage + concurrency 5 → 2.
- ✅ X-Rate-Limit header parser + grep-friendly `[asc-client] budget=` Railway log line.
- ✅ Amber rate-limit chip on the Bulk Availabilities modal (mirrors Hotfix 26 wizard).

Phase B (token bucket throttler + universal `ascFetch` refactor + screenshot-upload concurrency audit) is deferred conditional on Phase A telemetry — see §4.9 for the go/no-go gate.

#### Hotfix 27 — Bulk Import Type column tolerance (§3.3 institutional-lock restoration)

**Production verification.** Manager uploaded a Bulk Import file without
a `Type` column and the parser rejected it with
`IAP-item template header mismatch at column 3: expected "Type", got "Price (USD)"`.
The §3.3 IAP.h2 lock has always said "Optional column; empty/absent →
CONSUMABLE default; invalid → row error" — the empty-cell branch was
honored, the absent-column branch was not. Manager institutional memory
caught the drift; tool restored compliance.

**Root cause.** `lib/iap-management/parsers/iap-items.ts` shipped Cycle
29 with a comment claiming "Q-IAP.5 strict validation" — a deliberate
positional check that conflicted with the deeper §3.3 lock. The strict
validator walked `LEAD_HEADERS` against `header[i]` at each position; a
missing or reordered Type column failed *before* row parsing even
started, so the "empty cell → CONSUMABLE" branch downstream was
unreachable when the column itself was missing.

**Fix.** Header resolution switched from positional → name-based.
`findHeaderIndex(header, name)` does a trimmed case-insensitive match
and returns -1 for absent columns. Each lead header now resolves to its
own index (or -1):

```ts
const leadIdx = {
  productId:     findHeaderIndex(header, "Product ID"),
  referenceName: findHeaderIndex(header, "Reference Name"),
  type:          findHeaderIndex(header, "Type"),
  priceUsd:      findHeaderIndex(header, "Price (USD)"),
  gtPrice:       findHeaderIndex(header, "GT Price"),
  gtCurrency:    findHeaderIndex(header, "GT Currency"),
};
```

Only `Product ID` + `Reference Name` raise a header error when absent
(`REQUIRED_LEAD_HEADERS`). Every other lead column falls back to a
documented default:

| Column | Absent / empty → |
|---|---|
| Type | `CONSUMABLE` + `type_source: "DEFAULT"` |
| Price (USD) | `0` (downstream pricing stage skips with `skipped-no-tier`) |
| GT Price | `0` |
| GT Currency | `""` |

Locale-pair detection (`Display Name (X)` / `Description (X)`) now
scans non-lead columns at any position, not just `LEAD_HEADERS.length+`,
so reorderings work end-to-end.

**Invalid-Type guard preserved.** A *present* `Type` column with an
invalid enum value (e.g. `"consumable"` lowercase) still raises a
row-level error per the institutional lock's "invalid → row error"
clause — Manager spot-checks aren't silently coerced.

**Files touched (Hotfix 27):**

| File | Change |
|---|---|
| `lib/iap-management/parsers/iap-items.ts` | Strict positional `LEAD_HEADERS` loop replaced with name-based lookup; `findHeaderIndex` helper (case-insensitive, trimmed); new `LeadColumnIndex` shape; `readOptionalCellNumber` swap for the cells under optional columns; locale-pair scan iterates from col 0 skipping `leadClaimed`; header doc-comment rewritten to spell out the required vs optional contract. |
| `lib/iap-management/parsers/iap-items.test.ts` | Replaced the wrong-position-fails test with a reordered-now-works assertion; +8 new tests (no-Type column / minimal-template / empty-cells-under-optional / missing-Product-ID / missing-Reference-Name / case-insensitive headers / invalid-Type-still-errors). |

Tests: +6 net on the parser (8 existing → 14 total in this suite —
removed the now-irrelevant wrong-position + header-shift assertions,
added 8 new ones covering each branch of the §3.3 lock).

**Cycle 29 institutional-lock compliance now binding-by-test.** The new
tests pin every branch of the §3.3 lock — column absent, cell empty,
column present + valid, column present + invalid — so the parser can't
drift back into positional strictness without a deliberate test
deletion that would surface in review.

#### Hotfix 28 — Google IAP wizard per-row currency drift (Hotfix 14 cross-surface miss)

**Module**: Google IAP Management (not Apple). Shipped in parallel with
Apple's Cycle 40 Phase A+B1 telemetry observation period.

**Production symptom.** Manager uploaded a Bulk Import Excel with USD
prices ("Price (USD)" column → 21.99, 4.99, 9.99) to an app whose
default currency is VND (London1). The wizard's Preview step blocked
with "16 row(s) violate VND precision — Google will reject these"
followed by "Row 2 (...): VND only accepts whole numbers (got '21.99')."
The same Excel rows pass the server orchestrator + Google API path —
only the wizard's UI gate was wrong.

**Root cause.** `BulkImportWizard.tsx` pre-flight validation passed
`appDefaultCurrency` (VND) to `validateDecimalForCurrency` instead of
`row.baseCurrency` (USD, resolved by the parser from the "Price (USD)"
header). The accompanying comment ("same currency is used for every row
since Google enforces app-wide") explained the historical Hotfix 5
assumption — valid before Hotfix 14 migrated the writer to Google's
Monetization API. Post-Hotfix-14 the orchestrator stamps
`defaultPrice.currency` from `row.baseCurrency` (per-row) and Google
accepts mixed-currency batches, but the wizard's pre-flight check was
left on the old app-wide assumption.

**NEW trap class — "post-migration cross-surface assumption drift".**
A migration updates one surface (the server orchestrator) while another
surface (the client validator) keeps the pre-migration invariant. Both
read the same data but apply different rules; production is silent
until a workflow whose Excel currency ≠ app default currency exercises
the wedge. Discovery requires either a coverage audit at migration time
or a Manager-reported symptom that maps the two surfaces. Going forward:
when migrating an invariant on one surface, **grep every call site of
the dropped constraint** before declaring the migration complete.

**Fix.** One-line corrective in the wizard memo + helper extraction so
the rule is unit-testable:

```ts
// before:
const err = validateDecimalForCurrency(row.basePriceDecimal, appDefaultCurrency);
// after:
const err = validateDecimalForCurrency(row.basePriceDecimal, row.baseCurrency);
```

Cosmetic companion fix in `PreviewTable.tsx`: column header was
hardcoded "Base (USD)" (pre-Hotfix-14 app-wide assumption); now reads
"Base price" with each row's currency rendered next to its decimal
value. UI clarity post-mixed-currency support.

**Files touched (Hotfix 28):**

| File | Change |
|---|---|
| `components/google-iap-management/bulk-import/BulkImportWizard.tsx` | `precisionViolations` memo extracted to pure helper `computePrecisionViolations(rows)` (exported for tests); validates each row against its own `baseCurrency`; defensive guard skips rows with empty currency; stale Hotfix 5 comment rewritten to document the per-row invariant + history. Two downstream UI copy strings updated to drop the app-default-currency framing (button title + red-banner heading). |
| `components/google-iap-management/bulk-import/PreviewTable.tsx` | Column header "Base (USD)" → "Base price"; per-row cell shows `{basePriceDecimal} {baseCurrency}` (small grey currency suffix). |
| `components/google-iap-management/bulk-import/BulkImportWizard.test.ts` | **NEW** — 8 tests pinning per-row validation: USD fractional passes; VND integer passes; VND fractional fails; production-regression case (USD column / VND-default app); mixed-currency rows validated independently; skip-decision excluded; empty `baseCurrency` defensive skip; empty preview. |

Tests +8. Existing wizard render path unaffected.

**Cumulative Google IAP currency-precision institutional learning:**

| Marker | Pattern |
|---|---|
| Hotfix 4 | Per-app default currency + locale (banner + execute payload stamping) |
| Hotfix 5 | ISO 4217 currency precision validation (zero-decimal VND/JPY/KRW/HUF/TWD…) |
| Hotfix 14 | Monetization API migration — per-row currency replaces app-wide constraint |
| Hotfix 16 | Excel column flexibility ("Price (XXX)" / generic "Price") |
| Hotfix 19 | User-explicit tier disambiguation on multi-match |
| **Hotfix 28** | Wizard pre-flight validator caught up with Hotfix 14's per-row invariant |

### 10.9 Cycle 40 Phase A — bulk-availability retry coverage + X-Rate-Limit visibility

**Manager production evidence (post Hotfix 25 + 26).** Apple ASC rate
limits continued hitting Manager workflows. Hotfix 25 covered View
flows, Hotfix 26 covered Bulk Import — but Manager reported "no retry
signal visible" on Cycle 39 Phase 2 bulk Availabilities actions. The
silent-path-instrumentation-first feedback (memory) flagged this as a
diagnostic gap before a refactor gap: investigate first, refactor only
with empirical evidence.

**Investigation.** A coverage audit of every Apple-helper call site
project-wide isolated the gap to **one orchestrator**: the Cycle 39
Phase 2 bulk-availability path called `setAvailabilityToAllTerritories`
/ `setAvailabilityRemoveFromSales` with bare `iapFetch` (no
`withRetry`), concurrency 5. Every other path (single create/edit,
submit, submit-batch, sync-states, single-IAP lazy-load, all 10 bulk-
import sites) was already covered. Documented as the §4.8 orchestrator-
bypass-retry trap class.

**Phase A scope (~2h, targeted).**

| Knob | Cycle 39 Phase 2 ship | Cycle 40 Phase A |
|---|---|---|
| bulk-availability orchestrator `withRetry` | absent | **per-row `trackedWithRetry`** (mirror Hotfix 26) |
| bulk-availability concurrency | 5 | **2** (Hotfix 26 alignment) |
| Per-row 429 telemetry | none | **rate429_count / retry_attempts / backoff_total_ms / longest_backoff_ms** |
| Batch-level roll-up | none | **rate_limit_total + rows_throttled** |
| Modal amber chip | none | **renders only when rate429_count > 0** |
| X-Rate-Limit budget parsing | none | **`parseRateLimit` in `iapFetch` + `[asc-client] budget=R/L duration=Nms` Railway log** |

**Phase B deferred — conditional on Phase A telemetry.** The full
Cycle 40 design (token bucket throttler, universal `ascFetch` refactor,
screenshot-upload concurrency audit) is held until X-Rate-Limit data
from Phase A shows whether `withRetry` recovery is sufficient or
proactive throttling is needed. See §4.9 for the go/no-go criteria.

**Files touched (Phase A):**

| File | Change |
|---|---|
| `lib/iap-management/orchestrators/bulk-availability.ts` | + `RetryCounters` / `trackedWithRetry` (inline, mirrors Hotfix 26); per-row counters threaded through helper call; `BulkAvailabilityRowResult.rate_limit?` field; `BulkAvailabilityOutcome.rate_limit_total` field; `DEFAULT_CONCURRENCY = 2`; audit payload includes `rate_limit`; complete-line console log includes throttle counters. |
| `lib/iap-management/apple/fetch.ts` | + `parseRateLimit(headers): RateLimitInfo \| null` exported; `iapFetch` measures response duration and emits a `[asc-client]` tagged Railway log line when X-Rate-Limit is present. Existing `[iap-apple]` log line preserved. |
| `lib/iap-management/apple/fetch.test.ts` | +9 tests pinning the parser (canonical format, whitespace, missing fields, non-numeric, unknown segments, header-absent path) + the iapFetch `[asc-client]` log emission contract. |
| `lib/iap-management/orchestrators/bulk-availability.test.ts` | +6 tests pinning 429 retry recovery, counters population, audit payload `rate_limit` field, multi-row rows_throttled tally, local-draft exclusion, empty-input rate_limit_total zeroed. |
| `components/iap-management/AvailabilitiesBulkModal.tsx` | + `RateLimitTotal` interface (server response shape); state hook `rateLimitTotal`; reset on close; amber chip block over the results progress list (renders only when `rate429_count > 0`). |

Tests +15 net (orchestrator +6, fetch +9). Existing 30-test baseline
across both suites preserved.

**Apple ASC trap class cumulative learning post Phase A.**

| Marker | Pattern |
|---|---|
| §4.1 LANDMARK (Cycle 31) | V2 `?include` relationship truncation at 10 IDs |
| §4.6 (Cycle 31) | V2 `?include` whitelist enforced |
| Hotfix 20 | cursor pagination over hardcoded limit=50 |
| Hotfix 22 | V1 sub-resource pattern (dodge V2 ?include 50-cap) |
| Hotfix 25 | client-side lazy load + per-cell observers + queue 3 |
| Hotfix 26 | Bulk Import concurrency + per-row throttle + `onRetry` hook |
| §4.8 / §4.9 (Cycle 40 Phase A) | orchestrator-bypass-retry trap; X-Rate-Limit budget visibility |

**Phase A verification gate.** Manager checklist after Railway deploy:

- Bulk Availability action on 25+ items completes without per-row Apple
  429 ERROR cluster.
- Amber chip renders in the modal when Apple throttled the batch;
  clean runs stay quiet.
- `actions_log.payload.rate_limit` populated on bulk-availability rows
  (Supabase SQL Editor spot-check).
- Railway logs show `[asc-client] budget=R/L` lines on responses where
  Apple returned the header — empirical budget data for Phase B
  decision.

If all four check out and 429s no longer surface in Manager workflows,
Phase B is deferred to Cycle 41+ backlog. If 429s persist despite
recovery, the empirical Railway data justifies the Phase B token bucket
refactor.

#### Phase B1 — submit-batch concurrency alignment (shipped immediately)

Phase B evaluation surfaced one zero-risk subset that ships now rather
than waits for telemetry:

| Knob | Pre-B1 | Post-B1 |
|---|---|---|
| `SUBMIT_CONCURRENCY` in `app/api/iap-management/apps/[appId]/iaps/submit-batch/route.ts` | 5 | **2** |

Submit-batch already wraps every Apple call in `withRetry` (Hotfix 26
audit), so the change only smooths the burst profile. It aligns with the
Hotfix 26 Bulk Import (concurrency 2) + Cycle 40 Phase A Bulk
Availability (concurrency 2) precedent — a single cross-flow constant
for multi-row Apple POST orchestrators. No telemetry was required to
justify it; the cost (slightly slower large submit batches) matches the
already-Manager-accepted Hotfix 26 tradeoff.

#### Phase B subset trigger criteria (telemetry-gated)

The remaining Phase B subsets are explicitly deferred and selected à la
carte based on the 1–2 day telemetry observation window:

| Subset | Trigger | Estimate |
|---|---|---|
| **B2** auto-retry lazy-load cells after cool-down | Amber "(rate limited)" cells appear frequently in normal browsing | ~1h |
| **B3** token bucket proactive throttler | Railway logs show `budget=` regularly < 500 remaining; multi-workflow contention saturates budget | ~2h |
| **B4** universal `ascFetch` refactor (centralized handler) | B2 or B3 ships AND a shared rate-limit handler reduces duplication enough to justify the refactor | ~2h |

The trigger discipline rejects speculative refactor: B2/B3/B4 are sized
and ready, but Phase B's go/no-go for each subset depends on what the
`[asc-client] budget=` logs and `actions_log.payload.rate_limit` rows
actually show in production.

**Cap-figure conflict — ✅ CLOSED (2026-08-25).** §10.8's two
pre-Phase-A figures are resolved: `user-hour-lim` = **3,600** measured
live (§4.9 carries the number and the repeatable method). Hotfix 26 was
right, Hotfix 25 wrong.

**What that does to Phase B.** B3 (token-bucket throttler) was sized on
the possibility of a 250/hour cap, where a bucket is essential. At 3,600
it is not: a 500-item export costs 1,503 requests — 42% of one rolling
hour — so two full exports per hour fit comfortably and the third is
what needs handling. B3 accordingly demotes from "essential if 250" to
"pacing + protect the budget reserved for a Manager's interactive
clicks". Its trigger (`budget=` regularly < 500 remaining) is unchanged
and still unmet.

**Cycle 37 Phase 2 deferral closure status (post Cycle 39):**

| Deferred item | Shipped in |
|---|---|
| Edit affordance on trailing slot | Cycle 39 Phase 1 (Unit B, AvailabilitiesSection) |
| "Remove from Sale" toggle parity | Cycle 39 Phase 1 (Unit B radio + Stage 5) + Phase 2 (Unit C bulk) |
| List view column visibility | Cycle 39 Phase 2 (Unit D, Manager scope addition) |
| View Detail red emphasis | Cycle 39 Phase 1 (Unit A) |

---

### 10.10 Cycle 41 — Google IAP Bulk Activate / Bulk Deactivate

**Manager directive verbatim:** flip the sale state of N selected items
on Google Play in a single Manager action. Two new toolbar buttons on
the **left** of the existing button row (green border + text for Bulk
Activate, red border + text for Bulk Deactivate per destructive
emphasis). Bulk Deactivate gates on a count-display confirm dialog
("thông báo số lượng item sẽ bị inactive"). Per-item outcome + failed
items red emphasis + success/fail counts. Rate-limit handling
production-grade for apps with large item counts.

**Mockup-first design discipline — 3rd iteration cementing.** Cycle 36
(Google matrix), Cycle 39 Phase 2 (Apple bulk availabilities), and now
Cycle 41 all followed the mockup → Manager review → architectural lock →
implementation pipeline. The pattern is now institutional: any net-new
UX surface ships a `docs/<module>/design/<feature>-mockup.html` first.

#### Architecture pivot — Google ≠ Apple for bulk state writes

The kickoff initially proposed mirroring the Apple Cycle 40 Phase A
pattern (`withConcurrency(2)` + `trackedWithRetry` + `RetryCounters`
per row). Phase 1 investigation surfaced a load-bearing API-shape
difference that justified pivoting:

| Concern | Apple Cycle 40 Phase A | Google Cycle 41 |
|---|---|---|
| Native shape | Per-IAP `POST /availabilities` | **Cross-product** `monetization.onetimeproducts.purchaseOptions.batchUpdateStates` with `productId="-"` |
| N items | N HTTP calls | **1 HTTP call per ≤100-item chunk** |
| Rate-limit need | concurrency 2 + retry + per-row 429 telemetry | sequential 1-POST-per-chunk; no per-item machinery |
| Existing helper | `setAvailability*` per-IAP | `newCrossProductBatchActivate()` at [publisher-client.ts:675](../../lib/google-iap-management/google/publisher-client.ts#L675) (already shipped Hotfix 14) |

1000 items ≈ 10 sequential batches × 1 POST each ≈ 30-50s wall time —
well under Google's per-minute quota and faster than the Apple
per-item path would have been. The pivot is a concrete instance of a
**new institutional pattern: cross-module pattern reuse with
architectural awareness** — recognize the abstract shape (Manager
selects N items → fire a bulk verb → roll up results) but respect each
provider's native API affordances rather than blindly cloning the
sibling module's concurrency machinery.

#### Implementation map

| Layer | File | Surface |
|---|---|---|
| Publisher-client export | [`lib/google-iap-management/google/publisher-client.ts`](../../lib/google-iap-management/google/publisher-client.ts) | `batchUpdateProductStates(jwt, packageName, requests)` thin wrapper over the internal `newCrossProductBatchActivate` so orchestrators own chunking + per-batch error handling |
| Audit log enum | [`lib/google-iap-management/repository/actions-log.ts`](../../lib/google-iap-management/repository/actions-log.ts) | `ActionType` += `BULK_ACTIVATE`, `BULK_DEACTIVATE` |
| Orchestrator | [`lib/google-iap-management/orchestration/bulk-status.ts`](../../lib/google-iap-management/orchestration/bulk-status.ts) (NEW) | `executeBulkStatus({ jwt, appId, packageName, skus, action, actorEmail, chunkSize? })`; chunks at 100, sequential batches, per-chunk try/catch, cache-status writeback per successful chunk, one audit row per action |
| API routes | `app/api/google-iap-management/apps/[packageName]/iaps/bulk-{activate,deactivate}/route.ts` (NEW) | POST, Zod `{ skus: string[].min(1).max(1000) }`, NextAuth session check, returns `BulkStatusOutcome` |
| Modal | [`components/google-iap-management/iap-list/BulkStatusModal.tsx`](../../components/google-iap-management/iap-list/BulkStatusModal.tsx) (NEW) | Single component, `mode: "activate" | "deactivate"` prop drives filter / palette / confirm gate |
| List wiring | [`components/google-iap-management/iap-list/IapListClient.tsx`](../../components/google-iap-management/iap-list/IapListClient.tsx) | Two buttons on the LEFT side of the existing row + separator + `<BulkStatusModal>` mount |

Single-component approach over the kickoff-proposed shared-base
abstraction: deferred per F3 ("ship parallel implementations if
abstraction emerges natural"). The mode-prop branching is small enough
that a separate base + two thin variants would have added churn without
factoring out meaningful logic.

#### Per-batch failure semantics

If a chunk POST throws (network, 5xx, auth, etc.), every item in that
chunk is surfaced as failed with the same error message. Sibling
chunks continue. The Manager re-trigger workflow ("open Bulk Activate
again, the failed items still appear as inactive, retry") was deemed
sufficient recovery vs an orchestrator-owned legacy-fallback path —
the legacy `inappproducts.patch` per-item fallback already lives
inside `batchUpsertInAppProducts` for the Bulk Import flow, but
applying it here would double the surface area without buying recovery
the Manager can't get from a second modal click.

#### Q-BULK architectural locks (Cycle 41)

| Lock | Decision |
|---|---|
| Q-BULK.1 | Eligibility source = **all matching status** (cap 1000), not paginated subset |
| Q-BULK.2 | Confirm dialog = **count-only display**, no item-list preview |
| Q-BULK.3 | Progress = **single spinner** during the wait; no SSE (deferred) |
| Q-BULK.4 | Result UX = **modal in-place result + list page refresh on Close** |
| Q-BULK.5 | Failed item recovery = **error message per row**; retry button deferred |
| Q-BULK.6 | Rate-limit handling = **batch-chunked sequential** (Google-native), not the Apple per-item-concurrency mirror |
| Q-BULK.7 | Button placement = **left** of existing toolbar row; green border for Activate, red border for Deactivate |
| Q-BULK.8 | Naming = **"Bulk Activate" / "Bulk Deactivate"** parallel pair |

#### Tests added (+13)

`lib/google-iap-management/orchestration/bulk-status.test.ts`:
- `chunkArray` × 5 (empty, single chunk, boundary 100, order
  preservation, size validation)
- `executeBulkStatus` × 8 (NO_OP empty, single-chunk SUCCESS, deactivate
  verb mapping, 250→3 batches, chunkSize override, partial failure
  middle chunk, total failure, cache-update DB-failure non-fatal)

#### Deferrals carried out of Cycle 41

- Retry-failed-items button inside the result state (Manager re-trigger
  workflow suffices for now)
- SSE progress streaming (mirrors Cycle 39 Phase 2 deferral)
- Shared BulkStatusModalBase abstraction (deferred until a third Google
  IAP bulk modal emerges)

---

### 10.11 Hotfix 29 — Google Apps list auto-refresh (additive, manual preserved)

**Manager directive:** auto-refresh the Google IAP Apps list when (1)
Manager navigates to `/google-iap-management/apps` (left menu or Home
Apps card) and (2) after switching the active Google Console account
in the header. Manual **"Refresh from Google"** button MUST be preserved
("tôi vẫn giữ lại nút Refresh from Google để sync thủ công khi cần,
không được bỏ").

#### Concrete UX problem this fixes

Manager publishes a new app on Google Play → opens the internal tool →
app missing from the cached list → tries to create an IAP → friction
("App not cached, click Refresh first"). The cache-first server page
plus a button-only refresh path made it too easy to act on stale data.

#### Architecture pivot from the evaluation

Manager's amendment after the eval explicitly forbade replacing the
manual button. Pivot from the original "silent auto-only" sketch:
**auto-refresh is additive, never a replacement.** New institutional
pattern: **"Auto-trigger additive, manual preserved"** — automation
adds convenience, the manual control stays as the explicit-intent
fallback. Both paths reuse one fetch helper; the only differentiation
is the failure surface.

#### Implementation map

| Layer | File | Surface |
|---|---|---|
| Pure helper | [`lib/google-iap-management/staleness.ts`](../../lib/google-iap-management/staleness.ts) (NEW) | `isStale(lastRefreshedAt, thresholdSeconds)` — null-safe, parse-safe, defensive (unparseable date → stale, never block a refresh) |
| Server page | [`app/(dashboard)/google-iap-management/apps/page.tsx`](../../app/(dashboard)/google-iap-management/apps/page.tsx) | Computes `MAX(last_synced_at)` across cached apps + passes as `initialLastRefreshedAt` prop (more stable than `apps[0]?.last_synced_at` which assumed at least one cached row) |
| Client | [`components/google-iap-management/apps/AppsListClient.tsx`](../../components/google-iap-management/apps/AppsListClient.tsx) | `handleRefresh({ silent })` with sequence guard via `useRef`; `useEffect` auto-trigger with Strict-mode guard + 90s staleness check; manual button never disabled |

#### Q-HF29 architectural locks

| Lock | Decision |
|---|---|
| Q-HF29.1 | Staleness threshold = **90s** (dodges rapid back-button re-fire; feels fresh after Manager publishes a new app) |
| Q-HF29.2 | Failure surface = **`silent=true` → toast.error, `silent=false` → red banner** |
| Q-HF29.3 | Manual button = **always visible, never `disabled`** (Manager directive verbatim) |
| Q-HF29.4 | Race handling = **last-write-wins via `seqRef`**; manual click during in-flight auto cancels stale state updates from the auto-trigger but lets both POSTs run (idempotent endpoint, ~negligible quota cost) |
| Q-HF29.5 | Account switch path = **free** (existing `window.location.reload()` in `GoogleAccountSwitcher` mounts the page fresh; same auto-trigger fires) |
| Q-HF29.6 | Strict-mode guard = `autoFiredRef` sentinel so dev double-fire doesn't burn a redundant search call |

#### Per-trigger cost

Steady-state established account (apps cached + currency/language
populated): ~1 search call per page mount or account switch. Realistic
Manager workflow ~10 calls/day vs 200,000/day Google quota = **<0.01%**.
First-time-on-new-account: 1 search + N × 3 enrichment calls (concurrency
5), 10-15s; existing skip-if-both-set guard at [apps/refresh:101](../../app/api/google-iap-management/apps/refresh/route.ts#L101) means
steady-state cost stays flat after first sync.

#### Tests added (+6)

`lib/google-iap-management/staleness.test.ts`:
- `null`/`undefined` → stale (defensive)
- Unparseable date → stale (defensive)
- Now → fresh
- 89s ago + threshold 90s → fresh
- 91s ago + threshold 90s → stale
- Threshold 0 + non-now timestamp → stale

Component-level interaction tests (auto-fire, sequence guard, manual
always-clickable) deferred — the existing manual `handleRefresh` test
coverage was nil and adding RTL mount tests for this one component
would be disproportionate. The sequence-guard discipline is small
enough (~10 LOC) to be reviewed by inspection.

#### New institutional pattern: "Auto-trigger additive, manual preserved"

When automation closes a UX gap, the manual control that previously
filled that gap stays. Two reasons:

1. **Manager explicit-intent loud feedback channel.** Auto-trigger
   silent-fails (toast) to avoid noise on every page mount; manual
   click is a deliberate Manager action that deserves a banner if it
   fails. Removing the manual button removes the loud channel.
2. **Fallback discipline.** Auto-trigger logic (staleness threshold,
   Strict-mode guard, sequence race) is more code than the manual
   path. If any of it breaks, the manual button remains the always-
   working escape hatch — no rollback needed.

**Anti-pattern**: "automation removes the manual control" — moves the
recovery surface area into the failure mode itself.

Applies to: cross-module sync UX (Apple module is force-dynamic-fetch
which has the same UX without a button; if the Apple module ever
introduces a cache + button, the same discipline kicks in).

---

### 10.12 Cycle 42 — User documentation site (Apple + Google IAP Management)

**Manager directive:** standalone HTML documentation site covering both
Apple and Google IAP Management modules — left-menu nested navigation
(module → feature), per-feature description + usage instructions + tool
imagery, modern web UI/UX, `ui-ux-pro-max` skill leveraged. Two binding
constraints emerged across the kickoff iterations: **design and
organization 100% match mockup** (binding contract once approved), and
**illustrations generated from codebase reads** (not Manager-captured
screenshots upfront).

#### What this fixes

No internal docs existed for either IAP module. Onboarding new team
members required walking through the running tool. The institutional
knowledge accumulated across 9 Cycles + 30+ hotfix iterations lived in
KB files (engineer-facing) and commit messages — nothing user-facing in
Vietnamese for the actual Manager/PM workflow.

#### Phase structure

| Phase | Scope | Output | Commit |
|---|---|---|---|
| **1. Investigation + Q&A** | Feature inventory both modules + Q-DOCS lock confirmation + design-language alignment | Feature inventory + Q-DOCS recommendations | (in-conversation) |
| **2. Mockup HTML build** | Site scaffold + nav + 3 fleshed representative pages + 14 skeletons + interactivity polish | `docs/user-docs/index.html` v1 (2432 lines / 112KB) | [`84c256a`](https://github.com/kiangming/appstore-connect-cpps/commit/84c256a) |
| **3. Illustration feasibility eval** | Code-based SVG vs. existing mockup reuse comparison · revealed 7 design-contract mockup HTML files cover ~70% scope | Strategy proposal (Option 0 + Strategy B) | (in-conversation) |
| **4. Implementation** | Flesh 15 skeleton pages + refine 3 fleshed · 18 features total · institutional knowledge baked | `docs/user-docs/index.html` v2 (4076 lines / 228KB) | [`da390cd`](https://github.com/kiangming/appstore-connect-cpps/commit/da390cd) |
| **4b. KB §10.12 entry** | This section · cohesive cycle closure | This entry | (this commit) |

#### Q-DOCS architectural locks

| Lock | Decision |
|---|---|
| Q-DOCS.1 | Doc depth = **B Comprehensive** (overview + steps + illustrations + tips/pitfalls per feature) |
| Q-DOCS.2 | Language = **A Vietnamese only** (Manager primary) — bilingual deferred |
| Q-DOCS.3 | Search = **B Client-side sidebar filter** (label + keyword aliases, vi + en) — full-text deferred |
| Q-DOCS.4 | Theme = **C Light + dark toggle** (persisted via localStorage + `prefers-color-scheme` fallback) |
| Q-DOCS.5 | Nav structure = **B Two-level** (Module → Feature) per Manager "tên tính năng → các feature nhỏ" |
| Q-DOCS.6 | Code blocks = **C Highlighted + copy button** (Clipboard API, success state) |
| Q-DOCS.7 | Screenshots = **B Lightbox** (click to enlarge, ESC + scrim close) |
| Q-DOCS.8 | Deployment = **A Standalone HTML in `docs/user-docs/`** — hosting decision deferred Cycle 43+ |
| Q-DOCS.S1 | Top-level strategy = **Option 0 (existing mockup reuse + gap-fill)** over the originally-proposed Option 2 (code-SVG + Manager hybrid) — leverages the 7 pre-existing design-contract mockup HTMLs |
| Q-DOCS.S2 | Integration = **Strategy B (extract + inline) UNIFORM all pages** — Manager override of the proposed hybrid (B for fleshed + A iframe for stubs); UX consistency + dark mode coordination + lightbox + no Tailwind CDN dep |
| Q-DOCS.S3 | Real screenshots = **deferred Cycle 43+** — Manager production observation may surface gaps; Playwright capture decision empirical-evidence-based |

#### Institutional insight — mockup-first discipline payoff cumulative

Pre-existing design mockup HTML inventory (built as design contract
during prior cycles):

| Mockup file | Lines | Covers |
|---|---|---|
| `docs/iap-management/design/iap-management-mockup.html` | 1466 | Apple IAPs list, New/Edit IAP modals, Pricing detail |
| `docs/iap-management/design/iap-detail-view-mockup.html` | 471 | Apple View Detail (Cycle 31) |
| `docs/iap-management/design/availabilities-bulk-mockup.html` | 551 | Apple Bulk Availabilities (Cycle 39 Phase 2) |
| `docs/google-iap-management/design/google-iap-mockup.html` | 1521 | Google IAPs list, Create/Edit item |
| `docs/google-iap-management/design/bulk-status-mockup.html` | 568 | Google Bulk Activate/Deactivate all 5 states (Cycle 41) |
| `docs/google-iap-management/design/pricing-template-matrix-mockup.html` | 590 | Pricing matrix Apple + Google parity (Cycle 36) |
| `docs/google-iap-management/design/disambiguation-step-mockup.html` | 846 | Google Bulk Import disambiguation (Cycle 35-36) |

Coverage map: **12 of 18 features (≈70%) had a pre-existing
design-contract mockup**; 3 features (Apple Bulk Import wizard, Apple
Submit batch, Google Settings) required code-based SVG gap-fill from
component source (`BulkImportWizard.tsx` 857 lines, `SubmitBatchModal.tsx`
472 lines, `GoogleAccountsClient.tsx` 387 lines).

Strategy implementation: each docs page renders an inline SVG
illustration that visually mirrors the mockup pattern (state-shell
containers, modal-within-modal confirm gates, table layouts, multi-step
wizards) using the docs site's own CSS variables — so dark mode +
lightbox + search filter all participate uniformly, with no Tailwind
CDN dependency in the docs HTML itself.

#### Content scope

Apple module (10 features + overview): Apps list, IAPs list, New IAP,
Edit IAP, View Detail, Bulk Import wizard, Pricing templates, Pricing
matrix, Bulk Availabilities, Submit batch.

Google module (8 features + overview): Apps list, IAPs list, Create
item, Edit item, Bulk Import, Pricing matrix, Bulk Activate, Bulk
Deactivate, Settings.

Per-feature structure: meta-strip (module + tags) → page title +
lede → comparison table (where applicable) → step-by-step numbered
cards → SVG illustration with lightbox + caption → tips/warnings/
danger/info callouts → cross-feature links.

#### Institutional knowledge baked into content

Hotfix and Cycle references surfaced inline where relevant to user
workflow:

| Reference | Where surfaced |
|---|---|
| Hotfix 9 (Google `regionsVersion` cross-version trap) | Google Edit item · Google Pricing matrix |
| Hotfix 12 (Google two-step write refetch) | Google Edit item · Google Bulk Activate |
| Hotfix 25 (Apple Bulk Availabilities lazy-load) | Apple Bulk Availabilities |
| Hotfix 26 (Apple Bulk Import rate-limit telemetry) | Apple Bulk Import |
| Hotfix 27 (Apple Bulk Import Type optional column) | Apple Bulk Import (Excel template doc) |
| Hotfix 28 (Google Bulk Import per-row currency validation) | Google Bulk Import |
| Hotfix 29 (Google Apps list auto-refresh) | Google Apps list · Google Settings |
| Cycle 35-36 (Google Bulk Import disambiguation) | Google Bulk Import |
| Cycle 36 + 38 (Pricing matrix cross-module) | Both Pricing matrix pages |
| Cycle 39 Phase 2 (Apple Bulk Availabilities modal) | Apple Bulk Availabilities |
| Cycle 40 Phase A + B1 (rate-limit telemetry + concurrency alignment) | Apple Submit batch · Apple Bulk Availabilities |
| Cycle 41 (Google Bulk Activate/Deactivate) | Both Google bulk pages |

#### Technical implementation

| Aspect | Decision |
|---|---|
| File | Single self-contained HTML — [`docs/user-docs/index.html`](../user-docs/index.html) (4076 lines / 228KB) |
| Dependencies | None — vanilla HTML + inline `<style>` + inline `<script>`; opens in any browser, no build/server |
| Layout | 280px sticky sidebar + main content grid · max-content-width 880px |
| Palette | `#0c447c` primary + stone neutrals — preserved verbatim from existing tool/mockup palette to maintain sibling-not-different-product cohesion |
| Theme | CSS variables on `[data-theme="dark"]` swap · localStorage persistence · `prefers-color-scheme` fallback |
| Routing | Hash-based (`#feature-id`) deep links · breadcrumb sync · `popstate` not used (single-file) |
| Search | Client-side label + `data-keywords` filter (label + Vietnamese/English aliases) · empty-state surfaced when no group has visible items |
| Code blocks | Lexer-style tokenization classes (`tok-c` comment, `tok-k` keyword, `tok-s` string) · Clipboard API copy with success state |
| Screenshots | Inline SVG wireframes using docs CSS variables — render correctly in both themes · click-to-lightbox with ESC + scrim close |
| Mobile | Sidebar drawer with backdrop scrim at `< 901px` · single-column hero/quick grids |

#### `ui-ux-pro-max` skill — applied for, not applied for

**Applied:** information architecture (nav hierarchy + cross-feature
linking density), typography hierarchy (30/20/16/14 scale, letter-spacing
on titles), Vietnamese microcopy tone (warm/professional balance),
interactivity polish (fadeIn page transitions, hover lift on cards,
collapsible nav groups), dark mode token swap, mobile drawer pattern.

**Not applied:** palette pivot (preserved existing tool tokens), stack
swap (preserved vanilla HTML + inline `<style>` — no Tailwind CDN, no
build), layout grid (preserved 280px sidebar precedent).

Pattern: skill **enhances** foundation, doesn't **replace** it.

#### Gauntlet (commit `da390cd`)

- `npm run typecheck` clean
- `npm test` 2233/2233 pass
- `npm run lint` pre-existing warnings only (no new)
- `npm run build` successful
- File structure validation: 22 nav targets ↔ 22 page sections balanced; 90 cross-page `data-goto` links — all resolve; 0 stubs remaining; 21 pages with `page-lede` (fleshed)

#### Deferred Cycle 43+

1. Real screenshots — Manager-captured OR Playwright automated · decision empirical-evidence-based post Manager production observation.
2. ~~Documentation site hosting~~ → **RESOLVED Phase 4c**: route handler [`app/user-guide/route.ts`](../../app/user-guide/route.ts) serves `docs/user-docs/index.html` behind tool auth at `/user-guide`. `getServerSession` redirects unauthenticated users to `/login`; authenticated users get the standalone HTML via `new NextResponse(html, ...)` (NOT `dangerouslySetInnerHTML` — inline `<script>` execution required for theme/search/lightbox/copy). File read once at module init; copied into the standalone server output via `experimental.outputFileTracingIncludes['/user-guide'] = ['./docs/user-docs/index.html']` in [`next.config.mjs`](../../next.config.mjs). Theme aligned with the tool: docs reads the next-themes `theme` localStorage key on load (pre-paint, no FOUC), the docs' own toggle writes back to the same key so light/dark stays coherent across tool ↔ docs reloads. Entry points: User Guide card in [`HubPage.tsx`](../../app/(dashboard)/HubPage.tsx) `TOOLS` + nav entry in [`AppSidebar.tsx`](../../components/layout/AppSidebar.tsx) `NAV_ITEMS`, both `target="_blank"` (docs is a sibling experience with its own chrome — embedding would double-render sidebar + theme toggle).
3. Per-page illustration iteration — if Manager flags specific pages needing higher fidelity to a particular mockup state.
4. IAPs list auto-refresh wider scope (Hotfix 29 only covered Apps list).
5. Apple IAP Phase B subsets B2/B3/B4 — telemetry-gated, observation continues parallel.

#### Phase 4c — Tool integration (Cycle 42 closure addendum)

**Trap class avoided — runtime fs read in `output: "standalone"`**: Next.js's
file tracer follows the module import graph; `fs.readFileSync(path)`
arguments are opaque to the tracer, so `docs/user-docs/index.html` would
NOT have been copied into `.next/standalone/` and the server would have
failed to boot on Railway with `ENOENT: docs/user-docs/index.html`.
`experimental.outputFileTracingIncludes` is the load-bearing escape
hatch — keyed by the route path (`/user-guide`), valued by a relative
glob (`./docs/user-docs/index.html`). Build verification: `.next/standalone/
docs/user-docs/index.html` (232KB) shipped alongside `server.js`.

**Trap class avoided — `dangerouslySetInnerHTML` for self-contained HTML**:
The docs site relies on inline `<script>` blocks for theme detection,
sidebar search filter, lightbox, code-copy buttons, hash routing. React's
`dangerouslySetInnerHTML` parses the HTML but does NOT execute inline
scripts (a security-by-default behavior). Returning raw HTML via
`new NextResponse(html, { headers: { 'Content-Type': 'text/html' }})`
bypasses React rendering entirely and lets the browser execute scripts
normally.

**Theme alignment mechanism**: docs HTML now has a pre-paint `<script>`
in `<head>` that reads `localStorage.getItem('theme')` (next-themes default
key), resolves `'system'` / null via `prefers-color-scheme`, and sets both
`data-theme` (docs CSS variables) and `.dark` class (Tailwind class
strategy — for symmetry with the tool even though docs doesn't import
Tailwind) on `<html>` before first paint. The docs' own toggle writes
back to the same `'theme'` key, so toggling in docs propagates to the
tool on next tool tab reload. No live cross-tab sync (deferred per
Manager: "theme-on-load matching is sufficient").

#### New institutional patterns crystallized

**Pattern: "Mockup-first discipline payoff cumulative"**

When the design phase consistently produces a contract-grade mockup
HTML (Cycles 31, 36, 39 Phase 2, 41), those mockups become
**reusable documentation assets cross-domain** at near-zero conversion
cost. Cycle 42 was the first cross-domain reuse: 12 of 18 documentation
illustrations derive from prior cycles' mockup HTML files (sometimes
verbatim layout, sometimes converted to docs-site CSS variables).
Anti-pattern: treat mockups as throw-away after a cycle ships.

**Pattern: "Feasibility evaluation reveals optimal path"**

The illustration-generation feasibility eval (Phase 3) reframed the
original "code-based SVG vs. Manager-captured screenshots" trade-off
when the existing-mockup inventory surfaced as a third axis. The eval
itself was the load-bearing deliverable — a code-first attempt would
have rebuilt visuals that already existed.
Anti-pattern: implement-then-evaluate.

**Pattern: "100% mockup fidelity discipline"**

Once Manager approves a mockup, it becomes a binding design contract
for the implementation phase. Content fills the structure; structure
doesn't drift. This applies symmetrically: feature mockups bind
implementation, **and** documentation mockups bind doc-site
implementation.
Anti-pattern: design drift during implementation phase.

**Pattern: "Strategy B uniform overrides hybrid optimization"**

When fidelity discipline is binding, a single integration strategy
across all pages (Strategy B extract + inline UNIFORM) is preferable to
a per-feature-optimal hybrid (Strategy B for fleshed + Strategy A
iframe for stubs). The ~1h extra effort buys UX consistency,
coordinated dark mode, search filter participation, and lightbox
integration — all of which would fragment under a hybrid.
Anti-pattern: optimize each unit independently, ship inconsistent UX.

**Pattern: "Continuum diversification"**

After 9 cycles + 30+ hotfixes in TypeScript/React feature engineering,
Cycle 42 pivoted into the documentation domain. Same Pattern 10 reuse
mechanics (kickoff structure, Q-locks, phased shipping, gauntlet,
KB closure) work in a different output medium. Pattern 10 itself is
domain-agnostic.
Anti-pattern: assume continuum mechanics only fit feature engineering.

---

### 10.13 Cycle 43 — Google IAP hardening + Apple pricing fixes (2026-07)

**Session scope:** A series of diagnosis-then-implement tasks on the Google IAP
Management and Apple IAP Management modules. Each task followed the same
discipline: investigation (report findings, no code) → implementation →
gauntlet 4/4 → commit on a feature branch → green-light merge to main (Path-G
auto-deploy).

---

#### 10.13.A Google — cross-currency bulk import (USD file → VND app)

**Commits:** `84d64b6` (feature) + same-day correction `a54f9fe` ("header-first
cross-currency trigger + explicit-anchor" — verified against git).

**Symptom:** Bulk Import wizard with a USD-priced CSV into a VND-default app
showed no tier candidates and refused to proceed (the old path expected the
file currency to match the app currency).

**Fix (Cycle 43 cross-currency template resolution):**

| Signal | Trigger | Resolution |
|---|---|---|
| Header `Price (XXX)` where XXX ≠ app currency | *header-first* | Cross-currency mode: re-interpret `Price` as an XXX anchor, resolve app-currency price from template |
| Value: price decimal that can't fit app-currency precision | *value-based* | Same cross-currency path |
| Same currency | normal path | unchanged |

Resolution ladder for each row:
1. Look up template tiers by `(XXX, anchorMicros)` — a USD anchor from the file → match in the template → surface the matching app-currency price.
2. **Single match** → auto-resolve (no user action needed).
3. **Multiple matches** → disambiguation chooser (same dropdown UX as existing multi-candidate rows).
4. **No template / no match** → refuse with a row-level error; that row is excluded from the pushable set.

**Implementation note:** The existing "Hotfix 4 stomp" bug was also removed here — a prior hotfix had inadvertently overwritten the resolved pricing source back to `google_default` after template resolution. The fix pins the resolved source through to the batch write.

**File:** `lib/google-iap-management/orchestration/bulk-import.ts`; query helper `listUsdTiersForSource` in `lib/iap-management/queries/templates.ts`.

---

#### 10.13.B Google — live-vs-stored price comparison on item detail

**Context:** After syncing, iap_prices holds a snapshot. If a price changes
directly in Play Console the snapshot becomes stale — previously invisible
in the tool.

**Feature:** The item detail page now fetches the live price from Google
(per-item GET, not a full list refresh) and compares it against the DB
snapshot using **BigInt-exact micros** comparison (no epsilon, no false
diffs from formatting). Divergent regions are flagged and a per-item
**"Sync from Google"** button updates the DB snapshot for that item.

Key constraints:
- Live prices are **never persisted on view** — only the explicit Sync button writes to DB.
- Comparison engine reuses `comparePrices` / `microsEqual` from `lib/google-iap-management/price-comparison.ts`.
- The live fetch is a separate async call to `/api/google-iap-management/apps/[packageName]/iaps/[sku]/live-prices`; the page renders immediately with DB data.

**File:** `components/google-iap-management/iap-detail/LivePriceComparison.tsx` (later absorbed into the unified table — see §10.13.C).

---

#### 10.13.C Google — unified pricing table (merged edit + live comparison)

**Commit:** `c2b7b24` (verified against git — this is the specific commit for
this item; §10.13.A's cross-currency import is a separate, earlier commit,
`84d64b6`).

**Context:** Previously the item-detail page had two separate blocks: the edit
form's region-override table and the live-vs-stored comparison below it.
Duplication was confusing and the edit block's scrolling was separate from the
live block.

**Feature:** A single per-country table replacing both surfaces:
- **"Price from tool"** column — editable (mutates `regionOverrides`, same handlers as before).
- **"Price live on Google"** column — read-only (async fetch to `/live-prices`).
- **Status** column — `match` / `diff` / `tool-only` / `live-only` / `auto-eq` (BigInt-exact).
- Auto-eq rows (live == base, same currency) collapse by default.
- The **save payload is byte-identical** to the old edit block — `buildIapSaveBody` was extracted verbatim as a pure tested function before the redesign to prove equivalence.
- Live column is excluded from the save payload.

**Cardinal rule (must not regress):** This was a UI/layout reorganisation.
The edit/save logic, pricing-source selection, currency handling, and what
gets written to Google/DB are unchanged.

**Files:** `components/google-iap-management/iap-form/UnifiedPricingTable.tsx`
(NEW), `lib/google-iap-management/unified-pricing.ts` (NEW),
`lib/google-iap-management/iap-save-body.ts` (NEW regression anchor).

---

#### 10.13.D Google — bulk-refresh bulk-writes ("Failed to fetch" at ~1000 items)

**Root cause:** `batchSyncIapsFromGoogle` ran `syncIapFromGoogle` sequentially
per product — ~5 Supabase round-trips each (upsert iaps + delete/insert
listings + delete/insert prices). At Google's 1000-IAP-per-app ceiling:
~5,000 sequential round-trips → 2–5 min → exceeded the platform request
timeout → browser surfaced the ambiguous "Failed to fetch" TypeError.

**Fix — upsert-then-delete-stale:**

1. Bulk-upsert all iaps in chunks of 500 (resolves sku → id).
2. For child tables (iap_listings, iap_prices): bulk-**upsert current rows first**, then delete stale rows using `syncFloor`.
3. `syncFloor` = `MIN(updated_at)` returned by this run's upserts — a DB value vs DB value comparison, immune to app/DB clock skew. Strict `<` errs toward keeping rows.
4. A failed upsert chunk marks those items failed and **excludes them from the delete pass** (their existing rows untouched) — no failure path strips prices.
5. The legacy `inappproducts.list` fallback now also paginates via `tokenPagination.nextPageToken` (single call previously truncated silently at ~1000).
6. Client refresh wraps fetch in an `AbortController` (`REFRESH_TIMEOUT_MS=120s`) with a clear timeout message.

Round-trip reduction: ~5,000 sequential → **<20 set-wide operations** for 100 items (tested, bounded, non-linear).

**File:** `lib/google-iap-management/repository/iaps.ts`, `lib/google-iap-management/google/publisher-client.ts`.

---

#### 10.13.E Google — list-read .in() chunking (empty list at >~200 items)

**Root cause:** `listIapsWithDefaultLocale` fetched iap_listings via
`.in("iap_id", [all iap ids])` in one request. supabase-js does NOT
auto-chunk `.in()`. At ~293 items: ~293 UUIDs × ~39 chars/UUID ≈ 11.4 KB
query string → exceeded Supabase gateway's ~8 KB URI limit → error thrown →
`page.tsx`'s `.catch(() => [])` swallowed it → "No IAPs cached yet" despite
293 items in DB. Break-even ≈ 210 items.

**Fix:**
- `ID_IN_CHUNK = 200` — shared between the read path's `.in()` and the write
  path's stale-delete (ensures both treat large id sets identically).
- `ROW_PAGE = 1000` — range-paginate within each id-chunk to avoid PostgREST's
  1000-row default silently truncating heavily-localised apps.
- `page.tsx` error-swallow removed: `try/catch` + `loadError` prop → UI
  renders "Failed to load IAPs" (distinct from the empty-app "No IAPs yet").

**Institutional rule born here:** the write path (bulk-writes, 80c0bdd)
already chunked its `.in()` at `DELETE_ID_CHUNK=200` for exactly this reason.
The read path was never given the same treatment. → **Recurring pattern §P1
below** (twin-path hardening).

**File:** `lib/google-iap-management/repository/iaps.ts` (read and write now
share `ID_IN_CHUNK`).

---

#### 10.13.F Google — soft-delete flagging (`deleted_on_google_at`)

**Context:** Items deleted/renamed on the Play Console accumulated in the cache
(an app showed 293 live on Google + 109 orphans = 402 in DB). The bug was
confirmed via diagnostic SQL: `total_rows=402`, `distinct_skus=402`,
`duplicate_rows=0` → 109 are distinct orphan SKUs not touched by the latest sync.

**Feature — soft-delete instead of hard-delete:**

- New column `iap_mgmt.iaps.deleted_on_google_at` (nullable TIMESTAMPTZ).
  `NULL` = present on Google. Set = flagged; value = first-detected-missing timestamp.
- **Sync reconcile** (runs after child replace, in `batchSyncIapsFromGoogle`):
  - Absent from Google + not already flagged → flag now.
  - Reappeared while flagged → clear (self-correcting un-delete).
  - Already flagged + still missing → **preserve original date** (never overwrite).
- **Anomaly guard** — skip ALL flagging (log reason) when ANY of:
  `fetch_incomplete`, `empty_response`, `product_missing_sku`,
  `incoming < 50% of cached count`. Upserts still proceed; only the flag
  reconcile is gated. Protects the warning's credibility — a partial fetch must
  not spuriously flag the live catalog.

**UI effects:**
- Amber warning banner at top of IAPs list when flagged count > 0.
- Count chips: "293 on Google Play" / "109 not on Google".
- Flagged rows sorted to the bottom in a separate red block (excluded from main pagination count).
- Show/hide filter chip; per-row **Acknowledge / Remove** (inline confirm) + bulk **Remove all N** modal.
- **Flagged items excluded from activate/deactivate** (a gone-from-Google item cannot be pushed).
- Detail/edit page for a flagged item shows a deleted state (no edit/sync form).

**Migration:** `supabase/migrations/20260702120000_google_iap_mgmt_deleted_on_google.sql` —
adds `deleted_on_google_at`, partial index on flagged rows, expands
`actions_log.action_type` CHECK with `IAP_ACKNOWLEDGE_REMOVE` and closes
the `BULK_ACTIVATE`/`BULK_DEACTIVATE` gap (both were emitted but absent
from the CHECK → silently failed on every bulk operation since Cycle 41).

---

#### 10.13.G Google — purchase-options RMW ("Missing: legacy-base") ← LANDMARK

**Symptom:** Bulk Import overwrite rows (existing SKUs) failed with Google API
error: "Product must list all of its existing purchase options. Missing:
legacy-base."

**Root cause confirmed (B — not A):**
- `FULL_UPDATE_MASK = "listings,purchaseOptions,..."` — the PATCH **replaces
  the entire `purchaseOptions` array**.
- Our code always sent exactly one option: `{ purchaseOptionId: "buy", buyOption: { legacyCompatible: true }, ... }`.
- Products originally created via the **legacy `inappproducts.*` API** surface
  under the new Monetization API with `purchaseOptionId: "legacy-base"`.
- Our single-`"buy"` PATCH tries to delete `"legacy-base"` by omission → Google rejects.
- `legacyCompatible: true` was **already correctly set** — Hypothesis A
  (missing flag) is dead. The real cause is omitting an existing option.

**Fix — read-modify-write for overwrite rows only:**

| Path | Change |
|---|---|
| **Overwrite rows** | GET the live product via `newGetOneTimeProduct` (the raw function, NOT `getInAppProduct` which normalises through the adapter and discards purchaseOptionIds) → extract full `purchaseOptions` array with real IDs → pass to adapter |
| **Create rows** | Unchanged — single `"buy"` option, `allowMissing:true` |

Adapter (`inAppProductToOneTimeProduct`) new `existingPurchaseOptions` param:
- Target option selection: `pickTargetPurchaseOption` — prefers `legacyCompatible buyOption` → any `buyOption` → first option (same preference as the read-path `pickCanonicalPurchaseOption`).
- Updates `regionalPricingAndAvailabilityConfigs` on the target only.
- Passes ALL other options through **unchanged** (multi-option products preserved).

Publisher (`batchUpsertInAppProducts`):
- `BatchUpsertInput.isOverwrite` flag; GETs run with bounded concurrency (5 parallel).
- Per-row GET failure: that row fails cleanly (null in result array), batch continues — **no PATCH with a guessed option set**.
- `allowMissing` is now `false` for overwrite rows (not `true`).

**Core invariant:** An overwrite PATCH always includes the **complete** existing purchase-option set with real IDs. Sending a subset is rejected now; if Google relaxed the guard it would silently delete purchase options from live products.

**Discovery JSON** (in repo at `docs/google-iap-management/api/google-android-publisher-v3-discovery.json`) confirms field names:
- `Schema$OneTimeProductPurchaseOption.purchaseOptionId` — "Required. Immutable."
- `Schema$OneTimeProductBuyPurchaseOption.legacyCompatible` — the correct field name.

**Follow-up (Hotfix 30, commit `1fb3f7e`, 2026-07-21) — LANDMARK: purchase-option ids are developer-specified, never assume `"buy"`.**

The RMW fix above only covered `batchUpsertInAppProducts` (the bulk-import
overwrite path). It was never ported to three other surfaces that build
the exact same kind of request:

- `bulk-status.ts`'s `executeBulkStatus` (serves BOTH bulk-activate AND
  bulk-deactivate) — hardcoded `purchaseOptionId: DEFAULT_PURCHASE_OPTION_ID`
  ("buy") for every sku, unconditionally, with no live lookup at all.
- `patchInAppProduct` (single-item edit) — built its write shape via
  `inAppProductToOneTimeProduct` without ever passing
  `existingPurchaseOptions`, so it always took the CREATE-path branch and
  defaulted to `"buy"` even though it was patching an EXISTING product.

Both 404'd identically: `"Purchase option not found ... 'buy'"` — on any
product whose real id differs from `"buy"` (i.e. anything migrated from
the legacy `inappproducts.*` API, carrying `"legacy-base"`). This is a
generalizable landmark, not just a bug: **Google Play purchase-option ids
are DEVELOPER-SPECIFIED, not a fixed platform constant** — `"buy"` is
only a convention Google's own codelab examples use, and only this tool's
own convention for products it creates fresh. No write path may assume it
without first reading the live product.

**Fix — a shared choke point, not three separate patches:** new
`lib/google-iap-management/google/resolve-purchase-options.ts` (pure
`resolvePurchaseOptionFromLive`, reusing the same `pickTargetPurchaseOption`
preference order as the 4fbcdd5 fix) plus an exported
`resolveLivePurchaseOptions()` in `publisher-client.ts` (GET-live,
bounded concurrency, per-product failure isolation). Both `bulk-status.ts`
and `patchInAppProduct` now route through this ONE function instead of
each independently guessing — see §10.13.K **P1** for why a shared choke
point, not a third copy-pasted fix, is the correct shape here.

**Deliberately deferred, not fixed:** a product can have 2+ ACTIVE
purchase options; this fix resolves a SINGLE target id (same preference
order as before) and only touches that one. A 2+-active-option product is
surfaced via a non-blocking `warning` on the per-sku result (amber marker
in `BulkStatusModal.tsx`) rather than silently under-deactivated — full
multi-option state batching is out of scope until a real 2+-option
product is observed in the catalogue (see the Accepted Limitations note
in §10.15).

**Also fixed in the same commit:** per-sku GET-failure isolation (that sku
fails, siblings proceed — mirrors the batch-upsert pattern), and the
`sku=-` logging gap (the underlying Google call is one wildcard-`productId`
POST per chunk, so `bulk-status.ts` now separately logs the resolved
`(sku, purchaseOptionId)` set per chunk for diagnosability).

---

#### 10.13.H Apple — tier-gate source alignment

The bulk-import preview gate read IAP tier data from `iap_prices` /
`price_tier_territories` while the template-resolve path wrote to
`price_tier_template_entries`. A mismatch meant preview could pass tiers
that execute then couldn't find. Fixed by a single-source helper
`listUsdTiersForSource` (in `lib/iap-management/queries/templates.ts`)
used by both preview and execute, reading from the same table.

→ **Recurring pattern §P1 below** (twin-path hardening).

---

#### 10.13.I Apple — batch price-point cache + ID encoding (LANDMARK)

**Context:** Apple's pricing-schedule POST requires a `pricePointId` per
territory (opaque string per territory+customerPrice+IAP combination).
Naïvely fetching one per item per territory = ~175 round-trips per IAP.

**Discovery:** Apple price-point IDs are deterministically derivable:
```
id = base64_standard_UNPADDED(JSON({ s: iapId, t: territory, p: priceTier }))
```
(Confirmed by decoding IDs captured from real Apple API responses.)

**Fix — batch price-point catalog:**
1. Fetch the **global (territory, customerPrice) → tier** catalog **once per
   batch** using Apple's `listAllPricePoints` — a single set of calls, not
   per-item.
2. Cache it keyed by `iapType` (managed / subscription tiers differ).
3. Per-item: derive IDs by reconstructing `JSON({ s: iapId, t: territory, p: tier })` → base64_standard_UNPADDED.
4. **First-item round-trip verification**: after building the derived ID for
   the first item, verify it against a real Apple API GET. If the encoding
   diverges → auto-fallback to the per-item fetch path.

Reduction: ~175 Apple API calls per IAP → ~dozens total per batch (constant, not per-item).

**Files:** `lib/iap-management/apple/batch-price-point-catalog.ts` (NEW),
`lib/iap-management/apple/price-point-id.ts` (NEW).

---

#### 10.13.J Apple — overwrite-pricing cycle

Three inter-related fixes to the Apple "overwrite existing IAP" path:

1. **Partial-template-fail amber badge**: when some territories can't be matched in the pricing template, the base price is applied to matched territories and unmatched are left to Apple's auto-equalisation. Previously the row turned red (full failure). Now: amber badge "Partial match — N territories applied; M unmatched auto-equalized by Apple". Distinction matters: a partial match is informational, not a hard failure.

2. **Overwrite audit uuid fix**: the audit row was being created with `iapId: <new>` instead of the existing IAP's UUID (mirroring the create-path behaviour). Fixed: overwrite path passes the existing `iapId: null` sentinel to the audit helper so it looks up the live UUID, matching the create audit shape.

3. **Localization delta planner**: on overwrite, the tool must create new locales, patch changed locales, and delete removed locales — but it must **never delete the last localization** (Apple rejects an IAP with 0 locales). Delta planner: compute additions/updates/deletions; execute creates + patches first, confirm, then delete-only-if-remaining ≥ 1.

---

#### 10.13.K Recurring patterns / meta-rules crystallized

**P1 — Twin-path hardening audit**

When hardening a data-access pattern on one path (chunk a `.in()`, migrate a
source table, fix a currency stamp), grep for **every twin path** and apply the
same treatment. Validation gates and readers are systematically left behind on
the old pattern.

Confirmed instances: tier-gate source (preview vs execute), `.in()` chunking
(write path chunked at 200; read path never was → empty list at >~200 items),
Hotfix-4-stomp (cross-currency stamped pricing source overwritten back to
`google_default` after resolve); Google purchase-option-id RMW (4fbcdd5
fixed only the bulk-import overwrite path — `bulk-status.ts` and
`patchInAppProduct` kept the hardcoded `"buy"` default until 1fb3f7e,
§10.13.G). That last instance also crystallizes the STRONGER fix shape:
don't just patch the twin paths individually — extract a SHARED choke
point (`resolveLivePurchaseOptions()`) all callers route through, so the
next new write path can't reintroduce the same divergence by construction.

When the twins are REPLACE-semantics fields on the same resource, sweep
them in order of how LOUDLY they fail — the silent one is the one that
survives. `4fbcdd5` fixed `purchaseOptions` (Google REJECTS a partial
set: "must list all existing purchase options. Missing: …") and left
`listings` on the identical PATCH body untouched, because Google accepts
a partial listing set silently and destroys the rest (the still-open
§10.13.K backlog item). A sibling that errors gets fixed by its own bug
report; a sibling that quietly eats data never announces itself, so it
needs the deliberate sweep.

Companion instance, same feature, one cycle later — **a rule enforced
outside the scope it was correct in.** The custom-prices `defaultPrice`
rule ("must include an app-currency entry") was locked while custom was
template-only, where the custom set REPLACES the whole price set and is
therefore the only possible source of `defaultPrice`. When custom was
later allowed under Google Conversion — a SPARSE OVERLAY, where
`defaultPrice` comes from the file's base price — the unqualified rule
would have refused legitimate partial overrides. Branching the server was
not sufficient: the dialog's Save gate carried the same unscoped rule, so
the UI blocked exactly what the server had just been taught to accept.
**Both layers must be swept, and a comment asserting "no exception" is a
scope claim that needs re-checking whenever the scope moves** — the
original wording invited a future reader to "restore" the rule. Full
detail: `docs/google-iap-management/design-bulk-import-custom-prices.md`
§4.4.

Clean PREVENTIVE instance (Google Bulk Import per-item custom prices,
Aug 2026): the module already had two per-country price editors that had
drifted (the detail view's `UnifiedPricingTable` treats currency as
display-only; the older create-mode block lets you type it). Rather than
add a third for the custom-prices dialog, the editable cell was extracted
to a shared `components/google-iap-management/pricing/RegionPriceCell.tsx`
that BOTH surfaces render — the choke-point shape above, applied before
the divergence rather than after. Same cycle also crystallized the
companion rule: the shared component owns PRESENTATION only. It performs
no validation, deliberately; the rules live in `currency-precision.ts`
and every caller invokes them. A component that validated would let a
caller that forgot to render it skip the check silently.

**P2 — `actions_log` CHECK constraint must include new action types**

New `action_type` values are silently ignored when the DB CHECK constraint
doesn't include them (the insert errors and `appendAction` swallows it).
Confirmed silent failures: `BULK_ACTIVATE` + `BULK_DEACTIVATE` (Cycle 41 —
emitted since day 1, never in CHECK). Always verify the CHECK before
shipping a new `ActionType` enum value.

Fix pattern: include the new type in the migration's `DROP CONSTRAINT / ADD
CONSTRAINT` block. Use a single additive migration rather than mutating in-place
(forward-only migration discipline).

**P2 RECURRED AFTER BEING WRITTEN DOWN (Aug 2026) — and that is the lesson.**

Second confirmed instance, this time on Apple: `AVAILABILITY_SET_ALL_TERRITORIES`
and `AVAILABILITY_REMOVE_FROM_SALES` were emitted from four call sites across
three files (Cycles 37/39/40) and were never in `iap_mgmt`'s CHECK. Every one of
those audit rows was rejected in production from the day the feature shipped;
the Manager's successful UAT of `bd54826` is itself the evidence that the loss is
invisible from the outside. Fixed by migration `20260811000000`.

**The rule was documented, read, and still missed. So the rule was replaced by a
guard**: `lib/audit-constraints/` — `guard.ts` (mechanism) + `registry.ts` (one
declaration per module) + `guard.test.ts`, failing at `npm test` instead of
silently in production. Properties that make it real rather than decorative:

1. **Exact parity, both directions**, against the *newest* migration that
   defines each module's CHECK — a value in code but not SQL fails, and vice
   versa.
2. **Source scan across every emission shape**, per module. Literal grep alone
   would have reported the Apple drift as clean: both missing values hid in
   indirect emitters (a `writeAuditRow` parameter and a ternary). Shapes are
   **not portable between modules** (P8): iap uses `action_type: "X"` + two
   positional helpers, Google funnels through `appendAction({ actionType })`,
   store_mgmt emits mostly from plpgsql `INSERT`s.
3. ⚠ **SELF-CHECK SENTINELS — one per shape per module.** A pattern that
   silently stops matching finds zero violations and *passes vacuously*; the
   sentinel (a value reachable only through that shape) turns that into a
   failure. This is the single most important property in the guard.
4. **Discovery completeness** — the test sweeps the migrations for every
   `<schema>.actions_log`-shaped audit table and fails if one has no registry
   entry, so a future module is covered without anyone remembering to extend it.
5. **Declared blind spots.** store_mgmt's SQL tuple scan is `coverage-only`
   (positional `entry_type` is textually indistinguishable from ticket-state
   literals in the same statement), recorded in the registry and surfaced in a
   test name rather than left implicit.

**Cross-module audit result (Aug 2026)**: `iap_mgmt` had the 2-value drift (now
closed); `google_iap_mgmt` **clean** (13 declared = 13 in CHECK; `IAP_DELETE`
allowed-but-unused, retained); `store_mgmt.ticket_entries.entry_type` **clean**
(7 = 7; `ASSIGNMENT`/`PRIORITY_CHANGE` deferred-but-declared); CPP/`public` has
**no audit table at all** — a different posture, not a pass.

**Two corollaries worth carrying forward.** (a) Never *remove* a value from a
CHECK to "clean up": Postgres validates a recreated CHECK against existing rows,
so dropping one that historical rows carry makes the `ALTER` fail — record it as
explicitly-unused instead. (b) Severity is **module-specific**, so verify it
rather than assuming: the silent modules lose only the audit row, but
store_mgmt's `*_tx` RPCs roll back the *data write* too (see the correction in
§8.2).

**P3 — Surface divergence from external state; don't silently reconcile**

When the tool's cached state diverges from the authoritative external system
(Google/Apple prices, deleted-on-Google items), show the divergence to the
operator and let them decide. Don't silently re-sync or hide the gap.

Evidence: live-vs-stored price comparison (divergence badge per region);
deleted-on-Google soft-delete flagging (amber warning banner, explicit
acknowledge/remove).

**P4 — PATCH with replace-semantics updateMask requires read-modify-write**

When an API PATCH lists a collection field (`purchaseOptions`, availability
schedules, …) in its `updateMask`, the field is **fully replaced** with the
request body's value. Sending a subset deletes the omitted members.

Canonical fix: GET the existing resource first, merge your changes into the
full existing collection, then PATCH the merged set. Do NOT hardcode a
synthetic member (e.g. `purchaseOptionId: "buy"`) when the live resource may
have a different ID (`"legacy-base"`).

This pattern applies to any Apple or Google API where the update mask
replaces a collection. Audit every update path when a new collection
field is added to a mask.

**P5 — The status principle: terminal status must reflect REAL outcome, not the button clicked or a per-item label**

A tracking/Hub terminal status (or any aggregate success/fail signal) must
answer "did the underlying goal state actually get reached" — not "which
UI action did the user take" and not "does some per-item field say
SUCCESS." Confirmed instances, spanning three otherwise-unrelated
features:

| Instance | Naive read | Correct read |
|---|---|---|
| All-skipped bulk-import batch (**P2** above / 613a9c3) | 0 succeeded → looks like FAILED | Nothing was attempted-and-failed → SUCCESS |
| Google bulk operation, every row refused by Google | Same shape as above | SUCCESS (no real failures occurred) |
| Submit-batch partial-fail, user clicks "Cancel — don't submit" (§10.15) | User clicked a "cancel"-labeled button → looks like CANCELLED | 0 IAPs reached Apple review, and real Apple writes already happened → FAIL, not CANCEL |
| Submit-batch: all reviewSubmissionItem adds succeed, but the final submit PATCH fails (§10.15 / §10.16) | Every item's own `status` field says `"SUCCESS"` → looks like SUCCESS | `"SUCCESS"` there means "added to the container," not "reached review" — 0 items reached review → FAIL |

**Rule of application**: before wiring ANY terminal-status computation,
name explicitly what the "goal state" is (reached review? item persisted?
external system accepted it?) and compute the status from THAT, never
from a UI label or an intermediate-step's per-item field that shares a
name with — but doesn't mean — final success.

**P6 — Cross-process cache staleness (multi-instance deploy)**

An in-memory cache on a service that runs 2+ instances (Railway rolling
deploys run old + new instance side by side during a deploy) will serve
stale reads that a single-process mental model never catches — a write on
instance A doesn't invalidate instance B's cache. For a **cold path**
(read a handful of times per batch/request, not a hot loop), the fix is
**no cache at all**, not building cross-process invalidation — the
performance the cache buys is negligible against the correctness risk.

Instance: `hub_tracking_config`'s original 5-minute in-memory cache caused
the `enabled` Settings toggle to appear to "silently revert" and a
just-saved token to read back as missing (`9ed7845`) — removed entirely,
every read now hits the DB (see §10.15).

**P7 — Tracking: prefer a missed signal over a wrong one**

A fire-and-forget auxiliary call (telemetry, tracking, audit) that can't
yet determine the correct status must stay silent rather than send a
guessed/wrong one. A dropped signal is a gap; a wrong signal is
misinformation that looks authoritative.

Instance: Google's Hub-tracking slow-start race (`ce169a8`) — when a
fire-and-forget `/hub-tracking/start` call resolves AFTER the real
execute has already begun, the late `run_id` is dropped silently (never
adopted, never cancelled) rather than auto-labeling that real, actively-
succeeding run as CANCELLED.

**P8 — Twin-structure asymmetry (extends P1)**

P1 says: when hardening path A, grep for twin path B and apply the same
treatment. This crystallizes a sharper corollary: twin modules are **not
symmetric** — porting pattern A→B 1:1 leaves gaps wherever B has its own
extra surfaces A doesn't, or its own timing that A's fix doesn't
anticipate.

Confirmed instances:
- Google's IAP Management landing page has a nav-card grid Apple's
  module has no equivalent of — porting Apple's Hub-tracking Settings
  page without adding a matching nav card left it undiscoverable
  (`b5265c2`).
- Bulk Import threads `hub_run_id` via multipart FormData; submit-batch
  (a JSON API, not multipart) has to thread the same concept via a JSON
  body field instead — same concept, different transport, because the
  target surface's request shape differs (§10.15/§10.16).
- The "slow-start race" fix that was CORRECT for Apple's timing (drop the
  late run, don't adopt) was ported to Google in the SAME shape, but
  Google's actual timing characteristics reintroduced the CANCELLED
  mislabel through a different path than Apple's original bug — the twin
  port needed its own re-validation against the target's real timing, not
  just a copy of the source's fix (`ce169a8`; see **P7** above).

**When porting a pattern to a twin module: audit the target's *extra*
surfaces, and re-validate timing/ordering against the target's actual
flow — don't assume the source's fix transfers unchanged just because the
API shapes look similar.**

**P9 — Design-first pays off most exactly where a feature LOOKS like a proven pattern**

The temptation to skip a design pass is strongest when a new feature
resembles something already built and battle-tested — but that's
precisely where a dangerous mismatch hides, because surface similarity
invites assuming the proven pattern transfers wholesale.

Instance: IAP submit-batch's Hub tracking looked, at a glance, just like
Bulk Import's Hub tracking (same config, same lifecycle calls, same
cancel-guard concept) — but submit-batch's reviewSubmissions v2 path is
**multi-request** (a conflict or partial-fail response pauses for a
client round-trip before the outcome is known), which breaks Bulk
Import's core assumption that one request-scoped `try/finally` can always
own the terminal close. This was caught on paper, in the design doc,
before any code was written — see §10.15.

**P10 — Finalize-in-finally is a REQUIRED discipline for any tracking integration, and "the function exists" is not the acceptance test — a MUTATION-CHECK is.**

A tracking finalize (Hub run close, or any external "this operation
finished" signal) must sit in a `try/finally` wrapped around the WHOLE
operation, with the terminal status defaulted to `FAILED` and only
overwritten to the real value right before a legitimate success exit. An
unexpected mid-operation throw must NEVER leave the run `RUNNING` — this
is worse than the already-accepted tab-close orphan (§10.15's "no
RUNNING-run TTL" limitation): a tab-close is a user action outside the
tool's control, but an unhandled in-tab exception is a code defect the
`finally` is specifically there to catch.

**The acceptance criterion is a mutation-check, not a passing test suite.**
A test asserting `finalizeX` was called proves the HAPPY path is wired —
it does NOT prove the `finally` (vs. a `catch` that swallows and never
finalizes, or no wrapper at all) is what's making it pass. Verify by
deliberately breaking the `finally` (delete it, or replace with a bare
`catch {}`), confirming the SPECIFIC test that exercises the unexpected-
throw path now fails, then reverting and confirming it passes again. A
test that still passes with the `finally` removed is a fake test — it
happened to pass for an unrelated reason (e.g. the mock's happy-path
default), not because the finalize discipline actually fired.

Confirmed instances (verified this way, not just asserted): CPP Bulk
Import's client-orchestrated finalize (`7408176` — the initial
`CppBulkImportDialog.test.tsx` FAILED/PARTIAL tests only exercised the
NORMAL per-CPP-failure path; a dedicated unexpected-throw test was added
and mutation-verified) and Google bulk-status's server-route finalize
(`2e710d3` — removing `bulk-deactivate/route.ts`'s `finally` made the R1
test fail with 0 calls instead of 1; reverted and re-confirmed passing).

**P11 — Finalize-placement follows the orchestration locus, not the last integration's shape.**

Where the finalize call lives is a structural decision, not a style
preference — pick it from how the operation itself is orchestrated:

- **Single server-route operation** (one client→server round-trip that
  owns the whole write, e.g. Bulk Import's execute route, bulk-status's
  `executeBulkStatus`) → **server-side finalize**, inside that route's
  own `try/finally`. Robust to a client tab-close mid-write: the server
  call already owns the terminal regardless of what the browser does
  after the request is sent.
- **Client-orchestrated operation** (the client itself drives multiple
  requests — e.g. CPP Bulk Import's per-CPP `Promise.all` worker pool,
  each CPP a separate asset-upload sequence) → **client-driven finalize**:
  there is no single server route to host a `try/finally` around, so the
  client computes the terminal status after its own orchestration
  settles and POSTs the close itself, in ITS OWN `try/finally`.

Don't infer placement from copying the most recent integration — verify
which shape the NEW operation actually has (single round-trip vs.
client-orchestrated multi-request) before choosing, per **P9**. See
§10.15's per-integration table for both shapes side by side.

**P12 — Cancel-eligibility keys off a PERMANENT committed-ref, never a transient in-flight flag.**

A cancel guard (should this in-flight tracked operation be closed as
CANCELLED right now?) must check a ref/flag that is set once, the instant
the real mutating call is committed to, and NEVER reset — not a
transient state variable like `submitting`/`loading`/`executing` that
flips back to `false` once the request settles (success OR failure). A
transient flag re-opens a window where a UI action taken AFTER the write
already completed (but whose handler doesn't know that) can send a
spurious CANCELLED that overwrites the real terminal status the server
already recorded.

Origin: Apple Bulk Import's `executeStartedRef` (`4ba8e6f`) — the first
fix for exactly this class of bug. Reinforced by a NEW instance in Google
bulk-status (`2e710d3`): `BulkStatusModal.tsx`'s outer-modal backdrop
`onClick={handleClose}` is reachable even while `submitting=true` (the
X/footer-Close buttons are `disabled={submitting}`, but the backdrop
click has no such guard) — proving the transient-flag risk is not
theoretical even in a brand-new component built with the lesson already
in mind elsewhere in the same file. The guard (`writeStartedRef`) must be
checked by every cancel-eligible site (confirm-dialog decline, modal
close, `beforeunload`), not just the obvious ones.

**P13 (minor) — after a git operation goes sideways, verify the COMMITTED content directly, don't trust a clean working tree.**

If a git command mid-task does something unintended (e.g. a `git
checkout -- <file>` meant to revert a deliberate mutation-check edit
instead reset the file to pre-session `HEAD`, discarding real committed-
this-session work because it hadn't been committed yet when the checkout
ran), a clean `git diff`/`git status` afterward only proves the working
tree matches SOME prior state — not that it's the CORRECT one. Verify by
reading the actual committed content (`git show <hash>:<path>`) and by
re-running the relevant tests from a clean `HEAD` (not just the working
copy) before trusting the tree is right. Instance: the `2e710d3`
push-hygiene verification session, where a backup taken immediately
before the mutation (not `git stash`/`git checkout`) was what actually
recovered the correct pre-mutation file.

**P14 — LAYER-GAP, 3rd instance: a guard duplicated on client and server must be opened on BOTH.**

"The server accepts it" ≠ "the user can reach it". Confirmed instances: Google's
`canSave` dialog gate blocking exactly what the server had just been taught to
accept (§10.13.K P1 companion); and Apple's `isEmptyDiff`, which exists on the
server route **and** as a client copy inside `handleUpdateOnAppleClick` — opening
only the server one still left a customs-only edit showing "No changes detected"
and never opening the confirm modal, so the feature was dead on the Edit path
despite a correct merge behind it (`74b9739`, design §6.3). **When a rule lives in
two layers, grep for every evaluation site before declaring it fixed.**

**P15 — Structural tests that grep source MUST strip comments.**

A fitness test that reads raw source and forbids a string will fire on the
*prose that explains the rule*. Hit twice in two consecutive sub-chunks: the
"never store an Apple price-point id" assertion failed on its own explanatory
comment (`c8dcbef`), then the single-writer assertion failed on three route files
that merely NAME the table while documenting that they go through the repository
(`90560fc`). Both now strip block/line comments and assert on declarations or
call sites. **A test that punishes the explanation teaches authors to delete the
explanation.**

**P16 — Two fake-test shapes, both caught this cycle by mutating them.**

Neither is detectable by reading the test; only a mutation reveals them.

1. **A test that MIRRORS the guard's own logic** cannot fail when the real guard
   is reverted. The first gate-2 test re-implemented `shouldRun` as a local truth
   table and asserted against itself — reverting the production clause left it
   green. Replaced with a test that drives the real `updateIapOnApple`, which then
   failed with 0 orchestrator calls.
2. **A shared-function pin that matches the bare IDENTIFIER** passes when someone
   keeps the import and hand-rolls the logic. The "client and server call the same
   predicate" test matched `isCustomPricesSubmitBlocked`, so a mutation that kept
   the import and inlined a tier comparison PASSED. Now matches the CALL site
   (`name(`), re-verified against that same mutation.

⇒ **Mutate every guard test you write, and check WHAT it failed on.** A mutation
that fails for the wrong reason proves nothing (P10's rule, extended: the failure
message must name the defect, not an unrelated symptom).

**P17 — A MUTATION MUST PROVE IT WAS APPLIED. A GREEN MUTATION IS A FAILED
MUTATION, NOT A PASS.**

Companion to P16, and the missing half of it. P16 says mutate the test and check
what it failed on. P17 says: first check the mutation *landed on the code you
meant to break*.

Instance (Google base-price cycle SC3, `a3e9b1b`): the fix moved
`submitUpdate` to send `buildBody()` whole instead of hand-picking fields. The
mutation-check was a `perl -0pi -e 's/body: JSON.stringify(buildBody()),/<hand-
rolled>/'` — but `submitCreate` contains the SAME line and appears FIRST, so the
non-global substitution rewrote the create path (already correct, untested here)
and never touched `submitUpdate`. The suite stayed green. **A green result there
is visually indistinguishable from a legitimate "the guard holds" pass** — the
only reason it was caught was expecting red and interrogating the green.
Re-applied to `submitUpdate` it failed with `expected undefined to be
'default_template'`, naming the dropped field exactly.

Rules:
1. After mutating, **verify the edit landed**: `grep -c MUTATION <file>`, or read
   back the diff, before running anything. Prefer an anchored, position-aware
   edit (split on the enclosing function) over a bare pattern that may match
   siblings — duplicated call sites are the norm in twin-path code (P1), so a
   bare pattern matching the wrong twin is the DEFAULT failure, not an edge case.
2. **Treat a green mutation as an incident.** Investigate it as either (a) the
   mutation missed, or (b) the test is fake (P16). Never record it as a pass.
3. State in the report which site was mutated and what the failure message said.

This is a discipline correction to the mutation-check practice itself, which by
this point had been used ~8 times across the project (P10, P16, and the Google
base-price cycle's four sub-chunks).

**P18 — A VERIFICATION RUN MUST PROVE IT RAN SOMETHING. "GREEN" AND "RAN
NOTHING" ARE THE SAME OUTPUT.**

The third face of P16/P17, and the one that attacks the *report* rather than the
test. P16: the test may be fake. P17: the mutation may have missed. P18: the
run itself may have executed zero tests, and nothing in the output says so.

Instance (Apple per-territory availability arc, SC5-SC7, closed `6f206f8`):
guard suites were verified by naming file paths, e.g.

```
npx vitest run lib/iap-management/action-types.test.ts lib/audit-constraints ...
```

`lib/iap-management/action-types.test.ts` **had already been deleted** — its
parity checks were folded into `lib/audit-constraints/guard.test.ts`, whose own
header says "supersedes lib/iap-management/action-types.test.ts
(single-module)". Vitest treats positional args as **filters, not assertions**:
a path matching nothing contributes zero files, emits **no warning**, and the
aggregate line still reads `Test Files N passed`. So "action-types parity ✓"
appeared in three consecutive chunk wrap-ups as a verified guard while
contributing exactly nothing. The substance was never at risk (the 35-test
audit-guard did cover it) — the *reporting mechanism* was, and it fails silently
and identically for a guard that was deleted, renamed, moved, or typo'd.

Rules:
1. When verifying guards by file path, **assert a non-zero test count per run**.
   A per-file loop that prints `path → N tests` and flags `N == 0` costs one
   line and makes a ghost entry impossible. A single batched invocation cannot
   distinguish "all six ran" from "five ran and one is a ghost".
2. **A path is not a guarantee that a guard exists.** Guards get folded into
   broader suites (this is good — see the audit-constraints consolidation);
   verify-lists do not follow automatically and rot silently.
3. Same rule as P17 step 3: name what ran and what it produced, not that it
   "passed". A count is a claim that can be wrong; "green" is not.

Deferred, not built (would have widened the closing commit): a cheap repo-level
guard asserting every path in a verify-list resolves to a real file. Candidate
shape — a test that reads the documented guard-suite list and `statSync`s each
entry, failing on a missing path, so the list cannot outlive its files.

**P18 near-miss (2026-08-26, `[POOL-key-management-UI]` U1) — "1 failed suite,
0 tests" reads as a passing run when a sibling file supplies the number.**

Three `vi.mock` factories referenced top-level `class` declarations. `vi.mock`
is hoisted above the file body and a class is NOT hoisted, so the factory threw
`Cannot access 'Forbidden' before initialization` and the ENTIRE behavioural
file failed to collect. Vitest reported:

```
 Test Files  1 failed | 1 passed (2)
      Tests  17 passed (17)
```

Every test that "passed" belonged to the OTHER file — which happened to contain
exactly 17 tests as well. The coincidence made the line look like a clean run of
the file just written. Caught only by reading `Test Files`, not `Tests`.

**Practice:** read the FILE count, not just the test count, and confirm the
count moved by the number of tests just added. The fix is to declare mock-used
classes inside `vi.hoisted(() => ({ … }))`.

**P19 — PARITY OF OUTPUT IS NOT PARITY OF COST. THE ASSERTION HAS TO SIT ON A
SPY THAT COUNTS REQUESTS, NOT ON THE RESULTS.**

Fourth face of the P16-P18 family, and the one that survives all three. The
test can be real (P16), the mutation can land (P17), the run can execute
(P18) — and the suite still cannot see the defect, because the defect does not
change any value it looks at.

Instance (export arc, `9ff0c05` pool extraction, mutation (a) — the commit
message is the primary record): the mutated pool failed only as *"expected 1
time but got 5 times"*, and that commit states the rule in its own words —
**"the result sets look identical either way; only the spy sees the budget
being spent, which is why the assertion is on the spy."** Every
results-shaped assertion passed. Nothing in the returned data distinguishes
"asked Apple once per item" from "asked five times and kept the last answer".

This is the same family as the double-wrap `withRetry` bug the arc opened with
(`915deff`): 4 attempts became 16 *with no change in outcome* on every path
that eventually succeeded. Both are invisible to output assertions by
construction, and both are the failure mode that actually hurts on a
rate-limited API.

Rules:
1. For any code whose *purpose* is cost — a pool, a retry wrapper, a cache, a
   lazy loader, a batch — **at least one assertion must count calls**:
   `expect(spy).toHaveBeenCalledTimes(n)`, not `expect(result).toEqual(...)`.
2. State the expected count as a **derivation**, not a magic number: "3 per
   item × 2 items = 6". A bare `6` silently absorbs a regression that changes
   both the code and the number.
3. The strongest form is an assertion of **absence** — see `IapListClient.
   export-wizard.test.tsx`, where the whole feature's primary acceptance is
   `expect(fetch).not.toHaveBeenCalled()` after opening a wizard. That test
   fails for a pre-read and for nothing else.
4. Scope such a spy **by time, not by URL allowlist**. Allowlisting "ignore the
   territories route" would have passed a version that fetched the territory
   catalogue on open — precisely the regression being guarded. Clear the spy at
   the moment of interest, then forbid *any* call.

**P20 — A CENSUS BEFORE CODE CAN INVERT THE FIX, NOT JUST SIZE IT. A DOCSTRING
THAT CONTRADICTS A SIBLING IS THE SIGNAL TO RUN ONE.**

P9 says design-first pays off where a feature looks like a proven pattern.
P20 is the sharper case: the census does not refine the plan, it **deletes**
it, and the plan was the obvious one.

Instance (export arc, `ac6acd7`): the `links.next` handling in
`nextPathFromLink` (`apple/price-schedules.ts:267`) has a `catch` branch that
was read as sloppiness, and the proposal was "make it throw, like its twin"
(`extractNextPagePath`, `apple/client.ts:106-125`). The census found the branch
is a **deliberate feature carrying a tested relative-URL fallback from Manager
UAT MV30** — now stated in `client.ts:107-111`. The twins differ because
they are solving different problems, and the correct output was a sourced note
in *both* docstrings explaining the asymmetry — not a code change. The proposal
died before a line was written.

Same shape, same arc, second instance (`f7e1bdb`): the design doc said
`runAvailabilityReadPhase` is client-only. Its only import is
`import type { AvailabilityForIap }`, erased at compile time, and every seam is
injected. The claim was false, the *conclusion* it supported was right, and the
real reason (pre-claim latch for a shared client queue vs. `runStoppablePool`'s
claim-then-await) was already written correctly in `stoppable-pool.ts:41-48` —
the doc had drifted from the code that documented itself properly.

Rules:
1. **Two sources that disagree about the same mechanism is a census trigger**,
   not a tie to break by preference. One of them is stale, and which one is
   stale is load-bearing.
2. When a `catch`, a fallback, or an "obviously wrong" branch has a test, the
   test is the specification until proven otherwise. `git log -S` the branch
   before proposing its removal.
3. A census may legitimately conclude **"the code is right, the prose is
   wrong"**. That outcome is a success, and the deliverable is a docs commit —
   see P20's own instances, both of which shipped as documentation.
4. Cite the twin's line range in the correction so the next reader lands on the
   authoritative version instead of re-deriving it.

**P21 — ONE HTTP STATUS, TWO MEANINGS: DISAMBIGUATE BY STAGE WITH A SUBCLASS,
NEVER BY A BARE STATUS CHECK — AND NEVER BY A REGEX OVER THE MESSAGE.**

Instance (export arc, `a4d52e2`): `getPriceScheduleForIap` is a two-stage read.
A **stage-1** 404 means "Apple has no price schedule for this IAP" — a real
answer, and the row exports clean with genuinely no prices. A **stage-2** 404
means the schedule existed a moment ago and the sub-resource read broke — a
real failure. The original check was `status === 404`, which is **stage-blind**:
it classified a broken stage-2 read as "no schedule", producing a row exported
clean with blank prices and no recorded reason. That is the G4b defect shape,
reached through a different door.

The fix is structural: `NoPriceScheduleError extends AppleApiError`, thrown
**only** by the stage that can legitimately mean it, because
`getPriceScheduleForIap` is the only code that knows which stage threw. Callers
then test `err instanceof NoPriceScheduleError` — a claim about meaning — rather
than `err.status === 404` — a claim about transport.

Rules:
1. When a status code can arrive from more than one stage of a composite read,
   **only the composite knows which**. Classify there and export a subclass;
   never make callers guess from the status.
2. **Kill `/404/.test(message)` and its relatives on sight.** Parsing a status
   back out of prose is not a type; it breaks on the first wording change and
   it cannot distinguish stages even in principle. Same rule as
   `classifyAppleError`, which classifies at the `catch` where `instanceof`
   still works and never re-derives `kind` from the string.
3. A subclass is cheap and greppable. `AppleApiError` was **not** modified —
   the subclass lives next to the function that can construct it correctly.
4. Corollary for the sibling paths: once the subclass exists, every other
   caller that special-cases the bare status becomes a candidate. Audit, do not
   assume — see `[UPDATE-stage1-404-redundant-price-push]`, deliberately left
   alone because "no schedule" and "no custom prices" may not be the same claim
   on that path.

**P22 — A TARGETED-DROP MUTATION IS SHARPER THAN A DROP-EVERYTHING MUTATION.
THE SUITE MUST CATCH A SANITISER THAT SILENTLY REMOVES *ONE* INPUT.**

Refines P16/P17 on mutation *selection*. A mutation that empties the input set
proves very little: almost any assertion goes red when nothing is processed. The
question a silent-drop defect actually poses is whether the suite notices **one**
item disappearing between the request and the result.

Instance (export arc, pre-gate V4 on `70b1434`). Two distinct temptations, both
of which must be red, and only the second is diagnostic:

- **enumerate-then-intersect** — cross-check ids against Apple's list and keep
  the intersection. → 7 FAIL. Wide, but it also removes the enumeration
  assertions, so much of the redness is incidental.
- **targeted sanitiser** — `.filter(id => !id.startsWith("ghost"))`, i.e. drop
  the one id the route "doesn't recognise", locally, before attempting. → 2
  FAIL, and they fail on exactly the right assertions:
  `expected [ 's1', 's2' ] to include 'ghost'` (never *attempted*) and
  `expected 3 to be 5` (two ids vanished between request and file).

The second is the one that proves the guarantee, because it leaves the happy
path entirely intact and still goes red.

Rules:
1. For any "nothing is silently dropped" claim, mutate to drop **exactly one**
   element, not the whole set. If only the drop-everything mutation is red, the
   suite is asserting "it did something", not "it did all of it".
2. Pair every completeness claim with an **accounting assertion** —
   `exported + failed + notAttempted === requested`. It is one line and it is
   what caught the second failure above.
3. Distinguish the temptations and run each: *validate-then-drop* (local, no
   I/O) and *fetch-then-intersect* (remote) are different code, different
   review blind spots, and a suite can easily catch one and not the other.

**P23 — AN ERROR SUBCLASS WITH A NON-OBVIOUS CONSTRUCTOR IS A TEST FIXTURE
TRAP: BUILD IT FRESH PER CALL, AND CHECK THE SIGNATURE.**

Extends the vitest mock-reject note (`IAP.o.10a`, "reusing one Error instance
across retry attempts triggers spurious FAILs") with the failure mode one step
earlier: the fixture error is **mis-constructed**, and the damage surfaces far
from the cause.

Instance (export arc, `70b1434` tests): `NoPriceScheduleError`'s constructor is
`(appleIapId: string, cause: AppleApiError)`, not `AppleApiError`'s
`(status, method, endpoint, body)`. Built with four strings, `cause.body` was
`undefined`, so `errMsg()` threw a `TypeError` **inside the catch handler** —
which the pool then classified as `UNKNOWN` and failed *every row*. The symptom
was `X-Export-Item-Count: 0` across eight unrelated tests, pointing at the
route's item-set logic; the cause was one fixture line.

Rules:
1. **Read the subclass constructor before building one in a fixture.** A
   subclass that narrows or reorders its parent's parameters is normal, and TS
   will not always catch it through a `vi.fn()` boundary.
2. Build the error **inside `mockImplementation`**, fresh per call, rather than
   handing one instance to `mockRejectedValue` — the `IAP.o.10a` rule, extended
   from retry paths to all paths, because it costs nothing and removes a whole
   class of cross-test coupling.
3. **A failure inside a `catch` handler is the diagnostic to reach for** when
   many unrelated tests fail with the same suspiciously-total number (0 rows,
   all failed). The catch converts a fixture bug into a plausible-looking
   domain outcome, which is why it reads as a logic bug in the code under test.

**P24 and P25 live in §15** (Apple ASC key pool), because both were earned
there and both read better next to the code that produced them:
- **P24** — a poor test environment is a single-point-of-failure detector. A
  missing env var is the cheapest simulation of a new dependency being down.
  Run the suite BEFORE mocking anything.
- **P25** — a stub incomplete in the direction the code is defensive about is
  worse than no stub: a missing method fails loudly, but a missing method plus
  a broad guard produces a green test that proves nothing. Sibling of P23.

**P26–P29 live in §16** (C3 PARTIAL row-level). All four crossed the
frequency bar during the C1→C2→PRICING-429→C3 latch arc:
- **P26** — a mutation that catches NOTHING means the tests prove the
  PATTERN and not the WIRING. Add a structural guard; never lower the
  mutation. 4 instances.
- **P27** — a hand-written fixture is a CLAIM about the route, not evidence
  of it. 2 instances, both where the fixture was right and the route was
  wrong.
- **P28** — P15 pushed down a layer: the SLICER underneath an assertion must
  strip comments and strings too, or the guard fails OPEN.
- **P29** — the `fetch` boundary is where `tsc` is blind. Derive client types
  from the server's; do not trust the compiler to notice drift. 4 instances.

---

#### 10.13.K — Google single-item base-price cycle (2026-08-13, `f6b9b22` → `c0a9715`)

Symptom: on the Google IAP Edit form, changing the base price (or picking a
tier) reported success while Google's state never moved. Three distinct
defects, all worth keeping.

**(a) THE SHARPEST STATUS-PRINCIPLE INSTANCE YET (P5).** `updateIapOnGoogle`
returned `hasChanges: true` unconditionally — it reported the diff it COMPUTED,
never what Google DID. With `logging.ts` recording no body and no size, a write
that changed nothing was **indistinguishable from a real one at every layer**:
success toast, API response, audit row, Railway log. That is why it survived
from `44900f8` (2026-05-21) to a Manager spot-check ~3 months later. The fix
compares against the post-write re-read the client already fetched
(`orchestration/verify-write.ts`) and reports `hasChanges:false` + a `NO-OP
WRITE` log line when nothing moved. **If a tool cannot distinguish its own
no-op from its own success, no amount of testing downstream will surface the
bug.**

**(b) A MIGRATION SILENTLY DROPPED A CAPABILITY THE OLD API HAD.** Legacy
`inappproducts.patch` honoured `defaultPrice` as a first-class field. The v3
`OneTimeProduct` schema has **no base-price field at all** — pricing lives only
in `purchaseOptions[].regionalPricingAndAvailabilityConfigs`. The Hotfix-8
Phase-2 write migration (`44900f8`) ported the call but not that capability, and
nothing failed loudly because the adapter stamps `defaultPrice` onto the US
region *only when `prices` has no US entry* — and the Edit form preloads every
cached region, so US was always present and the base price had no carrier.
⇒ **When migrating an API, enumerate the fields the OLD one honoured and prove
each still lands. A 200 response is not proof.** Guarded now by
`defaultPriceShadowed` on the adapter write shape, logged at BOTH write call
sites (patch and insert), because the shape is a property of the schema, not of
one code path (P1).

**(c) THE WRITE-BACKWARDS DIFF — an inverted merge in a second coat.**
`initial` is a live prop, but the form seeds `useState` from it exactly once and
the page renders `<IapForm>` with no `key`. `router.refresh()` — which "Sync
from Google" fires deliberately — reconciles a NEW `initial` into the SURVIVING
instance. The diff then compared **fresh server truth (before) against stale
client state (after)**, so the review modal proposed writing the PRE-sync prices
back over Google's current ones: confirming it would have reverted real prices.
The comment at `UnifiedPricingTable.tsx:129-131` states the intended re-seed
("so the edit form reloads regionOverrides from the freshly-synced DB") — an
intent `useState(initial)` can never honour. ⇒ **A comment asserting a behaviour
React does not implement is a bug with a green light on it. When state is seeded
from a prop, either key the component or write the re-seed.**

**(d) DATA FROM THE STORE IS NEVER TRANSFORMED — hard constraint, not advice.**
A cache scan (286,443 price rows / 1,664 items) found exactly ONE row whose
value the tool's own currency table rejects: `com.vng.passsdk.2508111020`,
TW = **TWD 6.30**. Every other 0-decimal currency (VND, JPY, KRW, IDR, CLP, HUF)
had **zero** fractional rows. So it is not float noise from `convertRegionPrices`
— it is a REAL price on Google. The originally-prescribed fix (round on seed)
would have silently rewritten a live price by −4.8% on the next submit.
⇒ **Never round, truncate, normalise or "clean up" a value that came from the
store. Display every decimal; send an untouched row back byte-for-byte.** The
authorship rule follows from it: only a value the MANAGER typed may block a
submit; a value the store authored warns (client `partitionOverrideValidation`
AND server `snapshotFromInput` — a guard duplicated in two layers, P14).

**The tier/base model (Manager-locked).** The base price is the SINGLE SOURCE
for every country price; picking a tier is just a fast way to set the base
(from the tier's **USD** figure — Google templates use a fixed `Price (USD)`
header, so that is the canonical number). Both are RECALCULATE-EVERYTHING
commands, they overwrite each other, and the loop is unbounded. The reset is
TOTAL — hand-typed rows included — so the form **warns before** recalculating
when any hand-typed row would be lost, naming the count, with a cancel. The
boundary that keeps `dirty` coherent:

> **tier / base = the Manager COMMANDING a recalculation → ignore `dirty`.
> sync / validate = everything else → respect `dirty`.**

**Legacy-fallback currency coupling (closed same cycle).** Legacy
`inappproducts.*` requires `defaultPrice.currency` to equal the app's
configured currency. That held BY ACCIDENT until a tier was allowed to set the
base to USD on a non-USD app — the base had always been seeded from cache, i.e.
the app's currency. The fallback now takes the app-currency AMOUNT out of the
body's own `prices` map rather than relabelling the USD one (relabelling
`{USD,4990000}` as VND sends ₫4.99 for a $4.99 product), and passes the body
through untouched when no such entry exists, so Google returns its own clear
error instead of a number we invented. ⇒ **A constraint that is satisfied
incidentally is not satisfied. When a value stops being fixed, every consumer
that quietly relied on it being fixed becomes a bug — and a fallback path
deserves the fix precisely because it only runs when something else has already
failed, i.e. while someone is diagnosing.**

**OPEN BACKLOG (recorded, not fixed): `COMMON_CURRENCIES` is a curated ~30.**
`regions.ts:52-54` derives the base-currency `<select>` options from
`COMMON_REGIONS`. If the base ever lands on a currency outside that list, the
select renders with no matching option while state holds the real value — the
UI and the state disagree silently. `pickBaseFromDerived`'s USD-first order
makes this nearly unreachable (USD is in the list; the app's own currency
normally is too), so it is recorded rather than fixed. It becomes real if a
tier carries neither USD nor the app's currency and the first entry is exotic.

---

#### 10.13.K — OPEN BACKLOG: Google bulk-import OVERWRITE replaces listings (P4 replace-semantics RMW violation)

**Status: NOT FIXED — investigation required before touching it (live
store import path). Recorded 2026-08-05 during the locale-picker work;
the shipped mitigation is a Preview-time WARNING + Notes-sheet caution,
not a fix.**

**The defect.** Google's bulk-import OVERWRITE path sends whatever
listings the row carries, replacing the product's listings wholesale. A
row with no Title/Description columns falls back to a synthesized single
listing — `listings["en-US"] = { title: row.sku, description: "" }`
(`lib/google-iap-management/orchestration/bulk-import.ts:179-180`) — so
overwriting an existing product from such a row silently destroys its
real store metadata (a product titled in Vietnamese ends up titled with
its raw SKU). No error, no per-row failure: the import reports success.

**Why it is a P4 (store-write read-modify-write) violation.** The
overwrite path DOES do an RMW GET — but only for purchase options:
`batchUpsertInAppProducts` fetches the live product to include ALL
existing purchase options in the PATCH body
(`google/publisher-client.ts:864-872`), because Google rejects a partial
option set ("must list all existing purchase options. Missing: …").
Listings are the OTHER replace-semantics field on the same resource and
were never given the same treatment. Google doesn't reject a partial
listing set — it just accepts the destruction silently, which is exactly
why this went unnoticed while the purchase-option case was found
immediately.

**Twin-path framing (P1/P8).** Commit `4fbcdd5` fixed one
replace-semantics field (purchase options) on this resource and did not
sweep the sibling field. The grep that would have caught it: every field
on `InAppProduct` whose PATCH semantics are REPLACE, not merge —
`listings`, `prices`, `purchaseOptions` — checked against whether the
overwrite body reconstructs the full set. (`prices` IS bootstrapped
comprehensively via `regions-helper`, so listings is the lone gap.)

**Why the picker raised its priority.** Pre-picker, producing a
no-locale file required deleting 82 column pairs by hand. The locale
picker's default output (nothing pre-ticked, zero locales allowed) is a
core-only file — one click away — so the destructive combination went
from "implausible" to "the default path plus an Overwrite decision".

**Shipped mitigation (August 2026, NOT the fix).** A prominent amber
Preview banner naming the affected SKUs whenever rows set to Overwrite
carry no locale data (client-side, derived from live per-row decisions;
uses only data the preview already has — the preview's existence read
`listIapsForApp` carries no listing data, so the warning states what WILL
happen rather than enumerating current titles). Plus a Notes-sheet
caution in core-only templates. Deliberately Google-only: Apple's
`planLocalizationSync` suppresses deletions when the desired set is empty
(`localization-sync.ts:47-49`), so the risk genuinely doesn't exist there
— an Apple test pins that asymmetry so a future "unify for symmetry"
change must justify itself.

**When fixing (scope sketch).** Extend the overwrite RMW to merge
listings: GET the live product, then union/merge row listings over
existing ones instead of replacing (decide explicitly whether a row
listing for locale X overwrites just X or the whole map, and what a
row-with-no-listings should mean — probably "leave listings untouched",
matching Apple). Blast radius: the live-store write path for every
overwrite row; needs its own investigation pass, round-trip tests
against the real adapter shapes, and a decision on the
`onetime-product-adapter` mapping (`listings[i].languageCode`). Do not
bundle it with UI work.

---

#### 10.13.L Apple — bulk-import submit-after-create twin-path fix (IAP.q.2, commit `dc53b63`, 2026-07-15)

**Symptom:** Bulk Import's "Submit to Apple review after create" option
called `submitInAppPurchase` immediately after create, gated only by a
purely local condition (screenshot uploaded + no failed locales) with
zero visibility into Apple's actual IAP state. Apple's screenshot-confirm
PATCH returning 200 doesn't mean the `appStoreReviewScreenshot`
relationship has propagated on Apple's side yet, so the immediate submit
409'd (`ENTITY_ERROR.RELATIONSHIP.REQUIRED` / `IAP_SUBMISSION_NOT_ALLOWED`)
and the whole row collapsed to a bare red `ERROR` — hiding the fact that
the IAP itself had actually been created successfully (`apple_iap_id`
existed, just buried under the error label).

**Twin-path root cause:** the regular `submit-batch` endpoint already had
a Cycle 32 / IAP.q.1 state-guard (`partitionByStateGuard`, §4.5) that
bulk-import's create→submit path bypassed entirely — the exact "hardened
path A, forgot to check path B" shape §10.13.K **P1** names.

**Fix — converge on the existing guard rather than reinventing it:**
1. `pollIapReadyForSubmit` (new) polls until Apple reports
   `READY_TO_SUBMIT`, sharing a loop extracted from the existing
   `pollIapReadyForPricing`.
2. `lib/iap-management/apple/submit-eligibility.ts` (new) exports
   `checkSubmitEligibility`, composing that poll with the **same**
   `partitionByStateGuard` submit-batch already uses.
3. Bulk-import's create step calls `checkSubmitEligibility` before
   submitting. A not-yet-ready row gets `submit_outcome: "deferred"` (row
   stays `SUCCESS`/create-succeeded, `apple_iap_id` preserved); a
   guard-passed-but-still-rejected row gets `submit_outcome: "failed"`
   (also stays `SUCCESS`, not `ERROR`) — the create half is never rolled
   back based on the submit attempt's outcome.
4. `BulkImportWizard.tsx`'s `OutcomeBadge` renders "Created — submit
   deferred" (amber) / "Created — submit failed" (orange) instead of
   collapsing to a red `ERROR`; the Notes column surfaces the reason +
   `apple_iap_id` so the Manager can retry via `Submit Selected`.

No DB migration — `submit_outcome` / `submit_deferred_state` /
`submit_error` ride the existing `BULK_IMPORT_CREATE` actions_log JSON
payload. Tests: +22.

**Files:** `lib/iap-management/apple/poll-iap-ready.ts`,
`lib/iap-management/apple/submit-eligibility.ts` (NEW),
`app/(dashboard)/iap-management/apps/[appId]/bulk-import/execute/route.ts`,
`BulkImportWizard.tsx`.

---

### 10.14 Cycle 44 — IAP Export (Google + Apple) (2026-07)

**Session scope:** Two paired "investigation-first" tasks — export an app's
IAP catalog to xlsx, one per platform, delivered as two separate commits
(`e42a937` Google, `fbea49a` Apple). Same "Export list" affordance and file
layout across both modules; each platform's fetch strategy follows from its
own price-read shape rather than a shared implementation.

---

#### 10.14.A Shared design

- **Trigger:** "Export list" button on each module's IAP list page (next to
  Refresh / Bulk Import) → GET route → browser downloads an `.xlsx`.
- **Read-only:** no DB write, no sync side-effect, no audit-log entry. Both
  modules chose migration-free — per **P2** above, an `action_type` not in
  the `actions_log` CHECK constraint fails silently, so skipping the audit
  avoided a migration for a feature that never mutates state.
- **Layout** — one row per item, a two-row merged header:
  - Fixed left columns: Product ID / Product Name (Google) or SKU Name
    (Apple) / Status / Base Country (Apple only).
  - **Fixed territory price groups**: one (Price, Currency) pair per
    territory that has a price on ANY exported item — the sorted
    (alphabetical by code) **union** across the whole set, not a per-item
    list. A territory missing on a given item renders blank there.
  - **Positional localization groups**: "Localization N" merged header,
    filled left-to-right per item (Localization 1 = the item's 1st locale,
    etc.). Group count = the MAX locale count across all items; unused
    groups on a given row are blank.
  - Column determination = two passes over the fetched set (build the
    territory union + the max-locale-count) before the sheet is built.
- **Scope:** ALL items of the app — the full live set, not the current
  filtered/paginated list view.
- **Plain/unstyled:** both modules use `xlsx@0.18.5` (SheetJS Community
  Edition), which writes merged cells + column widths but NOT cell styling
  (fills/fonts/borders). Both approved sample layouts have a styled navy
  header; both times the styling-dependency question (`xlsx-js-style` /
  `exceljs`) was raised explicitly and green-lit to **ship plain-for-now**
  rather than add a new dependency.

---

#### 10.14.B Google — live full-catalog fetch (commit `e42a937`)

Google's `monetization.onetimeproducts.list` — the same paginated call
`listInAppProducts` (and therefore Refresh) already uses — returns COMPLETE
`OneTimeProduct` resources in one pass: every listing (title + description,
all locales) and every regional price, no truncation. This is the opposite
of Apple's V2 `?include` shape (§4.1): Google's list endpoint uses the
identical schema as its per-item `get`, so there is no "list returns less
than get" trap to work around here.

**Consequence:** the export reuses the Refresh fetch as-is — a handful of
paginated calls for the whole app, no per-item GET, bounded and fast.

| Column | Source |
|---|---|
| Product ID | `sku` |
| Product Name | Default title — same `en-US`-preferred / first-listing-fallback resolution as the list's `default_title` (mirrors `listIapsWithDefaultLocale` in `repository/iaps.ts`) |
| Status | `active` / `inactive` (already 2-state on Google — no raw-enum concern) |
| Localization sub-columns (2) | Locale Code, Description — locales with an EMPTY description are omitted entirely (not counted toward the group-count max) |

Deleted-on-Google items (§10.13.F soft-delete flagging) are excluded
automatically — the export reads live from Google, so a flagged/absent item
simply isn't in the response. No separate filter needed.

**Files:** `lib/google-iap-management/xlsx-export.ts` (pure
`buildExportPlan` / `buildExportWorkbook` / `xlsxExportFilename`),
`app/api/google-iap-management/apps/[packageName]/export/route.ts` (GET),
`IapListClient.tsx` button + loading/error/summary banners.

**Design reference:**
`docs/google-iap-management/design/IAP-export-SAMPLE-layout-v2.xlsx`
(approved sample, committed for structural comparison).

---

#### 10.14.C Apple — live per-IAP fetch, View Detail reuse (commit `fbea49a`) ← LANDMARK inheritance

Apple has no equivalent of Google's `iap_prices` cache and no single
endpoint that returns every IAP's pricing in one call — `iap_mgmt` has no
prices table at all (confirmed against the init migration: `apps`, `iaps`,
`iap_localizations`, `iap_screenshots`, `price_tiers`,
`price_tier_territories` — no `iap_prices`). Every row therefore needs a
live per-IAP fetch.

**Why reuse instead of reimplement:** View Detail (§4 / IAP.p2, see the
[apple-api-reference.md](apple-api-reference.md) "IAP View Detail" section)
already solved the hard part of this read — the **§4.1 LANDMARK** V2
`?include=manualPrices` truncation (caps at 10 IDs even when the schedule
has more). `getPriceScheduleForIap`
(`lib/iap-management/apple/price-schedules.ts`) works around it by treating
Stage 1's V2 relationship enumeration as advisory-only and walking Stage
2's V1 `/inAppPurchasePriceSchedules/{id}/manualPrices` sub-resource for
the authoritative full set. The export composes this function **UNCHANGED**
— new export code never touches `price-schedules.ts`, so the truncation fix
is inherited for free rather than re-derived (or worse, silently re-broken
by a naive re-implementation that goes back to trusting the V2 relationship
count).

Export orchestration (`lib/iap-management/apple/export-fetch.ts`, NEW)
composes the same primitives View Detail's `getIapViewData` does —
`getIapDetailFromApple` (IAP attributes + localizations) and
`getPriceScheduleForIap` + `unpackPriceSchedule` — but skips the
availability fetch and territory-count denominator (`getAvailabilityForIap`
/ `getAllTerritoryIds`) that `getIapViewData` also does, since export
doesn't need them. This trims the per-IAP cost from View Detail's 4
parallel calls down to ~2-3.

**Two-tier resilience** (mirrors View Detail's own per-stage error
boundary — see apple-api-reference.md "Per-stage error boundaries"):

| Failure | Effect |
|---|---|
| `getIapDetailFromApple` throws (critical path — no product id / SKU name / localizations to fall back on) | Row **skipped**. Counted in a warning total surfaced via the `X-Export-Failed-Count` response header; the export still completes for every other row. |
| `getPriceScheduleForIap` throws (404 "no schedule yet", or any other error) | Row **kept** with `priceSchedule: null` → blank pricing + blank Base Country for that row. Metadata + localizations still export. |

This is a deliberate asymmetry, not a shortcut: View Detail already treats
the IAP fetch as critical and the price-schedule fetch as best-effort (its
own docstring says so — see `getIapViewData` in
`lib/iap-management/queries/iap-detail.ts`), so the export inherits the
same philosophy rather than inventing a flatter "any failure = skip" rule.

**Cost + concurrency:** ~2-3 Apple calls per IAP (IAP+localizations,
schedule Stage 1, schedule Stage 2 — usually one page since Apple has
~175 territories against a 200-per-page limit). Bounded concurrency of 8
via the existing `lib/iap-management/concurrency.ts` `withConcurrency`
helper (the same generic utility Google's `batchUpsertInAppProducts` also
imports). Apple's 429/500 retry (`withRetry`, `AppleRateLimitError`) is
reused unchanged on the list call and inside `getPriceScheduleForIap`'s own
pagination. Rough wall-time: well under a minute for apps with a few
hundred IAPs; multi-minute for apps with 1000+. The client sets a 10-minute
`AbortController` ceiling + a "generating…" `sonner` toast (the Apple list
page already uses toast, not inline banners, for Refresh feedback — the
export follows that existing pattern rather than Google's inline-banner
style).

| Column | Source |
|---|---|
| Product ID | `productId` |
| SKU Name | Apple's `name` attribute — the internal REFERENCE NAME, distinct from the localized display name shown in each Localization group |
| Status | Raw `inAppPurchaseState` string (APPROVED / MISSING_METADATA / REMOVED_FROM_SALE / …) — no 2-state collapse, unlike Google |
| Base Country | `PriceScheduleView.baseTerritory`, converted alpha-3 → alpha-2 (`i18n-iso-countries`'s `alpha3ToAlpha2` — the same package `territory-name.ts` already depends on, no new dependency) |
| Territory columns | Apple auto-equalizes across ~175 territories, so a fully-priced catalog produces a very wide sheet — this is expected, not a bug |
| Localization sub-columns (3) | Locale, Display Name, Description |

Only effective-now price entries (`startDate === null`) populate the price
columns — a future-dated upcoming-change entry (the same concept
`UpcomingChangesTable` surfaces separately in View Detail) is excluded from
this point-in-time snapshot.

**Files:** `lib/iap-management/xlsx-export.ts` (pure plan/workbook
builder), `lib/iap-management/apple/export-fetch.ts` (NEW —
bounded-concurrency orchestration with dependency-injected fetch
primitives for testability), `app/api/iap-management/apps/[appId]/export/route.ts`
(GET), `IapListClient.tsx` button.

**Design reference:**
`docs/iap-management/design/Apple-IAP-export-SAMPLE-layout.xlsx` (approved
sample).

---

#### 10.14.D Cross-reference — "reuse the platform's own price read, don't reinvent it"

Both exports follow the same meta-rule from opposite directions:

- **Google** reuses **Refresh's list fetch** because Google's list endpoint
  already returns complete data — reusing it is a matter of not
  re-fetching what's already cheap and complete.
- **Apple** reuses **View Detail's fetch** because Apple's list endpoint
  returns none of the pricing detail — reusing View Detail's already-
  hardened 2-stage read avoids re-deriving (and risking re-breaking) the
  §4.1 truncation fix.

Neither module invented new Apple/Google API calls for this feature. This
is a concrete instance of the "cross-module pattern reuse with
architectural awareness" principle first named at Cycle 41 (§10.10) — same
abstract shape (export = fetch full catalog → shape into a two-row-merged-
header xlsx), each platform's implementation respects its own API's
affordances rather than cloning the sibling module's fetch strategy.

---

#### 10.14.E Territory filter — `ExportOptionsDialog` (shared Apple + Google, commit `a4208ed`, mockup `6465178`)

**One day after** both exports shipped (§10.14.A-C), a shared pre-export
filter dialog was added so the Manager can restrict which countries'
price columns actually export, instead of always getting the full
territory union.

**`ExportOptionsDialog`** (`components/iap-management/ExportOptionsDialog.tsx`)
— props `{ open, onCancel, onExport(selectedCodes: string[] | null) }` —
is imported **verbatim by both** IAP list pages (Apple's
`app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx` and
Google's `components/google-iap-management/iap-list/IapListClient.tsx`),
confirmed by grep — one component, no per-platform duplication. It reads
from a new static catalog, `lib/iap-management/territory-catalog.ts`
(~180 territories, 6 regions, country→currency), built because no
existing catalog covered the full store-territory set (reuses the
existing `i18n-iso-countries` dependency, no new one added). UX: search by
country name / ISO code / currency, multi-select checkboxes grouped by
region, Select All / Clear All, live "N of M selected" count.

**Selection contract (deliberate):** default state is all-selected, and
while nothing has been explicitly deselected, `onExport` receives `null`
— meaning "no filter, export everything the live fetch found," identical
to pre-feature behavior. Only once the operator explicitly deselects at
least one territory does `onExport` receive the literal array of
remaining codes, which the backend intersects against the real per-item
territory union (`buildExportPlan` in both `xlsx-export.ts` files gained
an optional `selectedTerritories` param). Both export routes switched
GET→POST specifically so the selection travels in the JSON body — the
same `.in()`/URL-length class of trap named in **§10.13.E**, avoided here
by not putting a variable-length list in a query string at all.

Not shared with CPP — Apple-IAP + Google-IAP only. Design mockup (`6465178`,
same day, 28 minutes earlier) at
`docs/google-iap-management/design/export-options-dialog-mockup.html`.

**Files:** `components/iap-management/ExportOptionsDialog.tsx` +
`.test.tsx` (NEW), `lib/iap-management/territory-catalog.ts` + `.test.ts`
(NEW), both `IapListClient.tsx` files, both export `route.ts` files, both
`xlsx-export.ts` files.

---

### 10.15 Cycle 45 — VNGGames Hub run tracking (Apple import, Google import, Apple submit) (2026-07)

> **Extended (2026-07-18/21):** the mechanism documented in this section
> grew to 5 integrations — CPP Bulk Import (4th, `docs/cpp-management/
> design-cpp-hub-tracking.md`) and Google Bulk Activate/Deactivate (5th,
> `docs/google-iap-management/design-bulk-status-hub-tracking.md`). This
> stays the ONE cross-module home for the Hub-tracking concept —
> per-integration DESIGN detail lives in the four linked design docs
> below; this section summarizes and cross-references, it doesn't
> restate them. See the 5-integration summary table further down.

> **Extended again (2026-07-21):** grew to 7 integrations — Apple "Set
> Availabilities" (6th) + "Remove from Sales" (7th), both over the
> shared bulk-availability flow (design
> [design-iap-availability-hub-tracking.md](design-iap-availability-hub-tracking.md)).
> See the 6th+7th subsection and the 7-integration summary table below.

**Session scope:** Three integrations of the same external tracking
mechanism, shipped as the module gained enough real usage to warrant
operational visibility on the [VNGGames Hub](../integrate-rest-vnggames-hub.md)
dashboard: Apple Bulk Import (first), Google Bulk Import (ported), Apple
IAP Submit (third — reuses Apple's own config, see below). Each is a
plain REST "runs ledger": `POST /runs/start` opens a run (returns
`RUN_ID`), `PATCH /runs/:id` closes it with a terminal status
(`SUCCESS` / `FAILED` / `CANCELLED` / `PARTIAL`) — 1:1 with one tool
workflow attempt.

**Shared mechanism (all three integrations):**
- Config: `iap_mgmt.hub_tracking_config` (Apple) /
  `google_iap_mgmt.hub_tracking_config` (Google) — separate tables per
  platform, own `workflow_id` + AES-256-GCM-encrypted token
  (`lib/asc-crypto.ts`) + Settings `enabled` toggle. **No in-memory
  cache** — every read hits the DB (§10.13.K **P6**; a 5-min cache
  caused the toggle-appears-to-revert bug, `9ed7845`).
- HTTP layer: `hub-client.ts` — hard `3000ms` **real** `AbortController`
  abort (not a `Promise.race` that lets the request keep running) on
  every call; never throws — a discriminated result type lets callers
  log-and-swallow.
- Non-blocking by construction: disabled/unconfigured/any Hub failure →
  full no-op, the actual tool workflow proceeds identically either way.
- `[hub-tracking]`-prefixed Railway logging, ATTEMPT-before / OUTCOME-
  after + duration, **token never logged** — every decrypt/read error
  handler explicitly says so in its own log line.
- Per-integration feature tag so Railway greps stay separable even where
  a Hub workflow is shared: `iap-hub-tracking` (Apple import),
  `google-iap-hub-tracking` (Google import), `iap-submit-hub-tracking`
  (Apple submit).
- Client-side cancel guard: a `useRef` set the instant the real mutating
  call is invoked and **never reset**, checked by every
  cancel/cleanup site instead of transient `loading`/`step` state. This
  is the fix for a bug ("successful run recorded as CANCELLED") that hit
  Apple import first (`4ba8e6f`) and Google import again through a
  different mechanism (`ce169a8` — see §10.13.K **P7**).

**Per-integration specifics:**

| | Apple Bulk Import | Google Bulk Import | Apple Submit (v2 path) |
|---|---|---|---|
| Commits | `95d9413` (feature), `613a9c3` (status-formula fix), `4ba8e6f` (CANCELLED bug fix — `executeStartedRef`), `9ed7845` (cache removal + logging) | `1663a37` (ported already-fixed), `b5265c2` (landing nav-card gap, §10.13.K **P8**), `ce169a8` (slow-start race recurrence, §10.13.K **P7**) | `867386a` |
| Config | Own `iap_mgmt.hub_tracking_config` | Own `google_iap_mgmt.hub_tracking_config` | **Reuses Apple's own** `iap_mgmt.hub_tracking_config` — no new table. Accepted tradeoff: submit runs and import runs share one Hub workflow stream, distinguished only by the `iap-submit-hub-tracking` log tag, not on the Hub dashboard itself. |
| Start point | Wizard step 1→2 ("Next") transition | Upload→preview transition | The FIRST `execute:true` POST (the only commit gesture in submit-batch — no run exists while merely viewing the preflight bucket preview) |
| Request shape | One HTTP request per execute (multipart FormData; `hub_run_id` threaded as its own form field, read before the `config` JSON parse so it survives a malformed-config 400) | Same shape as Apple | **Multi-request** — the reviewSubmissions v2 path can return `{phase:"conflict"}` or `{phase:"partial-fail"}`, pausing for a client round-trip before the run's outcome is known. `hub_run_id` threads through as a JSON body field across up to 3 hops instead of Apple import's single multipart field (§10.13.K **P8** twin-structure asymmetry — same concept, different transport, because JSON ≠ multipart) |
| Finalize | One request-scoped `try/finally` around the whole execute route, `HubTrackingState{runId,status,errorMessage}` threaded by reference, default `FAILED` overwritten right before a legitimate exit | Same shape as Apple | **NOT one try/finally** — 4 distinct finalize sites (legacy-path single-request; v2-no-conflict single-request; v2-conflict-detected does NOT finalize; v2-partial-fail does NOT finalize) — whichever request actually reaches a terminal outcome closes the run exactly once. The load-bearing structural finding of §10.13.K **P9** (design-first paid off here specifically because this looked like a copy of Apple import's tracking but isn't request-shaped the same way) |
| Cancel guard | Permanent `executeStartedRef`, single boundary (start → execute) | Same, plus a bounded 1s `Promise.race` on the late-start response + an explicit ref reset on "run another" (component isn't unmounted between runs, unlike Apple's wizard) | **Three-state** `executeCommittedRef` — state 1 (not started, no run) / state 2 (conflict dialog showing, zero Apple writes yet — cancel allowed, incl. a NEW `beforeunload`+`sendBeacon` handler this component didn't have before) / state 3 (partial-fail dialog showing, writes already happened — client cancel suppressed; resolution is the `proceedPartial`/`rollback` request itself) |
| Status computation | `computeBulkImportTerminalStatus({total,succeeded,failed})` — generic despite the name, `failed===0`→SUCCESS (all-skipped included) | Same function reused | Same function reused, but fed from **review-reaching** outcome, not raw per-item `status` labels — the "all adds succeed, confirm PATCH fails" case is FAIL even though every item still says `status:"SUCCESS"` (§10.13.K **P5**, the status principle); partial-fail rollback is always FAIL, never CANCEL, because real Apple writes (item-adds) already happened by that point |
| Known accepted limitation | — | — | Abandoning the tab while the partial-fail dialog is showing (state 3) leaves the Hub run `RUNNING` with no closer — accepted as a rare, low-volume edge case rather than building a server-side stale-run sweep |

**References:** [design-iap-submit-hub-tracking.md](design-iap-submit-hub-tracking.md)
(full submit-tracking design incl. the three-state guard rationale),
[integrate-rest-vnggames-hub.md](../integrate-rest-vnggames-hub.md) (the
Hub's own REST contract), [design-cpp-hub-tracking.md](../cpp-management/design-cpp-hub-tracking.md)
(4th integration, full detail), [design-bulk-status-hub-tracking.md](../google-iap-management/design-bulk-status-hub-tracking.md)
(5th integration, full detail).

#### 4th integration — CPP Bulk Import (shipped: design `8955d4b`, impl `ccf45b2`, R1 mutation-check backstop `7408176`)

First **client-orchestrated** finalize (§10.13.K **P11**) — CPP's Bulk
Import runs a 2-worker `Promise.all` pool per-CPP inside
`CppBulkImportDialog.tsx`, so there is no single server route to host a
`try/finally` around the whole batch the way Bulk Import/bulk-status do.
Full detail in [design-cpp-hub-tracking.md](../cpp-management/design-cpp-hub-tracking.md);
summary:
- **Config:** own `public.cpp_hub_tracking_config` (CPP's schema is
  `public`, not a dedicated `cpp_mgmt` schema — matches CPP's existing
  schema convention) + a dedicated Settings page
  (`app/(dashboard)/settings/hub-tracking/`), separate from Apple/Google's
  settings pages. `lib/cpp-hub-tracking/` is a flat sibling directory,
  same file shapes (`config`/`hub-client`/`tracking`/`status-mapping`).
- **Feature tag:** `cpp-hub-tracking`; **workflow_id:** `cpp-bulk-import`.
- **Finalize:** client-driven (Option A) — the wizard itself computes the
  terminal status after `Promise.all` settles and POSTs `/finalize`,
  wrapped in the wizard's own `try/finally` (R1, mutation-check-verified
  in `7408176` — the original tests only covered the per-CPP-failure
  path, not an unexpected mid-batch throw).
- **Success unit:** per-CPP (not per-asset) — one CPP with any failed
  asset counts as that CPP failed.
- **Guard:** two-state (start → upload, matching bulk-import/bulk-status,
  not submit-batch's three-state — CPP Bulk Import has no mid-flight
  conflict/pause dialog).

#### 5th integration — Google Bulk Activate/Deactivate (shipped: design `fe81785`, impl `2e710d3`)

**Reuses** `google_iap_mgmt.hub_tracking_config` (Google Bulk Import's own
table, the 2nd integration) — no new table, no new settings page. Full
detail in [design-bulk-status-hub-tracking.md](../google-iap-management/design-bulk-status-hub-tracking.md);
summary:
- **Feature tags:** `google-iap-bulk-activate` / `google-iap-bulk-deactivate`
  — distinct from Bulk Import's `google-iap-hub-tracking`, so all three
  Google integrations split cleanly in Railway logs while sharing one
  combined Hub dashboard workflow stream.
- **Finalize:** server-side, `run_id` threaded client→route (§10.13.K
  **P11** — `executeBulkStatus` is a single round-trip, confirmed
  structurally identical to Bulk Import's execute route before reusing
  its exact `try/finally` shape; R1 mutation-check-verified in `2e710d3`).
- **Cancel window is asymmetric between the two actions:** Deactivate has
  a reconfirm dialog → real cancel window (reconfirm-Cancel/backdrop/
  outer-close/`beforeunload`, all gated on the **P12** permanent
  `writeStartedRef`). Activate has NO reconfirm — `submit()` fires
  synchronously in the same click handler → effectively no cancel window;
  accepted, not a gap (Manager decision).
- **R3 (multi-start hygiene):** declining Deactivate's reconfirm returns
  to the selection screen INSIDE the same still-open modal (not a full
  navigate-away, unlike Apple submit's three-state dialogs) — re-clicking
  Deactivate starts a genuinely NEW run, so the just-declined run must be
  cancelled first or it leaks into the next attempt.
- **R4 (race → orphan-cancel, not silent-drop):** deliberately stronger
  than Google Bulk Import's `ce169a8`/**P7** precedent — if the ~1s race
  cap wins and the write proceeds untracked, the late-resolving `/start`
  response is now best-effort CANCELLED once it arrives, instead of
  dropped silently. See Accepted Limitations below for the residual gap
  this doesn't close (>1s race).
- **Status computation:** the SAME `computeGoogleBulkImportTerminalStatus`
  Google Bulk Import already uses, reused as-is (Manager decision:
  explicitly no rename, despite the "Import"-flavored name) — fed
  `{total,succeeded,failed}` from `BulkStatusOutcome`. The `1fb3f7e`
  multi-option `warning` (§10.13.G) is deliberately NOT folded into this
  terminal status — it's a separate, non-blocking signal.

#### 6th+7th integration — Apple Set Availabilities / Remove from Sales (shipped: design `7a7cc7a`, impl `bd54826`)

Both operations share ONE flow — `AvailabilitiesBulkModal.tsx` →
`POST /api/iap-management/iaps/bulk-availability` →
`executeBulkAvailability` (`lib/iap-management/orchestrators/
bulk-availability.ts`), discriminated only by the route body's
`action: "set-all" | "remove"` — not two separate hub-tracking wire-ups.
(SC6 widened this to `| "set-territories"` with its own tag
`iap-set-territories`; the one-route-many-actions shape held.)
Full detail in [design-iap-availability-hub-tracking.md](design-iap-availability-hub-tracking.md);
summary:

- **Config:** reuses Apple import's own `iap_mgmt.hub_tracking_config` —
  no new table, no new settings page (same tradeoff as Apple Submit-batch
  above: distinguished only by feature tag, not on the Hub dashboard
  itself).
- **Finalize:** server-side, single round-trip — the whole
  `bulk-availability` route handler wrapped in one `try/finally`
  (`HubTrackingState{runId,status,errorMessage}`), `hub_run_id` threaded
  from the request body. R1 mutation-check-verified: deleting the route's
  `finally`-block finalize call made the dedicated test fail (0 calls
  instead of 1); reverted, route diff empty after revert.
- **Two feature tags, one route** — `iap-set-availabilities` /
  `iap-remove-from-sales`, derived server-side from the validated
  `action` (never client-sent), so Railway logs stay separable per
  operation despite sharing one route + orchestrator.
- **Cancel window is asymmetric between the two actions** (same shape as
  Google Activate/Deactivate, 5th integration, above): Remove from Sales
  has a reconfirm dialog → real cancel window (decline/backdrop/outer-
  close/`beforeunload`, all gated on the permanent `writeStartedRef`,
  §10.13.K **P12**). Set Availabilities commits in the same tick as the
  click — no reconfirm, so `/start` races a bounded ~1s cap the same way
  Google's Activate does (§10.15's Google row, R4).
- **Tag parameterization made additive, verified against BOTH existing
  Apple callers:** `hub-client.ts`/`tracking.ts`
  (`hubStartRun`/`hubCloseRun`, `startBulkImportTracking`/
  `finalizeHubTracking`) gained an optional `feature` param defaulting to
  Bulk Import's existing `iap-hub-tracking` tag when omitted — mirrors
  the fix already applied on Google's hub-tracking lib. The
  `/hub-tracking/start` and `/cancel` routes accept an optional `feature`
  body field the same way. Apple Submit-batch's tag (`iap-submit-hub-
  tracking`) comes from its own separate server-side wrapper module
  (`submit-tracking.ts`), which this change leaves **completely
  untouched** — regression-proofed by running both existing suites after
  the parameterization (Bulk Import's hub-tracking suite 69/69, submit-
  batch's tracking suite 25/25, `submit-tracking.ts` zero diff).

#### 7-integration summary table

| Integration | Module | Config | Finalize placement | Guard | Cancel-window specifics | Feature tag(s) |
|---|---|---|---|---|---|---|
| Apple Bulk Import | `iap-management` | Own `iap_mgmt.hub_tracking_config` | Server (execute route `try/finally`) | Two-state, permanent `executeStartedRef` | Wizard step 1→2 through execute-click | `iap-hub-tracking` |
| Google Bulk Import | `google-iap-management` | Own `google_iap_mgmt.hub_tracking_config` | Server (execute route `try/finally`) | Two-state, permanent ref + 1s race cap | Upload→preview through execute-click | `google-iap-hub-tracking` |
| Apple Submit-batch | `iap-management` | **Reuses** Apple import's `iap_mgmt.hub_tracking_config` | Server, but **4 distinct finalize sites** (multi-request v2 conflict/partial-fail) | **Three-state** `executeCommittedRef` | First `execute:true` through conflict/partial-fail dialogs (state-dependent) | `iap-submit-hub-tracking` |
| CPP Bulk Import | `cpp-management` | Own `public.cpp_hub_tracking_config` + own Settings page | **Client** (`Promise.all` settle → `/finalize` POST, wizard's own `try/finally`) | Two-state, permanent ref | Validating/preview through upload-click | `cpp-hub-tracking` |
| Google Bulk Activate/Deactivate | `google-iap-management` | **Reuses** Google import's `google_iap_mgmt.hub_tracking_config` | Server (bulk-status route `try/finally`) | Two-state, permanent `writeStartedRef` + 1s race cap + orphan-cancel-on-late-resolve | Deactivate: reconfirm dialog dwell. Activate: none (synchronous submit, accepted) | `google-iap-bulk-activate` / `google-iap-bulk-deactivate` |
| Apple Set Availabilities | `iap-management` | **Reuses** Apple import's `iap_mgmt.hub_tracking_config` | Server (bulk-availability route `try/finally`) | Two-state, permanent `writeStartedRef` + 1s race cap | None (synchronous submit, accepted — same shape as Google Activate) | `iap-set-availabilities` |
| Apple Remove from Sales | `iap-management` | **Reuses** Apple import's `iap_mgmt.hub_tracking_config` | Server (bulk-availability route `try/finally`, same route as Set Availabilities) | Two-state, permanent `writeStartedRef` + 1s race cap | Reconfirm dialog dwell (same shape as Google Deactivate) | `iap-remove-from-sales` |

**Backlog — NOT yet built:** CPP's OLDER single-CPP asset-upload flow
(`components/cpp/BulkImportDialog.tsx` — imports assets into ONE existing
CPP from inside `CppEditor`/`LocalizationManager`; distinct from the now-
tracked `CppBulkImportDialog.tsx` multi-CPP creation flow above) is still
client-orchestrated per-file with no batch-level server endpoint —
adding Hub tracking there needs a new batch-level server endpoint first,
not just another `startXTracking`/`finalizeXTracking` pair. Flagged for a
future session, not started.

#### Accepted limitations (deferred-with-tripwire)

Consolidated here so a future reader knows what's deliberate vs. what
should trigger revisiting — each has a stated condition that means "stop
deferring, go build the fix":

| Limitation | Why accepted | Tripwire — when to revisit |
|---|---|---|
| Hub has **no RUNNING-run TTL** (`docs/integrate-rest-vnggames-hub.md` — only an explicit PATCH ever sets a terminal status; nothing auto-expires) — a tab-close mid-operation leaves an orphaned `RUNNING` run until manually closed. Affects every integration above. | Rare, low-volume edge case; building a server-side stale-run sweep is real infra work for a cosmetic dashboard issue. | Orphaned `RUNNING` runs becoming dashboard noise (Manager/ops complaint) → build a stale-run sweep (server-side cron: close any `RUNNING` run older than N hours as `FAILED`/`CANCELLED`). |
| Google multi-option **full-set deferred** (§10.13.G) — deactivate/activate/edit resolve and target a SINGLE purchase option; a genuine 2+-ACTIVE-option product is surfaced via the non-blocking `warning`, not fully handled, and Hub's terminal status reflects the Google-call outcome for that one option, not the product's full "is it actually off-sale everywhere" goal state. | No confirmed 2+-active-option product observed in the real catalogue yet; building full-set batching (resolve ALL active options, one state request per option, roll up N sub-results to one per-sku outcome) is real scope for a hypothetical case. | The `warning` firing on a real catalogue product (not just in tests) → build full-set multi-option state batching. |
| Google bulk-**Activate** race **>1s** — if the live `/start` call takes longer than the bounded cap, the write proceeds UNTRACKED (correct, never mislabeled — **P7**) and the late-arriving run is best-effort CANCELLED (`2e710d3`'s R4) rather than adopted into the write's own result. | The write itself is never blocked or wrongly labeled; only the TRACKING coverage for that one run is lost (a real, successful/failed operation just doesn't show up on the Hub dashboard for that attempt). | UAT or dashboard review shows this firing in practice (an activate run missing from the dashboard that should be there) → thread the client-held write RESULT (not just cancel) into the late-resolving run's finalize call instead of cancelling it, so it closes with its real terminal status. |
| **Two Apple Hub-tag mechanisms coexist** — Bulk Import/Set Availabilities/Remove from Sales derive their feature tag via the route-body `feature` param (`hub-client.ts`/`tracking.ts`, additive default), while Submit-batch derives its tag from its own separate server-side wrapper module (`submit-tracking.ts`), untouched by that parameterization. Two different mechanisms produce the same *kind* of value (a Railway log tag). | Each existing caller works correctly today; unifying them now would mean touching Submit-batch's already-shipped, independently-tested wrapper for no functional gain — parameterizing the route-body path was the additive, backward-compatible option that avoided that touch. | A **3rd** Apple integration needs a tag mechanism distinct from both existing ones (i.e. the two-mechanism split becomes three-plus, or a change to one mechanism must be mirrored in the other) → consolidate onto ONE mechanism (likely: fold `submit-tracking.ts` into the parameterized `feature` param) before adding a fourth. |

---

### 10.16 Cycle 46 — IAP submission migrated to reviewSubmissions (v2) (2026-07, commit `6bb7023`)

**Context:** Apple announced (2026-07-15) the deprecation of
`POST /v1/inAppPurchaseSubmissions` (no sunset date) in favor of the same
`reviewSubmissions`/`reviewSubmissionItems` mechanism CPP already used.
See **§4.10** and **§4.11** landmarks above for the Apple-behavior
findings this migration is built on, and
[design-iap-v2-submission-migration.md](design-iap-v2-submission-migration.md)
for the full investigation + design record — summarized here, not
restated.

**Dual-path architecture (rollback-safe):** the old `inAppPurchaseSubmissions`
flow is kept **fully intact**, byte-for-byte, as the default — not
refactored, not deleted. A new reviewSubmissions-based path is added
alongside it, selected per-app via `IAP_SUBMIT_V2_APPS`:

| Value | Effect |
|---|---|
| unset / empty | v2 OFF for every app — 100% legacy (safe default) |
| `"*"` | v2 ON for every app, **including apps added later** — handled as an explicit branch, never treated as a literal app id to match |
| `"id1,id2,..."` | v2 ON only for those exact **Apple App IDs** (the same numeric id form `submit-batch`'s route already keys on via `ctx.params.appId` — NOT the internal `iap_mgmt.apps` UUID) — dogfood mode, the recommended starting posture given §4.10's confirmed CPP/IAP slot-sharing collision risk |

**What the v2 path adds over the old one:**
- **Never blind-creates** the app's `reviewSubmission` — checks for an
  existing open one first (`lib/shared/review-submission.ts`,
  `createOrReuseReviewSubmission`), reusing it if present. This closes
  the latent CPP bug from **§4.10** too (backported to
  `prepareCppSubmission`).
- **Decision A conflict dialog**: if the shared items-only slot (§4.10)
  already has foreign items in it (e.g. CPP pages, or another IAP
  batch), the user sees exactly what's already there (item count +
  types, or a degraded "N other items" if Apple returns opaque
  relationships) and must explicitly choose "Submit all N to Apple
  review" or "Cancel" — never a silent co-submit.
- **200-item cap**: Apple's official per-submission limit (§4.10),
  enforced twice — client-side hard block on selection (multi-select
  capped at 200; "select all" over 200 refuses outright with a message)
  and a server-side zod `max(200)` backstop.
- **Rate-limit fix for the "52 items → 9 failures" production bug**:
  `withRetry`/`AppleRateLimitError` on every new Apple call site, 1000ms
  inter-item pacing between `reviewSubmissionItem` adds (reusing the
  bulk-import `INTER_ROW_DELAY_MS` convention), and a partial-fail
  proceed/rollback UX (mirroring CPP's existing pattern) so a failed
  item is never silently dropped. Confirmed common-case call count is
  close to **N+3** per batch (create-or-reuse + N item-adds + submit
  PATCH) rather than the old flow's **2N** (one submit + one status
  refetch per item) — though the version-id lookup is currently
  per-item rather than batched into the existing preflight call, so the
  practical count is closer to **~2N+3**; batching that lookup is a
  noted, deferred optimization if rate-limit pressure persists after
  rollout.
- **Shared extraction — hardens CPP too, not just IAP**:
  `lib/shared/apple-fetch.ts` (the 429/backoff primitive) is now used by
  BOTH the new IAP v2 submit code and CPP's `ascFetch`, which had **zero**
  rate-limit protection before this migration.

**Tests:** 6 new test files added with the migration build; full suite
green at merge time. **No new migration** — `IAP_SUBMIT_V2_APPS` is
env-only.

---

### 10.17 Cycle 47 — Bulk Import result Notes: full Apple error detail (2026-07, design `d709108`, impl `d5b77f4`)

**Root problem:** a failed Bulk Import row's Notes cell showed a
truncated raw error; the full Apple error was visible only in Railway
logs. Traced to a single choke point — the execute route's `errMsg()`
capped `AppleApiError.body` at 500 chars **before** it reached either the
JSON response or `actions_log` (both read the already-capped string);
the client then truncated a second time to ~120 chars for display. Full
detail + investigation: [design-bulk-import-notes-error-detail.md](design-bulk-import-notes-error-detail.md).

**Fix — additive, both fields new:**
- `describeAppleError()` (`lib/iap-management/bulk-import/
  apple-error-descriptor.ts`) captures the Apple response body **before**
  any cap — populates new `error_full` / `submit_error_full` (+
  `error_http_status` / `submit_error_http_status`) fields on
  `PerIapResult`, alongside the existing `error`/`submit_error` fields
  which **stay capped, unchanged** (backward compat — nothing that reads
  them today needed to change). Lives in its own module rather than as a
  `route.ts` export because Next.js route files only permit
  `GET`/`POST`/etc. named exports; the route's own `errMsg()` now just
  delegates to it.
- Persists to `actions_log` for free — `persistResult()` already spreads
  `...result` into the row's `jsonb` payload column, so the new fields
  ride along with **no migration**.
- `summarizeAppleError()` (`lib/iap-management/bulk-import/
  apple-error-summary.ts`) — pure parser, `errors[0].detail` → `.title` →
  `.code` → raw-truncated fallback for non-Apple-JSON text (network
  error, timeout); multi-error case prefixes with the count.
- `ExpandableErrorCell` (`components/ui/shared/` — a new cross-module
  location, not nested under the IAP-specific `components/ui/iap/`,
  specifically so Google's Bulk Import result table can adopt it later
  with no rewrite) — collapsed 2-line summary + `Detail`/`Close` text
  buttons, pretty-printed full JSON capped at ~10 lines then scrolls
  inside the cell; each row's expand state is independent (local
  `useState` per instance).
- Wired into `BulkImportWizard.tsx`'s ERROR-row Notes branch AND the
  submit-failed sub-note branch (same plumbing, both wired in the same
  pass).

**Tests:** 4 new suites — `apple-error-summary`, `apple-error-descriptor`
(incl. an explicit un-truncation proof: a >500-char mock Apple body
asserts `error_full` contains content past char 500 while `error` stays
capped at exactly 500), `ExpandableErrorCell`. Full gauntlet green:
typecheck, 2995/2995 tests, lint, build.

---

## 11. Cumulative Metrics (Post-Cycle 34)

| Metric | Value |
|---|---|
| **Total project commits** | 216 cumulative |
| **IAP arc commits** | ~65 (IAP.c through IAP.q.3; Cycles 33-34 cross-module) |
| **Tests** | 1346 → 1815 (+469 net during IAP trajectory) |
| **Migrations** | 7 (`iap_mgmt` schema; Cycles 32-34 added zero migrations) |
| **Active route.ts files** | 12 under `/api/iap-management/` |
| **Backend lib modules** | 29 TS files under `lib/iap-management/` |
| **Frontend components** | 17 under `components/iap-management/` + 7-primitive UI library |
| **Page routes** | 14 page.tsx under `app/(dashboard)/iap-management/` |
| **LOC net added** | ~20,000 cumulative across the IAP trajectory |
| **Memory patterns crystallized** | 60+ |
| **Q-IAP architectural locks** | ~30 |
| **Pattern 10 reuse #19 cycles** | 6 (29, 30, 31, 32, 33, 34) |
| **Manager refinement iterations** | 50+ |
| **Apple V2 IAP trap classes documented + tested** | 4 |
| **Dependencies added** | `i18n-iso-countries` (Cycle 31, ISO 3166-1 territory names) |
| **Gauntlet 4/4** | ✅ Every sub-chunk through IAP.q.3 |

---

## 12. Glossary

| Term | Definition |
|---|---|
| **ASC** | App Store Connect — Apple's developer-facing dashboard + API |
| **Apple V1 / V2** | API version. V1 = sub-resource endpoints (authoritative for deep traversal). V2 = aggregate endpoints (`?include` whitelist enforced, relationship enumeration truncated at 10 IDs) |
| **Apple V2 `?include` truncation** | LANDMARK: V2 endpoints with `?include` cap the relationship enumeration at 10 IDs even when the underlying schedule has more. See [§4.1](#41-landmark--apple-v2-include-relationship-truncation-iapp2m) |
| **Cycle 29-34** | Pattern 10 reuse #19 sequential cycles. Cycles 29-31 = strategic 5-deliverable trajectory milestone. Cycles 32-34 = post-trajectory hardening |
| **`customerPrice`** | Apple's USD-denominated localized price. Use for tier matching, NOT the historical numeric tier (Tier 1, Tier 2…) which Apple's 2024 rollover invalidated |
| **~~`existsOnApple_validated`~~** | ⚠ **PHANTOM — does not exist.** Never in any migration, never in any code path. Described here for three cycles as a tri-state column on `iap_mgmt.iaps`. The real "is this on Apple" test is **`apple_iap_id IS NULL`**. See [§4.15](#415-landmark--existsonapple_validated-does-not-exist-either--phantom-field-2-in-this-module) |
| **IAP** | In-App Purchase |
| **iapDb()** | Schema-isolation Supabase client wrapper. All `iap_mgmt.*` queries go through this |
| **Iris API** | Apple Connect Web's undocumented internal API at `/iris/v1/*`. Used for diagnosis only, never in production (cookie auth, unstable) |
| **Manager** | The Vietnamese-speaking project owner (Kiang Ming) driving the feature trajectory |
| **MV28 / MV29 / MV30** | Manager Verification rounds (numbered iteratively) |
| **Pricing source** | One of `APPLE` / `DEFAULT_TEMPLATE` / `APP_TEMPLATE` — drives the pricing orchestrator path |
| **Q-IAP.\*** | Architectural lock identifier. Q-IAP.h.\* = IAP.h sub-chunk overrides. Q-IAP.p1.\* = Cycle 30 locks. Q-IAP.p2.\* = Cycle 31 locks |
| **Q-K fail-soft** | Cycle 30 lock: template entry with no Apple match → log + continue, don't abort the orchestration |
| **Sub-arc / mini-cycle** | Narrow scope cycle within a larger arc (e.g. IAP.q.\*) |
| **Strategic 5-deliverable trajectory milestone** | The five cohesive arcs closed 2026-05-19: Phase E, ForwardDedup, IAP MVP, IAP Pricing Templates, IAP View Detail |
| **Trap class** | Recurring Apple integration gotcha pattern. Four classes documented; see [§4](#4-apple-integration-insights) |
| **items-only reviewSubmission slot** | LANDMARK: Apple allows one items-only `reviewSubmission` per (app, platform); CPP and IAP submissions both compete for it. See [§4.10](#410-landmark--cpp-and-iap-share-one-items-only-reviewsubmission-slot-per-app-platform) |
| **Hub run** | One `RUNNING`→terminal lifecycle on the external VNGGames Hub REST ledger, opened by `POST /runs/start`, closed by `PATCH /runs/:id`. See [§10.15](#1015-cycle-45--vnggames-hub-run-tracking-apple-import-google-import-apple-submit-2026-07) |
| **The status principle** | Meta-rule: a terminal status must reflect the real outcome (goal state reached / genuinely failed), never the button clicked or a same-named-but-different-meaning per-item field. See §10.13.K **P5** |

---

## 13. References

### Within `docs/iap-management/`

- **[SESSION-ARC-2026-05-15-summary.md](SESSION-ARC-2026-05-15-summary.md)** — Original Cycle 29 session arc (308 lines). Read for IAP MVP commit-by-commit narrative + Q1-Q12 + Q-IAP.1-8 + Q-IAP.h.1-3 detail.
- **[SESSION-ARC-2026-05-15-FINAL-summary.md](SESSION-ARC-2026-05-15-FINAL-summary.md)** — Strategic 5-deliverable trajectory closure + Cycles 32-34 hardening (539 lines). Read for "what happened when".
- **[apple-api-reference.md](apple-api-reference.md)** — Apple endpoint operational reference (461 lines): endpoint table, relationship names, pricing schedule POST shape, local-tier-to-Apple-price-point mapping, known gotchas, update-on-Apple flow, pricing template system, view detail composition.
- **[pricing-templates-guide.md](pricing-templates-guide.md)** — Manager-facing operational guide for pricing templates (157 lines): where to upload, file format, selection during IAP work, Q-K fail-soft semantics, Apple Connect verification.
- **[operational-guide.md](operational-guide.md)** — Manager-facing operational guide (new, Cycle 47): reading Bulk Import results + the expandable Apple error detail, and configuring VNGGames Hub tracking (both modules) + reading its terminal statuses. Intentionally scoped to these two topics for now, not a full feature tour — see the standalone documentation site for that.
- **[UAT-MV28-30.md](UAT-MV28-30.md)** — UAT scenarios for cycles MV28-30.
- **[UAT-MV30-deploy-checklist.md](UAT-MV30-deploy-checklist.md)** — Pre-flight Supabase deploy checklist.
- **`design/`** — HTML mockups (Cycle 31 view-detail mockup-first design reference).
- **`queries/`** — Manager-runnable SQL diagnostic queries.
- **`templates/`** — Apple Connect web UI observation samples + Manager-provided Excel templates.
- **[design-iap-v2-submission-migration.md](design-iap-v2-submission-migration.md)** — Full investigation + design record for the reviewSubmissions v2 IAP submit migration (Cycle 46, §10.16): CPP-vs-IAP submission comparison, call-count analysis, the create-or-reuse/conflict-dialog design, rate-limit plan.
- **[design-iap-submit-hub-tracking.md](design-iap-submit-hub-tracking.md)** — Full design record for Submit's Hub tracking integration (Cycle 45, §10.15): the multi-request finalize structure, the three-state cancel guard, and the status-computation decisions.
- **[design-iap-availability-hub-tracking.md](design-iap-availability-hub-tracking.md)** — Full design record for Set Availabilities/Remove from Sales' Hub tracking (6th+7th integration, §10.15): the shared-route two-tag split, the asymmetric cancel windows, the additive tag-parameterization across both existing Apple callers.
- **[design-bulk-import-notes-error-detail.md](design-bulk-import-notes-error-detail.md)** — Full investigation + design record for Bulk Import's Notes-cell full Apple error detail (Cycle 47, §10.17): the errMsg() truncation trace, the additive `error_full` field design, the reusable `ExpandableErrorCell` component. Includes an HTML mockup at `design/bulk-import-notes-error-mockup.html`.

### External (Apple)

- **App Store Connect API** — [developer.apple.com/documentation/appstoreconnectapi](https://developer.apple.com/documentation/appstoreconnectapi) (note: spec ≠ behavior; always cross-check Railway logs)
- **OpenAPI spec** — `docs/iap-management/openapi.oas.json` (snapshot of Apple's spec; check for drift before assuming spec accuracy). A newer full-repo snapshot also lives at `docs/openapi.oas.v20260717.json` (v4.4.1, used for the §4.11 reviewSubmissions v2 verification).
- **[Overview of submitting for review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/overview-of-submitting-for-review/)** — Apple's official Help doc confirming the 2-open-submissions-per-platform / 1-items-only-slot rule (§4.10).
- **[Submit an In-App Purchase](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-in-app-purchase/)** — Apple's official Help doc stating the 200-items-per-submission cap (§4.10).

### External (VNGGames Hub)

- **[integrate-rest-vnggames-hub.md](../integrate-rest-vnggames-hub.md)** — The Hub's own REST API contract (runs lifecycle, status enum, auth) that §10.15's seven tracking integrations implement against.
- **[design-cpp-hub-tracking.md](../cpp-management/design-cpp-hub-tracking.md)** — Full design record for CPP Bulk Import's Hub tracking (4th integration, §10.15): client-driven finalize, the two-state guard, R1-R4 implementation findings.
- **[design-bulk-status-hub-tracking.md](../google-iap-management/design-bulk-status-hub-tracking.md)** — Full design record for Google Bulk Activate/Deactivate's Hub tracking (5th integration, §10.15): server-side finalize, the asymmetric activate/deactivate cancel windows, R1-R4 implementation findings.

### Within repo root

- **[CLAUDE.md](../../CLAUDE.md)** — Project conventions + invariants (schema isolation, append-only audit log, forward-only migrations, action_type CHECK constraint, etc.)

---

## 14. Sign-off

**Strategic 5-deliverable trajectory milestone — ACHIEVED 2026-05-19.**

- ✅ Phase E (Reports analytics) — closed pre-arc
- ✅ ForwardDedup (Inbox dedup) — closed pre-arc
- ✅ IAP Management MVP (Cycle 29) — closed 2026-05-16
- ✅ IAP Pricing Templates (Cycle 30) — closed 2026-05-18
- ✅ IAP View Detail UI Apple Parity (Cycle 31) — closed 2026-05-19

**Post-trajectory hardening — three narrow-scope cycles 2026-05-20:**

- ✅ Cycle 32: IAP.q.1 submit validation hardening (UX + defence-in-depth)
- ✅ Cycle 33: IAP.q.2 Top Apple Guidelines parser tolerance + visibility (cross-module)
- ✅ Cycle 34: IAP.q.3 Top Apple Guidelines pagination + SQL ordering determinism (cross-module)

**Production-grade SaaS strategic feature continuum delivery pattern proven sustainable at scale.** 60+ memory patterns crystallized across 50+ Manager refinement iterations; 4 confirmed Apple V2 trap classes documented + tested + memorized; institutional knowledge preserved in this artifact + the SESSION-ARC files + the apple-api-reference + the MEMORY.md feedback index.

### 10.17 Cycle 45 — Apple per-territory custom prices + cross-module audit-constraint guard (Aug 2026)

Summary level only — the operator how-to lives in
[`operational-guide.md`](operational-guide.md) §3 and the user-docs site; the API
detail in [`apple-api-reference.md`](apple-api-reference.md); the full design +
as-built notes in
[`design-apple-custom-territory-prices.md`](design-apple-custom-territory-prices.md).

**Part 0 — the P2 recurrence (`0cb9292`, `a27c965`).** The availability paths had
been emitting two `action_type` values absent from the CHECK since Cycle 37, so
every one of those audit inserts was silently rejected in production (both writers
log the error and deliberately never throw). Fixed by `20260811000000`, then
generalised: `lib/audit-constraints/` now guards **every** module's audit column
from one mechanism — parity against the newest migration per module, a source scan
with per-shape sentinels, and a discovery check that fails when a new
`<schema>.actions_log` appears unregistered. Cross-module audit found
`google_iap_mgmt` and `store_mgmt` clean; CPP has no audit table. Severity note:
`store_mgmt`'s `ticket_entries` inserts run inside `*_tx` plpgsql functions, so a
drift there is **loud** (the transaction aborts) rather than silent — higher
severity, but self-announcing.

**Part 1 — the feature (`c8dcbef`, `90560fc`, `74b9739`).** Per-territory price
overrides on the Edit form, layered on top of the existing 3-source pricing model
and shipped through the same `POST /v1/inAppPurchasePriceSchedules`. Four
structural decisions worth carrying forward:

| Decision | Why it mattered |
|---|---|
| Store `(territory, price, currency)`, never a price-point id | Apple's id is per-IAP and cannot exist before the IAP does, so ids resolve server-side at submit down the template path — which makes Create and Edit structurally identical instead of two flows |
| Resolve overrides through a `Map<territory, …>`, flatten last | `additionalPricePointIds` is territory-anonymous; appending would send Apple two `manualPrices` for one territory — a corrupted request shape, not a wrong value. The Map mirrors the DB's PK in the payload |
| Staleness as a COMPARISON of a stored fingerprint, never a boolean | "Change the base back" clears itself with no user action and no extra state; a one-way flag would force an acknowledgement of a no-op *and* could swallow a later real change |
| A failed custom is its own outcome kind (`partial-custom-fail`), outranking the amber template-partial | A custom is an explicit per-territory instruction; templates keep their documented silent auto fallback, customs deliberately do not inherit it |

**The dialog also surfaced a long-standing truth nobody had written down**: Apple's
price schedule is replace-all, so a price set by hand in App Store Connect is
erased by the next push from the tool. That was already the behaviour; showing it
without a remedy would have been worse than silence, so the same view offers
"Import as custom price" (per-row and bulk) — the single most valuable thing the
dialog does for an existing IAP.

New meta-rules from this cycle: **P14** (LAYER-GAP 3rd instance), **P15**
(structural tests must strip comments), **P16** (two fake-test shapes). Tests
3356, gauntlet 4/4.

---

## 15. Apple ASC key pool — SHIPPED DARK (2026-08-25)

Apple counts its hourly request budget per KEY, so N keys on one team give
N × the headroom. The pool is on `main` and inert: `iap_mgmt.asc_account_keys`
holds zero rows, so every account takes the `empty` fallback and signs with
its own key exactly as before. Activating it means seeding a key, not
deploying anything.

**Activation is gated on measurement, not on confidence.** The Manager
confirmed per-key counting from operating a pool on a different tool — strong
evidence, and not a measurement of THIS system. Census D1 (11 read-only
requests, one extra key on the same team) is the confirmation, and §4.9's own
history is why it is not skipped: Apple's docs said 3,600 and Hotfix 25
shipped 250 for months because nobody read it off the wire. If D1 returns
PER-TEAM, the pool stays dark permanently and is NOT ripped out — the
fallback path costs nothing when the table is empty.

### 15.1 The three pieces

| | What it is | The load-bearing choice |
|---|---|---|
| **K1** storage | `iap_mgmt.asc_account_keys` + repository | Soft ref to `public.asc_accounts` (no cross-schema FK — `iap_mgmt.apps` set that precedent). **Explicit `REVOKE ALL … FROM authenticated, anon`**, diverging from this schema's own default grants |
| **K2** selection | Round-robin, chosen inside `appleFetch` | Selection sits at the JWT-minting line, so `withRetry` re-entering `fn()` lands on it again and **rotation happens inside the retry curve** |
| **K3** cooldown | Durable `cooldown_until` + `ApplePoolExhaustedError` | The error **extends `AppleRateLimitError`** so four shipped latches match it unchanged, and carries **`retryAfterMs: 0`** as a fast exit |

**K1 — the grant divergence is deliberate and is the interesting part.**
Migration `20260515020000` set `ALTER DEFAULT PRIVILEGES IN SCHEMA iap_mgmt
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated` as a safety
net so no future table would repeat the IAP.c missing-grant blunder. That
default is right for product tables and wrong for a table of encrypted ASC
private keys. `public.asc_accounts` guards the same data with RLS-and-no-
policies; `iap_mgmt` uses no RLS at all (Q-IAP.8 — auth at the Next.js
layer), so the equivalent is an explicit REVOKE. **A schema-wide safety net
is not a policy for every table in the schema.**

**K2 — placement bought three things at once.** Selecting once per operation
(above `withRetry`) would have frozen the key for all four attempts. Selecting
per request means: no call-site signature changes anywhere; no latch contract
changes — *"an `AppleRateLimitError` escaped `withRetry`"* now means the budget
ran out on up to four DIFFERENT keys, a STRONGER claim than the old one rather
than a conflicting one; and the property is machine-checkable by watching
which key signs each attempt. Hoisting the selection makes that test report
`['K1']` instead of `['K1','K2','K3','K4']`.

The opt-in is an **injected value, not a boolean**. A `{ keyPool: true }` flag
would mean `lib/shared` importing a feature module — inverting the dependency
direction — and would leave the flag settable from anywhere, CPP included.
`appleFetch` takes an `AppleKeyPool`; `iapFetch` passes one, `ascFetch`
imports none and therefore has nothing to pass. `[Q-RATELIMIT.pool-scope]` is
held by the module graph rather than by remembering.

**K3 — the fast exit reuses a mechanism `withRetry` already has.** Because
`ApplePoolExhaustedError` IS an `AppleRateLimitError`, `withRetry` retries it,
and each attempt re-enters selection, finds the pool still cooling and throws
again — correct, but the default curve would sleep 3.5 s to re-learn a known
fact. `withRetry` computes `Math.min(err.retryAfterMs ?? backoff[attempt],
CEILING)`, and `??` only falls through for null/undefined, so a literal `0`
wins and every sleep becomes `sleep(0)`. Chosen over adding a field for
`withRetry` to inspect **because `withRetry` is shared with CPP and every
non-pooled IAP path** — teaching it about key pools would put pool-shaped
behaviour on flows that have none.

### 15.2 ⚠ P24 — a poor test environment is a single-point-of-failure detector

**Both times an enhancement quietly became a new way for the critical path to
fail, the test suite found it — by being poorer than production.**

| | What was added | What the suite did | What it was in production |
|---|---|---|---|
| K2 | Pool read on the `iapFetch` path | 9 IAP tests failed: `Missing SUPABASE_URL` | A Supabase blip, a rotated `ENCRYPTION_KEY` or one corrupt row taking down EVERY Apple request in the module |
| K3 | Cooldown write in the 429 branch | Unhandled rejections | `iapDb()` throwing SYNCHRONOUSLY, escaping the 429 branch and REPLACING the `AppleRateLimitError` with a config error — after which no latch can tell "Apple refused" from "we are misconfigured" |

The tempting read both times was *"the tests need mocks"*. The correct read
was *"the code needs to not depend on this"*. **An optimisation that adds a
single point of failure to the thing it optimises is a bad trade at any
speed** — so `selectKey` degrades to the account key with a WARN, and
`persistCooldown` wraps its whole body rather than only inspecting the
returned `{ error }`.

Generalisation: when adding a dependency (DB, cache, network) to a path that
did not have one, **run the suite before mocking anything**. A missing env var
is the cheapest available simulation of that dependency being down, and it
arrives before the deploy rather than after.

⚠ The second instance also shows the first fix was incomplete in a way review
did not catch: `persistCooldown`'s docstring already SAID "never throws" while
the code still could, because `iapDb()` throws before any `{ error }` exists
to check. **Checking a returned error is not the same as guarding a call.**

### 15.3 ⚠ P25 — a stub that is incomplete in the direction the code is defensive about

`repository.test.ts`'s chainable Supabase stub defined `select`, `eq` and
`order` but not `update`. When K3 added a writer, `.update()` threw a
TypeError — which `persistCooldown`'s new guard caught and reported as a write
failure. The test therefore observed **the right SHAPE (an error, logged, not
thrown) for entirely the wrong reason**, and only failed because a sibling
assertion checked the message text.

**A stub that is incomplete in exactly the direction the code is defensive
about is worse than no stub at all**: a missing method fails loudly, but a
missing method plus a broad guard produces a green test that proves nothing.
Extend the stub when you extend the surface, and prefer at least one assertion
on the *content* of a defensive path, not just its shape — the content is what
distinguishes "the guard worked" from "the fixture is broken".

Related: P23 (fixture bug wearing a domain outcome's clothes). Same family,
different door.

### 15.4 The management UI — Settings → API Key Pool (2026-08-26)

`scripts/seed-asc-pool-key.mjs` is no longer the operating surface. Manager
decision: seeding five accounts by script was not acceptable for day-to-day
work, so `[POOL-key-management-UI]` was pulled off the backlog and shipped as
U1 (routes) → U2 (screen) → U3 (wire + e2e). The runbook
(`docs/iap-management/RUNBOOK-seed-pool-keys.md`) is kept as the dev/emergency
path and is NOT superseded.

**Scope v1, deliberately small:** a table of keys per account · Add · Enable /
Disable · Test key. No hard delete (disable keeps the audit trail for the one
table where "which key was live at 3pm" matters), no editing a key, no
displaying private key material in any form.

| Lock | Decision |
|---|---|
| `[Q-POOLUI.no-d1-button]` | **No "measure rate-limit scope" button.** Test key already emits everything D1 needs — see below. |
| Q1 | `AppleFetchOptions.onRateLimitInfo` approved: an additive observer on the shared `appleFetch`. Needed because `appleFetch` returns only the parsed body, and a route minting its own JWT to read a header would have broken the one-call-site invariant that let the pool ship as a single change. Gate condition pinned: a call WITHOUT the option is byte-identical. |
| Q2 | `key_id` displayed in FULL. It is documented non-secret, travels in the JWT header, and is already printed whole on the `[asc-client] … key=` line — truncating it would break the one thing the column is for, matching a row against the logs. Private key material is never shown, not even partially. |
| Q3 | Reached from the Settings header link chain, after Hub Tracking. |

**⚠ Test key IS the D1 measurement.** It signs with the row's key and
deliberately does NOT pass the key pool to `appleFetch` — with no pool,
`appleFetch` signs with exactly the credentials given, so rotation cannot
interfere. It calls `GET /v1/territories?limit=1`, one of the few endpoints
that returns `x-rate-limit` (§4.9: the two IAP endpoints omit it), and logs:

```
[key-pool-test] account=<id> key=<KID> status=<n> rem=<n> lim=<n>
```

Two clicks a few seconds apart on a two-key account decide the verdict: the
second key opening at `lim − 1` while the first was just charged means
PER-KEY; a second key already charged for the first one's traffic means
PER-TEAM, and the pool stops permanently per `[RATELIMIT-keypool-design]`.

⚠ **The mockup drew a tab strip across the settings pages. No such component
exists** — each settings page is a standalone route and they link from the
header. Implementing the drawing would have added a fourth navigation idiom to
one module; the header chain was used instead.

### 15.5 What is left

- **K4** — seed a second key, run census D1, record the verdict in §4.9.
  Blocked on the Manager creating the key. ⚠ **The mechanics changed in
  §15.4**: no script and no census file are needed any more. Add both keys in
  Settings → API Key Pool, click **Test key** on each within a few seconds,
  and read the two `[key-pool-test]` lines. (The census script this used to
  point at, `scratchpad/CENSUS-rate-limit-strategy.md`, no longer exists —
  it was session-local and was lost.)
- The ⏳ open question in §4.9 (does a 429 carry `Retry-After` when
  `x-rate-limit` is absent) is answered by the `[key-pool] 429-headers` log
  line the first time a real 429 happens. No action until then.

---

## 16. C3 — PARTIAL at the row level (2026-08-25)

A Bulk Import row returned a hard-coded `status: "SUCCESS"` while five of its
six stages swallowed their own errors. An IAP created on Apple with no
localizations, no price and no screenshot reported clean. KB §10.8 recorded
that symptom under Hotfix 26; the cause was one line.

The row's status is now DERIVED from a per-stage map, so the two cannot
disagree — `rollUpRowOutcome` is the only thing that decides SUCCESS vs
PARTIAL, and there is no longer a path to SUCCESS with a stage missing.

### 16.1 The shape, and the one field deliberately NOT ported

`RowStages` ports `update-orchestration.ts`'s `UpdateIapOutcome` — a sibling
already running this shape in production — but **not wholesale**. Its
per-stage `changed: boolean` is dropped: that module diffs an EXISTING IAP,
where "changed nothing" is a real outcome, whereas on CREATE every stage
changes something and the field would ship always-true. **P9 is exactly this
— the risk is highest where a feature LOOKS like a proven pattern.**

Two things were added that the sibling has no need for:
- `localizations.total` — the row already carried `failed_locales` (WHICH
  broke) but never the denominator, so "12 of 39" could not be rendered.
- `SKIPPED_BY_STOP` — a state of its own. *"We asked and Apple refused"* and
  *"we never asked"* lead a Manager to different actions: investigate, versus
  run it again.

### 16.2 [Q-C3.tracking-frozen] — the batch status does not move

Manager froze every tracking/batch-level status for C3. A batch containing
PARTIAL rows still reports on the Hub exactly what it reported before C3
existed. **The COUNTER (`import_batches.partial_count`) is the channel; the
status deliberately says nothing new.** This is a decision, not a loose end —
do not "finish the job" later by teaching `status` about PARTIAL.

⚠ **Freezing it took more than deleting the override, and that is the part
worth remembering.** Before C3 both terminal returns were an unconditional
`status: "SUCCESS"`, so `succeeded` meant "rows that reached the end of the
pipeline" — a population C3 splits in two. Passing the NARROWED `succeeded`
to `computeBulkImportTerminalStatus` would silently move its OUTPUT while
looking exactly like a revert:

| batch | pre-C3 | naive revert | correct |
|---|---|---|---|
| 1 now-PARTIAL row + 1 ERROR row | (1,1) → PARTIAL | (0,1) → **FAILED** | (1,1) → PARTIAL |

The input is re-widened to `succeeded + partial`. The same narrowing had
already leaked into `created_count`, whose twin `overwritten_count` was fixed
while it was left alone. `tracking-frozen.test.ts` pins both halves — a
fixture table (semantic) plus structural guards on the route (the half with
teeth; the semantic half is an identity by construction).

### 16.3 [Q-C3.conflict-read-B] — a read cache, and a third state

Step 3 asked "is this product_id already on Apple?" and both answers looked
identical: a product that finished cleanly and one left half-built by a
rate-limited batch produced the SAME conflict row, and the Manager picked a
ConflictMode from that row.

`iaps.last_import_status` + `last_import_summary` are a **read cache**, not
the record. `actions_log` (BULK_IMPORT_CREATE) keeps the full per-stage map
and the whole history and **wins on any disagreement**. The cache exists
because the screen resolves products by `(app_id, product_id)` — already
UNIQUE and indexed — while actions_log would need a JSONB-path filter with no
index, scanned on every page render of an append-only table.

⚠ **NULL is a third state and must stay one.** A product created in the
single-IAP form, synced from Apple, or predating the migration has NO
verdict. Reading that as "it went fine" is the single way this feature fails
— in the exact screen added to catch a half-built row — so the rule lives in
a pure `conflictRowNote()` and absence is asserted SEPARATELY from SUCCESS
even though both render nothing.

The write sits INSIDE the `SUCCESS || PARTIAL` guard, not beside it. A cache
that fails to write is loud (the row goes quiet); a cache written for a row
that never reached Apple is silent and worse — the next batch's conflict
screen would describe a product this batch never touched.

### 16.4 PARTIAL counts as a write that HAPPENED

The `iaps` upsert and the submit audit row were gated on SUCCESS. A PARTIAL
row's IAP exists on Apple — that is what PARTIAL means — so gating them out
would leave a row present on Apple and absent from `iap_mgmt.iaps`:
**`[SYNC-orphan-rows]` pointing the other way, created by the very change
meant to make the row honest.** Same for `overwritten_count`.

### 16.5 W2 — a twin CONVERGENCE, not a new rule

A screenshot Apple refuses to swap (`delete-locked`, IAP in review) now fails
its stage and the row rolls up PARTIAL. It used to report SUCCESS while the
orange "screenshot locked" pill sat beside it saying the opposite — the badge
and the status contradicting each other on one row.

⚠ The spread audit found that **`update-orchestration.ts` has ALWAYS treated
any `!result.ok`, `delete-locked` included, as a failed stage rolling up to
PARTIAL**, pinned in its own test. **Bulk import was the single path
disagreeing.** The twin-path rule usually says "you fixed one sibling, go fix
the other"; here it said "the other sibling was already right."

The audit also caught a regression W2 would have caused: making the row
PARTIAL makes `stageMapHasFindings` true, so the Notes cell takes the
stage-map branch and the one genuinely actionable sentence — *"Apple wouldn't
let us swap the screenshot … Swap manually in App Store Connect"* — becomes
UNREACHABLE. The instruction the Manager needs, deleted as a side effect of
making the row more honest. It moved into the map, and the summary now names
the reason (`screenshot locked by Apple review`) rather than the useless
generic `missing screenshot` — nobody can act on "missing" when the file was
fine and the upload was attempted.

### 16.6 ⚠ P26 — a mutation that catches nothing means the tests prove the pattern, not the wiring

Four times in this arc a fix was written, its behaviour tested, and the
mutation that removed the fix **passed every test**:

| # | Fix | Mutation result |
|---|---|---|
| PRICING-429 #2 | route wiring of the pricing marker | 103 tests passed |
| chunk B (e) | pricing stage checks the stop BEFORE the borrowed kind | 151 tests passed |
| W2-a | OVERWRITE counts `delete-locked` as FAILED | 156 tests passed |
| C-3 b1 | conflict note only for PARTIAL | UI test passed (rule tests caught it) |

The shape is always the same: the behavioural test **reproduces the rule
locally** — building a fixture that exercises `rollUpRowOutcome`, or asserting
a marker line the test itself constructs — so it proves the PATTERN is right
while saying nothing about whether the ROUTE uses it.

**The response is a structural guard, never a weaker mutation.** In a
harness-less route the call site is the claim, so the assertion has to look at
the call site. And the guard must be verified by RE-RUNNING the mutation
after adding it — P17's rule applied to the fix for P26.

⚠ C-3 b1 adds a corollary: the mutation can also expose **a test of your own
that is too weak**. The UI assertion checked the clean row for
`/missing|locales/` — words that happen not to occur in "all stages OK" — so
a mutation showing EVERY prior run's sentence sailed through. Replaced with a
sentinel in the clean row's own text. **A negative assertion built from a
vocabulary list is only as strong as the vocabulary.**

### 16.7 ⚠ P27 — a hand-written fixture is a CLAIM about the route, not evidence of it

Twice, a fixture asserted a value the route could not actually produce — and
both times **the fixture was right and the route was wrong**:

- `partial-vs-latch.test.ts` set `pricing: { state: "SKIPPED_BY_STOP" }` for a
  budget-stopped row. The route classified it `NOT_APPLICABLE`, because the
  synthesised `skipped-not-ready` hit `startsWith("skipped-")` before the stop
  check. Nothing compared the two.
- The B4 wording-table generator built `screenshot: { state: "OK", note:
  "delete-locked" }`, a combination that stopped existing the moment W2
  landed. The table printed SUCCESS for a case the code called PARTIAL.

A fixture written to the INTENDED behaviour and a route that implements
something else will both pass forever, because nothing checks that they agree.
Sibling of P23 and P25: all three are "the test setup is the bug", which is
the class hardest to see by reading the test. **When a fixture encodes a
route's output shape, something must pin the route to it** — a structural
guard on the branch order, or a test that builds the fixture BY CALLING the
route's own construction path.

#### P27 applied to DOCUMENTATION — grep every claimed label back to the component

Same class, different artefact. A user guide that quotes a UI label is making a
CLAIM about the code; nothing checks it, and a wrong label reads perfectly.

The 2026-08-27 guide pass found five such claims, and the fifth was not in any
arc being documented: the Bulk Availabilities wireframe drew a confirm button
reading **"Set Avail. for 5"**. No such label has ever existed — the button
says `OK (5 selected)` / `Remove (5 selected)` / `Continue — read 5 items`. It
had survived several arcs, several readings, and a Manager UAT, because it is
exactly what that button *ought* to say.

The others were the same shape: a column drawn as `175/175` when the cell has
only ever rendered `Available` / `Remove from Sales`; "chỉ admin vào được" on a
page that gates on `requireIapSession` and shows members a locked panel.

**The method that found them is the point, and it is mechanical:** take every
label the guide quotes, and grep it back to the component that renders it. What
does NOT work is reading the guide — a plausible wrong label is invisible that
way, which is why these lasted.

```
for label in "$@"; do grep -q "$label" "$component" || echo "MISSING: $label"; done
```

⚠ Two corollaries worth stating:
- **Retired copy needs its own grep, at 0 hits.** Adding the new sentence does
  not remove the old one, and the old one is what a reader hits first.
- **Case matters.** `Pricing Tiers` returned 0 hits while `Pricing tiers` was
  still live on another page. A case-sensitive sweep declared clean is not.

### 16.8 ⚠ P28 — the analyzer under an assertion must strip comments too (P15, one layer down)

P15 says structural tests that grep source must strip comments. C3 found the
same bug one layer lower, in the **slicer that feeds** the assertions.

`batch-close-guard.structural.test.ts` sliced each statement by walking to the
next `;` in raw source. A **prose semicolon inside a comment** ends the slice
early — and this route is heavily commented. A comment added during the chunk
A revert (*"…just not completely; excluding it…"*) truncated the close
statement **above its counters**, so every assertion in that file inspecting
those lines silently stopped seeing them and passed vacuously. Discovered only
by printing what the slicer actually returned.

**P15 protects the test from the prose; P28 protects the TOOL from the prose.**
And the failure directions differ, which is why this is worth its own rule:
P15's version fails LOUD (an assertion fires on a comment), P28's fails
**OPEN** — the guard keeps passing while checking nothing. Verified
load-bearing by reintroducing the exact semicolon AND deleting the column: both
guards still fire, where before the semicolon alone would have hidden it.

#### P28 corollary — a strip tool serves ONE question, and only that one

The pool-key admin API (`[POOL-key-management-UI]` U1) hit the other edge of
the same rule. Its structural guard asserted "no route logs the private key",
using the SAME comment-and-string stripper P28 introduced — and the mutation
that logged `` `… privateKey=${privateKey}` `` **passed all 38 tests**.

Template interpolation is *the* realistic way a secret reaches a log line, and
it lives inside a string. The stripper that P28 added to stop a guard firing
on its own prose had, one file later, blinded a different guard to the leak it
existed to catch.

**Two strippers now, chosen by the question:**

| Question | Tool | Why |
|---|---|---|
| "does the code CALL x?" | `codeOnly` — comments AND strings blanked | prose and string literals are noise |
| "does any string mention a secret?" | `commentsOnly` — comments blanked, strings KEPT | the string body *is* the evidence |

Plus a test that guards the guard: it asserts the log-call extractor can still
see inside a template literal, so if the helper ever starts blanking strings
again, that fails rather than every leak assertion silently passing.

**The generalisation: a stripper is an ANSWER to a question, not a neutral
cleanup.** Reusing one across two questions silently changes what the second
one can see. Related: P15 (fails loud), P28 proper (fails open) — this
corollary is a third failure mode, *fails open in a different assertion than
the one the tool was written for*.

### 16.9 ⚠ P29 — the `fetch` boundary is where `tsc` is blind

A server type widens; the client hand-declares its own narrower copy; the
value crosses as JSON and TypeScript never complains, because nothing connects
the two declarations. The client then holds a value its own type calls
impossible.

Four instances this arc:

| Site | Drift |
|---|---|
| `create-on-apple/route.ts` | hand-copied `PricingOutcome["kind"]` union |
| `BulkImportWizard.tsx` (pricing) | same union, third copy |
| `IapForm.tsx` | same union, fourth copy |
| `BulkImportWizard.tsx` (`status`) | **already drifted** — missing `NOT_ATTEMPTED` since C2 |

The last one is the instructive one: it had been wrong for a whole cycle, in a
file under active development, with a green typecheck the entire time.

**Derive from the source type** (`PerIapResult["status"]`,
`ExecuteSummary["partial"]`) — the route now exports both for this reason —
**and grep for copies rather than trusting the compiler to find them.** The
grep-before-adding-a-field step is what surfaced instance 4; it was not
findable any other way.

### 16.10 What C3 did NOT change

- **Hub tracking** — zero-line diff across `lib/iap-management/hub-tracking/`,
  `lib/cpp-hub-tracking/`, `lib/google-iap-management/hub-tracking/` and the
  three tracking routes. That diff IS the evidence for §16.2.
- **`computeBulkImportTerminalStatus`** — shared with submit-batch; widening
  its signature would push a stages concept onto a flow that has no stages.
- **ConflictMode mechanics** — [Q-C3.rerun-A] is information only. Pinned: the
  Action control renders identically for a PARTIAL and a clean prior run.
- **`import_batches.status`'s dead ternary** (`failed === 0 ? "COMPLETE" :
  "COMPLETE"`) — left in place ON PURPOSE. See `[BULKIMPORT-dead-ternary]`:
  with the status frozen and the counter carrying the truth, collapsing it
  would invite the next reader to "fix" it into a status change.

---

---

---

## 17. The availability mirror (2026-08-26, `ddf8dd6`)

### 17.1 The census that reversed the design's premise

The Manager described the tool: *"pick an app → the list loads and lazy-loads
Available/Removed per item → the tool caches it → Refresh from Apple re-fetches
everything."* Each clause was checked against the code before anything was
designed. One held, two did not, and the disagreement is what set the scope.

| Claim | Verdict | What the code said |
|---|---|---|
| The list shows real Available/Removed, lazy-loaded per item | ✅ | `AvailabilityCell` → `GET /iaps/{id}/availability` → `getAvailabilityForIap` (2-step read, Step B counts territories) → `classifyAvailability`. Real availability, **not** derived from `inAppPurchaseState`, and **not** the U3 include-presence trap. |
| The tool caches the result | ❌ | Nothing, at any layer. No DB column, no lifted state, `cache: "no-store"` on the fetch, no cache on the route. Each cell's answer lived in its own `useState` and died on unmount. |
| Refresh from Apple re-fetches everything | ❌ | `sync-states` called `getApp` + `listAllInAppPurchases` and wrote `state`. **Zero** availability requests. The column did not move, on that click or any other. |

⚠ **The reversal worth remembering.** The backlog item
`[EXPORT-availability-filter]` had been deferred because a paid filter would
cost "~1-2 Apple requests per selected item". The census found the list was
ALREADY paying 2 requests per item on **every mount** and discarding the
answer — ~200 requests per 100-row page scroll, every visit. The feature was
therefore not new spend; it was keeping what was already bought. **A cost
estimate written against a design is not a measurement of the running system.**

### 17.2 The four availability emitters, and why there are two delivery shapes

`setAvailabilityTerritories` is the single Apple write path (§4.12), and by the
time the mirror needed filling it had **four** callers. A kickoff that named
one would have shipped a mirror blind to three surfaces:

| Emitter | Surface | Mirror write |
|---|---|---|
| `orchestrators/bulk-availability.ts` | bulk Set / Remove from Sales | `recordAvailabilityMirrorFromAcceptedWrite` |
| `apple/update-orchestration.ts` | single Edit (stage 5) | same |
| `bulk-import/execute/route.ts` | Bulk Import | **columns spread into its existing UPSERT** |
| `iaps/[iapId]/create-on-apple/route.ts` | Create on Apple | `…FromAcceptedWrite`, outside the try |

⚠ **Bulk Import is why `availabilityMirrorColumns` exists as a separate pure
function.** At the moment it learns the availability outcome it is building an
UPSERT keyed on `(app_id, product_id)` for a row that may not exist yet — it
has no internal id to UPDATE. Making it issue a second statement would be a
write it does not need; letting it hand-roll the columns would be P1 with extra
steps. So: **two delivery shapes (UPDATE / UPSERT), one column definition.**
Callers choose the statement; none of them classifies.

⚠ **The territory count on a write comes from what was SENT, not a re-read.**
Apple's POST response carries the availability resource but its attributes hold
only `availableInNewTerritories` — the territory list is not echoed back. That
is sound because the write is a REPLACE (§4.12, no PATCH, no DELETE), so a 2xx
means the resource holds exactly that list. A confirming re-read would spend
1-2 more requests to re-learn what Apple just confirmed.

### 17.3 An error is not a verdict — the rule the whole mirror rests on

`recordAvailabilityMirror` accepts `AvailabilityForIap | null` and **nothing
else**. Both are real answers: an object is Apple's territory list, `null` is
Apple having no availability resource (the Removed-from-Sale surface). There is
deliberately no way to hand it a rate-limit or a failure.

Three consequences, each enforced by a test that was proven RED by breaking the
code:

- `NULL` in the DB is a **third state** — never synced — and the export filter
  renders it `Unknown`. Folding it into `AVAILABLE` is the U3 defect with a new
  face: U3 would have marked every removed item available by reading a
  relationship's presence as a verdict; `?? "AVAILABLE"` does the same thing
  from absence.
- A stopped sweep writes **nothing** for the items it never reached. They keep
  their old timestamp, including none. Stamping "now" on an unasked item makes
  the as-of label lie about precisely the data it exists to date.
- The as-of label takes the **oldest** record on screen, never the newest.
  `max()` dates a mixed screen by its freshest row — a one-word mutation that
  leaves every other test green and produces a UI that looks entirely normal.

### 17.4 `[EXPORT-avail-read-halving]`, applied — and what it still cannot do

`listAllInAppPurchases(creds, appId, { includeAvailability: true })` — opt-in,
so no other caller pays for the larger payload — yields
`data[].relationships.inAppPurchaseAvailability.data.id` **and**
`included[].attributes.availableInNewTerritories`. Both are exactly what Step A
of `getAvailabilityForIap` exists to fetch, so the sweep skips it:
**1 request per item, not 2** (~503 for a 500-item app).

⚠ **The include supplies an ID AND NOTHING ELSE.** Apple populates the
relationship for every IAP that exists (measured 0/29 missing) and the included
resource carries `links` only for `availableTerritories` — no count. So
presence cannot classify, and reading it as "available" IS U3. The verdict comes
from a territory count, through `classifyAvailability`, and from nowhere else.
`availabilityIdFromListedIap` carries this warning at the call site.

### 17.5 Mirror-first, and the P5 near-miss

The list cell now renders from the mirror when it has one, fetches when it does
not, and **adopts a newer mirror mid-life**. The last clause is what fixes the
census's M3: the cell never unmounts across `router.refresh()`, and its observer
effect returns early on any non-pending state, so before this a resolved cell
was frozen for the life of the page — a Manager who clicked Remove from Sales
watched the column keep saying "Available" and had every reason to conclude the
removal failed. Adoption is gated on `syncedAt` being **newer**, so a server
render racing the cell's own fresh fetch cannot push the stale answer back.

⚠ **P5 (the status principle), in a shape worth adding to the pattern.** In
`create-on-apple` the mirror write was first placed inside the availability
`try`. `getAllTerritoryIds`'s 1-hour cache can expire, and a refill is a real
Apple call that can 429 — landing in that `catch`, setting `availabilityError`,
and reporting *"availability set-all failed"* for a write Apple had already
accepted. The status principle is not only "report the outcome, not the button
clicked"; it is also **"a `catch` reports on the statement that threw, not on
the block it happens to sit in"**. Any statement added to an existing try/catch
inherits that block's error reporting — check what the catch will claim before
putting a new call inside it.

### 17.6 Lock — `[Q-EXPORT-avail.mirror]`

**Filtering and displaying Available/Removed from the LAST SYNC is enough.
Zero Apple requests when filtering or opening the export wizard (the U4 lock is
untouched). The surface must be labelled "as of last sync".**

Two obligations follow, and both are load-bearing:

1. **The lock only stands because a refresh action exists.** Without
   `Refresh from Apple` reading availability (C4), the as-of label could only
   ever say "very old", and a mirror nobody can freshen is a stale cache with a
   timestamp on it.
2. **A consequence the UI must state, not hide.** The filter runs on the
   mirror; the export reads live from Apple. An item removed *after* the last
   sync still passes an `Available` filter and still lands in the file. That is
   the price of a 0-request filter, and it is why the as-of line sits next to
   the control rather than in a tooltip.

⚠ The raw Apple `state` axis **stays** beside the availability axis, per filter
and per row. U3's 35/35 agreement is measured, not guaranteed, and the tool's
own API-driven removal was never part of that sample. Two axes that usually
agree are exactly the pair a UI is tempted to collapse — and collapsing them
means the day they disagree, nobody sees it.


**Knowledge base preserved for future development continuity.**

---

*Generated 2026-05-20 post-IAP.q.3 closure. Commit `f81032c`. Tests 1815. Gauntlet 4/4 ✅.*
