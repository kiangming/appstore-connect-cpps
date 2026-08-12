/**
 * Per-territory Custom Prices — pure model.
 *
 * The load-bearing properties, in order of how much damage losing them does:
 *   1. staleness is a COMPARISON, not a boolean (change-and-change-back clears)
 *   2. "cleared" is unrepresentable as a value — clearing DELETES the key
 *   3. `untouched` and `replace []` never collapse
 *   4. one territory can hold at most one price
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_BASE_TERRITORY,
  clearAllCustomPrices,
  clearCustomPrice,
  customPriceCount,
  describeBaselineDrift,
  fingerprintOf,
  hasCustomPrice,
  isCustomBaselineStale,
  isCustomPricesSubmitBlocked,
  isValidCustomPriceEntry,
  normalizeEntries,
  persistIntentFrom,
  setCustomPrice,
  toCustomPriceEntries,
  toCustomPriceSet,
  type CustomPriceEntry,
} from "./model";

const VNM: CustomPriceEntry = {
  territory_code: "VNM",
  customer_price: 25000,
  currency_code: "VND",
};
const JPN: CustomPriceEntry = {
  territory_code: "JPN",
  customer_price: 1200,
  currency_code: "JPY",
};

// ─── 1. The fingerprint + staleness comparison ───────────────────────────────

describe("fingerprintOf", () => {
  it("fills pricing_source and base_territory defaults", () => {
    expect(fingerprintOf({ tier_id: "TIER_10" })).toEqual({
      tier_id: "TIER_10",
      pricing_source: "APPLE",
      base_territory: DEFAULT_BASE_TERRITORY,
    });
  });

  it("returns null without a tier — a custom overrides a base, so with no base there is nothing to measure (CP-3)", () => {
    expect(fingerprintOf({ tier_id: null })).toBeNull();
    expect(fingerprintOf({ tier_id: undefined })).toBeNull();
    expect(fingerprintOf({ tier_id: "" })).toBeNull();
  });
});

describe("isCustomBaselineStale — a COMPARISON, never a one-way boolean", () => {
  const stored = fingerprintOf({
    tier_id: "TIER_10",
    pricing_source: "APP_TEMPLATE",
  })!;

  it("same baseline → NOT stale", () => {
    const current = fingerprintOf({
      tier_id: "TIER_10",
      pricing_source: "APP_TEMPLATE",
    });
    expect(isCustomBaselineStale(current, stored)).toBe(false);
  });

  it("changed tier → stale", () => {
    const current = fingerprintOf({
      tier_id: "TIER_15",
      pricing_source: "APP_TEMPLATE",
    });
    expect(isCustomBaselineStale(current, stored)).toBe(true);
  });

  it("changed pricing source → stale (it selects which template's overrides apply)", () => {
    const current = fingerprintOf({
      tier_id: "TIER_10",
      pricing_source: "DEFAULT_TEMPLATE",
    });
    expect(isCustomBaselineStale(current, stored)).toBe(true);
  });

  it("changed base territory → stale (constant today; the multi-base follow-up moves it)", () => {
    const current = fingerprintOf({
      tier_id: "TIER_10",
      pricing_source: "APP_TEMPLATE",
      base_territory: "JPN",
    });
    expect(isCustomBaselineStale(current, stored)).toBe(true);
  });

  it("⚠ changed AND CHANGED BACK → NOT stale, with no user action", () => {
    // The whole reason the design forbids a stored boolean: a one-way flag
    // would still be set here and would force the Manager to acknowledge a
    // no-op — and worse, would swallow a LATER real change.
    const changed = fingerprintOf({
      tier_id: "TIER_15",
      pricing_source: "APP_TEMPLATE",
    });
    expect(isCustomBaselineStale(changed, stored)).toBe(true);

    const changedBack = fingerprintOf({
      tier_id: "TIER_10",
      pricing_source: "APP_TEMPLATE",
    });
    expect(isCustomBaselineStale(changedBack, stored)).toBe(false);
  });

  it("re-stamping ('Keep them (reviewed)') clears staleness, and a FURTHER change re-triggers it", () => {
    const afterChange = fingerprintOf({
      tier_id: "TIER_15",
      pricing_source: "APP_TEMPLATE",
    })!;
    expect(isCustomBaselineStale(afterChange, stored)).toBe(true);

    // Re-stamp = the stored baseline becomes the current one. No flag anywhere.
    const restamped = afterChange;
    expect(isCustomBaselineStale(afterChange, restamped)).toBe(false);

    const changedAgain = fingerprintOf({
      tier_id: "TIER_20",
      pricing_source: "APP_TEMPLATE",
    });
    expect(isCustomBaselineStale(changedAgain, restamped)).toBe(true);
  });

  it("no stored baseline → not stale (nothing was ever baselined)", () => {
    expect(isCustomBaselineStale(fingerprintOf({ tier_id: "TIER_1" }), null)).toBe(
      false,
    );
    expect(isCustomBaselineStale(null, null)).toBe(false);
  });

  it("tier cleared while customs exist → stale (they are certainly not against the current base)", () => {
    expect(isCustomBaselineStale(null, stored)).toBe(true);
  });
});

describe("isCustomPricesSubmitBlocked", () => {
  const stored = fingerprintOf({ tier_id: "TIER_10" })!;
  const drifted = fingerprintOf({ tier_id: "TIER_15" });

  it("blocks when a stale set has entries", () => {
    expect(
      isCustomPricesSubmitBlocked({
        customPriceCount: 6,
        current: drifted,
        stored,
      }),
    ).toBe(true);
  });

  it("does NOT block a stale fingerprint with zero customs — nothing to review", () => {
    expect(
      isCustomPricesSubmitBlocked({
        customPriceCount: 0,
        current: drifted,
        stored,
      }),
    ).toBe(false);
  });

  it("does not block when in sync", () => {
    expect(
      isCustomPricesSubmitBlocked({
        customPriceCount: 6,
        current: fingerprintOf({ tier_id: "TIER_10" }),
        stored,
      }),
    ).toBe(false);
  });
});

describe("describeBaselineDrift — one wording for the banner and the 422", () => {
  it("is empty when not stale", () => {
    const b = fingerprintOf({ tier_id: "TIER_10" })!;
    expect(describeBaselineDrift(b, b)).toEqual([]);
  });

  it("names every changed component", () => {
    const stored = fingerprintOf({
      tier_id: "TIER_10",
      pricing_source: "APPLE",
    })!;
    const current = fingerprintOf({
      tier_id: "TIER_15",
      pricing_source: "APP_TEMPLATE",
    });
    expect(describeBaselineDrift(current, stored)).toEqual([
      "price tier TIER_10 → TIER_15",
      "pricing source APPLE → APP_TEMPLATE",
    ]);
  });

  it("explains a cleared tier", () => {
    const stored = fingerprintOf({ tier_id: "TIER_10" })!;
    expect(describeBaselineDrift(null, stored)).toEqual([
      "price tier cleared (was TIER_10)",
    ]);
  });
});

// ─── 2. "Cleared" is unrepresentable as a value ──────────────────────────────

describe("clearing DELETES the key — the dead-affordance fix", () => {
  it("clearCustomPrice removes the territory entirely, never writes a sentinel", () => {
    const set = toCustomPriceSet([VNM, JPN]);
    const cleared = clearCustomPrice(set, "VNM");

    expect(cleared.has("VNM")).toBe(false);
    expect(hasCustomPrice(cleared, "VNM")).toBe(false);
    // The distinguishing assertion: after clearing, the territory is
    // indistinguishable from one that never had a custom. If the
    // implementation wrote null/0/"" instead, `get` would return an object.
    expect(cleared.get("VNM")).toBeUndefined();
    expect(toCustomPriceEntries(cleared)).toEqual([JPN]);
  });

  it("a cleared territory is byte-identical to a never-set one", () => {
    const neverSet = toCustomPriceSet([JPN]);
    const clearedBack = clearCustomPrice(toCustomPriceSet([VNM, JPN]), "VNM");
    expect(toCustomPriceEntries(clearedBack)).toEqual(
      toCustomPriceEntries(neverSet),
    );
  });

  it("clearAllCustomPrices yields an empty set, always exitable", () => {
    expect(customPriceCount(clearAllCustomPrices())).toBe(0);
  });

  it("clearing an absent territory is a no-op, not an error", () => {
    const set = toCustomPriceSet([JPN]);
    expect(toCustomPriceEntries(clearCustomPrice(set, "BRA"))).toEqual([JPN]);
  });

  it("rejects a non-finite or negative price rather than storing a sentinel", () => {
    expect(
      isValidCustomPriceEntry({ ...VNM, customer_price: Number.NaN }),
    ).toBe(false);
    expect(isValidCustomPriceEntry({ ...VNM, customer_price: -1 })).toBe(false);
    expect(isValidCustomPriceEntry({ ...VNM, currency_code: "  " })).toBe(false);
    expect(isValidCustomPriceEntry({ ...VNM, territory_code: "" })).toBe(false);
    // Free is a legitimate price point.
    expect(isValidCustomPriceEntry({ ...VNM, customer_price: 0 })).toBe(true);
  });

  it("setCustomPrice ignores an invalid entry instead of poisoning the set", () => {
    const set = toCustomPriceSet([JPN]);
    const attempted = setCustomPrice(set, { ...VNM, customer_price: Number.NaN });
    expect(toCustomPriceEntries(attempted)).toEqual([JPN]);
  });

  it("does not mutate its input (set/clear are pure)", () => {
    const set = toCustomPriceSet([JPN]);
    setCustomPrice(set, VNM);
    clearCustomPrice(set, "JPN");
    expect(toCustomPriceEntries(set)).toEqual([JPN]);
  });
});

// ─── 3. untouched vs explicit-clear never collapse ───────────────────────────

describe("persistIntentFrom — the two meanings of empty, kept apart", () => {
  it("absent field → untouched (leave the stored set alone)", () => {
    expect(persistIntentFrom(undefined)).toEqual({ kind: "untouched" });
    expect(persistIntentFrom(null)).toEqual({ kind: "untouched" });
  });

  it("empty array → replace with nothing, i.e. an EXPLICIT clear", () => {
    expect(persistIntentFrom([])).toEqual({ kind: "replace", entries: [] });
  });

  it("untouched and explicit-clear are distinguishable — the whole point", () => {
    const untouched = persistIntentFrom(undefined);
    const cleared = persistIntentFrom([]);
    expect(untouched.kind).not.toBe(cleared.kind);
  });

  it("populated array → replace with normalized entries", () => {
    const intent = persistIntentFrom([VNM]);
    expect(intent).toEqual({ kind: "replace", entries: [VNM] });
  });
});

// ─── 4. One price per territory + canonical shape ────────────────────────────

describe("normalizeEntries", () => {
  it("collapses duplicate territories LAST-WINS (the PK is the real defence)", () => {
    const out = normalizeEntries([
      VNM,
      { territory_code: "VNM", customer_price: 39000, currency_code: "VND" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].customer_price).toBe(39000);
  });

  it("a set can never hold two prices for one territory", () => {
    const set = setCustomPrice(toCustomPriceSet([VNM]), {
      territory_code: "VNM",
      customer_price: 39000,
      currency_code: "VND",
    });
    expect(set.size).toBe(1);
    expect(set.get("VNM")?.customer_price).toBe(39000);
  });

  it("uppercases and trims codes so casing cannot create a second key", () => {
    const out = normalizeEntries([
      { territory_code: " vnm ", customer_price: 25000, currency_code: "vnd" },
    ]);
    expect(out).toEqual([VNM]);
  });

  it("sorts by territory so storage order is canonical", () => {
    expect(normalizeEntries([VNM, JPN]).map((e) => e.territory_code)).toEqual([
      "JPN",
      "VNM",
    ]);
  });

  it("drops invalid entries rather than passing them to the DB", () => {
    expect(normalizeEntries([VNM, { ...JPN, customer_price: Number.NaN }])).toEqual(
      [VNM],
    );
  });

  it("round-trips set → entries → set", () => {
    const entries = [VNM, JPN];
    expect(toCustomPriceEntries(toCustomPriceSet(entries))).toEqual(
      normalizeEntries(entries),
    );
  });
});
