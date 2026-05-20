'use client';

/**
 * IAP.q.3.I — pagination footer for Reports surfaces (Top Apple
 * Guidelines main list + UnparseableFooter expansion). Visual treatment
 * is intentionally subtle: thin top border, small-caps mono indicator
 * ("Page 1 of 5 · 87 items total"), Apple-styled Prev/Next buttons.
 *
 * Always-render contract: the parent decides whether to mount this at
 * all (via `usePagination`'s `shouldRenderControls`). This component
 * does not gate itself — keeps render logic in one place upstream.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface PaginationControlsProps {
  /** 0-indexed current page; UI displays as page+1. */
  currentPage: number;
  totalPages: number;
  totalItems: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

export function PaginationControls({
  currentPage,
  totalPages,
  totalItems,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: PaginationControlsProps) {
  return (
    <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between gap-3">
      <span className="text-[11px] text-slate-500 tabular-nums">
        Page {currentPage + 1} of {totalPages}
        <span className="text-slate-400"> · </span>
        {totalItems} item{totalItems === 1 ? '' : 's'} total
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasPrev}
          aria-label="Previous page"
          className="inline-flex items-center gap-0.5 px-2 py-1 text-[11.5px] font-medium rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft className="h-3 w-3" strokeWidth={2} />
          Prev
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!hasNext}
          aria-label="Next page"
          className="inline-flex items-center gap-0.5 px-2 py-1 text-[11.5px] font-medium rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Next
          <ChevronRight className="h-3 w-3" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
