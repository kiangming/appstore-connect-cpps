/**
 * POST /api/iap-management/apps/[appId]/iaps/[iapId]/submit
 *
 * IAP.o.6a — Manager-locked two-stage Apple workflow, stage 2.
 *
 * Submit-only: assumes the IAP already exists on Apple (apple_iap_id populated).
 * Refactored from the previous combined CREATE+LOCALIZE+SUBMIT route — see
 * /create-on-apple for stage 1.
 *
 * Steps:
 *   1. Verify iap_mgmt.iaps row has apple_iap_id (else 409).
 *   2. Pre-check: GET /v2/inAppPurchases/{id} to confirm Apple state is
 *      READY_TO_SUBMIT, unless ?skipCheck=true (caller already pre-flighted —
 *      used by submit-batch).
 *   3. POST /v1/inAppPurchaseSubmissions.
 *   4. GET fresh state, mirror to iap_mgmt.iaps.
 *   5. Audit log action_type='SUBMIT_APPLE_REVIEW'.
 *
 * Query params:
 *   • skipCheck=true  — skip step 2 (caller did batch pre-flight).
 */

import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { iapDb } from "@/lib/iap-management/db";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  getInAppPurchase,
  submitInAppPurchase,
} from "@/lib/iap-management/apple/client";
import {
  withRetry,
  AppleApiError,
} from "@/lib/iap-management/apple/fetch";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: { appId: string; iapId: string } },
) {
  // 1. Auth
  let session;
  try {
    session = await requireIapAdmin();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof IapForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
  const actor = session.user.email ?? "unknown";
  const { iapId } = ctx.params;

  const url = new URL(req.url);
  const skipCheck = url.searchParams.get("skipCheck") === "true";

  // 2. Verify IAP exists + is on Apple
  const db = iapDb();
  const row = await db
    .from("iaps")
    .select("id, apple_iap_id, state")
    .eq("id", iapId)
    .maybeSingle();
  if (row.error) {
    return NextResponse.json(
      { error: `IAP lookup failed: ${row.error.message}` },
      { status: 500 },
    );
  }
  if (!row.data) {
    return NextResponse.json({ error: "IAP not found" }, { status: 404 });
  }
  const iap = row.data as {
    id: string;
    apple_iap_id: string | null;
    state: string;
  };
  if (!iap.apple_iap_id) {
    return NextResponse.json(
      {
        error:
          "IAP is not yet on Apple. Use Create on Apple before submitting for review.",
      },
      { status: 409 },
    );
  }

  const creds = await getActiveAccount();

  // 3. Pre-check Apple state (unless caller skipped)
  if (!skipCheck) {
    try {
      const fresh = await withRetry(() =>
        getInAppPurchase(creds, iap.apple_iap_id!),
      );
      const appleState = fresh.data.attributes.state ?? "UNKNOWN";
      if (appleState !== "READY_TO_SUBMIT") {
        await db
          .from("iaps")
          .update({ state: appleState, synced_at: new Date().toISOString() })
          .eq("id", iapId);
        return NextResponse.json(
          {
            error: `Apple reports state="${appleState}"; only READY_TO_SUBMIT can be submitted. Fix the missing metadata and try again.`,
            state: appleState,
          },
          { status: 409 },
        );
      }
    } catch (err) {
      return await failWithLog(iapId, actor, "pre-check", err);
    }
  }

  // 4. Submit
  try {
    await withRetry(() => submitInAppPurchase(creds, iap.apple_iap_id!));
  } catch (err) {
    return await failWithLog(iapId, actor, "submission", err);
  }

  // 5. Fetch authoritative post-submit state (Apple flips to WAITING_FOR_REVIEW).
  let finalState = "WAITING_FOR_REVIEW";
  try {
    const fresh = await withRetry(() =>
      getInAppPurchase(creds, iap.apple_iap_id!),
    );
    finalState = fresh.data.attributes.state ?? finalState;
  } catch (err) {
    await log(
      "iap-submit",
      `post-submit state fetch failed iap=${iapId}: ${errMsg(err)}`,
      "WARN",
    );
  }

  await db
    .from("iaps")
    .update({ state: finalState, synced_at: new Date().toISOString() })
    .eq("id", iapId);

  await db.from("actions_log").insert({
    iap_id: iapId,
    actor,
    action_type: "SUBMIT_APPLE_REVIEW",
    payload: {
      apple_iap_id: iap.apple_iap_id,
      result: "SUCCESS",
      state: finalState,
      skip_check: skipCheck,
    },
  });

  return NextResponse.json({
    ok: true,
    apple_iap_id: iap.apple_iap_id,
    state: finalState,
  });
}

async function failWithLog(
  iapId: string,
  actor: string,
  stage: string,
  err: unknown,
): Promise<NextResponse> {
  const status = err instanceof AppleApiError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Apple submit failed";
  await log("iap-submit", `stage=${stage} iap=${iapId}: ${message}`, "ERROR");
  const db = iapDb();
  await db.from("actions_log").insert({
    iap_id: iapId,
    actor,
    action_type: "SUBMIT_APPLE_REVIEW",
    payload: {
      result: "ERROR",
      stage,
      apple_status: err instanceof AppleApiError ? err.status : null,
      message,
    },
  });
  return NextResponse.json(
    { error: friendlyError(stage, status, message) },
    { status: status >= 400 && status < 500 ? status : 502 },
  );
}

function friendlyError(stage: string, status: number, raw: string): string {
  if (status === 401) return "Apple credentials are invalid. Check Settings → ASC Accounts.";
  if (status === 403)
    return "Apple rejected the request (403 Forbidden). Verify the account has IAP write access.";
  if (status === 409)
    return `Apple reports a conflict (409) during ${stage}.`;
  if (status === 422) return `Apple validation failed during ${stage}: ${raw}`;
  if (status === 429) return "Apple rate limit reached. Wait a minute and try again.";
  return `Apple submit failed at the ${stage} step: ${raw}`;
}

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
