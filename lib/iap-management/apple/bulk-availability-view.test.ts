/**
 * Surface A's view logic.
 *
 * The three tests marked ⚠ are the SC6 mutation targets. Each guards a
 * decision that looks fine in a screenshot and is wrong anyway:
 *   • merging NOT_ATTEMPTED into failed destroys the only safely-resumable set;
 *   • hiding read-errored items from the confirm silently narrows the batch;
 *   • a retry that includes successes re-POSTs writes that already landed.
 */
import { describe, it, expect } from "vitest";
import {
  baseTerritoryAdvisory,
  buildConfirmBuckets,
  hasWorkToConfirm,
  isStoppedRun,
  partitionResults,
  resumableIds,
  type BulkRowResult,
  type ConfirmItem,
} from "./bulk-availability-view";
import {
  allTerritoriesSelection,
  noTerritoriesSelection,
  subsetSelection,
} from "./territory-selection";
import type { AvailabilityForIap } from "./availabilities";

const CATALOGUE = ["USA", "VNM", "BRA", "KAZ"];

const item = (n: string): ConfirmItem => ({
  appleIapId: `apple-${n}`,
  productId: `com.x.${n}`,
  name: `Item ${n}`,
});

const avail = (
  ids: string[],
  flag = false,
): AvailabilityForIap => ({
  territoryIds: ids,
  territoryCount: ids.length,
  availableInNewTerritories: flag,
});

const rows = (...spec: Array<[string, BulkRowResult["status"], string?]>) =>
  spec.map(([iapId, status, error]) => ({
    iapId,
    status,
    ...(error ? { error } : {}),
  })) as BulkRowResult[];

// ═══════════════════════════════════════════════════════════════════════════
// 1 — three result states, kept apart
// ═══════════════════════════════════════════════════════════════════════════
describe("partitionResults", () => {
  it("⚠ keeps NOT_ATTEMPTED as its OWN state, never folded into failed", () => {
    const p = partitionResults(
      rows(
        ["a", "SUCCESS"],
        ["b", "FAILED", "Apple 409 state guard"],
        ["c", "NOT_ATTEMPTED"],
        ["d", "NOT_ATTEMPTED"],
      ),
    );

    expect(p.succeeded.map((r) => r.iapId)).toEqual(["a"]);
    expect(p.failed.map((r) => r.iapId)).toEqual(["b"]);
    expect(p.notAttempted.map((r) => r.iapId)).toEqual(["c", "d"]);
    // If NOT_ATTEMPTED ever lands in `failed`, the only blindly-resumable
    // bucket is gone and a retry either re-sends diagnosed failures or
    // abandons work nobody attempted.
    expect(p.failed).toHaveLength(1);
  });

  it("preserves each failure's own reason — never one shared summary", () => {
    const p = partitionResults(
      rows(
        ["a", "FAILED", "Apple 409 PRICING_LOCK"],
        ["b", "FAILED", "territory NOT_AVAILABLE"],
      ),
    );
    expect(p.failed.map((r) => r.error)).toEqual([
      "Apple 409 PRICING_LOCK",
      "territory NOT_AVAILABLE",
    ]);
  });

  it("the three buckets always account for every row exactly once", () => {
    const all = rows(
      ["a", "SUCCESS"],
      ["b", "FAILED"],
      ["c", "NOT_ATTEMPTED"],
    );
    const p = partitionResults(all);
    expect(
      p.succeeded.length + p.failed.length + p.notAttempted.length,
    ).toBe(all.length);
  });
});

describe("resumableIds", () => {
  it("⚠ resumes NOT_ATTEMPTED only — never a success, never a failure", () => {
    const ids = resumableIds(
      rows(
        ["a", "SUCCESS"],
        ["b", "FAILED", "Apple said no"],
        ["c", "NOT_ATTEMPTED"],
      ),
    );
    expect(ids).toEqual(["c"]);
    // A succeeded row re-sent would re-POST a write that already landed;
    // Apple has no PATCH here, so a resend is a full replace.
    expect(ids).not.toContain("a");
    // SC3 locked this: a failure carries a reason a human reads first.
    expect(ids).not.toContain("b");
  });

  it("is empty when the run finished — nothing to resume", () => {
    expect(resumableIds(rows(["a", "SUCCESS"], ["b", "FAILED"]))).toEqual([]);
  });
});

describe("isStoppedRun", () => {
  it("⚠ a stopped run is not a failed run (P5)", () => {
    expect(isStoppedRun("STOPPED_RATE_LIMITED")).toBe(true);
    expect(isStoppedRun("FAILURE")).toBe(false);
    expect(isStoppedRun("PARTIAL")).toBe(false);
    expect(isStoppedRun("SUCCESS")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — confirm buckets (§C)
// ═══════════════════════════════════════════════════════════════════════════
describe("buildConfirmBuckets", () => {
  const states = new Map<string, AvailabilityForIap | null>([
    ["apple-a", avail(CATALOGUE, true)], // all territories
    ["apple-b", avail(["USA", "VNM"])], // subset
    ["apple-c", null], // removed from sale
  ]);

  it("counts only the items that really change, with the numbers", () => {
    const b = buildConfirmBuckets({
      eligible: [item("a"), item("b"), item("c")],
      readErrored: [],
      states,
      selection: subsetSelection(["USA", "VNM"]),
    });

    // b already holds exactly this selection.
    expect(b.alreadyMatches.map((i) => i.appleIapId)).toEqual(["apple-b"]);
    expect(b.willChange.map((i) => i.appleIapId)).toEqual(["apple-a", "apple-c"]);

    const a = b.willChange.find((c) => c.appleIapId === "apple-a")!;
    expect(a.previousCount).toBe(4);
    expect(a.nextCount).toBe(2);
    expect(a.removed).toBe(2);
    expect(a.added).toBe(0);
  });

  it("⚠ read-errored items get their OWN bucket and are named individually", () => {
    // filterEligible drops these from the run (modal:734, shipped behaviour).
    // The dialog must say so — folding them into "already matches" or a bare
    // count is how 50-updated becomes 48-updated silently.
    const b = buildConfirmBuckets({
      eligible: [item("a")],
      readErrored: [item("x"), item("y")],
      states,
      selection: subsetSelection(["USA"]),
    });

    expect(b.unknownExcluded.map((i) => i.appleIapId)).toEqual([
      "apple-x",
      "apple-y",
    ]);
    expect(b.alreadyMatches).toHaveLength(0);
    // Excluded items are NOT counted as changing.
    expect(b.willChange.map((i) => i.appleIapId)).toEqual(["apple-a"]);
  });

  it("⚠ same ids + different forward flag still counts as a change (KB §4.13)", () => {
    // apple-a holds all 4 WITH the flag. Ticking all 4 by hand sends the same
    // ids with the flag OFF — a different request. A hand-rolled id-length
    // comparison would call this "already matches" and hide the write.
    const b = buildConfirmBuckets({
      eligible: [item("a")],
      readErrored: [],
      states,
      selection: subsetSelection(CATALOGUE),
    });
    expect(b.alreadyMatches).toHaveLength(0);
    expect(b.willChange).toHaveLength(1);
  });

  it("an all-territories selection matching an all-territories item is a no-op", () => {
    const b = buildConfirmBuckets({
      eligible: [item("a")],
      readErrored: [],
      states,
      selection: allTerritoriesSelection(CATALOGUE),
    });
    expect(b.willChange).toHaveLength(0);
    expect(b.alreadyMatches).toHaveLength(1);
  });

  it("a removed item receiving the empty selection is a no-op", () => {
    const b = buildConfirmBuckets({
      eligible: [item("c")],
      readErrored: [],
      states,
      selection: noTerritoriesSelection(),
    });
    expect(b.alreadyMatches.map((i) => i.appleIapId)).toEqual(["apple-c"]);
  });

  it("offers no write when nothing would change", () => {
    const b = buildConfirmBuckets({
      eligible: [item("b")],
      readErrored: [],
      states,
      selection: subsetSelection(["USA", "VNM"]),
    });
    expect(hasWorkToConfirm(b)).toBe(false);
  });

  it("offers a write as soon as one item would change", () => {
    const b = buildConfirmBuckets({
      eligible: [item("a"), item("b")],
      readErrored: [],
      states,
      selection: subsetSelection(["USA", "VNM"]),
    });
    expect(hasWorkToConfirm(b)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — base-territory advisory across a heterogeneous batch (§G6)
// ═══════════════════════════════════════════════════════════════════════════
describe("baseTerritoryAdvisory", () => {
  const bases = {
    "apple-a": "USA",
    "apple-b": "USA",
    "apple-c": "BRA",
    "apple-d": "VNM",
  };

  it("⚠ groups by each item's OWN base — a batch holds several", () => {
    const groups = baseTerritoryAdvisory(
      [item("a"), item("b"), item("c"), item("d")],
      subsetSelection(["VNM", "KAZ"]),
      bases,
    );

    // VNM is inside the selection, so item d is not flagged.
    expect(groups.map((g) => g.baseTerritory)).toEqual(["BRA", "USA"]);
    expect(groups.find((g) => g.baseTerritory === "USA")!.items).toHaveLength(2);
    expect(groups.find((g) => g.baseTerritory === "BRA")!.items).toHaveLength(1);
  });

  it("names the items, not just a count — a count is unactionable", () => {
    const groups = baseTerritoryAdvisory(
      [item("a"), item("b")],
      subsetSelection(["VNM"]),
      bases,
    );
    expect(groups[0].items.map((i) => i.name)).toEqual(["Item a", "Item b"]);
  });

  it("stays silent when every base is inside the selection", () => {
    expect(
      baseTerritoryAdvisory([item("a"), item("c")], subsetSelection(["USA", "BRA"]), bases),
    ).toEqual([]);
  });

  it("⚠ never invents a base for an item that has none recorded", () => {
    // Defaulting to "USA" would warn about a territory we made up for it.
    expect(
      baseTerritoryAdvisory([item("zz")], subsetSelection(["VNM"]), bases),
    ).toEqual([]);
  });

  it("stays silent for Remove-from-Sale — the empty set is its own story", () => {
    expect(
      baseTerritoryAdvisory([item("a")], noTerritoriesSelection(), bases),
    ).toEqual([]);
  });
});
