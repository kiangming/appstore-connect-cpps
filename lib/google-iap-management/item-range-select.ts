/**
 * Shift-click range selection for the Google export picker. PURE.
 *
 * Design: docs/google-iap-management/design-export-picker-paging.md (M8).
 *
 * ─── THE ONE INVARIANT THIS MODULE EXISTS TO ENFORCE ───────────────────────
 *
 * ⚠ A RANGE CAN NEVER CONTAIN A ROW THE OPERATOR HAS NOT SEEN.
 *
 * `resolveRangeSkus` is handed the **rendered** SKUs and nothing else. It has
 * no access to the full list, so a range reaching past what is on screen is
 * not "guarded against" — it is UNREPRESENTABLE. That is the difference the
 * Manager asked for structurally (chunk 1, §2.1): the alternative (compute
 * over the matching set, then clamp) is one forgotten clamp away from ticking
 * rows nobody looked at.
 *
 * ⚠ WHY THE ANCHOR IS AN ID AND NEVER AN INDEX. An index into "the rows" goes
 * stale the moment the search, the window (or, from chunk 2, the page) changes
 * — and a stale index still points at *something*, silently the wrong row. A
 * missing id resolves to `null`, and `null` is a state the caller has to
 * answer out loud (a plain tick PLUS a hint — never a silent degrade).
 *
 * ⇒ TWO GUARANTEES, DELIBERATELY NOT ONE:
 *     1. The caller drops the anchor at a boundary (M8).
 *     2. This module returns `null` when the anchor is not among the rendered
 *        SKUs — which holds even if (1) is forgotten.
 *   Not the same rule twice: (1) is about the anchor not lingering, (2) is
 *   about what a range may CONTAIN. (2) is the one the mutation test breaks.
 *
 * ─── ADDITIVE, NEVER TOGGLING ──────────────────────────────────────────────
 *
 * `addRangeToSelection` only ever adds — Gmail's checkbox list, NOT
 * Finder/Explorer. Those two REPLACE the whole selection on shift-click,
 * which M1 (cumulative selection) disqualifies outright.
 *
 * ⚠ AND NOT "TOGGLE EACH ROW IN THE RANGE" EITHER. Toggling makes the result
 * depend on the prior state of rows in the MIDDLE of the range, which the
 * operator may never have looked at: the same gesture yields different
 * outcomes for reasons that are off-screen. Additive is idempotent —
 * shift-click twice, same result.
 *
 * ⚠ The accepted cost, stated: a range cannot be undone with a second
 * shift-click. The undo is the header checkbox's "Clear N …" (chunk 2, C1).
 *
 * ─── ⚠ THERE IS AN APPLE SIBLING, AND IT IS NOT SHARED *YET*, ON PURPOSE ───
 *
 * `lib/iap-management/apple/item-range-select.ts` computes the same inclusive
 * slice. It is keyed on `appleIapId` inside a row object; this one is keyed on
 * a bare SKU string, because Google's picker already threads SKUs everywhere.
 *
 * Sharing the two is a REAL question and it is ON THE TABLE — it is filed as
 * an explicit input to the pending cross-module decision (see the arc's
 * "việc 1" report). It is not answered here because the Manager sequenced
 * chunk 1 to be independent of that decision, and importing across modules
 * now would silently pre-empt it. ⚠ Do not "fix" this by copying more logic
 * in either direction: if the decision lands on sharing, these two collapse
 * into one generic helper.
 */

/**
 * The SKUs from `anchorSku` to `targetSku` inclusive, **in the order they
 * appear in `renderedSkus`** — the array the picker is actually displaying,
 * already narrowed by the status filter, then the search, then the window.
 *
 * Returns `null` — not `[]` — when no range can be formed:
 *   • `anchorSku` is null (nothing has been plainly ticked yet), or
 *   • the anchor is not among the rendered SKUs (the search or the window has
 *     hidden it, or the caller dropped it at a boundary), or
 *   • the target is not among the rendered SKUs (cannot happen from a real
 *     click; refused anyway so a future caller cannot smuggle one in).
 *
 * ⚠ `null` vs `[]` is load-bearing. `[]` reads as "a range with nothing in
 * it", which a caller applies as a silent no-op. `null` means "there is no
 * range here", which the operator must be TOLD.
 */
export function resolveRangeSkus(
  renderedSkus: readonly string[],
  anchorSku: string | null,
  targetSku: string,
): string[] | null {
  if (anchorSku === null) return null;
  const anchorIndex = renderedSkus.indexOf(anchorSku);
  if (anchorIndex === -1) return null;
  const targetIndex = renderedSkus.indexOf(targetSku);
  if (targetIndex === -1) return null;
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  return renderedSkus.slice(from, to + 1);
}

/**
 * Add every SKU in the range to the selection. Nothing is ever removed, so a
 * row already ticked inside the range stays ticked, and picks OUTSIDE the
 * range — including ones the window or the search is hiding (M1) — are
 * untouched.
 */
export function addRangeToSelection(
  selected: ReadonlySet<string>,
  rangeSkus: readonly string[],
): Set<string> {
  const next = new Set(selected);
  for (const sku of rangeSkus) next.add(sku);
  return next;
}
