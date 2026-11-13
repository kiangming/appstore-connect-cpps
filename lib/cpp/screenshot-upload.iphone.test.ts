/**
 * G1 — the shared routing helper, iPhone side (arc
 * `[CPP-bulkimport-iphone-screenshot-sizes]`, Manager D1, D3, D7): grouping
 * order, the 10-per-set count and the "no required iPhone screenshots"
 * warning. The iPad side keeps its own test (screenshot-upload.test.ts),
 * untouched. Wiring into both dialogs: components/cpp/iphone-screenshot-routing.test.tsx.
 */
import { describe, it, expect } from "vitest";
import type { ScreenshotDisplayType } from "@/types/asc";
import { checkIpadGroups, checkScreenshotGroups, groupBySpecs, groupScreenshots } from "./screenshot-upload";

const f = (name: string) => new File(["x"], name);
const g = (type: ScreenshotDisplayType, n: number) => ({
  displayType: type,
  files: Array.from({ length: n }, (_, i) => f(`${type}-${i}.png`)),
});
// Manager Q-D, verbatim.
const NO_REQUIRED_IPHONE =
  "No required iPhone screenshots — Apple requires Dynamic Island (large) or Face ID (large) screenshots for apps that run on iPhone. Import is not blocked.";

describe("groupScreenshots — iphone", () => {
  it("largest screen first (67, 65, 61, 58, 55, 47, 40, 35); input order kept inside a group", () => {
    const items = [
      { file: f("01.png"), displayType: "APP_IPHONE_35" },
      { file: f("02.png"), displayType: "APP_IPHONE_58" },
      { file: f("03.png"), displayType: "APP_IPHONE_67" },
      { file: f("04.png"), displayType: "APP_IPHONE_47" },
      { file: f("05.png"), displayType: "APP_IPHONE_65" },
      { file: f("06.png"), displayType: "APP_IPHONE_61" },
      { file: f("07.png"), displayType: "APP_IPHONE_40" },
      { file: f("08.png"), displayType: "APP_IPHONE_55" },
      { file: f("09.png"), displayType: "APP_IPHONE_67" },
    ] as Array<{ file: File; displayType: ScreenshotDisplayType }>;
    expect(groupScreenshots("iphone", items).map((x) => [x.displayType, x.files.map((y) => y.name)])).toEqual([
      ["APP_IPHONE_67", ["03.png", "09.png"]],
      ["APP_IPHONE_65", ["05.png"]],
      ["APP_IPHONE_61", ["06.png"]],
      ["APP_IPHONE_58", ["02.png"]],
      ["APP_IPHONE_55", ["08.png"]],
      ["APP_IPHONE_47", ["04.png"]],
      ["APP_IPHONE_40", ["07.png"]],
      ["APP_IPHONE_35", ["01.png"]],
    ]);
  });

  it("an iPad type never lands in an iPhone group (and vice versa)", () => {
    const items = [
      { file: f("a.png"), displayType: "APP_IPAD_PRO_3GEN_129" },
      { file: f("b.png"), displayType: "APP_IPHONE_65" },
    ] as Array<{ file: File; displayType: ScreenshotDisplayType }>;
    expect(groupScreenshots("iphone", items).map((x) => x.displayType)).toEqual(["APP_IPHONE_65"]);
    expect(groupScreenshots("ipad", items).map((x) => x.displayType)).toEqual(["APP_IPAD_PRO_3GEN_129"]);
  });
});

describe("groupBySpecs — merge-safe: two rows sharing a display type ⇒ ONE group (the UAT fallback 58 → 61 stays a one-row hotfix)", () => {
  it("rows [67, 61, 61, 40] ⇒ groups 61, 40 (67 has no image) — the 61 group holds every 61 image once, in input order", () => {
    const specs = [
      { displayType: "APP_IPHONE_67" },
      { displayType: "APP_IPHONE_61" },
      { displayType: "APP_IPHONE_61" },
      { displayType: "APP_IPHONE_40" },
    ] as Array<{ displayType: ScreenshotDisplayType }>;
    const items = [
      { file: f("01-fim.png"), displayType: "APP_IPHONE_61" },
      { file: f("02-dim.png"), displayType: "APP_IPHONE_61" },
      { file: f("03-hb4.png"), displayType: "APP_IPHONE_40" },
      { file: f("04-fim.png"), displayType: "APP_IPHONE_61" },
    ] as Array<{ file: File; displayType: ScreenshotDisplayType }>;
    expect(groupBySpecs(specs, items).map((x) => [x.displayType, x.files.map((y) => y.name)])).toEqual([
      ["APP_IPHONE_61", ["01-fim.png", "02-dim.png", "04-fim.png"]],
      ["APP_IPHONE_40", ["03-hb4.png"]],
    ]);
  });
});

describe("checkScreenshotGroups — iphone, max 10 per display type (D7)", () => {
  it("10 new ⇒ ok; 11 new ⇒ error with the Q-C label", () => {
    expect(checkScreenshotGroups("iphone", [g("APP_IPHONE_58", 10)], new Map()).errors).toEqual([]);
    expect(checkScreenshotGroups("iphone", [g("APP_IPHONE_58", 11)], new Map()).errors).toEqual([
      "Too many screenshots for iPhone Face ID (medium): 11 — max 10",
    ]);
  });

  it("screenshots already on Apple count", () => {
    const existing = new Map<ScreenshotDisplayType, number>([["APP_IPHONE_65", 9]]);
    expect(checkScreenshotGroups("iphone", [g("APP_IPHONE_65", 1)], existing).errors).toEqual([]);
    expect(checkScreenshotGroups("iphone", [g("APP_IPHONE_65", 2)], existing).errors).toEqual([
      "Too many screenshots for iPhone Face ID (large): 11 (9 already on Apple + 2 new) — max 10",
    ]);
  });
});

describe("checkScreenshotGroups — iphone, required screenshots (D3: warn, never block)", () => {
  const only61 = [g("APP_IPHONE_61", 1)];

  it("only Dynamic Island (medium), no 67/65 set ⇒ warning, verbatim", () => {
    expect(checkScreenshotGroups("iphone", only61, new Map())).toEqual({ errors: [], warnings: [NO_REQUIRED_IPHONE] });
  });

  it("a Dynamic Island (large) image in the import ⇒ no warning", () => {
    expect(checkScreenshotGroups("iphone", [...only61, g("APP_IPHONE_67", 1)], new Map()).warnings).toEqual([]);
  });

  it("a Face ID (large) image in the import ⇒ no warning", () => {
    expect(checkScreenshotGroups("iphone", [...only61, g("APP_IPHONE_65", 1)], new Map()).warnings).toEqual([]);
  });

  it("the locale already has a 6.7\" or a 6.5\" set ⇒ no warning", () => {
    expect(checkScreenshotGroups("iphone", only61, new Map([["APP_IPHONE_67", 2]])).warnings).toEqual([]);
    expect(checkScreenshotGroups("iphone", only61, new Map([["APP_IPHONE_65", 2]])).warnings).toEqual([]);
  });

  it("the locale has only other iPhone sets (61/58) ⇒ still warning", () => {
    expect(
      checkScreenshotGroups("iphone", only61, new Map([["APP_IPHONE_61", 3], ["APP_IPHONE_58", 1]])).warnings,
    ).toEqual([NO_REQUIRED_IPHONE]);
  });

  it("an iPad 13\" set does not satisfy the iPhone requirement (and vice versa)", () => {
    expect(checkScreenshotGroups("iphone", only61, new Map([["APP_IPAD_PRO_3GEN_129", 3]])).warnings).toEqual([
      NO_REQUIRED_IPHONE,
    ]);
    expect(checkIpadGroups([g("APP_IPAD_97", 1)], new Map([["APP_IPHONE_67", 3]])).warnings).toHaveLength(1);
  });

  it("existing sets could not be read (null) ⇒ no warning rather than a guess (KB P7)", () => {
    expect(checkScreenshotGroups("iphone", only61, null).warnings).toEqual([]);
  });

  it("no iPhone images ⇒ no warning", () => {
    expect(checkScreenshotGroups("iphone", [], new Map()).warnings).toEqual([]);
  });
});
