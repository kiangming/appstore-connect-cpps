import { describe, it, expect } from "vitest";

import { composeMatrix, type TemplateEntryRow } from "./template-matrix";

function row(
  identifier: string,
  region_code: string,
  currency: string,
  price_micros: string,
): TemplateEntryRow {
  return { identifier, region_code, currency, price_micros };
}

describe("composeMatrix (no diff)", () => {
  it("collects distinct tiers, markets, cells from a flat entry list", () => {
    const entries: TemplateEntryRow[] = [
      row("Tier 1", "VN", "VND", "27000000000"),
      row("Tier 1", "US", "USD", "990000"),
      row("Tier 2", "VN", "VND", "59000000000"),
      row("Tier 2", "US", "USD", "1990000"),
    ];
    const out = composeMatrix(entries);
    expect(out.tiers).toEqual(["Tier 1", "Tier 2"]);
    expect(out.markets.map((m) => m.code).sort()).toEqual(["US", "VN"]);
    expect(out.cells["Tier 1|VN"]).toEqual({
      priceMicros: "27000000000",
      currency: "VND",
    });
    expect(out.cells["Tier 2|US"]).toEqual({
      priceMicros: "1990000",
      currency: "USD",
    });
  });

  it("sorts tiers numeric-aware: 'Tier 2' < 'Tier 10'", () => {
    const entries: TemplateEntryRow[] = [
      row("Tier 10", "VN", "VND", "1"),
      row("Tier 2", "VN", "VND", "1"),
      row("Tier 1", "VN", "VND", "1"),
    ];
    const out = composeMatrix(entries);
    expect(out.tiers).toEqual(["Tier 1", "Tier 2", "Tier 10"]);
  });

  it("sorts Alternate tiers after primary tiers (Hotfix 19 convention)", () => {
    const entries: TemplateEntryRow[] = [
      row("Tier 5", "VN", "VND", "1"),
      row("Alternate Tier A", "VN", "VND", "1"),
      row("Tier 1", "VN", "VND", "1"),
      row("Alternate Tier 1", "VN", "VND", "1"),
    ];
    const out = composeMatrix(entries);
    // Primaries first (numeric-sorted), then Alternates.
    expect(out.tiers[0]).toBe("Tier 1");
    expect(out.tiers[1]).toBe("Tier 5");
    expect(out.tiers[2]).toMatch(/^Alternate/);
    expect(out.tiers[3]).toMatch(/^Alternate/);
  });

  it("preserves Excel upload order in the market list (Hotfix 24 — first-appearance, not alphabetic)", () => {
    // Manager's xlsx columns left-to-right: VN, AL, DZ, US. Pre-
    // Hotfix-24 the composer sorted alphabetically and Manager saw
    // Albania → Algeria → United States → Vietnam, burying intent.
    const entries: TemplateEntryRow[] = [
      row("Tier 1", "VN", "VND", "1"), // Vietnam — Manager's first column
      row("Tier 1", "AL", "ALL", "1"), // Albania
      row("Tier 1", "DZ", "DZD", "1"), // Algeria
      row("Tier 1", "US", "USD", "1"), // United States
    ];
    const out = composeMatrix(entries);
    expect(out.markets.map((m) => m.code)).toEqual(["VN", "AL", "DZ", "US"]);
    expect(out.markets.map((m) => m.name)).toEqual([
      "Vietnam",
      "Albania",
      "Algeria",
      "United States",
    ]);
  });

  it("dedupes the market list while preserving first-appearance order across tiers", () => {
    // Tier 2's VN row should NOT push VN to the back — it's seen
    // first in Tier 1 and stays in position 1.
    const entries: TemplateEntryRow[] = [
      row("Tier 1", "VN", "VND", "1"),
      row("Tier 1", "US", "USD", "1"),
      row("Tier 2", "US", "USD", "2"),
      row("Tier 2", "VN", "VND", "2"),
      row("Tier 2", "DE", "EUR", "2"),
    ];
    const out = composeMatrix(entries);
    expect(out.markets.map((m) => m.code)).toEqual(["VN", "US", "DE"]);
  });

  it("attaches continent to each market via getContinentForRegion", () => {
    const entries: TemplateEntryRow[] = [
      row("Tier 1", "VN", "VND", "1"),
      row("Tier 1", "DE", "EUR", "1"),
      row("Tier 1", "ZA", "ZAR", "1"),
    ];
    const out = composeMatrix(entries);
    const byCode = new Map(out.markets.map((m) => [m.code, m.continent]));
    expect(byCode.get("VN")).toBe("Asia");
    expect(byCode.get("DE")).toBe("Europe");
    expect(byCode.get("ZA")).toBe("Africa");
  });

  it("counts markets per continent for the toggle UI", () => {
    const entries: TemplateEntryRow[] = [
      row("Tier 1", "VN", "VND", "1"),
      row("Tier 1", "JP", "JPY", "1"),
      row("Tier 1", "DE", "EUR", "1"),
      row("Tier 1", "US", "USD", "1"),
    ];
    const out = composeMatrix(entries);
    expect(out.continentCounts.Asia).toBe(2);
    expect(out.continentCounts.Europe).toBe(1);
    expect(out.continentCounts.Americas).toBe(1);
    expect(out.continentCounts.Africa).toBe(0);
    expect(out.continentCounts.Oceania).toBe(0);
  });

  it("collects distinct used currencies sorted alphabetically (Q2 dropdown)", () => {
    const entries: TemplateEntryRow[] = [
      row("Tier 1", "VN", "VND", "1"),
      row("Tier 1", "JP", "JPY", "1"),
      row("Tier 1", "DE", "EUR", "1"),
      row("Tier 1", "US", "USD", "1"),
    ];
    const out = composeMatrix(entries);
    expect(out.currenciesUsed).toEqual(["EUR", "JPY", "USD", "VND"]);
  });
});

describe("composeMatrix (with Default diff)", () => {
  const defaultEntries: TemplateEntryRow[] = [
    row("Tier 1", "VN", "VND", "25000000000"), // 25,000 VND
    row("Tier 1", "US", "USD", "990000"),
    row("Tier 2", "VN", "VND", "59000000000"),
  ];

  it("annotates Per-App cells with default values when present", () => {
    const perApp: TemplateEntryRow[] = [
      row("Tier 1", "VN", "VND", "27000000000"), // diverges from Default 25,000
      row("Tier 1", "US", "USD", "990000"), // identical to Default
    ];
    const out = composeMatrix(perApp, defaultEntries);
    const vnCell = out.cells["Tier 1|VN"];
    const usCell = out.cells["Tier 1|US"];
    expect(vnCell.defaultPriceMicros).toBe("25000000000");
    expect(vnCell.isDiff).toBe(true);
    expect(usCell.defaultPriceMicros).toBe("990000");
    expect(usCell.isDiff).toBe(false);
  });

  it("leaves diff fields undefined when no Default entry covers the cell", () => {
    const perApp: TemplateEntryRow[] = [
      row("Tier 1", "JP", "JPY", "150"), // no JP in defaultEntries
    ];
    const out = composeMatrix(perApp, defaultEntries);
    const cell = out.cells["Tier 1|JP"];
    expect(cell.defaultPriceMicros).toBeUndefined();
    expect(cell.isDiff).toBeUndefined();
  });

  it("flags diff when currency differs even if micros happen to match", () => {
    const perApp: TemplateEntryRow[] = [
      row("Tier 1", "VN", "USD", "25000000000"), // currency changed
    ];
    const out = composeMatrix(perApp, defaultEntries);
    expect(out.cells["Tier 1|VN"].isDiff).toBe(true);
  });

  it("omits all diff metadata when no defaultEntries argument is passed", () => {
    const out = composeMatrix(defaultEntries);
    for (const cell of Object.values(out.cells)) {
      expect(cell.defaultPriceMicros).toBeUndefined();
      expect(cell.defaultCurrency).toBeUndefined();
      expect(cell.isDiff).toBeUndefined();
    }
  });
});
