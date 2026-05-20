'use client';

/**
 * IAP.q.3.I — client-side offset pagination hook for Reports surfaces.
 *
 * Sized for the Apple Reports usage pattern: arrays already in memory
 * (date-window prefiltered server-side), static during a render cycle,
 * deterministic order. No URL state, no remote fetch — just a slice +
 * page-state useState wrapped in a stable API.
 *
 * Identity-based reset contract: when the caller passes a new `items`
 * reference, page resets to 0. This is the explicit signal that "the
 * underlying data changed" (date range, filter, etc.). Callers MUST
 * pass stable references between renders when the data hasn't changed
 * — typically satisfied by reading directly from a Server-Component-
 * derived props object (e.g. `result.guidelines`). If the caller
 * synthesizes the array via `.filter()` each render, identity flips
 * every render and pagination is unusable; memoize first.
 *
 * Clamp behavior: if `currentPage` is past the last page (e.g. caller
 * filters items down while user is on page 3), the returned
 * `currentPage` reflects the safe clamped value via `Math.min`.
 * Internal state isn't mutated — the next user action (Prev/Next/
 * goToPage) commits the clamped value. This avoids a stale
 * out-of-bounds render flicker.
 */

import { useEffect, useState } from 'react';

export const DEFAULT_PAGE_SIZE = 20;

export interface UsePaginationResult<T> {
  /** 0-indexed; safe-clamped to `[0, totalPages-1]` when totalPages > 0. */
  currentPage: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
  pagedItems: T[];
  /** True when `totalItems > pageSize`. UI hides controls below this. */
  shouldRenderControls: boolean;
  goToPage: (page: number) => void;
  goToPrev: () => void;
  goToNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}

export function usePagination<T>(
  items: T[],
  pageSize: number = DEFAULT_PAGE_SIZE,
): UsePaginationResult<T> {
  const [currentPage, setCurrentPage] = useState(0);

  useEffect(() => {
    setCurrentPage(0);
  }, [items]);

  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const shouldRenderControls = totalItems > pageSize;
  const safePage = Math.min(currentPage, totalPages - 1);

  const start = safePage * pageSize;
  const end = start + pageSize;
  const pagedItems = items.slice(start, end);

  return {
    currentPage: safePage,
    pageSize,
    totalPages,
    totalItems,
    pagedItems,
    shouldRenderControls,
    goToPage: (page) =>
      setCurrentPage(Math.max(0, Math.min(page, totalPages - 1))),
    goToPrev: () => setCurrentPage((p) => Math.max(0, p - 1)),
    goToNext: () =>
      setCurrentPage((p) => Math.min(p + 1, totalPages - 1)),
    hasPrev: safePage > 0,
    hasNext: safePage < totalPages - 1,
  };
}
