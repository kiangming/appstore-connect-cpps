/**
 * [APPLE-bulkimport-drop-gt] G0 — fingerprints of Google's bulk-import
 * template and parser, so a change on one side cannot leak into the other
 * unnoticed. Lives on the Apple side on purpose.
 *
 * ⟲ 2026-10-21 — [GOOGLE-bulkimport-drop-gt] (Manager Q7): the Manager
 *   REVERSED the 2026-10-20 decision "Google có GT Price / GT Currency DÙNG
 *   THẬT — KHÔNG được đổi hành vi Google". The team never meant GT as a price;
 *   Google now drops the two columns too. GP1 and GP2 were re-pinned on
 *   purpose in that arc's G1, to Google's NEW template (2 lead columns) and
 *   parser (the GT is never read); GP3 — the constants both parsers share —
 *   is unchanged. The G0 values (2e3c3e0) are in the git history.
 *
 * Any fingerprint moving outside a Google arc means the change leaked across
 * modules.
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
  it("GP1 the template, for every kind of locale selection: spec and written workbook unchanged (re-pinned 2026-10-21, Q7: no GT columns)", () => {
    const cases: Array<[string, string[] | undefined, string, string]> = [
      ["full", undefined, "08fc57b2b76e62f6", "bba210acbe8780ae"],
      ["core", [], "a474f52865de3b35", "c510864e96539c6a"],
      ["vi", ["Vietnamese"], "684c858613f7231b", "7846af2f6b2ed8ab"],
      ["first3", GOOGLE_LOCALE_NAMES.slice(0, 3) as string[], "83b2a36520da72e2", "38e8ff086046cd3a"],
    ];
    expect(GOOGLE_LEAD_HEADER_ROW).toEqual(["Product ID", "Price (USD)"]);
    for (const [label, sel, specSha, workbookSha] of cases) {
      const spec = googleIapTemplateSpec(sel);
      expect(sha(JSON.stringify(spec)), `${label} spec`).toBe(specSha);
      expect(sha(csvOf(buildTemplateWorkbook(XLSX, spec))), `${label} workbook`).toBe(workbookSha);
    }
  });

  it("GP2 the parser reads a row of the new template, and the legacy Google file — GT columns included — parses with NO GT read (re-pinned 2026-10-21, Q7)", () => {
    const spec = googleIapTemplateSpec(["Vietnamese"]);
    const wb = buildTemplateWorkbook(XLSX, spec);
    const row = spec.headers.map(() => "" as string | number);
    row[spec.headers.indexOf("Product ID")] = "com.parity.row";
    row[spec.headers.indexOf("Price (USD)")] = 0.99;
    row[spec.headers.indexOf("Title (Vietnamese)")] = "T";
    row[spec.headers.indexOf("Description (Vietnamese)")] = "D";
    XLSX.utils.sheet_add_aoa(wb.Sheets[GOOGLE_DATA_SHEET_NAME], [row], { origin: -1 });
    const r = parseIapTemplate(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    expect(r.rows.map((x) => ({ sku: x.sku, base: `${x.basePriceDecimal} ${x.baseCurrency}`, listings: x.listings }))).toEqual([
      { sku: "com.parity.row", base: "0.99 USD", listings: [{ locale: "vi", title: "T", description: "D" }] },
    ]);
    expect([r.skippedSampleRows.length, r.refusedRows, r.errors, r.retiredGtColumns]).toEqual([3, [], [], null]);

    const legacy = parseIapTemplate(readFileSync(join(process.cwd(), "docs/google-iap-management/templates/template-item-iap-google.xlsx")));
    expect(legacy.rows).toHaveLength(3);
    expect(legacy.rows.every((x) => !("regionOverrides" in x))).toBe(true);
    expect(legacy.retiredGtColumns).toEqual({ rowsWithData: 3 });
    expect(sha(JSON.stringify(legacy))).toBe("870d712eea375517");
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
