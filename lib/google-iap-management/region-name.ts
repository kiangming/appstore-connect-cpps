/**
 * Hotfix 21 — Google Play region-code → display-name resolver.
 *
 * Google Play uses ISO 3166-1 alpha-2 country codes in InAppProduct.prices
 * and Monetization API regional pricing. Pre-Hotfix 21 the Edit form
 * sourced the region select from a hand-curated 30-entry `COMMON_REGIONS`
 * list (lib/google-iap-management/regions.ts). When Google returned a
 * price for a region outside that list (e.g. AL Albania, DZ Algeria,
 * AO Angola), the browser fell back to rendering the first option's
 * label ("US — United States") because the `<select value="AL">` value
 * matched no option. Manager flagged this in Cycle 35 close.
 *
 * This module wires `i18n-iso-countries` as the FALLBACK alpha-2 →
 * English-name source (full ISO 3166-1 coverage, ~250 entries) so the
 * Edit form select can list every market Google supports and render a
 * country name for any code at all. Mirrors the Apple-side resolver pattern
 * in components/iap-management/view-detail/territory-name.ts (which uses
 * alpha-3 because Apple returns 3-letter codes).
 *
 * ⚠ SINCE 2026-09-01 THE LIBRARY IS THE FALLBACK, NOT THE SOURCE. For the
 * 173 markets Google Play actually sells in, the name comes from
 * `PLAY_CONSOLE_LABELS` below — the Console's own Pricing screen — and the
 * library is never consulted. It answers only for codes outside that set,
 * which reach this function through `getAllRegions()`, not through pricing.
 *
 * Manager directive: display the country name only ("Albania"), not
 * "AL — Albania", to match Google Play Console pricing UI. The export file
 * is the one exception and composes `Name (CODE)` on top of this — see
 * `territoryColumnHeader` in xlsx-export.ts, and the reason there.
 */
import countries from "i18n-iso-countries";
// eslint-disable-next-line @typescript-eslint/no-var-requires -- JSON locale data loaded at module init
import enLocale from "i18n-iso-countries/langs/en.json";

countries.registerLocale(enLocale);

/**
 * ⚠ THE LABELS GOOGLE PLAY CONSOLE ITSELF SHOWS — all 173 markets, not a
 * patch list.
 *
 * Source: Google Play Console, **Pricing** screen (country + currency),
 * supplied by the Manager 2026-09-01. The code set and the currency of every
 * entry were compared by machine against `monetization.convertRegionPrices`
 * (measurement M1, `regionsVersion` "2025/03") and MATCH 100 PERCENT, 0
 * differing in either direction — so this is the same 173 markets the API
 * sells to, named the way the Console names them.
 *
 * ⚠ THIS REPLACED AN 18-ENTRY PATCH LIST, AND THE REPLACEMENT IS THE POINT.
 * Measured against this table, that list was: 7 entries doing real work, 5
 * that the library had silently made redundant (it now returns "United
 * Kingdom", "South Korea", "Bolivia", "Venezuela", "Vietnam" on its own), 5
 * for markets Google does not sell in — and ONE THAT WAS SIMPLY WRONG: `MO`
 * was pinned to "Macau" while both the Console and ISO say "Macao". A list
 * that grows one entry at a time is only ever as right as the last person who
 * noticed something; a full table can be diffed against its source.
 *
 * ⚠ AND THE OLD COMMENTS LIED ABOUT THE LIBRARY, WHICH IS HOW 5 ENTRIES WENT
 * STALE UNSEEN. They recorded an "ISO default" per entry — "Viet Nam",
 * "Korea, Republic of", "Bolivia, Plurinational State of" — that
 * `i18n-iso-countries@7.14.0` no longer returns. The package changed under
 * them and nothing failed, because a redundant override and a load-bearing
 * one look identical from the outside. That is why the table below carries no
 * per-entry claim about what the library would have said: its only claim is
 * what the Console shows, and that is checkable against the source.
 *
 * ⚠ NON-ASCII IS LOAD-BEARING IN EXACTLY THREE CHARACTERS, typed here as real
 * characters and verified by CODE POINT, not by eye:
 *   CI  "Côte d’Ivoire"  — o-circumflex = U+00F4, apostrophe = U+2019 (RIGHT
 *                          SINGLE QUOTATION MARK), NOT the ASCII U+0027
 *   TR  "Türkiye"        — u-diaeresis = U+00FC
 * `region-name.play-labels.test.ts` asserts those code points, and the xlsx
 * export additionally asserts they survive to the BYTES of the written file
 * as UTF-8 — a latin-1 write round-trips through the reader looking fine and
 * opens in Excel as mojibake.
 *
 * ⚠ HOW TO REFRESH: re-run M1
 * (`GET /api/google-iap-management/regions/catalog?packageName=<cached>`) for
 * the code+currency set, and read the Console's Pricing screen for the
 * labels. Do NOT extend this table from a name that merely looks better —
 * every entry is a claim about a screen someone has read.
 */
const PLAY_CONSOLE_LABELS: Record<string, string> = {
  AE: "United Arab Emirates", AG: "Antigua & Barbuda", AL: "Albania",
  AM: "Armenia", AO: "Angola", AR: "Argentina", AT: "Austria",
  AU: "Australia", AW: "Aruba", AZ: "Azerbaijan",
  BA: "Bosnia & Herzegovina", BD: "Bangladesh", BE: "Belgium",
  BF: "Burkina Faso", BG: "Bulgaria", BH: "Bahrain", BJ: "Benin",
  BM: "Bermuda", BO: "Bolivia", BR: "Brazil", BS: "Bahamas",
  BW: "Botswana", BY: "Belarus", BZ: "Belize", CA: "Canada",
  CD: "Congo - Kinshasa", CF: "Central African Republic",
  CG: "Congo - Brazzaville", CH: "Switzerland", CI: "Côte d’Ivoire",
  CL: "Chile", CM: "Cameroon", CO: "Colombia", CR: "Costa Rica",
  CV: "Cape Verde", CY: "Cyprus", CZ: "Czechia", DE: "Germany",
  DJ: "Djibouti", DK: "Denmark", DM: "Dominica", DO: "Dominican Republic",
  DZ: "Algeria", EC: "Ecuador", EE: "Estonia", EG: "Egypt", ER: "Eritrea",
  ES: "Spain", FI: "Finland", FJ: "Fiji", FM: "Micronesia", FR: "France",
  GA: "Gabon", GB: "United Kingdom", GD: "Grenada", GE: "Georgia",
  GH: "Ghana", GI: "Gibraltar", GM: "Gambia", GN: "Guinea", GR: "Greece",
  GT: "Guatemala", GW: "Guinea-Bissau", HK: "Hong Kong", HN: "Honduras",
  HR: "Croatia", HT: "Haiti", HU: "Hungary", ID: "Indonesia",
  IE: "Ireland", IL: "Israel", IN: "India", IQ: "Iraq", IS: "Iceland",
  IT: "Italy", JM: "Jamaica", JO: "Jordan", JP: "Japan", KE: "Kenya",
  KG: "Kyrgyzstan", KH: "Cambodia", KM: "Comoros", KN: "St. Kitts & Nevis",
  KR: "South Korea", KW: "Kuwait", KY: "Cayman Islands", KZ: "Kazakhstan",
  LA: "Laos", LB: "Lebanon", LC: "St. Lucia", LI: "Liechtenstein",
  LK: "Sri Lanka", LR: "Liberia", LT: "Lithuania", LU: "Luxembourg",
  LV: "Latvia", LY: "Libya", MA: "Morocco", MC: "Monaco", MD: "Moldova",
  MK: "North Macedonia", ML: "Mali", MM: "Myanmar (Burma)", MN: "Mongolia",
  MO: "Macao", MT: "Malta", MU: "Mauritius", MV: "Maldives", MX: "Mexico",
  MY: "Malaysia", MZ: "Mozambique", NA: "Namibia", NE: "Niger",
  NG: "Nigeria", NI: "Nicaragua", NL: "Netherlands", NO: "Norway",
  NP: "Nepal", NZ: "New Zealand", OM: "Oman", PA: "Panama", PE: "Peru",
  PG: "Papua New Guinea", PH: "Philippines", PK: "Pakistan", PL: "Poland",
  PT: "Portugal", PY: "Paraguay", QA: "Qatar", RO: "Romania", RS: "Serbia",
  RU: "Russia", RW: "Rwanda", SA: "Saudi Arabia", SB: "Solomon Islands",
  SC: "Seychelles", SE: "Sweden", SG: "Singapore", SI: "Slovenia",
  SK: "Slovakia", SL: "Sierra Leone", SM: "San Marino", SN: "Senegal",
  SO: "Somalia", SR: "Suriname", SV: "El Salvador",
  TC: "Turks & Caicos Islands", TD: "Chad", TG: "Togo", TH: "Thailand",
  TJ: "Tajikistan", TM: "Turkmenistan", TN: "Tunisia", TO: "Tonga",
  TR: "Türkiye", TT: "Trinidad & Tobago", TW: "Taiwan", TZ: "Tanzania",
  UA: "Ukraine", UG: "Uganda", US: "United States", UY: "Uruguay",
  UZ: "Uzbekistan", VA: "Vatican City", VE: "Venezuela",
  VG: "British Virgin Islands", VN: "Vietnam", VU: "Vanuatu", WS: "Samoa",
  YE: "Yemen", ZA: "South Africa", ZM: "Zambia", ZW: "Zimbabwe",
};

/**
 * Markets Google Play does NOT sell in, kept because this module also serves
 * `getAllRegions()` — the Edit form's region picker lists every ISO 3166-1
 * code, not just the sellable ones, so a code Google returns unexpectedly is
 * still renderable.
 *
 * ⚠ THESE ARE NOT PLAY CONSOLE LABELS and must never be merged into the table
 * above. There is no Console pricing row for them to be checked against; they
 * are the previous list's remaining entries, kept so this change does not
 * quietly alter a surface it was not aimed at.
 */
const NON_PRICING_LABELS: Record<string, string> = {
  KP: "North Korea",
  IR: "Iran",
  SY: "Syria",
  PS: "Palestine",
  BN: "Brunei",
};

/**
 * Resolve an ISO 3166-1 alpha-2 code to a display name suitable for the
 * Edit form region picker and any other Google-IAP UI surface. Falls
 * back to the upper-cased code itself if i18n-iso-countries has no
 * entry (defensive — should rarely fire for Google Play codes).
 */
export function regionNameFromCode(code: string): string {
  if (!code) return code;
  const upper = code.toUpperCase();
  // Play Console first — for the 173 markets that have a Console row the
  // Console IS the answer, and the library is not consulted at all.
  if (PLAY_CONSOLE_LABELS[upper]) return PLAY_CONSOLE_LABELS[upper];
  if (NON_PRICING_LABELS[upper]) return NON_PRICING_LABELS[upper];
  const name = countries.getName(upper, "en");
  return name ?? upper;
}

export interface RegionListEntry {
  code: string;
  name: string;
}

let cachedList: RegionListEntry[] | null = null;

/**
 * Return every ISO 3166-1 alpha-2 region with its display name, sorted
 * alphabetically by name. Cached after first call (the underlying data
 * is static for the lifetime of the process). Used by the Edit form
 * region picker so any code Google returns is renderable.
 */
export function getAllRegions(): RegionListEntry[] {
  if (cachedList) return cachedList;
  const all = countries.getNames("en");
  const merged: RegionListEntry[] = Object.keys(all).map((code) => ({
    code,
    name: regionNameFromCode(code),
  }));
  merged.sort((a, b) => a.name.localeCompare(b.name));
  cachedList = merged;
  return cachedList;
}
