// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  IapAvailabilitiesSection,
  pickDisplayState,
} from "./IapAvailabilitiesSection";

describe("pickDisplayState (pure)", () => {
  it("renders 'All countries or regions' when count === total and the new-territories flag is set", () => {
    const state = pickDisplayState(
      {
        availability: {
          availableInNewTerritories: true,
          territoryCount: 175,
          territoryIds: [],
        },
        totalTerritoryCount: 175,
      },
      null,
    );
    expect(state.primary).toBe("All countries or regions");
    expect(state.secondary).toMatch(/175/);
    expect(state.secondary).toMatch(/new markets/i);
  });

  it("renders 'N of M' when the count is a strict subset", () => {
    const state = pickDisplayState(
      {
        availability: {
          availableInNewTerritories: true,
          territoryCount: 50,
          territoryIds: [],
        },
        totalTerritoryCount: 175,
      },
      null,
    );
    expect(state.primary).toBe("50 of 175 countries or regions");
  });

  it("treats count===total without new-territories flag as 'N of M' (not 'All')", () => {
    const state = pickDisplayState(
      {
        availability: {
          availableInNewTerritories: false,
          territoryCount: 175,
          territoryIds: [],
        },
        totalTerritoryCount: 175,
      },
      null,
    );
    // Flag-off === Manager explicitly chose to opt out of new markets, so
    // even a full current list is not the same as the "All" radio.
    expect(state.primary).toBe("175 of 175 countries or regions");
    expect(state.secondary).toMatch(/manually/);
  });

  it("renders 'Remove from Sales' when no availability resource exists (404) and flags the removed state", () => {
    const state = pickDisplayState(
      { availability: null, totalTerritoryCount: 175 },
      null,
    );
    expect(state.primary).toBe("Remove from Sales");
    expect(state.removed).toBe(true);
  });

  it("Cycle 39 Phase 1 — flags removed when Apple returns availability with zero territories", () => {
    const state = pickDisplayState(
      {
        availability: {
          availableInNewTerritories: false,
          territoryCount: 0,
          territoryIds: [],
        },
        totalTerritoryCount: 175,
      },
      null,
    );
    expect(state.primary).toBe("Remove from Sales");
    expect(state.removed).toBe(true);
  });

  it("does NOT flag removed for healthy subset states", () => {
    const state = pickDisplayState(
      {
        availability: {
          availableInNewTerritories: false,
          territoryCount: 50,
          territoryIds: [],
        },
        totalTerritoryCount: 175,
      },
      null,
    );
    expect(state.removed).toBe(false);
  });

  it("surfaces 'Couldn't fetch availability' on a non-404 Apple error", () => {
    const state = pickDisplayState(null, "Apple boom");
    expect(state.primary).toBe("Couldn't fetch availability");
    expect(state.secondary).toBe("Apple boom");
    expect(state.removed).toBe(false);
  });

  it("falls back to a sensible denominator when the territories fetch failed (total=0)", () => {
    const state = pickDisplayState(
      {
        availability: {
          availableInNewTerritories: true,
          territoryCount: 42,
          territoryIds: [],
        },
        totalTerritoryCount: 0,
      },
      null,
    );
    expect(state.primary).toBe("42 of 42 countries or regions");
  });
});

describe("<IapAvailabilitiesSection />", () => {
  it("renders the all-territories headline", () => {
    render(
      <IapAvailabilitiesSection
        availabilityView={{
          availability: {
            availableInNewTerritories: true,
            territoryCount: 175,
            territoryIds: [],
          },
          totalTerritoryCount: 175,
        }}
        availabilityError={null}
      />,
    );
    expect(screen.getByText("All countries or regions")).toBeTruthy();
  });

  it("renders the subset count", () => {
    render(
      <IapAvailabilitiesSection
        availabilityView={{
          availability: {
            availableInNewTerritories: false,
            territoryCount: 73,
            territoryIds: [],
          },
          totalTerritoryCount: 175,
        }}
        availabilityError={null}
      />,
    );
    expect(screen.getByText("73 of 175 countries or regions")).toBeTruthy();
  });

  it("renders the Remove from Sales state with red emphasis", () => {
    render(
      <IapAvailabilitiesSection
        availabilityView={{ availability: null, totalTerritoryCount: 175 }}
        availabilityError={null}
      />,
    );
    const heading = screen.getByText("Remove from Sales");
    expect(heading).toBeTruthy();
    // Cycle 39 Phase 1 Unit A — red emphasis classes applied to the primary
    // text when the state surfaces as removed.
    expect(heading.className).toMatch(/text-red-/);
  });

  it("renders the error state with Apple's message", () => {
    render(
      <IapAvailabilitiesSection
        availabilityView={null}
        availabilityError="503 Service Unavailable"
      />,
    );
    expect(screen.getByText("Couldn't fetch availability")).toBeTruthy();
    expect(screen.getByText("503 Service Unavailable")).toBeTruthy();
  });
});
