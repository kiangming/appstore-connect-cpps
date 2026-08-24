/**
 * fetchExportSources — bounded-concurrency per-IAP export fetch with
 * failure isolation. Deps are injected fakes so this exercises the
 * isolation/degrade logic without a live Apple call.
 */
import { describe, it, expect, vi } from "vitest";

import { fetchExportSources } from "./export-fetch";
import { AppleApiError, AppleRateLimitError } from "./fetch";
import type { InAppPurchase, InAppPurchaseLocalization, AscApiResponse, InAppPurchasePriceSchedule } from "@/types/iap-management/apple";
import type { AscCredentials } from "@/lib/asc-jwt";

const creds = {} as AscCredentials;

function iap(id: string, productId: string, state = "APPROVED"): InAppPurchase {
  return {
    type: "inAppPurchases",
    id,
    attributes: { name: `Ref ${productId}`, productId, inAppPurchaseType: "CONSUMABLE", state },
  } as InAppPurchase;
}

function localization(locale: string, name: string, description = ""): InAppPurchaseLocalization {
  return {
    type: "inAppPurchaseLocalizations",
    id: `loc-${locale}`,
    attributes: { locale, name, description },
  } as InAppPurchaseLocalization;
}

function scheduleResponse(baseTerritory: string): AscApiResponse<InAppPurchasePriceSchedule> {
  return {
    data: {
      type: "inAppPurchasePriceSchedules",
      id: "sched-1",
      relationships: { baseTerritory: { data: { id: baseTerritory } } },
    } as unknown as InAppPurchasePriceSchedule,
    included: [],
  };
}

describe("fetchExportSources", () => {
  it("builds an ExportSource per IAP from the injected detail + schedule fetches", async () => {
    const getIapDetail = vi.fn().mockResolvedValue({
      iap: iap("a1", "com.x.a"),
      localizations: [localization("en-US", "A", "Desc A")],
      screenshot: null,
    });
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const result = await fetchExportSources(creds, [iap("a1", "com.x.a")], {
      getIapDetail,
      getPriceScheduleForIap,
    });

    expect(result.failures).toEqual([]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].productId).toBe("com.x.a");
    expect(result.sources[0].skuName).toBe("Ref com.x.a");
    expect(result.sources[0].status).toBe("APPROVED");
    expect(result.sources[0].priceSchedule?.baseTerritory).toBe("USA");
    expect(result.sources[0].localizations).toEqual([
      { locale: "en-US", displayName: "A", description: "Desc A" },
    ]);
  });

  it("skips an IAP whose critical detail fetch fails, with a warning — doesn't fail the export", async () => {
    const getIapDetail = vi
      .fn()
      .mockResolvedValueOnce({
        iap: iap("ok-1", "com.x.ok"),
        localizations: [],
        screenshot: null,
      })
      .mockRejectedValueOnce(new AppleApiError(500, "GET", "/v2/inAppPurchases/bad-1", "boom"));
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const result = await fetchExportSources(
      creds,
      [iap("ok-1", "com.x.ok"), iap("bad-1", "com.x.bad")],
      { getIapDetail, getPriceScheduleForIap },
    );

    expect(result.sources.map((s) => s.productId)).toEqual(["com.x.ok"]);
    expect(result.failures).toEqual([
      {
        productId: "com.x.bad",
        appleIapId: "bad-1",
        // `kind` is new in this commit: a 500 is Apple refusing, which the
        // failure sheet must not word like a rate limit.
        kind: "APPLE_ERROR",
        error: "500: boom",
      },
    ]);
  });

  it("degrades to blank pricing (priceSchedule: null) on a price-schedule 404 — row still included", async () => {
    const getIapDetail = vi.fn().mockResolvedValue({
      iap: iap("a1", "com.x.a"),
      localizations: [],
      screenshot: null,
    });
    const getPriceScheduleForIap = vi
      .fn()
      .mockRejectedValue(new AppleApiError(404, "GET", "/v2/inAppPurchases/a1/iapPriceSchedule", "not found"));

    const result = await fetchExportSources(creds, [iap("a1", "com.x.a")], {
      getIapDetail,
      getPriceScheduleForIap,
    });

    expect(result.failures).toEqual([]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].priceSchedule).toBeNull();
  });

  it("degrades to blank pricing on a non-404 price-schedule error too — row still included", async () => {
    const getIapDetail = vi.fn().mockResolvedValue({
      iap: iap("a1", "com.x.a"),
      localizations: [],
      screenshot: null,
    });
    const getPriceScheduleForIap = vi
      .fn()
      .mockRejectedValue(new AppleApiError(500, "GET", "/v2/inAppPurchases/a1/iapPriceSchedule", "boom"));

    const result = await fetchExportSources(creds, [iap("a1", "com.x.a")], {
      getIapDetail,
      getPriceScheduleForIap,
    });

    expect(result.failures).toEqual([]);
    expect(result.sources[0].priceSchedule).toBeNull();
  });

  it("respects bounded concurrency — never more than `concurrency` in flight at once", async () => {
    const CONCURRENCY = 2;
    let inFlight = 0;
    let maxInFlight = 0;
    const getIapDetail = vi.fn().mockImplementation(async (_c, id: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { iap: iap(id, `com.x.${id}`), localizations: [], screenshot: null };
    });
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const items = Array.from({ length: 6 }, (_, i) => iap(`id-${i}`, `com.x.${i}`));
    const result = await fetchExportSources(creds, items, {
      getIapDetail,
      getPriceScheduleForIap,
      concurrency: CONCURRENCY,
    });

    expect(result.sources).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(CONCURRENCY);
  });

  it("isolates multiple failures — every other IAP still exports", async () => {
    const getIapDetail = vi.fn().mockImplementation(async (_c, id: string) => {
      if (id === "bad-1" || id === "bad-2") {
        throw new AppleApiError(500, "GET", `/v2/inAppPurchases/${id}`, "boom");
      }
      return { iap: iap(id, `com.x.${id}`), localizations: [], screenshot: null };
    });
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const result = await fetchExportSources(
      creds,
      [iap("ok-1", "com.x.ok-1"), iap("bad-1", "com.x.bad-1"), iap("ok-2", "com.x.ok-2"), iap("bad-2", "com.x.bad-2")],
      { getIapDetail, getPriceScheduleForIap },
    );

    expect(result.sources.map((s) => s.productId).sort()).toEqual(["com.x.ok-1", "com.x.ok-2"]);
    expect(result.failures).toHaveLength(2);
  });
});

/**
 * BEHAVIOURAL counterpart to `retry-composition.structural.test.ts`.
 *
 * The structural test proves ONE `withRetry` lexically encloses the detail
 * read. It cannot prove that wrapper actually retries, or how many times, or
 * that it stays off non-429s. Chunk 3's stop latch will treat an escaping
 * `AppleRateLimitError` as "Apple's budget is gone, stop the pool" — a claim
 * that is only true if a transient 429 was already absorbed here. So the
 * attempt counts are pinned at runtime, not inferred from the wrapper count.
 *
 * ⚠ SPIES, NOT CANNED MOCKS. Each fake is a real function that increments a
 * counter, because the assertion IS the call count.
 *
 * ⚠ FRESH ERROR PER THROW. Re-throwing one `Error` instance across retry
 * attempts produces spurious failures under vitest (KB: the mock-reject reuse
 * gotcha) — every rejection below constructs a new one.
 *
 * ⚠ WHY THESE RUN FAST WITHOUT FAKE TIMERS. `withRetry` sleeps
 * `Math.min(err.retryAfterMs ?? backoff[attempt], 10_000)`, so an error
 * carrying `retryAfterMs: 0` yields `sleep(0)` and the backoff curve
 * collapses to nothing while the ATTEMPT COUNT — the thing under test — is
 * untouched. Same trick `client.test.ts:409-412` already uses. The production
 * call site passes no `RetryOptions`, and this test does not change that:
 * nothing about `withRetry` or `export-fetch` was altered to make it testable.
 */
describe("fetchExportSources — retry semantics on the detail read (Chunk 3 depends on these)", () => {
  const rateLimited = () =>
    new AppleRateLimitError("GET", "/v2/inAppPurchases/a1", "rate limited", 0);

  it("(i) absorbs a transient 429 — 2 failures then success = 3 calls, item exports", async () => {
    let calls = 0;
    const getIapDetail = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw rateLimited();
      return {
        iap: iap("a1", "com.x.a"),
        localizations: [localization("en-US", "A")],
        screenshot: null,
      };
    });
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const result = await fetchExportSources(creds, [iap("a1", "com.x.a")], {
      getIapDetail,
      getPriceScheduleForIap,
    });

    // If this fails, withRetry is not composed around the detail read at all
    // (export-fetch.ts:103) — the exact defect this chunk fixed.
    expect(calls).toBe(3);
    expect(getIapDetail).toHaveBeenCalledTimes(3);
    expect(result.failures).toEqual([]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].productId).toBe("com.x.a");
  });

  it("(ii) a 429 that survives every attempt = exactly 4 calls, isolated to its own item", async () => {
    // 4 = withRetry's ceiling: `for (attempt = 0; attempt <= backoff.length)`
    // with DEFAULT_BACKOFF_MS = [500, 1000, 2000] (apple-fetch.ts:23,109).
    // Pinning the number means a change to that budget cannot pass unnoticed.
    let badCalls = 0;
    const getIapDetail = vi.fn(async (_c: unknown, id: string) => {
      if (id === "bad") {
        badCalls += 1;
        throw rateLimited();
      }
      return {
        iap: iap(id, `com.x.${id}`),
        localizations: [localization("en-US", id)],
        screenshot: null,
      };
    });
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const result = await fetchExportSources(
      creds,
      [iap("ok1", "com.x.ok1"), iap("bad", "com.x.bad"), iap("ok2", "com.x.ok2")],
      { getIapDetail, getPriceScheduleForIap },
    );

    expect(badCalls).toBe(4);

    // The exhausted 429 lands in the per-item catch as a recorded failure —
    // this is the signal Chunk 3's latch will key on, and it means "retried
    // and still refused", never "one un-retried 429".
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].appleIapId).toBe("bad");
    expect(result.failures[0].error).toContain("429");

    // Failure isolation: the other two are untouched and still export.
    expect(result.sources.map((s) => s.productId).sort()).toEqual([
      "com.x.ok1",
      "com.x.ok2",
    ]);
  });

  it("(iii) a NON-429 is not retried — exactly 1 call", async () => {
    // Guards the other direction: `withRetry` retries ONLY
    // AppleRateLimitError (apple-fetch.ts:113-115). If someone later
    // "improves" it into a blind retry-any-error, export would multiply every
    // 500 by 4 against the endpoint whose whole problem is request budget —
    // and without this test, nothing would say so.
    let calls = 0;
    const getIapDetail = vi.fn(async () => {
      calls += 1;
      throw new AppleApiError(500, "GET", "/v2/inAppPurchases/a1", "boom");
    });
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const result = await fetchExportSources(creds, [iap("a1", "com.x.a")], {
      getIapDetail,
      getPriceScheduleForIap,
    });

    expect(calls).toBe(1);
    expect(result.sources).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain("500");
  });
});

/**
 * G4b — the price read no longer degrades silently.
 *
 * ⚠ `priceSchedule: null` used to mean two different things: "Apple has no
 * schedule" and "we could not read it". Both rendered identical blank price
 * cells, and because the workbook's territory columns are the union of
 * territories WITH a price, a territory priced only on throttled rows
 * disappeared from the file with no trace at all. These tests pin the split.
 */
describe("fetchExportSources — price-read classification (G4b)", () => {
  const detailOk = (id: string) =>
    vi.fn(async () => ({
      iap: iap(id, `com.x.${id}`),
      localizations: [localization("en-US", id)],
      screenshot: null,
    }));

  it("a 404 is NOT a failure — it is the legitimate no-schedule case", async () => {
    // Verified through both stages: neither getPriceScheduleForIap nor
    // fetchManualPricesPaginated catches, and appleFetch throws
    // AppleApiError(404). So 404 arrives at the catch and is recognised there.
    const getPriceScheduleForIap = vi
      .fn()
      .mockRejectedValue(new AppleApiError(404, "GET", "/sched", "not found"));

    const r = await fetchExportSources(creds, [iap("a1", "com.x.a1")], {
      getIapDetail: detailOk("a1"),
      getPriceScheduleForIap,
    });

    expect(r.sources).toHaveLength(1);
    expect(r.sources[0].priceSchedule).toBeNull();
    expect(r.sources[0].priceReadFailure).toBeNull(); // ← the whole point
    expect(r.failures).toEqual([]);
    expect(r.stopped).toBe(false);
  });

  it("a rate-limited price read keeps the row but records RATE_LIMITED", async () => {
    const getPriceScheduleForIap = vi
      .fn()
      .mockRejectedValue(new AppleRateLimitError("GET", "/sched", "slow down", 0));

    const r = await fetchExportSources(creds, [iap("a1", "com.x.a1")], {
      getIapDetail: detailOk("a1"),
      getPriceScheduleForIap,
    });

    // The row still exports — product id, name, status, localizations are real.
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0].productId).toBe("com.x.a1");
    expect(r.sources[0].priceSchedule).toBeNull();
    // ...but the blank prices now carry their reason.
    expect(r.sources[0].priceReadFailure).toMatchObject({
      kind: "RATE_LIMITED",
      status: 429,
    });
  });

  it("a non-404 Apple error records APPLE_ERROR with its status, not RATE_LIMITED", async () => {
    const getPriceScheduleForIap = vi
      .fn()
      .mockRejectedValue(new AppleApiError(403, "GET", "/sched", "forbidden"));

    const r = await fetchExportSources(creds, [iap("a1", "com.x.a1")], {
      getIapDetail: detailOk("a1"),
      getPriceScheduleForIap,
    });

    expect(r.sources[0].priceReadFailure).toMatchObject({
      kind: "APPLE_ERROR",
      status: 403,
    });
    expect(r.sources[0].priceReadFailure?.kind).not.toBe("RATE_LIMITED");
  });

  it("a non-Apple throw records UNKNOWN — neither of the other two may be claimed", async () => {
    const getPriceScheduleForIap = vi.fn().mockRejectedValue(new TypeError("socket hang up"));

    const r = await fetchExportSources(creds, [iap("a1", "com.x.a1")], {
      getIapDetail: detailOk("a1"),
      getPriceScheduleForIap,
    });

    expect(r.sources[0].priceReadFailure).toMatchObject({ kind: "UNKNOWN" });
    expect(r.sources[0].priceReadFailure?.status).toBeUndefined();
  });
});

/**
 * G4a — the pool stops dispatching once a 429 has survived retry.
 *
 * ⚠ The assertions are on the SPY, not on the result set. A pool that keeps
 * firing requests into an API already returning 429 produces the same-looking
 * failure rows; only the call count shows the budget being burned.
 */
describe("fetchExportSources — stop latch (G4a)", () => {
  const okDetail = async (_c: unknown, id: string) => ({
    iap: iap(id, `com.x.${id}`),
    localizations: [localization("en-US", id)],
    screenshot: null,
  });

  it("a 429 surviving retry on the DETAIL read stops the run; later items are NOT_ATTEMPTED with zero Apple calls", async () => {
    const seen: string[] = [];
    const getIapDetail = vi.fn(async (c: unknown, id: string) => {
      seen.push(id);
      if (id === "b") throw new AppleRateLimitError("GET", "/iap/b", "slow down", 0);
      return okDetail(c, id);
    });
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const r = await fetchExportSources(
      creds,
      [iap("a", "com.x.a"), iap("b", "com.x.b"), iap("c", "com.x.c"), iap("d", "com.x.d")],
      { getIapDetail, getPriceScheduleForIap, concurrency: 1 },
    );

    expect(r.stopped).toBe(true);
    // c and d were never sent to Apple at all. Distinct ids, because `b` is
    // legitimately attempted 4 times — Chunk 1's single withRetry — and that
    // count is itself asserted below so the retry budget stays pinned here too.
    expect([...new Set(seen)]).toEqual(["a", "b"]);
    expect(seen.filter((id) => id === "b")).toHaveLength(4);
    expect(seen).not.toContain("c");
    expect(seen).not.toContain("d");
    expect(r.sources.map((s) => s.productId)).toEqual(["com.x.a"]);
    expect(r.failures).toEqual([
      { productId: "com.x.b", appleIapId: "b", kind: "RATE_LIMITED", error: expect.any(String) },
      {
        productId: "com.x.c",
        appleIapId: "c",
        kind: "NOT_ATTEMPTED",
        error: "Export stopped before this item — nothing was sent.",
      },
      {
        productId: "com.x.d",
        appleIapId: "d",
        kind: "NOT_ATTEMPTED",
        error: "Export stopped before this item — nothing was sent.",
      },
    ]);
  });

  it("⚠ a 429 on the PRICE read also stops the run — the latch is not deaf to 2 of the 3 requests per item", async () => {
    // The price read does not throw (a missing price must not delete a usable
    // row), so its rate limit rides back on a SUCCESSFUL result. A latch wired
    // only to the throwing read would miss it — and the price read is two of
    // the three Apple requests each item costs.
    const detailSeen: string[] = [];
    const getIapDetail = vi.fn(async (c: unknown, id: string) => {
      detailSeen.push(id);
      return okDetail(c, id);
    });
    const getPriceScheduleForIap = vi.fn(async (_c: unknown, id: string) => {
      if (id === "a") throw new AppleRateLimitError("GET", "/sched/a", "slow down", 0);
      return scheduleResponse("USA");
    });

    const r = await fetchExportSources(
      creds,
      [iap("a", "com.x.a"), iap("b", "com.x.b"), iap("c", "com.x.c")],
      { getIapDetail, getPriceScheduleForIap, concurrency: 1 },
    );

    expect(r.stopped).toBe(true);
    expect(detailSeen).toEqual(["a"]); // b and c never touched Apple
    // ...and item `a` is still exported, as PARTIAL — the two decisions are
    // independent: the row is usable, the budget is gone.
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0].priceReadFailure).toMatchObject({ kind: "RATE_LIMITED" });
    expect(r.failures.map((f) => f.kind)).toEqual(["NOT_ATTEMPTED", "NOT_ATTEMPTED"]);
  });

  it("a non-429 failure does NOT stop the run — one bad row is not a halted batch", async () => {
    const getIapDetail = vi.fn(async (c: unknown, id: string) => {
      if (id === "b") throw new AppleApiError(404, "GET", "/iap/b", "gone");
      return okDetail(c, id);
    });
    const getPriceScheduleForIap = vi.fn().mockResolvedValue(scheduleResponse("USA"));

    const r = await fetchExportSources(
      creds,
      [iap("a", "com.x.a"), iap("b", "com.x.b"), iap("c", "com.x.c")],
      { getIapDetail, getPriceScheduleForIap, concurrency: 1 },
    );

    expect(r.stopped).toBe(false);
    expect(r.sources.map((s) => s.productId)).toEqual(["com.x.a", "com.x.c"]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].kind).toBe("APPLE_ERROR");
  });

  it("a clean run reports stopped:false and no failures", async () => {
    const r = await fetchExportSources(
      creds,
      [iap("a", "com.x.a"), iap("b", "com.x.b")],
      {
        getIapDetail: vi.fn(okDetail),
        getPriceScheduleForIap: vi.fn().mockResolvedValue(scheduleResponse("USA")),
      },
    );
    expect(r).toMatchObject({ stopped: false, failures: [] });
    expect(r.sources).toHaveLength(2);
  });
});
