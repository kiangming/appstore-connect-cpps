// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UpcomingChangesTable } from "./UpcomingChangesTable";
import type { PriceScheduleEntry } from "@/lib/iap-management/queries/iap-detail";

function entry(over: Partial<PriceScheduleEntry> = {}): PriceScheduleEntry {
  return {
    priceId: "p-future",
    startDate: "2026-05-28",
    endDate: null,
    territory: "USA",
    customerPrice: "0.99",
    currency: "USD",
    ...over,
  };
}

describe("UpcomingChangesTable", () => {
  it("renders one row per upcoming entry with territory name + price", () => {
    render(
      <UpcomingChangesTable
        entries={[entry({ territory: "VNM", customerPrice: "29000", currency: "VND" })]}
      />,
    );
    expect(screen.getByText("From 2026-05-28")).toBeInTheDocument();
    expect(screen.getByText("Vietnam (VNM)")).toBeInTheDocument();
    expect(screen.getByText("29000 VND")).toBeInTheDocument();
  });

  it("shows the Q-C placeholder when there are no upcoming changes", () => {
    render(<UpcomingChangesTable entries={[]} />);
    expect(screen.getByText("No upcoming changes.")).toBeInTheDocument();
  });

  it("disables the download CSV control in v1", () => {
    render(<UpcomingChangesTable entries={[]} />);
    const downloadBtn = screen.getByLabelText(/download upcoming changes/i);
    expect(downloadBtn).toBeDisabled();
  });
});
