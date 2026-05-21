# Google IAP Management — Operational Guide

This is the Manager-facing workflow guide. Each section walks through a
single end-to-end flow with screenshots-worthy steps. For the
developer-facing API reference (endpoints, scopes, priceMicros), see
`google-api-reference.md`.

---

## 0. One-time setup — Service Account preparation

Google IAP Management talks to Google Play with a **Service Account
JSON** key (one per Google Console). To prepare it:

1. Open Google Cloud Console for the project that owns the Google Play
   developer account.
2. **IAM & Admin → Service Accounts → Create Service Account.** Give
   it a descriptive name (e.g. `appstore-cpps-iap`).
3. Grant the Service Account these two roles:
   - `roles/androidpublisher.user` (Publisher API access)
   - `roles/playdeveloperreporting.viewer` (Reporting API access)
4. **Keys → Add Key → Create new key → JSON.** Save the downloaded
   `.json` somewhere safe — Google does not show it twice.
5. Open Google Play Console **→ Users and Permissions**, invite the
   Service Account email, and grant it (at minimum):
   - View app information
   - Manage in-app products
6. Wait ~5 minutes for the permission propagation, then upload the
   `.json` in the tool's Settings page (see § 1).

---

## 1. Settings — uploading a Google Console account

**Route:** `/google-iap-management/settings/google-accounts`

1. Click **Add account.**
2. Pick a friendly display name (Manager-only handle).
3. Choose the Service Account `.json` file.
4. Submit. The credential is AES-256-GCM-encrypted before insert; the
   raw JSON never persists to disk.
5. Click **Verify.** Both Publisher and Reporting scopes are
   exercised. Success flips status → `verified`; failure surfaces the
   error and status → `invalid`.

Multiple accounts are supported (e.g. one per Google developer
account). The top-nav switcher picks which one each tab applies to —
the choice is route-scoped (Q-GIAP.H).

---

## 2. Apps list — refreshing from Google

**Route:** `/google-iap-management/apps`

1. Click **Refresh from Google.** This hits Reporting `apps:search` and
   paginates through every app reachable by the active Service
   Account.
2. The cache is replaced for that account (UPSERT keyed on
   `(account, packageName)`); apps no longer reachable stay in the
   cache but won't be re-synced.
3. Each row links to the app detail page.

If the list is empty after a Refresh, the Service Account either lacks
Reporting access or hasn't been granted any apps in Play Console.

---

## 3. App detail — refreshing IAPs

**Route:** `/google-iap-management/apps/[packageName]`

1. Click **Refresh** to sync IAPs for this app from Publisher
   `inappproducts.list`. Cache is replaced; previously cached IAPs no
   longer in Google's list are removed.
2. Each IAP row shows default title (en-US), SKU, base price, status,
   purchase type, and last-synced timestamp.
3. Click the title or SKU to open the **Edit IAP** form for that SKU.
4. Click **New IAP** to open the **Create IAP** form.
5. Click **Bulk import** to open the wizard.

---

## 4. Create a single IAP

**Route:** `/google-iap-management/apps/[packageName]/iaps/new`

1. **Identification**
   - SKU: required. Letters, numbers, underscores, dots, dashes only.
     Apple-style format (`com.example.gem_pack_small`) is conventional.
   - Purchase type: `managed` or `consumable` (consumable is a
     client-acknowledgment behaviour, both serialise the same way).
   - Status: `active` by default (Q-GIAP.I).
2. **Listings** (multi-locale, Q-GIAP.J)
   - Pick a locale in the left sidebar; the default `en-US` must have
     a title.
   - Title cap 55 chars, Description cap 200.
3. **Pricing**
   - Pick a source — `Google default`, `Default Template`, or
     `App-specific Template` (see § 7 for what each does).
   - Set base price decimal + currency.
   - Optionally open Region overrides and add per-region price rows.
4. Click **Create on Google Play.** The server signs the JWT, posts
   to `inappproducts.insert`, syncs the cache, audit-logs the action.

If Google rejects the request, the error message surfaces inline above
the submit button.

---

## 5. Edit an existing IAP

**Route:** `/google-iap-management/apps/[packageName]/iaps/[sku]`

1. The form loads pre-populated from the cache. **SKU is immutable** —
   Google Play does not allow renaming.
2. Edit any field. Adding / removing locales or regions is allowed
   — they're map fields and the orchestrator replaces wholesale.
3. Click **Review changes.** A modal opens with three buckets:
   - Attributes (status, base price, currency, …)
   - Listings (Added · Modified · Removed) per locale
   - Region pricing (Added · Modified · Removed) per region
4. Click **Confirm update.** The server posts the new state via
   `inappproducts.patch`, syncs the cache, and records the full diff
   in the IAP_UPDATE audit entry.

If the diff is empty (i.e. you opened the form and clicked Review
without changes), the modal disables Confirm.

---

## 6. Bulk import

**Route:** `/google-iap-management/apps/[packageName]/bulk-import`

The wizard has four steps:

### Step 1 — Pricing source

Pick `Google default`, `Default Template`, or `App-specific Template`
for the **entire batch.** Template-mode rows are matched to a tier by
**SKU = tier identifier**; rows without a match fall back to inline
USD + GT Price.

### Step 2 — Upload

Drop or browse a `.xlsx` matching the template format
(`docs/google-iap-management/templates/template-item-iap-google.xlsx`).
Max 5 MB. The Manager's template currently has:

- Column A: **Product ID** (SKU)
- Column B: **Price (USD)** decimal
- Columns C–D: **GT Price** + **GT Currency** (optional override
  derived from currency → primary region)
- Columns E+: paired `Title (LangName)` / `Description (LangName)` per
  locale (82 supported)

### Step 3 — Preview

The wizard parses the file and shows every row with its existence
status (New · Exists). For existing SKUs, pick **Overwrite** or
**Skip** — Continue is gated until every row has a decision. Bulk
actions ("Set all Overwrite" / "Set all Skip") apply to existing rows
only.

Parse warnings (unrecognised locale columns, unmapped GT currencies,
mismatched GT Price/Currency pairs) appear in a collapsible amber
panel — they're informational; the rest of the import proceeds.

### Step 4 — Execute

The server fires a single `inappproducts.batchUpdate` call with
`allowMissing: true` (so the same call inserts new SKUs and updates
existing ones). When the response returns, the cache is synced row by
row and the result panel shows Created / Overwritten / Skipped /
Failed counts.

**Cap:** 100 actionable rows per call. The wizard surfaces an error if
exceeded; split the file.

---

## 7. Pricing templates

**Route:** `/google-iap-management/settings/pricing-templates`

Three tabs:

### Google Default Reference

Informational. Explains Google's auto-equalisation behaviour and the
resolution order at IAP create / import (App Template > Default
Template > Google default).

### Default Template

- **Upload / Replace:** one Default Template at a time, replace-on-
  upload (delete-then-insert under the partial unique index).
- **Remove:** drops the template; IAPs that picked
  `default_template` previously continue to exist with their
  already-published prices — the template only affects future
  resolutions.
- Header summary: Tiers × Regions × Entries × Uploaded by.
- Sample table shows the first 50 entries for sanity-checking.

### Per-App Templates

- Pick an app from the dropdown; apps that already have a template
  are annotated `· has template`.
- Upload — overrides Default for IAPs of that app that pick
  `app_template`.
- Each row in the list has a Remove button.

The template file format is documented in
`google-api-reference.md` § 9; the v1 file is
`docs/google-iap-management/templates/pricing-template-google.xlsx`
(sheet `price_tiers`, identifier column A, region columns B+ as
`CC - CUR - Country Name`).

---

## 8. Diagnostics

- **Settings → Verify fails** with permission error → Service Account
  is missing one of the two roles or the Play Console invite hasn't
  propagated. Wait 5 minutes and re-Verify.
- **Apps list empty** → Service Account has Publisher access but no
  Reporting role, OR Play Console hasn't granted any apps.
- **IAP refresh fails 404** → the package isn't reachable by this
  Service Account; check Play Console permissions.
- **Bulk import says "exceeds Google's per-call cap (100)"** → split
  the input file into ≤100-row chunks.
- **Tier dropdown empty** in the form → the template was uploaded but
  has zero parsed entries; re-upload the file (check the sheet name is
  `price_tiers` and headers match `CC - CUR - Name` format).
- **Stale cache after manual change on Google Play UI** → click
  Refresh on Apps or App detail. The tool's cache only updates on the
  tool's own writes (single IAP / Bulk Import) or explicit Refresh.
