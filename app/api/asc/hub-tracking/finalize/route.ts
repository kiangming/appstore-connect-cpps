/**
 * POST /api/asc/hub-tracking/finalize
 *
 * Closes a Hub run with the batch's terminal status (SUCCESS/PARTIAL/
 * FAILED). No precedent integration has this route — IAP/Google Bulk
 * Import close their run inside the execute route's own request-scoped
 * `finally`, because their whole upload is one server request. CPP's
 * asset-upload flow is client-orchestrated (Promise.all over many
 * per-file /api/asc/upload calls, no batch-level server route) — so
 * CppBulkImportDialog computes the terminal status itself from its
 * existing per-CPP progress state once the upload phase settles (or
 * throws — R1 finalize-in-finally, docs/cpp-management/
 * design-cpp-hub-tracking.md §2.A) and POSTs it here. This route is a
 * slim proxy: it validates the status enum and relays to Hub. Token stays
 * server-side, never reaches the browser.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { finalizeHubTracking } from "@/lib/cpp-hub-tracking/tracking";
import type { HubTerminalStatus } from "@/lib/cpp-hub-tracking/hub-client";

export const runtime = "nodejs";

const VALID_STATUSES: HubTerminalStatus[] = ["SUCCESS", "FAILED", "CANCELLED", "PARTIAL"];

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { run_id?: unknown; status?: unknown; error_message?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const runId = typeof body.run_id === "string" && body.run_id.length > 0 ? body.run_id : null;
  const status = body.status;
  if (typeof status !== "string" || !VALID_STATUSES.includes(status as HubTerminalStatus)) {
    return NextResponse.json(
      { error: `status must be one of ${VALID_STATUSES.join("/")}` },
      { status: 400 },
    );
  }
  const errorMessage = typeof body.error_message === "string" ? body.error_message : undefined;

  await finalizeHubTracking(runId, status as HubTerminalStatus, errorMessage);
  return NextResponse.json({ ok: true });
}
