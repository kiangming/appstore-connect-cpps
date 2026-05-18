// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionErrorBoundary } from "./SectionErrorBoundary";

function Boom(): JSX.Element {
  throw new Error("section blew up");
}

describe("SectionErrorBoundary", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Silence React's own console.error noise + the boundary's debug log.
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it("renders children when no error is thrown", () => {
    render(
      <SectionErrorBoundary label="header">
        <p>healthy child</p>
      </SectionErrorBoundary>,
    );
    expect(screen.getByText("healthy child")).toBeInTheDocument();
  });

  it("catches a thrown render error and surfaces the amber notice", () => {
    render(
      <SectionErrorBoundary label="price schedule">
        <Boom />
      </SectionErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByText(/Couldn't render the price schedule section/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/section blew up/)).toBeInTheDocument();
  });
});
