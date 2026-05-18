# Session arc summary — IAP Management strategic implementation

**Date**: 2026-05-15 (IAP.c – IAP.n) → 2026-05-16 (IAP.o.1 – IAP.o.5 UAT MV29 hotfixes) → 2026-05-16/17 (IAP.o.6 – IAP.o.11 MV30 hotfix run + pricing-silent-fail closure) → 2026-05-18 (IAP.o.12 edit-on-Apple)
**Arc name**: IAP Management module — 3rd strategic delivery
**Status**: Functional MVP + edit-on-Apple shipped. IAP.o.11d verified pricing single + bulk Apple-side; IAP.o.12 closes the Deferral 3 gap by adding the full Apple-supported edit surface (attributes + localizations + screenshot + pricing replace).
**Latest commit**: `855d957` IAP.o.12b — Update on Apple UI (was `9f35df7` IAP.o.11b at the previous close)

---

## What shipped

### Commit chain (this arc, 18 commits)

| # | Commit | Sub-chunk | Surface |
|---|---|---|---|
| 1 | `e828079` | docs(iap) | Manager-provided IAP templates |
| 2 | `cab085c` | IAP.c | `iap_mgmt` schema migration, 8 tables |
| 3 | `8662cd4` | IAP.d | Apple IAP API client + `withRetry` 429 primitive |
| 4 | `9a974cc` | IAP.e | Excel parsers + screenshot matcher (Q-IAP convention C) |
| 5 | `6ec7dbf` | IAP.f-prep | `tier_id` INT → TEXT (include Alternates per Q-IAP follow-up C) |
| 6 | `61b2eef` | IAP.f | Pricing Tiers Settings module |
| 7 | `85ca624` | IAP.g | Apps grid + IAP list (read-only) |
| 8 | `33fb551` | docs(iap) | UI mockup design reference |
| 9 | `522be51` | IAP.h | Create/edit form, 6-prerequisite checklist |
| 10 | `01133a6` | IAP.i | Bulk import wizard (4-step) |
| 11 | `4d51979` | IAP.h2 | Type column + tier inference (pull-forward) |
| 12 | `839124f` | IAP.j1 | Dark mode foundation (next-themes + tokens + toggle) |
| 13 | `cd962b0` | IAP.k | Hub card + sidebar nav registration |
| 14 | `345921a` | IAP.l | Comprehensive tests (+46) |
| 15 | `94a7137` | IAP.n | UAT MV28-30 brief |
| 16 | `bc0da34` | **IAP.o.1** hotfix | RLS off + GRANT alignment with store_mgmt |
| 17 | `0a2e72b` | **IAP.o.3+4** hotfix | Shell dark shim + empty-tiers warning |
| 18 | `a5503ad` | **IAP.o.5** refinements | Pricing Tiers expandable · tier picker price · bulk tier override · dark shim extension |
| 19 | `f31cdbd` | **IAP.o.6a** Apple 2-stage workflow | Create + Submit separation per Manager workflow lock |
| 20 | `3fbdcda` | **IAP.o.6b** | List-page multi-select Submit Selected flow |
| 21 | `cc49a0f` | **IAP.o.6c** | Apple state sync + bulk polish + audit vocabulary |
| 22 | `f11ce98` | **IAP.o.7a** | Apple `listInAppPurchases` pagination (MV30 Issues 2+3) |
| 23 | `0e6bb85` | **IAP.o.7b** | IAP list client-side pagination 100/page |
| 24 | `0fe2032` | **IAP.o.7c** | Bulk-import Step 4 UX hardening (Issue 1 prevention) |
| 25 | `6e7d7a0` | **IAP.o.8a** | Bulk-import overwrite syncs screenshots (MV30 Issue 1) |
| 26 | `4a0c82e` | **IAP.o.8b** | sync-states UPSERT unlocks Submit Selected (Issue 2) |
| 27 | `db71162` | **IAP.o.8c** | View detail page with Apple real-time fetch (Issue 3) |
| 28 | `7e1df4b` | **IAP.o.9b** fix | Screenshot endpoint family rename to `appStoreReviewScreenshot` |
| 29 | `567f02b` | **IAP.o.9c** docs | Post-deploy verification checklist |
| 30 | `c10c6e3` | **IAP.o.9a** | Wire Apple pricing schedule into create + bulk-import |
| 31 | `0391d66` | **IAP.o.9d** | Apple API schema integration pin + reference docs |
| 32 | `e9ffd14` | **IAP.o.10a** fix | Pricing match by USD `customerPrice` + 500 retry (Apple 2024 tier rollover) |
| 33 | `e127d63` | **IAP.o.10b** fix | View detail click defensive triple-fix |
| 34 | `e986585` | **IAP.o.10c** | Integration tests + docs reflect USD match strategy |
| 35 | `45a2e2f` | **IAP.o.11a** fix | Instrument pricing path · Stage 1→2 poll · retry 5+jitter · audit-write in orchestrator · UI severity escalate |
| 36 | `9f35df7` | **IAP.o.11b** docs | Pricing diagnostic SQL runbook (Q1–Q4 + Railway log tail) |
| 37 | `5ded834` | **IAP.o.11c** docs | apple-api-reference + SESSION-ARC reflect IAP.o.11 |
| 38 | `b85c73c` | **IAP.o.11d** fix | Apple `${local-id}` lid format + actions_log CHECK constraint expansion (H4 root cause) |
| 39 | `f6d4961` | **IAP.o.12a** feat | Update-on-Apple orchestration · diff-detector · state-edit-blocked helper · update-on-apple route · 5 new audit `*_ON_APPLE` action_types migration |
| 40 | `855d957` | **IAP.o.12b** feat | Update on Apple UI: button + diff modal + reviewNote enabled + familySharable checkbox + pre-warn banner |
| 41 | `6deac97` | **IAP.o.12c** docs | apple-api-reference + SESSION-ARC reflect edit-on-Apple flow; D2/D3 marked resolved; IAP.o.13 candidate documented |
| 42 | `848dae0` | **IAP.o.13a** fix | Screenshot edit UI exposed — placeholder "Edit via App Store Connect web UI" removed; ScreenshotUpload now renders cached-on-Apple state + drop area to replace; handleScreenshotRemove reverts to cached in edit mode |
| 43 | `62618c7` | **IAP.p1.a** feat | Pricing-templates schema (`price_tier_templates` + `price_tier_template_entries`) + Q-B auto-migration from legacy `price_tier_territories` to GLOBAL Default Template |
| 44 | `573079e` | **IAP.p1.b** feat | Sparse-template parser (blank cells = no-override) + `flattenTemplateEntries` helper for the entries persister |
| 45 | `8e82f81` | **IAP.p1.c** feat | Settings → Pricing Templates 2-tab restructure (Default + Per-App) backed by new template tables + scope-aware POST / DELETE endpoints |
| 46 | `d933e06` | **IAP.p1.d** feat | App detail page `AppPricingTemplateSection` — empty / populated states, inline upload/replace/remove |
| 47 | `9869f2c` | **IAP.p1.e** feat | Pricing orchestration 3-source model (`APPLE` / `DEFAULT_TEMPLATE` / `APP_TEMPLATE`) + `territory-price-points-cache` + Q-K `partial-template-fail` outcome; F8 nuance preserved (APPLE path bit-for-bit identical) |
| 48 | `a64146a` | **IAP.p1.f** feat | `PricingSourceSelector` on Create / Edit IAP form (Q-D most-specific default); Create-on-Apple route consumes the source as a typed `PricingSource` union |
| 49 | `f8ce9a3` | **IAP.p1.g** feat | Bulk Import wizard Step 3 source selector (Q-E batch-level); execute route threads source into every CREATE / OVERWRITE row; Step 4 surfaces applied source |
| 50 | `dbd9bd9` | **IAP.p1.h** feat | Update-on-Apple `UpdateIapOnAppleArgs.source` + currentTierId; pricing stage runs on source-only change when template-backed; UpdateChangesPreviewModal source banner |
| 51 | `79db4c6` | **IAP.p1.i** docs | apple-api-reference Pricing Template System section + Manager-facing `pricing-templates-guide.md` + SESSION-ARC roll-up + integration test |
| 52 | `(this commit)` | **IAP.p1.j** hotfix | MV30 v9 4-issue bundle: (1) persist `iaps.pricing_source` so Save Draft round-trip preserves Manager's explicit choice; (2) accurate entry count via dedicated `count: 'exact'` + range-paginated `fetchEntries` (Supabase 1000-row cap fix; also restored full template iteration in the pricing orchestrator); (3) live `/api/iap-management/asc-apps` Apple fetch behind the Per-App tab dropdown, refetch on open; (4) new `iap_mgmt.apps.asc_account_id` column captured by `ensureAppRegistered`, ASC Account column rendered on "Apps with custom templates" |

### Cumulative metrics (this arc — through IAP.p1.j)

- **Lines added**: ~17,000 net (IAP.p1 alone ~3,500 across migration + parser + UI + orchestration + docs + MV30 v9 hotfix)
- **Migrations**: 7 (added `20260520000000_iap_mgmt_p1j_hotfix` for the `iaps.pricing_source` + `apps.asc_account_id` columns)
- **Routes**: 18 (added `/api/iap-management/asc-apps` at IAP.p1.j)
- **Tests**: 1346 → 1665 (+319 new total; +31 in IAP.p1 alone)
- **Gauntlet 4/4 ✅** at every sub-chunk through IAP.p1.j
- **Dependencies added**: none in IAP.p1.
- **Hotfix + extension sub-chunks**: 30 post-UAT total. The o.6 → o.11 run was the post-MV30 cycle; o.12 closed Deferral 3 (edit-of-synced-IAP); p1.a–i shipped the strategic upgrade for Manager's 3-source per-territory pricing model; p1.j hot-fixed 4 UX/data issues surfaced by MV30 v9.

---

## Q-IAP locks comprehensive

### Initial scope (Q1–Q12 + Q-IAP.1–Q-IAP.8)

| Lock | Decision |
|---|---|
| **Q1** | IAP types: CONSUMABLE / NON_CONSUMABLE / NON_RENEWING_SUBSCRIPTION (no auto-renewable) |
| **Q2** | Production only (no Apple sandbox) + metadata validation pre-submit |
| **Q3** | Independent module; reuse infrastructure (NOT Store Submission App Registry) |
| **Q4** | Excel template Manager-provided |
| **Q5** | Bulk + per-IAP custom tier modes (later: tier inference replaces explicit column) |
| **Q6** | Reuse CPP Apple credentials (`asc_accounts` table) |
| **Q7** | Real-time sync + rate-limit handling mandatory |
| **Q8** | Conflict resolution: Overwrite default + per-item Skip option |
| **Q9** | Separate route `/iap-management/` |
| **Q10** | Manual sync only (Manager-triggered) |
| **Q11** | Option α full local DB cache (template-driven) |
| **Q12** | ForwardDedup UI quality + dark mode cross-tool |
| **Q-IAP.1** | Reuse `asc_accounts` as-is, thin link to `/settings` |
| **Q-IAP.2** | Multi-file drag-drop for screenshots (no ZIP companion) |
| **Q-IAP.3** | `next-themes` (localStorage + system-prefers-color-scheme) |
| **Q-IAP.4** | Concurrent bulk: last-write-wins, no lock |
| **Q-IAP.5** | Strict header validation + version detection on import |
| **Q-IAP.6** | Save as Draft default + explicit Submit button |
| **Q-IAP.7** | Price-tier replace-on-each-import (no history) |
| **Q-IAP.8** | Reuse global admin/member RBAC (no module whitelist) |

### IAP.h overrides (Q-IAP.h.1–3)

| Lock | Decision |
|---|---|
| **Q-IAP.h.1** | Create IAP = dedicated route (NOT modal — CPP precedent consistency) |
| **Q-IAP.h.2** | Locale UX = sidebar within page (search + 39 locales + has-data dot) |
| **Q-IAP.h.3** | Submit gate = Hybrid live checklist (6 items) + Apple validation safety net |

### IAP.h2 follow-up locks

| Lock | Decision |
|---|---|
| **Tier-count contradiction** | (C) Include Alternate Tiers; schema `tier_id` INT → TEXT |
| **Screenshot filename** | (C) Robust both-forms matcher — literal preferred, dots-as-underscores fallback |
| **Type column** | Optional column in template; empty/absent → CONSUMABLE default; invalid → row error |
| **Tier inference** | Price (USD) lookup → tier_id from `price_tier_territories` cache; no separate Tier column |

### Deferrals (Manager-locked, post-MVP)

| ID | Limitation | Status |
|---|---|---|
| **D1** | Screenshot 3-step Apple upload | ✅ **Absorbed into IAP.i** (bulk path) — single-IAP submit path still skips Apple upload (catch-22: reserve needs apple_iap_id) |
| **D2** | Pricing schedule POST `/v1/inAppPurchasePriceSchedules` | ✅ **RESOLVED at IAP.o.11d** — POST wired into single-IAP create-on-Apple + bulk-import + IAP.o.12 update-on-Apple paths; Manager v6 verified Apple-side. |
| **D3** | Edit-of-synced-IAP PATCH propagation | ✅ **RESOLVED at IAP.o.12** — single-IAP "Update on Apple" pushes attributes + localizations + screenshot + pricing via diff-driven orchestration. |
| **D4** | Dark mode full token migration | ⏸️ **IAP.j2 backlog** — IAP.o.3 + IAP.o.5 ship a dual-class shim covering: dashboard wrapper, AppSidebar, IAP form components, BulkImportWizard, PricingTiersClient. CPP + Store modules + HubPage tool cards still light-only. |

---

## Mid-flow Manager decisions log (chronological)

1. **Screenshot filename convention** (pre-IAP.c) — Manager picked (C) robust both-forms after sample-files-vs-spec contradiction surfaced.
2. **Tier count contradiction** (post IAP.e) — Manager picked (C) include Alternates; ship forward-only INT→TEXT migration.
3. **3 deferrals lock** (post IAP.h) — D1 absorbed into IAP.i submit-time orchestration; D2 partial; D3 post-MVP.
4. **Q-IAP.h.1–3 overrides** (IAP.h kickoff) — dedicated route + sidebar locale + hybrid checklist; mockup overridden where stated.
5. **Filename precision** (post IAP.i) — confirmed `item-iap-template.xlsx` is the authoritative filename (no `iap-item-template` or `appstore-template` variants in code).
6. **Template Type column add** (parallel with IAP.i ship) — Manager edited the xlsx in working tree before parser support landed; surfaced as red-baseline trigger.
7. **Option (A) pull-forward IAP.h2** — chose to ship parser tolerance + tier inference BEFORE IAP.j1, restoring green baseline.
8. **Continue same session for IAP.m + IAP.n** — context-budget verdict: ~30% remaining, sufficient for verification + UAT brief.
9. **IAP.o.1 RLS+GRANT** (post UAT MV29.A failure) — root cause: init migration enabled RLS without policies + skipped grants. Manager applied SQL via SQL Editor in parallel; forward-only migration committed for future deploys.
10. **IAP.o.5 UX refinements + dark deferral** (post re-UAT) — Issues A+B+C functional polish; Issue D dark mode partial, full migration deferred to backlog.

---

## Architecture reference

### Database (`iap_mgmt` schema, 8 tables)

```
iap_mgmt.price_tiers              — global cache, replace-on-import (Q-IAP.7)
iap_mgmt.price_tier_territories   — denormalized cache, ~16,800 rows
iap_mgmt.apps                     — IAP-scoped app registry (apple_app_id soft key, no FK to CPP/Store)
iap_mgmt.iaps                     — IAP rows; apple_iap_id NULL = local draft (Q-IAP.6)
iap_mgmt.iap_localizations        — per-locale display_name + description
iap_mgmt.iap_screenshots          — Apple screenshot reference (apple_id NULL until upload)
iap_mgmt.import_batches           — bulk import audit
iap_mgmt.actions_log              — append-only event log (CLAUDE.md invariant #2)
```

### Backend layout (`lib/iap-management/`)

```
db.ts                 — Supabase client wrapper, .schema('iap_mgmt')
auth.ts               — requireIapSession / requireIapAdmin (Q-IAP.8 global admin/member)
validation.ts         — IapFormState + validateIapFormState (6-prerequisite checklist)
concurrency.ts        — withConcurrency<T,R>() bounded semaphore (replaces p-limit dep)
apple/
  fetch.ts            — iapFetch + AppleApiError + AppleRateLimitError + withRetry
  client.ts           — endpoint wrappers (createInAppPurchase, …)
parsers/
  iap-items.ts        — parseIapItemsXlsx (84-col template with Type column)
  price-tiers.ts      — parsePriceTiersXlsx (95 tiers × 175 territories)
  screenshot-matcher.ts  — matchScreenshotToProductId (literal + normalized)
queries/
  iaps.ts             — findApp, createDraft, getIapWithRelations, …
  price-tiers.ts      — listTiers (w/ usd_price), listTiersWithTerritories,
                        resolveTierByUsdPrice, formatTierWithPrice
bulk-import/
  conflict-resolution.ts  — resolveConflicts + enrichWithTiers (two-pass pipeline)
```

### Frontend layout

```
app/(dashboard)/iap-management/
  layout.tsx                              — auth guard + <Toaster>
  page.tsx                                — redirect → /apps
  apps/
    page.tsx + AppsListClient.tsx
    [appId]/
      page.tsx + IapListClient.tsx        — Apple-side IAPs + local drafts section
      iaps/new/page.tsx + NewIapClient    — Save as Draft form
      iaps/[iapId]/page.tsx + EditIapClient — Edit + Submit
      bulk-import/page.tsx + BulkImportWizard — 4-step wizard
  settings/pricing-tiers/page.tsx + PricingTiersClient — expandable territory rows

app/api/iap-management/
  pricing-tiers/route.ts                  — POST upload + replace cache
  apps/[appId]/iaps/route.ts              — POST create draft
  apps/[appId]/bulk-import/execute/route.ts — orchestration (withConcurrency 5)
  iaps/[iapId]/route.ts                   — GET/PATCH/DELETE
  iaps/[iapId]/submit/route.ts            — Apple submit orchestration
  iaps/[iapId]/screenshot/route.ts        — screenshot register (Apple upload at submit time)

components/iap-management/
  iap-form/
    IapForm.tsx                           — shared shell (create + edit modes)
    LocaleSidebar.tsx                     — 240px locale picker (Q-IAP.h.2)
    LocaleEditor.tsx                      — right-canvas Display Name + Description
    SubmitChecklist.tsx                   — 6-prerequisite live indicator (Q-IAP.h.3)
    ScreenshotUpload.tsx                  — dropzone + 8 MB validation
```

### Cross-cutting reuse from CPP / Store

| What | From | Notes |
|---|---|---|
| Apple credentials | `lib/asc-account-repository.ts` + `asc-jwt.ts` | Q-IAP.1 — same `asc_accounts` table; `generateAscToken()` shared |
| Active account resolution | `lib/get-active-account.ts` | shared session.activeAccountId path |
| `xlsx` library | already installed | dynamic import pattern from `parseMetadataXlsx.ts` |
| `withRetry` shape | mirrored from `lib/store-submissions/gmail/client.ts` | adapted for Apple 429 + AppleApiError class |
| `iapDb()` wrapper | mirrored from `lib/store-submissions/db.ts` | schema isolation per CLAUDE.md #9 |
| `requireIapAdmin` pattern | mirrored from store_mgmt auth | Q-IAP.8 reuse global admin/member |
| Dropzone + upload | mirrored from `components/upload/AssetUploader.tsx` | bulk screenshot reuse |

---

## Backlog (Manager decision-set)

In Manager-stated priority order:

1. **Next feature (Manager will signal)** — fresh strategic kickoff.
2. **Dark mode polish** — IAP.j2 component refactor full cross-tool (apps grid, IAP list table, HubPage cards, TopNav, CPP modules, Store Submission modules). Effort: ~3-4h. Dual-class shim approach proven; mechanical.
3. ~~**D2 — Per-IAP pricing schedule POST**~~ — ✅ resolved at IAP.o.11d.
4. ~~**D3 — Edit-of-synced-IAP PATCH propagation**~~ — ✅ resolved at IAP.o.12.
5. **IAP.o.13 candidate — `contentHosting` + `availableInAllTerritories` edit support.** These attributes are NOT in `InAppPurchaseV2UpdateRequest`; Apple exposes them via dedicated child endpoints (e.g. `/v1/inAppPurchaseAvailabilities`). Investigation: ~2-3 h OpenAPI audit + Manager workflow priority assessment; implementation: ~3-4 h. Manager to surface explicit need.
5. **D1 polish — single-IAP Submit screenshot upload** — currently catch-22; resolution = same multi-step orchestration the bulk path uses (~1h to extract + share).
6. **Integration test layer** — Playwright or similar for the post-token-migration E2E coverage gap surfaced at IAP.l.

---

## Pre-flight for any future Supabase deploy

```bash
# 1. Apply all 3 migrations (chronological)
supabase db push

# 2. Add iap_mgmt to PostgREST exposed schemas (Dashboard → API)
#    Otherwise queries return 500 (root cause of UAT MV29.A failure)

# 3. Verify (in SQL Editor):
SELECT relname, relrowsecurity FROM pg_class
WHERE relnamespace = 'iap_mgmt'::regnamespace AND relkind = 'r'
ORDER BY relname;
-- All 8 rows: relrowsecurity = false (post IAP.o.1)

SHOW pgrst.db_schemas;  -- substring 'iap_mgmt' present

SELECT grantee, COUNT(*) FROM information_schema.role_table_grants
WHERE table_schema = 'iap_mgmt' GROUP BY grantee;
-- service_role + authenticated non-zero counts
```

Full pre-flight + UAT scenarios: [docs/iap-management/UAT-MV28-30.md](./UAT-MV28-30.md).

---

## Fresh-session resumption template

Use this prompt shape in a new Claude Code session when continuing IAP work or kicking off the next feature:

```
Project: appstore-connect-cpps (Next.js 14 + TS + Supabase).
Prior arc closed: IAP Management module shipped 2026-05-15.
  - Final commit: a5503ad
  - Summary: docs/iap-management/SESSION-ARC-2026-05-15-summary.md
  - UAT brief: docs/iap-management/UAT-MV28-30.md
  - Backlog: see summary §"Backlog" — Manager prioritises:
      1. <next feature name>
      2. Dark mode polish (IAP.j2 component refactor)
      3. D2 pricing schedule sync
      4. D3 edit-of-synced PATCH
Current task: <task description>
```

Manager's standard scope-investigation protocol applies — read CLAUDE.md, surface findings before implementing, surface mid-flow trigger-condition events.

---

## Sign-off

- **3 strategic arcs delivered cohesively this trajectory**: Phase E (PR-Reports.RejectReasons) → ForwardDedup (PR-Inbox.ForwardDedup) → IAP Management. Manager-stated milestone achieved.
- **IAP Management arc**: Functional MVP shipped at IAP.o.5; IAP.o.6 → IAP.o.11 hotfix run addressed UAT MV30 2-stage workflow + Apple-side pricing silent-fail. Visual polish (dark mode full migration) remains in backlog.
- **Pattern 10 reuse #19 cycle 29**: ongoing through IAP.o.11. Discipline preserved through 36 commits (18 strategic + 18 hotfix), Manager refinement iterations 35+, 0 mid-implementation hotfixes (all hotfixes post-UAT).
- **IAP.o.11 status**: instrumentation + retry/poll hardening shipped; Manager v5 re-test will surface root cause via Railway logs + `pricing-diagnostic.sql` runbook. If v5 still fails silently, the orchestration code path is the next suspect (audit log + Railway tail will pinpoint exit point).
- **Next session boundary**: post-v5 re-test verdict. If green, IAP arc closes definitively. If amber, IAP.o.12 = surgical fix based on instrumentation findings.
