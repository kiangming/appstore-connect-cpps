/**
 * POST /api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple
 *
 * IAP.o.6a — Manager-locked two-stage Apple workflow, stage 1.
 *
 * Pushes a local-only draft IAP up to Apple Connect:
 *   1. POST /v2/inAppPurchases  — create shell, capture apple_iap_id.
 *   2. POST /v1/inAppPurchaseLocalizations — one per filled locale.
 *   3. (optional) Screenshot 3-step via lib/iap-management/apple/screenshot-upload.
 *   4. GET /v2/inAppPurchases/{id} — fetch authoritative state.
 *   5. Mirror apple_iap_id + state + synced_at into iap_mgmt.iaps.
 *
 * Screenshot deliberately optional — Apple will return MISSING_METADATA when
 * absent and the Manager fixes it later via the IAP detail page. Submit for
 * Review is a separate action (list-page multi-select flow).
 *
 * Body shape: multipart/form-data
 *   • form        — JSON string of IapFormState (canonical state to persist).
 *   • screenshot  — File (optional, PNG/JPEG ≤ 8 MB).
 */

import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import {
  getIapWithRelations,
  replaceLocalizations,
} from "@/lib/iap-management/queries/iaps";
import { iapDb } from "@/lib/iap-management/db";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  createInAppPurchase,
  createInAppPurchaseLocalization,
  getInAppPurchase,
} from "@/lib/iap-management/apple/client";
import {
  withRetry,
  AppleApiError,
} from "@/lib/iap-management/apple/fetch";
import { uploadScreenshotToApple } from "@/lib/iap-management/apple/screenshot-upload";
import {
  validateIapFormForCreate,
  type IapFormState,
} from "@/lib/iap-management/validation";
import { log } from "@/lib/logger";
import type { InAppPurchaseType } from "@/types/iap-management/apple";

export const runtime = "nodejs";

const MAX_SCREENSHOT_SIZE = 8 * 1024 * 1024;
const ALLOWED_SCREENSHOT_TYPES = new Set(["image/png", "image/jpeg", "image/jpg"]);

interface SuccessResponse {
  ok: true;
  apple_iap_id: string;
  state: string;
  failed_locales: string[];
  screenshot_uploaded: boolean;
  screenshot_error?: string;
}

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
  const { appId: appleAppId, iapId } = ctx.params;

  // 2. Parse multipart FormData
  let form: IapFormState;
  let screenshot: File | null = null;
  try {
    const data = await req.formData();
    const formField = data.get("form");
    if (typeof formField !== "string") {
      return NextResponse.json(
        { error: 'Missing "form" field (JSON string).' },
        { status: 400 },
      );
    }
    form = JSON.parse(formField) as IapFormState;
    const fileField = data.get("screenshot");
    if (fileField instanceof File && fileField.size > 0) {
      screenshot = fileField;
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid form body: ${err instanceof Error ? err.message : err}` },
      { status: 400 },
    );
  }

  // 3. Validate Group A (5 items)
  const checklist = validateIapFormForCreate(form);
  if (!checklist.allPassed) {
    const missing = checklist.items.filter((i) => !i.passed).map((i) => i.key);
    return NextResponse.json(
      { error: `Missing create-stage prerequisites: ${missing.join(", ")}` },
      { status: 422 },
    );
  }

  // 4. Validate screenshot (if provided)
  if (screenshot) {
    if (screenshot.size > MAX_SCREENSHOT_SIZE) {
      return NextResponse.json(
        { error: `Screenshot exceeds 8MB limit (${(screenshot.size / 1024 / 1024).toFixed(1)}MB).` },
        { status: 422 },
      );
    }
    if (!ALLOWED_SCREENSHOT_TYPES.has(screenshot.type)) {
      return NextResponse.json(
        { error: `Unsupported screenshot type "${screenshot.type}". PNG or JPEG required.` },
        { status: 422 },
      );
    }
  }

  // 5. Load IAP — must exist and not already be on Apple
  const existing = await getIapWithRelations(iapId);
  if (!existing) {
    return NextResponse.json({ error: "IAP not found" }, { status: 404 });
  }
  if (existing.iap.apple_iap_id) {
    return NextResponse.json(
      {
        error:
          "IAP is already on Apple. Use the IAP list page to submit for review, or the edit form to update local fields.",
      },
      { status: 409 },
    );
  }

  // 6. Persist form to DB (auto-save the in-flight form state before pushing).
  const db = iapDb();
  const updateRes = await db
    .from("iaps")
    .update({
      reference_name: form.reference_name.trim(),
      type: (form.type || "CONSUMABLE") as InAppPurchaseType,
      tier_id: form.tier_id,
    })
    .eq("id", iapId);
  if (updateRes.error) {
    return NextResponse.json(
      { error: `iaps pre-update failed: ${updateRes.error.message}` },
      { status: 500 },
    );
  }
  try {
    await replaceLocalizations(iapId, Object.values(form.localizations));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "localizations save failed" },
      { status: 500 },
    );
  }

  // 7. Apple creds
  const creds = await getActiveAccount();

  // 8. CREATE shell on Apple
  let appleIapId: string;
  try {
    const created = await withRetry(() =>
      createInAppPurchase(creds, {
        appId: appleAppId,
        name: form.reference_name.trim(),
        productId: form.product_id.trim(),
        inAppPurchaseType: (form.type || "CONSUMABLE") as InAppPurchaseType,
        ...(existing.iap.review_note ? { reviewNote: existing.iap.review_note } : {}),
        familySharable: existing.iap.family_sharable,
      }),
    );
    appleIapId = created.data.id;
  } catch (err) {
    return await failWithLog(iapId, actor, "apple-create", err);
  }

  // Persist apple_iap_id + synced_at immediately so partial failures downstream
  // don't lose the link (Apple-side IAP exists; subsequent steps are recoverable).
  await db
    .from("iaps")
    .update({
      apple_iap_id: appleIapId,
      synced_at: new Date().toISOString(),
    })
    .eq("id", iapId);

  // 9. LOCALIZE — one POST per filled locale
  const failedLocales: string[] = [];
  const filledLocales = Object.values(form.localizations).filter(
    (l) => l.display_name.trim() && l.description.trim(),
  );
  for (const loc of filledLocales) {
    try {
      await withRetry(() =>
        createInAppPurchaseLocalization(creds, {
          iapId: appleIapId,
          locale: loc.locale,
          name: loc.display_name.trim(),
          description: loc.description.trim(),
        }),
      );
    } catch (err) {
      failedLocales.push(loc.locale);
      await log(
        "iap-create-on-apple",
        `locale fail ${loc.locale} iap=${iapId}: ${errMsg(err)}`,
        "WARN",
      );
    }
  }

  // 10. OPTIONAL screenshot 3-step
  let screenshotUploaded = false;
  let screenshotError: string | undefined;
  if (screenshot) {
    const result = await uploadScreenshotToApple(creds, appleIapId, screenshot);
    if (result.ok) {
      screenshotUploaded = true;
      // Insert/replace iap_screenshots row.
      await db
        .from("iap_screenshots")
        .delete()
        .eq("iap_id", iapId);
      await db.from("iap_screenshots").insert({
        iap_id: iapId,
        apple_id: result.apple_screenshot_id,
        file_name: result.file_name,
        file_size: result.file_size,
        uploaded_at: new Date().toISOString(),
      });
    } else {
      screenshotError = `[${result.stage}] ${result.error}`;
      await log(
        "iap-create-on-apple",
        `screenshot fail iap=${iapId}: ${screenshotError}`,
        "WARN",
      );
    }
  }

  // 11. GET authoritative Apple state
  let finalState = "MISSING_METADATA";
  try {
    const fresh = await withRetry(() => getInAppPurchase(creds, appleIapId));
    finalState = fresh.data.attributes.state ?? "MISSING_METADATA";
  } catch (err) {
    await log(
      "iap-create-on-apple",
      `final state fetch failed iap=${iapId}: ${errMsg(err)}`,
      "WARN",
    );
  }

  await db
    .from("iaps")
    .update({
      state: finalState,
      synced_at: new Date().toISOString(),
    })
    .eq("id", iapId);

  // 12. Audit log
  await db.from("actions_log").insert({
    iap_id: iapId,
    actor,
    action_type: "CREATE_ON_APPLE",
    payload: {
      apple_iap_id: appleIapId,
      product_id: form.product_id.trim(),
      state: finalState,
      failed_locales: failedLocales,
      screenshot_uploaded: screenshotUploaded,
      screenshot_error: screenshotError ?? null,
    },
  });

  const response: SuccessResponse = {
    ok: true,
    apple_iap_id: appleIapId,
    state: finalState,
    failed_locales: failedLocales,
    screenshot_uploaded: screenshotUploaded,
    ...(screenshotError ? { screenshot_error: screenshotError } : {}),
  };
  return NextResponse.json(response);
}

async function failWithLog(
  iapId: string,
  actor: string,
  stage: string,
  err: unknown,
): Promise<NextResponse> {
  const status = err instanceof AppleApiError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Apple create failed";
  await log("iap-create-on-apple", `stage=${stage} iap=${iapId}: ${message}`, "ERROR");
  const db = iapDb();
  await db.from("actions_log").insert({
    iap_id: iapId,
    actor,
    action_type: "CREATE_ON_APPLE",
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
    return `Apple reports a conflict (409) during ${stage}. The Product ID may already exist on Apple.`;
  if (status === 422) return `Apple validation failed during ${stage}: ${raw}`;
  if (status === 429) return "Apple rate limit reached. Wait a minute and try again.";
  return `Apple create failed at the ${stage} step: ${raw}`;
}

function errMsg(err: unknown): string {
  if (err instanceof AppleApiError) {
    return `${err.status}: ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
