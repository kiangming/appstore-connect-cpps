/**
 * Pure terminal-status mapping for a CPP Bulk Import batch's Hub tracking
 * close call. Ported from lib/iap-management/hub-tracking/status-mapping.ts
 * (kept as its own copy per module-isolation convention — see
 * docs/cpp-management/design-cpp-hub-tracking.md §2.G) — the mapping logic
 * itself is unchanged, only the message wording is CPP-specific (CPPs, not
 * rows).
 *
 * Driven by "did anything fail", not "did everything succeed": a batch
 * with zero failures is SUCCESS even if total === 0 (nothing to import).
 * Only a batch with failures and zero successes is FAILED; any mix of
 * successes and failures is PARTIAL.
 *   - failed === 0                    → SUCCESS
 *   - failed > 0 && succeeded === 0   → FAILED
 *   - failed > 0 && succeeded > 0     → PARTIAL
 *
 * The success unit is per-CPP (docs/cpp-management/design-cpp-hub-tracking.md
 * §1.3/§B) — `total`/`succeeded`/`failed` here count CPPs, not locales or
 * individual asset uploads.
 *
 * An unexpected exception aborting the whole upload batch before any CPP
 * has settled (Promise.all itself rejecting, R1) is NOT computed here —
 * `failed === 0 && succeeded === 0` would misreport SUCCESS for a batch
 * that never actually ran. The caller (CppBulkImportDialog's startUpload)
 * handles that case directly rather than routing it through this function.
 *
 * Deliberately ZERO imports (not even `./hub-client`'s `HubTerminalStatus`
 * type) — CppBulkImportDialog computes the terminal status CLIENT-SIDE
 * (design §2.A) and must import this exact function for a single source of
 * truth; hub-client.ts transitively pulls in lib/logger.ts (Node `fs`/
 * `path`), which is unsafe to bundle into a "use client" component. The
 * type below is structurally identical to hub-client.ts's own
 * `HubTerminalStatus` — TS structural typing makes the two interchangeable
 * without a cross-boundary import.
 */

export type HubTerminalStatus = "SUCCESS" | "FAILED" | "CANCELLED" | "PARTIAL";

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
    return { status: "FAILED", errorMessage: `${failed}/${total} CPPs failed` };
  }
  return { status: "PARTIAL" };
}

/**
 * R1 — finalize-in-finally's decision when the upload phase's Promise.all
 * itself rejects unexpectedly (uploadCpp never throws by construction —
 * this is a defensive backstop, not a normal code path). Never trust
 * "failed===0 → SUCCESS" here: 0 succeeded and 0 failed doesn't mean
 * nothing failed, it means we don't know what happened to whatever hadn't
 * settled yet by the time of the throw. Only what already succeeded is
 * trustworthy — if anything did, the batch is at best PARTIAL; if nothing
 * did, it's FAILED. Never left RUNNING (never CANCELLED/undecided) — an
 * in-tab throw orphaning the run is worse than the already-accepted
 * tab-close edge case.
 */
export function deriveTerminalStatusOnUnexpectedError(
  succeededCount: number,
  err: unknown,
): BulkImportTerminalStatus {
  return {
    status: succeededCount > 0 ? "PARTIAL" : "FAILED",
    errorMessage: `Unexpected error during upload: ${err instanceof Error ? err.message : String(err)}`,
  };
}
