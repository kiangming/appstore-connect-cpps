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
 * Canonical shape: 4 lead headers + 82 locale pairs = 168 columns.
 * The price header is FIXED "Price (USD)" — Manager decision. The
 * parser interprets the header currency EXPLICITLY (resolvePriceColumn
 * Pass 1, Hotfix 16): a "Price (USD)" file parses as USD regardless of
 * the app's default currency, and Cycle 43 cross-currency resolution
 * derives the app-currency price from the pricing template. The parser
 * itself stays flexible ("Price (XXX)" / generic "Price") — this const
 * is the EMISSION canonical form only.
 *
 * The locale map previously lived inline in excel-parser.ts (which
 * re-exports it for back-compat). Map keys are unique by construction,
 * so the generated template can never contain the duplicate locale
 * columns the legacy v1 Manager artifact shipped with (Title/Description
 * (English) ×3, (Persian) ×4 — silently last-win in the parser).
 */

import type { XlsxTemplateSpec } from "@/lib/xlsx-template";

/** Data-sheet name the parser selects BY NAME (sheet-selection
 *  hardening, design §C). Legacy files without it fall back to the
 *  first sheet. */
export const GOOGLE_DATA_SHEET_NAME = "IAP Items";
export const GOOGLE_NOTES_SHEET_NAME = "Notes";
/** Kept identical to the legacy Manager artifact name — the wizard copy
 *  and docs already reference it; the content is regenerated fresh on
 *  every click so the name needs no version/date. */
export const GOOGLE_TEMPLATE_FILENAME = "template-item-iap-google.xlsx";

export const GOOGLE_PRODUCT_ID_HEADER = "Product ID";
/** FIXED USD — Manager-locked decision (see module doc above for why
 *  this is safe against non-USD apps). */
export const GOOGLE_PRICE_HEADER = "Price (USD)";
export const GOOGLE_GT_PRICE_HEADER = "GT Price";
export const GOOGLE_GT_CURRENCY_HEADER = "GT Currency";

/** Emission order of the lead headers in the generated template. */
export const GOOGLE_LEAD_HEADER_ROW: readonly string[] = [
  GOOGLE_PRODUCT_ID_HEADER,
  GOOGLE_PRICE_HEADER,
  GOOGLE_GT_PRICE_HEADER,
  GOOGLE_GT_CURRENCY_HEADER,
];

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

export function googleLocalePairHeaders(): string[] {
  return GOOGLE_LOCALE_NAMES.flatMap((name) => [
    `Title (${name})`,
    `Description (${name})`,
  ]);
}

/** Full canonical header row — 4 lead + 82×2 locale = 168 columns. */
export function googleTemplateHeaders(): string[] {
  return [...GOOGLE_LEAD_HEADER_ROW, ...googleLocalePairHeaders()];
}

function googleNotesRows(): (string | number)[][] {
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
      "SKU — unique per app. Rows without it are skipped.",
    ],
    [
      GOOGLE_PRICE_HEADER,
      "REQUIRED",
      "⚠ US DOLLARS (USD) — ALWAYS, even when the app's default currency is not USD. The tool resolves the app-currency price from your pricing template during import (cross-currency). Example: 0.99 here means USD 0.99, NOT 0.99 of the app currency. Rows with an empty price are skipped with a warning.",
    ],
    [
      GOOGLE_GT_PRICE_HEADER,
      "Optional",
      "Override price, in the currency given in GT Currency. Must be filled together with GT Currency or the override is dropped with a warning.",
    ],
    [
      GOOGLE_GT_CURRENCY_HEADER,
      "Optional",
      'Currency code for GT Price, e.g. "VND" — mapped to that currency\'s primary region.',
    ],
    [
      "Title (<Locale>) + Description (<Locale>)",
      "Optional",
      `${GOOGLE_LOCALE_NAMES.length} locale pairs. Pairs left fully empty are skipped for that row.`,
    ],
    [],
    [
      `UNIT REMINDER: "${GOOGLE_PRICE_HEADER}" is US dollars — NOT the app's default currency. GT Price is in the GT Currency you specify on the same row.`,
    ],
    [],
    [
      `Example — ILLUSTRATION ONLY. Do NOT paste these rows into the "${GOOGLE_DATA_SHEET_NAME}" sheet: rows in the data sheet are imported as REAL store products.`,
    ],
    [
      ...GOOGLE_LEAD_HEADER_ROW,
      "Title (English (United States))",
      "Description (English (United States))",
    ],
    [
      "com.vng.example.product1",
      0.99,
      23000,
      "VND",
      "100 Gems",
      "A pack of 100 gems",
    ],
    [
      "com.vng.example.product2",
      4.99,
      "",
      "",
      "Starter Bundle",
      "One-time starter bundle",
    ],
  ];
}

/** Complete spec for lib/xlsx-template.buildTemplateWorkbook /
 *  downloadXlsxTemplate. */
export function googleIapTemplateSpec(): XlsxTemplateSpec {
  return {
    dataSheetName: GOOGLE_DATA_SHEET_NAME,
    headers: googleTemplateHeaders(),
    notesSheetName: GOOGLE_NOTES_SHEET_NAME,
    notesRows: googleNotesRows(),
    filename: GOOGLE_TEMPLATE_FILENAME,
  };
}
