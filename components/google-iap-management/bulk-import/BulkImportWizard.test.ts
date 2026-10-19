/**
 * Hotfix 28 — pure-helper tests for the Bulk Import wizard's per-row
 * precision validation. Pinned against the post-Hotfix-14 invariant:
 * each row validates against its OWN `baseCurrency` (resolved by the
 * Excel parser from the column header), NOT the app's default currency.
 *
 * The orchestrator (lib/google-iap-management/orchestration/bulk-import.ts)
 * already stamps `defaultPrice.currency` from `row.baseCurrency` and
 * the Google Monetization API accepts per-region pricing, so the wizard
 * pre-flight gate must match — otherwise USD-priced uploads to VND-
 * default apps are silently blocked at the Preview step (production
 * symptom that triggered this hotfix).
 */

import { describe, it, expect } from "vitest";
import { computePrecisionViolations, gtPlanOf } from "./execute-payload";
import type { PreviewRow } from "./BulkImportWizard";

function row(overrides: Partial<PreviewRow>): PreviewRow {
  return {
    rowNumber: 2,
    sku: "com.example.sku",
    baseCurrency: "USD",
    basePriceDecimal: "0.99",
    regionOverrides: [],
    listings: [],
    exists: false,
    decision: "create",
    tierCandidates: [],
    defaultTierSelection: null,
    tierMatchedBy: "none",
    ...overrides,
  };
}

describe("computePrecisionViolations (Hotfix 28)", () => {
  it("USD column with fractional value (e.g. 21.99) passes — USD allows 2 decimals", () => {
    const violations = computePrecisionViolations([
      row({ sku: "sku.a", basePriceDecimal: "21.99", baseCurrency: "USD" }),
    ]);
    expect(violations).toEqual([]);
  });

  it("VND column with whole number passes — VND requires integer", () => {
    const violations = computePrecisionViolations([
      row({ sku: "sku.a", basePriceDecimal: "25000", baseCurrency: "VND" }),
    ]);
    expect(violations).toEqual([]);
  });

  it("VND column with fractional value (21.99) is flagged — VND rejects decimals", () => {
    const violations = computePrecisionViolations([
      row({
        rowNumber: 7,
        sku: "sku.b",
        basePriceDecimal: "21.99",
        baseCurrency: "VND",
      }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rowNumber: 7, sku: "sku.b" });
    expect(violations[0].error).toMatch(/VND only accepts whole numbers/);
  });

  it("PRODUCTION REGRESSION: USD-priced rows in a VND-default app are no longer blocked (Hotfix 28 symptom)", () => {
    // Before Hotfix 28 the wizard passed `appDefaultCurrency` (VND in the
    // London1 app) instead of `row.baseCurrency`. A "Price (USD)" column
    // with "21.99" would then fail VND precision and block the import.
    // Post-fix it validates against the row's own column-resolved
    // currency — USD — and passes.
    const violations = computePrecisionViolations([
      row({ sku: "sku.cookie1.tier22", basePriceDecimal: "21.99", baseCurrency: "USD" }),
      row({ sku: "sku.cookie2.tier05", basePriceDecimal: "4.99", baseCurrency: "USD" }),
      row({ sku: "sku.cookie3.tier10", basePriceDecimal: "9.99", baseCurrency: "USD" }),
    ]);
    expect(violations).toEqual([]);
  });

  it("mixed-currency rows are validated independently — each against its own currency", () => {
    const violations = computePrecisionViolations([
      row({ rowNumber: 2, sku: "sku.usd", basePriceDecimal: "0.99", baseCurrency: "USD" }), // ok
      row({ rowNumber: 3, sku: "sku.vnd-ok", basePriceDecimal: "25000", baseCurrency: "VND" }), // ok
      row({ rowNumber: 4, sku: "sku.vnd-bad", basePriceDecimal: "25000.5", baseCurrency: "VND" }), // fail
      row({ rowNumber: 5, sku: "sku.jpy-bad", basePriceDecimal: "1.50", baseCurrency: "JPY" }), // fail (JPY exp=0)
    ]);
    expect(violations.map((v) => v.rowNumber)).toEqual([4, 5]);
  });

  it("skip-decision rows are excluded from the gate — they're not sent to Google", () => {
    const violations = computePrecisionViolations([
      // Would fail VND precision if checked, but Skip means it never reaches Google.
      row({
        rowNumber: 9,
        sku: "sku.skipped",
        basePriceDecimal: "21.99",
        baseCurrency: "VND",
        decision: "skip",
      }),
    ]);
    expect(violations).toEqual([]);
  });

  it("rows missing baseCurrency are skipped defensively (parser couldn't resolve a column)", () => {
    const violations = computePrecisionViolations([
      // baseCurrency intentionally empty — the parser usually fills this
      // from the column header or the app-default fallback; defensive
      // guard so a malformed preview row doesn't crash the gate.
      row({ basePriceDecimal: "21.99", baseCurrency: "" }),
    ]);
    expect(violations).toEqual([]);
  });

  it("empty preview returns empty violations", () => {
    expect(computePrecisionViolations([])).toEqual([]);
  });

  it("H4.3 — the gate IS the file-price choke point: a row the parser would refuse is a violation (0, \"26.000\" VND as text)", () => {
    const v = computePrecisionViolations([
      row({ rowNumber: 3, sku: "sku.zero", basePriceDecimal: "0", baseCurrency: "USD" }),
      row({ rowNumber: 4, sku: "sku.sep", basePriceDecimal: "26.000", baseCurrency: "VND" }),
      row({ rowNumber: 5, sku: "sku.ok", basePriceDecimal: "26000", baseCurrency: "VND" }),
    ]);
    expect(v.map((x) => x.sku)).toEqual(["sku.zero", "sku.sep"]);
  });
});

describe("H4.3 (Q5) — gtPlanOf: what the push does with a row's GT, every branch", () => {
  const GT = { region: "VN", currency: "VND", priceDecimal: "26000" };
  const T1 = { identifier: "T1", templateId: "t", regionCount: 3, vnCurrency: "VND", vnPriceMicros: "25000000000", vnPriceDecimal: "25000" };
  const NO_VN = { ...T1, identifier: "T2", vnCurrency: null, vnPriceMicros: null, vnPriceDecimal: null };
  const base = { pricingSource: "default_template" as const, tierSelections: {} as Record<number, string>, customPrices: {}, activeCustomSkus: new Set<string>() };
  const custom = (entries: Array<{ region: string; currency: string; priceDecimal: string }>) => ({
    customPrices: { "com.example.sku": { entries, baseline: { kind: "none" as const }, editedAt: "x" } },
    activeCustomSkus: new Set(["com.example.sku"]),
  });

  it.each([
    ["no GT", row({}), base, { kind: "none" }],
    ["Skip", row({ regionOverrides: [GT], decision: "skip" }), base, { kind: "skip", gt: GT }],
    ["Google Conversion", row({ regionOverrides: [GT] }), { ...base, pricingSource: "google_default" as const }, { kind: "sent", gt: GT }],
    ["template, no tier matched", row({ regionOverrides: [GT] }), base, { kind: "sent", gt: GT }],
    ["custom set WITH the GT country", row({ regionOverrides: [GT] }), { ...base, ...custom([{ region: "VN", currency: "VND", priceDecimal: "27000" }]) },
      { kind: "replaced_by_custom", gt: GT, customEntry: { currency: "VND", priceDecimal: "27000" } }],
    ["custom set WITHOUT the GT country", row({ regionOverrides: [GT] }), { ...base, ...custom([{ region: "US", currency: "USD", priceDecimal: "1" }]) },
      { kind: "replaced_by_custom", gt: GT, customEntry: null }],
    ["tier with a VN price", row({ regionOverrides: [GT], tierCandidates: [T1] }), { ...base, tierSelections: { 2: "T1" } },
      { kind: "replaced_by_tier", gt: GT, tier: "T1", tierEntry: { kind: "known", currency: "VND", priceDecimal: "25000" } }],
    ["tier without a VN price", row({ regionOverrides: [GT], tierCandidates: [NO_VN] }), { ...base, tierSelections: { 2: "T2" } },
      { kind: "replaced_by_tier", gt: GT, tier: "T2", tierEntry: { kind: "absent" } }],
    ["tier, GT in another country (price unknown on the client)", row({ regionOverrides: [{ region: "JP", currency: "JPY", priceDecimal: "160" }], tierCandidates: [T1] }), { ...base, tierSelections: { 2: "T1" } },
      { kind: "replaced_by_tier", gt: { region: "JP", currency: "JPY", priceDecimal: "160" }, tier: "T1", tierEntry: { kind: "unknown" } }],
    ["candidates but no tier picked", row({ regionOverrides: [GT], tierCandidates: [T1, NO_VN] }), base, { kind: "pending_tier", gt: GT }],
    ["tier lookup failed", row({ regionOverrides: [GT], tierMatchedBy: "lookup_failed" }), base, { kind: "unknown_lookup_failed", gt: GT }],
  ])("%s", (_label, r, state, expected) => {
    expect(gtPlanOf(r, state)).toEqual(expected);
  });

  it("custom beats a tier (the custom pre-pass replaces the GT before the template loop); Skip beats both", () => {
    const r = row({ regionOverrides: [GT], tierCandidates: [T1] });
    const st = { ...base, tierSelections: { 2: "T1" }, ...custom([{ region: "VN", currency: "VND", priceDecimal: "27000" }]) };
    expect(gtPlanOf(r, st).kind).toBe("replaced_by_custom");
    expect(gtPlanOf({ ...r, decision: "skip" }, st).kind).toBe("skip");
  });
});

