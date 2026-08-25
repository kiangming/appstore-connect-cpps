/**
 * [Q-C3.tracking-frozen] — C3 IS A ROW-LEVEL CHANGE. THE HUB MUST NOT NOTICE.
 *
 * Manager's decision, recorded so nobody "fixes" it later: the bulk-import
 * batch's Hub-tracking terminal status — and every batch-level counter —
 * keeps saying exactly what it said before C3 existed. A batch that leaves
 * half-built IAPs behind still reads SUCCESS on the Hub. That is not an
 * oversight; PARTIAL is delivered at the ROW level, in the stage map, and
 * widening it to the batch is a separate decision the Manager has not made.
 *
 * ⚠ WHY THIS FILE IS NOT ONE `expect(...).toBe("SUCCESS")`. The freeze is
 * threatened by a change that looks like an improvement — narrowing
 * `succeeded` and letting the mapping see it. Before C3 both terminal
 * returns in `runCreate`/`runOverwrite` were an unconditional
 * `status: "SUCCESS"`, so the OLD `succeeded` meant "rows that reached the
 * end of the pipeline". C3 split that population in two. Feeding the
 * mapping the narrowed half silently moves its OUTPUT — so simply deleting
 * the batch-level override is NOT enough to hold the status still, and a
 * test that only checked the override was gone would pass over the drift.
 *
 * Two halves, because either alone is defeatable:
 *   1. SEMANTIC — a fixture table of batch compositions, each scored the
 *      pre-C3 way and the post-C3 way. Every cell must agree.
 *   2. STRUCTURAL — the route actually feeds the mapping the re-widened
 *      input and assigns `terminal.status` bare. A semantic test cannot see
 *      the route; `execute/route.ts` has no orchestration harness.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeBulkImportTerminalStatus } from "@/lib/iap-management/hub-tracking/status-mapping";

/**
 * One batch, described in terms that predate C3: how many rows reached the
 * end of the pipeline, how many errored, how many were skipped or never
 * attempted. `ended` is the population C3 later split into SUCCESS +
 * PARTIAL — pre-C3 every one of them returned `status: "SUCCESS"`.
 */
interface Batch {
  name: string;
  ended: number;
  /** How many of `ended` C3 now classifies PARTIAL. Must be <= ended. */
  partial: number;
  failed: number;
  skipped: number;
  notAttempted: number;
}

const BATCHES: Batch[] = [
  { name: "clean batch, one row now partial", ended: 3, partial: 1, failed: 0, skipped: 0, notAttempted: 0 },
  { name: "clean batch, EVERY row now partial", ended: 3, partial: 3, failed: 0, skipped: 0, notAttempted: 0 },
  { name: "clean batch, none partial (C3 invisible)", ended: 3, partial: 0, failed: 0, skipped: 0, notAttempted: 0 },
  // ⚠ THE CELL THAT CATCHES THE DRIFT. Pre-C3: (succeeded=1, failed=1) →
  // PARTIAL. Feed the mapping the narrowed `succeeded` and it becomes
  // (0, 1) → FAILED — a batch that half-worked reported as a total loss.
  { name: "⚠ one partial + one error", ended: 1, partial: 1, failed: 1, skipped: 0, notAttempted: 0 },
  { name: "⚠ all survivors partial, some errors", ended: 2, partial: 2, failed: 2, skipped: 0, notAttempted: 0 },
  { name: "partial + error + success mix", ended: 3, partial: 1, failed: 1, skipped: 0, notAttempted: 0 },
  { name: "partial alongside skips", ended: 2, partial: 1, failed: 0, skipped: 4, notAttempted: 0 },
  { name: "partial alongside a stopped batch", ended: 2, partial: 2, failed: 0, skipped: 0, notAttempted: 5 },
  { name: "errors only, nothing ended", ended: 0, partial: 0, failed: 3, skipped: 0, notAttempted: 0 },
  { name: "all skipped by the Manager", ended: 0, partial: 0, failed: 0, skipped: 4, notAttempted: 0 },
  { name: "empty batch", ended: 0, partial: 0, failed: 0, skipped: 0, notAttempted: 0 },
];

const total = (b: Batch) => b.ended + b.failed + b.skipped + b.notAttempted;

/** What the route computed BEFORE C3: every ended row counted as SUCCESS. */
const preC3 = (b: Batch) =>
  computeBulkImportTerminalStatus({
    total: total(b),
    succeeded: b.ended,
    failed: b.failed,
  });

/**
 * What the route computes NOW. ⚠ The two locals are named for the route's
 * own variables on purpose: after C3, `succeeded` counts only rows with NO
 * missing stage, and the mapping is handed `succeeded + partial` to put the
 * pre-C3 population back together. The sum is the identity that IS the
 * freeze — the teeth are in the next test, which shows the other input the
 * route could plausibly have used moves the answer.
 */
const postC3 = (b: Batch) => {
  const succeeded = b.ended - b.partial;
  const partial = b.partial;
  return computeBulkImportTerminalStatus({
    total: total(b),
    succeeded: succeeded + partial,
    failed: b.failed,
  });
};

describe("[Q-C3.tracking-frozen] the Hub status is byte-identical to pre-C3", () => {
  it.each(BATCHES)("$name", (b) => {
    expect(b.partial).toBeLessThanOrEqual(b.ended);
    const before = preC3(b);
    const after = postC3(b);
    expect(after.status).toBe(before.status);
    expect(after.errorMessage).toBe(before.errorMessage);
  });

  it("⚠ and the drift the freeze exists to prevent is REAL, not hypothetical", () => {
    // Proves the fixture table above has teeth: had the route passed the
    // narrowed `succeeded`, this is the batch whose Hub status would have
    // moved. If this assertion ever reads "PARTIAL", the two inputs stopped
    // differing and the table can no longer detect anything.
    const b = BATCHES.find((x) => x.name.includes("one partial + one error"))!;
    const drifted = computeBulkImportTerminalStatus({
      total: total(b),
      succeeded: b.ended - b.partial, // the tempting, wrong input
      failed: b.failed,
    });
    expect(drifted.status).toBe("FAILED");
    expect(preC3(b).status).toBe("PARTIAL");
  });
});

// ─── STRUCTURAL HALF ────────────────────────────────────────────────────────

const src = readFileSync(
  join(
    __dirname, "..", "..", "..",
    "app", "api", "iap-management", "apps", "[appId]",
    "bulk-import", "execute", "route.ts",
  ),
  "utf8",
);

describe("[Q-C3.tracking-frozen] the route is wired to the frozen input", () => {
  it("⚠ feeds the mapping `succeeded + partial`, not the narrowed count", () => {
    const call = src.slice(
      src.indexOf("computeBulkImportTerminalStatus({"),
      src.indexOf("tracking.status ="),
    );
    expect(call).toContain("succeeded: succeeded + partial");
  });

  it("⚠ assigns the mapping's answer unchanged — no batch-level override", () => {
    // The override C3 chunk A first shipped read `partial > 0 && ... ?
    // "PARTIAL" : terminal.status` and downgraded clean batches. Manager
    // reverted it. Anything between the mapping and `tracking.status` that
    // mentions `partial` is that override coming back.
    expect(src).toContain("tracking.status = terminal.status;");
    const between = src.slice(
      src.indexOf("const terminal = computeBulkImportTerminalStatus"),
      src.indexOf("tracking.errorMessage = terminal.errorMessage;"),
    );
    const code = between
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).toContain("succeeded: succeeded + partial");
    expect(code.replace("succeeded: succeeded + partial,", "")).not.toContain("partial");
  });

  it("⚠ the batch counters do not shrink either", () => {
    // `created_count` reads `succeeded` directly. Chunk A narrowed the
    // variable and left this call site alone, which quietly dropped PARTIAL
    // rows from a counter C3 was never meant to touch. Same freeze, same
    // reason — and unlike the status, nothing else would have caught it.
    expect(src).toContain("created_count: succeeded + partial,");
  });
});
