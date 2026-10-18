import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

import {
  gtCurrencyRegionPairs,
  parseIapTemplate,
  regionForCurrency,
  resolvePriceColumn,
} from "./excel-parser";
import { PLAY_REGIONS } from "../google/play-regions.snapshot";
import { fileRegionPriceOf } from "../orchestration/file-price";
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

  it("'GT Price' is not a price column", () => {
    expect(resolvePriceColumn(["Product ID", "Price (USD)", "GT Price", "GT Currency"])).toMatchObject({ kind: "ok", currencyCode: "USD" });
  });

  it("no price column at all ⇒ error naming the only accepted shape", () => {
    const out = resolvePriceColumn(["Product ID", "Title (English)"]);
    expect(out.kind === "error" && out.message).toMatch(/^No price column found\. Expected exactly one "Price \(XXX\)" column/);
  });
});

describe("GT currency → region table", () => {
  it("maps known currencies to their one region", () => {
    expect(regionForCurrency("VND")).toBe("VN");
    expect(regionForCurrency("usd")).toBe("US");
    expect(regionForCurrency(" thb ")).toBe("TH");
  });

  it("returns null for unknown currencies (no COMMON_REGIONS fallback any more)", () => {
    expect(regionForCurrency("XYZ")).toBeNull();
  });

  it("against the measured catalog: 23 entries are billed in their currency; exactly CNY and ARS are not — and fileRegionPriceOf refuses them", () => {
    const billed = new Map(PLAY_REGIONS.map((r) => [r.code, r.currency]));
    const pairs = gtCurrencyRegionPairs();
    const matching = pairs.filter(({ currency, region }) => billed.get(region) === currency);
    const notBilled = pairs.filter(({ currency, region }) => billed.get(region) !== currency);
    expect(matching).toHaveLength(23);
    expect(notBilled.map((p) => p.currency).sort()).toEqual(["ARS", "CNY"]);
    for (const p of notBilled) {
      expect(fileRegionPriceOf({ region: p.region, currency: p.currency, priceDecimal: "1" }).ok).toBe(false);
    }
  });
});

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
    expect(row.regionOverrides).toEqual([
      { region: "VN", currency: "VND", priceDecimal: "25000" },
    ]);
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

  it("drops override when GT Currency is unmapped, warns", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.a", 0.99, 100, "XYZ"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows[0].regionOverrides).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/XYZ/);
  });

  it("warns and drops override when GT Price/Currency mismatched", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.a", 0.99, 100, ""],
      ["sku.b", 0.99, "", "VND"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows.every((r) => r.regionOverrides.length === 0)).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
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
      ["sku.a", "30.5"],
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
    expect(result.warnings).toContain("No row can be imported: 1 row(s) were not imported — see the messages above.");
    expect(result.refusedRows).toEqual([
      { rowNumber: 2, sku: "sku.a", reason: '"Price (USD)" = "abc" — Decimal price must be a non-negative number (got "abc").' },
    ]);
    expect(result.warnings.join("\n")).not.toMatch(/No data rows found/);
  });

  it("H4.1 Q10: a GT price with more decimals than its currency allows ⇒ the ROW is not imported (never sent without its GT)", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.a", 0.99, "26000.5", "VND"],
      ["sku.b", 0.99, 26000, "VND"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows.map((r) => r.sku)).toEqual(["sku.b"]);
    expect(result.rows[0].regionOverrides).toEqual([{ region: "VN", currency: "VND", priceDecimal: "26000" }]);
    expect(result.warnings).toContain(
      'Row 2 (SKU "sku.a"): GT Price "26000.5" VND — VND only accepts whole numbers (got "26000.5"). Google rejects fractional values for this currency. Row not imported.',
    );
  });

  it("H4.1: a GT in CNY / ARS REFUSES its row with Google's real billing (CN not sold; AR billed in USD) — never dropped and replaced by a converted price", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.a", 0.99, 7, "CNY"],
      ["sku.b", 0.99, 900, "ARS"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows).toEqual([]);
    expect(result.refusedRows).toEqual([
      { rowNumber: 2, sku: "sku.a", reason: 'GT Price "7" CNY — CN is not a region Google Play sells in.' },
      { rowNumber: 3, sku: "sku.b", reason: 'GT Price "900" ARS — Google Play bills AR in USD, not ARS.' },
    ]);
  });

  it("H4.1: a row with BOTH a bad price and a bad GT names both in one message", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.a", "0.999", "26000.5", "VND"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.refusedRows).toHaveLength(1);
    expect(result.refusedRows[0].reason).toBe(
      '"Price (USD)" = "0.999" — USD supports at most 2 decimal places (got "0.999" with 3). ' +
        'GT Price "26000.5" VND — VND only accepts whole numbers (got "26000.5"). Google rejects fractional values for this currency.',
    );
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
    expect(result.warnings).toContain("No row can be imported: 2 row(s) were not imported — see the messages above.");
    expect(result.warnings.join("\n")).toMatch(/example row\(s\) skipped/);
  });

  it("H4.1: numeric cells — float noise reads as its 6-decimal value; a REAL extra decimal reaches the precision check and refuses the row", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.noise", 0.1 + 0.2, 25999.99999999996, "VND"],
      ["sku.real", 4.9999999, "", ""],
      ["sku.tiny", 0.0000001, "", ""],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.rows.map((r) => [r.sku, r.basePriceDecimal, r.regionOverrides[0]?.priceDecimal])).toEqual([
      ["sku.noise", "0.3", "26000"],
    ]);
    expect(result.refusedRows.map((r) => r.sku)).toEqual(["sku.real", "sku.tiny"]);
  });

  it("every parsed row is explicit (nothing inferred since H4.1)", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (VND)"],
      ["sku.a", 25000],
    ]);
    expect(parseIapTemplate(buf).rows[0].priceHeaderSource).toBe("explicit");
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
