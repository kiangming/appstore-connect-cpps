/**
 * IAP.p1.i — Pricing-template integration tests.
 *
 * Pins the multi-entry POST payload shape Apple expects when the
 * orchestrator applies template-backed overrides on top of the USA base
 * (Q-C verified). Complements pricing-orchestration.test.ts (unit tests on
 * the orchestrator logic) by hitting the price-schedules wire layer with a
 * full template-driven scenario.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AscCredentials } from "@/lib/asc-jwt";

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

import { setPriceSchedule } from "./price-schedules";

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

describe("IAP.p1 — multi-entry POST /v1/inAppPurchasePriceSchedules", () => {
  beforeEach(() => iapFetch.mockReset());

  it("emits one manualPrices entry per overridden territory + matching included[]", async () => {
    iapFetch.mockResolvedValueOnce({
      data: { id: "sched-multi", type: "inAppPurchasePriceSchedules" },
    });
    const res = await setPriceSchedule(creds, {
      appleIapId: "iap-99",
      applePricePointId: "pp-usa-099",
      additionalPricePointIds: ["pp-vnm-25000", "pp-jpn-160"],
    });
    expect(res.ok).toBe(true);

    const body = iapFetch.mock.calls[0][3] as {
      data: {
        relationships: {
          manualPrices: { data: Array<{ id: string; type: string }> };
          baseTerritory: { data: { id: string } };
        };
      };
      included: Array<{
        id: string;
        relationships: {
          inAppPurchasePricePoint: { data: { id: string } };
        };
      }>;
    };

    // 1 base + 2 overrides = 3 manualPrices entries
    expect(body.data.relationships.manualPrices.data).toHaveLength(3);
    expect(body.included).toHaveLength(3);
    // baseTerritory is USA (default) — Apple equalizes the territories
    // NOT in manualPrices from this base.
    expect(body.data.relationships.baseTerritory.data.id).toBe("USA");

    // IAP.o.11d lid syntax ${price-N} — required by Apple.
    for (const ref of body.data.relationships.manualPrices.data) {
      expect(ref.id).toMatch(/^\$\{price-\d+\}$/);
      expect(ref.type).toBe("inAppPurchasePrices");
    }

    // Order is base first, then additionalPricePointIds in order — pin so
    // a future reordering can't silently break the included[] mapping.
    const pricePointIds = body.included.map(
      (inc) => inc.relationships.inAppPurchasePricePoint.data.id,
    );
    expect(pricePointIds).toEqual([
      "pp-usa-099",
      "pp-vnm-25000",
      "pp-jpn-160",
    ]);

    // Every manualPrices.data[].id must reference an included[].id.
    const manualIds = body.data.relationships.manualPrices.data.map((m) => m.id);
    const includedIds = body.included.map((inc) => inc.id);
    for (const mid of manualIds) {
      expect(includedIds).toContain(mid);
    }
  });

  it("backward-compat: empty additionalPricePointIds → single-entry shape (IAP.o.11d preserved)", async () => {
    iapFetch.mockResolvedValueOnce({
      data: { id: "sched-1", type: "inAppPurchasePriceSchedules" },
    });
    await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-099",
      additionalPricePointIds: [],
    });
    const body = iapFetch.mock.calls[0][3] as {
      data: { relationships: { manualPrices: { data: unknown[] } } };
      included: unknown[];
    };
    expect(body.data.relationships.manualPrices.data).toHaveLength(1);
    expect(body.included).toHaveLength(1);
  });

  it("backward-compat: omitting additionalPricePointIds entirely yields single entry", async () => {
    iapFetch.mockResolvedValueOnce({
      data: { id: "sched-1", type: "inAppPurchasePriceSchedules" },
    });
    await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-099",
    });
    const body = iapFetch.mock.calls[0][3] as {
      data: { relationships: { manualPrices: { data: unknown[] } } };
    };
    expect(body.data.relationships.manualPrices.data).toHaveLength(1);
  });

  it("honors custom baseTerritory across the multi-entry shape", async () => {
    iapFetch.mockResolvedValueOnce({
      data: { id: "sched-1", type: "inAppPurchasePriceSchedules" },
    });
    await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-vnm-25000",
      additionalPricePointIds: ["pp-jpn-160"],
      baseTerritory: "VNM",
    });
    const body = iapFetch.mock.calls[0][3] as {
      data: {
        relationships: {
          baseTerritory: { data: { id: string } };
          manualPrices: { data: unknown[] };
        };
      };
    };
    expect(body.data.relationships.baseTerritory.data.id).toBe("VNM");
    expect(body.data.relationships.manualPrices.data).toHaveLength(2);
  });
});
