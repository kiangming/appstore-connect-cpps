/**
 * G1 — the iPhone half of the size → display type table (arc
 * `[CPP-bulkimport-iphone-screenshot-sizes]`, design
 * docs/cpp-management/design-cpp-bulkimport-iphone-screenshot-sizes.md §C3,
 * Manager D1–D9 + Q-A..Q-D).
 *
 * ⚠ Every expectation is written BY HAND from Manager's list (Apple docs,
 * 2026-11-13) and Manager's approved sentences — never derived from
 * `IPHONE_SCREENSHOT_SPECS`, so a mutated spec row turns this file red.
 * If the iPhone UAT proves a row wrong, fix that ONE row here and in the spec.
 */
import { describe, it, expect } from "vitest";
import {
  IPHONE_DEFAULT_DISPLAY_TYPE,
  IPHONE_REQUIRED_DISPLAY_TYPES,
  SCREENSHOT_DISPLAY_TYPE_LABELS,
  classifyIpadScreenshot,
  classifyIphoneScreenshot,
  isIphoneDuoSize,
  labelsOf,
  screenshotSizeError,
  screenshotSizeErrorForDisplayType,
  sizesForDisplayType,
  sizesOfTypeIn,
} from "./screenshot-specs";

// [group as Manager listed it, size, expected display type] — 32 rows.
const EXPECTED: Array<[string, string, string]> = [
  ["Dynamic Island (large)", "1260x2736", "APP_IPHONE_67"],
  ["Dynamic Island (large)", "2736x1260", "APP_IPHONE_67"],
  ["Dynamic Island (large)", "1290x2796", "APP_IPHONE_67"],
  ["Dynamic Island (large)", "2796x1290", "APP_IPHONE_67"],
  ["Dynamic Island (large)", "1320x2868", "APP_IPHONE_67"],
  ["Dynamic Island (large)", "2868x1320", "APP_IPHONE_67"],
  ["Face ID (large)", "1284x2778", "APP_IPHONE_65"],
  ["Face ID (large)", "2778x1284", "APP_IPHONE_65"],
  ["Face ID (large)", "1242x2688", "APP_IPHONE_65"],
  ["Face ID (large)", "2688x1242", "APP_IPHONE_65"],
  ["Dynamic Island (medium)", "1179x2556", "APP_IPHONE_61"],
  ["Dynamic Island (medium)", "2556x1179", "APP_IPHONE_61"],
  ["Dynamic Island (medium)", "1206x2622", "APP_IPHONE_61"],
  ["Dynamic Island (medium)", "2622x1206", "APP_IPHONE_61"],
  // ⚠ inferred BY ELIMINATION (alternative APP_IPHONE_61) — the UAT checks these six first.
  ["Face ID (medium)", "1170x2532", "APP_IPHONE_58"],
  ["Face ID (medium)", "2532x1170", "APP_IPHONE_58"],
  ["Face ID (medium)", "1125x2436", "APP_IPHONE_58"],
  ["Face ID (medium)", "2436x1125", "APP_IPHONE_58"],
  ["Face ID (medium)", "1080x2340", "APP_IPHONE_58"],
  ["Face ID (medium)", "2340x1080", "APP_IPHONE_58"],
  ["Home Button (large)", "1242x2208", "APP_IPHONE_55"],
  ["Home Button (large)", "2208x1242", "APP_IPHONE_55"],
  ["Home Button (medium)", "750x1334", "APP_IPHONE_47"],
  ["Home Button (medium)", "1334x750", "APP_IPHONE_47"],
  ['Home Button (4")', "640x1096", "APP_IPHONE_40"],
  ['Home Button (4")', "640x1136", "APP_IPHONE_40"],
  ['Home Button (4")', "1136x600", "APP_IPHONE_40"],
  ['Home Button (4")', "1136x640", "APP_IPHONE_40"],
  ['Home Button (3.5")', "640x920", "APP_IPHONE_35"],
  ['Home Button (3.5")', "640x960", "APP_IPHONE_35"],
  ['Home Button (3.5")', "960x600", "APP_IPHONE_35"],
  ['Home Button (3.5")', "960x640", "APP_IPHONE_35"],
];
const DUO = ["1398x2034", "2034x1398", "2007x2853", "2853x2007"];

const dims = (size: string): [number, number] => {
  const [w, h] = size.split("x").map(Number);
  return [w, h];
};

const VALID_IPHONE =
  "Valid iPhone sizes — " +
  "Dynamic Island (large): 1260×2736, 2736×1260, 1290×2796, 2796×1290, 1320×2868, 2868×1320 · " +
  "Face ID (large): 1284×2778, 2778×1284, 1242×2688, 2688×1242 · " +
  "Dynamic Island (medium): 1179×2556, 2556×1179, 1206×2622, 2622×1206 · " +
  "Face ID (medium): 1170×2532, 2532×1170, 1125×2436, 2436×1125, 1080×2340, 2340×1080 · " +
  "Home Button (large): 1242×2208, 2208×1242 · " +
  "Home Button (medium): 750×1334, 1334×750 · " +
  'Home Button (4"): 640×1096, 640×1136, 1136×600, 1136×640 · ' +
  'Home Button (3.5"): 640×920, 640×960, 960×600, 960×640';

const DUO_SENTENCE = (size: string) =>
  `${size.replace("x", "×")} is an iPhone Duo screenshot size — iPhone Duo is not supported by the App Store Connect API yet; upload it manually on App Store Connect.`;

describe("size → display type (32 rows, hand-written)", () => {
  it("32 rows, no size in two groups, none of them an iPad size or a Duo size", () => {
    expect(EXPECTED).toHaveLength(32);
    expect(new Set(EXPECTED.map(([, s]) => s)).size).toBe(32);
    for (const [, size] of EXPECTED) {
      const [w, h] = dims(size);
      expect(classifyIpadScreenshot(w, h)).toBeNull();
      expect(isIphoneDuoSize(w, h)).toBe(false);
    }
  });

  it.each(EXPECTED)("%s %s → %s", (_group, size, type) => {
    const [w, h] = dims(size);
    expect(classifyIphoneScreenshot(w, h)?.displayType).toBe(type);
    expect(screenshotSizeError("iphone", w, h)).toBeNull();
  });

  it("not an iPhone size → null (iPad 13\", wrong size)", () => {
    expect(classifyIphoneScreenshot(2064, 2752)).toBeNull();
    expect(classifyIphoneScreenshot(1200, 2400)).toBeNull();
  });
});

describe("iPhone Duo — no display type in the OAS 4.4.1 ⇒ refused (D6, Q-D sentence)", () => {
  it.each(DUO)("%s → not classified, refused in iphone/ with the Duo sentence", (size) => {
    const [w, h] = dims(size);
    expect(isIphoneDuoSize(w, h)).toBe(true);
    expect(classifyIphoneScreenshot(w, h)).toBeNull();
    expect(screenshotSizeError("iphone", w, h)).toBe(DUO_SENTENCE(size));
  });

  it("editor: a Duo image on any iPhone set ⇒ the same Duo sentence", () => {
    expect(screenshotSizeErrorForDisplayType("APP_IPHONE_67", 2007, 2853)).toBe(DUO_SENTENCE("2007x2853"));
  });

  it("ipad/: a Duo image ⇒ the plain iPad sentence, NO move-to-iphone hint (Duo is not in the iPhone table)", () => {
    expect(screenshotSizeError("ipad", 1398, 2034)).toMatch(/^1398×2034 is not a valid iPad screenshot size\. Valid iPad sizes — /);
  });
});

describe("sizes accepted per TARGET set (editor, D2)", () => {
  it.each([
    ["APP_IPHONE_67", ["1260x2736", "2736x1260", "1290x2796", "2796x1290", "1320x2868", "2868x1320"]],
    ["APP_IPHONE_65", ["1284x2778", "2778x1284", "1242x2688", "2688x1242"]],
    ["APP_IPHONE_61", ["1179x2556", "2556x1179", "1206x2622", "2622x1206"]],
    ["APP_IPHONE_58", ["1170x2532", "2532x1170", "1125x2436", "2436x1125", "1080x2340", "2340x1080"]],
    ["APP_IPHONE_55", ["1242x2208", "2208x1242"]],
    ["APP_IPHONE_47", ["750x1334", "1334x750"]],
    ["APP_IPHONE_40", ["640x1096", "640x1136", "1136x600", "1136x640"]],
    ["APP_IPHONE_35", ["640x920", "640x960", "960x600", "960x640"]],
  ] as const)("%s", (type, sizes) => {
    expect(sizesForDisplayType(type).map(([w, h]) => `${w}x${h}`)).toEqual(sizes);
  });
});

describe("error sentences, verbatim (Q-D: §4.3 shape + D8 hint)", () => {
  it("iphone/, wrong size", () => {
    expect(screenshotSizeError("iphone", 1200, 2400)).toBe(`1200×2400 is not a valid iPhone screenshot size. ${VALID_IPHONE}`);
  });

  it("iphone/, an iPad image ⇒ D8 hint", () => {
    expect(screenshotSizeError("iphone", 1668, 2388)).toBe(
      `1668×2388 is not a valid iPhone screenshot size — this looks like an iPad screenshot; move it to screenshots/ipad/. ${VALID_IPHONE}`,
    );
  });

  it("editor, Face ID (medium) image on the Dynamic Island (medium) set ⇒ names its real group", () => {
    expect(screenshotSizeErrorForDisplayType("APP_IPHONE_61", 1170, 2532)).toBe(
      "Resolution: got 1170×2532 — expected one of: 1179×2556, 2556×1179, 1206×2622, 2622×1206 — this is an iPhone Face ID (medium) size, not iPhone Dynamic Island (medium)",
    );
  });

  it("editor, an iPad image on an iPhone set ⇒ no hint (same-device hint only)", () => {
    expect(screenshotSizeErrorForDisplayType("APP_IPHONE_65", 2064, 2752)).toBe(
      "Resolution: got 2064×2752 — expected one of: 1284×2778, 2778×1284, 1242×2688, 2688×1242",
    );
  });

  it("editor, the right image on its set ⇒ null", () => {
    expect(screenshotSizeErrorForDisplayType("APP_IPHONE_58", 1125, 2436)).toBeNull();
  });
});

describe("Q-A — ipad/: every size of the iPhone table gets the move-it hint", () => {
  it.each(EXPECTED)("%s %s", (_group, size) => {
    const [w, h] = dims(size);
    expect(screenshotSizeError("ipad", w, h)).toMatch(
      new RegExp(`^${w}×${h} is not a valid iPad screenshot size — this looks like an iPhone screenshot; move it to screenshots/iphone/\\. Valid iPad sizes — `),
    );
  });
});

describe("labels (Q-C), default (D5), required types (D3) — from the table", () => {
  it("iPhone labels = Apple's group names", () => {
    expect({
      APP_IPHONE_67: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_67,
      APP_IPHONE_65: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_65,
      APP_IPHONE_61: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_61,
      APP_IPHONE_58: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_58,
      APP_IPHONE_55: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_55,
      APP_IPHONE_47: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_47,
      APP_IPHONE_40: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_40,
      APP_IPHONE_35: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_35,
    }).toEqual({
      APP_IPHONE_67: "iPhone Dynamic Island (large)",
      APP_IPHONE_65: "iPhone Face ID (large)",
      APP_IPHONE_61: "iPhone Dynamic Island (medium)",
      APP_IPHONE_58: "iPhone Face ID (medium)",
      APP_IPHONE_55: "iPhone Home Button (large)",
      APP_IPHONE_47: "iPhone Home Button (medium)",
      APP_IPHONE_40: 'iPhone Home Button (4")',
      APP_IPHONE_35: 'iPhone Home Button (3.5")',
    });
  });

  it("every one of the 13 iPhone/iPad display types of the union has a label (no raw enum shown)", () => {
    const ALL = [
      "APP_IPHONE_67", "APP_IPHONE_65", "APP_IPHONE_61", "APP_IPHONE_58", "APP_IPHONE_55", "APP_IPHONE_47",
      "APP_IPHONE_40", "APP_IPHONE_35", "APP_IPAD_PRO_3GEN_129", "APP_IPAD_PRO_3GEN_11", "APP_IPAD_PRO_129",
      "APP_IPAD_105", "APP_IPAD_97",
    ] as const;
    for (const t of ALL) expect(SCREENSHOT_DISPLAY_TYPE_LABELS[t]).toMatch(/^iP(hone|ad) /);
  });

  it("editor default for a locale with no iPhone set = Dynamic Island (large)", () => {
    expect(IPHONE_DEFAULT_DISPLAY_TYPE).toBe("APP_IPHONE_67");
  });

  it("required for apps that run on iPhone = Dynamic Island (large) or Face ID (large)", () => {
    expect([...IPHONE_REQUIRED_DISPLAY_TYPES]).toEqual(["APP_IPHONE_67", "APP_IPHONE_65"]);
  });

  it("the default and the required types FOLLOW their rows (a one-row hotfix carries over)", () => {
    // Hand-written group sizes: whatever type these images classify to IS the default / required type.
    expect(sizesForDisplayType(IPHONE_DEFAULT_DISPLAY_TYPE).map(([w, h]) => `${w}x${h}`)).toEqual([
      "1260x2736", "2736x1260", "1290x2796", "2796x1290", "1320x2868", "2868x1320",
    ]);
    expect([...IPHONE_REQUIRED_DISPLAY_TYPES]).toEqual([
      classifyIphoneScreenshot(1290, 2796)?.displayType,
      classifyIphoneScreenshot(1284, 2778)?.displayType,
    ]);
  });
});

describe("merge-safe: two rows sharing a display type (the UAT fallback Face ID (medium) → APP_IPHONE_61)", () => {
  const MERGED = [
    { displayType: "APP_IPHONE_61", label: "iPhone Dynamic Island (medium)", sizes: [[1179, 2556]], source: "t" },
    { displayType: "APP_IPHONE_61", label: "iPhone Face ID (medium)", sizes: [[1170, 2532], [1125, 2436]], source: "t" },
    { displayType: "APP_IPHONE_40", label: 'iPhone Home Button (4")', sizes: [[640, 1136]], source: "t" },
  ] as const;

  it("the shared type accepts BOTH rows' sizes, in table order", () => {
    expect(sizesOfTypeIn(MERGED as never, "APP_IPHONE_61").map(([w, h]) => `${w}x${h}`)).toEqual([
      "1179x2556", "1170x2532", "1125x2436",
    ]);
  });

  it("the shared type shows the FIRST row's label", () => {
    expect(labelsOf(MERGED as never)).toEqual({
      APP_IPHONE_61: "iPhone Dynamic Island (medium)",
      APP_IPHONE_40: 'iPhone Home Button (4")',
    });
  });
});
