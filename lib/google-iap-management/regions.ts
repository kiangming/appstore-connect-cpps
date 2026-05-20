/**
 * Common Google Play regions for per-region price overrides (Q-GIAP.G).
 *
 * Google Play's InAppProduct.prices map is keyed by ISO 3166-1 alpha-2
 * country code. The full list is ~150+ countries; v1 surfaces a curated
 * subset matching the Manager's volume (top markets). Add to this list
 * as the Manager's pricing strategy expands.
 *
 * The currency per region is the typical default; Manager can edit if
 * the storefront uses a different one (rare).
 */

export interface RegionEntry {
  code: string; // ISO 3166-1 alpha-2
  name: string;
  currency: string; // ISO 4217
}

export const COMMON_REGIONS: readonly RegionEntry[] = [
  { code: "US", name: "United States", currency: "USD" },
  { code: "GB", name: "United Kingdom", currency: "GBP" },
  { code: "EU", name: "European Union (Euro storefronts)", currency: "EUR" },
  { code: "DE", name: "Germany", currency: "EUR" },
  { code: "FR", name: "France", currency: "EUR" },
  { code: "IT", name: "Italy", currency: "EUR" },
  { code: "ES", name: "Spain", currency: "EUR" },
  { code: "NL", name: "Netherlands", currency: "EUR" },
  { code: "JP", name: "Japan", currency: "JPY" },
  { code: "KR", name: "South Korea", currency: "KRW" },
  { code: "CN", name: "China", currency: "CNY" },
  { code: "TW", name: "Taiwan", currency: "TWD" },
  { code: "HK", name: "Hong Kong", currency: "HKD" },
  { code: "IN", name: "India", currency: "INR" },
  { code: "ID", name: "Indonesia", currency: "IDR" },
  { code: "TH", name: "Thailand", currency: "THB" },
  { code: "VN", name: "Vietnam", currency: "VND" },
  { code: "PH", name: "Philippines", currency: "PHP" },
  { code: "SG", name: "Singapore", currency: "SGD" },
  { code: "MY", name: "Malaysia", currency: "MYR" },
  { code: "AU", name: "Australia", currency: "AUD" },
  { code: "NZ", name: "New Zealand", currency: "NZD" },
  { code: "CA", name: "Canada", currency: "CAD" },
  { code: "MX", name: "Mexico", currency: "MXN" },
  { code: "BR", name: "Brazil", currency: "BRL" },
  { code: "AR", name: "Argentina", currency: "ARS" },
  { code: "RU", name: "Russia", currency: "RUB" },
  { code: "TR", name: "Turkey", currency: "TRY" },
  { code: "SA", name: "Saudi Arabia", currency: "SAR" },
  { code: "AE", name: "UAE", currency: "AED" },
] as const;

export const COMMON_CURRENCIES: readonly string[] = Array.from(
  new Set(COMMON_REGIONS.map((r) => r.currency)),
).sort();

export function defaultCurrencyForRegion(code: string): string {
  return COMMON_REGIONS.find((r) => r.code === code)?.currency ?? "USD";
}
