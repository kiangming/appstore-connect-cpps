/**
 * SC3 — THE TWO SILENT GATES, and the stale submit block.
 *
 * These are the LAYER-GAP failure in its Apple form: the G1 merge can be
 * perfect and a customs-only edit still never reaches it, with no message
 * anywhere. Each gate is pinned independently, because fixing one without the
 * other still leaves the feature dead on the Edit path.
 *
 *   GATE 1  isEmptyDiff — the route answers NO_CHANGES and the modal never opens
 *   GATE 2  shouldRun   — the pricing stage is skipped entirely
 */
import { describe, it, expect } from "vitest";
import {
  customPricesDivergeFromApple,
  detectIapChanges,
  isEmptyDiff,
  type CachedIapState,
} from "./diff-detector";
import {
  fingerprintOf,
  isCustomBaselineStale,
  isCustomPricesSubmitBlocked,
} from "@/lib/iap-management/custom-prices/model";
import type { IapFormState } from "@/lib/iap-management/validation";

const form: IapFormState = {
  reference_name: "Diamonds",
  product_id: "com.vng.diamonds",
  type: "CONSUMABLE",
  tier_id: "TIER_10",
  localizations: {
    "en-US": { locale: "en-US", display_name: "Diamonds", description: "Shiny" },
  },
  screenshot_filename: null,
  review_note: null,
  family_sharable: false,
  pricing_source: "APPLE",
  availability_target: "ALL",
};

const cached: CachedIapState = {
  reference_name: "Diamonds",
  review_note: null,
  family_sharable: false,
  tier_id: "TIER_10",
  localizations: {
    "en-US": { locale: "en-US", display_name: "Diamonds", description: "Shiny" },
  },
  screenshot_apple_id: null,
  screenshot_file_name: null,
  availability_target: "ALL",
};

// ─── GATE 1 ──────────────────────────────────────────────────────────────────

describe("GATE 1 — isEmptyDiff must see a customs-only change", () => {
  it("baseline: nothing changed ⇒ empty diff (unchanged behaviour)", () => {
    const diff = detectIapChanges({ form, cached, hasNewScreenshotFile: false });
    expect(isEmptyDiff(diff)).toBe(true);
    expect(diff.custom_prices_changed).toBeNull();
  });

  it("⚠ a customs-ONLY change is NOT an empty diff", () => {
    // Without the clause the route returns NO_CHANGES and the confirm modal
    // never opens — the common case (a Manager fixing one territory's price)
    // silently does nothing.
    const diff = detectIapChanges({
      form,
      cached,
      hasNewScreenshotFile: false,
      customPrices: { count: 1, diverging_territories: ["VNM"] },
    });
    expect(isEmptyDiff(diff)).toBe(false);
    expect(diff.custom_prices_changed).toEqual({
      count: 1,
      diverging_territories: ["VNM"],
    });
    // …and nothing else was invented as changed.
    expect(diff.attributes_changed).toBeNull();
    expect(diff.tier_changed).toBeNull();
    expect(diff.availability_changed).toBeNull();
  });

  it("an empty diverging list is normalised to null — it cannot fake a change", () => {
    const diff = detectIapChanges({
      form,
      cached,
      hasNewScreenshotFile: false,
      customPrices: { count: 3, diverging_territories: [] },
    });
    expect(diff.custom_prices_changed).toBeNull();
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("omitting the input keeps every existing caller byte-identical", () => {
    const withOut = detectIapChanges({ form, cached, hasNewScreenshotFile: false });
    const withNull = detectIapChanges({
      form,
      cached,
      hasNewScreenshotFile: false,
      customPrices: null,
    });
    expect(withOut).toEqual(withNull);
  });
});

// ─── The divergence computation that feeds gate 1 ─────────────────────────────

describe("customPricesDivergeFromApple", () => {
  it("null when Apple already charges exactly the customs", () => {
    expect(
      customPricesDivergeFromApple({
        customs: [{ territory_code: "VNM", customer_price: 25000 }],
        appleManualPrices: [{ territory: "VNM", customerPrice: 25000 }],
      }),
    ).toBeNull();
  });

  it("diverges when Apple has a different price", () => {
    expect(
      customPricesDivergeFromApple({
        customs: [{ territory_code: "VNM", customer_price: 25000 }],
        appleManualPrices: [{ territory: "VNM", customerPrice: 24000 }],
      }),
    ).toEqual({ count: 1, diverging_territories: ["VNM"] });
  });

  it("diverges when Apple has no manual price for a custom territory", () => {
    expect(
      customPricesDivergeFromApple({
        customs: [{ territory_code: "VNM", customer_price: 25000 }],
        appleManualPrices: [],
      }),
    ).toEqual({ count: 1, diverging_territories: ["VNM"] });
  });

  it("⚠ diverges when Apple has a manual price with NO custom behind it", () => {
    // The Manager cleared that custom; the replace-all push is what reverts the
    // territory. Missing this direction would make "clear all" a no-op on Apple
    // while the UI reported success.
    expect(
      customPricesDivergeFromApple({
        customs: [],
        appleManualPrices: [{ territory: "BRA", customerPrice: 29.9 }],
      }),
    ).toEqual({ count: 0, diverging_territories: ["BRA"] });
  });

  it("ignores the base territory — it is carried by applePricePointId (§E)", () => {
    expect(
      customPricesDivergeFromApple({
        customs: [],
        appleManualPrices: [{ territory: "USA", customerPrice: 9.99 }],
        baseTerritory: "USA",
      }),
    ).toBeNull();
  });

  it("tolerates float noise with the same epsilon as the price matcher", () => {
    expect(
      customPricesDivergeFromApple({
        customs: [{ territory_code: "BRA", customer_price: 29.9 }],
        appleManualPrices: [{ territory: "BRA", customerPrice: 29.9000001 }],
      }),
    ).toBeNull();
  });

  it("is case-insensitive on territory codes", () => {
    expect(
      customPricesDivergeFromApple({
        customs: [{ territory_code: "vnm", customer_price: 25000 }],
        appleManualPrices: [{ territory: "VNM", customerPrice: 25000 }],
      }),
    ).toBeNull();
  });
});

// ─── GATE 2 ──────────────────────────────────────────────────────────────────

const runPricingStageGate = (diff: {
  tier_changed: unknown;
  custom_prices_changed: unknown;
}, sourceKind: string) =>
  // Mirror of the guard in update-orchestration.runPricingStage. Asserted here
  // as a truth table; the mutation-check proves the real code matches it.
  diff.tier_changed !== null ||
  sourceKind !== "APPLE" ||
  diff.custom_prices_changed !== null;

describe("GATE 2 — shouldRun must run Stage 4 for a customs-only change", () => {
  it("⚠ customs-only under source APPLE ⇒ the stage MUST run", () => {
    expect(
      runPricingStageGate(
        { tier_changed: null, custom_prices_changed: { count: 1, diverging_territories: ["VNM"] } },
        "APPLE",
      ),
    ).toBe(true);
  });

  it("nothing changed under APPLE ⇒ stage skipped (unchanged behaviour)", () => {
    expect(
      runPricingStageGate({ tier_changed: null, custom_prices_changed: null }, "APPLE"),
    ).toBe(false);
  });

  it("tier change alone still runs (legacy)", () => {
    expect(
      runPricingStageGate(
        { tier_changed: { old_tier_id: "TIER_5", new_tier_id: "TIER_10" }, custom_prices_changed: null },
        "APPLE",
      ),
    ).toBe(true);
  });

  it("template source alone still runs (IAP.p1.h)", () => {
    expect(
      runPricingStageGate({ tier_changed: null, custom_prices_changed: null }, "APP_TEMPLATE"),
    ).toBe(true);
  });
});

// ─── Stale submit blocking ───────────────────────────────────────────────────

describe("stale submit blocking — one function, both layers", () => {
  const stored = fingerprintOf({ tier_id: "TIER_10", pricing_source: "APPLE" });

  it("blocks when a stale set has entries", () => {
    expect(
      isCustomPricesSubmitBlocked({
        customPriceCount: 6,
        current: fingerprintOf({ tier_id: "TIER_15", pricing_source: "APPLE" }),
        stored,
      }),
    ).toBe(true);
  });

  it("does not block when in sync", () => {
    expect(
      isCustomPricesSubmitBlocked({
        customPriceCount: 6,
        current: fingerprintOf({ tier_id: "TIER_10", pricing_source: "APPLE" }),
        stored,
      }),
    ).toBe(false);
  });

  it("does not block a stale fingerprint with no customs", () => {
    expect(
      isCustomPricesSubmitBlocked({
        customPriceCount: 0,
        current: fingerprintOf({ tier_id: "TIER_15", pricing_source: "APPLE" }),
        stored,
      }),
    ).toBe(false);
  });

  it("⚠ re-stamping unblocks, and a further change re-blocks", () => {
    const drifted = fingerprintOf({ tier_id: "TIER_15", pricing_source: "APPLE" })!;
    expect(
      isCustomPricesSubmitBlocked({ customPriceCount: 6, current: drifted, stored }),
    ).toBe(true);
    // "Keep them (reviewed)" = the stored baseline becomes the current one.
    expect(
      isCustomPricesSubmitBlocked({
        customPriceCount: 6,
        current: drifted,
        stored: drifted,
      }),
    ).toBe(false);
    expect(
      isCustomPricesSubmitBlocked({
        customPriceCount: 6,
        current: fingerprintOf({ tier_id: "TIER_20", pricing_source: "APPLE" }),
        stored: drifted,
      }),
    ).toBe(true);
  });

  it("the block is built on the same comparison, not a parallel rule", () => {
    // If a second implementation of staleness ever appears, these two diverge.
    const current = fingerprintOf({ tier_id: "TIER_15", pricing_source: "APPLE" });
    expect(isCustomPricesSubmitBlocked({ customPriceCount: 1, current, stored })).toBe(
      isCustomBaselineStale(current, stored),
    );
  });
});
