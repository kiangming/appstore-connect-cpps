// @vitest-environment jsdom
/**
 * ⚠ THIS FILE EXISTS BECAUSE OF A GAP THE EXTRACTION EXPOSED, not to
 * re-cover what already works.
 *
 * The parity gate for this extraction is the modal's own 53 tests, and they
 * hold three of the picker's four search-related behaviours: they go red if
 * "Select all" narrows to the rendered window, if the hidden-selection notice
 * disappears, or if the window stops disclosing what it is not showing.
 *
 * A fourth mutation — **the excluded tail stops respecting the search** —
 * left all 53 green. That behaviour was unpinned in the modal, and the
 * extraction has just moved it into a component the export wizard will also
 * render, which is precisely when an unpinned shared behaviour starts to
 * matter (P1). So it is pinned here, at the shared layer, rather than in
 * either consumer.
 *
 * The second test covers the same seam from the other side: `renderExcluded`
 * receives rows ALREADY narrowed, so a caller that filters again is
 * double-filtering and a caller that does not is correct. That contract has
 * to be observable or the next consumer will guess.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { BulkItemPicker } from "./BulkItemPicker";
import type {
  BulkItemRow,
  ExcludedRow,
} from "@/lib/iap-management/apple/bulk-item-rows";

function selectable(id: string, productId: string, name: string): BulkItemRow & {
  appleIapId: string;
} {
  return {
    key: id,
    appleIapId: id,
    internalId: `uuid-${id}`,
    productId,
    name,
    exclusion: null,
  };
}

function excluded(id: string, productId: string, name: string): ExcludedRow {
  return {
    key: id,
    appleIapId: id,
    internalId: null,
    productId,
    name,
    exclusion: { kind: "not_linked", reason: `${productId} is out` },
  };
}

const SELECTABLE = [
  selectable("s1", "com.example.gems", "Gem Pack"),
  selectable("s2", "com.example.coins", "Coin Pack"),
];
const EXCLUDED = [
  excluded("x1", "com.example.gems.legacy", "Legacy Gems"),
  excluded("x2", "com.example.coins.legacy", "Legacy Coins"),
];

function renderPicker(query: string) {
  const renderExcluded = vi.fn((rows: ExcludedRow[]) => (
    <ul data-testid="excluded">
      {rows.map((r) => (
        <li key={r.key}>{r.exclusion.reason}</li>
      ))}
    </ul>
  ));

  render(
    <BulkItemPicker
      rows={[...SELECTABLE, ...EXCLUDED]}
      selectableRows={SELECTABLE}
      excludedRows={EXCLUDED}
      selected={new Set()}
      query={query}
      onQueryChange={vi.fn()}
      windowSize={60}
      onShowMore={vi.fn()}
      onToggleOne={vi.fn()}
      onToggleAll={vi.fn()}
      renderExcluded={renderExcluded}
    />,
  );
  return renderExcluded;
}

describe("the excluded tail respects the search", () => {
  it("narrows with the query — an excluded row that does not match is not listed", () => {
    renderPicker("gems");

    expect(screen.getByText("com.example.gems.legacy is out")).toBeTruthy();
    expect(screen.queryByText("com.example.coins.legacy is out")).toBeNull();
  });

  it("disappears entirely when no excluded row matches — not rendered empty", () => {
    // ⚠ An empty excluded section is not the same as no excluded section: the
    // heading alone tells the Manager rows were dropped when none were.
    renderPicker("nothing-matches-this");

    expect(screen.queryByTestId("excluded")).toBeNull();
  });

  it("lists every excluded row when the search is empty", () => {
    renderPicker("");

    expect(screen.getByText("com.example.gems.legacy is out")).toBeTruthy();
    expect(screen.getByText("com.example.coins.legacy is out")).toBeTruthy();
  });
});

describe("renderExcluded's contract", () => {
  it("receives rows ALREADY narrowed by the search — the caller must not re-filter", () => {
    const renderExcluded = renderPicker("coins");

    expect(renderExcluded).toHaveBeenCalledTimes(1);
    const passed = renderExcluded.mock.calls[0][0];
    expect(passed.map((r) => r.key)).toEqual(["x2"]);
  });

  it("is not called at all when nothing is excluded", () => {
    const renderExcluded = vi.fn(() => <div data-testid="excluded" />);
    render(
      <BulkItemPicker
        rows={SELECTABLE}
        selectableRows={SELECTABLE}
        excludedRows={[]}
        selected={new Set()}
        query=""
        onQueryChange={vi.fn()}
        windowSize={60}
        onShowMore={vi.fn()}
        onToggleOne={vi.fn()}
        onToggleAll={vi.fn()}
        renderExcluded={renderExcluded}
      />,
    );

    expect(renderExcluded).not.toHaveBeenCalled();
  });

  it("still renders the excluded tail when NOTHING is selectable", () => {
    // ⚠ The "nothing selectable" slot replaces the LIST, never the reasons.
    // Swallowing the tail there is the silent drop with an extra step: the
    // Manager is told the picker is empty and not why.
    render(
      <BulkItemPicker
        rows={EXCLUDED}
        selectableRows={[]}
        excludedRows={EXCLUDED}
        selected={new Set()}
        query=""
        onQueryChange={vi.fn()}
        windowSize={60}
        onShowMore={vi.fn()}
        onToggleOne={vi.fn()}
        onToggleAll={vi.fn()}
        nothingSelectableSlot={<p data-testid="nothing">Nothing to pick</p>}
        renderExcluded={(rows) => (
          <ul data-testid="excluded">
            {rows.map((r) => (
              <li key={r.key}>{r.exclusion.reason}</li>
            ))}
          </ul>
        )}
      />,
    );

    expect(screen.getByTestId("nothing")).toBeTruthy();
    expect(screen.getByTestId("excluded")).toBeTruthy();
    expect(screen.getByText("com.example.gems.legacy is out")).toBeTruthy();
  });
});
