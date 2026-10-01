// @vitest-environment jsdom
/**
 * `[BULKIMPORT-loc-compare-apple]` C4 — the six cell states, as rendered.
 *
 * ⚠ THE ASSERTIONS ARE ABOUT SENTENCES, NOT ABOUT TICKS. Three different
 * findings all produce an unticked cell; what distinguishes them is the only
 * thing the Manager cannot get without opening App Store Connect — whether this
 * item has a change already waiting for review. A test that only checked the
 * checkbox would pass with all three merged into one label.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LocalizationStep, type CellDefaultMap } from "./LocalizationStep";
import { SKIP_LABELS } from "@/lib/iap-management/bulk-import/localization-version-plan";
import { CELL_LABELS } from "@/lib/iap-management/bulk-import/localization-cell-default";
import type { ParsedIapItem } from "@/lib/iap-management/parsers/iap-items";

const PID = "com.vng.nikki.pack199ak";

const item = (locales = ["vi", "en-US"]): ParsedIapItem =>
  ({
    row_index: 1,
    product_id: PID,
    reference_name: "Item box",
    type: "CONSUMABLE",
    type_source: "DEFAULT",
    price_usd: 0,
    base_price: 0,
    base_currency: "USD",
    localizations: locales.map((l) => ({
      locale: l,
      locale_name: l === "vi" ? "Vietnamese" : "English (U.S.)",
      display_name: `name-${l}`,
      description: `desc-${l}`,
    })),
    warnings: [],
  }) as unknown as ParsedIapItem;

function renderStep(cellDefaults: CellDefaultMap, liveItems?: Record<string, boolean>) {
  return render(
    <LocalizationStep
      items={[item()]}
      value={{ ignoreAll: false, selected: { [PID]: ["vi", "en-US"] } }}
      onChange={vi.fn()}
      cellDefaults={cellDefaults}
      liveItems={liveItems}
    />,
  );
}

const why = (locale: string) => screen.getByTestId(`localization-why-${PID}-${locale}`);

describe("① every untick says WHY — three findings, three sentences", () => {
  it("renders each skip reason with its own approved wording", () => {
    renderStep({
      [PID]: {
        vi: { tick: false, kind: "SKIPPED", reason: "IDENTICAL_TO_LIVE", label: SKIP_LABELS.IDENTICAL_TO_LIVE },
        "en-US": { tick: false, kind: "SKIPPED", reason: "ALREADY_IN_DRAFT", label: SKIP_LABELS.ALREADY_IN_DRAFT },
      },
    });
    expect(why("vi").textContent).toBe(SKIP_LABELS.IDENTICAL_TO_LIVE);
    expect(why("en-US").textContent).toBe(SKIP_LABELS.ALREADY_IN_DRAFT);
  });

  it("the third case — live matches but a DIFFERENT change is pending — has its own line", () => {
    renderStep({
      [PID]: {
        vi: {
          tick: false, kind: "SKIPPED",
          reason: "LIVE_MATCHES_BUT_DRAFT_DIFFERS",
          label: SKIP_LABELS.LIVE_MATCHES_BUT_DRAFT_DIFFERS,
        },
        "en-US": { tick: false, kind: "UNREADABLE", label: CELL_LABELS.UNREADABLE },
      },
    });
    expect(why("vi").textContent).toBe(SKIP_LABELS.LIVE_MATCHES_BUT_DRAFT_DIFFERS);
  });

  it("⚠⚠ the three sentences are DISTINCT on screen — merging them erases the only fact the cell carries", () => {
    renderStep({
      [PID]: {
        vi: { tick: false, kind: "SKIPPED", reason: "IDENTICAL_TO_LIVE", label: SKIP_LABELS.IDENTICAL_TO_LIVE },
        "en-US": { tick: false, kind: "SKIPPED", reason: "LIVE_MATCHES_BUT_DRAFT_DIFFERS", label: SKIP_LABELS.LIVE_MATCHES_BUT_DRAFT_DIFFERS },
      },
    });
    expect(why("vi").textContent).not.toBe(why("en-US").textContent);
  });

  it("'không đọc được' and 'chưa có trên Apple' read differently AND tick differently", () => {
    renderStep({
      [PID]: {
        vi: { tick: false, kind: "UNREADABLE", label: CELL_LABELS.UNREADABLE },
        "en-US": { tick: true, kind: "NEW_LOCALE", label: CELL_LABELS.NEW_LOCALE },
      },
    });
    expect(why("vi").textContent).toBe(CELL_LABELS.UNREADABLE);
    expect(why("en-US").textContent).toBe(CELL_LABELS.NEW_LOCALE);
    expect(why("vi").dataset.kind).toBe("UNREADABLE");
    expect(why("en-US").dataset.kind).toBe("NEW_LOCALE");
  });

  it("a CREATE item says so in the Manager's approved words", () => {
    renderStep({
      [PID]: {
        vi: { tick: true, kind: "NEW_ITEM", label: CELL_LABELS.NEW_ITEM },
        "en-US": { tick: true, kind: "NEW_ITEM", label: CELL_LABELS.NEW_ITEM },
      },
    });
    expect(why("vi").textContent).toBe(CELL_LABELS.NEW_ITEM);
  });

  it("⚠ no cell is left to merely DIM — a verdict always carries a sentence", () => {
    renderStep({
      [PID]: {
        vi: { tick: false, kind: "SKIPPED", reason: "IDENTICAL_TO_LIVE", label: SKIP_LABELS.IDENTICAL_TO_LIVE },
        "en-US": { tick: false, kind: "UNREADABLE", label: CELL_LABELS.UNREADABLE },
      },
    });
    for (const l of ["vi", "en-US"]) expect(why(l).textContent?.trim().length).toBeGreaterThan(0);
  });
});

describe("② the changed FIELD is highlighted, not just the cell", () => {
  it("a name-only edit highlights Name and leaves Desc alone", () => {
    const { container } = renderStep({
      [PID]: {
        vi: { tick: true, kind: "DIFFERS", changed: { name: true, description: false }, label: CELL_LABELS.CHANGED_NAME },
        "en-US": { tick: true, kind: "DIFFERS", changed: { name: false, description: true }, label: CELL_LABELS.CHANGED_DESC },
      },
    });
    const marked = Array.from(container.querySelectorAll("[data-changed]")).map(
      (e) => e.getAttribute("data-changed"),
    );
    expect(marked).toEqual(["name", "description"]);
    expect(why("vi").textContent).toBe(CELL_LABELS.CHANGED_NAME);
    expect(why("en-US").textContent).toBe(CELL_LABELS.CHANGED_DESC);
  });

  it("both fields changed ⇒ both marked", () => {
    const { container } = renderStep({
      [PID]: {
        vi: { tick: true, kind: "DIFFERS", changed: { name: true, description: true }, label: CELL_LABELS.CHANGED_BOTH },
        "en-US": { tick: true, kind: "NEW_LOCALE", label: CELL_LABELS.NEW_LOCALE },
      },
    });
    expect(container.querySelectorAll("[data-changed]")).toHaveLength(2);
  });

  it("a SKIPPED cell marks no field — there is nothing changing", () => {
    const { container } = renderStep({
      [PID]: {
        vi: { tick: false, kind: "SKIPPED", reason: "IDENTICAL_TO_LIVE", label: SKIP_LABELS.IDENTICAL_TO_LIVE },
        "en-US": { tick: false, kind: "SKIPPED", reason: "IDENTICAL_TO_LIVE", label: SKIP_LABELS.IDENTICAL_TO_LIVE },
      },
    });
    expect(container.querySelectorAll("[data-changed]")).toHaveLength(0);
  });
});

describe("③ the ACTIVE pill is gone; 'đang bán' is the fact that replaced it", () => {
  it("a live item is marked at ROW level", () => {
    renderStep(
      { [PID]: { vi: { tick: true, kind: "NEW_LOCALE", label: CELL_LABELS.NEW_LOCALE } } },
      { [PID]: true },
    );
    expect(screen.getByTestId(`localization-live-${PID}`).textContent).toMatch(/đang bán/);
  });

  it("an item that is NOT live carries no marker", () => {
    renderStep(
      { [PID]: { vi: { tick: true, kind: "NEW_LOCALE", label: CELL_LABELS.NEW_LOCALE } } },
      { [PID]: false },
    );
    expect(screen.queryByTestId(`localization-live-${PID}`)).toBeNull();
  });

  it("⚠ the word ACTIVE appears nowhere on screen", () => {
    const { container } = renderStep(
      { [PID]: { vi: { tick: false, kind: "UNREADABLE", label: CELL_LABELS.UNREADABLE } } },
      { [PID]: true },
    );
    expect(container.textContent).not.toMatch(/\bACTIVE\b/);
  });
});

describe("⑤ the column tri-state still reads a MIXED default correctly", () => {
  it("one ticked, one not ⇒ the column is partial, not off", () => {
    render(
      <LocalizationStep
        items={[item()]}
        value={{ ignoreAll: false, selected: { [PID]: ["vi"] } }}
        onChange={vi.fn()}
        cellDefaults={{
          [PID]: {
            vi: { tick: true, kind: "NEW_LOCALE", label: CELL_LABELS.NEW_LOCALE },
            "en-US": { tick: false, kind: "SKIPPED", reason: "IDENTICAL_TO_LIVE", label: SKIP_LABELS.IDENTICAL_TO_LIVE },
          },
        }}
      />,
    );
    // A single-item batch makes each column all-or-none; the mixed default is
    // visible as the two columns disagreeing.
    expect((screen.getByTestId("localization-col-vi") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("localization-col-en-US") as HTMLInputElement).checked).toBe(false);
  });

  it("a column mixed ACROSS items is indeterminate", () => {
    const other = { ...item(["vi"]), product_id: "com.vng.other" } as ParsedIapItem;
    render(
      <LocalizationStep
        items={[item(["vi"]), other]}
        value={{ ignoreAll: false, selected: { [PID]: ["vi"], "com.vng.other": [] } }}
        onChange={vi.fn()}
        cellDefaults={{}}
      />,
    );
    const col = screen.getByTestId("localization-col-vi") as HTMLInputElement;
    expect(col.indeterminate).toBe(true);
  });
});

describe("the step still works with NO verdicts at all", () => {
  it("cellDefaults absent ⇒ no sentence rendered, nothing throws", () => {
    // The pre-read render: cells exist before Apple has answered, and the step
    // must not invent a verdict for them.
    render(
      <LocalizationStep
        items={[item()]}
        value={{ ignoreAll: false, selected: {} }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId(`localization-why-${PID}-vi`)).toBeNull();
    expect(screen.getByTestId("localization-step")).toBeInTheDocument();
  });
});
