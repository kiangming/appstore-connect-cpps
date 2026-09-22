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

  it("returns TIER_5 for price 4.99 — the standard tier wins the tie", () => {
    /**
     * ⚠ THIS ASSERTION WAS `toBe("ALT_5")`, AND CHANGING IT RESTORES THE
     * TITLE — IT DOES NOT RELAX THE TEST.
     *
     * Read the title above as it stood before [TIER-TIEBREAK-priority]:
     *
     *   "returns TIER_5 for price 4.99 (tier_id ASC tie-break wins over ALT_5)"
     *
     * …directly above `expect(...).toBe("ALT_5")`. The title says TIER_5, the
     * assertion said ALT_5, and the deleted comment narrated the discovery in
     * between: "So per literal spec, the answer is ALT_5. Verify the actual
     * rule." Whoever wrote this expected the standard tier, met the alternate,
     * and corrected the assertion instead of the rule. The file has carried
     * that contradiction ever since.
     *
     * The cause was never a decision to prefer Alternate Tiers. It was the id
     * naming scheme: `"ALT_".localeCompare("TIER_")` is negative, so `ALT_*`
     * won every shared price by alphabet. The tie-break now reads the explicit
     * ranking in `lib/iap-management/tier-order.ts` — `FREE` → `TIER_<n>` →
     * `ALT_<số>` → `ALT_<chữ>` — which is the order `queries/template-matrix.
     * ts:87-88` has always used for the matrix screen, and the order the
     * now-deleted local `sortTierId` in this very file already encoded.
     *
     * ⚠ AND IT IS NOT COSMETIC. Census SQL over production data (2026-09-22,
     * KB §26): two tiers that tie on USD diverge in other territories —
     * $4.99 differs in 9 of 175 countries, $0.99 in 75. Picking the wrong one
     * moves real prices in real markets.
     */
    expect(resolveTierByUsdPrice(4.99, tiers)).toBe("TIER_5");
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
