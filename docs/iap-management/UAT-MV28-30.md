# IAP Management — Manager UAT MV28-30

**Status**: Ready for Manager UAT execution.
**Scope**: Verifies the IAP Management module MVP shipped over 12 sub-chunks (IAP.c–IAP.l) plus pre-flight + IAP.m verification.
**Architecture invariants**: CLAUDE.md schema isolation (#9), forward-only migrations (#7), service-role-only RLS.

---

## Pre-UAT setup (one-time)

Run in this order before executing any scenario.

### 1. Apply migrations to the Supabase target

```bash
# Production / staging (whichever environment you want to UAT against)
supabase db push
# OR if running locally against a Docker Supabase:
supabase migration up
```

Two migrations land for this arc:

| File | Adds |
|---|---|
| `supabase/migrations/20260515000000_iap_mgmt_init.sql` | `iap_mgmt` schema + 8 tables + RLS-on-no-policies |
| `supabase/migrations/20260515010000_iap_mgmt_tier_id_text.sql` | `tier_id` INT → TEXT to support Alternate Tiers (Manager follow-up answer C) |

Verify post-apply:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'iap_mgmt' ORDER BY table_name;
-- Expected 8 rows:
--   actions_log, apps, iap_localizations, iap_screenshots,
--   iaps, import_batches, price_tier_territories, price_tiers
```

### 2. Confirm environment variables

| Var | Required | Notes |
|---|---|---|
| `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Same project as CPP + Store modules |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | IAP queries are service-role-only |
| `ASC_ACCOUNTS` (or legacy `ASC_KEY_ID/ASC_ISSUER_ID/ASC_PRIVATE_KEY`) | ✅ | Reused from CPP Manager — Q-IAP.1 lock |
| `ADMIN_EMAILS` | ✅ | Manager email here = admin role = unlock IAP write actions (Q-IAP.8) |
| `GOOGLE_ALLOWED_EMAILS` | ✅ | NextAuth Google whitelist |

After changing `ADMIN_EMAILS`: restart dev/prod **and** sign out → sign in (NextAuth caches role in JWT — see CLAUDE.md "Lessons learned #1").

### 3. Confirm template fixtures (already committed)

```bash
ls -la docs/iap-management/templates/
# Expected:
# - price-tiers-template.xlsx  (95 data rows: Free + Tier 1..87 + 7 Alternates)
# - item-iap-template.xlsx     (3 sample rows: com.vng.example.product{1,2,3})
# - sample-screenshots/com.vng.example.product{1,2,3}.jpg
```

### 4. Start the dev server (UAT against `npm run dev`)

```bash
npm run dev
# Open http://localhost:3000 — Google SSO → hub
```

---

## MV28 — Module registration

Tool-peer scaffolding is wired correctly.

| # | Scenario | Action | Expected |
|---|---|---|---|
| 28.1 | Hub card visible | Land on `/` after sign-in | Three tool cards: CPP Manager, Store Management, **IAP Management** (ShoppingBag icon). Grid is `grid-cols-2 md:grid-cols-3` — verify by resizing browser ≤ 768 px (2-up grid) vs ≥ 768 px (3-up grid). |
| 28.2 | Sidebar nav-item | Sidebar (icon rail) shows 3 tool icons | Layers (CPP), Inbox (Store), ShoppingBag (IAP) in that order. Hover the rail → flyout labels match. |
| 28.3 | Click IAP card / sidebar entry | Navigate to `/iap-management` | Redirects to `/iap-management/apps` (the canonical landing). |
| 28.4 | Sidebar Settings shortcut, IAP context | From any `/iap-management/*` route click the Settings gear icon | Lands on `/iap-management/settings/pricing-tiers` (not the global `/settings`). |
| 28.5 | Sidebar Settings shortcut, CPP context | Same Settings icon from `/apps` or `/apps/[appId]/*` | Lands on global `/settings` (no regression). |
| 28.6 | Sidebar Settings shortcut, Store context | Same Settings icon from `/store-submissions/*` | Lands on `/store-submissions/config/settings` (no regression). |
| 28.7 | Theme toggle present | Sidebar icon rail between tool icons and Settings | Sun/Moon button visible. Hover flyout shows a labeled "Light mode" / "Dark mode" row. |
| 28.8 | Theme toggle persistence | Click toggle, refresh page | Theme survives (localStorage). Note: full UI darkening lands in IAP.j2 — currently only the page `body` background flips. Toggle is functional + persisted. |
| 28.9 | Theme system default | Clear localStorage, set OS to dark mode, reload | Body background follows OS preference (`defaultTheme="system"` + `enableSystem`). |

---

## MV29 — Core IAP workflows

End-to-end pricing import + IAP CRUD + bulk import.

### MV29.A — Pricing Tiers Settings

| # | Action | Expected |
|---|---|---|
| 29.A.1 | Sign in as **admin** email | Hub renders. Sidebar Settings → `/iap-management/settings/pricing-tiers`. |
| 29.A.2 | Sign in as **member** email | `/iap-management/settings/pricing-tiers` redirects to `/` (Q-IAP.8 admin gate). |
| 29.A.3 | Empty cache initial state | Stats card shows `0 / 0 / 0 / —`. Empty-state callout: "No tiers yet". |
| 29.A.4 | Import the template | Click "Import .xlsx" → select `price-tiers-template.xlsx` | Toast: "Imported 95 tiers (7 alternate) × 175 territories." Stats card updates: `Total 95 · Alternate 7 · Territories 175 · Imported <timestamp>`. Tier table renders standard tiers first, then a "Alternate tiers (7)" section break, then ALT_1..5, ALT_A, ALT_B. |
| 29.A.5 | Re-import (replace semantics) | Click "Import .xlsx" → select the same file | Q-IAP.7 lock — wipes + reinserts. Tier count remains 95. New `imported_at` timestamp. `iap_mgmt.import_batches` gains a 2nd row with `status='COMPLETE'`. |
| 29.A.6 | Import a malformed file | Rename any non-xlsx to `.xlsx` and try to import | 422 error toast with parser message: "Price-tiers template could not be read…" |
| 29.A.7 | Audit trail | `SELECT * FROM iap_mgmt.actions_log WHERE action_type='PRICE_TIER_IMPORT' ORDER BY created_at DESC;` | Two rows from steps 29.A.4 + 29.A.5, each with `payload->tier_count=95`, `alternate_count=7`. |

### MV29.B — IAP list view

| # | Action | Expected |
|---|---|---|
| 29.B.1 | `/iap-management/apps` | Apps grid from Apple ASC API. Click any app → `/iap-management/apps/[appId]`. |
| 29.B.2 | IAP list, app with existing Apple IAPs | Table shows productId, reference name, type badge (color-coded per type), state badge. Filters work (Type, State, search). |
| 29.B.3 | IAP list, app with no IAPs | Empty state: "No IAPs for this app. Use Bulk Import or Create IAP to populate." |
| 29.B.4 | Drafts section | If any local drafts exist (created in 29.C below), an amber "Local Drafts · N" section renders above the Apple-synced table with Edit links. |

### MV29.C — Single-IAP create (draft → submit)

| # | Action | Expected |
|---|---|---|
| 29.C.1 | "+ Create IAP" button | Navigate to `/iap-management/apps/[appId]/iaps/new` (dedicated route per Q-IAP.h.1). |
| 29.C.2 | Locale sidebar | Left 240 px sidebar lists all 39 Apple locales. Default selection: English (U.S.). Search filter works. |
| 29.C.3 | Fill an English (U.S.) locale | Display Name + Description | Sidebar dot turns green for en-US. Checklist "≥ 1 localization filled" → green. |
| 29.C.4 | Partial fill (e.g. Vietnamese: Display Name only) | Sidebar dot turns amber. Locale not counted toward checklist (paired integrity). |
| 29.C.5 | Submit checklist | All 6 items render with green check or grey icon | Items: reference_name, product_id, type, tier, localization, screenshot. Submit button stays disabled until all green. |
| 29.C.6 | Save as Draft | Fill basic info + tier + ≥1 locale → click "Save as Draft" | DB row inserted in `iap_mgmt.iaps` with `apple_iap_id=NULL`. Toast: "Draft saved". Redirects to edit page `/iap-management/apps/[appId]/iaps/[iapId]`. |
| 29.C.7 | Screenshot upload on edit page | Drag a PNG/JPEG ≤ 8 MB into the drop zone | POST to `/api/iap-management/iaps/[iapId]/screenshot` succeeds. `iap_mgmt.iap_screenshots` row inserted with `apple_id=NULL` (real Apple upload happens at Submit per deferral 1 lock). Checklist "screenshot" turns green. |
| 29.C.8 | Submit gating | With checklist not fully green | Submit button is disabled. Tooltip: "Complete the checklist first." |
| 29.C.9 | Submit to Apple — happy path | All 6 green → click "Submit to Apple" | Server orchestrates: POST `/v2/inAppPurchases` → POST `/v1/inAppPurchaseLocalizations` per locale → POST `/v1/inAppPurchaseSubmissions`. Toast: "Submitted to Apple Review". DB row gets `apple_iap_id` + `state='WAITING_FOR_REVIEW'`. `actions_log` gets a `SUBMIT_TO_APPLE` row with payload result=SUCCESS. |
| 29.C.10 | Submit error — invalid credentials | Temporarily break `ASC_ACCOUNTS` (e.g., bogus private key) → resubmit | Toast: "Apple credentials are invalid. Check Settings → ASC Accounts." `actions_log` gets SUBMIT_TO_APPLE with `payload.result='ERROR'` + `apple_status=401`. Friendly mapping verified. |

### MV29.D — Bulk import wizard

| # | Action | Expected |
|---|---|---|
| 29.D.1 | "Bulk Import" button | Navigate to `/iap-management/apps/[appId]/bulk-import` (dedicated route, not modal). |
| 29.D.2 | Step 1 upload | Drop `item-iap-template.xlsx` | Success card: "3 IAPs · 39 locale pairs detected. Type source: 0 from column, 3 defaulted to Consumable." |
| 29.D.3 | Type-column branches | Open the .xlsx, set Type col for row 2 to "NON_CONSUMABLE", save, re-upload | Success card updates: "Type source: 1 from column, 2 defaulted to Consumable." Step 3 row 2 Type badge reads `non consumable` with a `column` mini-badge. |
| 29.D.4 | Type-column invalid value | Set Type col for row 2 to "INVALID" | Parser throws a 422 error during Step 1 with message: "Invalid Type value 'INVALID'. Expected CONSUMABLE / NON_CONSUMABLE / NON_RENEWING_SUBSCRIPTION." |
| 29.D.5 | Step 2 screenshots | Drop the three `com.vng.example.product{1,2,3}.jpg` samples | Tally: Matched 3 / Unmatched 0 / Missing 0. Per-file table shows method = "literal" (dots preserved) for all 3. |
| 29.D.6 | Step 2 normalized matcher | Rename one sample to `com_vng_example_product1.jpg` (dots → underscores) and re-add | Match method = "normalized" (Q-IAP convention C robust both-forms). |
| 29.D.7 | Step 3 preview | Conflict policy `Overwrite`. All 3 are new productIds (no Apple conflict). | Counts: Create 3 / Overwrite 0 / Skip 0 / Error 0. Tier column shows `TIER_1` for all 3 (price $0.99 → TIER_1 lookup via `resolveTierByUsdPrice`). |
| 29.D.8 | Step 3 conflict toggle | Manually run 29.D up to Step 3, then re-run another bulk import with the same productIds | Conflict rows show "Overwrite" badge. Click the per-row Action toggle → flips to "Skip" (Q-IAP.8 per-item override). |
| 29.D.9 | Step 3 tier mismatch | Edit one row's Price (USD) cell to a non-tier value (e.g., 1.50) | That row's disposition becomes "Error" with reason "Price $1.5 does not match any Apple tier." |
| 29.D.10 | Step 4 execute | Click "Execute (3 IAPs)" | Concurrency 5 parallel per Manager investigation lock. Each IAP orchestrates Apple create → localize → screenshot 3-step (deferral 1 absorbed). Result table per IAP: SUCCESS / SKIPPED / ERROR. `iap_mgmt.import_batches` row created with status COMPLETE + counts. `actions_log` gets a `BULK_IMPORT_BATCH` row + per-IAP `CREATE_IAP` rows with `type_source` + `tier_source='PRICE_USD_LOOKUP'` + `resolved_tier_id`. |
| 29.D.11 | Step 4 partial failure | Force one row to fail (e.g., productId Apple-rejects due to existing-on-another-app conflict) | Other 2 succeed; failed row shows ERROR with stage + Apple body excerpt. Batch status = COMPLETE with `failed_count=1`. |

---

## MV30 — Apple API integration deep-dive

Verifies the trickier Apple orchestration edges flagged in commit bodies.

| # | Scenario | Expected |
|---|---|---|
| 30.1 | Rate-limit retry | Trigger Apple 429 (rare; usually requires sustained bulk). Mock by reducing your account quota, OR observe in Sentry/`logger` output during a real bulk of 50+ IAPs. | `withRetry` from `lib/iap-management/apple/fetch.ts` retries up to 3 times with `Retry-After` honored (capped at 10 s). After exhaustion, surfaces "Apple rate limit reached. Wait a minute and try again." |
| 30.2 | Submit flow stages | After 29.C.9 succeeds | DB `iap_mgmt.iaps` row has: `apple_iap_id != NULL`, `state='WAITING_FOR_REVIEW'`, `synced_at` recent. `iap_localizations` has one row per filled locale. `iap_screenshots` row has `apple_id` populated + `uploaded_at` set (post-submit upload, per deferral 1 absorption — verify by checking timestamps). |
| 30.3 | Screenshot 3-step | Inspect server logs during bulk execute | Three log lines per screenshot: reserve → upload → confirm. Filename + size match the file dropped in the wizard. MD5 checksum computed server-side. |
| 30.4 | Apple validation error friendly mapping | Trigger 422 from Apple (e.g., reference name with disallowed chars at submit) | Toast text from `friendlyError()` in submit route: "Apple validation failed during submission: ..." with truncated Apple body. |
| 30.5 | Conflict on second create attempt | Submit an IAP, then create another draft with the SAME productId, then submit | Apple returns 409 → friendlyError: "Apple reports a conflict (409) during create. The IAP may already exist with this productId." |
| 30.6 | OVERWRITE path in bulk | Run a bulk import where one productId exists on Apple, override defaults to OVERWRITE | Apple PATCH to existing inAppPurchase → DELETE existing localizations → POST new locales. Screenshot is NOT replaced (v1 limitation — documented in IAP.i commit body). Verify in Apple Connect that the IAP's name + locales are updated, screenshot preserved. |
| 30.7 | Account switcher consistency | Switch active ASC account via AccountSwitcher in TopNav | All IAP routes use `getActiveAccount()` — verify by checking `/iap-management/apps` reflects the switched account's app list. |

---

## Verdict recording

After each section, mark Pass / Fail. Track in this format:

```
MV28 (9 items):  ✅ Pass / ❌ Fail — notes:
MV29.A (7):      ✅ Pass / ❌ Fail — notes:
MV29.B (4):      ✅ Pass / ❌ Fail — notes:
MV29.C (10):     ✅ Pass / ❌ Fail — notes:
MV29.D (11):     ✅ Pass / ❌ Fail — notes:
MV30 (7):        ✅ Pass / ❌ Fail — notes:
```

If all green → IAP Management arc CLOSED COHESIVELY.
If issues found → file IAP.o hotfix sub-chunk with the specific scenario IDs that failed; reproduce locally, fix, re-UAT only the affected scenarios.

---

## Known v1 limitations (out of UAT scope; tracked for future)

| ID | Limitation | Defer target |
|---|---|---|
| L1 | OVERWRITE preserves screenshot (no replacement) | post-MVP follow-up |
| L2 | Per-IAP pricing schedule POST not wired (Apple Connect default applies) | IAP.h2 partially absorbed; full schedule sync = follow-up |
| L3 | Edit-of-synced-IAP PATCH propagation: bulk OVERWRITE works; single-IAP edit is local-only | Q-IAP.h.3 deferral lock — post-MVP if Manager hits frequent edit-of-approved cases |
| L4 | Component class migration to semantic tokens (`bg-card`/`text-foreground`/…) — currently only body bg responds to theme toggle | IAP.j2 — deferrable per scope lock |
| L5 | Bulk import is synchronous (no background job / polling) — for 100+ IAPs at Apple rate limits, may timeout | Background-job follow-up only if real workload hits the boundary |
