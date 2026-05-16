/**
 * Tests for IAP.o.9a price-point lookup. Two surfaces:
 *
 *   1. `listPricePointsForIap` builds the correct Apple URL + paginates via
 *      `links.next`, mirroring the IAP.o.7 pagination pattern.
 *   2. `findPricePointByTier` maps local tier_id strings (TIER_5, FREE,
 *      ALT_1, bare "10") to Apple's integer `priceTier` attribute.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listPricePointsForIap,
  findPricePointByTier,
  findPricePointByUsdPrice,
  type InAppPurchasePricePoint,
} from "./price-points";

const iapFetch = vi.hoisted(() => vi.fn());
vi.mock("./fetch", () => ({
  iapFetch,
  withRetry: <T>(fn: () => Promise<T>) => fn(),
  AppleApiError: class extends Error {
    status: number;
    body: string;
    constructor(status: number, _m: string, _e: string, body: string) {
      super(body);
      this.status = status;
      this.body = body;
    }
  },
}));

import type { AscCredentials } from "@/lib/asc-jwt";

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

function pricePoint(priceTier: string, customerPrice: string): InAppPurchasePricePoint {
  return {
    type: "inAppPurchasePricePoints",
    id: `pp-${priceTier}`,
    attributes: {
      customerPrice,
      proceeds: "0.7",
      priceTier,
    },
  };
}

describe("listPricePointsForIap", () => {
  beforeEach(() => iapFetch.mockReset());

  it("hits the v2 endpoint with USA territory filter + limit=200", async () => {
    iapFetch.mockResolvedValueOnce({ data: [pricePoint("1", "0.99")] });
    await listPricePointsForIap(creds, "iap-1");
    const [, method, endpoint] = iapFetch.mock.calls[0];
    expect(method).toBe("GET");
    expect(endpoint).toBe(
      "/v2/inAppPurchases/iap-1/pricePoints?filter[territory]=USA&limit=200",
    );
  });

  it("honors a custom territory argument", async () => {
    iapFetch.mockResolvedValueOnce({ data: [] });
    await listPricePointsForIap(creds, "iap-1", "VNM");
    const [, , endpoint] = iapFetch.mock.calls[0];
    expect(endpoint).toContain("filter[territory]=VNM");
  });

  it("follows links.next until exhausted and accumulates `data`", async () => {
    iapFetch
      .mockResolvedValueOnce({
        data: [pricePoint("1", "0.99")],
        links: { next: "https://api.appstoreconnect.apple.com/v2/foo?cursor=2" },
      })
      .mockResolvedValueOnce({
        data: [pricePoint("2", "1.99")],
        links: {},
      });
    const out = await listPricePointsForIap(creds, "iap-1");
    expect(out).toHaveLength(2);
    expect(iapFetch).toHaveBeenCalledTimes(2);
    expect(iapFetch.mock.calls[1][2]).toBe("/v2/foo?cursor=2");
  });
});

describe("findPricePointByUsdPrice", () => {
  // Apple's 2024 numbering rollover left some IAPs on old priceTier integers
  // (1, 2, 3) and others on new ones (10000, 10001, …). customerPrice stays
  // stable, so it's the only safe match key.
  const points: InAppPurchasePricePoint[] = [
    {
      type: "inAppPurchasePricePoints",
      id: "pp-099",
      attributes: { customerPrice: "0.99", proceeds: "0.7", priceTier: "10000" },
    },
    {
      type: "inAppPurchasePricePoints",
      id: "pp-199",
      attributes: { customerPrice: "1.99", proceeds: "1.4", priceTier: "10001" },
    },
    {
      type: "inAppPurchasePricePoints",
      id: "pp-legacy-099",
      attributes: { customerPrice: "0.99", proceeds: "0.7", priceTier: "1" },
    },
  ];

  it("matches the first customerPrice equal to the USD target", () => {
    const out = findPricePointByUsdPrice(points, 0.99);
    expect(out?.id).toBe("pp-099");
  });

  it("returns null when no customerPrice matches", () => {
    expect(findPricePointByUsdPrice(points, 9.99)).toBeNull();
  });

  it("returns null on null/undefined/NaN input", () => {
    expect(findPricePointByUsdPrice(points, null)).toBeNull();
    expect(findPricePointByUsdPrice(points, undefined)).toBeNull();
    expect(findPricePointByUsdPrice(points, NaN)).toBeNull();
  });

  it("matches across float-rounding noise (0.10 + 0.20 vs 0.30)", () => {
    const target = 0.1 + 0.2; // 0.30000000000000004
    const localized: InAppPurchasePricePoint[] = [
      {
        type: "inAppPurchasePricePoints",
        id: "pp-030",
        attributes: { customerPrice: "0.30", proceeds: "0.21", priceTier: "0030" },
      },
    ];
    expect(findPricePointByUsdPrice(localized, target)?.id).toBe("pp-030");
  });

  it("treats free tier (0) as a normal price match", () => {
    const free: InAppPurchasePricePoint[] = [
      {
        type: "inAppPurchasePricePoints",
        id: "pp-free",
        attributes: { customerPrice: "0.00", proceeds: "0", priceTier: "0" },
      },
    ];
    expect(findPricePointByUsdPrice(free, 0)?.id).toBe("pp-free");
  });
});

describe("findPricePointByTier (legacy, IAP.o.9a)", () => {
  const points: InAppPurchasePricePoint[] = [
    pricePoint("0", "0.00"),
    pricePoint("1", "0.99"),
    pricePoint("5", "4.99"),
    pricePoint("10", "9.99"),
  ];

  it("matches TIER_N by stripping the prefix", () => {
    const out = findPricePointByTier(points, "TIER_5");
    expect(out?.id).toBe("pp-5");
  });

  it("matches FREE → priceTier 0", () => {
    const out = findPricePointByTier(points, "FREE");
    expect(out?.id).toBe("pp-0");
  });

  it("matches ALT_N by stripping the prefix", () => {
    const out = findPricePointByTier(points, "ALT_1");
    expect(out?.id).toBe("pp-1");
  });

  it("accepts a bare integer string", () => {
    const out = findPricePointByTier(points, "10");
    expect(out?.id).toBe("pp-10");
  });

  it("returns null on no match", () => {
    expect(findPricePointByTier(points, "TIER_999")).toBeNull();
  });

  it("returns null on null/empty input", () => {
    expect(findPricePointByTier(points, null)).toBeNull();
    expect(findPricePointByTier(points, "")).toBeNull();
  });

  it("returns null on unparseable input", () => {
    expect(findPricePointByTier(points, "weird")).toBeNull();
  });
});
