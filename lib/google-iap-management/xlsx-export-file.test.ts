/**
 * The written .xlsx, at the level of its BYTES.
 *
 * Every other test in this module inspects the object model — the array of
 * arrays handed to SheetJS. That cannot see an encoding bug: a workbook whose
 * parts are written latin-1 has a perfectly correct object model, round-trips
 * through SheetJS's own reader looking fine, and opens in Excel as
 * "CÃ´te dâ€™Ivoire". Only the file can say.
 *
 * ⚠ R5 — WHERE THE TEXT LIVES CHANGED, BECAUSE THE WRITER CHANGED. Until R5
 * the Google writer was SheetJS, which emits NO `sharedStrings.xml` and writes
 * `<c t="str"><v>…</v></c>` inline into `xl/worksheets/sheet1.xml`; these tests
 * read that part. The writer is exceljs now (SheetJS cannot write freeze
 * panes) and exceljs uses a shared-string table, so the same characters live
 * in `xl/sharedStrings.xml`.
 *
 * ⚠ THAT IS A CHANGE OF WHERE TO LOOK, NOT A LOOSENED ASSERTION. Every claim
 * below is the same claim — the exact UTF-8 byte sequences, no mojibake, no
 * entities, the curly apostrophe — and the part name is pinned so a future
 * writer swap fails loudly here instead of reading an empty file and passing.
 *
 * ⚠ THE ORIGINAL LESSON IS APPLE'S, and the shape of the trap has now bitten
 * in both directions: porting Apple's `sharedStrings` assertion to SheetJS
 * would have unzipped a part that does not exist, and keeping SheetJS's
 * `sheet1.xml` assertion under exceljs would have searched a part the text is
 * no longer in. Neither failure looks like an encoding bug.
 */
import { describe, it, expect, beforeAll } from "vitest";

import { buildExportPlan, buildExportWorkbook } from "./xlsx-export";
import { partBytes, sheetXml } from "./__fixtures__/read-workbook";

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
let paneXml: string;

beforeAll(async () => {
  const wb = buildExportWorkbook(buildExportPlan([NON_ASCII_PRODUCT]));
  // ⚠ THE STRINGS ARE IN `sharedStrings.xml` NOW — see the header.
  sheetBytes = await partBytes(wb, "xl/sharedStrings.xml");
  sheetText = sheetBytes.toString("utf8");
  paneXml = await sheetXml(wb);
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
  it("⚠ the text really is in the part this file reads — no vacuous pass", () => {
    // Pinned because everything above depends on it. If a future writer swap
    // moves the strings back inline, these assertions would search an empty
    // (or absent) shared-string table and pass while proving nothing. That is
    // exactly the failure R5 walked into from the other side.
    expect(sheetText).toContain("<sst");
    expect(sheetText).toContain("Price in Côte d’Ivoire (CI)");
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * R5 — the freeze pane, at the level of the file.
 * ──────────────────────────────────────────────────────────────────────── */

describe("⚠ R5 — the freeze pane reaches the bytes", () => {
  it("`xl/worksheets/sheet1.xml` carries a frozen pane at 3 columns × 2 rows", () => {
    // ⚠ THE WHOLE REASON THE WRITER CHANGED. SheetJS produced a bare
    // `<sheetView workbookViewId="0"/>` with no `<pane>` for all four API
    // variants tried, which is why this assertion could not exist before.
    expect(paneXml).toMatch(/<pane\b/);
    expect(paneXml).toMatch(/xSplit="3"/);
    expect(paneXml).toMatch(/ySplit="2"/);
    expect(paneXml).toMatch(/state="frozen"/);
  });

  it("⚠ 3 columns, not Apple's 4 — this file has no Base Country column", () => {
    // Copying Apple's number would strand the first country pair inside the
    // frozen region, where it cannot scroll.
    expect(paneXml).not.toMatch(/xSplit="4"/);
  });

  it("⚠ 2 rows, not 1 — the country name and its Price/Currency pair", () => {
    // Freezing only row 1 leaves a price column scrolled away from the word
    // saying which half of the pair it is.
    expect(paneXml).not.toMatch(/ySplit="1"/);
  });

  it("the frozen top-left cell is D3 — the first scrollable data cell", () => {
    expect(paneXml).toMatch(/topLeftCell="D3"/);
  });
});
