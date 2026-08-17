// @vitest-environment jsdom
/**
 * Surface C — the Availability section of the Edit form.
 *
 * ⚠ THE MOST IMPORTANT TEST HERE IS THE DEFAULT. Manager decision 2 locks
 * surface C to the item's CURRENT territories; A and B default to ALL. If this
 * regressed to ALL, a Manager who opened the form to fix a display name and
 * pressed Update would silently widen a 12-territory item to every market —
 * and nothing in the flow would say so, because "no change" is exactly what
 * they would expect from not touching the section.
 *
 * ⚠ The two degraded states are load-bearing too. A failed availability read
 * and an empty catalogue both used to be masked (the old derivation collapsed
 * them into "default to ALL"). Rendering a picker on either would mean pushing
 * a selection built from an invented starting point.
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { AvailabilitiesSection } from "./AvailabilitiesSection";
import {
  allTerritoriesSelection,
  noTerritoriesSelection,
  subsetSelection,
  type TerritorySelection,
} from "@/lib/iap-management/apple/territory-selection";

/** Americas = { USA, BRA } · Asia = { VNM, KAZ } */
const CATALOGUE = ["USA", "VNM", "BRA", "KAZ"];

let seen: TerritorySelection | null = null;

function Host({
  initial,
  cached,
  previousKnown = true,
  allTerritoryIds = CATALOGUE,
  baseTerritory = null,
}: {
  initial: TerritorySelection | null;
  cached: TerritorySelection | null;
  previousKnown?: boolean;
  allTerritoryIds?: readonly string[];
  baseTerritory?: string | null;
}) {
  const [value, setValue] = useState(initial);
  seen = value;
  return (
    <AvailabilitiesSection
      value={value}
      cached={cached}
      previousKnown={previousKnown}
      allTerritoryIds={allTerritoryIds}
      baseTerritory={baseTerritory}
      onChange={setValue}
    />
  );
}

function renderSection(props: Parameters<typeof Host>[0]) {
  seen = props.initial;
  render(<Host {...props} />);
}

const row = (code: string) => screen.queryByTestId(`territory-row-${code}`);
const checkbox = (code: string) =>
  screen.getByTestId(`territory-row-${code}`).querySelector("input[type=checkbox]")!;
const footer = () => screen.getByTestId("territory-picker-footer").textContent ?? "";

// ═══════════════════════════════════════════════════════════════════════════
// 1 — THE DEFAULT (Manager decision 2)
// ═══════════════════════════════════════════════════════════════════════════
describe("default selection", () => {
  it("⚠ opens with the item's CURRENT territories, not ALL", () => {
    const current = subsetSelection(["VNM", "BRA"]);
    renderSection({ initial: current, cached: current });

    expect(checkbox("VNM")).toBeChecked();
    expect(checkbox("BRA")).toBeChecked();
    // The two the item is NOT sold in must start unticked. If these were
    // checked, pressing Update would widen the item silently.
    expect(checkbox("USA")).not.toBeChecked();
    expect(checkbox("KAZ")).not.toBeChecked();
    expect(footer()).toContain("2 of 4 selected");
  });

  it("shows no pending-change note when nothing has been touched", () => {
    const current = subsetSelection(["VNM"]);
    renderSection({ initial: current, cached: current });
    expect(screen.queryByTestId("availabilities-pending")).not.toBeInTheDocument();
  });

  it("an item removed from sale opens empty, not full", () => {
    renderSection({ initial: noTerritoriesSelection(), cached: null });
    for (const code of CATALOGUE) expect(checkbox(code)).not.toBeChecked();
    expect(footer()).toContain("0 of 4 selected");
  });

  it("surfaces the pending change once a territory is toggled", () => {
    const current = subsetSelection(["VNM"]);
    renderSection({ initial: current, cached: current });

    fireEvent.click(checkbox("USA"));

    const note = screen.getByTestId("availabilities-pending").textContent ?? "";
    expect(note).toContain("1 of 4");
    expect(note).toContain("2 of 4");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — Reset to current
// ═══════════════════════════════════════════════════════════════════════════
describe("reset to current", () => {
  it("restores exactly the Apple-side selection", () => {
    const current = subsetSelection(["VNM", "BRA"]);
    renderSection({ initial: current, cached: current });

    fireEvent.click(checkbox("USA"));
    fireEvent.click(checkbox("VNM"));
    expect([...(seen?.territoryIds ?? [])].sort()).toEqual(["BRA", "USA"]);

    fireEvent.click(screen.getByRole("button", { name: "Reset to current" }));
    expect(seen).toEqual(current);
    expect(screen.queryByTestId("availabilities-pending")).not.toBeInTheDocument();
  });

  it("resets to the EMPTY selection for an item Apple has no availability for", () => {
    renderSection({ initial: noTerritoriesSelection(), cached: null });

    fireEvent.click(checkbox("USA"));
    expect(seen?.territoryIds).toEqual(["USA"]);

    fireEvent.click(screen.getByRole("button", { name: "Reset to current" }));
    expect(seen?.territoryIds).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — the §G6 advisory, against the ITEM's base territory
// ═══════════════════════════════════════════════════════════════════════════
describe("base-territory advisory", () => {
  const advisory = () => screen.queryByTestId("territory-picker-base-advisory");

  it("appears when the selection excludes the item's base territory", () => {
    renderSection({
      initial: subsetSelection(["VNM", "KAZ"]),
      cached: subsetSelection(["VNM", "KAZ"]),
      baseTerritory: "USA",
    });
    expect(advisory()?.textContent).toContain("Prices are calculated from USA");
  });

  it("⚠ uses the ITEM's base_territory, never a hardcoded USA", () => {
    // The column is per-item (migration 20260515000000:94). An item based in
    // Brazil that excludes Brazil must warn about BRA, and an item based in
    // Brazil that excludes only the USA must not warn at all.
    renderSection({
      initial: subsetSelection(["USA", "VNM"]),
      cached: subsetSelection(["USA", "VNM"]),
      baseTerritory: "BRA",
    });
    expect(advisory()?.textContent).toContain("Prices are calculated from BRA");
  });

  it("stays quiet when the base territory is included", () => {
    renderSection({
      initial: subsetSelection(["USA", "VNM"]),
      cached: subsetSelection(["USA", "VNM"]),
      baseTerritory: "USA",
    });
    expect(advisory()).not.toBeInTheDocument();
  });

  it("does not block — the advisory never disables the controls", () => {
    renderSection({
      initial: subsetSelection(["VNM"]),
      cached: subsetSelection(["VNM"]),
      baseTerritory: "USA",
    });
    expect(advisory()).toBeInTheDocument();
    expect(checkbox("USA")).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: "All countries or regions" }),
    ).not.toBeDisabled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — degraded states are stated, never papered over
// ═══════════════════════════════════════════════════════════════════════════
describe("degraded reads", () => {
  it("refuses to render a picker when the availability read FAILED", () => {
    renderSection({
      initial: null,
      cached: null,
      previousKnown: false,
    });
    expect(screen.getByTestId("availabilities-unknown")).toBeInTheDocument();
    // No picker, so nothing can be pushed from an invented starting point.
    expect(row("USA")).not.toBeInTheDocument();
  });

  it("refuses to render a picker when Apple's catalogue could not be loaded", () => {
    // Pre-SC5 this was masked: an empty catalogue fell through to "default
    // ALL". Rendering the picker here would read "0 of 0 selected" and a push
    // would be a Remove-from-Sale nobody chose.
    renderSection({
      initial: subsetSelection(["VNM"]),
      cached: subsetSelection(["VNM"]),
      allTerritoryIds: [],
    });
    expect(screen.getByTestId("availabilities-no-catalogue")).toBeInTheDocument();
    expect(row("VNM")).not.toBeInTheDocument();
  });

  it("still renders the section heading in every degraded state", () => {
    renderSection({ initial: null, cached: null, previousKnown: false });
    expect(screen.getByTestId("availabilities-section")).toBeInTheDocument();
    expect(screen.getByText("Availability")).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — the G1 distinction survives the section wrapper
// ═══════════════════════════════════════════════════════════════════════════
describe("all-vs-all-frozen through the section", () => {
  it("the pending note distinguishes 'plus future markets' from 'not included'", () => {
    const current = subsetSelection(["VNM"]);
    renderSection({ initial: current, cached: current });

    fireEvent.click(screen.getByRole("button", { name: "All countries or regions" }));
    const asAll = screen.getByTestId("availabilities-pending").textContent ?? "";
    expect(asAll).toContain("plus future markets");

    fireEvent.click(
      screen.getByRole("button", { name: "Selected countries or regions" }),
    );
    const byHand = screen.getByTestId("availabilities-pending").textContent ?? "";
    expect(byHand).toContain("future markets NOT included");
    expect(byHand).not.toBe(asAll);
  });

  it("emits the flag Apple needs for each of the two states", () => {
    const current = subsetSelection(["VNM"]);
    renderSection({ initial: current, cached: current });

    fireEvent.click(screen.getByRole("button", { name: "All countries or regions" }));
    expect(seen).toEqual(allTerritoriesSelection(CATALOGUE));

    fireEvent.click(
      screen.getByRole("button", { name: "Selected countries or regions" }),
    );
    expect(seen?.availableInNewTerritories).toBe(false);
    expect([...(seen?.territoryIds ?? [])].sort()).toEqual([...CATALOGUE].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — Apple's ids are never transformed on the way through
// ═══════════════════════════════════════════════════════════════════════════
describe("ids round-trip verbatim", () => {
  it("keeps an unrecognised territory selectable and unmodified", () => {
    const onChange = vi.fn();
    render(
      <AvailabilitiesSection
        value={noTerritoriesSelection()}
        cached={noTerritoriesSelection()}
        previousKnown
        allTerritoryIds={["USA", "ATA"]}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByTestId("territory-row-ATA").querySelector("input[type=checkbox]")!,
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ territoryIds: ["ATA"] }),
    );
  });
});
