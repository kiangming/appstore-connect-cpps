/**
 * Cycle 38 — ISO 3166-1 alpha-3 → continent mapping (Apple side).
 *
 * Apple's IAP API surfaces territory codes in alpha-3 (USA, VNM, JPN,
 * KHM, …) — that's what `price_tier_template_entries.territory_code`
 * stores. The Cycle 36 `region-continent.ts` helper handles Google's
 * alpha-2 codes; this file is its Apple twin so the matrix view's
 * continent toggle works on Apple-side data without translating codes.
 *
 * Buckets and rationale mirror the Cycle 36 mapping:
 *   - Asia, Europe, Americas, Africa, Oceania
 *   - Türkiye → Europe (Apple groups it with Europe per Google Play
 *     storefront convention reused here)
 *   - Russia → Europe (ISO + Apple convention)
 *   - Antarctica → null (not sold to)
 *
 * Inline mapping over a library is intentional: ~250-entry static table
 * is trivially auditable and adds no runtime dep. Mirrors the same
 * Manager-readable structure as the alpha-2 sibling.
 */

import type { Continent } from "../../google-iap-management/region-continent";

export type { Continent };

const ASIA = new Set<string>([
  "AFG", "ARM", "AZE", "BHR", "BGD", "BTN", "BRN", "KHM", "CHN", "CYP",
  "GEO", "HKG", "IND", "IDN", "IRN", "IRQ", "ISR", "JPN", "JOR", "KAZ",
  "KWT", "KGZ", "LAO", "LBN", "MAC", "MYS", "MDV", "MNG", "MMR", "NPL",
  "PRK", "OMN", "PAK", "PSE", "PHL", "QAT", "SAU", "SGP", "KOR", "LKA",
  "SYR", "TWN", "TJK", "THA", "TLS", "TUR", "TKM", "ARE", "UZB", "VNM",
  "YEM",
]);

const EUROPE = new Set<string>([
  "ALB", "AND", "AUT", "BLR", "BEL", "BIH", "BGR", "HRV", "CZE", "DNK",
  "EST", "FIN", "FRA", "DEU", "GRC", "HUN", "ISL", "IRL", "ITA", "XKX",
  "LVA", "LIE", "LTU", "LUX", "MLT", "MDA", "MCO", "MNE", "NLD", "MKD",
  "NOR", "POL", "PRT", "ROU", "RUS", "SMR", "SRB", "SVK", "SVN", "ESP",
  "SWE", "CHE", "UKR", "GBR", "VAT",
  "GGY", "JEY", "IMN", "FRO",
  "ALA", "SJM", "GIB",
]);

const AMERICAS = new Set<string>([
  "ATG", "ARG", "ABW", "BHS", "BRB", "BLZ", "BMU", "BOL", "BRA", "CAN",
  "CYM", "CHL", "COL", "CRI", "CUB", "DMA", "DOM", "ECU", "SLV", "FLK",
  "GUF", "GRL", "GRD", "GLP", "GTM", "GUY", "HTI", "HND", "JAM", "MTQ",
  "MEX", "MSR", "NIC", "PAN", "PRY", "PER", "PRI", "KNA", "LCA", "SPM",
  "VCT", "SUR", "TTO", "TCA", "USA", "URY", "VEN", "VGB", "VIR",
  "AIA", "BES", "CUW", "SXM", "MAF", "BLM",
]);

const AFRICA = new Set<string>([
  "DZA", "AGO", "BEN", "BWA", "BFA", "BDI", "CPV", "CMR", "CAF", "TCD",
  "COM", "COG", "COD", "CIV", "DJI", "EGY", "GNQ", "ERI", "SWZ", "ETH",
  "GAB", "GMB", "GHA", "GIN", "GNB", "KEN", "LSO", "LBR", "LBY", "MDG",
  "MWI", "MLI", "MRT", "MUS", "MYT", "MAR", "MOZ", "NAM", "NER", "NGA",
  "REU", "RWA", "STP", "SEN", "SYC", "SLE", "SOM", "ZAF", "SSD", "SDN",
  "TZA", "TGO", "TUN", "UGA", "ESH", "ZMB", "ZWE",
  "IOT", "SHN",
]);

const OCEANIA = new Set<string>([
  "ASM", "AUS", "COK", "FJI", "PYF", "GUM", "KIR", "MHL", "FSM", "NRU",
  "NCL", "NZL", "NIU", "NFK", "MNP", "PLW", "PNG", "PCN", "WSM", "SLB",
  "TKL", "TON", "TUV", "VUT", "WLF",
  "UMI",
]);

const BY_CODE: Map<string, Continent> = (() => {
  const map = new Map<string, Continent>();
  for (const c of ASIA) map.set(c, "Asia");
  for (const c of EUROPE) map.set(c, "Europe");
  for (const c of AMERICAS) map.set(c, "Americas");
  for (const c of AFRICA) map.set(c, "Africa");
  for (const c of OCEANIA) map.set(c, "Oceania");
  return map;
})();

export const APPLE_CONTINENTS: ReadonlyArray<Continent> = [
  "Asia",
  "Europe",
  "Americas",
  "Africa",
  "Oceania",
];

/**
 * Map an ISO 3166-1 alpha-3 territory code to its continent bucket.
 * Returns null when the code is unrecognised (ATA Antarctica,
 * private-use codes, or anything Apple sometimes returns that ISO
 * doesn't bucket). Caller decides whether to drop or render under
 * "Other".
 */
export function getContinentForTerritory(code: string): Continent | null {
  if (!code) return null;
  return BY_CODE.get(code.toUpperCase()) ?? null;
}
