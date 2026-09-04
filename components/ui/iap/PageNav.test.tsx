// @vitest-environment jsdom
/**
 * [Y2] THE SHARED PAGINATION CONTROL — AND IT WAS UNGUARDED BEFORE THIS FILE.
 *
 * ⚠ The IAP list page's pagination footer had NO test of its own: a grep for
 * the footer's own strings across `app/(dashboard)/iap-management` found only
 * the bulk-import wizard's unrelated "Next" step button. So extracting it into
 * a shared component had nothing to fail if the extraction changed behaviour —
 * which is the worst possible condition for a refactor whose whole point is
 * that two surfaces now share one control.
 *
 * These tests pin the behaviours the inline footer had, so the SECOND consumer
 * (the export picker) cannot quietly change them for the first.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { PageNav } from "./PageNav";
import { computePageMeta } from "@/lib/iap-management/pagination/page-slice";

function setup(total: number, page: number, pageSize: number) {
  const onPageChange = vi.fn();
  const meta = computePageMeta(total, page, pageSize);
  render(
    <PageNav
      meta={meta}
      onPageChange={onPageChange}
      summary={`Showing ${meta.displayStart}–${meta.displayEnd} of ${total}`}
    />,
  );
  return { onPageChange, meta };
}

describe("the arithmetic is NOT here — it takes computePageMeta's output", () => {
  it("renders the position it was handed", () => {
    setup(220, 3, 100);
    expect(screen.getByTestId("page-nav-position").textContent).toContain("3");
    expect(screen.getByTestId("page-nav-position").textContent).toContain("of 3");
  });

  it("renders the caller's summary sentence verbatim — the wording is theirs", () => {
    setup(220, 1, 100);
    expect(screen.getByText("Showing 1–100 of 220")).toBeInTheDocument();
  });
});

describe("prev/next — the disabled rules the inline footer had", () => {
  it("Prev is disabled on the first page", () => {
    setup(220, 1, 100);
    expect(screen.getByLabelText("Previous page")).toBeDisabled();
    expect(screen.getByLabelText("Next page")).not.toBeDisabled();
  });

  it("Next is disabled on the last page", () => {
    setup(220, 3, 100);
    expect(screen.getByLabelText("Next page")).toBeDisabled();
    expect(screen.getByLabelText("Previous page")).not.toBeDisabled();
  });

  it("asks for the neighbouring page, never mutates anything itself", () => {
    const { onPageChange } = setup(220, 2, 100);
    fireEvent.click(screen.getByLabelText("Next page"));
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByLabelText("Previous page"));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });
});

describe("⚠ the single-page rule is SPLIT, on purpose", () => {
  /**
   * The prev/next cluster hides itself — disabled arrows next to "Page 1 of 1"
   * are noise anywhere. But the BAR still renders, because the picker's Rows
   * selector lives in it and must stay reachable on a one-page list. The list
   * page keeps its own `totalPages > 1 &&` guard so it shows nothing at all,
   * exactly as it did before the extraction.
   *
   * ⚠ MUTATION: move the whole-bar hide inside this component. The picker
   * would lose its Rows selector on short lists — and `leading` below goes
   * missing, so this test goes red.
   */
  it("hides prev/next on a single page but still renders the bar and its leading slot", () => {
    render(
      <PageNav
        meta={computePageMeta(12, 1, 50)}
        onPageChange={vi.fn()}
        summary="Showing 1–12 of 12"
        leading={<span data-testid="rows-slot">Rows</span>}
      />,
    );
    expect(screen.getByTestId("page-nav")).toBeInTheDocument();
    expect(screen.getByTestId("rows-slot")).toBeInTheDocument();
    expect(screen.queryByLabelText("Next page")).toBeNull();
    expect(screen.queryByTestId("page-nav-position")).toBeNull();
  });

  /**
   * ⚠ [Y3] THE ASSERTION WHOSE ABSENCE LET TWO REPORTS DISAGREE.
   *
   * Two arbitration write-ups gave different answers for WHERE the Rows
   * selector sits — one said footer-left, one said footer-right-before-Prev —
   * and the tests could not settle it, because they pinned the control's
   * IDENTITY (`<select>`, 20/30/50) and its CONTAINMENT (inside `page-nav`)
   * and never its ORDER. A position that nothing asserts is a position that
   * gets described from memory.
   *
   * ⚠ MUTATION: move `{leading}` after the prev/next cluster in PageNav, or
   * into the summary `<p>` on the left. This goes red.
   */
  it("⚠ `leading` sits in the RIGHT cluster, BEFORE Prev — order, not just presence", () => {
    render(
      <PageNav
        meta={computePageMeta(220, 2, 100)}
        onPageChange={vi.fn()}
        summary={<span data-testid="sum">Showing 101–200 of 220</span>}
        leading={<span data-testid="rows-slot">Rows</span>}
      />,
    );
    const bar = screen.getByTestId("page-nav");
    const order = [...bar.querySelectorAll("[data-testid], [aria-label]")]
      .map(
        (el) =>
          el.getAttribute("data-testid") ?? el.getAttribute("aria-label"),
      )
      .filter(
        (t): t is string =>
          t === "sum" ||
          t === "rows-slot" ||
          t === "Previous page" ||
          t === "page-nav-position" ||
          t === "Next page",
      );
    expect(order).toEqual([
      "sum",
      "rows-slot",
      "Previous page",
      "page-nav-position",
      "Next page",
    ]);
  });

  it("an empty list is a single empty page, not a crash", () => {
    render(
      <PageNav
        meta={computePageMeta(0, 1, 20)}
        onPageChange={vi.fn()}
        summary="Showing 0–0 of 0"
      />,
    );
    expect(screen.getByTestId("page-nav")).toBeInTheDocument();
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });
});
