/**
 * Pure terminal-status mapping for a bulk-import batch's Hub tracking close
 * call. Extracted from the execute route so the mapping (incl. edge cases)
 * is unit-testable without mocking the entire Apple orchestration pipeline.
 *
 * A submit-deferred/failed row still counts as `succeeded` — create
 * succeeded = import succeeded; submit is a separate concern (IAP.q.2).
 *
 * Driven by "did anything fail", not "did everything succeed": a batch
 * with zero failures is SUCCESS even if some/all rows were SKIPPED
 * (conflict-skip isn't a failure). Only a batch with failures and zero
 * successes is FAILED; any mix of successes and failures is PARTIAL.
 *   - failed === 0                    → SUCCESS (incl. all-skipped, or a
 *                                        skipped+succeeded mix with no
 *                                        failures, or total === 0)
 *   - failed > 0 && succeeded === 0   → FAILED
 *   - failed > 0 && succeeded > 0     → PARTIAL
 *
 * Early-return route exits (before any row is processed — bad form body,
 * missing excel, Apple sync failure, etc.) are NOT computed here; the
 * route sets FAILED with its own specific reason for those directly.
 */
import type { HubTerminalStatus } from "./hub-client";

export interface BulkImportTerminalStatus {
  status: HubTerminalStatus;
  errorMessage?: string;
}

export function computeBulkImportTerminalStatus(counts: {
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
