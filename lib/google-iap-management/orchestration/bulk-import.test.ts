import { describe, it, expect } from "vitest";

import { buildProduct, type BulkImportRow } from "./bulk-import";

function row(overrides: Partial<BulkImportRow> = {}): BulkImportRow {
  return {
    rowNumber: 2,
    sku: "com.example.pack",
    baseCurrency: "USD",
    basePriceDecimal: "1.99",
    regionOverrides: [],
    listings: [
      { locale: "en-US", title: "Small Pack", description: "200 gems" },
    ],
    decision: "create",
    ...overrides,
  };
}

describe("buildProduct (bulk-import row → InAppProduct)", () => {
  it("converts base decimal to micros + sets defaults", () => {
    const out = buildProduct("com.example.app", row());
    expect(out.packageName).toBe("com.example.app");
    expect(out.sku).toBe("com.example.pack");
    expect(out.status).toBe("active");
    expect(out.purchaseType).toBe("managedUser");
    expect(out.defaultLanguage).toBe("en-US");
    expect(out.defaultPrice).toEqual({
      currency: "USD",
      priceMicros: "1990000",
    });
  });

  it("includes prices map when regionOverrides present", () => {
    const out = buildProduct(
      "com.example.app",
      row({
        regionOverrides: [
          { region: "VN", currency: "vnd", priceDecimal: "25000" },
          { region: "JP", currency: "JPY", priceDecimal: "300" },
        ],
      }),
    );
    expect(out.prices).toEqual({
      VN: { currency: "VND", priceMicros: "25000000000" },
      JP: { currency: "JPY", priceMicros: "300000000" },
    });
  });

  it("omits prices map when no overrides", () => {
    const out = buildProduct("com.example.app", row({ regionOverrides: [] }));
    expect(out.prices).toBeUndefined();
  });

  it("falls back to en-US copy of first listing when no en-US in input", () => {
    const out = buildProduct(
      "com.example.app",
      row({
        listings: [{ locale: "vi", title: "Goi nho", description: "200 vien" }],
      }),
    );
    expect(out.listings?.["en-US"]).toEqual({
      title: "Goi nho",
      description: "200 vien",
    });
    expect(out.listings?.["vi"]).toEqual({
      title: "Goi nho",
      description: "200 vien",
    });
  });

  it("uses sku as en-US title when input listings are empty", () => {
    const out = buildProduct(
      "com.example.app",
      row({ sku: "fallback.sku", listings: [] }),
    );
    expect(out.listings?.["en-US"]).toEqual({
      title: "fallback.sku",
      description: "",
    });
  });

  it("skips listings entries that are empty in both title and description", () => {
    const out = buildProduct(
      "com.example.app",
      row({
        listings: [
          { locale: "en-US", title: "Pack", description: "" },
          { locale: "vi", title: "", description: "" }, // skipped
          { locale: "ja", title: "パック", description: "200 ジェム" },
        ],
      }),
    );
    expect(Object.keys(out.listings ?? {}).sort()).toEqual(["en-US", "ja"]);
  });
});
