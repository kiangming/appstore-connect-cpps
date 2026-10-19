/**
 * Excel parser for the Manager-delivered IAP bulk-import template
 * (docs/google-iap-management/templates/template-item-iap-google.xlsx).
 *
 * Sheet selection: the data sheet is looked up BY NAME ("IAP Items",
 * GOOGLE_DATA_SHEET_NAME in template-spec.ts) with a first-sheet fallback
 * for legacy files (the v1 Manager artifact used "Sheet1"). The generated
 * "Download template" ships a Notes sheet alongside — ignored here.
 *
 * Template shape (data sheet):
 *   Col A:  Product ID (SKU)
 *   Col B:  Price (XXX)              — base price, decimal, in currency XXX
 *                                       (H4: the header MUST name the currency)
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

import {
  filePriceOf,
  fileRegionPriceOf,
  PLAY_BILLING_CURRENCIES,
  type FileCell,
} from "../orchestration/file-price";
import {
  GOOGLE_DATA_SHEET_NAME,
  GOOGLE_PRODUCT_ID_HEADER,
  GOOGLE_GT_PRICE_HEADER,
  GOOGLE_GT_CURRENCY_HEADER,
  LOCALE_NAME_TO_BCP47,
} from "./template-spec";
import { TEMPLATE_SAMPLE_PRODUCT_IDS, TEMPLATE_SAMPLE_ROWS_NOTE } from "@/lib/xlsx-template";

/** Sample Product IDs shipped in the generated template's data sheet.
 *  Rows keeping them are SKIPPED (explicit outcome, not an error) so an
 *  unedited template can never create junk IAPs on the live store —
 *  the IDs don't exist there, so nothing would 409. Shared const with
 *  the generator: the skip list cannot drift from the template. */
const SAMPLE_PRODUCT_ID_SET = new Set<string>(TEMPLATE_SAMPLE_PRODUCT_IDS);

/** Manager-display locale name → Google Play BCP-47 locale code.
 *  Moved to template-spec.ts (single source of truth shared with the
 *  "Download template" generator — this file statically imports xlsx,
 *  so the client wizard imports the spec module, not this one).
 *  Re-exported for back-compat. */
export { LOCALE_NAME_TO_BCP47 };

/** GT Currency → the ONE region a GT Price is meant for.
 *  ⚠ An entry is NOT trusted to be billable: every GT goes through
 *    fileRegionPriceOf, which checks the pair against the measured catalog
 *    (play-regions.snapshot.ts). CNY→CN (CN is not sold) and ARS→AR (Google
 *    bills AR in USD) are KEPT on purpose so such a GT refuses its row with
 *    Google's real billing, rather than being dropped and replaced by a
 *    converted price (H4.1). The parser test pins which entries match the
 *    catalog (23) and which are refused (exactly CNY, ARS). This table is the
 *    ONLY source — the old COMMON_REGIONS fallback is gone. */
const CURRENCY_TO_REGION_OVERRIDES: Record<string, string> = {
  // The Manager's template uses VND as the prototypical GT currency. A
  // row whose GT Currency is not in this map is REFUSED (H4.2) — before,
  // the override was dropped with a warning.
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
  return CURRENCY_TO_REGION_OVERRIDES[currency.trim().toUpperCase()] ?? null;
}

/** The GT table as pairs — for the catalog-consistency test. */
export function gtCurrencyRegionPairs(): ReadonlyArray<{ currency: string; region: string }> {
  return Object.entries(CURRENCY_TO_REGION_OVERRIDES).map(([currency, region]) => ({ currency, region }));
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
  // (Cycle 43's `priceHeaderSource` is gone — H4.3, Q9: since H4.1 the
  // currency always comes from the header, and the execute route refuses a
  // request built before that by its `pricing_rule`.)
}

/** A row the file states but the tool cannot honour exactly (H4.1). */
export interface RefusedFileRow {
  rowNumber: number;
  sku: string;
  reason: string;
}

export interface ParseResult {
  rows: ParsedIapRow[];
  warnings: string[];
  errors: string[];
  /** Rows of the file NOT imported, each with its reason: a price or GT
   *  that cannot be honoured exactly (H4.1), an empty price, or no Product
   *  ID on a row that has data (H4.3 — "no row disappears silently"). Also
   *  in `warnings`; the wizard shows them in the preview table and the
   *  Manager may push the rest after confirming. */
  refusedRows: RefusedFileRow[];
  /** Template example rows skipped by Product ID (TEMPLATE_SAMPLE_PRODUCT_IDS).
   *  Explicit outcome — not errors, not silently dropped. */
  skippedSampleRows: { rowNumber: number; sku: string }[];
  /** H4.4 — the price header exactly as the file wrote it (e.g. "Price (USD)"),
   *  when it resolved. Recorded in the import audit: the header was the one
   *  fact past audits could not recover. */
  priceHeader?: string;
}

/** Column headers we recognise as non-locale at the start of the sheet.
 *  Price headers are NOT listed: they go through `resolvePriceColumn`. */
const FIXED_HEADERS = new Set([
  GOOGLE_PRODUCT_ID_HEADER,
  GOOGLE_GT_PRICE_HEADER,
  GOOGLE_GT_CURRENCY_HEADER,
]);

/** The price column, or why the file cannot be priced from its header.
 *  H4.1 (Manager Q1, Q10 — 2026-10-17): exactly ONE price column, and its
 *  header names a currency Google Play bills in. */
export type PriceColumnResult =
  | { kind: "ok"; columnIndex: number; currencyCode: string; headerText: string }
  | {
      kind: "error";
      reason:
        | "none"
        | "multiple"
        | "no_currency"
        | "not_play_currency"
        | "unrecognised"
        | "gt_header_case"
        | "gt_column_missing";
      message: string;
    };

/** "Price (XXX)" — and the same with "Default "/"Base " in front, any case.
 *  Without "(XXX)" it is a price header WITHOUT a currency. */
const PRICE_HEADER = /^(?:(?:default|base)\s+)?price\s*(?:\(\s*([a-z]{3})\s*\))?$/i;
/** Any other header that mentions "price" looks like a price column too. */
const LOOKS_LIKE_PRICE = /\bprice\b/i;

export function resolvePriceColumn(
  headerRow: ReadonlyArray<string | number | undefined>,
): PriceColumnResult {
  const found: Array<{ columnIndex: number; header: string; currency: string | null }> = [];
  const unrecognised: string[] = [];
  const gtMiscased: Array<{ header: string; exact: string }> = [];
  for (let c = 0; c < headerRow.length; c += 1) {
    const raw = headerRow[c];
    if (raw === undefined || raw === null) continue;
    const header = String(raw).trim();
    if (FIXED_HEADERS.has(header)) continue; // "GT Price" is not a price column
    // The GT columns are matched EXACTLY; "gt price" / "Gt Currency" would
    // be ignored and the GT dropped for every row without a word (H4.2).
    const gtExact = [GOOGLE_GT_PRICE_HEADER, GOOGLE_GT_CURRENCY_HEADER].find(
      (h) => h.toLowerCase() === header.replace(/\s+/g, " ").toLowerCase(),
    );
    if (gtExact) {
      gtMiscased.push({ header, exact: gtExact });
      continue;
    }
    const m = header.match(PRICE_HEADER);
    if (m) {
      found.push({ columnIndex: c, header, currency: m[1] ? m[1].toUpperCase() : null });
    } else if (LOOKS_LIKE_PRICE.test(header)) {
      unrecognised.push(header);
    }
  }
  if (gtMiscased.length > 0) {
    return {
      kind: "error",
      reason: "gt_header_case",
      message: gtMiscased.map((g) => `Header "${g.header}": write it exactly "${g.exact}".`).join(" "),
    };
  }
  // H4.2 — the GT is read only when BOTH exact headers exist. One without
  // the other ("GT Curency", a missing column) would drop every GT price in
  // the file without a word, and those countries would get a converted
  // price the file did not state. Same rule as a half-filled GT cell pair.
  const headers = new Set(headerRow.map((h) => (h === undefined || h === null ? "" : String(h).trim())));
  const hasGtPrice = headers.has(GOOGLE_GT_PRICE_HEADER);
  const hasGtCurrency = headers.has(GOOGLE_GT_CURRENCY_HEADER);
  if (hasGtPrice !== hasGtCurrency) {
    const [present, missing] = hasGtPrice
      ? [GOOGLE_GT_PRICE_HEADER, GOOGLE_GT_CURRENCY_HEADER]
      : [GOOGLE_GT_CURRENCY_HEADER, GOOGLE_GT_PRICE_HEADER];
    return {
      kind: "error",
      reason: "gt_column_missing",
      message: `The file has a "${present}" column but no "${missing}" column — add "${missing}" (written exactly), or remove "${present}". A GT needs both.`,
    };
  }
  // H4.1 Q10 — no silent first-wins: a column that looks like a price but is
  // not read would leave the Manager believing it was.
  if (unrecognised.length > 0) {
    return {
      kind: "error",
      reason: "unrecognised",
      message: `${unrecognised.map((h) => `"${h}"`).join(", ")} looks like a price column but is not "Price (XXX)". Rename it to "Price (XXX)" with the currency of the prices, or remove it — prices are read from exactly one "Price (XXX)" column.`,
    };
  }
  if (found.length === 0) {
    return {
      kind: "error",
      reason: "none",
      message:
        'No price column found. Expected exactly one "Price (XXX)" column, where XXX is the currency of the prices (e.g. "Price (USD)", "Price (VND)").',
    };
  }
  if (found.length > 1) {
    return {
      kind: "error",
      reason: "multiple",
      message: `The file has ${found.length} price columns (${found
        .map((f) => `"${f.header}"`)
        .join(", ")}). Keep exactly one "Price (XXX)" column — prices are read from that column only.`,
    };
  }
  const [only] = found;
  // H4.1 Q1 — before, such a header silently took the app's currency.
  if (only.currency === null) {
    return {
      kind: "error",
      reason: "no_currency",
      message: `Header "${only.header}" does not say which currency the prices are in. Rename it to "Price (XXX)" with the currency of the prices, e.g. "Price (USD)". The app's currency is not used for prices in the file.`,
    };
  }
  if (!PLAY_BILLING_CURRENCIES.has(only.currency)) {
    return {
      kind: "error",
      reason: "not_play_currency",
      message: `Header "${only.header}": "${only.currency}" is not a currency Google Play bills in.`,
    };
  }
  return { kind: "ok", columnIndex: only.columnIndex, currencyCode: only.currency, headerText: only.header };
}

interface ColumnIndex {
  sku?: number;
  price: PriceColumnResult;
  gtPrice?: number;
  gtCurrency?: number;
  /** locale → [titleCol, descCol] */
  locales: Map<string, { titleCol?: number; descCol?: number }>;
  unknownLocales: Set<string>;
}

function indexColumns(headerRow: Array<string | number | undefined>): ColumnIndex {
  const idx: ColumnIndex = {
    // The price column goes through its resolver before the per-cell loop.
    price: resolvePriceColumn(headerRow),
    locales: new Map(),
    unknownLocales: new Set(),
  };

  for (let c = 0; c < headerRow.length; c += 1) {
    const raw = headerRow[c];
    if (raw === undefined || raw === null) continue;
    const header = String(raw).trim();
    if (header === "") continue;

    if (header === GOOGLE_PRODUCT_ID_HEADER) idx.sku = c;
    else if (header === GOOGLE_GT_PRICE_HEADER) idx.gtPrice = c;
    else if (header === GOOGLE_GT_CURRENCY_HEADER) idx.gtCurrency = c;
    else if (FIXED_HEADERS.has(header)) {
      /* already handled */
    } else if (idx.price.kind === "ok" && idx.price.columnIndex === c) {
      /* price column — handled by resolvePriceColumn above */
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

/** H4.3 — does a row with NO Product ID still state a product? Only the
 *  columns that describe one count: the price, the GT price, a title or a
 *  description. A formula whose result is empty / 0 / FALSE (a helper column
 *  dragged down past the data), a stray GT Currency filled down, an unknown
 *  column, and the generated template's own "delete the sample rows" note do
 *  not — those rows are not products the Manager wrote, and refusing them
 *  would bury the real refusals (and could refuse thousands of rows). */
function rowStatesAProduct(ws: XLSX.WorkSheet, r: number, cols: number[]): boolean {
  for (const c of cols) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
    if (!cell || cell.v === undefined || cell.v === null) continue;
    if (cell.f && (cell.v === 0 || cell.v === false || String(cell.v).trim() === "")) continue;
    const text = String(cell.v).trim();
    if (text !== "" && text !== TEMPLATE_SAMPLE_ROWS_NOTE.trim()) return true;
  }
  return false;
}

/** "number" for an Excel NUMBER cell, else "text" (filePriceOf needs it to
 *  tell a typed "26.000" from the number 26000). */
function cellKind(ws: XLSX.WorkSheet, r: number, c: number): FileCell {
  return ws[XLSX.utils.encode_cell({ r, c })]?.t === "n" ? "number" : "text";
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
    if (Number.isInteger(cell.v)) return String(cell.v);
    // Float noise from Excel arithmetic (25999.99999999996, 0.30000000000000004)
    // reads as its 6-decimal value. A REAL 7th+ decimal (4.9999999, 0.0000001)
    // is passed through unrounded, so the precision check refuses the row
    // instead of the tool importing a different price (H4.1).
    const rounded = cell.v.toFixed(6);
    if (Math.abs(Number(rounded) - cell.v) > 1e-9) return String(cell.v);
    return rounded.replace(/\.?0+$/, "");
  }
  return String(cell.v).trim();
}

/**
 * Parse the Manager's IAP template buffer into structured rows.
 *
 * The parser is tolerant:
 *   - Unrecognised locale columns surface as warnings, not errors.
 *   - H4.3: a row that states a product (price, GT price, title or
 *     description) but has no Product ID is a refused row with a reason;
 *     anything else without one (empty rows, helper formulas, the template's
 *     own note) is ignored. An empty price is a refused row too.
 *   - H4.1/H4.2: a row whose price or GT price cannot be honoured exactly
 *     is NOT imported (per-row warning + `refusedRows`): not a valid
 *     decimal, more decimals than its currency allows, 0, a "." / ","
 *     typed in a no-decimals currency, a GT in a pair Google does not bill,
 *     a GT Currency outside the GT table, or only one of GT Price / GT
 *     Currency filled. It is never sent with some other price instead
 *     (filePriceOf / fileRegionPriceOf).
 *
 * Hard errors that block the entire file:
 *   - Workbook can't be opened.
 *   - Required Product ID column is missing.
 *   - No price column, more than one, a header without its currency
 *     ("Price" / "Default Price" / "Base Price" — H4.1 Q1), or a currency
 *     Google Play does not bill in (Q10). See resolvePriceColumn.
 *
 * ⚠ No app currency: the file is the only price source (H4).
 */
export function parseIapTemplate(buffer: ArrayBuffer | Buffer): ParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const rows: ParsedIapRow[] = [];
  const skippedSampleRows: ParseResult["skippedSampleRows"] = [];
  const refusedRows: RefusedFileRow[] = [];

  let wb: XLSX.WorkBook;
  try {
    // H4.2 (a) — raw: a text-format upload (CSV, TSV, HTML) must stay TEXT.
    // Without it SheetJS guesses numbers: "26.000" under Price (VND) became
    // the NUMBER 26 and skipped the thousands-separator refusal (measured).
    // xlsx cells keep their stored type either way.
    wb = XLSX.read(buffer, { type: "buffer", raw: true });
  } catch (err) {
    errors.push(
      `Failed to read workbook: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { rows, warnings, errors, refusedRows, skippedSampleRows };
  }

  if (wb.SheetNames.length === 0) {
    errors.push("Workbook has no sheets.");
    return { rows, warnings, errors, refusedRows, skippedSampleRows };
  }
  // Sheet-selection hardening (design-bulk-import-template-download.md §C):
  // prefer the canonical data sheet BY NAME so a Notes/instructions sheet
  // can never shadow the data — sheet ORDER is not load-bearing (a user
  // reorder or an Excel re-save must not break the import). Files without
  // the named sheet (legacy Manager templates, plain Sheet1 workbooks)
  // fall back to the first sheet, preserving pre-hardening behavior.
  const usedSheetFallback = !wb.Sheets[GOOGLE_DATA_SHEET_NAME];
  const sheetName = usedSheetFallback
    ? wb.SheetNames[0]
    : GOOGLE_DATA_SHEET_NAME;
  const ws = wb.Sheets[sheetName];
  // When the sheet was found only via the first-sheet fallback and then
  // turns out unusable, the real problem is usually the SHEET (e.g. a
  // notes/instructions sheet sitting where the data was expected) — name
  // that instead of a misleading missing-column message.
  const sheetHint = usedSheetFallback
    ? ` Couldn't find the data sheet "${GOOGLE_DATA_SHEET_NAME}" — parsed the first sheet "${sheetName}" instead; if your workbook keeps the data in another sheet, rename that sheet to "${GOOGLE_DATA_SHEET_NAME}".`
    : "";
  if (!ws["!ref"]) {
    errors.push(`Sheet "${sheetName}" is empty.` + sheetHint);
    return { rows, warnings, errors, refusedRows, skippedSampleRows };
  }

  const range = XLSX.utils.decode_range(ws["!ref"]);
  const headerRow: string[] = [];
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    headerRow.push(cellString(ws, range.s.r, c));
  }

  const idx = indexColumns(headerRow);

  const skuCol = idx.sku;
  const priceResolution = idx.price;
  if (skuCol === undefined) {
    errors.push(
      'Required column "Product ID" not found in header row.' + sheetHint,
    );
    return { rows, warnings, errors, refusedRows, skippedSampleRows };
  }
  if (priceResolution.kind === "error") {
    // The wrong-sheet hint only explains a MISSING price column; a header
    // that exists but lacks its currency is not a sheet problem.
    errors.push(priceResolution.message + (priceResolution.reason === "none" ? sheetHint : ""));
    return { rows, warnings, errors, refusedRows, skippedSampleRows };
  }
  const priceCol = priceResolution.columnIndex;
  const resolvedCurrency = priceResolution.currencyCode;

  if (idx.unknownLocales.size > 0) {
    warnings.push(
      `Ignoring ${idx.unknownLocales.size} unrecognised locale column(s): ${
        [...idx.unknownLocales].sort().join(", ")
      }. Add to LOCALE_NAME_TO_BCP47 if these should be imported.`,
    );
  }

  const productCols = [
    priceCol,
    ...(idx.gtPrice !== undefined ? [idx.gtPrice] : []),
    ...[...idx.locales.values()].flatMap((l) => [l.titleCol, l.descCol]).filter((c): c is number => c !== undefined),
  ];
  const refuse = (rowNumber: number, sku: string, reason: string) => {
    warnings.push(`Row ${rowNumber} (SKU "${sku}"): ${reason} Row not imported.`);
    refusedRows.push({ rowNumber, sku, reason });
  };

  for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
    const sku = cellString(ws, r, skuCol);
    if (sku === "") {
      // H4.3 — a row that states a product but has no Product ID used to
      // vanish without a word. Anything else without an ID is not a row.
      if (rowStatesAProduct(ws, r, productCols)) refuse(r + 1, "", 'no "Product ID" — every row needs one.');
      continue;
    }

    // Template example rows: skip by Product ID (explicit outcome below).
    if (SAMPLE_PRODUCT_ID_SET.has(sku)) {
      skippedSampleRows.push({ rowNumber: r + 1, sku });
      continue;
    }

    const basePriceDecimal = cellDecimal(ws, r, priceCol);
    if (basePriceDecimal === "") {
      // H4.3 — a refused row like the others (table, confirmation, Done,
      // Hub count), no longer a warning-only skip.
      refuse(r + 1, sku, `"${priceResolution.headerText}" is empty — fill in the price.`);
      continue;
    }

    // H4.1 — the file's price (and GT price) must be honoured exactly, or the
    // row is not imported. Never substituted by a conversion or another
    // currency. Both are checked so one upload names every problem.
    const reasons: string[] = [];
    const filePrice = filePriceOf({
      currency: resolvedCurrency,
      priceDecimal: basePriceDecimal,
      cell: cellKind(ws, r, priceCol),
    });
    if (!filePrice.ok) {
      reasons.push(`"${priceResolution.headerText}" = "${basePriceDecimal}" — ${filePrice.reason}`);
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
          const gt = fileRegionPriceOf({
            region,
            currency: gtCurrency,
            priceDecimal: gtPriceDecimal,
            cell: cellKind(ws, r, idx.gtPrice),
          });
          if (gt.ok) {
            regionOverrides.push({
              region,
              currency: gtCurrency,
              priceDecimal: gtPriceDecimal,
            });
          } else {
            reasons.push(`GT Price "${gtPriceDecimal}" ${gtCurrency} — ${gt.reason}`);
          }
        } else {
          // H4.2 (Manager 2026-10-18): a GT the tool cannot place refuses
          // the row, like every other GT error — before, the GT was dropped
          // and that country got a converted price the file did not state.
          reasons.push(
            `GT Currency "${gtCurrency}" is not a currency the GT column supports (one region per currency: ${Object.keys(CURRENCY_TO_REGION_OVERRIDES).join(", ")}).`,
          );
        }
      } else if (hasPrice !== hasCurrency) {
        reasons.push(
          hasPrice
            ? `GT Price "${gtPriceDecimal}" has no GT Currency — fill both or neither.`
            : `GT Currency "${gtCurrency}" has no GT Price — fill both or neither.`,
        );
      }
    }

    if (reasons.length > 0) {
      refuse(r + 1, sku, reasons.join(" "));
      continue;
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
      // Hotfix 16: baseCurrency now follows the resolved price column
      // (was hardcoded "USD" pre-Hotfix-16). Downstream currency-
      // precision validation (Hotfix 5) and template lookup (Hotfix 15
      // + Hotfix 16 generalisation) both consume this field.
      baseCurrency: resolvedCurrency,
      basePriceDecimal,
      regionOverrides,
      listings,
    });
  }

  const notImported = refusedRows.length;
  if (skippedSampleRows.length > 0) {
    warnings.push(
      `${skippedSampleRows.length} example row(s) skipped (sample Product IDs from the template) — delete the sample rows or replace them with your data.`,
    );
  }
  if (rows.length === 0 && notImported > 0) {
    // Not "no data": there were rows, and none could be imported.
    warnings.push(`No row can be imported: ${notImported} row(s) were not imported — each is listed with its reason.`);
  } else if (rows.length === 0 && errors.length === 0 && skippedSampleRows.length === 0) {
    // Suppressed when sample rows were skipped — the skip message above
    // already explains why nothing is importable.
    warnings.push("No data rows found after the header.");
  }

  return { rows, warnings, errors, refusedRows, skippedSampleRows, priceHeader: priceResolution.headerText };
}
