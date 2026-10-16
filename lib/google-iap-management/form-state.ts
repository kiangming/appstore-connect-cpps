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
  /**
   * SC2 — DIRTY TRACKING. True only when the Manager typed into THIS row in
   * THIS editing session.
   *
   * This is the single piece of information the whole cycle was missing. The
   * Edit form preloads every cached region as an "override", so by the time a
   * payload reaches the server, the Manager's actual intent and a passive
   * cache echo are indistinguishable — and the merge then preserved the
   * echoes over the Manager's change. That is the inverted merge.
   *
   * NEVER infer this by comparing against the cache. A value that differs
   * from cache may simply mean the cache is stale; a value equal to cache may
   * still have been typed deliberately. Dirty is a record of an ACTION, not a
   * comparison of values.
   *
   * Absent/false = safe to re-derive (see override-merge.ts for the precise
   * rule on when re-derive is allowed to overwrite it).
   */
  dirty?: boolean;
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

/**
 * The app's currency / language as PRE-FILL for the single Create / Edit form
 * (Hotfix 4). D9 [arc-google-missing-purchase-options]: these are no longer
 * captured by any refresh — the Manager declares them on the app page — and a
 * value here may still be a pre-2026-10-16 tool guess (provenance is not
 * carried into this form; bulk import reads it through its gate). Both are
 * null for an app never declared; callers fall back to USD / en-US.
 */
export interface AppDefaults {
  currency: string | null;
  language: string | null;
}

function safeMicrosToDecimal(micros: string | null | undefined): string {
  if (!micros) return "";
  try {
    return microsToDecimal(micros, 2);
  } catch {
    return "0";
  }
}

export function iapDetailToInitial(
  detail: {
    iap: {
      sku: string;
      purchase_type: string;
      status: string;
      default_currency: string | null;
      default_price_micros: string | null;
    };
    listings: Array<{ locale: string; title: string; description: string }>;
    prices: Array<{ region_code: string; currency: string; price_micros: string }>;
  },
  appDefaults: AppDefaults | null = null,
): IapFormInitial {
  const listings: Record<string, FormListing> = {};
  for (const l of detail.listings) {
    listings[l.locale] = { title: l.title, description: l.description };
  }
  const fallbackLocale = appDefaults?.language ?? DEFAULT_LOCALE;
  if (!listings[fallbackLocale]) {
    listings[fallbackLocale] = { title: "", description: "" };
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
    defaultLanguage: appDefaults?.language ?? DEFAULT_LOCALE,
    listings,
    baseCurrency:
      detail.iap.default_currency ?? appDefaults?.currency ?? "USD",
    basePriceDecimal: safeMicrosToDecimal(detail.iap.default_price_micros),
    regionOverrides,
  };
}
