/**
 * Tests for the pricing orchestration. IAP.o.10a refactor: match by USD
 * customerPrice (string→number) instead of Apple's volatile priceTier
 * integer. Verifies the 6-kind discriminated result covers Manager's UI
 * surface paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyPricingSchedule } from "./pricing-orchestration";

const listPricePointsForIap = vi.hoisted(() => vi.fn());
const setPriceSchedule = vi.hoisted(() => vi.fn());

vi.mock("./price-points", async () => {
  const actual = await vi.importActual<typeof import("./price-points")>(
    "./price-points",
  );
  return {
    ...actual,
    listPricePointsForIap,
  };
});

vi.mock("./price-schedules", () => ({
  setPriceSchedule,
}));

vi.mock("./fetch", () => ({
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

const POINTS = [
  // Apple's new (2024+) numbering scheme — priceTier integers in the
  // 10000+ range. Tool must not depend on priceTier for matching.
  {
    type: "inAppPurchasePricePoints",
    id: "pp-099",
    attributes: { customerPrice: "0.99", proceeds: "0.70", priceTier: "10000" },
  },
  {
    type: "inAppPurchasePricePoints",
    id: "pp-199",
    attributes: { customerPrice: "1.99", proceeds: "1.40", priceTier: "10001" },
  },
  {
    type: "inAppPurchasePricePoints",
    id: "pp-499",
    attributes: { customerPrice: "4.99", proceeds: "3.49", priceTier: "10004" },
  },
];

describe("applyPricingSchedule", () => {
  beforeEach(() => {
    listPricePointsForIap.mockReset();
    setPriceSchedule.mockReset();
  });

  it("returns kind='skipped-no-tier' when localTierId is null", async () => {
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: null,
      usdPrice: 0.99,
    });
    expect(out.kind).toBe("skipped-no-tier");
    expect(listPricePointsForIap).not.toHaveBeenCalled();
  });

  it("returns kind='skipped-no-usd-price' when local tier has no USD price cached", async () => {
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: null,
    });
    expect(out.kind).toBe("skipped-no-usd-price");
    expect(listPricePointsForIap).not.toHaveBeenCalled();
  });

  it("returns kind='skipped-no-match' when no Apple customerPrice matches", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_99",
      usdPrice: 99.99,
    });
    expect(out.kind).toBe("skipped-no-match");
    expect(setPriceSchedule).not.toHaveBeenCalled();
  });

  it("returns kind='failed-lookup' when listPricePointsForIap throws", async () => {
    listPricePointsForIap.mockRejectedValueOnce(new Error("net down"));
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
    });
    expect(out.kind).toBe("failed-lookup");
    if (out.kind === "failed-lookup") expect(out.error).toContain("net down");
  });

  it("returns kind='failed-set' when setPriceSchedule rejects (after retry exhaustion)", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    setPriceSchedule.mockResolvedValueOnce({
      ok: false,
      error: "500 UNEXPECTED_ERROR",
      attempts: 4,
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
    });
    expect(out.kind).toBe("failed-set");
    if (out.kind === "failed-set") {
      expect(out.price_point_id).toBe("pp-499");
      expect(out.usd_price).toBe(4.99);
      expect(out.attempts).toBe(4);
    }
  });

  it("matches USD price 0.99 → pp-099 even when Apple uses new priceTier numbering 10000", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    setPriceSchedule.mockResolvedValueOnce({
      ok: true,
      schedule_id: "sched-9",
      attempts: 1,
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_1",
      usdPrice: 0.99,
    });
    expect(out.kind).toBe("set");
    if (out.kind === "set") {
      expect(out.price_point_id).toBe("pp-099");
      expect(out.usd_price).toBe(0.99);
      expect(out.attempts).toBe(1);
    }
  });

  it("matches USD price 4.99 → pp-499 (mid-range)", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    setPriceSchedule.mockResolvedValueOnce({
      ok: true,
      schedule_id: "sched-1",
      attempts: 1,
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
    });
    expect(out.kind).toBe("set");
    if (out.kind === "set") {
      expect(out.price_point_id).toBe("pp-499");
    }
  });

  it("threads custom baseTerritory through to setPriceSchedule", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    setPriceSchedule.mockResolvedValueOnce({
      ok: true,
      schedule_id: "sched-1",
      attempts: 1,
    });
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      baseTerritory: "VNM",
    });
    expect(listPricePointsForIap).toHaveBeenCalledWith(creds, "iap-1", "VNM");
    expect(setPriceSchedule).toHaveBeenCalledWith(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-499",
      baseTerritory: "VNM",
    });
  });
});
