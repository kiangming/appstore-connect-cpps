# Session arc FINAL summary — IAP Management 5-phase strategic trajectory

**Date range**: 2026-05-15 → 2026-05-19
**Arc name**: IAP Management module — strategic trajectory closure (cycles 29 + 30 + 31)
**Status**: 🎉🎯 **STRATEGIC 5-DELIVERABLE TRAJECTORY MILESTONE ACHIEVED**
**Manager verdict**: *"this is the last push code. I work with claude code to fix a lot of issue for price schedule and now it's done."*
**Latest commit**: `(this commit)` IAP.q.1 — submit validation hardening (cycle 32 narrow scope) — was `4801e5c` IAP.p2.m at cycle-31 close

---

## 🎉 Strategic 5-deliverable trajectory milestone — ACHIEVED

The largest strategic feature trajectory shipped on this project. Five cohesive strategic arcs delivered through Pattern 10 reuse #19, cycles 29 + 30 + 31:

| # | Deliverable | Status | Anchor |
|---|---|---|---|
| 1 | **Phase E** — Reports analytics (Store Submission) | ✅ Closed | Pre-IAP arc |
| 2 | **ForwardDedup** — Inbox forward dedup (Store Submission) | ✅ Closed | Pre-IAP arc |
| 3 | **IAP Management MVP** (cycle 29) | ✅ Closed | IAP.c–IAP.o.13a |
| 4 | **IAP Pricing Templates** (cycle 30) | ✅ Closed | IAP.p1.a–IAP.p1.j |
| 5 | **IAP View Detail UI Apple Parity** (cycle 31) | ✅ Closed | IAP.p2.a–IAP.p2.m |

Pattern 10 reuse #19 cycles 29 + 30 + 31 ALL CLOSED COHESIVELY. Strategic implementation phase discipline proven sustainable at scale.

---

## Cumulative arc metrics (final, post-IAP.q.3)

| Metric | Value |
|---|---|
| **Total project commits** | 216 (cumulative across all arcs) |
| **IAP arc commits** | ~63 (IAP.c through IAP.q.3; Cycles 33-34 cross-module Store Submissions hardening) |
| **Tests** | 1346 → **1815** (+469 net during IAP trajectory; +22 in IAP.q.3) |
| **Migrations** | 7 (`iap_mgmt` schema; IAP.q.2 / IAP.q.3 = no migration) |
| **Routes** | 18 active under `/api/iap-management/` |
| **Backend modules** | 24 files under `lib/iap-management/apple/` + 10 under `queries/`, `parsers/`, `dedup/`, etc. |
| **Frontend modules** | View Detail (4 sections) + iap-form + pricing-tiers + bulk-import + 7-primitive UI library |
| **LOC net added** | ~20,000 cumulative across the IAP trajectory |
| **Gauntlet 4/4** | ✅ Every sub-chunk through IAP.q.3 |
| **Dependencies added** | `i18n-iso-countries` (IAP.p2.l, ISO 3166-1 territory names) |

---

## Cycle 29 — IAP Management MVP (commits 2–34)

**Span**: 2026-05-15 → 2026-05-16
**Sub-chunks**: IAP.c, d, e, f-prep, f, g, h, h2, i, j1, k, l, m, n + 13 IAP.o.* hotfix cycles

| Phase | Coverage |
|---|---|
| Schema + parsers | `iap_mgmt` 8-table init, 95-tier price table, sparse XLSX parsing |
| Apple API client | JWT auth wrapper, `withRetry` 429 primitive, IAP CRUD endpoints |
| UI scaffolding | Apps grid, IAP list, dedicated create/edit routes, locale sidebar, 6-prerequisite checklist |
| Bulk import | 4-step wizard, conflict resolution two-pass pipeline, screenshot matcher (literal + normalized fallback) |
| Cross-tool | Hub card + sidebar nav, dark-mode foundation (next-themes + dual-class shim) |
| Verification | Tests +46, UAT MV28/29/30 brief, deploy checklist |
| Hotfix cycle | IAP.o.1 → IAP.o.13a: RLS+GRANT alignment, Apple 2-stage workflow (create/submit separation), pagination, screenshot endpoint rename (`appStoreReviewScreenshot`), Apple state sync, customerPrice match discipline, lid format fix, edit-on-Apple multi-stage orchestration, screenshot edit UI |

**Cycle 29 deferrals (all closed):**
- D1 Screenshot 3-step Apple upload → absorbed into IAP.i bulk path
- D2 Pricing schedule POST → RESOLVED at IAP.o.11d
- D3 Edit-of-synced-IAP PATCH propagation → RESOLVED at IAP.o.12

---

## Cycle 30 — IAP Pricing Templates (commits 43–53)

**Span**: 2026-05-17 → 2026-05-18
**Sub-chunks**: IAP.p1.a, b, c, d, e, f, g, h, i, j, j.UI

| Phase | Coverage |
|---|---|
| Schema | `price_tier_templates` + `price_tier_template_entries` (Q-B auto-migrate legacy `price_tier_territories` → GLOBAL Default Template) |
| Parser | Sparse-template XLSX parser (blank cells = no-override) + `flattenTemplateEntries` helper |
| Settings UI | 2-tab restructure (Default + Per-App) with scope-aware POST/DELETE endpoints |
| App detail | `AppPricingTemplateSection` (empty/populated states + inline upload/replace/remove) |
| Orchestration | 3-source pricing model (`APPLE` / `DEFAULT_TEMPLATE` / `APP_TEMPLATE`) + `territory-price-points-cache` (per-orchestration) + Q-K `partial-template-fail` graceful degradation |
| Form integration | `PricingSourceSelector` on Create/Edit IAP form (Q-D most-specific default) + Create-on-Apple route consumes typed `PricingSource` union |
| Bulk import | Step 3 source selector (Q-E batch-level); execute route threads source into every CREATE/OVERWRITE row |
| Update-on-Apple | `UpdateIapOnAppleArgs.source` + currentTierId; pricing stage runs on source-only change |
| Docs | `apple-api-reference` Pricing Template System section + Manager-facing `pricing-templates-guide.md` |
| Hotfix | IAP.p1.j (MV30 v9 4-issue bundle: persist `pricing_source`, accurate entry count via `count: 'exact'`, live `/api/iap-management/asc-apps` Apple fetch, new `asc_account_id` column) |

**Cycle 30 architectural locks (Q-IAP.p1.A–K, all enforced by tests):**
- Q-A: REPLACE-ONLY template versioning (no history v1)
- Q-B: Atomic migration with defensive backup retention
- Q-D: Most-specific default for pricing source
- Q-E: Batch-level source selector (not per-row v1)
- Q-K: Partial-template-fail graceful degradation

---

## Cycle 31 — IAP View Detail UI Apple Parity (commits 54–60+)

**Span**: 2026-05-18 → 2026-05-19
**Sub-chunks**: IAP.p2.a, b, c, d, e, f, g, h + IAP.p2.i, j, k, l, m hardening

| Sub-chunk | Coverage |
|---|---|
| p2.a | Apple price-schedule fetch (`getPriceScheduleForIap`) + `getIapViewData` composer + per-stage error boundaries + `unpackPriceSchedule` JSON:API plumbing |
| p2.b | 7-primitive UI library: `StatusDot` (Q-D 5-tone), `TooltipBadge`, `LabeledField`, `SectionShell`, `DataTable`, `ExpandablePanel`, `ScreenshotPreview` + tooltips string-map (Q-I i18n-ready) |
| p2.c | Header section — status row + 2-col grid (Product ID / Apple ID / Reference Name + 64-char counter / Type) |
| p2.d | Price Schedule section (Q-K in-scope) — base territory + current prices summary + upcoming changes split |
| p2.e | App Store Localization section — DataTable with locale links + Q-D status dots |
| p2.f | Review Information section — ScreenshotPreview (Q-E enlarge modal) + read-only notes with X/4000 counter |
| p2.g | Page composition + sticky Q-G action bar + per-section `SectionErrorBoundary` + Apple Connect deep link (Q-H) |
| p2.h | Docs section + 7 integration tests pinning composer↔page contract |

---

## Cycle 32 — IAP Submit Validation Hardening (post-trajectory mini-cycle, IAP.q.1)

**Span**: 2026-05-20
**Sub-chunks**: IAP.q.1 (Option II + IV bundle, single commit)

Post-milestone Manager observation: items in `MISSING_METADATA` were still checkbox-selectable on the IAP list even though the modal preflight bucketing dropped them at submit time. Investigation confirmed the architecture was sound (Apple state authoritative, Q-IAP.h.3 lock honoured), but surfaced two narrow gaps:

| Gap | Layer | Fix |
|---|---|---|
| **UX clarity** — Manager could check a MISSING_METADATA row and discover later that it was silently filtered by the modal | Row-level checkbox | **Option II**: gate `eligible` by `appleToInternal[id]` AND `state === "READY_TO_SUBMIT"`; `title=`/`aria-label=` tooltip surfaces the specific blocker (no local row vs. wrong state) |
| **Defence-in-depth** — batch route `runExecute` had no server-side state recheck; trusted modal/caller bucketing | Server route | **Option IV**: refetch Apple state via `listInAppPurchases` at execute time, partition rows via new `partitionByStateGuard` helper, surface `SKIPPED_BY_STATE_GUARD` results + `?skipCheck=true` bypass for explicit internal callers |

**Pattern alignment**: `partitionByStateGuard` mirrors the existing `bucketSelection` preflight helper — same authority hierarchy (Apple state canonical), same testable-pure-function shape. The audit-log `action_type` reuses the existing `SUBMIT_APPLE_REVIEW` row with `payload.result: "SKIPPED"` (no migration needed; matches CLAUDE.md invariant on action_type CHECK constraints).

**Files touched (cycle 32):**
- [app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx](app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx) — selectableAppleIds + per-row eligible/tooltip
- [app/api/iap-management/apps/[appId]/iaps/submit-batch/route.ts](app/api/iap-management/apps/[appId]/iaps/submit-batch/route.ts) — state-guard partition + skippedResults + `?skipCheck=true`
- [lib/iap-management/submit-batch/bucket.ts](lib/iap-management/submit-batch/bucket.ts) — new `partitionByStateGuard` pure helper + `EligibleRow` / `SkippedRow` / `GuardPartition` types
- [components/iap-management/SubmitBatchModal.tsx](components/iap-management/SubmitBatchModal.tsx) — render `SKIPPED_BY_STATE_GUARD` rows distinctly + extended toast text
- [lib/iap-management/submit-batch/bucket.test.ts](lib/iap-management/submit-batch/bucket.test.ts) — +6 partitionByStateGuard tests

**Tests:** 1777 → 1783 (+6). Gauntlet 4/4 ✅.

**Result:** Manager-flagged UX gap closed AND defence-in-depth gap closed — single cohesive commit, no migration, ~1.5h.

---

## Cycle 33 — Store Submissions Top Apple Guidelines parser tolerance + visibility (cross-module mini-cycle, IAP.q.2)

**Span**: 2026-05-20
**Sub-chunks**: IAP.q.2.I + IAP.q.2.V (Option I + V bundle, single commit)
**Cross-module**: Touches Store Submissions module (Apple Reports), not IAP Management — listed here because the cycle continues the IAP.q.* post-trajectory hardening cadence with the same Pattern 10 reuse #19 discipline.

Post-milestone Manager observation on TICKET-10021: Apple Reports → Top Apple Guidelines section reported `"4 reasons couldn't be parsed (no Guideline header detected)"`. Phase-1 investigation traced the message to the `extractGuidelines` regex being too strict for mid-2026 Apple formats; UAT MV24 scenario D (data-accumulation gap) materialized.

| Gap | Layer | Fix |
|---|---|---|
| **Parser too strict** — rejected `Guideline 3 - Business` (1 level), `Guideline 2.1(b)`/`4.3(a)`/`3.1.2(c)` (sub-letters) which Apple actively uses | `extractGuidelines` regex in [`lib/store-submissions/queries/reports.ts`](../../lib/store-submissions/queries/reports.ts) | **Option I**: widened from `{1,2}` → `{0,2}` numeric levels + added optional `(?:\(([a-z])\))?` sub-letter capture. Canonical code preserves sub-letter so `2.1(b)` vs `2.1(c)` aggregate as distinct buckets |
| **Unparseable reasons opaque** — counter said "X couldn't be parsed" with no way to see which entries failed | [`GuidelineBreakdownTable.tsx`](../../components/store-submissions/reports/GuidelineBreakdownTable.tsx) footer | **Option V**: extended `RejectReasonBreakdownResult` with `unparseableEntries: UnparseableEntry[]` (entry_id + ticket_display_id + content_preview). Footer is now a disclosure: "Show details" reveals a compact list with Inbox deep-links (`/store-submissions/inbox?ticket=<uuid>` — same pattern as `RecentRejectedList`) |

**Defensive bounds preserved**: capital `G` still required (inline lowercase prose still rejected), 4-level codes still rejected (no accidental version-string match), uppercase sub-letter still rejected (surfaces typos), standalone-line anchor preserved.

**Invariant**: `unparseableReasons === unparseableEntries.length` — counter is derived from the entries array; structurally impossible to drift.

**Files touched (cycle 33):**
- [lib/store-submissions/queries/reports.ts](../../lib/store-submissions/queries/reports.ts) — regex + types (`UnparseableEntry`, extended `RejectReasonInputRow` + `RejectReasonBreakdownResult`) + aggregator + DB fetcher select/projection
- [components/store-submissions/reports/GuidelineBreakdownTable.tsx](../../components/store-submissions/reports/GuidelineBreakdownTable.tsx) — `UnparseableFooter` expandable subcomponent
- [lib/store-submissions/queries/reports.test.ts](../../lib/store-submissions/queries/reports.test.ts) — +10 tests (4 positive formats, sub-letter canonical preservation, uppercase rejection, 4-level rejection, multi-paragraph email body, aggregator unparsed-entry surfacing, counter invariant)
- [docs/store-submissions/CURRENT-STATE.md](../store-submissions/CURRENT-STATE.md) — IAP.q.2 section + Manager UAT MV24 scenario D resolution note

**Tests:** 1783 → 1793 (+10). Gauntlet 4/4 ✅. No migration.

**Result:** Manager UAT MV24 scenario D closed. Post-ship Manager re-test on TICKET-10021: open Apple Reports → Top Apple Guidelines, sub-letter codes (`2.1(b)`, `4.3(a)`, `3`, `3.1.2(c)`) surface in the breakdown, "couldn't be parsed" counter drops to 0 (or near-0 with the remainder visible via "Show details").

**Pattern alignment:** Cycle 33 demonstrates that production observation = continuous improvement signal post-MVP. Phase E shipped clean on a 2-entry corpus; 3 weeks of real Apple emails revealed a format Apple uses that wasn't in the sample. Investigation-first discipline (Phase 1 audit → SQL diagnostic → root-cause hypotheses → options proposal → Manager decision → targeted fix) preserved through the cycle.

---

## Cycle 34 — Store Submissions Top Apple Guidelines pagination (cross-module mini-cycle, IAP.q.3)

**Span**: 2026-05-20
**Sub-chunks**: IAP.q.3.I (hook + controls) + IAP.q.3.II (SQL ordering) + IAP.q.3.III (integration) — single cohesive 3-component bundle.
**Cross-module**: Touches Store Submissions module (Apple Reports surface), not IAP Management — listed here for the IAP.q.* post-trajectory hardening cadence.

Continuous improvement signal from IAP.q.2 ship: Manager confirmed parser fix works on TICKET-10021 then immediately surfaced the next question — `"Tôi muốn hiển thị all, nếu nhiều hơn 20 thì tách page"` (show all, paginate above 20). Phase-1 audit found neither surface has any row cap; both render every row via `.map()`. DB query also lacked deterministic ordering on the unparseable surface — pagination would have shuffled across re-fetches.

| Gap | Layer | Fix |
|---|---|---|
| **No row cap on Main Guidelines list** — would scale unbounded as corpus grows | [`GuidelineBreakdownTable.tsx`](../../components/store-submissions/reports/GuidelineBreakdownTable.tsx) | Client-side offset pagination via new `usePagination` hook (20/page, hide-when-≤20 threshold per SQ1) |
| **No row cap on UnparseableFooter expansion** — could grow as Manager pastes more free-text rejections | Same component, footer-level | Same hook; page state lives above the disclosure conditional → collapse/reopen preserves page (SQ3 structural) |
| **Supabase fetch order non-deterministic** — pagination would shuffle across re-fetches | [`reports.ts:getAppleRejectReasonBreakdown`](../../lib/store-submissions/queries/reports.ts) | Added `.order('created_at', { ascending: false })` (newest-first, matches `getAppleRecentRejected` convention) |

**4 sub-questions resolved (Manager auto-accepted defaults):**
- SQ1 hide-when-≤20 threshold (no controls below the floor)
- SQ2 component-local `useState` (no URL state — Reports is ephemeral internal-tool)
- SQ3 preserve page state on collapse/reopen (hook state above `{open && …}` conditional — structural)
- SQ4 SQL ordering fix bundled atomically (no partial-state commit history)

**Files touched (cycle 34):**
- **NEW** [lib/store-submissions/reports/use-pagination.ts](../../lib/store-submissions/reports/use-pagination.ts) — generic `usePagination<T>(items, pageSize=20)` hook with identity-based reset + clamp-on-shrink
- **NEW** [lib/store-submissions/reports/use-pagination.test.ts](../../lib/store-submissions/reports/use-pagination.test.ts) — 11 tests
- **NEW** [components/store-submissions/reports/PaginationControls.tsx](../../components/store-submissions/reports/PaginationControls.tsx) — `"Page N of M · X items total"` indicator + Prev/Next
- **NEW** [components/store-submissions/reports/PaginationControls.test.tsx](../../components/store-submissions/reports/PaginationControls.test.tsx) — 5 tests
- **NEW** [components/store-submissions/reports/GuidelineBreakdownTable.test.tsx](../../components/store-submissions/reports/GuidelineBreakdownTable.test.tsx) — 6 integration tests (SQ1 both surfaces, slicing advance, SQ3 preserve-on-toggle)
- [lib/store-submissions/queries/reports.ts](../../lib/store-submissions/queries/reports.ts) — added `.order('created_at', desc)` + comment explaining determinism dependency
- [components/store-submissions/reports/GuidelineBreakdownTable.tsx](../../components/store-submissions/reports/GuidelineBreakdownTable.tsx) — `usePagination` + `PaginationControls` integration in both surfaces

**Tests:** 1793 → 1815 (+22). Gauntlet 4/4 ✅. No migration. Bundle delta: Apple Reports 113kB → 114kB.

**Result:** Both Reports surfaces ready for production scale. Below 20 items: no controls, zero visual clutter (current corpus state). Above 20 items: Prev/Next + "Page N of M · X items total" indicator appears automatically. Deterministic SQL ordering guarantees page boundaries are stable across re-fetches.

**Pattern alignment:** Cycle 34 continues the IAP.q.* sub-arc of post-trajectory continuous-improvement hardening. Same Pattern 10 reuse #19 cycle shape: production observation → investigation-first → options proposal → Manager decision gate → cohesive bundled implementation. Two pagination primitives (`usePagination` hook + `PaginationControls` component) extracted at the right level — future Reports surfaces (e.g. RecentRejected, ByApp scrollable contenders) reuse at zero marginal cost.

---

### Hardening cycle (Manager UAT MV30 iteration)

The hardening cycle revealed deep Apple integration surprises and crystallized one of the most important patterns of the arc:

| Sub-chunk | Surface | Discovery |
|---|---|---|
| p2.i | Path-name bug | Apple V2 path segment is `iapPriceSchedule` (relationship name), NOT `inAppPurchasePriceSchedule` (resource type). Same trap class as IAP.o.9b's `appStoreReviewScreenshot` rename. 404 silent → "empty state" UX. |
| p2.j | Include whitelist | Apple's V2 schedule endpoint enforces strict `include` whitelist: `[baseTerritory, manualPrices, automaticPrices]`. Nested chains rejected 400. Required pivot to 2-stage fetch via V1 `/manualPrices` for deep traversal. |
| p2.k | 4-bug cascade | Unpacker FIX A (territory on InAppPurchasePrice, not price-point); FIX B (currency on Territory, not price-point); FIX C (base price cascade); FIX D (Stage 3 base-price fetch — later disproved). |
| p2.l | Iris ground truth | Apple Connect Web's iris API proved Stage 3 hypothesis WRONG: base IS in `manualPrices`. Dropped Stage 3, derived basePrice from `entries.find(t === baseTerritory)`. Added `i18n-iso-countries` for full ISO 3166-1 alpha-3 coverage. |
| **p2.m** | **Landmark discovery** | **Apple's V2 `?include=manualPrices` truncates the relationship enumeration to ≤10 IDs even with explicit `limit[manualPrices]=50`**. Stage 2's V1 endpoint returns the full 12. Unpacker pivoted to iterate the merged `priceBucket` directly, NOT Stage 1's truncated `manualRel`. |

---

## 🌟 Landmark Apple integration discovery (IAP.p2.m)

> **Apple V2 `?include` relationship truncation**
>
> V2 endpoints with `?include=manualPrices` cap the relationship enumeration at 10 IDs even when the actual schedule has more (12 observed at MV30). The V1 sub-resource endpoint `/v1/inAppPurchasePriceSchedules/{id}/manualPrices` returns the full set. Tool must use V1 as authoritative; V2 endpoint useful for header/metadata only.

This discovery extends IAP.o.11d's `customerPrice` match discipline. **Pattern crystallized: Apple API specification ≠ Apple API behavior. Railway logs = ground truth.**

The full Apple-V2-IAP read-path trap-class taxonomy (now 4 confirmed patterns):

| Trap | Symptom | Diagnostic fingerprint |
|---|---|---|
| **1. Path segment uses relationship name, not resource type** | Silent 404 → "empty state" UX | `priceSchedule: null + priceScheduleError: null` |
| **2. `include` is strict whitelist enum, not JSON:API dotted-path** | Visible 400 `PARAMETER_ERROR.INVALID` | Amber error notice; error message lists rejected include |
| **3. Attribute carrier ≠ resource you expect** | Silent `undefined` reads | Same column missing across every row |
| **4. POST shape ≠ storage shape AND V2 relationship enumeration truncates** | UI renders fewer rows than Apple Connect | Railway log: Stage 1 `manualRel_count < ` Stage 2 `apple_total` |

---

## Q-IAP locks comprehensive (cumulative)

### Original scope (Q1–Q12 + Q-IAP.1–Q-IAP.8 + Q-IAP.h.1–3 + Q-IAP.h2 follow-ups)
See [SESSION-ARC-2026-05-15-summary.md](./SESSION-ARC-2026-05-15-summary.md) for the full table.

### Cycle 30 — Q-IAP.p1.A–K (Pricing Templates)
| Lock | Decision |
|---|---|
| **Q-A** | REPLACE-ONLY template versioning v1 (no history) |
| **Q-B** | Atomic migration with defensive `price_tier_territories` backup retention |
| **Q-C** | Per-territory price-point fetch acknowledged as documented overhead |
| **Q-D** | Most-specific default for pricing source on Create/Edit form |
| **Q-E** | Batch-level pricing-source selector in Bulk Import (not per-row v1) |
| **Q-F** | Update-on-Apple source threading runs pricing stage on source-only change |
| **Q-G** | Apply pricing template to existing IAPs bulk action — deferred post-MVP |
| **Q-H** | Apple intermittent 500 retry budget extended to 5 attempts with jitter |
| **Q-K** | `partial-template-fail` graceful degradation (fail-soft outcome) |

### Cycle 31 — Q-IAP.p2.A–K (View Detail UI)
| Lock | Decision |
|---|---|
| **Q-A** | Inline edit deferred to IAP.p3; view-only v1 with Edit button navigation |
| **Q-B** | Price detail SUMMARY default + Show All expansion (Q-K in p2.d scope) |
| **Q-C** | Single-round-trip relationship traversal (later proved impossible — pivoted to 2-stage at p2.j) |
| **Q-D** | 5-color status palette simplified from Apple's full enum |
| **Q-E** | Screenshot click-to-enlarge modal + locale link navigation |
| **Q-F** | Refresh from Apple — manual button + auto on mount |
| **Q-G** | Top-right action bar cluster (Refresh · Apple Connect · Edit) |
| **Q-H** | Single Apple Connect deep link (no per-section links) |
| **Q-I** | Tooltips as pre-written string-map (i18n-ready) |
| **Q-J** | Responsive — md+ two-col, below md stack |
| **Q-K** | Price section IN p2.d scope (not deferred) |

---

## Memory patterns crystallized (cumulative, ~60 patterns)

### Foundation discipline
- Investigation-first response when Manager reports silent prod issues
- Apple integration silent failure mitigation (UI maps clean 404 to empty state → Manager won't see stack traces; instrumentation = ground truth)
- Two-stage architectural lock (single-round-trip optimism repeatedly invalidated by Apple's actual behavior)
- Manager domain knowledge supremacy (iris API ground truth disproved 2 successive p2.k/p2.l hypotheses)

### Apple integration depth
- **Apple Docs specification ≠ Apple API behavior** (recurring theme)
- **V2 `?include` relationship truncation (10-ID cap)** — NEW PATTERN from IAP.p2.m
- V1 endpoints authoritative data source; V2 endpoints metadata-only
- `customerPrice` match discipline over `priceTier` numbering (IAP.o.11d — Apple's 2024 tier rollover)
- Per-territory price-point fetch cost (IAP.p1.e — documented overhead, not bug)
- 3-step screenshot upload (reserve → PUT presigned → confirm; IAP.o.8a + IAP.o.9b)
- Apple validation states (`existsOnApple_validated` tri-state via IAP.o.6)
- Stage 1 truncation, Stage 2 authoritative (IAP.p2.m)

### Architectural discipline
- F8 nuance backward compatibility preservation (APPLE source path identical pre/post pricing-template refactor)
- Q-K graceful degradation (fail-soft outcomes — `partial-template-fail`, `skipped-not-ready`)
- Q-B atomic migration with defensive backup retention (`price_tier_territories` legacy table kept)
- Per-stage error boundaries (route-level → composer-level → render-level)
- Reusable component library investment (7 p2.b primitives reused across 4 sections)
- Tooltip i18n-ready string-map foresight (centralized lookup, no JSX-embedded copy)
- Schema isolation via `iapDb()` helper (CLAUDE.md invariant #9)

### Process discipline
- Sub-chunked sequential delivery (gauntlet 4/4 per sub-chunk)
- Mid-arc checkpoint verification (Manager UAT after each cycle)
- Two-session strategic discipline (Q-decisions reach lock before code)
- Pre-flight parallel work execution (Manager UAT + Claude implementation interleaved)
- Fresh session strategic kickoff pattern (each new arc gets clean context)
- Mockup-first design review (HTML mockup → Manager review → component scaffold)
- Recommended defaults alignment (Manager rarely overrides recommendations when justified)
- Manager refinement iteration ROI compound (each MV iteration crystallizes ~5 patterns)
- Narrow polish iteration discipline (visual balance, column heights, padding consistency)
- Closure ceremony cohesive discipline (this document)

### Production-grade insights
- External system integration depth >> initial MVP estimate (4 successive Apple traps in p2.i–m alone)
- Strategic feature continuum pattern (cycles 29 → 30 → 31 built on each other)
- Trajectory milestone recognition (5 cohesive deliverables = milestone, not just 5 commits)
- Empirical evidence > Apple Docs specification when behavior differs
- Railway logs = ground truth (instrumentation-first principle, IAP.o.11 + p2.m)

---

## Mid-flow Manager refinement iterations (cumulative ~50)

See [SESSION-ARC-2026-05-15-summary.md](./SESSION-ARC-2026-05-15-summary.md) for cycles 29 + 30 detail. **Cycle 31 additions (4 hardening iterations):**

1. **MV30 post-p2.h** — Manager reported "pricing not set" despite Apple Connect showing pricing. Investigation traced to wrong path segment (`inAppPurchasePriceSchedule` → should be `iapPriceSchedule`). Fixed at IAP.p2.i.
2. **MV30 post-p2.i** — Manager reported amber error notice 400 PARAMETER_ERROR.INVALID. Investigation traced to nested `include` chain rejected by Apple's strict whitelist. Fixed at IAP.p2.j (2-stage fetch).
3. **MV30 post-p2.j** — Manager reported missing country names + wrong base price + missing entries. Investigation traced to 4 cascading bugs (unpacker territory + currency + base cascade + 10-vs-11 count mystery). Fixed at IAP.p2.k.
4. **MV30 post-p2.k** — Manager provided iris API ground truth disproving Stage 3 hypothesis. Investigation traced to base-IS-in-manualPrices + V2 relationship truncation. Fixed at IAP.p2.l + IAP.p2.m. **Landmark Apple integration discovery preserved.**

---

## Architecture reference (final state)

### Database — `iap_mgmt` schema, 10 tables

```
iap_mgmt.price_tiers                        — global cache, replace-on-import
iap_mgmt.price_tier_territories             — denormalized legacy cache (Q-B backup retention)
iap_mgmt.price_tier_templates               — IAP.p1: scope_type GLOBAL or APP
iap_mgmt.price_tier_template_entries        — IAP.p1: per-territory override entries (sparse)
iap_mgmt.apps                               — IAP-scoped app registry + asc_account_id (IAP.p1.j)
iap_mgmt.iaps                               — IAP rows + pricing_source + tier_id (IAP.p1.f, .j)
iap_mgmt.iap_localizations                  — per-locale display_name + description
iap_mgmt.iap_screenshots                    — Apple screenshot reference
iap_mgmt.import_batches                     — bulk import audit
iap_mgmt.actions_log                        — append-only event log (CLAUDE.md invariant #2)
```

### Backend layout — `lib/iap-management/`

```
db.ts                                       Supabase wrapper, .schema('iap_mgmt')
auth.ts                                     requireIapSession / requireIapAdmin
validation.ts                               IapFormState + 6-prerequisite checklist
concurrency.ts                              withConcurrency<T,R>() bounded semaphore
tooltips.ts                                 pre-written tooltip string-map (Q-I)

apple/
  fetch.ts                                  iapFetch + withRetry + AppleApiError
  client.ts                                 Apple API endpoint wrappers
  screenshot-upload.ts                      3-step reserve → PUT → confirm
  poll-iap-ready.ts                         Stage 1→2 propagation guard (IAP.o.11a)
  price-points.ts                           per-IAP price-point lookup
  price-schedules.ts                        2-stage View Detail fetch + setPriceSchedule POST
  territory-price-points-cache.ts           per-orchestration cache (IAP.p1.e)
  pricing-orchestration.ts                  3-source logic (APPLE/DEFAULT/APP) + Q-K fail-soft
  state-edit-blocked.ts                     Apple state guard for edit-on-Apple
  diff-detector.ts                          local vs Apple diff for update orchestration
  update-orchestration.ts                   multi-stage update push (attributes + locs + screenshot + pricing)
  api-schemas.integration.test.ts           Apple endpoint contract enforcement

parsers/
  iap-items.ts                              84-col XLSX parser (with Type column)
  price-tiers.ts                            sparse template parser (IAP.p1.b)
  screenshot-matcher.ts                     literal + normalized matching

queries/
  iaps.ts                                   findApp, createDraft, getIapWithRelations
  iap-detail.ts                             View Detail composer + unpackPriceSchedule (IAP.p2.a/k/l/m)
  price-tiers.ts                            tier lookup + USD price resolution
  templates.ts                              template scope queries

bulk-import/
  conflict-resolution.ts                    two-pass pipeline with concurrency 5
```

### Frontend layout

```
app/(dashboard)/iap-management/
  layout.tsx                                module auth guard + Toaster
  page.tsx                                  redirect → /apps
  apps/page.tsx                             AppsListClient
  apps/[appId]/
    page.tsx                                IapListClient (IAPs + drafts + AppPricingTemplateSection)
    iaps/new/page.tsx                       NewIapClient (Save as Draft form)
    iaps/[iapId]/page.tsx                   EditIapClient (Update on Apple via diff modal)
    iaps/[iapId]/view/page.tsx              ViewIapPage (Apple-canonical detail, IAP.p2)
    bulk-import/page.tsx                    BulkImportWizard (4-step + source selector)
  settings/pricing-tiers/page.tsx           PricingTiersClient (2-tab Default + Per-App)

components/iap-management/
  IapDetailView.tsx                         page composition + sticky action bar (IAP.p2.g)
  SubmitBatchModal.tsx                      bulk Submit Selected flow
  iap-form/                                 shared shell + per-tab content
  pricing-tiers/                            Settings UI components
  view-detail/
    IapHeaderSection.tsx                    p2.c
    IapPriceScheduleSection.tsx             p2.d
    IapLocalizationSection.tsx              p2.e
    IapReviewInfoSection.tsx                p2.f
    SectionErrorBoundary.tsx                p2.g per-section render boundary
    PricesTableExpandable.tsx               p2.d Show All / Summary toggle
    UpcomingChangesTable.tsx                p2.d future-dated entries
    territory-name.ts                       i18n-iso-countries + APPLE_OVERRIDES (IAP.p2.l)

components/ui/iap/                          7-primitive library (p2.b, reusable across 4 sections)
  StatusDot.tsx + index.ts                  Q-D 5-tone palette
  TooltipBadge.tsx                          "?" badge + hover popover
  LabeledField.tsx                          label + tooltip + value row
  SectionShell.tsx                          card wrapper with title + description + trailing slots
  DataTable.tsx                             bordered table primitive
  ExpandablePanel.tsx                       disclosure with chevron
  ScreenshotPreview.tsx                     Q-E thumbnail + modal
```

### Routes — 18 active under `/api/iap-management/`

```
pricing-tiers/                              POST upload + replace cache
pricing-templates/ + [templateId]/          GET/POST/DELETE scope-aware
asc-apps/                                   live Apple fetch behind Per-App dropdown
apps/                                       list IAP-registered apps
apps/[appId]/                               app detail
apps/[appId]/iaps/                          POST create draft + sync-states + submit-batch
apps/[appId]/iaps/[iapId]/                  GET/PATCH/DELETE + create-on-apple + update-on-apple + submit
apps/[appId]/bulk-import/execute/           orchestration (withConcurrency 5)
iaps/[iapId]/                               legacy GET/PATCH/DELETE
```

### Cross-cutting reuse
- CPP Manager's `asc_accounts` table reused as-is (Q-IAP.1)
- CPP Manager's locale display utilities (`localeNameFromCode`) reused in IAP Localization section
- CPP Manager's JWT/ASC fetch primitives extended (not forked) for IAP-specific retry/wrap
- Store Submission's `withConcurrency<T,R>` extracted to shared lib
- Hub page + global sidebar updated to register IAP module (cycle 29 IAP.k)

---

## Deferrals + backlog (post-trajectory milestone)

### Priority 1 — Manager-driven if surfaces

| ID | Item | Notes |
|---|---|---|
| **IAP.p3** | Inline edit Reference Name in view mode | Q-A deferral from p2 — replaces current "Edit" button navigation |
| **IAP.p2+** | `contentHosting` + `availableInAllTerritories` edit | Separate Apple endpoints, deferred from initial scope |
| **IAP.p2+** | Apply pricing template to existing IAPs bulk action | Q-G deferral from p1 |
| **IAP.p2+** | Per-row pricing source override in Bulk Import | Q-E deferral from p1 (batch-level v1 shipped) |
| **IAP.p2+** | Pricing template versioning + history | Q-A REPLACE-ONLY locked v1 |
| **IAP.p2+** | `price_tier_territories` legacy table cleanup decision | Q-B defensive backup retention — keep or drop after stability period |

### Priority 2 — Other strategic arcs

| Item | Notes |
|---|---|
| Multi-platform extractor (Google Play / Huawei / Facebook) | Separate strategic arc, Store Submission scope |
| Auto-archive empty unclassified buckets | Store Submission post-Phase E enhancement |
| Dark mode full token migration | IAP.j2 backlog (D4 — current dual-class shim covers IAP module; CPP + Store + HubPage still light-only) |

### Priority 3 — External Manager process parallel

| Item | Notes |
|---|---|
| OAuth verification with Google Workspace | External process, parallel to code work |

---

## Production verification path

| Layer | Approach |
|---|---|
| **Monitoring instrumentation** | IAP.o.11a pattern: every Apple call logs `[component] action_id ATTEMPT/SUCCESS/FAILURE` to Railway; orchestrator-level audit-log writes in transactions; UI severity escalation for failures |
| **Diagnostic queries** | `docs/iap-management/pricing-templates-guide.md` ships Manager-facing SQL queries (Q1-Q4 + Railway log tail patterns from IAP.o.11b) |
| **Apple API integration tests** | `lib/iap-management/apple/api-schemas.integration.test.ts` pins request URL + method + body + include params for every endpoint; regression fails at test time, not Manager UAT |
| **Manager workflow value verification** | UAT MV28-30 series — fresh-namespace IAPs per cycle (avoid ghost-IAP 409s); compare tool output vs Apple Connect Web ground truth; Railway logs preserved for trace |
| **Railway logs = ground truth** | `[get-schedule] stage1 manualRel_count=…`, `[get-schedule] stage2 page=N got=N has_next=… apple_total=N`, `[set-price-schedule] start/attempt/success/retry/giving-up` — investigation-first protocol |

---

## Future resumption guidance

### Pre-flight steps for next strategic feature

1. **Verify environment**: `git status` (clean); `git log --oneline | head -5` (confirm latest commit); `npm test 2>&1 | tail -3` (1777+ tests baseline)
2. **Read memory pointers**: `MEMORY.md` index → relevant feedback entries (4 trap-class entries for Apple V2 integration alone)
3. **Read this arc summary** + the original `SESSION-ARC-2026-05-15-summary.md` for full Q-lock history
4. **Read `apple-api-reference.md`** + the **15+ Gotchas** before any new Apple endpoint wiring

### Strategic feature scope investigation patterns

1. **Investigation-first**: when Manager reports a silent prod issue, schema-audit + grep-audit before code (IAP.p2.i pattern — wrong path segment, not bad logic)
2. **Instrumentation before rewrite**: ship `[component] stage<N> …` logs BEFORE attempting fixes (IAP.o.11 + IAP.p2.m proved this)
3. **Iris API as ground truth source**: Manager Connect Web's `/iris/v1/` endpoints surface what Apple's documented APIs hide; use for diagnosis but never in production (cookie auth, undocumented, unstable)
4. **Test the contract, not the implementation**: `api-schemas.integration.test.ts` pins request shapes — regressions fail at test time

### Apple V2 relationship truncation discovery preservation

**MANDATORY pre-write checklist** for any new Apple V2 IAP endpoint:
1. Grep `openapi.oas.json` for the `operationId` BEFORE writing the path (Trap 1)
2. Verify the `include` whitelist enum (Trap 2)
3. Verify which resource carries each attribute (Trap 3)
4. **Verify reading the relationship enumeration vs the full sub-resource fetch returns the same count — Apple's V2 truncates relationship enumeration silently (Trap 4)**
5. Pin path-shape + include-shape + count expectations in `api-schemas.integration.test.ts`

---

## Sign-off

**5 strategic arcs cohesive trajectory milestone — ACHIEVED.**

- ✅ Phase E (Reports analytics) — closed
- ✅ ForwardDedup (Inbox dedup) — closed
- ✅ IAP Management MVP (cycle 29) — closed
- ✅ IAP Pricing Templates (cycle 30) — closed
- ✅ IAP View Detail UI Apple Parity (cycle 31) — closed

**Pattern 10 reuse #19 cycles 29 + 30 + 31 — ALL CLOSED COHESIVELY.**

- Strategic implementation phase discipline proven sustainable at scale (60+ patterns crystallized across 50+ refinement iterations)
- Production-grade external system integration depth revealed (4 confirmed Apple V2 trap classes documented + tested + memorized)
- Session natural boundary post-summary file generation

**Next strategic feature = fresh session strategic kickoff pattern established** (whenever Manager surfaces the next arc).

---

*Generated 2026-05-19 at IAP.p2.m closure. Commit `4801e5c`. Tests 1777. Gauntlet 4/4 ✅.*
