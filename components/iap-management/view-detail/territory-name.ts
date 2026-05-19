/**
 * IAP.p2.l — territory-code → display-name resolver.
 *
 * Apple returns 3-letter ISO 3166-1 alpha-3 codes (USA, VNM, JPN, KHM, …).
 * Pre-p2.l we hand-curated an 18-entry dictionary which left many SEA +
 * smaller-economy codes unmapped (Manager flagged HKG, MAC, MMR, KHM in
 * MV30 UAT). The fix wires the `i18n-iso-countries` package as the
 * baseline (full ISO 3166 alpha-3 → English name coverage) and layers a
 * small Apple-Connect override map on top for the few cases where
 * Apple's official display label diverges from the ISO standard.
 *
 * Order of resolution per call:
 *   1. Apple-Connect override map (handles "China mainland", etc.)
 *   2. i18n-iso-countries getName(code, "en")
 *   3. Raw code fallback (defensive — should rarely fire)
 */
import countries from "i18n-iso-countries";
// eslint-disable-next-line @typescript-eslint/no-var-requires -- JSON locale data loaded at module init
import enLocale from "i18n-iso-countries/langs/en.json";

countries.registerLocale(enLocale);

/**
 * Apple-Connect-specific display labels that differ from the ISO standard.
 * Keep this map small — every entry is a deliberate divergence from the
 * upstream package, not a routine country name. Each line is a known
 * difference between the ISO 3166-1 official name and the label App
 * Store Connect renders in its pricing UI.
 */
const APPLE_OVERRIDES: Record<string, string> = {
  USA: "United States",                  // ISO: "United States of America"
  CHN: "China mainland",                 // ISO: "People's Republic of China" — Apple labels mainland separately from HK/MAC/TWN
  TWN: "Taiwan",                         // ISO: "Taiwan, Province of China" — Apple uses short form
  MAC: "Macau",                          // ISO: "Macao" — Apple uses the Portuguese-influenced spelling (confirmed in Manager's UAT screenshot)
  RUS: "Russia",                         // ISO: "Russian Federation"
  IRN: "Iran",                           // ISO: "Islamic Republic of Iran"
  LAO: "Laos",                           // ISO: "Lao People's Democratic Republic"
};

export function territoryName(code: string): string {
  if (APPLE_OVERRIDES[code]) return APPLE_OVERRIDES[code];
  const name = countries.getName(code, "en", { select: "official" });
  return name ?? code;
}
