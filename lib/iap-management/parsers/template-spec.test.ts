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
import { buildTemplateWorkbook } from "@/lib/xlsx-template";

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

  it("generated data sheet contains ONLY the header row — no example rows", () => {
    const wb = buildTemplateWorkbook(XLSX, appleIapTemplateSpec());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[APPLE_DATA_SHEET_NAME], {
      header: 1,
      defval: "",
      blankrows: false,
    }) as unknown[][];
    expect(rows.length).toBe(1);
    expect(wb.SheetNames).toEqual([
      APPLE_DATA_SHEET_NAME,
      APPLE_NOTES_SHEET_NAME,
    ]);
  });
});

describe("round-trip — generated template parses cleanly through the real parser", () => {
  it("filled rows parse: 39 pairs resolved, 0 skipped, 0 warnings, notes sheet harmless", async () => {
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

    // Exact row count — notes-sheet contamination would change it (or
    // fail parsing outright).
    expect(result.items.length).toBe(2);
    expect(result.locale_pair_count).toBe(39);
    expect(result.skipped_locales).toEqual([]);
    expect(result.warnings).toEqual([]);

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
