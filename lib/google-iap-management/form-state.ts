/**
 * Pure helpers for converting cached IAP detail rows into the shape the
 * Edit form expects. Lives outside the IapForm "use client" boundary so
 * server-side pages can call this without crossing the client wire.
 */
import { microsToDecimal } from "./google/price-conversion";

export const DEFAULT_LOCALE = "en-US";

export interface FormListing {
  title: string;
  description: string;
}

export interface RegionOverrideRow {
  region: string;
  currency: string;
  priceDecimal: string;
}

export interface IapFormInitial {
  sku: string;
  purchaseType: "managed" | "consumable";
  status: "active" | "inactive";
  defaultLanguage: string;
  listings: Record<string, FormListing>;
  baseCurrency: string;
  basePriceDecimal: string;
  regionOverrides: RegionOverrideRow[];
}

function safeMicrosToDecimal(micros: string | null | undefined): string {
  if (!micros) return "";
  try {
    return microsToDecimal(micros, 2);
  } catch {
    return "0";
  }
}

export function iapDetailToInitial(detail: {
  iap: {
    sku: string;
    purchase_type: string;
    status: string;
    default_currency: string | null;
    default_price_micros: string | null;
  };
  listings: Array<{ locale: string; title: string; description: string }>;
  prices: Array<{ region_code: string; currency: string; price_micros: string }>;
}): IapFormInitial {
  const listings: Record<string, FormListing> = {};
  for (const l of detail.listings) {
    listings[l.locale] = { title: l.title, description: l.description };
  }
  if (!listings[DEFAULT_LOCALE]) {
    listings[DEFAULT_LOCALE] = { title: "", description: "" };
  }
  const regionOverrides: RegionOverrideRow[] = detail.prices.map((p) => ({
    region: p.region_code,
    currency: p.currency,
    priceDecimal: safeMicrosToDecimal(p.price_micros),
  }));
  return {
    sku: detail.iap.sku,
    purchaseType:
      detail.iap.purchase_type === "consumable" ? "consumable" : "managed",
    status: detail.iap.status === "inactive" ? "inactive" : "active",
    defaultLanguage: DEFAULT_LOCALE,
    listings,
    baseCurrency: detail.iap.default_currency ?? "USD",
    basePriceDecimal: safeMicrosToDecimal(detail.iap.default_price_micros),
    regionOverrides,
  };
}
