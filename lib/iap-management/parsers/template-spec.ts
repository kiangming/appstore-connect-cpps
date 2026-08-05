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
  resolveSelectedLocales,
  templateFilenameFor,
  type LocaleOption,
} from "@/lib/xlsx-template";

/** Data-sheet name the parser selects BY NAME (sheet-selection
 *  hardening, design §C). Legacy files without it fall back to the
 *  first sheet. */
export const APPLE_DATA_SHEET_NAME = "IAP Items";
export const APPLE_NOTES_SHEET_NAME = "Notes";
/** Symmetric, platform-identifying download name (Manager directive,
 *  August 2026): both modules' templates land in the same Downloads
 *  folder, so the name must say which platform it belongs to. Pattern
 *  `<platform>-iap-bulk-import-template.xlsx`, mirrored by the Google
 *  module. Regenerated fresh on every click — no version/date needed.
 *  (The legacy on-disk artifact keeps its old name
 *  docs/iap-management/templates/item-iap-template.xlsx.) */
export const APPLE_TEMPLATE_FILENAME = "apple-iap-bulk-import-template.xlsx";

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

/** Locale-picker rows (display-only strings precomputed at authoring
 *  time — see LocaleOption). `name` is the parser-matched key, so a
 *  selection is a list of these names. `country` is "—" for the 24
 *  language-only Apple locales; script/grouping variants (Simplified,
 *  Traditional) show verbatim, which is why the code column stays
 *  visible in the modal as the real disambiguator. Exhaustiveness
 *  against locale-map.json is pinned by template-spec.test.ts. */
export const APPLE_LOCALE_OPTIONS: readonly LocaleOption[] = [
  { name: "Arabic", language: "Arabic", country: "Saudi Arabia", code: "ar-SA" },
  { name: "Catalan", language: "Catalan", country: "—", code: "ca" },
  { name: "Chinese (Simplified)", language: "Chinese", country: "Simplified", code: "zh-Hans" },
  { name: "Chinese (Traditional)", language: "Chinese", country: "Traditional", code: "zh-Hant" },
  { name: "Croatian", language: "Croatian", country: "—", code: "hr" },
  { name: "Czech", language: "Czech", country: "—", code: "cs" },
  { name: "Danish", language: "Danish", country: "—", code: "da" },
  { name: "Dutch", language: "Dutch", country: "Netherlands", code: "nl-NL" },
  { name: "English (Australia)", language: "English", country: "Australia", code: "en-AU" },
  { name: "English (Canada)", language: "English", country: "Canada", code: "en-CA" },
  { name: "English (U.K.)", language: "English", country: "U.K.", code: "en-GB" },
  { name: "English (U.S.)", language: "English", country: "U.S.", code: "en-US" },
  { name: "Finnish", language: "Finnish", country: "—", code: "fi" },
  { name: "French", language: "French", country: "France", code: "fr-FR" },
  { name: "French (Canada)", language: "French", country: "Canada", code: "fr-CA" },
  { name: "German", language: "German", country: "Germany", code: "de-DE" },
  { name: "Greek", language: "Greek", country: "—", code: "el" },
  { name: "Hebrew", language: "Hebrew", country: "—", code: "he" },
  { name: "Hindi", language: "Hindi", country: "—", code: "hi" },
  { name: "Hungarian", language: "Hungarian", country: "—", code: "hu" },
  { name: "Indonesian", language: "Indonesian", country: "—", code: "id" },
  { name: "Italian", language: "Italian", country: "—", code: "it" },
  { name: "Japanese", language: "Japanese", country: "—", code: "ja" },
  { name: "Korean", language: "Korean", country: "—", code: "ko" },
  { name: "Malay", language: "Malay", country: "—", code: "ms" },
  { name: "Norwegian", language: "Norwegian", country: "—", code: "no" },
  { name: "Polish", language: "Polish", country: "—", code: "pl" },
  { name: "Portuguese (Brazil)", language: "Portuguese", country: "Brazil", code: "pt-BR" },
  { name: "Portuguese (Portugal)", language: "Portuguese", country: "Portugal", code: "pt-PT" },
  { name: "Romanian", language: "Romanian", country: "—", code: "ro" },
  { name: "Russian", language: "Russian", country: "—", code: "ru" },
  { name: "Slovak", language: "Slovak", country: "—", code: "sk" },
  { name: "Spanish (Mexico)", language: "Spanish", country: "Mexico", code: "es-MX" },
  { name: "Spanish (Spain)", language: "Spanish", country: "Spain", code: "es-ES" },
  { name: "Swedish", language: "Swedish", country: "—", code: "sv" },
  { name: "Thai", language: "Thai", country: "—", code: "th" },
  { name: "Turkish", language: "Turkish", country: "—", code: "tr" },
  { name: "Ukrainian", language: "Ukrainian", country: "—", code: "uk" },
  { name: "Vietnamese", language: "Vietnamese", country: "—", code: "vi" },
];

/** Locale whose pair the SAMPLE rows fill. "First selected in canonical
 *  order" with one deliberate exception: Vietnamese wins when it is in
 *  the selection. That keeps the FULL template byte-identical to the
 *  pre-picker file (whose samples came from the Manager's own
 *  Vietnamese source rows) — the full selection also keeps the original
 *  filename, so its content must not silently change either. */
function preferredSampleLocale(chosen: readonly string[]): string | undefined {
  return chosen.includes("Vietnamese") ? "Vietnamese" : chosen[0];
}

export function appleLocalePairHeaders(
  selected?: readonly string[],
): string[] {
  return resolveSelectedLocales(APPLE_LOCALE_NAMES, selected).flatMap(
    (name) => [`Display Name (${name})`, `Description (${name})`],
  );
}

/** Canonical header row for a selection: 6 lead columns ALWAYS, plus a
 *  pair per selected locale in canonical order. `undefined` = full set
 *  (6 + 39×2 = 84 columns); `[]` = core-only (6 columns), the picker's
 *  default path. */
export function appleTemplateHeaders(selected?: readonly string[]): string[] {
  return [...APPLE_LEAD_HEADER_ROW, ...appleLocalePairHeaders(selected)];
}

/** Example-row values, genericized from the Manager's source file
 *  (apple-item-iap-test.xlsx, August 2026). Product IDs come from the
 *  shared TEMPLATE_SAMPLE_PRODUCT_IDS skip list. USD prices are the
 *  Manager's (0.49 / 4.09 / 12.49). GT Price / GT Currency are left
 *  BLANK, deviating from the source's constant 23000/VND: those columns
 *  are currently NOT applied for Apple (parsed into base_price/
 *  base_currency, consumed nowhere downstream — Apple pricing comes
 *  from Price (USD) → tier inference → price schedule), and filling an
 *  inert column would teach a wrong pattern. The locale pair is filled
 *  for the FIRST SELECTED locale (canonical order) so an imported copy
 *  is metadata-complete; with zero locales selected the rows carry no
 *  locale cells at all. */
const SAMPLE_ROW_VALUES = TEMPLATE_SAMPLE_PRODUCT_IDS.map((id, i) => ({
  productId: id,
  referenceName: `Sample product 0${i + 1}`,
  priceUsd: [0.49, 4.09, 12.49][i],
  gtPrice: "",
  gtCurrency: "",
  displayName: `Sample product 0${i + 1}`,
  description: `Sample product 0${i + 1} - import, default price template`,
}));

/** The pre-filled data-sheet rows: 3 samples, a spacer, and the visible
 *  delete-me warning in a row whose Product ID cell is EMPTY (both
 *  parsers skip ID-less rows, so the note never parses as data).
 *  A sample row NEVER references a column absent from the selection. */
export function appleTemplateDataRows(
  selected?: readonly string[],
): (string | number)[][] {
  const headers = appleTemplateHeaders(selected);
  const col = (name: string) => headers.indexOf(name);
  const sampleLocale = preferredSampleLocale(
    resolveSelectedLocales(APPLE_LOCALE_NAMES, selected),
  );
  const rows = SAMPLE_ROW_VALUES.map((v) => {
    const row: (string | number)[] = headers.map(() => "");
    row[col(APPLE_LEAD_HEADERS.productId)] = v.productId;
    row[col(APPLE_LEAD_HEADERS.referenceName)] = v.referenceName;
    // Type left empty on purpose — demonstrates the Hotfix 27 default
    // (empty → CONSUMABLE), matching the Manager's source rows.
    row[col(APPLE_LEAD_HEADERS.priceUsd)] = v.priceUsd;
    row[col(APPLE_LEAD_HEADERS.gtPrice)] = v.gtPrice;
    row[col(APPLE_LEAD_HEADERS.gtCurrency)] = v.gtCurrency;
    if (sampleLocale !== undefined) {
      row[col(`Display Name (${sampleLocale})`)] = v.displayName;
      row[col(`Description (${sampleLocale})`)] = v.description;
    }
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
      "⚠ Currently NOT applied for Apple: the import parses this column (with GT Currency) but nothing downstream consumes it — Apple pricing comes from Price (USD) → tier inference → price schedule. Safe to leave blank (the sample rows do).",
  },
  gtCurrency: {
    required: "Optional",
    meaning:
      '⚠ Currently NOT applied for Apple — see GT Price. Currency code for GT Price, e.g. "VND", if you fill the pair anyway.',
  },
};

function appleNotesRows(selected?: readonly string[]): (string | number)[][] {
  const leadKeys = Object.keys(
    APPLE_LEAD_HEADERS,
  ) as (keyof typeof APPLE_LEAD_HEADERS)[];
  const chosen = resolveSelectedLocales(APPLE_LOCALE_NAMES, selected);
  const sampleLocale = preferredSampleLocale(chosen);
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
    ...(chosen.length > 0
      ? [
          [
            "Display Name (<Locale>) + Description (<Locale>)",
            "Optional",
            `${chosen.length} locale pair(s) included in THIS file (${chosen.join(", ")}) — chosen at download; the full Apple set is ${APPLE_LOCALE_NAMES.length}. Fill BOTH cells of a pair, or leave BOTH empty (that locale is skipped). Filling only one of the two produces a warning and the locale is skipped.`,
          ],
        ]
      : [
          [
            "(no locale columns)",
            "—",
            `This file was downloaded with NO locales selected, so it has only the core columns above (the full Apple set is ${APPLE_LOCALE_NAMES.length} locale pairs — download again and pick locales if you need them). Importing these rows CREATES products with no localizations: they stay metadata-incomplete on App Store Connect until you add localizations there or import a file that includes locale columns. Existing localizations on products you overwrite are PRESERVED — Apple never drops an IAP to zero localizations.`,
          ],
        ]),
    [],
    [
      `UNIT REMINDER: "${APPLE_LEAD_HEADERS.priceUsd}" is US dollars — it is what actually drives Apple pricing (tier inference → price schedule). GT Price / GT Currency are parsed but currently NOT applied for Apple; if filled, GT Price is a PRICE in GT Currency, NOT an exchange rate.`,
    ],
    [],
    [
      `SAMPLE ROWS: the "${APPLE_DATA_SHEET_NAME}" sheet comes PRE-FILLED with the 3 sample rows below. Delete them or replace them with your real products. Rows keeping the sample Product IDs (${TEMPLATE_SAMPLE_PRODUCT_IDS.join(", ")}) are skipped automatically on import — any other Product ID in the data sheet is imported as a REAL store product.`,
    ],
    // The illustrative table mirrors THIS file's columns — never a
    // column the selection excluded.
    [
      ...APPLE_LEAD_HEADER_ROW,
      ...(sampleLocale !== undefined
        ? [`Display Name (${sampleLocale})`, `Description (${sampleLocale})`]
        : []),
    ],
    ...SAMPLE_ROW_VALUES.map((v) => [
      v.productId,
      v.referenceName,
      "",
      v.priceUsd,
      v.gtPrice,
      v.gtCurrency,
      ...(sampleLocale !== undefined ? [v.displayName, v.description] : []),
    ]),
  ];
}

/** Complete spec for lib/xlsx-template.buildTemplateWorkbook /
 *  downloadXlsxTemplate.
 *
 *  `selectedLocaleNames` comes from the download modal's locale picker:
 *  `undefined` = FULL set (pre-picker behaviour, byte-identical output
 *  and filename), `[]` = core columns only (the picker's default path,
 *  nothing pre-ticked). Names are keys of APPLE_LOCALE_OPTIONS /
 *  locale-map.json; unknown names are ignored by resolveSelectedLocales
 *  rather than emitting a header no parser would match. */
export function appleIapTemplateSpec(
  selectedLocaleNames?: readonly string[],
): XlsxTemplateSpec {
  const chosen = resolveSelectedLocales(
    APPLE_LOCALE_NAMES,
    selectedLocaleNames,
  );
  return {
    dataSheetName: APPLE_DATA_SHEET_NAME,
    headers: appleTemplateHeaders(selectedLocaleNames),
    dataRows: appleTemplateDataRows(selectedLocaleNames),
    notesSheetName: APPLE_NOTES_SHEET_NAME,
    notesRows: appleNotesRows(selectedLocaleNames),
    filename: templateFilenameFor(
      APPLE_TEMPLATE_FILENAME,
      chosen.length,
      APPLE_LOCALE_NAMES.length,
    ),
  };
}
