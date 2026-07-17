/**
 * lib/iap-management/hub-tracking/submit-tracking.ts — Server-side only.
 *
 * Thin ATTEMPT/OUTCOME/timing logging wrapper around the EXISTING Bulk
 * Import Hub-tracking orchestration (`./tracking.ts`) — reused AS-IS, zero
 * changes, per the design doc's Q1 decision (one shared
 * `iap_mgmt.hub_tracking_config` / `workflow_id` / token for both features).
 *
 * Submit and Bulk Import share one Hub workflow (one combined run stream on
 * the Hub dashboard — accepted per Q1). This module exists ONLY to give
 * Submit's own Railway logs a distinct, greppable feature tag
 * ("iap-submit-hub-tracking") separate from Bulk Import's
 * ("iap-hub-tracking") — the underlying `tracking.ts`/`hub-client.ts` calls
 * still emit their own "iap-hub-tracking"-tagged ATTEMPT/OUTCOME lines too,
 * so both are independently greppable in Railway even though they hit the
 * same Hub workflow_id.
 *
 * See docs/iap-management/design-iap-submit-hub-tracking.md §D.
 */

import { log } from "@/lib/logger";
import {
  startBulkImportTracking,
  finalizeHubTracking,
  type HubTerminalStatus,
} from "./tracking";

const LOG_FEATURE = "iap-submit-hub-tracking";

export type { HubTerminalStatus };

/**
 * Starts a Hub run for a submit-batch execute attempt. Called server-side
 * at the FIRST `execute:true` POST (before `runStateGuard`) — the user's
 * only commit gesture in the submit flow (design doc §2, Q4). Returns null
 * when tracking is unconfigured/disabled/fails — the submit-batch route
 * proceeds identically either way (non-blocking, matches Bulk Import).
 */
export async function startSubmitHubTracking(
  actorEmail?: string | null,
): Promise<string | null> {
  await log(
    LOG_FEATURE,
    `[hub-tracking] submit start: ATTEMPT actor=${actorEmail ?? "unknown"}`,
  );
  const startedAt = Date.now();
  // Reused as-is — startBulkImportTracking is generic internally (config
  // gate + hubStartRun), nothing bulk-import-specific about its logic.
  const runId = await startBulkImportTracking(actorEmail);
  const elapsedMs = Date.now() - startedAt;
  await log(
    LOG_FEATURE,
    `[hub-tracking] submit start: OUTCOME run_id=${runId ?? "null (no-op)"} (${elapsedMs}ms)`,
  );
  return runId;
}

/**
 * Closes a submit-batch Hub run with a terminal status. No-ops when
 * `runId` is null (tracking never started, or the batch never reached a
 * terminal-closing site — see the multi-request finalize design, §1/§B).
 * Called from each of submit-batch's four finalize sites
 * (runExecuteLegacy, runExecuteV2's terminal branches, runProceedPartial,
 * runRollback) — NEVER from a single request-scoped try/finally the way
 * Bulk Import does it, since the v2 path can defer the terminal outcome
 * across up to two additional client round-trips (conflict dialog,
 * partial-fail dialog).
 */
export async function finalizeSubmitHubTracking(
  runId: string | null,
  status: HubTerminalStatus,
  errorMessage?: string,
): Promise<void> {
  await log(
    LOG_FEATURE,
    `[hub-tracking] submit finalize: ATTEMPT run_id=${runId ?? "null"} status=${status}`,
  );
  const startedAt = Date.now();
  await finalizeHubTracking(runId, status, errorMessage);
  const elapsedMs = Date.now() - startedAt;
  await log(
    LOG_FEATURE,
    `[hub-tracking] submit finalize: OUTCOME run_id=${runId ?? "null"} status=${status} (${elapsedMs}ms)`,
  );
}
