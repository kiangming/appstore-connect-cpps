// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PricesTableExpandable } from "./PricesTableExpandable";
import type { PriceScheduleEntry } from "@/lib/iap-management/queries/iap-detail";

function entry(over: Partial<PriceScheduleEntry> = {}): PriceScheduleEntry {
  return {
    priceId: "p-1",
    startDate: null,
    endDate: null,
    territory: "USA",
    customerPrice: "0.99",
    currency: "USD",
    ...over,
  };
}

describe("PricesTableExpandable", () => {
  it("renders the summary 'Current Price' bucket by default", () => {
    render(
      <PricesTableExpandable
        entries={[
          entry({ priceId: "p-usa", territory: "USA" }),
          entry({ priceId: "p-vnm", territory: "VNM", customerPrice: "29000" }),
        ]}
        baseTerritory="USA"
      />,
    );
    expect(screen.getByText("Current Price")).toBeInTheDocument();
    expect(screen.getByText("2 Manual Prices + Auto-Equalized")).toBeInTheDocument();
  });

  it("adds a row per distinct future endDate in the summary", () => {
    render(
      <PricesTableExpandable
        entries={[
          entry({ priceId: "p-a" }),
          entry({ priceId: "p-b", endDate: "2026-05-28", territory: "VNM" }),
        ]}
        baseTerritory="USA"
      />,
    );
    expect(screen.getByText("Price Ending on 2026-05-28")).toBeInTheDocument();
  });

  it("toggles to the full per-territory view on 'Show all' click", () => {
    render(
      <PricesTableExpandable
        entries={[
          entry({ priceId: "p-usa", territory: "USA" }),
          entry({ priceId: "p-vnm", territory: "VNM", customerPrice: "29000", currency: "VND" }),
        ]}
        baseTerritory="USA"
      />,
    );
    fireEvent.click(screen.getByText(/show all 2 territories/i));
    // Now showing the full table
    expect(screen.getByText("United States (base)")).toBeInTheDocument();
    expect(screen.getByText("Vietnam")).toBeInTheDocument();
    expect(screen.getByText("29000 VND")).toBeInTheDocument();
    expect(screen.getByText(/show summary/i)).toBeInTheDocument();
  });

  it("disables the show-all button when there are no entries", () => {
    render(<PricesTableExpandable entries={[]} baseTerritory="USA" />);
    const btn = screen.getByText(/show all 0 territories/i);
    expect(btn).toBeDisabled();
  });

  it("uses singular grammar for one entry", () => {
    render(
      <PricesTableExpandable
        entries={[entry({ priceId: "p-usa" })]}
        baseTerritory="USA"
      />,
    );
    expect(screen.getByText("1 Manual Price + Auto-Equalized")).toBeInTheDocument();
    expect(screen.getByText(/show all 1 territory/i)).toBeInTheDocument();
  });
});
