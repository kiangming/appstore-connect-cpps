/**
 * R5 — THE PARITY GATE for swapping the export writer from SheetJS to exceljs.
 *
 * ⚠ THIS REWROTE A WRITER THAT WAS ALREADY IN PRODUCTION, to add a display
 * convenience. The only honest way to do that is to prove the new file is the
 * old file — so this compares the WHOLE written workbook against a dump
 * captured from the SheetJS writer BEFORE the swap
 * (`__fixtures__/export-golden.json`), on one fixed input chosen to cover
 * everything the writer can produce:
 *
 *   · two items — one fully populated, one with no prices and no listings
 *   · a ticked territory nobody prices (`ER`) → the `—` column
 *   · the two non-ASCII labels (`CI`, `TR`)
 *   · a row with fewer localizations than the widest
 *   · a null product name
 *
 * ⚠ THE COMPARISON IS THROUGH THE FILE, NOT THE OBJECT MODEL. Both dumps come
 * from writing bytes and reading them back with the same reader, so the two
 * writers' different in-memory shapes cannot hide a difference.
 *
 * ⚠ WHAT IS ALLOWED TO DIFFER: nothing except the freeze pane, which the old
 * writer could not produce at all. That exception is asserted positively in
 * `xlsx-export-file.test.ts` rather than waved through here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildExportPlan, buildExportWorkbook } from "./xlsx-export";
import { dumpWorkbook, columnWidths } from "./__fixtures__/read-workbook";

/** ⚠ MUST STAY IDENTICAL to the input the golden was captured from. */
const PRODUCTS = [
  {
    sku: "gem.small",
    status: "active",
    listings: {
      "en-US": { title: "Small gems", description: "Desc EN" },
      vi: { title: "Kim cương nhỏ", description: "Mô tả" },
    },
    prices: {
      US: { currency: "USD", priceMicros: "1990000" },
      VN: { currency: "VND", priceMicros: "49000000000" },
      CI: { currency: "XOF", priceMicros: "1200000000" },
      TR: { currency: "TRY", priceMicros: "69900000" },
    },
  },
  { sku: "starter", status: "inactive", listings: null, prices: {} },
] as never[];
const TERRITORIES = ["US", "VN", "CI", "TR", "ER"];

const golden = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "export-golden.json"), "utf8"),
) as { sheetName: string; cells: Record<string, unknown>; merges: string[] };

async function current() {
  return dumpWorkbook(buildExportWorkbook(buildExportPlan(PRODUCTS, TERRITORIES)));
}

describe("⚠ R5 parity — the exceljs file IS the SheetJS file", () => {
  it("same sheet name", async () => {
    expect((await current()).sheetName).toBe(golden.sheetName);
  });

  it("every cell, same reference, same value — 53 of them", async () => {
    // The whole assertion in one line. If a single cell moved, shifted or
    // changed type, this fails and `toEqual` prints exactly which.
    const dump = await current();
    expect(Object.keys(golden.cells)).toHaveLength(53);
    expect(dump.cells).toEqual(golden.cells);
  });

  it("no cell was added and none was lost", async () => {
    // Stated separately from the value comparison so a failure reads as
    // "the shape changed" rather than "some value changed".
    const dump = await current();
    expect(Object.keys(dump.cells).sort()).toEqual(Object.keys(golden.cells).sort());
  });

  it("all 10 merges, identical rectangles", async () => {
    const dump = await current();
    expect(golden.merges).toHaveLength(10);
    expect(dump.merges).toEqual(golden.merges);
  });

  it("the two header rows still line up under their merged labels", async () => {
    const dump = await current();
    // Row 1 carries the country name, row 2 the Price/Currency pair.
    expect(dump.cells["D1"]).toBe("Price in Côte d’Ivoire (CI)");
    expect(dump.cells["D2"]).toBe("Price");
    expect(dump.cells["E2"]).toBe("Currency");
  });

  it("the `—` column for a ticked-but-unpriced territory survived the swap", async () => {
    const dump = await current();
    expect(dump.cells["F1"]).toBe("Price in Eritrea (ER)");
    expect(dump.cells["F3"]).toBe("—");
    expect(dump.cells["G3"]).toBe("—");
  });

  it("⚠ column widths are counted per COLUMN, not measured from text", async () => {
    // ⚠ READ FROM THE exceljs OBJECT, NOT THE ROUND TRIP. Measured: `XLSX.read`
    // of a written file returns `!cols: []`, so asserting widths through the
    // dump would pass on a writer that set none. The golden therefore cannot
    // cover this and it is pinned here directly.
    const wb = buildExportWorkbook(buildExportPlan(PRODUCTS, TERRITORIES));
    // 3 fixed + 5 territories × 2 + 2 localization groups × 2 = 17.
    expect(columnWidths(wb, 17)).toEqual([
      40, 28, 10,
      10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
      12, 34, 12, 34,
    ]);
  });
});
