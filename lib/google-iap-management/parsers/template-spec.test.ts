/**
 * Anti-drift + round-trip tests for the Google "Download template"
 * generator (design-bulk-import-template-download.md §D), including the
 * Manager-locked FIXED "Price (USD)" header verification: the parser
 * must interpret it as USD explicitly, regardless of the app's default
 * currency (a VND app + USD template must NOT read 0.99 as VND).
 *
 * Also pins the legacy v1 Manager artifact (fallback sheet path) — the
 * Google side previously had no real-file smoke test.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

import { parseIapTemplate } from "./excel-parser";
import {
  GOOGLE_DATA_SHEET_NAME,
  GOOGLE_NOTES_SHEET_NAME,
  GOOGLE_LEAD_HEADER_ROW,
  GOOGLE_PRICE_HEADER,
  GOOGLE_LOCALE_NAMES,
  googleTemplateHeaders,
  googleIapTemplateSpec,
} from "./template-spec";
import { buildTemplateWorkbook } from "@/lib/xlsx-template";

function wbToBuffer(wb: XLSX.WorkBook): Buffer {
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

/** A valid data row aligned to the generated header order. */
function makeDataRow(headers: string[], sku: string): unknown[] {
  const row: unknown[] = headers.map(() => "");
  row[headers.indexOf("Product ID")] = sku;
  row[headers.indexOf(GOOGLE_PRICE_HEADER)] = 0.99;
  row[headers.indexOf("GT Price")] = 23000;
  row[headers.indexOf("GT Currency")] = "VND";
  row[headers.indexOf("Title (English (United States))")] = "Title en-US";
  row[headers.indexOf("Description (English (United States))")] = "Desc en-US";
  row[headers.indexOf("Title (Vietnamese)")] = "Title vi";
  row[headers.indexOf("Description (Vietnamese)")] = "Desc vi";
  return row;
}

describe("anti-drift — generated headers equal the parser contract", () => {
  it("is exactly 4 lead + 82 locale pairs = 168 columns, no duplicates", () => {
    const headers = googleTemplateHeaders();
    expect(GOOGLE_LOCALE_NAMES.length).toBe(82);
    expect(headers.length).toBe(4 + 82 * 2);
    expect(headers.slice(0, 4)).toEqual([...GOOGLE_LEAD_HEADER_ROW]);
    GOOGLE_LOCALE_NAMES.forEach((name, i) => {
      expect(headers[4 + 2 * i]).toBe(`Title (${name})`);
      expect(headers[4 + 2 * i + 1]).toBe(`Description (${name})`);
    });
    // The legacy v1 artifact shipped duplicate locale pairs (English ×3,
    // Persian ×4 — silently last-win in the parser). The generated
    // template must never reproduce that.
    expect(new Set(headers).size).toBe(headers.length);
  });

  it("generated data sheet contains ONLY the header row — no example rows", () => {
    const wb = buildTemplateWorkbook(XLSX, googleIapTemplateSpec());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[GOOGLE_DATA_SHEET_NAME], {
      header: 1,
      defval: "",
      blankrows: false,
    }) as unknown[][];
    expect(rows.length).toBe(1);
    expect(wb.SheetNames).toEqual([
      GOOGLE_DATA_SHEET_NAME,
      GOOGLE_NOTES_SHEET_NAME,
    ]);
  });
});

describe("round-trip — generated template parses cleanly through the real parser", () => {
  it('FIXED "Price (USD)" is read as EXPLICIT USD even when the app default currency is VND', () => {
    const spec = googleIapTemplateSpec();
    const wb = buildTemplateWorkbook(XLSX, spec);
    const headers = googleTemplateHeaders();
    XLSX.utils.sheet_add_aoa(
      wb.Sheets[GOOGLE_DATA_SHEET_NAME],
      [
        makeDataRow(headers, "com.test.roundtrip1"),
        makeDataRow(headers, "com.test.roundtrip2"),
      ],
      { origin: -1 },
    );

    // VND app — the USD header must win over the app default (Hotfix 16
    // Pass 1, explicit currency). If the parser ever ignored the header,
    // 0.99 would be read as VND — wrong by ~25,000×.
    const result = parseIapTemplate(wbToBuffer(wb), {
      appDefaultCurrency: "VND",
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    // Exact row count — notes-sheet contamination would change it.
    expect(result.rows.length).toBe(2);

    const row = result.rows[0];
    expect(row.sku).toBe("com.test.roundtrip1");
    expect(row.baseCurrency).toBe("USD");
    expect(row.priceHeaderSource).toBe("explicit");
    expect(row.basePriceDecimal).toBe("0.99");
    expect(row.regionOverrides).toEqual([
      { region: "VN", currency: "VND", priceDecimal: "23000" },
    ]);
    expect(
      row.listings.map((l) => l.locale).sort(),
    ).toEqual(["en-US", "vi"]);
  });

  it("parses the named data sheet even when the Notes sheet is FIRST (by-name selection)", () => {
    // Deliberately adversarial sheet order — this is the mutation-check
    // target: neutering the by-name selection makes the parser read the
    // Notes sheet and this test MUST fail.
    const spec = googleIapTemplateSpec();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(spec.notesRows.map((r) => [...r])),
      spec.notesSheetName,
    );
    const headers = googleTemplateHeaders();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        headers,
        makeDataRow(headers, "com.test.notesfirst"),
      ]),
      spec.dataSheetName,
    );

    const result = parseIapTemplate(wbToBuffer(wb), {
      appDefaultCurrency: "USD",
    });
    expect(result.errors).toEqual([]);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].sku).toBe("com.test.notesfirst");
  });
});

describe("sheet-name error message", () => {
  it("names the sheet problem when the named sheet is absent and the first sheet has no headers", () => {
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

    const result = parseIapTemplate(wbToBuffer(wb), {
      appDefaultCurrency: "USD",
    });
    expect(result.rows).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(
      /Couldn't find the data sheet "IAP Items" — parsed the first sheet "Notes" instead/,
    );
  });
});

describe("legacy Manager artifact (v1, Sheet1) — fallback path smoke test", () => {
  it("still parses via the first-sheet fallback", () => {
    const buffer = fs.readFileSync(
      path.join(
        process.cwd(),
        "docs/google-iap-management/templates/template-item-iap-google.xlsx",
      ),
    );
    const result = parseIapTemplate(buffer, { appDefaultCurrency: "USD" });

    expect(result.errors).toEqual([]);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows[0].sku).toBe("com.vng.example.product1");
    expect(result.rows[0].baseCurrency).toBe("USD");
    expect(result.rows[0].priceHeaderSource).toBe("explicit");
  });
});
