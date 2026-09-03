"use client";

/**
 * The ONE pagination control for this module. Presentational — it owns no
 * state and does no arithmetic.
 *
 * Design: docs/iap-management/design-export-picker-paging-range.md §2.8.
 *
 * ⚠ EXTRACTED BEFORE THE SECOND COPY EXISTED, WHICH IS THE ONLY TIME IT IS
 * CHEAP. The IAP list page had this as inline JSX
 * (`IapListClient.tsx`, pre-Y2 :948-999) and Y2 needed the same bar inside the
 * export picker. Writing it twice would have produced two disabled rules, two
 * "Showing X–Y of Z" wordings and two hidden-when-single-page rules for one
 * behaviour — P1 twin-path, drifting apart at the first fix. The same
 * reasoning `BulkItemPicker` records for itself at its :7-11.
 *
 * ⚠ THE MATH IS NOT HERE AND MUST NOT MOVE HERE. `computePageMeta`
 * (`lib/iap-management/pagination/page-slice.ts`) is already shared by four
 * consumers and is separately unit-tested; this component takes its OUTPUT.
 * A `PageNav` that computed its own indices would be the second implementation
 * the design forbade.
 *
 * ⚠ IT DOES NOT HIDE ITSELF WHEN THERE IS ONE PAGE — the CALLER decides
 * whether to render it at all. That split is deliberate and load-bearing:
 *   • the list page renders it only when `totalPages > 1`, which is exactly
 *     what it did before the extraction, so small apps stay visually clean;
 *   • the picker renders it ALWAYS, because the Rows selector lives in this
 *     bar and must stay reachable on a single-page list.
 * Only the prev/next cluster hides on its own, since disabled arrows beside
 * "Page 1 of 1" are noise on any surface.
 */

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import type { PageMeta } from "@/lib/iap-management/pagination/page-slice";

export interface PageNavProps {
  meta: PageMeta;
  onPageChange: (next: number) => void;
  /** The "Showing …" line. Callers differ — the list page appends
   *  "(filtered from N)" and the picker names the selection view — so the
   *  sentence is theirs, not this component's. */
  summary: ReactNode;
  /** Rendered immediately before the prev/next cluster. The picker puts its
   *  Rows selector here; the list page passes nothing (Q4 — the two surfaces
   *  are deliberately asymmetric, see the picker for why). */
  leading?: ReactNode;
  /** Tightens the bar for use inside a dialog rather than under a table. */
  dense?: boolean;
}

export function PageNav({
  meta,
  onPageChange,
  summary,
  leading,
  dense = false,
}: PageNavProps) {
  const atStart = meta.page <= 1;
  const atEnd = meta.page >= meta.totalPages;
  const btn =
    "inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div
      data-testid="page-nav"
      className={`flex items-center justify-between gap-3 flex-wrap border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 ${
        dense ? "px-3.5 py-2" : "px-4 py-2.5"
      }`}
    >
      <p className="text-xs text-slate-500 dark:text-slate-400">{summary}</p>
      <div className="flex items-center gap-2">
        {leading}
        {meta.totalPages > 1 && (
          <>
            <button
              type="button"
              onClick={() => onPageChange(meta.page - 1)}
              disabled={atStart}
              className={btn}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </button>
            <span
              className="text-xs text-slate-500 dark:text-slate-400 tabular-nums"
              data-testid="page-nav-position"
            >
              Page{" "}
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {meta.page}
              </span>{" "}
              of{" "}
              <span className="font-medium text-slate-700 dark:text-slate-200">
                {meta.totalPages}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onPageChange(meta.page + 1)}
              disabled={atEnd}
              className={btn}
              aria-label="Next page"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
