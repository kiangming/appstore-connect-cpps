/**
 * E3.1 — the order of the territory columns. PURE.
 *
 * `[Q-EXPORT.manual-first]`: the countries someone priced BY HAND come first,
 * then the ones Apple auto-equalized. With the fill carrying the per-cell
 * truth (`[Q-EXPORT.source-marking]`), this order is NAVIGATION — it puts the
 * columns a Manager reasons about at the left edge — and no longer a claim
 * about any individual cell.
 *
 * ─── RULE α, AND WHY NOT "THE FIRST ITEM" ──────────────────────────────────
 *
 * A column is one thing; manual-vs-auto is a per-ITEM fact. Item A can price
 * Thailand by hand while item B lets Apple derive it, in the same file. So a
 * rule is needed for which group the TH column belongs to.
 *
 *   α (this)     a column is MANUAL if AT LEAST ONE item priced it by hand.
 *   first-item   take the first row's classification.
 *   majority     whichever most items say.
 *
 * α wins on stability. `first-item` is a sample of one and depends on row
 * order, so re-exporting the same app with the items sorted differently could
 * move a column between groups — two files of the same data that cannot be
 * compared. `majority` is worse: it moves when the SELECTION changes, so
 * adding one item can reshuffle columns that have nothing to do with it.
 *
 * ⚠ On real data the three often agree. Measured on app 6738648909
 * (2026-08-27): all 25 items carry the same 10 manual territories, so α and
 * first-item produce an identical column order there. The difference only
 * shows on mixed apps — and it is exactly there that a rule which moves under
 * you is worst.
 *
 * ─── WITHIN A GROUP ────────────────────────────────────────────────────────
 *
 *   1. Base territories first (manual group only). The base is the price
 *      every other territory is equalized FROM, so it is the number a Manager
 *      checks first. Plural because rows can disagree about theirs.
 *   2. Then alphabetical BY FULL NAME, not by code — the header reads
 *      "Price in Thailand (TH)", and sorting "Thailand" under T while
 *      displaying it next to "Taiwan" is the kind of order that looks broken.
 */
import { territoryName } from "@/components/iap-management/view-detail/territory-name";
import { toAppleCode } from "@/lib/iap-management/apple/territory-code-map";

/** The minimum this needs from a row — kept structural so the export's own
 *  row type can satisfy it without this module importing it. */
export interface ColumnOrderRow {
  baseTerritory: string | null;
  prices: Record<string, { manual: boolean | null }>;
}

export type TerritoryGroup = "manual" | "auto";

export interface OrderedTerritoryColumn {
  /** Alpha-2 (or Apple's raw code when unmappable) — the key into `prices`. */
  code: string;
  group: TerritoryGroup;
  /** True when this column is some row's base territory. */
  isBase: boolean;
  /** Resolved display name, or the code when there is no name for it. */
  name: string;
}

/**
 * Display name for a column code.
 *
 * ⚠ Goes back through `toAppleCode` because `territoryName` speaks Apple's
 * alpha-3. Kosovo is the case that needs it: the column is `XK`, Apple calls
 * it `XKS`, and only one of those two can be looked up.
 */
export function columnDisplayName(code: string): string {
  return territoryName(toAppleCode(code));
}

/**
 * Order the territory columns: manual group first, auto second.
 *
 * ⚠ A column with NO price on any row — the Manager selected a country Apple
 * does not sell in — has nobody claiming it is manual, so rule α places it in
 * the AUTO group. That is the least-wrong home: the manual group means
 * "someone set these by hand", and nobody set this one. Its cells will read
 * `—` (E5), which is what actually answers the question.
 *
 * ⚠ `null` (Apple did not say) does NOT make a column manual. Only an explicit
 * `manual === true` does. An unknown must not promote a column into the group
 * that means "a human chose this".
 */
export function orderTerritoryColumns(
  rows: readonly ColumnOrderRow[],
  territories: readonly string[],
): OrderedTerritoryColumn[] {
  const baseCodes = new Set<string>();
  for (const row of rows) {
    if (row.baseTerritory) baseCodes.add(row.baseTerritory);
  }

  const columns: OrderedTerritoryColumn[] = territories.map((code) => {
    const anyManual = rows.some((r) => r.prices[code]?.manual === true);
    return {
      code,
      group: anyManual ? "manual" : "auto",
      isBase: baseCodes.has(code),
      name: columnDisplayName(code),
    };
  });

  const rank = (c: OrderedTerritoryColumn): number => {
    if (c.group === "manual") return c.isBase ? 0 : 1;
    return 2;
  };

  return columns.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    // Alphabetical by the name actually rendered in the header.
    const byName = a.name.localeCompare(b.name);
    // ⚠ Code as the tiebreak so the order is TOTAL. Two territories can share
    // a display name when neither resolves and both fall back to a code, and
    // a comparator returning 0 leaves the order to the engine's sort
    // stability — i.e. to row order, which is the instability α exists to
    // avoid.
    return byName !== 0 ? byName : a.code.localeCompare(b.code);
  });
}
