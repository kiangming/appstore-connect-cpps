/**
 * G1 — pure parts of the shared routing helper (arc
 * `[CPP-bulkimport-ipad-screenshot-sizes]`, Manager Q3 + Q4): grouping order,
 * the 10-per-set count and the "no 13\"" warning. The wiring into both
 * dialogs is covered by components/cpp/ipad-screenshot-routing.baseline.test.tsx.
 */
import { describe, it, expect } from "vitest";
import type { ScreenshotDisplayType } from "@/types/asc";
import { checkIpadGroups, countScreenshotsPerSet, groupIpadScreenshots } from "./screenshot-upload";

const f = (name: string) => new File(["x"], name);
const NO_13_WARNING =
  'No iPad 13" screenshots — Apple requires iPad 13" screenshots for apps that run on iPad. Import is not blocked.';

describe("groupIpadScreenshots", () => {
  it("13\" group first, then 11\", 10.5\", 9.7\"; input order kept inside a group", () => {
    const items = [
      { file: f("01.png"), displayType: "APP_IPAD_97" },
      { file: f("02.png"), displayType: "APP_IPAD_PRO_3GEN_11" },
      { file: f("03.png"), displayType: "APP_IPAD_PRO_3GEN_129" },
      { file: f("04.png"), displayType: "APP_IPAD_PRO_3GEN_11" },
      { file: f("05.png"), displayType: "APP_IPAD_105" },
      { file: f("06.png"), displayType: "APP_IPAD_PRO_3GEN_129" },
    ] as Array<{ file: File; displayType: ScreenshotDisplayType }>;
    expect(groupIpadScreenshots(items).map((g) => [g.displayType, g.files.map((x) => x.name)])).toEqual([
      ["APP_IPAD_PRO_3GEN_129", ["03.png", "06.png"]],
      ["APP_IPAD_PRO_3GEN_11", ["02.png", "04.png"]],
      ["APP_IPAD_105", ["05.png"]],
      ["APP_IPAD_97", ["01.png"]],
    ]);
  });

  it("no items ⇒ no groups", () => expect(groupIpadScreenshots([])).toEqual([]));
});

describe("checkIpadGroups — max 10 per display type", () => {
  const g = (type: ScreenshotDisplayType, n: number) => ({
    displayType: type,
    files: Array.from({ length: n }, (_, i) => f(`${i}.png`)),
  });

  it("10 new ⇒ ok; 11 new ⇒ error", () => {
    expect(checkIpadGroups([g("APP_IPAD_PRO_3GEN_129", 10)], new Map()).errors).toEqual([]);
    expect(checkIpadGroups([g("APP_IPAD_PRO_3GEN_129", 11)], new Map()).errors).toEqual([
      'Too many screenshots for iPad 13": 11 — max 10',
    ]);
  });

  it("existing screenshots on Apple count", () => {
    const existing = new Map<ScreenshotDisplayType, number>([["APP_IPAD_PRO_3GEN_11", 8]]);
    expect(checkIpadGroups([g("APP_IPAD_PRO_3GEN_11", 2)], existing).errors).toEqual([]);
    expect(checkIpadGroups([g("APP_IPAD_PRO_3GEN_11", 3)], existing).errors).toEqual([
      'Too many screenshots for iPad 11": 11 (8 already on Apple + 3 new) — max 10',
    ]);
  });

  it("per display type, not per locale: 6 + 6 of two types ⇒ ok", () => {
    expect(
      checkIpadGroups([g("APP_IPAD_PRO_3GEN_129", 6), g("APP_IPAD_PRO_3GEN_11", 6)], new Map()).errors,
    ).toEqual([]);
  });
});

describe("checkIpadGroups — the 13\" warning (Q3: warn, never block)", () => {
  const only11 = [{ displayType: "APP_IPAD_PRO_3GEN_11" as ScreenshotDisplayType, files: [f("a.png")] }];

  it("only 11\" images, no 13\" set ⇒ warning", () => {
    expect(checkIpadGroups(only11, new Map()).warnings).toEqual([NO_13_WARNING]);
  });

  it("only 11\" images but the locale already has a 13\" set ⇒ no warning", () => {
    expect(checkIpadGroups(only11, new Map([["APP_IPAD_PRO_3GEN_129", 3]])).warnings).toEqual([]);
  });

  it("a 13\" image in the import ⇒ no warning", () => {
    const groups = [...only11, { displayType: "APP_IPAD_PRO_3GEN_129" as ScreenshotDisplayType, files: [f("b.png")] }];
    expect(checkIpadGroups(groups, new Map()).warnings).toEqual([]);
  });

  it("existing sets could not be read (null) ⇒ no warning rather than a guess (KB P7)", () => {
    expect(checkIpadGroups(only11, null).warnings).toEqual([]);
  });

  it("no iPad images ⇒ no warning", () => {
    expect(checkIpadGroups([], new Map()).warnings).toEqual([]);
  });

  it("the warning never adds an error", () => {
    expect(checkIpadGroups(only11, new Map()).errors).toEqual([]);
  });
});

describe("countScreenshotsPerSet — from included[], with the set's own id list (G1b)", () => {
  const shots = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ type: "appScreenshots", id: `${prefix}${i}` }));
  const set = (id: string, type: string, ids: string[], total?: number) => ({
    type: "appScreenshotSets",
    id,
    attributes: { screenshotDisplayType: type },
    relationships: {
      appScreenshots: {
        data: ids.map((x) => ({ type: "appScreenshots", id: x })),
        ...(total !== undefined ? { meta: { paging: { total, limit: 50 } } } : {}),
      },
    },
  });
  type Resp = Parameters<typeof countScreenshotsPerSet>[0];
  const ids = (prefix: string, n: number) => shots(prefix, n).map((x) => x.id);

  it("full lists: 10 in the 13\" set, 3 in the 11\" set", () => {
    const d = {
      data: [set("s13", "APP_IPAD_PRO_3GEN_129", ids("a", 10)), set("s11", "APP_IPAD_PRO_3GEN_11", ids("b", 3))],
      included: [...shots("a", 10), ...shots("b", 3)],
    } as unknown as Resp;
    expect(Object.fromEntries(countScreenshotsPerSet(d) ?? [])).toEqual({
      APP_IPAD_PRO_3GEN_129: 10,
      APP_IPAD_PRO_3GEN_11: 3,
    });
  });

  it("one set, relationship list CUT to 3 ids, included has all 10 ⇒ 10 (KB §4.1 fingerprint)", () => {
    const d = {
      data: [set("s11", "APP_IPAD_PRO_3GEN_11", ids("a", 3))],
      included: shots("a", 10),
    } as unknown as Resp;
    expect(countScreenshotsPerSet(d)?.get("APP_IPAD_PRO_3GEN_11")).toBe(10);
  });

  it("several sets + included screenshots no set lists ⇒ null (cannot attribute, no guess)", () => {
    const d = {
      data: [set("s13", "APP_IPAD_PRO_3GEN_129", ids("a", 2)), set("s11", "APP_IPAD_PRO_3GEN_11", ids("b", 2))],
      included: [...shots("a", 2), ...shots("b", 2), ...shots("orphan", 3)],
    } as unknown as Resp;
    expect(countScreenshotsPerSet(d)).toBeNull();
  });

  it("meta.paging.total wins when larger than what was listed", () => {
    const d = {
      data: [set("s11", "APP_IPAD_PRO_3GEN_11", ids("a", 3), 9)],
      included: shots("a", 3),
    } as unknown as Resp;
    expect(countScreenshotsPerSet(d)?.get("APP_IPAD_PRO_3GEN_11")).toBe(9);
  });

  it("an included resource of another type is not a screenshot", () => {
    const d = {
      data: [set("s13", "APP_IPAD_PRO_3GEN_129", ids("a", 1))],
      included: [...shots("a", 1), { type: "appCustomProductPageLocalizations", id: "x" }],
    } as unknown as Resp;
    expect(countScreenshotsPerSet(d)?.get("APP_IPAD_PRO_3GEN_129")).toBe(1);
  });

  it("empty set ⇒ 0; no sets ⇒ empty map", () => {
    expect(countScreenshotsPerSet({ data: [set("s", "APP_IPAD_97", [])], included: [] } as unknown as Resp)?.get("APP_IPAD_97")).toBe(0);
    expect(countScreenshotsPerSet({ data: [], included: [] })?.size).toBe(0);
  });
});
