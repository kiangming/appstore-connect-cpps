/**
 * POST /api/google-iap-management/hub-tracking/cancel
 *
 * Closes an in-flight Hub run as CANCELLED. Called two ways from the
 * wizard: (a) an explicit back-out (leaving the wizard before the import
 * runs), via a normal fetch with a JSON body; (b) a best-effort
 * `navigator.sendBeacon` on `beforeunload` — sendBeacon can't set a
 * custom Authorization header, so the token stays server-side and the
 * beacon just carries `{ run_id }` same-origin (session cookie rides
 * along automatically). Not relied on for hard crashes/force-quit.
 *
 * Body is parsed leniently (plain text → JSON.parse) since a sendBeacon
 * Blob's content-type isn't guaranteed to match what a manual fetch sends.
 */

import { NextResponse } from "next/server";
import {
  requireGoogleIapSession,
  GoogleIapUnauthorizedError,
} from "@/lib/google-iap-management/auth";
import { finalizeHubTracking } from "@/lib/google-iap-management/hub-tracking/tracking";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    await requireGoogleIapSession();
  } catch (err) {
    if (err instanceof GoogleIapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
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
