/**
 * Shift-click range selection for the item picker. PURE.
 *
 * Design: docs/iap-management/design-export-picker-paging-range.md §2.6, Q3.
 *
 * ─── THE ONE INVARIANT THIS MODULE EXISTS TO ENFORCE ───────────────────────
 *
 * ⚠ A RANGE CAN NEVER CONTAIN A ROW THE MANAGER HAS NOT SEEN.
 *
 * `resolveRangeIds` is handed the **rendered** rows and nothing else. It has
 * no access to the full list, so a range that reaches past what is on screen
 * is not "guarded against" — it is unrepresentable. That matters because the
 * alternative (compute over `matchingSelectable`, then clamp) is one forgotten
 * clamp away from selecting rows nobody looked at, and at ~3 Apple requests
 * per item that is a bill for work the Manager did not ask for.
 *
 * This is why the anchor is an **id, resolved by lookup**, and not an index.
 * An index into "the rows" goes stale the moment the search, a facet, the
 * window or (from Y2) the page changes, and a stale index still points at
 * *something* — silently the wrong row. A missing id resolves to `null`, and
 * `null` is a state the caller has to handle out loud.
 *
 * ⇒ TWO GUARANTEES, DELIBERATELY NOT ONE:
 *     1. The caller CLEARS the anchor at a boundary (the spec, Q-Y1.2).
 *     2. This module returns `null` when the anchor is not rendered (the
 *        invariant, which holds even if 1 is forgotten).
 *   They are not the same rule written twice: (1) is about the anchor not
 *   lingering, (2) is about what a range may contain. (2) is the one the
 *   mutation test breaks, because it is the one that costs money.
 *
 * ─── ADDITIVE, NEVER TOGGLING (Q3) ────────────────────────────────────────
 *
 * `addRangeToSelection` only ever adds. Reference behaviour is Gmail's
 * checkbox list, NOT Finder/Explorer: those two **replace** the whole
 * selection on shift-click, which M1 (cumulative selection) disqualifies
 * outright — a range on page 2 would wipe page 1.
 *
 * ⚠ AND NOT "TOGGLE EACH ROW IN THE RANGE" EITHER. Toggling makes the result
 * depend on the prior state of rows in the MIDDLE of the range, which the
 * Manager may never have looked at: the same gesture yields different
 * outcomes for reasons that are off-screen. On Apple an unpredictable
 * *un*-tick is a row silently missing from the workbook — the silent-drop
 * class. Additive is idempotent: shift-click twice, same result.
 *
 * ⚠ The accepted cost, stated: a range cannot be undone with a second
 * shift-click. The undo is the page checkbox's "Clear N on this page" (Y2).
 */

/** The minimum a row needs to take part in a range: an id to key on. */
export interface RangeSelectableRow {
  appleIapId: string;
}

/**
 * The ids from `anchorId` to `targetId` inclusive, **as they appear in
 * `renderedRows`** — the array the picker is actually displaying, already
 * narrowed by facets, then the search, then the window/page.
 *
 * Returns `null` — not `[]` — when no range can be formed:
 *   • `anchorId` is null (nothing has been clicked plainly yet), or
 *   • the anchor is not among the rendered rows (it is on another page, or the
 *     search/facets have hidden it), or
 *   • the target is not among the rendered rows (cannot happen from a real
 *     click; asserted anyway so a future caller cannot smuggle one in).
 *
 * ⚠ `null` vs `[]` is load-bearing. `[]` reads as "a range with nothing in
 * it", which a caller would apply as a no-op and show nothing. `null` means
 * "there is no range here", which is a thing the Manager must be TOLD —
 * Y1.2's rule is a plain tick PLUS a hint, never a silent degrade.
 */
export function resolveRangeIds(
  renderedRows: readonly RangeSelectableRow[],
  anchorId: string | null,
  targetId: string,
): string[] | null {
  if (anchorId === null) return null;
  const anchorIndex = renderedRows.findIndex((r) => r.appleIapId === anchorId);
  if (anchorIndex === -1) return null;
  const targetIndex = renderedRows.findIndex((r) => r.appleIapId === targetId);
  if (targetIndex === -1) return null;
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  return renderedRows.slice(from, to + 1).map((r) => r.appleIapId);
}

/**
 * Add every id in the range to the selection. Nothing is ever removed, so a
 * row already ticked inside the range stays ticked and picks outside the
 * range — including on other pages (M1) — are untouched.
 */
export function addRangeToSelection(
  selected: ReadonlySet<string>,
  rangeIds: readonly string[],
): Set<string> {
  const next = new Set(selected);
  for (const id of rangeIds) next.add(id);
  return next;
}
