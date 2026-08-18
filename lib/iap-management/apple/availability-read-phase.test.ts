/**
 * The READ phase — decision 3's stop-and-preserve, now on the read side.
 *
 * ⚠ MUTATION TARGETS:
 *   (a) continue past a rate limit instead of stopping → "stops" tests
 *   (b) fold the rate-limited item into notRead        → "asked ≠ unsent"
 *   (c) mark attempted before the post-wait re-check   → remainder shrinks
 */
import { describe, it, expect, vi } from "vitest";
import {
  runAvailabilityReadPhase,
  type ReadOutcome,
  type ReadPhaseTarget,
} from "./availability-read-phase";
import type { AvailabilityForIap } from "./availabilities";

const STATE: AvailabilityForIap = {
  availableInNewTerritories: false,
  territoryCount: 1,
  territoryIds: ["USA"],
};

const targets = (n: number): ReadPhaseTarget[] =>
  Array.from({ length: n }, (_, i) => ({
    appleIapId: `a${i}`,
    internalId: `u${i}`,
  }));

/** Serial (concurrency 1) so "which item stopped it" is deterministic. */
function run(
  ts: ReadPhaseTarget[],
  readOne: (t: ReadPhaseTarget) => Promise<ReadOutcome>,
  extra: Partial<Parameters<typeof runAvailabilityReadPhase>[0]> = {},
) {
  return runAvailabilityReadPhase({
    targets: ts,
    readOne,
    acquire: async () => {},
    release: () => {},
    concurrency: 1,
    ...extra,
  });
}

describe("the happy path", () => {
  it("reads every target and records its state", async () => {
    const res = await run(targets(4), async () => ({ kind: "ok", state: STATE }));
    expect(res.states.size).toBe(4);
    expect(res.errors.size).toBe(0);
    expect(res.notRead).toEqual([]);
    expect(res.stoppedByRateLimit).toBe(false);
  });

  it("a null state is a real answer (no availability resource), not an error", async () => {
    const res = await run(targets(2), async () => ({ kind: "ok", state: null }));
    expect(res.states.get("a0")).toBeNull();
    expect(res.errors.size).toBe(0);
  });

  it("reports progress once per attempted item", async () => {
    const onProgress = vi.fn();
    await run(targets(3), async () => ({ kind: "ok", state: STATE }), {
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  });
});

describe("⚠ decision 3 on the READ — stop, and preserve the remainder", () => {
  it("stops at the first rate limit; the rest is never sent", async () => {
    const seen: string[] = [];
    const res = await run(targets(10), async (t) => {
      seen.push(t.appleIapId);
      return t.appleIapId === "a2"
        ? { kind: "rate_limited" }
        : { kind: "ok", state: STATE };
    });

    expect(res.stoppedByRateLimit).toBe(true);
    expect(seen).toEqual(["a0", "a1", "a2"]);
    expect(res.states.size).toBe(2);
    expect(res.notRead.map((t) => t.appleIapId)).toEqual([
      "a3", "a4", "a5", "a6", "a7", "a8", "a9",
    ]);
  });

  it("⚠ the rate-limited item is an ERROR, not part of the retryable remainder", async () => {
    const res = await run(targets(5), async (t) =>
      t.appleIapId === "a1" ? { kind: "rate_limited" } : { kind: "ok", state: STATE },
    );
    // It was ASKED and refused (withRetry already exhausted its backoff).
    // Re-sending it blindly is exactly what SC3 forbade on the write side.
    expect(res.errors.get("a1")).toBe("rate_limited");
    expect(res.notRead.map((t) => t.appleIapId)).not.toContain("a1");
  });

  it("every target is accounted for exactly once across the three outcomes", async () => {
    const res = await run(targets(8), async (t) =>
      t.appleIapId === "a3" ? { kind: "rate_limited" } : { kind: "ok", state: STATE },
    );
    const all = [
      ...res.states.keys(),
      ...res.errors.keys(),
      ...res.notRead.map((t) => t.appleIapId),
    ];
    expect(all).toHaveLength(8);
    expect(new Set(all).size).toBe(8);
  });

  it("preserves the remainder under real concurrency too", async () => {
    const res = await runAvailabilityReadPhase({
      targets: targets(20),
      readOne: async (t) =>
        t.appleIapId === "a1" ? { kind: "rate_limited" } : { kind: "ok", state: STATE },
      acquire: async () => {},
      release: () => {},
      concurrency: 3,
    });
    expect(res.stoppedByRateLimit).toBe(true);
    expect(res.notRead.length).toBeGreaterThan(0);
    const all = [
      ...res.states.keys(),
      ...res.errors.keys(),
      ...res.notRead.map((t) => t.appleIapId),
    ];
    expect(new Set(all).size).toBe(20);
  });
});

describe("an ordinary failure is fail-soft, a rate limit is not", () => {
  it("a non-429 failure does NOT stop the phase", async () => {
    const res = await run(targets(5), async (t) =>
      t.appleIapId === "a1"
        ? { kind: "failed", reason: "fetch_failed" }
        : { kind: "ok", state: STATE },
    );
    expect(res.stoppedByRateLimit).toBe(false);
    expect(res.notRead).toEqual([]);
    expect(res.errors.get("a1")).toBe("fetch_failed");
    expect(res.states.size).toBe(4);
  });

  it("a thrown error is contained to its own row", async () => {
    const res = await run(targets(3), async (t) => {
      if (t.appleIapId === "a0") throw new Error("boom");
      return { kind: "ok", state: STATE };
    });
    expect(res.errors.get("a0")).toBe("boom");
    expect(res.states.size).toBe(2);
  });
});

describe("cancellation", () => {
  it("stops claiming targets once cancelled, and preserves the rest", async () => {
    let n = 0;
    const res = await run(
      targets(10),
      async () => {
        n += 1;
        return { kind: "ok", state: STATE };
      },
      { isCancelled: () => n >= 3 },
    );
    expect(n).toBe(3);
    expect(res.notRead.length).toBe(7);
  });

  it("an empty target list is a no-op, not a crash", async () => {
    const readOne = vi.fn();
    const res = await run([], readOne);
    expect(readOne).not.toHaveBeenCalled();
    expect(res.notRead).toEqual([]);
    expect(res.stoppedByRateLimit).toBe(false);
  });
});

describe("the slot is always released", () => {
  it("releases once per claimed target, including on throw", async () => {
    let acquired = 0;
    let released = 0;
    await run(
      targets(4),
      async (t) => {
        if (t.appleIapId === "a1") throw new Error("x");
        return { kind: "ok", state: STATE };
      },
      {
        acquire: async () => {
          acquired += 1;
        },
        release: () => {
          released += 1;
        },
      },
    );
    expect(acquired).toBe(4);
    expect(released).toBe(acquired);
  });
});
