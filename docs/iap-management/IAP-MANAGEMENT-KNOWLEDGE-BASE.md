# Apple IAP Management — Knowledge Base

> **Purpose.** Self-contained reference for the IAP Management feature. Read this first to understand *what is built and why*. For operational specifics see `apple-api-reference.md` (endpoint contracts), `pricing-templates-guide.md` (Manager UX), and the `SESSION-ARC-*` files (chronological "what happened when").
>
> **Authoritative as of** commit `f81032c` (2026-05-20, post-Cycle 34 / IAP.q.3). All file paths verified against the working tree.

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
| Submit state guard (defence-in-depth) | Server-side recheck in submit-batch route | `GET /v2/inAppPurchases?filter[apps]={id}` | 32 (IAP.q.1) |

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
| `existsOnApple_validated` tri-state | NEVER_SYNCED / OK / FAILED — never silent "unknown" | IAP.o.6 |
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

**Action types** (action_type CHECK constraint, extended in migration `20260518000000`):
- `UPDATE_ATTRIBUTES_ON_APPLE`
- `UPDATE_LOCALIZATIONS_ON_APPLE`
- `UPDATE_SCREENSHOT_ON_APPLE`
- `UPDATE_PRICING_ON_APPLE`
- `UPDATE_ON_APPLE` (parent rollup)

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

**Parser discipline.** `parseRateLimit` in
`lib/iap-management/apple/fetch.ts` is *defensive*: returns null when
the header is absent, when only one of the two fields is present, or
when values are non-numeric. The parser MUST NOT throw out of a
successful Apple response just because the header changed shape — this
is a read-only observability surface.

**Phase A surface.** `iapFetch` emits a structured Railway log line on
every response that carries the header:

```
[asc-client] GET /v2/inAppPurchases/abc → 200 budget=1234/3600 duration=180ms
```

Grep-friendly tag: `[asc-client] budget=`. Manager can audit budget
consumption across a workflow by tailing Railway logs and filtering on
this prefix. Endpoints that omit the header produce no `[asc-client]`
line — the existing `[iap-apple]` line still records status + endpoint.

**Phase B contingency.** A future Phase B (token bucket throttler +
universal `ascFetch` refactor) is justified only if Phase A's empirical
data shows persistent low budget remaining or 429 cascades that
`withRetry` can't recover from. The X-Rate-Limit visibility added in
Phase A is the gate that decides Phase B's go/no-go.

**Pre-Cycle-40 cap-figure conflict (resolution-pending).** KB §10.8
carries two inconsistent claims about Apple's hourly request budget:

| Source | Claim |
|---|---|
| Hotfix 25 | "Apple's 250 req/hour cap" |
| Hotfix 26 | "Apple's documented ~1 req/sec/token cap" (≈ 3,600/hour) |

These can't both be correct; the figures differ by an order of magnitude
and would justify very different Phase B designs (250 → token bucket
essential; 3,600 → bursts more tolerable). The conflict is documented
honestly rather than papered over because **resolution is empirical** —
the `user-hour-lim` value Apple sends in `X-Rate-Limit` (now logged via
`[asc-client] budget=R/L` post-Phase A) is the authoritative source.
Manager telemetry observation over 1–2 days post-deploy will surface the
true cap and resolve which figure to treat as load-bearing. The Phase B
subset trigger criteria (B2/B3/B4) explicitly depend on this resolution.

---

## 5. Database Schema

### 5.1 Schema isolation

All IAP Management tables live in the `iap_mgmt` Postgres schema. CLAUDE.md invariant #9 forbids cross-schema FKs; references to `public.*` (CPP) or `store_mgmt.*` (Store Submission) tables are TEXT-typed soft references (e.g. `iap_mgmt.apps.asc_account_id`).

**Access pattern**: all queries go through `lib/iap-management/db.ts` which returns `iapDb()` — a Supabase client wrapper bound to `.schema('iap_mgmt')`.

### 5.2 Tables (10 total, post-Cycle 30)

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
4. **action_type CHECK constraint** — extended per cycle via migration; never add a new action_type in code without the matching migration (Cycle 29 IAP.o.11d incident)
5. **`pricing_source` enum** — `'APPLE'` | `'DEFAULT_TEMPLATE'` | `'APP_TEMPLATE'` (Cycle 30)
6. **`tier_id` is TEXT** — was `INT` pre-IAP.h2; Apple Alternate Tiers required string IDs

### 5.4 Migrations (chronological, 7 total)

| Migration | Purpose | Cycle |
|---|---|---|
| `20260515000000_iap_mgmt_init.sql` | Initial 8-table schema | 29 (IAP.c) |
| `20260515010000_iap_mgmt_tier_id_text.sql` | `tier_id INT → TEXT` for Alternate Tiers | 29 (IAP.f-prep) |
| `20260515020000_iap_mgmt_rls_grants_fix.sql` | RLS disable + service_role/authenticated GRANTs | 29 (IAP.o.1 hotfix) |
| `20260517000000_iap_mgmt_actions_log_action_type_expand.sql` | action_type CHECK adds `CREATE_PRICING_ON_APPLE` etc. | 29 (IAP.o.11d) |
| `20260518000000_iap_mgmt_actions_log_update_on_apple.sql` | action_type CHECK adds 5 `*_ON_APPLE` rows for IAP.o.12 | 29 (IAP.o.12a) |
| `20260519000000_iap_mgmt_pricing_templates.sql` | `price_tier_templates` + entries + Q-B legacy migration | 30 (IAP.p1.a) |
| `20260520000000_iap_mgmt_p1j_hotfix.sql` | `iaps.pricing_source` + `apps.asc_account_id` columns | 30 (IAP.p1.j) |

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
| Dropzone + upload UI | `components/upload/AssetUploader.tsx` | Bulk screenshot reuse |

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

`/iap-management/apps/[appId]/bulk-import` →

1. **Step 1 — Pricing source** (batch-level, Q-E)
2. **Step 2 — Upload Excel** (84-column template + screenshot folder)
3. **Step 3 — Preview + validate** (two-pass conflict resolution: resolve + enrich)
4. **Step 4 — Execute** with `withConcurrency<T,R>` of 5; per-row result hints

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

The IAP.o.11a instrumentation pattern: every Apple call writes `[component] action_id ATTEMPT/SUCCESS/FAILURE` to Railway logs at orchestrator + endpoint boundaries. Audit-log writes happen in the same transaction as the data write so log + DB row are consistent.

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
- **`existsOnApple_validated` tri-state** — NEVER_SYNCED / OK / FAILED, never silent "unknown" (IAP.o.6)
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
| **IAP.p2+** | `contentHosting` edit | Separate Apple endpoint; not in `InAppPurchaseV2UpdateRequest`. `availableInAllTerritories` FULLY UNBLOCKED by Cycle 39 Phase 1 (edit affordance + Remove-from-Sale toggle) — see §10.8. Bulk-action toolbar deferred to Cycle 39 Phase 2. |
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
- Unit C — bulk-modal filter via the same classifier, mode-aware: `set-all` keeps `removed`, `remove` keeps `available`, both modes drop `unknown` so Manager doesn't act on stale state.

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
Apple-rate-limited integrations. Apple's 250 req/hour cap [^h25cap] is
shared across all API surfaces under a single ASC key; any pattern that
fans out N requests per page render compounds across pages, apps, and
manager tabs. Lazy-load + per-cell observers + client-side concurrency
ceiling is the institutional answer.

[^h25cap]: **Cap figure conflicts with Hotfix 26's "~1 req/sec/token"
    (= 3,600/hour) claim.** See §4.9 — both figures pre-date Cycle 40
    Phase A's `[asc-client] budget=` Railway log. Authoritative
    `user-hour-lim` value will be revealed empirically from production
    telemetry; Phase B subset selection (B2/B3/B4) depends on the
    resolution.

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

[^h26cap]: **Cap figure conflicts with Hotfix 25's "250 req/hour" claim
    (above).** Hotfix 26's "~1 req/sec" ≈ 3,600/hour, an order of
    magnitude higher. See §4.9 — both figures pre-date Cycle 40 Phase A's
    `[asc-client] budget=` Railway log. Authoritative `user-hour-lim`
    value will be revealed empirically from production telemetry; Phase
    B subset selection (B2/B3/B4) depends on the resolution.
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

**Cap-figure conflict.** §10.8's two pre-Phase-A figures (Hotfix 25 →
250/hour, Hotfix 26 → ~3,600/hour) are now explicitly annotated as
resolution-pending in §4.9. The empirical `user-hour-lim` value Manager
observes during telemetry decides which figure was load-bearing —
critical input for Phase B subset selection because B3's design depends
on the true cap.

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
| **`existsOnApple_validated`** | Tri-state column on `iap_mgmt.iaps`: NEVER_SYNCED / OK / FAILED. No silent "unknown" |
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

---

## 13. References

### Within `docs/iap-management/`

- **[SESSION-ARC-2026-05-15-summary.md](SESSION-ARC-2026-05-15-summary.md)** — Original Cycle 29 session arc (308 lines). Read for IAP MVP commit-by-commit narrative + Q1-Q12 + Q-IAP.1-8 + Q-IAP.h.1-3 detail.
- **[SESSION-ARC-2026-05-15-FINAL-summary.md](SESSION-ARC-2026-05-15-FINAL-summary.md)** — Strategic 5-deliverable trajectory closure + Cycles 32-34 hardening (539 lines). Read for "what happened when".
- **[apple-api-reference.md](apple-api-reference.md)** — Apple endpoint operational reference (461 lines): endpoint table, relationship names, pricing schedule POST shape, local-tier-to-Apple-price-point mapping, known gotchas, update-on-Apple flow, pricing template system, view detail composition.
- **[pricing-templates-guide.md](pricing-templates-guide.md)** — Manager-facing operational guide for pricing templates (157 lines): where to upload, file format, selection during IAP work, Q-K fail-soft semantics, Apple Connect verification.
- **[UAT-MV28-30.md](UAT-MV28-30.md)** — UAT scenarios for cycles MV28-30.
- **[UAT-MV30-deploy-checklist.md](UAT-MV30-deploy-checklist.md)** — Pre-flight Supabase deploy checklist.
- **`design/`** — HTML mockups (Cycle 31 view-detail mockup-first design reference).
- **`queries/`** — Manager-runnable SQL diagnostic queries.
- **`templates/`** — Apple Connect web UI observation samples + Manager-provided Excel templates.

### External (Apple)

- **App Store Connect API** — [developer.apple.com/documentation/appstoreconnectapi](https://developer.apple.com/documentation/appstoreconnectapi) (note: spec ≠ behavior; always cross-check Railway logs)
- **OpenAPI spec** — `docs/iap-management/openapi.oas.json` (snapshot of Apple's spec; check for drift before assuming spec accuracy)

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

**Knowledge base preserved for future development continuity.**

---

*Generated 2026-05-20 post-IAP.q.3 closure. Commit `f81032c`. Tests 1815. Gauntlet 4/4 ✅.*
