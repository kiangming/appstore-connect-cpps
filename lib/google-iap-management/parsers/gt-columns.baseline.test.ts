/**
 * [GOOGLE-bulkimport-drop-gt] What the Google bulk-import TEMPLATE and PARSER
 * do with "GT Price" / "GT Currency" (Manager 2026-10-21; design
 * docs/google-iap-management/design-bulkimport-drop-gt-columns.md).
 *
 * G0 (2e3c3e0) pinned the behaviour BEFORE the change; G1 edited this file on
 * purpose — its diff is the record of what the change did:
 *   - the template no longer has the two columns (core 2 · 1 locale 4 ·
 *     3 locales 8 · full 166), the Notes never mention them and tell the user
 *     to copy column by column; sample rows and the Notes table are built by
 *     header NAME;
 *   - the parser never reads them (Manager Q1): an old file — any value,
 *     junk included, any header spelling, either column alone — reads EXACTLY
 *     like the same file without them; it only reports `retiredGtColumns`
 *     (the preview's notice, never a refusal). A row with only GT is an empty
 *     row (gate G0);
 *   - Manager Q6: a bare-number Title with a three-capital-letter
 *     Description (an old row pasted whole) refuses the row.
 *
 * Every value comes from the REAL generator (googleIapTemplateSpec →
 * buildTemplateWorkbook, the chain the Download button runs) and the REAL
 * parser (parseIapTemplate, the one the preview route runs). An OLD file is
 * the G0-era template rebuilt cell for cell from what G0 pinned (headers,
 * sample rows with GT 26000 / 52000 / 598000 VND, spacer, note), or the
 * Manager's own legacy file. Preview, execute, the request to Google and the
 * audit are pinned in app/api/google-iap-management/apps/[packageName]/
 * bulk-import/gt-columns.route.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

import {
  googleIapTemplateSpec,
  googleLocalePairHeaders,
  googleRetiredGtWarning,
  GOOGLE_DATA_SHEET_NAME,
  GOOGLE_LOCALE_NAMES,
  GOOGLE_RETIRED_GT_HEADERS,
} from "./template-spec";
import { parseIapTemplate } from "./excel-parser";
import { buildTemplateWorkbook, TEMPLATE_SAMPLE_PRODUCT_IDS, TEMPLATE_SAMPLE_ROWS_NOTE } from "@/lib/xlsx-template";

const NOTES = "Notes";
const roundTrip = (wb: XLSX.WorkBook) => XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
const template = (sel: readonly string[] | undefined) => {
  const spec = googleIapTemplateSpec(sel);
  return { spec, wb: roundTrip(buildTemplateWorkbook(XLSX, spec)) };
};
/** A sheet as the reader sees it, trailing padding cells removed. */
function rowsOf(wb: XLSX.WorkBook, sheet: string): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, blankrows: true, defval: "" }).map((r) => {
    const row = [...r];
    while (row.length > 0 && row[row.length - 1] === "") row.pop();
    return row;
  });
}
const notesRow = (wb: XLSX.WorkBook, excelRow: number) => rowsOf(wb, NOTES)[excelRow - 1] ?? [];

const LEAD = ["Product ID", "Price (USD)"];
const SAMPLES = [
  ["com.vngg.tool.product.sample01", 0.99],
  ["com.vngg.tool.product.sample02", 1.99],
  ["com.vngg.tool.product.sample03", 22.99],
];
const SAMPLE_LISTINGS = [1, 2, 3].map((i) => [`Sample product 0${i}`, `Sample product 0${i} - import, default price template`]);
const UNIT = ['UNIT REMINDER: "Price (USD)" is US dollars — the header\'s currency, not the app\'s.'];
const COPY = [
  "COPYING FROM ANOTHER FILE: copy column by column, under the same headers — never paste whole rows from an older template. Its columns can differ from this one, and a pasted row puts values under the wrong headers — a price can end up as a product's title.",
];
const SELECTIONS: ReadonlyArray<readonly string[] | undefined> = [[], ["Vietnamese"], GOOGLE_LOCALE_NAMES.slice(0, 3), undefined];

describe("the Google template no longer carries GT Price / GT Currency", () => {
  it("T1 two sheets; 2 lead columns; core 2 · 1 locale 4 · 3 locales 8 · full 166; the filenames are unchanged", () => {
    const cases = [
      [[], 2, "google-iap-bulk-import-template-core.xlsx", undefined],
      [["Vietnamese"], 4, "google-iap-bulk-import-template-1-locale.xlsx", "Title (Vietnamese)"],
      [GOOGLE_LOCALE_NAMES.slice(0, 3), 8, "google-iap-bulk-import-template-3-locales.xlsx", "Title (Afrikaans)"],
      [undefined, 166, "google-iap-bulk-import-template.xlsx", "Title (Afrikaans)"],
    ] as const;
    for (const [sel, count, filename, c1] of cases) {
      const { spec, wb } = template(sel);
      expect(wb.SheetNames).toEqual([GOOGLE_DATA_SHEET_NAME, NOTES]);
      expect(spec.headers).toHaveLength(count);
      expect(spec.headers.slice(0, 2)).toEqual(LEAD);
      expect(spec.filename).toBe(filename);
      // C1 — where GT Price was — is now the first locale column, or nothing.
      expect(wb.Sheets[GOOGLE_DATA_SHEET_NAME].C1?.v).toBe(c1);
    }
  });

  it("T2 the data sheet's sample rows: Product ID + Price (USD) as a NUMBER, the listing under its own headers — in every variant", () => {
    for (const sel of SELECTIONS) {
      const { wb } = template(sel);
      const data = rowsOf(wb, GOOGLE_DATA_SHEET_NAME);
      const header = data[0].map(String);
      for (let i = 0; i < 3; i += 1) {
        expect(data[1 + i].slice(0, 2), `${String(sel)} sample ${i + 1}`).toEqual(SAMPLES[i]);
        if (sel === undefined || sel.length > 0) {
          const locale = sel === undefined || sel.includes("Vietnamese") ? "Vietnamese" : sel[0];
          expect([data[1 + i][header.indexOf(`Title (${locale})`)], data[1 + i][header.indexOf(`Description (${locale})`)]]).toEqual(
            SAMPLE_LISTINGS[i],
          );
        } else {
          expect(data[1 + i]).toHaveLength(2);
        }
      }
      expect(wb.Sheets[GOOGLE_DATA_SHEET_NAME].B2).toMatchObject({ t: "n", v: 0.99 });
    }
  });

  it("T3 Notes N7–N19 (core download, the UI default): no GT line; the UNIT REMINDER without GT; the copy-by-column advice; the table", () => {
    const { wb } = template([]);
    expect(notesRow(wb, 7)[0]).toBe("Product ID");
    expect(notesRow(wb, 8)[0]).toBe("Price (USD)"); // the last lead-column line
    expect(notesRow(wb, 9)[0]).toBe("(no locale columns)");
    expect(notesRow(wb, 10)[0]).toBe("⚠ OVERWRITE CAUTION");
    expect(notesRow(wb, 11)).toEqual([]);
    expect(notesRow(wb, 12)).toEqual(UNIT);
    expect(notesRow(wb, 13)).toEqual(COPY);
    expect(notesRow(wb, 14)).toEqual([]);
    expect(String(notesRow(wb, 15)[0])).toMatch(/^SAMPLE ROWS: /);
    expect(notesRow(wb, 16)).toEqual(LEAD);
    expect([notesRow(wb, 17), notesRow(wb, 18), notesRow(wb, 19)]).toEqual(SAMPLES);
    expect(rowsOf(wb, NOTES)).toHaveLength(19);
  });

  it("T3b with locales the same lines sit one row higher (one locale line instead of two): N11 UNIT, N12 COPY, table N15–N18", () => {
    for (const sel of SELECTIONS.filter((s) => s === undefined || s.length > 0)) {
      const { wb } = template(sel);
      expect([notesRow(wb, 11), notesRow(wb, 12)], String(sel)).toEqual([UNIT, COPY]);
      expect(notesRow(wb, 15).slice(0, 2)).toEqual(LEAD);
      expect([16, 17, 18].map((r) => notesRow(wb, r).slice(0, 2))).toEqual(SAMPLES);
      expect(rowsOf(wb, NOTES)).toHaveLength(18);
    }
  });

  it("T4 the Notes table is built by header NAME: every sample value sits under the same header as in the data sheet (every variant)", () => {
    for (const sel of SELECTIONS) {
      const { wb } = template(sel);
      const tableAt = sel !== undefined && sel.length === 0 ? 16 : 15;
      const tableHeader = notesRow(wb, tableAt).map(String);
      const data = rowsOf(wb, GOOGLE_DATA_SHEET_NAME);
      const dataHeader = data[0].map(String);
      for (let i = 0; i < 3; i += 1) {
        const noteRow = notesRow(wb, tableAt + 1 + i);
        tableHeader.forEach((h, c) => {
          expect(noteRow[c] ?? "", `${String(sel)} row ${i + 1} "${h}"`).toEqual(data[1 + i][dataHeader.indexOf(h)] ?? "");
        });
      }
      expect(notesRow(wb, tableAt + 1)[tableHeader.indexOf("Price (USD)")]).toBe(0.99);
    }
  });

  it("T5 no cell of either sheet mentions GT — in any variant (the template has no country names, so no Guatemala either)", () => {
    for (const sel of SELECTIONS) {
      const { wb } = template(sel);
      for (const sheet of wb.SheetNames) {
        const text = rowsOf(wb, sheet).flat().map(String);
        expect(text.filter((t) => /\bGT\b/i.test(t)), `${String(sel)} / ${sheet}`).toEqual([]);
      }
    }
  });

  it("T6 the preview notice, verbatim (Manager Q1; wording approved at gate G0 2026-10-21)", () => {
    expect(GOOGLE_RETIRED_GT_HEADERS).toEqual(["GT Price", "GT Currency"]);
    expect(googleRetiredGtWarning(null)).toBeNull();
    expect(googleRetiredGtWarning({ rowsWithData: 3 })).toEqual({
      kind: "data",
      text:
        "File còn dữ liệu ở cột GT Price / GT Currency. Tool KHÔNG dùng hai cột này cho Google — giá chỉ lấy từ cột Price. " +
        "Hãy xoá trống dữ liệu hoặc xoá hẳn hai cột này trong file. Số dòng có điền GT: 3.",
    });
    expect(googleRetiredGtWarning({ rowsWithData: 0 })).toEqual({
      kind: "empty",
      text: "File còn hai cột GT Price / GT Currency (trống). Tool không dùng hai cột này — có thể xoá hẳn hai cột khỏi file.",
    });
  });
});

// ── The parser ────────────────────────────────────────────────────────────

const buf = (wb: XLSX.WorkBook) => XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
const SKIPPED_SAMPLES = "3 example row(s) skipped (sample Product IDs from the template) — delete the sample rows or replace them with your data.";
const VI = ["Title (Vietnamese)", "Description (Vietnamese)"];

/** The G0-era 1-locale template, cell for cell as G0 pinned it (T1 / T2):
 *  GT columns C/D, sample rows carrying GT 26000 / 52000 / 598000 VND, the
 *  spacer and the note — plus `extra` rows written under its headers. */
function oldTemplateFile(extra: ReadonlyArray<Record<string, unknown>>, gtHeaders: readonly string[] = GOOGLE_RETIRED_GT_HEADERS) {
  const headers = ["Product ID", "Price (USD)", ...gtHeaders, ...googleLocalePairHeaders(["Vietnamese"])];
  const at = (r: Record<string, unknown>) => headers.map((h) => (h in r ? r[h] : null));
  const samples = TEMPLATE_SAMPLE_PRODUCT_IDS.map((id, i) =>
    at({
      "Product ID": id,
      "Price (USD)": [0.99, 1.99, 22.99][i],
      [gtHeaders[0]]: [26000, 52000, 598000][i],
      [gtHeaders[1] ?? gtHeaders[0]]: gtHeaders[1] ? "VND" : [26000, 52000, 598000][i],
      [VI[0]]: `Sample product 0${i + 1}`,
      [VI[1]]: `Sample product 0${i + 1} - import, default price template`,
    }),
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([headers, ...samples, [], [null, TEMPLATE_SAMPLE_ROWS_NOTE], ...extra.map(at)]),
    GOOGLE_DATA_SHEET_NAME,
  );
  return buf(wb);
}
/** The NEW 1-locale template (real generator), plus `extra` rows by header name. */
function newTemplateFile(extra: ReadonlyArray<Record<string, unknown>>) {
  const spec = googleIapTemplateSpec(["Vietnamese"]);
  const wb = buildTemplateWorkbook(XLSX, spec);
  XLSX.utils.sheet_add_aoa(wb.Sheets[GOOGLE_DATA_SHEET_NAME], extra.map((r) => spec.headers.map((h) => (h in r ? r[h] : null))), { origin: -1 });
  return buf(wb);
}
function parseAoa(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), GOOGLE_DATA_SHEET_NAME);
  return parseIapTemplate(buf(wb));
}
/** Everything the parser decides, minus the GT report. */
const decided = (r: ReturnType<typeof parseIapTemplate>) => {
  const { retiredGtColumns: _gt, ...rest } = r;
  return rest;
};
const ROW = { "Product ID": "com.g0.gt", "Price (USD)": 0.99, [VI[0]]: "T", [VI[1]]: "D" };

describe("the Google parser never reads GT Price / GT Currency (Manager Q1)", () => {
  it("P1 an OLD file, whatever its GT cells hold — valid, junk, half-filled, 0, too precise, a currency Google does not bill, the NUMBER 26 — reads EXACTLY like the same row in the new template", () => {
    const fresh = parseIapTemplate(newTemplateFile([ROW]));
    expect(fresh.rows.map((x) => [x.rowNumber, x.sku, `${x.basePriceDecimal} ${x.baseCurrency}`, x.listings])).toEqual([
      [7, "com.g0.gt", "0.99 USD", [{ locale: "vi", title: "T", description: "D" }]],
    ]);
    expect([fresh.refusedRows, fresh.warnings, fresh.errors, fresh.retiredGtColumns]).toEqual([[], [SKIPPED_SAMPLES], [], null]);
    const values: Array<[unknown, unknown]> = [
      [null, null], [26000, "VND"], ["26000", "VND"], [26000, "vnd"], [1.29, "USD"], [23, "EUR"], [26, "VND"],
      ["abc", "VND"], ["`", "VND"], [26000, null], [null, "VND"], [" ", "VND"], ["26.000", "VND"], ["26,000", "VND"],
      [0, "VND"], [-5, "VND"], ["26000.5", "VND"], [26000.5, "VND"], [26000, "XYZ"], [100, "CNY"], [100, "ARS"], ["abc", "xyz"],
    ];
    for (const [p, c] of values) {
      const old = parseIapTemplate(oldTemplateFile([{ ...ROW, "GT Price": p, "GT Currency": c }]));
      expect(decided(old), `GT ${String(p)} / ${String(c)}`).toEqual(decided(fresh));
      // Counted, never read: the 3 sample rows carry GT in an old template.
      const filled = [p, c].some((v) => v !== null && String(v).trim() !== "");
      expect(old.retiredGtColumns, `GT ${String(p)} / ${String(c)}`).toEqual({ rowsWithData: 3 + (filled ? 1 : 0) });
    }
  });

  it("P2 the GT headers in any spelling, or one of the two alone ⇒ the file is NOT refused, the column is ignored (gate G0, flips G0's P3)", () => {
    const fresh = decided(parseIapTemplate(newTemplateFile([ROW])));
    const spellings: Array<readonly string[]> = [
      ["gt price", "GT Currency"],
      ["GT Price", "Gt Currency"],
      ["GT  Price", "gt  currency"],
      [" GT PRICE ", "GT CURRENCY"],
      ["GT Price"],
      ["GT Currency"],
    ];
    for (const gt of spellings) {
      const r = parseIapTemplate(oldTemplateFile([{ ...ROW, [gt[0]]: 26000, ...(gt[1] ? { [gt[1]]: "VND" } : {}) }], gt));
      expect(decided(r), gt.join(" + ")).toEqual(fresh);
      expect(r.retiredGtColumns, gt.join(" + ")).toEqual({ rowsWithData: 4 });
    }
  });

  it("P2b the boundary: only those two names are recognised — 'GT Curency' is an unknown column (ignored like any other), 'GT Price (VND)' still looks like a second price column (file refused, H4.1 Q10)", () => {
    const typo = parseAoa([
      ["Product ID", "Price (USD)", "GT Price", "GT Curency"],
      ["com.g0.h", 0.99, 26000, "VND"],
    ]);
    expect([typo.errors, typo.rows.map((x) => x.sku), typo.retiredGtColumns]).toEqual([[], ["com.g0.h"], { rowsWithData: 1 }]);
    const withCurrency = parseAoa([
      ["Product ID", "Price (USD)", "GT Price (VND)"],
      ["com.g0.h", 0.99, 26000],
    ]);
    expect(withCurrency.errors).toEqual([
      '"GT Price (VND)" looks like a price column but is not "Price (XXX)". Rename it to "Price (XXX)" with the currency of the prices, or remove it — prices are read from exactly one "Price (XXX)" column.',
    ]);
  });

  it("P3 a row with ONLY GT (no Product ID, no price) is an empty row — not refused — and still counted (gate G0)", () => {
    const head = ["Product ID", "Price (USD)", "GT Price", "GT Currency"];
    for (const gtCells of [[26000, null], [null, "VND"], [26000, "VND"], ["abc", "xyz"]]) {
      const r = parseAoa([head, ["com.g0.a", 0.99, null, null], [null, null, ...gtCells]]);
      expect([r.rows.map((x) => x.sku), r.refusedRows, r.warnings, r.retiredGtColumns], JSON.stringify(gtCells)).toEqual([
        ["com.g0.a"],
        [],
        [],
        { rowsWithData: 1 },
      ]);
    }
    // A row with a PRICE and no Product ID is still refused, GT or not.
    const priced = parseAoa([head, [null, 0.99, 26000, "VND"]]);
    expect(priced.refusedRows).toEqual([{ rowNumber: 2, sku: "", reason: 'no "Product ID" — every row needs one.' }]);
  });

  it("P4 by header name: GT columns anywhere ⇒ ignored; columns present but empty ⇒ rowsWithData 0 (the light notice); the full 166-column template parses", () => {
    const shuffled = parseAoa([
      ["GT Currency", "Title (Vietnamese)", "Product ID", "Description (Vietnamese)", "GT Price", "Price (USD)"],
      ["VND", "T", "com.g0.h", "D", 26000, 0.99],
    ]);
    expect([shuffled.rows.map((x) => [x.sku, x.listings]), shuffled.retiredGtColumns]).toEqual([
      [["com.g0.h", [{ locale: "vi", title: "T", description: "D" }]]],
      { rowsWithData: 1 },
    ]);
    const emptyColumns = parseAoa([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["com.g0.h", 0.99, null, null],
    ]);
    expect(emptyColumns.retiredGtColumns).toEqual({ rowsWithData: 0 });
    expect(googleRetiredGtWarning(emptyColumns.retiredGtColumns ?? null)?.kind).toBe("empty");
    const spec = googleIapTemplateSpec(undefined);
    const wb = buildTemplateWorkbook(XLSX, spec);
    const row = spec.headers.map(() => null as unknown);
    row[spec.headers.indexOf("Product ID")] = "com.g0.full";
    row[spec.headers.indexOf("Price (USD)")] = 1.99;
    row[spec.headers.indexOf("Title (Zulu)")] = "Z";
    XLSX.utils.sheet_add_aoa(wb.Sheets[GOOGLE_DATA_SHEET_NAME], [row], { origin: -1 });
    const full = parseIapTemplate(buf(wb));
    expect([full.rows.map((x) => [x.sku, x.basePriceDecimal, x.listings]), full.retiredGtColumns]).toEqual([
      [["com.g0.full", "1.99", [{ locale: "zu", title: "Z", description: "" }]]],
      null,
    ]);
    const untouched = parseIapTemplate(buf(buildTemplateWorkbook(XLSX, googleIapTemplateSpec([]))));
    expect([untouched.rows, untouched.refusedRows, untouched.warnings, untouched.skippedSampleRows.length]).toEqual([[], [], [SKIPPED_SAMPLES], 3]);
  });

  it("P5 Manager Q6: a bare-number Title with a three-capital-letter Description ⇒ the ROW is refused, in any locale; one of the two alone is a normal row", () => {
    const head = ["Product ID", "Price (USD)", "Title (English)", "Description (English)", "Title (Vietnamese)", "Description (Vietnamese)"];
    const shifted = (t: unknown, d: unknown) =>
      `"Title (Vietnamese)" = "${String(t)}" và "Description (Vietnamese)" = "${String(d)}": có vẻ dữ liệu bị lệch cột — đừng chép cả dòng từ template cũ; hãy chép theo từng cột.`;
    for (const [t, d] of [[26000, "VND"], ["26000", "VND"], [1.29, "USD"], ["26.000", "VND"], ["26,000", "KRW"]] as const) {
      const r = parseAoa([head, ["com.g0.q6", 0.99, "Gem", "Gem pack", t, d]]);
      expect([r.rows, r.refusedRows], `${t} / ${d}`).toEqual([[], [{ rowNumber: 2, sku: "com.g0.q6", reason: shifted(t, d) }]]);
      expect(r.warnings[0]).toBe(`Row 2 (SKU "com.g0.q6"): ${shifted(t, d)} Row not imported.`);
    }
    // Every locale is checked, and every shifted pair is named.
    const both = parseAoa([head, ["com.g0.q6", 0.99, 52000, "VND", 26000, "VND"]]);
    expect(both.refusedRows[0].reason).toBe(
      '"Title (English)" = "52000" và "Description (English)" = "VND": có vẻ dữ liệu bị lệch cột — đừng chép cả dòng từ template cũ; hãy chép theo từng cột. ' +
        shifted(26000, "VND"),
    );
    // A bad price and a shifted pair: one message names both.
    const twice = parseAoa([head, ["com.g0.q6", 0, "Gem", "Gem pack", 26000, "VND"]]);
    expect(twice.refusedRows[0].reason).toBe(
      '"Price (USD)" = "0" — the price is 0 — a 0 price is not accepted; enter the real price. ' + shifted(26000, "VND"),
    );
    // Negatives: only BOTH conditions refuse.
    for (const [t, d] of [[26000, "Vnd"], [26000, "VNDX"], [26000, ""], ["", "VND"], ["Gem 26000", "VND"], [26000, "VN"], ["Gói 99", "USD"]] as const) {
      const r = parseAoa([head, ["com.g0.q6", 0.99, null, null, t, d]]);
      expect([r.rows.map((x) => x.sku), r.refusedRows], `${t} / ${d}`).toEqual([["com.g0.q6"], []]);
    }
  });

  it("P6 the Manager's legacy file (template-item-iap-google.xlsx): 3 rows, NO region override any more, the GT counted (3 rows)", () => {
    const r = parseIapTemplate(readFileSync(join(process.cwd(), "docs/google-iap-management/templates/template-item-iap-google.xlsx")));
    expect(r.rows.map((x) => [x.rowNumber, x.sku, `${x.basePriceDecimal} ${x.baseCurrency}`, x.listings])).toEqual(
      [1, 2, 3].map((i) => [
        i + 1,
        `com.vng.example.product${i}`,
        "0.99 USD",
        [{ locale: "af", title: `Example ${i}`, description: `Example ${i}` }],
      ]),
    );
    expect(r.rows.every((x) => !("regionOverrides" in x))).toBe(true);
    expect([r.refusedRows, r.warnings, r.errors, r.priceHeader, r.retiredGtColumns]).toEqual([[], [], [], "Price (USD)", { rowsWithData: 3 }]);
  });
});
