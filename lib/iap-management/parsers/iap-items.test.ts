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

  it("Hotfix 27 — reordered lead columns parse successfully via name lookup", async () => {
    // Pre-Hotfix-27 this layout (Type before Reference Name) failed strict
    // positional validation. Post-Hotfix-27 the parser resolves columns by
    // name, so reorderings work as long as the required columns are present.
    const ws = XLSX.utils.aoa_to_sheet([
      [
        "Product ID",
        "Type",
        "Reference Name",
        "Price (USD)",
        "GT Price",
        "GT Currency",
        "Display Name (English (U.S.))",
        "Description (English (U.S.))",
      ],
      [
        "com.vng.x",
        "NON_CONSUMABLE",
        "Reordered Test",
        4.99,
        23000,
        "VND",
        "Test",
        "Test desc",
      ],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([buf], "reordered.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const result = await parseIapItemsXlsx(file);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].product_id).toBe("com.vng.x");
    expect(result.items[0].reference_name).toBe("Reordered Test");
    expect(result.items[0].type).toBe("NON_CONSUMABLE");
    expect(result.items[0].type_source).toBe("COLUMN");
    expect(result.items[0].price_usd).toBe(4.99);
    expect(result.items[0].base_price).toBe(23000);
    expect(result.items[0].base_currency).toBe("VND");
    expect(result.items[0].localizations).toHaveLength(1);
  });

  it("Hotfix 27 — Type column entirely absent → every row defaults to CONSUMABLE (DEFAULT source)", async () => {
    // Manager's production bug: template arrived without the Type column.
    // §3.3 IAP.h2 lock says column absent == empty cell → CONSUMABLE default.
    const ws = XLSX.utils.aoa_to_sheet([
      [
        "Product ID",
        "Reference Name",
        "Price (USD)",
        "GT Price",
        "GT Currency",
        "Display Name (English (U.S.))",
        "Description (English (U.S.))",
      ],
      ["com.vng.a", "Product A", 0.99, 23000, "VND", "A", "Adesc"],
      ["com.vng.b", "Product B", 4.99, 115000, "VND", "B", "Bdesc"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([buf], "no-type-col.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const result = await parseIapItemsXlsx(file);
    expect(result.items).toHaveLength(2);
    for (const row of result.items) {
      expect(row.type).toBe("CONSUMABLE");
      expect(row.type_source).toBe("DEFAULT");
    }
  });

  it("Hotfix 27 — Price (USD) / GT Price / GT Currency columns absent → safe defaults", async () => {
    // Per §3.3 institutional lock, only Product ID + Reference Name are
    // truly required. Other columns become 0 / "" defaults; downstream
    // pricing stage gracefully skips with `skipped-no-tier`.
    const ws = XLSX.utils.aoa_to_sheet([
      [
        "Product ID",
        "Reference Name",
        "Display Name (English (U.S.))",
        "Description (English (U.S.))",
      ],
      ["com.vng.minimal", "Minimal Row", "Name", "Desc"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([buf], "minimal.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const result = await parseIapItemsXlsx(file);
    expect(result.items[0]).toMatchObject({
      product_id: "com.vng.minimal",
      reference_name: "Minimal Row",
      type: "CONSUMABLE",
      type_source: "DEFAULT",
      price_usd: 0,
      base_price: 0,
      base_currency: "",
    });
    // Locale pair still works even though no lead pricing columns exist.
    expect(result.items[0].localizations).toHaveLength(1);
  });

  it("Hotfix 27 — empty cells under present numeric columns → 0 (not row error)", async () => {
    const file = buildFile([
      [
        "com.vng.empty.price",
        "Empty Price Row",
        "", // Type empty → CONSUMABLE
        "", // Price (USD) empty → 0 (Hotfix 27 — was a row error pre-fix)
        "", // GT Price empty → 0
        "", // GT Currency empty → ""
        "Name",
        "Desc",
      ],
    ]);
    const result = await parseIapItemsXlsx(file);
    expect(result.items[0]).toMatchObject({
      product_id: "com.vng.empty.price",
      type: "CONSUMABLE",
      type_source: "DEFAULT",
      price_usd: 0,
      base_price: 0,
      base_currency: "",
    });
  });

  it("Hotfix 27 — missing Product ID column surfaces a clear required-column error", async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Reference Name", "Type", "Price (USD)"],
      ["Sample Name", "CONSUMABLE", 0.99],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([buf], "no-product-id.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await expect(parseIapItemsXlsx(file)).rejects.toThrow(
      /missing the required "Product ID" column/,
    );
  });

  it("Hotfix 27 — missing Reference Name column surfaces a clear required-column error", async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Product ID", "Type", "Price (USD)"],
      ["com.vng.x", "CONSUMABLE", 0.99],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([buf], "no-reference-name.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await expect(parseIapItemsXlsx(file)).rejects.toThrow(
      /missing the required "Reference Name" column/,
    );
  });

  it("Hotfix 27 — case-insensitive header matching tolerates stylistic variations", async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      [
        "product id",        // lowercase
        "REFERENCE NAME",     // uppercase
        "Type",
        "Price (USD)",
        "GT Price",
        "GT Currency",
      ],
      ["com.vng.case", "Case Test", "", 0.99, 23000, "VND"],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([buf], "case-variant.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const result = await parseIapItemsXlsx(file);
    expect(result.items[0].product_id).toBe("com.vng.case");
    expect(result.items[0].reference_name).toBe("Case Test");
    expect(result.items[0].type).toBe("CONSUMABLE");
    expect(result.items[0].type_source).toBe("DEFAULT");
  });

  it("Hotfix 27 — invalid Type value still errors out (institutional lock preserved)", async () => {
    // §3.3 IAP.h2 lock: "invalid → row error" — NOT silently defaulted.
    // This guard against accidentally-typed values being silently coerced.
    const file = buildFile([rowWith({ type: "consumable" })]);
    await expect(parseIapItemsXlsx(file)).rejects.toThrow(
      /Invalid Type value "consumable"/,
    );
  });
});
