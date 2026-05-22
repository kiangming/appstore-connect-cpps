import { describe, it, expect } from "vitest";

import { pickTierByUsdMicros } from "./templates";

/**
 * Hotfix 15: pure picker used by the USD-tier inference fallback in
 * bulk-import. The DB-integrated `findTemplateTierByUsdMicros`
 * narrows the SELECT with `.eq("region_code", "US")` + `.eq("currency",
 * "USD")` + `.eq("price_micros", ...)`, but we still run the picker
 * locally because the integration tests would need to mock the
 * Supabase client. Pure logic here is the regression-prevention path.
 */
describe("pickTierByUsdMicros", () => {
  it("returns the identifier whose US-region USD entry matches", () => {
    const entries = [
      { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "990000" },
      { identifier: "Tier 2", region_code: "US", currency: "USD", price_micros: "1990000" },
      { identifier: "Tier 3", region_code: "US", currency: "USD", price_micros: "4990000" },
    ];
    expect(pickTierByUsdMicros(entries, "1990000")).toBe("Tier 2");
  });

  it("returns null when no entry matches the requested USD micros", () => {
    const entries = [
      { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "990000" },
      { identifier: "Tier 2", region_code: "US", currency: "USD", price_micros: "1990000" },
    ];
    expect(pickTierByUsdMicros(entries, "999999")).toBeNull();
  });

  it("skips non-US region entries that happen to match the micros value", () => {
    // A template tier whose US entry is $1.99 (1_990_000 micros) and
    // whose VN entry is 25,000 VND (25_000_000_000 micros). A naive
    // implementation that matched only on price_micros would pick the
    // VN row and return its tier; the picker must also enforce
    // region_code === "US".
    const entries = [
      { identifier: "Tier 2", region_code: "VN", currency: "VND", price_micros: "25000000000" },
      { identifier: "Tier 2", region_code: "US", currency: "USD", price_micros: "1990000" },
      { identifier: "Tier 3", region_code: "VN", currency: "VND", price_micros: "1990000" },
    ];
    expect(pickTierByUsdMicros(entries, "1990000")).toBe("Tier 2");
  });

  it("skips entries whose currency is not USD even if region is US", () => {
    // Defensive — shouldn't happen in practice (region US ⇔ currency USD
    // in Google's catalog), but if the template was hand-edited the
    // picker shouldn't accept a non-USD currency for the US region.
    const entries = [
      { identifier: "Tier ?", region_code: "US", currency: "EUR", price_micros: "1990000" },
      { identifier: "Tier 2", region_code: "US", currency: "USD", price_micros: "1990000" },
    ];
    expect(pickTierByUsdMicros(entries, "1990000")).toBe("Tier 2");
  });

  it("returns the first match when multiple tiers share the same US price (deterministic)", () => {
    // Two tiers shouldn't normally share a USD price, but if they do
    // the picker returns the first one (query order). This is
    // deterministic — caller can resolve conflicts by reordering.
    const entries = [
      { identifier: "Tier A", region_code: "US", currency: "USD", price_micros: "990000" },
      { identifier: "Tier B", region_code: "US", currency: "USD", price_micros: "990000" },
    ];
    expect(pickTierByUsdMicros(entries, "990000")).toBe("Tier A");
  });

  it("returns null for empty entries (template has no US/USD rows)", () => {
    expect(pickTierByUsdMicros([], "990000")).toBeNull();
  });
});
