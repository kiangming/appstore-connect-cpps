// @vitest-environment jsdom
/**
 * G0 — pins how BOTH bulk-import folder parsers decide iPhone vs iPad today
 * (design docs/cpp-management/design-cpp-bulkimport-ipad-screenshot-sizes.md
 * §1.3). The device comes from the folder NAME only; any other sub-folder
 * under `screenshots/` is skipped silently. Arc G1 keeps this behaviour (the
 * display type is chosen by image size, the device still by folder).
 *
 * Twin: `parseCppFolderStructure` (many CPPs, `<root>/<CPP>/<locale>/…`) and
 * `parseFolderStructure` (one CPP, `<root>/<locale>/…`) carry the same rule.
 */
import { describe, it, expect } from "vitest";
import { parseCppFolderStructure } from "@/lib/parseCppFolderStructure";
import { parseFolderStructure } from "@/lib/parseFolderStructure";
import { fileAt } from "@/components/cpp/__fixtures__/screenshot-files";

// Path under `<locale>/` → expected bucket (hand-written).
const CASES: Array<[string, "ipad" | "iphone" | "skipped"]> = [
  ["screenshots/ipad/01.png", "ipad"],
  ["screenshots/iPad/02.png", "ipad"],
  ["screenshots/IPAD/03.png", "ipad"],
  ["screenshots/ipad-11/04.png", "skipped"],
  ["screenshots/ipad 13/05.png", "skipped"],
  ["screenshots/ipad/11/06.png", "skipped"],
  ["screenshots/07.png", "skipped"],
  ["screenshots/iphone/08.png", "iphone"],
];

function expected(bucket: "ipad" | "iphone") {
  return CASES.filter(([, b]) => b === bucket).map(([p]) => p.split("/").pop());
}

describe("G0 — folder → device (parseCppFolderStructure, many CPPs)", () => {
  it("only screenshots/<iphone|ipad>/<file> is picked up, case-insensitively", () => {
    const out = parseCppFolderStructure(CASES.map(([p]) => fileAt(`root/CPP A/en-US/${p}`)));
    expect(out.cpps).toHaveLength(1);
    const loc = out.cpps[0].locales[0];
    expect(loc.screenshotFiles.ipad.map((f) => f.name)).toEqual(expected("ipad"));
    expect(loc.screenshotFiles.iphone.map((f) => f.name)).toEqual(expected("iphone"));
  });
});

describe("G0 — folder → device (parseFolderStructure, one CPP)", () => {
  it("only screenshots/<iphone|ipad>/<file> is picked up, case-insensitively", () => {
    const out = parseFolderStructure(CASES.map(([p]) => fileAt(`root/en-US/${p}`)));
    expect(out).toHaveLength(1);
    expect(out[0].screenshotFiles.ipad.map((f) => f.name)).toEqual(expected("ipad"));
    expect(out[0].screenshotFiles.iphone.map((f) => f.name)).toEqual(expected("iphone"));
  });
});
