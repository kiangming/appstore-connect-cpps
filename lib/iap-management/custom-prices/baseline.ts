/**
 * Per-territory Custom Prices — baseline table assembly. PURE.
 *
 * Design: docs/iap-management/design-apple-custom-territory-prices.md §B, §G5.
 * Client-importable (no DB, no Apple client) — the dialog renders straight from
 * this, and `structure.test.ts` keeps a server-only import out.
 *
 * ⚠ THE WHOLE POINT: assembling the ~175-row table requires ZERO price-point
 * requests (gate G3). Every column comes from data we already have:
 *
 *   template value      price_tier_template_entries (DB, current tier + source)
 *   existing manual     the G4 schedule read (Apple)
 *   custom value        iap_custom_prices (SC1 repository)
 *   auto                nothing — rendered as "— auto —", never a number
 *
 * Eager-fetching price points for all ~175 territories would be ~105,000
 * objects into the browser to render a table the Manager will edit ~5 rows of.
 * Points are fetched lazily, per territory, only when a picker opens.
 *
 * ⚠ AND WE DO NOT INVENT THE AUTO NUMBER. Apple equalises from the base price
 * and nothing in this repo reproduces that calculation. A plausible-looking
 * computed number would be worse than an honest dash: the Manager would treat
 * it as Apple's actual price. `provenance: "auto"` carries no value at all —
 * that is deliberate, not an omission (§G5 row 2).
 */
import type { CustomPriceEntry } from "./model";
import { normalizeTerritoryCode } from "./model";
import { matchesTerritoryQuery } from "../territory-query";

/**
 * Where a territory's CURRENT price comes from. Two of the four are weaker
 * claims than they look, and the labels say so (§G5):
 *
 *   "template"    — a CLAIM, not a guarantee. If the template's price has no
 *                   matching Apple price point the orchestrator drops it into
 *                   `missing_price_points` and the territory silently falls
 *                   back to auto (pricing-orchestration.ts:326-334). Rendered
 *                   as "template · unverified" until matched against Apple's
 *                   live list.
 *   "existing-manual" — what a PREVIOUS submit wrote. Apple does not record
 *                   whether it came from a template or a custom, AND it is
 *                   WIPED by the next submit (replace-all POST). This is the
 *                   single most important thing the dialog says, and the reason
 *                   J-6's import exists.
 *   "auto"        — Apple equalises it. Value unknown to this tool.
 *   "base"        — the base-territory row. Read-only in the dialog (§E).
 */
export type CustomPriceProvenance =
  | "base"
  | "template"
  | "existing-manual"
  | "auto";

export interface BaselineRow {
  territory_code: string;
  territory_name: string;
  /** null when no source told us the currency (an auto row in a territory the
   *  template doesn't cover). The column renders blank rather than guessing. */
  currency_code: string | null;
  provenance: CustomPriceProvenance;
  /** The current price, or null for `auto` / an unknown base. NEVER computed. */
  current_price: number | null;
  /** The Manager's override for this territory, if any. */
  custom_price: number | null;
  /** True for the base-territory row: read-only, edited via Price Tier (§E). */
  is_base: boolean;
  /** True when this row's stored custom is no longer offered by Apple. Only
   *  set once a picker has been opened for the territory (§I.3); unknown
   *  territories stay false rather than claiming a clean bill of health. */
  custom_unavailable: boolean;
}

export interface AssembleBaselineArgs {
  /** Apple's full territory list, alpha-3. */
  territories: ReadonlyArray<{ code: string; name: string; currency: string | null }>;
  /** The base territory ("USA" today). */
  baseTerritory: string;
  /** Base price for the base-territory row — the tier's USA/USD price. */
  basePrice?: number | null;
  /** Template entries for the CURRENT tier + pricing source. Empty under
   *  source APPLE, which has no template by definition. */
  templateEntries: ReadonlyArray<{
    territory_code: string;
    customer_price: number;
    currency_code: string;
  }>;
  /** Effective-now manual prices already on Apple. MUST already be filtered to
   *  startDate === null — use `effectiveNowManualPrices`. */
  existingManual: ReadonlyArray<{
    territory: string;
    customerPrice: number;
    currency: string | null;
  }>;
  /** The Manager's current custom set. */
  customPrices: ReadonlyArray<CustomPriceEntry>;
  /** Territories whose stored custom was checked against Apple's live list and
   *  found missing (§I.3). */
  unavailableCustomTerritories?: ReadonlyArray<string>;
}

/**
 * ⚠ Keep ONLY effective-now entries from a price-schedule read.
 *
 * `unpackPriceSchedule` returns future-dated entries too — that is what feeds
 * the view page's UpcomingChangesTable. Without this filter a scheduled change
 * renders as the CURRENT price, and J-6's "import as custom" would import
 * tomorrow's price as today's custom: a wrong price shipped to a live store,
 * from a read that looked correct.
 *
 * If Apple ever returns more than one effective-now entry for a territory the
 * first wins — Apple does not, this just makes the shape total.
 */
export function effectiveNowManualPrices<
  T extends { territory: string; startDate: string | null },
>(entries: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of entries) {
    if (e.startDate !== null) continue;
    const code = normalizeTerritoryCode(e.territory);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(e);
  }
  return out;
}

/**
 * Build one row per Apple territory.
 *
 * Provenance precedence for the CURRENT price — deliberately independent of
 * whether a custom exists, because the dialog has to show what the territory
 * gets TODAY next to what the Manager is changing it to:
 *
 *   base territory        → "base"
 *   on Apple right now    → "existing-manual"   (a real, observed value)
 *   in the active template → "template"          (a claim)
 *   otherwise             → "auto"               (no value)
 *
 * `existing-manual` outranks `template` because it is what Apple is actually
 * charging; the template is only what the next submit WOULD send.
 */
export function assembleBaselineRows(args: AssembleBaselineArgs): BaselineRow[] {
  const base = normalizeTerritoryCode(args.baseTerritory);

  const templateByTerritory = new Map(
    args.templateEntries.map((e) => [normalizeTerritoryCode(e.territory_code), e]),
  );
  const manualByTerritory = new Map(
    args.existingManual.map((e) => [normalizeTerritoryCode(e.territory), e]),
  );
  const customByTerritory = new Map(
    args.customPrices.map((e) => [normalizeTerritoryCode(e.territory_code), e]),
  );
  const unavailable = new Set(
    (args.unavailableCustomTerritories ?? []).map(normalizeTerritoryCode),
  );

  return args.territories.map((territory) => {
    const code = normalizeTerritoryCode(territory.code);
    const template = templateByTerritory.get(code);
    const manual = manualByTerritory.get(code);
    const custom = customByTerritory.get(code);
    const isBase = code === base;

    let provenance: CustomPriceProvenance;
    let currentPrice: number | null;
    if (isBase) {
      provenance = "base";
      currentPrice = args.basePrice ?? null;
    } else if (manual) {
      provenance = "existing-manual";
      currentPrice = manual.customerPrice;
    } else if (template) {
      provenance = "template";
      currentPrice = template.customer_price;
    } else {
      provenance = "auto";
      // Deliberately null. See the file header.
      currentPrice = null;
    }

    return {
      territory_code: code,
      territory_name: territory.name,
      currency_code:
        custom?.currency_code ??
        template?.currency_code ??
        manual?.currency ??
        territory.currency ??
        null,
      provenance,
      current_price: currentPrice,
      // The base row can never carry a custom: the write path has one base slot
      // and the template loop excludes the base territory (§E). Even if a stray
      // row existed, it is not surfaced as editable here.
      custom_price: isBase ? null : (custom?.customer_price ?? null),
      is_base: isBase,
      custom_unavailable: !isBase && custom !== undefined && unavailable.has(code),
    };
  });
}

/** Rows the Manager could import as customs — every effective-now manual price
 *  outside the base territory that does not already have one (J-6 bulk). */
export function importableManualRows(rows: ReadonlyArray<BaselineRow>): BaselineRow[] {
  return rows.filter(
    (r) => !r.is_base && r.provenance === "existing-manual" && r.custom_price === null,
  );
}

/**
 * Turn an `existing-manual` row into a custom entry (J-6).
 *
 * The imported value is Apple's CURRENT price verbatim — the point is that it
 * survives the next replace-all submit, so changing it here would defeat the
 * purpose. Returns null for a row with no usable value or currency, rather than
 * inventing either.
 */
export function manualRowToCustomEntry(row: BaselineRow): CustomPriceEntry | null {
  if (row.is_base) return null;
  if (row.provenance !== "existing-manual") return null;
  if (row.current_price === null || !row.currency_code) return null;
  return {
    territory_code: row.territory_code,
    customer_price: row.current_price,
    currency_code: row.currency_code,
  };
}

/**
 * Search across name, alpha-3 code and currency (the dialog's one input).
 *
 * A thin adapter over the shared predicate since SC4: the availability
 * territory picker needs the same match and sits adjacent to this dialog on
 * the Edit form, so the logic lives in `territory-query.ts` and this
 * function only maps `BaselineRow`'s field names onto it (P1 — one
 * predicate, not two that drift).
 */
export function matchesBaselineQuery(row: BaselineRow, query: string): boolean {
  return matchesTerritoryQuery(
    {
      name: row.territory_name,
      code: row.territory_code,
      currency: row.currency_code,
    },
    query,
  );
}

export interface BaselineCounts {
  total: number;
  customised: number;
  importable: number;
  unavailable: number;
}

export function baselineCounts(rows: ReadonlyArray<BaselineRow>): BaselineCounts {
  return {
    total: rows.length,
    customised: rows.filter((r) => r.custom_price !== null).length,
    importable: importableManualRows(rows).length,
    unavailable: rows.filter((r) => r.custom_unavailable).length,
  };
}

/**
 * Human label for a provenance, used by the row pill AND the picker's
 * placeholder ("— use template ₫24,000 —"), so the two can never disagree
 * about what a row falls back to.
 */
export function provenanceLabel(provenance: CustomPriceProvenance): string {
  switch (provenance) {
    case "base":
      return "base tier";
    case "template":
      // The qualifier is not decoration — see the type's doc comment.
      return "template · unverified";
    case "existing-manual":
      return "on Apple now";
    case "auto":
      return "Apple equalises";
  }
}

/**
 * The warning shown on every `existing-manual` row.
 *
 * Apple's price-schedule POST is replace-all, so a manual price that is not
 * re-sent reverts to auto. That has ALWAYS been true — this dialog is simply
 * the first surface that admits it. Showing the Manager their prices are about
 * to be destroyed without offering a remedy would be worse than staying quiet,
 * which is why J-6's import sits on the same row.
 */
export const EXISTING_MANUAL_WARNING =
  "Set on Apple now — will revert to auto on the next push unless you import it as a custom price.";

/** J-1: the reason the picker is unavailable, shown in place of the affordance
 *  rather than as a silent disabled control. */
export const NO_DONOR_REASON =
  "Custom prices need Apple's price list, which this tool reads through an IAP that already exists on Apple. This app has none yet — create this IAP first, then edit it to add custom prices.";

/** CP-3: customs override a base price, so there must be one. */
export const NO_TIER_REASON =
  "Pick a price tier first — custom prices override the base price, they don't replace it.";
