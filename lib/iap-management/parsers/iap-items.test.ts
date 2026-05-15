/**
 * Synthetic-xlsx unit tests for parseIapItemsXlsx — covers the Type-column
 * enum branches that the real Manager template doesn't exercise (samples
 * leave Type empty). Smoke tests against the real template live in
 * parsers.smoke.test.ts.
 */

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseIapItemsXlsx } from "./iap-items";

const LEAD = [
  "Product ID",
  "Reference Name",
  "Type",
  "Price (USD)",
  "GT Price",
  "GT Currency",
  "Display Name (English (U.S.))",
  "Description (English (U.S.))",
];

function buildFile(rows: unknown[][]): File {
  const ws = XLSX.utils.aoa_to_sheet([LEAD, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([buf], "synthetic.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function rowWith(opts: { type?: string; price?: number; name?: string } = {}) {
  return [
    opts.name ?? "com.vng.test.product",
    "Test Product",
    opts.type ?? "",
    opts.price ?? 0.99,
    23000,
    "VND",
    "Test", // Display Name (en-US)
    "Test desc", // Description (en-US)
  ];
}

describe("parseIapItemsXlsx Type column (Manager IAP.h2 lock)", () => {
  it("Type=CONSUMABLE → type=CONSUMABLE, type_source=COLUMN", async () => {
    const file = buildFile([rowWith({ type: "CONSUMABLE" })]);
    const result = await parseIapItemsXlsx(file);
    expect(result.items[0].type).toBe("CONSUMABLE");
    expect(result.items[0].type_source).toBe("COLUMN");
  });

  it("Type=NON_CONSUMABLE → applied via COLUMN source", async () => {
    const file = buildFile([rowWith({ type: "NON_CONSUMABLE" })]);
    const result = await parseIapItemsXlsx(file);
    expect(result.items[0].type).toBe("NON_CONSUMABLE");
    expect(result.items[0].type_source).toBe("COLUMN");
  });

  it("Type=NON_RENEWING_SUBSCRIPTION → applied via COLUMN source", async () => {
    const file = buildFile([rowWith({ type: "NON_RENEWING_SUBSCRIPTION" })]);
    const result = await parseIapItemsXlsx(file);
    expect(result.items[0].type).toBe("NON_RENEWING_SUBSCRIPTION");
    expect(result.items[0].type_source).toBe("COLUMN");
  });

  it("Empty Type cell → CONSUMABLE default with DEFAULT source", async () => {
    const file = buildFile([rowWith({ type: "" })]);
    const result = await parseIapItemsXlsx(file);
    expect(result.items[0].type).toBe("CONSUMABLE");
    expect(result.items[0].type_source).toBe("DEFAULT");
  });

  it("Invalid Type value (lowercase) → throws with explicit error message", async () => {
    const file = buildFile([rowWith({ type: "consumable" })]);
    await expect(parseIapItemsXlsx(file)).rejects.toThrow(
      /Invalid Type value "consumable"/,
    );
  });

  it("Invalid Type value (typo) → throws with expected enum list in message", async () => {
    const file = buildFile([rowWith({ type: "AUTO_RENEWABLE_SUBSCRIPTION" })]);
    await expect(parseIapItemsXlsx(file)).rejects.toThrow(
      /CONSUMABLE \/ NON_CONSUMABLE \/ NON_RENEWING_SUBSCRIPTION/,
    );
  });

  it("Type column at wrong position → header mismatch error", async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      [
        "Product ID",
        "Type", // wrong — should be col 2 not col 1
        "Reference Name",
        "Price (USD)",
        "GT Price",
        "GT Currency",
      ],
      ["com.vng.x", "CONSUMABLE", "Name", 0.99, 23000, "VND"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([buf], "bad-header.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await expect(parseIapItemsXlsx(file)).rejects.toThrow(
      /header mismatch at column 2/,
    );
  });

  it("Header shift propagates to Price column at col 3", async () => {
    // If parser still expected Price at col 2 (pre-IAP.h2 layout), it would
    // throw a numeric-cell error. Verify the post-IAP.h2 layout works.
    const file = buildFile([rowWith({ type: "CONSUMABLE", price: 4.99 })]);
    const result = await parseIapItemsXlsx(file);
    expect(result.items[0].price_usd).toBe(4.99);
    expect(result.items[0].base_price).toBe(23000);
    expect(result.items[0].base_currency).toBe("VND");
  });
});
