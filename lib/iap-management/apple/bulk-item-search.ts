/**
 * In-modal search + the selection arithmetic that goes with it. PURE.
 *
 * Design: docs/iap-management/design-set-availabilities-item-list.md §4.2/§4.4.
 *
 * ⚠ WHY THE COUNTS ARE A MODULE AND NOT THREE `.filter().length` CALLS INLINE.
 * Once the list is searched AND windowed, "select all" has three plausible
 * meanings and two of them are wrong:
 *
 *   • everything rendered right now   ← WRONG. Silently under-selects; the
 *                                       Manager sees "Select all", gets 60 of
 *                                       500, and nothing says so.
 *   • everything in the app           ← WRONG. Ignores the search they just
 *                                       typed to narrow the batch.
 *   • everything matching the search  ← CORRECT, and the only one that keeps
 *                                       the label honest at any window size.
 *
 * This is the same failure class as the silent drop: a control whose label
 * overstates what it did. Design PART 3 rejected paginating the pre-read partly
 * for this reason, so the render fix must not reintroduce it.
 *
 * ⚠ AND THE SELECTION SURVIVES THE SEARCH BOX. Typing a new query must not
 * silently discard items already ticked — but it does hide them, so the count
 * of hidden-but-selected is computed here and shown. A number the Manager can
 * see is the difference between "the tool kept my selection" and "the tool did
 * something I cannot account for".
 */

import type { BulkItemRow } from "./bulk-item-rows";

/** Rows rendered before the "show more" step. Chosen so a 1,000-item app
 *  mounts ~60 controlled checkboxes instead of 1,000 — the search box is the
 *  primary tool for getting to a workable set, this is the safety net. */
export const ROW_WINDOW_STEP = 60;

/** Case-insensitive substring over the two fields the Manager actually reads.
 *  ⚠ Not a regex: the query is user input, and this module must never become a
 *  place where a stray `(` throws. */
export function matchesQuery(row: BulkItemRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    row.productId.toLowerCase().includes(q) ||
    row.name.toLowerCase().includes(q)
  );
}

export function filterRowsByQuery<T extends BulkItemRow>(
  rows: readonly T[],
  query: string,
): T[] {
  const q = query.trim();
  if (!q) return [...rows];
  return rows.filter((r) => matchesQuery(r, q));
}

export interface SelectionCounts {
  /** Selectable rows matching the current search — what "Select all" takes. */
  matching: number;
  /** Selected AND matching — the ticked boxes currently on screen. */
  selectedMatching: number;
  /**
   * Selected but NOT matching the current search: still in the batch, still
   * going to be written, just not visible right now.
   *
   * ⚠ This number existing is the whole point. Without it a Manager who
   * narrows the search sees the count drop and concludes the tool lost their
   * selection.
   */
  selectedHidden: number;
  /** Every row in the app, selectable or not — the denominator that stops
   *  "12 of 38" from reading as "12 of everything". */
  total: number;
}

export function selectionCounts(args: {
  selectableRows: readonly BulkItemRow[];
  totalRows: number;
  selected: ReadonlySet<string>;
  query: string;
}): SelectionCounts {
  const { selectableRows, totalRows, selected, query } = args;
  let matching = 0;
  let selectedMatching = 0;
  let selectedAny = 0;
  for (const r of selectableRows) {
    const id = r.appleIapId;
    if (id === null) continue;
    const isSel = selected.has(id);
    if (isSel) selectedAny += 1;
    if (matchesQuery(r, query)) {
      matching += 1;
      if (isSel) selectedMatching += 1;
    }
  }
  return {
    matching,
    selectedMatching,
    selectedHidden: selectedAny - selectedMatching,
    total: totalRows,
  };
}

/**
 * What "Select all" toggles TO, given the current search.
 *
 * ⚠ Scoped to the matching set on both directions: ticking adds every match
 * without disturbing selections the search is hiding, and un-ticking removes
 * only the matches — so a Manager cannot silently wipe an off-screen selection
 * with one click on a narrowed list.
 */
export function toggleAllForQuery(args: {
  selectableRows: readonly BulkItemRow[];
  selected: ReadonlySet<string>;
  query: string;
}): Set<string> {
  const { selectableRows, selected, query } = args;
  const matchIds = selectableRows
    .filter((r) => r.appleIapId !== null && matchesQuery(r, query))
    .map((r) => r.appleIapId as string);
  const allOn = matchIds.length > 0 && matchIds.every((id) => selected.has(id));
  const next = new Set(selected);
  if (allOn) for (const id of matchIds) next.delete(id);
  else for (const id of matchIds) next.add(id);
  return next;
}
