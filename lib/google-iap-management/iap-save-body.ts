/**
 * Pure builder for the IAP create/update save payload.
 *
 * EXTRACTED VERBATIM from IapForm's inline `buildBody` (Cycle: unified-pricing
 * redesign) so the save payload is unit-testable and provably unchanged by the
 * UI reorganization. The unified per-country table mutates the SAME
 * `regionOverrides` / base / listings state these fields read, so identical
 * edits produce a byte-identical body — this module is the regression anchor.
 *
 * DO NOT change the mapping/filtering here without intending to change what is
 * written to Google/DB.
 */
import type { FormListing, RegionOverrideRow } from "./form-state";
import type { PricingSource } from "../../components/google-iap-management/iap-form/PricingSourceSelector";

export interface IapSaveBodyState {
  sku: string;
  purchaseType: "managed" | "consumable";
  status: "active" | "inactive";
  defaultLanguage: string;
  listings: Record<string, FormListing>;
  baseCurrency: string;
  basePriceDecimal: string;
  regionOverrides: RegionOverrideRow[];
  pricingSource: PricingSource;
  tierIdentifier: string;
}

export interface IapSaveBody {
  sku: string;
  purchaseType: "managed" | "consumable";
  status: "active" | "inactive";
  defaultLanguage: string;
  listings: Array<{ locale: string; title: string; description: string }>;
  baseCurrency: string;
  basePriceDecimal: string;
  regionOverrides: Array<{ region: string; currency: string; priceDecimal: string }>;
  pricingSource: PricingSource;
  tierIdentifier: string | null;
}

export function buildIapSaveBody(state: IapSaveBodyState): IapSaveBody {
  return {
    sku: state.sku.trim(),
    purchaseType: state.purchaseType,
    status: state.status,
    defaultLanguage: state.defaultLanguage,
    listings: Object.entries(state.listings)
      .filter(([, l]) => l.title.trim().length > 0)
      .map(([locale, l]) => ({
        locale,
        title: l.title,
        description: l.description,
      })),
    baseCurrency: state.baseCurrency,
    basePriceDecimal: state.basePriceDecimal,
    regionOverrides: state.regionOverrides
      .filter((r) => r.priceDecimal.trim().length > 0)
      .map((r) => ({
        region: r.region,
        currency: r.currency,
        priceDecimal: r.priceDecimal,
      })),
    pricingSource: state.pricingSource,
    tierIdentifier:
      state.pricingSource === "google_default"
        ? null
        : state.tierIdentifier.trim() || null,
  };
}
