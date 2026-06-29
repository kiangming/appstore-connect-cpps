/**
 * Row model for the unified per-country pricing table (edit + live-compare in
 * one surface). Pure + deterministic — no I/O — so the merge of the editable
 * "Price from tool" column with the read-only "Price live on Google" column is
 * computed and tested independently of the React component.
 *
 * REUSES comparePrices/microsEqual (price-comparison.ts) — no new comparison
 * engine. Status maps 1:1 to comparePrices, plus a presentation-only "auto-eq"
 * refinement for the benign live-only case where Google's live price equals
 * the base in the SAME currency (trivial auto-equalization, not a drift).
 *
 * Editing semantics (preserved bit-for-bit): the table edits the SAME
 * `regionOverrides` array IapForm already saves. Explicit-override rows carry
 * their array index (edit/remove via existing index handlers). Inherit/
 * live-only rows carry no index — editing them ADDS a regionOverride (promote
 * to explicit). A row with no explicit override is NOT in the save payload
 * (inherit), exactly as today.
 */
import {
  comparePrices,
  microsEqual,
  type RegionPrice,
  type PriceComparisonStatus,
} from "./price-comparison";
import { decimalToMicros } from "./google/price-conversion";
import type { RegionOverrideRow } from "./form-state";

function safeDecimalToMicros(dec: string, currency?: string): string | null {
  try {
    return decimalToMicros(dec, currency);
  } catch {
    return null;
  }
}

/** Reference to the editable tool-side override row backing this region. */
export interface UnifiedOverrideRef {
  /** Index into the regionOverrides array (for updateOverride/removeOverride). */
  index: number;
  currency: string;
  priceDecimal: string;
}

export type UnifiedStatus = PriceComparisonStatus | "auto-eq";

export interface UnifiedPricingRow {
  region_code: string;
  /** The explicit tool override backing this row, or null when the region
   *  inherits base / is live-only (editing promotes it to an override). */
  override: UnifiedOverrideRef | null;
  /** Read-only live Google value (never part of the save payload). */
  live: { currency: string; price_micros: string } | null;
  status: UnifiedStatus;
  /** True when the tool has an explicit, non-empty override for this region. */
  hasExplicitTool: boolean;
}

export interface UnifiedPricingArgs {
  regionOverrides: ReadonlyArray<RegionOverrideRow>;
  livePrices: ReadonlyArray<RegionPrice>;
  baseCurrency: string;
  basePriceDecimal: string;
}

export function buildUnifiedPricingRows(
  args: UnifiedPricingArgs,
): UnifiedPricingRow[] {
  const { regionOverrides, livePrices, baseCurrency, basePriceDecimal } = args;

  // region -> first override row index (the add-flow keeps regions unique).
  const indexByRegion = new Map<string, number>();
  regionOverrides.forEach((r, i) => {
    if (!indexByRegion.has(r.region)) indexByRegion.set(r.region, i);
  });

  // Tool prices for comparison = explicit (non-empty) overrides with valid
  // micros — the exact set buildIapSaveBody would write.
  const toolPrices: RegionPrice[] = [];
  for (const r of regionOverrides) {
    if (!r.priceDecimal.trim()) continue;
    const micros = safeDecimalToMicros(r.priceDecimal, r.currency);
    if (micros === null) continue;
    toolPrices.push({
      region_code: r.region,
      currency: r.currency.trim().toUpperCase(),
      price_micros: micros,
    });
  }

  // Reuse the shared BigInt-exact comparison (divergent-first sorted).
  const cmp = comparePrices(toolPrices, livePrices);

  const baseCur = baseCurrency.trim().toUpperCase();
  const baseMicros = basePriceDecimal.trim()
    ? safeDecimalToMicros(basePriceDecimal, baseCurrency)
    : null;

  const covered = new Set(cmp.map((c) => c.region_code));
  const rows: UnifiedPricingRow[] = cmp.map((c) => {
    const idx = indexByRegion.get(c.region_code);
    const ov = idx !== undefined ? regionOverrides[idx] : undefined;
    const hasExplicitTool = !!ov && ov.priceDecimal.trim().length > 0;

    let status: UnifiedStatus = c.status;
    // Presentation-only refinement (still microsEqual, no new engine): a
    // live-only row whose live price equals the base in the SAME currency is
    // the trivial auto-equalization — benign, not a drift to flag.
    if (
      c.status === "live-only" &&
      c.live &&
      baseMicros &&
      c.live.currency.trim().toUpperCase() === baseCur &&
      microsEqual(c.live.price_micros, baseMicros)
    ) {
      status = "auto-eq";
    }

    return {
      region_code: c.region_code,
      override:
        ov && idx !== undefined
          ? { index: idx, currency: ov.currency, priceDecimal: ov.priceDecimal }
          : null,
      live: c.live,
      status,
      hasExplicitTool,
    };
  });

  // Override rows that have an EMPTY priceDecimal and no live counterpart
  // aren't in `cmp` (excluded from toolPrices, absent from live). Surface them
  // so an added-but-unfilled region row stays visible/editable.
  for (const [region, idx] of indexByRegion) {
    if (covered.has(region)) continue;
    const ov = regionOverrides[idx];
    rows.push({
      region_code: region,
      override: { index: idx, currency: ov.currency, priceDecimal: ov.priceDecimal },
      live: null,
      status: "tool-only",
      hasExplicitTool: ov.priceDecimal.trim().length > 0,
    });
  }

  return rows;
}

export interface UnifiedPricingSummary {
  total: number;
  diverged: number; // diff + tool-only + live-only (NOT match/auto-eq)
}

export function summarizeUnifiedPricing(
  rows: ReadonlyArray<UnifiedPricingRow>,
): UnifiedPricingSummary {
  let diverged = 0;
  for (const r of rows) {
    if (r.status !== "match" && r.status !== "auto-eq") diverged += 1;
  }
  return { total: rows.length, diverged };
}

/**
 * Split rows into the always-visible set (divergent rows + every explicit
 * override) and the collapsible set (the auto-equalized / inheriting majority
 * that matches live). Collapsing is PRESENTATION ONLY — both sets reference
 * the same regionOverrides, so a collapsed territory is never dropped from the
 * save payload.
 */
export function partitionPricingRows(rows: ReadonlyArray<UnifiedPricingRow>): {
  visible: UnifiedPricingRow[];
  collapsed: UnifiedPricingRow[];
} {
  const visible: UnifiedPricingRow[] = [];
  const collapsed: UnifiedPricingRow[] = [];
  for (const r of rows) {
    const benign = r.status === "match" || r.status === "auto-eq";
    if (benign && !r.hasExplicitTool) {
      collapsed.push(r);
    } else {
      visible.push(r);
    }
  }
  return { visible, collapsed };
}
