import { describe, it, expect } from "vitest";

import { buildCsv, csvFilename, formatPriceForCsv } from "./csv-export";
import { composeMatrix, type TemplateEntryRow } from "./queries/template-matrix";

function row(
  identifier: string,
  region_code: string,
  currency: string,
  price_micros: string,
): TemplateEntryRow {
  return { identifier, region_code, currency, price_micros };
}

describe("formatPriceForCsv", () => {
  it("trims to currency-natural precision (Hotfix 5 reuse)", () => {
    expect(formatPriceForCsv("25000000000", "VND")).toBe("25000");
    expect(formatPriceForCsv("990000", "USD")).toBe("0.99");
    expect(formatPriceForCsv("1990000", "BHD")).toBe("1.990");
  });

  it("returns empty string for missing inputs", () => {
    expect(formatPriceForCsv(undefined, "USD")).toBe("");
    expect(formatPriceForCsv("990000", undefined)).toBe("");
    expect(formatPriceForCsv("", "")).toBe("");
  });

  it("falls back to raw micros if conversion throws", () => {
    expect(formatPriceForCsv("not-a-number", "USD")).toBe("not-a-number");
  });
});

describe("buildCsv (Default view, no diff column)", () => {
  it("emits CRLF-separated rows with the standard 5-column header", () => {
    const matrix = composeMatrix([
      row("Tier 1", "VN", "VND", "27000000000"),
      row("Tier 1", "US", "USD", "990000"),
    ]);
    const csv = buildCsv({
      matrix,
      filteredMarkets: matrix.markets,
      includeDefaultDiff: false,
    });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "tier_identifier,region_code,country_name,currency,price",
    );
    // Lines after the header — order follows tiers × filteredMarkets.
    expect(lines).toContain("Tier 1,US,United States,USD,0.99");
    expect(lines).toContain("Tier 1,VN,Vietnam,VND,27000");
    expect(lines.length).toBe(3);
  });

  it("skips cells absent from the matrix (sparse templates)", () => {
    const matrix = composeMatrix([
      row("Tier 1", "VN", "VND", "27000000000"),
      // No Tier 2 entries for VN — sparse cell.
      row("Tier 2", "US", "USD", "1990000"),
    ]);
    const csv = buildCsv({
      matrix,
      filteredMarkets: matrix.markets,
      includeDefaultDiff: false,
    });
    expect(csv).toContain("Tier 1,VN,Vietnam,VND,27000");
    expect(csv).not.toContain("Tier 1,US,"); // sparse — skipped
    expect(csv).toContain("Tier 2,US,United States,USD,1.99");
  });

  it("respects filteredMarkets — markets filtered out don't appear", () => {
    const matrix = composeMatrix([
      row("Tier 1", "VN", "VND", "27000000000"),
      row("Tier 1", "US", "USD", "990000"),
      row("Tier 1", "DE", "EUR", "990000"),
    ]);
    const onlyAsia = matrix.markets.filter((m) => m.continent === "Asia");
    const csv = buildCsv({
      matrix,
      filteredMarkets: onlyAsia,
      includeDefaultDiff: false,
    });
    expect(csv).toContain("Tier 1,VN,");
    expect(csv).not.toContain("Tier 1,US,");
    expect(csv).not.toContain("Tier 1,DE,");
  });

  it("quotes fields containing commas / quotes / newlines (RFC 4180)", () => {
    // Country name with a comma is rare but possible if Manager edits an
    // override. We don't ship one by default; assert the quoting helper
    // by feeding a custom identifier with a comma.
    const matrix = composeMatrix([
      row("Tier, special", "VN", "VND", "27000000000"),
    ]);
    const csv = buildCsv({
      matrix,
      filteredMarkets: matrix.markets,
      includeDefaultDiff: false,
    });
    expect(csv).toContain('"Tier, special",VN,Vietnam,VND,27000');
  });
});

describe("buildCsv (Per-App view, with diff column)", () => {
  const defaults: TemplateEntryRow[] = [
    row("Tier 1", "VN", "VND", "25000000000"),
    row("Tier 1", "US", "USD", "990000"),
  ];

  it("adds the default_price column and populates it for matched cells", () => {
    const matrix = composeMatrix(
      [
        row("Tier 1", "VN", "VND", "27000000000"),
        row("Tier 1", "US", "USD", "990000"),
      ],
      defaults,
    );
    const csv = buildCsv({
      matrix,
      filteredMarkets: matrix.markets,
      includeDefaultDiff: true,
    });
    expect(csv.split("\r\n")[0]).toBe(
      "tier_identifier,region_code,country_name,currency,price,default_price",
    );
    expect(csv).toContain("Tier 1,VN,Vietnam,VND,27000,25000");
    expect(csv).toContain("Tier 1,US,United States,USD,0.99,0.99");
  });

  it("leaves default_price blank when no Default entry covers the cell", () => {
    const matrix = composeMatrix(
      [row("Tier 1", "JP", "JPY", "150")],
      defaults,
    );
    const csv = buildCsv({
      matrix,
      filteredMarkets: matrix.markets,
      includeDefaultDiff: true,
    });
    expect(csv).toContain("Tier 1,JP,Japan,JPY,0,");
  });
});

describe("csvFilename", () => {
  it("emits the default-scope filename with a YYYYMMDD-HHmm stamp", () => {
    const now = new Date(2026, 4, 23, 14, 7); // 2026-05-23 14:07 local
    expect(csvFilename({ scope: "default", now })).toBe(
      "pricing-template-default-20260523-1407.csv",
    );
  });

  it("emits the per-app filename including the package slug", () => {
    const now = new Date(2026, 4, 23, 9, 30);
    expect(
      csvFilename({ scope: "per-app", packageName: "com.vng.passsdk", now }),
    ).toBe("pricing-template-per-app-com.vng.passsdk-20260523-0930.csv");
  });

  it("sanitises unsafe filename characters in the package slug", () => {
    const now = new Date(2026, 4, 23, 0, 0);
    expect(
      csvFilename({ scope: "per-app", packageName: "com/bad name", now }),
    ).toMatch(/pricing-template-per-app-com_bad_name-/);
  });
});
