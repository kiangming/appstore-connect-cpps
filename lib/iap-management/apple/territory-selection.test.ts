import { describe, it, expect } from "vitest";

import {
  allTerritoriesSelection,
  classifySelection,
  diffSelection,
  excludesBaseTerritory,
  noTerritoriesSelection,
  selectionsEqual,
  subsetSelection,
} from "./territory-selection";
import type { AvailabilityForIap } from "./availabilities";

/** A stand-in catalogue. Ids are opaque to us — that is the point. */
const ALL = ["USA", "VNM", "JPN", "DEU", "TWN"];

function availability(
  territoryIds: string[],
  availableInNewTerritories = false,
): AvailabilityForIap {
  return {
    availableInNewTerritories,
    territoryCount: territoryIds.length,
    territoryIds,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// THE LOAD-BEARING ONE. KB §4.13: Apple has no `availableInAllTerritories`;
// `availableInNewTerritories` is forward-looking and INDEPENDENT of the list.
// So "All countries or regions" and "every box ticked by hand" carry the same
// ids and different flags. If these ever collapse into one state, the tool is
// silently sending a different request than the UI claims.
// ───────────────────────────────────────────────────────────────────────────
describe("All vs 175-ticked-by-hand — the distinction is structural", () => {
  it("classifies same-ids-different-flag as two DIFFERENT kinds", () => {
    const all = allTerritoriesSelection(ALL);
    const byHand = subsetSelection(ALL); // flag defaults false

    expect(classifySelection(all, ALL)).toBe("ALL");
    expect(classifySelection(byHand, ALL)).toBe("ALL_FROZEN");
    expect(classifySelection(all, ALL)).not.toBe(
      classifySelection(byHand, ALL),
    );
  });

  it("does NOT treat them as equal selections", () => {
    const all = allTerritoriesSelection(ALL);
    const byHand = subsetSelection(ALL);

    // Identical id sets…
    expect([...all.territoryIds].sort()).toEqual(
      [...byHand.territoryIds].sort(),
    );
    // …but not the same selection.
    expect(selectionsEqual(all, byHand)).toBe(false);
  });

  it("reports a change when ONLY the forward flag differs", () => {
    const current = availability(ALL, false);
    const diff = diffSelection(current, allTerritoriesSelection(ALL));

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.flagChanged).toBe(true);
    // The whole point: no territory moved, yet this is a real write.
    expect(diff.willChange).toBe(true);
  });

  it("never derives the flag from list length", () => {
    // A subset that happens to be everything must not silently become "ALL".
    const sneaky = subsetSelection(ALL, false);
    expect(sneaky.availableInNewTerritories).toBe(false);
    expect(classifySelection(sneaky, ALL)).not.toBe("ALL");
  });
});

describe("classifySelection", () => {
  it("empty is NONE regardless of flag", () => {
    expect(classifySelection(noTerritoriesSelection(), ALL)).toBe("NONE");
    expect(classifySelection(subsetSelection([], true), ALL)).toBe("NONE");
  });

  it("a strict subset is SUBSET", () => {
    expect(classifySelection(subsetSelection(["USA", "VNM"]), ALL)).toBe(
      "SUBSET",
    );
  });

  it("is order-insensitive when matching the catalogue", () => {
    const shuffled = subsetSelection([...ALL].reverse(), true);
    expect(classifySelection(shuffled, ALL)).toBe("ALL");
  });
});

describe("diffSelection", () => {
  it("names what is added and what is removed", () => {
    const diff = diffSelection(
      availability(["USA", "VNM", "DEU"]),
      subsetSelection(["VNM", "TWN"]),
    );
    expect(diff.added).toEqual(["TWN"]);
    expect(diff.removed).toEqual(["USA", "DEU"]);
    expect(diff.previousCount).toBe(3);
    expect(diff.nextCount).toBe(2);
    expect(diff.willChange).toBe(true);
  });

  it("an identical set with an identical flag is a no-op", () => {
    const diff = diffSelection(
      availability(["USA", "VNM"], false),
      subsetSelection(["VNM", "USA"], false),
    );
    expect(diff.willChange).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.flagChanged).toBe(false);
  });

  it("treats a missing availability resource as zero territories", () => {
    const diff = diffSelection(null, subsetSelection(["USA"]));
    expect(diff.previousCount).toBe(0);
    expect(diff.added).toEqual(["USA"]);
    expect(diff.removed).toEqual([]);
    expect(diff.willChange).toBe(true);
  });

  it("removing everything from a live item is a change", () => {
    const diff = diffSelection(
      availability(["USA", "VNM"]),
      noTerritoriesSelection(),
    );
    expect(diff.removed).toEqual(["USA", "VNM"]);
    expect(diff.willChange).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Never transform values received from Apple.
// ───────────────────────────────────────────────────────────────────────────
describe("territory ids round-trip verbatim", () => {
  it("does not re-case, trim or reorder ids", () => {
    const odd = ["us-A", "  VNM", "jpn", "ZZZ_9"];
    const sel = subsetSelection(odd);
    expect(sel.territoryIds).toEqual(odd);
  });

  it("does not mutate the caller's array", () => {
    const source = ["USA", "VNM"];
    const sel = subsetSelection(source);
    classifySelection(sel, ALL);
    selectionsEqual(sel, allTerritoriesSelection(ALL));
    diffSelection(availability(["JPN"]), sel);
    expect(source).toEqual(["USA", "VNM"]);
  });

  it("does not mutate the catalogue passed to allTerritoriesSelection", () => {
    const catalogue = [...ALL];
    const sel = allTerritoriesSelection(catalogue);
    classifySelection(sel, catalogue);
    expect(catalogue).toEqual(ALL);
  });

  it("surfaces diff members as the exact strings Apple gave us", () => {
    const diff = diffSelection(
      availability(["us-A"]),
      subsetSelection(["ZZZ_9"]),
    );
    expect(diff.removed).toEqual(["us-A"]);
    expect(diff.added).toEqual(["ZZZ_9"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Manager decision 4 — WARN, never block. V2 established the base is the
// item's own `base_territory` column, NOT the literal "USA".
// ───────────────────────────────────────────────────────────────────────────
describe("excludesBaseTerritory", () => {
  it("is true when the item's base is not in the selection", () => {
    expect(excludesBaseTerritory(subsetSelection(["VNM", "JPN"]), "USA")).toBe(
      true,
    );
  });

  it("is false when the base is included", () => {
    expect(excludesBaseTerritory(subsetSelection(["USA", "VNM"]), "USA")).toBe(
      false,
    );
  });

  it("uses the item's own base, not a hardcoded USA", () => {
    const sel = subsetSelection(["USA", "VNM"]);
    // An item based in Japan is excluded by this very same selection.
    expect(excludesBaseTerritory(sel, "JPN")).toBe(true);
    expect(excludesBaseTerritory(sel, "USA")).toBe(false);
  });

  it("does not fire for Remove-from-Sales (that is its own story)", () => {
    expect(excludesBaseTerritory(noTerritoriesSelection(), "USA")).toBe(false);
  });

  it("does not fire when the base is unknown", () => {
    expect(excludesBaseTerritory(subsetSelection(["VNM"]), null)).toBe(false);
    expect(excludesBaseTerritory(subsetSelection(["VNM"]), undefined)).toBe(
      false,
    );
    expect(excludesBaseTerritory(subsetSelection(["VNM"]), "")).toBe(false);
  });
});
