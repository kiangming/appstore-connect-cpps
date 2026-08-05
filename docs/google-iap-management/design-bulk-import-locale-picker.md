# Bulk Import Template — Locale Selection Before Download (Google)

**Pointer stub — the canonical investigation + design doc covers BOTH
modules and lives at:**

`docs/iap-management/design-bulk-import-locale-picker.md`
Mockup: `docs/iap-management/design/bulk-import-locale-picker-mockup.html`
(module toggle includes the Google 82-locale list).

Google-specific content in that doc — do not duplicate here:

- Gate 1a–1e: name-based discovery in `excel-parser.ts` (indexColumns
  `:226-241`, pair regex `:255-256`), zero/subset templates proven
  empirically clean, price resolver unaffected.
- Zero-locale semantics: CREATE synthesizes the en-US/SKU default
  listing (`orchestration/bulk-import.ts:179-180`); OVERWRITE replaces
  listings (purchase-option-only merge, `publisher-client.ts:864-872`)
  — risk §I.1.
- Design: §B display consts (GOOGLE_LOCALE_OPTIONS, ~30/82 rows
  region-less), §E filename pattern, §F parameterized
  `googleIapTemplateSpec(selected?)`.

Status: DESIGN — awaiting Manager review. No implementation.
