// @vitest-environment jsdom
/**
 * Behaviours of the availability territory picker that are cheap to break and
 * expensive to lose.
 *
 * ⚠ The load-bearing one is the FIRST describe: "All countries or regions" and
 * "every territory ticked by hand" must produce different emitted selections
 * AND different visible text. They carry identical ids and differ only in
 * `availableInNewTerritories`, which Apple treats as forward-looking — so they
 * are two different request bodies (KB §4.13). A UI that rendered them the
 * same would be lying about what it will send, and nothing else would catch
 * it: the ids match, the count matches, the table looks identical.
 *
 * ⚠ The second-most dangerous control is select-all. It must address the
 * CURRENT FILTER, never the catalogue. The mutation-check for this chunk
 * points a filtered select-all at the full list and requires these tests to
 * go red.
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TerritoryAvailabilityPicker } from "./TerritoryAvailabilityPicker";
import {
  allTerritoriesSelection,
  noTerritoriesSelection,
  subsetSelection,
  type TerritorySelection,
} from "@/lib/iap-management/apple/territory-selection";

/** Americas = { USA, BRA } · Asia = { VNM, KAZ } · Europe = { DEU } */
const IDS = ["USA", "VNM", "BRA", "KAZ", "DEU"];

/**
 * The picker is controlled, so tests drive it through a host that owns the
 * state — the same shape every real surface will use. `latest()` reads what
 * the picker last emitted.
 */
function Host({
  initial,
  ...rest
}: {
  initial: TerritorySelection;
  resetTo?: TerritorySelection | null;
  baseTerritory?: string | null;
}) {
  const [value, setValue] = useState(initial);
  seen = value;
  return (
    <TerritoryAvailabilityPicker
      territoryIds={IDS}
      value={value}
      onChange={setValue}
      {...rest}
    />
  );
}

let seen: TerritorySelection = noTerritoriesSelection();
const latest = () => seen;

function renderPicker(
  initial: TerritorySelection,
  rest?: { resetTo?: TerritorySelection | null; baseTerritory?: string | null },
) {
  seen = initial;
  render(<Host initial={initial} {...rest} />);
}

const row = (code: string) => screen.queryByTestId(`territory-row-${code}`);
const checkbox = (code: string) =>
  screen.getByTestId(`territory-row-${code}`).querySelector("input[type=checkbox]")!;
const footer = () => screen.getByTestId("territory-picker-footer").textContent ?? "";
const countChip = () => screen.getByTestId("territory-picker-count").textContent ?? "";
const searchBox = () => screen.getByLabelText("Search territories");
const chip = (name: string) => screen.getByRole("button", { name });
const scopeAll = () => chip("All countries or regions");
const scopeSelected = () => chip("Selected countries or regions");

// ═══════════════════════════════════════════════════════════════════════════
// 1 — the G1 distinction (behaviour 2). THE test.
// ═══════════════════════════════════════════════════════════════════════════
describe("All countries vs every-territory-ticked-by-hand", () => {
  it("emits the same ids with a DIFFERENT flag", () => {
    renderPicker(allTerritoriesSelection(IDS));
    const asAll = latest();

    // One click: keep the ids, hand ownership of the list to the Manager.
    fireEvent.click(scopeSelected());
    const byHand = latest();

    expect(asAll.availableInNewTerritories).toBe(true);
    expect(byHand.availableInNewTerritories).toBe(false);
    expect([...byHand.territoryIds].sort()).toEqual([...asAll.territoryIds].sort());
    // If this ever passes, the two states have collapsed into one.
    expect(byHand).not.toEqual(asAll);
  });

  it("says which one you are in, in words — the states never read alike", () => {
    renderPicker(allTerritoriesSelection(IDS));
    const allText = footer();
    expect(allText).toContain("includes any new market Apple launches later");

    fireEvent.click(scopeSelected());
    const byHandText = footer();
    expect(byHandText).toContain("new Apple markets will NOT be added automatically");

    expect(byHandText).not.toBe(allText);
    // Both hold all 5 ids, so the count alone cannot tell them apart.
    expect(allText).toContain(`${IDS.length} of ${IDS.length} selected`);
    expect(byHandText).toContain(`${IDS.length} of ${IDS.length} selected`);
  });

  it("'All countries' hides the table — there is no per-row state to show", () => {
    renderPicker(allTerritoriesSelection(IDS));
    expect(row("USA")).not.toBeInTheDocument();
    expect(screen.getByText(`All ${IDS.length} countries and regions`)).toBeInTheDocument();

    fireEvent.click(scopeSelected());
    expect(row("USA")).toBeInTheDocument();
  });

  it("un-ticking one territory drops the forward-looking flag", () => {
    renderPicker(allTerritoriesSelection(IDS));
    fireEvent.click(scopeSelected());
    fireEvent.click(checkbox("VNM"));

    expect(latest().availableInNewTerritories).toBe(false);
    expect(latest().territoryIds).not.toContain("VNM");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — select-all applies to the FILTER, not the catalogue (behaviour 3)
// ═══════════════════════════════════════════════════════════════════════════
describe("select all / clear all address only what is shown", () => {
  it("'Select all N shown' under a continent filter selects ONLY that continent", () => {
    renderPicker(noTerritoriesSelection());

    fireEvent.click(chip("Asia"));
    fireEvent.click(chip("Select all 2 shown"));

    expect([...latest().territoryIds].sort()).toEqual(["KAZ", "VNM"]);
    // The catalogue was never addressed.
    expect(latest().territoryIds).not.toContain("USA");
    expect(latest().territoryIds).not.toContain("DEU");
  });

  it("'Select all N shown' under a search query selects ONLY the matches", () => {
    renderPicker(noTerritoriesSelection());

    fireEvent.change(searchBox(), { target: { value: "vietnam" } });
    fireEvent.click(chip("Select all 1 shown"));

    expect(latest().territoryIds).toEqual(["VNM"]);
  });

  it("the button label carries the number it will affect", () => {
    renderPicker(noTerritoriesSelection());
    expect(chip(`Select all ${IDS.length} shown`)).toBeInTheDocument();

    fireEvent.click(chip("Americas"));
    expect(chip("Select all 2 shown")).toBeInTheDocument();
  });

  it("'Clear all N shown' leaves selections outside the filter untouched", () => {
    renderPicker(subsetSelection(["USA", "VNM", "KAZ"]));

    fireEvent.click(chip("Asia"));
    fireEvent.click(chip("Clear all 2 shown"));

    // Asia cleared, the Americas selection survives.
    expect(latest().territoryIds).toEqual(["USA"]);
  });

  it("warns while a filter is narrowing the list, and not otherwise", () => {
    renderPicker(noTerritoriesSelection());
    expect(screen.getByTestId("territory-picker-filter-strip").textContent).not.toContain(
      "Filter active",
    );

    fireEvent.click(chip("Asia"));
    expect(screen.getByTestId("territory-picker-filter-strip").textContent).toContain(
      "Filter active — 2 of 5 shown",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — live count, pre-selection, reset (behaviours 4, 5)
// ═══════════════════════════════════════════════════════════════════════════
describe("live count", () => {
  it("updates on every toggle and counts the SET, not the view", () => {
    renderPicker(noTerritoriesSelection());
    expect(countChip()).toContain("0 of 5 selected");

    fireEvent.click(checkbox("VNM"));
    expect(countChip()).toContain("1 of 5 selected");

    fireEvent.click(checkbox("USA"));
    expect(countChip()).toContain("2 of 5 selected");

    // Filtering away a selected row must not change the count.
    fireEvent.click(chip("Europe"));
    expect(row("VNM")).not.toBeInTheDocument();
    expect(countChip()).toContain("2 of 5 selected");
  });
});

describe("pre-selection and reset (surface C)", () => {
  it("opens with the item's current territories ticked", () => {
    renderPicker(subsetSelection(["VNM", "BRA"]));

    expect(checkbox("VNM")).toBeChecked();
    expect(checkbox("BRA")).toBeChecked();
    expect(checkbox("USA")).not.toBeChecked();
    expect(countChip()).toContain("2 of 5 selected");
  });

  it("'Reset to current' restores exactly what was passed", () => {
    const current = subsetSelection(["VNM", "BRA"]);
    renderPicker(current, { resetTo: current });

    fireEvent.click(checkbox("USA"));
    fireEvent.click(checkbox("VNM"));
    expect([...latest().territoryIds].sort()).toEqual(["BRA", "USA"]);

    fireEvent.click(screen.getByRole("button", { name: "Reset to current" }));
    expect(latest()).toEqual(current);
  });

  it("offers no reset where there is nothing to reset to (surface B)", () => {
    renderPicker(noTerritoriesSelection());
    expect(screen.queryByRole("button", { name: "Reset to current" })).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — the §G6 advisory: a configuration fact, and nothing more
// ═══════════════════════════════════════════════════════════════════════════
describe("base-territory advisory", () => {
  const advisory = () => screen.queryByTestId("territory-picker-base-advisory");

  it("appears when the selection excludes the item's own base territory", () => {
    renderPicker(subsetSelection(["VNM", "KAZ"]), { baseTerritory: "USA" });
    expect(advisory()?.textContent).toContain("Prices are calculated from USA");
  });

  it("uses the ITEM's base territory, not a hardcoded USA", () => {
    renderPicker(subsetSelection(["USA"]), { baseTerritory: "DEU" });
    expect(advisory()?.textContent).toContain("Prices are calculated from DEU");
  });

  it("stays quiet when the base is included", () => {
    renderPicker(subsetSelection(["USA", "VNM"]), { baseTerritory: "USA" });
    expect(advisory()).not.toBeInTheDocument();
  });

  it("stays quiet for Remove-from-Sale — the empty set is its own story", () => {
    renderPicker(noTerritoriesSelection(), { baseTerritory: "USA" });
    expect(advisory()).not.toBeInTheDocument();
  });

  it("never claims a consequence Apple has not been shown to produce (G6)", () => {
    renderPicker(subsetSelection(["VNM"]), { baseTerritory: "USA" });
    const text = advisory()?.textContent ?? "";
    // §G6 is UNPROVEN: the spec is silent on whether Apple rejects, ignores or
    // parks a price in an excluded territory. Copy that promised an outcome
    // would be a guess dressed as a warning.
    for (const forbidden of ["reject", "will fail", "error", "invalid", "blocked"]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("does not block: nothing is disabled while the advisory shows", () => {
    renderPicker(subsetSelection(["VNM"]), { baseTerritory: "USA" });
    expect(advisory()).toBeInTheDocument();
    expect(scopeAll()).not.toBeDisabled();
    expect(scopeSelected()).not.toBeDisabled();
    expect(checkbox("USA")).not.toBeDisabled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — never transform Apple's values
// ═══════════════════════════════════════════════════════════════════════════
describe("Apple's ids round-trip verbatim", () => {
  it("emits ids exactly as received, without sorting or rewriting", () => {
    renderPicker(noTerritoriesSelection());

    fireEvent.click(checkbox("VNM"));
    fireEvent.click(checkbox("USA"));

    // Click order preserved — the picker appends and never sorts.
    expect(latest().territoryIds).toEqual(["VNM", "USA"]);
  });

  it("renders an unrecognised id rather than dropping or normalising it", () => {
    // A territory ISO does not bucket. Apple gave it to us; it must be
    // selectable, and its id must survive untouched.
    const onChange = vi.fn();
    render(
      <TerritoryAvailabilityPicker
        territoryIds={["USA", "ATA"]}
        value={noTerritoriesSelection()}
        onChange={onChange}
      />,
    );

    expect(row("ATA")).toBeInTheDocument();
    fireEvent.click(checkbox("ATA"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ territoryIds: ["ATA"] }),
    );
  });
});
