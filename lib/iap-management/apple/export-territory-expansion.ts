/**
 * F-B — what "all countries" means in the Apple export.
 *
 * `[Q-EXPORT.union-columns]` (Manager, 2026-08-27): when the operator ticks
 * every box, the file gets a column for **every territory either side knows
 * about** — the union of the shared picker catalog and Apple's own list.
 *
 * ─── THE THREE CANDIDATE SOURCES, AND WHY THE UNION WON ────────────────────
 *
 *   catalog only     183 columns. Matches the dialog exactly — but the 11
 *                    markets Apple sells to and the catalog lacks, RUSSIA
 *                    among them, get no column. Ticking "all" silently omits
 *                    a market with real revenue in it.
 *   Apple only       175 columns. Every market Apple sells to — but the 19
 *                    catalog entries Apple does NOT sell to vanish, and those
 *                    are tickable in the dialog. Silent drop, other direction.
 *   union            194 columns. Nothing either side knows is dropped.
 *
 * ⚠ THE UNION IS THE ONLY OPTION THAT DROPS NOTHING, and "drops nothing" is
 * the property this whole arc has been buying back. E2 removed a silent drop
 * from the intersection; picking either single source here would put one
 * straight back, just on a different set of countries.
 *
 * ⚠ IT ALSO REACHES RUSSIA WITHOUT TOUCHING `TERRITORY_CATALOG`. The catalog
 * is shared with the Google IAP module (P8) and widening it would add 11 rows
 * to Google's picker for markets nobody has checked Play sells in. Unioning
 * HERE, at the Apple export's own edge, gets the prices out with zero Google
 * blast radius — the same move `territory-code-map` made for Kosovo.
 *
 * ⚠ THE ASYMMETRY IS KNOWN AND TEMPORARY. Ticking "all" now produces a Russia
 * column; ticking Russia individually is still impossible, because the dialog
 * builds its list from the catalog. That is `[EXPORT-catalog-missing-11]`, it
 * is gated on a Google check (P8), and it is the thing that removes this
 * asymmetry. Recorded so nobody reads the inconsistency as a bug in here.
 *
 * ─── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 *
 * ⚠ NOT a filter, and not a cap. A territory Apple prices that appears in
 * NEITHER list still gets a column: `buildExportPlan` is handed this
 * expansion, and the codes actually observed are unioned on top of it
 * downstream. A market Apple added after the snapshot was taken therefore
 * still exports — it just also trips the runtime drift warning.
 */
import {
  APPLE_TERRITORIES_ALPHA3,
  unknownAppleTerritories,
} from "./apple-territories.snapshot";
import { toCatalogCode } from "./territory-code-map";
import { ALL_TERRITORY_CODES } from "@/lib/iap-management/territory-catalog";

/**
 * Every territory an "all countries" export gets a column for, as alpha-2
 * catalog codes.
 *
 * ⚠ Apple's side goes through `toCatalogCode` FIRST. Both halves must speak
 * the same alphabet before they meet, or Kosovo enters twice — `XK` from the
 * catalog and `XKS` from Apple — and the file grows a duplicate column for
 * one country. Sorted so the column order is deterministic across runs.
 */
export function allExportTerritories(): string[] {
  const codes = new Set<string>(ALL_TERRITORY_CODES);
  for (const alpha3 of APPLE_TERRITORIES_ALPHA3) {
    codes.add(toCatalogCode(alpha3));
  }
  return [...codes].sort();
}

export { unknownAppleTerritories };
