/**
 * C3 chunk A — the localization loop must stop on a spent budget, and ONLY on
 * a spent budget.
 *
 * ⚠ WHY STRUCTURAL. `execute/route.ts` has no orchestration harness (its own
 * test file says so and explains the cost: Supabase, the Apple client, the
 * parser, conflict resolution, the territory catalogue, the price-point
 * cache). The defect is a property of one loop inside a 1,700-line function,
 * and `retry-composition.structural.test.ts` and
 * `batch-close-guard.structural.test.ts` already established this technique
 * here for exactly that reason. The behavioural half — that a spent budget
 * stops the BATCH — is covered by `partial-vs-latch.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/** The localization loop, sliced from its `for` to the closing of its catch. */
function localeLoop(): string {
  const start = src.indexOf("for (const [locIndex, loc] of item.localizations.entries())");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("// 3. Pricing schedule", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("the locale loop breaks on an exhausted budget", () => {
  it("⚠ has a break guarded by rateCounters.exhausted", () => {
    // Before C3 a 429 that had already burned four retries on locale #k
    // marched on through #k+1…#39, each costing four more — roughly 156
    // requests fired at an API that had just refused, for one row.
    const loop = localeLoop();
    expect(loop).toMatch(/if \(args\.rateCounters\.exhausted\)/);
    expect(loop).toContain("break;");
  });

  it("⚠ the guard runs BEFORE the try — a stopped loop sends nothing", () => {
    // Checking after the request would spend the very budget it is reacting
    // to. Same rule as stoppable-pool's Rule 1, one layer down.
    const loop = localeLoop();
    const guard = loop.indexOf("args.rateCounters.exhausted");
    const firstTry = loop.indexOf("try {");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstTry);
  });

  it("⚠ the CATCH still continues — one bad locale is not a broken row", () => {
    // The boundary that matters. A description that is too long, an
    // unsupported locale or a duplicate says nothing about the NEXT locale.
    // If the catch ever gains its own `break`, this fails.
    const loop = localeLoop();
    const catchIdx = loop.indexOf("} catch (err) {");
    expect(catchIdx).toBeGreaterThan(-1);
    const afterCatch = loop.slice(catchIdx);
    expect(afterCatch).toContain("failedLocales.push");
    expect(afterCatch).not.toContain("break;");
  });

  it("records the remainder so the map can say 27 were never sent", () => {
    expect(localeLoop()).toContain("localesStoppedByStop");
  });

  it("counts successes so the map has a numerator", () => {
    expect(localeLoop()).toContain("localesDone += 1");
  });
});

describe("stages after the stop are skipped, not attempted-and-failed", () => {
  it("screenshot, availability and pricing each check the flag", () => {
    // Otherwise they fire at an API that has already refused, and their
    // failures become indistinguishable from real ones.
    expect(src).toContain("screenshotFile && !args.rateCounters.exhausted");
    expect(src).toContain("const availabilityAttempted = !args.rateCounters.exhausted");
    expect(src).toContain("const pricingSkippedByStop = args.rateCounters.exhausted");
  });

  it("⚠ neither CREATE nor OVERWRITE returns a hard-coded SUCCESS any more", () => {
    // The headline defect: five stages swallowed their errors and the row
    // asserted success regardless. Both dispositions now derive it.
    expect(src).not.toMatch(/disposition: "CREATE",\s*\n\s*status: "SUCCESS"/);
    expect(src).not.toMatch(/disposition: "OVERWRITE",\s*\n\s*status: "SUCCESS"/);
    expect(src.split("rollUpRowOutcome(").length - 1).toBeGreaterThanOrEqual(2);
  });
});
