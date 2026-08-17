// @vitest-environment jsdom
/**
 * The confirm gate — three buckets, and Cancel sending nothing.
 *
 * ⚠ The read-errored bucket is the mutation target. `filterEligible` already
 * drops those items from the run; if the dialog does not SAY so, the Manager
 * believes N items were updated when N-2 were, and nothing anywhere corrects
 * them.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SetTerritoriesConfirm } from "./SetTerritoriesConfirm";
import {
  buildConfirmBuckets,
  baseTerritoryAdvisory,
  type ConfirmItem,
} from "@/lib/iap-management/apple/bulk-availability-view";
import {
  allTerritoriesSelection,
  subsetSelection,
} from "@/lib/iap-management/apple/territory-selection";
import type { AvailabilityForIap } from "@/lib/iap-management/apple/availabilities";

const CATALOGUE = ["USA", "VNM", "BRA", "KAZ"];

const item = (n: string): ConfirmItem => ({
  appleIapId: `apple-${n}`,
  productId: `com.x.${n}`,
  name: `Item ${n}`,
});

const states = new Map<string, AvailabilityForIap | null>([
  [
    "apple-a",
    { territoryIds: CATALOGUE, territoryCount: 4, availableInNewTerritories: true },
  ],
  [
    "apple-b",
    { territoryIds: ["USA", "VNM"], territoryCount: 2, availableInNewTerritories: false },
  ],
]);

function renderConfirm(opts?: {
  readErrored?: ConfirmItem[];
  selection?: ReturnType<typeof subsetSelection>;
  bases?: Record<string, string>;
}) {
  const selection = opts?.selection ?? subsetSelection(["USA", "VNM"]);
  const buckets = buildConfirmBuckets({
    eligible: [item("a"), item("b")],
    readErrored: opts?.readErrored ?? [],
    states,
    selection,
  });
  const advisory = baseTerritoryAdvisory(
    buckets.willChange,
    selection,
    opts?.bases ?? {},
  );
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <SetTerritoriesConfirm
      buckets={buckets}
      selection={selection}
      allTerritoryIds={CATALOGUE}
      advisory={advisory}
      submitting={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onCancel, onConfirm };
}

describe("the three buckets", () => {
  it("states the real change count and names every changing item", () => {
    renderConfirm();
    // Only apple-a changes; apple-b already holds exactly this set.
    expect(screen.getByTestId("confirm-headline").textContent).toContain(
      "Replace availability on 1 item?",
    );
    expect(screen.getByTestId("confirm-change-apple-a")).toBeInTheDocument();
    expect(
      screen.queryByTestId("confirm-change-apple-b"),
    ).not.toBeInTheDocument();
    // …with the numbers.
    expect(screen.getByTestId("confirm-change-apple-a").textContent).toContain(
      "4 → 2",
    );
  });

  it("collapses the already-matching items into a count", () => {
    renderConfirm();
    expect(screen.getByTestId("confirm-already-matches").textContent).toContain(
      "1 item",
    );
  });

  it("⚠ names the read-errored items in their OWN bucket", () => {
    renderConfirm({ readErrored: [item("x"), item("y")] });

    const bucket = screen.getByTestId("confirm-unknown-excluded");
    expect(bucket.textContent).toContain("2 items left out");
    expect(bucket.textContent).toContain("could not be read");
    // Named individually, never a bare count.
    expect(screen.getByTestId("confirm-unknown-apple-x")).toBeInTheDocument();
    expect(screen.getByTestId("confirm-unknown-apple-y")).toBeInTheDocument();
    // And NOT counted as changing.
    expect(screen.getByTestId("confirm-headline").textContent).toContain(
      "1 item?",
    );
  });

  it("no unknown bucket when every read succeeded", () => {
    renderConfirm();
    expect(
      screen.queryByTestId("confirm-unknown-excluded"),
    ).not.toBeInTheDocument();
  });

  it("states the REPLACE verb unhedged", () => {
    renderConfirm();
    const body = document.body.textContent ?? "";
    expect(body).toContain("replaced");
    expect(body).toContain("Territories not in your selection will be removed");
  });
});

describe("Cancel", () => {
  it("⚠ calls onCancel and never onConfirm — nothing is sent", () => {
    const { onCancel, onConfirm } = renderConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Cancel holds the default focus, not the destructive action", () => {
    renderConfirm();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});

describe("the ALL vs ALL_FROZEN distinction reaches the confirm copy", () => {
  it("⚠ all-plus-flag and all-by-hand do not read alike (KB §4.13)", () => {
    const { unmount } = { unmount: () => {} };
    renderConfirm({ selection: allTerritoriesSelection(CATALOGUE) });
    const withFlag = document.body.textContent ?? "";
    expect(withFlag).toContain("plus any new market Apple launches later");
    unmount();
    document.body.innerHTML = "";

    renderConfirm({ selection: subsetSelection(CATALOGUE) });
    const byHand = document.body.textContent ?? "";
    expect(byHand).toContain("will NOT be added automatically");
    expect(byHand).not.toBe(withFlag);
  });
});

describe("base-territory advisory", () => {
  it("groups by each item's own base and names the items", () => {
    renderConfirm({
      selection: subsetSelection(["VNM"]),
      bases: { "apple-a": "USA", "apple-b": "BRA" },
    });
    const advisory = screen.getByTestId("confirm-base-advisory");
    expect(advisory.textContent).toContain("USA");
    expect(advisory.textContent).toContain("Item a");
  });

  it("⚠ says availability only — it must not borrow surface C's pricing copy", () => {
    renderConfirm({
      selection: subsetSelection(["VNM"]),
      bases: { "apple-a": "USA" },
    });
    const text = screen.getByTestId("confirm-base-advisory").textContent ?? "";
    expect(text).toContain("does not touch prices");
    // G6 is UNPROVEN and this surface pushes no prices — no promised outcome.
    for (const forbidden of ["reject", "will fail", "invalid", "blocked"]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("silent when no item's base falls outside the selection", () => {
    renderConfirm({ bases: { "apple-a": "USA" } });
    expect(
      screen.queryByTestId("confirm-base-advisory"),
    ).not.toBeInTheDocument();
  });
});
