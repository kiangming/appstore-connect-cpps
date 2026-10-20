/**
 * PA2.2/PA2.3 — the preview's flags (design §L2.9, Q-F). The ×10 flag is the
 * ONLY place a locale typo such as "49,000" read as 49 shows up before a
 * REPLACE (R9), and the ladder flag the only check on a NEW override's
 * value; neither was pinned at any layer before this file (review PA2.3).
 * Pure function — no I/O.
 */
import { describe, it, expect } from "vitest";

import { diffTemplate, type DiffEntry } from "./diff";

const e = (tier_id: string, territory_code: string, currency_code: string, customer_price: number | string, proceeds: number | null = null): DiffEntry => ({
  tier_id,
  territory_code,
  currency_code,
  customer_price,
  proceeds,
});

function diff(current: DiffEntry[], file: DiffEntry[], opts: { territories?: string[]; tierIds?: string[] } = {}) {
  const territories = opts.territories ?? [...new Set([...current, ...file].map((x) => x.territory_code))];
  const tierIds = opts.tierIds ?? [...new Set([...current, ...file].map((x) => x.tier_id))];
  const headerCurrency = new Map(file.map((x) => [x.territory_code, x.currency_code]));
  return diffTemplate({ current, file: { entries: file, territories, tierIds, headerCurrency } });
}
const flagsOf = (d: ReturnType<typeof diff>, tier: string, code: string) =>
  d.changes.find((c) => c.tier_id === tier && c.territory_code === code)?.flags;

describe("×10 — a changed price more than ×10 or less than ÷10 (strict, the spec)", () => {
  it("D1 the R9 typo 79,000 → 79 (÷1000) is flagged, and counted in the warnings", () => {
    const d = diff([e("TIER_3", "VNM", "VND", 79000)], [e("TIER_3", "VNM", "VND", 79)]);
    expect(flagsOf(d, "TIER_3", "VNM")).toEqual(["magnitude"]);
    expect(d.warnings.magnitude).toBe(1);
  });

  it("D2 just past the boundary is flagged both ways; an exact ×10 / ÷10 and anything inside is not", () => {
    const d = diff(
      [e("TIER_1", "VNM", "VND", 25000), e("TIER_2", "VNM", "VND", 49000), e("TIER_3", "VNM", "VND", 79000), e("TIER_4", "VNM", "VND", 99000), e("TIER_5", "VNM", "VND", 129000)],
      [e("TIER_1", "VNM", "VND", 250000), e("TIER_2", "VNM", "VND", 4900), e("TIER_3", "VNM", "VND", 790001), e("TIER_4", "VNM", "VND", 9899), e("TIER_5", "VNM", "VND", 99000)],
    );
    expect(flagsOf(d, "TIER_1", "VNM")).toEqual([]); // exactly ×10
    expect(flagsOf(d, "TIER_2", "VNM")).toEqual([]); // exactly ÷10
    expect(flagsOf(d, "TIER_3", "VNM")).toEqual(["magnitude"]);
    expect(flagsOf(d, "TIER_4", "VNM")).toEqual(["magnitude"]);
    expect(flagsOf(d, "TIER_5", "VNM")).toEqual([]);
    expect(d.warnings.magnitude).toBe(2);
  });

  it("D3 an ADDED or REMOVED cell is never ×10 (nothing to compare with); a NUMERIC string compares as a number", () => {
    const d = diff([e("TIER_1", "VNM", "VND", "25000.0000"), e("TIER_2", "VNM", "VND", 49000)], [e("TIER_1", "VNM", "VND", 25000), e("TIER_3", "VNM", "VND", 79)]);
    expect(d.totals).toMatchObject({ unchanged: 1, added: 1, removed: 1, changed: 0 });
    expect(d.warnings.magnitude).toBe(0);
  });
});

describe("tier ladder — a NEW override outside its neighbouring standard tiers in the file", () => {
  const column = [e("TIER_1", "VNM", "VND", 25000), e("TIER_3", "VNM", "VND", 79000)];

  it("D4 49 VND between 25,000 and 79,000 is flagged; 49,000 is not", () => {
    const low = diff(column, [...column, e("TIER_2", "VNM", "VND", 49)]);
    expect(flagsOf(low, "TIER_2", "VNM")).toEqual(["ladder"]);
    expect(low.warnings.ladder).toBe(1);
    const ok = diff(column, [...column, e("TIER_2", "VNM", "VND", 49000)]);
    expect(flagsOf(ok, "TIER_2", "VNM")).toEqual([]);
    expect(ok.warnings.ladder).toBe(0);
  });

  it("D5 above the next tier is flagged; tiers order numerically (TIER_10 after TIER_9, not after TIER_1)", () => {
    const col = [e("TIER_1", "VNM", "VND", 25000), e("TIER_9", "VNM", "VND", 229000), e("TIER_11", "VNM", "VND", 279000)];
    const d = diff(col, [...col, e("TIER_10", "VNM", "VND", 300000)]);
    expect(flagsOf(d, "TIER_10", "VNM")).toEqual(["ladder"]);
    const fine = diff(col, [...col, e("TIER_10", "VNM", "VND", 249000)]);
    expect(flagsOf(fine, "TIER_10", "VNM")).toEqual([]);
  });

  it("D6 alternate tiers are outside the ladder (both as the new cell and as neighbours); a CHANGED cell is not laddered", () => {
    const d = diff(column, [...column, e("ALT_A", "VNM", "VND", 5)]);
    expect(flagsOf(d, "ALT_A", "VNM")).toEqual([]);
    const changed = diff([...column, e("TIER_2", "VNM", "VND", 49000)], [...column, e("TIER_2", "VNM", "VND", 30000)]);
    expect(flagsOf(changed, "TIER_2", "VNM")).toEqual([]);
  });
});

describe("USA, removals, proceeds — what the preview's totals and warnings say", () => {
  it("D7 every USA change is flagged 'usa' (added, changed, removed); a missing USA column is a warning", () => {
    const d = diff(
      [e("TIER_1", "USA", "USD", 0.99), e("TIER_2", "USA", "USD", 1.99)],
      [e("TIER_1", "USA", "USD", 0.89), e("TIER_3", "USA", "USD", 2.99)],
      { territories: ["USA"] },
    );
    expect(d.changes.map((c) => `${c.kind}:${c.flags.join(",")}`).sort()).toEqual(["added:usa", "changed:usa", "removed:usa"]);
    expect(d.warnings.usaChanges).toBe(3);
    expect(d.warnings.usaColumnMissing).toBe(false);
    expect(diff([e("TIER_1", "VNM", "VND", 25000)], [e("TIER_1", "VNM", "VND", 25000)]).warnings.usaColumnMissing).toBe(true);
  });

  it("D8 a removal says WHY: cleared in the file / territory column absent / tier row absent", () => {
    const d = diff(
      [e("TIER_1", "VNM", "VND", 25000), e("TIER_1", "THA", "THB", 35), e("TIER_2", "VNM", "VND", 49000)],
      [],
      { territories: ["VNM"], tierIds: ["TIER_1"] },
    );
    expect(Object.fromEntries(d.changes.map((c) => [`${c.tier_id}|${c.territory_code}`, c.removedBecause]))).toEqual({
      "TIER_1|VNM": "cleared",
      "TIER_1|THA": "column-absent",
      "TIER_2|VNM": "row-absent",
    });
    expect(d.totals).toMatchObject({ removed: 3, removedCleared: 1, removedColumnAbsent: 1, removedRowAbsent: 1, before: 3, after: 0 });
  });

  it("D9 an override set to the SAME price stays unchanged (never 'inherited'); proceeds held today are counted", () => {
    const d = diff([e("TIER_1", "VNM", "VND", 25000, 20000), e("TIER_2", "VNM", "VND", 49000)], [e("TIER_1", "VNM", "VND", 25000), e("TIER_2", "VNM", "VND", 49000)]);
    expect(d.totals).toMatchObject({ unchanged: 2, added: 0, changed: 0, removed: 0, proceedsCleared: 1 });
    expect(d.changes).toEqual([]);
  });
});
