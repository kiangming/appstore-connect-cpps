# Runbook — cached price precision audit (Google IAP)

**Read-only.** Answers: *are there cached prices whose decimals the tool's own
currency table would reject?* Such a row shows an amber warning on the Edit
form and, before the 2026-08-13 base-price cycle, blocked **every** edit to
that item — including its title.

## Why this exists

The first hypothesis was float noise from `convertRegionPrices`. The scan
**disproved it**: across 286,443 price rows / 1,664 items there was exactly
**one** offending row, and it is a real price on Google, not noise.

| Currency (tool says 0 dp) | Rows | Fractional |
|---|---|---|
| VND | 1,663 | 0 |
| JPY | 1,661 | 0 |
| KRW | 1,661 | 0 |
| IDR | 1,662 | 0 |
| CLP | 1,661 | 0 |
| HUF | 1,661 | 0 |
| **TWD** | 1,661 | **1** |

The single offender: `com.vng.passsdk.2508111020`, `TW = TWD 6.30`
(`price_micros = 6300000`), base USD 0.49, 173 regions cached,
`last_synced_at = 2026-05-22`.

> ⚠ **Do not "fix" such a value.** Rounding TWD 6.30 → 6 would silently cut a
> live price by 4.8%. Values from Google are never rounded, trimmed or
> normalised; an untouched row is written back byte-for-byte. Whether TWD 6.30
> should be something else is a **business decision for the Manager**, made
> deliberately on the form or in Play Console — never by the tool.
> (KB §10.13.K, Google base-price cycle, item (d).)

## Run it

Needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`. Read-only
— it issues `select` only.

```bash
node docs/google-iap-management/diagnostics/price-precision-audit.mjs
```

Output: total rows scanned, offending rows, offending items, offending base
prices, top-10 items with region/currency/micros/decimal, a per-currency
breakdown, and the tool-vs-Google reality check per 0-decimal currency.

## Reading the result

- **0 offending rows** → nothing to do. Re-run after any bulk import that
  introduces new currencies, or if Google changes a country's currency (the
  BG → EUR move of Jan 2026 is the precedent).
- **>0** → for each item decide, per row, whether Google's value is correct.
  If it is, leave it: the warning is informational and does not block saving.
  If it is not, edit that row on the form (typing into it makes it yours, so
  precision validation then applies) or fix it in Play Console.
- **A currency showing many fractional rows** → the tool's exponent table is
  probably wrong for that currency, not the data. Check
  `lib/google-iap-management/google/currency-precision.ts` against Play
  Console before touching any price. TWD sits in that table as 0 dp on the
  strength of 1,660/1,661 rows; one exception does not overturn it.

## What it replicates

Verbatim, so the verdict matches what the form does:

- `microsToDecimal(micros, 2)` — `google/price-conversion.ts`
- `getCurrencyDecimals(currency)` — `google/currency-precision.ts`
- `validateDecimalForCurrency(decimal, currency)` — same file

If any of those three change, update the script in the same commit or it will
start disagreeing with the product silently.
