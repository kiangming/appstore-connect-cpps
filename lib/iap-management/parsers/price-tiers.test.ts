/**
 * Synthetic-fixture tests for parsePriceTiersXlsx covering IAP.p1.b sparse
 * template support + hard-reject / soft-warning paths. The full-grid Manager
 * template path is locked by parsers.smoke.test.ts against the real
 * docs/iap-management/templates/price-tiers-template.xlsx.
 */

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  parsePriceTiersXlsx,
  flattenTemplateEntries,
} from "./price-tiers";

function buildSheet(rows: unknown[][]): File {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "price_tiers");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([buf], "test.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// Two-territory header (USA_USD, VNM_VND). Each territory occupies 2 cells
// (Price, Proceeds), so columns are: 0=tier_name, 1=USA Price, 2=USA Proceeds,
// 3=VNM Price, 4=VNM Proceeds.
const HEADER_ROW = ["", "United States (USA_USD)", "", "Vietnam (VNM_VND)", ""];
const SUBHEADER_ROW = ["", "Price", "Proceeds", "Price", "Proceeds"];

describe("parsePriceTiersXlsx — sparse template support (IAP.p1.b)", () => {
  it("parses a full-grid 2-territory tier row", async () => {
    const file = buildSheet([
      HEADER_ROW,
      SUBHEADER_ROW,
      ["Tier 1", 0.99, 0.7, 25000, 17500],
    ]);
    const result = await parsePriceTiersXlsx(file);
    expect(result.tiers).toHaveLength(1);
    expect(result.tiers[0].territories).toHaveLength(2);
    expect(result.populated_entry_count).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("skips a (tier, territory) when both price and proceeds are blank", async () => {
    const file = buildSheet([
      HEADER_ROW,
      SUBHEADER_ROW,
      ["Tier 1", 0.99, 0.7, "", ""], // VNM blank
    ]);
    const result = await parsePriceTiersXlsx(file);
    expect(result.tiers).toHaveLength(1);
    expect(result.tiers[0].territories).toHaveLength(1);
    expect(result.tiers[0].territories[0].territory_code).toBe("USA");
    expect(result.populated_entry_count).toBe(1);
  });

  it("accepts price with blank proceeds — proceeds null on the entry", async () => {
    const file = buildSheet([
      HEADER_ROW,
      SUBHEADER_ROW,
      ["Tier 1", 0.99, "", 25000, ""],
    ]);
    const result = await parsePriceTiersXlsx(file);
    expect(result.tiers[0].territories).toHaveLength(2);
    expect(result.tiers[0].territories[0]).toMatchObject({
      territory_code: "USA",
      customer_price: 0.99,
      proceeds: null,
    });
  });

  it("warns when proceeds is filled but price is blank — entry skipped", async () => {
    const file = buildSheet([
      HEADER_ROW,
      SUBHEADER_ROW,
      ["Tier 1", "", 0.7, 25000, 17500],
    ]);
    const result = await parsePriceTiersXlsx(file);
    expect(result.tiers[0].territories).toHaveLength(1);
    expect(result.tiers[0].territories[0].territory_code).toBe("VNM");
    expect(result.warnings.some((w) => w.includes("USA"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("proceeds filled but price blank"))).toBe(true);
  });

  it("throws on non-numeric price cell (where present)", async () => {
    const file = buildSheet([
      HEADER_ROW,
      SUBHEADER_ROW,
      ["Tier 1", "not-a-number", 0.7, 25000, 17500],
    ]);
    await expect(parsePriceTiersXlsx(file)).rejects.toThrow(/Expected numeric/);
  });

  it("warns on unrecognised tier-name shape and skips the row", async () => {
    const file = buildSheet([
      HEADER_ROW,
      SUBHEADER_ROW,
      ["Tier 1", 0.99, 0.7, 25000, 17500],
      ["Strange Row", 1.99, 1.4, 50000, 35000],
    ]);
    const result = await parsePriceTiersXlsx(file);
    expect(result.tiers).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('"Strange Row"'))).toBe(true);
  });

  it("captures sparse populated_entry_count across multiple tiers", async () => {
    const file = buildSheet([
      HEADER_ROW,
      SUBHEADER_ROW,
      ["Tier 1", 0.99, 0.7, "", ""], // USA only
      ["Tier 2", "", "", 50000, 35000], // VNM only
      ["Tier 3", 2.99, 2.1, 75000, 52500], // both
    ]);
    const result = await parsePriceTiersXlsx(file);
    expect(result.tiers).toHaveLength(3);
    expect(result.populated_entry_count).toBe(4);
  });

  it("rejects malformed sheet name", async () => {
    const ws = XLSX.utils.aoa_to_sheet([HEADER_ROW, SUBHEADER_ROW, ["Tier 1", 0.99, 0.7, 25000, 17500]]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Wrong Name");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([buf], "test.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await expect(parsePriceTiersXlsx(file)).rejects.toThrow(/Expected sheet/);
  });

  it("warns on Price/Proceeds sub-header mismatch", async () => {
    const file = buildSheet([
      HEADER_ROW,
      ["", "Cost", "Proceeds", "Price", "Proceeds"], // "Cost" instead of "Price"
      ["Tier 1", 0.99, 0.7, 25000, 17500],
    ]);
    const result = await parsePriceTiersXlsx(file);
    expect(result.warnings.some((w) => w.includes("USA"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("Cost"))).toBe(true);
  });
});

describe("flattenTemplateEntries", () => {
  it("produces one entry per (tier, territory) with populated values", async () => {
    const file = buildSheet([
      HEADER_ROW,
      SUBHEADER_ROW,
      ["Tier 1", 0.99, 0.7, "", ""],
      ["Tier 2", 1.99, 1.4, 50000, 35000],
    ]);
    const parsed = await parsePriceTiersXlsx(file);
    const flat = flattenTemplateEntries(parsed);
    expect(flat).toHaveLength(3);
    expect(flat).toContainEqual({
      tier_id: "TIER_1",
      territory_code: "USA",
      currency_code: "USD",
      customer_price: 0.99,
      proceeds: 0.7,
    });
    expect(flat).toContainEqual({
      tier_id: "TIER_2",
      territory_code: "VNM",
      currency_code: "VND",
      customer_price: 50000,
      proceeds: 35000,
    });
  });

  it("preserves null proceeds on flattened rows", async () => {
    const file = buildSheet([
      HEADER_ROW,
      SUBHEADER_ROW,
      ["Tier 1", 0.99, "", 25000, ""],
    ]);
    const parsed = await parsePriceTiersXlsx(file);
    const flat = flattenTemplateEntries(parsed);
    expect(flat.every((e) => e.proceeds === null)).toBe(true);
  });
});
