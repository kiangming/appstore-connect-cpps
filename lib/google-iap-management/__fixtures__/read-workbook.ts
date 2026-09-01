/**
 * Read an exceljs workbook back the way a spreadsheet app would — via the
 * WRITTEN BYTES, not the object model.
 *
 * ⚠ THIS IS A CHANGE OF MEASUREMENT, NOT A LOOSENED ASSERTION. Until R5 the
 * Google export writer returned a SheetJS `WorkBook` and the tests read it
 * with `XLSX.utils.sheet_to_json`. The writer is exceljs now (SheetJS cannot
 * write freeze panes), so that reader no longer applies. Every assertion the
 * tests made still has to hold; only the way the value is obtained moved.
 *
 * ⚠ AND IT MOVED TO A STRICTER PLACE. The old reader inspected an in-memory
 * object that had never been serialised. This one writes the file and reads it
 * back, so anything the writer drops at write time — which is exactly how the
 * SheetJS styling and freeze-pane limits were discovered — now shows up.
 *
 * ⚠ `xlsx` IS USED HERE AS A READER, WHICH IS THE ONE ROLE THE SPLIT LEAVES IT
 * IN THE GOOGLE MODULE. `excel-library-split.structural.test.ts` pins that:
 * after R5 no Google file WRITES with xlsx. Reading a workbook back is the
 * same thing the upload parsers do, and xlsx is the forgiving reader.
 */
import * as XLSX from "xlsx";

/**
 * ⚠ STRUCTURAL TYPE, NOT `import type ExcelJS from "exceljs"`.
 *
 * The library fence's first rule is absolute: no file imports BOTH Excel
 * libraries. This helper reads with `xlsx`, so naming the exceljs type would
 * make it the first exception — and it caught exactly that on the first run.
 * Widening the rule to permit `import type` would have been the easy fix and
 * the wrong one: the rule exists so nobody can half-use both, and "it's only
 * a type" is how that starts.
 *
 * Only the members actually used are declared. A caller passing a real
 * `WritableWorkbook` satisfies this structurally.
 */
interface WritableWorkbook {
  xlsx: { writeBuffer(): Promise<ArrayBuffer | Buffer> };
  worksheets: Array<{ getColumn(i: number): { width?: number } }>;
}

export interface WorkbookDump {
  sheetName: string;
  /** Cell reference → value, exactly what a reader sees. Empty cells absent. */
  cells: Record<string, unknown>;
  /** `r,c-r,c` (0-based), sorted — comparable across writers. */
  merges: string[];
}

/** Serialise, then read back. Async because exceljs's writer is. */
export async function dumpWorkbook(wb: WritableWorkbook): Promise<WorkbookDump> {
  const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  const back = XLSX.read(buf, { type: "buffer" });
  const sheetName = back.SheetNames[0];
  const ws = back.Sheets[sheetName];
  const cells: Record<string, unknown> = {};
  for (const k of Object.keys(ws)) {
    if (k.startsWith("!")) continue;
    cells[k] = (ws[k] as { v?: unknown }).v ?? null;
  }
  return {
    sheetName,
    cells,
    merges: (ws["!merges"] ?? [])
      .map((m) => `${m.s.r},${m.s.c}-${m.e.r},${m.e.c}`)
      .sort(),
  };
}

/** Array-of-arrays view, for tests that used `sheet_to_json({header:1})`. */
export async function dumpAoa(wb: WritableWorkbook): Promise<unknown[][]> {
  const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  const back = XLSX.read(buf, { type: "buffer" });
  const ws = back.Sheets[back.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as unknown[][];
}

/**
 * Column widths, read from the exceljs object.
 *
 * ⚠ NOT FROM THE ROUND-TRIP. Measured: `XLSX.read` of a written file returns
 * `!cols: []` — widths do not survive that reader. Asserting them through
 * `dumpWorkbook` would therefore pass vacuously on a writer that set none.
 */
export function columnWidths(wb: WritableWorkbook, count: number): Array<number | undefined> {
  const ws = wb.worksheets[0];
  return Array.from({ length: count }, (_, i) => ws.getColumn(i + 1).width);
}

/** The raw `xl/worksheets/sheet1.xml`, for byte/pane-level assertions. */
export async function sheetXml(wb: WritableWorkbook): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  const dir = mkdtempSync(join(tmpdir(), "g-export-"));
  const file = join(dir, "out.xlsx");
  writeFileSync(file, buf);
  return execFileSync("unzip", ["-p", file, "xl/worksheets/sheet1.xml"], {
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
}

/** Raw bytes of one archive member — for encoding assertions. */
export async function partBytes(wb: WritableWorkbook, member: string): Promise<Buffer> {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  const dir = mkdtempSync(join(tmpdir(), "g-export-"));
  const file = join(dir, "out.xlsx");
  writeFileSync(file, buf);
  return execFileSync("unzip", ["-p", file, member], { maxBuffer: 32 * 1024 * 1024 });
}
