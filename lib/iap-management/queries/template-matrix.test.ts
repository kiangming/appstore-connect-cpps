import { describe, it, expect } from "vitest";

import { composeMatrix, type TemplateEntryRow } from "./template-matrix";

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
  ["TIER_10", "Tier 10"],
  ["ALT_A", "Alternate Tier A"],
  ["ALT_1", "Alternate Tier 1"],
]);

describe("composeMatrix (no diff)", () => {
  it("collects tiers, markets, cells from a flat row list", () => {
    const entries: TemplateEntryRow[] = [
      row("TIER_1", "USA", "USD", 0.99),
      row("TIER_1", "VNM", "VND", 25000),
      row("TIER_2", "USA", "USD", 1.99),
    ];
    const out = composeMatrix({ entries, tierNames: TIER_NAMES });
    expect(out.tiers.map((t) => t.tier_id)).toEqual(["TIER_1", "TIER_2"]);
    expect(out.markets.map((m) => m.code).sort()).toEqual(["USA", "VNM"]);
    expect(out.cells["TIER_1|USA"]).toEqual({
      customerPrice: 0.99,
      currency: "USD",
    });
    expect(out.cells["TIER_1|VNM"].customerPrice).toBe(25000);
  });

  it("resolves tier display names via the tierNames map (alpha-3 territory tags via territoryName)", () => {
    const out = composeMatrix({
      entries: [row("TIER_1", "USA", "USD", 0.99)],
      tierNames: TIER_NAMES,
    });
    expect(out.tiers[0].tier_name).toBe("Tier 1");
    expect(out.markets[0].name).toBe("United States");
  });

  it("sorts tiers numeric-aware: Tier 2 precedes Tier 10", () => {
    const out = composeMatrix({
      entries: [
        row("TIER_10", "USA", "USD", 9.99),
        row("TIER_2", "USA", "USD", 1.99),
        row("TIER_1", "USA", "USD", 0.99),
      ],
      tierNames: TIER_NAMES,
    });
    expect(out.tiers.map((t) => t.tier_id)).toEqual([
      "TIER_1",
      "TIER_2",
      "TIER_10",
    ]);
  });

  it("places ALT_-prefixed tiers after primary tiers (Apple alternate convention)", () => {
    const out = composeMatrix({
      entries: [
        row("ALT_A", "USA", "USD", 0.99),
        row("TIER_1", "USA", "USD", 0.99),
        row("ALT_1", "USA", "USD", 0.99),
        row("TIER_2", "USA", "USD", 1.99),
      ],
      tierNames: TIER_NAMES,
    });
    expect(out.tiers[0].is_alternate).toBe(false);
    expect(out.tiers[1].is_alternate).toBe(false);
    expect(out.tiers[2].is_alternate).toBe(true);
    expect(out.tiers[3].is_alternate).toBe(true);
    expect(out.tiers[0].tier_id).toBe("TIER_1");
    expect(out.tiers[1].tier_id).toBe("TIER_2");
  });

  it("falls back to the raw tier_id when tierNames has no entry", () => {
    const out = composeMatrix({
      entries: [row("UNMAPPED", "USA", "USD", 0.99)],
      tierNames: new Map(),
    });
    expect(out.tiers[0].tier_name).toBe("UNMAPPED");
  });

  it("preserves Excel upload order in the market list (Hotfix 24 — first-appearance, not alphabetic)", () => {
    // Manager's xlsx puts VN first (business priority), then US, then
    // DE. Pre-Hotfix-24 the composer sorted alphabetically and
    // surfaced Germany → United States → Vietnam, burying intent.
    const out = composeMatrix({
      entries: [
        row("TIER_1", "VNM", "VND", 25000), // Vietnam — Manager's first column
        row("TIER_1", "USA", "USD", 0.99), // United States — second
        row("TIER_1", "DEU", "EUR", 0.99), // Germany — third
      ],
      tierNames: TIER_NAMES,
    });
    expect(out.markets.map((m) => m.code)).toEqual(["VNM", "USA", "DEU"]);
    expect(out.markets.map((m) => m.name)).toEqual([
      "Vietnam",
      "United States",
      "Germany",
    ]);
  });

  it("dedupes the market list while preserving first-appearance order across tiers", () => {
    // Tier 2's VNM row should NOT push VN to the back — it's seen
    // first in Tier 1 and stays in position 1.
    const out = composeMatrix({
      entries: [
        row("TIER_1", "VNM", "VND", 25000),
        row("TIER_1", "USA", "USD", 0.99),
        row("TIER_2", "USA", "USD", 1.99),
        row("TIER_2", "VNM", "VND", 59000),
        row("TIER_2", "DEU", "EUR", 1.99),
      ],
      tierNames: TIER_NAMES,
    });
    expect(out.markets.map((m) => m.code)).toEqual(["VNM", "USA", "DEU"]);
  });

  it("buckets markets by continent via alpha-3 helper", () => {
    const out = composeMatrix({
      entries: [
        row("TIER_1", "USA", "USD", 0.99),
        row("TIER_1", "VNM", "VND", 25000),
        row("TIER_1", "DEU", "EUR", 0.99),
        row("TIER_1", "ZAF", "ZAR", 19.99),
      ],
      tierNames: TIER_NAMES,
    });
    expect(out.continentCounts.Americas).toBe(1);
    expect(out.continentCounts.Asia).toBe(1);
    expect(out.continentCounts.Europe).toBe(1);
    expect(out.continentCounts.Africa).toBe(1);
    expect(out.continentCounts.Oceania).toBe(0);
  });

  it("collects distinct used currencies sorted alphabetically", () => {
    const out = composeMatrix({
      entries: [
        row("TIER_1", "USA", "USD", 0.99),
        row("TIER_1", "VNM", "VND", 25000),
        row("TIER_1", "DEU", "EUR", 0.99),
      ],
      tierNames: TIER_NAMES,
    });
    expect(out.currenciesUsed).toEqual(["EUR", "USD", "VND"]);
  });
});

describe("composeMatrix (with Default diff)", () => {
  const defaults: TemplateEntryRow[] = [
    row("TIER_1", "VNM", "VND", 25000),
    row("TIER_1", "USA", "USD", 0.99),
  ];

  it("annotates Per-App cells with default values when present", () => {
    const out = composeMatrix({
      entries: [
        row("TIER_1", "VNM", "VND", 27000), // diff: 25000 → 27000
        row("TIER_1", "USA", "USD", 0.99), // same
      ],
      tierNames: TIER_NAMES,
      defaultEntries: defaults,
    });
    expect(out.cells["TIER_1|VNM"].isDiff).toBe(true);
    expect(out.cells["TIER_1|VNM"].defaultCustomerPrice).toBe(25000);
    expect(out.cells["TIER_1|USA"].isDiff).toBe(false);
    expect(out.cells["TIER_1|USA"].defaultCustomerPrice).toBe(0.99);
  });

  it("leaves diff fields undefined when no Default entry covers the cell", () => {
    const out = composeMatrix({
      entries: [row("TIER_1", "JPN", "JPY", 160)], // not in defaults
      tierNames: TIER_NAMES,
      defaultEntries: defaults,
    });
    expect(out.cells["TIER_1|JPN"].defaultCustomerPrice).toBeUndefined();
    expect(out.cells["TIER_1|JPN"].isDiff).toBeUndefined();
  });

  it("flags diff when currency differs even if price happens to match", () => {
    const out = composeMatrix({
      entries: [row("TIER_1", "VNM", "USD", 25000)], // currency swap
      tierNames: TIER_NAMES,
      defaultEntries: defaults,
    });
    expect(out.cells["TIER_1|VNM"].isDiff).toBe(true);
  });

  it("omits diff metadata entirely when no defaultEntries argument", () => {
    const out = composeMatrix({
      entries: defaults,
      tierNames: TIER_NAMES,
    });
    for (const cell of Object.values(out.cells)) {
      expect(cell.defaultCustomerPrice).toBeUndefined();
      expect(cell.isDiff).toBeUndefined();
    }
  });
});
