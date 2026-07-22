// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExpandableErrorCell } from "./ExpandableErrorCell";

describe("ExpandableErrorCell", () => {
  it("shows the collapsed summary and no Detail button when detail is absent", () => {
    render(<ExpandableErrorCell summary="apple_iap_id 6775742430…" />);
    expect(screen.getByText("apple_iap_id 6775742430…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows no Detail button when detail is an empty string", () => {
    render(<ExpandableErrorCell summary="—" detail="" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a Detail button when detail is present, collapsed by default", () => {
    render(
      <ExpandableErrorCell
        summary="apple-create 409 — This name is already being used."
        detail='{"errors":[{"detail":"This name is already being used."}]}'
      />,
    );
    const button = screen.getByRole("button", { name: "Detail" });
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("expands to the full pretty-printed JSON on Detail click, and Close collapses it", () => {
    const detail = '{"errors":[{"detail":"This name is already being used.","code":"ENTITY_ERROR"}]}';
    render(<ExpandableErrorCell summary="apple-create 409 — This name is already being used." detail={detail} />);

    fireEvent.click(screen.getByRole("button", { name: "Detail" }));

    const expanded = screen.getByRole("button", { name: "Close" });
    expect(expanded).toHaveAttribute("aria-expanded", "true");
    // Pretty-printed (indented) JSON — not the raw minified string.
    expect(screen.getByText(/"detail": "This name is already being used\."/)).toBeInTheDocument();

    fireEvent.click(expanded);
    expect(screen.getByRole("button", { name: "Detail" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/"detail":/)).toBeNull();
  });

  it("renders non-JSON detail as raw text when expanded (network error / timeout fallback)", () => {
    render(
      <ExpandableErrorCell
        summary="apple-create: fetch failed"
        detail="TypeError: fetch failed"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Detail" }));
    expect(screen.getByText("TypeError: fetch failed")).toBeInTheDocument();
  });

  it("multiple instances expand independently", () => {
    render(
      <>
        <ExpandableErrorCell summary="Row A summary" detail='{"errors":[{"detail":"A"}]}' />
        <ExpandableErrorCell summary="Row B summary" detail='{"errors":[{"detail":"B"}]}' />
      </>,
    );
    const [detailA, detailB] = screen.getAllByRole("button", { name: "Detail" });
    fireEvent.click(detailA);

    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Detail" })).toBe(detailB);
  });
});
