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

// ═══════════════════════════════════════════════════════════════════════════
// CHUNK 1 — shift-click ranges + the two-tier counter.
// ═══════════════════════════════════════════════════════════════════════════

const FIVE = [
  iap("a.one", "Alpha"),
  iap("b.two", "Bravo"),
  iap("c.three", "Charlie"),
  iap("d.four", "Delta"),
  iap("e.five", "Echo"),
];

/** Tick a row the way a mouse does: a change event whose NATIVE event carries
 *  `shiftKey`. React's synthetic change event does not have it, so this is
 *  also the measurement that reading `nativeEvent` is the right call. */
function shiftClick(sku: string) {
  fireEvent.click(screen.getByLabelText(`Select ${sku}`), { shiftKey: true });
}
function plainClick(sku: string) {
  fireEvent.click(screen.getByLabelText(`Select ${sku}`));
}

describe("⚠ C2 — `rangeSelect` DEFAULTS OFF, and the write path depends on it", () => {
  it("⭐ WITHOUT the flag, a shift-click is a PLAIN tick — no range, no merged set", () => {
    // THE MUTATION THIS FAILS: flipping the default to `true`. The gate has to
    // live HERE, at the shared tier — `BulkStatusModal`'s own 77-ish tests
    // stayed green under exactly this mutation on the Apple side, because a
    // consumer's suite cannot guard a gesture it never performs.
    const props = renderList({ items: FIVE, onSelectionChange: vi.fn() });
    plainClick("a.one");
    shiftClick("c.three");
    expect(props.onSelectionChange).not.toHaveBeenCalled();
    expect(props.onToggleOne).toHaveBeenNthCalledWith(1, "a.one");
    expect(props.onToggleOne).toHaveBeenNthCalledWith(2, "c.three");
  });

  it("⭐ WITH the flag, the same gesture forms a range", () => {
    // The other half of the both-branches gate: an optional prop that is never
    // exercised in its ON state is dead code with a test rubber-stamping it.
    const onSelectionChange = vi.fn();
    renderList({ items: FIVE, rangeSelect: true, onSelectionChange });
    plainClick("a.one");
    shiftClick("c.three");
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect([...onSelectionChange.mock.calls[0][0]]).toEqual([
      "a.one",
      "b.two",
      "c.three",
    ]);
  });

  it("without the flag there is no two-tier counter either", () => {
    renderList({ items: FIVE, selected: new Set(["a.one"]) });
    expect(screen.queryByTestId("tier-on-screen")).not.toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });
});

describe("⚠ shift-click is ADDITIVE across the window (M1/M8)", () => {
  it("⭐ keeps picks made OUTSIDE the range — a range must never replace", () => {
    // THE MUTATION THIS FAILS: `addRangeToSelection` replacing instead of
    // merging (Finder/Explorer semantics), which would wipe every pick the
    // window is currently hiding.
    const onSelectionChange = vi.fn();
    renderList({
      items: FIVE,
      rangeSelect: true,
      selected: new Set(["e.five"]),
      onSelectionChange,
    });
    plainClick("a.one");
    shiftClick("b.two");
    expect([...onSelectionChange.mock.calls[0][0]].sort()).toEqual([
      "a.one",
      "b.two",
      "e.five",
    ]);
  });

  it("the anchor does not chain — a second shift-click re-aims from the same anchor", () => {
    const onSelectionChange = vi.fn();
    renderList({ items: FIVE, rangeSelect: true, onSelectionChange });
    plainClick("a.one");
    shiftClick("b.two");
    shiftClick("d.four");
    expect([...onSelectionChange.mock.calls[1][0]]).toEqual([
      "a.one",
      "b.two",
      "c.three",
      "d.four",
    ]);
  });

  it("works backwards — shift-click above the anchor", () => {
    const onSelectionChange = vi.fn();
    renderList({ items: FIVE, rangeSelect: true, onSelectionChange });
    plainClick("d.four");
    shiftClick("b.two");
    expect([...onSelectionChange.mock.calls[0][0]]).toEqual([
      "b.two",
      "c.three",
      "d.four",
    ]);
  });
});

describe("⚠ M8 — the range never leaves the RENDERED rows, and the boundary drops the anchor", () => {
  it("⭐ a range cannot contain a row the window is hiding", () => {
    // windowSize 3 renders a/b/c only. Even though d and e MATCH, no gesture
    // available on screen can pull them into a range.
    const onSelectionChange = vi.fn();
    renderList({
      items: FIVE,
      windowSize: 3,
      onShowMore: vi.fn(),
      rangeSelect: true,
      onSelectionChange,
    });
    plainClick("a.one");
    shiftClick("c.three");
    const applied = [...onSelectionChange.mock.calls[0][0]];
    expect(applied).toEqual(["a.one", "b.two", "c.three"]);
    expect(applied).not.toContain("d.four");
    expect(applied).not.toContain("e.five");
  });

  it("⭐ the anchor does NOT survive a window change — plain tick + a hint instead", () => {
    // THE MUTATION THIS FAILS: keeping the anchor across the boundary. M8 says
    // a boundary drops it; here that is re-derived from the `windowSize` the
    // anchor was set under, not watched with an effect.
    //
    // ⚠ `rerender` on the SAME instance, not a second `render`. A second
    // render mounts a second component with fresh state, so the anchor would
    // be absent for a reason that has nothing to do with the boundary — the
    // test would pass while proving nothing.
    const onSelectionChange = vi.fn();
    const onToggleOne = vi.fn();
    const base = {
      items: FIVE,
      selected: new Set<string>() as ReadonlySet<string>,
      onToggleAll: vi.fn(),
      onShowMore: vi.fn(),
      rangeSelect: true,
      onSelectionChange,
      onToggleOne,
    };
    const { rerender } = render(
      <IapSelectionList {...base} windowSize={3} />,
    );
    plainClick("a.one"); // anchor set at windowSize 3
    expect(onToggleOne).toHaveBeenCalledWith("a.one");

    // Same instance, wider window — the boundary the anchor was set under is
    // gone, so the anchor must be gone with it.
    rerender(<IapSelectionList {...base} windowSize={5} />);
    shiftClick("c.three");

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onToggleOne).toHaveBeenLastCalledWith("c.three");
    expect(screen.getByTestId("range-hint")).toBeInTheDocument();
  });

  it("the anchor DOES survive within the same window — the boundary rule is not a blanket reset", () => {
    // The counter-test to the one above: if the anchor were dropped on every
    // render the feature would never work at all, and the boundary test would
    // still be green. Both directions, or neither is proven.
    const onSelectionChange = vi.fn();
    const base = {
      items: FIVE,
      selected: new Set<string>() as ReadonlySet<string>,
      onToggleOne: vi.fn(),
      onToggleAll: vi.fn(),
      onShowMore: vi.fn(),
      rangeSelect: true,
      onSelectionChange,
    };
    const { rerender } = render(
      <IapSelectionList {...base} windowSize={5} />,
    );
    plainClick("a.one");
    rerender(<IapSelectionList {...base} windowSize={5} />);
    shiftClick("c.three");
    expect([...onSelectionChange.mock.calls[0][0]]).toEqual([
      "a.one",
      "b.two",
      "c.three",
    ]);
  });

  it("⭐ a shift-click with no usable anchor ticks plainly AND SAYS SO", () => {
    // M8: never a silent degrade. The hint is the difference between "the tool
    // ignored my modifier" and "the tool told me why".
    const props = renderList({
      items: FIVE,
      rangeSelect: true,
      onSelectionChange: vi.fn(),
    });
    shiftClick("c.three"); // no prior plain tick ⇒ no anchor
    expect(props.onSelectionChange).not.toHaveBeenCalled();
    expect(props.onToggleOne).toHaveBeenCalledWith("c.three");
    expect(screen.getByTestId("range-hint")).toBeInTheDocument();
  });

  it("the hint clears once a range succeeds", () => {
    renderList({ items: FIVE, rangeSelect: true, onSelectionChange: vi.fn() });
    shiftClick("b.two");
    expect(screen.getByTestId("range-hint")).toBeInTheDocument();
    shiftClick("d.four"); // b.two became the anchor, so this one forms
    expect(screen.queryByTestId("range-hint")).not.toBeInTheDocument();
  });
});

describe("⚠ C3 — the counter has TWO tiers and they are allowed to disagree", () => {
  it("⭐ total and on-screen are reported SEPARATELY when they differ", () => {
    // THE MUTATION THIS FAILS: collapsing the two tiers into one number. With
    // Google's tick-everything default the two routinely disagree, and one
    // number cannot be both without lying about one of them.
    renderList({
      items: FIVE,
      windowSize: 2,
      onShowMore: vi.fn(),
      rangeSelect: true,
      selected: new Set(["a.one", "d.four", "e.five"]),
    });
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    expect(screen.getByTestId("tier-on-screen")).toHaveTextContent("1 of 2 shown");
  });

  it("names the picks the WINDOW is hiding", () => {
    renderList({
      items: FIVE,
      windowSize: 2,
      onShowMore: vi.fn(),
      rangeSelect: true,
      selected: new Set(["a.one", "d.four", "e.five"]),
    });
    expect(screen.getByTestId("hidden-by-window")).toHaveTextContent(
      /2 selected items are not shown yet/,
    );
  });

  it("⭐ the two hide-reasons are DISJOINT — search-hidden + window-hidden = total off-screen", () => {
    // Items a,b (match "a"/"b"? no) — use the query to hide e.five, and the
    // window to hide c/d. Each line must count its OWN cause only, so a reader
    // can add them and land on the total.
    renderList({
      items: FIVE,
      query: ".",
      onQueryChange: vi.fn(), // matches all five (every sku has a dot)
      windowSize: 2,
      onShowMore: vi.fn(),
      rangeSelect: true,
      selected: new Set(["a.one", "c.three", "e.five"]),
    });
    // All five match, so nothing is search-hidden…
    expect(screen.queryByText(/hidden by the current search/)).not.toBeInTheDocument();
    // …and the window hides two of the three picks.
    expect(screen.getByTestId("hidden-by-window")).toHaveTextContent(
      /2 selected items are not shown yet/,
    );
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("no window-hidden line when every pick is on screen", () => {
    renderList({
      items: FIVE,
      rangeSelect: true,
      selected: new Set(["a.one"]),
    });
    expect(screen.queryByTestId("hidden-by-window")).not.toBeInTheDocument();
  });
});
