import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

import { parseIapTemplate, regionForCurrency } from "./excel-parser";

function makeWorkbook(rows: Array<Array<string | number>>): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

describe("regionForCurrency", () => {
  it("maps known currencies to their primary region", () => {
    expect(regionForCurrency("VND")).toBe("VN");
    expect(regionForCurrency("usd")).toBe("US");
    expect(regionForCurrency(" thb ")).toBe("TH");
  });

  it("returns null for unknown currencies", () => {
    expect(regionForCurrency("XYZ")).toBeNull();
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

  it("rejects file with missing Price (USD) column", () => {
    const buf = makeWorkbook([
      ["Product ID", "Title (English (United States))"],
      ["sku.a", "x"],
    ]);
    const result = parseIapTemplate(buf);
    expect(result.errors[0]).toMatch(/Price \(USD\)/);
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
});
