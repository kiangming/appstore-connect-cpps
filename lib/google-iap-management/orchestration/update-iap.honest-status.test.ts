/**
 * SC1 — HONEST STATUS, end to end through the real publisher-client + adapter.
 *
 * These cases are driven by what GOOGLE returns on the post-write re-read, not
 * by whatever bug currently exists upstream. That is deliberate: they must
 * stay green through SC2 and beyond. A no-op is a no-op whether it is caused
 * by today's shadowed base price or by any future defect — the whole point of
 * the status principle is that the check does not depend on knowing the cause.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

function money(micros: string, currencyCode: string) {
  const v = BigInt(micros);
  return {
    currencyCode,
    units: String(v / MICROS),
    nanos: Number(v % MICROS) * 1000,
  };
}

function productWith(regions: Record<string, [string, string]>): {
  data: OneTimeProduct;
} {
  return {
    data: {
      productId: SKU,
      packageName: PKG,
      listings: [{ languageCode: "en-US", title: "Small Gem Pack", description: "g" }],
      purchaseOptions: [
        {
          purchaseOptionId: "legacy-base",
          buyOption: { legacyCompatible: true },
          state: "ACTIVE",
          regionalPricingAndAvailabilityConfigs: Object.entries(regions).map(
            ([regionCode, [currency, micros]]) => ({
              regionCode,
              price: money(micros, currency),
              availability: "AVAILABLE",
            }),
          ),
        },
      ],
    },
  };
}

const OLD = { US: ["USD", "1990000"], VN: ["VND", "49000000000"] } as Record<
  string,
  [string, string]
>;
const NEW = { US: ["USD", "2990000"], VN: ["VND", "74000000000"] } as Record<
  string,
  [string, string]
>;

function cachedDetail(): IapDetail {
  return {
    iap: {
      id: "iap-uuid",
      app_id: "app-uuid",
      sku: SKU,
      purchase_type: "managed",
      status: "active",
      default_currency: "USD",
      default_price_micros: "1990000",
      last_synced_at: "2026-08-01T00:00:00Z",
      deleted_on_google_at: null,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    },
    listings: [
      { id: "l1", iap_id: "iap-uuid", locale: "en-US", title: "Small Gem Pack", description: "g" },
    ],
    prices: Object.entries(OLD).map(([region, [currency, micros]], i) => ({
      id: `p${i}`,
      iap_id: "iap-uuid",
      region_code: region,
      currency,
      price_micros: micros,
    })),
  };
}

function input(basePriceDecimal: string, overrides: Record<string, [string, string]>) {
  return {
    appId: "app-uuid",
    packageName: PKG,
    sku: SKU,
    purchaseType: "managed" as const,
    status: "active" as const,
    defaultLanguage: "en-US",
    listings: [{ locale: "en-US", title: "Small Gem Pack", description: "g" }],
    baseCurrency: "USD",
    basePriceDecimal,
    regionOverrides: Object.entries(overrides).map(([region, [currency, micros]]) => ({
      region,
      currency,
      priceDecimal: (Number(BigInt(micros)) / 1e6).toString(),
    })),
    actorEmail: "manager@example.com",
    current: cachedDetail(),
  };
}

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const s of [
    getProductSpy,
    patchSpy,
    batchActivateSpy,
    convertRegionPricesSpy,
    logSpy,
    syncSpy,
    appendActionSpy,
  ]) {
    s.mockReset();
  }
  batchActivateSpy.mockResolvedValue({ data: {} });
  convertRegionPricesSpy.mockResolvedValue({
    data: {
      convertedRegionPrices: Object.fromEntries(
        Object.entries(NEW).map(([r, [c, m]]) => [r, { price: money(m, c) }]),
      ),
      regionVersion: { version: "2026/01" },
    },
  });
  syncSpy.mockResolvedValue(undefined);
  appendActionSpy.mockResolvedValue(undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("updateIapOnGoogle — honest status", () => {
  it("Google's state did not move → hasChanges:false, noOp:true, loud log", async () => {
    // Every read returns the OLD pricing: the write changed nothing.
    getProductSpy.mockResolvedValue(productWith(OLD));
    patchSpy.mockResolvedValue(productWith(OLD));

    const res = await updateIapOnGoogle(jwt, input("2.99", OLD));

    expect(res.hasChanges).toBe(false);
    expect(res.verification?.noOp).toBe(true);
    expect(res.verification?.basePriceApplied).toBe(false);
    expect(
      errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("NO-OP WRITE")),
    ).toBe(true);
  });

  it("Google's state moved to the intended values → hasChanges:true, nothing unapplied", async () => {
    getProductSpy
      .mockResolvedValueOnce(productWith(OLD)) // purchase-option resolution
      .mockResolvedValue(productWith(NEW)); // post-state refetch
    patchSpy.mockResolvedValue(productWith(NEW));

    const res = await updateIapOnGoogle(jwt, input("2.99", NEW));

    expect(res.hasChanges).toBe(true);
    expect(res.verification?.noOp).toBe(false);
    expect(res.verification?.basePriceApplied).toBe(true);
    expect(res.verification?.unappliedRegions).toEqual([]);
    expect(
      errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("NO-OP WRITE")),
    ).toBe(false);
  });

  it("partial application is named, not hidden behind a green result", async () => {
    const PARTIAL = { US: NEW.US, VN: OLD.VN };
    getProductSpy
      .mockResolvedValueOnce(productWith(OLD))
      .mockResolvedValue(productWith(PARTIAL));
    patchSpy.mockResolvedValue(productWith(PARTIAL));

    const res = await updateIapOnGoogle(jwt, input("2.99", NEW));

    expect(res.hasChanges).toBe(true);
    expect(res.verification?.unappliedRegions).toEqual(["VN"]);
    expect(
      warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("PARTIAL WRITE")),
    ).toBe(true);
  });

  it("the audit row records the OUTCOME, not just the intent", async () => {
    getProductSpy.mockResolvedValue(productWith(OLD));
    patchSpy.mockResolvedValue(productWith(OLD));

    await updateIapOnGoogle(jwt, input("2.99", OLD));

    expect(appendActionSpy).toHaveBeenCalledTimes(1);
    const payload = appendActionSpy.mock.calls[0][0].payload;
    expect(payload.action_type).toBeUndefined(); // action_type is a column, not payload
    expect(payload.verification.noOp).toBe(true);
    expect(payload.attributes.basePriceMicros).toEqual({
      before: "1990000",
      after: "2990000",
    });
  });
});
