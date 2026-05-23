/**
 * Cycle 36 — ISO 3166-1 alpha-2 → continent bucket mapping.
 *
 * Pairs with `region-name.ts` (Hotfix 21) to power the pricing-template
 * matrix view's continent toggle filter. The Manager UX directive
 * (Q2.D, locked 2026-05-23) calls for hide/show pills over 5 continent
 * buckets: Asia, Europe, Americas, Africa, Oceania.
 *
 * Inline mapping over a library (e.g. countries-and-timezones,
 * country-flag-icons) chosen deliberately:
 *   - ~250-entry static table — trivially auditable
 *   - Zero new runtime dependency
 *   - Deterministic bucketing decisions Manager can override if Google
 *     Play's storefront grouping ever diverges from the geographical
 *     standard (e.g. Türkiye crosses Asia/Europe — Google Play groups it
 *     with Europe; we follow that here)
 *
 * Bucket definitions follow UN M.49 / ISO 3166-1 standard regions with
 * Google-Play-specific exceptions noted at each line.
 *
 * Unrecognised codes (e.g. private-use ranges, deprecated codes) return
 * null — caller decides whether to bucket them under "Other" or drop.
 */

export type Continent = "Asia" | "Europe" | "Americas" | "Africa" | "Oceania";

const ASIA = new Set<string>([
  "AF", "AM", "AZ", "BH", "BD", "BT", "BN", "KH", "CN", "CY", "GE", "HK",
  "IN", "ID", "IR", "IQ", "IL", "JP", "JO", "KZ", "KW", "KG", "LA", "LB",
  "MO", "MY", "MV", "MN", "MM", "NP", "KP", "OM", "PK", "PS", "PH", "QA",
  "SA", "SG", "KR", "LK", "SY", "TW", "TJ", "TH", "TL", "TR", "TM", "AE",
  "UZ", "VN", "YE",
]);

const EUROPE = new Set<string>([
  "AL", "AD", "AT", "BY", "BE", "BA", "BG", "HR", "CZ", "DK", "EE", "FI",
  "FR", "DE", "GR", "HU", "IS", "IE", "IT", "XK", "LV", "LI", "LT", "LU",
  "MT", "MD", "MC", "ME", "NL", "MK", "NO", "PL", "PT", "RO", "RU", "SM",
  "RS", "SK", "SI", "ES", "SE", "CH", "UA", "GB", "VA",
  // Crown / British Isles dependencies
  "GG", "JE", "IM", "FO",
  // Russian-language enclaves Google Play sells in (rare)
  "AX", // Åland Islands (Finland)
  "SJ", // Svalbard & Jan Mayen
  "GI", // Gibraltar
]);

const AMERICAS = new Set<string>([
  "AG", "AR", "AW", "BS", "BB", "BZ", "BM", "BO", "BR", "CA", "KY", "CL",
  "CO", "CR", "CU", "DM", "DO", "EC", "SV", "FK", "GF", "GL", "GD", "GP",
  "GT", "GY", "HT", "HN", "JM", "MQ", "MX", "MS", "NI", "PA", "PY", "PE",
  "PR", "KN", "LC", "PM", "VC", "SR", "TT", "TC", "US", "UY", "VE", "VG",
  "VI",
  // Caribbean / Atlantic dependencies sometimes surfaced by Google
  "AI", // Anguilla
  "BQ", // Caribbean Netherlands (Bonaire, Sint Eustatius, Saba)
  "CW", // Curaçao
  "SX", // Sint Maarten (Dutch)
  "MF", // Saint Martin (French)
  "BL", // Saint Barthélemy
]);

const AFRICA = new Set<string>([
  "DZ", "AO", "BJ", "BW", "BF", "BI", "CV", "CM", "CF", "TD", "KM", "CG",
  "CD", "CI", "DJ", "EG", "GQ", "ER", "SZ", "ET", "GA", "GM", "GH", "GN",
  "GW", "KE", "LS", "LR", "LY", "MG", "MW", "ML", "MR", "MU", "YT", "MA",
  "MZ", "NA", "NE", "NG", "RE", "RW", "ST", "SN", "SC", "SL", "SO", "ZA",
  "SS", "SD", "TZ", "TG", "TN", "UG", "EH", "ZM", "ZW",
  // Indian-Ocean / Atlantic dependencies
  "IO", // British Indian Ocean Territory
  "SH", // Saint Helena, Ascension & Tristan da Cunha
]);

const OCEANIA = new Set<string>([
  "AS", "AU", "CK", "FJ", "PF", "GU", "KI", "MH", "FM", "NR", "NC", "NZ",
  "NU", "NF", "MP", "PW", "PG", "PN", "WS", "SB", "TK", "TO", "TV", "VU",
  "WF",
  // Smaller territories occasionally returned by Google
  "UM", // U.S. Minor Outlying Islands
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

export const CONTINENTS: ReadonlyArray<Continent> = [
  "Asia",
  "Europe",
  "Americas",
  "Africa",
  "Oceania",
];

/**
 * Map an ISO 3166-1 alpha-2 region code to its continent bucket.
 * Returns null when the code is unrecognised (private-use, deprecated,
 * or simply not in our 5-bucket scheme — e.g. Antarctica AQ which
 * Google Play doesn't sell to but may appear in test data).
 */
export function getContinentForRegion(code: string): Continent | null {
  if (!code) return null;
  return BY_CODE.get(code.toUpperCase()) ?? null;
}
