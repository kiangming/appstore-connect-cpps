/**
 * Google bulk-import template spec — SINGLE SOURCE OF TRUTH for the
 * column contract, consumed by BOTH:
 *   - the parser (excel-parser.ts — fixed-header matching, locale map,
 *     data-sheet name), and
 *   - the "Download template" generator (googleIapTemplateSpec → shared
 *     lib/xlsx-template.ts).
 * A parser column change that forgets the template fails the anti-drift
 * tests in template-spec.test.ts instead of reaching users
 * (design-bulk-import-template-download.md §A/§D).
 *
 * Client-safe by construction: ZERO imports — no xlsx (excel-parser.ts
 * imports xlsx statically, which is why the consts live here and not
 * there: the client wizard must be able to import this module without
 * pulling xlsx into the initial bundle), no server-only deps.
 *
 * Canonical shape: 2 lead headers + 82 locale pairs = 166 columns.
 * ([GOOGLE-bulkimport-drop-gt], 2026-10-21: "GT Price" / "GT Currency" are no
 * longer emitted; old files still import, see GOOGLE_RETIRED_GT_HEADERS.)
 * The price header is FIXED "Price (USD)" — Manager decision. The
 * parser reads the currency from the header ONLY (H4.1): exactly one
 * "Price (XXX)" column, in a currency Google Play bills in; a header
 * without its currency is refused. This const is the EMISSION canonical
 * form only — the parser accepts any "Price (XXX)". The Notes text below
 * describes H4 (H4.1–H4.3): the file's price, in its header currency, is
 * the only price source — the app's currency takes no part — and a row
 * the tool cannot send exactly is refused with its reason in the preview.
 *
 * The locale map previously lived inline in excel-parser.ts (which
 * re-exports it for back-compat). Map keys are unique by construction,
 * so the generated template can never contain the duplicate locale
 * columns the legacy v1 Manager artifact shipped with (Title/Description
 * (English) ×3, (Persian) ×4 — silently last-win in the parser).
 */

import type { XlsxTemplateSpec, LocaleOption } from "@/lib/xlsx-template";
import {
  TEMPLATE_SAMPLE_PRODUCT_IDS,
  TEMPLATE_SAMPLE_ROWS_NOTE,
  resolveSelectedLocales,
  templateFilenameFor,
} from "@/lib/xlsx-template";

/** Data-sheet name the parser selects BY NAME (sheet-selection
 *  hardening, design §C). Legacy files without it fall back to the
 *  first sheet. */
export const GOOGLE_DATA_SHEET_NAME = "IAP Items";
export const GOOGLE_NOTES_SHEET_NAME = "Notes";
/** Symmetric, platform-identifying download name (Manager directive,
 *  August 2026): both modules' templates land in the same Downloads
 *  folder, so the name must say which platform it belongs to. Pattern
 *  `<platform>-iap-bulk-import-template.xlsx`, mirrored by the Apple
 *  module. INTENTIONALLY diverges from the Manager's original artifact
 *  name (template-item-iap-google.xlsx): the generated file's content
 *  differs from that artifact (auto-skipped sample rows, Notes sheet,
 *  no duplicate locale columns). The legacy artifact keeps its name at
 *  docs/google-iap-management/templates/. */
export const GOOGLE_TEMPLATE_FILENAME = "google-iap-bulk-import-template.xlsx";

export const GOOGLE_PRODUCT_ID_HEADER = "Product ID";
/** FIXED USD — Manager-locked decision. Safe for an app in any currency:
 *  the parser reads the currency from this header only, and the app's
 *  currency takes no part in bulk-import pricing (H4 — module doc above). */
export const GOOGLE_PRICE_HEADER = "Price (USD)";

/** Lead headers the template USED to carry and no longer does
 *  ([GOOGLE-bulkimport-drop-gt], Manager 2026-10-21, Q1). The team filled
 *  them but never meant them as prices, while the tool posted GT Price as
 *  that currency's region price — a bug against that intent. Files made
 *  before still have them; the parser RECOGNISES these names (any case or
 *  spacing, either one alone) and NEVER reads them: not as a price, not
 *  checked, not sent. The preview says so (googleRetiredGtWarning) without
 *  blocking anything. Removing the names from the parser altogether would
 *  refuse every file in circulation: "GT Price" looks like a price column. */
export const GOOGLE_RETIRED_GT_HEADERS: readonly string[] = ["GT Price", "GT Currency"];

/** What the parser found of the retired GT columns (null = none in the file).
 *  `rowsWithData` counts every row below the header with a non-empty GT
 *  cell — template sample rows and rows with no Product ID included: it
 *  measures what is left in those columns, not what is imported. */
export type RetiredGtColumns = { rowsWithData: number } | null;

/** THE wording of the preview's GT notice (Manager Q1, approved at gate G0
 *  2026-10-21). Never blocks Push, never refuses a row — the columns are
 *  ignored either way. null when the file has no GT column. */
export function googleRetiredGtWarning(gt: RetiredGtColumns): { kind: "data" | "empty"; text: string } | null {
  if (!gt) return null;
  if (gt.rowsWithData > 0) {
    return {
      kind: "data",
      text:
        "File còn dữ liệu ở cột GT Price / GT Currency. Tool KHÔNG dùng hai cột này cho Google — giá chỉ lấy từ cột Price. " +
        `Hãy xoá trống dữ liệu hoặc xoá hẳn hai cột này trong file. Số dòng có điền GT: ${gt.rowsWithData}.`,
    };
  }
  return {
    kind: "empty",
    text: "File còn hai cột GT Price / GT Currency (trống). Tool không dùng hai cột này — có thể xoá hẳn hai cột khỏi file.",
  };
}

/** Emission order of the lead headers in the generated template. */
export const GOOGLE_LEAD_HEADER_ROW: readonly string[] = [GOOGLE_PRODUCT_ID_HEADER, GOOGLE_PRICE_HEADER];

/** Manager-display locale name → Google Play BCP-47 locale code.
 *  82 entries — the parser matches Title/Description headers against
 *  these keys; the generator emits one pair per key. */
export const LOCALE_NAME_TO_BCP47: Record<string, string> = {
  Afrikaans: "af",
  Albanian: "sq",
  Amharic: "am",
  Arabic: "ar",
  Armenian: "hy-AM",
  Azerbaijani: "az-AZ",
  Bangla: "bn-BD",
  Basque: "eu-ES",
  Belarusian: "be",
  Bulgarian: "bg",
  Burmese: "my-MM",
  Catalan: "ca",
  "Chinese (Hong Kong)": "zh-HK",
  "Chinese (Simplified)": "zh-CN",
  "Chinese (Traditional)": "zh-TW",
  Croatian: "hr",
  Czech: "cs-CZ",
  Danish: "da-DK",
  Dutch: "nl-NL",
  English: "en",
  "English (Australia)": "en-AU",
  "English (Canada)": "en-CA",
  "English (United Kingdom)": "en-GB",
  "English (United States)": "en-US",
  Estonian: "et",
  Filipino: "fil",
  Finnish: "fi-FI",
  "French (Canada)": "fr-CA",
  "French (France)": "fr-FR",
  Galician: "gl-ES",
  Georgian: "ka-GE",
  German: "de-DE",
  Greek: "el-GR",
  Gujarati: "gu",
  Hebrew: "iw-IL",
  Hindi: "hi-IN",
  Hungarian: "hu-HU",
  Icelandic: "is-IS",
  Indonesian: "id",
  Italian: "it-IT",
  Japanese: "ja-JP",
  Kannada: "kn-IN",
  Kazakh: "kk",
  Khmer: "km-KH",
  Korean: "ko-KR",
  Kyrgyz: "ky-KG",
  Lao: "lo-LA",
  Latvian: "lv",
  Lithuanian: "lt",
  Macedonian: "mk-MK",
  Malay: "ms",
  "Malay (Malaysia)": "ms-MY",
  Malayalam: "ml-IN",
  Marathi: "mr-IN",
  Mongolian: "mn-MN",
  Nepali: "ne-NP",
  Norwegian: "no-NO",
  Persian: "fa",
  Polish: "pl-PL",
  "Portuguese (Brazil)": "pt-BR",
  "Portuguese (Portugal)": "pt-PT",
  Punjabi: "pa",
  Romanian: "ro",
  Romansh: "rm",
  Russian: "ru-RU",
  Serbian: "sr",
  Sinhala: "si-LK",
  Slovak: "sk",
  Slovenian: "sl",
  "Spanish (Latin America)": "es-419",
  "Spanish (Spain)": "es-ES",
  "Spanish (United States)": "es-US",
  Swahili: "sw",
  Swedish: "sv-SE",
  Tamil: "ta-IN",
  Telugu: "te-IN",
  Thai: "th",
  Turkish: "tr-TR",
  Ukrainian: "uk",
  Urdu: "ur",
  Vietnamese: "vi",
  Zulu: "zu",
};

/** The 82 locale display names, in map (emission) order. */
export const GOOGLE_LOCALE_NAMES: readonly string[] = Object.keys(
  LOCALE_NAME_TO_BCP47,
);

/** Locale-picker rows (display-only strings precomputed at authoring
 *  time — see LocaleOption). `name` is the parser-matched key, so a
 *  selection is a list of these names. `country` is "—" for the ~30
 *  language-only Google locales; the code column stays visible in the
 *  modal because Google's generic "English" (en) sits alongside four
 *  regional English variants. Exhaustiveness against
 *  LOCALE_NAME_TO_BCP47 is pinned by template-spec.test.ts. */
export const GOOGLE_LOCALE_OPTIONS: readonly LocaleOption[] = [
  { name: "Afrikaans", language: "Afrikaans", country: "—", code: "af" },
  { name: "Albanian", language: "Albanian", country: "—", code: "sq" },
  { name: "Amharic", language: "Amharic", country: "—", code: "am" },
  { name: "Arabic", language: "Arabic", country: "—", code: "ar" },
  { name: "Armenian", language: "Armenian", country: "Armenia", code: "hy-AM" },
  { name: "Azerbaijani", language: "Azerbaijani", country: "Azerbaijan", code: "az-AZ" },
  { name: "Bangla", language: "Bangla", country: "Bangladesh", code: "bn-BD" },
  { name: "Basque", language: "Basque", country: "Spain", code: "eu-ES" },
  { name: "Belarusian", language: "Belarusian", country: "—", code: "be" },
  { name: "Bulgarian", language: "Bulgarian", country: "—", code: "bg" },
  { name: "Burmese", language: "Burmese", country: "Myanmar (Burma)", code: "my-MM" },
  { name: "Catalan", language: "Catalan", country: "—", code: "ca" },
  { name: "Chinese (Hong Kong)", language: "Chinese", country: "Hong Kong", code: "zh-HK" },
  { name: "Chinese (Simplified)", language: "Chinese", country: "Simplified", code: "zh-CN" },
  { name: "Chinese (Traditional)", language: "Chinese", country: "Traditional", code: "zh-TW" },
  { name: "Croatian", language: "Croatian", country: "—", code: "hr" },
  { name: "Czech", language: "Czech", country: "Czechia", code: "cs-CZ" },
  { name: "Danish", language: "Danish", country: "Denmark", code: "da-DK" },
  { name: "Dutch", language: "Dutch", country: "Netherlands", code: "nl-NL" },
  { name: "English", language: "English", country: "—", code: "en" },
  { name: "English (Australia)", language: "English", country: "Australia", code: "en-AU" },
  { name: "English (Canada)", language: "English", country: "Canada", code: "en-CA" },
  { name: "English (United Kingdom)", language: "English", country: "United Kingdom", code: "en-GB" },
  { name: "English (United States)", language: "English", country: "United States", code: "en-US" },
  { name: "Estonian", language: "Estonian", country: "—", code: "et" },
  { name: "Filipino", language: "Filipino", country: "—", code: "fil" },
  { name: "Finnish", language: "Finnish", country: "Finland", code: "fi-FI" },
  { name: "French (Canada)", language: "French", country: "Canada", code: "fr-CA" },
  { name: "French (France)", language: "French", country: "France", code: "fr-FR" },
  { name: "Galician", language: "Galician", country: "Spain", code: "gl-ES" },
  { name: "Georgian", language: "Georgian", country: "Georgia", code: "ka-GE" },
  { name: "German", language: "German", country: "Germany", code: "de-DE" },
  { name: "Greek", language: "Greek", country: "Greece", code: "el-GR" },
  { name: "Gujarati", language: "Gujarati", country: "—", code: "gu" },
  { name: "Hebrew", language: "Hebrew", country: "Israel", code: "iw-IL" },
  { name: "Hindi", language: "Hindi", country: "India", code: "hi-IN" },
  { name: "Hungarian", language: "Hungarian", country: "Hungary", code: "hu-HU" },
  { name: "Icelandic", language: "Icelandic", country: "Iceland", code: "is-IS" },
  { name: "Indonesian", language: "Indonesian", country: "—", code: "id" },
  { name: "Italian", language: "Italian", country: "Italy", code: "it-IT" },
  { name: "Japanese", language: "Japanese", country: "Japan", code: "ja-JP" },
  { name: "Kannada", language: "Kannada", country: "India", code: "kn-IN" },
  { name: "Kazakh", language: "Kazakh", country: "—", code: "kk" },
  { name: "Khmer", language: "Khmer", country: "Cambodia", code: "km-KH" },
  { name: "Korean", language: "Korean", country: "South Korea", code: "ko-KR" },
  { name: "Kyrgyz", language: "Kyrgyz", country: "Kyrgyzstan", code: "ky-KG" },
  { name: "Lao", language: "Lao", country: "Laos", code: "lo-LA" },
  { name: "Latvian", language: "Latvian", country: "—", code: "lv" },
  { name: "Lithuanian", language: "Lithuanian", country: "—", code: "lt" },
  { name: "Macedonian", language: "Macedonian", country: "North Macedonia", code: "mk-MK" },
  { name: "Malay", language: "Malay", country: "—", code: "ms" },
  { name: "Malay (Malaysia)", language: "Malay", country: "Malaysia", code: "ms-MY" },
  { name: "Malayalam", language: "Malayalam", country: "India", code: "ml-IN" },
  { name: "Marathi", language: "Marathi", country: "India", code: "mr-IN" },
  { name: "Mongolian", language: "Mongolian", country: "Mongolia", code: "mn-MN" },
  { name: "Nepali", language: "Nepali", country: "Nepal", code: "ne-NP" },
  { name: "Norwegian", language: "Norwegian", country: "Norway", code: "no-NO" },
  { name: "Persian", language: "Persian", country: "—", code: "fa" },
  { name: "Polish", language: "Polish", country: "Poland", code: "pl-PL" },
  { name: "Portuguese (Brazil)", language: "Portuguese", country: "Brazil", code: "pt-BR" },
  { name: "Portuguese (Portugal)", language: "Portuguese", country: "Portugal", code: "pt-PT" },
  { name: "Punjabi", language: "Punjabi", country: "—", code: "pa" },
  { name: "Romanian", language: "Romanian", country: "—", code: "ro" },
  { name: "Romansh", language: "Romansh", country: "—", code: "rm" },
  { name: "Russian", language: "Russian", country: "Russia", code: "ru-RU" },
  { name: "Serbian", language: "Serbian", country: "—", code: "sr" },
  { name: "Sinhala", language: "Sinhala", country: "Sri Lanka", code: "si-LK" },
  { name: "Slovak", language: "Slovak", country: "—", code: "sk" },
  { name: "Slovenian", language: "Slovenian", country: "—", code: "sl" },
  { name: "Spanish (Latin America)", language: "Spanish", country: "Latin America", code: "es-419" },
  { name: "Spanish (Spain)", language: "Spanish", country: "Spain", code: "es-ES" },
  { name: "Spanish (United States)", language: "Spanish", country: "United States", code: "es-US" },
  { name: "Swahili", language: "Swahili", country: "—", code: "sw" },
  { name: "Swedish", language: "Swedish", country: "Sweden", code: "sv-SE" },
  { name: "Tamil", language: "Tamil", country: "India", code: "ta-IN" },
  { name: "Telugu", language: "Telugu", country: "India", code: "te-IN" },
  { name: "Thai", language: "Thai", country: "—", code: "th" },
  { name: "Turkish", language: "Turkish", country: "Türkiye", code: "tr-TR" },
  { name: "Ukrainian", language: "Ukrainian", country: "—", code: "uk" },
  { name: "Urdu", language: "Urdu", country: "—", code: "ur" },
  { name: "Vietnamese", language: "Vietnamese", country: "—", code: "vi" },
  { name: "Zulu", language: "Zulu", country: "—", code: "zu" },
];

/** Locale whose pair the SAMPLE rows fill. "First selected in canonical
 *  order" with one deliberate exception: Vietnamese wins when it is in
 *  the selection — the pre-picker file's samples came from the Manager's
 *  own Vietnamese source rows, and the full selection keeps that file's
 *  samples and filename. */
function preferredSampleLocale(chosen: readonly string[]): string | undefined {
  return chosen.includes("Vietnamese") ? "Vietnamese" : chosen[0];
}

export function googleLocalePairHeaders(
  selected?: readonly string[],
): string[] {
  return resolveSelectedLocales(GOOGLE_LOCALE_NAMES, selected).flatMap(
    (name) => [`Title (${name})`, `Description (${name})`],
  );
}

/** Canonical header row for a selection: 2 lead columns ALWAYS, plus a
 *  pair per selected locale in canonical order. `undefined` = full set
 *  (2 + 82×2 = 166 columns); `[]` = core-only (2 columns), the picker's
 *  default path. */
export function googleTemplateHeaders(selected?: readonly string[]): string[] {
  return [...GOOGLE_LEAD_HEADER_ROW, ...googleLocalePairHeaders(selected)];
}

/** Example-row values, genericized from the Manager's source file
 *  (template-item-iap-google.xlsx, August 2026; its junk 4th row
 *  excluded; its Product-ID/Title numbering mismatch reconciled to a
 *  consistent sampleNN ↔ "Sample product NN"). Product IDs come from the
 *  shared TEMPLATE_SAMPLE_PRODUCT_IDS skip list. USD prices are the
 *  Manager's (0.99 / 1.99 / 22.99). */
const SAMPLE_ROW_VALUES = TEMPLATE_SAMPLE_PRODUCT_IDS.map((id, i) => ({
  productId: id,
  priceUsd: [0.99, 1.99, 22.99][i],
  title: `Sample product 0${i + 1}`,
  description: `Sample product 0${i + 1} - import, default price template`,
}));

/** The 3 sample products as rows UNDER `headers`, every value placed by
 *  header NAME. ONE builder for the data sheet AND the Notes illustration,
 *  so neither can drift from its own header row (the Notes table used to
 *  be a positional array — Apple's lesson when it dropped the same two
 *  columns). A header the row needs but `headers` lacks throws (a
 *  programming error, never user input). */
function sampleRows(headers: readonly string[], sampleLocale: string | undefined): (string | number)[][] {
  const col = (name: string) => {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error(`sample row: the header row has no "${name}" column`);
    return i;
  };
  return SAMPLE_ROW_VALUES.map((v) => {
    const row: (string | number)[] = headers.map(() => "");
    row[col(GOOGLE_PRODUCT_ID_HEADER)] = v.productId;
    row[col(GOOGLE_PRICE_HEADER)] = v.priceUsd;
    if (sampleLocale !== undefined) {
      row[col(`Title (${sampleLocale})`)] = v.title;
      row[col(`Description (${sampleLocale})`)] = v.description;
    }
    return row;
  });
}

/** The pre-filled data-sheet rows: 3 samples, a spacer, and the visible
 *  delete-me warning in a row whose Product ID cell is EMPTY. Since H4.3 a
 *  SKU-less row that states a product (price, title or description) is
 *  REFUSED, not skipped — the note sits in the price column, so the parser
 *  recognises it by its exact text (TEMPLATE_SAMPLE_ROWS_NOTE,
 *  excel-parser.ts rowStatesAProduct) and ignores it; it never parses or
 *  refuses as data.
 *  A sample row NEVER references a column absent from the selection. */
export function googleTemplateDataRows(
  selected?: readonly string[],
): (string | number)[][] {
  const sampleLocale = preferredSampleLocale(
    resolveSelectedLocales(GOOGLE_LOCALE_NAMES, selected),
  );
  // Truly empty spacer ([] → no cells written), then the note with an
  // EMPTY Product ID cell so the parser ignores the row.
  return [...sampleRows(googleTemplateHeaders(selected), sampleLocale), [], ["", TEMPLATE_SAMPLE_ROWS_NOTE]];
}

function googleNotesRows(selected?: readonly string[]): (string | number)[][] {
  const chosen = resolveSelectedLocales(GOOGLE_LOCALE_NAMES, selected);
  const sampleLocale = preferredSampleLocale(chosen);
  const noteTableHeaders = [
    ...GOOGLE_LEAD_HEADER_ROW,
    ...(sampleLocale !== undefined ? [`Title (${sampleLocale})`, `Description (${sampleLocale})`] : []),
  ];
  return [
    ["Google IAP bulk-import template — how to fill"],
    [],
    [
      `Enter one product per row in the "${GOOGLE_DATA_SHEET_NAME}" sheet, under the headers. Do not rename that sheet — the import looks it up by name.`,
    ],
    [
      "This Notes sheet is ignored by the import — keeping or deleting it makes no difference.",
    ],
    [],
    ["Column", "Required?", "Meaning / allowed values"],
    [
      GOOGLE_PRODUCT_ID_HEADER,
      "REQUIRED",
      "SKU — unique per app. A row with data but no Product ID is not imported (the preview lists it with the reason).",
    ],
    [
      GOOGLE_PRICE_HEADER,
      "REQUIRED",
      "⚠ US DOLLARS (USD) — the currency is the one in this header, whatever the app's own currency is; the app's currency is not used. Example: 0.99 here means USD 0.99. A pricing template is matched by the tier named after the Product ID, else by this price in the header's currency; other countries are converted by Google from this price. To price in another currency, rename the header (e.g. \"Price (VND)\") to a currency Google Play bills in — exactly one price column per file. A header without its currency (\"Price\", \"Default Price\", \"Base Price\") or a second price column refuses the whole file. A row with an empty price is not imported (the preview lists it with the reason); a 0 price, or more decimals than the currency allows, keeps the row out. In a currency without decimals (VND, JPY…) write the number without separators: \"26.000\" typed as text keeps the row out (it may mean 26 thousand).",
    ],
    ...(chosen.length > 0
      ? [
          [
            "Title (<Locale>) + Description (<Locale>)",
            "Optional",
            `${chosen.length} locale pair(s) included in THIS file (${chosen.join(", ")}) — chosen at download; the full Google set is ${GOOGLE_LOCALE_NAMES.length}. Pairs left fully empty are skipped for that row.`,
          ],
        ]
      : [
          [
            "(no locale columns)",
            "—",
            `This file was downloaded with NO locales selected, so it has only the core columns above (the full Google set is ${GOOGLE_LOCALE_NAMES.length} locale pairs — download again and pick locales if you need them). NEW products import with a single fallback en-US listing whose title is the SKU itself.`,
          ],
          [
            "⚠ OVERWRITE CAUTION",
            "—",
            "If you use this core-only file to OVERWRITE products that already exist on Google Play, their CURRENT store listings are REPLACED by that SKU-titled en-US listing — a product titled in Vietnamese would end up titled with its raw SKU. Download a template WITH the locales you need (and fill them) before overwriting existing products. The wizard also warns about this in the Preview step.",
          ],
        ]),
    [],
    [
      `UNIT REMINDER: "${GOOGLE_PRICE_HEADER}" is US dollars — the header's currency, not the app's.`,
    ],
    [
      "COPYING FROM ANOTHER FILE: copy column by column, under the same headers — never paste whole rows from an older template. Its columns can differ from this one, and a pasted row puts values under the wrong headers — a price can end up as a product's title.",
    ],
    [],
    [
      `SAMPLE ROWS: the "${GOOGLE_DATA_SHEET_NAME}" sheet comes PRE-FILLED with the 3 sample rows below. Delete them or replace them with your real products. Rows keeping the sample Product IDs (${TEMPLATE_SAMPLE_PRODUCT_IDS.join(", ")}) are skipped automatically on import — any other Product ID in the data sheet is imported as a REAL store product.`,
    ],
    // The illustrative table mirrors THIS file's columns — never a
    // column the selection excluded — and its rows come from the SAME
    // by-name builder as the data sheet.
    noteTableHeaders,
    ...sampleRows(noteTableHeaders, sampleLocale),
  ];
}

/** Complete spec for lib/xlsx-template.buildTemplateWorkbook /
 *  downloadXlsxTemplate.
 *
 *  `selectedLocaleNames` comes from the download modal's locale picker:
 *  `undefined` = FULL set (every locale, the original filename and
 *  Vietnamese samples — see preferredSampleLocale; its content changed on
 *  purpose with [GOOGLE-bulkimport-drop-gt]: 166 columns, no GT), `[]` = core
 *  columns only (the picker's default path,
 *  nothing pre-ticked). Names are keys of GOOGLE_LOCALE_OPTIONS /
 *  LOCALE_NAME_TO_BCP47; unknown names are ignored by
 *  resolveSelectedLocales rather than emitting a header no parser would
 *  match. */
export function googleIapTemplateSpec(
  selectedLocaleNames?: readonly string[],
): XlsxTemplateSpec {
  const chosen = resolveSelectedLocales(
    GOOGLE_LOCALE_NAMES,
    selectedLocaleNames,
  );
  return {
    dataSheetName: GOOGLE_DATA_SHEET_NAME,
    headers: googleTemplateHeaders(selectedLocaleNames),
    dataRows: googleTemplateDataRows(selectedLocaleNames),
    notesSheetName: GOOGLE_NOTES_SHEET_NAME,
    notesRows: googleNotesRows(selectedLocaleNames),
    filename: templateFilenameFor(
      GOOGLE_TEMPLATE_FILENAME,
      chosen.length,
      GOOGLE_LOCALE_NAMES.length,
    ),
  };
}
