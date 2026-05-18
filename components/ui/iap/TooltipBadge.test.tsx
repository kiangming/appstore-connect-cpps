// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipBadge } from "./TooltipBadge";

describe("TooltipBadge", () => {
  it("renders the tooltip copy in the hover popover", () => {
    render(<TooltipBadge tip="A unique alphanumeric ID" />);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "A unique alphanumeric ID",
    );
  });

  it("mirrors the tip into aria-label for screen readers", () => {
    const { container } = render(<TooltipBadge tip="Apple's internal ID" />);
    const badge = container.firstElementChild!;
    expect(badge.getAttribute("aria-label")).toBe("Apple's internal ID");
  });
});
