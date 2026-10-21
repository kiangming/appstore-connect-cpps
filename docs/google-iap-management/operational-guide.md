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
   A refresh counts as **complete** (and lets bulk import run for this app)
   only when every item was cached. If Google returns an **empty** list while
   the tool already holds items for the app, the tool says so in an amber
   notice and does **not** count it as complete — check the app on Play
   Console / the service account's access, then refresh again. A refresh
   that does not count never cancels an EARLIER complete one: an app that
   was refreshed completely before stays importable on that list.
3. Click the title or SKU to open the **Edit IAP** form for that SKU.
4. Click **New IAP** to open the **Create IAP** form.
5. Click **Bulk import** to open the wizard.

---

### 3.1 Export list — download the app's IAPs as .xlsx

Click **Export list** on the app detail page (the button reads **Generating…**
while it works). Export is a **two-step wizard**:

**Step 1 — "Export list — items to include"** (`Step 1 of 2 · countries are
chosen next`)

- **Which items.** Three options with live counts: **All items**,
  **Active only**, **Inactive only**.
- **Which of them.** Below the options, a checkbox list headed
  `Items (N of M selected)`, with **Select all (N)**, an `N selected` counter,
  and a search box (`Search by SKU or name…`). Everything starts ticked, so
  clicking straight through exports the whole app exactly as before.
- Long lists render in pages of 50 with a **Show more** button. ⚠ Rows below
  the fold are **still selected and still exported** — the button says so.
- Search hides rows but never unticks them. If picks are hidden, a line says
  how many, and the `N selected` counter keeps counting them.
- **Select all** applies to everything matching the current search, not just
  what is on screen.
- The button reads **Next — choose countries (N)** where N is what will
  actually be exported. Untick everything and it greys out and reads
  **Select at least 1 item** — the export is refused rather than quietly
  widened back to "everything".
- Changing the status option **resets the ticks** to all items in the new
  option. A selection made against a different set is not carried over.

**Step 2 — "Export options"** — the country picker (`Choose which countries &
currencies to include in the exported file.`), with **Select all** /
**Clear all** and an `N of M selected` counter. The button reads
**Export N countries**. Leaving every country ticked means "no filter".

> ⚠ **"Active" here covers TWO of Google's states.** The dialog says so, in
> these words:
>
> > *Google calls a purchase option ACTIVE or INACTIVE_PUBLISHED; this tool
> > counts both as "Active". "Inactive" is everything else.*
>
> An item Google labels `INACTIVE_PUBLISHED` is filtered as **Active**. That
> is how the whole tool has always classified it, and the note is there so the
> word "Active" is not read as Google's `ACTIVE` alone.

**Counts on screen vs the file.** The counts in step 1 come from the cached
list (last **Refresh**). The file is built **live from Google**. If an item
changed on Play Console since the last Refresh, the file follows Google and
the result message says so — e.g. *"Exported 8 items. 4 items skipped by the
"active" filter. The list on screen showed 9 — Google's live data differs, and
the file follows Google. Refresh to update the list."*

**Cost.** One Google API request per export, whatever you pick. Changing the
filter, searching, or ticking items costs nothing.

---

#### The file

`IAP-export-<package>-<YYYYMMDD>.xlsx`. One row per SKU. Fixed columns
`Product ID · Product Name · Status`, then a **Price / Currency** pair per
country, then a **Locale Code / Description** pair per localization.

**The three fixed columns and both header rows are frozen.** Scroll right
across all 173 country pairs and `Product ID · Product Name · Status` stay in
place; scroll down and the country name plus its `Price / Currency` sub-header
stay in place. Both header rows are frozen, not just the first — the country
name is on row 1 and the word telling you which half of the pair a column is
sits on row 2, so freezing one without the other would strand a price column
away from its own label.

**Country column headers read `Price in Vietnam (VN)`** — the market name with
its ISO 3166-1 alpha-2 code in parentheses. The code stays because a
spreadsheet is read away from the tool, where the name alone cannot be matched
back to the key.

> ⚠ **The country names are the ones Google Play Console shows.** Google
> publishes no country-name list through its API, so the names come from a
> table transcribed from the Console's **Pricing** screen: all 173 markets,
> supplied by the Manager on 2026-09-01, with codes and currencies matched by
> machine against the API (100%, none differing).
>
> **16 headers changed on 2026-09-01.** If you have an older export, that is
> why it reads differently — for example `Holy See (Vatican City State)` is now
> `Vatican City`, `Virgin Islands, British` is now `British Virgin Islands`,
> `Cote d'Ivoire` now carries its accents, and `Macau` is now **Macao** (that
> last one was simply wrong before: both the Console and the standard say
> Macao).
>
> If a name still looks wrong, say which label the Console shows and the table
> is corrected there. It is only ever changed from a screen someone has read.

**Countries offered: 173 — the markets Google Play actually sells in.**

> ⚠ **This was 183 until 2026-09-01, and the old list was not Google's.** It
> came from the Apple module's catalogue and was wrong in both directions:
>
> - **15 markets Google sells in could not be ticked at all** — Russia,
>   Belarus, Libya, Gibraltar, Aruba, Bermuda, Cayman Islands, Turks & Caicos,
>   British Virgin Islands, Central African Republic, Eritrea, Somalia, Vatican
>   City, Yemen, Zimbabwe. They are all selectable now.
> - **25 entries were markets Google does not sell in** — ticking them could
>   never produce anything. They are gone.

**A ticked country with no price reads `—`.**

> ⚠ **It used to lose the column entirely.** Tick a country that no exported
> item prices and, before 2026-09-01, no column appeared at all: the question
> was removed instead of answered, and nothing in the file said so. Now the
> column is there and every cell reads `—`, meaning "this item has no price in
> this market".
>
> `—` has exactly one meaning here. The export reads every item in a single
> call, so there is no "we could not check" case to confuse it with — unlike
> the Apple export, which reads items one at a time and needs a failure sheet.

If a country code has no name at all, the header shortens to the bare code
(`Price in ZZ`) rather than repeating it as `Price in ZZ (ZZ)`. No market
Google currently sells in falls into this case; a test fails loudly if one ever
starts to.

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
**USD** figure (if the tier has no USD price: its price in the form's
currency, else its first price). This is the item form only — a bulk-import
file is priced in the currency of its own `Price (XXX)` header (§6).

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

**What you type follows the same price rules as a bulk-import file and the
custom-prices dialog** (October 2026): no more decimals than the currency
allows, no 0 price, and in a currency without decimals (VND, IDR, KRW, JPY,
TWD…) no "." or "," — `26.000` may mean 26 thousand, so write `26000`. The
prices the form fills in itself are written without separators, so they
never trip that rule.

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

**Prices come only from the file**: the number in its `Price (XXX)` column,
in the currency XXX written in that header (Step 2). The app's own currency
takes no part in bulk-import pricing — there is nothing to set or declare on
the app before importing (since October 2026, H4).

- **Template sources:** a row takes the tier named after its SKU
  (**SKU = tier identifier**); otherwise the tier whose price **in the
  file's currency** equals the file's price (when several tiers match, Step 3
  lets you pick). Countries the tier does not list, and rows with no matching
  tier, get Google's conversion of the file's price. A matched tier holding a
  price Google cannot take (more decimals than its currency allows, or 0)
  refuses the row (`tier_price_invalid`, Step 4).
- **`Google Conversion`:** every country is converted by Google from the
  file's price — so the US price is the file's price only when the file is
  in USD.
- **A country's own price** comes only from a matched tier or from custom
  prices (Step 3). The retired `GT Price` / `GT Currency` columns of an old
  file are never used ([GOOGLE-bulkimport-drop-gt], 2026-10-21 — see Step 2).

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

- **Product ID** (SKU) — required (a file without this column is refused).
  A row with data but no Product ID is not imported (Step 3).
- **Price (XXX)** decimal — required, **exactly one** such column (also
  accepted as `Default Price (XXX)` / `Base Price (XXX)`, any letter case).
  XXX is the currency the prices are written in and must be one Google Play
  bills in. The downloaded template writes `Price (USD)`; to price in
  another currency, rename the header — e.g. `Price (VND)`. This header's
  currency is the **only** price currency: the app's own currency is not
  used. **The whole file is refused** (no preview) when the price header has
  no currency (`Price`, `Default Price`, `Base Price`), when there is a
  second price column, when another column looks like a price but is not
  `Price (XXX)` (e.g. `Price USD`, `Unit price`), or when XXX is not a
  currency Google Play bills in.
- paired `Title (LangName)` / `Description (LangName)` per locale (82
  supported)

**`GT Price` / `GT Currency` are gone from the template** (2026-10-21,
[GOOGLE-bulkimport-drop-gt]: the team filled them but never meant them as
prices, and the tool posted GT Price as that country's price). An old file
that still has them imports as if they were not there: they are never read,
checked or sent — in any case or spelling, one column alone included, and a
row with only GT cells is an empty row. Step 3 shows a notice (with the
number of rows that still have GT data) but never blocks Push and never
refuses a row; clear the cells or delete the two columns. To give one
country its own price, use **Custom prices** in Step 3.

**Copy from an old file column by column, under the same headers — never
whole rows.** A row pasted by position into a file without the GT columns
puts the GT pair under Title / Description; a row whose Title is a bare
number and whose Description is exactly three capital letters (e.g.
`26000` / `VND`), in any locale, is refused ("có vẻ dữ liệu bị lệch cột").

Legacy files that keep data in the first sheet (e.g. `Sheet1`, like the
old `docs/google-iap-management/templates/template-item-iap-google.xlsx`
artifact) still parse via the first-sheet fallback.

### Step 3 — Preview

The wizard parses the file and shows every row with its existence
status (New · Exists). For existing SKUs, pick **Overwrite** or
**Skip** — **Push to Google Play** is gated until every row has a
decision. Bulk actions ("Set all Overwrite" / "Set all Skip") apply to
existing rows only. A pricing note at the top of the wizard ("Prices come
only from the file", shown on every step) restates the rules of Step 1. A
file that still has the GT columns gets a notice above the table (never a
gate — see Step 2).

**A row that cannot be imported is shown IN the table**, marked
**Not imported** with its reason, and counted in a red notice above it.
It is never sent with some other price instead. A row is not imported
when:

- its price is empty;
- its price is not a number, is 0, or has more decimals than its currency
  allows;
- in a currency without decimals (VND, IDR, KRW, JPY, TWD, HUF…) its price
  is typed as **text** with a "." or "," — `26.000` may mean 26 thousand:
  write `26000` (a NUMBER cell is fine, even when Excel displays it with a
  thousands separator);
- in any locale, its Title is a bare number and its Description exactly
  three capital letters — an old row pasted whole, shifted (see Step 2);
- it has data (price, title or description) but no Product ID.

If other rows can be imported, **Push** first opens a confirmation that
names every row left out — **Go back** sends nothing; **Leave them out and
push** sends the rest, and the rows left out are listed again on the result
screen. If no row can be imported, Push stays disabled: fix the file and
upload it again.

Parse warnings (unrecognised locale columns, skipped sample rows, a tier
lookup that failed — run Preview again) appear in a collapsible amber
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

| Source | Semantics |
|---|---|
| `Default Template` · `App-specific Template` | **REPLACES** the tier's whole price set. The dialog pre-fills from the row's tier (no matching tier: it opens empty); after Save the tier is not used for this row at all — a country you leave blank or clear gets Google's conversion of the file's price, not the tier's price. |
| `Google Conversion` | **SPARSE OVERLAY.** Set only the countries you want; every blank country still gets Google's automatic conversion of the file's price. The dialog opens **empty** — nothing is pre-filled. |

Under every source the row's file price (`Price (XXX)`) stays its default
price and the base Google converts from, and a custom set needs **no** price
in any particular currency — the app's currency included.

> Until October 2026 (H4) a custom set under a template source had to
> contain a price in the app's currency: the dialog blocked Save without it
> and the server refused the row with `custom_no_app_currency_entry`. Both
> are gone.

Rules that hold under every source:

- **Currency is fixed per country** and shown as a chip — it is Google's
  billing currency for that market, not something you pick.
- **A blank price is not "no price".** It reads
  `inherits — Google conversion`: at push, Google converts the row's file
  price (`Price (XXX)`) into that country. **set price** opens the field.
- **Save is blocked when a price breaks the price rules** — the same rules
  as a bulk-import file and the item Edit form: no more decimals than the
  currency allows (VND/JPY take whole numbers, KWD takes 3 decimals), no 0
  price, and in a currency without decimals no "." or "," (`26.000` may
  mean 26 thousand — write `26000`). The server checks every custom price
  again at push (`custom_invalid_price`).
- **Prices ≥90% below the reference get a non-blocking warning.** The
  reference is the *tier's price* when the row has a tier, otherwise
  *Google's converted price* of the file's price. The tool has no per-country
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
| Upload a **different file** at Step 2 | Kept for SKUs that are importable rows of the new file; dropped for the rest — including a SKU that is in the file but marked **Not imported** there. The banner names both lists |
| Set the row to **Skip** | **Kept but not sent** — the chip greys out with "inactive — this row is set to Skip, so nothing is sent". Un-skipping reactivates it. This is the *only* thing that deactivates a custom set |
| **Refresh the page** | **Lost** — all wizard state is in the browser. You get a browser warning first |
| **Import another** | Cleared — that is a new batch |

### Step 4 — Execute

Before writing, the server asks Google to convert each row's **file price**
into every country (one `convertRegionPrices` call per row; tier and custom
prices win where present), and reads the live product of each Overwrite
row once, so its other purchase options are kept (API reference §13). It
then sends ONE `monetization.onetimeproducts.batchUpdate` call
(`allowMissing: true` for new SKUs, `false` for Overwrite rows) and sets
each product's state with `purchaseOptions:batchUpdateStates`. There is no
fallback to the legacy `inappproducts.batchUpdate` any more (removed in
October 2026, H4): if Google refuses the call, the wizard shows Google's own
error. When the response returns, the cache is synced row by row and the
result screen shows Created / Overwritten / Skipped / Failed / **Not sent** /
**Custom** counts — the first five add up to the rows in the file.
**Failed** = rows Google did not write: the call failed for them or returned
no product for them — including **Overwrite** rows whose live read failed
(the tool leaves those out of the call rather than overwrite blind) — and
rows whose cache sync failed; **Not sent** = rows refused at push, or left
out in the file. **Custom** is how many items were
priced from a per-item custom set rather than the batch template.

**Every row not sent is listed by name with its reason**, in two groups:
"left out — refused in the file" (the rows you confirmed leaving out at
Push) and "refused at push". A row whose price cannot be applied exactly as
stated is excluded from the batch — it is NEVER quietly sent with another
price (a template price, a conversion, another currency) instead. The codes
below are the `kind` the audit log records for each refused row:

| Reason | Meaning |
|---|---|
| `refused_in_file` | Marked **Not imported** in Step 3 (reason kept) and left out when you confirmed Push. Fix the file and import the row again. |
| `file_price_invalid` | The row's price cannot be sent exactly as written — the Step 3 checks, run again on the server. |
| `tier_price_invalid` | The matched pricing-template tier holds a price that cannot be sent (more decimals than its currency allows, or 0). The reason names the tier and the country. Fix the tier in Settings → Pricing Templates, then import the row again. |
| `conversion_failed` | The file price is not in USD and Google's conversion of it failed, or left the row with no US price. The reason says which failure it was: **temporary** (network, Google 5xx, 408, 429) — not the row's data, run the row again later; **Google rejected the price as invalid** (400 `INVALID_ARGUMENT`) — check the price; **an access, account or app problem** (any other 4xx, e.g. 403) — fix the access, then run again. A USD row is still sent: its file price is the US price. |
| `custom_invalid_price` | A custom price breaks the price rules (precision, 0, `26.000`-style text in a currency without decimals), an entry is missing its country, currency or amount, or the custom set is empty. Fix it in the dialog and re-push. |
| `price_build_failed` | Safety net: the row's prices could not be built even though every check passed. Should never happen — report it. |

> `custom_no_app_currency_entry` was retired in October 2026 (H4): a custom
> set no longer needs a price in the app's currency (see Step 3). Rows that
> used to be refused because the file's currency differed from the app's
> are now written, priced from the file.
>
> `custom_source_mismatch` was retired in August 2026. It refused custom
> prices on a `Google Conversion` batch, which is now a supported
> combination.

**Every row not written counts as failed for the Hub** — refused at push,
left out in the file, or not written by Google; only rows you set to
**Skip** count as skipped. The run closes **PARTIAL** when other rows were
written and **FAILED** when none were — never SUCCESS. In the database,
`import_batches.status` is `COMPLETE` only when every row was written or
skipped, and `FAILED` otherwise (the column has no partial value); a run
that ends in an error is closed `FAILED` too — unless the closing write itself
fails, which is logged (`[google-iap:bulk-import] import_batches close
FAILED|THREW batch=…`) and leaves the row `IN_PROGRESS`.

**Cap:** 100 rows sent per call (`BATCH_MAX`,
`orchestration/bulk-import.ts` — counted AFTER skips, sample rows, rows
left out in the file and rows refused for their file price, tier or custom
prices; not raw file rows). If exceeded, the tool throws before anything is
sent to Google — no partial import, no silent truncation — the batch is
closed `FAILED`, and the wizard shows the error when you Push. Preview does
NOT pre-check this cap; split the file and re-run.

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
- ⚠ Upload does not yet check prices against each currency (BACKLOG
  `[GOOGLE-template-upload-price-check]`). A 0, or a price with more
  decimals than its currency allows (e.g. TWD `30.5`), is stored — and
  every Bulk Import row that matches that tier is refused at push
  (`tier_price_invalid`; other rows are still sent). A VND/JPY… cell typed
  as text `26.000` is stored as **26** and cannot be caught at push — check
  price cells before uploading.

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
- **Push answers "The tool was updated since this page was opened…"
  (`PREVIEW_OUTDATED`, 409)** → the tab was opened before an update;
  nothing was sent. **Reload the page**, then upload the file and run
  Preview again — uploading again in the same tab gets the same answer.
- **Upload refused: "Header "Price" does not say which currency the prices
  are in"** (or "The file has 2 price columns") → rename the header to
  `Price (XXX)` with the currency of the prices, e.g. `Price (USD)` /
  `Price (VND)`, and keep exactly one price column (§6 Step 2).
- **A row is marked "Not imported"** → its reason is on the row (§6 Step 3).
  Fix the file and re-upload, or push the rest and import that row later.
- **A row was refused `conversion_failed` "temporarily"** → not a problem
  with the row's data: run that row again later. "Google rejected the file
  price … as invalid" → check the price; "an access, account or app
  problem" → fix the service account's access first (§6 Step 4).
- **A row was refused `tier_price_invalid`** → the pricing-template tier
  holds a price Google cannot take (more decimals than its currency
  allows, or 0). Fix the tier in Settings → Pricing Templates, then import
  the row again.
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
