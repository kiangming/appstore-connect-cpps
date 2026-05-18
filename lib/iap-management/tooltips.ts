/**
 * IAP.p2.b — pre-written tooltip strings for the View Detail UI.
 *
 * Q-I lock: tooltips live as a centralised string-map so they're
 * i18n-ready (a single locale switch wraps the lookup) and easy for
 * Manager to revise without grepping JSX. Call sites pass
 * `tooltipFor("product-id")` into `<TooltipBadge tip={…} />`.
 *
 * The keys map to the labelled fields in the mockup. Add new entries here
 * before referencing them from a component; the test layer pins every
 * declared key so a missing copy trips a build-time signal.
 */
export type TooltipKey =
  | "product-id"
  | "apple-id"
  | "reference-name"
  | "type"
  | "iap-state"
  | "family-sharable"
  | "review-screenshot"
  | "review-notes"
  | "base-territory"
  | "price-summary"
  | "localization-status"
  | "localization-description";

const TOOLTIPS: Record<TooltipKey, string> = {
  "product-id": "A unique alphanumeric ID for your in-app purchase",
  "apple-id": "Apple's internal ID for this in-app purchase",
  "reference-name":
    "Shown in App Store Connect; not visible to customers",
  type: "Consumable / Non-Consumable / Non-Renewing Subscription",
  "iap-state": "Current review state on Apple's side",
  "family-sharable":
    "Whether the purchase is shareable via Family Sharing",
  "review-screenshot":
    "A screenshot showing the in-app purchase in your app, for Apple's review team",
  "review-notes":
    "Provide context for Apple's review team to complete the review faster",
  "base-territory":
    "Apple equalizes other territories from this base price",
  "price-summary":
    "Summary of the current price schedule and any upcoming changes",
  "localization-status": "Review state of this individual localization",
  "localization-description":
    "Long-form description shown when the IAP is promoted on the App Store",
};

export function tooltipFor(key: TooltipKey): string {
  return TOOLTIPS[key];
}

/** Test-only export — full key list pinned for completeness checks. */
export const TOOLTIP_KEYS: readonly TooltipKey[] = Object.keys(
  TOOLTIPS,
) as TooltipKey[];
