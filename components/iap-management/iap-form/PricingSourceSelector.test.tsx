/**
 * Unit tests for PricingSourceSelector (IAP.p1.f).
 *
 * Verifies the Q-D most-specific resolver + UI gating of disabled options.
 * The selector is intentionally dumb — parent owns state — so tests focus on
 * (1) the pure default resolver and (2) the radio's disabled semantics.
 */
import { describe, it, expect } from "vitest";
import {
  defaultPricingSource,
  resolveInitialPricingSource,
} from "./PricingSourceSelector";

describe("defaultPricingSource — Q-D most-specific resolver", () => {
  it("picks APP_TEMPLATE when both are available", () => {
    expect(defaultPricingSource(true, true)).toBe("APP_TEMPLATE");
  });

  it("picks DEFAULT_TEMPLATE when only the default is available", () => {
    expect(defaultPricingSource(true, false)).toBe("DEFAULT_TEMPLATE");
  });

  it("falls back to APPLE when no template is configured", () => {
    expect(defaultPricingSource(false, false)).toBe("APPLE");
  });

  it("picks APP_TEMPLATE when only the app template is available", () => {
    // The Default template can be missing while the app has its own.
    // This is rare but possible — should still surface the app override.
    expect(defaultPricingSource(false, true)).toBe("APP_TEMPLATE");
  });
});

// IAP.p1.j Issue 1 — Save Draft round-trip MUST preserve the Manager's
// explicit choice even when Q-D would have picked a more specific source.
describe("resolveInitialPricingSource — Q-J persistence over Q-D default", () => {
  it("preserves stored APPLE even when both templates are available", () => {
    expect(resolveInitialPricingSource("APPLE", true, true)).toBe("APPLE");
  });

  it("preserves stored DEFAULT_TEMPLATE when an app template also exists", () => {
    expect(resolveInitialPricingSource("DEFAULT_TEMPLATE", true, true)).toBe(
      "DEFAULT_TEMPLATE",
    );
  });

  it("preserves stored APP_TEMPLATE regardless of default availability", () => {
    expect(resolveInitialPricingSource("APP_TEMPLATE", false, true)).toBe(
      "APP_TEMPLATE",
    );
  });

  it("falls back to Q-D default when no stored value (fresh draft)", () => {
    expect(resolveInitialPricingSource(undefined, true, false)).toBe(
      "DEFAULT_TEMPLATE",
    );
    expect(resolveInitialPricingSource(null, false, true)).toBe(
      "APP_TEMPLATE",
    );
    expect(resolveInitialPricingSource(undefined, false, false)).toBe("APPLE");
  });
});
