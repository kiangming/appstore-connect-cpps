/**
 * Pure pagination helper for client-side list slicing. Lifted out of
 * IapListClient (IAP.o.7b) so the index math is unit-testable independently
 * of React/jsdom — the component owns state and rendering, this owns math.
 *
 * Behaviour:
 *  - `requestedPage` is CLAMPED to `[1, totalPages]`. The component renders
 *    using the returned `page`, not the raw request. This is how filter
 *    changes that shrink the list below the current page are handled
 *    gracefully without the caller needing to recompute first.
 *  - `total === 0` yields `totalPages === 1` (single empty page) and
 *    `displayStart/End === 0` so the "Showing 0 of 0" copy reads naturally.
 *  - `displayStart`/`displayEnd` are 1-based for UI display; `startIndex`/
 *    `endIndex` are 0-based for `Array.prototype.slice` consumption.
 */

export interface PageMeta {
  /** Clamped page number, always in [1, totalPages]. */
  page: number;
  totalPages: number;
  /** 0-based slice start (for `array.slice(startIndex, endIndex)`). */
  startIndex: number;
  /** 0-based slice end (exclusive). */
  endIndex: number;
  /** 1-based display start ("Showing X of Y"); 0 when list is empty. */
  displayStart: number;
  /** 1-based display end (inclusive); 0 when list is empty. */
  displayEnd: number;
}

export function computePageMeta(
  total: number,
  requestedPage: number,
  pageSize: number,
): PageMeta {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), totalPages);
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, total);
  return {
    page,
    totalPages,
    startIndex,
    endIndex,
    displayStart: total === 0 ? 0 : startIndex + 1,
    displayEnd: endIndex,
  };
}
