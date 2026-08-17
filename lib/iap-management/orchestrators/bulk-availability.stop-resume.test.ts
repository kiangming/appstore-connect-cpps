/**
 * SC3 — stop-and-preserve on rate-limit exhaustion (Manager decision 3).
 *
 * The invariants under test, in order of how badly getting them wrong
 * would hurt:
 *
 *   1. A SUCCESS is never re-sent on resume. A re-POST to
 *      /v1/inAppPurchaseAvailabilities is a FULL REPLACE, so re-running a
 *      successful item is a real Apple write — not an idempotent no-op.
 *   2. NOT_ATTEMPTED is its own state. Folding it into FAILED would tell
 *      Manager that 85 items broke when nothing was sent for them, and
 *      would make the remainder unsafe to resume blindly.
 *   3. Only rate-limit exhaustion stops the run. Fail-soft (Q-K) still
 *      governs everything else.
 *   4. Exactly one withRetry. The attempt count is asserted so a second
 *      wrapper (the sync-states:91 x client.ts:70 double-wrap) cannot be
 *      added silently.
 *   5. No audit row for an item that was never attempted.
 *
 * `withRetry` is REAL here, not mocked — the attempt-count assertion is
 * worthless against a stubbed retry. AppleRateLimitError carries
 * retryAfterMs=1 so the real backoff sleeps ~3ms total instead of 3.5s.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppleRateLimitError } from "@/lib/iap-management/apple/fetch";

const setAvailabilityTerritories = vi.hoisted(() => vi.fn());
const getAllTerritoryIds = vi.hoisted(() => vi.fn());
const auditInsert = vi.hoisted(() => vi.fn());

vi.mock("@/lib/iap-management/apple/availabilities", () => ({
  setAvailabilityTerritories,
  getAllTerritoryIds,
}));
vi.mock("@/lib/iap-management/db", () => ({
  iapDb: () => ({
    from: (table: string) => {
      if (table === "iaps") {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) =>
              Promise.resolve({
                data: ids.map((id) => ({
                  id,
                  apple_iap_id: id.startsWith("draft-") ? null : `APL_${id}`,
                })),
                error: null,
              }),
          }),
        };
      }
      return {
        insert: (row: Record<string, unknown>) => {
          auditInsert(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  }),
}));

import { executeBulkAvailability } from "./bulk-availability";

const creds = {
  id: "t",
  name: "T",
  keyId: "k",
  issuerId: "i",
  privateKey: "p",
} as never;

const CATALOGUE = ["USA", "VNM", "JPN"];
const SELECTION = {
  territoryIds: ["VNM", "JPN"],
  availableInNewTerritories: false,
};

/** Fresh instance per call — reusing one Error across mockRejectedValueOnce
 *  chains causes spurious failures (memory: feedback_vitest_mock_rejected). */
const rateLimit = () =>
  new AppleRateLimitError("POST", "/v1/inAppPurchaseAvailabilities", "", 1);

/** Serial execution so "row 2 stops the run" is deterministic. */
const SERIAL = 1;

function run(iapIds: string[], extra: Record<string, unknown> = {}) {
  return executeBulkAvailability({
    creds,
    iapIds,
    action: "set-territories",
    selection: SELECTION,
    actor: "tester",
    concurrency: SERIAL,
    ...extra,
  });
}

beforeEach(() => {
  setAvailabilityTerritories.mockReset();
  getAllTerritoryIds.mockReset();
  getAllTerritoryIds.mockResolvedValue(CATALOGUE);
  auditInsert.mockReset();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("rate-limit exhaustion mid-batch stops the run", () => {
  it("splits the batch into three DISTINCT sets with correct membership", async () => {
    setAvailabilityTerritories
      .mockResolvedValueOnce({ data: { id: "av-1" } }) // row-1 succeeds
      .mockRejectedValueOnce(rateLimit()) // row-2: 4 attempts…
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit()) // …then exhausted ⇒ STOP
      .mockResolvedValue({ data: { id: "never" } }); // must never be reached

    const out = await run(["row-1", "row-2", "row-3", "row-4", "row-5"]);

    expect(out.overall).toBe("STOPPED_RATE_LIMITED");
    expect(out.stopped_reason).toBe("RATE_LIMIT");

    const byStatus = (s: string) =>
      out.results.filter((r) => r.status === s).map((r) => r.iapId);

    expect(byStatus("SUCCESS")).toEqual(["row-1"]);
    expect(byStatus("FAILED")).toEqual(["row-2"]);
    expect(byStatus("NOT_ATTEMPTED")).toEqual(["row-3", "row-4", "row-5"]);

    // The three sets are disjoint and cover the batch.
    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.not_attempted).toBe(3);
    expect(out.succeeded + out.failed + out.not_attempted).toBe(out.total);
  });

  it("makes no Apple call at all for not-attempted items", async () => {
    setAvailabilityTerritories
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue({ data: { id: "never" } });

    await run(["row-1", "row-2", "row-3"]);

    // 4 attempts on row-1 and nothing else. Rows 2 and 3 never touched Apple.
    expect(setAvailabilityTerritories).toHaveBeenCalledTimes(4);
    const touched = setAvailabilityTerritories.mock.calls.map((c) => c[1]);
    expect(new Set(touched)).toEqual(new Set(["APL_row-1"]));
  });

  it("writes NO audit row for a not-attempted item", async () => {
    setAvailabilityTerritories
      .mockResolvedValueOnce({ data: { id: "av-1" } })
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue({ data: { id: "never" } });

    await run(["row-1", "row-2", "row-3", "row-4"]);

    // One SUCCESS row + one ERROR row. Nothing for row-3 / row-4.
    expect(auditInsert).toHaveBeenCalledTimes(2);
    const loggedIaps = auditInsert.mock.calls.map(
      (c) => (c[0] as { iap_id?: string }).iap_id,
    );
    expect(loggedIaps).not.toContain("row-3");
    expect(loggedIaps).not.toContain("row-4");
  });

  it("names the rate-limited item with its own failure kind, not a summary", async () => {
    setAvailabilityTerritories
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue({ data: { id: "never" } });

    const out = await run(["row-1", "row-2"]);

    const failed = out.results.find((r) => r.status === "FAILED")!;
    expect(failed.iapId).toBe("row-1");
    expect(failed.failure_kind).toBe("RATE_LIMITED");
    expect(failed.error).toMatch(/429/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("resume runs ONLY the remainder", () => {
  it("a successful item is never re-sent", async () => {
    setAvailabilityTerritories
      .mockResolvedValueOnce({ data: { id: "av-1" } }) // row-1 SUCCESS
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit()) // row-2 FAILED ⇒ STOP
      .mockResolvedValue({ data: { id: "never" } });

    const first = await run(["row-1", "row-2", "row-3", "row-4"]);
    expect(first.remainder).toEqual(["row-3", "row-4"]);

    // ── Resume: feed the remainder straight back.
    setAvailabilityTerritories.mockReset();
    setAvailabilityTerritories.mockResolvedValue({ data: { id: "av-r" } });
    auditInsert.mockReset();

    const second = await run(first.remainder);

    expect(second.overall).toBe("SUCCESS");
    expect(second.total).toBe(2);

    const resent = setAvailabilityTerritories.mock.calls.map((c) => c[1]);
    expect(resent).toEqual(["APL_row-3", "APL_row-4"]);
    // THE ONE THAT MATTERS: the item Apple already accepted is untouched.
    expect(resent).not.toContain("APL_row-1");
    // And the failed one is not silently retried either — resuming a
    // failure needs a human to read why it failed first.
    expect(resent).not.toContain("APL_row-2");
  });

  it("the remainder excludes succeeded and failed by construction", async () => {
    setAvailabilityTerritories
      .mockResolvedValueOnce({ data: { id: "av-1" } })
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue({ data: { id: "never" } });

    const out = await run(["row-1", "row-2", "row-3"]);

    const succeeded = out.results
      .filter((r) => r.status === "SUCCESS")
      .map((r) => r.iapId);
    const failed = out.results
      .filter((r) => r.status === "FAILED")
      .map((r) => r.iapId);

    for (const id of [...succeeded, ...failed]) {
      expect(out.remainder).not.toContain(id);
    }
    expect(out.remainder).toEqual(["row-3"]);
  });

  it("resume preserves the selection verbatim — same territories, same flag", async () => {
    setAvailabilityTerritories
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue({ data: { id: "never" } });

    const first = await run(["row-1", "row-2"]);

    setAvailabilityTerritories.mockReset();
    setAvailabilityTerritories.mockResolvedValue({ data: { id: "av-r" } });

    await run(first.remainder);

    expect(setAvailabilityTerritories.mock.calls[0][2]).toEqual(SELECTION);
    expect(setAvailabilityTerritories.mock.calls[0][2].territoryIds).toEqual([
      "VNM",
      "JPN",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("only rate-limit exhaustion stops the run (Q-K fail-soft elsewhere)", () => {
  it("an Apple rejection fails ONE row and the batch continues", async () => {
    setAvailabilityTerritories
      .mockResolvedValueOnce({ data: { id: "av-1" } })
      .mockRejectedValueOnce(new Error("422 Apple rejected territory XYZ"))
      .mockResolvedValueOnce({ data: { id: "av-3" } });

    const out = await run(["row-1", "row-2", "row-3"]);

    expect(out.overall).toBe("PARTIAL");
    expect(out.stopped_reason).toBeUndefined();
    expect(out.not_attempted).toBe(0);
    expect(out.remainder).toEqual([]);
    expect(setAvailabilityTerritories).toHaveBeenCalledTimes(3);

    const failed = out.results.find((r) => r.status === "FAILED")!;
    expect(failed.iapId).toBe("row-2");
    expect(failed.failure_kind).toBe("APPLE_REJECTED");
  });

  it("a local draft fails its own row and the batch continues", async () => {
    setAvailabilityTerritories.mockResolvedValue({ data: { id: "av-x" } });

    const out = await run(["row-1", "draft-2", "row-3"]);

    expect(out.overall).toBe("PARTIAL");
    expect(out.not_attempted).toBe(0);
    const failed = out.results.find((r) => r.status === "FAILED")!;
    expect(failed.iapId).toBe("draft-2");
    expect(failed.failure_kind).toBe("NOT_SYNCED");
    expect(failed.error).toMatch(/not synced/i);
  });

  it("a 429 that RECOVERS within the retry budget does not stop anything", async () => {
    setAvailabilityTerritories
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValueOnce({ data: { id: "av-1" } })
      .mockResolvedValueOnce({ data: { id: "av-2" } });

    const out = await run(["row-1", "row-2"]);

    expect(out.overall).toBe("SUCCESS");
    expect(out.stopped_reason).toBeUndefined();
    expect(out.not_attempted).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("retry composition — exactly one withRetry, no double wrap", () => {
  it("a 429 is attempted 1 + 3 retries = 4 times, never 16", async () => {
    setAvailabilityTerritories.mockRejectedValue(rateLimit());

    const out = await run(["row-1"]);

    // DEFAULT_BACKOFF_MS is [500, 1000, 2000] ⇒ 3 retries ⇒ 4 attempts.
    // A second wrapper would multiply this to 4 x 4 = 16.
    expect(setAvailabilityTerritories).toHaveBeenCalledTimes(4);
    expect(out.results[0].rate_limit!.retry_attempts).toBe(3);
    expect(out.results[0].rate_limit!.rate429_count).toBe(3);
  });

  it("honours Apple's Retry-After rather than the default curve", async () => {
    setAvailabilityTerritories.mockRejectedValue(rateLimit()); // retryAfterMs = 1

    const out = await run(["row-1"]);

    // 3 sleeps of 1ms each, taken from the header — not 500+1000+2000.
    expect(out.results[0].rate_limit!.backoff_total_ms).toBe(3);
    expect(out.results[0].rate_limit!.longest_backoff_ms).toBe(1);
  });

  it("a non-429 error is NOT retried at all", async () => {
    setAvailabilityTerritories.mockRejectedValue(new Error("500 boom"));

    await run(["row-1"]);

    expect(setAvailabilityTerritories).toHaveBeenCalledTimes(1);
  });
});
