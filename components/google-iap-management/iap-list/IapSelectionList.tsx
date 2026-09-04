"use client";

/**
 * The shared per-item selection list for the Google IAP module: select-all
 * bar, checkbox rows, and (opt-in) a search box plus a windowed "Show more".
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Extracted from `BulkStatusModal`'s inner `SelectionState`, where it was
 * written for Bulk Activate / Deactivate. The export picker (X3) needs the
 * same list with the same select-all semantics, and writing a second one is
 * P1 twin-path: two "select all" scopes and two row layouts for one
 * behaviour, drifting apart at the first fix. The Apple module hit exactly
 * this and answered it the same way (`BulkItemPicker`).
 *
 * ⚠ THE EXTRACTION IS BEHAVIOUR-PRESERVING BY CONSTRUCTION, AND THAT IS
 * PROVEN, NOT ASSERTED. `BulkStatusModal`'s own test file is unchanged —
 * byte-for-byte, `git diff` on it is empty — and still passes. That is the
 * parity gate for this move; anything that required editing those tests would
 * mean the modal's behaviour moved, which is the one thing this refactor is
 * not allowed to do.
 *
 * ─── WHAT IS OPT-IN, AND WHY IT DEFAULTS OFF ───────────────────────────────
 *
 * `search`, `rangeSelect` and `paged` are OPTIONAL and every one of them
 * defaults OFF. Omit them and this renders exactly what `SelectionState`
 * rendered: a select-all bar and every row. The modal omits them, so it is
 * untouched; the export picker passes them.
 *
 * ⚠ THIS IS NOT LAZINESS ABOUT THE MODAL. Adding a search box to Bulk
 * Activate would be a UI change to a shipped write path, decided by nobody,
 * riding in on a refactor. If that box is wanted there it is a separate,
 * visible decision.
 *
 * ─── THE THREE GUARANTEES ──────────────────────────────────────────────────
 *
 * ⚠ 1. "SELECT ALL" MEANS EVERY MATCHING ITEM — never the rendered window.
 *      The callback receives the filtered set, not the sliced one. Scoping it
 *      to the window hands back 20 of 200 under a label that says "all".
 *
 * ⚠ 2. WHAT IS NOT ON SCREEN IS STILL SELECTED, AND THE SCREEN SAYS SO. Up to
 *      chunk 2 this was a growing window plus a "Show more" that named the
 *      remainder. Chunk 2 replaced it with real paging, so the same promise is
 *      now kept by the two-tier counter and the "not on this page" line —
 *      a silent truncation is indistinguishable from a shorter list, whichever
 *      mechanism does the truncating.
 *
 * ⚠ 3. A SELECTION HIDDEN BY THE SEARCH IS STILL A SELECTION, AND IS COUNTED
 *      ON SCREEN. Without that line the count appears to drop when the query
 *      narrows, and the operator concludes the tool lost their picks.
 *
 * ⚠ STATE IS CONTROLLED, NOT OWNED — `selected`, `query` and `windowSize` all
 * come from the caller, matching how `SelectionState` already worked. The
 * modal resets its own state on close; moving that in here would make reset
 * timing a new question at exactly the moment this extraction must prove it
 * changed nothing.
 *
 * ⚠ NO FETCHING, EVER. Both callers price their options from data already on
 * the page. `export-status-filter.test.ts` asserts structurally that neither
 * this file nor the scope dialog can reach the network.
 *
 * ─── CHUNK 1 ADDITIONS: SHIFT-CLICK RANGE + THE TWO-TIER COUNTER ───────────
 *
 * ⚠ 4. THE RANGE IS COMPUTED OVER `visible`, AND THAT CHOICE IS THE FEATURE.
 *      `resolveRangeSkus` is handed the RENDERED array, so a range that
 *      reaches past what is on screen is unrepresentable rather than guarded
 *      (§2.1). `item-range-select.structural.test.ts` pins the argument, so
 *      swapping it for `matching` or `items` goes red.
 *
 * ⚠ 5. THE ANCHOR IS OWNED HERE, WHICH BREAKS THE "CONTROLLED" RULE ABOVE ON
 *      PURPOSE. Selection state stays the caller's; the anchor does not,
 *      because only this component knows what is RENDERED, and the anchor's
 *      whole meaning is "a row in the current rendered set". Handing it to the
 *      caller would force the caller to know the rendered set — which is
 *      exactly the knowledge guarantee 4 exists to withhold from it.
 *
 * ⚠ 6. THE BOUNDARY IS RE-DERIVED, NOT WATCHED. The anchor is stored WITH the
 *      page AND page size it was set under, and a resolve under a different
 *      one is refused (M8: a boundary drops the anchor). This is deliberately
 *      not an effect hook watching them: guarantee "NO FETCHING, EVER" is
 *      enforced by a structural test that bans effect hooks in this file
 *      outright, so reaching for one here would trade one guarantee away to
 *      buy another. Re-derivation costs nothing and breaks neither.
 *
 * ⚠ 7. THE COUNTER HAS TWO TIERS AND THE TWO HIDE-REASONS ARE DISJOINT. Total
 *      picks, then picks among the rendered rows. The two "…is hidden" lines
 *      partition the gap: one counts picks the SEARCH hides, the other counts
 *      picks the PAGE hides. They never double-count, so a reader can add them
 *      and land on the total.
 *
 * ─── CHUNK 2: PAGING, AND THE ONE RULE THAT IS NOT APPLE'S ─────────────────
 *
 * ⚠ 8. THE HEADER CHECKBOX IS A FULL TRI-STATE AND *DOES* CLEAR THE PAGE.
 *      ⛔ DO NOT "FIX THIS FOR CONSISTENCY WITH APPLE." Apple's picker rules
 *      that the header checkbox never clears — and that rule is correct THERE
 *      because Apple's picker opens with NOTHING ticked, so the only useful
 *      direction is adding.
 *
 *      Google opens with EVERYTHING ticked (`IapListClient.tsx:199-202`,
 *      deliberate: an operator who clicks straight through gets the pre-X3
 *      export). The operator's actual job is therefore SUBTRACTIVE — "give me
 *      30 of these 200" starts by clearing. Porting Apple's never-clear rule
 *      would delete the single most useful gesture on this surface and leave
 *      the operator un-ticking 170 rows by hand.
 *
 *      Scope still reads from POSITION, which is the part that IS shared with
 *      Apple: the checkbox at the head of the tick column means THIS PAGE, the
 *      labelled button in the toolbar means EVERYTHING MATCHING.
 *
 * ⚠ 9. PAGE / PAGE SIZE / "SELECTED ONLY" ARE OWNED HERE, UNLIKE `query`.
 *      They are view state with no meaning to the caller, and the reset rules
 *      that made `query` controlled do not apply: `computePageMeta` CLAMPS an
 *      out-of-range page, so a narrowing search or filter self-corrects, and
 *      the scope dialog unmounts on close (`ExportScopeDialog.tsx:97`), so
 *      reopening starts at page 1 for free. Lifting them to the caller would
 *      add three props and two reset rules to buy nothing.
 */
import { useState, type ReactNode } from "react";
import { Search } from "lucide-react";

import { computePageMeta } from "@/lib/iap-management/pagination/page-slice";
import { PageNav } from "@/components/ui/iap/PageNav";

import {
  resolveRangeSkus,
  addRangeToSelection,
} from "@/lib/google-iap-management/item-range-select";

import type { IapWithDefaultLocale } from "@/lib/google-iap-management/repository/iaps";

export interface IapSelectionListProps {
  /** Already filtered by the caller's own rules (eligibility, status, …). */
  items: readonly IapWithDefaultLocale[];
  selected: ReadonlySet<string>;
  onToggleOne: (sku: string) => void;
  /** Receives the SKUs currently matching the search — guarantee 1. */
  onToggleAll: (matchingSkus: string[]) => void;
  /** Trailing per-row content. The two callers disagree about it entirely:
   *  the modal shows a status dot keyed to its mode, the picker shows the
   *  item's own status. Sharing the wording would re-create the defect the
   *  extraction avoids. */
  renderTrailing?: (iap: IapWithDefaultLocale) => ReactNode;
  /** Opt-in search. Omit both and no box renders. */
  query?: string;
  onQueryChange?: (q: string) => void;
  /** Opt-in paging (chunk 2). Omit and every matching row renders — which is
   *  what the write path (`BulkStatusModal`) must keep getting, C2. */
  paged?: boolean;
  /** Copy for the select-all row; defaults to the modal's existing string. */
  selectAllLabel?: (matching: number) => string;
  /** Opt-in shift-click ranges. Omit and every tick is a plain tick, which is
   *  what the write path (`BulkStatusModal`) must keep getting — C2. Receives
   *  the WHOLE next selection, already merged, so the caller cannot widen a
   *  range it did not compute. */
  rangeSelect?: boolean;
  onSelectionChange?: (next: Set<string>) => void;
}

/** C4 — Manager's decision. 20/30/50 are the offered sizes; 50 is the default
 *  so an app under 50 items is a single page and the pager stays out of the
 *  way. */
const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [20, 30, 50] as const;

function matches(iap: IapWithDefaultLocale, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return `${iap.default_title ?? ""} ${iap.sku}`.toLowerCase().includes(needle);
}

export function IapSelectionList({
  items,
  selected,
  onToggleOne,
  onToggleAll,
  renderTrailing,
  query,
  onQueryChange,
  paged = false,
  selectAllLabel,
  rangeSelect = false,
  onSelectionChange,
}: IapSelectionListProps) {
  // ⚠ Guarantee 9 — view state, owned here. See the docblock for why this one
  // is not controlled like `query` is.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [selectedOnly, setSelectedOnly] = useState(false);

  const searchable = typeof query === "string" && Boolean(onQueryChange);
  const matching = searchable ? items.filter((i) => matches(i, query!)) : items;

  // ⚠ M3 — the search narrows the WHOLE list, and only then is it paged. The
  // "Selected only" view narrows the same way, so every count below is
  // measured against what the operator asked to look at.
  const inView = paged && selectedOnly
    ? matching.filter((i) => selected.has(i.sku))
    : matching;

  const meta = computePageMeta(inView.length, page, pageSize);
  const visible = paged ? inView.slice(meta.startIndex, meta.endIndex) : inView;

  const matchingSkus = matching.map((i) => i.sku);
  // ⚠ Guarantee 1: "all" is measured against MATCHING, never against VISIBLE.
  const allSelected =
    matching.length > 0 && matchingSkus.every((sku) => selected.has(sku));
  const someSelected = !allSelected && matchingSkus.some((sku) => selected.has(sku));

  // ⚠ Guarantee 3: the total counts every pick, including ones the current
  // query hides. `selected.size`, not a count over `matching`.
  const selectedTotal = selected.size;
  const selectedHiddenByQuery =
    searchable ? selectedTotal - matchingSkus.filter((s) => selected.has(s)).length : 0;

  // ⚠ Guarantee 7, tier 2: picks among the rows ACTUALLY RENDERED. Derived
  // from `visible`, so it drops as the window truncates — that gap is the
  // whole point of the second tier.
  const visibleSkus = visible.map((i) => i.sku);
  const selectedOnScreen = visibleSkus.filter((sku) => selected.has(sku)).length;
  // ⚠ Guarantee 7, disjointness: this counts picks the PAGE hides, measured
  // against MATCHING — never against the whole list — so it cannot overlap
  // `selectedHiddenByQuery`, which counts the ones the SEARCH hides.
  const selectedHiddenByPage =
    matchingSkus.filter((s) => selected.has(s)).length - selectedOnScreen;

  // ⚠ C1 — (B)'s scope is THIS PAGE. Full tri-state: partial fills the page,
  // full CLEARS it. See docblock guarantee 8 before "fixing" this.
  const pageAllSelected =
    visibleSkus.length > 0 && visibleSkus.every((sku) => selected.has(sku));
  const pageSomeSelected =
    !pageAllSelected && visibleSkus.some((sku) => selected.has(sku));

  // ⚠ Guarantee 5/6: the anchor is owned here and carries the `windowSize` it
  // was set under. A resolve under a different window is refused, which is M8
  // ("a boundary drops the anchor") expressed as a re-derivation instead of
  // the effect hook this file is structurally forbidden to have.
  const [anchor, setAnchor] = useState<
    { sku: string; atPage: number; atPageSize: number } | null
  >(null);
  const [rangeRefused, setRangeRefused] = useState(false);

  // ⚠ M8 — the boundary is the PAGE now. Flipping the page OR changing the
  // page size invalidates the anchor, because either one changes which rows a
  // range could legally contain.
  const anchorSku =
    anchor !== null &&
    anchor.atPage === meta.page &&
    anchor.atPageSize === pageSize
      ? anchor.sku
      : null;
  const anchorStamp = { atPage: meta.page, atPageSize: pageSize };

  /** (A) — the labelled TOOLBAR button: scope is EVERYTHING MATCHING. */
  function handleToggleAllMatching() {
    if (!onSelectionChange) return;
    const next = new Set(selected);
    if (allSelected) for (const sku of matchingSkus) next.delete(sku);
    else for (const sku of matchingSkus) next.add(sku);
    onSelectionChange(next);
  }

  /** (B) — the HEADER CHECKBOX: scope is THIS PAGE, full tri-state.
   *
   * ⛔ `pageAllSelected` ⇒ CLEAR the page. This is the deliberate divergence
   * from Apple (docblock guarantee 8): Google opens with everything ticked, so
   * clearing is the operator's first move, not an afterthought. */
  function handleTogglePage() {
    if (!onSelectionChange) return;
    const next = new Set(selected);
    if (pageAllSelected) for (const sku of visibleSkus) next.delete(sku);
    else for (const sku of visibleSkus) next.add(sku);
    onSelectionChange(next);
  }

  /** M9 — changing the page size ANCHORS THE VIEWPORT: the operator keeps
   *  looking at roughly the rows they were looking at. Resetting to page 1
   *  throws away where they had scrolled to, at exactly the moment they were
   *  comparing rows. */
  function handlePageSizeChange(nextSize: number) {
    setPage(Math.floor(meta.startIndex / nextSize) + 1);
    setPageSize(nextSize);
  }

  /** One handler for every row tick, plain or shifted.
   *
   * ⚠ `shiftKey` IS READ OFF `nativeEvent`. React's synthetic `change` event
   * carries no `shiftKey`; the underlying native event for a checkbox click
   * does. The test fires a change with a shifted nativeEvent and asserts a
   * range forms — that assertion IS the measurement, not a comment.
   *
   * ⚠ Keyboard activation (Space) produces a nativeEvent with no `shiftKey`,
   * which is falsy, which is a plain tick. Shift+Space is not a range gesture
   * and is not being invented here. */
  function handleRowToggle(sku: string, shiftKey: boolean) {
    if (rangeSelect && shiftKey && onSelectionChange) {
      // ⚠ §2.1 — `visibleSkus`, NEVER `matchingSkus` or `items`. The range is
      // computed over what is on screen, so reaching past it is
      // unrepresentable rather than clamped.
      const rangeSkus = resolveRangeSkus(visibleSkus, anchorSku, sku);
      if (rangeSkus !== null) {
        onSelectionChange(addRangeToSelection(selected, rangeSkus));
        // ⚠ The anchor does NOT move to the target — Gmail keeps it, so a
        // second shift-click re-aims the same range instead of chaining.
        setRangeRefused(false);
        return;
      }
      // No usable anchor: a plain tick, and SAY SO (M8 — never a silent
      // degrade).
      setRangeRefused(true);
      setAnchor({ sku, ...anchorStamp });
      onToggleOne(sku);
      return;
    }
    setRangeRefused(false);
    if (rangeSelect) setAnchor({ sku, ...anchorStamp });
    onToggleOne(sku);
  }

  return (
    <>
      {searchable && (
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange!(e.target.value)}
            placeholder="Search by SKU or name…"
            aria-label="Search items"
            className="w-full rounded-lg border border-slate-300 pl-8 pr-3 py-2 text-[13px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition"
          />
        </div>
      )}

      {/* ⚠ M7 — SCOPE IS READ FROM POSITION. (A) is a labelled BUTTON in the
          toolbar and means everything matching; (B) is the CHECKBOX at the head
          of the tick column and means this page. Same wording on both would
          make the operator remember which is which instead of see it. */}
      {paged && (
        <div className="flex items-center gap-2 flex-wrap mb-2.5">
          <button
            type="button"
            onClick={handleToggleAllMatching}
            data-testid="select-all-matching"
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11.5px] font-medium text-emerald-700 hover:bg-emerald-100 transition"
          >
            {allSelected
              ? `Clear all ${matching.length}`
              : `Select all ${matching.length} matching`}
          </button>
          <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-slate-200">
            {([false, true] as const).map((mode) => (
              <button
                key={String(mode)}
                type="button"
                onClick={() => {
                  setSelectedOnly(mode);
                  setPage(1);
                }}
                data-testid={mode ? "view-selected" : "view-all"}
                className={`px-2.5 py-1 text-[11px] transition ${
                  selectedOnly === mode
                    ? "bg-emerald-600 font-semibold text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {mode ? `Selected (${selectedTotal})` : "All"}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pb-2 border-b border-slate-200 mb-2">
        <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={paged ? pageAllSelected : allSelected}
            ref={(el) => {
              if (el) el.indeterminate = paged ? pageSomeSelected : someSelected;
            }}
            onChange={() => (paged ? handleTogglePage() : onToggleAll(matchingSkus))}
            className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
            aria-label={paged ? "Select all on this page" : "Select all"}
          />
          {paged
            ? pageAllSelected
              ? `Clear ${visibleSkus.length} on this page`
              : `Select all ${visibleSkus.length} on this page`
            : (selectAllLabel ?? ((n: number) => `Select all (${n})`))(
                matching.length,
              )}
        </label>
        {/* ⚠ Guarantee 7 — TWO TIERS. Collapsing these into one number is the
            mutation this design exists to fail: with Google's tick-everything
            default (C3) the total and the on-screen count routinely disagree,
            and one number cannot be both. */}
        {rangeSelect || paged ? (
          <span className="text-right text-[10.5px] leading-tight tabular-nums">
            <span className="block text-[11px] font-bold text-emerald-700">
              {selectedTotal} selected
            </span>
            <span className="block text-slate-400" data-testid="tier-on-screen">
              {selectedOnScreen} of {visibleSkus.length} on this page
            </span>
          </span>
        ) : (
          <span className="text-[11px] text-slate-400">{selectedTotal} selected</span>
        )}
      </div>

      {searchable && selectedHiddenByQuery > 0 && (
        <p className="text-[11px] text-slate-500 mb-2">
          {selectedHiddenByQuery} selected item
          {selectedHiddenByQuery === 1 ? " is" : "s are"} hidden by the current
          search — still selected, still exported.
        </p>
      )}

      {/* ⚠ Guarantee 7 — the WINDOW's share of the gap, named separately from
          the SEARCH's share above so the two add up to the total. Says
          "shown", not "on this page": chunk 1 has a window, not pages, and a
          hint that promises a control which does not exist yet is worse than
          a hint whose wording differs from the mockup. */}
      {(rangeSelect || paged) && selectedHiddenByPage > 0 && (
        <p className="text-[11px] text-slate-500 mb-2" data-testid="hidden-by-page">
          {selectedHiddenByPage} selected item
          {selectedHiddenByPage === 1 ? " is" : "s are"} not on this page —
          still selected, still exported.
        </p>
      )}

      {/* M8 — a shift-click that could not form a range degrades to a plain
          tick, and that degrade is ANNOUNCED. */}
      {rangeSelect && rangeRefused && (
        <p
          className="text-[11px] mb-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-emerald-700"
          data-testid="range-hint"
        >
          Shift-click selects a range from the last row you ticked, within the
          rows shown. Ticked this one on its own.
        </p>
      )}

      <ul className="divide-y divide-slate-100">
        {visible.map((iap) => {
          const checked = selected.has(iap.sku);
          return (
            <li key={iap.sku} className="flex items-center gap-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) =>
                  handleRowToggle(
                    iap.sku,
                    Boolean((e.nativeEvent as MouseEvent).shiftKey),
                  )
                }
                className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer flex-shrink-0"
                aria-label={`Select ${iap.sku}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-slate-800 font-medium truncate">
                  {iap.default_title ?? (
                    <span className="text-slate-400 italic">— no title —</span>
                  )}
                </p>
                <p className="font-mono text-[11px] text-slate-500 truncate">
                  {iap.sku}
                </p>
              </div>
              {renderTrailing?.(iap)}
            </li>
          );
        })}
      </ul>

      {searchable && matching.length === 0 && (
        <p className="py-6 text-center text-[13px] text-slate-400 italic">
          No items match “{query}”.
        </p>
      )}

      {/* ⚠ C4 — the bar renders even on a SINGLE page, because the Rows
          selector lives in it and must stay reachable. `PageNav` hides only
          the prev/next cluster on its own (`PageNav.tsx:75`), so a small app
          gets the selector with no dead arrows beside it. */}
      {paged && (
        <div className="-mx-1 mt-2 overflow-hidden rounded-lg border border-slate-200">
          <PageNav
            meta={meta}
            onPageChange={setPage}
            dense
            summary={
              inView.length === 0
                ? "Nothing to show"
                : `Showing ${meta.displayStart}–${meta.displayEnd} of ${inView.length}${
                    selectedOnly ? " selected" : ""
                  }`
            }
            leading={
              /* ⚠ C4 — Rows selector sits in the RIGHT cluster, immediately
                 BEFORE Prev. `PageNav.leading` is exactly that slot. */
              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
                Rows
                <select
                  value={pageSize}
                  onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                  aria-label="Rows per page"
                  className="rounded-md border border-slate-200 bg-white px-1 py-0.5 text-[11px] text-slate-700"
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
        </div>
      )}
    </>
  );
}
