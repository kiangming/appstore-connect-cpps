import { describe, it, expect } from "vitest";
import {
  buildUnifiedPricingRows,
  summarizeUnifiedPricing,
  partitionPricingRows,
} from "./unified-pricing";
import type { RegionOverrideRow } from "./form-state";
import type { RegionPrice } from "./price-comparison";

const ov = (region: string, currency: string, priceDecimal: string): RegionOverrideRow => ({
  region,
  currency,
  priceDecimal,
});
const live = (region: string, currency: string, micros: string): RegionPrice => ({
  region_code: region,
  currency,
  price_micros: micros,
});

describe("buildUnifiedPricingRows — five row states", () => {
  it("explicit override == live → match", () => {
    const rows = buildUnifiedPricingRows({
      regionOverrides: [ov("GB", "GBP", "0.79")],
      livePrices: [live("GB", "GBP", "790000")],
      baseCurrency: "USD",
      basePriceDecimal: "0.99",
    });
    const gb = rows.find((r) => r.region_code === "GB")!;
    expect(gb.status).toBe("match");
    expect(gb.hasExplicitTool).toBe(true);
    expect(gb.override?.priceDecimal).toBe("0.79");
  });

  it("explicit override != live → diff (drift flagged)", () => {
    const rows = buildUnifiedPricingRows({
      regionOverrides: [ov("US", "USD", "0.99")],
      livePrices: [live("US", "USD", "1990000")],
      baseCurrency: "USD",
      basePriceDecimal: "0.99",
    });
    expect(rows.find((r) => r.region_code === "US")!.status).toBe("diff");
  });

  it("tool override, no live → tool-only (In tool, not on Google)", () => {
    const rows = buildUnifiedPricingRows({
      regionOverrides: [ov("VN", "VND", "23000")],
      livePrices: [],
      baseCurrency: "USD",
      basePriceDecimal: "0.99",
    });
    const vn = rows.find((r) => r.region_code === "VN")!;
    expect(vn.status).toBe("tool-only");
    expect(vn.override).not.toBeNull(); // still editable
  });

  it("live only, no tool override → live-only (On Google, not in tool) + no editable index", () => {
    const rows = buildUnifiedPricingRows({
      regionOverrides: [],
      livePrices: [live("MY", "MYR", "12900000")],
      baseCurrency: "USD",
      basePriceDecimal: "0.99",
    });
    const my = rows.find((r) => r.region_code === "MY")!;
    expect(my.status).toBe("live-only");
    expect(my.override).toBeNull(); // inherits base; editing promotes to override
    expect(my.hasExplicitTool).toBe(false);
  });

  it("live only, equals base in SAME currency → auto-eq (benign, not a drift)", () => {
    const rows = buildUnifiedPricingRows({
      regionOverrides: [],
      livePrices: [live("PR", "USD", "990000")], // base USD 0.99 auto-equalized
      baseCurrency: "USD",
      basePriceDecimal: "0.99",
    });
    expect(rows.find((r) => r.region_code === "PR")!.status).toBe("auto-eq");
  });

  it("sorts divergent rows first (reuses comparePrices ordering)", () => {
    const rows = buildUnifiedPricingRows({
      regionOverrides: [ov("AU", "AUD", "1.49"), ov("BR", "BRL", "5.00")],
      livePrices: [live("AU", "AUD", "1490000"), live("BR", "BRL", "9990000")], // BR diverges
      baseCurrency: "USD",
      basePriceDecimal: "0.99",
    });
    expect(rows[0].region_code).toBe("BR");
    expect(rows[0].status).toBe("diff");
  });
});

describe("summarizeUnifiedPricing", () => {
  it("counts diverged as diff + tool-only + live-only (not match/auto-eq)", () => {
    const rows = buildUnifiedPricingRows({
      regionOverrides: [ov("US", "USD", "0.99"), ov("GB", "GBP", "0.79"), ov("VN", "VND", "23000")],
      livePrices: [live("US", "USD", "1990000"), live("GB", "GBP", "790000"), live("MY", "MYR", "1")],
      baseCurrency: "USD",
      basePriceDecimal: "0.99",
    });
    // US diff, GB match, VN tool-only, MY live-only → diverged = 3
    expect(summarizeUnifiedPricing(rows).diverged).toBe(3);
  });
});

describe("partitionPricingRows — collapse is presentation-only", () => {
  it("collapses benign auto-equalized/matching inherit rows; keeps divergent + explicit overrides visible", () => {
    const rows = buildUnifiedPricingRows({
      regionOverrides: [ov("GB", "GBP", "0.79")], // explicit match → visible
      livePrices: [
        live("GB", "GBP", "790000"),
        live("US", "USD", "1990000"), // live-only diff-ish → visible
        live("PR", "USD", "990000"), // auto-eq → collapsed
        live("GU", "USD", "990000"), // auto-eq → collapsed
      ],
      baseCurrency: "USD",
      basePriceDecimal: "0.99",
    });
    const { visible, collapsed } = partitionPricingRows(rows);
    expect(collapsed.map((r) => r.region_code).sort()).toEqual(["GU", "PR"]);
    expect(visible.map((r) => r.region_code).sort()).toEqual(["GB", "US"]);
  });

  it("does NOT drop collapsed regions from the row set (collapse never loses a territory)", () => {
    const rows = buildUnifiedPricingRows({
      regionOverrides: [],
      livePrices: [live("PR", "USD", "990000"), live("GU", "USD", "990000")],
      baseCurrency: "USD",
      basePriceDecimal: "0.99",
    });
    const { visible, collapsed } = partitionPricingRows(rows);
    expect(visible.length + collapsed.length).toBe(rows.length);
    expect(rows.length).toBe(2);
  });
});
