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

// IAP.p1.e: orchestration now consults the template tables for non-APPLE
// pricing sources. Mock the loaders so tests stay hermetic.
const getDefaultTemplate = vi.hoisted(() => vi.fn());
const getAppTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/queries/templates", () => ({
  getDefaultTemplate,
  getAppTemplate,
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
import { createBatchPricePointCatalog } from "./batch-price-point-catalog";
import { encodePricePointId } from "./price-point-id";
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
      additionalPricePointIds: [],
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

// IAP.p1.e — three-source pricing model. The APPLE path preserves IAP.o.11d
// behavior (F8 nuance: backward compat). DEFAULT_TEMPLATE / APP_TEMPLATE
// paths fetch per-territory price points and assemble a multi-entry
// manualPrices payload.
describe("applyPricingSchedule — three-source pricing model (IAP.p1.e)", () => {
  beforeEach(() => {
    listPricePointsForIap.mockReset();
    setPriceSchedule.mockReset();
    auditInsert.mockReset();
    getDefaultTemplate.mockReset();
    getAppTemplate.mockReset();
  });

  // ── APPLE source — unchanged behavior ─────────────────────────────────
  it("APPLE source: emits empty additionalPricePointIds (preserves IAP.o.11d shape)", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    setPriceSchedule.mockResolvedValueOnce({
      ok: true,
      schedule_id: "sched-apple",
      attempts: 1,
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APPLE" },
      audit: baseAudit,
    });
    expect(out.kind).toBe("set");
    if (out.kind === "set") {
      expect(out.source_kind).toBe("APPLE");
      expect(out.overridden_territory_count).toBe(0);
    }
    expect(setPriceSchedule.mock.calls[0][1].additionalPricePointIds).toEqual([]);
    // No template loader consulted on APPLE path.
    expect(getDefaultTemplate).not.toHaveBeenCalled();
    expect(getAppTemplate).not.toHaveBeenCalled();
  });

  // ── DEFAULT_TEMPLATE source — overrides applied per territory ────────
  it("DEFAULT_TEMPLATE: resolves per-territory overrides and POSTs multi-entry schedule", async () => {
    listPricePointsForIap
      .mockResolvedValueOnce(POINTS) // USA base
      .mockResolvedValueOnce([
        // VNM territory price points
        {
          type: "inAppPurchasePricePoints",
          id: "pp-vnm-25000",
          attributes: { customerPrice: "25000", proceeds: "17500", priceTier: "10000" },
        },
      ]);
    getDefaultTemplate.mockResolvedValueOnce({
      template: {
        id: "tmpl-default",
        scope_type: "GLOBAL",
        scope_app_id: null,
        uploaded_at: "2026-05-18T00:00:00Z",
        uploaded_by: "tester",
        source_filename: null,
      },
      entries: [
        // USA entry is filtered out (baseTerritory) inside orchestrator.
        { tier_id: "TIER_5", territory_code: "USA", currency_code: "USD", customer_price: 4.99, proceeds: 3.49 },
        { tier_id: "TIER_5", territory_code: "VNM", currency_code: "VND", customer_price: 25000, proceeds: 17500 },
        // Different tier ignored.
        { tier_id: "TIER_1", territory_code: "VNM", currency_code: "VND", customer_price: 5000, proceeds: 3500 },
      ],
    });
    setPriceSchedule.mockResolvedValueOnce({
      ok: true,
      schedule_id: "sched-default",
      attempts: 1,
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "DEFAULT_TEMPLATE" },
      audit: baseAudit,
    });
    expect(out.kind).toBe("set");
    if (out.kind === "set") {
      expect(out.source_kind).toBe("DEFAULT_TEMPLATE");
      expect(out.overridden_territory_count).toBe(1);
    }
    // USA fetched first as the base; VNM fetched as override.
    expect(listPricePointsForIap.mock.calls[0][2]).toBe("USA");
    expect(listPricePointsForIap.mock.calls[1][2]).toBe("VNM");
    expect(setPriceSchedule.mock.calls[0][1].additionalPricePointIds).toEqual([
      "pp-vnm-25000",
    ]);
  });

  // ── APP_TEMPLATE source — scoped to the app id ────────────────────────
  it("APP_TEMPLATE: consults getAppTemplate with the provided app_id", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS); // USA only — no overrides
    getAppTemplate.mockResolvedValueOnce({
      template: {
        id: "tmpl-app",
        scope_type: "APP",
        scope_app_id: "app-uuid-123",
        uploaded_at: "2026-05-18T00:00:00Z",
        uploaded_by: "tester",
        source_filename: null,
      },
      entries: [],
    });
    setPriceSchedule.mockResolvedValueOnce({
      ok: true,
      schedule_id: "sched-app",
      attempts: 1,
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "APP_TEMPLATE", app_id: "app-uuid-123" },
      audit: baseAudit,
    });
    expect(out.kind).toBe("set");
    expect(getAppTemplate).toHaveBeenCalledWith("app-uuid-123");
    expect(getDefaultTemplate).not.toHaveBeenCalled();
  });

  // ── Q-K fail-soft: template entry with no Apple catalog match ─────────
  it("DEFAULT_TEMPLATE: missing Apple match → partial-template-fail, POST still happens", async () => {
    listPricePointsForIap
      .mockResolvedValueOnce(POINTS)
      .mockResolvedValueOnce([
        // VNM territory points — only 50000 available, template asks for 25000.
        {
          type: "inAppPurchasePricePoints",
          id: "pp-vnm-50000",
          attributes: { customerPrice: "50000", proceeds: "35000", priceTier: "10001" },
        },
      ]);
    getDefaultTemplate.mockResolvedValueOnce({
      template: {
        id: "tmpl-default",
        scope_type: "GLOBAL",
        scope_app_id: null,
        uploaded_at: "2026-05-18T00:00:00Z",
        uploaded_by: "tester",
        source_filename: null,
      },
      entries: [
        { tier_id: "TIER_5", territory_code: "VNM", currency_code: "VND", customer_price: 25000, proceeds: 17500 },
      ],
    });
    setPriceSchedule.mockResolvedValueOnce({
      ok: true,
      schedule_id: "sched-partial",
      attempts: 1,
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "DEFAULT_TEMPLATE" },
      audit: baseAudit,
    });
    expect(out.kind).toBe("partial-template-fail");
    if (out.kind === "partial-template-fail") {
      expect(out.missing_price_points).toEqual([
        { tier_id: "TIER_5", territory_code: "VNM", customer_price: 25000 },
      ]);
      expect(out.overridden_territory_count).toBe(0);
    }
    expect(lastAuditPayload().outcome).toBe("partial-template-fail");
    expect(lastAuditPayload().missing_price_points).toEqual([
      { tier_id: "TIER_5", territory_code: "VNM", customer_price: 25000 },
    ]);
  });

  // ── Template source selected but no template exists ──────────────────
  it("DEFAULT_TEMPLATE selected but no template exists → falls back to APPLE behavior", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    getDefaultTemplate.mockResolvedValueOnce(null);
    setPriceSchedule.mockResolvedValueOnce({
      ok: true,
      schedule_id: "sched-fallback",
      attempts: 1,
    });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-1",
      localTierId: "TIER_5",
      usdPrice: 4.99,
      source: { kind: "DEFAULT_TEMPLATE" },
      audit: baseAudit,
    });
    expect(out.kind).toBe("set");
    if (out.kind === "set") {
      expect(out.source_kind).toBe("DEFAULT_TEMPLATE");
      expect(out.overridden_territory_count).toBe(0);
    }
    expect(setPriceSchedule.mock.calls[0][1].additionalPricePointIds).toEqual([]);
  });

  // ── Audit log records the source on every outcome ────────────────────
  it("audit payload includes source + source_app_id", async () => {
    listPricePointsForIap.mockResolvedValueOnce(POINTS);
    getAppTemplate.mockResolvedValueOnce(null);
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
      source: { kind: "APP_TEMPLATE", app_id: "app-xyz" },
      audit: baseAudit,
    });
    expect(lastAuditPayload().source).toBe("APP_TEMPLATE");
    expect(lastAuditPayload().source_app_id).toBe("app-xyz");
  });
});

/**
 * Cycle 44 — batch price-point catalog PARITY.
 *
 * The load-bearing guarantee: routing price-point DATA through the batch
 * catalog must produce BYTE-IDENTICAL price selection + submitted ids vs the
 * pre-optimization per-item fetch. Price selection (customerPrice matching)
 * is untouched; only the data source + id derivation change.
 */
describe("applyPricingSchedule — Cycle 44 batch-catalog parity", () => {
  // Catalog identical across IAPs: same customerPrice → same tier `p`; ids
  // encode the requesting IAP (so the catalog's round-trip guard passes).
  function pointsFor(iap: string, territory: string) {
    return ["0.99", "1.99", "4.99"].map((cp, i) => ({
      type: "inAppPurchasePricePoints",
      id: encodePricePointId({ s: iap, t: territory, p: `${10000 + i}` }),
      attributes: { customerPrice: cp, proceeds: "0.70" },
    }));
  }

  const TEMPLATE = {
    template: { id: "tpl-1", scope_type: "APP", scope_app_id: "app-1" },
    entries: [
      { tier_id: "TIER_1", territory_code: "USA", currency_code: "USD", customer_price: 0.99, proceeds: null },
      { tier_id: "TIER_1", territory_code: "COL", currency_code: "COP", customer_price: 1.99, proceeds: null },
      { tier_id: "TIER_1", territory_code: "JPN", currency_code: "JPY", customer_price: 4.99, proceeds: null },
    ],
  };
  const common = {
    localTierId: "TIER_1",
    usdPrice: 0.99,
    source: { kind: "APP_TEMPLATE" as const, app_id: "app-1" },
    audit: baseAudit,
  };

  beforeEach(() => {
    listPricePointsForIap.mockReset();
    setPriceSchedule.mockReset();
    auditInsert.mockReset();
    listPricePointsForIap.mockImplementation((_c: unknown, iap: string, terr: string) =>
      Promise.resolve(pointsFor(iap, terr)),
    );
    setPriceSchedule.mockResolvedValue({ ok: true, schedule_id: "sch", attempts: 1 });
    getAppTemplate.mockResolvedValue(TEMPLATE);
  });

  function lastScheduleArgs() {
    const call = setPriceSchedule.mock.calls.at(-1);
    if (!call) throw new Error("setPriceSchedule not called");
    return call[1] as { applePricePointId: string; additionalPricePointIds: string[] };
  }

  it("catalog path selects identical prices AND submits byte-identical ids vs per-item fetch", async () => {
    // (1) per-item path (no catalog) for iap-B — the baseline behavior.
    await applyPricingSchedule({ creds, appleIapId: "iap-B", ...common });
    const perItem = lastScheduleArgs();

    // (2) catalog path: warm with iap-A, then run iap-B from cache.
    setPriceSchedule.mockClear();
    listPricePointsForIap.mockClear();
    const catalog = createBatchPricePointCatalog(creds);
    await applyPricingSchedule({ creds, appleIapId: "iap-A", iapType: "CONSUMABLE", catalog, ...common });
    const fetchesAfterWarm = listPricePointsForIap.mock.calls.length;
    await applyPricingSchedule({ creds, appleIapId: "iap-B", iapType: "CONSUMABLE", catalog, ...common });
    const fetchesAfterSecond = listPricePointsForIap.mock.calls.length;
    const viaCatalog = lastScheduleArgs();

    // Byte-identical base + per-territory override ids → identical price choice.
    expect(viaCatalog.applePricePointId).toBe(perItem.applePricePointId);
    expect([...viaCatalog.additionalPricePointIds].sort()).toEqual(
      [...perItem.additionalPricePointIds].sort(),
    );

    // Amortization: warming iap-A fetched 3 territories (USA+COL+JPN); the
    // SECOND item added ZERO fetches (the whole point of the optimization).
    expect(fetchesAfterWarm).toBe(3);
    expect(fetchesAfterSecond).toBe(3);
  });

  it("outcome reports the DERIVED (submitted) price_point_id for the current IAP", async () => {
    const catalog = createBatchPricePointCatalog(creds);
    await applyPricingSchedule({ creds, appleIapId: "iap-A", iapType: "CONSUMABLE", catalog, ...common });
    const out = await applyPricingSchedule({
      creds,
      appleIapId: "iap-B",
      iapType: "CONSUMABLE",
      catalog,
      ...common,
    });
    expect(out.kind).toBe("set");
    if (out.kind === "set") {
      // the id Apple would return for iap-B at (USA, base tier)
      expect(out.price_point_id).toBe(encodePricePointId({ s: "iap-B", t: "USA", p: "10000" }));
    }
  });
});
