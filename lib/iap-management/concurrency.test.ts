import { describe, it, expect } from "vitest";
import { withConcurrency } from "./concurrency";

describe("withConcurrency", () => {
  it("returns empty for empty input", async () => {
    const result = await withConcurrency([], 5, async () => "x");
    expect(result).toEqual([]);
  });

  it("rejects limit < 1", async () => {
    await expect(
      withConcurrency([1, 2, 3], 0, async (n) => n),
    ).rejects.toThrow(/limit must be/);
  });

  it("preserves result order matching input order", async () => {
    const items = [10, 20, 30, 40, 50];
    const results = await withConcurrency(items, 2, async (n) => n * 2);
    expect(results).toEqual([20, 40, 60, 80, 100]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await withConcurrency(items, 5, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5 + (n % 3)));
      active--;
      return n;
    });

    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it("propagates errors and waits for in-flight tasks", async () => {
    const items = [1, 2, 3];
    await expect(
      withConcurrency(items, 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow(/boom/);
  });
});
