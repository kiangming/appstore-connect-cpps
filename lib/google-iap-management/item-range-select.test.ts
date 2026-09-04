/**
 * Chunk 1 — the pure range helper. These tests are the acceptance bar for the
 * invariant "a range can never contain a row the operator has not seen".
 */
import { describe, it, expect } from "vitest";

import {
  resolveRangeSkus,
  addRangeToSelection,
} from "./item-range-select";

const RENDERED = ["a", "b", "c", "d"];

describe("resolveRangeSkus — forming a range", () => {
  it("returns the inclusive slice, anchor before target", () => {
    expect(resolveRangeSkus(RENDERED, "b", "d")).toEqual(["b", "c", "d"]);
  });

  it("returns the inclusive slice, anchor AFTER target — direction is irrelevant", () => {
    expect(resolveRangeSkus(RENDERED, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("a single row is a range of one, not null", () => {
    expect(resolveRangeSkus(RENDERED, "c", "c")).toEqual(["c"]);
  });

  it("preserves the RENDERED order, not the argument order", () => {
    expect(resolveRangeSkus(RENDERED, "d", "a")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("⚠ resolveRangeSkus — the refusals, and why each is `null` not `[]`", () => {
  it("no anchor yet ⇒ null", () => {
    expect(resolveRangeSkus(RENDERED, null, "b")).toBeNull();
  });

  it("⭐ anchor NOT among the rendered rows ⇒ null — the boundary guarantee", () => {
    // This is guarantee (2): it holds even when the caller forgets to drop the
    // anchor at a boundary. `z` is a row that exists somewhere in the list but
    // is not on screen.
    expect(resolveRangeSkus(RENDERED, "z", "b")).toBeNull();
  });

  it("⭐ target NOT among the rendered rows ⇒ null — a range cannot REACH OUT", () => {
    // A real click cannot produce this, which is exactly why it is asserted:
    // it is the shape a future caller would smuggle in by passing the MATCHING
    // array instead of the RENDERED one. With `matching` this range would
    // form and would tick rows nobody looked at.
    expect(resolveRangeSkus(RENDERED, "a", "z")).toBeNull();
  });

  it("an empty rendered set refuses everything", () => {
    expect(resolveRangeSkus([], "a", "b")).toBeNull();
  });

  it("⚠ never returns an empty array — `[]` would read as a silent no-op", () => {
    for (const r of [
      resolveRangeSkus(RENDERED, null, "b"),
      resolveRangeSkus(RENDERED, "z", "b"),
      resolveRangeSkus(RENDERED, "a", "z"),
    ]) {
      expect(r).toBeNull();
      expect(r).not.toEqual([]);
    }
  });
});

describe("⚠ addRangeToSelection — ADDITIVE, never toggling", () => {
  it("adds the range and KEEPS picks outside it", () => {
    // M1: a range must never wipe a pick made elsewhere — the Finder/Explorer
    // "replace the selection" behaviour is disqualified outright.
    const before = new Set(["far.away", "b"]);
    expect([...addRangeToSelection(before, ["b", "c"])].sort()).toEqual([
      "b",
      "c",
      "far.away",
    ]);
  });

  it("⭐ does NOT untick a row already ticked inside the range", () => {
    // Toggling would make the outcome depend on the prior state of rows in the
    // MIDDLE of the range — rows the operator may never have looked at.
    const before = new Set(["b"]);
    expect(addRangeToSelection(before, ["a", "b", "c"]).has("b")).toBe(true);
  });

  it("is idempotent — shift-click twice, same result", () => {
    const once = addRangeToSelection(new Set<string>(), ["a", "b"]);
    const twice = addRangeToSelection(once, ["a", "b"]);
    expect([...twice].sort()).toEqual(["a", "b"]);
  });

  it("does not mutate the set it was given", () => {
    const before = new Set(["x"]);
    addRangeToSelection(before, ["a"]);
    expect([...before]).toEqual(["x"]);
  });
});
