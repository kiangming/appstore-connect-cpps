/**
 * The written .xlsx, at the level of its BYTES.
 *
 * Every other test in this module inspects the object model — the array of
 * arrays handed to SheetJS. That cannot see an encoding bug: a workbook whose
 * parts are written latin-1 has a perfectly correct object model, round-trips
 * through SheetJS's own reader looking fine, and opens in Excel as
 * "CÃ´te dâ€™Ivoire". Only the file can say.
 *
 * ⚠ THIS IS THE APPLE ARC'S LESSON, NOT A NEW ONE — and deliberately not a
 * copy of its test. Apple pinned `—` (U+2014) and `·` (U+00B7) at this layer
 * for exactly this failure. But Apple's writer is **exceljs**, which puts
 * text in `xl/sharedStrings.xml`; the Google writer is **xlsx** (SheetJS),
 * which — measured, not assumed — emits NO sharedStrings part at all and
 * writes `<c t="str"><v>…</v></c>` inline into `xl/worksheets/sheet1.xml`.
 * A ported assertion would have unzipped a part that does not exist, and
 * `unzip` failing is not the same as the characters being wrong.
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as XLSX from "xlsx";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildExportPlan, buildExportWorkbook } from "./xlsx-export";

/** The only two labels in the 173-row Console table with non-ASCII characters. */
const NON_ASCII_PRODUCT = {
  sku: "sku-accents",
  status: "active",
  listings: { "en-US": { title: "Accent probe", description: "d" } },
  prices: {
    CI: { currency: "XOF", priceMicros: "1000000" },
    TR: { currency: "TRY", priceMicros: "1000000" },
  },
} as unknown as Parameters<typeof buildExportPlan>[0][number];

let sheetBytes: Buffer;
let sheetText: string;

beforeAll(() => {
  const wb = buildExportWorkbook(buildExportPlan([NON_ASCII_PRODUCT]));
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const dir = mkdtempSync(join(tmpdir(), "google-iap-export-"));
  const file = join(dir, "out.xlsx");
  writeFileSync(file, buf);
  // `-p` streams one member to stdout; no encoding option, so this is raw.
  sheetBytes = execFileSync("unzip", ["-p", file, "xl/worksheets/sheet1.xml"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  sheetText = sheetBytes.toString("utf8");
});

describe("⚠ `Côte d’Ivoire` and `Türkiye` reach the bytes as UTF-8", () => {
  it("the three characters are present as their exact UTF-8 byte sequences", () => {
    // Asserted as BYTES, not as a decoded string: decoding first would let a
    // wrongly-encoded file be repaired by the reader before the assertion
    // ever saw it.
    //   ô  U+00F4 → C3 B4
    //   ’  U+2019 → E2 80 99
    //   ü  U+00FC → C3 BC
    expect(sheetBytes.includes(Buffer.from([0xc3, 0xb4])), "ô as C3 B4").toBe(true);
    expect(sheetBytes.includes(Buffer.from([0xe2, 0x80, 0x99])), "’ as E2 80 99").toBe(true);
    expect(sheetBytes.includes(Buffer.from([0xc3, 0xbc])), "ü as C3 BC").toBe(true);
  });

  it("the full headers read back correctly", () => {
    expect(sheetText).toContain("Price in Côte d’Ivoire (CI)");
    expect(sheetText).toContain("Price in Türkiye (TR)");
  });

  it("⚠ NOT mojibake — no double-encoded `Ã` anywhere in the sheet", () => {
    // The signature of UTF-8 bytes re-encoded as UTF-8 after being read as
    // latin-1: "Côte" becomes "CÃ´te", "Türkiye" becomes "TÃ¼rkiye". `Ã` is
    // U+00C3 and appears in no legitimate label in the table.
    expect(sheetText).not.toContain("Ã");
    expect(sheetText).not.toContain("â€™");
  });

  it("⚠ NOT numeric character references — Excel would render them literally", () => {
    // A writer that escapes non-ASCII "to be safe" produces a file that opens
    // showing `C&#244;te`. Valid XML, wrong output.
    expect(sheetText).not.toContain("&#244;");
    expect(sheetText).not.toContain("&#8217;");
    expect(sheetText).not.toContain("&#252;");
  });

  it("⚠ the apostrophe is U+2019, not the ASCII U+0027", () => {
    // The failure that survives every other check in this file: `Côte
    // d'Ivoire` is valid UTF-8, is not mojibake, is not an entity, and is
    // still not what Play Console shows.
    expect(sheetText).toContain("Côte d’Ivoire");
    expect(sheetText).not.toContain("Côte d'Ivoire");
  });
});

describe("the accents do not disturb the file's shape", () => {
  it("SheetJS still writes the headers inline, with no sharedStrings part", () => {
    // Pinned because this file's whole approach depends on it. If SheetJS
    // ever switches to a shared-string table, the assertions above would read
    // a sheet that no longer contains the text and pass vacuously.
    expect(sheetText).toContain('t="str"');
    expect(sheetText).toContain("<v>Price in Côte d’Ivoire (CI)</v>");
  });
});
