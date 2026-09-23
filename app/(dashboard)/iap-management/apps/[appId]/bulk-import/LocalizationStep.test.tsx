// @vitest-environment jsdom
/**
 * `[BULKIMPORT-loc-step]` C3 — the Localization step.
 *
 * ⚠ WHAT IS DELIBERATELY NOT TESTED HERE: anything comparing the file against
 * Apple. That was designed and mocked up, then deferred by the Manager on
 * 2026-09-23 (`[BULKIMPORT-loc-compare-apple]`). A test asserting "identical
 * cells start unticked" would be pinning a feature that does not exist.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LocalizationStep, type LocalizationSelectionState } from "./LocalizationStep";
import type { ParsedIapItem } from "@/lib/iap-management/parsers/iap-items";

const loc = (locale: string, name: string, desc: string) => ({
  locale,
  locale_name: locale === "vi" ? "Vietnamese" : "English (U.S.)",
  display_name: name,
  description: desc,
});

function item(
  product_id: string,
  locales: Array<{ locale: string; name: string; desc: string }>,
  warnings: string[] = [],
): ParsedIapItem {
  return {
    row_index: 1,
    product_id,
    reference_name: `ref ${product_id}`,
    type: "CONSUMABLE",
    type_source: "DEFAULT",
    price_usd: 1,
    base_price: 0,
    base_currency: "USD",
    localizations: locales.map((l) => loc(l.locale, l.name, l.desc)),
    warnings,
  };
}

const EMPTY: LocalizationSelectionState = { ignoreAll: false, selected: {} };

function renderStep(items: ParsedIapItem[], value = EMPTY) {
  const onChange = vi.fn();
  const utils = render(
    <LocalizationStep items={items} value={value} onChange={onChange} />,
  );
  return { ...utils, onChange };
}

describe("LocalizationStep — default is TICK-ALL (the parity gate)", () => {
  it("every cell starts ticked when nothing has been chosen", () => {
    renderStep([item("com.a", [{ locale: "vi", name: "188 Vàng", desc: "Gói 188" }])]);
    const cb = screen.getByTestId("localization-cell-com.a-vi") as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it("the counter reads all-of-all", () => {
    renderStep([
      item("com.a", [
        { locale: "vi", name: "A", desc: "a" },
        { locale: "en-US", name: "B", desc: "b" },
      ]),
    ]);
    expect(screen.getByTestId("localization-counter").textContent).toContain("2 / 2");
  });
});

describe("LocalizationStep — M-1: Name and Desc are separately labelled", () => {
  it("shows both fields on their own lines", () => {
    renderStep([item("com.a", [{ locale: "vi", name: "188 Vàng", desc: "Gói 188 Vàng" }])]);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Desc")).toBeInTheDocument();
    expect(screen.getByText("188 Vàng")).toBeInTheDocument();
    expect(screen.getByText("Gói 188 Vàng")).toBeInTheDocument();
  });

  it("⭐ a name and a description differing by ONE character are both shown verbatim", () => {
    // "188 Vàng" vs "188 Vàng." — one dot, and it is a REAL edit the Manager
    // wanted. Nothing here may normalise it away.
    renderStep([item("com.a", [{ locale: "vi", name: "188 Vàng.", desc: "188 Vàng" }])]);
    expect(screen.getByText("188 Vàng.")).toBeInTheDocument();
    expect(screen.getByText("188 Vàng")).toBeInTheDocument();
  });
});

describe("LocalizationStep — ticking", () => {
  it("un-ticking one cell reports the remaining locales for that item", () => {
    const { onChange } = renderStep([
      item("com.a", [
        { locale: "vi", name: "A", desc: "a" },
        { locale: "en-US", name: "B", desc: "b" },
      ]),
    ]);
    fireEvent.click(screen.getByTestId("localization-cell-com.a-vi"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ selected: { "com.a": ["en-US"] } }),
    );
  });

  /**
   * ⚠ HEADER FULL ⇒ CLEARS THE COLUMN. Manager's explicit call: the default is
   * everything ticked, so the real work is SUBTRACTING. Do NOT port the
   * territory picker's "never remove" rule — different default, opposite job.
   */
  it("a FULL column header clears the whole column", () => {
    const { onChange } = renderStep([
      item("com.a", [{ locale: "vi", name: "A", desc: "a" }]),
      item("com.b", [{ locale: "vi", name: "B", desc: "b" }]),
    ]);
    fireEvent.click(screen.getByTestId("localization-col-vi"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ selected: { "com.a": [], "com.b": [] } }),
    );
  });

  it("the column header is INDETERMINATE when only some cells are ticked", () => {
    renderStep(
      [
        item("com.a", [{ locale: "vi", name: "A", desc: "a" }]),
        item("com.b", [{ locale: "vi", name: "B", desc: "b" }]),
      ],
      { ignoreAll: false, selected: { "com.a": [], "com.b": ["vi"] } },
    );
    const head = screen.getByTestId("localization-col-vi") as HTMLInputElement;
    expect(head.indeterminate).toBe(true);
    expect(head.checked).toBe(false);
  });

  it("'Ignore all' zeroes the counter", () => {
    renderStep(
      [item("com.a", [{ locale: "vi", name: "A", desc: "a" }])],
      { ignoreAll: true, selected: {} },
    );
    expect(screen.getByTestId("localization-counter").textContent).toContain("0 / 1");
  });
});

describe("LocalizationStep — Q7: little or nothing to select", () => {
  it("Q7.1 a file with NO localization content still renders the step, with a reason", () => {
    renderStep([item("com.a", [])]);
    expect(screen.getByTestId("localization-step")).toBeInTheDocument();
    expect(screen.getByTestId("localization-empty").textContent).toContain(
      "no localization content",
    );
  });

  it("Q7.4 MIXED: an item with no localizations gets no row, the others still do", () => {
    renderStep([
      item("com.a", [{ locale: "vi", name: "A", desc: "a" }]),
      item("com.b", []),
    ]);
    expect(screen.getByTestId("localization-cell-com.a-vi")).toBeInTheDocument();
    expect(screen.queryByText("com.b")).not.toBeInTheDocument();
    expect(screen.getByTestId("localization-counter").textContent).toContain("1 / 1");
  });

  it("an item missing ONE locale shows a placeholder, not a ticked cell", () => {
    renderStep([
      item("com.a", [
        { locale: "vi", name: "A", desc: "a" },
        { locale: "en-US", name: "B", desc: "b" },
      ]),
      item("com.b", [{ locale: "vi", name: "C", desc: "c" }]),
    ]);
    expect(screen.queryByTestId("localization-cell-com.b-en-US")).not.toBeInTheDocument();
  });
});

describe("LocalizationStep — the half-filled pair finally gets said out loud", () => {
  /**
   * ⚠ `items[i].warnings` had NO consumer anywhere in the repo before this
   * component. The parser dropped half-filled pairs and recorded why, and the
   * why went nowhere — a silent skip, the exact class this step removes.
   */
  it("renders the parser's per-item warning for a dropped half-pair", () => {
    renderStep([
      item("com.a", [{ locale: "vi", name: "A", desc: "a" }], [
        'Locale "Thai": partial fill (Display Name only) — skipped.',
      ]),
    ]);
    const panel = screen.getByTestId("localization-dropped-pairs");
    expect(panel.textContent).toContain("com.a");
    expect(panel.textContent).toContain("partial fill");
  });

  it("says nothing when there is nothing to say", () => {
    renderStep([item("com.a", [{ locale: "vi", name: "A", desc: "a" }])]);
    expect(screen.queryByTestId("localization-dropped-pairs")).not.toBeInTheDocument();
  });

  it("still warns when the file has no usable localizations at all", () => {
    renderStep([item("com.a", [], ['Locale "Thai": partial fill — skipped.'])]);
    expect(screen.getByTestId("localization-dropped-pairs")).toBeInTheDocument();
  });
});

describe("LocalizationStep — detail popover", () => {
  it("opens on click and shows both full field values", () => {
    renderStep([
      item("com.a", [{ locale: "vi", name: "188 Vàng", desc: "Gói 188 Vàng dùng trong game" }]),
    ]);
    expect(screen.queryByTestId("localization-detail-com.a-vi")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("detail"));
    const pop = screen.getByTestId("localization-detail-com.a-vi");
    expect(pop.textContent).toContain("Display Name");
    expect(pop.textContent).toContain("Gói 188 Vàng dùng trong game");
  });

  it("closes on a click outside — via the shared hook, not a fourth inline copy", () => {
    renderStep([item("com.a", [{ locale: "vi", name: "A", desc: "a" }])]);
    fireEvent.click(screen.getByText("detail"));
    expect(screen.getByTestId("localization-detail-com.a-vi")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("localization-detail-com.a-vi")).not.toBeInTheDocument();
  });
});
