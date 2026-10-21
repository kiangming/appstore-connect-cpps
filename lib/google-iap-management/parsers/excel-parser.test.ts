import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

import { parseIapTemplate, resolvePriceColumn } from "./excel-parser";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function makeWorkbook(rows: Array<Array<string | number>>): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

describe("resolvePriceColumn — H4.1: exactly ONE price column, and it names a Play currency", () => {
  it("matches 'Price (USD)' (the generated template's header)", () => {
    expect(resolvePriceColumn(["Product ID", "Price (USD)", "Title (English (United States))"])).toEqual({
      kind: "ok",
      columnIndex: 1,
      currencyCode: "USD",
      headerText: "Price (USD)",
    });
  });

  it("matches 'Price (VND)' and normalises the code ('Price (vnd)' → VND)", () => {
    expect(resolvePriceColumn(["Product ID", "Price (VND)"])).toMatchObject({ kind: "ok", currencyCode: "VND" });
    expect(resolvePriceColumn(["Product ID", "Price (vnd)"])).toMatchObject({ kind: "ok", currencyCode: "VND" });
  });

  it.each(["Price", "Default Price", "Base Price", "PRICE", "default price"])(
    "Q1: a header without its currency (%s) is REFUSED — the app currency is never used",
    (header) => {
      const out = resolvePriceColumn(["Product ID", header]);
      expect(out.kind).toBe("error");
      expect(out.kind === "error" && out.message).toBe(
        `Header "${header}" does not say which currency the prices are in. Rename it to "Price (XXX)" with the currency of the prices, e.g. "Price (USD)". The app's currency is not used for prices in the file.`,
      );
    },
  );

  it("Q10: two price columns are REFUSED — explicit + explicit, or explicit + generic (no more silent first-wins)", () => {
    for (const headers of [
      ["Product ID", "Price (USD)", "Price (VND)"],
      ["Product ID", "Price", "Price (VND)"],
    ]) {
      const out = resolvePriceColumn(headers);
      expect(out.kind).toBe("error");
      expect(out.kind === "error" && out.message).toMatch(/^The file has 2 price columns \(".+", ".+"\)\. Keep exactly one "Price \(XXX\)" column/);
    }
  });

  it.each(["ABC", "CNY", "ARS"])("Q10: a currency Google Play does not bill in (%s) is REFUSED", (code) => {
    const out = resolvePriceColumn(["Product ID", `Price (${code})`]);
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toBe(
      `Header "Price (${code})": "${code}" is not a currency Google Play bills in.`,
    );
  });

  it("Q10: any capitalisation or a Default/Base prefix is still a price column — two of them are refused, in either order", () => {
    for (const headers of [
      ["Product ID", "Price (USD)", "PRICE (VND)"],
      ["Product ID", "Price (USD)", "price (vnd)"],
      ["Product ID", "Base Price (VND)", "Price (USD)"],
      ["Product ID", "Price (VND)", "Price"],
    ]) {
      expect(resolvePriceColumn(headers)).toMatchObject({ kind: "error", reason: "multiple" });
    }
  });

  it("a lone price header in another case, or with a Default/Base prefix, is read in its stated currency", () => {
    expect(resolvePriceColumn(["Product ID", "price (usd)"])).toMatchObject({ kind: "ok", currencyCode: "USD" });
    expect(resolvePriceColumn(["Product ID", "Base Price (VND)"])).toMatchObject({ kind: "ok", currencyCode: "VND" });
  });

  it.each(["Price USD", "Price (US$)", "Unit price"])(
    "Q10: a header that looks like a price but is not 'Price (XXX)' (%s) refuses the file — it would otherwise be ignored silently",
    (header) => {
      const out = resolvePriceColumn(["Product ID", "Price (VND)", header]);
      expect(out).toMatchObject({ kind: "error", reason: "unrecognised" });
      expect(out.kind === "error" && out.message).toBe(
        `"${header}" looks like a price column but is not "Price (XXX)". Rename it to "Price (XXX)" with the currency of the prices, or remove it — prices are read from exactly one "Price (XXX)" column.`,
      );
    },
  );

  it("'GT Price' / 'GT Currency' written exactly are NOT caught as price columns (Manager 2026-10-18, decision 3)", () => {
    expect(resolvePriceColumn(["Product ID", "Price (USD)", "GT Price", "GT Currency"])).toEqual({
      kind: "ok",
      columnIndex: 1,
      currencyCode: "USD",
      headerText: "Price (USD)",
    });
  });

  // [GOOGLE-bulkimport-drop-gt] G1 — was "a GT header in another case ⇒
  // refused with 'write it exactly'" and "one GT column without the other
  // refuses the FILE": both guarded the GT being READ. It never is now, so
  // neither is a reason to refuse a file (gate G0, 2026-10-21).
  it("the retired GT headers in ANY case or spacing are not price columns either — the file is not refused", () => {
    expect(resolvePriceColumn(["Product ID", "Price (USD)", "gt price", "Gt  Currency"])).toEqual({
      kind: "ok",
      columnIndex: 1,
      currencyCode: "USD",
      headerText: "Price (USD)",
    });
  });

  it("one GT column without the other, or a misspelt one, no longer refuses the FILE — the GT is never read", () => {
    for (const headers of [
      ["Product ID", "Price (USD)", "GT Price"],
      ["Product ID", "Price (USD)", "GT Price", "GT Curency"],
      ["Product ID", "Price (USD)", "GT Currency"],
      ["Product ID", "Price (USD)", "GT Amount", "GT Currency"],
    ]) {
      expect(resolvePriceColumn(headers)).toMatchObject({ kind: "ok", currencyCode: "USD" });
    }
    // End to end: the row is read, nothing taken from the GT column.
    const result = parseIapTemplate(makeWorkbook([["Product ID", "Price (VND)", "GT Price"], ["sku.a", 26000, 25000]]));
    expect([result.errors, result.rows.map((r) => [r.sku, r.basePriceDecimal]), result.retiredGtColumns]).toEqual([
      [],
      [["sku.a", "26000"]],
      { rowsWithData: 1 },
    ]);
  });

  it("no price column at all ⇒ error naming the only accepted shape", () => {
    const out = resolvePriceColumn(["Product ID", "Title (English)"]);
    expect(out.kind === "error" && out.message).toMatch(/^No price column found\. Expected exactly one "Price \(XXX\)" column/);
  });
});

// [GOOGLE-bulkimport-drop-gt] G1 — the "GT currency → region table" block is
// gone with the table: the parser no longer maps a GT Currency to a region.

describe("parseIapTemplate", () => {
  it("parses a minimal valid template", () => {
    const buf = makeWorkbook([
      [
        "Product ID",
        "Price (USD)",
        "GT Price",
        "GT Currency",
        "Title (English (United States))",
        "Description (English (United States))",
        "Title (Vietnamese)",
        "Description (Vietnamese)",
      ],
      [
        "com.example.pack1",
        0.99,
        25000,
        "VND",
        "Small Pack",
        "200 gems",
        "Goi Nho",
        "200 vien",
      ],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.sku).toBe("com.example.pack1");
    expect(row.baseCurrency).toBe("USD");
    expect(row.basePriceDecimal).toBe("0.99");
    // G1: the GT is not read — no override, only counted.
    expect("regionOverrides" in row).toBe(false);
    expect(result.retiredGtColumns).toEqual({ rowsWithData: 1 });
    expect(row.listings).toEqual(
      expect.arrayContaining([
        { locale: "en-US", title: "Small Pack", description: "200 gems" },
        { locale: "vi", title: "Goi Nho", description: "200 vien" },
      ]),
    );
  });

  it("rejects file with missing Product ID column", () => {
    const buf = makeWorkbook([
      ["Price (USD)", "Title (English (United States))"],
      [0.99, "x"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.errors[0]).toMatch(/Product ID/);
    expect(result.rows).toHaveLength(0);
  });

  it("rejects file with no recognised price column", () => {
    const buf = makeWorkbook([
      ["Product ID", "Title (English (United States))"],
      ["sku.a", "x"],
    ]);
    const result = parseIapTemplate(buf);
    // Hotfix 16: error message lists accepted patterns instead of
    // naming a single required header.
    expect(result.errors[0]).toMatch(/No price column found/);
    expect(result.errors[0]).toMatch(/Price \(XXX\)/);
  });

  it("skips rows without a SKU", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)"],
      ["", 0.99],
      ["sku.real", 1.99],
      ["", ""],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sku).toBe("sku.real");
  });

  it("emits warning for unrecognised locale columns", () => {
    const buf = makeWorkbook([
      [
        "Product ID",
        "Price (USD)",
        "Title (Klingon)",
        "Description (Klingon)",
      ],
      ["sku.a", 0.99, "tlhIngan", "Hol"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.warnings.join("\n")).toMatch(/Klingon/);
    expect(result.rows[0].listings).toHaveLength(0);
  });

  // [GOOGLE-bulkimport-drop-gt] G1 — the next GT tests used to pin a row
  // REFUSED for its GT (a currency outside the GT table; one of the pair
  // filled). The GT is not read any more (Manager Q1): such rows import.
  it("G1: a GT Currency outside the old GT table, or only one of GT Price / GT Currency filled ⇒ the row IMPORTS (the GT is not read)", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.a", 0.99, 100, "XYZ"],
      ["sku.b", 0.99, 100, ""],
      ["sku.c", 0.99, "", "VND"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows.map((r) => r.sku)).toEqual(["sku.a", "sku.b", "sku.c"]);
    expect([result.refusedRows, result.warnings, result.retiredGtColumns]).toEqual([[], [], { rowsWithData: 3 }]);
  });

  it("skips rows with missing Price (USD), keeps valid neighbours", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)"],
      ["sku.a", ""],
      ["sku.b", 1.99],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sku).toBe("sku.b");
    expect(result.warnings.join("\n")).toMatch(/sku\.a/);
  });

  // Hotfix 16: Manager's wall scenario — VND app + Excel with "Price
  // (VND)" header. baseCurrency must follow the header, not be
  // hardcoded USD.
  it("parses 'Price (VND)' header and sets row.baseCurrency = VND", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (VND)"],
      ["sku.a", 25000],
      ["sku.b", 50000],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.baseCurrency)).toEqual(["VND", "VND"]);
    expect(result.rows.map((r) => r.basePriceDecimal)).toEqual([
      "25000",
      "50000",
    ]);
  });

  it("H4.1 Q1: a generic 'Price' header refuses the FILE (before: silently priced in the app currency)", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price"],
      ["sku.a", 25000],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      'Header "Price" does not say which currency the prices are in. Rename it to "Price (XXX)" with the currency of the prices, e.g. "Price (USD)". The app\'s currency is not used for prices in the file.',
    ]);
  });

  it("H4.1: a price with more decimals than its currency allows ⇒ that ROW is not imported (warning), neighbours are", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (TWD)"],
      ["sku.a", 30.5],
      ["sku.b", 30],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.sku)).toEqual(["sku.b"]);
    expect(result.warnings).toContain(
      'Row 2 (SKU "sku.a"): "Price (TWD)" = "30.5" — TWD only accepts whole numbers (got "30.5"). Google rejects fractional values for this currency. Row not imported.',
    );
  });

  it("H4.1: a price that is not a number ⇒ that row is not imported", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)"],
      ["sku.a", "abc"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/Row 2 \(SKU "sku\.a"\): "Price \(USD\)" = "abc" — Decimal price must be a non-negative number/);
    // Not "no data rows" — there was a row, and it was refused.
    expect(result.warnings).toContain("No row can be imported: 1 row(s) were not imported — each is listed with its reason.");
    expect(result.refusedRows).toEqual([
      { rowNumber: 2, sku: "sku.a", reason: '"Price (USD)" = "abc" — Decimal price must be a non-negative number (got "abc").' },
    ]);
    expect(result.warnings.join("\n")).not.toMatch(/No data rows found/);
  });

  // G1 — were "a GT too precise / in CNY / ARS refuses its row": the GT is
  // not read, so those rows import; with a bad PRICE, only the price is named.
  it("G1: a GT too precise, or in a pair Google does not bill (CNY / ARS) ⇒ the row IMPORTS", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.a", 0.99, 26000.5, "VND"],
      ["sku.b", 0.99, 7, "CNY"],
      ["sku.c", 0.99, 900, "ARS"],
    ]);
    const result = parseIapTemplate(buf);
    expect([result.rows.map((r) => r.sku), result.refusedRows, result.warnings]).toEqual([["sku.a", "sku.b", "sku.c"], [], []]);
  });

  it("G1: a row with a bad price AND a bad GT names only the price — the GT is never checked", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.a", "0.999", 26000.5, "VND"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.refusedRows).toHaveLength(1);
    expect(result.refusedRows[0].reason).toBe('"Price (USD)" = "0.999" — USD supports at most 2 decimal places (got "0.999" with 3).');
  });

  it("H4.1: the not-imported summary counts refused AND blank-price rows, and still appears next to the sample-row message", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (TWD)"],
      ["com.vngg.tool.product.sample01", 30],
      ["sku.blank", ""],
      ["sku.bad", "30.5"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows).toEqual([]);
    expect(result.warnings).toContain("No row can be imported: 2 row(s) were not imported — each is listed with its reason.");
    expect(result.warnings.join("\n")).toMatch(/example row\(s\) skipped/);
  });

  it("H4.1: numeric cells — float noise reads as its 6-decimal value; a REAL extra decimal reaches the precision check and refuses the row", () => {
    // G1: the GT-column half of this test (25999.99999999996 ⇒ "26000") is
    // gone with the GT read.
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)"],
      ["sku.noise", 0.1 + 0.2],
      ["sku.real", 4.9999999],
      ["sku.tiny", 0.0000001],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows.map((r) => [r.sku, r.basePriceDecimal])).toEqual([["sku.noise", "0.3"]]);
    expect(result.refusedRows.map((r) => r.sku)).toEqual(["sku.real", "sku.tiny"]);
  });

  it("H4.3 (Q9): a parsed row carries no priceHeaderSource — the currency always comes from the header", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (VND)"],
      ["sku.a", 25000],
    ]);
    const row = parseIapTemplate(buf).rows[0];
    expect(row.baseCurrency).toBe("VND");
    expect("priceHeaderSource" in row).toBe(false);
  });
});

describe("H4.2 — thousands separators and zero prices (Manager 2026-10-18)", () => {
  it("(a) '26.000' typed as TEXT in a VND column ⇒ row refused (may be a thousands separator); the NUMBER 26000 is read as is", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (VND)", "GT Price", "GT Currency"],
      ["sku.text", "26.000", "", ""],
      ["sku.comma", "26,000", "", ""],
      ["sku.number", 26000, "", ""],
      ["sku.gt", 26000, "25.000", "VND"],
    ]);
    const result = parseIapTemplate(buf);
    // G1: sku.gt imports — its "25.000" GT is not read (was refused).
    expect(result.rows.map((r) => [r.sku, r.basePriceDecimal])).toEqual([["sku.number", "26000"], ["sku.gt", "26000"]]);
    expect(result.refusedRows.map((r) => r.reason)).toEqual([
      '"Price (VND)" = "26.000" — "26.000" has a "." but VND has no decimals — it may be a thousands separator (26.000 = 26 thousand?). Write a whole number without separators, e.g. 26000.',
      '"Price (VND)" = "26,000" — "26,000" has a "," but VND has no decimals — it may be a thousands separator (26.000 = 26 thousand?). Write a whole number without separators, e.g. 26000.',
    ]);
  });

  it("(a) a CSV / text upload stays TEXT: '26.000' VND is refused there too, never read as the number 26", () => {
    const csv = Buffer.from(
      "Product ID,Price (VND),GT Price,GT Currency\nsku.sep,26.000,,\nsku.ok,26000,,\nsku.gt,26000,25.000,VND\n",
      "utf8",
    );
    const result = parseIapTemplate(csv);
    // G1: sku.gt imports — its GT is not read (was refused).
    expect(result.rows.map((r) => [r.sku, r.basePriceDecimal])).toEqual([["sku.ok", "26000"], ["sku.gt", "26000"]]);
    expect(result.refusedRows.map((r) => r.sku)).toEqual(["sku.sep"]);
    expect(result.refusedRows.every((r) => /it may be a thousands separator/.test(r.reason))).toBe(true);
  });

  it("(a) Hotfix 5's trailing zeros stay accepted for a currency WITH decimals: '0.990' USD", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)"],
      ["sku.a", "0.990"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.refusedRows).toEqual([]);
    expect(result.rows[0].basePriceDecimal).toBe("0.990");
  });

  it("(b) a 0 price ⇒ row refused with a clear reason; a 0 GT is not read (G1: was refused)", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.zero", 0, "", ""],
      ["sku.zero-text", "0.00", "", ""],
      ["sku.gt-zero", 0.99, 0, "VND"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows.map((r) => r.sku)).toEqual(["sku.gt-zero"]);
    expect(result.refusedRows).toEqual([
      { rowNumber: 2, sku: "sku.zero", reason: '"Price (USD)" = "0" — the price is 0 — a 0 price is not accepted; enter the real price.' },
      { rowNumber: 3, sku: "sku.zero-text", reason: '"Price (USD)" = "0.00" — the price is 0 — a 0 price is not accepted; enter the real price.' },
    ]);
  });
});

describe("H4.3 — no row disappears silently", () => {
  it("a row with data but NO Product ID, and a row with an EMPTY price, are refused rows with a reason; an empty row is not a row", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "Title (English)"],
      ["sku.ok", 0.99, "Gem"],
      ["", 1.99, "No id"],
      ["sku.noprice", "", "No price"],
      ["", "", ""],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows.map((r) => r.sku)).toEqual(["sku.ok"]);
    expect(result.refusedRows).toEqual([
      { rowNumber: 3, sku: "", reason: 'no "Product ID" — every row needs one.' },
      { rowNumber: 4, sku: "sku.noprice", reason: '"Price (USD)" is empty — fill in the price.' },
    ]);
  });

  it("rows WITHOUT a Product ID that do not state a product are ignored: a helper formula dragged down (cached 0 / empty), a GT Currency filled down, an unknown column", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency", "Notes"],
      ["sku.ok", 0.99, null, null, null],
      [null, null, null, "VND", "planning"],
      [null, null, null, "VND", null],
    ]);
    // A helper formula in GT Price, dragged down: cached result 0 / "".
    ws["C3"] = { t: "n", v: 0, f: "A3*25000" };
    ws["C4"] = { t: "s", v: "", f: 'IF(A4="","",A4)' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "IAP Items");
    const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const result = parseIapTemplate(Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer));
    expect(result.rows.map((r) => r.sku)).toEqual(["sku.ok"]);
    expect(result.refusedRows).toEqual([]);
  });

  it("the generated template's own 'delete the sample rows' note (empty Product ID) is NOT a refused row", async () => {
    const { googleTemplateDataRows, googleTemplateHeaders } = await import("./template-spec");
    const buf = makeWorkbook([googleTemplateHeaders(), ...googleTemplateDataRows()]);
    const result = parseIapTemplate(buf);
    expect(result.refusedRows).toEqual([]);
    expect(result.skippedSampleRows).toHaveLength(3);
  });
});

describe("structural", () => {
  it("the parser takes no app currency in any spelling", () => {
    const src = readFileSync(join(__dirname, "excel-parser.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/appDefaultCurrency|default_currency|appCurrency|AppCurrency/);
  });
});
