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

describe("findPricePointByTier", () => {
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
