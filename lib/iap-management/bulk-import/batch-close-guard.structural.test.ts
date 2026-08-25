/**
 * STRUCTURAL invariant — the write that CLOSES an import batch must check its
 * error.
 *
 * ⚠ WHY STRUCTURAL AND NOT BEHAVIOURAL. The defect is a property of one call
 * site inside a 1,400-line route with no orchestration harness (its own test
 * file says so). Driving `POST` far enough to reach the batch close would
 * mean mocking Supabase, the Apple client, the parser, conflict resolution,
 * the territory catalogue and the price-point cache — and the assertion would
 * still only be "this one statement checked its result". `retry-composition
 * .structural.test.ts` established this technique in this codebase for
 * exactly that reason: when the defect lives at a call site, the assertion
 * has to look at the call site.
 *
 * ⚠ WHY THIS INVARIANT IS WORTH A TEST AT ALL. Nothing in the app SELECTs
 * from `import_batches` — it is a hand-queried audit trail. So a rejected
 * close-write leaves the row stuck at IN_PROGRESS with every counter at zero,
 * permanently, with no error surfaced anywhere. That is the KB §9 P2 shape
 * ("the CHECK constraint fails silently"), and it is precisely how shipping
 * code ahead of migration 20260825000000 (`not_attempted_count`) would
 * present: as nothing at all.
 *
 * The INSERT that opens the batch has always checked its error. The UPDATE
 * that closes it did not, until C2.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = join(
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
);

const src = readFileSync(ROUTE, "utf8");

/** Every `.from("import_batches")` statement, sliced to its terminating `;`. */
function importBatchStatements(): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf('.from("import_batches")', i);
    if (at < 0) break;
    // Walk back to the start of the statement (previous `;` or `{`).
    let start = at;
    while (start > 0 && !";{}".includes(src[start - 1])) start--;
    const end = src.indexOf(";", at);
    out.push(src.slice(start, end < 0 ? src.length : end));
    i = at + 1;
  }
  return out;
}

describe("import_batches writes must not be fire-and-forget", () => {
  it("the route touches import_batches exactly twice (open + close)", () => {
    // A third write appearing without a matching assertion below should fail
    // here rather than slip through unguarded.
    expect(importBatchStatements()).toHaveLength(2);
  });

  it("⚠ the CLOSE update assigns its result — it is not `await db…update(…)` alone", () => {
    const close = importBatchStatements().find((s) => s.includes(".update("));
    expect(close).toBeDefined();
    // `await db.from(...)` with no binding is the fire-and-forget shape.
    expect(close!).toMatch(/const\s+\w+\s*=\s*await/);
  });

  it("⚠ and the route CHECKS that result's `.error`", () => {
    const close = importBatchStatements().find((s) => s.includes(".update("))!;
    const binding = /const\s+(\w+)\s*=\s*await/.exec(close)![1];
    // Somewhere after the statement, the binding's error is inspected.
    const after = src.slice(src.indexOf(close) + close.length);
    expect(after).toMatch(new RegExp(`${binding}\\.error`));
  });

  it("the failure is surfaced as an ERROR log, not swallowed", () => {
    const close = importBatchStatements().find((s) => s.includes(".update("))!;
    const binding = /const\s+(\w+)\s*=\s*await/.exec(close)![1];
    const after = src.slice(src.indexOf(close) + close.length);
    const guard = after.slice(after.indexOf(`${binding}.error`));
    expect(guard.slice(0, 900)).toMatch(/"ERROR"/);
  });

  it("the log names the migration, so a code-before-migration deploy is diagnosable", () => {
    // The one failure mode this guard exists for should say what to do about
    // itself rather than leaving a Postgres column-not-found to interpret.
    expect(src).toMatch(/20260825000000/);
  });

  it("the OPEN insert still checks its error too (unchanged, pinned)", () => {
    const open = importBatchStatements().find((s) => s.includes(".insert("))!;
    const binding = /const\s+(\w+)\s*=\s*await/.exec(open)![1];
    expect(src).toMatch(new RegExp(`${binding}\\.error`));
  });
});
