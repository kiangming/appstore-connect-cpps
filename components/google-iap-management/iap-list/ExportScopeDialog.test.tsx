// @vitest-environment jsdom

/**
 * X2 — the export scope dialog: the counts it shows, and the disclosure it
 * is obliged to carry.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ExportScopeDialog } from "./ExportScopeDialog";

const ITEMS = [
  { status: "active" },
  { status: "active" },
  { status: "active" },
  { status: "inactive" },
  { status: null },
];

function renderDialog(over: Partial<Parameters<typeof ExportScopeDialog>[0]> = {}) {
  const props = {
    open: true,
    items: ITEMS,
    value: "all" as const,
    onChange: vi.fn(),
    onCancel: vi.fn(),
    onNext: vi.fn(),
    ...over,
  };
  render(<ExportScopeDialog {...props} />);
  return props;
}

describe("ExportScopeDialog — visibility", () => {
  it("renders nothing when closed", () => {
    render(
      <ExportScopeDialog
        open={false}
        items={ITEMS}
        value="all"
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    expect(screen.queryByText("Export list — items to include")).not.toBeInTheDocument();
  });
});

describe("ExportScopeDialog — counts come from the props, priced before committing", () => {
  it("shows all / active / inactive counts, with unknown status counted inactive", () => {
    renderDialog();
    const group = screen.getByRole("radiogroup", { name: "Item status" });
    expect(group).toHaveTextContent("All items");
    // 5 total, 3 active, 2 inactive (one of them the null-status item).
    expect(group.textContent).toMatch(/All items\s*5/);
    expect(group.textContent).toMatch(/Active only\s*3/);
    expect(group.textContent).toMatch(/Inactive only\s*2/);
  });

  it("the Next button carries the count for the SELECTED filter", () => {
    renderDialog({ value: "active" });
    expect(
      screen.getByRole("button", { name: "Next — choose countries (3)" }),
    ).toBeInTheDocument();
  });

  it("Next is disabled, and says why, when the filter matches nothing", () => {
    renderDialog({ items: [{ status: "inactive" }], value: "active" });
    const btn = screen.getByRole("button", { name: "No items match" });
    expect(btn).toBeDisabled();
  });
});

describe("⚠ the disclosure — the label must not just say `Active`", () => {
  it("renders INACTIVE_PUBLISHED on screen, not only in a source comment", () => {
    // ⚠ THE MUTATION THIS EXISTS FOR. `mapStateToStatus` folds Google's
    // INACTIVE_PUBLISHED into the tool's "active"; a control labelled plainly
    // "Active only" is then making a claim about Google that the tool does not
    // keep. A comment in the source cannot warn an operator.
    renderDialog();
    expect(screen.getByText(/INACTIVE_PUBLISHED/)).toBeInTheDocument();
  });

  it("also states that Inactive is everything else, not a second Google state", () => {
    renderDialog();
    expect(screen.getByText(/everything else/)).toBeInTheDocument();
  });

  it("warns that the counts are from the last Refresh, not live", () => {
    // The other half of X2.4: the dialog must not present cached counts as if
    // they were Google's current answer.
    renderDialog();
    expect(screen.getByText(/last synced/)).toBeInTheDocument();
    expect(screen.getByText(/the file follows Google/)).toBeInTheDocument();
  });
});

describe("ExportScopeDialog — wiring", () => {
  it("picking an option reports it upward; the dialog owns no filter state", () => {
    const props = renderDialog({ value: "all" });
    fireEvent.click(screen.getByRole("radio", { name: /Inactive only/ }));
    expect(props.onChange).toHaveBeenCalledWith("inactive");
  });

  it("Next advances to the country step; Cancel backs out", () => {
    const props = renderDialog({ value: "active" });
    fireEvent.click(screen.getByRole("button", { name: /Next — choose countries/ }));
    expect(props.onNext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});
