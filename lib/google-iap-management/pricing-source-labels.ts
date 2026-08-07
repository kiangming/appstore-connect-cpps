/**
 * Operator-facing display labels for the three Google pricing sources.
 *
 * ⚠ THE KEYS ARE A PERSISTED CONTRACT — NEVER RENAME THEM.
 * `google_default` / `default_template` / `app_template` are written to:
 *   - `google_iap_mgmt.import_batches.pricing_source`, under a CHECK
 *     constraint (20260520010000_google_iap_mgmt_init.sql:213-215)
 *   - every `actions_log` BULK_IMPORT_BATCH payload
 *     (orchestration/bulk-import.ts — `pricing_source: input.pricingSource`)
 *   - the execute + preview wire contracts (VALID_PRICING_SOURCES) and the
 *     single-IAP save body (iap-save-body.ts)
 * Renaming a key would invalidate every historical row and force a
 * migration for what is only a wording change. The VALUES below are
 * display text and may be reworded freely.
 *
 * Why a shared module rather than inline JSX strings: the orchestrator
 * raises an operator-facing error that has to name the source the operator
 * can actually SEE in the UI. Before this module it hardcoded the raw enum
 * (`change the pricing source to "google_default"`), which named something
 * that appears nowhere on screen. One map, two consumers — the UI card
 * titles and that error message cannot drift apart.
 *
 * Consumers:
 *   - components/google-iap-management/iap-form/PricingSourceSelector.tsx
 *     (card titles — rendered by BOTH the Bulk Import wizard Step 1 and the
 *     single-IAP Create/Edit form)
 *   - lib/google-iap-management/orchestration/bulk-import.ts
 *     (the no-template-uploaded error)
 */

/** The persisted pricing-source values. Structurally identical unions are
 *  declared alongside the wire validators in the execute/preview routes and
 *  the orchestrator; those are the transport contract and stay literal. */
export type PricingSourceValue =
  | "google_default"
  | "default_template"
  | "app_template";

/**
 * Display labels. Card render order is NOT defined here — it is the JSX
 * order in PricingSourceSelector (Default Template → App-specific Template
 * → Google Conversion). Nothing keyed off this object is order-sensitive.
 */
export const PRICING_SOURCE_LABELS: Record<PricingSourceValue, string> = {
  // Renamed from "Google default" (Phase 1). The old label read as "the
  // fallback/none option"; the mechanism is actually Google's automatic
  // price conversion, which is what the Manager calls it.
  google_default: "Google Conversion",
  default_template: "Default Template",
  app_template: "App-specific Template",
};
