/**
 * The committed iPhone UAT kit (docs/cpp-management/uat-iphone-screenshot-sizes/,
 * made by scripts/uat/gen-iphone-screenshot-kit.py) must agree with the spec
 * table: each PNG's REAL size (read from its IHDR header) classifies into the
 * slot written by hand below for its file-name group (label + display type).
 * The text PRINTED on the images comes from the generator's GROUPS; the last
 * block reads the generator source and checks GROUPS against the same
 * hand-written slots, so a changed row cannot leave the printed "API: …" stale
 * (the PNGs themselves are only re-checked by regenerating). Otherwise the UAT
 * would test a kit, not the tool. Model: lib/cpp/uat-ipad-kit.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ScreenshotDisplayType } from "@/types/asc";
import {
  IPHONE_SCREENSHOT_SIZES,
  classifyIpadScreenshot,
  classifyIphoneScreenshot,
  isIphoneDuoSize,
  screenshotSizeError,
} from "./screenshot-specs";
import { checkScreenshotGroups } from "./screenshot-upload";

const KIT = path.resolve(__dirname, "../../docs/cpp-management/uat-iphone-screenshot-sizes");
const IPHONE = (kit: string) => path.join(KIT, kit, "UAT iPhone Sizes", "en-US", "screenshots", "iphone");
const pngs = (kit: string) => readdirSync(IPHONE(kit)).filter((f) => f.endsWith(".png")).sort();

// File-name group → the slot it must land in (hand-written, Manager Q-C labels).
const SLOT_BY_GROUP: Record<string, { label: string; type: string }> = {
  "di-large": { label: "iPhone Dynamic Island (large)", type: "APP_IPHONE_67" },
  "faceid-large": { label: "iPhone Face ID (large)", type: "APP_IPHONE_65" },
  "di-medium": { label: "iPhone Dynamic Island (medium)", type: "APP_IPHONE_61" },
  "faceid-medium": { label: "iPhone Face ID (medium)", type: "APP_IPHONE_58" },
  "hb-large": { label: "iPhone Home Button (large)", type: "APP_IPHONE_55" },
  "hb-medium": { label: "iPhone Home Button (medium)", type: "APP_IPHONE_47" },
  "hb-4in": { label: 'iPhone Home Button (4")', type: "APP_IPHONE_40" },
  "hb-3.5in": { label: 'iPhone Home Button (3.5")', type: "APP_IPHONE_35" },
};

function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(12, 16).toString("latin1")).toBe("IHDR");
  expect(b[25]).toBe(2); // colour type 2 = RGB, no alpha
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function parse(name: string): { group: string; w: number; h: number } {
  const m = /^\d+-(.+)-(\d+)x(\d+)\.png$/.exec(name);
  expect(m).not.toBeNull();
  const [, group, w, h] = m as RegExpExecArray;
  return { group, w: Number(w), h: Number(h) };
}

describe("UAT kit A — 32 images, every one lands in the slot its name says", () => {
  const files = pngs("A-import");

  it("32 images: 6 · 4 · 4 · 6 · 2 · 2 · 4 · 4 per group (each ≤ 10 per slot), numbered 01..32", () => {
    const count = (group: string) => files.filter((f) => parse(f).group === group).length;
    expect(files).toHaveLength(32);
    expect(files.map((f) => f.slice(0, 3))).toEqual(
      Array.from({ length: 32 }, (_, i) => `${String(i + 1).padStart(2, "0")}-`),
    );
    expect(count("di-large")).toBe(6);
    expect(count("faceid-large")).toBe(4);
    expect(count("di-medium")).toBe(4);
    expect(count("faceid-medium")).toBe(6);
    expect(count("hb-large")).toBe(2);
    expect(count("hb-medium")).toBe(2);
    expect(count("hb-4in")).toBe(4);
    expect(count("hb-3.5in")).toBe(4);
  });

  it("covers every iPhone size the tool uploads, once", () => {
    const kitSizes = files.map((f) => `${parse(f).w}x${parse(f).h}`).sort();
    const tableSizes = IPHONE_SCREENSHOT_SIZES.map(([w, h]) => `${w}x${h}`).sort();
    expect(kitSizes).toEqual(tableSizes);
  });

  it.each(files)("%s", (name) => {
    const { group, w, h } = parse(name);
    const [rw, rh] = pngSize(path.join(IPHONE("A-import"), name));
    expect([rw, rh]).toEqual([w, h]);
    const spec = classifyIphoneScreenshot(rw, rh);
    expect(spec?.label).toBe(SLOT_BY_GROUP[group].label);
    expect(spec?.displayType).toBe(SLOT_BY_GROUP[group].type);
    expect(screenshotSizeError("iphone", rw, rh)).toBeNull();
  });

  it("Preview of the whole kit: no error (≤ 10 per type), no D3 warning (Dynamic Island (large) present)", () => {
    const byType = new Map<ScreenshotDisplayType, File[]>();
    for (const name of files) {
      const { w, h } = parse(name);
      const type = classifyIphoneScreenshot(w, h)?.displayType;
      expect(type).toBeDefined();
      if (type) byType.set(type, [...(byType.get(type) ?? []), new File(["x"], name)]);
    }
    const groups = [...byType].map(([displayType, f]) => ({ displayType, files: f }));
    expect(groups).toHaveLength(8);
    expect(Math.max(...groups.map((g) => g.files.length))).toBeLessThanOrEqual(10);
    expect(checkScreenshotGroups("iphone", groups, new Map())).toEqual({ errors: [], warnings: [] });
  });
});

describe("UAT kit B — 3 images, all BLOCKED", () => {
  const files = pngs("B-blocked");

  it("exactly 97-DUO, 98-IPAD, 99-WRONG; real size = name", () => {
    expect(files).toEqual(["97-DUO-1398x2034.png", "98-IPAD-2064x2752.png", "99-WRONG-1200x2400.png"]);
    for (const name of files) {
      const { w, h } = parse(name);
      expect(pngSize(path.join(IPHONE("B-blocked"), name))).toEqual([w, h]);
      expect(screenshotSizeError("iphone", w, h)).not.toBeNull();
      expect(classifyIphoneScreenshot(w, h)).toBeNull();
    }
  });

  it("Duo: the Manager Q-D sentence, verbatim", () => {
    expect(screenshotSizeError("iphone", 1398, 2034)).toBe(
      "1398×2034 is an iPhone Duo screenshot size — iPhone Duo is not supported by the App Store Connect API yet; upload it manually on App Store Connect.",
    );
  });

  it("iPad 13\" in iphone/: refused with the D8 hint", () => {
    expect(classifyIpadScreenshot(2064, 2752)?.label).toBe('iPad 13"');
    expect(screenshotSizeError("iphone", 2064, 2752)).toContain(
      "— this looks like an iPad screenshot; move it to screenshots/ipad/",
    );
  });

  it("1200×2400: in NO table (iPhone, iPad, Duo) ⇒ the plain wrong-size sentence", () => {
    expect(classifyIphoneScreenshot(1200, 2400)).toBeNull();
    expect(classifyIpadScreenshot(1200, 2400)).toBeNull();
    expect(isIphoneDuoSize(1200, 2400)).toBe(false);
    const err = screenshotSizeError("iphone", 1200, 2400) ?? "";
    expect(err.startsWith("1200×2400 is not a valid iPhone screenshot size. Valid iPhone sizes — ")).toBe(true);
    expect(err).not.toContain("looks like");
  });
});

describe("UAT kit C — only Dynamic Island (medium) ⇒ D3 warning, not blocked", () => {
  const files = pngs("C-warning");

  it("exactly 2 images, both APP_IPHONE_61 (neither APP_IPHONE_67 nor APP_IPHONE_65)", () => {
    expect(files).toEqual(["01-di-medium-only-1179x2556.png", "02-di-medium-only-1206x2622.png"]);
    for (const name of files) {
      const [w, h] = pngSize(path.join(IPHONE("C-warning"), name));
      expect([w, h]).toEqual([parse(name).w, parse(name).h]);
      const type = classifyIphoneScreenshot(w, h)?.displayType;
      expect(type).toBe("APP_IPHONE_61");
      expect(type).not.toBe("APP_IPHONE_67");
      expect(type).not.toBe("APP_IPHONE_65");
    }
  });

  it("Preview on a locale with no iPhone set yet: the D3 warning, no error", () => {
    const groups = [{ displayType: "APP_IPHONE_61" as const, files: files.map((n) => new File(["x"], n)) }];
    expect(checkScreenshotGroups("iphone", groups, new Map())).toEqual({
      errors: [],
      warnings: [
        "No required iPhone screenshots — Apple requires Dynamic Island (large) or Face ID (large) screenshots for apps that run on iPhone. Import is not blocked.",
      ],
    });
  });
});

describe("generator GROUPS = the hand-written slots (the text printed on kit A)", () => {
  it("every (slug, printed group, printed API type) in scripts/uat/gen-iphone-screenshot-kit.py matches SLOT_BY_GROUP", () => {
    const src = readFileSync(path.resolve(__dirname, "../../scripts/uat/gen-iphone-screenshot-kit.py"), "utf8");
    const block = src.slice(src.indexOf("GROUPS = ["), src.indexOf("]),\n]", src.indexOf("GROUPS = [")) + 4);
    const tuples = [...block.matchAll(/\("([^"]+)", (?:"([^"]+)"|'([^']+)'), "(APP_IPHONE_\d+)"/g)].map((m) => [m[1], m[2] ?? m[3], m[4]]);
    expect(tuples.map(([slug]) => slug)).toEqual(Object.keys(SLOT_BY_GROUP));
    for (const [slug, printed, type] of tuples) {
      expect(type).toBe(SLOT_BY_GROUP[slug].type);
      expect(printed).toBe(SLOT_BY_GROUP[slug].label.replace(/^iPhone /, "").toUpperCase());
    }
  });
});
