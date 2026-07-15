/**
 * lib/iap-management/hub-tracking/tracking.ts — Server-side only.
 *
 * Orchestration glue between the config store and the Hub HTTP client,
 * consumed directly by the start/cancel API routes and by the bulk-import
 * execute route's finally block. Every function here is non-blocking and
 * non-throwing by construction — config-read failures are logged and
 * treated the same as "not configured" (null / no-op), never propagated
 * to the caller.
 */

import { log } from "@/lib/logger";
import { getActiveHubTrackingCredentials } from "./config";
import { hubStartRun, hubCloseRun, type HubTerminalStatus } from "./hub-client";

/**
 * Called on the wizard's step 1→2 transition. Returns null (no Hub call
 * made) when tracking is unconfigured or disabled, or when the Hub call
 * itself fails/times out — the caller treats null identically in every
 * case: bulk import proceeds exactly as it does today.
 */
export async function startBulkImportTracking(
  actorEmail?: string | null,
): Promise<string | null> {
  let creds;
  try {
    creds = await getActiveHubTrackingCredentials();
  } catch (err) {
    await log(
      "iap-hub-tracking",
      `config read failed on start: ${err instanceof Error ? err.message : err}`,
      "WARN",
    );
    return null;
  }
  if (!creds) return null;
  return hubStartRun({ workflowId: creds.workflowId, token: creds.token, actor: actorEmail ?? undefined });
}

/**
 * Closes a run with the given terminal status. No-ops if `runId` is null
 * (tracking never started for this batch) or if the config has since
 * become unavailable/disabled (can't authenticate the PATCH). Called from
 * the execute route's `finally` block (guarantees closure on every exit
 * path) and from the cancel route/beforeunload beacon (status CANCELLED).
 */
export async function finalizeHubTracking(
  runId: string | null,
  status: HubTerminalStatus,
  errorMessage?: string,
): Promise<void> {
  if (!runId) return;
  let creds;
  try {
    creds = await getActiveHubTrackingCredentials();
  } catch (err) {
    await log(
      "iap-hub-tracking",
      `config read failed on finalize (run=${runId}): ${err instanceof Error ? err.message : err}`,
      "WARN",
    );
    return;
  }
  if (!creds) return;
  await hubCloseRun({ token: creds.token, runId, status, errorMessage });
}

export type { HubTerminalStatus };
