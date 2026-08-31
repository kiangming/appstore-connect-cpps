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

### 3.1 Export list — download the app's IAPs as .xlsx

Click **Export list** on the app detail page. A dialog opens to pick which
country price columns to include; **Export** downloads
`IAP-export-<package>-<YYYYMMDD>.xlsx`.

The file is read **live from Google**, not from the tool's cache — so it
reflects Google Play at the moment you click, even if the list on screen was
synced earlier. It costs **one** Google API request regardless of how many
items the app has.

Layout: one row per SKU. Fixed columns `Product ID · Product Name · Status`,
then a **Price / Currency** pair for each country, then a **Locale Code /
Description** pair per localization.

**Country column headers read `Price in Vietnam (VN)`** — the market name with
its ISO 3166-1 alpha-2 code in parentheses. The code is kept because a
spreadsheet is read away from the tool, where the name alone cannot be matched
back to the key.

> ⚠ **The country names are ISO names, not Google's names.** Google publishes
> no country-name list through its API — `convertRegionPrices` returns a
> region code and a price and nothing else — so the tool resolves names from
> the `i18n-iso-countries` package, plus 18 hand-checked overrides that match
> what Google Play Console renders (United States, South Korea, Taiwan,
> Vietnam, Macau, Russia and 12 more).
>
> Outside those 18, expect the ISO wording, which is sometimes stiffer than
> Play Console's. Real examples from the current list:
>
> | Code | Header in the file |
> |---|---|
> | `VA` | `Price in Holy See (Vatican City State) (VA)` |
> | `VG` | `Price in Virgin Islands, British (VG)` |
> | `FM` | `Price in Micronesia, Federated States of (FM)` |
> | `CI` | `Price in Cote d'Ivoire (CI)` |
>
> These are correct, not bugs. If one of them should read differently, say
> which label Play Console shows and it becomes a new override — the override
> list is only ever extended from a label someone has actually read on screen.

If a country code has no name at all, the header shortens to the bare code
(`Price in ZZ`) rather than repeating it as `Price in ZZ (ZZ)`. No market
Google currently sells in falls into this case; a test fails loudly if one
ever starts to.

> ⓘ **Changing shortly.** The item selection and Active/Inactive filter
> (chunks X2-X3) and the country list in the dialog (chunk X4) are not yet
> built — today the export always covers every item, and the country picker
> still offers a list that is not Google's. This section will be extended as
> each ships.

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
     `Google Conversion` (see § 7 for what each does). The three cards
     load, grey-with-reason and auto-select by priority exactly as in Bulk
     Import Step 1 (§ 6) — the same component drives both, so Create /
     Edit cannot be submitted until the availability check resolves.
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
4. Click **Confirm update.** The server posts the new state, syncs the
   cache, and records the diff **plus the verified outcome** in the
   IAP_UPDATE audit entry.

If the diff is empty (i.e. you opened the form and clicked Review
without changes), the modal disables Confirm.

### 5.1 Base price and tiers — how country prices are decided

**The base price is the single source for every country price.** Picking a
tier is just a fast way to set the base: the base jumps to the tier's
**USD** figure (Google's pricing templates use a fixed `Price (USD)`
column, so that number is the tier's canonical price).

Both actions mean the same thing — *recalculate every country from this* —
and each one overwrites the last, as many times as you like:

| # | You do | What happens |
|---|---|---|
| 1 | Pick a tier | Base jumps to the tier's USD price; ~170 country prices recalculated from the tier |
| 2 | Type a different base price | ~170 country prices recalculated from the new base |
| 3 | Pick a different tier | Base jumps again; ~170 recalculated again |
| 4 | … | No limit — the last action wins |

The recalculated prices appear in the per-country table **before** you
save, so you can review (and then hand-adjust) them.

> ⚠ **A recalculation replaces EVERY row, including prices you typed by
> hand.** If any hand-typed price would be lost, the tool asks first and
> tells you how many — Cancel changes nothing. It never recalculates and
> then tells you afterwards.

### 5.2 Why an untouched price may show a warning instead of an error

Some prices on Google carry more decimal places than the tool's currency
table expects (production has one: `com.vng.passsdk.2508111020`,
TW = TWD 6.30, where the tool treats TWD as whole-number-only).

**The tool never rounds, trims or "fixes" a value that came from Google.**
It shows every decimal, and a row you have not touched is sent back to
Google byte-for-byte, exactly as received.

So such a row shows an amber **warning**, not a blocking error — you can
still edit and save anything else on the item. It only becomes a blocking
error once *you* type into that row, because then it is your value to fix.
If you want TWD 6.30 to become something else, change it deliberately —
the tool will not decide that for you.

### 5.3 "Sync from Google" mid-edit

**Sync from Google** replaces the tool's stored prices with Google's live
values and reloads the form. Rows you have not edited are refreshed;
**rows you typed by hand are kept.** If a row you edited ALSO changed on
Google, the tool shows both values side by side with *Keep mine* /
*Take Google's* — it will not choose for you.

(Note this is the opposite of a tier/base recalculation, which does
overwrite hand-typed rows. A sync is data arriving from Google; a
recalculation is you telling the tool to recompute.)

### 5.4 If the update did not actually change anything

After every update the tool re-reads the item from Google and compares it
against what it sent. If Google's state did not move, the result is
reported as **no changes**, not success, and the server log carries:

```
[google-iap:update-iap] NO-OP WRITE pkg=… sku=… requested_base=… applied_base=… …
```

A partially-applied write logs `PARTIAL WRITE` with the region list. If
you see either, the item on Google is NOT what the review modal showed —
re-check on Play Console before assuming the change landed.

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

**The step has three states**, because the tool has to ask which pricing
templates exist before it can offer them:

| State | What the operator sees |
|---|---|
| Checking | All three cards **disabled**, nothing selected, "Checking which pricing templates are available…". **Continue is disabled** — the tool does not pick a source on your behalf. |
| Resolved | Available sources become selectable; unavailable ones are greyed **with a reason** ("No default template uploaded — add one in Settings → Pricing Templates"). The tool then auto-selects by priority — **App-specific Template → Default Template → Google Conversion** — and that choice is visibly ticked, never applied silently. |
| Check failed | Error banner + **Retry**. Both template cards stay disabled (their existence is genuinely unknown); `Google Conversion` is enabled and selected, since it needs no template. |

Before August 2026 the step pre-selected `Google Conversion` on load,
because the other two need an async check. That read as "the templates are
broken", and let operators import under a source they never chose.

The same behaviour applies to the single-IAP Create / Edit form (§4) — one
shared component, so the two surfaces cannot drift.

Individual items can override the batch source with **per-item Custom
prices** in Step 3 — under **any** of the three sources. See below.

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

Any row can override the batch source for itself, under **all three**
pricing sources. In the **Tier** column click `Custom…` (rows with several
matching tiers get it as the last entry in the tier dropdown). The dialog
lists every country Google sells in, with search (name / ISO code /
currency) and continent filters.

**What "custom" means depends on the source — this is the rule that bites.**

| Source | Semantics | App-currency entry required? |
|---|---|---|
| `Default Template` · `App-specific Template` | **REPLACES** the tier's whole price set. The dialog pre-fills from the tier. | **Yes.** Because the custom set replaces everything, it is the only possible source of `defaultPrice`. Missing ⇒ the row is refused with `custom_no_app_currency_entry`; the dialog blocks Save so you find out before pushing. |
| `Google Conversion` | **SPARSE OVERLAY.** Set only the countries you want; every blank country still gets Google's automatic conversion. The dialog opens **empty** — nothing is pre-filled. | **No.** `defaultPrice` comes from the file's base price. Overriding three countries, none of them in the app's currency, is legitimate. If you *do* set an app-currency price, it wins over the base price. |

Rules that hold under every source:

- **Currency is fixed per country** and shown as a chip — it is Google's
  billing currency for that market, not something you pick.
- **A blank price is not "no price".** It reads
  `inherits — Google conversion`: at push, Google converts the item's
  default price into that country. **set price** opens the field.
- **Save is blocked on a currency-precision error** — VND/JPY take whole
  numbers, KWD takes 3 decimals. Same rules as the item Edit form.
- **Prices ≥90% below the reference get a non-blocking warning.** The
  reference is the *tier's price* under a template source, or *Google's
  converted price* under Google Conversion. The tool has no per-country
  minimum table — Google enforces floors at push and reports no per-row
  reason, so one below-floor price can fail the whole batch. It is a
  heuristic, not a guarantee.

Once saved the row shows `Custom · N countries` with **View / edit** and
**Clear**. Custom prices are **absolute**: they are no longer tied to the
template and will not change if you switch templates.

**Reverting** — any of: `Clear custom prices` in the dialog, `Clear` on the
row (with an Undo toast), or picking a real tier again from the row's
dropdown. All three drop the custom set so the row falls back to the batch
pricing source.

**What survives what**

| You do this | Custom prices |
|---|---|
| Back to Step 1, change the source (including to `Google Conversion`), re-preview | **Kept and still sent.** The dialog then says "no longer tied to a template" and shows the current source's values for comparison |
| Upload a **different file** at Step 2 | Kept for SKUs still in the file, dropped for the rest — the banner names both lists |
| Set the row to **Skip** | **Kept but not sent** — the chip greys out with "inactive — this row is set to Skip, so nothing is sent". Un-skipping reactivates it. This is the *only* thing that deactivates a custom set |
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
| `custom_no_app_currency_entry` | **Template sources only.** No priced country used the app's own currency, so Google had no default price to use. Normally the dialog blocks this at Save. Cannot occur under `Google Conversion`, where the base price supplies the default. |

> `custom_source_mismatch` was retired in August 2026. It refused custom
> prices on a `Google Conversion` batch, which is now a supported
> combination.

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
- **Update said "no changes" but you did change something** → the tool
  verified against Google after writing and Google's state had not moved
  (see §5.4). Grep the server log for `NO-OP WRITE`. This is the tool
  refusing to claim a success it could not confirm — it is not a display
  glitch.
- **A country price shows an amber warning you did not cause** → the value
  came from Google with more decimals than that currency normally allows
  (see §5.2). It does not block saving and it is sent back unchanged.
- **Price precision audit across the whole cache** → run the runbook at
  `docs/google-iap-management/diagnostics/price-precision-audit.md`.
