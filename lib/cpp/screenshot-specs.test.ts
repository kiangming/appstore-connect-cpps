/**
 * G1 — the size → display type table (arc `[CPP-bulkimport-ipad-screenshot-sizes]`,
 * design docs/cpp-management/design-cpp-bulkimport-ipad-screenshot-sizes.md
 * §3.1, §4.3, §P6-chốt).
 *
 * ⚠ The expected table is written BY HAND from Manager's list (Apple docs,
 * 2026-11-06) — never derived from `IPAD_SCREENSHOT_SPECS`, so that a mutated
 * spec row turns this file red.
 *
 * iPhone arc `[CPP-bulkimport-iphone-screenshot-sizes]` G1 (Manager D1/D2/Q-C/
 * Q-D): the cases tagged `[iPhone G1 FLIPPED]` pinned iPHONE behaviour of the
 * iPad arc ("iPhone unchanged / out of scope") and were flipped on purpose,
 * each title saying what it was. No iPad assertion of this file changed.
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
    // iPhone: unchanged by the iPhone arc for APP_IPHONE_65 (its own group = the four 6.5" sizes).
    ["APP_IPHONE_65", ["1284x2778", "2778x1284", "1242x2688", "2688x1242"]],
  ] as const)("%s", (type, sizes) => {
    expect(sizesForDisplayType(type).map(([w, h]) => `${w}x${h}`)).toEqual(sizes);
  });

  it("[iPhone G1 FLIPPED] APP_IPHONE_67 takes its OWN group's sizes, D2 (was: the four 6.5\" sizes — every iPhone set took them)", () => {
    expect(sizesForDisplayType("APP_IPHONE_67").map(([w, h]) => `${w}x${h}`)).toEqual([
      "1260x2736", "2736x1260", "1290x2796", "2796x1290", "1320x2868", "2868x1320",
    ]);
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

  it("[iPhone G1 FLIPPED] bulk, iphone folder, an iPad image ⇒ §4.3 sentence + D8 hint (was: \"Resolution: got 2064×2752 — expected one of: <four 6.5\" sizes>\", iPhone out of scope)", () => {
    expect(screenshotSizeError("iphone", 2064, 2752)).toBe(
      "2064×2752 is not a valid iPhone screenshot size — this looks like an iPad screenshot; move it to screenshots/ipad/. " +
        "Valid iPhone sizes — Dynamic Island (large): 1260×2736, 2736×1260, 1290×2796, 2796×1290, 1320×2868, 2868×1320 · " +
        "Face ID (large): 1284×2778, 2778×1284, 1242×2688, 2688×1242 · Dynamic Island (medium): 1179×2556, 2556×1179, 1206×2622, 2622×1206 · " +
        "Face ID (medium): 1170×2532, 2532×1170, 1125×2436, 2436×1125, 1080×2340, 2340×1080 · Home Button (large): 1242×2208, 2208×1242 · " +
        'Home Button (medium): 750×1334, 1334×750 · Home Button (4"): 640×1096, 640×1136, 1136×600, 1136×640 · ' +
        'Home Button (3.5"): 640×920, 640×960, 960×600, 960×640',
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

  it("[iPhone G1 FLIPPED] iPhone labels = Apple's group names, Q-C (was: 'iPhone 6.5\"', 'iPhone 4\"')", () => {
    expect(SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_65).toBe("iPhone Face ID (large)");
    expect(SCREENSHOT_DISPLAY_TYPE_LABELS.APP_IPHONE_40).toBe('iPhone Home Button (4")');
  });

  it("the required iPad type is 13\"", () => expect(IPAD_REQUIRED_DISPLAY_TYPE).toBe("APP_IPAD_PRO_3GEN_129"));
});
