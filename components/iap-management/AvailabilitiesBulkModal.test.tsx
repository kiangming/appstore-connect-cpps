// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import type { InAppPurchase } from "@/types/iap-management/apple";
import type { AvailabilityForIap } from "@/lib/iap-management/apple/availabilities";
import { filterEligible } from "./AvailabilitiesBulkModal";

function iap(id: string, productId: string, name: string): InAppPurchase {
  return {
    id,
    type: "inAppPurchases",
    attributes: {
      productId,
      name,
      inAppPurchaseType: "CONSUMABLE",
      state: "READY_FOR_SALE",
      familySharable: false,
    },
  } as unknown as InAppPurchase;
}

const availableState: AvailabilityForIap = {
  availableInNewTerritories: true,
  territoryCount: 175,
  territoryIds: [],
};
const removedState: AvailabilityForIap = {
  availableInNewTerritories: false,
  territoryCount: 0,
  territoryIds: [],
};

const appleToInternal = {
  "iap-avail": "uuid-1",
  "iap-removed": "uuid-2",
  "iap-error": "uuid-3",
  "iap-noinit": "uuid-4",
};

const iaps = [
  iap("iap-avail", "com.x.avail", "Available product"),
  iap("iap-removed", "com.x.removed", "Removed product"),
  iap("iap-error", "com.x.error", "Errored fetch product"),
  iap("iap-no-local-row", "com.x.unsynced", "Unsynced product"),
  iap("iap-noinit", "com.x.noinit", "No-availability product"),
];

const states = new Map<string, AvailabilityForIap | null>([
  ["iap-avail", availableState],
  ["iap-removed", removedState],
  ["iap-noinit", null], // 404 path → "removed" bucket
  // iap-error intentionally omitted from states (caller hadn't seen it)
]);
const errors = new Map<string, string>([
  ["iap-error", "Apple 503"],
]);

describe("AvailabilitiesBulkModal.filterEligible", () => {
  it("'set-all' mode lists only items currently Removed from Sales", () => {
    const eligible = filterEligible(iaps, states, errors, "set-all", appleToInternal);
    const ids = eligible.map((e) => e.appleIapId);
    expect(ids).toContain("iap-removed");
    expect(ids).toContain("iap-noinit"); // null state → removed bucket
    expect(ids).not.toContain("iap-avail"); // already available
    expect(ids).not.toContain("iap-error"); // unknown → excluded
    expect(ids).not.toContain("iap-no-local-row"); // no internal UUID
  });

  it("'remove' mode lists only items currently Available", () => {
    const eligible = filterEligible(iaps, states, errors, "remove", appleToInternal);
    const ids = eligible.map((e) => e.appleIapId);
    expect(ids).toEqual(["iap-avail"]);
  });

  it("excludes rows whose Apple fetch errored (both modes)", () => {
    expect(
      filterEligible(iaps, states, errors, "set-all", appleToInternal)
        .map((e) => e.appleIapId),
    ).not.toContain("iap-error");
    expect(
      filterEligible(iaps, states, errors, "remove", appleToInternal)
        .map((e) => e.appleIapId),
    ).not.toContain("iap-error");
  });

  it("excludes rows lacking an internal UUID (Refresh from Apple needed)", () => {
    const eligible = filterEligible(iaps, states, errors, "set-all", appleToInternal);
    expect(eligible.find((e) => e.appleIapId === "iap-no-local-row")).toBeUndefined();
  });

  it("returns an empty list when no IAP matches the mode's bucket", () => {
    // Only one Available IAP — set-all mode wants Removed, so eligible = [Removed + No-init].
    // Construct a fresh fixture with ONLY available items to test the empty path.
    const onlyAvailable = [iap("a-1", "com.a", "All available")];
    const s = new Map<string, AvailabilityForIap | null>([
      ["a-1", availableState],
    ]);
    const out = filterEligible(
      onlyAvailable,
      s,
      new Map(),
      "set-all",
      { "a-1": "uuid-a" },
    );
    expect(out).toEqual([]);
  });

  it("preserves product metadata (productId + name) for modal row rendering", () => {
    const eligible = filterEligible(iaps, states, errors, "remove", appleToInternal);
    expect(eligible[0]).toEqual({
      appleIapId: "iap-avail",
      productId: "com.x.avail",
      name: "Available product",
    });
  });
});
