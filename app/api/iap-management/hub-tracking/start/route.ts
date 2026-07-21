/**
 * POST /api/iap-management/hub-tracking/start
 *
 * Shared by every Apple IAP feature that tracks a run on the VNGGames Hub
 * client-side: Bulk Import (the step 1→2 "Next" click) and Set
 * Availabilities / Remove from Sales (the button click, before selection
 * is submitted). Opens a Hub run and returns its RUN_ID for the caller to
 * hold in client state (threaded to the write route for the terminal
 * close, and to /cancel for an explicit back-out).
 *
 * An optional `feature` JSON body field selects the Railway log tag —
 * e.g. `"iap-set-availabilities"` / `"iap-remove-from-sales"`. Omitted
 * (Bulk Import's existing caller sends no body at all) defaults to
 * `"iap-hub-tracking"`, so Bulk Import's behavior is unchanged.
 *
 * Non-blocking by construction: unconfigured/disabled tracking, or any Hub
 * failure, both resolve to `{ run_id: null }` — the caller proceeds
 * identically either way.
 */

import { NextResponse } from "next/server";
import { requireIapSession, IapUnauthorizedError } from "@/lib/iap-management/auth";
import { startBulkImportTracking } from "@/lib/iap-management/hub-tracking/tracking";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let session;
  try {
    session = await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  // Bulk Import sends no body at all — `.json()` on an empty body throws,
  // caught here so `feature` stays undefined (the tracking module's own
  // default) rather than the request failing.
  let feature: string | undefined;
  try {
    const body = (await req.json()) as { feature?: unknown };
    if (typeof body.feature === "string" && body.feature.length > 0) {
      feature = body.feature;
    }
  } catch {
    // No/invalid body — feature stays undefined.
  }

  const runId = await startBulkImportTracking(session.user.email, feature);
  return NextResponse.json({ run_id: runId });
}
