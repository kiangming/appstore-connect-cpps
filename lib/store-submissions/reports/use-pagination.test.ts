// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_SIZE, usePagination } from './use-pagination';

describe('usePagination', () => {
  it('starts on page 0 with a fresh array', () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    const { result } = renderHook(() => usePagination(items));
    expect(result.current.currentPage).toBe(0);
    expect(result.current.pagedItems).toEqual([0, 1, 2, 3, 4]);
    expect(result.current.totalItems).toBe(5);
    expect(result.current.totalPages).toBe(1);
  });

  it('slices items into pages of `pageSize` (default 20)', () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    const { result } = renderHook(() => usePagination(items));
    expect(result.current.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(result.current.totalPages).toBe(3);
    expect(result.current.pagedItems).toHaveLength(20);
    expect(result.current.pagedItems[0]).toBe(0);
    expect(result.current.pagedItems[19]).toBe(19);
  });

  it('goToNext advances and clamps at the last page', () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    const { result } = renderHook(() => usePagination(items));

    act(() => result.current.goToNext());
    expect(result.current.currentPage).toBe(1);
    expect(result.current.pagedItems[0]).toBe(20);

    act(() => result.current.goToNext());
    expect(result.current.currentPage).toBe(2);
    expect(result.current.pagedItems[0]).toBe(40);
    expect(result.current.pagedItems).toHaveLength(5); // last partial page

    // Already at last page — goToNext is a no-op.
    act(() => result.current.goToNext());
    expect(result.current.currentPage).toBe(2);
    expect(result.current.hasNext).toBe(false);
  });

  it('goToPrev rewinds and clamps at page 0', () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    const { result } = renderHook(() => usePagination(items));

    act(() => result.current.goToNext());
    act(() => result.current.goToNext());
    expect(result.current.currentPage).toBe(2);

    act(() => result.current.goToPrev());
    expect(result.current.currentPage).toBe(1);

    act(() => result.current.goToPrev());
    expect(result.current.currentPage).toBe(0);
    expect(result.current.hasPrev).toBe(false);

    // Already at page 0 — goToPrev is a no-op.
    act(() => result.current.goToPrev());
    expect(result.current.currentPage).toBe(0);
  });

  it('resets to page 0 when items identity changes (filter/refetch)', () => {
    const initial = Array.from({ length: 45 }, (_, i) => i);
    const replaced = Array.from({ length: 30 }, (_, i) => 100 + i);
    const { result, rerender } = renderHook(
      ({ items }: { items: number[] }) => usePagination(items),
      { initialProps: { items: initial } },
    );

    act(() => result.current.goToNext());
    act(() => result.current.goToNext());
    expect(result.current.currentPage).toBe(2);

    rerender({ items: replaced });
    expect(result.current.currentPage).toBe(0);
    expect(result.current.pagedItems[0]).toBe(100);
  });

  it('clamps currentPage when totalItems shrinks below it', () => {
    // Caller passes the same reference but length effectively reduced via
    // a wrapping component — the identity reset will hit, but clamp also
    // protects intermediate renders.
    const shrunk = Array.from({ length: 10 }, (_, i) => i);
    const { result } = renderHook(
      ({ items }: { items: number[] }) => usePagination(items),
      { initialProps: { items: shrunk } },
    );
    // totalPages = 1 (Math.max(1, ceil(10/20)) = 1) → safePage clamps to 0
    expect(result.current.currentPage).toBe(0);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.hasNext).toBe(false);
  });

  it('shouldRenderControls = false at 20 items (threshold)', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const { result } = renderHook(() => usePagination(items));
    expect(result.current.totalItems).toBe(20);
    expect(result.current.shouldRenderControls).toBe(false);
  });

  it('shouldRenderControls = true at 21 items (above threshold)', () => {
    const items = Array.from({ length: 21 }, (_, i) => i);
    const { result } = renderHook(() => usePagination(items));
    expect(result.current.totalItems).toBe(21);
    expect(result.current.shouldRenderControls).toBe(true);
    expect(result.current.totalPages).toBe(2);
  });

  it('handles empty array (no controls, page 0, empty paged slice)', () => {
    const { result } = renderHook(() => usePagination<number>([]));
    expect(result.current.currentPage).toBe(0);
    expect(result.current.pagedItems).toEqual([]);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.shouldRenderControls).toBe(false);
    expect(result.current.hasPrev).toBe(false);
    expect(result.current.hasNext).toBe(false);
  });

  it('goToPage clamps out-of-range targets', () => {
    const items = Array.from({ length: 45 }, (_, i) => i);
    const { result } = renderHook(() => usePagination(items));

    act(() => result.current.goToPage(99));
    expect(result.current.currentPage).toBe(2); // clamped to last

    act(() => result.current.goToPage(-5));
    expect(result.current.currentPage).toBe(0); // clamped to first
  });

  it('respects a custom pageSize argument', () => {
    const items = Array.from({ length: 11 }, (_, i) => i);
    const { result } = renderHook(() => usePagination(items, 5));
    expect(result.current.pageSize).toBe(5);
    expect(result.current.totalPages).toBe(3);
    expect(result.current.shouldRenderControls).toBe(true);
  });
});
