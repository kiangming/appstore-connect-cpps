/**
 * Anti-drift + round-trip tests for the Apple "Download template"
 * generator (design-bulk-import-template-download.md §D).
 *
 * The structural guard: the generated template and the parser consume
 * the same spec consts (template-spec.ts), and the round-trip below
 * pushes a generated workbook through the REAL parser — so a parser
 * column change that forgets the template fails here instead of
 * reaching users.
 */

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

import { parseIapItemsXlsx } from "./iap-items";
import {
  APPLE_DATA_SHEET_NAME,
  APPLE_NOTES_SHEET_NAME,
  APPLE_LEAD_HEADER_ROW,
  APPLE_REQUIRED_LEAD_HEADERS,
  APPLE_LOCALE_NAMES,
  appleTemplateHeaders,
  appleIapTemplateSpec,
} from "./template-spec";
import {
  buildTemplateWorkbook,
  TEMPLATE_SAMPLE_PRODUCT_IDS,
} from "@/lib/xlsx-template";

function wbToFile(wb: XLSX.WorkBook): File {
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([buf], "generated-template.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** A valid data row aligned to the generated header order. */
function makeDataRow(headers: string[], productId: string): unknown[] {
  const row: unknown[] = headers.map(() => "");
  row[headers.indexOf("Product ID")] = productId;
  row[headers.indexOf("Reference Name")] = `Ref ${productId}`;
  row[headers.indexOf("Type")] = "CONSUMABLE";
  row[headers.indexOf("Price (USD)")] = 0.99;
  row[headers.indexOf("GT Price")] = 23000;
  row[headers.indexOf("GT Currency")] = "VND";
  row[headers.indexOf("Display Name (English (U.S.))")] = "Name en-US";
  row[headers.indexOf("Description (English (U.S.))")] = "Desc en-US";
  row[headers.indexOf("Display Name (Vietnamese)")] = "Name vi";
  row[headers.indexOf("Description (Vietnamese)")] = "Desc vi";
  return row;
}

describe("anti-drift — generated headers equal the parser contract", () => {
  it("is exactly 6 lead + 39 adjacent locale pairs = 84 columns", () => {
    const headers = appleTemplateHeaders();
    expect(APPLE_LOCALE_NAMES.length).toBe(39);
    expect(headers.length).toBe(6 + 39 * 2);
    expect(headers.slice(0, 6)).toEqual([...APPLE_LEAD_HEADER_ROW]);
    APPLE_LOCALE_NAMES.forEach((name, i) => {
      expect(headers[6 + 2 * i]).toBe(`Display Name (${name})`);
      expect(headers[6 + 2 * i + 1]).toBe(`Description (${name})`);
    });
    // No duplicate columns, and every parser-required header is present.
    expect(new Set(headers).size).toBe(headers.length);
    for (const required of APPLE_REQUIRED_LEAD_HEADERS) {
      expect(headers).toContain(required);
    }
  });

  it("generated data sheet = header + 3 sample rows + in-sheet warning note", () => {
    const wb = buildTemplateWorkbook(XLSX, appleIapTemplateSpec());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[APPLE_DATA_SHEET_NAME], {
      header: 1,
      defval: "",
      blankrows: false,
    }) as unknown[][];
    // header + 3 samples + note row (blank spacer dropped by blankrows:false)
    expect(rows.length).toBe(5);
    const noteRow = rows[4];
    expect(noteRow[0]).toBe(""); // empty Product ID cell → parser ignores it
    expect(String(noteRow[1])).toMatch(/SAMPLES — delete them or replace/);
    expect(wb.SheetNames).toEqual([
      APPLE_DATA_SHEET_NAME,
      APPLE_NOTES_SHEET_NAME,
    ]);
  });

  it("sample-row Product IDs are EXACTLY the shared parser skip list", () => {
    // The structural guard for the skip guard itself: an edit that adds/
    // renames a sample row without updating TEMPLATE_SAMPLE_PRODUCT_IDS
    // (or vice versa) fails here.
    const spec = appleIapTemplateSpec();
    const idCol = spec.headers.indexOf("Product ID");
    const idsInSheet = spec.dataRows
      .map((row) => String(row[idCol] ?? ""))
      .filter((v) => v !== "");
    expect(idsInSheet).toEqual([...TEMPLATE_SAMPLE_PRODUCT_IDS]);
  });

  it("every sample row fills one full locale pair (metadata-complete example)", () => {
    // KB §7.1: an IAP needs ≥1 localization to be submittable. The
    // Manager's source rows had none — the generated examples must not
    // teach that shape.
    const spec = appleIapTemplateSpec();
    const dn = spec.headers.indexOf("Display Name (Vietnamese)");
    const ds = spec.headers.indexOf("Description (Vietnamese)");
    const sampleRows = spec.dataRows.filter(
      (row) => String(row[spec.headers.indexOf("Product ID")] ?? "") !== "",
    );
    expect(sampleRows.length).toBe(3);
    for (const row of sampleRows) {
      expect(String(row[dn])).toMatch(/^Sample product 0\d$/);
      expect(String(row[ds])).toMatch(/^Sample product 0\d - import/);
    }
  });
});

describe("round-trip — generated template parses cleanly through the real parser", () => {
  it("unedited template: 3 example rows come back SKIPPED, zero items, zero errors", async () => {
    const wb = buildTemplateWorkbook(XLSX, appleIapTemplateSpec());

    const result = await parseIapItemsXlsx(wbToFile(wb));

    expect(result.items).toEqual([]); // zero created
    expect(result.sample_rows_skipped.map((s) => s.product_id)).toEqual([
      ...TEMPLATE_SAMPLE_PRODUCT_IDS,
    ]);
    expect(result.locale_pair_count).toBe(39);
    expect(result.skipped_locales).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/3 example row\(s\) skipped .* delete the sample rows or replace them/),
    ]);
  });

  it("user rows added after the samples parse normally; samples still skipped", async () => {
    const spec = appleIapTemplateSpec();
    const wb = buildTemplateWorkbook(XLSX, spec);
    const headers = appleTemplateHeaders();
    XLSX.utils.sheet_add_aoa(
      wb.Sheets[APPLE_DATA_SHEET_NAME],
      [
        makeDataRow(headers, "com.test.roundtrip1"),
        makeDataRow(headers, "com.test.roundtrip2"),
      ],
      { origin: -1 },
    );

    const result = await parseIapItemsXlsx(wbToFile(wb));

    // Exact counts — notes-sheet contamination would change them (or
    // fail parsing outright).
    expect(result.items.length).toBe(2);
    expect(result.sample_rows_skipped.length).toBe(3);
    expect(result.locale_pair_count).toBe(39);
    expect(result.skipped_locales).toEqual([]);

    const item = result.items[0];
    expect(item.product_id).toBe("com.test.roundtrip1");
    expect(item.reference_name).toBe("Ref com.test.roundtrip1");
    expect(item.type).toBe("CONSUMABLE");
    expect(item.type_source).toBe("COLUMN");
    expect(item.price_usd).toBe(0.99);
    expect(item.base_price).toBe(23000);
    expect(item.base_currency).toBe("VND");
    expect(item.warnings).toEqual([]);
    expect(item.localizations.map((l) => l.locale).sort()).toEqual([
      "en-US",
      "vi",
    ]);
  });

  it("replace-then-import: samples OVERWRITTEN by real rows are NOT skipped (ID-scoped, not position-scoped)", async () => {
    const spec = appleIapTemplateSpec();
    const wb = buildTemplateWorkbook(XLSX, spec);
    const headers = appleTemplateHeaders();
    // Overwrite the 3 sample rows in place (rows 2–4) — the note row
    // below them stays, as a real user would leave it.
    XLSX.utils.sheet_add_aoa(
      wb.Sheets[APPLE_DATA_SHEET_NAME],
      [
        makeDataRow(headers, "com.real.product1"),
        makeDataRow(headers, "com.real.product2"),
        makeDataRow(headers, "com.real.product3"),
      ],
      { origin: "A2" },
    );

    const result = await parseIapItemsXlsx(wbToFile(wb));

    expect(result.items.map((i) => i.product_id)).toEqual([
      "com.real.product1",
      "com.real.product2",
      "com.real.product3",
    ]);
    expect(result.sample_rows_skipped).toEqual([]);
    expect(result.warnings).toEqual([]);
    // The example shape carries a localization (verify item d) — real
    // rows built the same way parse it.
    expect(result.items[0].localizations.length).toBeGreaterThanOrEqual(1);
  });

  it("parses the named data sheet even when the Notes sheet is FIRST (by-name selection)", async () => {
    // Deliberately adversarial sheet order — this is the mutation-check
    // target: neutering the by-name selection makes the parser read the
    // Notes sheet and this test MUST fail.
    const spec = appleIapTemplateSpec();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(spec.notesRows.map((r) => [...r])),
      spec.notesSheetName,
    );
    const headers = appleTemplateHeaders();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        headers,
        makeDataRow(headers, "com.test.notesfirst"),
      ]),
      spec.dataSheetName,
    );

    const result = await parseIapItemsXlsx(wbToFile(wb));
    expect(result.items.length).toBe(1);
    expect(result.items[0].product_id).toBe("com.test.notesfirst");
    expect(result.locale_pair_count).toBe(39);
  });
});

describe("sheet-name error message", () => {
  it("names the sheet problem when the named sheet is absent and the first sheet has no headers", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["How to fill this template"],
        ["Column", "Required?"],
        ["Product ID", "REQUIRED"],
      ]),
      "Notes",
    );

    await expect(parseIapItemsXlsx(wbToFile(wb))).rejects.toThrow(
      /Couldn't find the data sheet "IAP Items" — parsed the first sheet "Notes" instead/,
    );
  });

  it("legacy Sheet1 files keep the plain missing-column message shape via the fallback", async () => {
    // Fallback path with a genuinely missing required column — the error
    // must still lead with the sheet situation so the user checks the
    // right thing first.
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["Reference Name", "Type"],
        ["Ref only", "CONSUMABLE"],
      ]),
      "Sheet1",
    );
    await expect(parseIapItemsXlsx(wbToFile(wb))).rejects.toThrow(
      /Couldn't find the data sheet "IAP Items".*no "Product ID" column/,
    );
  });
});
