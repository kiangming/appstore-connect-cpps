/**
 * SC1 diagnostic — GUARD THE CLASS, NOT THE INSTANCE.
 *
 * The v3 OneTimeProduct schema has no base-price field. `defaultPrice`
 * reaches Google only by being stamped onto the US region config, and that
 * stamp is skipped whenever `prices` already carries US. When the two
 * disagree, the caller's base price is simply absent from the write and
 * Google returns 200 having changed nothing.
 *
 * `defaultPriceShadowed` is the structural signal for that, exposed on the
 * write shape (adapter stays pure) and logged at BOTH write call sites in
 * publisher-client.ts — patch AND insert — because the shape is a property
 * of the schema, not of one code path.
 */
// @vitest-environment node
import { describe, it, expect } from "vitest";

import {
  inAppProductToOneTimeProduct,
  type ToolInAppProduct,
} from "./onetime-product-adapter";

function iap(overrides: Partial<ToolInAppProduct> = {}): ToolInAppProduct {
  return {
    packageName: "com.example.app",
    sku: "sku.a",
    status: "active",
    defaultLanguage: "en-US",
    defaultPrice: { currency: "USD", priceMicros: "2990000" },
    prices: { US: { currency: "USD", priceMicros: "1990000" } },
    listings: { "en-US": { title: "T", description: "D" } },
    ...overrides,
  };
}

describe("defaultPriceShadowed", () => {
  it("fires when the base price disagrees with the US config that shadowed it", () => {
    const shape = inAppProductToOneTimeProduct(iap());
    expect(shape.defaultPriceShadowed).toBe(true);

    // …and proves the base price really is absent from the body.
    const configs =
      shape.product.purchaseOptions![0].regionalPricingAndAvailabilityConfigs!;
    const us = configs.find((c) => c.regionCode === "US")!;
    expect(us.price).toEqual({ currencyCode: "USD", units: "1", nanos: 990_000_000 });
  });

  it("stays quiet when the US config carries the same value — nothing is lost", () => {
    const shape = inAppProductToOneTimeProduct(
      iap({ prices: { US: { currency: "USD", priceMicros: "2990000" } } }),
    );
    expect(shape.defaultPriceShadowed).toBe(false);
  });

  it("stays quiet when there is no US config — defaultPrice is stamped, so it lands", () => {
    const shape = inAppProductToOneTimeProduct(
      iap({ prices: { VN: { currency: "VND", priceMicros: "49000000000" } } }),
    );
    expect(shape.defaultPriceShadowed).toBe(false);
    const codes = shape.product
      .purchaseOptions![0].regionalPricingAndAvailabilityConfigs!.map((c) => c.regionCode)
      .sort();
    expect(codes).toEqual(["US", "VN"]);
  });

  it("fires on a currency mismatch even when the amount matches", () => {
    const shape = inAppProductToOneTimeProduct(
      iap({
        defaultPrice: { currency: "EUR", priceMicros: "1990000" },
        prices: { US: { currency: "USD", priceMicros: "1990000" } },
      }),
    );
    expect(shape.defaultPriceShadowed).toBe(true);
  });

  it("applies on the UPDATE (existing purchase options) branch too", () => {
    const shape = inAppProductToOneTimeProduct(iap(), [
      {
        purchaseOptionId: "legacy-base",
        buyOption: { legacyCompatible: true },
        state: "ACTIVE",
        regionalPricingAndAvailabilityConfigs: [],
      },
    ]);
    expect(shape.purchaseOptionId).toBe("legacy-base");
    expect(shape.defaultPriceShadowed).toBe(true);
  });
});
