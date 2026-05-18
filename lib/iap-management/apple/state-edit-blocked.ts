/**
 * Apple state → edit likelihood (IAP.o.12a, Manager Q-IAP.o.12.C).
 *
 * Apple's OpenAPI spec does not enumerate which IAP states accept PATCH and
 * which reject — only the 409 / 422 response shapes are documented. Behavior
 * observed across the IAP.o.6 → IAP.o.11 hotfix cycle: WAITING_FOR_REVIEW
 * and IN_REVIEW reliably reject edits with `STATE_ERROR.*` codes; the rest
 * typically accept (Apple may still reject per-field for state-specific
 * reasons, but at the resource level these two are the consistently-locked
 * pair).
 *
 * Manager decision: pre-warn banner (not pre-block). The button stays
 * enabled — Apple's response is the source of truth, local cached state
 * can lag the sync. This helper only drives the banner copy.
 */
import type { InAppPurchaseState } from "@/types/iap-management/apple";

const LIKELY_BLOCKED: ReadonlySet<InAppPurchaseState> = new Set([
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
]);

export function isStateEditLikelyBlocked(
  state: InAppPurchaseState | string | null | undefined,
): boolean {
  if (!state) return false;
  return LIKELY_BLOCKED.has(state as InAppPurchaseState);
}
