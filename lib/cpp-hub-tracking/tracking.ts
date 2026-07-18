/**
 * lib/cpp-hub-tracking/tracking.ts — Server-side only.
 *
 * Orchestration glue between the config store and the Hub HTTP client,
 * consumed by the start/cancel/finalize API routes. Every function here is
 * non-blocking and non-throwing by construction — config-read failures are
 * logged and treated the same as "not configured" (null / no-op), never
 * propagated to the caller.
 *
 * Unlike IAP/Google Bulk Import (where finalize runs inside the execute
 * route's own request-scoped `finally`), CPP's asset-upload flow is
 * client-orchestrated with no batch-level server route — finalize here is
 * called from a slim `/finalize` route that only relays a client-computed
 * terminal status to Hub (docs/cpp-management/design-cpp-hub-tracking.md
 * §2.A). The function itself is otherwise identical to the IAP/Google
 * precedent.
 *
 * Every decision point logs a `[hub-tracking]`-prefixed line (Railway
 * console) so a no-op and a silent failure are distinguishable from
 * outside — the tracking itself is fire-and-forget, but its behavior
 * shouldn't be a black box. The token is never included in any log line.
 */

import { log } from "@/lib/logger";
import { getHubTrackingGate } from "./config";
import { hubStartRun, hubCloseRun, type HubTerminalStatus } from "./hub-client";

const LOG_FEATURE = "cpp-hub-tracking";

/**
 * Called on the CPP Bulk Import dialog's "validating"→"preview" transition
 * (the moment the folder has finished loading into the tool, before any
 * Apple write). Returns null (no Hub call made) when tracking is
 * unconfigured or disabled, or when the Hub call itself fails/times out —
 * the caller treats null identically in every case: bulk import proceeds
 * exactly as it does today.
 */
export async function startBulkImportTracking(
  actorEmail?: string | null,
): Promise<string | null> {
  let gate;
  try {
    gate = await getHubTrackingGate();
  } catch (err) {
    await log(
      LOG_FEATURE,
      `[hub-tracking] start: config read failed (non-fatal): ${err instanceof Error ? err.message : err}`,
      "WARN",
    );
    return null;
  }

  if (!gate.credentials) {
    await log(
      LOG_FEATURE,
      `[hub-tracking] start: enabled=${gate.enabled} configured=${gate.configured} → SKIP (no-op)`,
    );
    return null;
  }

  await log(
    LOG_FEATURE,
    `[hub-tracking] start: enabled=${gate.enabled} configured=${gate.configured} → PROCEEDING workflow_id=${gate.credentials.workflowId}`,
  );
  return hubStartRun({
    workflowId: gate.credentials.workflowId,
    token: gate.credentials.token,
    actor: actorEmail ?? undefined,
  });
}

/**
 * Closes a run with the given terminal status. No-ops if `runId` is null
 * (tracking never started for this batch, or the run was already handled)
 * or if the config has since become unavailable/disabled (can't
 * authenticate the PATCH). Called from the `/finalize` route (client-
 * computed terminal status, R1 finalize-in-finally) and from the `/cancel`
 * route (explicit back-out / beforeunload beacon, status CANCELLED).
 */
export async function finalizeHubTracking(
  runId: string | null,
  status: HubTerminalStatus,
  errorMessage?: string,
): Promise<void> {
  if (!runId) {
    await log(LOG_FEATURE, `[hub-tracking] finalize: status=${status} → SKIP (no run_id)`);
    return;
  }

  let gate;
  try {
    gate = await getHubTrackingGate();
  } catch (err) {
    await log(
      LOG_FEATURE,
      `[hub-tracking] finalize: run_id=${runId} status=${status} config read failed (non-fatal): ${err instanceof Error ? err.message : err}`,
      "WARN",
    );
    return;
  }

  if (!gate.credentials) {
    await log(
      LOG_FEATURE,
      `[hub-tracking] finalize: run_id=${runId} status=${status} enabled=${gate.enabled} configured=${gate.configured} → SKIP (config unavailable/disabled)`,
    );
    return;
  }

  await hubCloseRun({ token: gate.credentials.token, runId, status, errorMessage });
}

export type { HubTerminalStatus };
