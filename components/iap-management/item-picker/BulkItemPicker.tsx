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
  /** The window is a RENDER bound only — never a selection bound. */
  const windowed = useMemo(
    () => matchingSelectable.slice(0, windowSize),
    [matchingSelectable, windowSize],
  );
  const hiddenByWindow = matchingSelectable.length - windowed.length;

  // Scoped to the matching set so the checkbox state and `onToggleAll` cannot
  // disagree — a "checked" box that unticks something else is worse than none.
  const allSelected =
    counts.matching > 0 && counts.selectedMatching === counts.matching;
  const someSelected = counts.selectedMatching > 0 && !allSelected;

  /**
   * [Y1] The last row ticked WITHOUT Shift, by id. Never an index — see
   * `item-range-select.ts` for why a stale index is worse than a missing one.
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
      {/* A 1,000-row app needs a way in that is not scrolling. */}
      {rows.length > ROW_WINDOW_STEP && (
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
              ⚠ Y1 WORDING DIFFERS FROM THE MOCKUP ON PURPOSE: the mockup says
              "within one page" and "raise the page size", and in Y1 there are
              no pages yet. Promising a control that does not exist is worse
              than the wording drift. Y2 restores the mockup's exact copy when
              the pages it names are real. */}
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
                  That Shift-click had no starting row among the rows shown, so
                  only the one row was selected. Click a row normally first,
                  then Shift-click another to take everything between them.
                </>
              ) : (
                <>
                  Tip — click a row, then <strong>Shift</strong>-click another
                  to select everything between them, within the rows shown.
                  Changing the search or a filter clears the starting row. For
                  a wider group, use Select all ({counts.matching} matching).
                </>
              )}
            </p>
          )}

          {/* ⚠ Never a silent truncation. The window is a render bound; it
              has no effect on what "Select all" takes or what is written,
              and it says so. */}
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
