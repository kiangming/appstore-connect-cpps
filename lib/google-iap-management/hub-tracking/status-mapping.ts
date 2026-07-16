/**
 * Pure terminal-status mapping for a Google bulk-import batch's Hub
 * tracking close call. Parallel to
 * lib/iap-management/hub-tracking/status-mapping.ts (Apple), adapted to
 * Google's aggregate-only result shape (no per-row array, no submit-outcome
 * nuance — Google Play products go live on creation, there's no App-Review
 * style second phase).
 *
 * Driven by "did anything fail", not "did everything succeed":
 *   - failed === 0                  → SUCCESS (incl. all-skipped, all
 *                                      cross-currency-refused, or a mix of
 *                                      succeeded/skipped/refused with zero
 *                                      failures, or total === 0)
 *   - failed > 0 && succeeded === 0 → FAILED
 *   - failed > 0 && succeeded > 0   → PARTIAL
 *
 * `rowsRefused` (Cycle 43 cross-currency fail-soft) is folded into the
 * "skipped" bucket — a refusal is soft (the row wasn't sent to Google, not
 * that Google rejected it), so it's neither a success nor a failure, same
 * treatment as a Manager-chosen SKIP disposition.
 *
 * Early-return route exits (before any row is processed — bad JSON,
 * missing rows, no Google account, etc.) are NOT computed here; the route
 * sets FAILED with its own specific reason for those directly.
 */
import type { HubTerminalStatus } from "./hub-client";

export interface BulkImportTerminalStatus {
  status: HubTerminalStatus;
  errorMessage?: string;
}

export function computeGoogleBulkImportTerminalStatus(counts: {
  total: number;
  succeeded: number;
  failed: number;
}): BulkImportTerminalStatus {
  const { total, succeeded, failed } = counts;
  if (failed === 0) {
    return { status: "SUCCESS" };
  }
  if (succeeded === 0) {
    return { status: "FAILED", errorMessage: `${failed}/${total} rows failed` };
  }
  return { status: "PARTIAL" };
}
