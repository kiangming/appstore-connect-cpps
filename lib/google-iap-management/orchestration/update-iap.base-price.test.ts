/**
 * ACCEPTANCE CRITERION for the base-price cycle (SC1).
 *
 * THE GAP THIS CLOSES: before this file, no test in the module asserted the
 * PRICING CONTENT of any PATCH body. publisher-client.patch-rmw.test.ts
 * (:112-195) asserts purchase-option IDs only, so a write that shipped
 * byte-identical pricing to what was already live passed every test, every
 * typecheck and every log line. That is how the silent no-op survived from
 * 44900f8 (2026-05-21) to production report.
 *
 * WHAT IT ASSERTS: a Manager base-price change actually reaches the body sent
 * to `monetization.onetimeproducts.patch`. The v3 OneTimeProduct schema has no
 * base-price field — pricing lives exclusively in
 * purchaseOptions[].regionalPricingAndAvailabilityConfigs — so the ONLY way a
 * base-price change can exist on the wire is as changed regional configs.
 *
 * FIXTURE IS PRODUCTION-SHAPED, NOT CONVENIENT: the Edit form preloads
 * regionOverrides from cache (form-state.ts:74-78), so `regionOverrides` here
 * carries every cached region at its OLD value while only `basePriceDecimal`
 * moves. That is exactly what IapForm.tsx:431-439 sends today.
 *
 * Expected: RED until SC2 re-derives the regions a base price owns.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getProductSpy,
  patchSpy,
  batchActivateSpy,
  convertRegionPricesSpy,
  logSpy,
  syncSpy,
  appendActionSpy,
} = vi.hoisted(() => ({
  getProductSpy: vi.fn(),
  patchSpy: vi.fn(),
  batchActivateSpy: vi.fn(),
  convertRegionPricesSpy: vi.fn(),
  logSpy: vi.fn(),
  syncSpy: vi.fn(),
  appendActionSpy: vi.fn(),
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
        convertRegionPrices: convertRegionPricesSpy,
      },
    }),
  },
}));
vi.mock("../google/logging", () => ({ logPublisherCall: logSpy }));
vi.mock("google-auth-library", () => ({ JWT: class {} }));
vi.mock("../repository/iaps", () => ({ syncIapFromGoogle: syncSpy }));
vi.mock("../repository/actions-log", () => ({ appendAction: appendActionSpy }));

import { updateIapOnGoogle } from "./update-iap";
import type { IapDetail } from "../repository/iaps";
import type { OneTimeProduct } from "../google/onetime-product-adapter";

const jwt = {} as never;
const PKG = "com.example.app";
const SKU = "gem_pack_small";
// BigInt(...) rather than 1_000_000n: tsconfig targets below ES2020, which
// rejects BigInt literals (TS2737).
const MICROS = BigInt(1_000_000);
const NANOS_PER_MICRO = BigInt(1000);

/** Live/cached state: base USD 1.99, three regions in sync with Google. */
const LIVE = {
  US: { currency: "USD", micros: "1990000" },
  VN: { currency: "VND", micros: "49000000000" },
  JP: { currency: "JPY", micros: "300000000" },
} as const;

/** What Google's convertRegionPrices returns for the NEW base (USD 2.99). */
const CONVERTED_FOR_299 = {
  US: { currencyCode: "USD", units: "2", nanos: 990_000_000 },
  VN: { currencyCode: "VND", units: "74000", nanos: 0 },
  JP: { currencyCode: "JPY", units: "450", nanos: 0 },
};

function cachedDetail(): IapDetail {
  return {
    iap: {
      id: "iap-uuid",
      app_id: "app-uuid",
      sku: SKU,
      purchase_type: "managed",
      status: "active",
      default_currency: "USD",
      default_price_micros: LIVE.US.micros,
      last_synced_at: "2026-08-01T00:00:00Z",
      deleted_on_google_at: null,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    },
    listings: [
      {
        id: "l1",
        iap_id: "iap-uuid",
        locale: "en-US",
        title: "Small Gem Pack",
        description: "200 gems.",
      },
    ],
    prices: Object.entries(LIVE).map(([region, p], i) => ({
      id: `p${i}`,
      iap_id: "iap-uuid",
      region_code: region,
      currency: p.currency,
      price_micros: p.micros,
    })),
  };
}

/** The live product Google returns from GET (purchase-option resolution +
 *  the post-state refetch). */
function liveProduct(): { data: OneTimeProduct } {
  return {
    data: {
      productId: SKU,
      packageName: PKG,
      listings: [
        { languageCode: "en-US", title: "Small Gem Pack", description: "200 gems." },
      ],
      purchaseOptions: [
        {
          purchaseOptionId: "legacy-base",
          buyOption: { legacyCompatible: true },
          state: "ACTIVE",
          regionalPricingAndAvailabilityConfigs: Object.entries(LIVE).map(
            ([regionCode, p]) => ({
              regionCode,
              price: {
                currencyCode: p.currency,
                units: String(BigInt(p.micros) / MICROS),
                nanos: Number(BigInt(p.micros) % MICROS) * 1000,
              },
              availability: "AVAILABLE",
            }),
          ),
        },
      ],
    },
  };
}

/** Exactly what IapForm sends today: the base price moves, and every region
 *  override is the untouched cache echo at its OLD value. */
function managerChangesBasePriceTo(decimal: string) {
  return {
    appId: "app-uuid",
    packageName: PKG,
    sku: SKU,
    purchaseType: "managed" as const,
    status: "active" as const,
    defaultLanguage: "en-US",
    listings: [
      { locale: "en-US", title: "Small Gem Pack", description: "200 gems." },
    ],
    baseCurrency: "USD",
    basePriceDecimal: decimal,
    regionOverrides: Object.entries(LIVE).map(([region, p]) => ({
      region,
      currency: p.currency,
      priceDecimal:
        region === "US" ? "1.99" : region === "VN" ? "49000.00" : "300.00",
    })),
    actorEmail: "manager@example.com",
    current: cachedDetail(),
  };
}

/** Pull the regional configs out of whatever was sent to onetimeproducts.patch. */
function sentRegionalConfigs(): Record<string, { currency: string; micros: string }> {
  expect(patchSpy).toHaveBeenCalledTimes(1);
  const body = patchSpy.mock.calls[0][0].requestBody as OneTimeProduct;
  const opt = (body.purchaseOptions ?? [])[0];
  const out: Record<string, { currency: string; micros: string }> = {};
  for (const c of opt?.regionalPricingAndAvailabilityConfigs ?? []) {
    if (!c.regionCode || !c.price) continue;
    const units = BigInt(c.price.units ?? "0");
    const nanos = BigInt(c.price.nanos ?? 0);
    out[c.regionCode] = {
      currency: c.price.currencyCode ?? "",
      micros: (units * MICROS + nanos / NANOS_PER_MICRO).toString(),
    };
  }
  return out;
}

beforeEach(() => {
  getProductSpy.mockReset();
  patchSpy.mockReset();
  batchActivateSpy.mockReset();
  convertRegionPricesSpy.mockReset();
  logSpy.mockReset();
  syncSpy.mockReset();
  appendActionSpy.mockReset();

  // Purchase-option resolution GET, then the post-state refetch GET.
  getProductSpy.mockResolvedValue(liveProduct());
  patchSpy.mockResolvedValue(liveProduct());
  batchActivateSpy.mockResolvedValue({ data: {} });
  convertRegionPricesSpy.mockResolvedValue({
    data: {
      convertedRegionPrices: Object.fromEntries(
        Object.entries(CONVERTED_FOR_299).map(([r, price]) => [r, { price }]),
      ),
      regionVersion: { version: "2026/01" },
    },
  });
  syncSpy.mockResolvedValue(undefined);
  appendActionSpy.mockResolvedValue(undefined);
});

describe("base-price change must reach the Google payload", () => {
  it("ACCEPTANCE: raising the base price 1.99 → 2.99 changes the regional configs sent to Google", async () => {
    await updateIapOnGoogle(jwt, managerChangesBasePriceTo("2.99"));

    const sent = sentRegionalConfigs();

    // The base price's only carrier on the v3 wire is the regional configs.
    // If the US config still reads 1.99 the write is a byte-identical no-op.
    expect(sent.US).toEqual({ currency: "USD", micros: "2990000" });
  });

  it("ACCEPTANCE: the whole converted catalogue moves, not just the base region", async () => {
    await updateIapOnGoogle(jwt, managerChangesBasePriceTo("2.99"));

    const sent = sentRegionalConfigs();
    expect(sent.VN).toEqual({ currency: "VND", micros: "74000000000" });
    expect(sent.JP).toEqual({ currency: "JPY", micros: "450000000" });
  });

  it("REGRESSION GUARD: the payload must not be byte-identical to live state", async () => {
    await updateIapOnGoogle(jwt, managerChangesBasePriceTo("2.99"));

    const sent = sentRegionalConfigs();
    const identicalToLive = Object.entries(LIVE).every(
      ([region, p]) =>
        sent[region]?.micros === p.micros && sent[region]?.currency === p.currency,
    );
    expect(identicalToLive).toBe(false);
  });
});
