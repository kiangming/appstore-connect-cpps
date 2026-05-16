import { describe, it, expect } from "vitest";
import {
  computeWillSubmitCount,
  type WillSubmitDecisionLike,
} from "./will-submit";

function d(
  product_id: string,
  disposition: WillSubmitDecisionLike["disposition"],
): WillSubmitDecisionLike {
  return { product_id, disposition };
}

describe("computeWillSubmitCount — Step 3 bifurcation logic", () => {
  it("returns 0 when submitOnCreate is false regardless of screenshots", () => {
    const decisions = [d("p1", "CREATE"), d("p2", "CREATE")];
    const shots = new Set(["p1", "p2"]);
    expect(computeWillSubmitCount(decisions, shots, false)).toBe(0);
  });

  it("counts only CREATE rows that have a matched screenshot", () => {
    const decisions = [
      d("p1", "CREATE"), // shot present → counts
      d("p2", "CREATE"), // shot missing → skip
      d("p3", "OVERWRITE"), // overwrite path → skip (no submit on overwrite)
      d("p4", "SKIP"), // skipped → skip
      d("p5", "ERROR"), // error → skip
    ];
    const shots = new Set(["p1", "p3", "p4"]);
    expect(computeWillSubmitCount(decisions, shots, true)).toBe(1);
  });

  it("returns total CREATE count when every CREATE has a screenshot", () => {
    const decisions = [
      d("p1", "CREATE"),
      d("p2", "CREATE"),
      d("p3", "CREATE"),
    ];
    const shots = new Set(["p1", "p2", "p3"]);
    expect(computeWillSubmitCount(decisions, shots, true)).toBe(3);
  });

  it("returns 0 when no CREATE row has a screenshot", () => {
    const decisions = [d("p1", "CREATE"), d("p2", "CREATE")];
    const shots = new Set<string>();
    expect(computeWillSubmitCount(decisions, shots, true)).toBe(0);
  });

  it("handles empty decisions list", () => {
    expect(computeWillSubmitCount([], new Set(["x"]), true)).toBe(0);
  });
});
