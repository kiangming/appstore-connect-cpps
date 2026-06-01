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
import { computePrecisionViolations } from "./BulkImportWizard";
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

  // Cycle 43 — cross-currency rows that resolved via template do NOT trip
  // the precision gate because their raw price is no longer the value sent
  // to Google; the push uses the resolved app-currency micros instead.
  describe("Cycle 43 — cross-currency resolution exempts the precision gate", () => {
    it("cross_currency_resolved row with 4.99 + VND is NOT a violation (push sends resolved VND)", () => {
      const violations = computePrecisionViolations([
        row({
          sku: "sku.cookie.tier5",
          basePriceDecimal: "4.99",
          baseCurrency: "VND",
          resolution: {
            kind: "cross_currency_resolved",
            anchorUsdMicros: "4990000",
            chosenTier: "Tier 5",
            appCurrencyPrice: {
              currency: "VND",
              priceMicros: "120000000000",
              priceDecimal: "120000",
            },
          },
        }),
      ]);
      expect(violations).toEqual([]);
    });

    it("cross_currency_needs_choice row is NOT a violation (push gated by tier-pick, not precision)", () => {
      const violations = computePrecisionViolations([
        row({
          sku: "sku.cookie.tier5",
          basePriceDecimal: "0.99",
          baseCurrency: "VND",
          resolution: {
            kind: "cross_currency_needs_choice",
            anchorUsdMicros: "990000",
          },
        }),
      ]);
      expect(violations).toEqual([]);
    });

    it("cross_currency_refused row is NOT a violation (push fail-soft refuses; precision irrelevant)", () => {
      const violations = computePrecisionViolations([
        row({
          sku: "sku.cookie.tier5",
          basePriceDecimal: "4.99",
          baseCurrency: "VND",
          resolution: {
            kind: "cross_currency_refused",
            anchorUsdMicros: "4990000",
            reason: "No template tier matches USD price 4.99.",
            refusalKind: "template_miss",
          },
        }),
      ]);
      expect(violations).toEqual([]);
    });

    it("same_currency rows still receive the precision check (regression guard)", () => {
      const violations = computePrecisionViolations([
        row({
          rowNumber: 2,
          sku: "sku.vnd.bad",
          basePriceDecimal: "21.99",
          baseCurrency: "VND",
          resolution: { kind: "same_currency" },
        }),
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0].error).toMatch(/VND only accepts whole numbers/);
    });

    it("missing resolution field defaults to same_currency (backward-compat with legacy preview shape)", () => {
      const violations = computePrecisionViolations([
        // No `resolution` field — pre-Cycle-43 preview responses look
        // this way; the gate must still enforce precision.
        row({
          rowNumber: 7,
          sku: "sku.legacy.vnd.bad",
          basePriceDecimal: "4.99",
          baseCurrency: "VND",
        }),
      ]);
      expect(violations).toHaveLength(1);
    });
  });
});
