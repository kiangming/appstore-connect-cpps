/**
 * Tests for IAP.o.11a precheck poll. The poll is the Stage 1→Stage 2 race
 * guard so a freshly-created IAP doesn't try to set price before Apple has
 * fully propagated the record across services.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const iapFetch = vi.hoisted(() => vi.fn());
vi.mock("./fetch", async () => {
  const actual = await vi.importActual<typeof import("./fetch")>("./fetch");
  return {
    ...actual,
    iapFetch,
  };
});

import { pollIapReadyForPricing, pollIapReadyForSubmit } from "./poll-iap-ready";
import { AppleApiError } from "./fetch";
import type { AscCredentials } from "@/lib/asc-jwt";

const creds: AscCredentials = {
  id: "test",
  name: "Test",
  keyId: "K",
  issuerId: "I",
  privateKey: "P",
};

function iapResponse(state: string) {
  return {
    data: {
      type: "inAppPurchases",
      id: "iap-1",
      attributes: {
        name: "x",
        productId: "p",
        inAppPurchaseType: "CONSUMABLE",
        state,
      },
    },
  };
}

describe("pollIapReadyForPricing", () => {
  beforeEach(() => iapFetch.mockReset());

  it("returns ready=true on the first attempt when Apple responds with a populated state", async () => {
    iapFetch.mockResolvedValueOnce(iapResponse("MISSING_METADATA"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await pollIapReadyForPricing({
      creds,
      appleIapId: "iap-1",
      config: { intervalMs: 200, maxAttempts: 10, sleep },
    });
    expect(out.ready).toBe(true);
    if (out.ready) {
      expect(out.attempts).toBe(1);
      expect(out.final_state).toBe("MISSING_METADATA");
    }
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries when Apple returns 404 and resolves when the IAP propagates", async () => {
    iapFetch
      .mockRejectedValueOnce(
        new AppleApiError(404, "GET", "/v2/inAppPurchases/iap-1", "NOT_FOUND"),
      )
      .mockRejectedValueOnce(
        new AppleApiError(404, "GET", "/v2/inAppPurchases/iap-1", "NOT_FOUND"),
      )
      .mockResolvedValueOnce(iapResponse("READY_TO_SUBMIT"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await pollIapReadyForPricing({
      creds,
      appleIapId: "iap-1",
      config: { intervalMs: 200, maxAttempts: 10, sleep },
    });
    expect(out.ready).toBe(true);
    if (out.ready) {
      expect(out.attempts).toBe(3);
      expect(out.final_state).toBe("READY_TO_SUBMIT");
    }
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it("returns ready=false after maxAttempts when Apple persistently 404s", async () => {
    // vitest 4.1.4: retry-loop tests need fresh Error instances per attempt
    // — sharing one via mockRejectedValue triggers spurious FAILs (memory:
    // feedback_vitest_mock_rejected.md).
    const make404 = () =>
      new AppleApiError(404, "GET", "/v2/inAppPurchases/iap-1", "NOT_FOUND");
    iapFetch
      .mockRejectedValueOnce(make404())
      .mockRejectedValueOnce(make404())
      .mockRejectedValueOnce(make404());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await pollIapReadyForPricing({
      creds,
      appleIapId: "iap-1",
      config: { intervalMs: 200, maxAttempts: 3, sleep },
    });
    expect(out.ready).toBe(false);
    if (!out.ready) {
      expect(out.attempts).toBe(3);
      expect(out.reason).toContain("404");
    }
    expect(iapFetch).toHaveBeenCalledTimes(3);
    // sleep called between attempts but NOT after the final one.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("treats a 200 with missing state as 'not ready' and continues polling", async () => {
    iapFetch
      .mockResolvedValueOnce({
        data: { type: "inAppPurchases", id: "iap-1", attributes: { state: "" } },
      })
      .mockResolvedValueOnce(iapResponse("MISSING_METADATA"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await pollIapReadyForPricing({
      creds,
      appleIapId: "iap-1",
      config: { intervalMs: 200, maxAttempts: 5, sleep },
    });
    expect(out.ready).toBe(true);
    if (out.ready) expect(out.attempts).toBe(2);
  });

  it("reports the last error reason when never reaching ready", async () => {
    iapFetch
      .mockRejectedValueOnce(new Error("network unreachable"))
      .mockRejectedValueOnce(new Error("network unreachable"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await pollIapReadyForPricing({
      creds,
      appleIapId: "iap-1",
      config: { intervalMs: 10, maxAttempts: 2, sleep },
    });
    expect(out.ready).toBe(false);
    if (!out.ready) expect(out.reason).toContain("network unreachable");
  });
});

describe("pollIapReadyForSubmit", () => {
  beforeEach(() => iapFetch.mockReset());

  it("is NOT ready on a populated-but-wrong state (unlike pollIapReadyForPricing)", async () => {
    iapFetch.mockResolvedValueOnce(iapResponse("MISSING_METADATA"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await pollIapReadyForSubmit({
      creds,
      appleIapId: "iap-1",
      config: { intervalMs: 10, maxAttempts: 1, sleep },
    });
    expect(out.ready).toBe(false);
    if (!out.ready) {
      expect(out.reason).toContain("MISSING_METADATA");
      expect(out.last_seen_state).toBe("MISSING_METADATA");
    }
  });

  it("becomes ready once Apple reports READY_TO_SUBMIT", async () => {
    iapFetch
      .mockResolvedValueOnce(iapResponse("MISSING_METADATA"))
      .mockResolvedValueOnce(iapResponse("MISSING_METADATA"))
      .mockResolvedValueOnce(iapResponse("READY_TO_SUBMIT"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await pollIapReadyForSubmit({
      creds,
      appleIapId: "iap-1",
      config: { intervalMs: 200, maxAttempts: 10, sleep },
    });
    expect(out.ready).toBe(true);
    if (out.ready) {
      expect(out.attempts).toBe(3);
      expect(out.final_state).toBe("READY_TO_SUBMIT");
    }
  });

  it("gives up after maxAttempts, surfacing the last non-ready state seen", async () => {
    iapFetch
      .mockResolvedValueOnce(iapResponse("MISSING_METADATA"))
      .mockResolvedValueOnce(iapResponse("MISSING_METADATA"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await pollIapReadyForSubmit({
      creds,
      appleIapId: "iap-1",
      config: { intervalMs: 10, maxAttempts: 2, sleep },
    });
    expect(out.ready).toBe(false);
    if (!out.ready) {
      expect(out.last_seen_state).toBe("MISSING_METADATA");
      expect(out.reason).toContain("MISSING_METADATA");
    }
  });

  it("has no last_seen_state when every attempt errors (e.g. persistent 404)", async () => {
    const make404 = () =>
      new AppleApiError(404, "GET", "/v2/inAppPurchases/iap-1", "NOT_FOUND");
    iapFetch.mockRejectedValueOnce(make404()).mockRejectedValueOnce(make404());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await pollIapReadyForSubmit({
      creds,
      appleIapId: "iap-1",
      config: { intervalMs: 10, maxAttempts: 2, sleep },
    });
    expect(out.ready).toBe(false);
    if (!out.ready) {
      expect(out.last_seen_state).toBeUndefined();
      expect(out.reason).toContain("404");
    }
  });
});
