/**
 * C3 chunk A — PARTIAL and the batch latch are two different questions, and
 * the row must answer both without confusing them.
 *
 *   PARTIAL because Apple's budget ran out → the NEXT row will fail too.
 *                                             Stop the batch (C2's latch).
 *   PARTIAL because this row's screenshot   → says nothing about the next
 *   file was rejected                         row. Keep going (Rule 2).
 *
 * Getting this backwards in either direction is a real failure: halting a
 * 500-row import because one PNG was malformed, or marching the whole batch
 * into an API that has already refused.
 */
import { describe, it, expect, vi } from "vitest";

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
import { rollUpRowOutcome, type RowStages } from "./row-outcome";

interface Row {
  product_id: string;
  status: "SUCCESS" | "PARTIAL" | "ERROR" | "NOT_ATTEMPTED";
  summary?: string;
  stages?: RowStages;
  rate_limit?: RetryCounters;
}

const okStages = (): RowStages => ({
  create: { state: "OK" },
  localizations: { state: "OK", done: 3, total: 3, failed: [], skippedByStop: 0 },
  pricing: { state: "OK", outcome: "set" },
  screenshot: { state: "OK", note: "uploaded-new" },
  availability: { state: "OK" },
  submit: { state: "NOT_APPLICABLE" },
});

/** PARTIAL because a file was bad — nothing to do with the budget. */
const badScreenshotStages = (): RowStages => ({
  ...okStages(),
  screenshot: { state: "FAILED", note: "failed", error: "invalid PNG" },
});

/** PARTIAL because the budget ran out mid-row. */
const rateLimitedStages = (): RowStages => ({
  ...okStages(),
  localizations: { state: "SKIPPED_BY_STOP", done: 1, total: 3, failed: [], skippedByStop: 2 },
  pricing: { state: "SKIPPED_BY_STOP", outcome: "skipped-not-ready" },
  screenshot: { state: "SKIPPED_BY_STOP" },
  availability: { state: "SKIPPED_BY_STOP" },
});

/** Fakes orchestrateOne: builds the row exactly as the route does. */
async function runBatch(
  plan: Record<string, { stages: RowStages; exhausted: boolean }>,
) {
  const attempted: string[] = [];
  const { results } = await runStoppablePool<string, Row>({
    items: Object.keys(plan),
    concurrency: 1,
    shouldStop: () => false,
    shouldStopOnResult: rowExhaustedRateLimitBudget,
    skipped: (id) => ({ product_id: id, status: "NOT_ATTEMPTED" as const }),
    onError: async (id) => ({ product_id: id, status: "ERROR" as const }),
    run: async (id) => {
      attempted.push(id);
      const counters = createRetryCounters();
      counters.exhausted = plan[id].exhausted;
      const roll = rollUpRowOutcome(plan[id].stages);
      return {
        product_id: id,
        status: roll.status,
        summary: roll.summary,
        stages: plan[id].stages,
        rate_limit: counters,
      };
    },
  });
  return { results, attempted };
}

describe("PARTIAL caused by a rate limit stops the batch", () => {
  it("⚠ later rows are NEVER orchestrated", async () => {
    const { results, attempted } = await runBatch({
      a: { stages: okStages(), exhausted: false },
      b: { stages: rateLimitedStages(), exhausted: true },
      c: { stages: okStages(), exhausted: false },
      d: { stages: okStages(), exhausted: false },
    });
    expect(attempted).toEqual(["a", "b"]);
    expect(results.filter((r) => r.status === "NOT_ATTEMPTED").map((r) => r.product_id))
      .toEqual(["c", "d"]);
  });

  it("the stopping row is PARTIAL, and says why in one line", async () => {
    const { results } = await runBatch({
      a: { stages: rateLimitedStages(), exhausted: true },
      b: { stages: okStages(), exhausted: false },
    });
    const row = results[0];
    expect(row.status).toBe("PARTIAL");
    expect(row.summary).toContain("1/3 locales");
    expect(row.summary).toContain("stopped by rate limit");
  });
});

describe("⚠ PARTIAL caused by anything else does NOT stop the batch", () => {
  it("a bad screenshot fails one row and the import continues", async () => {
    // Halting 500 rows because one PNG was malformed is the failure mode on
    // the other side of this boundary.
    const { results, attempted } = await runBatch({
      a: { stages: okStages(), exhausted: false },
      b: { stages: badScreenshotStages(), exhausted: false },
      c: { stages: okStages(), exhausted: false },
      d: { stages: okStages(), exhausted: false },
    });
    expect(attempted).toEqual(["a", "b", "c", "d"]);
    expect(results.find((r) => r.product_id === "b")!.status).toBe("PARTIAL");
    expect(results.some((r) => r.status === "NOT_ATTEMPTED")).toBe(false);
  });

  it("many ordinary PARTIALs still never halt the run", async () => {
    const { attempted } = await runBatch({
      a: { stages: badScreenshotStages(), exhausted: false },
      b: { stages: badScreenshotStages(), exhausted: false },
      c: { stages: badScreenshotStages(), exhausted: false },
    });
    expect(attempted).toEqual(["a", "b", "c"]);
  });

  it("⚠ the two PARTIALs are distinguishable from the row alone", async () => {
    // Both are `status: "PARTIAL"`. Only the MAP says which — which is why
    // the map, not the status, is what the Manager is shown.
    const { results } = await runBatch({
      a: { stages: badScreenshotStages(), exhausted: false },
      b: { stages: rateLimitedStages(), exhausted: true },
    });
    const [byFile, byBudget] = results;
    expect(byFile.status).toBe(byBudget.status);
    expect(byFile.stages!.screenshot.state).toBe("FAILED");
    expect(byBudget.stages!.screenshot.state).toBe("SKIPPED_BY_STOP");
  });
});
