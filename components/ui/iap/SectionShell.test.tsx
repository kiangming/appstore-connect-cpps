// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionShell } from "./SectionShell";

describe("SectionShell", () => {
  it("renders the title and child content", () => {
    render(
      <SectionShell title="App Store Localization">
        <p>row content</p>
      </SectionShell>,
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "App Store Localization",
    );
    expect(screen.getByText("row content")).toBeInTheDocument();
  });

  it("renders the description line under the title", () => {
    render(
      <SectionShell
        title="Price Schedule"
        description="Below is a summary of your current pricing."
      >
        <span />
      </SectionShell>,
    );
    expect(
      screen.getByText("Below is a summary of your current pricing."),
    ).toBeInTheDocument();
  });

  it("renders the trailing slot (right-side link)", () => {
    render(
      <SectionShell
        title="Price Schedule"
        trailing={<a href="#">All Prices →</a>}
      >
        <span />
      </SectionShell>,
    );
    expect(screen.getByRole("link", { name: /all prices/i })).toBeInTheDocument();
  });
});
