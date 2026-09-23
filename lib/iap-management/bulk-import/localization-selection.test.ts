/**
 * `[BULKIMPORT-loc-step]` C2 — the localization choke point.
 *
 * Two layers, and they prove different things:
 *   · BEHAVIOUR  — the selection rules, including every Q7 edge case.
 *   · STRUCTURAL — that the route still reads `item.localizations` ONLY after
 *                  the filter. A behaviour test cannot catch a ninth read site
 *                  added upstream of the choke point; that is what the
 *                  structural test is for.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { applyLocalizationSelection } from "./localization-selection";
import type { ParsedIapItem } from "../parsers/iap-items";

const loc = (locale: string) => ({
  locale,
  locale_name: locale,
  display_name: `${locale} name`,
  description: `${locale} desc`,
});

const item = (product_id: string, locales: string[]): ParsedIapItem => ({
  row_index: 1,
  product_id,
  reference_name: product_id,
  type: "CONSUMABLE",
  type_source: "DEFAULT",
  price_usd: 1,
  base_price: 0,
  base_currency: "USD",
  localizations: locales.map(loc),
  warnings: [],
});

describe("applyLocalizationSelection — the parity default", () => {
  /**
   * ⭐ THE PARITY GATE OF THE WHOLE ARC, asserted at the normal layer.
   * The scope was narrowed on 2026-09-23 (no comparison against Apple), so the
   * default really is "process everything" — the same thing the tool did
   * before this arc existed. That makes parity directly assertable instead of
   * needing to be measured one layer down.
   */
  it("undefined selection ⇒ every localization survives, untouched", () => {
    const items = [item("a", ["vi", "en-US"]), item("b", ["vi"])];
    const r = applyLocalizationSelection(items, undefined);
    expect(r.items.map((i) => i.localizations.map((l) => l.locale))).toEqual([
      ["vi", "en-US"],
      ["vi"],
    ]);
    expect(r.dropped).toBe(0);
    expect(r.kept).toBe(3);
    expect(r.anomalies).toEqual([]);
  });

  it("returns the SAME item objects when nothing is filtered (no needless copies)", () => {
    const items = [item("a", ["vi"])];
    expect(applyLocalizationSelection(items, undefined).items[0]).toBe(items[0]);
  });

  it("a selection that ticks everything is also a no-op", () => {
    const items = [item("a", ["vi", "en-US"])];
    const r = applyLocalizationSelection(items, {
      selected: { a: ["vi", "en-US"] },
    });
    expect(r.items[0].localizations.map((l) => l.locale)).toEqual(["vi", "en-US"]);
    expect(r.dropped).toBe(0);
  });
});

describe("applyLocalizationSelection — the Manager's choices", () => {
  it("'Ignore all' drops every cell and counts them", () => {
    const items = [item("a", ["vi", "en-US"]), item("b", ["vi"])];
    const r = applyLocalizationSelection(items, { ignore_all: true });
    expect(r.items.every((i) => i.localizations.length === 0)).toBe(true);
    expect(r.kept).toBe(0);
    expect(r.dropped).toBe(3);
  });

  it("'Ignore all' does NOT touch anything other than localizations", () => {
    const items = [item("a", ["vi"])];
    const r = applyLocalizationSelection(items, { ignore_all: true });
    expect(r.items[0].price_usd).toBe(1);
    expect(r.items[0].product_id).toBe("a");
    expect(r.items[0].type).toBe("CONSUMABLE");
  });

  it("un-ticking one locale on one item leaves the other item alone", () => {
    const items = [item("a", ["vi", "en-US"]), item("b", ["vi", "en-US"])];
    const r = applyLocalizationSelection(items, {
      selected: { a: ["en-US"], b: ["vi", "en-US"] },
    });
    expect(r.items[0].localizations.map((l) => l.locale)).toEqual(["en-US"]);
    expect(r.items[1].localizations.map((l) => l.locale)).toEqual(["vi", "en-US"]);
    expect(r.kept).toBe(3);
    expect(r.dropped).toBe(1);
  });

  it("an explicitly EMPTY list drops that item's cells — empty is a decision, not a gap", () => {
    const items = [item("a", ["vi"])];
    const r = applyLocalizationSelection(items, { selected: { a: [] } });
    expect(r.items[0].localizations).toEqual([]);
    expect(r.dropped).toBe(1);
    expect(r.anomalies).toEqual([]);
  });
});

describe("applyLocalizationSelection — Q7: the file has little or nothing to select", () => {
  /**
   * ⚠ Q7 (b)+(c). The parser already drops a locale pair when BOTH cells are
   * blank, and drops a HALF-filled pair with a warning (`iap-items.ts`), so by
   * the time items reach here "no localization columns" and "columns present
   * but empty" are the same shape: `localizations: []`.
   */
  it("an item with no localizations at all: nothing to keep, nothing to drop, NOT an anomaly", () => {
    const items = [item("a", [])];
    const r = applyLocalizationSelection(items, { selected: {} });
    expect(r.kept).toBe(0);
    expect(r.dropped).toBe(0);
    // It was never a tickable cell, so it is not a "forgotten" item.
    expect(r.anomalies).toEqual([]);
  });

  it("an empty batch totals zero — the confirm dialog has nothing to count", () => {
    const r = applyLocalizationSelection([], { selected: {} });
    expect(r).toMatchObject({ kept: 0, dropped: 0, anomalies: [] });
    expect(r.items).toEqual([]);
  });

  it("Q7.4 MIXED: items with and without localizations in one batch", () => {
    const items = [item("a", ["vi"]), item("b", []), item("c", ["vi", "en-US"])];
    const r = applyLocalizationSelection(items, {
      selected: { a: ["vi"], c: ["vi"] },
    });
    expect(r.items[0].localizations.map((l) => l.locale)).toEqual(["vi"]);
    expect(r.items[1].localizations).toEqual([]);
    expect(r.items[2].localizations.map((l) => l.locale)).toEqual(["vi"]);
    // Denominator counts REAL cells only: a=1 + c=2 = 3, never rows × pairs.
    expect(r.kept).toBe(2);
    expect(r.dropped).toBe(1);
    expect(r.anomalies).toEqual([]);
  });
});

describe("applyLocalizationSelection — anomalies are SAID, never silent", () => {
  /**
   * ⚠ THE DIRECTION OF THIS DEFAULT IS DELIBERATE. "Unmentioned ⇒ drop" would
   * turn any client/server skew into a silent mass-skip — the same failure
   * mode as the 2026-09-22 incident, pointing the other way. So an unmentioned
   * item KEEPS its data and the oddity is reported.
   */
  it("an item missing from a stated selection keeps its cells AND is reported", () => {
    const items = [item("a", ["vi"]), item("b", ["vi", "en-US"])];
    const r = applyLocalizationSelection(items, { selected: { a: ["vi"] } });
    expect(r.items[1].localizations).toHaveLength(2);
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]).toContain("b");
    expect(r.kept).toBe(3);
    expect(r.dropped).toBe(0);
  });

  it("a malformed `selected` is NOT treated as 'no opinion' — it keeps data and complains", () => {
    const items = [item("a", ["vi"])];
    const r = applyLocalizationSelection(items, {
      selected: "everything" as unknown as Record<string, string[]>,
    });
    expect(r.items[0].localizations).toHaveLength(1);
    expect(r.dropped).toBe(0);
    expect(r.anomalies).toHaveLength(1);
  });

  it("a locale ticked that is not in the file cannot invent a cell", () => {
    const items = [item("a", ["vi"])];
    const r = applyLocalizationSelection(items, {
      selected: { a: ["vi", "fr-FR"] },
    });
    expect(r.items[0].localizations.map((l) => l.locale)).toEqual(["vi"]);
    expect(r.kept).toBe(1);
  });
});

// ─── Structural ──────────────────────────────────────────────────────────────

const ROUTE_SRC = readFileSync(
  join(
    __dirname,
    "../../../app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts",
  ),
  "utf8",
);

/**
 * ⚠ COMMENTS STRIPPED, AND THE FIRST RUN IS WHY. The choke point's own comment
 * says the words "item.localizations" — so an un-stripped scan found a "read"
 * at the comment and failed. A structural test that matches prose is measuring
 * the documentation, not the code.
 */
const ROUTE = ROUTE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /(^|[^:])\/\/[^\n]*/g,
  "$1",
);

describe("[BULKIMPORT-loc-step] C2 — the choke point is the ONLY way in", () => {
  it("the route filters immediately after parsing, before resolveConflicts", () => {
    const parse = ROUTE.indexOf("await parseIapItemsXlsx(excel)");
    const filter = ROUTE.indexOf("applyLocalizationSelection(");
    const resolve = ROUTE.indexOf("resolveConflicts({");
    expect(parse).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(parse);
    expect(resolve).toBeGreaterThan(filter);
  });

  it("every `item.localizations` read sits AFTER the choke point", () => {
    const filter = ROUTE.indexOf("applyLocalizationSelection(");
    const reads: number[] = [];
    const re = /item\.localizations/g;
    for (let m = re.exec(ROUTE); m; m = re.exec(ROUTE)) reads.push(m.index);
    // The census counted eight; the assertion is the ORDER, not the count, so
    // a ninth read added later is covered too — as long as it is downstream.
    expect(reads.length).toBeGreaterThanOrEqual(8);
    expect(reads.every((i) => i > filter)).toBe(true);
  });

  it("the filtered items are what flows on — `parsed` is reassigned, not shadowed", () => {
    expect(ROUTE).toContain("parsed = { ...parsed, items: locSelection.items }");
  });
});
