/**
 * POST /api/asc/hub-tracking/start
 *
 * Called by CppBulkImportDialog on the "validating"→"preview" transition
 * (the folder has finished loading into the tool, before any Apple write).
 * Opens a VNGGames Hub run for this batch and returns its RUN_ID for the
 * dialog to hold in client state (threaded to /finalize for the terminal
 * close, and to /cancel for an explicit back-out).
 *
 * Non-blocking by construction: unconfigured/disabled tracking, or any Hub
 * failure, both resolve to `{ run_id: null }` — the dialog proceeds
 * identically either way.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { startBulkImportTracking } from "@/lib/cpp-hub-tracking/tracking";

export const runtime = "nodejs";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runId = await startBulkImportTracking(session.user.email);
  return NextResponse.json({ run_id: runId });
}
