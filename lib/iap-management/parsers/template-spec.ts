/**
 * Apple bulk-import template spec — SINGLE SOURCE OF TRUTH for the
 * column contract, consumed by BOTH:
 *   - the parser (iap-items.ts — lead-header lookup, Type enum,
 *     data-sheet name), and
 *   - the "Download template" generator (appleIapTemplateSpec → shared
 *     lib/xlsx-template.ts).
 * A parser column change that forgets the template fails the anti-drift
 * tests in template-spec.test.ts instead of reaching users
 * (design-bulk-import-template-download.md §A/§D).
 *
 * Client-safe by construction: the only imports are locale-map.json and
 * a type — no xlsx, no server-only deps — so the client wizard can
 * import these consts without dragging anything heavy into the bundle.
 *
 * Canonical shape: 6 lead headers + 39 locale pairs = 84 columns.
 * Lead-header matching in the parser is trimmed + case-insensitive
 * (Hotfix 27 / §3.3 lock); only Product ID + Reference Name are
 * required. Locale pairs MUST be adjacent (Display Name immediately
 * followed by its Description) — a parser requirement the generator
 * satisfies by construction.
 */

import localeMapJson from "@/lib/locale-map.json";
import type { InAppPurchaseType } from "@/types/iap-management/apple";
import type { XlsxTemplateSpec } from "@/lib/xlsx-template";
import {
  TEMPLATE_SAMPLE_PRODUCT_IDS,
  TEMPLATE_SAMPLE_ROWS_NOTE,
} from "@/lib/xlsx-template";

/** Data-sheet name the parser selects BY NAME (sheet-selection
 *  hardening, design §C). Legacy files without it fall back to the
 *  first sheet. */
export const APPLE_DATA_SHEET_NAME = "IAP Items";
export const APPLE_NOTES_SHEET_NAME = "Notes";
/** Kept identical to the legacy Manager artifact name — the wizard copy
 *  and docs already reference it; the content is regenerated fresh on
 *  every click so the name needs no version/date. */
export const APPLE_TEMPLATE_FILENAME = "item-iap-template.xlsx";

/** Canonical lead headers keyed by their parser role. `as const` keeps
 *  the exhaustive coupling: adding a key forces the notes metadata below
 *  (Record over the same keys) to be extended too. */
export const APPLE_LEAD_HEADERS = {
  productId: "Product ID",
  referenceName: "Reference Name",
  type: "Type",
  priceUsd: "Price (USD)",
  gtPrice: "GT Price",
  gtCurrency: "GT Currency",
} as const;

/** Emission order of the lead headers in the generated template. */
export const APPLE_LEAD_HEADER_ROW: readonly string[] =
  Object.values(APPLE_LEAD_HEADERS);

/** Only these two columns are REQUIRED (§3.3 institutional lock —
 *  everything else has a documented default). */
export const APPLE_REQUIRED_LEAD_HEADERS: readonly string[] = [
  APPLE_LEAD_HEADERS.productId,
  APPLE_LEAD_HEADERS.referenceName,
];

/** Allowed Type values (§3.3 lock: empty/absent → CONSUMABLE default;
 *  invalid with column present → row error). */
export const APPLE_TYPE_VALUES: readonly InAppPurchaseType[] = [
  "CONSUMABLE",
  "NON_CONSUMABLE",
  "NON_RENEWING_SUBSCRIPTION",
];

/** The 39 Apple locale friendly names, in locale-map.json (alphabetical)
 *  order — the same map the parser resolves locale headers against via
 *  lib/locale-utils.localeCodeFromName. */
export const APPLE_LOCALE_NAMES: readonly string[] =
  Object.keys(localeMapJson);

export function appleLocalePairHeaders(): string[] {
  return APPLE_LOCALE_NAMES.flatMap((name) => [
    `Display Name (${name})`,
    `Description (${name})`,
  ]);
}

/** Full canonical header row — 6 lead + 39×2 locale = 84 columns. */
export function appleTemplateHeaders(): string[] {
  return [...APPLE_LEAD_HEADER_ROW, ...appleLocalePairHeaders()];
}

/** Example-row values, genericized from the Manager's source file
 *  (apple-item-iap-test.xlsx, August 2026). Product IDs come from the
 *  shared TEMPLATE_SAMPLE_PRODUCT_IDS skip list. USD prices are the
 *  Manager's (0.49 / 4.09 / 12.49). GT Price deviates from the source's
 *  constant 23000: GT Price is a base-territory PRICE, not an exchange
 *  rate (verified — the Google sibling posts it as a literal per-region
 *  store price; Apple currently parses it into base_price/base_currency
 *  without downstream consumption), so a constant 23000 across three
 *  different USD prices would teach users a stale-rate pattern. The
 *  samples carry per-row illustrative VND prices (~26,000 VND/USD,
 *  rounded to thousands) instead. Each row fills one locale pair
 *  (Vietnamese, like the Google source rows) so an imported copy would
 *  be metadata-complete. */
const SAMPLE_ROW_VALUES = TEMPLATE_SAMPLE_PRODUCT_IDS.map((id, i) => ({
  productId: id,
  referenceName: `Sample product 0${i + 1}`,
  priceUsd: [0.49, 4.09, 12.49][i],
  gtPrice: [13000, 106000, 325000][i],
  gtCurrency: "VND",
  viDisplayName: `Sample product 0${i + 1}`,
  viDescription: `Sample product 0${i + 1} - import, default price template`,
}));

/** The pre-filled data-sheet rows: 3 samples, a spacer, and the visible
 *  delete-me warning in a row whose Product ID cell is EMPTY (both
 *  parsers skip ID-less rows, so the note never parses as data). */
export function appleTemplateDataRows(): (string | number)[][] {
  const headers = appleTemplateHeaders();
  const col = (name: string) => headers.indexOf(name);
  const rows = SAMPLE_ROW_VALUES.map((v) => {
    const row: (string | number)[] = headers.map(() => "");
    row[col(APPLE_LEAD_HEADERS.productId)] = v.productId;
    row[col(APPLE_LEAD_HEADERS.referenceName)] = v.referenceName;
    // Type left empty on purpose — demonstrates the Hotfix 27 default
    // (empty → CONSUMABLE), matching the Manager's source rows.
    row[col(APPLE_LEAD_HEADERS.priceUsd)] = v.priceUsd;
    row[col(APPLE_LEAD_HEADERS.gtPrice)] = v.gtPrice;
    row[col(APPLE_LEAD_HEADERS.gtCurrency)] = v.gtCurrency;
    row[col("Display Name (Vietnamese)")] = v.viDisplayName;
    row[col("Description (Vietnamese)")] = v.viDescription;
    return row;
  });
  // Truly empty spacer ([] → no cells written), then the note with an
  // EMPTY Product ID cell so the parser ignores the row.
  return [...rows, [], ["", TEMPLATE_SAMPLE_ROWS_NOTE]];
}

/** Per-lead-column notes metadata. Keyed over APPLE_LEAD_HEADERS so a
 *  new lead column cannot be added without documenting it here —
 *  TypeScript enforces exhaustiveness. */
const LEAD_NOTES: Record<
  keyof typeof APPLE_LEAD_HEADERS,
  { required: string; meaning: string }
> = {
  productId: {
    required: "REQUIRED",
    meaning:
      "Unique product identifier (letters, digits, underscore, period, hyphen). CANNOT be changed after the IAP is created on App Store Connect.",
  },
  referenceName: {
    required: "REQUIRED",
    meaning: "Internal name shown in App Store Connect. Max 64 characters.",
  },
  type: {
    required: "Optional",
    meaning: `One of: ${APPLE_TYPE_VALUES.join(" / ")}. Empty cell (or column removed) → CONSUMABLE. Any other value fails that row.`,
  },
  priceUsd: {
    required: "Optional",
    meaning:
      "Numeric price in US DOLLARS (USD) — used to infer the Apple price tier from your pricing template. Empty → the pricing stage is skipped for that row.",
  },
  gtPrice: {
    required: "Optional",
    meaning:
      "Base-territory price (numeric), in the currency given in GT Currency.",
  },
  gtCurrency: {
    required: "Optional",
    meaning: 'Base-territory currency code for GT Price, e.g. "VND".',
  },
};

function appleNotesRows(): (string | number)[][] {
  const leadKeys = Object.keys(
    APPLE_LEAD_HEADERS,
  ) as (keyof typeof APPLE_LEAD_HEADERS)[];
  return [
    ["Apple IAP bulk-import template — how to fill"],
    [],
    [
      `Enter one product per row in the "${APPLE_DATA_SHEET_NAME}" sheet, under the headers. Do not rename that sheet — the import looks it up by name.`,
    ],
    [
      "This Notes sheet is ignored by the import — keeping or deleting it makes no difference.",
    ],
    [],
    ["Column", "Required?", "Meaning / allowed values"],
    ...leadKeys.map((key) => [
      APPLE_LEAD_HEADERS[key],
      LEAD_NOTES[key].required,
      LEAD_NOTES[key].meaning,
    ]),
    [
      "Display Name (<Locale>) + Description (<Locale>)",
      "Optional",
      `${APPLE_LOCALE_NAMES.length} locale pairs. Fill BOTH cells of a pair, or leave BOTH empty (that locale is skipped). Filling only one of the two produces a warning and the locale is skipped.`,
    ],
    [],
    [
      `UNIT REMINDER: "${APPLE_LEAD_HEADERS.priceUsd}" is US dollars. GT Price is a PRICE in the GT Currency you specify on the same row — it is NOT an exchange rate.`,
    ],
    [],
    [
      `SAMPLE ROWS: the "${APPLE_DATA_SHEET_NAME}" sheet comes PRE-FILLED with the 3 sample rows below. Delete them or replace them with your real products. Rows keeping the sample Product IDs (${TEMPLATE_SAMPLE_PRODUCT_IDS.join(", ")}) are skipped automatically on import — any other Product ID in the data sheet is imported as a REAL store product.`,
    ],
    [
      ...APPLE_LEAD_HEADER_ROW,
      "Display Name (Vietnamese)",
      "Description (Vietnamese)",
    ],
    ...SAMPLE_ROW_VALUES.map((v) => [
      v.productId,
      v.referenceName,
      "",
      v.priceUsd,
      v.gtPrice,
      v.gtCurrency,
      v.viDisplayName,
      v.viDescription,
    ]),
  ];
}

/** Complete spec for lib/xlsx-template.buildTemplateWorkbook /
 *  downloadXlsxTemplate. */
export function appleIapTemplateSpec(): XlsxTemplateSpec {
  return {
    dataSheetName: APPLE_DATA_SHEET_NAME,
    headers: appleTemplateHeaders(),
    dataRows: appleTemplateDataRows(),
    notesSheetName: APPLE_NOTES_SHEET_NAME,
    notesRows: appleNotesRows(),
    filename: APPLE_TEMPLATE_FILENAME,
  };
}
