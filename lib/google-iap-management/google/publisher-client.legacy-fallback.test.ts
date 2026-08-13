/**
 * The LEGACY fallback body must carry the app's currency (SC3b follow-up).
 *
 * Legacy `inappproducts.*` enforces defaultPrice.currency == the app's
 * configured currency. Until SC3b that held by accident — the Edit form's base
 * currency was always seeded from cache, i.e. the app's currency. SC3b lets a
 * tier set the base to USD on a non-USD app, so the fallback would have failed
 * with a currency error WE introduced, exactly when a Manager is diagnosing why
 * the v3 write failed.
 *
 * The amount is taken from the body's own prices map, never relabelled: calling
 * {USD, 4990000} "VND" would send ₫4.99 for a $4.99 product.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getProductSpy, patchSpy, batchActivateSpy, legacyPatchSpy, logSpy } =
  vi.hoisted(() => ({
    getProductSpy: vi.fn(),
    patchSpy: vi.fn(),
    batchActivateSpy: vi.fn(),
    legacyPatchSpy: vi.fn(),
    logSpy: vi.fn(),
  }));

vi.mock("googleapis", () => ({
  google: {
    androidpublisher: () => ({
      monetization: {
        onetimeproducts: {
          get: getProductSpy,
          patch: patchSpy,
          purchaseOptions: { batchUpdateStates: batchActivateSpy },
        },
      },
      inappproducts: { patch: legacyPatchSpy },
    }),
  },
}));
vi.mock("./logging", () => ({ logPublisherCall: logSpy }));
vi.mock("google-auth-library", () => ({ JWT: class {} }));

import { patchInAppProduct } from "./publisher-client";
import type { InAppProduct } from "./publisher-client";

const jwt = {} as never;
const PKG = "com.example.app";
const SKU = "gem_pack";

/** A VND-configured app, edited under a tier whose base is USD (SC3b). */
function bodyWithUsdBase(): InAppProduct {
  return {
    sku: SKU,
    status: "active",
    purchaseType: "managedUser",
    defaultLanguage: "en-US",
    defaultPrice: { currency: "USD", priceMicros: "4990000" },
    prices: {
      US: { currency: "USD", priceMicros: "4990000" },
      VN: { currency: "VND", priceMicros: "119000000000" },
    },
    listings: { "en-US": { title: "Gems", description: "d" } },
  };
}

function liveProduct() {
  return {
    data: {
      productId: SKU,
      packageName: PKG,
      purchaseOptions: [
        {
          purchaseOptionId: "legacy-base",
          buyOption: { legacyCompatible: true },
          state: "ACTIVE",
          regionalPricingAndAvailabilityConfigs: [],
        },
      ],
      listings: [{ languageCode: "en-US", title: "Gems", description: "d" }],
    },
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const s of [getProductSpy, patchSpy, batchActivateSpy, legacyPatchSpy, logSpy]) {
    s.mockReset();
  }
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warnSpy.mockRestore());

function legacyBodySent(): InAppProduct {
  expect(legacyPatchSpy).toHaveBeenCalledTimes(1);
  return legacyPatchSpy.mock.calls[0][0].requestBody as InAppProduct;
}

describe("legacy fallback body — defaultPrice currency", () => {
  it("v3 fails on a VND app with a USD base → legacy gets the app's currency AND its amount", async () => {
    getProductSpy.mockRejectedValue(new Error("v3 down"));
    legacyPatchSpy.mockResolvedValue({ data: { sku: SKU } });

    await patchInAppProduct(jwt, PKG, SKU, bodyWithUsdBase(), {
      appCurrency: "VND",
    });

    // The amount comes from the body's own VN entry — not a relabelled 4.99.
    expect(legacyBodySent().defaultPrice).toEqual({
      currency: "VND",
      priceMicros: "119000000000",
    });
  });

  it("v3 SUCCEEDS → nothing changes; the legacy path is never touched", async () => {
    getProductSpy.mockResolvedValue(liveProduct());
    patchSpy.mockResolvedValue(liveProduct());
    batchActivateSpy.mockResolvedValue({ data: {} });

    await patchInAppProduct(jwt, PKG, SKU, bodyWithUsdBase(), {
      appCurrency: "VND",
    });

    expect(legacyPatchSpy).not.toHaveBeenCalled();
    // And the v3 body still carries whatever the orchestrator built.
    expect(patchSpy).toHaveBeenCalledTimes(1);
  });

  it("base already in the app's currency → body passes through untouched", async () => {
    getProductSpy.mockRejectedValue(new Error("v3 down"));
    legacyPatchSpy.mockResolvedValue({ data: { sku: SKU } });

    const body = bodyWithUsdBase();
    await patchInAppProduct(jwt, PKG, SKU, body, { appCurrency: "USD" });

    expect(legacyBodySent().defaultPrice).toEqual({
      currency: "USD",
      priceMicros: "4990000",
    });
  });

  it("no app-currency entry to borrow → body untouched, Google gets to reject it", async () => {
    // Never invent a price. A clear 400 from Google beats a made-up amount.
    getProductSpy.mockRejectedValue(new Error("v3 down"));
    legacyPatchSpy.mockResolvedValue({ data: { sku: SKU } });

    const body = bodyWithUsdBase();
    delete body.prices!.VN;
    await patchInAppProduct(jwt, PKG, SKU, body, { appCurrency: "VND" });

    expect(legacyBodySent().defaultPrice).toEqual({
      currency: "USD",
      priceMicros: "4990000",
    });
  });

  it("no appCurrency supplied → body untouched (unchanged behaviour for callers that don't pass it)", async () => {
    getProductSpy.mockRejectedValue(new Error("v3 down"));
    legacyPatchSpy.mockResolvedValue({ data: { sku: SKU } });

    await patchInAppProduct(jwt, PKG, SKU, bodyWithUsdBase());

    expect(legacyBodySent().defaultPrice).toEqual({
      currency: "USD",
      priceMicros: "4990000",
    });
  });
});
