/**
 * The surface defaults, asserted.
 *
 * ⚠ The first test is the one that matters. Surface C opening on ALL instead of
 * the item's current territories is a silent widening: the Manager sees a form
 * they did not touch, presses Update for an unrelated field, and every market
 * gets added. The mutation-check for SC5 points this function at ALL and
 * requires this file to go red.
 */
import { describe, it, expect } from "vitest";
import {
  bulkSurfaceDefaultSelection,
  editSurfaceDefaultSelection,
} from "./availability-surface-defaults";
import { subsetSelection } from "./territory-selection";

const CATALOGUE = ["USA", "VNM", "BRA", "KAZ"];

describe("surface C (Edit item) — defaults to the item's CURRENT territories", () => {
  it("⚠ returns the current selection, NOT every territory", () => {
    const current = subsetSelection(["VNM", "BRA"]);
    const out = editSurfaceDefaultSelection(current, true);

    expect(out).toEqual(current);
    expect(out!.territoryIds).toHaveLength(2);
    // The catalogue is 4. If this ever equals 4, the default has become ALL.
    expect(out!.territoryIds).not.toHaveLength(CATALOGUE.length);
    expect(out!.availableInNewTerritories).toBe(false);
  });

  it("preserves the forward-looking flag of an all-territories item", () => {
    const current = { territoryIds: CATALOGUE, availableInNewTerritories: true };
    expect(editSurfaceDefaultSelection(current, true)).toEqual(current);
  });

  it("a known-absent availability becomes the EMPTY selection, not ALL", () => {
    const out = editSurfaceDefaultSelection(null, true);
    expect(out).toEqual({ territoryIds: [], availableInNewTerritories: false });
  });

  it("⚠ a FAILED read yields null — there is nothing honest to pre-fill", () => {
    // Not the empty selection: that would claim "removed from sale" about an
    // item nobody could read, and a push would act on the claim.
    expect(editSurfaceDefaultSelection(null, false)).toBeNull();
    expect(editSurfaceDefaultSelection(subsetSelection(["USA"]), false)).toBeNull();
  });

  it("does not transform the ids it passes through", () => {
    const current = subsetSelection(["VNM", "USA"]);
    expect(editSurfaceDefaultSelection(current, true)!.territoryIds).toEqual([
      "VNM",
      "USA",
    ]);
  });
});

describe("surfaces A and B (bulk) — default to ALL", () => {
  it("returns every territory plus the forward-looking flag", () => {
    const out = bulkSurfaceDefaultSelection(CATALOGUE);
    expect(out.territoryIds).toEqual(CATALOGUE);
    expect(out.availableInNewTerritories).toBe(true);
  });

  it("⚠ the two surface families do NOT share a default", () => {
    // If these ever agree, one of the two policies has been lost.
    const current = subsetSelection(["VNM"]);
    expect(editSurfaceDefaultSelection(current, true)).not.toEqual(
      bulkSurfaceDefaultSelection(CATALOGUE),
    );
  });
});
