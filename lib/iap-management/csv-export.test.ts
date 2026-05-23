import { describe, it, expect } from "vitest";

import { buildCsv, csvFilename, formatPriceForCsv } from "./csv-export";
import { composeMatrix, type TemplateEntryRow } from "./queries/template-matrix";

function row(
  tier_id: string,
  territory_code: string,
  currency_code: string,
  customer_price: number,
): TemplateEntryRow {
  return {
    tier_id,
    territory_code,
    currency_code,
    customer_price,
    proceeds: null,
  };
}

const TIER_NAMES = new Map<string, string>([
  ["TIER_1", "Tier 1"],
  ["TIER_2", "Tier 2"],
  ["ALT_A", "Alternate Tier A"],
]);

describe("formatPriceForCsv (Apple decimal-native)", () => {
  it("strips insignificant trailing zeros for whole-currency values", () => {
    expect(formatPriceForCsv(25000)).toBe("25000");
    expect(formatPriceForCsv(150)).toBe("150");
  });

  it("preserves fractional precision up to Apple's 4-decimal storage", () => {
    expect(formatPriceForCsv(0.99)).toBe("0.99");
    expect(formatPriceForCsv(1.999)).toBe("1.999");
  });

  it("normalises numeric strings (Supabase may return string-encoded NUMERICs)", () => {
    expect(formatPriceForCsv("0.99")).toBe("0.99");
    expect(formatPriceForCsv("25000.0000")).toBe("25000");
  });

  it("returns empty string for undefined / empty input", () => {
    expect(formatPriceForCsv(undefined)).toBe("");
    expect(formatPriceForCsv("")).toBe("");
  });
});

describe("buildCsv (Default view — no diff column)", () => {
  it("emits the 6-column header and one row per filled cell", () => {
    const matrix = composeMatrix({
      entries: [
        row("TIER_1", "USA", "USD", 0.99),
        row("TIER_1", "VNM", "VND", 25000),
      ],
      tierNames: TIER_NAMES,
    });
    const csv = buildCsv({
      matrix,
      filteredMarkets: matrix.markets,
      includeDefaultDiff: false,
    });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "tier_id,tier_name,territory_code,country_name,currency,customer_price",
    );
    expect(lines).toContain("TIER_1,Tier 1,USA,United States,USD,0.99");
    expect(lines).toContain("TIER_1,Tier 1,VNM,Vietnam,VND,25000");
    expect(lines.length).toBe(3);
  });

  it("skips sparse cells (no row emitted for absent (tier, territory) pairs)", () => {
    const matrix = composeMatrix({
      entries: [
        row("TIER_1", "USA", "USD", 0.99),
        row("TIER_2", "VNM", "VND", 59000),
      ],
      tierNames: TIER_NAMES,
    });
    const csv = buildCsv({
      matrix,
      filteredMarkets: matrix.markets,
      includeDefaultDiff: false,
    });
    expect(csv).toContain("TIER_1,Tier 1,USA,");
    expect(csv).toContain("TIER_2,Tier 2,VNM,");
    expect(csv).not.toContain("TIER_1,Tier 1,VNM,"); // sparse
    expect(csv).not.toContain("TIER_2,Tier 2,USA,"); // sparse
  });

  it("respects the filteredMarkets argument", () => {
    const matrix = composeMatrix({
      entries: [
        row("TIER_1", "USA", "USD", 0.99),
        row("TIER_1", "VNM", "VND", 25000),
        row("TIER_1", "DEU", "EUR", 0.99),
      ],
      tierNames: TIER_NAMES,
    });
    const onlyAsia = matrix.markets.filter((m) => m.continent === "Asia");
    const csv = buildCsv({
      matrix,
      filteredMarkets: onlyAsia,
      includeDefaultDiff: false,
    });
    expect(csv).toContain("TIER_1,Tier 1,VNM,");
    expect(csv).not.toContain("TIER_1,Tier 1,USA,");
    expect(csv).not.toContain("TIER_1,Tier 1,DEU,");
  });
});

describe("buildCsv (Per-App view — with diff column)", () => {
  it("emits a 7-column header and populates default_customer_price for matched cells", () => {
    const defaults: TemplateEntryRow[] = [
      row("TIER_1", "VNM", "VND", 25000),
      row("TIER_1", "USA", "USD", 0.99),
    ];
    const matrix = composeMatrix({
      entries: [
        row("TIER_1", "VNM", "VND", 27000), // diff
        row("TIER_1", "USA", "USD", 0.99), // identical
      ],
      tierNames: TIER_NAMES,
      defaultEntries: defaults,
    });
    const csv = buildCsv({
      matrix,
      filteredMarkets: matrix.markets,
      includeDefaultDiff: true,
    });
    expect(csv.split("\r\n")[0]).toBe(
      "tier_id,tier_name,territory_code,country_name,currency,customer_price,default_customer_price",
    );
    expect(csv).toContain("TIER_1,Tier 1,VNM,Vietnam,VND,27000,25000");
    expect(csv).toContain("TIER_1,Tier 1,USA,United States,USD,0.99,0.99");
  });
});

describe("csvFilename", () => {
  it("emits the default-scope filename", () => {
    const now = new Date(2026, 4, 23, 14, 7);
    expect(csvFilename({ scope: "default", now })).toBe(
      "apple-pricing-template-default-20260523-1407.csv",
    );
  });

  it("emits the per-app filename including the bundle-id slug", () => {
    const now = new Date(2026, 4, 23, 9, 30);
    expect(
      csvFilename({ scope: "per-app", bundleId: "com.vng.passsdk", now }),
    ).toBe("apple-pricing-template-per-app-com.vng.passsdk-20260523-0930.csv");
  });

  it("sanitises unsafe filename characters in the bundle-id slug", () => {
    const now = new Date(2026, 4, 23, 0, 0);
    expect(
      csvFilename({ scope: "per-app", bundleId: "com/bad name", now }),
    ).toMatch(/apple-pricing-template-per-app-com_bad_name-/);
  });
});
