/**
 * Create-IAP orchestrator — builds a Google Play InAppProduct request body
 * from the Manager's form state and posts via Android Publisher v3
 * inappproducts.insert.
 *
 * Boundary responsibilities (kept inside this module):
 *   - Decimal → micros conversion (Q-GIAP.F)
 *   - Locale → listings map shape
 *   - Region → prices map shape
 *   - Calling the Publisher API
 *   - Writing the cache (top-level + listings + prices)
 *   - Audit-logging IAP_CREATE
 *
 * Errors are tagged so the caller (API route) can return user-friendly
 * messages while preserving the underlying SDK error for logs.
 */
import type { JWT } from "google-auth-library";

import {
  insertInAppProduct,
  type InAppProduct,
} from "../google/publisher-client";
import { decimalToMicros } from "../google/price-conversion";
import { syncIapFromGoogle } from "../repository/iaps";
import { appendAction } from "../repository/actions-log";

export interface LocaleListingInput {
  locale: string;
  title: string;
  description: string;
}

export interface RegionPriceInput {
  region: string;
  currency: string;
  /** Manager-input decimal, e.g. "1.99". */
  priceDecimal: string;
}

export interface CreateIapInput {
  appId: string; // our cache uuid
  packageName: string;
  sku: string;
  purchaseType: "managed" | "consumable";
  status: "active" | "inactive";
  defaultLanguage: string; // e.g. "en-US"
  listings: LocaleListingInput[];
  baseCurrency: string;
  /** Manager-input decimal, e.g. "1.99". */
  basePriceDecimal: string;
  regionOverrides: RegionPriceInput[];
  actorEmail: string | null;
}

export interface CreateIapResult {
  sku: string;
  status: string | null;
}

/**
 * Builds the InAppProduct request body Google expects, then calls the
 * Publisher API and writes the cache. The returned shape mirrors what
 * the UI needs (sku + final status as returned by Google).
 */
export async function createIapOnGoogle(
  jwt: JWT,
  input: CreateIapInput,
): Promise<CreateIapResult> {
  // Build the request body.
  const listings: NonNullable<InAppProduct["listings"]> = {};
  for (const l of input.listings) {
    if (!l.title.trim() && !l.description.trim()) continue;
    listings[l.locale] = {
      title: l.title.trim(),
      description: l.description.trim(),
    };
  }

  if (Object.keys(listings).length === 0) {
    throw new Error("At least one locale must have a title.");
  }
  if (!listings[input.defaultLanguage]) {
    throw new Error(
      `Default locale "${input.defaultLanguage}" must have a title.`,
    );
  }

  // Hotfix 5: pass currency so decimalToMicros enforces precision.
  // VND/JPY/KRW etc. reject fractional values; Google rejects mismatches
  // with "Illegal default price-value" if we let one through.
  const baseMicros = decimalToMicros(input.basePriceDecimal, input.baseCurrency);
  const defaultPrice: NonNullable<InAppProduct["defaultPrice"]> = {
    currency: input.baseCurrency,
    priceMicros: baseMicros,
  };

  const prices: NonNullable<InAppProduct["prices"]> = {};
  for (const r of input.regionOverrides) {
    if (!r.priceDecimal.trim()) continue;
    prices[r.region] = {
      currency: r.currency,
      priceMicros: decimalToMicros(r.priceDecimal, r.currency),
    };
  }

  // Google's API enum mapping. v1: consumable is just a managed product
  // (client-side acknowledgment behavior). Subscriptions are out of scope.
  const purchaseType = "managedUser";

  const body: InAppProduct = {
    packageName: input.packageName,
    sku: input.sku,
    status: input.status,
    purchaseType,
    defaultLanguage: input.defaultLanguage,
    defaultPrice,
    listings,
    ...(Object.keys(prices).length > 0 ? { prices } : {}),
  };

  const created = await insertInAppProduct(jwt, input.packageName, body);

  // Sync the cache from the response (Google may have normalized fields
  // — currency casing, etc).
  await syncIapFromGoogle(input.appId, created);

  await appendAction({
    actionType: "IAP_CREATE",
    actorEmail: input.actorEmail,
    targetId: input.appId,
    payload: {
      package_name: input.packageName,
      sku: input.sku,
      status: input.status,
      base_currency: input.baseCurrency,
      base_price_decimal: input.basePriceDecimal,
      locale_count: Object.keys(listings).length,
      region_overrides: Object.keys(prices).length,
    },
  });

  return {
    sku: created.sku ?? input.sku,
    status: created.status ?? input.status,
  };
}
