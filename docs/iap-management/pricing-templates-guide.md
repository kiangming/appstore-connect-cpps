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
