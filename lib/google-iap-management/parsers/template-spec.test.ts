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
  GOOGLE_LOCALE_OPTIONS,
  GOOGLE_NOTES_SHEET_NAME,
  GOOGLE_LEAD_HEADER_ROW,
  GOOGLE_PRICE_HEADER,
  GOOGLE_LOCALE_NAMES,
  googleTemplateHeaders,
  googleIapTemplateSpec,
} from "./template-spec";
import {
  buildTemplateWorkbook,
  TEMPLATE_SAMPLE_PRODUCT_IDS,
} from "@/lib/xlsx-template";

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

  it("generated data sheet = header + 3 sample rows + in-sheet warning note", () => {
    const wb = buildTemplateWorkbook(XLSX, googleIapTemplateSpec());
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[GOOGLE_DATA_SHEET_NAME], {
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
      GOOGLE_DATA_SHEET_NAME,
      GOOGLE_NOTES_SHEET_NAME,
    ]);
  });

  it("sample-row Product IDs are EXACTLY the shared parser skip list", () => {
    // The structural guard for the skip guard itself: an edit that adds/
    // renames a sample row without updating TEMPLATE_SAMPLE_PRODUCT_IDS
    // (or vice versa) fails here.
    const spec = googleIapTemplateSpec();
    const idCol = spec.headers.indexOf("Product ID");
    const idsInSheet = spec.dataRows
      .map((row) => String(row[idCol] ?? ""))
      .filter((v) => v !== "");
    expect(idsInSheet).toEqual([...TEMPLATE_SAMPLE_PRODUCT_IDS]);
  });
});

describe("round-trip — unedited template", () => {
  it("3 example rows come back SKIPPED, zero rows, zero errors", () => {
    const wb = buildTemplateWorkbook(XLSX, googleIapTemplateSpec());

    const result = parseIapTemplate(wbToBuffer(wb), {
      appDefaultCurrency: "VND",
    });

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([]); // zero created
    expect(result.skippedSampleRows.map((s) => s.sku)).toEqual([
      ...TEMPLATE_SAMPLE_PRODUCT_IDS,
    ]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/3 example row\(s\) skipped .* delete the sample rows or replace them/),
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
    // Exact counts — notes-sheet contamination would change them. The 3
    // pre-filled sample rows surface as the explicit skip outcome.
    expect(result.rows.length).toBe(2);
    expect(result.skippedSampleRows.length).toBe(3);

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

  it("replace-then-import: samples OVERWRITTEN by real rows are NOT skipped (ID-scoped, not position-scoped)", () => {
    const spec = googleIapTemplateSpec();
    const wb = buildTemplateWorkbook(XLSX, spec);
    const headers = googleTemplateHeaders();
    // Overwrite the 3 sample rows in place (rows 2–4) — the note row
    // below them stays, as a real user would leave it.
    XLSX.utils.sheet_add_aoa(
      wb.Sheets[GOOGLE_DATA_SHEET_NAME],
      [
        makeDataRow(headers, "com.real.product1"),
        makeDataRow(headers, "com.real.product2"),
        makeDataRow(headers, "com.real.product3"),
      ],
      { origin: "A2" },
    );

    const result = parseIapTemplate(wbToBuffer(wb), {
      appDefaultCurrency: "VND",
    });

    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.sku)).toEqual([
      "com.real.product1",
      "com.real.product2",
      "com.real.product3",
    ]);
    expect(result.skippedSampleRows).toEqual([]);
    expect(result.warnings).toEqual([]);
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


// ─── Locale picker: subset + zero-locale templates (design
//     design-bulk-import-locale-picker.md §G). Permanent versions of the
//     feasibility-gate harness.

describe("locale selection — anti-drift stays EXACT per selection", () => {
  it("core headers are ALWAYS present and locale columns are exactly the selection", () => {
    for (const sel of [[], ["Vietnamese"], ["Japanese", "Vietnamese", "English"]]) {
      const canonical = GOOGLE_LOCALE_NAMES.filter((n) => sel.includes(n));
      expect(googleTemplateHeaders(sel)).toEqual([
        ...GOOGLE_LEAD_HEADER_ROW,
        ...canonical.flatMap((n) => [`Title (${n})`, `Description (${n})`]),
      ]);
      for (const core of GOOGLE_LEAD_HEADER_ROW) {
        expect(canonical).not.toContain(core);
      }
    }
  });

  it("the FULL set is still pinned to 168 columns (catches a new core column or locale-map growth)", () => {
    expect(googleTemplateHeaders().length).toBe(4 + 82 * 2);
    expect(googleTemplateHeaders(GOOGLE_LOCALE_NAMES)).toEqual(
      googleTemplateHeaders(),
    );
  });

  it("unknown selected names are ignored rather than emitting unparseable headers", () => {
    expect(googleTemplateHeaders(["Klingon"])).toEqual([
      ...GOOGLE_LEAD_HEADER_ROW,
    ]);
  });

  it("filename differentiates content: base / -core / -N-locales", () => {
    expect(googleIapTemplateSpec().filename).toBe(
      "google-iap-bulk-import-template.xlsx",
    );
    expect(googleIapTemplateSpec([]).filename).toBe(
      "google-iap-bulk-import-template-core.xlsx",
    );
    expect(googleIapTemplateSpec(["Vietnamese"]).filename).toBe(
      "google-iap-bulk-import-template-1-locale.xlsx",
    );
    expect(googleIapTemplateSpec(["Vietnamese", "Japanese"]).filename).toBe(
      "google-iap-bulk-import-template-2-locales.xlsx",
    );
  });

  it("locale options are exhaustive over the locale map, both directions", () => {
    expect(GOOGLE_LOCALE_OPTIONS.length).toBe(GOOGLE_LOCALE_NAMES.length);
    expect(GOOGLE_LOCALE_OPTIONS.map((o) => o.name)).toEqual([
      ...GOOGLE_LOCALE_NAMES,
    ]);
    for (const o of GOOGLE_LOCALE_OPTIONS) {
      expect(o.language.length).toBeGreaterThan(0);
      expect(o.country.length).toBeGreaterThan(0); // "—" when region-less
      expect(o.code.length).toBeGreaterThan(0);
    }
  });
});

describe("locale selection — sample rows + notes adapt", () => {
  it("a single-locale selection fills THAT locale's pair", () => {
    const spec = googleIapTemplateSpec(["Japanese"]);
    const t = spec.headers.indexOf("Title (Japanese)");
    const d = spec.headers.indexOf("Description (Japanese)");
    const sampleRows = spec.dataRows.filter(
      (r) => String(r[0] ?? "").startsWith("com."),
    );
    expect(sampleRows.length).toBe(3);
    for (const row of sampleRows) {
      expect(String(row[t])).toMatch(/^Sample product 0\d$/);
      expect(String(row[d])).toMatch(/^Sample product 0\d - import/);
    }
  });

  it("ZERO locales: no locale cells, and the Notes sheet carries the OVERWRITE caution", () => {
    const spec = googleIapTemplateSpec([]);
    expect(spec.headers).toEqual([...GOOGLE_LEAD_HEADER_ROW]);
    const sampleRows = spec.dataRows.filter(
      (r) => String(r[0] ?? "").startsWith("com."),
    );
    for (const row of sampleRows) {
      expect(row.length).toBeLessThanOrEqual(GOOGLE_LEAD_HEADER_ROW.length);
    }
    const notesText = spec.notesRows.map((r) => r.join(" | ")).join("\n");
    expect(notesText).toContain("(no locale columns)");
    expect(notesText).toContain("OVERWRITE CAUTION");
    expect(notesText).toContain("SKU-titled en-US listing");
    expect(notesText).toContain("title is the SKU itself");
    expect(notesText).not.toContain("Title (");
    // GT statement survives in every variant.
    expect(notesText).toContain("NOT an exchange rate");
  });
});

describe("locale selection — ROUND-TRIP through the real parser", () => {
  it("SUBSET (1 of 82) fills + parses cleanly, USD semantics intact against a VND app", () => {
    const spec = googleIapTemplateSpec(["Vietnamese"]);
    const wb = buildTemplateWorkbook(XLSX, spec);
    const headers = [...spec.headers];
    const row: unknown[] = headers.map(() => "");
    row[headers.indexOf("Product ID")] = "sku.subset";
    row[headers.indexOf(GOOGLE_PRICE_HEADER)] = 0.99;
    row[headers.indexOf("Title (Vietnamese)")] = "vi title";
    row[headers.indexOf("Description (Vietnamese)")] = "vi desc";
    XLSX.utils.sheet_add_aoa(wb.Sheets[GOOGLE_DATA_SHEET_NAME], [row], {
      origin: -1,
    });

    const result = parseIapTemplate(wbToBuffer(wb), {
      appDefaultCurrency: "VND",
    });
    expect(result.errors).toEqual([]);
    expect(result.rows.length).toBe(1);
    expect(result.skippedSampleRows.length).toBe(3);
    expect(result.rows[0].baseCurrency).toBe("USD");
    expect(result.rows[0].priceHeaderSource).toBe("explicit");
    expect(result.rows[0].listings.map((l) => l.locale)).toEqual(["vi"]);
  });

  it("ZERO locales (the DEFAULT path) fills + parses cleanly", () => {
    const spec = googleIapTemplateSpec([]);
    const wb = buildTemplateWorkbook(XLSX, spec);
    XLSX.utils.sheet_add_aoa(
      wb.Sheets[GOOGLE_DATA_SHEET_NAME],
      [["sku.core", 1.99, "", ""]],
      { origin: -1 },
    );

    const result = parseIapTemplate(wbToBuffer(wb), {
      appDefaultCurrency: "VND",
    });
    expect(result.errors).toEqual([]);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].sku).toBe("sku.core");
    expect(result.rows[0].baseCurrency).toBe("USD");
    expect(result.rows[0].listings).toEqual([]);
    expect(result.skippedSampleRows.length).toBe(3);
  });
});
