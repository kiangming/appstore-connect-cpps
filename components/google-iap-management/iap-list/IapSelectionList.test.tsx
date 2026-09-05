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

  it("renders every row, and no pager", () => {
    renderList();
    expect(screen.getAllByRole("checkbox")).toHaveLength(ITEMS.length + 1); // +select-all
    expect(screen.queryByTestId("page-nav")).not.toBeInTheDocument();
  });

  it("keeps the existing select-all copy and the selected counter", () => {
    renderList({ selected: new Set(["gem.small"]) });
    expect(screen.getByText("Select all (3)")).toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });
});

describe("⚠ guarantee 1 — `Select all` means every MATCHING item, not the window", () => {
  it("hands back every matching SKU — the un-paged modal path, unchanged", () => {
    // THE DEFECT THIS PREVENTS: scoping select-all to the rendered rows hands
    // back a subset under a label that says "all". This is the write path's
    // shape (no `paged`), so it must keep going through `onToggleAll`.
    const props = renderList();
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
/** 45 rows — three pages at size 20, a single page at the default 50. */
const MANY = Array.from({ length: 45 }, (_, i) =>
  iap(`sku.${String(i).padStart(2, "0")}`, `Item ${i}`),
);

/** The paged picker as the export dialog wires it. */
function renderPaged(over: Partial<Parameters<typeof IapSelectionList>[0]> = {}) {
  return renderList({ paged: true, rangeSelect: true, ...over });
}

/** Drive the real Rows control rather than reaching into state — page size is
 *  owned by the component, so the control IS the only way in, and exercising
 *  it keeps these tests honest about what the operator can actually do. */
function setRows(n: number) {
  fireEvent.change(screen.getByLabelText("Rows per page"), {
    target: { value: String(n) },
  });
}

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
  it("⭐ a range cannot contain a row another PAGE is hiding", () => {
    // Page size 20 over 45 rows: page 1 is rows 00–19. Even though rows 20–44
    // match, no gesture available on screen can pull them into a range.
    const onSelectionChange = vi.fn();
    renderPaged({ items: MANY, onSelectionChange });
    setRows(20);
    plainClick("sku.00");
    shiftClick("sku.19");
    const applied = [...onSelectionChange.mock.calls.at(-1)![0]];
    expect(applied).toHaveLength(20);
    expect(applied).not.toContain("sku.20");
    expect(applied).not.toContain("sku.44");
  });

  it("⭐ the anchor does NOT survive a window change — plain tick + a hint instead", () => {
    // THE MUTATION THIS FAILS: keeping the anchor across the boundary. M8 says
    // a boundary drops it; here that is re-derived from the page and page size
    // the anchor was set under, not watched with an effect hook.
    //
    // ⚠ Same instance throughout — the page is flipped with the real Next
    // button. Re-mounting would reset the anchor for a reason that has nothing
    // to do with the boundary, and the test would pass while proving nothing.
    const onSelectionChange = vi.fn();
    const onToggleOne = vi.fn();
    renderPaged({ items: MANY, onSelectionChange, onToggleOne });
    setRows(20);
    plainClick("sku.00"); // anchor set on page 1
    onSelectionChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Next/ })); // page 2
    shiftClick("sku.25");

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onToggleOne).toHaveBeenLastCalledWith("sku.25");
    expect(screen.getByTestId("range-hint")).toBeInTheDocument();
  });

  it("the anchor DOES survive within the same window — the boundary rule is not a blanket reset", () => {
    // The counter-test to the one above: if the anchor were dropped on every
    // render the feature would never work at all, and the boundary test would
    // still be green. Both directions, or neither is proven.
    const onSelectionChange = vi.fn();
    renderPaged({ items: MANY, onSelectionChange });
    setRows(20);
    plainClick("sku.00");
    onSelectionChange.mockClear();
    shiftClick("sku.03"); // same page, same size ⇒ anchor still valid
    expect([...onSelectionChange.mock.calls[0][0]]).toEqual([
      "sku.00",
      "sku.01",
      "sku.02",
      "sku.03",
    ]);
  });

  it("⭐⭐ changing PAGE SIZE drops the anchor even though it is STILL ON SCREEN", () => {
    // ⚠ THIS TEST EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT.
    //
    // Deleting the anchor's boundary check entirely left the suite green: with
    // the anchor on page 1 and the shift-click on page 2, `resolveRangeSkus`
    // already refuses, because the anchor is not among the rendered rows —
    // the helper's guarantee (2), which holds even when (1) is forgotten.
    //
    // The gap that mutation exposed is the case where the TWO GUARANTEES
    // DISAGREE: keep the anchor on screen and change only the page SIZE.
    // Row 00 is rendered at size 20 AND at size 30, so (2) has nothing to
    // object to — only the anchor's own stamp knows the boundary moved. This
    // is the one gesture that proves rule (1) is real and not decoration.
    const onSelectionChange = vi.fn();
    const onToggleOne = vi.fn();
    renderPaged({ items: MANY, onSelectionChange, onToggleOne });
    setRows(20);
    plainClick("sku.00"); // anchor stamped at page 1 / size 20
    onSelectionChange.mockClear();

    setRows(30); // M9 keeps us on page 1, so sku.00 is still rendered…
    expect(screen.getByLabelText("Select sku.00")).toBeInTheDocument();

    shiftClick("sku.05"); // …but the boundary moved, so no range may form.
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onToggleOne).toHaveBeenLastCalledWith("sku.05");
    expect(screen.getByTestId("range-hint")).toBeInTheDocument();
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
    renderPaged({
      items: MANY,
      selected: new Set(["sku.00", "sku.30", "sku.44"]),
    });
    setRows(20);
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    expect(screen.getByTestId("tier-on-screen")).toHaveTextContent(
      "1 of 20 on this page",
    );
  });

  it("names the picks the WINDOW is hiding", () => {
    renderPaged({
      items: MANY,
      selected: new Set(["sku.00", "sku.30", "sku.44"]),
    });
    setRows(20);
    expect(screen.getByTestId("hidden-by-page")).toHaveTextContent(
      /2 selected items are not on this page/,
    );
  });

  it("⭐ the two hide-reasons are DISJOINT — search-hidden + window-hidden = total off-screen", () => {
    // Items a,b (match "a"/"b"? no) — use the query to hide e.five, and the
    // window to hide c/d. Each line must count its OWN cause only, so a reader
    // can add them and land on the total.
    renderPaged({
      items: MANY,
      query: "sku.",
      onQueryChange: vi.fn(), // matches all 45
      selected: new Set(["sku.00", "sku.30", "sku.44"]),
    });
    setRows(20);
    // All 45 match, so nothing is search-hidden…
    expect(screen.queryByText(/hidden by the current search/)).not.toBeInTheDocument();
    // …and the page hides two of the three picks.
    expect(screen.getByTestId("hidden-by-page")).toHaveTextContent(
      /2 selected items are not on this page/,
    );
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("no window-hidden line when every pick is on screen", () => {
    renderList({
      items: FIVE,
      rangeSelect: true,
      selected: new Set(["a.one"]),
    });
    expect(screen.queryByTestId("hidden-by-page")).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CHUNK 2 — paging, the tri-state header, and "Selected only".
// ═══════════════════════════════════════════════════════════════════════════

describe("⚠ C2 — `paged` DEFAULTS OFF; the write path keeps the flat list", () => {
  it("⭐ without the flag there is no pager, no toolbar button, no view switch", () => {
    // THE MUTATION THIS FAILS: flipping the default to `true`, which would put
    // a pager into Bulk Activate/Deactivate — a shipped WRITE surface — with
    // nobody deciding to.
    renderList({ items: MANY });
    expect(screen.queryByTestId("page-nav")).not.toBeInTheDocument();
    expect(screen.queryByTestId("select-all-matching")).not.toBeInTheDocument();
    expect(screen.queryByTestId("view-selected")).not.toBeInTheDocument();
    // …and every one of the 45 rows renders.
    expect(screen.getAllByRole("checkbox")).toHaveLength(MANY.length + 1);
  });

  it("⭐ without the flag the header checkbox is still ALL-MATCHING via onToggleAll", () => {
    // The modal's contract: one checkbox, whole-list scope, through the old
    // callback. Chunk 2 must not re-point it at a page that does not exist.
    const onToggleAll = vi.fn();
    renderList({ items: MANY, onToggleAll });
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(onToggleAll).toHaveBeenCalledTimes(1);
    expect(onToggleAll.mock.calls[0][0]).toHaveLength(45);
  });
});

describe("⚠ C4 — Rows selector: 20/30/50, default 50, and the single-page case", () => {
  it("⭐ defaults to 50 — 45 items is therefore ONE page", () => {
    renderPaged({ items: MANY });
    expect(screen.getByLabelText("Rows per page")).toHaveValue("50");
    expect(screen.getByText(/Showing 1–45 of 45/)).toBeInTheDocument();
  });

  it("⭐ a single page shows NO Prev/Next — but the Rows selector stays reachable", () => {
    // C4's explicit requirement. `PageNav` hides only the prev/next cluster,
    // so the bar itself survives to carry the selector.
    renderPaged({ items: MANY });
    expect(screen.getByTestId("page-nav")).toBeInTheDocument();
    expect(screen.getByLabelText("Rows per page")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Prev/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Next/ })).not.toBeInTheDocument();
  });

  it("⭐ on a single page the two counter tiers AGREE (total = on this page)", () => {
    renderPaged({ items: MANY, selected: new Set(["sku.00", "sku.44"]) });
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByTestId("tier-on-screen")).toHaveTextContent(
      "2 of 45 on this page",
    );
    expect(screen.queryByTestId("hidden-by-page")).not.toBeInTheDocument();
  });

  it("offers exactly 20 / 30 / 50", () => {
    renderPaged({ items: MANY });
    expect(
      [...screen.getByLabelText("Rows per page").querySelectorAll("option")].map(
        (o) => o.textContent,
      ),
    ).toEqual(["20", "30", "50"]);
  });

  it("dropping to 20 splits 45 rows into three pages", () => {
    renderPaged({ items: MANY });
    setRows(20);
    expect(screen.getByTestId("page-nav-position")).toHaveTextContent("Page 1 of 3");
  });
});

describe("⚠ M9 — changing the page size ANCHORS THE VIEWPORT", () => {
  it("⭐ does NOT reset to page 1", () => {
    // THE MUTATION THIS FAILS: `setPage(1)` on a size change. Rows 40–44 are
    // on page 3 at size 20; at size 30 they sit on page 2 — floor(40/30)+1.
    renderPaged({ items: MANY });
    setRows(20);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByTestId("page-nav-position")).toHaveTextContent("Page 3 of 3");
    setRows(30);
    expect(screen.getByTestId("page-nav-position")).toHaveTextContent("Page 2 of 2");
    expect(screen.getByText(/Showing 31–45 of 45/)).toBeInTheDocument();
  });

  it("keeps the operator looking at the rows they were looking at", () => {
    renderPaged({ items: MANY });
    setRows(20);
    fireEvent.click(screen.getByRole("button", { name: /Next/ })); // rows 20–39
    setRows(30);
    // floor(20/30)+1 = 1 ⇒ rows 1–30, which still contains row 20.
    expect(screen.getByLabelText("Select sku.20")).toBeInTheDocument();
  });
});

describe("⚠ C1/M7 — (A) the toolbar button vs (B) the header checkbox", () => {
  it("⭐ (B) the header checkbox scopes to THIS PAGE, not the whole list", () => {
    // THE MUTATION THIS FAILS: pointing (B) at the matching set. The label
    // says "on this page"; a control that quietly means more than its label is
    // the whole defect this split exists to prevent.
    const onSelectionChange = vi.fn();
    renderPaged({ items: MANY, onSelectionChange });
    setRows(20);
    fireEvent.click(screen.getByLabelText("Select all on this page"));
    expect([...onSelectionChange.mock.calls[0][0]]).toHaveLength(20);
  });

  it("⭐ (A) the toolbar button scopes to EVERYTHING MATCHING, not the page", () => {
    // THE MUTATION THIS FAILS: scoping (A) to the current page — 20 rows under
    // a label that reads "Select all 45 matching".
    const onSelectionChange = vi.fn();
    renderPaged({ items: MANY, onSelectionChange });
    setRows(20);
    fireEvent.click(screen.getByTestId("select-all-matching"));
    expect([...onSelectionChange.mock.calls[0][0]]).toHaveLength(45);
  });

  it("⭐⛔ (B) FULL ⇒ CLEARS THE PAGE — the deliberate divergence from Apple", () => {
    // ⛔ DO NOT "fix for consistency with Apple". Apple's never-clear rule is
    // built on a picker that opens EMPTY; Google opens with everything ticked
    // (IapListClient.tsx:199-202), so clearing is the operator's FIRST move.
    // Porting Apple's rule here deletes the most useful gesture on the surface.
    const onSelectionChange = vi.fn();
    renderPaged({
      items: MANY,
      selected: new Set(MANY.map((i) => i.sku)), // G1: everything ticked
      onSelectionChange,
    });
    setRows(20);
    expect(screen.getByLabelText("Select all on this page")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Select all on this page"));
    const next = onSelectionChange.mock.calls[0][0];
    expect(next.size).toBe(25); // 45 − the 20 on this page
    expect(next.has("sku.00")).toBe(false);
    expect(next.has("sku.20")).toBe(true); // page 2 untouched
  });

  it("⭐ (B) PARTIAL ⇒ fills the page, never clears", () => {
    const onSelectionChange = vi.fn();
    renderPaged({
      items: MANY,
      selected: new Set(["sku.00"]),
      onSelectionChange,
    });
    setRows(20);
    fireEvent.click(screen.getByLabelText("Select all on this page"));
    expect(onSelectionChange.mock.calls[0][0].size).toBe(20);
  });

  it("(B) is indeterminate when the page is partly ticked", () => {
    renderPaged({ items: MANY, selected: new Set(["sku.00"]) });
    setRows(20);
    expect(
      (screen.getByLabelText("Select all on this page") as HTMLInputElement)
        .indeterminate,
    ).toBe(true);
  });

  it("(A) flips its label to Clear when everything matching is ticked", () => {
    renderPaged({ items: MANY, selected: new Set(MANY.map((i) => i.sku)) });
    expect(screen.getByTestId("select-all-matching")).toHaveTextContent(
      "Clear all 45",
    );
  });
});

describe("⚠ C5 — Selected only", () => {
  it("⭐ shows only the ticked rows, and pages THEM", () => {
    renderPaged({
      items: MANY,
      selected: new Set(["sku.00", "sku.30", "sku.44"]),
    });
    fireEvent.click(screen.getByTestId("view-selected"));
    expect(screen.getByText(/Showing 1–3 of 3 selected/)).toBeInTheDocument();
    expect(screen.getByLabelText("Select sku.30")).toBeInTheDocument();
    expect(screen.queryByLabelText("Select sku.01")).not.toBeInTheDocument();
  });

  it("⭐ the header checkbox reads checked + Clear there — NO special case", () => {
    // C5 says it explicitly: in this view every rendered row is by definition
    // selected, so the ordinary tri-state rule already produces checked+Clear.
    // Special-casing it would be a second rule doing the first rule's job.
    renderPaged({ items: MANY, selected: new Set(["sku.00", "sku.30"]) });
    fireEvent.click(screen.getByTestId("view-selected"));
    expect(screen.getByLabelText("Select all on this page")).toBeChecked();
    expect(screen.getByText("Clear 2 on this page")).toBeInTheDocument();
  });

  it("⭐⛔ (A) IS NOT RENDERED at all under 'Selected only'", () => {
    // ⚠ ASSERTS ABSENCE, ON PURPOSE. A test shaped "the label matches what is
    // on screen" would stay GREEN if someone switched to option γ — making
    // (A) follow the view — because γ also produces a label that matches. Only
    // "there is no such control" distinguishes β from γ.
    //
    // ⛔ γ is the move a future reader will reach for. It breaks M7: (A)'s
    // scope must be readable from its POSITION, not from which view is on.
    renderPaged({ items: MANY, selected: new Set(["sku.00", "sku.30"]) });
    expect(screen.getByTestId("select-all-matching")).toBeInTheDocument(); // All
    fireEvent.click(screen.getByTestId("view-selected"));
    expect(screen.queryByTestId("select-all-matching")).not.toBeInTheDocument();
  });

  it("⭐ (A) comes back — with the ALL-MATCHING count — on returning to All", () => {
    // The other half: hiding it must be scoped to the view, not a one-way
    // door, and its scope must be unchanged when it returns.
    renderPaged({ items: MANY, selected: new Set(["sku.00", "sku.30"]) });
    fireEvent.click(screen.getByTestId("view-selected"));
    fireEvent.click(screen.getByTestId("view-all"));
    expect(screen.getByTestId("select-all-matching")).toHaveTextContent(
      "Select all 45 matching",
    );
  });

  it("⭐ under a search, (A) still counts MATCHING — not the page, not the view", () => {
    // Guards the count that (A) reports while it IS visible: status ∩ search.
    renderPaged({ items: MANY, query: "sku.1", onQueryChange: vi.fn() });
    expect(screen.getByTestId("select-all-matching")).toHaveTextContent(
      "Select all 10 matching", // sku.10 … sku.19
    );
  });

  it("the switch names how many are selected", () => {
    renderPaged({ items: MANY, selected: new Set(["sku.00", "sku.30"]) });
    expect(screen.getByTestId("view-selected")).toHaveTextContent("Selected (2)");
  });
});
