/**
 * Live xlsx export — "Export list" button on the Apple IAP list page.
 *
 * Apple sibling to lib/google-iap-management/xlsx-export.ts. Builds the
 * approved layout (see
 * docs/iap-management/design/Apple-IAP-export-SAMPLE-layout.xlsx):
 * one row per IAP, a two-row merged header — fixed Product ID / SKU Name /
 * Status / Base Country columns, then a (Price, Currency) pair per
 * territory that has a price on ANY exported IAP, then a "Localization N"
 * group (Locale / Display Name / Description) sized to the IAP with the
 * most localizations.
 *
 * Unlike Google (whose list fetch returns complete pricing in one pass),
 * Apple has no per-territory price cache — every row here comes from a
 * live per-IAP fetch that reuses View Detail's price-schedule +
 * localization read as-is (see the export route). This module is pure:
 * no I/O, just plan/workbook construction from already-fetched data.
 *
 * Territory display codes are Apple's native alpha-3 (USA, VNM, …)
 * converted to alpha-2 (US, VN, …) via `i18n-iso-countries` to match the
 * approved sample's header format — the same package
 * components/iap-management/view-detail/territory-name.ts already
 * depends on, no new dependency.
 *
 * xlsx@0.18.5 (SheetJS Community Edition) writes merges + column widths
 * but not cell styling — plain/unstyled, same decision as the Google
 * export.
 */
import * as XLSX from "xlsx";
import countries from "i18n-iso-countries";

import type { PriceScheduleView } from "./queries/iap-detail";

const SHEET_NAME = "Apple IAP Export";
const FIXED_COLUMNS = ["Product ID", "SKU Name", "Status", "Base Country"] as const;
const LOCALIZATION_SUBHEADERS = ["Locale", "Display Name", "Description"] as const;

export interface ExportSourceLocalization {
  locale: string;
  displayName: string;
  description: string;
}

/** Already-fetched per-IAP data, composed by the export route from
 *  View Detail's own primitives (getInAppPurchase + splitIncluded,
 *  getPriceScheduleForIap + unpackPriceSchedule). */
export interface ExportSource {
  productId: string;
  skuName: string;
  /** Raw Apple `inAppPurchaseState` — no 2-state collapse. */
  status: string;
  /** Null when Apple has no price schedule yet for this IAP (e.g. a
   *  freshly-created MISSING_METADATA product). */
  priceSchedule: PriceScheduleView | null;
  localizations: ExportSourceLocalization[];
}

export interface ExportRowPrice {
  price: string;
  currency: string;
}

export interface ExportRow {
  productId: string;
  skuName: string;
  status: string;
  /** Alpha-2 display code, or null when there's no price schedule. */
  baseTerritory: string | null;
  /** Keyed by alpha-2 display code. Only territories with an
   *  effective-now price on this IAP are present. */
  prices: Record<string, ExportRowPrice>;
  localizations: ExportSourceLocalization[];
}

export interface ExportPlan {
  /** Sorted (alphabetical) union of territories-with-a-price across all rows. */
  territories: string[];
  /** Max localization count across all rows — number of "Localization N" groups. */
  localizationGroupCount: number;
  rows: ExportRow[];
}

/** Apple's native alpha-3 → alpha-2, falling back to the raw code for any
 *  territory the ISO table doesn't cover (defensive — mirrors
 *  territory-name.ts's raw-code fallback for the same reason). */
function toAlpha2(code: string): string {
  return countries.alpha3ToAlpha2(code) ?? code;
}

function toExportRow(source: ExportSource): ExportRow {
  const schedule = source.priceSchedule;
  const prices: ExportRow["prices"] = {};
  if (schedule) {
    for (const entry of schedule.entries) {
      // Effective-now price only (startDate === null) — a future-dated
      // entry is an upcoming change, not part of this point-in-time
      // snapshot. One entry per territory: first effective-now match wins
      // (Apple doesn't ship more than one, this just guards the type).
      if (entry.startDate !== null) continue;
      const code = toAlpha2(entry.territory);
      if (prices[code]) continue;
      prices[code] = { price: entry.customerPrice, currency: entry.currency ?? "" };
    }
  }

  return {
    productId: source.productId,
    skuName: source.skuName,
    status: source.status,
    baseTerritory: schedule ? toAlpha2(schedule.baseTerritory) : null,
    prices,
    localizations: source.localizations,
  };
}

/** Two-pass column determination + per-row extraction. Pure — no I/O. */
export function buildExportPlan(sources: ExportSource[]): ExportPlan {
  const rows = sources.map(toExportRow);

  const territorySet = new Set<string>();
  let localizationGroupCount = 0;
  for (const row of rows) {
    for (const code of Object.keys(row.prices)) territorySet.add(code);
    localizationGroupCount = Math.max(localizationGroupCount, row.localizations.length);
  }

  return {
    territories: [...territorySet].sort(),
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
      null,
    ]).flat(),
  ];

  const headerRow2: Array<string | null> = [
    ...FIXED_COLUMNS.map(() => null),
    ...territories.flatMap(() => ["Price", "Currency"]),
    ...Array.from({ length: localizationGroupCount }, () => [
      ...LOCALIZATION_SUBHEADERS,
    ]).flat(),
  ];

  const dataRows: Array<Array<string | null>> = rows.map((row) => [
    row.productId,
    row.skuName,
    row.status,
    row.baseTerritory,
    ...territories.flatMap((t) => {
      const cell = row.prices[t];
      return cell ? [cell.price, cell.currency] : [null, null];
    }),
    ...Array.from({ length: localizationGroupCount }, (_, i) => {
      const loc = row.localizations[i];
      return loc ? [loc.locale, loc.displayName, loc.description] : [null, null, null];
    }).flat(),
  ]);

  const aoa = [headerRow1, headerRow2, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Vertical merges for the fixed columns (span both header rows).
  const merges: XLSX.Range[] = FIXED_COLUMNS.map((_, c) => ({
    s: { r: 0, c },
    e: { r: 1, c },
  }));
  // Horizontal 2-col merges for every territory group header.
  for (let g = 0; g < territories.length; g += 1) {
    const startCol = FIXED_COLUMNS.length + g * 2;
    merges.push({ s: { r: 0, c: startCol }, e: { r: 0, c: startCol + 1 } });
  }
  // Horizontal 3-col merges for every localization group header.
  const locStart = FIXED_COLUMNS.length + territories.length * 2;
  for (let g = 0; g < localizationGroupCount; g += 1) {
    const startCol = locStart + g * 3;
    merges.push({ s: { r: 0, c: startCol }, e: { r: 0, c: startCol + 2 } });
  }
  ws["!merges"] = merges;

  ws["!cols"] = [
    { wch: 40 }, // Product ID
    { wch: 28 }, // SKU Name
    { wch: 20 }, // Status
    { wch: 12 }, // Base Country
    ...territories.flatMap(() => [{ wch: 10 }, { wch: 10 }]),
    ...Array.from({ length: localizationGroupCount }, () => [
      { wch: 10 },
      { wch: 22 },
      { wch: 34 },
    ]).flat(),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  return wb;
}

/** Manager filename convention: `Apple-IAP-export-<appRef>-<YYYYMMDD>.xlsx`. */
export function xlsxExportFilename(appRef: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const slug = appRef.replace(/[^a-z0-9._-]+/gi, "_");
  return `Apple-IAP-export-${slug}-${stamp}.xlsx`;
}
