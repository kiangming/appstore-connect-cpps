/**
 * Excel parser for the Manager-delivered IAP bulk-import template
 * (docs/google-iap-management/templates/template-item-iap-google.xlsx).
 *
 * Template shape (Sheet1, single sheet):
 *   Col A:  Product ID (SKU)
 *   Col B:  Price (USD)              — base price, decimal
 *   Col C:  GT Price                  — optional "Game Tier" override decimal
 *   Col D:  GT Currency               — currency for col C (e.g. "VND")
 *   Col E+: alternating Title/Description columns, one pair per locale
 *           "Title (English (United States))" / "Description (English (United States))"
 *
 * Q-GIAP.D: format pinned down by Manager template delivery
 * (2026-05-21). The parser tolerates extra columns and skips
 * unrecognised locale columns with a warning so future template
 * iterations don't break the import.
 *
 * Locale display names map to BCP-47 codes; the table below covers the
 * 82 locale columns observed in the v1 template. Unknown names are
 * skipped with a warning — the import proceeds for the rest.
 */
import * as XLSX from "xlsx";

import { COMMON_REGIONS } from "../regions";

/** Manager-display locale name → Google Play BCP-47 locale code. */
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

/** Reverse: currency → primary region for GT Price/Currency override.
 *  Covers the regions in our COMMON_REGIONS list plus a few extra commonly
 *  seen GT currencies. */
const CURRENCY_TO_REGION_OVERRIDES: Record<string, string> = {
  // The Manager's template uses VND as the prototypical GT currency; widen
  // the map to other markets they may add later. If a row's GT Currency is
  // not in this map the parser drops the override with a warning.
  USD: "US",
  EUR: "DE",
  GBP: "GB",
  JPY: "JP",
  KRW: "KR",
  CNY: "CN",
  TWD: "TW",
  HKD: "HK",
  INR: "IN",
  IDR: "ID",
  THB: "TH",
  VND: "VN",
  PHP: "PH",
  SGD: "SG",
  MYR: "MY",
  AUD: "AU",
  NZD: "NZ",
  CAD: "CA",
  MXN: "MX",
  BRL: "BR",
  ARS: "AR",
  RUB: "RU",
  TRY: "TR",
  SAR: "SA",
  AED: "AE",
};

export function regionForCurrency(currency: string): string | null {
  const norm = currency.trim().toUpperCase();
  if (CURRENCY_TO_REGION_OVERRIDES[norm]) {
    return CURRENCY_TO_REGION_OVERRIDES[norm];
  }
  // Fall back: first matching region in COMMON_REGIONS
  const fallback = COMMON_REGIONS.find((r) => r.currency === norm);
  return fallback?.code ?? null;
}

export interface ParsedListing {
  locale: string;
  title: string;
  description: string;
}

export interface ParsedRegionOverride {
  region: string;
  currency: string;
  priceDecimal: string;
}

export interface ParsedIapRow {
  /** 1-indexed row number for Manager-facing error messages. */
  rowNumber: number;
  sku: string;
  baseCurrency: string;
  basePriceDecimal: string;
  regionOverrides: ParsedRegionOverride[];
  listings: ParsedListing[];
}

export interface ParseResult {
  rows: ParsedIapRow[];
  warnings: string[];
  errors: string[];
}

/** Column headers we recognise as non-locale at the start of the sheet. */
const FIXED_HEADERS = new Set([
  "Product ID",
  "Price (USD)",
  "GT Price",
  "GT Currency",
]);

interface ColumnIndex {
  sku?: number;
  priceUsd?: number;
  gtPrice?: number;
  gtCurrency?: number;
  /** locale → [titleCol, descCol] */
  locales: Map<string, { titleCol?: number; descCol?: number }>;
  unknownLocales: Set<string>;
}

function indexColumns(
  headerRow: Array<string | number | undefined>,
): ColumnIndex {
  const idx: ColumnIndex = {
    locales: new Map(),
    unknownLocales: new Set(),
  };

  for (let c = 0; c < headerRow.length; c += 1) {
    const raw = headerRow[c];
    if (raw === undefined || raw === null) continue;
    const header = String(raw).trim();
    if (header === "") continue;

    if (header === "Product ID") idx.sku = c;
    else if (header === "Price (USD)") idx.priceUsd = c;
    else if (header === "GT Price") idx.gtPrice = c;
    else if (header === "GT Currency") idx.gtCurrency = c;
    else if (FIXED_HEADERS.has(header)) {
      /* already handled */
    } else {
      const titleMatch = header.match(/^Title \((.+)\)$/);
      const descMatch = header.match(/^Description \((.+)\)$/);
      if (titleMatch) {
        const name = titleMatch[1].trim();
        const bcp47 = LOCALE_NAME_TO_BCP47[name];
        if (!bcp47) {
          idx.unknownLocales.add(name);
          continue;
        }
        const entry = idx.locales.get(bcp47) ?? {};
        entry.titleCol = c;
        idx.locales.set(bcp47, entry);
      } else if (descMatch) {
        const name = descMatch[1].trim();
        const bcp47 = LOCALE_NAME_TO_BCP47[name];
        if (!bcp47) {
          idx.unknownLocales.add(name);
          continue;
        }
        const entry = idx.locales.get(bcp47) ?? {};
        entry.descCol = c;
        idx.locales.set(bcp47, entry);
      }
      // Unrecognised non-locale columns are silently ignored.
    }
  }

  return idx;
}

function cellString(
  ws: XLSX.WorkSheet,
  r: number,
  c: number,
): string {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell) return "";
  if (cell.v === null || cell.v === undefined) return "";
  return String(cell.v).trim();
}

function cellDecimal(
  ws: XLSX.WorkSheet,
  r: number,
  c: number,
): string {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell) return "";
  if (cell.v === null || cell.v === undefined) return "";
  if (typeof cell.v === "number") {
    // Excel may store prices as JS numbers — preserve up to 6 decimal places.
    return Number.isInteger(cell.v) ? String(cell.v) : cell.v.toFixed(6).replace(/\.?0+$/, "");
  }
  return String(cell.v).trim();
}

/**
 * Parse the Manager's IAP template buffer into structured rows.
 *
 * The parser is tolerant:
 *   - Unrecognised locale columns surface as warnings, not errors.
 *   - Rows missing a SKU are skipped (template often has trailing blanks).
 *   - GT Price + GT Currency are paired; if only one is set, the override
 *     is dropped with a warning.
 *
 * Hard errors that block the entire file:
 *   - Workbook can't be opened.
 *   - Required Product ID column is missing.
 *   - Required Price (USD) column is missing.
 */
export function parseIapTemplate(buffer: ArrayBuffer | Buffer): ParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const rows: ParsedIapRow[] = [];

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch (err) {
    errors.push(
      `Failed to read workbook: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { rows, warnings, errors };
  }

  if (wb.SheetNames.length === 0) {
    errors.push("Workbook has no sheets.");
    return { rows, warnings, errors };
  }
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws["!ref"]) {
    errors.push(`Sheet "${sheetName}" is empty.`);
    return { rows, warnings, errors };
  }

  const range = XLSX.utils.decode_range(ws["!ref"]);
  const headerRow: string[] = [];
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    headerRow.push(cellString(ws, range.s.r, c));
  }

  const idx = indexColumns(headerRow);

  const skuCol = idx.sku;
  const priceCol = idx.priceUsd;
  if (skuCol === undefined) {
    errors.push('Required column "Product ID" not found in header row.');
    return { rows, warnings, errors };
  }
  if (priceCol === undefined) {
    errors.push('Required column "Price (USD)" not found in header row.');
    return { rows, warnings, errors };
  }

  if (idx.unknownLocales.size > 0) {
    warnings.push(
      `Ignoring ${idx.unknownLocales.size} unrecognised locale column(s): ${
        [...idx.unknownLocales].sort().join(", ")
      }. Add to LOCALE_NAME_TO_BCP47 if these should be imported.`,
    );
  }

  for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
    const sku = cellString(ws, r, skuCol);
    if (sku === "") continue;

    const basePriceDecimal = cellDecimal(ws, r, priceCol);
    if (basePriceDecimal === "") {
      warnings.push(`Row ${r + 1} (SKU "${sku}"): missing Price (USD); skipped.`);
      continue;
    }

    const regionOverrides: ParsedRegionOverride[] = [];
    if (idx.gtPrice !== undefined && idx.gtCurrency !== undefined) {
      const gtPriceDecimal = cellDecimal(ws, r, idx.gtPrice);
      const gtCurrency = cellString(ws, r, idx.gtCurrency).toUpperCase();
      const hasPrice = gtPriceDecimal !== "";
      const hasCurrency = gtCurrency !== "";
      if (hasPrice && hasCurrency) {
        const region = regionForCurrency(gtCurrency);
        if (region) {
          regionOverrides.push({
            region,
            currency: gtCurrency,
            priceDecimal: gtPriceDecimal,
          });
        } else {
          warnings.push(
            `Row ${r + 1} (SKU "${sku}"): GT Currency "${gtCurrency}" not in region map; override dropped.`,
          );
        }
      } else if (hasPrice !== hasCurrency) {
        warnings.push(
          `Row ${r + 1} (SKU "${sku}"): GT Price + GT Currency must be set together; override dropped.`,
        );
      }
    }

    const listings: ParsedListing[] = [];
    for (const [locale, cols] of idx.locales) {
      const title =
        cols.titleCol !== undefined ? cellString(ws, r, cols.titleCol) : "";
      const description =
        cols.descCol !== undefined ? cellString(ws, r, cols.descCol) : "";
      if (title === "" && description === "") continue;
      listings.push({ locale, title, description });
    }

    rows.push({
      rowNumber: r + 1,
      sku,
      baseCurrency: "USD",
      basePriceDecimal,
      regionOverrides,
      listings,
    });
  }

  if (rows.length === 0 && errors.length === 0) {
    warnings.push("No data rows found after the header.");
  }

  return { rows, warnings, errors };
}
