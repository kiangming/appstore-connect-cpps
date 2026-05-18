/**
 * IAP.p2.d — minimal territory-code → display-name resolver.
 *
 * Apple returns 3-letter ISO 3166-1 alpha-3 codes (USA, VNM, JPN, …). The
 * mockup only spells out "United States" for the base territory; other
 * rows fall back to the code. A full 175-entry map is out of scope for
 * p2.d — Manager can request expansion if the codes prove unfriendly.
 *
 * Entries here cover the territories most likely to surface in the base
 * row + small per-IAP overrides; everything else uses the raw code.
 */
const TERRITORY_NAMES: Record<string, string> = {
  USA: "United States",
  GBR: "United Kingdom",
  JPN: "Japan",
  VNM: "Vietnam",
  KOR: "South Korea",
  TWN: "Taiwan",
  CHN: "China mainland",
  IND: "India",
  IDN: "Indonesia",
  THA: "Thailand",
  PHL: "Philippines",
  MYS: "Malaysia",
  SGP: "Singapore",
  AUS: "Australia",
  CAN: "Canada",
  DEU: "Germany",
  FRA: "France",
  BRA: "Brazil",
};

export function territoryName(code: string): string {
  return TERRITORY_NAMES[code] ?? code;
}
