/**
 * Tests for IAP.q.2 submit-eligibility — the fix for bulk-import's
 * create→submit 409 (missing appStoreReviewScreenshot relationship +
 * IAP_SUBMISSION_NOT_ALLOWED). Confirms:
 *   - a ready IAP (Apple reports READY_TO_SUBMIT) is eligible
 *   - a not-yet-ready IAP is NOT eligible (deferred, not submitted)
 *   - the decision genuinely routes through `partitionByStateGuard` — the
 *     SAME function submit-batch's Cycle 32 state-guard uses — rather than
 *     a parallel reimplementation (twin-path convergence).
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

const partitionByStateGuardSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/submit-batch/bucket", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/iap-management/submit-batch/bucket")
  >("@/lib/iap-management/submit-batch/bucket");
  return {
    ...actual,
    partitionByStateGuard: (
      ...args: Parameters<typeof actual.partitionByStateGuard>
    ) => {
      partitionByStateGuardSpy(...args);
      return actual.partitionByStateGuard(...args);
    },
  };
});

import { checkSubmitEligibility } from "./submit-eligibility";
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

describe("checkSubmitEligibility", () => {
  beforeEach(() => {
    iapFetch.mockReset();
    partitionByStateGuardSpy.mockClear();
  });

  it("is eligible once the poll observes READY_TO_SUBMIT", async () => {
    iapFetch
      .mockResolvedValueOnce(iapResponse("MISSING_METADATA"))
      .mockResolvedValueOnce(iapResponse("READY_TO_SUBMIT"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await checkSubmitEligibility({
      creds,
      appleIapId: "iap-1",
      pollConfig: { intervalMs: 10, maxAttempts: 5, sleep },
    });
    expect(out.eligible).toBe(true);
    expect(out.fresh_state).toBe("READY_TO_SUBMIT");
    expect(out.poll.ready).toBe(true);
    // Twin-path convergence: the decision genuinely went through
    // partitionByStateGuard with the fresh state, not a parallel check.
    expect(partitionByStateGuardSpy).toHaveBeenCalledTimes(1);
    expect(partitionByStateGuardSpy).toHaveBeenCalledWith(
      [{ id: "iap-1", apple_iap_id: "iap-1" }],
      new Map([["iap-1", "READY_TO_SUBMIT"]]),
    );
  });

  it("is NOT eligible when Apple never reports READY_TO_SUBMIT within the poll window (deferred, not an error)", async () => {
    iapFetch
      .mockResolvedValueOnce(iapResponse("MISSING_METADATA"))
      .mockResolvedValueOnce(iapResponse("MISSING_METADATA"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await checkSubmitEligibility({
      creds,
      appleIapId: "iap-1",
      pollConfig: { intervalMs: 10, maxAttempts: 2, sleep },
    });
    expect(out.eligible).toBe(false);
    expect(out.fresh_state).toBe("MISSING_METADATA");
    expect(out.poll.ready).toBe(false);
    expect(partitionByStateGuardSpy).toHaveBeenCalledWith(
      [{ id: "iap-1", apple_iap_id: "iap-1" }],
      new Map([["iap-1", "MISSING_METADATA"]]),
    );
  });

  it("falls back to fresh_state=UNKNOWN (still deferred, not eligible) when every poll attempt errors", async () => {
    const make404 = () =>
      new AppleApiError(404, "GET", "/v2/inAppPurchases/iap-1", "NOT_FOUND");
    iapFetch.mockRejectedValueOnce(make404()).mockRejectedValueOnce(make404());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await checkSubmitEligibility({
      creds,
      appleIapId: "iap-1",
      pollConfig: { intervalMs: 10, maxAttempts: 2, sleep },
    });
    expect(out.eligible).toBe(false);
    expect(out.fresh_state).toBe("UNKNOWN");
  });
});
