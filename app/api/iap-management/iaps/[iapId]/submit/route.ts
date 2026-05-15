import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import {
  getIapWithRelations,
  logSubmitAttempt,
} from "@/lib/iap-management/queries/iaps";
import { iapDb } from "@/lib/iap-management/db";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  createInAppPurchase,
  createInAppPurchaseLocalization,
  submitInAppPurchase,
} from "@/lib/iap-management/apple/client";
import {
  withRetry,
  AppleApiError,
} from "@/lib/iap-management/apple/fetch";
import { log } from "@/lib/logger";
import type { InAppPurchaseType } from "@/types/iap-management/apple";

export const runtime = "nodejs";

/**
 * POST /api/iap-management/iaps/[iapId]/submit
 *
 * Orchestrates the full Apple submit flow for a local-draft IAP:
 *   1. POST /v2/inAppPurchases — create shell, capture apple_iap_id.
 *   2. POST /v1/inAppPurchaseLocalizations — one per filled locale.
 *   3. POST /v1/inAppPurchaseSubmissions — push for Apple Review.
 *   4. Mirror updated state back to iap_mgmt.iaps.
 *
 * Each Apple call is wrapped in withRetry (429-aware). On any failure,
 * remaining steps are skipped and the partial state is preserved so the
 * caller can re-submit and pick up where they left off.
 *
 * NOTE: Screenshot 3-step + pricing schedule are out-of-scope for IAP.h v1
 * (Manager review pending — see IAP.h surface report). The API returns 200
 * with `partial: true` when those steps are skipped.
 */
export async function POST(
  _req: Request,
  ctx: { params: { iapId: string } },
) {
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

  // 1. Load the IAP + relations
  const data = await getIapWithRelations(ctx.params.iapId);
  if (!data) {
    return NextResponse.json({ error: "IAP not found" }, { status: 404 });
  }
  if (data.iap.apple_iap_id) {
    // Already on Apple — treat as re-submit. (For v1, just attempt step 3.)
    return await reSubmitOnly(ctx.params.iapId, data.iap.apple_iap_id, actor);
  }

  const creds = await getActiveAccount();
  const db = iapDb();
  let appleIapId: string | null = null;

  // Resolve Apple's numeric app id from our internal UUID — Apple's create
  // endpoint expects the App Store app id, not our iap_mgmt.apps PK.
  const appRow = await db
    .from("apps")
    .select("apple_app_id")
    .eq("id", data.iap.app_id)
    .maybeSingle();
  if (appRow.error || !appRow.data) {
    return NextResponse.json(
      { error: "Could not resolve Apple App ID for this draft." },
      { status: 500 },
    );
  }
  const appleAppId = (appRow.data as { apple_app_id: string }).apple_app_id;

  // 2. Create shell on Apple
  try {
    const created = await withRetry(() =>
      createInAppPurchase(creds, {
        appId: appleAppId,
        name: data.iap.reference_name,
        productId: data.iap.product_id,
        inAppPurchaseType: data.iap.type as InAppPurchaseType,
        ...(data.iap.review_note ? { reviewNote: data.iap.review_note } : {}),
        familySharable: data.iap.family_sharable,
      }),
    );
    appleIapId = created.data.id;
    await db
      .from("iaps")
      .update({
        apple_iap_id: appleIapId,
        synced_at: new Date().toISOString(),
      })
      .eq("id", ctx.params.iapId);
  } catch (err) {
    return await failWithLog(
      ctx.params.iapId,
      actor,
      "create",
      err,
    );
  }

  // 3. Upload localizations
  const failedLocales: string[] = [];
  for (const loc of data.localizations) {
    try {
      await withRetry(() =>
        createInAppPurchaseLocalization(creds, {
          iapId: appleIapId!,
          locale: loc.locale,
          name: loc.display_name,
          description: loc.description,
        }),
      );
    } catch (err) {
      failedLocales.push(loc.locale);
      await log(
        "iap-submit",
        `locale fail ${loc.locale} on iap=${ctx.params.iapId}: ${
          err instanceof Error ? err.message : err
        }`,
        "WARN",
      );
    }
  }

  // 4. Submit for review
  try {
    await withRetry(() => submitInAppPurchase(creds, appleIapId!));
    await db
      .from("iaps")
      .update({
        state: "WAITING_FOR_REVIEW",
        synced_at: new Date().toISOString(),
      })
      .eq("id", ctx.params.iapId);
    await logSubmitAttempt(ctx.params.iapId, actor, "SUCCESS", {
      apple_iap_id: appleIapId,
      failed_locales: failedLocales,
    });
    return NextResponse.json({
      ok: true,
      apple_iap_id: appleIapId,
      failed_locales: failedLocales,
      partial: failedLocales.length > 0,
    });
  } catch (err) {
    return await failWithLog(ctx.params.iapId, actor, "submission", err, {
      apple_iap_id: appleIapId,
      failed_locales: failedLocales,
    });
  }
}

async function reSubmitOnly(
  iapId: string,
  appleIapId: string,
  actor: string,
): Promise<NextResponse> {
  const creds = await getActiveAccount();
  try {
    await withRetry(() => submitInAppPurchase(creds, appleIapId));
    const db = iapDb();
    await db
      .from("iaps")
      .update({
        state: "WAITING_FOR_REVIEW",
        synced_at: new Date().toISOString(),
      })
      .eq("id", iapId);
    await logSubmitAttempt(iapId, actor, "SUCCESS", { apple_iap_id: appleIapId });
    return NextResponse.json({ ok: true, apple_iap_id: appleIapId });
  } catch (err) {
    return await failWithLog(iapId, actor, "resubmit", err, {
      apple_iap_id: appleIapId,
    });
  }
}

async function failWithLog(
  iapId: string,
  actor: string,
  stage: string,
  err: unknown,
  extra: Record<string, unknown> = {},
): Promise<NextResponse> {
  const status =
    err instanceof AppleApiError ? err.status : 500;
  const message =
    err instanceof Error ? err.message : "Apple submission failed";
  await log("iap-submit", `stage=${stage} iap=${iapId}: ${message}`, "ERROR");
  await logSubmitAttempt(iapId, actor, "ERROR", {
    stage,
    apple_status: err instanceof AppleApiError ? err.status : null,
    apple_body: err instanceof AppleApiError ? err.body : null,
    message,
    ...extra,
  });
  return NextResponse.json(
    { error: friendlyError(stage, status, message) },
    { status: status >= 400 && status < 500 ? status : 502 },
  );
}

function friendlyError(stage: string, status: number, raw: string): string {
  if (status === 401) return "Apple credentials are invalid. Check Settings → ASC Accounts.";
  if (status === 403) return "Apple rejected the request (403 Forbidden). Verify the account has IAP write access.";
  if (status === 409) return `Apple reports a conflict (409) during ${stage}. The IAP may already exist with this productId.`;
  if (status === 422) return `Apple validation failed during ${stage}: ${raw}`;
  if (status === 429) return "Apple rate limit reached. Wait a minute and try again.";
  return `Apple submission failed at the ${stage} step: ${raw}`;
}
