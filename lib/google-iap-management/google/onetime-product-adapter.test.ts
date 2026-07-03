import { describe, it, expect } from "vitest";

import {
  oneTimeProductToInAppProduct,
  inAppProductToOneTimeProduct,
  pickTargetPurchaseOption,
  DEFAULT_PURCHASE_OPTION_ID,
  type OneTimeProduct,
  type OneTimeProductPurchaseOption,
  type ToolInAppProduct,
} from "./onetime-product-adapter";

const sampleOneTimeProduct: OneTimeProduct = {
  packageName: "com.example.app",
  productId: "gem_pack_small",
  listings: [
    { languageCode: "en-US", title: "Small Pack", description: "200 gems" },
    { languageCode: "vi", title: "Goi Nho", description: "200 vien" },
  ],
  purchaseOptions: [
    {
      purchaseOptionId: "buy",
      state: "ACTIVE",
      buyOption: { legacyCompatible: true },
      regionalPricingAndAvailabilityConfigs: [
        {
          regionCode: "US",
          price: { currencyCode: "USD", units: "1", nanos: 990_000_000 },
          availability: "AVAILABLE",
        },
        {
          regionCode: "VN",
          price: { currencyCode: "VND", units: "25000", nanos: 0 },
          availability: "AVAILABLE",
        },
      ],
    },
  ],
};

describe("oneTimeProductToInAppProduct (READ side)", () => {
  it("maps a happy-path active product into legacy shape", () => {
    const result = oneTimeProductToInAppProduct(sampleOneTimeProduct);
    expect(result.sku).toBe("gem_pack_small");
    expect(result.packageName).toBe("com.example.app");
    expect(result.status).toBe("active");
    expect(result.purchaseType).toBe("managed");
    expect(result.defaultLanguage).toBe("en-US");
    expect(result.defaultPrice).toEqual({
      currency: "USD",
      priceMicros: "1990000",
    });
    expect(result.prices).toEqual({
      US: { currency: "USD", priceMicros: "1990000" },
      VN: { currency: "VND", priceMicros: "25000000000" },
    });
    expect(result.listings).toEqual({
      "en-US": { title: "Small Pack", description: "200 gems" },
      vi: { title: "Goi Nho", description: "200 vien" },
    });
  });

  it("maps INACTIVE state to 'inactive' status", () => {
    const inactive = JSON.parse(JSON.stringify(sampleOneTimeProduct)) as OneTimeProduct;
    inactive.purchaseOptions![0].state = "INACTIVE";
    expect(oneTimeProductToInAppProduct(inactive).status).toBe("inactive");
  });

  it("treats DRAFT and STATE_UNSPECIFIED as 'inactive'", () => {
    const draft = JSON.parse(JSON.stringify(sampleOneTimeProduct)) as OneTimeProduct;
    draft.purchaseOptions![0].state = "DRAFT";
    expect(oneTimeProductToInAppProduct(draft).status).toBe("inactive");
  });

  it("maps INACTIVE_PUBLISHED to 'active' (legacy-billing-library compat)", () => {
    const p = JSON.parse(JSON.stringify(sampleOneTimeProduct)) as OneTimeProduct;
    p.purchaseOptions![0].state = "INACTIVE_PUBLISHED";
    expect(oneTimeProductToInAppProduct(p).status).toBe("active");
  });

  it("falls back to first config when no US regional pricing present", () => {
    const p = JSON.parse(JSON.stringify(sampleOneTimeProduct)) as OneTimeProduct;
    p.purchaseOptions![0].regionalPricingAndAvailabilityConfigs = [
      {
        regionCode: "VN",
        price: { currencyCode: "VND", units: "25000", nanos: 0 },
        availability: "AVAILABLE",
      },
      {
        regionCode: "JP",
        price: { currencyCode: "JPY", units: "300", nanos: 0 },
        availability: "AVAILABLE",
      },
    ];
    const out = oneTimeProductToInAppProduct(p);
    expect(out.defaultPrice).toEqual({
      currency: "VND",
      priceMicros: "25000000000",
    });
  });

  it("prefers a buyOption purchaseOption over a rentOption", () => {
    const p: OneTimeProduct = {
      ...sampleOneTimeProduct,
      purchaseOptions: [
        {
          purchaseOptionId: "rent",
          state: "INACTIVE",
          rentOption: { rentalPeriod: "P7D" },
          regionalPricingAndAvailabilityConfigs: [],
        },
        {
          purchaseOptionId: "buy",
          state: "ACTIVE",
          buyOption: { legacyCompatible: true },
          regionalPricingAndAvailabilityConfigs: [
            {
              regionCode: "US",
              price: { currencyCode: "USD", units: "1", nanos: 990_000_000 },
              availability: "AVAILABLE",
            },
          ],
        },
      ],
    };
    const out = oneTimeProductToInAppProduct(p);
    expect(out.status).toBe("active"); // from buy option, not rent
    expect(out.defaultPrice).toEqual({ currency: "USD", priceMicros: "1990000" });
  });

  it("handles a product with no purchase options gracefully (inactive)", () => {
    const p: OneTimeProduct = {
      packageName: "com.example.app",
      productId: "empty",
      listings: [{ languageCode: "en-US", title: "Empty", description: "" }],
      purchaseOptions: [],
    };
    const out = oneTimeProductToInAppProduct(p);
    expect(out.status).toBe("inactive");
    expect(out.defaultPrice).toBeNull();
    expect(out.prices).toBeNull();
  });

  it("falls back to 'en-US' when listings array is empty", () => {
    const p: OneTimeProduct = {
      packageName: "com.example.app",
      productId: "x",
      listings: [],
      purchaseOptions: [],
    };
    expect(oneTimeProductToInAppProduct(p).defaultLanguage).toBe("en-US");
  });
});

describe("inAppProductToOneTimeProduct (WRITE side)", () => {
  const sampleIap: ToolInAppProduct = {
    packageName: "com.example.app",
    sku: "gem_pack_small",
    status: "active",
    purchaseType: "managed",
    defaultLanguage: "en-US",
    defaultPrice: { currency: "USD", priceMicros: "1990000" },
    prices: {
      VN: { currency: "VND", priceMicros: "25000000000" },
    },
    listings: {
      "en-US": { title: "Small Pack", description: "200 gems" },
      vi: { title: "Goi Nho", description: "200 vien" },
    },
  };

  it("builds a OneTimeProduct with a single buy purchase option", () => {
    const out = inAppProductToOneTimeProduct(sampleIap);
    expect(out.product.productId).toBe("gem_pack_small");
    expect(out.product.packageName).toBe("com.example.app");
    expect(out.product.listings).toHaveLength(2);
    expect(out.product.purchaseOptions).toHaveLength(1);
    expect(out.product.purchaseOptions![0].purchaseOptionId).toBe(
      DEFAULT_PURCHASE_OPTION_ID,
    );
    expect(out.product.purchaseOptions![0].buyOption).toBeDefined();
    expect(out.desiredState).toBe("ACTIVE");
    expect(out.purchaseOptionId).toBe(DEFAULT_PURCHASE_OPTION_ID);
  });

  it("synthesises a US regional config from defaultPrice when prices map has no US entry", () => {
    const out = inAppProductToOneTimeProduct(sampleIap);
    const configs = out.product.purchaseOptions![0]
      .regionalPricingAndAvailabilityConfigs!;
    const regionCodes = configs.map((c) => c.regionCode);
    expect(regionCodes).toEqual(expect.arrayContaining(["US", "VN"]));
    const us = configs.find((c) => c.regionCode === "US")!;
    expect(us.price).toEqual({
      currencyCode: "USD",
      units: "1",
      nanos: 990_000_000,
    });
  });

  it("preserves explicit prices map entry over defaultPrice for the same region", () => {
    const iap: ToolInAppProduct = {
      ...sampleIap,
      defaultPrice: { currency: "USD", priceMicros: "1990000" },
      prices: {
        US: { currency: "USD", priceMicros: "990000" }, // 0.99 wins
      },
    };
    const out = inAppProductToOneTimeProduct(iap);
    const configs = out.product.purchaseOptions![0]
      .regionalPricingAndAvailabilityConfigs!;
    expect(configs).toHaveLength(1);
    expect(configs[0].regionCode).toBe("US");
    expect(configs[0].price?.nanos).toBe(990_000_000);
    expect(configs[0].price?.units).toBe("0");
  });

  it("maps inactive status to INACTIVE desiredState", () => {
    const out = inAppProductToOneTimeProduct({ ...sampleIap, status: "inactive" });
    expect(out.desiredState).toBe("INACTIVE");
  });

  it("filters empty / whitespace-only listings", () => {
    const iap: ToolInAppProduct = {
      ...sampleIap,
      listings: {
        "en-US": { title: "Pack", description: "" },
        vi: { title: "", description: "" }, // dropped
        ja: { title: "パック", description: "200 ジェム" },
      },
    };
    const out = inAppProductToOneTimeProduct(iap);
    const codes = out.product.listings!.map((l) => l.languageCode).sort();
    expect(codes).toEqual(["en-US", "ja"]);
  });

  it("throws when sku is missing", () => {
    expect(() =>
      inAppProductToOneTimeProduct({ ...sampleIap, sku: undefined }),
    ).toThrow(/sku/);
  });

  it("throws when packageName is missing", () => {
    expect(() =>
      inAppProductToOneTimeProduct({ ...sampleIap, packageName: undefined }),
    ).toThrow(/packageName/);
  });
});

describe("bidirectional round-trip", () => {
  it("preserves listings + active status + multi-region prices through OTP → IAP → OTP", () => {
    const iap = oneTimeProductToInAppProduct(sampleOneTimeProduct);
    const writeShape = inAppProductToOneTimeProduct(iap);
    // listings count matches
    expect(writeShape.product.listings).toHaveLength(2);
    // regional pricing count matches (the adapter doesn't duplicate US
    // since it's already in `prices`)
    const configs =
      writeShape.product.purchaseOptions![0]
        .regionalPricingAndAvailabilityConfigs!;
    const regionCodes = configs.map((c) => c.regionCode).sort();
    expect(regionCodes).toEqual(["US", "VN"]);
    // state preserved
    expect(writeShape.desiredState).toBe("ACTIVE");
  });
});

describe("pickTargetPurchaseOption — target selection for RMW", () => {
  const opt = (id: string, flags: Partial<OneTimeProductPurchaseOption> = {}): OneTimeProductPurchaseOption => ({
    purchaseOptionId: id,
    ...flags,
  });

  it("prefers legacyCompatible buyOption (the 'legacy-base' case)", () => {
    const options = [
      opt("other", { rentOption: {} }),
      opt("legacy-base", { buyOption: { legacyCompatible: true } }),
    ];
    expect(pickTargetPurchaseOption(options)?.purchaseOptionId).toBe("legacy-base");
  });

  it("falls back to any buyOption when no legacyCompatible one exists", () => {
    const options = [
      opt("rent1", { rentOption: {} }),
      opt("buy1", { buyOption: { legacyCompatible: false } }),
    ];
    expect(pickTargetPurchaseOption(options)?.purchaseOptionId).toBe("buy1");
  });

  it("falls back to first option when no buyOption at all", () => {
    const options = [opt("first", { rentOption: {} }), opt("second", { rentOption: {} })];
    expect(pickTargetPurchaseOption(options)?.purchaseOptionId).toBe("first");
  });

  it("returns null for empty array", () => {
    expect(pickTargetPurchaseOption([])).toBeNull();
  });
});

describe("inAppProductToOneTimeProduct — RMW path (existingPurchaseOptions)", () => {
  const base: ToolInAppProduct = {
    sku: "sku.a",
    packageName: "com.example.app",
    status: "active",
    prices: { US: { currency: "USD", priceMicros: "1990000" } },
    listings: { "en-US": { title: "T", description: "D" } },
  };

  it("uses 'legacy-base' as purchaseOptionId (not 'buy') when live option is legacy-base", () => {
    const existing: OneTimeProductPurchaseOption[] = [
      { purchaseOptionId: "legacy-base", buyOption: { legacyCompatible: true } },
    ];
    const shape = inAppProductToOneTimeProduct(base, existing);
    expect(shape.purchaseOptionId).toBe("legacy-base");
    expect(shape.product.purchaseOptions).toHaveLength(1);
    expect(shape.product.purchaseOptions![0].purchaseOptionId).toBe("legacy-base");
  });

  it("preserves ALL options, updating only the target's pricing", () => {
    const existing: OneTimeProductPurchaseOption[] = [
      {
        purchaseOptionId: "legacy-base",
        buyOption: { legacyCompatible: true },
        regionalPricingAndAvailabilityConfigs: [{ regionCode: "OLD", availability: "AVAILABLE" }],
      },
      { purchaseOptionId: "extra", rentOption: {} },
    ];
    const shape = inAppProductToOneTimeProduct(base, existing);
    const ids = shape.product.purchaseOptions!.map((o) => o.purchaseOptionId).sort();
    expect(ids).toEqual(["extra", "legacy-base"]);

    const target = shape.product.purchaseOptions!.find((o) => o.purchaseOptionId === "legacy-base")!;
    // Pricing updated (no OLD region).
    expect(target.regionalPricingAndAvailabilityConfigs?.some((c) => c.regionCode === "OLD")).toBe(false);
    expect(target.regionalPricingAndAvailabilityConfigs?.some((c) => c.regionCode === "US")).toBe(true);

    const extra = shape.product.purchaseOptions!.find((o) => o.purchaseOptionId === "extra")!;
    // Non-target preserved unchanged.
    expect(extra.rentOption).toBeDefined();
  });

  it("create path (no existingPurchaseOptions): single 'buy' option", () => {
    const shape = inAppProductToOneTimeProduct(base);
    expect(shape.purchaseOptionId).toBe(DEFAULT_PURCHASE_OPTION_ID);
    expect(shape.product.purchaseOptions).toHaveLength(1);
    expect(shape.product.purchaseOptions![0].purchaseOptionId).toBe("buy");
    expect(shape.product.purchaseOptions![0].buyOption?.legacyCompatible).toBe(true);
  });
});
