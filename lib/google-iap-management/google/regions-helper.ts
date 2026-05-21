/**
 * Regions bootstrap helper for Hotfix 8 Phase 2 (WRITE migration).
 *
 * The new Monetization API rejects products that don't carry a price
 * for every region the app is published in:
 *
 *   "Must provide a price for each region the app has been published in"
 *
 * Legacy `inappproducts.insert` accepted a sparse `prices` map +
 * top-level `defaultPrice` and Google auto-equalised the missing
 * regions server-side. The new API has removed that convenience —
 * regional pricing is explicit per purchase option.
 *
 * `monetization.convertRegionPrices` is Google's own canonical way to
 * convert a single base price into prices for every supported region
 * using today's exchange rates and country-specific patterns. We use
 * it to bootstrap a comprehensive regional map at write time. Manager-
 * supplied per-region overrides win over the converted result.
 *
 * Cost: one extra API call per write that needs regions expansion.
 * Acceptable — Manager's create / edit volume is low (single-digits
 * per session).
 *
 * Failure handling: if `convertRegionPrices` itself fails, the caller
 * falls back to sending only Manager's explicit prices. Google may
 * then reject with the "must provide a price" error and the Manager
 * gets a clear message — better than a silent half-broken state.
 */
import type { JWT } from "google-auth-library";

import {
  convertRegionPrices as rawConvertRegionPrices,
  type ConvertRegionPricesRequest,
} from "./publisher-client";
import { microsToMoney, moneyToMicros } from "./price-conversion";

export interface RegionPriceMicros {
  region: string;
  currency: string;
  priceMicros: string;
}

/**
 * Call Google's `monetization.convertRegionPrices` with a single base
 * price + currency, then convert the response's Money values back to
 * the tool's internal micros shape.
 *
 * The base region is included in the result (Google echoes it back in
 * the converted map with the same currency).
 */
export async function buildRegionMapFromBasePrice(
  jwt: JWT,
  packageName: string,
  basePriceMicros: string,
  baseCurrency: string,
): Promise<RegionPriceMicros[]> {
  const request: ConvertRegionPricesRequest = {
    price: microsToMoney(basePriceMicros, baseCurrency),
  };
  const res = await rawConvertRegionPrices(jwt, packageName, request);
  const map = res.convertedRegionPrices ?? {};
  const out: RegionPriceMicros[] = [];
  for (const [regionCode, entry] of Object.entries(map)) {
    if (!entry?.price) continue;
    const currency = entry.price.currencyCode;
    if (!currency) continue;
    out.push({
      region: regionCode,
      currency,
      priceMicros: moneyToMicros(entry.price),
    });
  }
  out.sort((a, b) => a.region.localeCompare(b.region));
  return out;
}

/**
 * Merge an auto-converted region map with Manager-supplied explicit
 * region overrides. Explicit overrides win on duplicate keys —
 * Manager's intent always beats the auto-calculation.
 *
 * Both inputs use the tool's internal micros shape; output is the
 * union of regions (the auto-converted set is typically a superset,
 * but Manager can target a region the converter didn't return).
 */
export function mergeRegionMaps(
  auto: RegionPriceMicros[],
  explicit: RegionPriceMicros[],
): RegionPriceMicros[] {
  const merged = new Map<string, RegionPriceMicros>();
  for (const entry of auto) merged.set(entry.region, entry);
  for (const entry of explicit) merged.set(entry.region, entry);
  return [...merged.values()].sort((a, b) =>
    a.region.localeCompare(b.region),
  );
}
