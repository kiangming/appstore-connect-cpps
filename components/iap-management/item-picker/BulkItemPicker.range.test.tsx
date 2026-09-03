// @vitest-environment jsdom
/**
 * [Y1] Shift-click range selection AT THE SHARED LAYER, and the `paged` gate.
 *
 * ⚠ WHY THE GATE IS TESTED ON BOTH BRANCHES HERE AND NOT ONLY IN A CONSUMER.
 * `paged` defaulting to `false` is what keeps A′ (the availability WRITE
 * modal) unchanged — Q2. A default is a fact this component asserts, not a
 * habit it happens to have: flip it to `true` and
 * `"does nothing when the surface has not opted in"` goes red immediately,
 * without waiting for A′'s 5 test files to notice.
 *
 * ⚠ AND THE OFF BRANCH IS TESTED FOR AN ABSENCE. The only assertion that fails
 * when someone "just turns it on for everyone" is one that says the range did
 * NOT happen. A test that only exercises the on branch is green either way.
 *
 * The pure arithmetic lives in `item-range-select.test.ts`. This file is about
 * what the COMPONENT does with a real shift-click: which rows the range is
 * computed over, where the anchor comes from, and what is said when there is
 * no range to form.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { BulkItemPicker } from "./BulkItemPicker";
import type { BulkItemRow } from "@/lib/iap-management/apple/bulk-item-rows";

type Row = BulkItemRow & { appleIapId: string };

function row(id: string, productId: string, name: string): Row {
  return {
    key: id,
    appleIapId: id,
    internalId: `uuid-${id}`,
    productId,
    name,
    exclusion: null,
  };
}

/** Five rows in a KNOWN order. The range means "between", so order is the
 *  whole premise — pinned independently in `item-range-select.order.test.ts`. */
const ROWS: Row[] = [
  row("a", "com.x.a", "Alpha"),
  row("b", "com.x.b", "Bravo"),
  row("c", "com.x.c", "Charlie"),
  row("d", "com.x.d", "Delta"),
  row("e", "com.x.e", "Echo"),
];

interface Opts {
  paged?: boolean;
  windowSize?: number;
  query?: string;
  selected?: Set<string>;
  withHandler?: boolean;
  rows?: Row[];
}

function setup(opts: Opts = {}) {
  const {
    paged = true,
    windowSize = 60,
    query = "",
    selected = new Set<string>(),
    withHandler = true,
    rows: rowsIn = ROWS,
  } = opts;
  const onSelectRange = vi.fn();
  const onToggleOne = vi.fn();
  const view = render(
    <BulkItemPicker
      rows={rowsIn}
      selectableRows={rowsIn}
      excludedRows={[]}
      selected={selected}
      query={query}
      onQueryChange={vi.fn()}
      windowSize={windowSize}
      onShowMore={vi.fn()}
      onToggleOne={onToggleOne}
      onToggleAll={vi.fn()}
      paged={paged}
      onSelectRange={withHandler ? onSelectRange : undefined}
    />,
  );
  return { onSelectRange, onToggleOne, view };
}

const cb = (productId: string) =>
  screen.getByRole("checkbox", { name: `Select ${productId}` });

const plainClick = (productId: string) => fireEvent.click(cb(productId));
const shiftClick = (productId: string) =>
  fireEvent.click(cb(productId), { shiftKey: true });

// ─── the gate ──────────────────────────────────────────────────────────────

describe("the `paged` gate — Q2, A′ must not inherit this", () => {
  /**
   * ⚠ MUTATION: change the default to `paged = true` in BulkItemPicker, or
   * drop the `paged &&` guard in `handleRowToggle`. This goes red.
   */
  it("does nothing when the surface has not opted in — a shift-click is a plain tick", () => {
    const { onSelectRange, onToggleOne } = setup({ paged: false });
    plainClick("com.x.b");
    shiftClick("com.x.d");
    expect(onSelectRange).not.toHaveBeenCalled();
    expect(onToggleOne.mock.calls).toEqual([["b"], ["d"]]);
  });

  it("renders no hint at all when the surface has not opted in", () => {
    setup({ paged: false });
    expect(screen.queryByTestId("range-hint")).not.toBeInTheDocument();
    expect(screen.queryByTestId("range-hint-miss")).not.toBeInTheDocument();
  });

  it("⚠ DEFAULTS to off — an omitted prop must behave like A′, not like export", () => {
    const onSelectRange = vi.fn();
    const onToggleOne = vi.fn();
    render(
      <BulkItemPicker
        rows={ROWS}
        selectableRows={ROWS}
        excludedRows={[]}
        selected={new Set()}
        query=""
        onQueryChange={vi.fn()}
        windowSize={60}
        onShowMore={vi.fn()}
        onToggleOne={onToggleOne}
        onToggleAll={vi.fn()}
        /* paged deliberately NOT passed */
        onSelectRange={onSelectRange}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select com.x.b" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select com.x.d" }), {
      shiftKey: true,
    });
    expect(onSelectRange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("range-hint")).not.toBeInTheDocument();
  });

  it("is on for a surface that opts in", () => {
    const { onSelectRange } = setup({ paged: true });
    plainClick("com.x.b");
    shiftClick("com.x.d");
    expect(onSelectRange).toHaveBeenCalledWith(["b", "c", "d"]);
  });
});

// ─── the gesture ───────────────────────────────────────────────────────────

describe("the gesture — a plain click sets the anchor, Shift takes the range", () => {
  it("takes everything between the two clicks", () => {
    const { onSelectRange } = setup();
    plainClick("com.x.b");
    shiftClick("com.x.e");
    expect(onSelectRange).toHaveBeenCalledWith(["b", "c", "d", "e"]);
  });

  it("works upwards — anchor below the target", () => {
    const { onSelectRange } = setup();
    plainClick("com.x.d");
    shiftClick("com.x.a");
    expect(onSelectRange).toHaveBeenCalledWith(["a", "b", "c", "d"]);
  });

  /**
   * ⚠ MUTATION: move the anchor to the target after a successful range
   * (`setAnchorId(appleIapId)` before the `return`). This goes red — the
   * second range would become d→e instead of b→e.
   */
  it("keeps the anchor after a range, so a second Shift-click RE-AIMS it", () => {
    const { onSelectRange } = setup();
    plainClick("com.x.b");
    shiftClick("com.x.d");
    shiftClick("com.x.e");
    expect(onSelectRange.mock.calls).toEqual([
      [["b", "c", "d"]],
      [["b", "c", "d", "e"]],
    ]);
  });

  it("the range NEVER goes through onToggleOne — it is one additive apply", () => {
    const { onToggleOne } = setup();
    plainClick("com.x.b");
    onToggleOne.mockClear();
    shiftClick("com.x.e");
    expect(onToggleOne).not.toHaveBeenCalled();
  });
});

// ─── the boundary: the money test ──────────────────────────────────────────

describe("⚠ a range can never contain a row the Manager has not seen", () => {
  /**
   * The Y1 rendering boundary is the WINDOW; in Y2 it becomes the page. Same
   * assertion, same code path — the range is computed over the rendered rows
   * and nothing else.
   *
   * ⚠ MUTATION (Y1.3, the cross-boundary one): compute the range over
   * `matchingSelectable` instead of `windowed` in `handleRowToggle`. This goes
   * red — rows "c".."e" are not rendered, and the range would sweep them.
   */
  it("a range between two rendered rows contains exactly the rows between them", () => {
    const { onSelectRange, onToggleOne } = setup({ windowSize: 2 });
    // Only a + b are rendered.
    expect(screen.queryByRole("checkbox", { name: "Select com.x.c" })).toBeNull();
    plainClick("com.x.a");
    shiftClick("com.x.b");
    expect(onSelectRange).toHaveBeenCalledWith(["a", "b"]);
    expect(onToggleOne).toHaveBeenCalledTimes(1); // the anchor click only
  });

  /**
   * ⚠ THE TEST THAT GIVES THE PREVIOUS ONE ITS TEETH, and it took a mutation
   * that stayed GREEN to find it.
   *
   * In Y1 the rendered set is a PREFIX (`slice(0, windowSize)`), so two rows
   * that are both clickable have the same index in `windowed` and in
   * `matchingSelectable` — computing the range over either one gives the same
   * answer, and the mutation "use the full matching list" is invisible. It is
   * only when the anchor is OUTSIDE the rendered set that the two disagree,
   * and Y1 can reach that state for real: the window SHRINKS back to
   * `ROW_WINDOW_STEP` whenever the query changes
   * (ExportItemWizard.tsx:459-462), so a row ticked after "Show more" can stop
   * being rendered while still being the anchor.
   *
   * ⚠ MUTATION: `resolveRangeIds(matchingSelectable, …)` instead of
   * `resolveRangeIds(windowed, …)`. With the mutation the range becomes
   * b..d — sweeping "c" and "d", which are NOT ON SCREEN, into an export that
   * bills ~3 Apple requests each. This test goes red; the one above does not.
   */
  it("⚠ an anchor OUTSIDE the rendered rows sweeps nothing — not one unseen row", () => {
    const { onSelectRange, onToggleOne, view } = setup({ windowSize: 60 });
    plainClick("com.x.d"); // anchor at index 3, rendered right now
    onToggleOne.mockClear();
    // The window shrinks — exactly what a query change does to it.
    view.rerender(
      <BulkItemPicker
        rows={ROWS}
        selectableRows={ROWS}
        excludedRows={[]}
        selected={new Set(["d"])}
        query=""
        onQueryChange={vi.fn()}
        windowSize={2}
        onShowMore={vi.fn()}
        onToggleOne={onToggleOne}
        onToggleAll={vi.fn()}
        paged
        onSelectRange={onSelectRange}
      />,
    );
    expect(screen.queryByRole("checkbox", { name: "Select com.x.d" })).toBeNull();
    shiftClick("com.x.b");
    expect(onSelectRange).not.toHaveBeenCalled();
    expect(onToggleOne).toHaveBeenCalledWith("b");
    expect(screen.getByTestId("range-hint-miss")).toBeInTheDocument();
  });

  /**
   * ⚠ MUTATION (Y1.3, the surviving-anchor one): make the anchor an INDEX, or
   * resolve it against the unfiltered list. This goes red: "a" is a real row
   * of the app, it is simply not on screen once the search narrows.
   */
  it("an anchor the SEARCH has hidden does not resolve — plain tick + the miss hint", () => {
    const { onSelectRange, onToggleOne, view } = setup();
    plainClick("com.x.a"); // anchor on a row that is about to be hidden
    // Re-render with a query that excludes the anchor, as the caller would.
    view.rerender(
      <BulkItemPicker
        rows={ROWS}
        selectableRows={ROWS}
        excludedRows={[]}
        selected={new Set(["a"])}
        query="delta"
        onQueryChange={vi.fn()}
        windowSize={60}
        onShowMore={vi.fn()}
        onToggleOne={onToggleOne}
        onToggleAll={vi.fn()}
        paged
        onSelectRange={onSelectRange}
      />,
    );
    expect(screen.queryByRole("checkbox", { name: "Select com.x.a" })).toBeNull();
    shiftClick("com.x.d");
    expect(onSelectRange).not.toHaveBeenCalled();
    expect(screen.getByTestId("range-hint-miss")).toBeInTheDocument();
  });

  /**
   * ⚠ M5, AND THE STRONG FORM OF IT. `mid` sits BETWEEN the two matching rows
   * in the underlying list, and the search hides it. A range that swept the
   * list rather than the rendered rows would pick it up — a row that is not
   * merely off-screen but explicitly filtered out, added to a 3-request-per-
   * item export with nothing on screen saying so.
   *
   * ⚠ MUTATION: compute over `selectableRows` (or `matchingSelectable` before
   * the window) instead of `windowed`. This goes red with `mid` in the range.
   */
  it("a row the SEARCH hides, sitting BETWEEN two matches, is not swept in", () => {
    const INTERLEAVED: Row[] = [
      row("a", "com.x.a", "Alpha"),
      row("g1", "com.pack.1", "Gem Pack 1"),
      row("mid", "com.other.mid", "Middle"),
      row("g2", "com.pack.2", "Gem Pack 2"),
      row("e", "com.x.e", "Echo"),
    ];
    const { onSelectRange } = setup({ rows: INTERLEAVED, query: "pack" });
    expect(
      screen.queryByRole("checkbox", { name: "Select com.other.mid" }),
    ).toBeNull();
    plainClick("com.pack.1");
    shiftClick("com.pack.2");
    expect(onSelectRange).toHaveBeenCalledWith(["g1", "g2"]);
  });
});

// ─── the hint: Y1.2, never a silent degrade ────────────────────────────────

describe("the hint — Y1.2: a Shift-click that formed no range is ANSWERED", () => {
  it("shows the baseline tip as soon as the surface opts in — the gesture has no control of its own", () => {
    setup();
    expect(screen.getByTestId("range-hint")).toBeInTheDocument();
  });

  /**
   * ⚠ MUTATION: delete `setRangeMiss(true)` from the no-range branch. This
   * goes red — and that mutation is exactly "silently degrade to a plain
   * tick", which is the defect Y1.2 names.
   */
  it("a Shift-click with no anchor at all ticks the row and shows the MISS hint", () => {
    const { onSelectRange, onToggleOne } = setup();
    shiftClick("com.x.d"); // nothing clicked plainly yet
    expect(onSelectRange).not.toHaveBeenCalled();
    expect(onToggleOne).toHaveBeenCalledWith("d");
    expect(screen.getByTestId("range-hint-miss")).toBeInTheDocument();
    expect(screen.queryByTestId("range-hint")).not.toBeInTheDocument();
  });

  it("the miss hint clears on the next plain click — it is a response, not a banner", () => {
    setup();
    shiftClick("com.x.d");
    expect(screen.getByTestId("range-hint-miss")).toBeInTheDocument();
    plainClick("com.x.b");
    expect(screen.queryByTestId("range-hint-miss")).not.toBeInTheDocument();
    expect(screen.getByTestId("range-hint")).toBeInTheDocument();
  });

  /**
   * ⚠ THE PROP COMBINATION THAT MUST NOT BE SILENT. `paged` on with no
   * handler is a wiring mistake; it degrades to a plain tick AND says so,
   * rather than swallowing the gesture.
   */
  it("paged on but no handler wired — plain tick plus the miss hint, never silence", () => {
    const { onToggleOne } = setup({ withHandler: false });
    plainClick("com.x.b");
    shiftClick("com.x.d");
    expect(onToggleOne.mock.calls).toEqual([["b"], ["d"]]);
    expect(screen.getByTestId("range-hint-miss")).toBeInTheDocument();
  });
});
