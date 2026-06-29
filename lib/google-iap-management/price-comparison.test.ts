import { describe, it, expect } from "vitest";
import {
  comparePrices,
  summarizeComparison,
  microsEqual,
  type RegionPrice,
} from "./price-comparison";

const p = (region: string, currency: string, micros: string): RegionPrice => ({
  region_code: region,
  currency,
  price_micros: micros,
});

describe("microsEqual", () => {
  it("integer-equal micros are equal regardless of leading/trailing whitespace", () => {
    expect(microsEqual("990000", " 990000 ")).toBe(true);
  });
  it("different micros differ", () => {
    expect(microsEqual("990000", "1990000")).toBe(false);
  });
  it("does not false-diff on equal values (the formatting-safety guarantee)", () => {
    // both are the same integer micros — display rounding can't change this
    expect(microsEqual("23000000000", "23000000000")).toBe(true);
  });
  it("falls back to string compare on non-integer input without throwing", () => {
    expect(microsEqual("abc", "abc")).toBe(true);
    expect(microsEqual("abc", "def")).toBe(false);
  });
});

describe("comparePrices", () => {
  it("flags 'match' when currency + micros are identical", () => {
    const rows = comparePrices([p("US", "USD", "990000")], [p("US", "USD", "990000")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("match");
  });

  it("flags 'diff' when micros differ (live ≠ tool)", () => {
    const rows = comparePrices([p("US", "USD", "990000")], [p("US", "USD", "1990000")]);
    expect(rows[0].status).toBe("diff");
    expect(rows[0].tool?.price_micros).toBe("990000");
    expect(rows[0].live?.price_micros).toBe("1990000");
  });

  it("flags 'diff' when currency differs even if micros match", () => {
    const rows = comparePrices([p("CH", "EUR", "990000")], [p("CH", "CHF", "990000")]);
    expect(rows[0].status).toBe("diff");
  });

  it("flags 'tool-only' when the region is in the DB but not on Google", () => {
    const rows = comparePrices([p("VN", "VND", "23000000000")], []);
    expect(rows[0].status).toBe("tool-only");
    expect(rows[0].live).toBeNull();
  });

  it("flags 'live-only' when Google has a region the DB doesn't (direct-console add)", () => {
    const rows = comparePrices([], [p("MY", "MYR", "12900000")]);
    expect(rows[0].status).toBe("live-only");
    expect(rows[0].tool).toBeNull();
  });

  it("handles territory-set mismatch in BOTH directions in one comparison", () => {
    const rows = comparePrices(
      [p("US", "USD", "990000"), p("VN", "VND", "23000000000")],
      [p("US", "USD", "990000"), p("MY", "MYR", "12900000")],
    );
    const byRegion = Object.fromEntries(rows.map((r) => [r.region_code, r.status]));
    expect(byRegion).toEqual({ US: "match", VN: "tool-only", MY: "live-only" });
  });

  it("sorts divergent rows first, then alphabetical (mismatches obvious at a glance)", () => {
    const rows = comparePrices(
      [p("ZA", "ZAR", "1"), p("AU", "AUD", "1"), p("BR", "BRL", "1")],
      [p("ZA", "ZAR", "1"), p("AU", "AUD", "999"), p("BR", "BRL", "1")],
    );
    // AU is the only diff → must sort first; matches (BR, ZA) follow alpha.
    expect(rows.map((r) => r.region_code)).toEqual(["AU", "BR", "ZA"]);
    expect(rows[0].status).toBe("diff");
  });

  it("does not produce false diffs for equal prices (no epsilon/format noise)", () => {
    const rows = comparePrices(
      [p("US", "USD", "990000"), p("VN", "VND", "23000000000")],
      [p("US", "USD", "990000"), p("VN", "VND", "23000000000")],
    );
    expect(rows.every((r) => r.status === "match")).toBe(true);
  });
});

describe("summarizeComparison", () => {
  it("counts each status and rolls up diverged = diff + toolOnly + liveOnly", () => {
    const rows = comparePrices(
      [p("US", "USD", "990000"), p("VN", "VND", "1"), p("GB", "GBP", "1")],
      [p("US", "USD", "1990000"), p("MY", "MYR", "1"), p("GB", "GBP", "1")],
    );
    const s = summarizeComparison(rows);
    expect(s.total).toBe(4); // US, VN, GB, MY
    expect(s.match).toBe(1); // GB
    expect(s.diff).toBe(1); // US
    expect(s.toolOnly).toBe(1); // VN
    expect(s.liveOnly).toBe(1); // MY
    expect(s.diverged).toBe(3);
  });

  it("reports diverged=0 when everything matches", () => {
    const rows = comparePrices([p("US", "USD", "990000")], [p("US", "USD", "990000")]);
    expect(summarizeComparison(rows).diverged).toBe(0);
  });
});
