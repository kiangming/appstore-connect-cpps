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
 * ⚠ The block "G0 TODAY — every other size on Apple's list is REJECTED" is the
 * behaviour G1 flips ON PURPOSE (20 iPad sizes become accepted). When G1 lands
 * it is replaced, not deleted silently.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { validateScreenshot } from "@/lib/asset-validator";
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

describe("G0 TODAY — every other size on Apple's list is REJECTED (G1 flips this for ipad)", () => {
  it("the list is the 20 sizes of design §1.2", () => {
    expect(IPAD_NOT_ACCEPTED_TODAY).toHaveLength(20);
  });

  it.each(IPAD_NOT_ACCEPTED_TODAY)("%s → REJECT for ipad and for iphone", async (size) => {
    expect((await validateScreenshot(png(`a-${size}.png`), "ipad")).ok).toBe(false);
    expect((await validateScreenshot(png(`a-${size}.png`), "iphone")).ok).toBe(false);
  });
});

describe("G0 — error text, verbatim (design §1.4)", () => {
  it("ipad, wrong size", async () => {
    const r = await validateScreenshot(png("11in-1668x2388.png"), "ipad");
    expect(r).toEqual({
      ok: false,
      errors: ["Resolution: got 1668×2388 — expected one of: 2064×2752, 2752×2064, 2048×2732, 2732×2048"],
      warnings: [],
    });
  });

  it("iphone, an iPad-sized image", async () => {
    const r = await validateScreenshot(png("13in-2064x2752.png"), "iphone");
    expect(r.errors).toEqual([
      "Resolution: got 2064×2752 — expected one of: 1284×2778, 2778×1284, 1242×2688, 2688×1242",
    ]);
  });

  it("unreadable image", async () => {
    const r = await validateScreenshot(png("corrupt-2064x2752.png"), "ipad");
    expect(r.errors).toEqual(["Cannot read image file — file may be corrupted"]);
  });
});
