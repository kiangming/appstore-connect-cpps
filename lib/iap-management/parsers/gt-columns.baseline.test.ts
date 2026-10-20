/**
 * [APPLE-bulkimport-drop-gt] G0 — what the Apple bulk-import TEMPLATE and
 * PARSER do with "GT Price" / "GT Currency" TODAY, pinned before the change
 * (Manager 2026-10-20; design docs/iap-management/design-apple-bulkimport-drop-gt-columns.md).
 *
 * Every value comes from the REAL generator (appleIapTemplateSpec →
 * buildTemplateWorkbook, the chain the Download button runs) and the REAL
 * parser (parseIapItemsXlsx, the one Step 1 and the execute route run).
 * G1 edits THIS file on purpose: its diff is the record of what the change
 * did to the template and the parser.
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
/** A Notes row as the reader sees it, trailing padding cells removed. */
function notesRow(wb: XLSX.WorkBook, excelRow: number): unknown[] {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[NOTES], { header: 1, blankrows: true, defval: "" });
  const row = [...(aoa[excelRow - 1] ?? [])];
  while (row.length > 0 && row[row.length - 1] === "") row.pop();
  return row;
}

const N11 = [
  "GT Price",
  "Optional",
  "⚠ Currently NOT applied for Apple: the import parses this column (with GT Currency) but nothing downstream consumes it — Apple pricing comes from Price (USD) → tier inference → price schedule. Safe to leave blank (the sample rows do).",
];
const N12 = [
  "GT Currency",
  "Optional",
  '⚠ Currently NOT applied for Apple — see GT Price. Currency code for GT Price, e.g. "VND", if you fill the pair anyway.',
];
const N15 = [
  'UNIT REMINDER: "Price (USD)" is US dollars — it is what actually drives Apple pricing (tier inference → price schedule). GT Price / GT Currency are parsed but currently NOT applied for Apple; if filled, GT Price is a PRICE in GT Currency, NOT an exchange rate.',
];
const N17 = [
  'SAMPLE ROWS: the "IAP Items" sheet comes PRE-FILLED with the 3 sample rows below. Delete them or replace them with your real products. Rows keeping the sample Product IDs (com.vngg.tool.product.sample01, com.vngg.tool.product.sample02, com.vngg.tool.product.sample03) are skipped automatically on import — any other Product ID in the data sheet is imported as a REAL store product.',
];
const LEAD_TODAY = ["Product ID", "Reference Name", "Type", "Price (USD)", "GT Price", "GT Currency"];

describe("G0 — the Apple template TODAY carries GT Price / GT Currency", () => {
  it("T1 two sheets; E1 / F1 are GT Price / GT Currency; core 6 · 1 locale 8 · full 84 columns; filenames", () => {
    const cases = [
      [[], 6, "apple-iap-bulk-import-template-core.xlsx"],
      [["Vietnamese"], 8, "apple-iap-bulk-import-template-1-locale.xlsx"],
      [undefined, 84, "apple-iap-bulk-import-template.xlsx"],
    ] as const;
    for (const [sel, count, filename] of cases) {
      const { spec, wb } = template(sel);
      expect(wb.SheetNames).toEqual([APPLE_DATA_SHEET_NAME, NOTES]);
      expect(spec.headers).toHaveLength(count);
      expect(spec.headers.slice(0, 6)).toEqual(LEAD_TODAY);
      expect(spec.filename).toBe(filename);
      const ws = wb.Sheets[APPLE_DATA_SHEET_NAME];
      expect([ws.E1?.v, ws.F1?.v]).toEqual(["GT Price", "GT Currency"]);
      // The sample rows write the two GT cells as EMPTY STRINGS — real cells.
      expect([ws.E2?.v, ws.F2?.v, ws.E4?.v, ws.F4?.v]).toEqual(["", "", "", ""]);
    }
  });

  it("T2 Notes N11–N21 verbatim (core download, the UI default)", () => {
    const { wb } = template([]);
    expect(notesRow(wb, 11)).toEqual(N11);
    expect(notesRow(wb, 12)).toEqual(N12);
    expect(notesRow(wb, 13)[0]).toBe("(no locale columns)");
    expect(notesRow(wb, 14)).toEqual([]);
    expect(notesRow(wb, 15)).toEqual(N15);
    expect(notesRow(wb, 16)).toEqual([]);
    expect(notesRow(wb, 17)).toEqual(N17);
    expect(notesRow(wb, 18)).toEqual(LEAD_TODAY);
    expect(notesRow(wb, 19)).toEqual(["com.vngg.tool.product.sample01", "Sample product 01", "", 0.49]);
    expect(notesRow(wb, 20)).toEqual(["com.vngg.tool.product.sample02", "Sample product 02", "", 4.09]);
    expect(notesRow(wb, 21)).toEqual(["com.vngg.tool.product.sample03", "Sample product 03", "", 12.49]);
  });

  it("T3 Notes with a locale: the same GT lines; the illustrative table puts the locale pair after the two GT cells", () => {
    for (const sel of [["Vietnamese"], undefined] as const) {
      const { wb } = template(sel);
      expect([notesRow(wb, 11), notesRow(wb, 12), notesRow(wb, 15)]).toEqual([N11, N12, N15]);
      expect(notesRow(wb, 18)).toEqual([...LEAD_TODAY, "Display Name (Vietnamese)", "Description (Vietnamese)"]);
      expect(notesRow(wb, 19)).toEqual([
        "com.vngg.tool.product.sample01", "Sample product 01", "", 0.49, "", "",
        "Sample product 01", "Sample product 01 - import, default price template",
      ]);
    }
  });
});

// ── The parser ────────────────────────────────────────────────────────────

type GtCells = { price: unknown; currency: unknown } | "ABSENT";
const LOCALE = ["Display Name (Vietnamese)", "Description (Vietnamese)"];

/** A file shaped like the real download (data sheet + Notes), with the given
 *  lead headers and two products, written by the real workbook builder. */
function file(gt: GtCells, opts: { gtHeaders?: [string, string] } = {}): File {
  const spec = appleIapTemplateSpec(["Vietnamese"]);
  const gtHeaders = opts.gtHeaders ?? ["GT Price", "GT Currency"];
  const headers = gt === "ABSENT"
    ? ["Product ID", "Reference Name", "Type", "Price (USD)", ...LOCALE]
    : ["Product ID", "Reference Name", "Type", "Price (USD)", ...gtHeaders, ...LOCALE];
  const row = (id: string, ref: string, usd: number, dn: string, desc: string) => {
    const r: unknown[] = headers.map(() => "");
    r[headers.indexOf("Product ID")] = id;
    r[headers.indexOf("Reference Name")] = ref;
    r[headers.indexOf("Price (USD)")] = usd;
    if (gt !== "ABSENT") {
      r[headers.indexOf(gtHeaders[0])] = gt.price;
      r[headers.indexOf(gtHeaders[1])] = gt.currency;
    }
    r[headers.indexOf(LOCALE[0])] = dn;
    r[headers.indexOf(LOCALE[1])] = desc;
    return r as (string | number)[];
  };
  const dataRows = [row("com.vng.gt.one", "One", 0.99, "Mot", "Mo ta mot"), row("com.vng.gt.two", "Two", 4.99, "Hai", "Mo ta hai")];
  const wb = buildTemplateWorkbook(XLSX, { ...spec, headers, dataRows });
  return new File([XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer], "gt.xlsx");
}
/** The parse with the two GT-derived fields set aside — what everything
 *  downstream of the parser reads. */
async function parse(f: File) {
  const out = await parseIapItemsXlsx(f);
  const gtOf = out.items.map((i) => [i.base_price, i.base_currency]);
  const rest = { ...out, items: out.items.map(({ base_price: _p, base_currency: _c, ...it }) => it) };
  return { gtOf, rest };
}

describe("G0 — the Apple parser TODAY reads GT into base_price / base_currency, and checks ONE thing", () => {
  it("P1 every accepted kind of GT: the same items and warnings; only base_price / base_currency differ", async () => {
    const variants: Array<[string, GtCells, [number, string]]> = [
      ["empty", { price: "", currency: "" }, [0, ""]],
      ["23000 / VND", { price: 23000, currency: "VND" }, [23000, "VND"]],
      ["-5 / zzz", { price: -5, currency: "zzz" }, [-5, "zzz"]],
      ["'1,99' / VND", { price: "1,99", currency: "VND" }, [199, "VND"]],
      ["columns absent", "ABSENT", [0, ""]],
    ];
    const ref = (await parse(file({ price: "", currency: "" }))).rest;
    expect(ref.items.map((i) => i.product_id)).toEqual(["com.vng.gt.one", "com.vng.gt.two"]);
    expect(ref.warnings).toEqual([]);
    for (const [label, gt, base] of variants) {
      const { gtOf, rest } = await parse(file(gt));
      expect(rest, label).toEqual(ref);
      expect(gtOf, label).toEqual([base, base]);
    }
  });

  it("P2 the ONE check: a GT Price that is not a number rejects the WHOLE file", async () => {
    for (const [cell, shown] of [["abc", "abc"], ["23 000", "23 000"], ["23000đ", "23000đ"]] as const) {
      await expect(parseIapItemsXlsx(file({ price: cell, currency: "VND" }))).rejects.toThrow(
        `expected numeric GT Price, got "${shown}"`,
      );
    }
    await expect(parseIapItemsXlsx(file({ price: true, currency: "VND" }))).rejects.toThrow(/expected numeric GT Price/);
  });

  it("P3 the header is matched by name, trimmed, any case: 'gt price' / ' GT CURRENCY ' are read as GT today", async () => {
    const { gtOf, rest } = await parse(file({ price: 23000, currency: "VND" }, { gtHeaders: ["gt price", " GT CURRENCY "] }));
    expect(gtOf).toEqual([[23000, "VND"], [23000, "VND"]]);
    expect(rest.warnings).toEqual([]);
  });

  it("P4 the legacy file docs/iap-management/templates/item-iap-template.xlsx: 3 items, 0 warnings, 23000 / VND each", async () => {
    const bytes = readFileSync(join(process.cwd(), "docs/iap-management/templates/item-iap-template.xlsx"));
    const out = await parseIapItemsXlsx(new File([new Uint8Array(bytes)], "item-iap-template.xlsx"));
    expect(out.items).toHaveLength(3);
    expect(out.warnings).toEqual([]);
    expect(out.items.map((i) => [i.base_price, i.base_currency])).toEqual([[23000, "VND"], [23000, "VND"], [23000, "VND"]]);
  });
});
