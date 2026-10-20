# Pricing Templates — Manager guide (IAP.p1)

This guide explains how to use the three-tier pricing template system
shipped in **IAP.p1**. The legacy single-template path is migrated
automatically — no immediate action required.

## TL;DR

Three sources are now available wherever the Tool sets prices on Apple:

1. **Apple base** — Tool sends one USA price-point; Apple auto-equalizes
   every other territory. (= behavior before IAP.p1.)
2. **Default Template** — per-territory overrides Manager uploads in
   Settings, **one per ASC account**. Used by every app of that account
   unless overridden. (⚠ Changed 2026-08-29, `[ACCOUNT-default-template]`:
   before that date there was a single template shared by all accounts.)
3. **App-specific template** — per-app per-territory overrides Manager
   uploads on the app detail page. Wins over Default for that app.

Templates are **sparse**: blank cells mean "no override — let Apple
auto-equalize." Manager doesn't need to fill the whole grid.

## Where to upload

### Default Template (one per ASC account)

Settings → Pricing Templates → **Default Template** tab → pick the account
in the chip row → Upload .xlsx.

⚠ **The chip row is independent of the account in the TopNav switcher.**
That is deliberate: it lets you look at another account's template without
switching context. It also means **the account you upload to is the chip
you have selected, not the one in the TopNav** — check the chip before
pressing Replace.

Each account holds at most one Default Template. Replacing is destructive
for that account only; the other accounts are untouched. Remove falls that
account back to Apple-only behavior — with no shared template behind it,
because there no longer is one.

A template you have not configured yourself shows an origin pill saying it
came from the 2026-08-29 migration, which duplicated the old shared
template into one copy per account. Uploading your own makes the pill
disappear on its own.

⚠ The Per-App tab next to it has **no chip row** — its app list follows the
TopNav account, because listing apps means asking Apple with that account's
credentials. To see another account's apps, switch in the TopNav.

### Per-App Template

Two equivalent surfaces:

- Settings → Pricing Templates → **Per-App Templates** tab — pick an app
  from the dropdown, then upload.
- App detail page → **Pricing Template** section — Upload / Replace /
  Remove inline. Requires the app to have at least one IAP draft saved
  first (so it's registered in `iap_mgmt.apps`).

## File format

Identical to the existing `price-tiers-template.xlsx`:

- Sheet name `price_tiers`
- Row 0: territory headers `Country Name (CCC_CCC)` (e.g. `Vietnam (VNM_VND)`)
- Row 1: alternating sub-headers `Price` / `Proceeds` per territory
- Row 2+: data rows. Column 0 = tier name (`Free Tier`, `Tier 1`, …, `Alternate Tier A` …)

What's new in IAP.p1:

- **Blank cells are allowed.** Both `Price` and `Proceeds` blank → no
  override for that (tier, territory).
- **Proceeds may be omitted** even if Price is filled — the entry is
  stored with `proceeds=null`.
- **Price filled but Proceeds blank** is accepted; the entry uses the
  Price and leaves Proceeds null.
- **Proceeds filled but Price blank** emits a warning and the entry is
  skipped (price is required for an override to mean anything).

## Selection during IAP work

Three places to pick the source — Manager's choice each time (Q-J
explicit):

| Surface | Where | Default |
|---|---|---|
| Create IAP | Above the Tier picker on the form | Most specific available (Q-D): app → default → Apple |
| Bulk Import | Step 3 (Preview) | Same as Create |
| Edit IAP → Update on Apple | Same form selector | Same as Create |

Unavailable options gray out with a hint pointing to the upload surface.

## What happens server-side

- **Apple base** — single USA price-point POST. Apple equalizes the rest.
  No change from before IAP.p1.
- **Default / App template** — Tool fetches Apple's per-territory price
  points lazily (`/v2/inAppPurchases/{id}/pricePoints?filter[territory]=X`),
  finds the price-point whose `customerPrice` matches the template entry,
  and adds it to the POST's `manualPrices` array. Territories not in the
  template fall through to Apple auto-equalization.

## Q-K fail-soft: when a template entry has no Apple match

Rare but possible: Manager's template lists a `customer_price` that
doesn't exist in Apple's catalog for that territory (e.g. Manager picked
a price Apple has since removed). What happens:

1. The orchestrator logs the miss to Railway:  
   `[pricing] no Apple catalog match apple_iap_id=… territory=VNM customer_price=25000`
2. The POST still happens with whatever overrides DID resolve.
3. The audit log row carries `outcome='partial-template-fail'` and the
   `missing_price_points` array enumerates the unresolved entries.
4. UI surfaces this via the price-not-set / warning toast on Create, or
   a partial-success indicator on the Bulk Import Step 4 results.

Manager's workflow stays unblocked — Tool never refuses to ship over a
mismatch. Fix the template at leisure and re-run when convenient.

## Apple Connect verification

After a Tool POST you should see:

- **Apple base**: every territory in the IAP's price schedule shows the
  same auto-equalized price derived from your USA base.
- **Template paths**: each overridden territory shows your template's
  exact `customer_price` (in that territory's currency); non-overridden
  territories show Apple's auto-equalized value.

The audit log (`iap_mgmt.actions_log` WHERE `action_type='SET_PRICE_SCHEDULE'`)
captures `payload.source`, `payload.overridden_territory_count`, and
`payload.missing_price_points` so you can verify without leaving the Tool.

## ASC account in the Per-App table (IAP.p1.j)

The **Apps with custom templates** table on Settings → Pricing Templates →
Per-App Templates shows an **ASC Account** column. Tool captures which
ASC account was active at the moment Manager first registered the app
(via Save Draft, Bulk Import, or template upload) and shows that
account's display name from CPP Setting.

- Pre-IAP.p1.j rows display "—" until Manager touches them again — the
  next ensureAppRegistered call backfills the column (we never overwrite
  an already-captured value).
- The "Upload for an app" dropdown is live-fetched from Apple under the
  **currently selected** ASC account every time you open it. Switch the
  account in the TopNav AccountSwitcher and reopen the dropdown to see
  the new account's catalog. The dropdown helper line shows which
  account it's reading from.

## Pricing-source persistence (IAP.p1.j)

The Manager's explicit source choice on the Create / Edit IAP form is
persisted to the IAP row (`iap_mgmt.iaps.pricing_source`). Save Draft +
reload preserves the choice — Tool will NOT silently re-derive a
template default when you explicitly picked Apple base.

Bulk Import remains batch-level (Q-E): every row in the same execute
call shares one source.

## Export the matrix to .xlsx (2026-08-30)

Both matrix screens — **Settings → Pricing Templates → Default Template**
and **… → Per-App Templates → _app_** — have an **`Export XLSX`** button in
the filter bar. It replaces the old `Export CSV`; **the CSV export is gone.**

### What the file is

**A snapshot of what the screen is showing.** Nothing is added, removed or
recomputed on the way out. Concretely:

| | |
|---|---|
| **Rows** | one per tier, in the order the screen lists them (`Free Tier`, `Tier 1`, `Tier 2`, … then `Alternate Tier *`) |
| **Columns** | one **pair** per territory — `Price` and `Currency` — under a merged header carrying the full country name |
| **Column order** | the order the territories appear **in the .xlsx you uploaded** — VN first, then the SEA neighbours, etc. **Not alphabetical**, and not re-sorted |
| **Which territories** | exactly the ones passing the current search / currency / continent filters. Filter first, then export |
| **Frozen** | the `Tier` column and both header rows stay put while you scroll |

### Reading the cells

- **A number** — the price, exactly as stored. No thousands separator, no
  rounding, no trailing decimal separator. It is a real Excel number, so
  sorting, filtering and `SUM()` work on it.
- **`·`** — there is **no entry** for that (tier, territory) pair in the
  template. Same meaning as on screen: *"no override for that tier-territory
  pair (Apple auto-equalisation fills)"*. It is **not** a zero and **not** a
  missing read.
- **Orange text** (Per-App only) — that cell differs from the **Default
  Template** at the same tier/territory. Hover the cell in Excel: the note
  reads `Default: <price> <CCY>` / `Per-App: <price> <CCY>` — both
  currencies, because a cell can differ by currency alone while the two
  numbers look identical.

⚠ The `★` you see on screen is **not** written into the cell. Putting it
there would turn the cell into text and break sorting; the orange carries the
same statement.

### The Highlight switch changes the file

On the Per-App screen the checkbox **`Highlight differences from Default ★`**
controls the file too. Untick it and the exported workbook has **no orange
cells and no notes** — the values are identical either way, only the marking
changes. (The old CSV ignored this switch, which is one of the three
mismatches this rewrite fixed.)

### When the button is greyed out

If the filters leave zero territories the screen shows *"No territories match
the active filters."* and the button is disabled with the tooltip *"No
territories match the active filters — nothing to export."* There is nothing
to put in a file; clear a filter.

### If it refuses

The message says which of three things happened, and each needs a different
move:

| Message says | Do |
|---|---|
| …a field was rejected / no territories selected | fix the filters and retry |
| *"No Default template for the active account."* / *"No Per-App template for this app."* | upload the template first |
| *"The pricing template changed since this page was loaded — it no longer covers: XXX, YYY."* | someone re-uploaded the template while your page was open. **Reload the page**, then export |

### ⚠ This file cannot be uploaded back — use "Export for editing"

`Export XLSX` is a picture of the screen: filtered, with country names but no
territory codes. Importing it is refused. To change prices in a spreadsheet,
use the second export below.

## Edit the template in Excel: `Export for editing` → `Import edited file` (2026-10-20)

Both matrix screens also have **`Export for editing`** and **`Import edited
file`** (on the Default screen the import is for admins only — the same rule as
uploading a Default template; on a Per-App screen, anyone who may upload a
Per-App template).

### The rules (Manager, 2026-10-19)

1. **The file is the whole truth.** After the import the template is exactly
   the file, whatever it held before.
2. **A cell with a price** is an override at exactly that price.
3. **An empty or `·` cell** is no override — Apple's own price applies.
   Clearing a cell that had an override removes it. On a Per-App template that
   means **Apple's** price, **not** the Default template's.

So a file imported back unchanged changes no tier, territory, currency or
price. (Proceeds are not in the file; every cell's proceeds is empty after an
import — they are display-only and no price write reads them. The preview says
how many cells lose them.)

### The file for editing

- **Every territory of the template, always.** The screen's filters are
  ignored on purpose: a filtered file would delete the hidden territories'
  overrides on import.
- Each territory header carries its code and currency, `Vietnam (VNM_VND)` —
  the same header as the upload template. The currency is the one Apple bills
  that territory in.
- A hidden sheet `_import_info` states which template the file belongs to
  (the Default of account X, or the Per-App template of app Y). Leave it alone;
  Excel keeps it hidden.
- No orange difference marks.
- Name: `apple-pricing-template-default-for-editing-<stamp>.xlsx` /
  `apple-pricing-template-per-app-<bundle-id>-for-editing-<stamp>.xlsx`.

### What you may change

Prices; a new price in a `·` cell; clearing a cell. Rows (tiers that already
exist) and territories may be added, removed or reordered — the preview shows
every effect.

⚠ A territory is **two columns**, like every territory in the file: the header
`Name (CODE_CUR)` in the left one (the right one empty), and `Price` /
`Currency` in row 2. To add one, copy an existing pair of columns and edit it.
Do not insert a single column — every pair after it shifts, and the whole file
is refused.

### What is refused — the whole file, nothing written, every problem listed with its cell

| Refused | Example |
|---|---|
| a tier that does not exist, or not spelled exactly as stored | `Tier 05`, `Alternate Tier a` |
| a territory Apple does not sell in; the same territory twice | `ZZZ` |
| a header currency that is not the one Apple bills | `Japan (JPN_USD)` — Apple bills Japan in JPY |
| a Currency cell that differs from its header | `USD` under `Vietnam (VNM_VND)` — the currency comes from the header |
| a formula; a negative price; more than 4 decimals | `=1+1`, `-1`, `1.23456` |
| text that is not plainly a number | `49.000`, `1,99` (`2.49` typed as text is fine) |
| a file with no price at all | — use **Remove** in Settings to remove a template |
| a file of ANOTHER template | another account's Default, another app — 409, naming both |
| the `Export XLSX` file, an old export, a format-A template file | upload a template file in Settings instead |

### Preview, then write

After you choose the file you see what the import will do — nothing is
written yet: new overrides, price changes, overrides removed (back to Apple's
price), unchanged cells, overrides after vs now; and warnings:

- changes in the **USA column** — bulk import reads its tiers and USD base
  prices from it; a missing USA column means bulk import finds no tier;
- prices changed more than **×10** (a typo such as `49,000` read as 49);
- new overrides outside their neighbouring tiers;
- how many cells lose their proceeds.

No Apple price is shown for a removed override — only "back to Apple's price".
**Write N changes** writes the file; a file with no changes can still be
written (the button then says **Write anyway**). With more than 200 changes
the table shows 200 rows — the flagged ones (USA, ×10, tier ladder) and the
removed overrides first; the counts always cover every row.

### If the write fails part-way

*"The template may be partially written — import the same file again."*
Importing the same file again makes the template exactly the file. The matrix
reloads at once so it shows what is really there. If it now says *"No …
template uploaded yet"* (the write broke in its first batch — always the case
for a Per-App template, which fits in one batch), **`Import edited file` is on
that empty page too**: import the file there. (The Settings upload refuses a
file for editing — wrong door.) The same button restores a template that was
removed in Settings, from a file exported for editing before.

If the write got no clear answer (the connection dropped, a 502 / 504 page):
*"…the template may or may not have been written…"* — the same move: import
the same file again.

### If "Export for editing" refuses

| Message says | Do |
|---|---|
| *"Cannot export for editing: XKS (EUR, USD — Apple bills EUR) hold more than one currency…"* and/or *"VNM (USD, Apple bills VND)"* | the template holds a territory in two currencies, or in a currency Apple does not bill there. Both kinds are listed in ONE message. Fix the template file (one currency per territory, Apple's) and upload it in Settings |
| *"This page shows the Default template of account A, but the account selected in the top bar is now B…"* | the account was switched in another tab. **Reload the page**, then export (the file would otherwise be B's under A's heading) |

⚠ The Settings upload (format A) does **not** check a header's currency
against Apple's. A template uploaded there with, say, `Vietnam (VNM_USD)` is
accepted, and then refused by "Export for editing" with the message above.

## Replace vs Remove

- **Replace** = upload a new file. Old entries are deleted and the new
  ones inserted. No history kept (Q-A).
- **Remove** = delete the template header. Entries cascade away. IAPs
  created from now on with the corresponding source fall back to the
  next-most-specific template, or Apple base if none.

## Limits + safety

- Maximum file size: **10 MB**.
- Strict validations remain: malformed headers, non-numeric cells where
  present, wrong sheet name — all hard rejects.
- Apple per-territory fetches are cached per orchestration call; Manager
  doesn't pay the cost twice within a single Create / Update / Bulk row.
