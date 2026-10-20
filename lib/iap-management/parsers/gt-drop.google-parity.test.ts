/**
 * [APPLE-bulkimport-drop-gt] G0 — GOOGLE must not change (Manager 2026-10-20:
 * "Google có GT Price / GT Currency DÙNG THẬT — KHÔNG được đổi hành vi
 * Google"). Lives on the Apple side on purpose: the Apple change touches no
 * Google file, so `git diff -- '*google-iap-management*'` stays empty.
 *
 * Fingerprints of what Google's REAL generator and REAL parser produce
 * today (values measured by the census, design §1.5), plus the two shared
 * constants both parsers read. Any of them moving means the Apple change
 * leaked into Google.
 */
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

import { buildTemplateWorkbook, TEMPLATE_SAMPLE_PRODUCT_IDS, TEMPLATE_SAMPLE_ROWS_NOTE } from "@/lib/xlsx-template";
import {
  googleIapTemplateSpec,
  GOOGLE_DATA_SHEET_NAME,
  GOOGLE_LEAD_HEADER_ROW,
  GOOGLE_LOCALE_NAMES,
} from "@/lib/google-iap-management/parsers/template-spec";
import { parseIapTemplate } from "@/lib/google-iap-management/parsers/excel-parser";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const csvOf = (wb: XLSX.WorkBook) => {
  const back = XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
  return back.SheetNames.map((n) => `#${n}\n${XLSX.utils.sheet_to_csv(back.Sheets[n])}`).join("\n");
};

describe("G0 — Google's bulk-import template and parser, fingerprinted", () => {
  it("GP1 the template, for every kind of locale selection: spec and written workbook unchanged", () => {
    const cases: Array<[string, string[] | undefined, string, string]> = [
      ["full", undefined, "5543ac9c12f51872", "7293a61d4ffd2165"],
      ["core", [], "377ec5880739f1b1", "1ea5cf18bd04db6e"],
      ["vi", ["Vietnamese"], "c3f67b2f4218bcbd", "34cacd6f00d64ea6"],
      ["first3", GOOGLE_LOCALE_NAMES.slice(0, 3) as string[], "01231ba16baada68", "ab1def466760d849"],
    ];
    expect(GOOGLE_LEAD_HEADER_ROW).toEqual(["Product ID", "Price (USD)", "GT Price", "GT Currency"]);
    for (const [label, sel, specSha, workbookSha] of cases) {
      const spec = googleIapTemplateSpec(sel);
      expect(sha(JSON.stringify(spec)), `${label} spec`).toBe(specSha);
      expect(sha(csvOf(buildTemplateWorkbook(XLSX, spec))), `${label} workbook`).toBe(workbookSha);
    }
  });

  it("GP2 the parser still reads a GT row as a VN override, and the legacy Google file parses the same", () => {
    const spec = googleIapTemplateSpec(["Vietnamese"]);
    const wb = buildTemplateWorkbook(XLSX, spec);
    const row = spec.headers.map(() => "" as string | number);
    row[spec.headers.indexOf("Product ID")] = "com.parity.gt";
    row[spec.headers.indexOf("Price (USD)")] = 0.99;
    row[spec.headers.indexOf("GT Price")] = 26000;
    row[spec.headers.indexOf("GT Currency")] = "VND";
    row[spec.headers.indexOf("Title (Vietnamese)")] = "T";
    row[spec.headers.indexOf("Description (Vietnamese)")] = "D";
    XLSX.utils.sheet_add_aoa(wb.Sheets[GOOGLE_DATA_SHEET_NAME], [row], { origin: -1 });
    const r = parseIapTemplate(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    expect(r.rows.map((x) => ({ sku: x.sku, base: `${x.basePriceDecimal} ${x.baseCurrency}`, gt: x.regionOverrides }))).toEqual([
      { sku: "com.parity.gt", base: "0.99 USD", gt: [{ region: "VN", currency: "VND", priceDecimal: "26000" }] },
    ]);
    expect([r.skippedSampleRows.length, r.refusedRows, r.errors]).toEqual([3, [], []]);

    const legacy = parseIapTemplate(readFileSync(join(process.cwd(), "docs/google-iap-management/templates/template-item-iap-google.xlsx")));
    expect(legacy.rows).toHaveLength(3);
    expect(legacy.rows[0]?.regionOverrides).toEqual([{ region: "VN", currency: "VND", priceDecimal: "23000" }]);
    expect(sha(JSON.stringify(legacy))).toBe("379b164101f0b7c1");
  });

  it("GP3 the two constants BOTH parsers read are untouched (Google matches the note verbatim)", () => {
    expect(TEMPLATE_SAMPLE_PRODUCT_IDS).toEqual([
      "com.vngg.tool.product.sample01",
      "com.vngg.tool.product.sample02",
      "com.vngg.tool.product.sample03",
    ]);
    expect(sha(TEMPLATE_SAMPLE_ROWS_NOTE)).toBe("9212103f95d7e1fb");
  });
});
