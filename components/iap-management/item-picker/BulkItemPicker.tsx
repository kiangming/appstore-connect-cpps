"use client";

/**
 * The shared ITEM PICKER — search box, select-all bar, windowed row list,
 * "Show more", and the shown-but-disabled excluded tail.
 *
 * Extracted verbatim from `AvailabilitiesBulkModal.tsx:1113-1274`, where it was
 * written for A′ (the availability surface). The export wizard needs the same
 * list with the same three guarantees, and re-implementing it there would be
 * P1 twin-path: two windowing rules and two "select all" scopes for one
 * behaviour, drifting apart at the first fix.
 *
 * ─── THE THREE GUARANTEES THIS COMPONENT EXISTS TO KEEP ────────────────────
 *
 * ⚠ 1. "SELECT ALL" MEANS EVERY MATCHING ITEM — never the rendered window.
 *      Scoping it to the window hands back 60 of 500 under a label that says
 *      "all"; scoping it to the whole app ignores the search the Manager just
 *      typed. The arithmetic lives in `bulk-item-search.ts` and is called from
 *      here rather than re-derived, so the checkbox and the action cannot
 *      disagree.
 *
 * ⚠ 2. THE WINDOW IS A RENDER BOUND, AND IT SAYS SO. "Show more" states how
 *      many are not shown AND that not-shown is not excluded. A silent
 *      truncation here is indistinguishable from a shorter list.
 *
 * ⚠ 3. A SELECTION HIDDEN BY THE SEARCH IS STILL A SELECTION, AND IS COUNTED
 *      ON SCREEN. Without that line the count appears to drop when the query
 *      narrows and the Manager concludes the tool lost their picks.
 *
 * ─── WHAT IS DELIBERATELY *NOT* HERE ───────────────────────────────────────
 *
 * Every string that is true on one surface and false on another. The
 * exclusion reasons, the "nothing selectable" copy, the per-row trailing badge
 * and the caption above the list all arrive as SLOTS, because A′ and export
 * genuinely disagree about them — most sharply about which rows are excluded
 * at all (design §2.G: an Apple item with no local UUID is excluded for
 * availability and perfectly selectable for export). Sharing the wording would
 * have re-created the defect `export-item-rows.ts` was written to avoid.
 *
 * ⚠ STATE IS CONTROLLED, NOT OWNED. `query` and `windowSize` come from the
 * caller. The modal already resets both in its own `handleClose`, and moving
 * that ownership in here would have made the reset timing a new question at
 * exactly the moment this extraction is supposed to prove it changed nothing.
 *
 * ─── [Y1] SHIFT-CLICK RANGE SELECTION, BEHIND `paged` ─────────────────────
 *
 * Design: docs/iap-management/design-export-picker-paging-range.md §2.5-2.6.
 *
 * ⚠ `paged` IS A PER-SURFACE GATE, NOT A PER-FEATURE ONE, and it is OFF by
 * default. Q2's decision was about surfaces: export is a READ path (a wrong
 * pick costs a re-run) and A′ is a WRITE path (a wrong pick has already
 * changed what sells where, and re-running does not undo it). The risk is not
 * symmetric, so one refactor must not drag both surfaces along at once. One
 * flag for the whole new picker — range selection now, pagination in Y2 —
 * rather than one flag per feature, because two flags on a shared component
 * is how one component grows two behaviours.
 *
 * ⚠ The name reads slightly ahead of what it gates in Y1 (there are no pages
 * yet). Deliberate: it is named for the surface capability it will gate by the
 * end of the arc, so nobody introduces a second flag in Y2.
 *
 * ⚠ IT MUST NOT BECOME DEAD CODE. Both branches are pinned
 * (`BulkItemPicker.range.test.tsx`), and flipping the default to `true` turns
 * A′'s parity test red — the flag's default is an asserted fact, not a habit.
 *
 * ⚠ AND THE ANCHOR *IS* OWNED HERE, unlike `query`/`windowSize`. Those two are
 * reset by the caller because only the caller knows when its dialog closes.
 * The anchor needs no external reset at all: its validity is RE-DERIVED on
 * every use by looking the id up in the rendered rows
 * (`resolveRangeIds`), so there is no reset timing to get wrong and nothing
 * for a caller to forget. Handing it out as a prop would have invented the
 * very question the comment above says to avoid.
 */

import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import type { BulkItemRow } from "@/lib/iap-management/apple/bulk-item-rows";
import {
  filterRowsByQuery,
  selectionCounts,
  ROW_WINDOW_STEP,
} from "@/lib/iap-management/apple/bulk-item-search";
import { resolveRangeIds } from "@/lib/iap-management/apple/item-range-select";
import { computePageMeta } from "@/lib/iap-management/pagination/page-slice";
import { PageNav } from "@/components/ui/iap/PageNav";

/**
 * [Y2, M6] The page sizes the Manager chose. ⚠ EXPORTED so the caller's
 * default and the dropdown cannot drift — the wizard seeds `pageSize` from
 * `PAGE_SIZE_OPTIONS[0]` rather than repeating the number.
 */
export const PAGE_SIZE_OPTIONS = [20, 30, 50] as const;

/**
 * The minimum a row needs to be tickable: an Apple id to key the checkbox on.
 * Both A′'s `SelectableRow` (which additionally requires `internalId`) and
 * export's `ExportSelectableRow` (which deliberately does not) satisfy it, so
 * the picker never has to know which surface it is rendering.
 */
export interface PickableRow extends BulkItemRow {
  appleIapId: string;
}

export interface BulkItemPickerProps<
  S extends PickableRow,
  E extends BulkItemRow,
> {
  /** EVERY row, selectable or not — the denominator, and what decides whether
   *  the search box is worth rendering at all. */
  rows: readonly BulkItemRow[];
  selectableRows: readonly S[];
  excludedRows: readonly E[];
  selected: ReadonlySet<string>;

  query: string;
  /** ⚠ The caller is expected to reset the window here — a narrowed list that
   *  keeps a 300-row window would render rows the search just excluded. */
  onQueryChange: (next: string) => void;
  windowSize: number;
  onShowMore: () => void;

  onToggleOne: (appleIapId: string) => void;
  onToggleAll: () => void;

  /**
   * [Y1] Turn on this surface's new selection affordances. **OFF by default**
   * so A′ (the availability WRITE modal) is byte-for-byte unchanged — see the
   * header for why the gate is per-surface and not per-feature.
   */
  paged?: boolean;
  /**
   * [Y1] Apply a shift-click range — **additive**, the caller must not
   * toggle. Only ever called when `paged` is on.
   *
   * ⚠ If `paged` is on and this is absent, a shift-click degrades to a plain
   * tick AND the hint fires. That is a defined outcome, not an oversight:
   * there is no prop combination that silently does nothing.
   */
  onSelectRange?: (appleIapIds: string[]) => void;

  /**
   * [Y2] Pagination. Read ONLY when `paged` — with the flag off, `windowSize`
   * + "Show more" is still the whole story and A′ is untouched.
   *
   * ⚠ CALLER-OWNED, like `query` and `windowSize` and for the same reason: the
   * caller resets them together in its own close/reset, and the page must
   * return to 1 when a FACET changes — something only the caller knows about.
   * The anchor is the one piece of state this component does own, because its
   * only rule is re-derived (see `anchorId`).
   */
  page?: number;
  onPageChange?: (next: number) => void;
  pageSize?: number;
  onPageSizeChange?: (next: number) => void;

  /**
   * [Y2, Q5] "Selected only" — a view over the SAME selection set, not a
   * second selection. `"selected"` narrows the rendered rows to the ticked
   * ones and then pages them exactly as usual.
   *
   * ⚠ IT IS A FILTER, AND THAT IS THE WHOLE DESIGN. It adds no state beyond
   * this string, no arithmetic, and no second notion of what is selected — so
   * it cannot drift from the counter or the payload. It exists because M4
   * makes "12 selected, none of them on screen" a reachable state.
   */
  viewMode?: "all" | "selected";
  onViewModeChange?: (next: "all" | "selected") => void;

  /**
   * [Y2] (B) — select or clear EVERY row on the current page.
   *
   * ⚠ THE IDS ARE THE PAGE'S, COMPUTED HERE, AND THE CALLER MUST NOT WIDEN
   * THEM. This is the control the design spent most of its risk budget on:
   * (A) is "all matching, every page" and (B) is "this page", they differ by
   * up to 10x, and at ~3 Apple requests per item confusing them costs money.
   */
  onSelectManyInPage?: (appleIapIds: string[], select: boolean) => void;

  /** Rendered between the search box and the list. A′ puts its filter caption
   *  and (in set-territories) the territory picker here. */
  betweenSearchAndList?: ReactNode;
  /** Trailing cell on each row — a per-surface state badge, or nothing. */
  renderRowTrailing?: (row: S) => ReactNode;
  /** Shown INSTEAD of the list when no row is selectable. */
  nothingSelectableSlot?: ReactNode;
  /** The shown-but-disabled tail. Receives rows ALREADY narrowed by the
   *  search, so the caller never re-filters. */
  renderExcluded?: (rows: E[]) => ReactNode;
}

export function BulkItemPicker<S extends PickableRow, E extends BulkItemRow>({
  rows,
  selectableRows,
  excludedRows,
  selected,
  query,
  onQueryChange,
  windowSize,
  onShowMore,
  onToggleOne,
  onToggleAll,
  paged = false,
  onSelectRange,
  page = 1,
  onPageChange,
  pageSize = ROW_WINDOW_STEP,
  onPageSizeChange,
  viewMode = "all",
  onViewModeChange,
  onSelectManyInPage,
  betweenSearchAndList,
  renderRowTrailing,
  nothingSelectableSlot,
  renderExcluded,
}: BulkItemPickerProps<S, E>) {
  /** ⚠ SEARCH NARROWS WHAT IS SHOWN, NEVER WHAT IS SELECTED. Rows the query
   *  hides stay in `selected` and stay in the batch; the count of those is
   *  rendered so the Manager can account for every ticked box. */
  const matchingSelectable = useMemo(
    () => filterRowsByQuery(selectableRows, query),
    [selectableRows, query],
  );
  const matchingExcluded = useMemo(
    () => filterRowsByQuery(excludedRows, query),
    [excludedRows, query],
  );
  const counts = useMemo(
    () =>
      selectionCounts({
        selectableRows,
        totalRows: rows.length,
        selected,
        query,
      }),
    [selectableRows, rows.length, selected, query],
  );
  /**
   * [Y2, Q5] "Selected only" narrows the rows BEFORE paging, so the pages are
   * pages of the selection. Off — and when `paged` is off — this is identity.
   */
  const viewRows = useMemo(
    () =>
      paged && viewMode === "selected"
        ? matchingSelectable.filter((r) => selected.has(r.appleIapId))
        : matchingSelectable,
    [paged, viewMode, matchingSelectable, selected],
  );

  /**
   * [Y2] The page's index math, from the module four other surfaces already
   * use. ⚠ `computePageMeta` CLAMPS the requested page into range
   * (page-slice.ts:37), which is what keeps a shrinking result set from
   * leaving the picker on a page that no longer exists.
   */
  const pageMeta = useMemo(
    () => computePageMeta(viewRows.length, page, pageSize),
    [viewRows.length, page, pageSize],
  );

  /**
   * THE RENDERED ROWS — and the single source of that fact.
   *
   * ⚠ EVERYTHING THAT MUST AGREE WITH "WHAT IS ON SCREEN" READS THIS ARRAY:
   * the rows, the shift-click range (Y1), (B)'s tri-state and its ids, and the
   * "on this page" half of the counter. One array, so they cannot disagree.
   *
   * ⚠ AND IT IS A RENDER BOUND ONLY — never a selection bound. That was true
   * of the window and stays true of the page: nothing here decides what is
   * exported. What CHANGED in Y2 is that a page is a MIDDLE slice, so a ticked
   * row can now leave the screen — which is why the counter below reports the
   * page and the whole set separately, and why the off-page notice exists.
   */
  const windowed = useMemo(
    () =>
      paged
        ? viewRows.slice(pageMeta.startIndex, pageMeta.endIndex)
        : matchingSelectable.slice(0, windowSize),
    [
      paged,
      viewRows,
      pageMeta.startIndex,
      pageMeta.endIndex,
      matchingSelectable,
      windowSize,
    ],
  );
  const hiddenByWindow = paged
    ? 0
    : matchingSelectable.length - windowed.length;

  /** [Y2, M2] The near half of the two-tier counter. */
  const selectedOnPage = useMemo(
    () => windowed.filter((r) => selected.has(r.appleIapId)).length,
    [windowed, selected],
  );
  /**
   * [Y2, M2] ⚠ THE NUMBER THIS WHOLE CHUNK EXISTS FOR. Picks that are still
   * in the batch but not on this page. Before Y2 it could not be non-zero:
   * the window only grew, so a row once rendered never left. It can now, and
   * an unreported divergence between "selected" and "on screen" is the
   * silent-drop class.
   */
  const selectedOffPage = Math.max(0, counts.selectedMatching - selectedOnPage);

  /** [Y2] (B)'s scope — exactly the rows rendered, nothing wider. */
  const pageIds = useMemo(
    () => windowed.map((r) => r.appleIapId),
    [windowed],
  );
  const pageAllSelected =
    pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const pageSomeSelected =
    pageIds.some((id) => selected.has(id)) && !pageAllSelected;

  // Scoped to the matching set so the checkbox state and `onToggleAll` cannot
  // disagree — a "checked" box that unticks something else is worse than none.
  const allSelected =
    counts.matching > 0 && counts.selectedMatching === counts.matching;
  const someSelected = counts.selectedMatching > 0 && !allSelected;

  /**
   * [Y1] The last row ticked WITHOUT Shift, by id. Never an index — see
   * `item-range-select.ts` for why a stale index is worse than a missing one.
   *
   * ⚠ DELIBERATELY NOT CLEARED AT A BOUNDARY, AND DO NOT "FIX" THAT.
   * Manager decision, Y1 gate point (4). The spec was worded "a page flip
   * clears the anchor"; it is implemented instead as `resolveRangeIds`
   * refusing an anchor that is not among the rendered rows — which produces
   * the same observable behaviour in every safety-relevant case, out of ONE
   * definition. The single difference is that coming BACK to the page the
   * anchor is on re-validates it, and that is safe: every row the range would
   * contain is on screen again, so the range still means what it looks like.
   *
   * Adding `setAnchorId(null)` to the page-flip handler (or the page-size, or
   * the search, or the facet handlers) would trade one definition for a LIST
   * OF TRIGGERS SOMEONE HAS TO REMEMBER — which is the failure shape this arc
   * exists to avoid, and the list is never finished: Y2 adds two more
   * boundaries, and a future filter would add another.
   */
  const [anchorId, setAnchorId] = useState<string | null>(null);
  /** [Y1] A shift-click that could not form a range. Y1.2: say so. */
  const [rangeMiss, setRangeMiss] = useState(false);

  /**
   * [Y1] One handler for every row tick, plain or shifted.
   *
   * ⚠ `shiftKey` IS READ OFF `nativeEvent`, AND THAT IS MEASURED, NOT ASSUMED.
   * A probe under this exact stack (React 18 + jsdom, vitest 4.1.4) logged
   * `click shift=true | change type=click shift=true` — for a checkbox the
   * change event's `nativeEvent` IS the originating click and carries the
   * modifier. So there is no `onClick`-into-a-ref dance and no assumption
   * about which of the two handlers runs first.
   *
   * ⚠ Keyboard activation (Space) gives a `nativeEvent` with no `shiftKey`,
   * which is falsy, which is a plain tick. Shift+Space is not a range gesture
   * on any platform, so that is the right answer rather than a gap.
   */
  function handleRowToggle(appleIapId: string, shiftKey: boolean) {
    if (paged && shiftKey) {
      const rangeIds = resolveRangeIds(windowed, anchorId, appleIapId);
      // ⚠ `null` is "there is no range here", and it must be VISIBLE. Falling
      //   through to a plain tick with nothing said is the silent-degrade
      //   Y1.2 forbids: the Manager asked for a group and got one row.
      if (rangeIds !== null && onSelectRange) {
        onSelectRange(rangeIds);
        setRangeMiss(false);
        // ⚠ The anchor does NOT move to the target. Gmail keeps the anchor so
        //   a second shift-click re-aims the same range instead of chaining a
        //   new one off wherever the last one landed.
        return;
      }
      // No anchor on screen (or no handler wired) — tick this row and TELL THEM.
      setRangeMiss(true);
      setAnchorId(appleIapId);
      onToggleOne(appleIapId);
      return;
    }
    // A plain click is what SETS the anchor. This is the only place it moves.
    setAnchorId(appleIapId);
    setRangeMiss(false);
    onToggleOne(appleIapId);
  }

  return (
    <>
      {/* A 1,000-row app needs a way in that is not scrolling.
          ⚠ [Y2] THE THRESHOLD IS THE RENDER BOUND, NOT A CONSTANT — and that
          correction was forced by a test, not noticed by reading.
          The rule was `rows.length > ROW_WINDOW_STEP` (60), tuned when the
          bound WAS 60. Under `paged` the bound is `pageSize`, so a 45-item app
          at 20 rows/page had three pages to walk and NO SEARCH BOX: strictly
          worse than before Y2, where the same 45 rows all rendered at once and
          scrolling was enough. Tying the threshold to the actual bound fixes
          it for every page size, including ones nobody has picked yet.
          ⚠ A′ (paged off) keeps the 60 exactly. */}
      {rows.length > (paged ? pageSize : ROW_WINDOW_STEP) && (
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search product ID or name…"
          aria-label="Search items"
          data-testid="item-search"
          className="w-full mb-3 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
        />
      )}

      {betweenSearchAndList}

      {selectableRows.length === 0 ? (
        nothingSelectableSlot
      ) : (
        <>
          {/* ─── THE TOOLBAR ────────────────────────────────────────────
              ⚠ TWO SHAPES, GATED, AND THE GATE IS WHY A′ IS BYTE-IDENTICAL.

              paged OFF (A′): the original single checkbox, untouched.

              paged ON (export, Q1/M7): (A) becomes a LABELLED BUTTON here in
              the toolbar and (B) becomes the only CHECKBOX, down in the
              tickbox column header. Two controls whose scopes differ by up to
              10x must not be the same KIND of control — the scope has to be
              readable from POSITION, because at ~3 Apple requests per item a
              mis-click is a real bill. Position is what the Manager reads;
              a longer label on two identical checkboxes is what they would
              have to remember. */}
          {paged ? (
            <div className="flex items-start justify-between gap-3 pb-2 border-b border-slate-200 dark:border-slate-800 mb-2">
              <div className="flex items-center gap-2 flex-wrap">
                {/* (A) — ALL MATCHING, EVERY PAGE. Same semantics and the same
                    `onToggleAll` as before; only the affordance changed. */}
                <button
                  type="button"
                  onClick={onToggleAll}
                  data-testid="select-all-matching"
                  className={`px-2.5 py-1 text-[11.5px] font-semibold rounded-md border transition ${
                    allSelected
                      ? "border-[#bfdbfe] bg-[#eff6ff] text-[#0c447c] dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
                      : "border-slate-300 bg-white text-[#0c447c] hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-blue-200"
                  }`}
                >
                  {allSelected
                    ? `✓ Clear all ${counts.matching}`
                    : `Select all ${counts.matching} matching`}
                </button>

                {/* [Q5] The review view for picks that are out of sight. */}
                <span className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden text-[11px]">
                  <button
                    type="button"
                    onClick={() => onViewModeChange?.("all")}
                    data-testid="view-all"
                    aria-pressed={viewMode === "all"}
                    className={`px-2.5 py-1 ${
                      viewMode === "all"
                        ? "bg-[#0c447c] text-white font-semibold"
                        : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                    }`}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => onViewModeChange?.("selected")}
                    data-testid="view-selected"
                    aria-pressed={viewMode === "selected"}
                    className={`px-2.5 py-1 ${
                      viewMode === "selected"
                        ? "bg-[#0c447c] text-white font-semibold"
                        : "bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                    }`}
                  >
                    Selected ({counts.selectedMatching})
                  </button>
                </span>
              </div>

              {/* ⚠ [M2] THE TWO-TIER COUNTER IS MANDATORY, NOT DECORATION.
                  (A) as a button cannot carry the `indeterminate` state the
                  checkbox used to — that cost was declared when Q1 was taken,
                  and this is where it is paid back. Both numbers, always:
                  the batch total AND how much of it is in front of you. */}
              <span
                className="text-[11px] text-slate-500 dark:text-slate-400 text-right leading-relaxed shrink-0"
                data-testid="selection-counts"
              >
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {counts.selectedMatching}
                </span>{" "}
                selected ·{" "}
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {selectedOnPage}
                </span>{" "}
                on this page
                <br />
                <span className="text-slate-400 dark:text-slate-500">
                  {counts.matching} matching · {counts.total} total
                </span>
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800 mb-2">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={onToggleAll}
                  className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
                  aria-label="Select all"
                />
                {/* ⚠ "matching", not a bare count: with a search active this
                    takes every match, INCLUDING rows the window has not
                    rendered. The label has to say which set that is. */}
                Select all ({counts.matching} matching)
              </label>
              <span
                className="text-[11px] text-slate-400 dark:text-slate-500"
                data-testid="selection-counts"
              >
                {counts.selectedMatching} selected of {counts.matching}
                {" · "}
                {counts.total} total
              </span>
            </div>
          )}

          {/* ⚠ [Y2] THE DIVERGENCE THE WHOLE CHUNK IS ABOUT. Picks that are
              still in the batch but not on this page. Unreachable before Y2 —
              the window only grew — and the single most likely way for this
              feature to lose a Manager's work quietly. */}
          {paged && selectedOffPage > 0 && (
            <p
              data-testid="selection-offpage-notice"
              className="text-[11px] text-amber-700 dark:text-amber-300 mb-2"
            >
              + {selectedOffPage} selected{" "}
              {selectedOffPage === 1 ? "item is" : "items are"} on other pages —
              still selected, and still part of the export. Use Selected (
              {counts.selectedMatching}) to review them.
            </p>
          )}

          {/* ⚠ The divergence must be VISIBLE. Narrowing the search hides
              ticked rows without unticking them; without this line the
              count appears to drop and the Manager concludes the tool lost
              their selection. */}
          {counts.selectedHidden > 0 && (
            <p
              data-testid="selection-hidden-notice"
              className="text-[11px] text-amber-700 dark:text-amber-300 mb-2"
            >
              + {counts.selectedHidden} more selected{" "}
              {counts.selectedHidden === 1 ? "item is" : "items are"} hidden by
              this search — still selected, and still part of the batch.
            </p>
          )}

          {/* ─── (B) — THE ONLY CHECKBOX IN THE TICKBOX COLUMN ─────────
              `flex items-center gap-3` mirrors the rows below EXACTLY, so this
              checkbox sits in the same column as theirs. That alignment IS the
              scope: a checkbox at the head of the tick column means "this
              page" in every table anyone has used, which is why (A) had to
              stop being one.

              ⚠ THE LABEL CHANGES WITH THE STATE, so the click is never
              ambiguous. And from PARTIAL it FILLS — it never clears (§2.2):
              from a partial page the intent is overwhelmingly "add the rest",
              and reading an ambiguous click as the destructive one is how
              picks get lost. The clear direction stays one click away, from
              the full state.

              ⚠ NO SPECIAL CASE UNDER "Selected only" (Q5): there every row is
              ticked, so the state machine below already renders it checked
              with the Clear label. Nothing to branch on. */}
          {paged && pageIds.length > 0 && (
            <div className="flex items-center gap-3 py-2 px-0 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/30">
              <input
                type="checkbox"
                checked={pageAllSelected}
                ref={(el) => {
                  if (el) el.indeterminate = pageSomeSelected;
                }}
                onChange={() =>
                  onSelectManyInPage?.(pageIds, !pageAllSelected)
                }
                className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
                aria-label={
                  pageAllSelected
                    ? `Clear ${pageIds.length} on this page`
                    : `Select all ${pageIds.length} on this page`
                }
                data-testid="select-all-in-page"
              />
              <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                {pageAllSelected
                  ? `Clear ${pageIds.length} on this page`
                  : `Select all ${pageIds.length} on this page`}
                {pageSomeSelected && (
                  <span className="font-normal text-slate-400 dark:text-slate-500">
                    {" "}
                    — {selectedOnPage} already selected
                  </span>
                )}
              </span>
            </div>
          )}

          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {windowed.map((row) => {
              const checked = selected.has(row.appleIapId);
              return (
                <li
                  key={row.appleIapId}
                  className="flex items-center gap-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      handleRowToggle(
                        row.appleIapId,
                        // ⚠ See handleRowToggle: this is the click event.
                        (e.nativeEvent as { shiftKey?: boolean }).shiftKey ===
                          true,
                      )
                    }
                    className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
                    aria-label={`Select ${row.productId}`}
                  />
                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate w-44">
                    {row.productId}
                  </span>
                  <span className="text-slate-800 dark:text-slate-200 flex-1 truncate">
                    {row.name}
                  </span>
                  {renderRowTrailing?.(row)}
                </li>
              );
            })}
          </ul>

          {/* ⚠ [Y1] THE HINT IS PART OF THE FEATURE, NOT DECORATION.
              Two states, ONE element (the mockup draws the baseline; the miss
              variant is the same line, because a shift-click that could not
              form a range must be ANSWERED, not swallowed — Y1.2):
                • baseline  — muted, always on when `paged`: the gesture is
                              undiscoverable otherwise, it has no control.
                • miss      — amber, after a shift-click with no anchor on
                              screen: names what happened AND what to do.
              ⚠ THE COPY NAMES PAGES AGAIN AS OF Y2, which is the mockup's
              wording. Y1 shipped a temporary sentence ("within the rows
              shown", no "raise the page size") because Y1 had no pages, and
              promising a control that does not exist is worse than wording
              drift. The pages are real now, so the mockup's copy is restored —
              Y1 gate point (1). */}
          {paged && (
            <p
              data-testid={rangeMiss ? "range-hint-miss" : "range-hint"}
              className={
                rangeMiss
                  ? "mt-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300"
                  : "mt-2 border-t border-dashed border-slate-200 dark:border-slate-700 pt-2 text-[11px] text-slate-500 dark:text-slate-400"
              }
            >
              {rangeMiss ? (
                <>
                  That Shift-click had no starting row on this page, so only
                  the one row was selected. Click a row normally first, then
                  Shift-click another to take everything between them.
                </>
              ) : (
                <>
                  Tip — click a row, then <strong>Shift</strong>-click another
                  to select everything between them,{" "}
                  <strong>within one page</strong>. Changing page, page size,
                  the search or a filter clears the starting row. For a wider
                  group, raise the page size or use Select all (
                  {counts.matching} matching).
                </>
              )}
            </p>
          )}

          {/* ⚠ Never a silent truncation. The window is a render bound; it
              has no effect on what "Select all" takes or what is written,
              and it says so. */}
          {/* ⚠ [Y2] THE ROWS SELECTOR IS A <select>, NOT A SEGMENTED CONTROL.
              The mockup drew three buttons in a row; the Manager changed
              exactly this one thing and nothing else. Label and position are
              the mockup's.
              ⚠ AND CHANGING IT ANCHORS THE VIEWPORT (Q7) — the arithmetic is
              the caller's (`onPageSizeChange`), because the caller owns
              `page`. See the wizard for why anchoring beats resetting. */}
          {paged && (
            <PageNav
              dense
              meta={pageMeta}
              onPageChange={(next) => onPageChange?.(next)}
              summary={
                <>
                  Showing{" "}
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {pageMeta.displayStart}–{pageMeta.displayEnd}
                  </span>{" "}
                  of{" "}
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {viewRows.length}
                    {viewMode === "selected" ? " selected" : ""}
                  </span>
                  {viewMode === "all" && counts.matching !== counts.total && (
                    <>
                      {" "}
                      <span className="text-slate-400">
                        (filtered from {counts.total})
                      </span>
                    </>
                  )}
                </>
              }
              leading={
                <label className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                  Rows
                  <select
                    value={pageSize}
                    onChange={(e) =>
                      onPageSizeChange?.(Number(e.target.value))
                    }
                    aria-label="Rows per page"
                    data-testid="page-size-select"
                    className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[11px] px-1.5 py-1 text-slate-700 dark:text-slate-200"
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              }
            />
          )}

          {hiddenByWindow > 0 && (
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={onShowMore}
                data-testid="show-more-rows"
                className="text-[11px] font-medium text-[#0071E3] hover:underline"
              >
                Show {Math.min(hiddenByWindow, ROW_WINDOW_STEP)} more (
                {hiddenByWindow} not shown)
              </button>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                Not shown is not excluded — Select all still takes all{" "}
                {counts.matching}.
              </p>
            </div>
          )}
        </>
      )}

      {/* ⚠ THE ANTI-SILENT-DROP SURFACE. Every row the action cannot touch is
          listed here with the reason it is out. Previously these rows simply
          vanished and the caption above blamed availability regardless of the
          real cause. */}
      {matchingExcluded.length > 0 && renderExcluded?.(matchingExcluded)}
    </>
  );
}
