/**
 * Tests for IAP.o.9a price-schedule POST. The payload Apple expects pairs a
 * primary `manualPrices.data[].id` with a matching `included[].id` entry —
 * the tests pin this shape so a typo can't ship to production silently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setPriceSchedule } from "./price-schedules";

const iapFetch = vi.hoisted(() => vi.fn());
vi.mock("./fetch", async () => {
  const actual = await vi.importActual<typeof import("./fetch")>("./fetch");
  return {
    ...actual,
    iapFetch,
  };
});

import { AppleApiError } from "./fetch";

import type { AscCredentials } from "@/lib/asc-jwt";

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

describe("setPriceSchedule", () => {
  beforeEach(() => iapFetch.mockReset());

  it("POSTs /v1/inAppPurchasePriceSchedules with the JSON:API shape", async () => {
    iapFetch.mockResolvedValueOnce({
      data: { id: "sched-1", type: "inAppPurchasePriceSchedules" },
    });
    const out = await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-5",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.schedule_id).toBe("sched-1");
      expect(out.attempts).toBe(1);
    }
    const [, method, endpoint, body] = iapFetch.mock.calls[0];
    expect(method).toBe("POST");
    expect(endpoint).toBe("/v1/inAppPurchasePriceSchedules");
    const payload = body as {
      data: {
        type: string;
        relationships: {
          inAppPurchase: { data: { id: string } };
          baseTerritory: { data: { id: string } };
          manualPrices: { data: Array<{ id: string }> };
        };
      };
      included: Array<{
        type: string;
        id: string;
        attributes: { startDate: null };
        relationships: {
          inAppPurchasePricePoint: { data: { id: string } };
          inAppPurchaseV2: { data: { id: string } };
        };
      }>;
    };
    expect(payload.data.type).toBe("inAppPurchasePriceSchedules");
    expect(payload.data.relationships.inAppPurchase.data.id).toBe("iap-1");
    expect(payload.data.relationships.baseTerritory.data.id).toBe("USA");

    // manualPrices.data[].id MUST match the included[].id reference.
    const manualId = payload.data.relationships.manualPrices.data[0].id;
    expect(payload.included).toHaveLength(1);
    expect(payload.included[0].id).toBe(manualId);
    expect(payload.included[0].type).toBe("inAppPurchasePrices");
    expect(payload.included[0].attributes.startDate).toBeNull();
    expect(payload.included[0].relationships.inAppPurchasePricePoint.data.id).toBe("pp-5");
    expect(payload.included[0].relationships.inAppPurchaseV2.data.id).toBe("iap-1");

    // IAP.o.11d: Apple rejects plain UUIDs with
    // ENTITY_ERROR.INCLUDED.INVALID_ID — required format is "${...}" (JSON:API
    // compound-document "lid" syntax). Pin the contract so a regression to
    // randomUUID cannot ship silently again.
    expect(manualId).toMatch(/^\$\{.+\}$/);
  });

  it("honors a custom baseTerritory", async () => {
    iapFetch.mockResolvedValueOnce({ data: { id: "s", type: "x" } });
    await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-1",
      baseTerritory: "VNM",
    });
    const body = iapFetch.mock.calls[0][3] as {
      data: { relationships: { baseTerritory: { data: { id: string } } } };
    };
    expect(body.data.relationships.baseTerritory.data.id).toBe("VNM");
  });

  it("returns ok=false on Apple rejection without throwing", async () => {
    iapFetch.mockRejectedValueOnce(new Error("422 Unprocessable"));
    const out = await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-bad",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("422");
      expect(out.attempts).toBe(1);
    }
  });

  it("retries on Apple 500 UNEXPECTED_ERROR and returns success when the retry succeeds (IAP.o.10a)", async () => {
    iapFetch
      .mockRejectedValueOnce(
        new AppleApiError(
          500,
          "POST",
          "/v1/inAppPurchasePriceSchedules",
          "UNEXPECTED_ERROR",
        ),
      )
      .mockResolvedValueOnce({
        data: { id: "sched-2", type: "inAppPurchasePriceSchedules" },
      });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-1",
      retryConfig: { delaysMs: [0, 0, 0], sleep },
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.attempts).toBe(2);
    expect(iapFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("returns failure after exhausting retries on persistent 500", async () => {
    const make500 = () =>
      new AppleApiError(
        500,
        "POST",
        "/v1/inAppPurchasePriceSchedules",
        "UNEXPECTED_ERROR",
      );
    iapFetch
      .mockRejectedValueOnce(make500())
      .mockRejectedValueOnce(make500())
      .mockRejectedValueOnce(make500())
      .mockRejectedValueOnce(make500());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-1",
      retryConfig: { delaysMs: [0, 0, 0], sleep },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.attempts).toBe(4);
      expect(out.error).toContain("500");
    }
  });

  it("does NOT retry on 4xx (payload errors aren't intermittent)", async () => {
    iapFetch.mockRejectedValueOnce(
      new AppleApiError(
        409,
        "POST",
        "/v1/inAppPurchasePriceSchedules",
        "ENTITY_ERROR",
      ),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-1",
      retryConfig: { delaysMs: [0, 0, 0], sleep },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.attempts).toBe(1);
    expect(iapFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  // ─── IAP.o.11a — extended retry budget (5 attempts) + jitter ─────────────

  it("retries up to 5 attempts on persistent 500s (IAP.o.11a budget bump from 3)", async () => {
    const make500 = () =>
      new AppleApiError(
        500,
        "POST",
        "/v1/inAppPurchasePriceSchedules",
        "UNEXPECTED_ERROR",
      );
    iapFetch
      .mockRejectedValueOnce(make500())
      .mockRejectedValueOnce(make500())
      .mockRejectedValueOnce(make500())
      .mockRejectedValueOnce(make500())
      .mockRejectedValueOnce(make500());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-1",
      // Pass the IAP.o.11a default-shaped delays so the budget surfaces.
      retryConfig: { delaysMs: [0, 0, 0, 0], sleep, jitterRatio: 0 },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.attempts).toBe(5);
      expect(out.error).toContain("500");
    }
    expect(iapFetch).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("succeeds at attempt 5 after four 500s (covers the new tail delays)", async () => {
    const make500 = () =>
      new AppleApiError(
        500,
        "POST",
        "/v1/inAppPurchasePriceSchedules",
        "UNEXPECTED_ERROR",
      );
    iapFetch
      .mockRejectedValueOnce(make500())
      .mockRejectedValueOnce(make500())
      .mockRejectedValueOnce(make500())
      .mockRejectedValueOnce(make500())
      .mockResolvedValueOnce({
        data: { id: "sched-late", type: "inAppPurchasePriceSchedules" },
      });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-1",
      retryConfig: { delaysMs: [0, 0, 0, 0], sleep, jitterRatio: 0 },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.attempts).toBe(5);
      expect(out.schedule_id).toBe("sched-late");
    }
  });

  it("applies ±jitterRatio to each backoff (deterministic with injected rng)", async () => {
    const make500 = () =>
      new AppleApiError(
        500,
        "POST",
        "/v1/inAppPurchasePriceSchedules",
        "UNEXPECTED_ERROR",
      );
    iapFetch
      .mockRejectedValueOnce(make500())
      .mockResolvedValueOnce({
        data: { id: "s", type: "inAppPurchasePriceSchedules" },
      });
    const sleep = vi.fn().mockResolvedValue(undefined);
    // rng = 1.0 → +20% upper bound on base 1000 → 1200ms.
    const out = await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-1",
      retryConfig: {
        delaysMs: [1000],
        sleep,
        jitterRatio: 0.2,
        rng: () => 1.0,
      },
    });
    expect(out.ok).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1200);
  });

  it("jitter floor at 0 — rng=0 (lower bound) cannot produce negative sleep", async () => {
    const make500 = () =>
      new AppleApiError(
        500,
        "POST",
        "/v1/inAppPurchasePriceSchedules",
        "UNEXPECTED_ERROR",
      );
    iapFetch
      .mockRejectedValueOnce(make500())
      .mockResolvedValueOnce({
        data: { id: "s", type: "inAppPurchasePriceSchedules" },
      });
    const sleep = vi.fn().mockResolvedValue(undefined);
    // rng = 0 → -20% lower bound on base 500 → 400ms (still positive).
    const out = await setPriceSchedule(creds, {
      appleIapId: "iap-1",
      applePricePointId: "pp-1",
      retryConfig: {
        delaysMs: [500],
        sleep,
        jitterRatio: 0.2,
        rng: () => 0,
      },
    });
    expect(out.ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(400);
  });
});
