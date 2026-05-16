/**
 * Tests for IAP.o.9a pricing orchestration. Verifies the typed result
 * `kind` discriminates the four happy/sad paths Manager workflow cares
 * about: set / skipped-no-tier / skipped-no-match / failed-*.
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
  {
    type: "inAppPurchasePricePoints",
    id: "pp-5",
    attributes: { customerPrice: "4.99", proceeds: "3.49", priceTier: "5" },
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
    });
    expect(out.kind).toBe("skipped-no-tier");
    expect(listPricePointsForIap).not.toHaveBeenCalled();
  });

  it("returns kind='skipped-no-match' when no Apple priceTier matches", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_999",
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
    });
    expect(out.kind).toBe("failed-lookup");
    if (out.kind === "failed-lookup") expect(out.error).toContain("net down");
  });

  it("returns kind='failed-set' when setPriceSchedule rejects", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    setPriceSchedule.mockResolvedValueOnce({ ok: false, error: "422" });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
    });
    expect(out.kind).toBe("failed-set");
    if (out.kind === "failed-set") {
      expect(out.price_point_id).toBe("pp-5");
      expect(out.error).toBe("422");
    }
  });

  it("returns kind='set' with schedule_id on the happy path", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    setPriceSchedule.mockResolvedValueOnce({
      ok: true,
      schedule_id: "sched-9",
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
    });
    expect(out.kind).toBe("set");
    if (out.kind === "set") {
      expect(out.price_point_id).toBe("pp-5");
      expect(out.schedule_id).toBe("sched-9");
    }
  });

  it("threads custom baseTerritory through to setPriceSchedule", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    setPriceSchedule.mockResolvedValueOnce({
      ok: true,
      schedule_id: "sched-1",
    });
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      baseTerritory: "VNM",
    });
    expect(listPricePointsForIap).toHaveBeenCalledWith(creds, "iap-1", "VNM");
    expect(setPriceSchedule).toHaveBeenCalledWith(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-5",
      baseTerritory: "VNM",
    });
  });
});
