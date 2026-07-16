/**
 * POST /api/google-iap-management/hub-tracking/start
 *
 * Called by the Bulk Import wizard when handleUploadAndPreview() succeeds
 * (the upload→preview transition — the moment the user has finished
 * uploading data). Opens a VNGGames Hub run for this batch and returns its
 * RUN_ID for the wizard to hold in client state (threaded to /execute for
 * the terminal close, and to /cancel for an explicit back-out).
 *
 * Non-blocking by construction: unconfigured/disabled tracking, or any Hub
 * failure, both resolve to `{ run_id: null }` — the wizard proceeds
 * identically either way.
 */

import { NextResponse } from "next/server";
import {
  requireGoogleIapSession,
  GoogleIapUnauthorizedError,
} from "@/lib/google-iap-management/auth";
import { startBulkImportTracking } from "@/lib/google-iap-management/hub-tracking/tracking";

export const runtime = "nodejs";

export async function POST() {
  let session;
  try {
    session = await requireGoogleIapSession();
  } catch (err) {
    if (err instanceof GoogleIapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const runId = await startBulkImportTracking(session.user.email);
  return NextResponse.json({ run_id: runId });
}
