/**
 * [GOOGLE-bulkimport-drop-gt] What the Google bulk-import TEMPLATE and PARSER
 * do with "GT Price" / "GT Currency" (Manager 2026-10-21; design
 * docs/google-iap-management/design-bulkimport-drop-gt-columns.md).
 *
 * G0 pins the behaviour BEFORE the change. G1 edits this file on purpose —
 * its diff is the record of what the change did.
 *
 * Every value comes from the REAL generator (googleIapTemplateSpec →
 * buildTemplateWorkbook, the chain the Download button runs) and the REAL
 * parser (parseIapTemplate, the one the preview route runs). What GT does
 * further down — preview, execute, the request to Google, the audit — is
 * pinned in app/api/google-iap-management/apps/[packageName]/bulk-import/
 * gt-columns.route.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

import { googleIapTemplateSpec, GOOGLE_DATA_SHEET_NAME, GOOGLE_LOCALE_NAMES } from "./template-spec";
import { parseIapTemplate } from "./excel-parser";
import { buildTemplateWorkbook } from "@/lib/xlsx-template";

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

const LEAD = ["Product ID", "Price (USD)", "GT Price", "GT Currency"];
const SAMPLES = [
  ["com.vngg.tool.product.sample01", 0.99, 26000, "VND"],
  ["com.vngg.tool.product.sample02", 1.99, 52000, "VND"],
  ["com.vngg.tool.product.sample03", 22.99, 598000, "VND"],
];
const SAMPLE_LISTINGS = [1, 2, 3].map((i) => [`Sample product 0${i}`, `Sample product 0${i} - import, default price template`]);
const GT_PRICE_LINE = [
  "GT Price",
  "Optional",
  'Override price for ONE country, in the currency given in GT Currency. Fill GT Price and GT Currency both, or neither — one without the other keeps the row out. A 0 price, more decimals than the currency allows, or a "." / "," in a currency without decimals keeps the row out. A pricing-template tier that matches the row, or custom prices, replace the GT.',
];
const GT_CURRENCY_LINE = [
  "GT Currency",
  "Optional",
  'Currency code for GT Price, e.g. "VND" — mapped to that currency\'s primary region. A currency outside the GT list, or one Google Play does not bill that region in, keeps the row out. Write both headers exactly "GT Price" / "GT Currency", and keep both columns or neither — otherwise the file is refused.',
];
const UNIT = [
  'UNIT REMINDER: "Price (USD)" is US dollars — the header\'s currency, not the app\'s. GT Price is a PRICE in the GT Currency you specify on the same row (posted to Google Play as that currency\'s region price) — it is NOT an exchange rate.',
];
const SELECTIONS: ReadonlyArray<readonly string[] | undefined> = [[], ["Vietnamese"], GOOGLE_LOCALE_NAMES.slice(0, 3), undefined];

describe("the Google template carries GT Price / GT Currency (G0)", () => {
  it("T1 two sheets; C1/D1 = GT Price / GT Currency; core 4 · 1 locale 6 · 3 locales 10 · full 168; the filenames", () => {
    const cases = [
      [[], 4, "google-iap-bulk-import-template-core.xlsx", undefined],
      [["Vietnamese"], 6, "google-iap-bulk-import-template-1-locale.xlsx", "Title (Vietnamese)"],
      [GOOGLE_LOCALE_NAMES.slice(0, 3), 10, "google-iap-bulk-import-template-3-locales.xlsx", "Title (Afrikaans)"],
      [undefined, 168, "google-iap-bulk-import-template.xlsx", "Title (Afrikaans)"],
    ] as const;
    for (const [sel, count, filename, e1] of cases) {
      const { spec, wb } = template(sel);
      expect(wb.SheetNames).toEqual([GOOGLE_DATA_SHEET_NAME, NOTES]);
      expect(spec.headers).toHaveLength(count);
      expect(spec.headers.slice(0, 4)).toEqual(LEAD);
      expect(spec.filename).toBe(filename);
      const ws = wb.Sheets[GOOGLE_DATA_SHEET_NAME];
      expect([ws.C1?.v, ws.D1?.v, ws.E1?.v]).toEqual(["GT Price", "GT Currency", e1]);
    }
  });

  it("T2 the data sheet's sample rows carry GT 26000 / 52000 / 598000 VND — a NUMBER under GT Price — in every variant", () => {
    for (const sel of SELECTIONS) {
      const { wb } = template(sel);
      const data = rowsOf(wb, GOOGLE_DATA_SHEET_NAME);
      for (let i = 0; i < 3; i += 1) {
        expect(data[1 + i].slice(0, 4), `${String(sel)} sample ${i + 1}`).toEqual(SAMPLES[i]);
        if (sel === undefined || sel.length > 0) {
          const header = data[0].map(String);
          const locale = sel === undefined ? "Vietnamese" : sel.includes("Vietnamese") ? "Vietnamese" : sel[0];
          expect([data[1 + i][header.indexOf(`Title (${locale})`)], data[1 + i][header.indexOf(`Description (${locale})`)]]).toEqual(
            SAMPLE_LISTINGS[i],
          );
        }
      }
      expect(wb.Sheets[GOOGLE_DATA_SHEET_NAME].C2).toMatchObject({ t: "n", v: 26000 });
    }
  });

  it("T3 Notes N9 / N10 (GT lines) and N14 (UNIT REMINDER) verbatim, then the illustrative table with GT — core download (the UI default)", () => {
    const { wb } = template([]);
    expect(notesRow(wb, 8)[0]).toBe("Price (USD)");
    expect(notesRow(wb, 9)).toEqual(GT_PRICE_LINE);
    expect(notesRow(wb, 10)).toEqual(GT_CURRENCY_LINE);
    expect(notesRow(wb, 11)[0]).toBe("(no locale columns)");
    expect(notesRow(wb, 12)[0]).toBe("⚠ OVERWRITE CAUTION");
    expect(notesRow(wb, 13)).toEqual([]);
    expect(notesRow(wb, 14)).toEqual(UNIT);
    expect(notesRow(wb, 15)).toEqual([]);
    expect(String(notesRow(wb, 16)[0])).toMatch(/^SAMPLE ROWS: /);
    expect(notesRow(wb, 17)).toEqual(LEAD);
    expect([notesRow(wb, 18), notesRow(wb, 19), notesRow(wb, 20)]).toEqual(SAMPLES);
    expect(rowsOf(wb, NOTES)).toHaveLength(20);
  });

  it("T3b with locales the same lines sit one row higher (one locale line instead of two): N9 / N10 GT, N13 UNIT REMINDER, table N16–N19", () => {
    for (const sel of SELECTIONS.filter((s) => s === undefined || s.length > 0)) {
      const { wb } = template(sel);
      expect([notesRow(wb, 9), notesRow(wb, 10), notesRow(wb, 13)], String(sel)).toEqual([GT_PRICE_LINE, GT_CURRENCY_LINE, UNIT]);
      expect(notesRow(wb, 16).slice(0, 4)).toEqual(LEAD);
      expect([17, 18, 19].map((r) => notesRow(wb, r).slice(0, 4))).toEqual(SAMPLES);
      expect(rowsOf(wb, NOTES)).toHaveLength(19);
    }
  });

  it("T4 every sample value in the Notes table sits under the same header as in the data sheet (every variant)", () => {
    for (const sel of SELECTIONS) {
      const { wb } = template(sel);
      const tableAt = sel !== undefined && sel.length === 0 ? 17 : 16;
      const tableHeader = notesRow(wb, tableAt).map(String);
      const data = rowsOf(wb, GOOGLE_DATA_SHEET_NAME);
      const dataHeader = data[0].map(String);
      for (let i = 0; i < 3; i += 1) {
        const noteRow = notesRow(wb, tableAt + 1 + i);
        tableHeader.forEach((h, c) => {
          expect(noteRow[c] ?? "", `${String(sel)} row ${i + 1} "${h}"`).toEqual(data[1 + i][dataHeader.indexOf(h)] ?? "");
        });
      }
    }
  });

  it("T5 exactly these cells mention GT (core download): the two headers, the two Notes lines, the UNIT REMINDER, the table headers", () => {
    const { wb } = template([]);
    const cells: string[] = [];
    for (const sheet of wb.SheetNames) {
      rowsOf(wb, sheet).forEach((r, i) =>
        r.forEach((v, j) => {
          if (/\bGT\b/.test(String(v))) cells.push(`${sheet}!${XLSX.utils.encode_cell({ r: i, c: j })}`);
        }),
      );
    }
    expect(cells).toEqual([
      "IAP Items!C1",
      "IAP Items!D1",
      "Notes!A9",
      "Notes!C9",
      "Notes!A10",
      "Notes!C10",
      "Notes!A14",
      "Notes!C17",
      "Notes!D17",
    ]);
  });
});

// ── The parser ────────────────────────────────────────────────────────────

const buf = (wb: XLSX.WorkBook) => XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
const SKIPPED_SAMPLES = "3 example row(s) skipped (sample Product IDs from the template) — delete the sample rows or replace them with your data.";
const NONE_LEFT = "No row can be imported: 1 row(s) were not imported — each is listed with its reason.";

/** The REAL 1-locale template, plus one row written under its headers BY NAME. */
function parseTemplateRow(gtPrice: unknown, gtCurrency: unknown) {
  const spec = googleIapTemplateSpec(["Vietnamese"]);
  const wb = buildTemplateWorkbook(XLSX, spec);
  const row = spec.headers.map(() => null as unknown);
  const set = (h: string, v: unknown) => (row[spec.headers.indexOf(h)] = v);
  set("Product ID", "com.g0.gt");
  set("Price (USD)", 0.99);
  set("GT Price", gtPrice);
  set("GT Currency", gtCurrency);
  set("Title (Vietnamese)", "T");
  set("Description (Vietnamese)", "D");
  XLSX.utils.sheet_add_aoa(wb.Sheets[GOOGLE_DATA_SHEET_NAME], [row], { origin: -1 });
  return parseIapTemplate(buf(wb));
}
function parseAoa(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), GOOGLE_DATA_SHEET_NAME);
  return parseIapTemplate(buf(wb));
}

describe("the Google parser reads GT Price / GT Currency (G0)", () => {
  it("P1 accepted ⇒ ONE override for the currency's region; listings and warnings exactly as for a row without GT", () => {
    const cases: Array<[string, unknown, unknown, unknown[]]> = [
      ["empty cells", null, null, []],
      ["number", 26000, "VND", [{ region: "VN", currency: "VND", priceDecimal: "26000" }]],
      ["text", "26000", "VND", [{ region: "VN", currency: "VND", priceDecimal: "26000" }]],
      ["lower-case currency", 26000, "vnd", [{ region: "VN", currency: "VND", priceDecimal: "26000" }]],
      ["USD ⇒ US", 1.29, "USD", [{ region: "US", currency: "USD", priceDecimal: "1.29" }]],
      ["EUR ⇒ DE (one region per currency)", 23, "EUR", [{ region: "DE", currency: "EUR", priceDecimal: "23" }]],
      ["the NUMBER 26 (a typed 26.000) — 1000× too low, accepted", 26, "VND", [{ region: "VN", currency: "VND", priceDecimal: "26" }]],
    ];
    for (const [label, p, c, overrides] of cases) {
      const r = parseTemplateRow(p, c);
      expect(
        r.rows.map((x) => ({ n: x.rowNumber, sku: x.sku, base: `${x.basePriceDecimal} ${x.baseCurrency}`, ov: x.regionOverrides, l: x.listings })),
        label,
      ).toEqual([{ n: 7, sku: "com.g0.gt", base: "0.99 USD", ov: overrides, l: [{ locale: "vi", title: "T", description: "D" }] }]);
      expect([r.refusedRows, r.errors, r.warnings, r.skippedSampleRows.length], label).toEqual([[], [], [SKIPPED_SAMPLES], 3]);
    }
  });

  it("P2 refused ROW, with the reason — whatever the price column says", () => {
    const supported =
      "USD, EUR, GBP, JPY, KRW, CNY, TWD, HKD, INR, IDR, THB, VND, PHP, SGD, MYR, AUD, NZD, CAD, MXN, BRL, ARS, RUB, TRY, SAR, AED";
    const cases: Array<[string, unknown, unknown, string]> = [
      ["junk", "abc", "VND", 'GT Price "abc" VND — Decimal price must be a non-negative number (got "abc").'],
      ["a stray backtick", "`", "VND", 'GT Price "`" VND — Decimal price must be a non-negative number (got "`").'],
      ["only GT Price", 26000, null, 'GT Price "26000" has no GT Currency — fill both or neither.'],
      ["only GT Currency", null, "VND", 'GT Currency "VND" has no GT Price — fill both or neither.'],
      ["a blank GT Price", " ", "VND", 'GT Currency "VND" has no GT Price — fill both or neither.'],
      ["\"26.000\" as text", "26.000", "VND", 'GT Price "26.000" VND — "26.000" has a "." but VND has no decimals — it may be a thousands separator (26.000 = 26 thousand?). Write a whole number without separators, e.g. 26000.'],
      ["\"26,000\" as text", "26,000", "VND", 'GT Price "26,000" VND — "26,000" has a "," but VND has no decimals — it may be a thousands separator (26.000 = 26 thousand?). Write a whole number without separators, e.g. 26000.'],
      ["0", 0, "VND", 'GT Price "0" VND — the price is 0 — a 0 price is not accepted; enter the real price.'],
      ["negative", -5, "VND", 'GT Price "-5" VND — Decimal price must be a non-negative number (got "-5").'],
      ["too precise (text)", "26000.5", "VND", 'GT Price "26000.5" VND — VND only accepts whole numbers (got "26000.5"). Google rejects fractional values for this currency.'],
      ["too precise (number)", 26000.5, "VND", 'GT Price "26000.5" VND — VND only accepts whole numbers (got "26000.5"). Google rejects fractional values for this currency.'],
      ["a currency outside the GT table", 26000, "XYZ", `GT Currency "XYZ" is not a currency the GT column supports (one region per currency: ${supported}).`],
      ["CNY — CN is not sold", 100, "CNY", 'GT Price "100" CNY — CN is not a region Google Play sells in.'],
      ["ARS — Google bills AR in USD", 100, "ARS", 'GT Price "100" ARS — Google Play bills AR in USD, not ARS.'],
    ];
    for (const [label, p, c, reason] of cases) {
      const r = parseTemplateRow(p, c);
      expect(r.rows, label).toEqual([]);
      expect(r.refusedRows, label).toEqual([{ rowNumber: 7, sku: "com.g0.gt", reason }]);
      expect(r.warnings, label).toEqual([`Row 7 (SKU "com.g0.gt"): ${reason} Row not imported.`, SKIPPED_SAMPLES, NONE_LEFT]);
      expect(r.errors, label).toEqual([]);
    }
  });

  it("P3 refused FILE by its GT headers: wrong case or spacing; one GT column without the other (a typo, \"GT Price (VND)\")", () => {
    const head = (gt: string[], cells: unknown[]) => parseAoa([["Product ID", "Price (USD)", ...gt], ["com.g0.h", 0.99, ...cells]]);
    const missing = (present: string, absent: string) =>
      `The file has a "${present}" column but no "${absent}" column — add "${absent}" (written exactly), or remove "${present}". A GT needs both.`;
    const cases: Array<[string, ReturnType<typeof parseIapTemplate>, string]> = [
      ["gt price", head(["gt price", "GT Currency"], [26000, "VND"]), 'Header "gt price": write it exactly "GT Price".'],
      ["Gt Currency", head(["GT Price", "Gt Currency"], [26000, "VND"]), 'Header "Gt Currency": write it exactly "GT Currency".'],
      ["GT  Price (two spaces)", head(["GT  Price", "GT Currency"], [26000, "VND"]), 'Header "GT  Price": write it exactly "GT Price".'],
      ["only GT Price", head(["GT Price"], [26000]), missing("GT Price", "GT Currency")],
      ["only GT Currency", head(["GT Currency"], ["VND"]), missing("GT Currency", "GT Price")],
      ["GT Curency (typo)", head(["GT Price", "GT Curency"], [26000, "VND"]), missing("GT Price", "GT Currency")],
      ["GT Price (VND)", head(["GT Price (VND)", "GT Currency"], [26000, "VND"]), missing("GT Currency", "GT Price")],
    ];
    for (const [label, r, error] of cases) {
      expect([r.errors, r.rows, r.refusedRows, r.warnings], label).toEqual([[error], [], [], []]);
    }
  });

  it("P4 read BY HEADER NAME: GT columns anywhere ⇒ the same row; the full 168-column template reads its GT too", () => {
    const shuffled = parseAoa([
      ["GT Currency", "Title (Vietnamese)", "Product ID", "Description (Vietnamese)", "GT Price", "Price (USD)"],
      ["VND", "T", "com.g0.h", "D", 26000, 0.99],
    ]);
    expect(shuffled.rows.map((x) => [x.sku, x.regionOverrides, x.listings])).toEqual([
      ["com.g0.h", [{ region: "VN", currency: "VND", priceDecimal: "26000" }], [{ locale: "vi", title: "T", description: "D" }]],
    ]);
    const spec = googleIapTemplateSpec(undefined);
    const wb = buildTemplateWorkbook(XLSX, spec);
    const row = spec.headers.map(() => null as unknown);
    row[spec.headers.indexOf("Product ID")] = "com.g0.full";
    row[spec.headers.indexOf("Price (USD)")] = 1.99;
    row[spec.headers.indexOf("GT Price")] = 52000;
    row[spec.headers.indexOf("GT Currency")] = "VND";
    row[spec.headers.indexOf("Title (Zulu)")] = "Z";
    XLSX.utils.sheet_add_aoa(wb.Sheets[GOOGLE_DATA_SHEET_NAME], [row], { origin: -1 });
    const full = parseIapTemplate(buf(wb));
    expect(full.rows.map((x) => [x.sku, x.regionOverrides])).toEqual([["com.g0.full", [{ region: "VN", currency: "VND", priceDecimal: "52000" }]]]);
    // The untouched template: only its samples, skipped.
    const untouched = parseIapTemplate(buf(buildTemplateWorkbook(XLSX, googleIapTemplateSpec([]))));
    expect([untouched.rows, untouched.refusedRows, untouched.warnings, untouched.skippedSampleRows.length]).toEqual([[], [], [SKIPPED_SAMPLES], 3]);
  });

  it("P5 a row with NO Product ID: a GT Price states a product (refused, \"no Product ID\"); a GT Currency alone does not (ignored)", () => {
    const head = ["Product ID", "Price (USD)", "GT Price", "GT Currency"];
    const gtPrice = parseAoa([head, ["com.g0.a", 0.99, null, null], [null, null, 26000, null]]);
    expect(gtPrice.refusedRows).toEqual([{ rowNumber: 3, sku: "", reason: 'no "Product ID" — every row needs one.' }]);
    const gtCurrency = parseAoa([head, ["com.g0.a", 0.99, null, null], [null, null, null, "VND"]]);
    expect([gtCurrency.refusedRows, gtCurrency.warnings, gtCurrency.rows.map((x) => x.sku)]).toEqual([[], [], ["com.g0.a"]]);
  });

  it("P6 a file WITHOUT GT columns, an old row pasted whole by position (Manager Q6): Title = 26000, Description = VND ⇒ accepted, no warning", () => {
    for (const title of [26000, "26000"]) {
      const r = parseAoa([
        ["Product ID", "Price (USD)", "Title (Vietnamese)", "Description (Vietnamese)"],
        ["com.g0.q6", 0.99, title, "VND"],
      ]);
      expect(r.rows.map((x) => [x.sku, x.regionOverrides, x.listings]), String(typeof title)).toEqual([
        ["com.g0.q6", [], [{ locale: "vi", title: "26000", description: "VND" }]],
      ]);
      expect([r.refusedRows, r.warnings, r.errors]).toEqual([[], [], []]);
    }
  });

  it("P7 the Manager's legacy file (template-item-iap-google.xlsx): 3 rows, each with a VN override of VND 23000, no warning", () => {
    const r = parseIapTemplate(readFileSync(join(process.cwd(), "docs/google-iap-management/templates/template-item-iap-google.xlsx")));
    expect(r.rows.map((x) => [x.rowNumber, x.sku, `${x.basePriceDecimal} ${x.baseCurrency}`, x.regionOverrides])).toEqual(
      [1, 2, 3].map((i) => [
        i + 1,
        `com.vng.example.product${i}`,
        "0.99 USD",
        [{ region: "VN", currency: "VND", priceDecimal: "23000" }],
      ]),
    );
    expect([r.refusedRows, r.warnings, r.errors, r.priceHeader]).toEqual([[], [], [], "Price (USD)"]);
  });
});
