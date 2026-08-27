// @vitest-environment jsdom

/**
 * G3.3 — THE WITH-PROP PATH, WHICH HAD NO COVERAGE AT ALL.
 *
 * The 13 tests in `ExportOptionsDialog.test.tsx` all render without the new
 * `catalog` prop, so they pin the DEFAULT (Google's 183) and are untouched by
 * G3 — deliberately, that is the hard gate. But they say nothing about what
 * happens when a caller supplies its own list, and the Apple export now does.
 *
 * ⚠ THE FAILURE THIS FILE EXISTS TO CATCH is not "the list is wrong". It is
 * the dialog DISAGREEING WITH ITSELF: the picker was reading the module
 * constant in five separate places, and moving four of them to the prop still
 * looks perfect on screen while "Select all" quietly ticks 183 countries in a
 * 175-country picker. Eight of those are markets Apple does not sell in, and
 * they would sail into the export as columns nobody asked for.
 *
 * So the assertions below deliberately cross-check what is DISPLAYED against
 * what is SELECTED, rather than checking either alone.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { ExportOptionsDialog } from "./ExportOptionsDialog";
import { APPLE_TERRITORY_CATALOG } from "@/lib/iap-management/apple/apple-territory-catalog";
import { ALL_TERRITORY_CODES } from "@/lib/iap-management/territory-catalog";

const APPLE_N = APPLE_TERRITORY_CATALOG.length; // 175
const SHARED_N = ALL_TERRITORY_CODES.length; // 183

function renderApple(onExport = vi.fn()) {
  render(
    <ExportOptionsDialog
      open
      catalog={APPLE_TERRITORY_CATALOG}
      onCancel={vi.fn()}
      onExport={onExport}
    />,
  );
  return onExport;
}

describe("ExportOptionsDialog — given Apple's catalog", () => {
  it("the two lists really do differ, or this whole file proves nothing", () => {
    // ⚠ The vacuity guard. If Apple's list ever equalled the shared one, every
    // assertion below would pass while testing the default path.
    expect(APPLE_N).toBe(175);
    expect(SHARED_N).toBe(183);
    expect(APPLE_N).not.toBe(SHARED_N);
  });

  it("shows 175 selected of 175 — not the shared 183", () => {
    renderApple();
    expect(
      screen.getByText(`${APPLE_N} of ${APPLE_N} selected`),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(`${SHARED_N} of ${SHARED_N} selected`),
    ).not.toBeInTheDocument();
  });

  it("the Export button counts Apple's markets", () => {
    renderApple();
    expect(
      screen.getByRole("button", { name: `Export ${APPLE_N} countries` }),
    ).toBeInTheDocument();
  });

  it("⚠ MUTATION (b) — `Select all` ticks 175, not 183", () => {
    // THE ASSERTION THAT CATCHES A HALF-MIGRATED DIALOG. Untick one country,
    // press Select all, and the counter must return to Apple's total. If
    // `selectAll` still read ALL_TERRITORY_CODES it would read 183 here — in
    // a picker showing 175 — and the eight extras would be invisible on
    // screen and very much present in the payload.
    const onExport = renderApple();
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]);
    expect(
      screen.getByText(`${APPLE_N - 1} of ${APPLE_N} selected`),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /select all/i }));
    expect(
      screen.getByText(`${APPLE_N} of ${APPLE_N} selected`),
    ).toBeInTheDocument();

    // …and the payload agrees with the counter: all-selected ⇒ null.
    fireEvent.click(screen.getByRole("button", { name: /^Export/ }));
    expect(onExport).toHaveBeenCalledWith(null);
  });

  it("⚠ a partial selection carries EXACTLY the codes shown, never 183 of them", () => {
    // The other half of MUTATION (b): the counter could be right while the
    // payload is built from the wrong list.
    const onExport = renderApple();
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Export/ }));

    const payload = onExport.mock.calls[0][0] as string[];
    expect(payload).not.toBeNull();
    expect(payload).toHaveLength(APPLE_N - 1);
    const appleCodes = new Set(APPLE_TERRITORY_CATALOG.map((t) => t.code));
    const strays = payload.filter((c) => !appleCodes.has(c));
    expect(strays).toEqual([]);
  });

  it("all-selected still sends null — the shared contract is not changed by the prop", () => {
    const onExport = renderApple();
    fireEvent.click(screen.getByRole("button", { name: /^Export/ }));
    expect(onExport).toHaveBeenCalledWith(null);
  });

  it("⚠ MUTATION (d) — RUSSIA is tickable, for the first time", () => {
    // RU is in Apple's list and has never been in TERRITORY_CATALOG, so this
    // is only reachable through the prop. Ticking everything-but-RU proves it
    // is a real, selectable row rather than a label.
    const onExport = renderApple();
    const ru = screen.getByLabelText(/Russia/i);
    expect(ru).toBeInTheDocument();
    fireEvent.click(ru);
    fireEvent.click(screen.getByRole("button", { name: /^Export/ }));
    const payload = onExport.mock.calls[0][0] as string[];
    expect(payload).not.toContain("RU");
    expect(payload).toHaveLength(APPLE_N - 1);
  });

  it("⚠ MUTATION (c) — the 19 markets Apple does not sell to are ABSENT", () => {
    renderApple();
    // Andorra and Monaco are in the shared catalog and not in Apple's list.
    expect(screen.queryByLabelText(/Andorra/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Monaco/i)).not.toBeInTheDocument();
    // …while a market both lists carry is still there.
    expect(screen.getByLabelText(/Vietnam/i)).toBeInTheDocument();
  });

  it("⚠ currency shown is APPLE'S — Bulgaria reads EUR, not BGN", () => {
    // The same country reads BGN in the Google picker. That is correct: each
    // module shows the currency its own store bills in (KB §4.19).
    renderApple();
    const bg = screen.getByLabelText(/Bulgaria/i).closest("label")!;
    expect(within(bg).getByText(/BG · EUR/)).toBeInTheDocument();
  });

  it("Clear all then Select all returns to Apple's total, not the shared one", () => {
    renderApple();
    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));
    expect(screen.getByText(`0 of ${APPLE_N} selected`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /select all/i }));
    expect(
      screen.getByText(`${APPLE_N} of ${APPLE_N} selected`),
    ).toBeInTheDocument();
  });

  it("⚠ MUTATION (a) — the DEFAULT is still the shared 183, so Google is untouched", () => {
    // Rendered exactly the way Google renders it: three props, no catalog.
    // If the default were ever changed to Apple's list, Google's picker would
    // silently lose 19 markets and gain 11 it may not sell in.
    render(<ExportOptionsDialog open onCancel={vi.fn()} onExport={vi.fn()} />);
    expect(
      screen.getByText(`${SHARED_N} of ${SHARED_N} selected`),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Andorra/i)).toBeInTheDocument();
  });
});
