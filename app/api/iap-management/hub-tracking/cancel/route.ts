/**
 * POST /api/iap-management/hub-tracking/cancel
 *
 * Closes an in-flight Hub run as CANCELLED. Shared by every Apple IAP
 * feature that tracks a run: Bulk Import (an explicit back-out, or a
 * `beforeunload` beacon) and Set Availabilities / Remove from Sales
 * (declining the reconfirm dialog, closing the modal before the write
 * commits, or the same `beforeunload` beacon). Called two ways: (a) an
 * explicit back-out, via a normal fetch with a JSON body; (b) a
 * best-effort `navigator.sendBeacon` on `beforeunload` — sendBeacon can't
 * set a custom Authorization header, so the token stays server-side and
 * the beacon just carries `{ run_id }` same-origin (session cookie rides
 * along automatically). Not relied on for hard crashes/force-quit — see
 * the orphaned-run limitation in the design doc.
 *
 * Body is parsed leniently (plain text → JSON.parse) since a sendBeacon
 * Blob's content-type isn't guaranteed to match what a manual fetch sends.
 *
 * An optional `feature` field selects the Railway log tag, same
 * convention as /hub-tracking/start; omitted defaults to Bulk Import's
 * existing tag.
 */

import { NextResponse } from "next/server";
import { requireIapSession, IapUnauthorizedError } from "@/lib/iap-management/auth";
import { finalizeHubTracking } from "@/lib/iap-management/hub-tracking/tracking";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const text = await req.text().catch(() => "");
  let runId: string | null = null;
  let feature: string | undefined;
  try {
    const body = JSON.parse(text) as { run_id?: unknown; feature?: unknown };
    if (typeof body.run_id === "string" && body.run_id.length > 0) {
      runId = body.run_id;
    }
    if (typeof body.feature === "string" && body.feature.length > 0) {
      feature = body.feature;
    }
  } catch {
    // Malformed/empty body — no-op below via finalizeHubTracking(null, ...).
  }

  await finalizeHubTracking(runId, "CANCELLED", undefined, feature);
  return NextResponse.json({ ok: true });
}
