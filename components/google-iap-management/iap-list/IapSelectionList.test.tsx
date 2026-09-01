// @vitest-environment jsdom

/**
 * X3/T1 — the shared selection list: the three guarantees, and the fact that
 * omitting the opt-in props reproduces `BulkStatusModal`'s previous markup.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { IapSelectionList } from "./IapSelectionList";

type Item = Parameters<typeof IapSelectionList>[0]["items"][number];

function iap(sku: string, title: string | null, status = "active"): Item {
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
  } as unknown as Item;
}

const ITEMS = [
  iap("gem.small", "Small gems"),
  iap("gem.medium", "Medium gems"),
  iap("starter.pack", "Starter pack"),
];

function renderList(over: Partial<Parameters<typeof IapSelectionList>[0]> = {}) {
  const props = {
    items: ITEMS,
    selected: new Set<string>() as ReadonlySet<string>,
    onToggleOne: vi.fn(),
    onToggleAll: vi.fn(),
    ...over,
  };
  render(<IapSelectionList {...props} />);
  return props;
}

describe("without the opt-in props — the BulkStatusModal shape, unchanged", () => {
  it("renders no search box", () => {
    renderList();
    expect(screen.queryByLabelText("Search items")).not.toBeInTheDocument();
  });

  it("renders every row, with no `Show more`", () => {
    renderList();
    expect(screen.getAllByRole("checkbox")).toHaveLength(ITEMS.length + 1); // +select-all
    expect(screen.queryByText(/Show more/)).not.toBeInTheDocument();
  });

  it("keeps the existing select-all copy and the selected counter", () => {
    renderList({ selected: new Set(["gem.small"]) });
    expect(screen.getByText("Select all (3)")).toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });
});

describe("⚠ guarantee 1 — `Select all` means every MATCHING item, not the window", () => {
  it("hands back every matching SKU even when the window shows fewer", () => {
    // THE DEFECT THIS PREVENTS: scoping select-all to the rendered window
    // hands back 2 of 3 under a label that says "all".
    const props = renderList({ windowSize: 2, onShowMore: vi.fn() });
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(props.onToggleAll).toHaveBeenCalledWith([
      "gem.small",
      "gem.medium",
      "starter.pack",
    ]);
  });

  it("narrows to the search results, not to the whole app", () => {
    const props = renderList({ query: "gem", onQueryChange: vi.fn() });
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(props.onToggleAll).toHaveBeenCalledWith(["gem.small", "gem.medium"]);
  });

  it("the checkbox reads checked only when every MATCHING item is selected", () => {
    // Selected items outside the query must not make the box look complete.
    renderList({
      query: "gem",
      onQueryChange: vi.fn(),
      selected: new Set(["gem.small", "gem.medium"]),
    });
    expect(screen.getByLabelText("Select all")).toBeChecked();
  });
});

describe("⚠ guarantee 2 — the window announces itself and says rows are still included", () => {
  it("`Show more` names how many are hidden AND that they are not excluded", () => {
    renderList({ windowSize: 1, onShowMore: vi.fn() });
    const btn = screen.getByRole("button", { name: /Show more/ });
    expect(btn).toHaveTextContent("2 more");
    // A silent truncation is indistinguishable from a shorter list; this
    // sentence is what makes the difference visible.
    expect(btn).toHaveTextContent(/still\s+included in the export/);
  });

  it("no `Show more` when nothing is hidden", () => {
    renderList({ windowSize: 99, onShowMore: vi.fn() });
    expect(screen.queryByText(/Show more/)).not.toBeInTheDocument();
  });

  it("clicking it asks the caller to widen — the list owns no window state", () => {
    const props = renderList({ windowSize: 1, onShowMore: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
    expect(props.onShowMore).toHaveBeenCalledTimes(1);
  });
});

describe("⚠ guarantee 3 — a selection hidden by the search is still counted", () => {
  it("says how many picks the current query is hiding", () => {
    // Without this line the count appears to drop when the query narrows and
    // the operator concludes the tool lost their picks.
    renderList({
      query: "gem",
      onQueryChange: vi.fn(),
      selected: new Set(["gem.small", "starter.pack"]),
    });
    expect(screen.getByText(/1 selected item is hidden by the current search/))
      .toBeInTheDocument();
    // …and the headline total still counts both.
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("no such line when the query hides nothing", () => {
    renderList({
      query: "gem",
      onQueryChange: vi.fn(),
      selected: new Set(["gem.small"]),
    });
    expect(screen.queryByText(/hidden by the current search/)).not.toBeInTheDocument();
  });
});

describe("search behaviour", () => {
  it("matches on SKU and on title", () => {
    renderList({ query: "Starter", onQueryChange: vi.fn() });
    expect(screen.getByLabelText("Select starter.pack")).toBeInTheDocument();
    expect(screen.queryByLabelText("Select gem.small")).not.toBeInTheDocument();
  });

  it("says so when nothing matches, rather than rendering an empty box", () => {
    renderList({ query: "zzz", onQueryChange: vi.fn() });
    expect(screen.getByText(/No items match/)).toBeInTheDocument();
  });
});

describe("row wiring", () => {
  it("ticking a row reports its SKU upward", () => {
    const props = renderList();
    fireEvent.click(screen.getByLabelText("Select gem.medium"));
    expect(props.onToggleOne).toHaveBeenCalledWith("gem.medium");
  });

  it("renders the caller's trailing slot, not a shared status string", () => {
    renderList({ renderTrailing: (i) => <span>badge:{i.sku}</span> });
    expect(screen.getByText("badge:gem.small")).toBeInTheDocument();
  });

  it("an item with no title shows the placeholder, not an empty row", () => {
    renderList({ items: [iap("no.title", null)] });
    expect(screen.getByText("— no title —")).toBeInTheDocument();
  });
});
