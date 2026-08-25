/**
 * C2 — the line between "Apple throttled us" and "Apple's budget is gone".
 *
 * Bulk Import has counted 429s since Hotfix 26, but that counter says only
 * that a 429 HAPPENED — it is incremented from `withRetry`'s onRetry hook,
 * which fires on the throttles that then succeed. Using it as a stop signal
 * would halt a batch every time Apple hiccuped and recovered.
 *
 * `exhausted` is the different fact, and these tests exist to keep the two
 * from drifting back together.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createRetryCounters,
  trackedWithRetry,
  rowExhaustedRateLimitBudget,
} from "./retry-counters";
import {
  AppleApiError,
  AppleRateLimitError,
} from "@/lib/iap-management/apple/fetch";

const rl = () => new AppleRateLimitError("POST", "/x", "", null);
/** Immediate sleeper so the real backoff curve runs without real waiting. */
const noSleep = { sleep: vi.fn().mockResolvedValue(undefined) };

vi.mock("@/lib/iap-management/apple/fetch", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/iap-management/apple/fetch")
  >("@/lib/iap-management/apple/fetch");
  return {
    ...actual,
    // Inject the no-op sleeper into every withRetry call made by
    // trackedWithRetry, which does not expose retry options of its own.
    withRetry: <T,>(fn: () => Promise<T>, opts: object = {}) =>
      actual.withRetry(fn, { ...opts, ...noSleep }),
  };
});

describe("trackedWithRetry — exhausted vs rate429_count", () => {
  it("⚠ a 429 that RECOVERS does NOT set exhausted — this is the Hotfix 26 boundary", async () => {
    const c = createRetryCounters();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rl())
      .mockResolvedValueOnce("ok");

    await expect(trackedWithRetry(c, fn)).resolves.toBe("ok");

    // The throttle IS recorded — that telemetry is unchanged and still true.
    expect(c.rate429_count).toBe(1);
    // But the budget was not exhausted, so the batch must keep going.
    expect(c.exhausted).toBe(false);
  });

  it("a 429 that survives the whole curve DOES set exhausted", async () => {
    const c = createRetryCounters();
    const fn = vi.fn().mockRejectedValue(rl());

    await expect(trackedWithRetry(c, fn)).rejects.toBeInstanceOf(
      AppleRateLimitError,
    );

    expect(fn).toHaveBeenCalledTimes(4); // 1 + 3 retries
    expect(c.exhausted).toBe(true);
  });

  it("⚠ RE-THROWS — the caller's own catch must still run", async () => {
    // The whole C2/C3 boundary rests on this. Every stage in orchestrateOne
    // swallows its error to keep the row going; if trackedWithRetry swallowed
    // it first, those stages would silently believe they had succeeded and a
    // half-built row would report SUCCESS. Recording the fact must not change
    // the control flow.
    const c = createRetryCounters();
    const err = rl();
    await expect(trackedWithRetry(c, vi.fn().mockRejectedValue(err))).rejects.toBe(
      err,
    );
    expect(c.exhausted).toBe(true);
  });

  it("a NON-429 failure sets neither counter, and still propagates", async () => {
    const c = createRetryCounters();
    const err = new AppleApiError(409, "POST", "/x", "conflict");
    await expect(trackedWithRetry(c, vi.fn().mockRejectedValue(err))).rejects.toBe(
      err,
    );
    expect(c.exhausted).toBe(false);
    expect(c.rate429_count).toBe(0);
  });

  it("a clean call leaves every counter at zero", async () => {
    const c = createRetryCounters();
    await expect(
      trackedWithRetry(c, vi.fn().mockResolvedValue("ok")),
    ).resolves.toBe("ok");
    expect(c).toEqual(createRetryCounters());
  });

  it("counters accumulate across a row's stages — one bag, many calls", async () => {
    // Stage 1 throttles then recovers; stage 2 exhausts. The row should end
    // up with both facts, not just the last one.
    const c = createRetryCounters();
    await trackedWithRetry(
      c,
      vi.fn().mockRejectedValueOnce(rl()).mockResolvedValueOnce("ok"),
    );
    expect(c.exhausted).toBe(false);
    await expect(
      trackedWithRetry(c, vi.fn().mockRejectedValue(rl())),
    ).rejects.toBeInstanceOf(AppleRateLimitError);
    expect(c.exhausted).toBe(true);
    expect(c.rate429_count).toBeGreaterThan(1);
  });
});

describe("rowExhaustedRateLimitBudget — the pool's stop predicate", () => {
  it("true only when the row's counters say the budget ran out", () => {
    expect(
      rowExhaustedRateLimitBudget({
        rate_limit: { ...createRetryCounters(), exhausted: true },
      }),
    ).toBe(true);
  });

  it("⚠ FALSE for a row that was throttled and recovered", () => {
    expect(
      rowExhaustedRateLimitBudget({
        rate_limit: { ...createRetryCounters(), rate429_count: 7 },
      }),
    ).toBe(false);
  });

  it("false when a row carries no counters at all (never reached Apple)", () => {
    expect(rowExhaustedRateLimitBudget({})).toBe(false);
  });
});
