/**
 * Regression anchor for the unified-pricing redesign: the save payload must be
 * IDENTICAL to the pre-redesign edit flow. buildIapSaveBody is the verbatim
 * extraction of IapForm's old inline buildBody, so these assertions lock the
 * exact shape/filtering the update + create routes receive.
 */
import { describe, it, expect } from "vitest";
import { buildIapSaveBody, type IapSaveBodyState } from "./iap-save-body";

function state(overrides: Partial<IapSaveBodyState> = {}): IapSaveBodyState {
  return {
    sku: "  coins_large  ",
    purchaseType: "managed",
    status: "active",
    defaultLanguage: "en-US",
    listings: {
      "en-US": { title: "Coins", description: "200 coins" },
      "ko-KR": { title: "", description: "ignored — no title" },
    },
    baseCurrency: "USD",
    basePriceDecimal: "0.99",
    regionOverrides: [
      { region: "US", currency: "USD", priceDecimal: "0.99" },
      { region: "GB", currency: "GBP", priceDecimal: "0.79" },
      { region: "FR", currency: "EUR", priceDecimal: "   " }, // empty → dropped
    ],
    pricingSource: "google_default",
    tierIdentifier: "",
    ...overrides,
  };
}

describe("buildIapSaveBody — payload lock (must not change with the UI merge)", () => {
  it("trims sku; filters empty-title listings; drops empty-price overrides", () => {
    const body = buildIapSaveBody(state());
    expect(body.sku).toBe("coins_large");
    expect(body.listings).toEqual([
      { locale: "en-US", title: "Coins", description: "200 coins" },
    ]);
    expect(body.regionOverrides).toEqual([
      { region: "US", currency: "USD", priceDecimal: "0.99" },
      { region: "GB", currency: "GBP", priceDecimal: "0.79" },
    ]);
  });

  it("google_default → tierIdentifier null", () => {
    expect(buildIapSaveBody(state()).tierIdentifier).toBeNull();
  });

  it("template source → trimmed tierIdentifier", () => {
    const body = buildIapSaveBody(
      state({ pricingSource: "app_template", tierIdentifier: "  Tier 3  " }),
    );
    expect(body.tierIdentifier).toBe("Tier 3");
    expect(body.pricingSource).toBe("app_template");
  });

  it("template source with blank tier → null", () => {
    expect(
      buildIapSaveBody(state({ pricingSource: "default_template", tierIdentifier: "   " }))
        .tierIdentifier,
    ).toBeNull();
  });

  it("passes base price/currency, purchaseType, status, defaultLanguage through verbatim", () => {
    const body = buildIapSaveBody(
      state({ purchaseType: "consumable", status: "inactive", basePriceDecimal: "23000", baseCurrency: "VND" }),
    );
    expect(body).toMatchObject({
      purchaseType: "consumable",
      status: "inactive",
      baseCurrency: "VND",
      basePriceDecimal: "23000",
      defaultLanguage: "en-US",
    });
  });

  it("the per-territory edit a unified-table row performs (upsert into regionOverrides) yields the same body as the old index flow", () => {
    // Editing region "GB" to 0.89 — whether done by index or region-key, the
    // regionOverrides array is the same, so the body is identical.
    const edited = state({
      regionOverrides: [
        { region: "US", currency: "USD", priceDecimal: "0.99" },
        { region: "GB", currency: "GBP", priceDecimal: "0.89" }, // changed
      ],
    });
    expect(buildIapSaveBody(edited).regionOverrides).toEqual([
      { region: "US", currency: "USD", priceDecimal: "0.99" },
      { region: "GB", currency: "GBP", priceDecimal: "0.89" },
    ]);
  });
});
