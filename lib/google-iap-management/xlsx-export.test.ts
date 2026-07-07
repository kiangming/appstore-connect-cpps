import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

import {
  buildExportPlan,
  buildExportWorkbook,
  xlsxExportFilename,
} from "./xlsx-export";
import type { ToolInAppProduct } from "./google/onetime-product-adapter";

function product(overrides: Partial<ToolInAppProduct>): ToolInAppProduct {
  return {
    packageName: "com.example.app",
    sku: "sku",
    status: "active",
    purchaseType: "managed",
    defaultLanguage: "en-US",
    defaultPrice: null,
    prices: null,
    listings: null,
    ...overrides,
  };
}

describe("buildExportPlan — territory columns", () => {
  it("is the sorted union of territories-with-a-price across all rows", () => {
    const plan = buildExportPlan([
      product({
        sku: "a",
        prices: { US: { currency: "USD", priceMicros: "1990000" } },
      }),
      product({
        sku: "b",
        prices: {
          VN: { currency: "VND", priceMicros: "149000000000" },
          ID: { currency: "IDR", priceMicros: "89000000000" },
        },
      }),
    ]);
    expect(plan.territories).toEqual(["ID", "US", "VN"]);
  });

  it("leaves a SKU's missing territory blank (absent from its prices map)", () => {
    const plan = buildExportPlan([
      product({
        sku: "a",
        prices: { US: { currency: "USD", priceMicros: "1990000" } },
      }),
      product({
        sku: "b",
        prices: { VN: { currency: "VND", priceMicros: "149000000000" } },
      }),
    ]);
    const rowA = plan.rows.find((r) => r.sku === "a")!;
    const rowB = plan.rows.find((r) => r.sku === "b")!;
    expect(rowA.prices.VN).toBeUndefined();
    expect(rowB.prices.US).toBeUndefined();
  });

  it("converts micros → decimal per-currency via the existing helper (USD 2dp, VND 0dp)", () => {
    const plan = buildExportPlan([
      product({
        sku: "a",
        prices: {
          US: { currency: "USD", priceMicros: "1990000" },
          VN: { currency: "VND", priceMicros: "149000000000" },
        },
      }),
    ]);
    const row = plan.rows[0];
    expect(row.prices.US).toEqual({ price: "1.99", currency: "USD" });
    expect(row.prices.VN).toEqual({ price: "149000", currency: "VND" });
  });
});

describe("buildExportPlan — territory selection (Export options dialog)", () => {
  const twoTerritoryProducts = [
    product({
      sku: "a",
      prices: {
        US: { currency: "USD", priceMicros: "1990000" },
        VN: { currency: "VND", priceMicros: "149000000000" },
      },
    }),
  ];

  it("no selection (absent) → unchanged: every priced territory", () => {
    const plan = buildExportPlan(twoTerritoryProducts);
    expect(plan.territories).toEqual(["US", "VN"]);
  });

  it("empty selection ([]) is treated as 'no filter' too", () => {
    const plan = buildExportPlan(twoTerritoryProducts, []);
    expect(plan.territories).toEqual(["US", "VN"]);
  });

  it("a subset selection narrows to exactly the intersection", () => {
    const plan = buildExportPlan(twoTerritoryProducts, ["US"]);
    expect(plan.territories).toEqual(["US"]);
  });

  it("a selected territory no item actually has a price for → no column, no crash", () => {
    const plan = buildExportPlan(twoTerritoryProducts, ["US", "DE"]);
    expect(plan.territories).toEqual(["US"]);
  });

  it("selecting every priced territory explicitly is equivalent to no filter", () => {
    const plan = buildExportPlan(twoTerritoryProducts, ["US", "VN"]);
    expect(plan.territories).toEqual(["US", "VN"]);
  });

  it("does not affect localization groups or fixed columns", () => {
    const withLoc = [
      product({
        sku: "a",
        prices: {
          US: { currency: "USD", priceMicros: "1990000" },
          VN: { currency: "VND", priceMicros: "149000000000" },
        },
        listings: { "en-US": { title: "Item A", description: "Desc" } },
      }),
    ];
    const unfiltered = buildExportPlan(withLoc);
    const filtered = buildExportPlan(withLoc, ["US"]);
    expect(filtered.localizationGroupCount).toBe(unfiltered.localizationGroupCount);
    expect(filtered.rows[0].sku).toBe(unfiltered.rows[0].sku);
    expect(filtered.rows[0].productName).toBe(unfiltered.rows[0].productName);
    expect(filtered.rows[0].status).toBe(unfiltered.rows[0].status);
    expect(filtered.rows[0].localizations).toEqual(unfiltered.rows[0].localizations);
    // Row-level prices are untouched — only `plan.territories` (which
    // drives the workbook's columns) is narrowed.
    expect(filtered.rows[0].prices).toEqual(unfiltered.rows[0].prices);
  });
});

describe("buildExportPlan — localization groups", () => {
  it("group count is the max described-locale count across all rows", () => {
    const plan = buildExportPlan([
      product({
        sku: "a",
        listings: {
          "en-US": { title: "A", description: "Desc A" },
          vi: { title: "A vi", description: "Mo ta" },
        },
      }),
      product({
        sku: "b",
        listings: { "en-US": { title: "B", description: "Desc B" } },
      }),
    ]);
    expect(plan.localizationGroupCount).toBe(2);
  });

  it("fills each row's described locales left-to-right in listings order", () => {
    const plan = buildExportPlan([
      product({
        sku: "a",
        listings: {
          "en-US": { title: "A", description: "Desc A" },
          vi: { title: "A vi", description: "Mo ta" },
        },
      }),
    ]);
    const row = plan.rows[0];
    expect(row.localizations).toEqual([
      { locale: "en-US", description: "Desc A" },
      { locale: "vi", description: "Mo ta" },
    ]);
  });

  it("omits locales with an empty/whitespace-only description", () => {
    const plan = buildExportPlan([
      product({
        sku: "a",
        listings: {
          "en-US": { title: "A", description: "Desc A" },
          vi: { title: "A vi", description: "   " },
          fr: { title: "A fr", description: "" },
        },
      }),
    ]);
    const row = plan.rows[0];
    expect(row.localizations).toEqual([{ locale: "en-US", description: "Desc A" }]);
    expect(plan.localizationGroupCount).toBe(1);
  });
});

describe("buildExportPlan — Product Name resolution", () => {
  it("prefers en-US title, matching the list's DEFAULT TITLE resolution", () => {
    const plan = buildExportPlan([
      product({
        sku: "a",
        listings: {
          vi: { title: "Tieu de", description: "" },
          "en-US": { title: "English title", description: "" },
        },
      }),
    ]);
    expect(plan.rows[0].productName).toBe("English title");
  });

  it("falls back to the first listing when en-US is absent", () => {
    const plan = buildExportPlan([
      product({
        sku: "a",
        listings: { vi: { title: "Tieu de", description: "" } },
      }),
    ]);
    expect(plan.rows[0].productName).toBe("Tieu de");
  });

  it("is null when there are no listings at all", () => {
    const plan = buildExportPlan([product({ sku: "a", listings: null })]);
    expect(plan.rows[0].productName).toBeNull();
  });
});

describe("buildExportPlan — status mapping", () => {
  it("maps Google's normalised status directly to active/inactive", () => {
    const plan = buildExportPlan([
      product({ sku: "a", status: "active" }),
      product({ sku: "b", status: "inactive" }),
    ]);
    expect(plan.rows[0].status).toBe("active");
    expect(plan.rows[1].status).toBe("inactive");
  });

  it("defaults anything unexpected to inactive", () => {
    const plan = buildExportPlan([product({ sku: "a", status: null })]);
    expect(plan.rows[0].status).toBe("inactive");
  });
});

describe("buildExportWorkbook — file structure", () => {
  it("emits a two-row merged header + one data row per SKU", () => {
    const plan = buildExportPlan([
      product({
        sku: "sku-1",
        listings: { "en-US": { title: "Item One", description: "Desc" } },
        prices: { US: { currency: "USD", priceMicros: "1990000" } },
      }),
      product({
        sku: "sku-2",
        listings: { "en-US": { title: "Item Two", description: "Desc 2" } },
        prices: { US: { currency: "USD", priceMicros: "990000" } },
      }),
    ]);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      defval: null,
    }) as unknown[][];

    expect(aoa[0].slice(0, 5)).toEqual([
      "Product ID",
      "Product Name",
      "Status",
      "Price in US",
      null,
    ]);
    expect(aoa[1].slice(0, 5)).toEqual([null, null, null, "Price", "Currency"]);
    expect(aoa.length).toBe(4); // 2 header rows + 2 data rows
    expect(aoa[2]).toEqual([
      "sku-1",
      "Item One",
      "active",
      "1.99",
      "USD",
      "en-US",
      "Desc",
    ]);
    expect(aoa[3]).toEqual([
      "sku-2",
      "Item Two",
      "active",
      "0.99",
      "USD",
      "en-US",
      "Desc 2",
    ]);
  });

  it("merges the fixed columns vertically and each group header horizontally", () => {
    const plan = buildExportPlan([
      product({
        sku: "a",
        prices: {
          US: { currency: "USD", priceMicros: "1990000" },
          VN: { currency: "VND", priceMicros: "149000000000" },
        },
        listings: { "en-US": { title: "A", description: "Desc" } },
      }),
    ]);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const merges = ws["!merges"] ?? [];

    // Fixed columns: A1:A2, B1:B2, C1:C2 (vertical).
    expect(merges).toContainEqual({ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } });
    expect(merges).toContainEqual({ s: { r: 0, c: 1 }, e: { r: 1, c: 1 } });
    expect(merges).toContainEqual({ s: { r: 0, c: 2 }, e: { r: 1, c: 2 } });
    // Territory group headers: D1:E1 (US), F1:G1 (VN) — alphabetical order.
    expect(merges).toContainEqual({ s: { r: 0, c: 3 }, e: { r: 0, c: 4 } });
    expect(merges).toContainEqual({ s: { r: 0, c: 5 }, e: { r: 0, c: 6 } });
    // Localization group header: H1:I1.
    expect(merges).toContainEqual({ s: { r: 0, c: 7 }, e: { r: 0, c: 8 } });
  });

  it("leaves unused territory/localization slots blank on a given row", () => {
    const plan = buildExportPlan([
      product({
        sku: "a",
        prices: { US: { currency: "USD", priceMicros: "1990000" } },
        listings: {
          "en-US": { title: "A", description: "Desc" },
          vi: { title: "A vi", description: "Mo ta" },
        },
      }),
      product({
        sku: "b",
        status: "inactive",
        prices: {}, // no price at all
        listings: null, // no localizations at all
      }),
    ]);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as unknown[][];
    const rowB = aoa[3];
    // Columns: sku, name, status, US price, US currency, loc1 code, loc1 desc, loc2 code, loc2 desc
    expect(rowB).toEqual(["b", null, "inactive", null, null, null, null, null, null]);
  });

  it("handles an empty product list (no territories, no localization groups)", () => {
    const plan = buildExportPlan([]);
    expect(plan.territories).toEqual([]);
    expect(plan.localizationGroupCount).toBe(0);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
    expect(aoa[0]).toEqual(["Product ID", "Product Name", "Status"]);
    expect(aoa.length).toBe(2); // just the two header rows
  });
});

describe("xlsxExportFilename", () => {
  it("emits the IAP-export-<package>-<YYYYMMDD> convention", () => {
    const now = new Date(2026, 6, 6, 10, 0);
    expect(xlsxExportFilename("com.vng.passsdk", now)).toBe(
      "IAP-export-com.vng.passsdk-20260706.xlsx",
    );
  });

  it("sanitises unsafe filename characters in the package name", () => {
    const now = new Date(2026, 6, 6);
    expect(xlsxExportFilename("com/bad name", now)).toMatch(
      /^IAP-export-com_bad_name-20260706\.xlsx$/,
    );
  });
});
