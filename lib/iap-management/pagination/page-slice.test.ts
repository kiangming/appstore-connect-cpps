/**
 * Unit tests for the IAP list page-slice math (IAP.o.7b). Edge cases here
 * mirror the failure modes Manager hit during MV30 once IAP.o.7a unblocked
 * the full Apple list — apps with >200 IAPs were silently truncated, so the
 * client-side pagination needs to handle large lists, filter-induced page
 * shrinkage, and empty states cleanly.
 */

import { describe, it, expect } from "vitest";
import { computePageMeta } from "./page-slice";

describe("computePageMeta", () => {
  it("empty list collapses to a single empty page (Showing 0 of 0)", () => {
    const meta = computePageMeta(0, 1, 100);
    expect(meta).toEqual({
      page: 1,
      totalPages: 1,
      startIndex: 0,
      endIndex: 0,
      displayStart: 0,
      displayEnd: 0,
    });
  });

  it("list smaller than page size fits in one page", () => {
    const meta = computePageMeta(42, 1, 100);
    expect(meta.totalPages).toBe(1);
    expect(meta.startIndex).toBe(0);
    expect(meta.endIndex).toBe(42);
    expect(meta.displayStart).toBe(1);
    expect(meta.displayEnd).toBe(42);
  });

  it("list exactly page size is still one page", () => {
    const meta = computePageMeta(100, 1, 100);
    expect(meta.totalPages).toBe(1);
    expect(meta.endIndex).toBe(100);
    expect(meta.displayEnd).toBe(100);
  });

  it("list of page size + 1 needs two pages", () => {
    const meta = computePageMeta(101, 1, 100);
    expect(meta.totalPages).toBe(2);
    expect(meta.endIndex).toBe(100);

    const page2 = computePageMeta(101, 2, 100);
    expect(page2.startIndex).toBe(100);
    expect(page2.endIndex).toBe(101);
    expect(page2.displayStart).toBe(101);
    expect(page2.displayEnd).toBe(101);
  });

  it("last page is partial when total is not a multiple of pageSize", () => {
    const meta = computePageMeta(250, 3, 100);
    expect(meta.totalPages).toBe(3);
    expect(meta.startIndex).toBe(200);
    expect(meta.endIndex).toBe(250);
    expect(meta.displayStart).toBe(201);
    expect(meta.displayEnd).toBe(250);
  });

  it("requested page beyond totalPages clamps to the last page", () => {
    // Mirrors the filter-induced shrinkage scenario: Manager was on page 5,
    // applied a filter that reduced total to 80 → page 5 doesn't exist any
    // more, must clamp to page 1.
    const meta = computePageMeta(80, 5, 100);
    expect(meta.page).toBe(1);
    expect(meta.totalPages).toBe(1);
    expect(meta.startIndex).toBe(0);
    expect(meta.endIndex).toBe(80);
  });

  it("requested page < 1 clamps up to page 1", () => {
    const meta = computePageMeta(50, 0, 100);
    expect(meta.page).toBe(1);
  });

  it("requested page is NaN or non-finite clamps to page 1", () => {
    expect(computePageMeta(50, NaN, 100).page).toBe(1);
    expect(computePageMeta(50, -3, 100).page).toBe(1);
  });

  it("requested page is fractional rounds down via Math.floor before clamping", () => {
    const meta = computePageMeta(300, 2.7, 100);
    expect(meta.page).toBe(2);
    expect(meta.startIndex).toBe(100);
  });

  it("handles realistic >200 IAP app (Manager MV30 scenario)", () => {
    // Manager's app: 450 IAPs. Page 100/page → 5 pages.
    const meta = computePageMeta(450, 5, 100);
    expect(meta.totalPages).toBe(5);
    expect(meta.startIndex).toBe(400);
    expect(meta.endIndex).toBe(450);
    expect(meta.displayStart).toBe(401);
    expect(meta.displayEnd).toBe(450);
  });
});
