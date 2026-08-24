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
 */

import type { ReactNode } from "react";
import { useMemo } from "react";

import type { BulkItemRow } from "@/lib/iap-management/apple/bulk-item-rows";
import {
  filterRowsByQuery,
  selectionCounts,
  ROW_WINDOW_STEP,
} from "@/lib/iap-management/apple/bulk-item-search";

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
                    onChange={() => onToggleOne(row.appleIapId)}
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
