/**
 * The three rules of `runStoppablePool`, each pinned by an assertion that a
 * plausible mis-implementation actually breaks.
 *
 * ⚠ "The latch is checked" is not the invariant — "the latch is checked
 * BEFORE any I/O" is. A test that only asserts the final result set passes
 * even when the check happens after `run`, because the results look the same
 * either way while the budget is silently spent. So the assertions below are
 * on the SPY: was `run` invoked at all for the items after the stop.
 */
import { describe, it, expect, vi } from "vitest";
import { runStoppablePool } from "./stoppable-pool";

class StopError extends Error {}
class SoftError extends Error {}
const shouldStop = (err: unknown) => err instanceof StopError;

/** A promise a test can resolve by hand, to hold an item mid-flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("runStoppablePool — rule 1: latch checked BEFORE any I/O", () => {
  it("items after the stop are never passed to `run` at all", async () => {
    const run = vi.fn(async (n: number) => {
      if (n === 0) throw new StopError("budget gone");
      return `ran:${n}`;
    });

    const out = await runStoppablePool<number, string>({
      items: [0, 1, 2, 3, 4],
      concurrency: 1, // serial, so item 0 stops before 1 is dispatched
      run,
      onError: async (n) => `failed:${n}`,
      shouldStop,
      skipped: (n) => `skipped:${n}`,
    });

    // THE assertion. If the latch were checked after `run`, this would be 5.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(0);
    expect(out.results).toEqual([
      "failed:0",
      "skipped:1",
      "skipped:2",
      "skipped:3",
      "skipped:4",
    ]);
    expect(out.stopped).toBe(true);
  });

  it("skipped items do not reach `onError` either — they are not failures", async () => {
    const onError = vi.fn(async (n: number) => `failed:${n}`);
    await runStoppablePool<number, string>({
      items: [0, 1, 2],
      concurrency: 1,
      run: async (n) => {
        if (n === 0) throw new StopError();
        return `ran:${n}`;
      },
      onError,
      shouldStop,
      skipped: (n) => `skipped:${n}`,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(0, expect.any(StopError));
  });
});

describe("runStoppablePool — rule 2: ONLY shouldStop sets the latch", () => {
  it("a soft error fails one item and the batch continues", async () => {
    const run = vi.fn(async (n: number) => {
      if (n === 1) throw new SoftError("bad territory");
      return `ran:${n}`;
    });

    const out = await runStoppablePool<number, string>({
      items: [0, 1, 2, 3],
      concurrency: 1,
      run,
      onError: async (n) => `failed:${n}`,
      shouldStop,
      skipped: (n) => `skipped:${n}`,
    });

    expect(run).toHaveBeenCalledTimes(4);
    expect(out.results).toEqual(["ran:0", "failed:1", "ran:2", "ran:3"]);
    expect(out.stopped).toBe(false);
    expect(out.results).not.toContain("skipped:2");
  });

  it("many soft errors still never stop the pool", async () => {
    const out = await runStoppablePool<number, string>({
      items: [0, 1, 2, 3, 4],
      concurrency: 2,
      run: async () => {
        throw new SoftError("every one of them");
      },
      onError: async (n) => `failed:${n}`,
      shouldStop,
      skipped: (n) => `skipped:${n}`,
    });
    expect(out.stopped).toBe(false);
    expect(out.results.every((r) => r.startsWith("failed:"))).toBe(true);
  });

  it("`onError` cannot stop the pool — it has no access to the latch", async () => {
    // onError here tries every trick a caller might: throwing a StopError of
    // its own must not latch, because rule 2 consults shouldStop on the
    // ORIGINAL error only.
    const run = vi.fn(async (n: number) => {
      if (n === 0) throw new SoftError();
      return `ran:${n}`;
    });
    const out = await runStoppablePool<number, string>({
      items: [0, 1, 2],
      concurrency: 1,
      run,
      onError: async (n) => `failed:${n}`,
      shouldStop: (err) => err instanceof StopError,
      skipped: (n) => `skipped:${n}`,
    });
    expect(out.stopped).toBe(false);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("the latch is set BEFORE onError runs — a sibling dispatched during onError's await sees it down", async () => {
    const seen: string[] = [];
    const run = vi.fn(async (n: number) => {
      seen.push(`run:${n}`);
      if (n === 0) throw new StopError();
      return `ran:${n}`;
    });
    await runStoppablePool<number, string>({
      items: [0, 1, 2],
      concurrency: 1,
      run,
      onError: async (n) => {
        // A real onError awaits an audit write here.
        await Promise.resolve();
        seen.push(`onError:${n}`);
        return `failed:${n}`;
      },
      shouldStop,
      skipped: (n) => `skipped:${n}`,
    });
    expect(seen).toEqual(["run:0", "onError:0"]);
  });
});

describe("runStoppablePool — rule 3: in-flight items finish and are recorded honestly", () => {
  it("a sibling mid-request when the latch trips keeps its REAL result", async () => {
    const gate = deferred<void>();
    const order: string[] = [];

    const out = await runStoppablePool<number, string>({
      items: [0, 1, 2, 3],
      concurrency: 2,
      run: async (n) => {
        if (n === 0) {
          // Item 1 is already in flight (concurrency 2) — hold it open,
          // stop the pool, then let it land.
          order.push("stop");
          gate.resolve();
          throw new StopError();
        }
        if (n === 1) {
          await gate.promise;
          order.push("inflight-finished");
          return "ran:1";
        }
        return `ran:${n}`;
      },
      onError: async (n) => `failed:${n}`,
      shouldStop,
      skipped: (n) => `skipped:${n}`,
    });

    // The in-flight sibling completed AFTER the stop and kept its own value —
    // not overwritten with a skip marker.
    expect(order).toEqual(["stop", "inflight-finished"]);
    expect(out.results[1]).toBe("ran:1");
    expect(out.stopped).toBe(true);
  });

  it("results are total and in input order — nothing is dropped or reordered", async () => {
    const out = await runStoppablePool<number, string>({
      items: [0, 1, 2, 3, 4, 5],
      concurrency: 3,
      run: async (n) => {
        if (n === 2) throw new StopError();
        return `ran:${n}`;
      },
      onError: async (n) => `failed:${n}`,
      shouldStop,
      skipped: (n) => `skipped:${n}`,
    });
    expect(out.results).toHaveLength(6);
    expect(out.results[2]).toBe("failed:2");
    // Every slot is filled by exactly one of the three shapes.
    for (const r of out.results) {
      expect(r).toMatch(/^(ran|failed|skipped):\d$/);
    }
  });
});

describe("runStoppablePool — degenerate inputs", () => {
  it("empty input returns empty, not stopped", async () => {
    const run = vi.fn();
    const out = await runStoppablePool<number, string>({
      items: [],
      concurrency: 4,
      run,
      onError: async () => "x",
      shouldStop,
      skipped: () => "s",
    });
    expect(out).toEqual({ results: [], stopped: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("a clean run never sets the latch", async () => {
    const out = await runStoppablePool<number, string>({
      items: [0, 1, 2],
      concurrency: 2,
      run: async (n) => `ran:${n}`,
      onError: async (n) => `failed:${n}`,
      shouldStop,
      skipped: (n) => `skipped:${n}`,
    });
    expect(out).toEqual({ results: ["ran:0", "ran:1", "ran:2"], stopped: false });
  });
});

/**
 * `shouldStopOnResult` — the stop signal that arrives on a SUCCESS.
 *
 * ⚠ WHY THIS EXISTS AT THE POOL LAYER AT ALL. Some work is partially
 * recoverable: the xlsx export's price read can be rate-limited while the row
 * it belongs to is still worth exporting. Forcing that to throw would delete a
 * usable row in order to report a budget fact. So the item succeeds AND the
 * latch falls.
 *
 * ⚠ AND WHY THESE TESTS ARE HERE RATHER THAN ONLY IN export-fetch. The
 * predicate was added for one caller, and its only coverage was through that
 * caller — the same layer gap that let a dead feature and two double-wraps
 * ship green in this module. A test that starts at the pool is the only one
 * that fails if the pool's own contract regresses.
 */
describe("runStoppablePool — shouldStopOnResult: a successful result can stop the pool", () => {
  it("(i) items after the trigger are skipped, and `run` is never called for them", async () => {
    const run = vi.fn(async (n: number) => (n === 1 ? "partial:1" : `ran:${n}`));

    const out = await runStoppablePool<number, string>({
      items: [0, 1, 2, 3],
      concurrency: 1,
      run,
      onError: async (n) => `failed:${n}`,
      shouldStop,
      shouldStopOnResult: (r) => r.startsWith("partial:"),
      skipped: (n) => `skipped:${n}`,
    });

    expect(out.stopped).toBe(true);
    // THE assertion: 2 and 3 never reached `run` at all.
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, 0);
    expect(run).toHaveBeenNthCalledWith(2, 1);
  });

  it("(ii) the TRIGGERING item keeps its own real result — it is not rewritten as skipped", async () => {
    // Rule 3, extended to this predicate. The item that trips the latch
    // SUCCEEDED; in the export it is a PARTIAL row that still belongs in the
    // file. Replacing it with the skip marker would report it as "nothing was
    // sent" when its request was sent, answered, and used.
    const out = await runStoppablePool<number, string>({
      items: [0, 1, 2],
      concurrency: 1,
      run: async (n) => (n === 1 ? "partial:1" : `ran:${n}`),
      onError: async (n) => `failed:${n}`,
      shouldStop,
      shouldStopOnResult: (r) => r.startsWith("partial:"),
      skipped: (n) => `skipped:${n}`,
    });

    expect(out.results).toEqual(["ran:0", "partial:1", "skipped:2"]);
    expect(out.results[1]).not.toBe("skipped:1");
  });

  it("(iii) the POOL owns the decision — identical results, opposite predicates, opposite outcomes", async () => {
    // Rule 2 stays structural with the new predicate: `run` cannot stop the
    // pool by returning a magic value. The same returned value stops one pool
    // and not the other, because the predicate — not the value — decides.
    const args = {
      items: [0, 1, 2],
      concurrency: 1,
      run: async (n: number) => (n === 1 ? "partial:1" : `ran:${n}`),
      onError: async (n: number) => `failed:${n}`,
      shouldStop,
      skipped: (n: number) => `skipped:${n}`,
    };

    const stops = await runStoppablePool<number, string>({
      ...args,
      shouldStopOnResult: (r) => r.startsWith("partial:"),
    });
    const doesNot = await runStoppablePool<number, string>({
      ...args,
      shouldStopOnResult: () => false,
    });

    expect(stops.stopped).toBe(true);
    expect(doesNot.stopped).toBe(false);
    expect(doesNot.results).toEqual(["ran:0", "partial:1", "ran:2"]);
  });

  it("(iii-b) omitting the predicate entirely leaves behaviour identical — bulk-availability's path", async () => {
    const out = await runStoppablePool<number, string>({
      items: [0, 1, 2],
      concurrency: 1,
      run: async (n) => (n === 1 ? "partial:1" : `ran:${n}`),
      onError: async (n) => `failed:${n}`,
      shouldStop,
      skipped: (n) => `skipped:${n}`,
    });
    expect(out).toEqual({
      results: ["ran:0", "partial:1", "ran:2"],
      stopped: false,
    });
  });

  it("a throw still routes to shouldStop, not to shouldStopOnResult", async () => {
    const shouldStopOnResult = vi.fn(() => false);
    const out = await runStoppablePool<number, string>({
      items: [0, 1, 2],
      concurrency: 1,
      run: async (n) => {
        if (n === 0) throw new StopError();
        return `ran:${n}`;
      },
      onError: async (n) => `failed:${n}`,
      shouldStop,
      shouldStopOnResult,
      skipped: (n) => `skipped:${n}`,
    });
    expect(out.stopped).toBe(true);
    // never consulted — item 0 threw, items 1-2 never ran
    expect(shouldStopOnResult).not.toHaveBeenCalled();
  });
});
