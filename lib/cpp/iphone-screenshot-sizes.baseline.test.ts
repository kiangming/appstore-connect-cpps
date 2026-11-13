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
 * Blocks tagged `[G1 FLIPS]` pin behaviour that Manager's D1–D9 change on
 * purpose; G1 replaces them and says so ("was: …"). Untagged blocks must stay
 * green unchanged.
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

describe("[G1 FLIPS] every other size on Apple's iPhone list is REJECTED in iphone/ today", () => {
  it("32 sizes (28 to become accepted + 4 iPhone Duo, which stays refused — D6)", () => {
    expect(NOT_ACCEPTED_ROWS).toHaveLength(32);
  });

  it.each(NOT_ACCEPTED_ROWS)("%s %s → REJECT for iphone", async (_g, size) => {
    expect((await validateScreenshot(png(size), "iphone")).ok).toBe(false);
  });
});

describe("G0 — no iPhone size is an iPad size (stays: every one is REJECTED in ipad/)", () => {
  it("36 sizes", () => expect(ALL_ROWS).toHaveLength(36));

  it.each(ALL_ROWS)("%s %s → REJECT for ipad", async (_g, size) => {
    expect((await validateScreenshot(png(size), "ipad")).ok).toBe(false);
  });
});

describe("[G1 FLIPS] editor today: EVERY iPhone set accepts exactly the four 6.5\" sizes (not checked against the target set)", () => {
  const IPHONE_TYPES = ["APP_IPHONE_67", "APP_IPHONE_65", "APP_IPHONE_61", "APP_IPHONE_55", "APP_IPHONE_47", "APP_IPHONE_40", "APP_IPHONE_35"] as const;

  it.each(IPHONE_TYPES)("%s: 1284×2778 accepted, 1290×2796 refused", async (type) => {
    expect((await validateScreenshotForDisplayType(png("1284x2778"), type)).ok).toBe(true);
    expect((await validateScreenshotForDisplayType(png("1290x2796"), type)).ok).toBe(false);
  });
});

describe("error sentences today, verbatim", () => {
  it("[G1 FLIPS] iphone/, a Dynamic Island (medium) image", async () => {
    expect((await validateScreenshot(png("1179x2556"), "iphone")).errors).toEqual([
      "Resolution: got 1179×2556 — expected one of: 1284×2778, 2778×1284, 1242×2688, 2688×1242",
    ]);
  });

  it("[G1 FLIPS] iphone/, an iPad image — no hint today (D8 adds one)", async () => {
    expect((await validateScreenshot(png("2064x2752"), "iphone")).errors).toEqual([
      "Resolution: got 2064×2752 — expected one of: 1284×2778, 2778×1284, 1242×2688, 2688×1242",
    ]);
  });

  it("ipad/, a 6.5\" iPhone image ⇒ the move-it hint (iPad behaviour, must stay)", async () => {
    expect((await validateScreenshot(png("1284x2778"), "ipad")).errors[0]).toMatch(
      /^1284×2778 is not a valid iPad screenshot size — this looks like an iPhone screenshot; move it to screenshots\/iphone\/\. Valid iPad sizes — /,
    );
  });

  it("[G1: Manager Q-A] ipad/, a Dynamic Island (medium) image ⇒ NO hint today (hint covers only the four 6.5\" sizes)", async () => {
    expect((await validateScreenshot(png("1179x2556"), "ipad")).errors[0]).toMatch(
      /^1179×2556 is not a valid iPad screenshot size\. Valid iPad sizes — /,
    );
  });
});
