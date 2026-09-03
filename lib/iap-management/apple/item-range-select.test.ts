/**
 * The range arithmetic, at the layer where it can be asserted without jsdom.
 *
 * ⚠ THE THREE MUTATIONS THIS FILE IS THE ACCEPTANCE BAR FOR (Y1.3):
 *   1. the range REPLACES the selection instead of adding to it
 *   2. a shift-click across a rendering boundary silently sweeps rows the
 *      Manager never saw
 *   3. the anchor survives a boundary and still resolves
 * Each has a test below whose name says so, and each was run red.
 */
import { describe, it, expect } from "vitest";

import {
  resolveRangeIds,
  addRangeToSelection,
} from "./item-range-select";

const rows = (...ids: string[]) => ids.map((id) => ({ appleIapId: id }));

const RENDERED = rows("a", "b", "c", "d", "e");

describe("resolveRangeIds — the range is bounded by what is RENDERED", () => {
  it("takes every row between anchor and target, inclusive, in list order", () => {
    expect(resolveRangeIds(RENDERED, "b", "d")).toEqual(["b", "c", "d"]);
  });

  it("works upwards too — the anchor may be BELOW the target", () => {
    expect(resolveRangeIds(RENDERED, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("a range of one is the row itself, not an error", () => {
    expect(resolveRangeIds(RENDERED, "c", "c")).toEqual(["c"]);
  });

  /**
   * ⚠ MUTATION 2 + 3 — the money test. If `resolveRangeIds` is ever changed to
   * look the anchor up in the full list rather than the rendered slice, or if
   * a stale anchor is allowed to resolve anyway, this goes red: the anchor
   * "x" is a real row of the app that is NOT on screen.
   */
  it("returns null — NOT a range — when the anchor is not among the rendered rows", () => {
    expect(resolveRangeIds(RENDERED, "x", "d")).toBeNull();
  });

  it("returns null when nothing has been clicked plainly yet", () => {
    expect(resolveRangeIds(RENDERED, null, "d")).toBeNull();
  });

  it("returns null when the target is not rendered either", () => {
    expect(resolveRangeIds(RENDERED, "b", "zzz")).toBeNull();
  });

  /**
   * ⚠ `null`, never `[]`. A caller can apply `[]` as a silent no-op; `null` is
   * a state it has to answer for. Y1.2 requires the answer to be a hint.
   */
  it("distinguishes 'no range here' from 'an empty range'", () => {
    expect(resolveRangeIds([], "b", "d")).toBeNull();
    expect(resolveRangeIds(RENDERED, "b", "d")).not.toBeNull();
  });
});

describe("addRangeToSelection — ADDITIVE, never toggling (Q3)", () => {
  /**
   * ⚠ MUTATION 1. Replace the body with `new Set(rangeIds)` — the
   * Finder/Explorer model — and this goes red on `keep-me`, which is a pick
   * made somewhere else. M1 is what forbids that model.
   */
  it("leaves picks OUTSIDE the range alone — M1, cumulative selection", () => {
    const next = addRangeToSelection(new Set(["keep-me"]), ["b", "c"]);
    expect([...next].sort()).toEqual(["b", "c", "keep-me"]);
  });

  it("a row already ticked INSIDE the range stays ticked — never toggled off", () => {
    const next = addRangeToSelection(new Set(["c"]), ["b", "c", "d"]);
    expect([...next].sort()).toEqual(["b", "c", "d"]);
  });

  it("is idempotent — shift-clicking the same range twice changes nothing", () => {
    const once = addRangeToSelection(new Set(), ["b", "c", "d"]);
    const twice = addRangeToSelection(once, ["b", "c", "d"]);
    expect([...twice].sort()).toEqual([...once].sort());
  });

  it("does not mutate the set it was handed", () => {
    const before = new Set(["keep-me"]);
    addRangeToSelection(before, ["b"]);
    expect([...before]).toEqual(["keep-me"]);
  });
});
