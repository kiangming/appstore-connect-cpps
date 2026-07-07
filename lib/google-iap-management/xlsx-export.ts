/**
 * Live xlsx export — "Export list" button on an app's IAP list page.
 *
 * Builds the approved v2 layout (see
 * docs/google-iap-management/design/IAP-export-SAMPLE-layout-v2.xlsx):
 * one row per SKU, a two-row merged header — fixed Product ID / Product
 * Name / Status columns, then a (Price, Currency) pair per territory that
 * has a price on ANY exported item, then a (Locale Code, Description) pair
 * per "Localization N" slot, sized to the SKU with the most described
 * locales.
 *
 * Data source is always the live `listInAppProducts` result (read-only,
 * no DB write) — see the export route. This module is pure: no I/O.
 *
 * xlsx@0.18.5 (SheetJS Community Edition) writes merges + column widths
 * but not cell styling (fills/fonts) — the approved sample's navy header
 * is not reproduced here pending a dependency decision (Part 1 finding).
 */
import * as XLSX from "xlsx";

import { microsToDecimal } from "./google/price-conversion";
import { getCurrencyDecimals } from "./google/currency-precision";
import type { ToolInAppProduct } from "./google/onetime-product-adapter";

const SHEET_NAME = "IAP Export";
const FIXED_COLUMNS = ["Product ID", "Product Name", "Status"] as const;

export interface ExportRowPrice {
  price: string;
  currency: string;
}

export interface ExportRowLocalization {
  locale: string;
  description: string;
}

export interface ExportRow {
  sku: string;
  productName: string | null;
  status: "active" | "inactive";
  /** Keyed by territory (region) code. Only territories with a price on
   *  this SKU are present — absent keys render as a blank cell pair. */
  prices: Record<string, ExportRowPrice>;
  /** Locales with a non-empty description, in Google's listings order.
   *  Positional — index 0 fills "Localization 1", etc. */
  localizations: ExportRowLocalization[];
}

export interface ExportPlan {
  /** Sorted (alphabetical) union of territories-with-a-price across all rows. */
  territories: string[];
  /** Max described-locale count across all rows — number of "Localization N" groups. */
  localizationGroupCount: number;
  rows: ExportRow[];
}

/** Same resolution order as `listIapsWithDefaultLocale` in
 *  repository/iaps.ts: prefer en-US, else the first listing encountered
 *  (Google's listings[] array order, preserved by the adapter's map). */
function resolveDefaultTitle(
  listings: ToolInAppProduct["listings"],
): string | null {
  const entries = Object.entries(listings ?? {});
  const enUs = entries.find(([locale]) => locale === "en-US");
  const fallback = entries[0];
  return enUs?.[1]?.title ?? fallback?.[1]?.title ?? null;
}

function toExportRow(product: ToolInAppProduct): ExportRow {
  const prices: ExportRow["prices"] = {};
  for (const [region, p] of Object.entries(product.prices ?? {})) {
    const decimals = getCurrencyDecimals(p.currency);
    prices[region] = {
      price: microsToDecimal(p.priceMicros, decimals),
      currency: p.currency,
    };
  }

  const localizations: ExportRowLocalization[] = Object.entries(
    product.listings ?? {},
  )
    .filter(([, l]) => (l.description ?? "").trim() !== "")
    .map(([locale, l]) => ({ locale, description: l.description ?? "" }));

  return {
    sku: product.sku ?? "",
    productName: resolveDefaultTitle(product.listings),
    status: product.status === "active" ? "active" : "inactive",
    prices,
    localizations,
  };
}

/**
 * Two-pass column determination + per-row extraction. Pure — no I/O.
 *
 * `selectedTerritories` (Export options dialog, shared with the Apple
 * export): when provided and non-empty, the territory PRICE columns are
 * narrowed to (union of territories-with-a-price) ∩ (selected codes).
 * Absent or empty means "no filter" — every priced territory, i.e.
 * today's unfiltered behavior. Fixed columns and localization groups are
 * per-item/per-locale, not per-territory, and are never affected by this
 * parameter.
 */
export function buildExportPlan(
  products: ToolInAppProduct[],
  selectedTerritories?: readonly string[] | null,
): ExportPlan {
  const rows = products.map(toExportRow);

  const territorySet = new Set<string>();
  let localizationGroupCount = 0;
  for (const row of rows) {
    for (const region of Object.keys(row.prices)) territorySet.add(region);
    localizationGroupCount = Math.max(
      localizationGroupCount,
      row.localizations.length,
    );
  }

  const allTerritories = [...territorySet].sort();
  const selection =
    selectedTerritories && selectedTerritories.length > 0
      ? new Set(selectedTerritories)
      : null;
  const territories = selection
    ? allTerritories.filter((t) => selection.has(t))
    : allTerritories;

  return {
    territories,
    localizationGroupCount,
    rows,
  };
}

/** Build the two-row merged-header workbook from a plan. */
export function buildExportWorkbook(plan: ExportPlan): XLSX.WorkBook {
  const { territories, localizationGroupCount, rows } = plan;

  const headerRow1: Array<string | null> = [
    ...FIXED_COLUMNS.map((label) => label as string),
    ...territories.flatMap((t) => [`Price in ${t}`, null]),
    ...Array.from({ length: localizationGroupCount }, (_, i) => [
      `Localization ${i + 1}`,
      null,
    ]).flat(),
  ];

  const headerRow2: Array<string | null> = [
    ...FIXED_COLUMNS.map(() => null),
    ...territories.flatMap(() => ["Price", "Currency"]),
    ...Array.from({ length: localizationGroupCount }, () => [
      "Locale Code",
      "Description",
    ]).flat(),
  ];

  const dataRows: Array<Array<string | null>> = rows.map((row) => [
    row.sku,
    row.productName,
    row.status,
    ...territories.flatMap((t) => {
      const cell = row.prices[t];
      return cell ? [cell.price, cell.currency] : [null, null];
    }),
    ...Array.from({ length: localizationGroupCount }, (_, i) => {
      const loc = row.localizations[i];
      return loc ? [loc.locale, loc.description] : [null, null];
    }).flat(),
  ]);

  const aoa = [headerRow1, headerRow2, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Vertical merges for the fixed columns (span both header rows).
  const merges: XLSX.Range[] = FIXED_COLUMNS.map((_, c) => ({
    s: { r: 0, c },
    e: { r: 1, c },
  }));
  // Horizontal 2-col merges for every territory + localization group header.
  const groupCount = territories.length + localizationGroupCount;
  for (let g = 0; g < groupCount; g += 1) {
    const startCol = FIXED_COLUMNS.length + g * 2;
    merges.push({ s: { r: 0, c: startCol }, e: { r: 0, c: startCol + 1 } });
  }
  ws["!merges"] = merges;

  ws["!cols"] = [
    { wch: 40 }, // Product ID
    { wch: 28 }, // Product Name
    { wch: 10 }, // Status
    ...territories.flatMap(() => [{ wch: 10 }, { wch: 10 }]),
    ...Array.from({ length: localizationGroupCount }, () => [
      { wch: 12 },
      { wch: 34 },
    ]).flat(),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  return wb;
}

/** Manager filename convention: `IAP-export-<packageName>-<YYYYMMDD>.xlsx`. */
export function xlsxExportFilename(packageName: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const slug = packageName.replace(/[^a-z0-9._-]+/gi, "_");
  return `IAP-export-${slug}-${stamp}.xlsx`;
}
