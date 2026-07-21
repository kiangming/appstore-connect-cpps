/**
 * POST /api/iap-management/iaps/bulk-availability
 *
 * Cycle 39 Phase 2 — bulk Apple availability flip for a multi-selected
 * set of IAPs. Body shape:
 *
 *   { iapIds: string[], action: "set-all" | "remove", hub_run_id?: string }
 *
 * Where `iapIds` are internal `iap_mgmt.iaps.id` rows (UUIDs). The
 * orchestrator resolves each row's `apple_iap_id` server-side, calls
 * Apple at concurrency 5, and writes one actions_log row per IAP using
 * the Phase 1 audit types (`AVAILABILITY_SET_ALL_TERRITORIES` /
 * `AVAILABILITY_REMOVE_FROM_SALES`).
 *
 * Q-K fail-soft preserved: per-IAP failures never cascade. The response
 * surfaces per-row status + an aggregate roll-up so the modal can render
 * the progress view (mockup State 6) without a second round-trip.
 *
 * Hub tracking (6th+7th integration,
 * docs/iap-management/design-iap-availability-hub-tracking.md): the
 * whole handler is wrapped in try/finally so every exit path — each
 * early return below, and the success/failure of `executeBulkAvailability`
 * itself — closes the Hub run (opened client-side at the Set
 * Availabilities / Remove from Sales button click) exactly once with the
 * correct terminal status. `tracking.status` defaults to FAILED and is
 * only overwritten to the real terminal value right before the success
 * return; every early return sets `tracking.errorMessage` to its specific
 * reason. Mirrors Google bulk-status's `bulk-activate`/`bulk-deactivate`
 * route try/finally pattern exactly — confirmed structurally identical
 * (single round-trip, no mid-flight pause) before reusing it. The feature
 * tag is derived server-side from the validated `action`, never trusted
 * from the client, so a malformed/spoofed tag can't reach the Hub's
 * Railway log lines for this route's own finalize call.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  executeBulkAvailability,
  type BulkAvailabilityOutcome,
} from "@/lib/iap-management/orchestrators/bulk-availability";
import {
  finalizeHubTracking,
  type HubTerminalStatus,
} from "@/lib/iap-management/hub-tracking/tracking";
import { computeBulkImportTerminalStatus } from "@/lib/iap-management/hub-tracking/status-mapping";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

const BodySchema = z.object({
  iapIds: z.array(z.string().min(1)).min(1).max(500),
  action: z.enum(["set-all", "remove"]),
  /** Threaded from the modal's button-click Hub-tracking start call.
   *  Absent/empty means tracking never started (unconfigured/disabled,
   *  or the client's race cap expired before /start resolved) — a no-op. */
  hub_run_id: z.string().nullish(),
});

const FEATURE_BY_ACTION: Record<"set-all" | "remove", string> = {
  "set-all": "iap-set-availabilities",
  remove: "iap-remove-from-sales",
};

/** Threaded by reference so the outer `finally` always closes the run
 *  correctly, even on an unforeseen exception (R1 finalize-in-finally). */
interface HubTrackingState {
  runId: string | null;
  status: HubTerminalStatus;
  errorMessage?: string;
}

export async function POST(req: Request) {
  const tracking: HubTrackingState = { runId: null, status: "FAILED" };
  // Placeholder until the body parses and the real per-mode tag is known
  // (a session/body failure can't know `action` yet — this default only
  // ever labels a Railway log line for a run that's already null/no-op).
  let feature = "iap-hub-tracking";

  try {
    let session;
    try {
      session = await requireIapSession();
    } catch (err) {
      if (err instanceof IapUnauthorizedError) {
        tracking.errorMessage = err.message;
        return NextResponse.json({ error: err.message }, { status: 401 });
      }
      throw err;
    }
    const actor = session.user.email ?? "unknown";

    let body: z.infer<typeof BodySchema>;
    try {
      const json = await req.json();
      body = BodySchema.parse(json);
    } catch (err) {
      const message = `Invalid body: ${err instanceof Error ? err.message : err}`;
      tracking.errorMessage = message;
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // Parsed as early as the body's validity is known — a run started
    // client-side must still close correctly even if nothing downstream
    // succeeds. Tag derived from the validated `action`, not client-sent.
    feature = FEATURE_BY_ACTION[body.action];
    tracking.runId =
      body.hub_run_id && body.hub_run_id.length > 0 ? body.hub_run_id : null;

    let creds;
    try {
      creds = await getActiveAccount();
    } catch (err) {
      await log(
        "bulk-availability",
        `getActiveAccount failed: ${err instanceof Error ? err.message : err}`,
        "ERROR",
      );
      tracking.errorMessage = "Apple credentials unavailable";
      return NextResponse.json(
        { error: "Apple credentials unavailable" },
        { status: 500 },
      );
    }

    const outcome: BulkAvailabilityOutcome = await executeBulkAvailability({
      creds,
      iapIds: body.iapIds,
      action: body.action,
      actor,
    });

    // Terminal status from the SAME per-IAP outcome the modal renders
    // (status principle) — reused as-is, zero logic changes.
    const terminal = computeBulkImportTerminalStatus({
      total: outcome.total,
      succeeded: outcome.succeeded,
      failed: outcome.failed,
    });
    tracking.status = terminal.status;
    tracking.errorMessage = terminal.errorMessage;

    return NextResponse.json(outcome);
  } finally {
    await finalizeHubTracking(
      tracking.runId,
      tracking.status,
      tracking.errorMessage,
      feature,
    );
  }
}
