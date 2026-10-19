# Bulk Import "Download template" — Google IAP Management

**Pointer stub — the canonical investigation + design doc covers BOTH modules
and lives at:**

`docs/iap-management/design-bulk-import-template-download.md`

Google-specific decisions in that doc (do not duplicate content here — single
source of truth):

- Findings F1 (sheet-by-index in `excel-parser.ts:415`), F2/F3 (82-locale
  `LOCALE_NAME_TO_BCP47` spec, exact-case fixed headers, flexible price
  column), F4 (v1 artifact's duplicate locale pairs + example data rows,
  no artifact smoke test), F7 (button belongs in the Step 2 "upload" card,
  NOT Step 1 — the wizards are asymmetric).
- Design sections A (generated-from-parser), C (sheet-selection hardening),
  D (anti-drift + round-trip tests), E (twin-path split table), F
  (client-side generation). The design proposed `Price (<appDefaultCurrency>)`;
  the Manager chose a FIXED `Price (USD)` header (G.1) — that is what ships
  (`template-spec.ts`, `GOOGLE_PRICE_HEADER`).

Status: IMPLEMENTED (August 2026) — see the canonical doc's status block.

> ⚠ *2026-10-19 (H4, `arc-google-h4-file-currency-pricing`):* the currency
> written in the file's price header is the ONLY price source; the app's
> currency takes no part in bulk-import pricing. A price header without its
> currency (`Price` / `Default Price` / `Base Price`), a second price column,
> another header that looks like a price, or a currency Google Play does not
> bill in refuses the FILE (`resolvePriceColumn`, `excel-parser.ts`). F3's
> acceptance of a currency-less ("generic") price header and the
> app-currency / cross-currency reasoning in the canonical doc (§E, §F,
> §G.1) are history.
