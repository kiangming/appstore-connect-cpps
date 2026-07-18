/**
 * POST /api/asc/hub-tracking/cancel
 *
 * Closes an in-flight Hub run as CANCELLED. Called three ways from
 * CppBulkImportDialog: (a) an explicit back-out (closing the dialog before
 * "Import All" is clicked), via a normal fetch with a JSON body; (b) a
 * best-effort `navigator.sendBeacon` on `beforeunload` — sendBeacon can't
 * set a custom Authorization header, so the token stays server-side and
 * the beacon just carries `{ run_id }` same-origin (session cookie rides
 * along automatically); (c) a best-effort close of a late-arriving orphan
 * run_id that resolved after upload had already started (race hardening,
 * design §1.8/§2.D). Not relied on for hard crashes/force-quit — see the
 * orphaned-run limitation in the design doc.
 *
 * Body is parsed leniently (plain text → JSON.parse) since a sendBeacon
 * Blob's content-type isn't guaranteed to match what a manual fetch sends.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { finalizeHubTracking } from "@/lib/cpp-hub-tracking/tracking";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const text = await req.text().catch(() => "");
  let runId: string | null = null;
  try {
    const body = JSON.parse(text) as { run_id?: unknown };
    if (typeof body.run_id === "string" && body.run_id.length > 0) {
      runId = body.run_id;
    }
  } catch {
    // Malformed/empty body — no-op below via finalizeHubTracking(null, ...).
  }

  await finalizeHubTracking(runId, "CANCELLED");
  return NextResponse.json({ ok: true });
}
