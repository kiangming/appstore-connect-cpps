/**
 * The committed UAT kit (docs/cpp-management/uat-ipad-screenshot-sizes/, made
 * by scripts/uat/gen-ipad-screenshot-kit.py) must agree with the spec table:
 * each PNG's REAL size (read from its IHDR header) classifies into the slot
 * written by hand in its file name. Otherwise the UAT would test a kit, not
 * the tool.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { classifyIpadScreenshot, screenshotSizeError } from "./screenshot-specs";

const KIT = path.resolve(__dirname, "../../docs/cpp-management/uat-ipad-screenshot-sizes");
const IPAD = (kit: string) => path.join(KIT, kit, "UAT iPad Sizes", "en-US", "screenshots", "ipad");

// File-name group → the label of the slot it must land in (hand-written).
const SLOT_BY_GROUP: Record<string, string> = {
  "13in": 'iPad 13"',
  "13in-or-12.9in": 'iPad 13"',
  "11in": 'iPad 11"',
  "11in-only": 'iPad 11"',
  "10.5in": 'iPad 10.5"',
  "9.7in": 'iPad 9.7"',
};

function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(12, 16).toString("latin1")).toBe("IHDR");
  expect(b[25]).toBe(2); // colour type 2 = RGB, no alpha
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("UAT kit A — 24 images, every one lands in the slot its name says", () => {
  const files = readdirSync(IPAD("A-import")).filter((f) => f.endsWith(".png")).sort();

  it("24 images: 4 × 13\", 10 × 11\", 2 × 10.5\", 8 × 9.7\" (each ≤ 10 per slot)", () => {
    const count = (re: RegExp) => files.filter((f) => re.test(f)).length;
    expect(files).toHaveLength(24);
    expect(count(/-13in/)).toBe(4);
    expect(count(/-11in-/)).toBe(10);
    expect(count(/-10\.5in-/)).toBe(2);
    expect(count(/-9\.7in-/)).toBe(8);
  });

  it.each(files)("%s", (name) => {
    const m = /^\d+-(.+)-(\d+)x(\d+)\.png$/.exec(name);
    expect(m).not.toBeNull();
    const [, group, w, h] = m as RegExpExecArray;
    const [rw, rh] = pngSize(path.join(IPAD("A-import"), name));
    expect([rw, rh]).toEqual([Number(w), Number(h)]);
    expect(classifyIpadScreenshot(rw, rh)?.label).toBe(SLOT_BY_GROUP[group]);
  });
});

describe("UAT kits B and C", () => {
  it("B: the one wrong image (1600×2400) is refused", () => {
    const [name] = readdirSync(IPAD("B-wrong-size")).filter((f) => f.endsWith(".png"));
    const [w, h] = pngSize(path.join(IPAD("B-wrong-size"), name));
    expect([w, h]).toEqual([1600, 2400]);
    expect(screenshotSizeError("ipad", w, h)).not.toBeNull();
  });

  it("C: a single 11\" image (no 13\")", () => {
    const names = readdirSync(IPAD("C-no-13in")).filter((f) => f.endsWith(".png"));
    expect(names).toHaveLength(1);
    const [w, h] = pngSize(path.join(IPAD("C-no-13in"), names[0]));
    expect(classifyIpadScreenshot(w, h)?.label).toBe('iPad 11"');
  });
});
