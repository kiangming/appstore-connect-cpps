/**
 * G2 — the territory list the APPLE export picker shows.
 *
 * `[Q-EXPORT.apple-only-picker]`: the Apple picker offers exactly the markets
 * Apple sells to (175), not the shared 183. A country Apple does not sell in
 * cannot be ticked and cannot produce a column, so the file stops carrying
 * questions nobody asked.
 *
 * ─── ONE SOURCE OF IDENTITY, THREE LAYERS OF FACT ──────────────────────────
 *
 *   WHICH territories  `apple-territories.snapshot.ts`  — the only authority
 *   CURRENCY           `apple-territories.snapshot.ts`  — Apple's own answer
 *   NAME + REGION      `TERRITORY_CATALOG`, plus a small table for the 11
 *                      markets the catalog has never carried
 *
 * ⚠ THERE IS NO SECOND LIST OF CODES. This module iterates the snapshot and
 * decorates it; it never enumerates territories of its own. Two lists that
 * must agree are two lists that will not — the same reason
 * `APPLE_TERRITORIES_ALPHA3` became a projection in G1b rather than a
 * hand-kept sibling.
 *
 * ⚠ CURRENCY COMES FROM THE SNAPSHOT, NEVER FROM THE CATALOG, and this is not
 * a style preference. Measured 2026-08-27: the catalog disagrees with Apple on
 * **96 of the 164 codes they share (58.5%)**, because Apple collapses 93
 * markets to USD and 3 to EUR rather than billing locally — Bulgaria is EUR
 * not BGN, Macau USD not MOP. The catalog is right about the country and wrong
 * about Apple, and this picker shows Apple's prices. KB §4.19, and
 * `[CATALOG-currency-wrong]` in TODO.md for the surface still reading it.
 *
 * ⚠ NAME AND REGION *ARE* TAKEN FROM THE CATALOG for the 164 shared codes, and
 * that is deliberate: they are the same facts, resolved the same way
 * (`i18n-iso-countries` + a small override map), and copying 164 rows here
 * would create the very duplicate this file's first warning forbids. Only
 * currency had a reason to diverge, and only currency does.
 */
import {
  APPLE_TERRITORIES,
  type AppleTerritory,
} from "./apple-territories.snapshot";
import { toCatalogCode } from "./territory-code-map";
import {
  TERRITORY_CATALOG,
  TERRITORY_REGIONS,
  type TerritoryEntry,
  type TerritoryRegion,
} from "@/lib/iap-management/territory-catalog";
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";

countries.registerLocale(enLocale);

/**
 * Display names for the 11 Apple markets the shared catalog has never carried
 * — where ISO's official form is not what a Manager would look for.
 *
 * ⚠ Only three entries, and each is a divergence from ISO, not a preference:
 * ISO says "Russian Federation", "Virgin Islands, British" and "Turks and
 * Caicos Islands". Mirrors `DISPLAY_NAME_OVERRIDES` in the shared catalog
 * rather than inventing a second convention. The other eight resolve straight
 * from `i18n-iso-countries` (verified 11/11 resolvable).
 */
const APPLE_ONLY_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  RU: "Russia",
  VG: "British Virgin Islands",
  TC: "Turks & Caicos",
};

/**
 * Region bucket for the 11, ASSIGNED BY HAND.
 *
 * ⚠ WHY NOT READ THEM FROM `region-continent.ts`. It does carry all 11 — but
 * on a FIVE-bucket scheme that folds the Middle East into Asia, while this
 * picker groups into SIX. Measured: every one of the catalog's 11 Middle East
 * entries (BH IQ IL JO KW LB OM QA SA TR AE) is `ASIA` over there. Importing
 * mechanically would file **Yemen under Asia**, which is the single row in
 * this table where the two schemes disagree.
 *
 * ⚠ AND THAT IS NOT WORTH A CONVERTER. Writing a 5→6 bucket translation for
 * one exception means maintaining a mapping whose only job is to special-case
 * Yemen, in a file nobody would think to look in. Eleven hand-written rows
 * with the reason next to them is the honest size of this problem.
 */
const APPLE_ONLY_REGIONS: Readonly<Record<string, TerritoryRegion>> = {
  AI: "Americas",
  BM: "Americas",
  KY: "Americas",
  MS: "Americas",
  TC: "Americas",
  VG: "Americas",
  BY: "Europe",
  RU: "Europe",
  LY: "Africa",
  ZW: "Africa",
  // ⚠ Middle East, NOT Asia. See the warning above — this is the row that
  // makes the hand-assignment necessary.
  YE: "Middle East",
};

const CATALOG_BY_CODE: ReadonlyMap<string, TerritoryEntry> = new Map(
  TERRITORY_CATALOG.map((t) => [t.code, t]),
);

function nameFor(code: string): string {
  const fromCatalog = CATALOG_BY_CODE.get(code)?.name;
  if (fromCatalog) return fromCatalog;
  return (
    APPLE_ONLY_NAME_OVERRIDES[code] ?? countries.getName(code, "en") ?? code
  );
}

function regionFor(code: string): TerritoryRegion {
  const fromCatalog = CATALOG_BY_CODE.get(code)?.region;
  if (fromCatalog) return fromCatalog;
  const assigned = APPLE_ONLY_REGIONS[code];
  if (assigned) return assigned;
  // ⚠ A territory Apple added after 2026-08-27 that nothing here knows. It
  // still appears — losing a market from the picker is worse than filing it
  // imperfectly — and the export's drift warning is what says the snapshot
  // needs refreshing.
  return "Asia";
}

function decorate(t: AppleTerritory): TerritoryEntry {
  const code = toCatalogCode(t.code);
  return {
    code,
    name: nameFor(code),
    // ⚠ Apple's answer, every time. Never `CATALOG_BY_CODE.get(code).currency`.
    currency: t.currency,
    region: regionFor(code),
  };
}

/**
 * The 175 Apple markets, grouped and sorted exactly like the shared catalog
 * (region order, then alphabetical by name) so the picker's shape is
 * identical and only its CONTENTS differ.
 */
export const APPLE_TERRITORY_CATALOG: readonly TerritoryEntry[] = (() => {
  const all = APPLE_TERRITORIES.map(decorate);
  const out: TerritoryEntry[] = [];
  for (const region of TERRITORY_REGIONS) {
    out.push(
      ...all
        .filter((t) => t.region === region)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }
  return out;
})();

/** Codes only, in picker order. ⚠ Derived — see the header. */
export const APPLE_TERRITORY_CODES: readonly string[] =
  APPLE_TERRITORY_CATALOG.map((t) => t.code);
