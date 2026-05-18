// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExpandablePanel } from "./ExpandablePanel";

describe("ExpandablePanel", () => {
  it("hides children by default and reveals them after click", () => {
    render(
      <ExpandablePanel title="In-App Purchase Pricing">
        <p>Pricing details</p>
      </ExpandablePanel>,
    );
    expect(screen.queryByText("Pricing details")).toBeNull();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("Pricing details")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });

  it("respects defaultOpen=true", () => {
    render(
      <ExpandablePanel title="Pricing" defaultOpen>
        <p>Open by default</p>
      </ExpandablePanel>,
    );
    expect(screen.getByText("Open by default")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });
});
