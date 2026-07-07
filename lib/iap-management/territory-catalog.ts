/**
 * Shared territory → currency → region catalog for the "Export options"
 * dialog (Google IAP + Apple IAP export — see
 * docs/google-iap-management/design/export-options-dialog-mockup.html,
 * commit 6465178).
 *
 * Part 1 investigation (this feature): neither module already encodes a
 * COMPLETE territory→currency catalog.
 *   - `lib/google-iap-management/regions.ts` (COMMON_REGIONS) is an
 *     explicitly curated ~30-entry subset ("v1 surfaces a curated subset
 *     matching the Manager's volume"), not the full store list.
 *   - `lib/google-iap-management/google/region-currency-map.ts` is
 *     BCP-47 LANGUAGE → currency (e.g. "en" → USD), not COUNTRY →
 *     currency — many countries share a language but not a currency
 *     (Canada/UK/Australia all speak English but use CAD/GBP/AUD), so
 *     it can't be repurposed as a per-country catalog.
 *   - `price_tier_territories` / `pricing_template_entries` (DB tables)
 *     only contain territories a Manager has actually price-configured
 *     for a specific tier/template — incomplete/empty for apps or tiers
 *     without one, not a canonical "every store territory" list.
 *   - `i18n-iso-countries` (already a dependency — also used by
 *     lib/google-iap-management/region-name.ts and
 *     components/iap-management/view-detail/territory-name.ts) gives
 *     country names, but ISO 3166-1 carries no currency data.
 *
 * Conclusion: build ONE static data module (this file) rather than a new
 * dependency. Google Play and App Store sell to nearly-identical
 * territory sets, so one shared catalog is deliberately used by both
 * modules' export routes — this file lives under `lib/iap-management/`
 * (the module root already used for cross-module utilities, e.g.
 * `concurrency.ts` and `pagination/page-slice.ts`, both imported by the
 * Google module). Codes are ISO 3166-1 alpha-2 — Google's native format,
 * and the same format the Apple export already converts its native
 * alpha-3 codes to for display (see `lib/iap-management/xlsx-export.ts`
 * `toAlpha2`). Picking a territory a given app doesn't actually sell in
 * is harmless — the export's territory union naturally has no data for
 * it, so the column is blank (matching today's behavior for any
 * unpriced territory).
 *
 * Region buckets (Asia / Europe / Americas / Africa / Middle East /
 * Oceania) match the approved mockup's 6-way grouping — NOT Google's
 * own `region-continent.ts`, which buckets Middle-East countries into
 * "Asia" (5 buckets, no separate Middle East). The mockup is the
 * approved source of truth for this UI, so this file defines its own
 * bucket per entry rather than reusing that 5-bucket scheme.
 */
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";

countries.registerLocale(enLocale);

export type TerritoryRegion =
  | "Asia"
  | "Europe"
  | "Americas"
  | "Africa"
  | "Middle East"
  | "Oceania";

export const TERRITORY_REGIONS: readonly TerritoryRegion[] = [
  "Asia",
  "Europe",
  "Americas",
  "Africa",
  "Middle East",
  "Oceania",
];

export interface TerritoryEntry {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  /** ISO 4217. Several countries deliberately share a code — the same
   *  1-country:1-currency-but-many-countries:1-shared-currency reality
   *  the approved mockup calls out (EUR, XOF, XCF/XOF, USD, XCD, …). */
  currency: string;
  region: TerritoryRegion;
}

interface RawEntry {
  code: string;
  currency: string;
  region: TerritoryRegion;
}

/** A handful of display-name divergences from the ISO 3166-1 default —
 *  small and deliberate, mirroring the override pattern already used by
 *  region-name.ts (Google) and territory-name.ts (Apple). Kept local
 *  (not imported) since importing a Google-namespaced module from this
 *  shared/cross-module file would run the dependency direction backwards
 *  relative to the established precedent (Google → lib/iap-management,
 *  never the reverse). */
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  KR: "South Korea",
  TW: "Taiwan",
  VN: "Vietnam",
  CZ: "Czechia",
  MO: "Macau",
  LA: "Laos",
  MD: "Moldova",
  CI: "Côte d'Ivoire",
};

// prettier-ignore
const RAW: readonly RawEntry[] = [
  // ── Asia ──────────────────────────────────────────────────────────
  { code: "AF", currency: "AFN", region: "Asia" },
  { code: "AM", currency: "AMD", region: "Asia" },
  { code: "AZ", currency: "AZN", region: "Asia" },
  { code: "BD", currency: "BDT", region: "Asia" },
  { code: "BT", currency: "BTN", region: "Asia" },
  { code: "BN", currency: "BND", region: "Asia" },
  { code: "KH", currency: "KHR", region: "Asia" },
  { code: "CN", currency: "CNY", region: "Asia" },
  { code: "GE", currency: "GEL", region: "Asia" },
  { code: "HK", currency: "HKD", region: "Asia" },
  { code: "IN", currency: "INR", region: "Asia" },
  { code: "ID", currency: "IDR", region: "Asia" },
  { code: "JP", currency: "JPY", region: "Asia" },
  { code: "KZ", currency: "KZT", region: "Asia" },
  { code: "KG", currency: "KGS", region: "Asia" },
  { code: "LA", currency: "LAK", region: "Asia" },
  { code: "MO", currency: "MOP", region: "Asia" },
  { code: "MY", currency: "MYR", region: "Asia" },
  { code: "MV", currency: "MVR", region: "Asia" },
  { code: "MN", currency: "MNT", region: "Asia" },
  { code: "MM", currency: "MMK", region: "Asia" },
  { code: "NP", currency: "NPR", region: "Asia" },
  { code: "PK", currency: "PKR", region: "Asia" },
  { code: "PH", currency: "PHP", region: "Asia" },
  { code: "SG", currency: "SGD", region: "Asia" },
  { code: "KR", currency: "KRW", region: "Asia" },
  { code: "LK", currency: "LKR", region: "Asia" },
  { code: "TW", currency: "TWD", region: "Asia" },
  { code: "TJ", currency: "TJS", region: "Asia" },
  { code: "TH", currency: "THB", region: "Asia" },
  { code: "TL", currency: "USD", region: "Asia" },
  { code: "TM", currency: "TMT", region: "Asia" },
  { code: "UZ", currency: "UZS", region: "Asia" },
  { code: "VN", currency: "VND", region: "Asia" },

  // ── Middle East ───────────────────────────────────────────────────
  { code: "BH", currency: "BHD", region: "Middle East" },
  { code: "IQ", currency: "IQD", region: "Middle East" },
  { code: "IL", currency: "ILS", region: "Middle East" },
  { code: "JO", currency: "JOD", region: "Middle East" },
  { code: "KW", currency: "KWD", region: "Middle East" },
  { code: "LB", currency: "LBP", region: "Middle East" },
  { code: "OM", currency: "OMR", region: "Middle East" },
  { code: "QA", currency: "QAR", region: "Middle East" },
  { code: "SA", currency: "SAR", region: "Middle East" },
  { code: "TR", currency: "TRY", region: "Middle East" },
  { code: "AE", currency: "AED", region: "Middle East" },

  // ── Europe (5 EUR entries deliberately included per the mockup) ────
  { code: "AL", currency: "ALL", region: "Europe" },
  { code: "AD", currency: "EUR", region: "Europe" },
  { code: "AT", currency: "EUR", region: "Europe" },
  { code: "BE", currency: "EUR", region: "Europe" },
  { code: "BA", currency: "BAM", region: "Europe" },
  { code: "BG", currency: "BGN", region: "Europe" },
  { code: "HR", currency: "EUR", region: "Europe" },
  { code: "CY", currency: "EUR", region: "Europe" },
  { code: "CZ", currency: "CZK", region: "Europe" },
  { code: "DK", currency: "DKK", region: "Europe" },
  { code: "EE", currency: "EUR", region: "Europe" },
  { code: "FI", currency: "EUR", region: "Europe" },
  { code: "FR", currency: "EUR", region: "Europe" },
  { code: "DE", currency: "EUR", region: "Europe" },
  { code: "GR", currency: "EUR", region: "Europe" },
  { code: "HU", currency: "HUF", region: "Europe" },
  { code: "IS", currency: "ISK", region: "Europe" },
  { code: "IE", currency: "EUR", region: "Europe" },
  { code: "IT", currency: "EUR", region: "Europe" },
  { code: "XK", currency: "EUR", region: "Europe" },
  { code: "LV", currency: "EUR", region: "Europe" },
  { code: "LI", currency: "CHF", region: "Europe" },
  { code: "LT", currency: "EUR", region: "Europe" },
  { code: "LU", currency: "EUR", region: "Europe" },
  { code: "MT", currency: "EUR", region: "Europe" },
  { code: "MD", currency: "MDL", region: "Europe" },
  { code: "MC", currency: "EUR", region: "Europe" },
  { code: "ME", currency: "EUR", region: "Europe" },
  { code: "NL", currency: "EUR", region: "Europe" },
  { code: "MK", currency: "MKD", region: "Europe" },
  { code: "NO", currency: "NOK", region: "Europe" },
  { code: "PL", currency: "PLN", region: "Europe" },
  { code: "PT", currency: "EUR", region: "Europe" },
  { code: "RO", currency: "RON", region: "Europe" },
  { code: "SM", currency: "EUR", region: "Europe" },
  { code: "RS", currency: "RSD", region: "Europe" },
  { code: "SK", currency: "EUR", region: "Europe" },
  { code: "SI", currency: "EUR", region: "Europe" },
  { code: "ES", currency: "EUR", region: "Europe" },
  { code: "SE", currency: "SEK", region: "Europe" },
  { code: "CH", currency: "CHF", region: "Europe" },
  { code: "UA", currency: "UAH", region: "Europe" },
  { code: "GB", currency: "GBP", region: "Europe" },

  // ── Americas (Ecuador/El Salvador dollarized; XCD shared by 6) ─────
  { code: "AG", currency: "XCD", region: "Americas" },
  { code: "AR", currency: "ARS", region: "Americas" },
  { code: "BS", currency: "BSD", region: "Americas" },
  { code: "BB", currency: "BBD", region: "Americas" },
  { code: "BZ", currency: "BZD", region: "Americas" },
  { code: "BO", currency: "BOB", region: "Americas" },
  { code: "BR", currency: "BRL", region: "Americas" },
  { code: "CA", currency: "CAD", region: "Americas" },
  { code: "CL", currency: "CLP", region: "Americas" },
  { code: "CO", currency: "COP", region: "Americas" },
  { code: "CR", currency: "CRC", region: "Americas" },
  { code: "DM", currency: "XCD", region: "Americas" },
  { code: "DO", currency: "DOP", region: "Americas" },
  { code: "EC", currency: "USD", region: "Americas" },
  { code: "SV", currency: "USD", region: "Americas" },
  { code: "GD", currency: "XCD", region: "Americas" },
  { code: "GT", currency: "GTQ", region: "Americas" },
  { code: "GY", currency: "GYD", region: "Americas" },
  { code: "HT", currency: "HTG", region: "Americas" },
  { code: "HN", currency: "HNL", region: "Americas" },
  { code: "JM", currency: "JMD", region: "Americas" },
  { code: "MX", currency: "MXN", region: "Americas" },
  { code: "NI", currency: "NIO", region: "Americas" },
  { code: "PA", currency: "USD", region: "Americas" },
  { code: "PY", currency: "PYG", region: "Americas" },
  { code: "PE", currency: "PEN", region: "Americas" },
  { code: "KN", currency: "XCD", region: "Americas" },
  { code: "LC", currency: "XCD", region: "Americas" },
  { code: "VC", currency: "XCD", region: "Americas" },
  { code: "SR", currency: "SRD", region: "Americas" },
  { code: "TT", currency: "TTD", region: "Americas" },
  { code: "US", currency: "USD", region: "Americas" },
  { code: "UY", currency: "UYU", region: "Americas" },
  { code: "VE", currency: "VES", region: "Americas" },

  // ── Africa (XOF shared by 8, XAF shared by 5) ──────────────────────
  { code: "DZ", currency: "DZD", region: "Africa" },
  { code: "AO", currency: "AOA", region: "Africa" },
  { code: "BJ", currency: "XOF", region: "Africa" },
  { code: "BW", currency: "BWP", region: "Africa" },
  { code: "BF", currency: "XOF", region: "Africa" },
  { code: "BI", currency: "BIF", region: "Africa" },
  { code: "CV", currency: "CVE", region: "Africa" },
  { code: "CM", currency: "XAF", region: "Africa" },
  { code: "TD", currency: "XAF", region: "Africa" },
  { code: "KM", currency: "KMF", region: "Africa" },
  { code: "CG", currency: "XAF", region: "Africa" },
  { code: "CD", currency: "CDF", region: "Africa" },
  { code: "CI", currency: "XOF", region: "Africa" },
  { code: "DJ", currency: "DJF", region: "Africa" },
  { code: "EG", currency: "EGP", region: "Africa" },
  { code: "GQ", currency: "XAF", region: "Africa" },
  { code: "SZ", currency: "SZL", region: "Africa" },
  { code: "ET", currency: "ETB", region: "Africa" },
  { code: "GA", currency: "XAF", region: "Africa" },
  { code: "GM", currency: "GMD", region: "Africa" },
  { code: "GH", currency: "GHS", region: "Africa" },
  { code: "GN", currency: "GNF", region: "Africa" },
  { code: "GW", currency: "XOF", region: "Africa" },
  { code: "KE", currency: "KES", region: "Africa" },
  { code: "LS", currency: "LSL", region: "Africa" },
  { code: "LR", currency: "LRD", region: "Africa" },
  { code: "MG", currency: "MGA", region: "Africa" },
  { code: "MW", currency: "MWK", region: "Africa" },
  { code: "ML", currency: "XOF", region: "Africa" },
  { code: "MR", currency: "MRU", region: "Africa" },
  { code: "MU", currency: "MUR", region: "Africa" },
  { code: "MA", currency: "MAD", region: "Africa" },
  { code: "MZ", currency: "MZN", region: "Africa" },
  { code: "NA", currency: "NAD", region: "Africa" },
  { code: "NE", currency: "XOF", region: "Africa" },
  { code: "NG", currency: "NGN", region: "Africa" },
  { code: "RW", currency: "RWF", region: "Africa" },
  { code: "ST", currency: "STN", region: "Africa" },
  { code: "SN", currency: "XOF", region: "Africa" },
  { code: "SC", currency: "SCR", region: "Africa" },
  { code: "SL", currency: "SLE", region: "Africa" },
  { code: "ZA", currency: "ZAR", region: "Africa" },
  { code: "TZ", currency: "TZS", region: "Africa" },
  { code: "TG", currency: "XOF", region: "Africa" },
  { code: "TN", currency: "TND", region: "Africa" },
  { code: "UG", currency: "UGX", region: "Africa" },
  { code: "ZM", currency: "ZMW", region: "Africa" },

  // ── Oceania ─────────────────────────────────────────────────────────
  { code: "AU", currency: "AUD", region: "Oceania" },
  { code: "FJ", currency: "FJD", region: "Oceania" },
  { code: "KI", currency: "AUD", region: "Oceania" },
  { code: "MH", currency: "USD", region: "Oceania" },
  { code: "FM", currency: "USD", region: "Oceania" },
  { code: "NR", currency: "AUD", region: "Oceania" },
  { code: "NZ", currency: "NZD", region: "Oceania" },
  { code: "PW", currency: "USD", region: "Oceania" },
  { code: "PG", currency: "PGK", region: "Oceania" },
  { code: "WS", currency: "WST", region: "Oceania" },
  { code: "SB", currency: "SBD", region: "Oceania" },
  { code: "TO", currency: "TOP", region: "Oceania" },
  { code: "TV", currency: "AUD", region: "Oceania" },
  { code: "VU", currency: "VUV", region: "Oceania" },
];

function resolveName(code: string): string {
  return DISPLAY_NAME_OVERRIDES[code] ?? countries.getName(code, "en") ?? code;
}

function buildCatalog(): TerritoryEntry[] {
  const all = RAW.map(
    (raw): TerritoryEntry => ({
      code: raw.code,
      currency: raw.currency,
      region: raw.region,
      name: resolveName(raw.code),
    }),
  );

  const out: TerritoryEntry[] = [];
  for (const region of TERRITORY_REGIONS) {
    const entries = all
      .filter((t) => t.region === region)
      .sort((a, b) => a.name.localeCompare(b.name));
    out.push(...entries);
  }
  return out;
}

/** Full catalog, grouped by region (in `TERRITORY_REGIONS` order), sorted
 *  alphabetically by name within each region. Computed once at module
 *  load — the underlying data is static for the process lifetime. */
export const TERRITORY_CATALOG: readonly TerritoryEntry[] = buildCatalog();

/** All catalog codes, in catalog order — the dialog's "select all" set. */
export const ALL_TERRITORY_CODES: readonly string[] = TERRITORY_CATALOG.map(
  (t) => t.code,
);

export function currencyForTerritory(code: string): string | null {
  const hit = TERRITORY_CATALOG.find((t) => t.code === code.toUpperCase());
  return hit ? hit.currency : null;
}
