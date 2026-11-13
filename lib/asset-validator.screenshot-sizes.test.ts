// @vitest-environment jsdom
/**
 * G0 — pins TODAY's screenshot-size behaviour of `validateScreenshot` before
 * arc `[CPP-bulkimport-ipad-screenshot-sizes]` changes it (design
 * docs/cpp-management/design-cpp-bulkimport-ipad-screenshot-sizes.md §1.2,
 * §1.4, §P5.1).
 *
 * Every expected size below is written BY HAND, never read from
 * lib/asset-validator.ts — a mutated table must turn this file red.
 *
 * G1 (Manager Q2/Q4/Q5) flipped TWO blocks on purpose, named here:
 *   - "every other size on Apple's list": 20 iPad sizes were REJECTED, now
 *     accepted for ipad (still rejected for iphone);
 *   - "error text — ipad, wrong size": the sentence is now design §4.3's.
 * Every other block is G0's, unchanged.
 *
 * iPhone arc `[CPP-bulkimport-iphone-screenshot-sizes]` G1 (Manager D1/D2/Q-C/
 * Q-D): the cases tagged `[iPhone G1 FLIPPED]` pinned iPHONE behaviour of the
 * iPad arc ("iPhone unchanged / out of scope") and were flipped on purpose,
 * each title saying what it was. No iPad assertion of this file changed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { checkScreenshot, validateScreenshot } from "@/lib/asset-validator";
import { installFakeImage } from "@/components/cpp/__fixtures__/screenshot-files";

beforeAll(() => installFakeImage());

function png(name: string): File {
  return new File(["x"], name, { type: "image/png" });
}

// Hand-written — Apple docs via Manager 2026-11-06 (design §3.1).
const IPAD_ACCEPTED_TODAY = ["2064x2752", "2752x2064", "2048x2732", "2732x2048"];
const IPHONE_ACCEPTED_TODAY = ["1284x2778", "2778x1284", "1242x2688", "2688x1242"];
const IPAD_NOT_ACCEPTED_TODAY = [
  // 11"
  "1488x2266", "2266x1488", "1512x2316", "2316x1512", "1668x2420",
  "2420x1668", "1668x2388", "2388x1668", "1640x2360", "2360x1640",
  // 10.5"
  "1668x2224", "2224x1668",
  // 9.7"
  "1536x2008", "1536x2048", "2048x1496", "2048x1536",
  "768x1004", "768x1024", "1024x748", "1024x768",
];

describe("G0 — sizes accepted today (parity: must stay accepted after G1)", () => {
  it.each(IPAD_ACCEPTED_TODAY)("ipad %s → OK", async (size) => {
    const r = await validateScreenshot(png(`a-${size}.png`), "ipad");
    expect(r).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it.each(IPHONE_ACCEPTED_TODAY)("iphone %s → OK", async (size) => {
    const r = await validateScreenshot(png(`a-${size}.png`), "iphone");
    expect(r).toEqual({ ok: true, errors: [], warnings: [] });
  });
});

describe("G0 — cross-device is rejected", () => {
  it.each(IPAD_ACCEPTED_TODAY)("iPad size %s in the iphone bucket → REJECT", async (size) => {
    const r = await validateScreenshot(png(`a-${size}.png`), "iphone");
    expect(r.ok).toBe(false);
  });

  it.each(IPHONE_ACCEPTED_TODAY)("iPhone size %s in the ipad bucket → REJECT", async (size) => {
    const r = await validateScreenshot(png(`a-${size}.png`), "ipad");
    expect(r.ok).toBe(false);
  });
});

describe("[G1 FLIPPED] every other size on Apple's list — was REJECTED, now OK for ipad", () => {
  it("the list is the 20 sizes of design §1.2", () => {
    expect(IPAD_NOT_ACCEPTED_TODAY).toHaveLength(20);
  });

  it.each(IPAD_NOT_ACCEPTED_TODAY)("%s → OK for ipad, still REJECT for iphone", async (size) => {
    expect(await validateScreenshot(png(`a-${size}.png`), "ipad")).toEqual({ ok: true, errors: [], warnings: [] });
    expect((await validateScreenshot(png(`a-${size}.png`), "iphone")).ok).toBe(false);
  });
});

describe("G1 — checkScreenshot carries the display type (ipad; iphone since the iPhone arc)", () => {
  it("ipad 1668×2388 → APP_IPAD_PRO_3GEN_11; ipad 2048×2732 → APP_IPAD_PRO_3GEN_129 (Q1)", async () => {
    expect((await checkScreenshot(png("a-1668x2388.png"), "ipad")).displayType).toBe("APP_IPAD_PRO_3GEN_11");
    expect((await checkScreenshot(png("a-2048x2732.png"), "ipad")).displayType).toBe("APP_IPAD_PRO_3GEN_129");
  });

  it("[iPhone G1 FLIPPED] iphone 1284×2778 → ok, displayType APP_IPHONE_65 (was: null — iPhone routing by size, D1)", async () => {
    expect(await checkScreenshot(png("a-1284x2778.png"), "iphone")).toEqual({
      ok: true, errors: [], warnings: [], displayType: "APP_IPHONE_65",
    });
  });
});

describe("G0 — error text, verbatim (design §1.4)", () => {
  it("[G1 FLIPPED] ipad, wrong size — design §4.3 sentence", async () => {
    const r = await validateScreenshot(png("wrong-1600x2400.png"), "ipad");
    expect(r).toEqual({
      ok: false,
      errors: [
        "1600×2400 is not a valid iPad screenshot size. Valid iPad sizes — " +
          '13": 2064×2752, 2752×2064, 2048×2732, 2732×2048 · ' +
          '12.9": 2048×2732, 2732×2048 · ' +
          '11": 1488×2266, 2266×1488, 1512×2316, 2316×1512, 1668×2420, 2420×1668, 1668×2388, 2388×1668, 1640×2360, 2360×1640 · ' +
          '10.5": 1668×2224, 2224×1668 · ' +
          '9.7": 1536×2008, 1536×2048, 2048×1496, 2048×1536, 768×1004, 768×1024, 1024×748, 1024×768',
      ],
      warnings: [],
    });
  });

  it("[iPhone G1 FLIPPED] iphone, an iPad-sized image ⇒ §4.3 sentence + D8 hint (was: \"Resolution: got 2064×2752 — expected one of: <four 6.5\" sizes>\")", async () => {
    const r = await validateScreenshot(png("13in-2064x2752.png"), "iphone");
    expect(r.errors).toEqual([
      "2064×2752 is not a valid iPhone screenshot size — this looks like an iPad screenshot; move it to screenshots/ipad/. " +
        "Valid iPhone sizes — Dynamic Island (large): 1260×2736, 2736×1260, 1290×2796, 2796×1290, 1320×2868, 2868×1320 · " +
        "Face ID (large): 1284×2778, 2778×1284, 1242×2688, 2688×1242 · Dynamic Island (medium): 1179×2556, 2556×1179, 1206×2622, 2622×1206 · " +
        "Face ID (medium): 1170×2532, 2532×1170, 1125×2436, 2436×1125, 1080×2340, 2340×1080 · Home Button (large): 1242×2208, 2208×1242 · " +
        'Home Button (medium): 750×1334, 1334×750 · Home Button (4"): 640×1096, 640×1136, 1136×600, 1136×640 · ' +
        'Home Button (3.5"): 640×920, 640×960, 960×600, 960×640',
    ]);
  });

  it("unreadable image", async () => {
    const r = await validateScreenshot(png("corrupt-2064x2752.png"), "ipad");
    expect(r.errors).toEqual(["Cannot read image file — file may be corrupted"]);
  });
});
