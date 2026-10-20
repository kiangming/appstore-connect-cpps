/**
 * [APPLE-bulkimport-drop-gt] What the Apple bulk-import TEMPLATE and PARSER
 * do with "GT Price" / "GT Currency" (Manager 2026-10-20; design
 * docs/iap-management/design-apple-bulkimport-drop-gt-columns.md).
 *
 * G0 (c7fc479) pinned the behaviour BEFORE the change; G1 edited this file on
 * purpose — its diff is the record of what the change did:
 *   - the template no longer has the two columns (core 4 · 1 locale 6 ·
 *     full 82), the Notes never mention them and tell the user to copy column
 *     by column; the Notes table is built by header NAME;
 *   - the parser no longer reads or checks them: a file that still has them
 *     — junk included, any position, any case — reads EXACTLY like a file
 *     without them, with no warning (Manager Q1 (a)).
 *
 * Every value comes from the REAL generator (appleIapTemplateSpec →
 * buildTemplateWorkbook, the chain the Download button runs) and the REAL
 * parser (parseIapItemsXlsx, the one Step 1 and the execute route run).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

import { appleIapTemplateSpec, APPLE_DATA_SHEET_NAME } from "./template-spec";
import { parseIapItemsXlsx } from "./iap-items";
import { buildTemplateWorkbook } from "@/lib/xlsx-template";

const NOTES = "Notes";
const roundTrip = (wb: XLSX.WorkBook) => XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
const template = (sel: readonly string[] | undefined) => {
  const spec = appleIapTemplateSpec(sel);
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

const LEAD = ["Product ID", "Reference Name", "Type", "Price (USD)"];
const UNIT = ['UNIT REMINDER: "Price (USD)" is US dollars — it is what drives Apple pricing (tier inference → price schedule).'];
const COPY = [
  "COPYING FROM ANOTHER FILE: copy column by column, under the same headers — never paste whole rows from an older template. Its columns can differ from this one, and a pasted row puts values under the wrong headers without any error.",
];
const SAMPLE = [
  'SAMPLE ROWS: the "IAP Items" sheet comes PRE-FILLED with the 3 sample rows below. Delete them or replace them with your real products. Rows keeping the sample Product IDs (com.vngg.tool.product.sample01, com.vngg.tool.product.sample02, com.vngg.tool.product.sample03) are skipped automatically on import — any other Product ID in the data sheet is imported as a REAL store product.',
];
const SELECTIONS = [[], ["Vietnamese"], undefined] as const;

describe("the Apple template no longer carries GT Price / GT Currency", () => {
  it("T1 two sheets; 4 lead columns; core 4 · 1 locale 6 · full 82; the filenames are unchanged (Manager Q3)", () => {
    const cases = [
      [[], 4, "apple-iap-bulk-import-template-core.xlsx", undefined],
      [["Vietnamese"], 6, "apple-iap-bulk-import-template-1-locale.xlsx", "Display Name (Vietnamese)"],
      [undefined, 82, "apple-iap-bulk-import-template.xlsx", "Display Name (Arabic)"],
    ] as const;
    for (const [sel, count, filename, e1] of cases) {
      const { spec, wb } = template(sel);
      expect(wb.SheetNames).toEqual([APPLE_DATA_SHEET_NAME, NOTES]);
      expect(spec.headers).toHaveLength(count);
      expect(spec.headers.slice(0, 4)).toEqual(LEAD);
      expect(spec.filename).toBe(filename);
      // E1 — where GT Price was — is now the first locale column, or nothing.
      expect(wb.Sheets[APPLE_DATA_SHEET_NAME].E1?.v).toBe(e1);
    }
  });

  it("T1b no cell of either sheet mentions GT — in any variant (the template has no territory names, so no Guatemala either)", () => {
    for (const sel of SELECTIONS) {
      const { wb } = template(sel);
      for (const sheet of wb.SheetNames) {
        const text = rowsOf(wb, sheet).flat().map(String);
        expect(text.filter((t) => /\bGT\b/i.test(t)), `${String(sel)} / ${sheet}`).toEqual([]);
      }
    }
  });

  it("T2 Notes N11–N20 verbatim (core download, the UI default): no GT line; the copy-by-column advice", () => {
    const { wb } = template([]);
    expect(notesRow(wb, 10)[0]).toBe("Price (USD)"); // the last lead-column line
    expect(notesRow(wb, 11)[0]).toBe("(no locale columns)");
    expect(notesRow(wb, 12)).toEqual([]);
    expect(notesRow(wb, 13)).toEqual(UNIT);
    expect(notesRow(wb, 14)).toEqual(COPY);
    expect(notesRow(wb, 15)).toEqual([]);
    expect(notesRow(wb, 16)).toEqual(SAMPLE);
    expect(notesRow(wb, 17)).toEqual(LEAD);
    expect(notesRow(wb, 18)).toEqual(["com.vngg.tool.product.sample01", "Sample product 01", "", 0.49]);
    expect(notesRow(wb, 19)).toEqual(["com.vngg.tool.product.sample02", "Sample product 02", "", 4.09]);
    expect(notesRow(wb, 20)).toEqual(["com.vngg.tool.product.sample03", "Sample product 03", "", 12.49]);
    expect(rowsOf(wb, NOTES)).toHaveLength(20);
  });

  it("T3 the Notes table is built by header NAME: every sample value sits under the same header as in the data sheet (every variant)", () => {
    for (const sel of SELECTIONS) {
      const { wb } = template(sel);
      expect([notesRow(wb, 13), notesRow(wb, 14)]).toEqual([UNIT, COPY]);
      const tableHeader = notesRow(wb, 17).map(String);
      const data = rowsOf(wb, APPLE_DATA_SHEET_NAME);
      const dataHeader = data[0].map(String);
      for (let i = 0; i < 3; i += 1) {
        const noteRow = notesRow(wb, 18 + i);
        const dataRow = data[1 + i];
        tableHeader.forEach((h, c) => {
          expect(noteRow[c] ?? "", `${String(sel)} row ${i + 1} "${h}"`).toEqual(dataRow[dataHeader.indexOf(h)] ?? "");
        });
      }
      expect(notesRow(wb, 18)[tableHeader.indexOf("Price (USD)")]).toBe(0.49);
    }
  });
});

// ── The parser ────────────────────────────────────────────────────────────

const DN = "Display Name (Vietnamese)";
const DESC = "Description (Vietnamese)";
const PRODUCTS = [
  { "Product ID": "com.vng.gt.one", "Reference Name": "One", "Price (USD)": 0.99, [DN]: "Mot", [DESC]: "Mo ta mot" },
  { "Product ID": "com.vng.gt.two", "Reference Name": "Two", "Price (USD)": 4.99, [DN]: "Hai", [DESC]: "Mo ta hai" },
];
const NEW_LAYOUT = [...LEAD, DN, DESC];

/** A file shaped like the real download (data sheet + Notes), with `headers`
 *  in THAT order and every value placed by header name. */
function fileWith(headers: readonly string[], gt: { price?: unknown; currency?: unknown } = {}): File {
  const spec = appleIapTemplateSpec(["Vietnamese"]);
  const dataRows = PRODUCTS.map((p) =>
    headers.map((h) => {
      const k = h.trim().toLowerCase();
      if (k === "gt price") return gt.price ?? "";
      if (k === "gt currency") return gt.currency ?? "";
      return (p as Record<string, unknown>)[h] ?? "";
    }),
  ) as (string | number)[][];
  const wb = buildTemplateWorkbook(XLSX, { ...spec, headers: [...headers], dataRows });
  return new File([XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer], "gt.xlsx");
}

describe("the Apple parser no longer reads or checks GT — an old file reads exactly like a new one (Manager Q1 (a))", () => {
  it("P1 every kind of GT, at any position, in any layout ⇒ the same parse as the new layout, 0 warnings, no base_*", async () => {
    const ref = await parseIapItemsXlsx(fileWith(NEW_LAYOUT));
    expect(ref.items.map((i) => i.product_id)).toEqual(["com.vng.gt.one", "com.vng.gt.two"]);
    expect(ref.items.map((i) => i.localizations.map((l) => l.display_name))).toEqual([["Mot"], ["Hai"]]);
    expect(ref.warnings).toEqual([]);
    for (const item of ref.items) {
      expect(item).not.toHaveProperty("base_price");
      expect(item).not.toHaveProperty("base_currency");
    }
    const layouts: Array<[string, string[]]> = [
      ["old template (GT after Price)", [...LEAD, "GT Price", "GT Currency", DN, DESC]],
      ["GT at the end", [...NEW_LAYOUT, "GT Price", "GT Currency"]],
      ["reordered, GT in between", ["Reference Name", "GT Currency", "Product ID", "Price (USD)", "GT Price", "Type", DN, DESC]],
    ];
    const gts: Array<{ price: unknown; currency: unknown }> = [
      { price: "", currency: "" },
      { price: 23000, currency: "VND" },
      { price: -5, currency: "zzz" },
      { price: "1,99", currency: "VND" },
      { price: "abc", currency: "VND" },
      { price: "23 000", currency: "ZZZ" },
      { price: "23000đ", currency: "" },
      { price: true, currency: 42 },
    ];
    for (const [label, headers] of layouts) {
      for (const gt of gts) {
        expect(await parseIapItemsXlsx(fileWith(headers, gt)), `${label} / ${JSON.stringify(gt)}`).toEqual(ref);
      }
    }
  });

  it("P2 a GT Price that is not a number is ACCEPTED now (G0 pinned it as rejecting the whole file)", async () => {
    const ref = await parseIapItemsXlsx(fileWith(NEW_LAYOUT));
    for (const price of ["abc", "23 000", "23000đ", true]) {
      await expect(parseIapItemsXlsx(fileWith([...LEAD, "GT Price", "GT Currency", DN, DESC], { price, currency: "VND" }))).resolves.toEqual(ref);
    }
  });

  it("P3 the retired names are matched like any header — trimmed, any case: 'gt price' / ' GT CURRENCY ' ⇒ 0 warnings, same parse", async () => {
    const ref = await parseIapItemsXlsx(fileWith(NEW_LAYOUT));
    const out = await parseIapItemsXlsx(fileWith([...LEAD, "gt price", " GT CURRENCY ", DN, DESC], { price: 23000, currency: "VND" }));
    expect(out).toEqual(ref);
  });

  it("P3b ONLY those two names are retired — any other unknown header still warns", async () => {
    const out = await parseIapItemsXlsx(fileWith([...LEAD, "GT Pricing", DN, DESC]));
    expect(out.warnings).toEqual(['Skipped unexpected header at column 5: "GT Pricing" (expected "Display Name (Locale)")']);
  });

  it("P4 the legacy file docs/iap-management/templates/item-iap-template.xlsx (still has GT 23000 / VND): 3 items, 0 warnings, no base_*", async () => {
    const bytes = readFileSync(join(process.cwd(), "docs/iap-management/templates/item-iap-template.xlsx"));
    const out = await parseIapItemsXlsx(new File([new Uint8Array(bytes)], "item-iap-template.xlsx"));
    // Values read from the file itself (Product ID, Reference Name, Price (USD)).
    expect(out.items.map((i) => [i.product_id, i.reference_name, i.price_usd])).toEqual([
      ["com.vng.example.product1", "Example 1", 0.99],
      ["com.vng.example.product2", "Example 2", 0.99],
      ["com.vng.example.product3", "Example 3", 0.99],
    ]);
    expect(out.warnings).toEqual([]);
    for (const item of out.items) expect(item).not.toHaveProperty("base_price");
  });
});
