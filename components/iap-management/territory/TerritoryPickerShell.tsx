"use client";

/**
 * The territory picker CHROME — search box, continent chips, scroll frame,
 * sticky header, empty state. Nothing else.
 *
 * Design: docs/iap-management/design-apple-per-territory-availability.md §G4.
 *
 * WHY THIS EXISTS (P1 — twin path)
 * Two dialogs pick over Apple's ~175 territories: Custom Prices (a per-
 * territory VALUE, fetched lazily per row) and availability (a per-territory
 * BOOLEAN). On the Edit form they sit ADJACENT — two buttons in the same
 * `IapForm`. Building the second one's toolbar by hand is precisely the shape
 * that has bitten this module before: patch one, forget the sibling. So the
 * chrome is extracted once and both mount it. `TerritoryPickerShell.chrome`
 * asserts structurally that no third copy appears.
 *
 * WHAT THIS DELIBERATELY DOES NOT KNOW
 * Prices, provenance, availability, `TerritorySelection`, `TERRITORY_CATALOG`.
 * It does not fetch and it does not own the territory list — the caller passes
 * `items`, because the list used to SHOW must be the list that gets SENT, and
 * only the surface knows where that came from. The right-hand cell of every
 * row belongs to the caller too: availability has no per-row async, no three-
 * state option loading and no provenance, so a shell that modelled those would
 * force the simpler picker to pretend.
 *
 * WHAT IT DOES OWN: the filter. Both predicates (continent, then query, then
 * the caller's extra) run HERE, once. A caller that re-derived the visible
 * subset would have reintroduced the drift this file exists to prevent —
 * hence the render-prop slots below, which hand the already-filtered subset
 * back rather than inviting the caller to compute it again.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Loader2, Search } from "lucide-react";
import {
  APPLE_CONTINENTS,
  getContinentForTerritory,
  type Continent,
} from "@/lib/iap-management/apple/territory-continent";

/** What the caller's slots get told about the current filter. */
export interface TerritoryPickerView<T> {
  /** The rows passing every filter, in `items` order. */
  visible: readonly T[];
  /** `items.length` — the unfiltered total. */
  total: number;
  /** True when a continent chip or a query is narrowing the list. */
  filterActive: boolean;
}

/**
 * A slot is either static content or a function of the current filter state.
 * The function form is how "Select all 42 shown" gets its 42 without the
 * caller re-running the filter.
 */
export type TerritorySlot<T> =
  | ReactNode
  | ((view: TerritoryPickerView<T>) => ReactNode);

function renderSlot<T>(
  slot: TerritorySlot<T> | undefined,
  view: TerritoryPickerView<T>,
): ReactNode {
  return typeof slot === "function"
    ? (slot as (v: TerritoryPickerView<T>) => ReactNode)(view)
    : slot;
}

export interface TerritoryPickerShellProps<T> {
  /** The territory rows. Order is preserved; the shell never sorts. */
  items: readonly T[];
  /** Alpha-3 id of a row, for continent bucketing. */
  codeOf: (item: T) => string;
  /** The caller's search predicate — see `matchesTerritoryQuery`. */
  matches: (item: T, query: string) => boolean;
  /** An optional caller-owned filter (Custom Prices' "Only customised"). */
  extraFilter?: (item: T) => boolean;
  /** `<th>` cells for the sticky header row. */
  columns: ReactNode;
  /** Column count, so the empty-state cell can span the table. */
  columnCount: number;
  renderRow: (item: T) => ReactNode;
  /** Right-hand end of the toolbar (extra filters). */
  toolbarSlot?: TerritorySlot<T>;
  /** The live count chip. The shell does not know what is being counted. */
  countSlot?: TerritorySlot<T>;
  /** A full-width strip under the toolbar (the filter-active warning). */
  bannerSlot?: TerritorySlot<T>;
  searchPlaceholder: string;
  emptyLabel: string;
  loading?: boolean;
  loadingLabel?: string;
  loadError?: string | null;
  /**
   * Change this to clear the search box and reset the continent chip. Callers
   * that stay mounted while hidden use it to reproduce their own open-reset.
   */
  resetKey?: string | number;
}

export function TerritoryPickerShell<T>({
  items,
  codeOf,
  matches,
  extraFilter,
  columns,
  columnCount,
  renderRow,
  toolbarSlot,
  countSlot,
  bannerSlot,
  searchPlaceholder,
  emptyLabel,
  loading = false,
  loadingLabel = "Loading territories…",
  loadError = null,
  resetKey,
}: TerritoryPickerShellProps<T>) {
  const [query, setQuery] = useState("");
  const [continent, setContinent] = useState<Continent | "ALL">("ALL");

  // Reset on the caller's signal. Keyed on `resetKey` rather than an effect so
  // there is no render-then-correct flash of the previous filter.
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  if (resetKey !== seenResetKey) {
    setSeenResetKey(resetKey);
    setQuery("");
    setContinent("ALL");
  }

  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (extraFilter && !extraFilter(item)) return false;
        if (continent !== "ALL" && getContinentForTerritory(codeOf(item)) !== continent) {
          return false;
        }
        return matches(item, query);
      }),
    [items, extraFilter, continent, codeOf, matches, query],
  );

  const view: TerritoryPickerView<T> = {
    visible,
    total: items.length,
    filterActive: query.trim().length > 0 || continent !== "ALL",
  };

  return (
    <>
      {/* Toolbar */}
      <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label="Search territories"
            className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 pl-8 pr-3 py-1.5 text-xs"
          />
        </div>
        <div className="flex gap-1">
          {(["ALL", ...APPLE_CONTINENTS] as Array<Continent | "ALL">).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setContinent(c)}
              aria-pressed={continent === c}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium border ${
                continent === c
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700"
              }`}
            >
              {c === "ALL" ? "All" : c}
            </button>
          ))}
        </div>
        {renderSlot(toolbarSlot, view)}
        {renderSlot(countSlot, view)}
      </div>

      {renderSlot(bannerSlot, view)}

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <p className="p-6 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> {loadingLabel}
          </p>
        )}
        {loadError && <p className="p-6 text-center text-xs text-red-600">{loadError}</p>}
        {!loading && !loadError && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white dark:bg-slate-900 shadow-[0_1px_0_#e2e8f0]">
              <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
                {columns}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {visible.map((item) => renderRow(item))}
              {visible.length === 0 && (
                <tr>
                  <td
                    colSpan={columnCount}
                    className="px-5 py-6 text-center text-slate-400"
                  >
                    {emptyLabel}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
