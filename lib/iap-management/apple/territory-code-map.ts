/**
 * E2b — Apple's territory codes ↔ the codes the export dialog speaks.
 *
 * Apple returns ISO 3166-1 **alpha-3** (`USA`, `VNM`, `THA`). The territory
 * picker — `TERRITORY_CATALOG`, shared with the Google IAP module — speaks
 * **alpha-2** (`US`, `VN`, `TH`). Every price key and every column code in the
 * Apple export crosses that boundary, and this module is the crossing.
 *
 * ─── WHY A MODULE FOR WHAT LOOKS LIKE ONE LIBRARY CALL ─────────────────────
 *
 * `i18n-iso-countries` handles 174 of Apple's 175 territories. It cannot
 * handle **Kosovo**, because Kosovo has no ISO 3166-1 assignment at all:
 *
 *     Apple                       →  XKS
 *     Google Play / the catalog   →  XK
 *     ISO 3166-1                  →  (nothing)
 *
 * `alpha3ToAlpha2("XKS")` returns undefined. The shipped code fell back to the
 * raw string, so the Kosovo price arrived keyed `"XKS"` while the Manager's
 * selection said `"XK"` — the two never met. Kosovo was tickable in the
 * dialog and could never produce a column, whatever Apple charged there. Same
 * silent-drop family as the intersection bug in E2, through a different door.
 *
 * ─── WHY THE CATALOG IS NOT SIMPLY CHANGED TO XKS ──────────────────────────
 *
 * ⚠ VERIFIED BEFORE TOUCHING ANYTHING: `TERRITORY_CATALOG` is shared with the
 * Google module (P8), and Google needs `XK` — `region-continent.ts:37` lists
 * `"XK"` among its European region codes, because that is Play Console's
 * code for Kosovo. Editing the catalog to suit Apple would break Google's
 * region bucketing for the same country.
 *
 * So the two codes both stay correct, and the translation happens HERE, at
 * Apple's edge, where the mismatch actually is. Nothing outside the Apple
 * export path imports this file — a structural test enforces that.
 *
 * ⚠ BOTH DIRECTIONS EXIST ON PURPOSE. `toCatalogCode` keys prices and matches
 * the selection; `toAppleCode` goes back the other way so the header can ask
 * `territoryName()` — which speaks Apple's alpha-3 — for a display name.
 * A one-way map would have forced the header to special-case Kosovo again,
 * somewhere else.
 */
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";

countries.registerLocale(enLocale);

/**
 * Codes ISO does not carry, so the library cannot convert them.
 *
 * ⚠ KEEP THIS TINY. Every entry is a territory the ISO tables do not cover;
 * it is not a place to encode preferences about naming or bucketing. Today it
 * has exactly one member, and the day it needs a second the reason should be
 * "ISO has no assignment for it either", not "this was easier here".
 */
const APPLE_TO_CATALOG: Readonly<Record<string, string>> = {
  // Kosovo. Apple: XKS · Play Console + TERRITORY_CATALOG: XK · ISO: none.
  XKS: "XK",
};

/** The same map, inverted once at module load rather than searched per call. */
const CATALOG_TO_APPLE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(APPLE_TO_CATALOG).map(([apple, catalog]) => [catalog, apple]),
);

/**
 * Apple's code → the code the picker and the column headers use.
 *
 * ⚠ FALLS BACK TO THE INPUT, NEVER TO EMPTY. An unknown territory keeps
 * Apple's own code and therefore still gets a column — a market we cannot
 * name is still a market with a price, and dropping it would be the exact
 * failure this module exists to end.
 */
export function toCatalogCode(appleCode: string): string {
  return (
    APPLE_TO_CATALOG[appleCode] ?? countries.alpha3ToAlpha2(appleCode) ?? appleCode
  );
}

/**
 * The reverse: a column/selection code → the code Apple speaks.
 *
 * Used by the header builder to resolve a display name (`territoryName()`
 * takes Apple's alpha-3). Falls back to the input for the same reason.
 */
export function toAppleCode(catalogCode: string): string {
  return (
    CATALOG_TO_APPLE[catalogCode] ??
    countries.alpha2ToAlpha3(catalogCode) ??
    catalogCode
  );
}

/** Test-only visibility into the override table, so a test can assert the map
 *  stays small rather than merely that Kosovo works. */
export const __APPLE_CODE_OVERRIDES = APPLE_TO_CATALOG;
