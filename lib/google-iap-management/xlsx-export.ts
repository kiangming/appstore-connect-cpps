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
 * ─── ⚠ WRITER IS `exceljs`, NOT `xlsx` — CHANGED 2026-09-01 (R5) ──────────
 *
 * The Manager asked for the three identity columns to stay put while scrolling
 * sideways. `xlsx@0.18.5` (SheetJS CE) **cannot write freeze panes at all**,
 * and that was measured on THIS path rather than read off a doc: four variants
 * (`!freeze` as a string, `!freeze` as an object, `!views`, and a do-nothing
 * control) all produced the identical bare `<sheetView workbookViewId="0"/>`
 * with no `<pane>` element anywhere in `xl/worksheets/sheet1.xml`.
 *
 * ⚠ UPGRADING IS NOT A ROUTE OUT. 0.18.5 is the last npm release of `xlsx`;
 * freeze panes and cell styling are paid (Pro) features. Nobody should
 * re-propose a version bump.
 *
 * ⚠ AND THE USUAL OBJECTION DOES NOT APPLY HERE. `exceljs` is a server-only
 * dependency (KB §4.17) and pulling it into a browser bundle is what that rule
 * exists to prevent — but this writer has ALWAYS run server-side: the route
 * calls it and returns bytes, the client only does `res.blob()`. Measured: the
 * export route contributes 0 B of client bundle, and the sibling surface that
 * already writes with exceljs through a server route
 * (`/settings/pricing-templates/default`) sits at 171 kB, not the 424 kB an
 * accidental client import once produced. So this swap costs 0 kB.
 *
 * ⚠ THE OUTPUT IS UNCHANGED EXCEPT FOR THE FREEZE. Every structural fact of
 * the old file — sheet name, every cell, all 10 merges, the two header rows —
 * is pinned against a golden dump captured from the SheetJS writer BEFORE this
 * change (`__fixtures__/export-golden.json`) and re-asserted after. That
 * fixture is the parity gate for this rewrite.
 *
 * ⚠ `xlsx` IS STILL THE READER. The upload parsers keep it; the Google module
 * now uses `xlsx` for reading only, pinned by a structural test.
 */
import ExcelJS from "exceljs";

import { microsToDecimal } from "./google/price-conversion";
import { getCurrencyDecimals } from "./google/currency-precision";
import type { ToolInAppProduct } from "./google/onetime-product-adapter";
import { regionNameFromCode } from "./region-name";

const SHEET_NAME = "IAP Export";
const FIXED_COLUMNS = ["Product ID", "Product Name", "Status"] as const;

/**
 * What a territory cell says when this item has no price there.
 *
 * ⚠ AN EM DASH, NOT A BLANK. Since X4 the ticked set IS the column set, so a
 * column can be entirely unpriced — and a column of blanks is
 * indistinguishable from a column the writer forgot to fill. `—` is
 * unmistakably a rendered answer.
 *
 * ⚠ ONE MARKER IS ENOUGH HERE, AND THAT IS A FACT ABOUT GOOGLE, NOT A
 * SIMPLIFICATION OF APPLE'S. Apple needs several (`—` for not-sold, plus a
 * failure sheet distinguishing PARTIAL / FAILED / APPLE_ERROR) because its
 * export reads each item separately and any one of those reads can fail, so a
 * missing cell is genuinely ambiguous: not sold, or not answered? Google's
 * export makes ONE list call. It returns every item with its complete regional
 * pricing, or it throws and the route returns an error with no file at all
 * (`export/route.ts` catch). There is no partial state to distinguish, so a
 * missing cell has exactly one meaning: **this item has no price in this
 * territory.** Adding Apple's second marker would invent a distinction the
 * data cannot make.
 */
const NO_PRICE = "\u2014";

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
 * export): when provided and non-empty, **THE SELECTION IS THE COLUMN SET** —
 * every ticked code gets a column, whether or not any exported item prices it.
 * Absent or empty still means "no filter": every priced territory, exactly the
 * pre-X4 unfiltered behaviour. Fixed columns and localization groups are
 * per-item/per-locale, not per-territory, and are never affected.
 *
 * ⚠ IT USED TO INTERSECT, AND THAT WAS A SILENT DROP
 * (`[GOOGLE-export-intersection-silent-drop]`). The old line was
 * `allTerritories.filter((t) => selection.has(t))`, so a country the operator
 * ticked that nobody priced **produced no column at all** — the question was
 * removed instead of answered, and nothing in the file said so. Apple had the
 * identical bug and fixed it in E2; the Google twin was never ported.
 *
 * ⚠ X4 MADE FIXING IT MANDATORY, NOT OPTIONAL. X4 widens the picker to
 * Google's real 173, which puts 15 markets in reach that were never tickable
 * before — precisely the ones most likely to have no price yet. Widening the
 * list while still intersecting would have made this defect FIRE MORE OFTEN,
 * so the two ship together or neither does.
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
  // ⚠ THE SELECTION IS THE COLUMN SET — union, not intersection. A ticked
  // country with no price anywhere still gets a column, and its cells carry
  // the explicit "no price" marker. See the header for why intersecting was
  // wrong and why X4 could not ship without this.
  const territories =
    selectedTerritories && selectedTerritories.length > 0
      ? [...new Set(selectedTerritories)].sort()
      : allTerritories;

  return {
    territories,
    localizationGroupCount,
    rows,
  };
}

/**
 * R3 — the territory column header: `Price in Vietnam (VN)`.
 *
 * ⚠ THE NAME COMES FROM `regionNameFromCode`, WHICH IS NOT REDEFINED HERE.
 * That resolver already owns alpha-2 → display name for this module
 * (`region-name.ts`: i18n-iso-countries plus 18 overrides matching the labels
 * Google Play Console actually renders) and four other surfaces already read
 * it — the Edit form's region picker, the unified pricing table, the
 * custom-prices dialog and the template matrix. A second copy of that rule
 * living in the export would drift from the screen at the first override
 * anyone adds, and the file would then disagree with the UI about what a
 * country is called.
 *
 * ⚠ AND IT IS NOT MODIFIED EITHER. `regionNameFromCode` returns the name
 * ALONE ("Vietnam"), by a Manager directive recorded in its own docblock
 * (region-name.ts:20-21 — "display the country name only … to match Google
 * Play Console pricing UI"). The parenthetical code is an EXPORT-FILE
 * concern: a spreadsheet is read away from the tool, where "Vietnam" alone
 * cannot be matched back to the `VN` key a re-import needs. So the
 * composition lives here, at the one place that builds the file, and the
 * shared resolver keeps doing exactly what four UI surfaces already expect.
 *
 * ⚠ WHEN THERE IS NO REAL NAME, THE PARENTHETICAL IS DROPPED — never
 * `Price in ZZ (ZZ)`. `regionNameFromCode` falls back to the code itself
 * (region-name.ts:67-68), so the naive template would print a code beside
 * itself: two tokens, neither of them a name, in a header whose whole job
 * is to name a market.
 *
 * ⚠ ONE COMPARISON IS ENOUGH HERE, AND THAT IS A FACT ABOUT GOOGLE, NOT A
 * SIMPLIFICATION OF APPLE'S. Apple's `columnHeaderLabel` must test the
 * fallback against TWO codes (`export-column-order.ts:88-90`) because its
 * column key is alpha-2 while its resolver speaks alpha-3, so Kosovo comes
 * back as `XKS` against a column keyed `XK` — two different strings, and the
 * naive check waves it through. Google has no such split: `regionCode` from
 * `convertRegionPrices` and the input to `regionNameFromCode` are the SAME
 * alpha-2 token, confirmed on production data by census Q2b (0 rows outside
 * `^[A-Z]{2}$` across 308,933 price rows). Equality with `code` is therefore
 * the whole of the fallback. ⚠ Do NOT import Apple's `toCatalogCode` /
 * `toAppleCode` to "be safe" — there is no conversion to make (KB §4.20),
 * and reaching for one would mean the source is wrong.
 */
export function territoryColumnHeader(code: string): string {
  const name = regionNameFromCode(code);
  return name === code ? `Price in ${code}` : `Price in ${name} (${code})`;
}

/** Rows of the header block — the fixed columns merge down across both. */
const HEADER_ROW_COUNT = 2;

/**
 * ⚠ FREEZE — the three identity columns and both header rows.
 *
 * `xSplit: 3` is `FIXED_COLUMNS.length`: Product ID · Product Name · Status
 * stay put while the operator scrolls across up to 173 country pairs.
 * `ySplit: 2` is `HEADER_ROW_COUNT` — BOTH header rows, because the country
 * name lives on row 1 and its Price/Currency sub-header on row 2. Freezing
 * only row 1 would leave a price column scrolled away from the word telling
 * you which of the pair it is.
 *
 * ⚠ NOT Apple's numbers. The Apple export freezes 4 columns (it has a Base
 * Country column this file does not). Copying 4 here would strand the first
 * country pair in the frozen region.
 */
const FREEZE = { cols: FIXED_COLUMNS.length, rows: HEADER_ROW_COUNT } as const;

/** Build the two-row merged-header workbook from a plan. */
export function buildExportWorkbook(plan: ExportPlan): ExcelJS.Workbook {
  const { territories, localizationGroupCount, rows } = plan;

  const headerRow1: Array<string | null> = [
    ...FIXED_COLUMNS.map((label) => label as string),
    ...territories.flatMap((t) => [territoryColumnHeader(t), null]),
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
      return cell ? [cell.price, cell.currency] : [NO_PRICE, NO_PRICE];
    }),
    ...Array.from({ length: localizationGroupCount }, (_, i) => {
      const loc = row.localizations[i];
      return loc ? [loc.locale, loc.description] : [null, null];
    }).flat(),
  ]);

  const aoa = [headerRow1, headerRow2, ...dataRows];

  // Vertical merges for the fixed columns (span both header rows), then a
  // horizontal 2-col merge for every territory + localization group header.
  // ⚠ 0-BASED HERE, 1-BASED AT `mergeCells` — the +1s below are that shift,
  // not an off-by-one. Kept in this shape so the rectangles read the same as
  // they did under SheetJS and the golden fixture can compare them directly.
  const merges = FIXED_COLUMNS.map((_, c) => ({
    s: { r: 0, c },
    e: { r: HEADER_ROW_COUNT - 1, c },
  }));
  const groupCount = territories.length + localizationGroupCount;
  for (let g = 0; g < groupCount; g += 1) {
    const startCol = FIXED_COLUMNS.length + g * 2;
    merges.push({ s: { r: 0, c: startCol }, e: { r: 0, c: startCol + 1 } });
  }

  const widths = [
    40, // Product ID
    28, // Product Name
    10, // Status
    ...territories.flatMap(() => [10, 10]),
    ...Array.from({ length: localizationGroupCount }, () => [12, 34]).flat(),
  ];

  const wb = new ExcelJS.Workbook();
  // ⚠ Deterministic stamps: without them every write embeds `new Date()` and
  // two exports of identical data differ byte-for-byte, which makes the
  // byte-level tests non-reproducible. Same reason the matrix writer does it.
  const EPOCH = new Date(0);
  wb.created = EPOCH;
  wb.modified = EPOCH;

  const ws = wb.addWorksheet(SHEET_NAME);
  for (const row of aoa) ws.addRow(row);
  for (const m of merges) {
    ws.mergeCells(m.s.r + 1, m.s.c + 1, m.e.r + 1, m.e.c + 1);
  }
  widths.forEach((w, i) => {
    // ⚠ Column widths are COUNTED PER COLUMN, never measured from the header
    // text. "Price in United States (US)" is nearly three times the width of
    // the old "Price in US"; a builder that sized from text would drift.
    ws.getColumn(i + 1).width = w;
  });
  ws.views = [{ state: "frozen", xSplit: FREEZE.cols, ySplit: FREEZE.rows }];

  return wb;
}

/** Write the workbook to bytes. Async because exceljs is. */
export async function writeExportBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** Manager filename convention: `IAP-export-<packageName>-<YYYYMMDD>.xlsx`. */
export function xlsxExportFilename(packageName: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const slug = packageName.replace(/[^a-z0-9._-]+/gi, "_");
  return `IAP-export-${slug}-${stamp}.xlsx`;
}
