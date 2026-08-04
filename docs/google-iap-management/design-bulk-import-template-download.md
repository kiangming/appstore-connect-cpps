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
  (client-side generation, `Price (<appDefaultCurrency>)`).

Status: DESIGN — awaiting Manager review. No implementation yet.
