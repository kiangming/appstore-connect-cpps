import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

import {
  parseIapTemplate,
  regionForCurrency,
  resolvePriceColumn,
} from "./excel-parser";

function makeWorkbook(rows: Array<Array<string | number>>): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

describe("resolvePriceColumn (Hotfix 16)", () => {
  it("matches 'Price (USD)' as explicit USD (backward-compat with original template)", () => {
    const out = resolvePriceColumn(
      ["Product ID", "Price (USD)", "Title (English (United States))"],
      "USD",
    );
    expect(out).toEqual({
      columnIndex: 1,
      currencyCode: "USD",
      source: "explicit",
      headerText: "Price (USD)",
    });
  });

  it("matches 'Price (VND)' as explicit VND regardless of app default", () => {
    // Explicit header beats app default — Manager's intent in the
    // header text wins.
    const out = resolvePriceColumn(["Product ID", "Price (VND)"], "USD");
    expect(out).toMatchObject({ currencyCode: "VND", source: "explicit" });
  });

  it("normalises currency code to uppercase ('Price (vnd)' → VND)", () => {
    const out = resolvePriceColumn(["Product ID", "Price (vnd)"], "USD");
    expect(out?.currencyCode).toBe("VND");
  });

  it("matches generic 'Price' → uses app default currency", () => {
    const out = resolvePriceColumn(["Product ID", "Price"], "VND");
    expect(out).toMatchObject({ currencyCode: "VND", source: "inferred" });
  });

  it("matches 'Default Price' and 'Base Price' as generic candidates", () => {
    expect(resolvePriceColumn(["Default Price"], "EUR")?.currencyCode).toBe(
      "EUR",
    );
    expect(resolvePriceColumn(["Base Price"], "JPY")?.currencyCode).toBe(
      "JPY",
    );
  });

  it("case-insensitive on generic candidates ('default price' / 'PRICE')", () => {
    expect(resolvePriceColumn(["default price"], "USD")?.source).toBe(
      "inferred",
    );
    expect(resolvePriceColumn(["PRICE"], "USD")?.source).toBe("inferred");
  });

  it("prefers an explicit 'Price (XXX)' header over a generic 'Price' when both are present", () => {
    const out = resolvePriceColumn(
      ["Product ID", "Price", "Price (VND)"],
      "USD",
    );
    // Pass 1 (explicit) wins regardless of column order.
    expect(out).toMatchObject({
      columnIndex: 2,
      currencyCode: "VND",
      source: "explicit",
    });
  });

  it("falls back to USD when appDefaultCurrency is empty and header is generic", () => {
    // Defensive: an app that never had default_currency cached (pre-
    // Hotfix-4 row) shouldn't crash; we treat generic price as USD.
    const out = resolvePriceColumn(["Price"], "");
    expect(out?.currencyCode).toBe("USD");
  });

  it("returns null when no candidate column is present", () => {
    expect(
      resolvePriceColumn(["Product ID", "Title (English)"], "USD"),
    ).toBeNull();
  });
});

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
    const result = parseIapTemplate(buf, { appDefaultCurrency: "USD" });
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
    const result = parseIapTemplate(buf, { appDefaultCurrency: "USD" });
    expect(result.errors[0]).toMatch(/Product ID/);
    expect(result.rows).toHaveLength(0);
  });

  it("rejects file with no recognised price column", () => {
    const buf = makeWorkbook([
      ["Product ID", "Title (English (United States))"],
      ["sku.a", "x"],
    ]);
    const result = parseIapTemplate(buf, { appDefaultCurrency: "USD" });
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
    const result = parseIapTemplate(buf, { appDefaultCurrency: "USD" });
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
    const result = parseIapTemplate(buf, { appDefaultCurrency: "USD" });
    expect(result.warnings.join("\n")).toMatch(/Klingon/);
    expect(result.rows[0].listings).toHaveLength(0);
  });

  it("drops override when GT Currency is unmapped, warns", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.a", 0.99, 100, "XYZ"],
    ]);
    const result = parseIapTemplate(buf, { appDefaultCurrency: "USD" });
    expect(result.rows[0].regionOverrides).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/XYZ/);
  });

  it("warns and drops override when GT Price/Currency mismatched", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)", "GT Price", "GT Currency"],
      ["sku.a", 0.99, 100, ""],
      ["sku.b", 0.99, "", "VND"],
    ]);
    const result = parseIapTemplate(buf, { appDefaultCurrency: "USD" });
    expect(result.rows.every((r) => r.regionOverrides.length === 0)).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("skips rows with missing Price (USD), keeps valid neighbours", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price (USD)"],
      ["sku.a", ""],
      ["sku.b", 1.99],
    ]);
    const result = parseIapTemplate(buf, { appDefaultCurrency: "USD" });
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
    const result = parseIapTemplate(buf, { appDefaultCurrency: "VND" });
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.baseCurrency)).toEqual(["VND", "VND"]);
    expect(result.rows.map((r) => r.basePriceDecimal)).toEqual([
      "25000",
      "50000",
    ]);
  });

  it("parses generic 'Price' header + app default VND → row.baseCurrency = VND with a warning", () => {
    const buf = makeWorkbook([
      ["Product ID", "Price"],
      ["sku.a", 25000],
    ]);
    const result = parseIapTemplate(buf, { appDefaultCurrency: "VND" });
    expect(result.errors).toEqual([]);
    expect(result.rows[0].baseCurrency).toBe("VND");
    // Inferred-source path emits a warning suggesting the explicit
    // header so future imports skip the inference step.
    expect(result.warnings.join("\n")).toMatch(/Price \(VND\)/);
  });
});
