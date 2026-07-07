import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

import { buildExportPlan, buildExportWorkbook, xlsxExportFilename } from "./xlsx-export";
import type { ExportSource } from "./xlsx-export";
import type { PriceScheduleView, PriceScheduleEntry } from "./queries/iap-detail";

function entry(overrides: Partial<PriceScheduleEntry>): PriceScheduleEntry {
  return {
    priceId: "price-1",
    startDate: null,
    endDate: null,
    territory: "USA",
    customerPrice: "0.99",
    currency: "USD",
    ...overrides,
  };
}

function schedule(entries: PriceScheduleEntry[], baseTerritory = "USA"): PriceScheduleView {
  const basePrice = entries.find((e) => e.territory === baseTerritory && e.startDate === null) ?? null;
  return { baseTerritory, basePrice, entries };
}

function source(overrides: Partial<ExportSource>): ExportSource {
  return {
    productId: "com.example.item",
    skuName: "Item",
    status: "APPROVED",
    priceSchedule: null,
    localizations: [],
    ...overrides,
  };
}

describe("buildExportPlan — territory columns", () => {
  it("is the sorted (alpha-2) union of territories-with-a-price across all rows", () => {
    const plan = buildExportPlan([
      source({ priceSchedule: schedule([entry({ territory: "USA" })]) }),
      source({
        priceSchedule: schedule(
          [
            entry({ territory: "VNM", customerPrice: "24000", currency: "VND" }),
            entry({ territory: "JPN", customerPrice: "160", currency: "JPY" }),
          ],
          "VNM",
        ),
      }),
    ]);
    expect(plan.territories).toEqual(["JP", "US", "VN"]);
  });

  it("leaves a row's missing territory blank when it has no effective-now price there", () => {
    const plan = buildExportPlan([
      source({ priceSchedule: schedule([entry({ territory: "USA" })]) }),
      source({
        priceSchedule: schedule([entry({ territory: "VNM", customerPrice: "24000", currency: "VND" })], "VNM"),
      }),
    ]);
    expect(plan.rows[0].prices.VN).toBeUndefined();
    expect(plan.rows[1].prices.US).toBeUndefined();
  });

  it("excludes future-dated (upcoming-change) entries from the price columns", () => {
    const plan = buildExportPlan([
      source({
        priceSchedule: schedule([
          entry({ territory: "USA", customerPrice: "0.99" }),
          entry({ territory: "USA", customerPrice: "1.99", startDate: "2026-12-01", priceId: "price-2" }),
        ]),
      }),
    ]);
    expect(plan.rows[0].prices.US).toEqual({ price: "0.99", currency: "USD" });
  });

  it("uses Apple's customerPrice/currency verbatim — no re-conversion (already currency-correct)", () => {
    const plan = buildExportPlan([
      source({
        priceSchedule: schedule(
          [
            entry({ territory: "USA", customerPrice: "0.99", currency: "USD" }),
            entry({ territory: "JPN", customerPrice: "160", currency: "JPY" }),
            entry({ territory: "VNM", customerPrice: "24000", currency: "VND" }),
          ],
          "USA",
        ),
      }),
    ]);
    const row = plan.rows[0];
    expect(row.prices.US).toEqual({ price: "0.99", currency: "USD" });
    expect(row.prices.JP).toEqual({ price: "160", currency: "JPY" });
    expect(row.prices.VN).toEqual({ price: "24000", currency: "VND" });
  });

  it("leaves baseTerritory + all prices blank when there's no schedule at all", () => {
    const plan = buildExportPlan([source({ priceSchedule: null })]);
    expect(plan.rows[0].baseTerritory).toBeNull();
    expect(plan.rows[0].prices).toEqual({});
    expect(plan.territories).toEqual([]);
  });

  it("converts Base Country from alpha-3 to alpha-2", () => {
    const plan = buildExportPlan([
      source({ priceSchedule: schedule([entry({ territory: "USA" })], "USA") }),
    ]);
    expect(plan.rows[0].baseTerritory).toBe("US");
  });
});

describe("buildExportPlan — territory selection (Export options dialog)", () => {
  const twoTerritorySources = [
    source({
      priceSchedule: schedule(
        [
          entry({ territory: "USA", customerPrice: "0.99", currency: "USD" }),
          entry({ territory: "VNM", customerPrice: "24000", currency: "VND" }),
        ],
        "USA",
      ),
    }),
  ];

  it("no selection (absent) → unchanged: every priced territory", () => {
    const plan = buildExportPlan(twoTerritorySources);
    expect(plan.territories).toEqual(["US", "VN"]);
  });

  it("empty selection ([]) is treated as 'no filter' too", () => {
    const plan = buildExportPlan(twoTerritorySources, []);
    expect(plan.territories).toEqual(["US", "VN"]);
  });

  it("a subset selection (alpha-2 codes) narrows to exactly the intersection", () => {
    const plan = buildExportPlan(twoTerritorySources, ["US"]);
    expect(plan.territories).toEqual(["US"]);
  });

  it("a selected territory no item actually has a price for → no column, no crash", () => {
    const plan = buildExportPlan(twoTerritorySources, ["US", "DE"]);
    expect(plan.territories).toEqual(["US"]);
  });

  it("does not affect Base Country, localization groups, or fixed columns", () => {
    const withLoc = [
      source({
        productId: "sku-1",
        skuName: "Item One",
        status: "APPROVED",
        priceSchedule: schedule(
          [
            entry({ territory: "USA", customerPrice: "0.99", currency: "USD" }),
            entry({ territory: "VNM", customerPrice: "24000", currency: "VND" }),
          ],
          "USA",
        ),
        localizations: [{ locale: "en-US", displayName: "Item One", description: "Desc" }],
      }),
    ];
    const unfiltered = buildExportPlan(withLoc);
    const filtered = buildExportPlan(withLoc, ["US"]);
    expect(filtered.localizationGroupCount).toBe(unfiltered.localizationGroupCount);
    expect(filtered.rows[0].productId).toBe(unfiltered.rows[0].productId);
    expect(filtered.rows[0].skuName).toBe(unfiltered.rows[0].skuName);
    expect(filtered.rows[0].status).toBe(unfiltered.rows[0].status);
    expect(filtered.rows[0].baseTerritory).toBe(unfiltered.rows[0].baseTerritory);
    expect(filtered.rows[0].localizations).toEqual(unfiltered.rows[0].localizations);
    expect(filtered.rows[0].prices).toEqual(unfiltered.rows[0].prices);
  });
});

describe("buildExportPlan — localization groups", () => {
  it("group count is the max localization count across all rows", () => {
    const plan = buildExportPlan([
      source({
        localizations: [
          { locale: "en-US", displayName: "A", description: "Desc A" },
          { locale: "ja", displayName: "A ja", description: "Desc ja" },
        ],
      }),
      source({ localizations: [{ locale: "en-US", displayName: "B", description: "Desc B" }] }),
    ]);
    expect(plan.localizationGroupCount).toBe(2);
  });

  it("fills each row's localizations left-to-right, positionally", () => {
    const plan = buildExportPlan([
      source({
        localizations: [
          { locale: "en-US", displayName: "A", description: "Desc A" },
          { locale: "vi", displayName: "A vi", description: "Mo ta" },
        ],
      }),
    ]);
    expect(plan.rows[0].localizations).toEqual([
      { locale: "en-US", displayName: "A", description: "Desc A" },
      { locale: "vi", displayName: "A vi", description: "Mo ta" },
    ]);
  });
});

describe("buildExportPlan — fixed columns", () => {
  it("SKU Name is the reference name, not a localized display name", () => {
    const plan = buildExportPlan([
      source({
        skuName: "Internal Reference Name",
        localizations: [{ locale: "en-US", displayName: "Storefront Display Name", description: "" }],
      }),
    ]);
    expect(plan.rows[0].skuName).toBe("Internal Reference Name");
  });

  it("Status is the raw Apple state string — no 2-state collapse", () => {
    const plan = buildExportPlan([
      source({ status: "MISSING_METADATA" }),
      source({ status: "REMOVED_FROM_SALE" }),
      source({ status: "APPROVED" }),
    ]);
    expect(plan.rows.map((r) => r.status)).toEqual([
      "MISSING_METADATA",
      "REMOVED_FROM_SALE",
      "APPROVED",
    ]);
  });
});

describe("buildExportWorkbook — file structure", () => {
  it("emits a two-row merged header (4 fixed cols) + one data row per IAP", () => {
    const plan = buildExportPlan([
      source({
        productId: "sku-1",
        skuName: "Item One",
        status: "APPROVED",
        priceSchedule: schedule([entry({ territory: "USA", customerPrice: "0.99", currency: "USD" })], "USA"),
        localizations: [{ locale: "en-US", displayName: "Item One", description: "Desc" }],
      }),
    ]);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as unknown[][];

    expect(aoa[0]).toEqual(["Product ID", "SKU Name", "Status", "Base Country", "Price in US", null, "Localization 1", null, null]);
    expect(aoa[1]).toEqual([null, null, null, null, "Price", "Currency", "Locale", "Display Name", "Description"]);
    expect(aoa.length).toBe(3); // 2 header rows + 1 data row
    expect(aoa[2]).toEqual(["sku-1", "Item One", "APPROVED", "US", "0.99", "USD", "en-US", "Item One", "Desc"]);
  });

  it("merges the 4 fixed columns vertically, territory groups 2-wide, localization groups 3-wide", () => {
    const plan = buildExportPlan([
      source({
        priceSchedule: schedule(
          [
            entry({ territory: "USA", customerPrice: "0.99", currency: "USD" }),
            entry({ territory: "JPN", customerPrice: "160", currency: "JPY" }),
          ],
          "USA",
        ),
        localizations: [{ locale: "en-US", displayName: "A", description: "Desc" }],
      }),
    ]);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const merges = ws["!merges"] ?? [];

    // Fixed columns: A1:A2 .. D1:D2.
    for (let c = 0; c < 4; c += 1) {
      expect(merges).toContainEqual({ s: { r: 0, c }, e: { r: 1, c } });
    }
    // Territory group headers: E1:F1 (JP), G1:H1 (US) — alphabetical.
    expect(merges).toContainEqual({ s: { r: 0, c: 4 }, e: { r: 0, c: 5 } });
    expect(merges).toContainEqual({ s: { r: 0, c: 6 }, e: { r: 0, c: 7 } });
    // Localization group header (3-wide): I1:K1.
    expect(merges).toContainEqual({ s: { r: 0, c: 8 }, e: { r: 0, c: 10 } });
  });

  it("leaves unused territory/localization slots blank on a given row", () => {
    const plan = buildExportPlan([
      source({
        productId: "a",
        priceSchedule: schedule([entry({ territory: "USA", customerPrice: "0.99", currency: "USD" })], "USA"),
        localizations: [{ locale: "en-US", displayName: "A", description: "Desc" }],
      }),
      source({ productId: "b", status: "MISSING_METADATA", priceSchedule: null, localizations: [] }),
    ]);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) as unknown[][];
    const rowB = aoa[3];
    expect(rowB).toEqual(["b", "Item", "MISSING_METADATA", null, null, null, null, null, null]);
  });

  it("handles an empty IAP list (no territories, no localization groups)", () => {
    const plan = buildExportPlan([]);
    expect(plan.territories).toEqual([]);
    expect(plan.localizationGroupCount).toBe(0);
    const wb = buildExportWorkbook(plan);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
    expect(aoa[0]).toEqual(["Product ID", "SKU Name", "Status", "Base Country"]);
    expect(aoa.length).toBe(2);
  });
});

describe("xlsxExportFilename", () => {
  it("emits the Apple-IAP-export-<appRef>-<YYYYMMDD> convention", () => {
    const now = new Date(2026, 6, 6, 10, 0);
    expect(xlsxExportFilename("1234567890", now)).toBe("Apple-IAP-export-1234567890-20260706.xlsx");
  });

  it("sanitises unsafe filename characters", () => {
    const now = new Date(2026, 6, 6);
    expect(xlsxExportFilename("com/bad name", now)).toMatch(/^Apple-IAP-export-com_bad_name-20260706\.xlsx$/);
  });
});
