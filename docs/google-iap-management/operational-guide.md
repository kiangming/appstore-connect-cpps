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
   - Pick a source — `Default Template`, `App-specific Template`, or
     `Google Conversion` (see § 7 for what each does).
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

Pick `Default Template`, `App-specific Template`, or `Google Conversion`
for the **entire batch** (that is the order the cards appear in).
Template-mode rows are matched to a tier by **SKU = tier identifier**;
rows without a match fall back to `Google Conversion` — inline base price
+ GT Price, converted by Google into every other country.

> `Google Conversion` was labelled `Google default` before August 2026.
> Only the label changed: the stored value is still `google_default` in
> `import_batches.pricing_source` and in every historical audit-log entry,
> so old batches and SQL queries are unaffected.

Under either template source, individual items can override the template
with **per-item Custom prices** in Step 3 — see below.

### Step 2 — Upload

Get the template via **Download bulk import template** on the Apps list
page (no need to enter the wizard), or **Download template** in the
wizard header — visible at every step. Both buttons are the same shared
component (`components/ui/shared/DownloadTemplateButton.tsx`) and both
open the **locale picker** first; the file is generated on confirm from
the parser's own column spec
(`lib/google-iap-management/parsers/template-spec.ts`), so it cannot
drift from what the import accepts.

**Locale picker.** Lists all 82 Google Play locales (language ·
country/variant · BCP-47 code; region-less locales show `—` for country,
so the code is the disambiguator). Search matches all three fields;
**Select all shown** applies to the current filter; **Clear all** resets.
NOTHING is pre-ticked and the selection is not remembered between opens.

Selecting nothing is valid and — because nothing is pre-ticked — is the
default one-click output: a **core-columns-only** template. The file name
reflects the selection: `…-template-core.xlsx` (no locales),
`…-template-<N>-locales.xlsx` (partial), and the base
`google-iap-bulk-import-template.xlsx` for the full 82. Two partial
downloads with the same N share a name (the browser de-dupes); the Notes
sheet lists which locales that file actually contains.

⚠ **Core-only + Overwrite destroys listing metadata.** Google replaces a
product's listings with whatever the row carries, so an OVERWRITE row
with no Title/Description leaves the product with a single `en-US`
listing titled with its SKU. The wizard warns in Preview and names the
affected SKUs (see Step 3). Apple has no equivalent risk — it preserves
existing localizations when a row carries none.

Two sheets:

- `IAP Items` — the data sheet (the parser selects it BY NAME, so don't
  rename it). It comes PRE-FILLED with 3 sample rows (Product IDs
  `com.vngg.tool.product.sample01–03`) plus a delete-me note row.
  Replace the samples with your products or delete them: rows keeping
  the sample Product IDs are SKIPPED automatically on import and
  surfaced as an explicit "example row(s) skipped" warning (not an
  error, never imported). A file uploaded with ONLY the samples yields
  zero importable rows — an empty Preview, the most common first-run
  confusion. Any OTHER Product ID in this sheet imports as a real
  store IAP.
- `Notes` — column guide (in English) + the same example rows for
  reading; ignored by the import, safe to leave in the file.

Drop or browse the filled `.xlsx`. Max 5 MB. Columns (matched by
header NAME, not position):

- **Product ID** (SKU) — required
- **Price (USD)** decimal — required. ALWAYS US dollars (fixed header —
  Manager decision): the parser reads the currency from the header
  explicitly, so USD stays USD even for non-USD apps; cross-currency
  resolution (Cycle 43) derives the app-currency price from the
  pricing template
- **GT Price** + **GT Currency** — a REAL per-region store price (e.g.
  `26000` + `VND` = the actual 26,000₫ price for the VN region), NOT an
  exchange rate. Optional; must be filled together (the region is
  derived from the currency)
- paired `Title (LangName)` / `Description (LangName)` per locale (82
  supported)

Legacy files that keep data in the first sheet (e.g. `Sheet1`, like the
old `docs/google-iap-management/templates/template-item-iap-google.xlsx`
artifact) still parse via the first-sheet fallback.

### Step 3 — Preview

The wizard parses the file and shows every row with its existence
status (New · Exists). For existing SKUs, pick **Overwrite** or
**Skip** — Continue is gated until every row has a decision. Bulk
actions ("Set all Overwrite" / "Set all Skip") apply to existing rows
only.

Parse warnings (unrecognised locale columns, unmapped GT currencies,
mismatched GT Price/Currency pairs) appear in a collapsible amber
panel — they're informational; the rest of the import proceeds.

**Listing-loss warning (Google only).** A prominent amber banner appears
whenever rows currently set to **Overwrite** carry no locale data, and it
names the affected SKUs: those products' existing store listings will be
replaced by a single SKU-titled `en-US` listing. It is derived live from
the per-row decisions (flip a row to Skip and it disappears) and is a
WARNING, not a block — overwriting with an SKU-titled listing can be
deliberate. Fix by downloading a template WITH the needed locales,
filling them, and re-uploading — or by setting those rows to Skip.
The underlying cause (the overwrite read-modify-write GET merges purchase
options but NOT listings) is tracked as a backlog item in the Apple KB
§10.13.K P4 follow-ups — not fixed by the warning.

#### Custom prices for one item

Any row can override the template for itself. In the **Tier** column,
click `Custom…` (rows with several matching tiers get it as the last
entry in the tier dropdown). The dialog lists every country Google sells
in, pre-filled from that row's template tier.

- **Currency is fixed per country** and shown as a chip — it is Google's
  billing currency for that market, not something you pick.
- **A blank price is not "no price".** It reads
  `inherits — Google conversion`: at push, Google converts the item's
  default price into that country. The footer counts these separately.
- **Save is blocked** on a currency-precision error (VND/JPY take whole
  numbers, KWD takes 3 decimals — the same rules as the item Edit form),
  and when no priced country uses the app's own currency. Google needs
  that entry to derive the product's default price; without it the row
  would be refused at push, so the dialog stops you here instead.
- Prices far below the template baseline get a **non-blocking warning**.
  The tool has no per-country minimum table — Google enforces floors at
  push and reports no per-row reason, so one below-floor price can fail
  the whole batch. The warning is a heuristic, not a guarantee.

Once saved the row shows `Custom · N countries` with **View / edit** and
**Reset to template**. Custom prices are **absolute**: they are no longer
tied to the template and will not change if you switch templates.

**Reverting** — any of: `Reset all to template` in the dialog, `Reset to
template` on the row (with an Undo toast), or picking a real tier again
from the row's dropdown.

**What survives what**

| You do this | Custom prices |
|---|---|
| Back to Step 1, change template, re-preview | **Kept** — the dialog then says "no longer tied to a template" and shows the new template's values for comparison |
| Upload a **different file** at Step 2 | Kept for SKUs still in the file, dropped for the rest — the banner names both lists |
| Switch to `Google Conversion` | Kept but **inactive** — not sent; switching back to a template source reactivates them |
| Set the row to **Skip** | Kept, not sent |
| **Refresh the page** | **Lost** — all wizard state is in the browser. You get a browser warning first |
| **Import another** | Cleared — that is a new batch |

### Step 4 — Execute

The server fires a single `inappproducts.batchUpdate` call with
`allowMissing: true` (so the same call inserts new SKUs and updates
existing ones). When the response returns, the cache is synced row by
row and the result panel shows Created / Overwritten / Skipped /
Failed / Refused / **Custom** counts. **Custom** is how many items were
priced from a per-item custom set rather than the batch template.

**Refused rows are listed with their reason.** A custom row that cannot
be applied is excluded from the batch and named here — it is NEVER
quietly shipped with the template price instead. Custom refusal reasons:

| Reason | Meaning |
|---|---|
| `custom_invalid_price` | A price broke its currency's precision rules. Fix it in the dialog and re-push. |
| `custom_no_app_currency_entry` | No priced country used the app's own currency, so Google had no default price to use. Normally the dialog blocks this at Save. |
| `custom_source_mismatch` | Custom prices arrived on a `Google Conversion` batch. Should be unreachable from the wizard. |

A refused custom row also makes the run's Hub status **FAILED** rather
than SUCCESS — the Manager asked for a price and it did not get applied,
so reporting success would be wrong. (Cross-currency refusals still count
as a soft skip, unchanged.)

**Cap:** 100 actionable rows per call (`BATCH_MAX`,
`orchestration/bulk-import.ts` — counted AFTER skips, sample rows and
cross-currency refusals, not raw file rows). If exceeded, the tool
throws before anything is sent to Google — no partial import, no
silent truncation — and the wizard surfaces the error at Commit.
Preview does NOT pre-check this cap; split the file and re-run.

---

## 7. Pricing templates

**Route:** `/google-iap-management/settings/pricing-templates`

Three tabs:

### Google Default Reference

Informational. Explains Google's auto-equalisation behaviour and the
resolution order at IAP create / import (per-item Custom > App Template
> Default Template > Google Conversion). A Bulk Import item marked
**Custom** ignores the template entirely — its prices are absolute. The **tab** keeps the name "Google
Default Reference" — it is a read-only benchmark matrix, a different
thing from the `Google Conversion` pricing-source mode.

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
