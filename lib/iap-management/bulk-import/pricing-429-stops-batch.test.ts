/**
 * [PRICING-429-no-retry] END-TO-END — a rate limit in the PRICING stage must
 * stop the batch, exactly like one in any other stage.
 *
 * ⚠ WHY END-TO-END AND NOT THREE UNIT TESTS. The defect was never in one
 * piece; it was in the JOIN. `setPriceSchedule` classified nothing,
 * `applyPricingSchedule` flattened what it caught, the caller wrapped
 * nothing, and `trackedWithRetry` — which only sees throws — could not see a
 * stage that never throws. Each piece looked defensible alone. What was
 * broken was that the fact never travelled from the first to the last, so the
 * assertion has to follow it the whole way:
 *
 *     pricing outcome (RATE_LIMITED)
 *       → pricingOutcomeHitRateLimit
 *       → rateCounters.exhausted
 *       → rowExhaustedRateLimitBudget   (C2's shouldStopOnResult)
 *       → runStoppablePool stops dispatching
 *
 * The orchestrator is faked at the row boundary — the pieces under test are
 * the real ones.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `pricing-orchestration` reaches a Supabase client at module scope (audit
// log + template queries). Only its pure predicate and its types are needed
// here, so the DB edges are stubbed exactly as `pricing-orchestration.test.ts`
// already does — this file tests a signal path, not persistence.
vi.mock("@/lib/iap-management/db", () => ({ iapDb: vi.fn() }));
vi.mock("@/lib/iap-management/queries/templates", () => ({
  getPricingTemplateEntries: vi.fn(),
  getPricingTemplate: vi.fn(),
}));
import { runStoppablePool } from "@/lib/iap-management/stoppable-pool";
import {
  createRetryCounters,
  rowExhaustedRateLimitBudget,
  type RetryCounters,
} from "./retry-counters";
import {
  pricingOutcomeHitRateLimit,
  type PricingOutcome,
} from "@/lib/iap-management/apple/pricing-orchestration";

/** The one line the route adds — reproduced verbatim, not re-implemented. */
function markPricingRateLimit(
  counters: RetryCounters,
  outcome: PricingOutcome | null,
): void {
  if (pricingOutcomeHitRateLimit(outcome)) counters.exhausted = true;
}

interface Row {
  product_id: string;
  status: "SUCCESS" | "ERROR" | "NOT_ATTEMPTED";
  rate_limit?: RetryCounters;
}

const priced = (): PricingOutcome => ({
  kind: "set",
  price_point_id: "pp1",
  usd_price: 0.99,
  schedule_id: "s1",
  attempts: 1,
  source_kind: "APPLE",
  overridden_territory_count: 0,
});

const rateLimitedAt = (
  kind: "failed-set" | "failed-lookup" | "failed-exception",
): PricingOutcome =>
  kind === "failed-set"
    ? {
        kind: "failed-set",
        tier_id: "t1",
        price_point_id: "pp1",
        usd_price: 0.99,
        error: "Apple ASC API error 429 …",
        attempts: 1,
        failure_kind: "RATE_LIMITED",
      }
    : kind === "failed-lookup"
      ? { kind: "failed-lookup", error: "429", failure_kind: "RATE_LIMITED" }
      : { kind: "failed-exception", error: "429", failure_kind: "RATE_LIMITED" };

/** Fakes `orchestrateOne`: runs a pricing stage, swallows, returns a row. */
async function runBatch(outcomes: Record<string, PricingOutcome>) {
  const attempted: string[] = [];
  const ids = Object.keys(outcomes);
  const { results } = await runStoppablePool<string, Row>({
    items: ids,
    concurrency: 1, // one at a time, so "the next row" is unambiguous
    shouldStop: () => false,
    shouldStopOnResult: rowExhaustedRateLimitBudget,
    skipped: (id) => ({ product_id: id, status: "NOT_ATTEMPTED" as const }),
    onError: async (id) => ({ product_id: id, status: "ERROR" as const }),
    run: async (id) => {
      attempted.push(id);
      const counters = createRetryCounters();
      // The pricing stage never throws — it returns. Exactly as in the route.
      markPricingRateLimit(counters, outcomes[id]);
      return { product_id: id, status: "SUCCESS" as const, rate_limit: counters };
    },
  });
  return { results, attempted };
}

describe("a pricing 429 stops the batch", () => {
  it("⚠ rows after the rate-limited one are NEVER orchestrated", async () => {
    const { results, attempted } = await runBatch({
      a: priced(),
      b: rateLimitedAt("failed-set"),
      c: priced(),
      d: priced(),
    });
    // The load-bearing assertion: nothing was SENT for c and d.
    expect(attempted).toEqual(["a", "b"]);
    expect(results.filter((r) => r.status === "NOT_ATTEMPTED").map((r) => r.product_id))
      .toEqual(["c", "d"]);
  });

  it("⚠ the SAME is true for a 429 on the price-point READ", async () => {
    // That path already had withRetry, so a RATE_LIMITED arriving from it has
    // burned four attempts — and used to be flattened by the blanket catch.
    const { attempted } = await runBatch({
      a: priced(),
      b: rateLimitedAt("failed-lookup"),
      c: priced(),
    });
    expect(attempted).toEqual(["a", "b"]);
  });

  it("and for one that escaped as an exception", async () => {
    const { attempted } = await runBatch({
      a: rateLimitedAt("failed-exception"),
      b: priced(),
    });
    expect(attempted).toEqual(["a"]);
  });

  it("the row that hit the limit keeps its own result — Rule 3", async () => {
    const { results } = await runBatch({ a: rateLimitedAt("failed-set"), b: priced() });
    expect(results.find((r) => r.product_id === "a")!.status).toBe("SUCCESS");
  });
});

describe("⚠ a pricing failure that is NOT a rate limit must not stop anything", () => {
  it("APPLE_ERROR (409/422 — a payload problem) lets the batch finish", async () => {
    const { attempted } = await runBatch({
      a: priced(),
      b: {
        kind: "failed-set",
        tier_id: "t1",
        price_point_id: "pp1",
        usd_price: 0.99,
        error: "422 ENTITY_ERROR",
        attempts: 1,
        failure_kind: "APPLE_ERROR",
      },
      c: priced(),
    });
    expect(attempted).toEqual(["a", "b", "c"]);
  });

  it("APPLE_5XX — already retried six times — is a row failure, not a batch stop", async () => {
    const { attempted } = await runBatch({
      a: {
        kind: "failed-set",
        tier_id: "t1",
        price_point_id: "pp1",
        usd_price: 0.99,
        error: "500 UNEXPECTED_ERROR",
        attempts: 6,
        failure_kind: "APPLE_5XX",
      },
      b: priced(),
      c: priced(),
    });
    expect(attempted).toEqual(["a", "b", "c"]);
  });

  it("a skipped stage is not a failure at all", async () => {
    const { attempted } = await runBatch({
      a: { kind: "skipped-no-tier" },
      b: priced(),
    });
    expect(attempted).toEqual(["a", "b"]);
  });

  it("a fully priced batch never produces NOT_ATTEMPTED", async () => {
    const { results } = await runBatch({ a: priced(), b: priced() });
    expect(results.every((r) => r.status === "SUCCESS")).toBe(true);
  });
});

/**
 * ⚠ STRUCTURAL — the route must actually CALL the marker, on BOTH paths.
 *
 * The suite above proves the signal path works. It does not prove the route
 * is wired into it: the marker is reproduced there, so deleting the real call
 * in `execute/route.ts` leaves every one of those tests green. That gap was
 * found by mutating the route and watching 103 tests pass — the same shadow
 * K3's first attempt at a durable-cooldown test had, where asserting a mock
 * was called stood in for asserting the behaviour.
 *
 * A behavioural assertion is not available: `execute/route.ts` has no
 * orchestration harness (its own test file says so and explains the cost).
 * The defect is a property of two call sites, so — as
 * `retry-composition.structural.test.ts` and `batch-close-guard.structural
 * .test.ts` already established here — the assertion looks at the call sites.
 */
describe("the route is wired into the signal path", () => {
  const src = readFileSync(
    join(
      __dirname,
      "..",
      "..",
      "..",
      "app",
      "api",
      "iap-management",
      "apps",
      "[appId]",
      "bulk-import",
      "execute",
      "route.ts",
    ),
    "utf8",
  );

  it("⚠ marks the rate limit after EVERY applyPricingSchedule call", () => {
    // CREATE and OVERWRITE both run the pricing stage against the same
    // endpoint. Hooking one leaves a whole disposition invisible to the latch
    // — the twin-path rule, which this repo has been bitten by before.
    const pricingCalls = src.split("await applyPricingSchedule(").length - 1;
    const marks = src.split("markPricingRateLimit(args.rateCounters,").length - 1;
    expect(pricingCalls).toBe(2);
    expect(marks).toBe(pricingCalls);
  });

  it("reads failure_kind, never the message text", () => {
    // The `/404/.test(err.message)` shape must not reappear at the caller.
    expect(src).not.toMatch(/\/429\/\s*\.test\(/);
    expect(src).toContain("pricingOutcomeHitRateLimit");
  });
});
