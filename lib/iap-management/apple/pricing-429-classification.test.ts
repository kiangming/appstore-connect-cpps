/**
 * [PRICING-429-no-retry] — make the pricing stage's rate limits VISIBLE
 * without changing a single retry decision.
 *
 * ⚠ THE INVARIANT THIS COMMIT PROMISED IS AN ATTEMPT COUNT, so the first
 * describe below asserts exactly that: for 429, for 500, and for a mixed
 * sequence, the number of Apple calls after classification equals the number
 * before. "No attempt matrix to get wrong" is only a claim until a spy counts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const iapFetch = vi.hoisted(() => vi.fn());
vi.mock("./fetch", async () => {
  const actual = await vi.importActual<typeof import("./fetch")>("./fetch");
  return { ...actual, iapFetch };
});

import { setPriceSchedule, classifyPricingFailure } from "./price-schedules";
import { AppleApiError, AppleRateLimitError } from "./fetch";
import type { AscCredentials } from "@/lib/asc-jwt";

const creds = {} as AscCredentials;
const args = { appleIapId: "iap-1", applePricePointId: "pp-1" };
/** Deterministic + instant: real curve, no real waiting, no jitter noise. */
const fast = { sleep: vi.fn().mockResolvedValue(undefined), jitterRatio: 0, rng: () => 0.5 };

beforeEach(() => {
  iapFetch.mockReset();
  fast.sleep.mockClear();
});

const rateLimit = () => new AppleRateLimitError("POST", "/v1/x", "", null);
const serverErr = () => new AppleApiError(500, "POST", "/v1/x", "UNEXPECTED_ERROR");
const conflict = () => new AppleApiError(409, "POST", "/v1/x", "conflict");

describe("⚠ ATTEMPT COUNTS ARE UNCHANGED — the promise of this commit", () => {
  it("429 → still exactly ONE call (deliberately not retried)", async () => {
    iapFetch.mockRejectedValue(rateLimit());
    const r = await setPriceSchedule(creds, { ...args, retryConfig: fast });
    expect(iapFetch).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
  });

  it("500 → still SIX calls (1 + the five-delay curve)", async () => {
    iapFetch.mockRejectedValue(serverErr());
    await setPriceSchedule(creds, { ...args, retryConfig: fast });
    expect(iapFetch).toHaveBeenCalledTimes(6);
  });

  it("409 → still exactly ONE call (retry cannot fix a payload)", async () => {
    iapFetch.mockRejectedValue(conflict());
    await setPriceSchedule(creds, { ...args, retryConfig: fast });
    expect(iapFetch).toHaveBeenCalledTimes(1);
  });

  it("⚠ MIXED 500-then-429 → the 429 ENDS it; the 5xx budget is not shared with it", async () => {
    // This is the case the census flagged as the double-wrap risk of the
    // rejected alternative (wrap-and-throw). PA-C never wraps, so a 429
    // simply stops the loop where it lands: two 500s, then the 429.
    iapFetch
      .mockRejectedValueOnce(serverErr())
      .mockRejectedValueOnce(serverErr())
      .mockRejectedValue(rateLimit());
    await setPriceSchedule(creds, { ...args, retryConfig: fast });
    expect(iapFetch).toHaveBeenCalledTimes(3);
  });

  it("a success on the third attempt still costs three, not six", async () => {
    iapFetch
      .mockRejectedValueOnce(serverErr())
      .mockRejectedValueOnce(serverErr())
      .mockResolvedValueOnce({ data: { id: "sched-1", type: "x" } });
    const r = await setPriceSchedule(creds, { ...args, retryConfig: fast });
    expect(iapFetch).toHaveBeenCalledTimes(3);
    expect(r.ok).toBe(true);
  });
});

describe("classification happens at the catch, where instanceof still works", () => {
  it("a 429 is RATE_LIMITED", async () => {
    iapFetch.mockRejectedValue(rateLimit());
    const r = await setPriceSchedule(creds, { ...args, retryConfig: fast });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("RATE_LIMITED");
  });

  it("a 500 is APPLE_5XX, not RATE_LIMITED", async () => {
    iapFetch.mockRejectedValue(serverErr());
    const r = await setPriceSchedule(creds, { ...args, retryConfig: fast });
    if (!r.ok) expect(r.kind).toBe("APPLE_5XX");
  });

  it("a 409 is APPLE_ERROR", async () => {
    iapFetch.mockRejectedValue(conflict());
    const r = await setPriceSchedule(creds, { ...args, retryConfig: fast });
    if (!r.ok) expect(r.kind).toBe("APPLE_ERROR");
  });

  it("a non-Apple throw is UNKNOWN — neither of the others may be claimed", async () => {
    iapFetch.mockRejectedValue(new TypeError("fetch failed"));
    const r = await setPriceSchedule(creds, { ...args, retryConfig: fast });
    if (!r.ok) expect(r.kind).toBe("UNKNOWN");
  });

  it("the LAST error decides — mixed 500s then a 429 classifies as RATE_LIMITED", async () => {
    iapFetch.mockRejectedValueOnce(serverErr()).mockRejectedValue(rateLimit());
    const r = await setPriceSchedule(creds, { ...args, retryConfig: fast });
    if (!r.ok) expect(r.kind).toBe("RATE_LIMITED");
  });
});

describe("⚠ classifyPricingFailure reads TYPES, never message text", () => {
  it('an error whose MESSAGE contains "429" but is not a rate limit is NOT RATE_LIMITED', async () => {
    // The exact trap a `/429/.test(err.message)` implementation falls into,
    // and the same one `/404/.test(err.message)` created in the custom-prices
    // baseline route before it was removed. Apple's own error bodies and URLs
    // routinely carry digits.
    const decoy = new AppleApiError(
      422,
      "POST",
      "/v1/inAppPurchasePriceSchedules",
      'ENTITY_ERROR: price point 429 is not valid for territory USA',
    );
    expect(classifyPricingFailure(decoy)).toBe("APPLE_ERROR");
    expect(decoy.message).toContain("429");
  });

  it('a 500 whose body mentions "429" is still APPLE_5XX', async () => {
    const decoy = new AppleApiError(500, "POST", "/v1/x", "UNEXPECTED_ERROR ref 429");
    expect(classifyPricingFailure(decoy)).toBe("APPLE_5XX");
  });

  it("a real rate limit is RATE_LIMITED even with an empty body", () => {
    expect(classifyPricingFailure(new AppleRateLimitError("POST", "/v1/x", "", null))).toBe(
      "RATE_LIMITED",
    );
  });
});
