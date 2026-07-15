/**
 * Pure terminal-status mapping for a bulk-import batch's Hub tracking close
 * call. Extracted from the execute route so the mapping (incl. the
 * total===0 edge case) is unit-testable without mocking the entire Apple
 * orchestration pipeline.
 *
 * A submit-deferred/failed row still counts as `succeeded` — create
 * succeeded = import succeeded; submit is a separate concern (IAP.q.2).
 * A batch where every row was SKIPPED (no successes, no failures) maps to
 * FAILED per the locked spec (succeeded === 0 && total > 0) — a known
 * nuance of the literal formula, not an oversight.
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
  if (total === 0) {
    return { status: "FAILED", errorMessage: "no rows to import" };
  }
  if (succeeded === total) {
    return { status: "SUCCESS" };
  }
  if (succeeded === 0) {
    return { status: "FAILED", errorMessage: `${failed}/${total} rows failed` };
  }
  return { status: "PARTIAL" };
}
