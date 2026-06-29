/**
 * Live-vs-stored per-territory price comparison (Google IAP detail view).
 *
 * The item detail page shows two columns: "Price from tool" (the stored
 * iap_prices snapshot) and "Price live on Google" (a display-only single-item
 * fetch). Operators edit prices directly in Play Console for small changes,
 * so the snapshot routinely diverges — this module computes the per-region
 * delta so divergence is obvious.
 *
 * EQUALITY RULE (verification #2): compare in identical units — currency
 * (case-insensitive) + price_micros as integers (BigInt). Both sides store
 * raw micros strings, so equality is exact with NO epsilon and NO decimal
 * formatting — display rounding can never produce a false "diff".
 *
 * Pure + deterministic — no I/O — so the divergence logic is unit-tested and
 * shared by the server route and the client component unchanged.
 */

export interface RegionPrice {
  region_code: string;
  currency: string;
  price_micros: string;
}

export type PriceComparisonStatus =
  | "match" // present both sides, same currency + micros
  | "diff" // present both sides, currency or micros differ
  | "tool-only" // in the tool's DB, not on Google
  | "live-only"; // on Google, not in the tool's DB

export interface PriceComparisonRow {
  region_code: string;
  tool: { currency: string; price_micros: string } | null;
  live: { currency: string; price_micros: string } | null;
  status: PriceComparisonStatus;
}

export interface PriceComparisonSummary {
  total: number;
  match: number;
  diff: number;
  toolOnly: number;
  liveOnly: number;
  /** Any non-match row — the count surfaced as the "N divergent" badge. */
  diverged: number;
}

/** Integer-micros equality (BigInt). Falls back to trimmed string compare if
 *  either value isn't a clean integer string (defensive — never throws). */
export function microsEqual(a: string, b: string): boolean {
  try {
    return BigInt(a.trim()) === BigInt(b.trim());
  } catch {
    return a.trim() === b.trim();
  }
}

function currencyEqual(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * Compare the tool's stored prices against Google's live prices, keyed by
 * region. Returns one row per region present on EITHER side (handles
 * territory-set mismatches in both directions). Divergent rows sort first so
 * mismatches are obvious at a glance; ties broken alphabetically by region.
 */
export function comparePrices(
  tool: ReadonlyArray<RegionPrice>,
  live: ReadonlyArray<RegionPrice>,
): PriceComparisonRow[] {
  const toolByRegion = new Map(tool.map((r) => [r.region_code, r]));
  const liveByRegion = new Map(live.map((r) => [r.region_code, r]));
  const regions = new Set<string>([
    ...toolByRegion.keys(),
    ...liveByRegion.keys(),
  ]);

  const rows: PriceComparisonRow[] = [];
  for (const region of regions) {
    const t = toolByRegion.get(region) ?? null;
    const l = liveByRegion.get(region) ?? null;
    let status: PriceComparisonStatus;
    if (t && l) {
      status =
        currencyEqual(t.currency, l.currency) &&
        microsEqual(t.price_micros, l.price_micros)
          ? "match"
          : "diff";
    } else if (t) {
      status = "tool-only";
    } else {
      status = "live-only";
    }
    rows.push({
      region_code: region,
      tool: t ? { currency: t.currency, price_micros: t.price_micros } : null,
      live: l ? { currency: l.currency, price_micros: l.price_micros } : null,
      status,
    });
  }

  // Divergent rows first (match last), then alphabetical by region.
  const matchRank = (s: PriceComparisonStatus) => (s === "match" ? 1 : 0);
  rows.sort(
    (a, b) =>
      matchRank(a.status) - matchRank(b.status) ||
      a.region_code.localeCompare(b.region_code),
  );
  return rows;
}

export function summarizeComparison(
  rows: ReadonlyArray<PriceComparisonRow>,
): PriceComparisonSummary {
  const summary: PriceComparisonSummary = {
    total: rows.length,
    match: 0,
    diff: 0,
    toolOnly: 0,
    liveOnly: 0,
    diverged: 0,
  };
  for (const r of rows) {
    if (r.status === "match") summary.match += 1;
    else if (r.status === "diff") summary.diff += 1;
    else if (r.status === "tool-only") summary.toolOnly += 1;
    else summary.liveOnly += 1;
  }
  summary.diverged = summary.diff + summary.toolOnly + summary.liveOnly;
  return summary;
}
