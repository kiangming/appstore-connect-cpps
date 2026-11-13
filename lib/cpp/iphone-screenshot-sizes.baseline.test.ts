// @vitest-environment jsdom
/**
 * G0 — pins TODAY's iPhone screenshot-size behaviour before arc
 * `[CPP-bulkimport-iphone-screenshot-sizes]` changes it (design
 * docs/cpp-management/design-cpp-bulkimport-iphone-screenshot-sizes.md §C1, §G0).
 *
 * Real `validateScreenshot` / `validateScreenshotForDisplayType`; the size
 * comes from the file name via the fake `Image`. Every size below is written
 * BY HAND from Manager's list (Apple docs, 2026-11-13) — never read from
 * lib/cpp/screenshot-specs.ts.
 *
 * G1 (Manager D1/D2/D6/D8/Q-A) FLIPPED the blocks tagged `[G1 FLIPPED]` on
 * purpose — each title says what it was. Untagged blocks are G0's, unchanged.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { validateScreenshot, validateScreenshotForDisplayType } from "@/lib/asset-validator";
import { installFakeImage } from "@/components/cpp/__fixtures__/screenshot-files";

beforeAll(() => installFakeImage());

const png = (size: string) => new File(["x"], `a-${size}.png`, { type: "image/png" });

// Manager's list, by group (36 sizes, no size in two groups — census C3).
const FACE_ID_LARGE = ["1284x2778", "2778x1284", "1242x2688", "2688x1242"];
const NOT_ACCEPTED_TODAY: Record<string, string[]> = {
  "iPhone Duo": ["1398x2034", "2034x1398", "2007x2853", "2853x2007"],
  "Dynamic Island (large)": ["1260x2736", "2736x1260", "1290x2796", "2796x1290", "1320x2868", "2868x1320"],
  "Dynamic Island (medium)": ["1179x2556", "2556x1179", "1206x2622", "2622x1206"],
  "Face ID (medium)": ["1170x2532", "2532x1170", "1125x2436", "2436x1125", "1080x2340", "2340x1080"],
  "Home Button (large)": ["1242x2208", "2208x1242"],
  "Home Button (medium)": ["750x1334", "1334x750"],
  'Home Button (4")': ["640x1096", "640x1136", "1136x600", "1136x640"],
  'Home Button (3.5")': ["640x920", "640x960", "960x600", "960x640"],
};
const NOT_ACCEPTED_ROWS = Object.entries(NOT_ACCEPTED_TODAY).flatMap(([g, sizes]) => sizes.map((s) => [g, s]));
const ALL_ROWS = [...FACE_ID_LARGE.map((s) => ["Face ID (large)", s]), ...NOT_ACCEPTED_ROWS];

describe("G0 — Face ID (large) 6.5\" sizes are accepted today (parity: still accepted after G1)", () => {
  it.each(FACE_ID_LARGE)("iphone %s → OK", async (size) => {
    expect(await validateScreenshot(png(size), "iphone")).toEqual({ ok: true, errors: [], warnings: [] });
  });
});

describe("[G1 FLIPPED] the other 32 sizes of Apple's iPhone list — were all REJECTED in iphone/", () => {
  it("32 sizes (28 now accepted + 4 iPhone Duo, still refused — D6)", () => {
    expect(NOT_ACCEPTED_ROWS).toHaveLength(32);
  });

  const NOW_ACCEPTED = NOT_ACCEPTED_ROWS.filter(([g]) => g !== "iPhone Duo");
  const DUO = NOT_ACCEPTED_ROWS.filter(([g]) => g === "iPhone Duo");

  it("28 + 4", () => {
    expect([NOW_ACCEPTED.length, DUO.length]).toEqual([28, 4]);
  });

  it.each(NOW_ACCEPTED)("%s %s → OK for iphone (was: REJECT)", async (_g, size) => {
    expect(await validateScreenshot(png(size), "iphone")).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it.each(DUO)("%s %s → still REJECT for iphone, now with the Duo sentence (Q-D)", async (_g, size) => {
    const [w, h] = size.split("x");
    expect((await validateScreenshot(png(size), "iphone")).errors).toEqual([
      `${w}×${h} is an iPhone Duo screenshot size — iPhone Duo is not supported by the App Store Connect API yet; upload it manually on App Store Connect.`,
    ]);
  });
});

describe("G0 — no iPhone size is an iPad size (stays: every one is REJECTED in ipad/)", () => {
  it("36 sizes", () => expect(ALL_ROWS).toHaveLength(36));

  it.each(ALL_ROWS)("%s %s → REJECT for ipad", async (_g, size) => {
    expect((await validateScreenshot(png(size), "ipad")).ok).toBe(false);
  });
});

describe("[G1 FLIPPED] editor checks the TARGET set (D2) — was: EVERY iPhone set took exactly the four 6.5\" sizes", () => {
  // [type, accepts 1284×2778 (Face ID large), accepts 1290×2796 (Dynamic Island large)] — hand-written.
  const ROWS = [
    ["APP_IPHONE_67", false, true],
    ["APP_IPHONE_65", true, false],
    ["APP_IPHONE_61", false, false],
    ["APP_IPHONE_58", false, false],
    ["APP_IPHONE_55", false, false],
    ["APP_IPHONE_47", false, false],
    ["APP_IPHONE_40", false, false],
    ["APP_IPHONE_35", false, false],
  ] as const;

  it.each(ROWS)("%s: 1284×2778 → %s, 1290×2796 → %s", async (type, takes65, takes67) => {
    expect((await validateScreenshotForDisplayType(png("1284x2778"), type)).ok).toBe(takes65);
    expect((await validateScreenshotForDisplayType(png("1290x2796"), type)).ok).toBe(takes67);
  });
});

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

describe("error sentences, verbatim", () => {
  it("[G1 FLIPPED] iphone/, a Dynamic Island (medium) image ⇒ accepted (was: \"Resolution: got 1179×2556 — expected one of: <4 sizes>\")", async () => {
    expect(await validateScreenshot(png("1179x2556"), "iphone")).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it("[G1 FLIPPED] iphone/, an iPad image ⇒ §4.3 sentence + D8 hint (was: no hint)", async () => {
    expect((await validateScreenshot(png("2064x2752"), "iphone")).errors).toEqual([
      `2064×2752 is not a valid iPhone screenshot size — this looks like an iPad screenshot; move it to screenshots/ipad/. ${VALID_IPHONE}`,
    ]);
  });

  it("ipad/, a 6.5\" iPhone image ⇒ the move-it hint (iPad behaviour, must stay)", async () => {
    expect((await validateScreenshot(png("1284x2778"), "ipad")).errors[0]).toMatch(
      /^1284×2778 is not a valid iPad screenshot size — this looks like an iPhone screenshot; move it to screenshots\/iphone\/\. Valid iPad sizes — /,
    );
  });

  it("[G1 FLIPPED: Manager Q-A] ipad/, a Dynamic Island (medium) image ⇒ the move-it hint (was: no hint — only the four 6.5\" sizes had it)", async () => {
    expect((await validateScreenshot(png("1179x2556"), "ipad")).errors[0]).toMatch(
      /^1179×2556 is not a valid iPad screenshot size — this looks like an iPhone screenshot; move it to screenshots\/iphone\/\. Valid iPad sizes — /,
    );
  });
});
