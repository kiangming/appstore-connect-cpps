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
  basePrice: PriceScheduleEntry | null = null,
): PriceScheduleView {
  return { baseTerritory, basePrice, entries };
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

  it("renders the Base Country row from priceSchedule.basePrice (IAP.p2.k Stage 3)", () => {
    // IAP.p2.k: base price comes from Stage 3 (automaticPrices filtered by
    // base territory), NOT from manualPrices entries — Apple stores base
    // separately. Pre-p2.k fell back to current[0] which surfaced the wrong
    // price (HK's $23 as the "United States" base).
    render(
      <IapPriceScheduleSection
        priceSchedule={makeSchedule(
          [],
          "USA",
          {
            priceId: "p-base",
            startDate: null,
            endDate: null,
            territory: "USA",
            customerPrice: "0.99",
            currency: "USD",
          },
        )}
        now={NOW}
      />,
    );
    expect(screen.getByText("United States")).toBeInTheDocument();
    expect(screen.getByText((c) => c.includes("(USD)"))).toBeInTheDocument();
    expect(screen.getByText("0.99")).toBeInTheDocument();
  });

  it("renders the Base Country territory name even when basePrice is null (Stage 3 fail)", () => {
    // Stage 3 is best-effort — when it fails or returns no row, still
    // surface the territory name so Manager sees the base location.
    render(
      <IapPriceScheduleSection
        priceSchedule={makeSchedule([], "USA", null)}
        now={NOW}
      />,
    );
    expect(screen.getByText("United States")).toBeInTheDocument();
    // No currency badge and no price block rendered.
    expect(
      screen.queryByText((c) => c.includes("(USD)")),
    ).not.toBeInTheDocument();
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
