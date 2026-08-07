import { describe, it, expect } from "vitest";

import {
  buildCustomPriceRows,
  validateCustomPrices,
  diffFromTemplate,
  summarizeCustomPrices,
  findAppCurrencyEntry,
  flagSuspiciousDrops,
  toCustomEntries,
  type CatalogCountry,
  type TemplateEntry,
} from "./custom-prices";

const CATALOG: CatalogCountry[] = [
  { regionCode: "US", currency: "USD" },
  { regionCode: "VN", currency: "VND" },
  { regionCode: "JP", currency: "JPY" },
  { regionCode: "KW", currency: "KWD" },
];

const TEMPLATE: TemplateEntry[] = [
  { regionCode: "US", currency: "USD", priceDecimal: "9.99" },
  { regionCode: "VN", currency: "VND", priceDecimal: "249000" },
  { regionCode: "JP", currency: "JPY", priceDecimal: "1500" },
];

describe("buildCustomPriceRows", () => {
  it("pre-fills from the template and marks untouched rows as template state", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [],
    });
    expect(rows).toHaveLength(4);
    const us = rows.find((r) => r.regionCode === "US")!;
    expect(us.templateDecimal).toBe("9.99");
    expect(us.customDecimal).toBeNull();
    expect(us.state).toBe("template");
  });

  it("a country with no template entry and no custom value is `inherit` (Google conversion)", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [],
    });
    const kw = rows.find((r) => r.regionCode === "KW")!;
    expect(kw.templateDecimal).toBeNull();
    expect(kw.state).toBe("inherit");
  });

  it("derives currency from the template entry first, then Google's catalog", () => {
    // JP is in both; KW is catalog-only.
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [],
    });
    expect(rows.find((r) => r.regionCode === "JP")!.currency).toBe("JPY");
    expect(rows.find((r) => r.regionCode === "KW")!.currency).toBe("KWD");
  });

  it("does NOT trust a saved custom entry's currency over the authoritative sources", () => {
    // Stale saved state claiming VN is USD must not win — currency is not
    // user-editable, so a divergence means the saved set is out of date.
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [{ region: "VN", currency: "USD", priceDecimal: "199000" }],
    });
    expect(rows.find((r) => r.regionCode === "VN")!.currency).toBe("VND");
  });

  it("includes template-only countries the catalog omits (never silently drops a price)", () => {
    const rows = buildCustomPriceRows({
      countries: [{ regionCode: "US", currency: "USD" }],
      templateEntries: [
        { regionCode: "US", currency: "USD", priceDecimal: "9.99" },
        { regionCode: "BG", currency: "EUR", priceDecimal: "8.99" },
      ],
      custom: [],
    });
    expect(rows.map((r) => r.regionCode).sort()).toEqual(["BG", "US"]);
  });

  it("marks a differing typed value as custom, and an equal one as template", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [
        { region: "VN", currency: "VND", priceDecimal: "199000" }, // differs
        { region: "US", currency: "USD", priceDecimal: "9.99" }, // same
      ],
    });
    expect(rows.find((r) => r.regionCode === "VN")!.state).toBe("custom");
    expect(rows.find((r) => r.regionCode === "US")!.state).toBe("template");
  });

  it("treats trailing zeros as unchanged — 1.990 is not an edit of 1.99", () => {
    const rows = buildCustomPriceRows({
      countries: [{ regionCode: "US", currency: "USD" }],
      templateEntries: [{ regionCode: "US", currency: "USD", priceDecimal: "9.99" }],
      custom: [{ region: "US", currency: "USD", priceDecimal: "9.990" }],
    });
    expect(rows[0].state).toBe("template");
    expect(diffFromTemplate(rows)).toBe(0);
  });

  it("sorts by country name", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: [],
      custom: [],
    });
    const names = rows.map((r) => r.countryName);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});

describe("validateCustomPrices", () => {
  it("applies the SAME per-currency precision rules as the detail form", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [
        { region: "JP", currency: "JPY", priceDecimal: "1499.50" }, // JPY = 0 decimals
        { region: "KW", currency: "KWD", priceDecimal: "3.14159" }, // KWD = 3 decimals
        { region: "US", currency: "USD", priceDecimal: "12.34" }, // fine
      ],
    });
    const errors = validateCustomPrices(rows);
    const byRegion = Object.fromEntries(errors.map((e) => [e.regionCode, e.error]));
    expect(byRegion.JP).toContain("JPY only accepts whole numbers");
    expect(byRegion.KW).toContain("at most 3 decimal places");
    expect(byRegion.US).toBeUndefined();
  });

  it("blank countries are not errors — blank means 'let Google convert'", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [],
    });
    expect(validateCustomPrices(rows)).toEqual([]);
  });

  it("rejects a typed price for a country with no known billing currency", () => {
    const rows = buildCustomPriceRows({
      countries: [],
      templateEntries: [],
      custom: [{ region: "ZZ", currency: "", priceDecimal: "5.00" }],
    });
    expect(validateCustomPrices(rows)[0].error).toContain("No billing currency known");
  });
});

describe("summarizeCustomPrices + diffFromTemplate", () => {
  it("counts customised / at-template / blank", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [{ region: "VN", currency: "VND", priceDecimal: "199000" }],
    });
    expect(summarizeCustomPrices(rows)).toEqual({
      total: 4,
      customised: 1, // VN
      atTemplate: 2, // US, JP
      blank: 1, // KW
    });
    expect(diffFromTemplate(rows)).toBe(1);
  });
});

describe("findAppCurrencyEntry — the Save-time guard (Q6)", () => {
  it("passes when a priced country uses the app's default currency", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [{ region: "VN", currency: "VND", priceDecimal: "199000" }],
    });
    expect(findAppCurrencyEntry(rows, "VND")).toEqual({ ok: true, regionCode: "VN" });
  });

  it("fails when no PRICED country uses the app currency — a template value doesn't count", () => {
    // VN has a template price but the Manager typed nothing there; the
    // push sends only typed entries, so there'd be no VND defaultPrice.
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [{ region: "US", currency: "USD", priceDecimal: "12.00" }],
    });
    const res = findAppCurrencyEntry(rows, "VND");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("VND price");
  });

  it("fails loudly when the app has no cached default currency", () => {
    const rows = buildCustomPriceRows({ countries: CATALOG, templateEntries: [], custom: [] });
    const res = findAppCurrencyEntry(rows, null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("Refresh from Google");
  });
});

describe("flagSuspiciousDrops — the missing-floor-table heuristic (R4)", () => {
  it("flags a price >=90% below the template baseline", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [{ region: "VN", currency: "VND", priceDecimal: "1000" }], // vs 249000
    });
    const flags = flagSuspiciousDrops(rows);
    expect(flags).toHaveLength(1);
    expect(flags[0].regionCode).toBe("VN");
    expect(flags[0].percentBelow).toBe(100 - Math.round((1000 / 249000) * 100));
    expect(flags[0].message).toContain("below the template price");
  });

  it("does not flag a modest discount, and never flags an increase", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [
        { region: "VN", currency: "VND", priceDecimal: "199000" }, // -20%
        { region: "US", currency: "USD", priceDecimal: "19.99" }, // +100%
      ],
    });
    expect(flagSuspiciousDrops(rows)).toEqual([]);
  });

  it("does not flag when there is no template baseline to compare against", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: [],
      custom: [{ region: "VN", currency: "VND", priceDecimal: "1" }],
    });
    expect(flagSuspiciousDrops(rows)).toEqual([]);
  });
});

describe("toCustomEntries", () => {
  it("omits blank countries — blank is 'let Google convert', not an empty price", () => {
    const rows = buildCustomPriceRows({
      countries: CATALOG,
      templateEntries: TEMPLATE,
      custom: [{ region: "VN", currency: "VND", priceDecimal: "199000" }],
    });
    expect(toCustomEntries(rows)).toEqual([
      { region: "VN", currency: "VND", priceDecimal: "199000" },
    ]);
  });
});
