// @vitest-environment jsdom

/**
 * X2 — the export scope dialog: the counts it shows, and the disclosure it
 * is obliged to carry.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ExportScopeDialog } from "./ExportScopeDialog";

/**
 * ⚠ X3 — the fixture grew from `{ status }` to whole rows. The dialog now
 * renders a per-item list, so it needs the fields that list shows (sku,
 * title). The counts and the disclosure assertions below are UNCHANGED in
 * meaning; only the shape they read from is fuller.
 */
function iap(sku: string, status: string | null, title: string | null = null) {
  return {
    id: `id-${sku}`,
    app_id: "app-1",
    sku,
    purchase_type: "managed",
    status,
    default_currency: "USD",
    default_price_micros: "1990000",
    last_synced_at: null,
    deleted_on_google_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    default_title: title,
  } as unknown as Parameters<typeof ExportScopeDialog>[0]["items"][number];
}

const ITEMS = [
  iap("a1", "active", "Alpha"),
  iap("a2", "active", "Beta"),
  iap("a3", "active", "Gamma"),
  iap("i1", "inactive", "Delta"),
  iap("u1", null, "Epsilon"),
];

const ALL_SKUS = new Set(ITEMS.map((i) => i.sku));

function renderDialog(over: Partial<Parameters<typeof ExportScopeDialog>[0]> = {}) {
  const props = {
    open: true,
    items: ITEMS,
    value: "all" as const,
    onChange: vi.fn(),
    onCancel: vi.fn(),
    onNext: vi.fn(),
    selected: ALL_SKUS as ReadonlySet<string>,
    onToggleSku: vi.fn(),
    onToggleAll: vi.fn(),
    query: "",
    onQueryChange: vi.fn(),
    windowSize: 50,
    onShowMore: vi.fn(),
    ...over,
  };
  render(<ExportScopeDialog {...props} />);
  return props;
}

describe("ExportScopeDialog — visibility", () => {
  it("renders nothing when closed", () => {
    renderDialog({ open: false });
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

  it("⚠ X3 — the Next button counts SELECTED items in scope, not just matching ones", () => {
    // Before X3 this read the filter's match count. Now the checkboxes can
    // narrow further, so the button has to report what will actually be
    // exported — a button promising 3 while 1 is ticked is the silent-drop
    // shape this arc keeps removing.
    renderDialog({ value: "active" });
    expect(
      screen.getByRole("button", { name: "Next — choose countries (3)" }),
    ).toBeInTheDocument();
  });

  it("deselecting narrows the Next count without touching the filter", () => {
    renderDialog({ value: "active", selected: new Set(["a1"]) });
    expect(
      screen.getByRole("button", { name: "Next — choose countries (1)" }),
    ).toBeInTheDocument();
  });

  it("⚠ Next is DISABLED at zero — never silently widened to `all`", () => {
    // The route answers `[]` with a 400. Letting the operator through would
    // trade a clear stop for a confusing server error; widening it to
    // everything would export a file they did not ask for.
    renderDialog({ value: "active", selected: new Set<string>() });
    const btn = screen.getByRole("button", { name: "Select at least 1 item" });
    expect(btn).toBeDisabled();
  });

  it("Next is disabled when the filter itself matches nothing", () => {
    renderDialog({ items: [iap("i1", "inactive")], value: "active" });
    expect(
      screen.getByRole("button", { name: "Select at least 1 item" }),
    ).toBeDisabled();
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
