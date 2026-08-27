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
 * converted to alpha-2 (US, VN, …) via `apple/territory-code-map` to match the
 * approved sample's header format — the same package
 * components/iap-management/view-detail/territory-name.ts already
 * depends on, no new dependency.
 *
 * xlsx@0.18.5 (SheetJS Community Edition) writes merges + column widths
 * but not cell styling — plain/unstyled, same decision as the Google
 * export.
 */
import ExcelJS from "exceljs";
import { toCatalogCode } from "./apple/territory-code-map";
import {
  columnHeaderLabel,
  orderTerritoryColumns,
} from "./export-column-order";

import type { PriceScheduleView } from "./queries/iap-detail";

const SHEET_NAME = "Apple IAP Export";
/** ⚠ Appended only when there is something to report. A clean export stays a
 *  ONE-SHEET workbook, byte-shape identical to before this feature. */
const FAILURE_SHEET_NAME = "Export Failures";
const FAILURE_COLUMNS = [
  "Product ID",
  "Apple IAP ID",
  "Status",
  "Reason",
  "Detail",
] as const;
const FIXED_COLUMNS = ["Product ID", "SKU Name", "Status", "Base Country"] as const;
const LOCALIZATION_SUBHEADERS = ["Locale", "Display Name", "Description"] as const;

/**
 * Why an Apple read did not produce data. ⚠ The kinds are kept APART on
 * purpose and are never merged into one "failed" bucket: they lead a Manager
 * to three different actions.
 *
 *   RATE_LIMITED  — a 429 that survived `withRetry`'s full backoff. Wait and
 *                   re-export; the data is fine, the budget was not.
 *   APPLE_ERROR   — Apple was asked and refused for a reason of its own
 *                   (404 gone, 403, 409). Carries the status; retrying the
 *                   same request changes nothing.
 *   UNKNOWN       — transport/parse. Neither of the above may be claimed.
 *   NOT_ATTEMPTED — nothing was sent, because the run had already stopped.
 *                   The ONLY kind that is safe to re-export blindly.
 */
export type ExportFailureKind =
  | "RATE_LIMITED"
  | "APPLE_ERROR"
  | "UNKNOWN"
  | "INCOMPLETE_PRICES"
  | "UNKNOWN_BASE_TERRITORY"
  | "NOT_ATTEMPTED";

/**
 * ⚠ UNKNOWN_BASE_TERRITORY IS ITS OWN KIND TOO, for the same reason
 * INCOMPLETE_PRICES is. The read SUCCEEDED and the prices are COMPLETE —
 * only the schedule's base-territory pointer was unreadable. It is not
 * APPLE_ERROR (nothing was refused), not RATE_LIMITED (nothing was
 * throttled), not UNKNOWN (we can explain it precisely), and not
 * INCOMPLETE_PRICES (no price is missing).
 *
 * Before this kind existed the condition had no way to be reported at all:
 * `unpackPriceSchedule` substituted `"USA"` and the row exported looking
 * correct. The Manager action is also distinct from all four — the prices in
 * this row are trustworthy, so re-reading buys nothing; what needs checking
 * is which territory Apple considers the base.
 */

/**
 * ⚠ INCOMPLETE_PRICES IS ITS OWN KIND, not a flavour of the others. The read
 * SUCCEEDED — Apple did not refuse, nothing was rate-limited, nothing threw.
 * Stage 2 simply came back short and said so. Filing it under APPLE_ERROR
 * would claim a refusal that never happened; under UNKNOWN would claim we
 * cannot explain it, when we can, exactly. And the Manager action differs
 * from all three: the prices in this row are a subset, so re-read the
 * schedule rather than waiting for a budget or giving up on the item.
 */

/**
 * A price-schedule read that failed for a reason that is NOT "Apple has no
 * schedule". ⚠ THIS TYPE EXISTS BECAUSE `priceSchedule: null` USED TO MEAN
 * TWO THINGS. A throttled read and a genuinely price-less IAP both collapsed
 * to `null`, so a rate-limited row exported with blank price cells that were
 * indistinguishable from a correct blank. `priceSchedule: null` now carries
 * exactly one meaning again — Apple has no schedule — and every other cause
 * lands here instead.
 */
export interface PriceReadFailure {
  kind: Exclude<ExportFailureKind, "NOT_ATTEMPTED">;
  /** Apple's HTTP status when there was one. */
  status?: number;
  /** Only for INCOMPLETE_PRICES — which of the two truncation paths fired.
   *  Structured rather than baked into `message` so the sheet renders it from
   *  data instead of re-reading it out of prose. */
  incompleteReason?: "PAGE_CAP" | "COUNT_MISMATCH";
  /** Human-readable, for the Detail column. Never parsed for `kind`. */
  message: string;
}

/** One row of the "Export Failures" sheet. */
export interface ExportFailureRow {
  productId: string;
  appleIapId: string;
  /**
   * PARTIAL      — the row IS in the main sheet, but its prices are missing.
   * FAILED       — the row is not in the main sheet at all.
   * NOT_ATTEMPTED— nothing was sent for it.
   */
  status: "PARTIAL" | "FAILED" | "NOT_ATTEMPTED";
  kind: ExportFailureKind;
  detail: string;
}

export interface ExportSourceLocalization {
  locale: string;
  displayName: string;
  description: string;
}

/** Already-fetched per-IAP data, composed by the export route from
 *  View Detail's own primitives (getInAppPurchase + splitIncluded,
 *  getPriceScheduleForIap + unpackPriceSchedule). */
export interface ExportSource {
  /** Apple's opaque IAP id — carried so the failure sheet can name the row
   *  by the same identifier the rest of the module uses. */
  appleIapId: string;
  productId: string;
  skuName: string;
  /** Raw Apple `inAppPurchaseState` — no 2-state collapse. */
  status: string;
  /**
   * ⚠ EXACTLY ONE MEANING: Apple has no price schedule for this IAP (a
   * freshly-created MISSING_METADATA product, or a 404 on the schedule
   * sub-resource, which is Apple's way of saying the same thing).
   *
   * It does NOT mean "we could not read the prices" — that is
   * `priceReadFailure`. Before those were split, a rate-limited read wrote
   * `null` here and the workbook rendered blank price cells with nothing to
   * distinguish them from a correct blank.
   */
  priceSchedule: PriceScheduleView | null;
  /** Non-null ⇒ the prices in this row are MISSING, not absent. The row still
   *  exports (its product id, name, status and localizations are real) and is
   *  additionally listed in the failure sheet as PARTIAL. */
  priceReadFailure: PriceReadFailure | null;
  localizations: ExportSourceLocalization[];
}

export interface ExportRowPrice {
  price: string;
  currency: string;
  /**
   * E3 — who set this price: `true` a human, `false` Apple's
   * auto-equalization, `null` Apple did not say.
   *
   * ⚠ Carried per CELL, not per column, because a territory can be manual on
   * one item and automatic on another in the same file. That is the whole
   * reason the marking is a fill and not a header suffix.
   */
  manual: boolean | null;
}

export interface ExportRow {
  appleIapId: string;
  /** Carried through so the workbook builder can mark PARTIAL rows without
   *  re-deriving the cause from blank cells (which is what it could not do). */
  priceReadFailure: PriceReadFailure | null;
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

/**
 * Apple's native alpha-3 → the code the picker and columns use.
 *
 * ⚠ E2b — delegates to `territory-code-map`, which handles the one territory
 * the ISO tables cannot: Kosovo is `XKS` to Apple and `XK` to the catalog, so
 * the bare library call left its price keyed under a code the selection could
 * never match. Still falls back to the raw code for anything unknown — an
 * unnameable market is still a market with a price.
 */
function toAlpha2(code: string): string {
  return toCatalogCode(code);
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
      prices[code] = {
        price: entry.customerPrice,
        currency: entry.currency ?? "",
        // ⚠ Straight from the entry, which took it from Apple's `manual`
        // attribute (E1/F1) — never re-derived here.
        manual: entry.manual,
      };
    }
  }

  return {
    appleIapId: source.appleIapId,
    productId: source.productId,
    skuName: source.skuName,
    status: source.status,
    // ⚠ TWO different nulls collapse into this one cell, and that is fine
    // *because the failure sheet separates them*: no schedule at all vs. a
    // schedule whose base was unreadable. The cell is blank either way — a
    // blank is honest — but only one of the two gets an
    // UNKNOWN_BASE_TERRITORY row naming it. Before F2 the second case wrote
    // a confident `US` here instead.
    baseTerritory: schedule?.baseTerritory
      ? toAlpha2(schedule.baseTerritory)
      : null,
    prices,
    localizations: source.localizations,
    priceReadFailure: source.priceReadFailure,
  };
}

/**
 * Two-pass column determination + per-row extraction. Pure — no I/O.
 *
 * `selectedTerritories` (Export options dialog, shared with the Google
 * export): when provided and non-empty, the territory PRICE columns are
 * narrowed to (union of territories-with-a-price) ∩ (selected codes) —
 * codes are alpha-2 display codes, matching `ExportRow.prices`' keys
 * (already converted from Apple's native alpha-3 by `toExportRow`).
 * Absent or empty means "no filter" — every priced territory, i.e.
 * today's unfiltered behavior. Fixed columns and localization groups are
 * per-item/per-locale, not per-territory, and are never affected by this
 * parameter. The selection does NOT change the fetch — every IAP's full
 * price schedule is still fetched regardless; this only decides which
 * columns the workbook renders.
 *
 * ─── E2 — THE SELECTION IS THE COLUMN SET, NOT A FILTER OVER IT ────────────
 *
 * This used to read
 *
 *     territories = allTerritories.filter((t) => selection.has(t))
 *
 * i.e. the INTERSECTION of (territories some row has a price for) and
 * (territories the Manager picked). A country the Manager selected that no
 * item had a price for did not come out blank — **it produced no column at
 * all**, and the file said nothing about having dropped it.
 *
 * That is the silent-drop class, and it hid the real bug for a while: the
 * export also never read Apple's `automaticPrices` (E1), so "has a price"
 * meant "has a MANUAL price". The Manager picked ten countries, got ten
 * columns, and had no way to see that the other selected markets had been
 * removed from the question rather than answered.
 *
 * ⚠ NOW: when a selection is given, THE SELECTION IS THE COLUMNS. Every
 * country asked about gets a column, and what goes in the cell answers it —
 * a price, or `—` for "Apple does not sell here". A question asked must be
 * answered visibly, including when the answer is "nothing".
 *
 * ⚠ The no-selection path is UNCHANGED: the union of priced territories.
 * There is no question to answer there, so there is nothing to leave blank —
 * and widening it to all ~175 would silently make every unfiltered export
 * enormous.
 */
export function buildExportPlan(
  sources: ExportSource[],
  selectedTerritories?: readonly string[] | null,
): ExportPlan {
  const rows = sources.map(toExportRow);

  const territorySet = new Set<string>();
  let localizationGroupCount = 0;
  for (const row of rows) {
    for (const code of Object.keys(row.prices)) territorySet.add(code);
    localizationGroupCount = Math.max(localizationGroupCount, row.localizations.length);
  }

  const allTerritories = [...territorySet].sort();
  // ⚠ `[...new Set(...)]` — the request body is client-supplied and a
  // duplicated code would otherwise render the same country twice.
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

/** A per-item outcome the fetch could not turn into a row at all. Mirrors
 *  `ExportFetchFailure` structurally; declared here so the workbook module
 *  does not import from the fetch module (which imports from this one). */
export interface ExportFetchFailureLike {
  productId: string;
  appleIapId: string;
  kind: ExportFailureKind;
  error: string;
}

const KIND_LABEL: Record<ExportFailureKind, string> = {
  RATE_LIMITED: "Rate limited",
  APPLE_ERROR: "Apple refused",
  UNKNOWN: "Unknown error",
  INCOMPLETE_PRICES: "Incomplete prices",
  UNKNOWN_BASE_TERRITORY: "Base territory unreadable",
  NOT_ATTEMPTED: "Not attempted",
};

/**
 * Every item that is not fully in the main sheet, as failure-sheet rows.
 *
 * ⚠ PARTIAL rows come from `plan.rows`, not from `failures` — they DID
 * export, they are in the main sheet, and they are listed here as well
 * because their price cells are blank for a reason a reader cannot see.
 *
 * ⚠ The three kinds are never collapsed. "Rate limited" tells a Manager to
 * wait and re-export; "Apple refused" tells them retrying changes nothing;
 * "Not attempted" tells them it is safe to re-export blindly. One merged
 * "failed" column would destroy all three messages at once.
 */
export function buildFailureRows(
  rows: readonly ExportRow[],
  failures: readonly ExportFetchFailureLike[],
): ExportFailureRow[] {
  const out: ExportFailureRow[] = [];

  for (const row of rows) {
    const f = row.priceReadFailure;
    if (!f) continue;
    out.push({
      productId: row.productId,
      appleIapId: row.appleIapId,
      status: "PARTIAL",
      kind: f.kind,
      detail:
        f.kind === "INCOMPLETE_PRICES"
          ? `${f.incompleteReason ?? "UNKNOWN_REASON"} — ${f.message}`
          : detailFor(f.kind, f.status, f.message),
    });
  }

  for (const f of failures) {
    out.push({
      productId: f.productId,
      appleIapId: f.appleIapId,
      status: f.kind === "NOT_ATTEMPTED" ? "NOT_ATTEMPTED" : "FAILED",
      kind: f.kind,
      detail: detailFor(f.kind, undefined, f.error),
    });
  }

  return out;
}

function detailFor(
  kind: ExportFailureKind,
  status: number | undefined,
  message: string,
): string {
  if (kind === "NOT_ATTEMPTED") {
    // ⚠ The one bucket that is safe to re-export blindly — nothing was sent
    // for it, so the sentence says so plainly rather than leaving a Manager
    // to infer it from the word "not attempted".
    return "Export stopped before this item — rate limit reached. Safe to re-export.";
  }
  if (kind === "RATE_LIMITED") {
    return `Apple rate-limited the read after retries were exhausted. ${message}`.trim();
  }
  if (kind === "UNKNOWN_BASE_TERRITORY") {
    // ⚠ Says what IS trustworthy as well as what is not. A reader who only
    // sees "unreadable" re-runs the export; the prices did not need it.
    return (
      "Apple returned the price schedule without a readable base territory. " +
      "Prices in this row are complete; only the Base Territory cell is blank. " +
      message
    ).trim();
  }
  if (kind === "APPLE_ERROR") {
    return status !== undefined
      ? `Apple returned ${status}. ${message}`.trim()
      : message;
  }
  return message;
}

/** The failure sheet as data. Rendered by `addSheet` like the main one, so
 *  both sheets go through one place that knows how exceljs is driven. */
function buildFailureSheet(failureRows: readonly ExportFailureRow[]): SheetSpec {
  const aoa: Array<Array<string | null>> = [
    [...FAILURE_COLUMNS],
    ...failureRows.map((r) => [
      r.productId,
      r.appleIapId,
      r.status,
      KIND_LABEL[r.kind],
      r.detail,
    ]),
  ];
  return { aoa, widths: [40, 16, 15, 16, 72] };
}

/**
 * Build the two-row merged-header workbook from a plan.
 *
 * ⚠ A CLEAN EXPORT IS UNCHANGED. With no failures and no partial rows this
 * returns exactly the single-sheet workbook it always did — same sheet name,
 * same header rows, same merges, no note row. The failure sheet and the note
 * row appear ONLY when there is something real to report, because a
 * permanently-present empty sheet trains people to stop looking at it.
 */
export function buildExportWorkbook(
  plan: ExportPlan,
  failures: readonly ExportFetchFailureLike[] = [],
): ExcelJS.Workbook {
  const { territories, localizationGroupCount, rows } = plan;
  const failureRows = buildFailureRows(rows, failures);
  const partialCount = failureRows.filter((r) => r.status === "PARTIAL").length;

  // ⚠ The note goes in the main sheet because that is the sheet someone
  // reads first, and a blank price cell there is exactly what it warns
  // about. It is ONE prepended row, present only when a partial row exists,
  // so every header/merge coordinate below is offset by `noteOffset` rather
  // than hard-coded to 0 — and on a clean export the offset is 0 and the
  // arithmetic collapses to what it was.
  const noteRow: Array<Array<string | null>> =
    partialCount > 0
      ? [
          [
            `⚠ ${partialCount} row${partialCount === 1 ? "" : "s"} incomplete — price columns are blank because the read failed, not because there is no price. See the "${FAILURE_SHEET_NAME}" sheet.`,
          ],
        ]
      : [];
  const noteOffset = noteRow.length;

  // E3.1 — manual columns first, then auto; base territory heads the manual
  // group; alphabetical by DISPLAY NAME inside each group. Pure, and tested
  // on its own so the ordering rule is not buried in the rendering.
  const columns = orderTerritoryColumns(rows, territories);
  const orderedCodes = columns.map((c) => c.code);

  const headerRow1: Array<string | null> = [
    ...FIXED_COLUMNS.map((label) => label as string),
    // E4 — full market name + code, e.g. "Price in Thailand (TH)". The
    // parenthetical is dropped when there is no real name to pair it with.
    ...columns.flatMap((c) => [columnHeaderLabel(c.code), null]),
    ...Array.from({ length: localizationGroupCount }, (_, i) => [
      `Localization ${i + 1}`,
      null,
      null,
    ]).flat(),
  ];

  const headerRow2: Array<string | null> = [
    ...FIXED_COLUMNS.map(() => null),
    ...orderedCodes.flatMap(() => ["Price", "Currency"]),
    ...Array.from({ length: localizationGroupCount }, () => [
      ...LOCALIZATION_SUBHEADERS,
    ]).flat(),
  ];

  const dataRows: Array<Array<string | null>> = rows.map((row) => [
    row.productId,
    row.skuName,
    row.status,
    row.baseTerritory,
    ...orderedCodes.flatMap((t) => {
      const cell = row.prices[t];
      return cell ? [cell.price, cell.currency] : [null, null];
    }),
    ...Array.from({ length: localizationGroupCount }, (_, i) => {
      const loc = row.localizations[i];
      return loc ? [loc.locale, loc.displayName, loc.description] : [null, null, null];
    }).flat(),
  ]);

  const aoa = [...noteRow, headerRow1, headerRow2, ...dataRows];

  // Vertical merges for the fixed columns (span both header rows).
  // ⚠ Coordinates stay 0-INDEXED here, exactly as they were, and `addSheet`
  // converts to exceljs's 1-indexed API in one place. Rewriting every
  // `noteOffset` arithmetic to 1-indexed would have been the easiest way to
  // introduce an off-by-one into merge geometry that no assertion covers
  // cell-by-cell.
  const merges: MergeRange[] = FIXED_COLUMNS.map((_, c) => ({
    s: { r: noteOffset, c },
    e: { r: noteOffset + 1, c },
  }));
  // Horizontal 2-col merges for every territory group header.
  for (let g = 0; g < orderedCodes.length; g += 1) {
    const startCol = FIXED_COLUMNS.length + g * 2;
    merges.push({
      s: { r: noteOffset, c: startCol },
      e: { r: noteOffset, c: startCol + 1 },
    });
  }
  // Horizontal 3-col merges for every localization group header.
  const locStart = FIXED_COLUMNS.length + orderedCodes.length * 2;
  for (let g = 0; g < localizationGroupCount; g += 1) {
    const startCol = locStart + g * 3;
    merges.push({
      s: { r: noteOffset, c: startCol },
      e: { r: noteOffset, c: startCol + 2 },
    });
  }
  const widths = [
    40, // Product ID
    28, // SKU Name
    20, // Status
    12, // Base Country
    ...orderedCodes.flatMap(() => [10, 10]),
    ...Array.from({ length: localizationGroupCount }, () => [10, 22, 34]).flat(),
  ];

  // ── E3.2 — the AUTO fills. ────────────────────────────────────────────────
  //
  // ⚠ SOURCE OF TRUTH IS `cell.manual`, the attribute Apple put on the price
  // row (E1/F1). Not the column's group, not the endpoint it arrived on, not
  // its position. The column group is a navigation aid computed from the same
  // attribute; shading from the group instead would repaint every cell in a
  // mixed column with the majority's answer, which is the precise lie the fill
  // was chosen to avoid.
  //
  // ⚠ ONLY `manual === false` IS SHADED. `null` — Apple said nothing — stays
  // white, because a yellow cell asserts "Apple derived this" and we would be
  // asserting it without evidence. White under-claims; yellow over-claims.
  const fills: CellFill[] = [];
  const firstDataRow = noteOffset + 2; // note? + header1 + header2
  rows.forEach((row, r) => {
    orderedCodes.forEach((code, g) => {
      if (row.prices[code]?.manual !== false) return;
      const priceCol = FIXED_COLUMNS.length + g * 2;
      // Both halves of the pair — a shaded price beside an unshaded currency
      // reads as a rendering fault, not as a statement.
      fills.push({ r: firstDataRow + r, c: priceCol });
      fills.push({ r: firstDataRow + r, c: priceCol + 1 });
    });
  });

  const wb = new ExcelJS.Workbook();
  addSheet(wb, SHEET_NAME, {
    aoa,
    widths,
    merges,
    fills,
    // ⚠ FREEZE 4, NOT 5. The fixed block is exactly the 4 FIXED_COLUMNS; a
    // 5-column freeze would cut the first territory in half, pinning its
    // Price while its Currency scrolls away. Derived from the structure so it
    // stays right if a fixed column is ever added.
    freeze: { cols: FIXED_COLUMNS.length, rows: noteOffset + 2 },
  });
  if (failureRows.length > 0) {
    addSheet(wb, FAILURE_SHEET_NAME, buildFailureSheet(failureRows));
  }
  return wb;
}

/** 0-indexed merge rectangle, in the same coordinates the builder computes. */
interface MergeRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

/** 0-indexed cell to shade. */
interface CellFill {
  r: number;
  c: number;
}

interface SheetSpec {
  aoa: Array<Array<string | null>>;
  widths: number[];
  merges?: MergeRange[];
  fills?: CellFill[];
  freeze?: { cols: number; rows: number };
}

/**
 * ⚠ THE ONLY PLACE THAT DRIVES exceljs. Everything above builds plain data in
 * 0-indexed coordinates — the same shapes the xlsx version built — and this
 * converts once. Two benefits worth the indirection: the 0→1 index shift
 * happens in one spot instead of at every call site, and the failure sheet
 * cannot drift away from the main sheet's rendering rules.
 */
function addSheet(wb: ExcelJS.Workbook, name: string, spec: SheetSpec): void {
  const ws = wb.addWorksheet(name);
  for (const row of spec.aoa) {
    // `?? null` keeps blank cells blank rather than writing "undefined".
    ws.addRow(row.map((v) => v ?? null));
  }
  spec.widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
  for (const m of spec.merges ?? []) {
    ws.mergeCells(m.s.r + 1, m.s.c + 1, m.e.r + 1, m.e.c + 1);
  }
  for (const f of spec.fills ?? []) {
    ws.getCell(f.r + 1, f.c + 1).fill = AUTO_PRICE_FILL;
  }
  if (spec.freeze) {
    ws.views = [
      { state: "frozen", xSplit: spec.freeze.cols, ySplit: spec.freeze.rows },
    ];
  }
}

/**
 * The yellow the Manager chose for auto-equalized prices.
 *
 * A pale amber rather than a saturated yellow: it has to stay legible behind
 * black text in both Excel and Google Sheets, and roughly 165 of ~175 columns
 * can carry it on a typical row — a strong yellow at that density stops being
 * a highlight and becomes the page.
 */
const AUTO_PRICE_FILL: ExcelJS.FillPattern = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFF2CC" },
};

/** Manager filename convention: `Apple-IAP-export-<appRef>-<YYYYMMDD>.xlsx`. */
export function xlsxExportFilename(appRef: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const slug = appRef.replace(/[^a-z0-9._-]+/gi, "_");
  return `Apple-IAP-export-${slug}-${stamp}.xlsx`;
}
