import { describe, it, expect } from "vitest";

import { resolvePurchaseOptionFromLive } from "./resolve-purchase-options";
import type { OneTimeProductPurchaseOption } from "./onetime-product-adapter";

function option(
  id: string,
  overrides: Partial<OneTimeProductPurchaseOption> = {},
): OneTimeProductPurchaseOption {
  return {
    purchaseOptionId: id,
    state: "ACTIVE",
    ...overrides,
  };
}

describe("resolvePurchaseOptionFromLive", () => {
  it("falls back to the default id when the live product has no purchase options", () => {
    const result = resolvePurchaseOptionFromLive([]);
    expect(result.purchaseOptionId).toBe("buy");
    expect(result.hasMultipleActiveOptions).toBe(false);
  });

  it("falls back to the default id when options is null/undefined", () => {
    expect(resolvePurchaseOptionFromLive(null).purchaseOptionId).toBe("buy");
    expect(resolvePurchaseOptionFromLive(undefined).purchaseOptionId).toBe("buy");
  });

  it("resolves the REAL legacy id (legacy-base) instead of the hardcoded 'buy' default", () => {
    const options = [
      option("legacy-base", { buyOption: { legacyCompatible: true } }),
    ];
    const result = resolvePurchaseOptionFromLive(options);
    expect(result.purchaseOptionId).toBe("legacy-base");
    expect(result.hasMultipleActiveOptions).toBe(false);
  });

  it("prefers legacyCompatible buyOption over a plain buyOption", () => {
    const options = [
      option("buy", { buyOption: {} }),
      option("legacy-base", { buyOption: { legacyCompatible: true } }),
    ];
    const result = resolvePurchaseOptionFromLive(options);
    expect(result.purchaseOptionId).toBe("legacy-base");
  });

  it("falls back to any buyOption when no legacyCompatible option exists", () => {
    const options = [
      option("rent-1", { rentOption: {} }),
      option("buy-custom", { buyOption: {} }),
    ];
    const result = resolvePurchaseOptionFromLive(options);
    expect(result.purchaseOptionId).toBe("buy-custom");
  });

  it("falls back to the first option when there is no buyOption at all", () => {
    const options = [option("rent-only", { rentOption: {} })];
    const result = resolvePurchaseOptionFromLive(options);
    expect(result.purchaseOptionId).toBe("rent-only");
  });

  it("flags hasMultipleActiveOptions when 2+ options are ACTIVE (not just present)", () => {
    const options = [
      option("legacy-base", { buyOption: { legacyCompatible: true }, state: "ACTIVE" }),
      option("buy", { buyOption: {}, state: "ACTIVE" }),
    ];
    const result = resolvePurchaseOptionFromLive(options);
    expect(result.hasMultipleActiveOptions).toBe(true);
    // Still resolves a single target (legacyCompatible wins) — full-set
    // handling is out of scope; this only surfaces the edge case.
    expect(result.purchaseOptionId).toBe("legacy-base");
  });

  it("does NOT flag hasMultipleActiveOptions when only one option is ACTIVE (others DRAFT/INACTIVE)", () => {
    const options = [
      option("legacy-base", { buyOption: { legacyCompatible: true }, state: "ACTIVE" }),
      option("buy", { buyOption: {}, state: "DRAFT" }),
    ];
    const result = resolvePurchaseOptionFromLive(options);
    expect(result.hasMultipleActiveOptions).toBe(false);
  });
});
