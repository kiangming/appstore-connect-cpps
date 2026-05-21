import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getApp } from "@/lib/asc-client";
import { getActiveAccount } from "@/lib/get-active-account";
import {
  ensureAppRegistered,
  createDraftIap,
} from "@/lib/iap-management/queries/iaps";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

const FormSchema = z.object({
  reference_name: z.string().min(1).max(64),
  product_id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  type: z.enum(["CONSUMABLE", "NON_CONSUMABLE", "NON_RENEWING_SUBSCRIPTION"]),
  tier_id: z.string().nullable(),
  localizations: z.record(
    z.string(),
    z.object({
      locale: z.string(),
      display_name: z.string(),
      description: z.string(),
    }),
  ),
  screenshot_filename: z.string().nullable(),
  // IAP.p1.j Issue 1: persist Manager's explicit pricing-source choice
  // so reload doesn't re-derive Q-D default. Optional for forward-compat
  // with any older clients still on the IAP.p1.f payload shape.
  pricing_source: z
    .enum(["APPLE", "DEFAULT_TEMPLATE", "APP_TEMPLATE"])
    .optional(),
});

const BodySchema = z.object({
  form: FormSchema,
});

/**
 * POST /api/iap-management/apps/[appId]/iaps
 *
 * Creates a local draft IAP (apple_iap_id NULL). [appId] is Apple's numeric
 * app ID — we fetch the app from Apple to capture bundleId + name, then
 * upsert iap_mgmt.apps to obtain the internal UUID FK for the draft row.
 */
export async function POST(
  req: Request,
  ctx: { params: { appId: string } },
) {
  // Hotfix 10: member-accessible (was requireIapAdmin pre-Hotfix-10).
  let session;
  try {
    session = await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  let body;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid body";
    return NextResponse.json({ error: msg }, { status: 422 });
  }

  // Fetch app from Apple to capture name + bundle id, then register in our schema.
  let internalAppId: string;
  try {
    const creds = await getActiveAccount();
    const appRes = await getApp(creds, ctx.params.appId);
    internalAppId = await ensureAppRegistered({
      apple_app_id: ctx.params.appId,
      bundle_id: appRes.data.attributes.bundleId,
      name: appRes.data.attributes.name,
      asc_account_id: creds.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to resolve app";
    await log("iap-create", `app resolve failed: ${msg}`, "ERROR");
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Insert draft + localizations + initial audit row.
  try {
    const row = await createDraftIap({
      app_id: internalAppId,
      form: body.form,
      actor: session.user.email ?? "unknown",
    });
    await log(
      "iap-create",
      `draft created id=${row.id} product=${row.product_id} by ${session.user.email}`,
    );
    return NextResponse.json({ id: row.id }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Insert failed";
    await log("iap-create", `insert error: ${msg}`, "ERROR");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
