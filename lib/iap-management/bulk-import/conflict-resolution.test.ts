import { describe, it, expect } from "vitest";
import {
  resolveConflicts,
  type ConflictMode,
} from "./conflict-resolution";
import type { ParsedIapItem } from "../parsers/iap-items";

function row(overrides: Partial<ParsedIapItem> = {}): ParsedIapItem {
  return {
    row_index: 2,
    product_id: "com.vng.app.product1",
    reference_name: "Product 1",
    price_usd: 0.99,
    base_price: 23000,
    base_currency: "VND",
    localizations: [],
    warnings: [],
    ...overrides,
  };
}

describe("resolveConflicts — Q-IAP.8 (overwrite default + per-item skip)", () => {
  it("CREATE when productId is new", () => {
    const result = resolveConflicts({
      parsed: [row({ product_id: "com.vng.app.new1" })],
      existing_product_ids: new Set(),
      default_mode: "OVERWRITE",
    });
    expect(result.decisions[0].disposition).toBe("CREATE");
    expect(result.counts).toEqual({ create: 1, overwrite: 0, skip: 0, error: 0 });
  });

  it("OVERWRITE when productId exists and global mode = OVERWRITE", () => {
    const result = resolveConflicts({
      parsed: [row({ product_id: "com.vng.app.existing" })],
      existing_product_ids: new Set(["com.vng.app.existing"]),
      default_mode: "OVERWRITE",
    });
    expect(result.decisions[0].disposition).toBe("OVERWRITE");
    expect(result.decisions[0].conflict).toBe(true);
  });

  it("SKIP when productId exists and global mode = SKIP", () => {
    const result = resolveConflicts({
      parsed: [row({ product_id: "com.vng.app.existing" })],
      existing_product_ids: new Set(["com.vng.app.existing"]),
      default_mode: "SKIP",
    });
    expect(result.decisions[0].disposition).toBe("SKIP");
  });

  it("per-item override wins over default_mode", () => {
    const items = [
      row({ product_id: "com.vng.app.a" }),
      row({ product_id: "com.vng.app.b" }),
    ];
    const result = resolveConflicts({
      parsed: items,
      existing_product_ids: new Set(["com.vng.app.a", "com.vng.app.b"]),
      default_mode: "OVERWRITE",
      overrides: { "com.vng.app.a": "SKIP" },
    });
    expect(result.decisions[0].disposition).toBe("SKIP");
    expect(result.decisions[1].disposition).toBe("OVERWRITE");
  });

  it("validation errors short-circuit conflict handling", () => {
    const result = resolveConflicts({
      parsed: [
        row({ product_id: "has spaces" }),
        row({ product_id: "_starts.with.underscore" }),
        row({ product_id: "com.valid.product", reference_name: "x".repeat(65) }),
      ],
      existing_product_ids: new Set(["has spaces"]), // even if "existing"
      default_mode: "OVERWRITE",
    });
    expect(result.decisions[0].disposition).toBe("ERROR");
    expect(result.decisions[0].reason).toMatch(/invalid characters/);
    expect(result.decisions[1].disposition).toBe("ERROR");
    expect(result.decisions[2].disposition).toBe("ERROR");
    expect(result.decisions[2].reason).toMatch(/64 chars/);
  });

  it("rejects non-numeric / negative price", () => {
    const result = resolveConflicts({
      parsed: [
        row({ price_usd: -1 }),
        row({ price_usd: Number.NaN }),
      ],
      existing_product_ids: new Set(),
      default_mode: "OVERWRITE",
    });
    expect(result.decisions[0].disposition).toBe("ERROR");
    expect(result.decisions[1].disposition).toBe("ERROR");
  });

  it("counts buckets reflect per-row disposition", () => {
    const result = resolveConflicts({
      parsed: [
        row({ product_id: "com.vng.app.new1" }),
        row({ product_id: "com.vng.app.new2" }),
        row({ product_id: "com.vng.app.existing1" }),
        row({ product_id: "com.vng.app.existing2" }),
        row({ product_id: "broken id" }),
      ],
      existing_product_ids: new Set([
        "com.vng.app.existing1",
        "com.vng.app.existing2",
      ]),
      default_mode: "OVERWRITE",
      overrides: { "com.vng.app.existing2": "SKIP" },
    });
    expect(result.counts).toEqual({
      create: 2,
      overwrite: 1,
      skip: 1,
      error: 1,
    });
  });

  it("preserves source row for downstream consumers", () => {
    const items = [row({ product_id: "com.vng.app.x" })];
    const result = resolveConflicts({
      parsed: items,
      existing_product_ids: new Set(),
      default_mode: "OVERWRITE",
    });
    expect(result.decisions[0].source).toBe(items[0]);
  });
});

describe("ConflictMode type", () => {
  it("admits only OVERWRITE and SKIP", () => {
    const modes: ConflictMode[] = ["OVERWRITE", "SKIP"];
    expect(modes).toHaveLength(2);
  });
});
