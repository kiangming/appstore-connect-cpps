/**
 * PA2.2 — the reader of the "Export for editing" file
 * (design-template-matrix-reimport.md §L2.9; rules 1–3 + Q-D, Q-H…Q-K, Q-Q).
 *
 * Files come from the REAL writer (the same function the route calls), then
 * are edited the way a spreadsheet edits them — through exceljs on the
 * workbook, or by rewriting the saved XML (Excel's 17-digit numbers) — and
 * read back by the real reader. The full-grid cases use the real Manager
 * template (95 tiers × 175 territories = 16 625 prices).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type ExcelJS from "exceljs";

import { buildTemplateMatrixWorkbook } from "../xlsx-template-matrix-export";
import { composeMatrix, type TemplateEntryRow } from "../queries/template-matrix";
import { flattenTemplateEntries, type FlatTemplateEntry } from "./price-tiers";
import { loadRealTemplateFile, type RealTemplateFile } from "../queries/pglite-iap-db.test-helper";
import type { EditExportInfo } from "../template-matrix-edit-spec";
import { isMatrixEditFile, MatrixEditFileError, parseMatrixEditFile, type MatrixEditFile } from "./template-matrix-edit";

const INFO: EditExportInfo = {
  scope: { kind: "ACCOUNT", accountId: "acct-1", accountName: "Account One" },
  exportedAt: "2026-10-20T03:00:00.000Z",
  exportedBy: "manager@example.test",
};

let real: RealTemplateFile;
let knownTiers: Map<string, string>;

beforeAll(async () => {
  real = await loadRealTemplateFile();
  knownTiers = new Map(real.parsed.tiers.map((t) => [t.tier_id, t.tier_name]));
}, 60_000);

/** The writer's edit-mode workbook for `entries`, optionally edited, as a File. */
async function editFile(
  entries: ReadonlyArray<FlatTemplateEntry>,
  edit?: (ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook) => void,
  opts: { view?: boolean; scope?: "default" | "per-app"; info?: EditExportInfo } = {},
): Promise<File> {
  const matrix = composeMatrix({ entries: entries as TemplateEntryRow[], tierNames: knownTiers });
  const wb = buildTemplateMatrixWorkbook({
    matrix,
    visibleMarkets: matrix.markets,
    showDiff: false,
    scope: opts.scope ?? "default",
    ...(opts.view ? {} : { edit: opts.info ?? INFO }),
  });
  if (edit) edit(wb.worksheets[0], wb);
  return new File([new Uint8Array(await wb.xlsx.writeBuffer())], "edit.xlsx");
}

/** A small grid: Tier 1 / Tier 2 / Tier 10 × USA, VNM, JPN — all full. */
function small(): FlatTemplateEntry[] {
  return real.entries.filter(
    (e) => ["TIER_1", "TIER_2", "TIER_10"].includes(e.tier_id) && ["USA", "VNM", "JPN"].includes(e.territory_code),
  );
}
/** Address of a cell in the small grid: row by tier, column by territory. */
function at(tier: "TIER_1" | "TIER_2" | "TIER_10", code: "USA" | "VNM" | "JPN", half: "price" | "currency" = "price"): string {
  const cols = { USA: "B", VNM: "D", JPN: "F" } as const;
  const curCols = { USA: "C", VNM: "E", JPN: "G" } as const;
  const row = { TIER_1: 3, TIER_2: 4, TIER_10: 5 }[tier];
  return `${half === "price" ? cols[code] : curCols[code]}${row}`;
}

async function problemsOf(file: File): Promise<MatrixEditFileError> {
  const err = await parseMatrixEditFile(file, knownTiers).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MatrixEditFileError);
  return err as MatrixEditFileError;
}

const keyed = (es: ReadonlyArray<FlatTemplateEntry>) =>
  new Map(es.map((e) => [`${e.tier_id}|${e.territory_code}`, e]));

describe("PA2.2 reader — an unedited file reads back as exactly the template", () => {
  it("R1 the real 16 625-price template: same keys, currency, price (Object.is); proceeds null; column + row order kept", async () => {
    const out: MatrixEditFile = await parseMatrixEditFile(await editFile(real.entries), knownTiers);
    const got = flattenTemplateEntries(out.parsed);
    expect(got).toHaveLength(16_625);
    const want = keyed(real.entries);
    const wrong = got.filter((g) => {
      const w = want.get(`${g.tier_id}|${g.territory_code}`);
      return !w || w.currency_code !== g.currency_code || !Object.is(g.customer_price, Number(w.customer_price));
    });
    expect(wrong).toEqual([]);
    expect(got.every((g) => g.proceeds === null)).toBe(true);
    expect(out.territories).toEqual(real.territoryOrder);
    expect(out.scope).toEqual(INFO.scope);
    expect(out.parsed.warnings).toEqual([]);
  });

  it("R2 Excel's 17-digit <v> numbers (every price rewritten) read back as the same 16 625 prices", async () => {
    const file = await editFile(real.entries);
    const dir = mkdtempSync(join(tmpdir(), "pa22-"));
    writeFileSync(join(dir, "in.xlsx"), new Uint8Array(await file.arrayBuffer()));
    execFileSync("unzip", ["-q", "in.xlsx", "-d", "x"], { cwd: dir });
    const sheetPath = join(dir, "x/xl/worksheets/sheet1.xml");
    let rewritten = 0;
    const xml = readFileSync(sheetPath, "utf8").replace(/<c ([^>]*?)><v>([^<]+)<\/v><\/c>/g, (m, attrs: string, v: string) => {
      if (/t="/.test(attrs)) return m; // shared strings, not numbers
      rewritten += 1;
      return `<c ${attrs}><v>${Number(v).toPrecision(17)}</v></c>`;
    });
    writeFileSync(sheetPath, xml);
    execFileSync("zip", ["-q", "-r", "-X", "../out.xlsx", ...readdirSync(join(dir, "x"))], { cwd: join(dir, "x") });
    expect(rewritten).toBe(16_625);
    const out = await parseMatrixEditFile(new File([readFileSync(join(dir, "out.xlsx"))], "out.xlsx"), knownTiers);
    const want = keyed(real.entries);
    const wrong = flattenTemplateEntries(out.parsed).filter(
      (g) => !Object.is(g.customer_price, Number(want.get(`${g.tier_id}|${g.territory_code}`)!.customer_price)),
    );
    expect(wrong).toEqual([]);
  });
});

describe("PA2.2 reader — rules 2 and 3", () => {
  it("R3 a price typed into a '·' cell is an override in the HEADER's currency (Q-D); a changed price is the new price", async () => {
    const entries = small().filter((e) => !(e.tier_id === "TIER_2" && e.territory_code === "JPN"));
    const file = await editFile(entries, (ws) => {
      ws.getCell(at("TIER_2", "JPN")).value = 1500; // was "·", Currency cell still "·"
      ws.getCell(at("TIER_1", "VNM")).value = 25000;
    });
    const got = keyed(flattenTemplateEntries((await parseMatrixEditFile(file, knownTiers)).parsed));
    expect(got.get("TIER_2|JPN")).toMatchObject({ customer_price: 1500, currency_code: "JPY" });
    expect(got.get("TIER_1|VNM")).toMatchObject({ customer_price: 25000, currency_code: "VND" });
  });

  it("R4 a cleared price is NO override — even with the Currency cell left beside it (Excel keeps it); '·' is no override too", async () => {
    const file = await editFile(small(), (ws) => {
      ws.getCell(at("TIER_1", "USA")).value = null; // cleared; C3 still "USD"
      ws.getCell(at("TIER_2", "VNM")).value = "·";
      ws.getCell(at("TIER_10", "JPN")).value = "  ";
    });
    const got = keyed(flattenTemplateEntries((await parseMatrixEditFile(file, knownTiers)).parsed));
    expect(got.has("TIER_1|USA")).toBe(false);
    expect(got.has("TIER_2|VNM")).toBe(false);
    expect(got.has("TIER_10|JPN")).toBe(false);
    expect(got.size).toBe(9 - 3);
  });

  it("R5 Q-K: unambiguous text prices are read (\"2.49\", \"160\"); a lower-case Currency equal to the header is accepted", async () => {
    const file = await editFile(small(), (ws) => {
      ws.getCell(at("TIER_1", "USA")).value = "2.49";
      ws.getCell(at("TIER_1", "JPN")).value = "160";
      ws.getCell(at("TIER_1", "JPN", "currency")).value = "jpy";
    });
    const got = keyed(flattenTemplateEntries((await parseMatrixEditFile(file, knownTiers)).parsed));
    expect(got.get("TIER_1|USA")?.customer_price).toBe(2.49);
    expect(got.get("TIER_1|JPN")).toMatchObject({ customer_price: 160, currency_code: "JPY" });
  });

  it("R6 rows and columns may be removed (Q-P): what is not in the file is not in the result", async () => {
    const file = await editFile(small(), (ws) => {
      ws.spliceColumns(6, 2); // JPN
      ws.spliceRows(5, 1); // Tier 10
    });
    const out = await parseMatrixEditFile(file, knownTiers);
    expect(out.territories).toEqual(["USA", "VNM"]);
    expect(out.tierIds).toEqual(["TIER_1", "TIER_2"]);
    expect(flattenTemplateEntries(out.parsed)).toHaveLength(4);
  });
});

describe("PA2.2 reader — every doubt is a refusal, with its cell address (nothing is written)", () => {
  it("R7 a VIEW export (no _import_info) is NOT an edit file", async () => {
    const err = await problemsOf(await editFile(small(), undefined, { view: true }));
    expect(err.code).toBe("NOT_EDIT_FILE");
    expect(err.message).toMatch(/not an "Export for editing" file/);
  });

  it("R8 the info sheet must describe a supported file; the price sheet must be there", async () => {
    const badFormat = await problemsOf(
      await editFile(small(), (_ws, wb) => {
        wb.getWorksheet("_import_info")!.getCell("B2").value = "something-else";
      }),
    );
    expect(badFormat.code).toBe("INVALID_FILE");
    expect(badFormat.message).toMatch(/does not describe a supported file/);
    const renamed = await problemsOf(await editFile(small(), (ws) => { ws.name = "Sheet1"; }));
    expect(renamed.message).toMatch(/The sheet "Default Template" is missing/);
  });

  it("R9 headers: no code, a code Apple does not sell in, a duplicate territory", async () => {
    const err = await problemsOf(
      await editFile(small(), (ws) => {
        ws.getCell("B1").value = "United States";
        ws.getCell("D1").value = "Vietnam (ZZZ_VND)";
      }),
    );
    expect(err.problems.map((p) => p.cell)).toEqual(["B1", "D1"]);
    expect(err.problems[0].message).toMatch(/must look like "Vietnam \(VNM_VND\)"/);
    expect(err.problems[1].message).toMatch(/"ZZZ" is not a territory Apple sells in/);

    const dup = await problemsOf(await editFile(small(), (ws) => { ws.getCell("F1").value = "Japan (USA_USD)"; }));
    expect(dup.problems).toEqual([{ cell: "F1", message: expect.stringMatching(/USA appears twice \(also B1\)/) }]);
  });

  it("R10 Q-H tiers: not a tier name · no such tier · not the canonical spelling · twice", async () => {
    const err = await problemsOf(
      await editFile(small(), (ws) => {
        ws.getCell("A3").value = "Bogus";
        ws.getCell("A4").value = "Tier 05";
        ws.getCell("A5").value = "tier 10";
      }),
    );
    expect(err.problems).toEqual([
      { cell: "A3", message: expect.stringMatching(/"Bogus" is not a tier name/) },
      { cell: "A4", message: expect.stringMatching(/"Tier 05" — there is no such tier/) },
      { cell: "A5", message: expect.stringMatching(/"tier 10" is not a tier name/) },
    ]);
    const alt = real.entries.filter((e) => e.tier_id === "ALT_A" && e.territory_code === "USA");
    const nonCanonical = await problemsOf(await editFile(alt, (ws) => { ws.getCell("A3").value = "Alternate Tier a"; }));
    expect(nonCanonical.problems).toEqual([{ cell: "A3", message: 'write the tier exactly as "Alternate Tier A"' }]);
    const twice = await problemsOf(await editFile(small(), (ws) => { ws.getCell("A4").value = "Tier 1"; }));
    expect(twice.problems).toEqual([{ cell: "A4", message: expect.stringMatching(/Tier 1 appears twice \(also A3\)/) }]);
  });

  it("R11 prices: formula · negative · more than 4 decimals (Q-J) · too large · ambiguous or comma text (Q-K) · boolean", async () => {
    const err = await problemsOf(
      await editFile(small(), (ws) => {
        ws.getCell(at("TIER_1", "USA")).value = { formula: "0.5*2" } as ExcelJS.CellFormulaValue;
        ws.getCell(at("TIER_1", "VNM")).value = -1;
        ws.getCell(at("TIER_1", "JPN")).value = 1.23456;
        ws.getCell(at("TIER_2", "USA")).value = 1e12;
        ws.getCell(at("TIER_2", "VNM")).value = "49.000";
        ws.getCell(at("TIER_2", "JPN")).value = "1,99";
        ws.getCell(at("TIER_10", "USA")).value = true;
      }),
    );
    expect(err.problems.map((p) => p.cell)).toEqual(["B3", "D3", "F3", "B4", "D4", "F4", "B5"]);
    expect(err.problems.map((p) => p.message)).toEqual([
      expect.stringMatching(/is a formula/),
      expect.stringMatching(/-1 is not a price/),
      expect.stringMatching(/1\.23456 has more than 4 decimals/),
      expect.stringMatching(/too large/),
      expect.stringMatching(/"49\.000" is ambiguous/),
      expect.stringMatching(/"1,99" is text with a comma/),
      expect.stringMatching(/is not a price \(boolean/),
    ]);
    expect(err.message).toMatch(/7 problems\. Nothing was written\./);
  });

  it("R12 Q-D: a Currency cell that contradicts its header is refused, with the reason", async () => {
    const err = await problemsOf(await editFile(small(), (ws) => { ws.getCell(at("TIER_1", "VNM", "currency")).value = "USD"; }));
    expect(err.problems).toEqual([
      {
        cell: "E3",
        message: expect.stringMatching(/Currency says "USD" but the column is VNM_VND — the currency comes from the column header/),
      },
    ]);
  });

  it("R16 a header currency that is not the one Apple bills (KB §4.19; prod V2 = 0 rows, 2026-10-20) is refused, naming the right one", async () => {
    const err = await problemsOf(await editFile(small(), (ws) => { ws.getCell("D1").value = "Vietnam (VNM_USD)"; }));
    expect(err.problems).toEqual([
      { cell: "D1", message: 'the header says VNM_USD, but Apple bills VNM in VND — write "(VNM_VND)"' },
    ]);
  });

  it("R13 a value outside the grid (a column with no territory header) is refused", async () => {
    const err = await problemsOf(await editFile(small(), (ws) => { ws.getCell("J4").value = 99; }));
    expect(err.problems).toEqual([{ cell: "J4", message: "has a value but its column has no territory header" }]);
  });

  it("R14 Q-Q: a file with no price at all is refused — it would empty the template", async () => {
    const err = await problemsOf(
      await editFile(small(), (ws) => {
        for (const t of ["TIER_1", "TIER_2", "TIER_10"] as const)
          for (const c of ["USA", "VNM", "JPN"] as const) ws.getCell(at(t, c)).value = "·";
      }),
    );
    expect(err.problems).toEqual([{ cell: null, message: expect.stringMatching(/The file has no prices/) }]);
  });
});

describe("PA2.2 — telling the files apart (sniff)", () => {
  it("R15 an edit file yes; a view export, the format-A template and garbage no", async () => {
    expect(await isMatrixEditFile(await editFile(small()))).toBe(true);
    expect(await isMatrixEditFile(await editFile(small(), undefined, { view: true }))).toBe(false);
    expect(await isMatrixEditFile(new File([new Uint8Array(real.bytes)], "price-tiers-template.xlsx"))).toBe(false);
    expect(await isMatrixEditFile(new File(["x"], "x.xlsx"))).toBe(false);
  });
});
