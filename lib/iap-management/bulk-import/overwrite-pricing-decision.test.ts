import { describe, it, expect } from "vitest";

import { decideOverwritePricing } from "./overwrite-pricing-decision";

describe("decideOverwritePricing (Hotfix 23 regression)", () => {
  it("runs pricing when tier_id matches the cache — the Manager bug repro", () => {
    // Manager scenario: v1 template assigns Tier 1 → 10 countries.
    // Cached tier on the local row = "TIER_1". Manager replaces the
    // template to v2 (Tier 1 → 4 countries). Re-importing the same
    // SKU still resolves to "TIER_1". Pre-Hotfix-23 the gate
    // short-circuited the POST and Apple stayed on the v1 schedule.
    const d = decideOverwritePricing({
      resolvedTierId: "TIER_1",
      cachedTierId: "TIER_1",
    });
    expect(d.shouldRunPricing).toBe(true);
    expect(d.tierUnchanged).toBe(true);
    expect(d.preFixWouldSkip).toBe(true);
  });

  it("runs pricing when the resolved tier differs from cache (always did, still does)", () => {
    const d = decideOverwritePricing({
      resolvedTierId: "TIER_2",
      cachedTierId: "TIER_1",
    });
    expect(d.shouldRunPricing).toBe(true);
    expect(d.tierUnchanged).toBe(false);
    expect(d.preFixWouldSkip).toBe(false);
  });

  it("runs pricing when cache is missing (the 'treated as differs' rule pre-fix)", () => {
    const d = decideOverwritePricing({
      resolvedTierId: "TIER_1",
      cachedTierId: null,
    });
    expect(d.shouldRunPricing).toBe(true);
    expect(d.tierUnchanged).toBe(false);
    expect(d.preFixWouldSkip).toBe(false);
  });

  it("skips pricing when no resolved tier — no schedule to push", () => {
    const d = decideOverwritePricing({
      resolvedTierId: null,
      cachedTierId: "TIER_1",
    });
    expect(d.shouldRunPricing).toBe(false);
  });

  it("skips pricing when neither resolved nor cached tier is present", () => {
    const d = decideOverwritePricing({
      resolvedTierId: null,
      cachedTierId: null,
    });
    expect(d.shouldRunPricing).toBe(false);
  });
});
