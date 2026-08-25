/**
 * C2 — Bulk Import's outer latch, exercised through the REAL primitive and
 * the REAL predicate.
 *
 * ⚠ WHY THIS IS NOT A ROUTE TEST. `bulk-import/execute/route.ts` has no
 * orchestration harness — its own test file says so and explains why
 * (building one means mocking Supabase, the Apple client, the parser,
 * conflict resolution, the territory catalogue and the price-point cache).
 * What C2 actually adds to that route is two things: a predicate, and the
 * pool wiring. Both are tested here against the genuine `runStoppablePool`
 * and the genuine `rowExhaustedRateLimitBudget`, with only `orchestrateOne`
 * itself stood in for — which is the part C2 does not change.
 *
 * ⚠ THE SIGNAL IS A RESULT, NOT A THROW. `orchestrateOne` never throws; every
 * exit is a returned `PerIapResult`. The stand-in below therefore never
 * throws either — a fixture that threw would be testing a shape the real code
 * cannot produce, and would make `shouldStop` look load-bearing when it is
 * dead by construction.
 */
import { describe, it, expect } from "vitest";
import { runStoppablePool } from "@/lib/iap-management/stoppable-pool";
import {
  createRetryCounters,
  rowExhaustedRateLimitBudget,
  type RetryCounters,
} from "./retry-counters";

interface Row {
  product_id: string;
  status: "SUCCESS" | "ERROR" | "SKIPPED" | "NOT_ATTEMPTED";
  rate_limit?: RetryCounters;
  error?: string;
}

const clean = (): RetryCounters => createRetryCounters();
const recovered = (): RetryCounters => ({ ...clean(), rate429_count: 3 });
const exhausted = (): RetryCounters => ({ ...clean(), exhausted: true });

/**
 * Runs the same pool shape the route builds. `outcomes` maps a product id to
 * the result its (stubbed) orchestration returns.
 */
async function runPool(
  ids: string[],
  outcomes: Record<string, Row>,
  concurrency = 2,
) {
  const attempted: string[] = [];
  const { results } = await runStoppablePool<string, Row>({
    items: ids,
    concurrency,
    shouldStop: () => false,
    shouldStopOnResult: rowExhaustedRateLimitBudget,
    skipped: (id) => ({
      product_id: id,
      status: "NOT_ATTEMPTED" as const,
      error: "Batch stopped before this row",
    }),
    onError: async (id, err) => ({
      product_id: id,
      status: "ERROR" as const,
      error: String(err),
    }),
    run: async (id) => {
      attempted.push(id);
      return outcomes[id];
    },
  });
  return { results, attempted };
}

const ok = (id: string): Row => ({ product_id: id, status: "SUCCESS", rate_limit: clean() });

describe("Bulk Import outer latch — a row that exhausted the budget stops the batch", () => {
  it("⚠ rows after the exhausted one are NEVER orchestrated at all", async () => {
    const { results, attempted } = await runPool(["a", "b", "c", "d"], {
      a: ok("a"),
      b: { product_id: "b", status: "ERROR", rate_limit: exhausted(), error: "429" },
      c: ok("c"),
      d: ok("d"),
    });

    // ⚠ The load-bearing assertion is what was ATTEMPTED, not what was
    // reported. A row can carry the right status while its Apple calls
    // already went out; only this proves nothing was sent.
    expect(attempted).not.toContain("d");
    expect(results.find((r) => r.product_id === "d")!.status).toBe("NOT_ATTEMPTED");
  });

  it("every row is accounted for exactly once — nothing is dropped", async () => {
    const { results } = await runPool(["a", "b", "c", "d"], {
      a: ok("a"),
      b: { product_id: "b", status: "ERROR", rate_limit: exhausted(), error: "429" },
      c: ok("c"),
      d: ok("d"),
    });
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.product_id)).toEqual(["a", "b", "c", "d"]);
  });

  it("⚠ RULE 3 — the triggering row keeps its OWN result, it is not rewritten", async () => {
    // C2 does not change what a row's outcome MEANS. The row that exhausted
    // the budget may be an ERROR, or (today, pre-C3) even a half-built
    // SUCCESS. Either way the pool reports what actually happened to it and
    // only changes what happens to the rows AFTER it.
    const { results } = await runPool(["a", "b", "c"], {
      a: ok("a"),
      b: { product_id: "b", status: "SUCCESS", rate_limit: exhausted() },
      c: ok("c"),
    });
    const trigger = results.find((r) => r.product_id === "b")!;
    expect(trigger.status).toBe("SUCCESS");
    expect(trigger.status).not.toBe("NOT_ATTEMPTED");
  });

  it("⚠ a row throttled that RECOVERED does not stop anything", async () => {
    // The Hotfix 26 boundary, at the pool level this time. rate429_count > 0
    // is normal operation; the batch must run to completion.
    const { results, attempted } = await runPool(["a", "b", "c", "d"], {
      a: ok("a"),
      b: { product_id: "b", status: "SUCCESS", rate_limit: recovered() },
      c: ok("c"),
      d: ok("d"),
    });
    expect(attempted).toEqual(["a", "b", "c", "d"]);
    expect(results.some((r) => r.status === "NOT_ATTEMPTED")).toBe(false);
  });

  it("a plain ERROR row does not stop the batch — one bad row is not a halted batch", async () => {
    const { attempted } = await runPool(["a", "b", "c"], {
      a: ok("a"),
      b: { product_id: "b", status: "ERROR", rate_limit: clean(), error: "409" },
      c: ok("c"),
    });
    expect(attempted).toEqual(["a", "b", "c"]);
  });

  it("a Manager-chosen SKIP is untouched by the latch — different fact entirely", async () => {
    const { results, attempted } = await runPool(["a", "b", "c"], {
      a: ok("a"),
      b: { product_id: "b", status: "SKIPPED" },
      c: ok("c"),
    });
    expect(attempted).toEqual(["a", "b", "c"]);
    expect(results.find((r) => r.product_id === "b")!.status).toBe("SKIPPED");
    expect(results.some((r) => r.status === "NOT_ATTEMPTED")).toBe(false);
  });

  it("a clean batch never produces a NOT_ATTEMPTED row", async () => {
    const { results } = await runPool(["a", "b"], { a: ok("a"), b: ok("b") });
    expect(results.every((r) => r.status === "SUCCESS")).toBe(true);
  });

  it("⚠ at concurrency 2 the in-flight sibling still completes — C2's stated cost", async () => {
    // Rule 3, spelled out as a number: the latch bounds the spread BETWEEN
    // rows, and the rows already dispatched run to the end. With
    // CONCURRENCY_LIMIT=2 that means up to one extra row's worth of Apple
    // traffic after the latch falls. Stopping it mid-row is C3.
    const { attempted } = await runPool(
      ["a", "b", "c", "d"],
      {
        a: { product_id: "a", status: "ERROR", rate_limit: exhausted(), error: "429" },
        b: ok("b"),
        c: ok("c"),
        d: ok("d"),
      },
      2,
    );
    // "a" trips the latch, "b" was already dispatched alongside it.
    expect(attempted).toEqual(["a", "b"]);
  });
});
