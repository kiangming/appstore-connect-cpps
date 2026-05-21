/**
 * Adapter between Google's Monetization API v3 OneTimeProduct schema and
 * the tool's internal InAppProduct shape (Hotfix 8).
 *
 * Background — Google is rolling out a new publishing API to replace the
 * legacy `androidpublisher.inappproducts.*` resource. Some apps return
 * 403 "Please migrate to the new publishing API." when called via the
 * legacy endpoint; others still return data. The strategic target is
 * `androidpublisher.monetization.onetimeproducts.*`.
 *
 * Schema differences are non-trivial — this isn't a rename:
 *
 *   Legacy InAppProduct                ↔  OneTimeProduct
 *   ────────────────────────────────────────────────────────────────────
 *   sku                                ↔  productId
 *   status (active/inactive)           ↔  purchaseOptions[i].state
 *                                          (ACTIVE/INACTIVE/DRAFT/...)
 *                                          NOTE: state is read-only on
 *                                          the product; set via separate
 *                                          purchaseOptions:batchUpdateStates
 *   purchaseType                       ↔  purchaseOptions[i].buyOption
 *                                          vs rentOption (presence)
 *   defaultLanguage                    ↔  (no equivalent — listings carry
 *                                          languageCode per entry)
 *   defaultPrice { currency, micros }  ↔  no top-level default. Pricing
 *                                          lives in
 *                                          purchaseOptions[i]
 *                                            .regionalPricingAndAvailability
 *                                            Configs[].price (Money shape)
 *   prices { regionCode → { ... } }    ↔  same source — single array
 *                                          carries ALL regions, including
 *                                          the "default"
 *   listings { locale → { ... } }      ↔  listings[i] { languageCode,
 *                                                       title, description }
 *                                          (was map, now array)
 *
 * Money format: legacy `priceMicros` (string, 1e-6 units) → new
 * `Money { currencyCode, units (int64 string), nanos (int 10^-9) }`.
 * Conversion via lib/google-iap-management/google/price-conversion.ts
 * helpers `microsToMoney` and `moneyToMicros`.
 *
 * This adapter normalises both directions so the rest of the codebase
 * keeps working in InAppProduct terms. The cache schema (google_iap_mgmt.
 * iaps + iap_listings + iap_prices) is unchanged.
 *
 * Multi-purchaseOption products: the new API permits multiple purchase
 * options per product (e.g. buy + rent variants). The tool's v1 model
 * assumes one — this adapter picks the FIRST buyOption (or, if none, the
 * first option overall) and discards the rest. Manager-facing
 * documentation should call this out before multi-option becomes common.
 *
 * Default price/currency derivation on read:
 *   - Prefer US-region config if present (matches Google Play Console's
 *     own default in most catalogues)
 *   - Else first config in the array
 *   - Else null (product with no regional pricing — rare)
 *
 * The default_price_micros + default_currency fields on the cached IAP
 * row are populated from this derivation; the per-region `prices` map
 * carries every regional config including the chosen "default".
 *
 * This file is pure: no I/O, no network, no DB. Easy to unit-test
 * bidirectionally.
 */
import type {
  androidpublisher_v3,
} from "googleapis";

import { microsToMoney, moneyToMicros } from "./price-conversion";

export type OneTimeProduct = androidpublisher_v3.Schema$OneTimeProduct;
export type OneTimeProductListing =
  androidpublisher_v3.Schema$OneTimeProductListing;
export type OneTimeProductPurchaseOption =
  androidpublisher_v3.Schema$OneTimeProductPurchaseOption;
export type Money = androidpublisher_v3.Schema$Money;

// Tool-internal shape. Mirrors the relevant subset of the legacy
// InAppProduct schema the rest of the codebase already consumes.
export interface ToolInAppProduct {
  packageName?: string | null;
  sku?: string | null;
  status?: "active" | "inactive" | null;
  purchaseType?: "managed" | "consumable" | "subscription" | null;
  defaultLanguage?: string | null;
  defaultPrice?: {
    currency: string;
    priceMicros: string;
  } | null;
  prices?: Record<
    string,
    { currency: string; priceMicros: string }
  > | null;
  listings?: Record<
    string,
    { title?: string | null; description?: string | null }
  > | null;
}

/* ──────────────────────────────────────────────────────────────────────
 *  Read path: OneTimeProduct → ToolInAppProduct
 * ──────────────────────────────────────────────────────────────────── */

/** Pick the canonical purchase option for the tool's single-option model.
 *  Prefer a `buyOption` (the v1 IAP shape); fall back to the first
 *  option overall so we don't drop the row entirely if Manager only has
 *  a rentOption. Returns null when the product has no purchase options. */
function pickCanonicalPurchaseOption(
  product: OneTimeProduct,
): OneTimeProductPurchaseOption | null {
  const options = product.purchaseOptions ?? [];
  if (options.length === 0) return null;
  const buy = options.find((o) => o.buyOption);
  return buy ?? options[0];
}

function mapStateToStatus(
  state: string | null | undefined,
): "active" | "inactive" {
  if (state === "ACTIVE" || state === "INACTIVE_PUBLISHED") return "active";
  return "inactive";
}

function pickDefaultPricingConfig(
  option: OneTimeProductPurchaseOption,
): NonNullable<
  OneTimeProductPurchaseOption["regionalPricingAndAvailabilityConfigs"]
>[number] | null {
  const configs = option.regionalPricingAndAvailabilityConfigs ?? [];
  if (configs.length === 0) return null;
  const us = configs.find((c) => c.regionCode === "US");
  return us ?? configs[0];
}

export function oneTimeProductToInAppProduct(
  product: OneTimeProduct,
): ToolInAppProduct {
  const option = pickCanonicalPurchaseOption(product);

  // Listings: array → map keyed by languageCode.
  const listings: NonNullable<ToolInAppProduct["listings"]> = {};
  for (const l of (product.listings ?? []) as OneTimeProductListing[]) {
    if (!l.languageCode) continue;
    listings[l.languageCode] = {
      title: l.title ?? "",
      description: l.description ?? "",
    };
  }

  // Default language: no first-class field on OneTimeProduct. Use the
  // first listing's languageCode; fall back to "en-US" if no listings.
  const defaultLanguage =
    (product.listings ?? [])[0]?.languageCode ?? "en-US";

  // Status + purchaseType from the canonical purchase option.
  const status = option ? mapStateToStatus(option.state) : "inactive";
  // Tool's "managed" / "consumable" distinction isn't expressible in
  // OneTimeProduct's buyOption vs rentOption — buy ≈ managed (v1 default).
  // Subscriptions are a different resource (subscriptions.*) — Q-GIAP.A
  // keeps them deferred.
  const purchaseType: ToolInAppProduct["purchaseType"] = option?.rentOption
    ? "consumable"
    : "managed";

  // Pricing: one regional config per region in the canonical option.
  // Build both `defaultPrice` (US-or-first) and `prices` map (all regions).
  let defaultPrice: ToolInAppProduct["defaultPrice"] = null;
  const prices: NonNullable<ToolInAppProduct["prices"]> = {};
  if (option) {
    const configs = option.regionalPricingAndAvailabilityConfigs ?? [];
    for (const c of configs) {
      if (!c.regionCode || !c.price) continue;
      const currency = c.price.currencyCode ?? "USD";
      const priceMicros = moneyToMicros(c.price);
      prices[c.regionCode] = { currency, priceMicros };
    }
    const def = pickDefaultPricingConfig(option);
    if (def && def.price) {
      defaultPrice = {
        currency: def.price.currencyCode ?? "USD",
        priceMicros: moneyToMicros(def.price),
      };
    }
  }

  return {
    packageName: product.packageName ?? null,
    sku: product.productId ?? null,
    status,
    purchaseType,
    defaultLanguage,
    defaultPrice,
    prices: Object.keys(prices).length > 0 ? prices : null,
    listings: Object.keys(listings).length > 0 ? listings : null,
  };
}

/* ──────────────────────────────────────────────────────────────────────
 *  Write path: ToolInAppProduct → OneTimeProduct (+ desired state)
 * ──────────────────────────────────────────────────────────────────── */

/** Result of write conversion. The OneTimeProduct body goes to
 *  `monetization.onetimeproducts.patch`. The `desiredState` is applied
 *  separately via `purchaseOptions:batchUpdateStates` because the new
 *  API marks `state` as output-only on the product resource. */
export interface OneTimeProductWriteShape {
  product: OneTimeProduct;
  /** ACTIVE | INACTIVE — set via separate batchUpdateStates call after
   *  patch returns. ACTIVE may be a no-op if the product already
   *  defaults to ACTIVE on create. */
  desiredState: "ACTIVE" | "INACTIVE";
  /** Purchase-option id used in the patch body. The state-update call
   *  needs it to target the same option. */
  purchaseOptionId: string;
}

/** Stable purchase-option id for tool-managed products. We use a fixed
 *  string because the tool's single-option model means there's never
 *  more than one option per product, and the new API requires the id
 *  to round-trip on updates. "buy" satisfies the API's id format
 *  constraint (lowercase letters / numbers / hyphens, ≤63 chars). */
export const DEFAULT_PURCHASE_OPTION_ID = "buy";

export function inAppProductToOneTimeProduct(
  iap: ToolInAppProduct,
): OneTimeProductWriteShape {
  if (!iap.sku) {
    throw new Error("ToolInAppProduct.sku is required to build a OneTimeProduct.");
  }
  if (!iap.packageName) {
    throw new Error(
      "ToolInAppProduct.packageName is required to build a OneTimeProduct.",
    );
  }

  // Listings map → array. Empty/whitespace entries are skipped so the
  // patch doesn't ship junk listings.
  const listings: OneTimeProductListing[] = [];
  for (const [languageCode, entry] of Object.entries(iap.listings ?? {})) {
    const title = (entry.title ?? "").trim();
    const description = (entry.description ?? "").trim();
    if (!title && !description) continue;
    listings.push({ languageCode, title, description });
  }

  // Regional pricing: combine `defaultPrice` (treated as a regional
  // override too) with `prices` map. If a region appears in both, the
  // explicit `prices` entry wins.
  const regionalPricing: NonNullable<
    OneTimeProductPurchaseOption["regionalPricingAndAvailabilityConfigs"]
  > = [];

  const regionsSeen = new Set<string>();

  for (const [regionCode, p] of Object.entries(iap.prices ?? {})) {
    if (regionsSeen.has(regionCode)) continue;
    regionsSeen.add(regionCode);
    regionalPricing.push({
      regionCode,
      price: microsToMoney(p.priceMicros, p.currency),
      availability: "AVAILABLE",
    });
  }

  // Stamp a US-region default from `defaultPrice` if no explicit US
  // config exists. This preserves the legacy semantics where Google's
  // auto-equalisation used `defaultPrice` for any unlisted region.
  if (iap.defaultPrice && !regionsSeen.has("US")) {
    regionalPricing.push({
      regionCode: "US",
      price: microsToMoney(iap.defaultPrice.priceMicros, iap.defaultPrice.currency),
      availability: "AVAILABLE",
    });
  }

  const purchaseOption: OneTimeProductPurchaseOption = {
    purchaseOptionId: DEFAULT_PURCHASE_OPTION_ID,
    buyOption: {
      legacyCompatible: true,
    },
    regionalPricingAndAvailabilityConfigs: regionalPricing,
  };

  const product: OneTimeProduct = {
    packageName: iap.packageName,
    productId: iap.sku,
    listings,
    purchaseOptions: [purchaseOption],
  };

  const desiredState: "ACTIVE" | "INACTIVE" =
    iap.status === "inactive" ? "INACTIVE" : "ACTIVE";

  return {
    product,
    desiredState,
    purchaseOptionId: DEFAULT_PURCHASE_OPTION_ID,
  };
}
