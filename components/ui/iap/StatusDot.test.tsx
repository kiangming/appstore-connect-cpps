// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusDot, statusToneForState, humanizeState } from "./StatusDot";

describe("StatusDot", () => {
  it("renders the dot with the tone-mapped colour class", () => {
    const { container } = render(<StatusDot tone="success" />);
    const dot = container.querySelector("span[aria-hidden]")!;
    expect(dot.className).toContain("bg-emerald-500");
  });

  it("renders the label next to the dot when provided", () => {
    const { getByText } = render(
      <StatusDot tone="warning" label="Missing Metadata" />,
    );
    expect(getByText("Missing Metadata")).toBeInTheDocument();
  });

  it("applies the size variant to the dot element", () => {
    const { container } = render(<StatusDot tone="info" size="md" />);
    const dot = container.querySelector("span[aria-hidden]")!;
    expect(dot.className).toContain("h-2.5");
    expect(dot.className).toContain("w-2.5");
  });
});

describe("statusToneForState — Q-D 5-colour palette", () => {
  it.each([
    ["READY_FOR_SALE", "success"],
    ["APPROVED", "success"],
    ["MISSING_METADATA", "warning"],
    ["PREPARE_FOR_SUBMISSION", "warning"],
    ["WAITING_FOR_REVIEW", "info"],
    ["IN_REVIEW", "info"],
    ["PENDING_APPLE_RELEASE", "info"],
    ["REJECTED", "error"],
    ["DEVELOPER_ACTION_NEEDED", "error"],
    ["READY_TO_SUBMIT", "neutral"],
    ["REMOVED_FROM_SALE", "neutral"],
  ])("maps %s → %s", (state, expected) => {
    expect(statusToneForState(state)).toBe(expected);
  });

  it("falls back to neutral for unknown states (no throw)", () => {
    expect(statusToneForState("WAT_IS_THIS")).toBe("neutral");
  });
});

describe("humanizeState", () => {
  it("converts SCREAMING_SNAKE → Title Case", () => {
    expect(humanizeState("MISSING_METADATA")).toBe("Missing Metadata");
    expect(humanizeState("PENDING_APPLE_RELEASE")).toBe("Pending Apple Release");
  });
});
