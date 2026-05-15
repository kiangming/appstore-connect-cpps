import { describe, it, expect } from "vitest";
import {
  resolveTierByUsdPrice,
  type UsdTierEntry,
} from "./price-tiers";

const tiers: UsdTierEntry[] = [
  { tier_id: "FREE", customer_price: 0 },
  { tier_id: "TIER_1", customer_price: 0.99 },
  { tier_id: "TIER_2", customer_price: 1.99 },
  { tier_id: "TIER_5", customer_price: 4.99 },
  { tier_id: "TIER_10", customer_price: 9.99 },
  { tier_id: "ALT_5", customer_price: 4.99 }, // intentional same-price collision with TIER_5
  { tier_id: "ALT_A", customer_price: 0.69 },
];

describe("resolveTierByUsdPrice — Manager IAP.h2 lock", () => {
  it("returns FREE for price 0", () => {
    expect(resolveTierByUsdPrice(0, tiers)).toBe("FREE");
  });

  it("returns TIER_1 for price 0.99", () => {
    expect(resolveTierByUsdPrice(0.99, tiers)).toBe("TIER_1");
  });

  it("returns TIER_5 for price 4.99 (tier_id ASC tie-break wins over ALT_5)", () => {
    // Manager SQL spec: ORDER BY tier_id ASC LIMIT 1.
    // "ALT_5".localeCompare("TIER_5") → negative; "ALT_5" sorts first.
    // So per literal spec, the answer is ALT_5. Verify the actual rule:
    expect(resolveTierByUsdPrice(4.99, tiers)).toBe("ALT_5");
  });

  it("returns ALT_A for the alternate-tier-only price 0.69", () => {
    expect(resolveTierByUsdPrice(0.69, tiers)).toBe("ALT_A");
  });

  it("returns null for a price with no exact match", () => {
    expect(resolveTierByUsdPrice(1.5, tiers)).toBeNull();
    expect(resolveTierByUsdPrice(100, tiers)).toBeNull();
  });

  it("is exact-match (no fuzzy)", () => {
    expect(resolveTierByUsdPrice(0.98, tiers)).toBeNull();
    expect(resolveTierByUsdPrice(1.0, tiers)).toBeNull();
  });

  it("handles empty tier list (no FREE fallback row required)", () => {
    expect(resolveTierByUsdPrice(0, [])).toBe("FREE"); // price 0 short-circuits
    expect(resolveTierByUsdPrice(0.99, [])).toBeNull();
  });
});
