/**
 * GET/POST /api/iap-management/hub-tracking/config
 *
 * Settings-tier surface for the VNGGames Hub tracking integration —
 * admin-only (mirrors pricing-tiers). GET never returns the token, only
 * `{ workflow_id, configured, enabled, updated_at }`. POST saves
 * `{ workflow_id, token?, enabled }`: an omitted/blank token keeps the
 * existing encrypted value, a non-blank token overwrites it.
 *
 * Save-time credential validation (non-fatal): fires a throwaway Hub
 * start+cancel against the entered creds to surface a bad/unregistered
 * workflow_id (422) or bad token (401) immediately. A rejection is a
 * WARNING surfaced in the response — the save still proceeds. A
 * network/timeout failure during validation never blocks the save either;
 * it's reported as "couldn't verify" instead of "rejected".
 */

import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import {
  getHubTrackingConfigPublic,
  saveHubTrackingConfig,
  resolveTokenForValidation,
} from "@/lib/iap-management/hub-tracking/config";
import { hubValidateCredentials } from "@/lib/iap-management/hub-tracking/hub-client";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

function authErrorResponse(err: unknown): NextResponse {
  if (err instanceof IapUnauthorizedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }
  if (err instanceof IapForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  throw err;
}

export async function GET() {
  try {
    await requireIapAdmin();
  } catch (err) {
    return authErrorResponse(err);
  }
  const config = await getHubTrackingConfigPublic();
  return NextResponse.json(config);
}

export async function POST(req: Request) {
  let session;
  try {
    session = await requireIapAdmin();
  } catch (err) {
    return authErrorResponse(err);
  }

  let body: { workflow_id?: unknown; token?: unknown; enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const workflowId = typeof body.workflow_id === "string" ? body.workflow_id.trim() : "";
  const token =
    typeof body.token === "string" && body.token.length > 0 ? body.token : undefined;
  const enabled = Boolean(body.enabled);

  if (!workflowId) {
    return NextResponse.json({ error: "workflow_id is required" }, { status: 400 });
  }

  // Save-time credential validation — a WARNING, never a save-blocker.
  let validation: { ok: boolean; reason?: "rejected" | "network-error"; detail?: string } = {
    ok: true,
  };
  try {
    const tokenForValidation = await resolveTokenForValidation({ token });
    if (tokenForValidation) {
      const result = await hubValidateCredentials({ workflowId, token: tokenForValidation });
      validation = result.ok
        ? { ok: true }
        : { ok: false, reason: result.reason, detail: result.detail };
    }
  } catch (err) {
    await log(
      "iap-hub-tracking",
      `save-time validation errored (non-fatal): ${err instanceof Error ? err.message : err}`,
      "WARN",
    );
    validation = { ok: false, reason: "network-error" };
  }

  try {
    await saveHubTrackingConfig({
      workflowId,
      token,
      enabled,
      updatedBy: session.user.email ?? "unknown",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save config" },
      { status: 400 },
    );
  }

  const config = await getHubTrackingConfigPublic();
  return NextResponse.json({ ...config, validation });
}
