/**
 * G1 — the size → display type table (arc `[CPP-bulkimport-ipad-screenshot-sizes]`,
 * design docs/cpp-management/design-cpp-bulkimport-ipad-screenshot-sizes.md
 * §3.1, §4.3, §P6-chốt).
 *
 * ⚠ The expected table is written BY HAND from Manager's list (Apple docs,
 * 2026-11-06) — never derived from `IPAD_SCREENSHOT_SPECS`, so that a mutated
 * spec row turns this file red.
 */
import { describe, it, expect } from "vitest";
import {
  IPAD_REQUIRED_DISPLAY_TYPE,
  SCREENSHOT_DISPLAY_TYPE_LABELS,
  classifyIpadScreenshot,
  screenshotSizeError,
  screenshotSizeErrorForDisplayType,
  sizesForDisplayType,
} from "./screenshot-specs";

// [group as Manager listed it, size, expected display type] — 26 rows.
const EXPECTED: Array<[string, string, string]> = [
  ['13"', "2064x2752", "APP_IPAD_PRO_3GEN_129"],
  ['13"', "2752x2064", "APP_IPAD_PRO_3GEN_129"],
  ['13"', "2048x2732", "APP_IPAD_PRO_3GEN_129"],
  ['13"', "2732x2048", "APP_IPAD_PRO_3GEN_129"],
  // 12.9": both sizes are also 13" ⇒ Manager Q1 = always 13".
  ['12.9"', "2048x2732", "APP_IPAD_PRO_3GEN_129"],
  ['12.9"', "2732x2048", "APP_IPAD_PRO_3GEN_129"],
  ['11"', "1488x2266", "APP_IPAD_PRO_3GEN_11"],
  ['11"', "2266x1488", "APP_IPAD_PRO_3GEN_11"],
  ['11"', "1512x2316", "APP_IPAD_PRO_3GEN_11"],
  ['11"', "2316x1512", "APP_IPAD_PRO_3GEN_11"],
  ['11"', "1668x2420", "APP_IPAD_PRO_3GEN_11"],
  ['11"', "2420x1668", "APP_IPAD_PRO_3GEN_11"],
  ['11"', "1668x2388", "APP_IPAD_PRO_3GEN_11"],
  ['11"', "2388x1668", "APP_IPAD_PRO_3GEN_11"],
  ['11"', "1640x2360", "APP_IPAD_PRO_3GEN_11"],
  ['11"', "2360x1640", "APP_IPAD_PRO_3GEN_11"],
  ['10.5"', "1668x2224", "APP_IPAD_105"],
  ['10.5"', "2224x1668", "APP_IPAD_105"],
  ['9.7"', "1536x2008", "APP_IPAD_97"],
  ['9.7"', "1536x2048", "APP_IPAD_97"],
  ['9.7"', "2048x1496", "APP_IPAD_97"],
  ['9.7"', "2048x1536", "APP_IPAD_97"],
  ['9.7"', "768x1004", "APP_IPAD_97"],
  ['9.7"', "768x1024", "APP_IPAD_97"],
  ['9.7"', "1024x748", "APP_IPAD_97"],
  ['9.7"', "1024x768", "APP_IPAD_97"],
];

function dims(size: string): [number, number] {
  const [w, h] = size.split("x").map(Number);
  return [w, h];
}

describe("size → display type (26 rows, hand-written)", () => {
  it("the table has 26 rows", () => expect(EXPECTED).toHaveLength(26));

  it.each(EXPECTED)("%s %s → %s", (_group, size, type) => {
    const [w, h] = dims(size);
    expect(classifyIpadScreenshot(w, h)?.displayType).toBe(type);
    expect(screenshotSizeError("ipad", w, h)).toBeNull();
  });

  it("nothing is ever classified as 12.9\" (APP_IPAD_PRO_129) — Q1", () => {
    for (const [, size] of EXPECTED) {
      const [w, h] = dims(size);
      expect(classifyIpadScreenshot(w, h)?.displayType).not.toBe("APP_IPAD_PRO_129");
    }
  });

  it("not an iPad size → null", () => {
    expect(classifyIpadScreenshot(1600, 2400)).toBeNull();
    expect(classifyIpadScreenshot(1284, 2778)).toBeNull();
    expect(classifyIpadScreenshot(2752, 2752)).toBeNull();
  });
});

describe("sizes accepted per TARGET set (editor)", () => {
  it.each([
    ["APP_IPAD_PRO_3GEN_129", ["2064x2752", "2752x2064", "2048x2732", "2732x2048"]],
    ["APP_IPAD_PRO_129", ["2048x2732", "2732x2048"]],
    ["APP_IPAD_PRO_3GEN_11", ["1488x2266", "2266x1488", "1512x2316", "2316x1512", "1668x2420", "2420x1668", "1668x2388", "2388x1668", "1640x2360", "2360x1640"]],
    ["APP_IPAD_105", ["1668x2224", "2224x1668"]],
    ["APP_IPAD_97", ["1536x2008", "1536x2048", "2048x1496", "2048x1536", "768x1004", "768x1024", "1024x748", "1024x768"]],
    // iPhone: unchanged — every iPhone set takes today's four 6.5" sizes.
    ["APP_IPHONE_65", ["1284x2778", "2778x1284", "1242x2688", "2688x1242"]],
    ["APP_IPHONE_67", ["1284x2778", "2778x1284", "1242x2688", "2688x1242"]],
  ] as const)("%s", (type, sizes) => {
    expect(sizesForDisplayType(type).map(([w, h]) => `${w}x${h}`)).toEqual(sizes);
  });
});

describe("error sentences, verbatim", () => {
  const VALID_IPAD =
    'Valid iPad sizes — 13": 2064×2752, 2752×2064, 2048×2732, 2732×2048 · ' +
    '12.9": 2048×2732, 2732×2048 · ' +
    '11": 1488×2266, 2266×1488, 1512×2316, 2316×1512, 1668×2420, 2420×1668, 1668×2388, 2388×1668, 1640×2360, 2360×1640 · ' +
    '10.5": 1668×2224, 2224×1668 · ' +
    '9.7": 1536×2008, 1536×2048, 2048×1496, 2048×1536, 768×1004, 768×1024, 1024×748, 1024×768';

  it("bulk, ipad folder, wrong size (design §4.3)", () => {
    expect(screenshotSizeError("ipad", 1600, 2400)).toBe(
      `1600×2400 is not a valid iPad screenshot size. ${VALID_IPAD}`,
    );
  });

  it("bulk, ipad folder, an iPhone image ⇒ hint to move it", () => {
    expect(screenshotSizeError("ipad", 1284, 2778)).toBe(
      "1284×2778 is not a valid iPad screenshot size — this looks like an iPhone screenshot; " +
        `move it to screenshots/iphone/. ${VALID_IPAD}`,
    );
  });

  it("bulk, iphone folder — unchanged sentence (iPhone out of scope)", () => {
    expect(screenshotSizeError("iphone", 2064, 2752)).toBe(
      "Resolution: got 2064×2752 — expected one of: 1284×2778, 2778×1284, 1242×2688, 2688×1242",
    );
  });

  it("editor, 13\" set — exactly today's sentence", () => {
    expect(screenshotSizeErrorForDisplayType("APP_IPAD_PRO_3GEN_129", 1600, 2400)).toBe(
      "Resolution: got 1600×2400 — expected one of: 2064×2752, 2752×2064, 2048×2732, 2732×2048",
    );
  });

  it("editor, 11\" set, a 13\" image ⇒ names the image's real group", () => {
    expect(screenshotSizeErrorForDisplayType("APP_IPAD_PRO_3GEN_11", 2064, 2752)).toBe(
      "Resolution: got 2064×2752 — expected one of: 1488×2266, 2266×1488, 1512×2316, 2316×1512, " +
        '1668×2420, 2420×1668, 1668×2388, 2388×1668, 1640×2360, 2360×1640 — this is an iPad 13" size, not iPad 11"',
    );
  });

  it("editor, 12.9\" set accepts 2048×2732 (the size is in both groups)", () => {
    expect(screenshotSizeErrorForDisplayType("APP_IPAD_PRO_129", 2048, 2732)).toBeNull();
    expect(screenshotSizeErrorForDisplayType("APP_IPAD_PRO_129", 2064, 2752)).toBe(
      'Resolution: got 2064×2752 — expected one of: 2048×2732, 2732×2048 — this is an iPad 13" size, not iPad 12.9"',
    );
  });
});

describe("labels + required type come from the table", () => {
  it("iPad labels", () => {
    expect({
      APP_IPAD_PRO_3GEN_129: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPAD_PRO_3GEN_129,
      APP_IPAD_PRO_129: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPAD_PRO_129,
      APP_IPAD_PRO_3GEN_11: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPAD_PRO_3GEN_11,
      APP_IPAD_105: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPAD_105,
      APP_IPAD_97: SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPAD_97,
    }).toEqual({
      APP_IPAD_PRO_3GEN_129: 'iPad 13"',
      APP_IPAD_PRO_129: 'iPad 12.9"',
      APP_IPAD_PRO_3GEN_11: 'iPad 11"',
      APP_IPAD_105: 'iPad 10.5"',
      APP_IPAD_97: 'iPad 9.7"',
    });
  });

  it("iPhone labels unchanged", () => {
    expect(SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_65).toBe('iPhone 6.5"');
    expect(SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_40).toBe('iPhone 4"');
  });

  it("the required iPad type is 13\"", () => expect(IPAD_REQUIRED_DISPLAY_TYPE).toBe("APP_IPAD_PRO_3GEN_129"));
});
