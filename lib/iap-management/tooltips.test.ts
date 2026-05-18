import { describe, it, expect } from "vitest";
import { tooltipFor, TOOLTIP_KEYS } from "./tooltips";

describe("tooltips", () => {
  it("returns a non-empty string for every declared key", () => {
    for (const key of TOOLTIP_KEYS) {
      const copy = tooltipFor(key);
      expect(copy.length).toBeGreaterThan(0);
    }
  });

  it("exposes the mockup-anchored entries (regression pin)", () => {
    // These four are the most visible in the mockup; if a future refactor
    // accidentally drops them, the view sections regress to bare labels.
    expect(tooltipFor("product-id")).toMatch(/unique alphanumeric/i);
    expect(tooltipFor("reference-name")).toMatch(/not visible to customers/i);
    expect(tooltipFor("base-territory")).toMatch(/equalizes/i);
    expect(tooltipFor("review-screenshot")).toMatch(/review team/i);
  });
});
