// @vitest-environment jsdom
/**
 * G1 — iPhone images routed by SIZE in both bulk dialogs (arc
 * `[CPP-bulkimport-iphone-screenshot-sizes]`, Manager D1, D3, D6, D7, D8,
 * Q-C, Q-D): each image goes to the set of the display type its size maps to
 * (lib/cpp/screenshot-specs.ts), one set per type, an existing set of the
 * same type reused, file-name order kept. Preview video untouched.
 *
 * Real folder parsers + real validator (size from the file name via the fake
 * `Image`); only `fetch` is faked. Every expected request and sentence is
 * written by hand. G0 pins + their flips live in
 * iphone-screenshot-routing.baseline.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import { installFakeImage } from "./__fixtures__/screenshot-files";
import { MANY, ONE, previewOnly, runImport, type Req, type Scenario } from "./__fixtures__/bulk-dialog-harness";

beforeEach(() => installFakeImage());
afterEach(() => vi.unstubAllGlobals());

const IP = (name: string) => `en-US/screenshots/iphone/${name}`;
const NO_REQUIRED_IPHONE =
  "No required iPhone screenshots — Apple requires Dynamic Island (large) or Face ID (large) screenshots for apps that run on iPhone. Import is not blocked.";

const MIXED = [
  IP("01-hb4-640x1136.png"),
  IP("02-dil-1290x2796.png"),
  IP("03-fim-1170x2532.png"),
  IP("04-dil-1320x2868.png"),
  IP("05-fil-1284x2778.png"),
];
const MIXED_EXPECTED: Req[] = [
  ["POST set", "loc-new-en-US", "APP_IPHONE_67"],
  ["upload", "set-new-APP_IPHONE_67", "02-dil-1290x2796.png"],
  ["upload", "set-new-APP_IPHONE_67", "04-dil-1320x2868.png"],
  ["POST set", "loc-new-en-US", "APP_IPHONE_65"],
  ["upload", "set-new-APP_IPHONE_65", "05-fil-1284x2778.png"],
  ["POST set", "loc-new-en-US", "APP_IPHONE_58"],
  ["upload", "set-new-APP_IPHONE_58", "03-fim-1170x2532.png"],
  ["POST set", "loc-new-en-US", "APP_IPHONE_40"],
  ["upload", "set-new-APP_IPHONE_40", "01-hb4-640x1136.png"],
];

describe.each([MANY, ONE])("G1 — iPhone images routed by size — $name", (d) => {
  it("mixed folder ⇒ one set per type, largest screen first, file-name order inside each", async () => {
    expect(await runImport(d, { existing: [], files: MIXED })).toEqual(MIXED_EXPECTED);
  });

  it("one image per group ⇒ 8 sets in order 67, 65, 61, 58, 55, 47, 40, 35", async () => {
    const reqs = await runImport(d, {
      existing: [],
      files: [
        IP("01-1260x2736.png"), IP("02-2778x1284.png"), IP("03-1206x2622.png"), IP("04-2436x1125.png"),
        IP("05-2208x1242.png"), IP("06-750x1334.png"), IP("07-1136x600.png"), IP("08-960x640.png"),
      ],
    });
    expect(reqs.filter((r) => r[0] === "POST set").map((r) => r[2])).toEqual([
      "APP_IPHONE_67", "APP_IPHONE_65", "APP_IPHONE_61", "APP_IPHONE_58",
      "APP_IPHONE_55", "APP_IPHONE_47", "APP_IPHONE_40", "APP_IPHONE_35",
    ]);
    expect(reqs.filter((r) => r[0] === "upload").map((r) => r[2])).toEqual([
      "01-1260x2736.png", "02-2778x1284.png", "03-1206x2622.png", "04-2436x1125.png",
      "05-2208x1242.png", "06-750x1334.png", "07-1136x600.png", "08-960x640.png",
    ]);
  });

  it("existing 6.5\" set is reused for 6.5\" images; a 6.7\" image gets a new 6.7\" set", async () => {
    expect(
      await runImport(d, {
        existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-65", type: "APP_IPHONE_65" }] }],
        files: [IP("01-1242x2688.png"), IP("02-1290x2796.png")],
      }),
    ).toEqual([
      ["POST set", "loc-en", "APP_IPHONE_67"],
      ["upload", "set-new-APP_IPHONE_67", "02-1290x2796.png"],
      ["upload", "set-65", "01-1242x2688.png"],
    ]);
  });

  it("iPhone groups go before iPad groups", async () => {
    expect(
      await runImport(d, {
        existing: [],
        files: ["en-US/screenshots/ipad/01-1668x2388.png", IP("01-1179x2556.png"), IP("02-1290x2796.png")],
      }),
    ).toEqual([
      ["POST set", "loc-new-en-US", "APP_IPHONE_67"],
      ["upload", "set-new-APP_IPHONE_67", "02-1290x2796.png"],
      ["POST set", "loc-new-en-US", "APP_IPHONE_61"],
      ["upload", "set-new-APP_IPHONE_61", "01-1179x2556.png"],
      ["POST set", "loc-new-en-US", "APP_IPAD_PRO_3GEN_11"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_11", "01-1668x2388.png"],
    ]);
  });

  it("Preview lists which images go to which screen type, with Apple's group names (Q-C)", async () => {
    const { container } = await previewOnly(d, { existing: [], files: MIXED });
    const text = container.textContent ?? "";
    expect(text).toContain("iPhone Dynamic Island (large): 02-dil-1290x2796.png, 04-dil-1320x2868.png");
    expect(text).toContain("iPhone Face ID (large): 05-fil-1284x2778.png");
    expect(text).toContain("iPhone Face ID (medium): 03-fim-1170x2532.png");
    expect(text).toContain('iPhone Home Button (4"): 01-hb4-640x1136.png');
    expect(text).not.toMatch(/iPhone: 0/); // the old single "iPhone: …" line is gone
  });

  it("D3 — only Dynamic Island (medium) ⇒ warning in the locale + footer count, Import NOT blocked, imports into 61", async () => {
    const s: Scenario = { existing: [], files: [IP("01-1179x2556.png"), IP("02-1206x2622.png")] };
    const { container } = await previewOnly(d, s);
    expect(container.textContent).toContain(NO_REQUIRED_IPHONE);
    expect(container.textContent).toMatch(/1 (locale )?without required iPhone screenshots/);
    expect(screen.getByRole("button", { name: /Import All/ })).not.toBeDisabled();
    document.body.innerHTML = "";
    expect(await runImport(d, s)).toEqual([
      ["POST set", "loc-new-en-US", "APP_IPHONE_61"],
      ["upload", "set-new-APP_IPHONE_61", "01-1179x2556.png"],
      ["upload", "set-new-APP_IPHONE_61", "02-1206x2622.png"],
    ]);
  });

  it("D3 — only Dynamic Island (medium) but the locale already has a 6.5\" set ⇒ no warning", async () => {
    const { container } = await previewOnly(d, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-65", type: "APP_IPHONE_65", count: 2 }] }],
      files: [IP("01-1179x2556.png")],
    });
    expect(container.textContent).not.toMatch(/required iPhone screenshots/);
  });

  it("D6 — a Duo image ⇒ blocked with the Duo sentence, nothing sent", async () => {
    const { requests, container } = await previewOnly(d, { existing: [], files: [IP("01-1290x2796.png"), IP("02-duo-2007x2853.png")] });
    expect(screen.getByRole("button", { name: /Import All/ })).toBeDisabled();
    expect(container.textContent).toContain(
      "02-duo-2007x2853.png: 2007×2853 is an iPhone Duo screenshot size — iPhone Duo is not supported by the App Store Connect API yet; upload it manually on App Store Connect.",
    );
    expect(requests).toEqual([]);
  });

  it("D8 — an iPad image in iphone/ ⇒ blocked with the move-it hint", async () => {
    const { container } = await previewOnly(d, { existing: [], files: [IP("01-2064x2752.png")] });
    expect(screen.getByRole("button", { name: /Import All/ })).toBeDisabled();
    expect(container.textContent).toContain(
      "01-2064x2752.png: 2064×2752 is not a valid iPhone screenshot size — this looks like an iPad screenshot; move it to screenshots/ipad/. Valid iPhone sizes — Dynamic Island (large): 1260×2736",
    );
  });

  it("wrong size ⇒ blocked with the §4.3-shaped sentence", async () => {
    const { container } = await previewOnly(d, { existing: [], files: [IP("01-1200x2400.png")] });
    expect(screen.getByRole("button", { name: /Import All/ })).toBeDisabled();
    expect(container.textContent).toContain(
      '01-1200x2400.png: 1200×2400 is not a valid iPhone screenshot size. Valid iPhone sizes — Dynamic Island (large): 1260×2736, 2736×1260, 1290×2796, 2796×1290, 1320×2868, 2868×1320 · Face ID (large):',
    );
  });

  it("D7 — 11 images of one iPhone type ⇒ blocked", async () => {
    const files = Array.from({ length: 11 }, (_, i) => IP(`${String(i).padStart(2, "0")}-750x1334.png`));
    const { container } = await previewOnly(d, { existing: [], files });
    expect(screen.getByRole("button", { name: /Import All/ })).toBeDisabled();
    expect(container.textContent).toContain("Too many screenshots for iPhone Home Button (medium): 11 — max 10");
  });

  it("D7 — 10 already in the 6.7\" set + 1 new 6.7\" ⇒ blocked, counted from included[]", async () => {
    const { container } = await previewOnly(d, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-67", type: "APP_IPHONE_67", count: 10, listed: 3 }] }],
      files: [IP("01-1290x2796.png")],
    });
    expect(screen.getByRole("button", { name: /Import All/ })).toBeDisabled();
    expect(container.textContent).toContain(
      "Too many screenshots for iPhone Dynamic Island (large): 11 (10 already on Apple + 1 new) — max 10",
    );
  });

  it("iPad warning and iPhone warning are separate (each device's own required set)", async () => {
    const { container } = await previewOnly(d, {
      existing: [],
      files: ["en-US/screenshots/ipad/01-1668x2388.png", IP("01-1179x2556.png")],
    });
    const text = container.textContent ?? "";
    expect(text).toContain(NO_REQUIRED_IPHONE);
    expect(text).toContain('No iPad 13" screenshots');
  });
});

describe("G1 — twin: the same images through both dialogs ⇒ the same request sequence", () => {
  it("mixed iPhone + iPad, existing 6.5\" and iPad 11\" sets", async () => {
    const s: Scenario = {
      existing: [{
        locale: "en-US",
        locId: "loc-en",
        sets: [{ id: "set-65", type: "APP_IPHONE_65" }, { id: "set-11", type: "APP_IPAD_PRO_3GEN_11" }],
      }],
      files: [...MIXED, "en-US/screenshots/ipad/01-2064x2752.png", "en-US/screenshots/ipad/02-1668x2388.png"],
    };
    const many = await runImport(MANY, s);
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    installFakeImage();
    const one = await runImport(ONE, s);
    expect(many).toEqual([
      ["POST set", "loc-en", "APP_IPHONE_67"],
      ["upload", "set-new-APP_IPHONE_67", "02-dil-1290x2796.png"],
      ["upload", "set-new-APP_IPHONE_67", "04-dil-1320x2868.png"],
      ["upload", "set-65", "05-fil-1284x2778.png"],
      ["POST set", "loc-en", "APP_IPHONE_58"],
      ["upload", "set-new-APP_IPHONE_58", "03-fim-1170x2532.png"],
      ["POST set", "loc-en", "APP_IPHONE_40"],
      ["upload", "set-new-APP_IPHONE_40", "01-hb4-640x1136.png"],
      ["POST set", "loc-en", "APP_IPAD_PRO_3GEN_129"],
      ["upload", "set-new-APP_IPAD_PRO_3GEN_129", "01-2064x2752.png"],
      ["upload", "set-11", "02-1668x2388.png"],
    ]);
    expect(one).toEqual(many);
  });
});

describe("G1c — CppBulkImportDialog: the existing CPP's localizations could not be read ⇒ 'unknown', not 'empty' (KB P7)", () => {
  it("only Dynamic Island (medium) in a locale of an existing CPP whose read failed ⇒ NO required-set warning (was: warned as if the locale were empty)", async () => {
    const { container } = await previewOnly(MANY, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-67", type: "APP_IPHONE_67", count: 3 }] }],
      cppReadFails: true,
      files: [IP("01-1179x2556.png")],
    });
    expect(container.textContent).toContain("iPhone Dynamic Island (medium): 01-1179x2556.png");
    expect(container.textContent).not.toMatch(/required iPhone screenshots/);
  });

  it("the same for iPad: only 11\" images ⇒ no iPad 13\" warning when the read failed", async () => {
    const { container } = await previewOnly(MANY, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [{ id: "set-13", type: "APP_IPAD_PRO_3GEN_129", count: 3 }] }],
      cppReadFails: true,
      files: ["en-US/screenshots/ipad/01-1668x2388.png"],
    });
    expect(container.textContent).toContain('iPad 11": 01-1668x2388.png');
    expect(container.textContent).not.toMatch(/No iPad 13"|without iPad 13"/);
  });

  it("control: the read succeeds and the locale really has no required set ⇒ the warning shows", async () => {
    const { container } = await previewOnly(MANY, {
      existing: [{ locale: "en-US", locId: "loc-en", sets: [] }],
      files: [IP("01-1179x2556.png")],
    });
    expect(container.textContent).toContain(NO_REQUIRED_IPHONE);
  });
});

