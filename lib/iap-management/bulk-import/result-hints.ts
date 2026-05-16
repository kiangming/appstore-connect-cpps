/**
 * Pure result-classification helpers for the bulk-import wizard (IAP.o.7c).
 *
 * Manager MV30 surfaced a UX gap: failed rows were reported via
 * `toast.warning`, which is too easy to miss when the wizard auto-routes
 * Manager to Step 4 with a busy results table. The fix is two-pronged —
 * escalate the toast severity so failures aren't silently glossed over, and
 * surface a hint when the batch contained NON_RENEWING_SUBSCRIPTION rows
 * (those appear in Apple Connect's Subscriptions tab, not the IAP tab —
 * Manager's "tool says success, Apple UI says missing" was a tab mismatch,
 * not a code bug).
 *
 * Helpers are pure so they're unit-testable in isolation; the wizard wires
 * them into the toast call + Step 4 header banner.
 */

import type { ParsedIapItem } from "../parsers/iap-items";

export interface BulkImportTally {
  succeeded: number;
  skipped: number;
  failed: number;
}

/**
 * Pick the toast severity for the bulk-import completion notification.
 * Failure-presence dominates: any failed row → error toast (Manager directive
 * IAP.o.7c — failures must not blend in with successes).
 */
export function bulkImportToastSeverity(
  tally: BulkImportTally,
): "success" | "error" {
  return tally.failed > 0 ? "error" : "success";
}

/**
 * True when the parsed batch contains any NON_RENEWING_SUBSCRIPTION row.
 * Used to gate the Step 4 hint that points Manager at Apple Connect's
 * Subscriptions tab.
 */
export function hasNonRenewingSub(items: readonly ParsedIapItem[]): boolean {
  return items.some((it) => it.type === "NON_RENEWING_SUBSCRIPTION");
}
