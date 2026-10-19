/**
 * Pure terminal-status mapping for a Google bulk-import batch's Hub
 * tracking close call. Parallel to
 * lib/iap-management/hub-tracking/status-mapping.ts (Apple), adapted to
 * Google's aggregate-only result shape (no per-row array, no submit-outcome
 * nuance — Google Play products go live on creation, there's no App-Review
 * style second phase).
 *
 * Driven by "did anything fail", not "did everything succeed":
 *   - failed === 0                  → SUCCESS (incl. all-skipped, a mix
 *                                      of succeeded/skipped with zero
 *                                      failures, or total === 0)
 *   - failed > 0 && succeeded === 0 → FAILED
 *   - failed > 0 && succeeded > 0   → PARTIAL
 *
 * ⚠ A REFUSED row arrives here inside `failed` (KB P5, H4.2/H4.3): the
 * execute route adds the orchestrator's `rowsRefused` — EVERY refusal kind
 * (file_price_invalid, conversion_failed, tier_price_invalid,
 * price_build_failed, custom_invalid_price, and refused_in_file for the rows
 * the Manager left out of the file) — to rowsFailed, and `total` includes
 * the left-out rows. A refusal means a row of the file was NOT written, so
 * it is never a soft skip; only a Manager-chosen SKIP is "skipped". (Before
 * H4.2 the cross-currency refusals were folded into "skipped".)
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
