"use client";

/**
 * Per-territory availability picker — the control all three surfaces mount
 * (A: Set Availabilities bulk · B: Bulk Import step · C: Edit item).
 *
 * Design: docs/iap-management/design-apple-per-territory-availability.md
 * §PART 2 B (the seven required behaviours) and §G6 (the advisory).
 * Visual target: design/apple-per-territory-availability-mockup.html.
 *
 * ⚠ THE LOAD-BEARING BEHAVIOUR IS BEHAVIOUR 2, AND IT IS A RENDERING RULE.
 * Apple has no `availableInAllTerritories`. `availableInNewTerritories` is
 * FORWARD-looking, so "All countries or regions" and "every territory ticked
 * by hand" carry the SAME ids and DIFFERENT flags — two different request
 * bodies (KB §4.13). Two states that send different bodies must never render
 * identically, so the footer says which one you are in, in words, always.
 *
 * ⚠ THE TERRITORY LIST IS A PROP, NEVER A LOCAL CATALOGUE. The list used to
 * SHOW must be the list that gets SENT: `setAvailabilityToAllTerritories`
 * enumerates Apple's live `/v1/territories`, while `territory-catalog.ts` is a
 * static local table. If the picker read the local one, "175 of 175 selected"
 * could be a lie. Each surface passes the ids it will actually send.
 * OPEN QUESTION FOR SC5: there is no client-facing route for `/v1/territories`
 * yet, and surface B (pre-create) has no per-item read to piggyback on — so
 * where each surface sources this list is still to be decided, per surface.
 *
 * ⚠ NEVER TRANSFORM APPLE'S VALUES. Ids arrive as opaque strings and are
 * emitted verbatim: no upper-casing, no trimming, no sorting of the emitted
 * array. Display names are derived for the eye only and never sent.
 *
 * Selection maths is NOT here — it is `lib/iap-management/apple/
 * territory-selection.ts`, shared with the server so the count the Manager
 * reads and the body the orchestrator writes cannot drift.
 */
import { useMemo, type ReactNode } from "react";
import {
  allTerritoriesSelection,
  classifySelection,
  excludesBaseTerritory,
  subsetSelection,
  type TerritorySelection,
} from "@/lib/iap-management/apple/territory-selection";
import { getContinentForTerritory } from "@/lib/iap-management/apple/territory-continent";
import { matchesTerritoryQuery } from "@/lib/iap-management/territory-query";
import { territoryName } from "@/components/iap-management/view-detail/territory-name";
import {
  TerritoryPickerShell,
  type TerritoryPickerView,
} from "./TerritoryPickerShell";

interface TerritoryRow {
  /** Apple's id, verbatim. */
  code: string;
  /** Derived for display and search only — never sent. */
  name: string;
}

export interface TerritoryAvailabilityPickerProps {
  /**
   * Every territory the surface can offer, as Apple gave them. This is also
   * the set "All countries or regions" resolves to.
   */
  territoryIds: readonly string[];
  /** The current selection. Controlled: the surface owns this state. */
  value: TerritorySelection;
  onChange: (next: TerritorySelection) => void;
  /**
   * The item's availability as read a moment ago, enabling "Reset to
   * current" (behaviour 5 — surface C). Omit where there is nothing to
   * reset to, as on Bulk Import.
   */
  resetTo?: TerritorySelection | null;
  /**
   * The item's own `base_territory`, for the §G6 advisory. NOT the literal
   * "USA" — the column is per-item.
   */
  baseTerritory?: string | null;
  /** Rendered above the segmented control, for per-surface framing. */
  intro?: ReactNode;
}

const rowCode = (row: TerritoryRow) => row.code;
const matchesRow = (row: TerritoryRow, query: string) =>
  matchesTerritoryQuery({ name: row.name, code: row.code }, query);

export function TerritoryAvailabilityPicker({
  territoryIds,
  value,
  onChange,
  resetTo,
  baseTerritory,
  intro,
}: TerritoryAvailabilityPickerProps) {
  const rows = useMemo<TerritoryRow[]>(
    () => territoryIds.map((code) => ({ code, name: territoryName(code) })),
    [territoryIds],
  );

  const selected = useMemo(() => new Set(value.territoryIds), [value.territoryIds]);
  const kind = classifySelection(value, territoryIds);
  const mode: "all" | "selected" = kind === "ALL" ? "all" : "selected";

  const total = territoryIds.length;
  const count = value.territoryIds.length;

  /**
   * Every toggle produces a hand-picked set, so the forward-looking flag goes
   * FALSE — a Manager who enumerated territories chose *these*, and opting
   * them into every future Apple market would be the tool deciding for them
   * (the rule `subsetSelection` documents).
   */
  const emitSubset = (ids: readonly string[]) => onChange(subsetSelection(ids));

  const toggle = (code: string) => {
    if (selected.has(code)) {
      emitSubset(value.territoryIds.filter((id) => id !== code));
    } else {
      // Append — never reorder what Apple gave us.
      emitSubset([...value.territoryIds, code]);
    }
  };

  const selectAllShown = (visible: readonly TerritoryRow[]) => {
    const additions = visible.map((r) => r.code).filter((c) => !selected.has(c));
    emitSubset([...value.territoryIds, ...additions]);
  };

  const clearAllShown = (visible: readonly TerritoryRow[]) => {
    const drop = new Set(visible.map((r) => r.code));
    emitSubset(value.territoryIds.filter((id) => !drop.has(id)));
  };

  /**
   * Behaviour 2 made textual. The suffix is the ONLY thing distinguishing two
   * selections that hold identical ids — if it ever goes missing, the UI is
   * lying about what it will send.
   */
  const footerSentence =
    kind === "ALL"
      ? `${count} of ${total} selected — includes any new market Apple launches later.`
      : kind === "ALL_FROZEN"
        ? `${count} of ${total} selected — new Apple markets will NOT be added automatically.`
        : `${count} of ${total} selected`;

  const advisory = excludesBaseTerritory(value, baseTerritory);

  /** Select-all / clear-all NEVER address the catalogue — only what is shown. */
  const filterStrip = (view: TerritoryPickerView<TerritoryRow>) => {
    const shown = view.visible.length;
    return (
      <div
        data-testid="territory-picker-filter-strip"
        className={`px-5 py-2 border-b flex items-center gap-2 flex-wrap ${
          view.filterActive
            ? "border-amber-300 bg-amber-50 dark:bg-amber-900/20"
            : "border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
        }`}
      >
        {view.filterActive && (
          <span className="text-[11px] text-amber-900 dark:text-amber-200">
            Filter active — <strong>{shown} of {view.total}</strong> shown
          </span>
        )}
        <div className="flex gap-2 ml-auto">
          <button
            type="button"
            onClick={() => selectAllShown(view.visible)}
            disabled={shown === 0}
            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-medium disabled:opacity-40"
          >
            Select all {shown} shown
          </button>
          <button
            type="button"
            onClick={() => clearAllShown(view.visible)}
            disabled={shown === 0}
            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-medium disabled:opacity-40"
          >
            Clear all {shown} shown
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {intro}

      {/* The G1 distinction, surfaced as the first choice in the dialog. */}
      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
        <div
          role="group"
          aria-label="Territory scope"
          className="inline-flex rounded-lg border border-slate-300 dark:border-slate-700 p-0.5 bg-slate-50 dark:bg-slate-800/40"
        >
          <button
            type="button"
            aria-pressed={mode === "all"}
            onClick={() => onChange(allTerritoriesSelection(territoryIds))}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${
              mode === "all"
                ? "bg-slate-900 text-white"
                : "text-slate-600 dark:text-slate-300"
            }`}
          >
            All countries or regions
          </button>
          <button
            type="button"
            aria-pressed={mode === "selected"}
            // Keep the ids, drop the flag: the Manager now owns this list.
            // That is exactly the ALL_FROZEN state, and the footer says so.
            onClick={() => emitSubset(value.territoryIds)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium ${
              mode === "selected"
                ? "bg-slate-900 text-white"
                : "text-slate-600 dark:text-slate-300"
            }`}
          >
            Selected countries or regions
          </button>
        </div>
        {mode === "all" && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2">
            Includes any new market Apple launches later.
          </p>
        )}
      </div>

      {mode === "all" ? (
        <div className="px-5 py-8 bg-slate-50/60 dark:bg-slate-800/30 text-center flex-1">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
            All {total} countries and regions
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Plus every market Apple adds in the future.
          </p>
        </div>
      ) : (
        <TerritoryPickerShell<TerritoryRow>
          items={rows}
          codeOf={rowCode}
          matches={matchesRow}
          searchPlaceholder="Search country or code…"
          emptyLabel="No countries or regions match the current filter."
          columnCount={2}
          columns={
            <>
              <th className="px-5 py-2.5 font-semibold">Country or region</th>
              <th className="px-3 py-2.5 font-semibold">Continent</th>
            </>
          }
          countSlot={
            <span
              data-testid="territory-picker-count"
              className="px-2 py-1 rounded bg-blue-100 text-blue-900 text-[11px] font-semibold"
            >
              {count} of {total} selected
            </span>
          }
          bannerSlot={filterStrip}
          renderRow={(row) => (
            <tr
              key={row.code}
              data-testid={`territory-row-${row.code}`}
              className={
                selected.has(row.code)
                  ? "bg-blue-50 dark:bg-blue-900/20"
                  : "hover:bg-slate-50 dark:hover:bg-slate-800/30"
              }
            >
              <td className="px-5 py-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(row.code)}
                    onChange={() => toggle(row.code)}
                    className="h-3.5 w-3.5 rounded border-slate-300"
                  />
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {row.name}
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">{row.code}</span>
                </label>
              </td>
              <td className="px-3 py-2 text-slate-500">
                {getContinentForTerritory(row.code) ?? "—"}
              </td>
            </tr>
          )}
        />
      )}

      {/* Footer: the count, the G1 sentence, the advisory, the reset. */}
      <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30 flex items-center justify-between gap-3 flex-wrap">
        <p
          data-testid="territory-picker-footer"
          className="text-[11px] text-slate-600 dark:text-slate-300"
        >
          {footerSentence}
        </p>
        {resetTo && (
          <button
            type="button"
            onClick={() => onChange(resetTo)}
            className="text-[11px] text-blue-700 hover:underline"
          >
            Reset to current
          </button>
        )}
      </div>

      {advisory && (
        <p
          data-testid="territory-picker-base-advisory"
          className="px-5 py-2 text-[11px] text-amber-900 dark:text-amber-200 bg-amber-50 dark:bg-amber-900/20 border-t border-amber-200"
        >
          Prices are calculated from {baseTerritory}, which this selection excludes.
          Check the price schedule.
        </p>
      )}
    </div>
  );
}
