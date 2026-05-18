// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { IapPriceScheduleSection } from "./IapPriceScheduleSection";
import type {
  PriceScheduleView,
  PriceScheduleEntry,
} from "@/lib/iap-management/queries/iap-detail";

function makeSchedule(
  entries: PriceScheduleEntry[] = [],
  baseTerritory = "USA",
): PriceScheduleView {
  return { baseTerritory, entries };
}

const NOW = new Date("2026-05-20T00:00:00.000Z");

describe("IapPriceScheduleSection", () => {
  it("renders the amber error notice when priceScheduleError is set", () => {
    render(
      <IapPriceScheduleSection
        priceSchedule={null}
        priceScheduleError="Apple 500: boom"
        now={NOW}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Apple 500: boom/)).toBeInTheDocument();
  });

  it("renders the empty placeholder when priceSchedule is null and no error", () => {
    render(
      <IapPriceScheduleSection
        priceSchedule={null}
        now={NOW}
      />,
    );
    expect(
      screen.getByText(/No pricing has been set on Apple yet\./),
    ).toBeInTheDocument();
  });

  it("renders the Base Country row from the priceSchedule entries", () => {
    render(
      <IapPriceScheduleSection
        priceSchedule={makeSchedule([
          {
            priceId: "p-1",
            startDate: null,
            endDate: null,
            territory: "USA",
            customerPrice: "0.99",
            currency: "USD",
          },
        ])}
        now={NOW}
      />,
    );
    expect(screen.getByText("United States")).toBeInTheDocument();
    // currency badge text appears as " (USD)" with a leading space — flexible match
    expect(screen.getByText((c) => c.includes("(USD)"))).toBeInTheDocument();
    expect(screen.getByText("0.99")).toBeInTheDocument();
  });

  it("partitions future-dated entries into Upcoming Changes", () => {
    render(
      <IapPriceScheduleSection
        priceSchedule={makeSchedule([
          {
            priceId: "p-now",
            startDate: null,
            endDate: null,
            territory: "USA",
            customerPrice: "0.99",
            currency: "USD",
          },
          {
            priceId: "p-future",
            startDate: "2026-06-01",
            endDate: null,
            territory: "VNM",
            customerPrice: "29000",
            currency: "VND",
          },
        ])}
        now={NOW}
      />,
    );
    // Upcoming entry appears in the Upcoming Changes table
    expect(screen.getByText("From 2026-06-01")).toBeInTheDocument();
    expect(screen.getByText("Vietnam (VNM)")).toBeInTheDocument();
    // Current shows 1 manual price (only USA)
    expect(
      screen.getByText("1 Manual Price + Auto-Equalized"),
    ).toBeInTheDocument();
  });

  it("renders 'No upcoming changes.' when none exist", () => {
    render(
      <IapPriceScheduleSection
        priceSchedule={makeSchedule([
          {
            priceId: "p-now",
            startDate: null,
            endDate: null,
            territory: "USA",
            customerPrice: "0.99",
            currency: "USD",
          },
        ])}
        now={NOW}
      />,
    );
    expect(screen.getByText("No upcoming changes.")).toBeInTheDocument();
  });

  it("renders inside an ExpandablePanel that defaults open", () => {
    render(
      <IapPriceScheduleSection
        priceSchedule={makeSchedule([])}
        now={NOW}
      />,
    );
    const toggle = screen.getByRole("button", { name: /in-app purchase pricing/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
