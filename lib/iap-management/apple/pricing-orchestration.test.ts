/**
 * Tests for the pricing orchestration. IAP.o.10a/IAP.o.11a refactor — match
 * by USD customerPrice (string→number) instead of Apple's volatile priceTier
 * integer, AND verify every outcome path writes a SET_PRICE_SCHEDULE audit
 * row inside the orchestrator (IAP.o.11a moves the audit write here so a
 * silent return-early cannot leave the audit log empty).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listPricePointsForIap = vi.hoisted(() => vi.fn());
const setPriceSchedule = vi.hoisted(() => vi.fn());
const auditInsert = vi.hoisted(() => vi.fn());

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

// IAP.o.11a: orchestrator now writes the SET_PRICE_SCHEDULE audit row itself.
// Capture every insert so tests can assert the payload at each outcome path.
vi.mock("@/lib/iap-management/db", () => ({
  iapDb: () => ({
    from: () => ({
      insert: (...args: unknown[]) => {
        auditInsert(...args);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

import { applyPricingSchedule } from "./pricing-orchestration";
import type { AscCredentials } from "@/lib/asc-jwt";

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

const baseAudit = { iapId: "iap-row-1", actor: "tester" };

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

function lastAuditPayload(): Record<string, unknown> {
  const call = auditInsert.mock.calls.at(-1);
  if (!call) throw new Error("no audit insert captured");
  const row = call[0] as { payload: Record<string, unknown> };
  return row.payload;
}

describe("applyPricingSchedule", () => {
  beforeEach(() => {
    listPricePointsForIap.mockReset();
    setPriceSchedule.mockReset();
    auditInsert.mockReset();
  });

  it("returns kind='skipped-no-tier' when localTierId is null", async () => {
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: null,
      usdPrice: 0.99,
      audit: baseAudit,
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
      audit: baseAudit,
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
      audit: baseAudit,
    });
    expect(out.kind).toBe("skipped-no-match");
    if (out.kind === "skipped-no-match") {
      expect(out.sample_apple_prices).toEqual(["0.99", "1.99", "4.99"]);
    }
    expect(setPriceSchedule).not.toHaveBeenCalled();
  });

  it("returns kind='failed-lookup' when listPricePointsForIap throws", async () => {
    listPricePointsForIap.mockRejectedValueOnce(new Error("net down"));
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      audit: baseAudit,
    });
    expect(out.kind).toBe("failed-lookup");
    if (out.kind === "failed-lookup") expect(out.error).toContain("net down");
  });

  it("returns kind='failed-set' when setPriceSchedule rejects (after retry exhaustion)", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    setPriceSchedule.mockResolvedValueOnce({
      ok: false,
      error: "500 UNEXPECTED_ERROR",
      attempts: 5,
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      audit: baseAudit,
    });
    expect(out.kind).toBe("failed-set");
    if (out.kind === "failed-set") {
      expect(out.price_point_id).toBe("pp-499");
      expect(out.usd_price).toBe(4.99);
      expect(out.attempts).toBe(5);
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
      audit: baseAudit,
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
      audit: baseAudit,
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
      audit: baseAudit,
    });
    expect(listPricePointsForIap).toHaveBeenCalledWith(creds, "iap-1", "VNM");
    expect(setPriceSchedule).toHaveBeenCalledWith(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-499",
      baseTerritory: "VNM",
    });
  });

  // ─── IAP.o.11a — precheck short-circuit ─────────────────────────────────

  it("returns kind='skipped-not-ready' when precheck.ready === false (no Apple calls)", async () => {
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      precheck: { ready: false, reason: "404: not found", attempts: 10, total_ms: 2000 },
      audit: baseAudit,
    });
    expect(out.kind).toBe("skipped-not-ready");
    if (out.kind === "skipped-not-ready") {
      expect(out.reason).toBe("404: not found");
      expect(out.poll_attempts).toBe(10);
      expect(out.poll_total_ms).toBe(2000);
    }
    expect(listPricePointsForIap).not.toHaveBeenCalled();
    expect(setPriceSchedule).not.toHaveBeenCalled();
  });

  it("proceeds normally when precheck.ready === true", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    setPriceSchedule.mockResolvedValueOnce({ ok: true, schedule_id: "s", attempts: 1 });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 0.99,
      precheck: { ready: true, attempts: 1, total_ms: 50 },
      audit: baseAudit,
    });
    expect(out.kind).toBe("set");
    expect(listPricePointsForIap).toHaveBeenCalled();
  });

  // ─── IAP.o.11a — audit log written at every outcome ─────────────────────

  it("writes SET_PRICE_SCHEDULE audit row at outcome=set", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    setPriceSchedule.mockResolvedValueOnce({ ok: true, schedule_id: "s-9", attempts: 1 });
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-99",
      localTierId: "TIER_1",
      usdPrice: 0.99,
      audit: { iapId: "row-99", actor: "alice" },
    });
    expect(auditInsert).toHaveBeenCalledTimes(1);
    const row = auditInsert.mock.calls[0][0] as {
      iap_id: string;
      actor: string;
      action_type: string;
      payload: Record<string, unknown>;
    };
    expect(row.iap_id).toBe("row-99");
    expect(row.actor).toBe("alice");
    expect(row.action_type).toBe("SET_PRICE_SCHEDULE");
    expect(row.payload.outcome).toBe("set");
    expect(row.payload.result).toBe("SUCCESS");
    expect(row.payload.schedule_id).toBe("s-9");
    expect(row.payload.price_point_id).toBe("pp-099");
  });

  it("writes audit row with result='ERROR' at outcome=skipped-no-match (Q-F severity escalation)", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_X",
      usdPrice: 99.99,
      audit: baseAudit,
    });
    expect(auditInsert).toHaveBeenCalledTimes(1);
    expect(lastAuditPayload().outcome).toBe("skipped-no-match");
    expect(lastAuditPayload().result).toBe("ERROR");
    expect(lastAuditPayload().sample_apple_prices).toEqual(["0.99", "1.99", "4.99"]);
  });

  it("writes audit row with result='ERROR' at outcome=skipped-not-ready", async () => {
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 0.99,
      precheck: { ready: false, reason: "timeout", attempts: 10, total_ms: 2000 },
      audit: baseAudit,
    });
    expect(auditInsert).toHaveBeenCalledTimes(1);
    expect(lastAuditPayload().outcome).toBe("skipped-not-ready");
    expect(lastAuditPayload().result).toBe("ERROR");
    expect(lastAuditPayload().poll_attempts).toBe(10);
    expect(lastAuditPayload().poll_total_ms).toBe(2000);
    expect(lastAuditPayload().poll_reason).toBe("timeout");
  });

  it("writes audit row with result='INFO' at outcome=skipped-no-tier (intentional skip)", async () => {
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: null,
      usdPrice: 0.99,
      audit: baseAudit,
    });
    expect(auditInsert).toHaveBeenCalledTimes(1);
    expect(lastAuditPayload().outcome).toBe("skipped-no-tier");
    expect(lastAuditPayload().result).toBe("INFO");
  });

  it("writes audit row at outcome=failed-lookup", async () => {
    listPricePointsForIap.mockRejectedValueOnce(new Error("net down"));
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      audit: baseAudit,
    });
    expect(auditInsert).toHaveBeenCalledTimes(1);
    expect(lastAuditPayload().outcome).toBe("failed-lookup");
    expect(lastAuditPayload().result).toBe("ERROR");
    expect(lastAuditPayload().error).toContain("net down");
  });

  it("omits iap_id from audit row when audit.iapId is null (bulk CREATE path)", async () => {
    await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: null,
      usdPrice: 0.99,
      audit: { iapId: null, actor: "bulk", batchId: "batch-1", productId: "com.x.y" },
    });
    expect(auditInsert).toHaveBeenCalledTimes(1);
    const row = auditInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.iap_id).toBeUndefined();
    expect(row.batch_id).toBe("batch-1");
    expect((row.payload as Record<string, unknown>).product_id).toBe("com.x.y");
  });

  it("returns kind='failed-exception' when an unexpected throw escapes the inner flow", async () => {
    // findPricePointByUsdPrice is called inside the orchestrator after the
    // listPricePointsForIap mock resolves. Force an unexpected throw by
    // returning a payload that doesn't conform to the interface (causes a
    // null deref inside the matcher).
    listPricePointsForIap.mockResolvedValueOnce(null as never);
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      audit: baseAudit,
    });
    expect(out.kind).toBe("failed-exception");
    expect(auditInsert).toHaveBeenCalledTimes(1);
    expect(lastAuditPayload().outcome).toBe("failed-exception");
    expect(lastAuditPayload().result).toBe("ERROR");
  });
});
