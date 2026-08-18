/**
 * Search + selection arithmetic.
 *
 * ⚠ MUTATION TARGETS:
 *   (a) scope toggleAllForQuery to the window/whole list → "matching" tests
 *   (b) drop selectedHidden from the counts               → "survives search"
 */
import { describe, it, expect } from "vitest";
import {
  matchesQuery,
  filterRowsByQuery,
  selectionCounts,
  toggleAllForQuery,
  ROW_WINDOW_STEP,
} from "./bulk-item-search";
import type { BulkItemRow } from "./bulk-item-rows";

const row = (id: string, productId: string, name: string): BulkItemRow => ({
  key: id,
  appleIapId: id,
  internalId: `u-${id}`,
  productId,
  name,
  exclusion: null,
});

const ROWS = [
  row("a", "com.x.gems.60", "Gems 60"),
  row("b", "com.x.gems.300", "Gems 300"),
  row("c", "com.x.starter", "Starter Pack"),
  row("d", "com.x.vip", "VIP Monthly"),
];

describe("matchesQuery", () => {
  it("matches product id and name, case-insensitively", () => {
    expect(matchesQuery(ROWS[0], "GEMS")).toBe(true);
    expect(matchesQuery(ROWS[2], "starter pack")).toBe(true);
    expect(matchesQuery(ROWS[3], "gems")).toBe(false);
  });

  it("an empty or whitespace query matches everything", () => {
    expect(matchesQuery(ROWS[0], "")).toBe(true);
    expect(matchesQuery(ROWS[0], "   ")).toBe(true);
    expect(filterRowsByQuery(ROWS, "")).toHaveLength(4);
  });

  it("⚠ treats the query as a substring, never a regex — user input cannot throw", () => {
    expect(() => filterRowsByQuery(ROWS, "([")).not.toThrow();
    expect(filterRowsByQuery(ROWS, "([")).toHaveLength(0);
    expect(filterRowsByQuery(ROWS, ".")).toHaveLength(4); // literal dot, all have one
  });
});

describe("⚠ Select all = every MATCHING item, not the rendered window", () => {
  it("ticks every match, including matches a window would not have rendered", () => {
    const many = Array.from({ length: ROW_WINDOW_STEP + 25 }, (_, i) =>
      row(`i${i}`, `com.x.gems.${i}`, `Gems ${i}`),
    );
    const next = toggleAllForQuery({
      selectableRows: many,
      selected: new Set(),
      query: "gems",
    });
    // ⚠ MUTATION TARGET: scope this to ROW_WINDOW_STEP and it silently returns
    // 60 of 85 under a label that says "all".
    expect(next.size).toBe(many.length);
  });

  it("with a search active it takes only the matches, not the whole app", () => {
    const next = toggleAllForQuery({
      selectableRows: ROWS,
      selected: new Set(),
      query: "gems",
    });
    expect([...next].sort()).toEqual(["a", "b"]);
  });

  it("⚠ un-ticking a narrowed list cannot wipe an off-screen selection", () => {
    // Everything selected, then the Manager narrows to "gems" and unticks.
    const next = toggleAllForQuery({
      selectableRows: ROWS,
      selected: new Set(["a", "b", "c", "d"]),
      query: "gems",
    });
    expect([...next].sort()).toEqual(["c", "d"]); // the hidden two survive
  });

  it("toggles ON when the matching set is only partly selected", () => {
    const next = toggleAllForQuery({
      selectableRows: ROWS,
      selected: new Set(["a"]),
      query: "gems",
    });
    expect(next.has("a")).toBe(true);
    expect(next.has("b")).toBe(true);
  });
});

describe("⚠ the selection survives the search box, and says so", () => {
  it("counts hidden-but-selected rows separately", () => {
    const c = selectionCounts({
      selectableRows: ROWS,
      totalRows: ROWS.length,
      selected: new Set(["a", "c", "d"]),
      query: "gems",
    });
    expect(c.matching).toBe(2);          // a, b
    expect(c.selectedMatching).toBe(1);  // a
    // ⚠ MUTATION TARGET: return 0 here and the UI stops telling the Manager
    // that c and d are still in the batch — the count appears to drop from 3
    // to 1 with no explanation.
    expect(c.selectedHidden).toBe(2);    // c, d
    expect(c.total).toBe(4);
  });

  it("with no search, nothing is hidden", () => {
    const c = selectionCounts({
      selectableRows: ROWS,
      totalRows: ROWS.length,
      selected: new Set(["a", "c"]),
      query: "",
    });
    expect(c.selectedHidden).toBe(0);
    expect(c.selectedMatching).toBe(2);
  });

  it("total counts EVERY row, so the denominator is not the filtered set", () => {
    const c = selectionCounts({
      selectableRows: ROWS.slice(0, 2),
      totalRows: 500,
      selected: new Set(),
      query: "",
    });
    expect(c.matching).toBe(2);
    expect(c.total).toBe(500);
  });

  it("ignores rows with no Apple id (drafts can never be selected)", () => {
    const withDraft: BulkItemRow[] = [
      ...ROWS,
      { key: "draft:1", appleIapId: null, internalId: "d1", productId: "com.x.gems.draft", name: "Gems Draft", exclusion: null },
    ];
    const c = selectionCounts({
      selectableRows: withDraft,
      totalRows: withDraft.length,
      selected: new Set(),
      query: "gems",
    });
    expect(c.matching).toBe(2);
  });
});
