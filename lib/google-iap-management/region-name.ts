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
 * This module wires `i18n-iso-countries` as the canonical alpha-2 →
 * English-name source (full ISO 3166-1 coverage, ~250 entries) so the
 * Edit form select can list every market Google supports and render the
 * correct country name. Mirrors the Apple-side resolver pattern in
 * components/iap-management/view-detail/territory-name.ts (which uses
 * alpha-3 because Apple returns 3-letter codes).
 *
 * Manager directive: display the country name only ("Albania"), not
 * "AL — Albania", to match Google Play Console pricing UI.
 */
import countries from "i18n-iso-countries";
// eslint-disable-next-line @typescript-eslint/no-var-requires -- JSON locale data loaded at module init
import enLocale from "i18n-iso-countries/langs/en.json";

countries.registerLocale(enLocale);

/**
 * Google-Play-specific display labels that diverge from the ISO 3166-1
 * default English name. Keep this map small — every entry is a
 * deliberate divergence from the upstream package matching a label the
 * Google Play Console pricing UI actually renders. Verified against
 * Manager reference Image 2.
 */
const GOOGLE_OVERRIDES: Record<string, string> = {
  US: "United States", // ISO default: "United States of America"
  GB: "United Kingdom", // ISO default: "United Kingdom of Great Britain and Northern Ireland"
  KR: "South Korea", // ISO default: "Korea, Republic of"
  KP: "North Korea", // ISO default: "Korea, Democratic People's Republic of"
  TW: "Taiwan", // ISO default: "Taiwan, Province of China"
  RU: "Russia", // ISO default: "Russian Federation"
  IR: "Iran", // ISO default: "Iran, Islamic Republic of"
  LA: "Laos", // ISO default: "Lao People's Democratic Republic"
  VN: "Vietnam", // ISO default: "Viet Nam"
  CZ: "Czechia", // ISO default already "Czechia" in most builds; pin for stability
  MO: "Macau", // ISO default: "Macao"
  TZ: "Tanzania", // ISO default: "Tanzania, United Republic of"
  SY: "Syria", // ISO default: "Syrian Arab Republic"
  BO: "Bolivia", // ISO default: "Bolivia, Plurinational State of"
  VE: "Venezuela", // ISO default: "Venezuela, Bolivarian Republic of"
  MD: "Moldova", // ISO default: "Moldova, Republic of"
  PS: "Palestine", // ISO default: "Palestine, State of"
  BN: "Brunei", // ISO default: "Brunei Darussalam"
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
  if (GOOGLE_OVERRIDES[upper]) return GOOGLE_OVERRIDES[upper];
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
