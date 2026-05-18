import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { deleteTemplate } from "@/lib/iap-management/queries/templates";
import { iapDb } from "@/lib/iap-management/db";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * DELETE /api/iap-management/pricing-templates/[templateId]
 *
 * Remove a Default or App-specific pricing template. CASCADE wipes its
 * entries automatically. Admin-only (Q-IAP.8).
 */
export async function DELETE(
  _req: Request,
  ctx: { params: { templateId: string } },
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

  try {
    const header = await deleteTemplate(ctx.params.templateId);
    await iapDb()
      .from("actions_log")
      .insert({
        actor: session.user.email ?? "unknown",
        action_type: "PRICE_TIER_IMPORT",
        payload: {
          op: "delete_template",
          template_id: header.id,
          scope: header.scope_type,
          scope_app_id: header.scope_app_id,
        },
      });
    await log(
      "iap-pricing-templates",
      `delete ok by ${session.user.email}: ${ctx.params.templateId} (${header.scope_type})`,
    );
    return NextResponse.json(
      {
        template_id: header.id,
        scope_type: header.scope_type,
        scope_app_id: header.scope_app_id,
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed";
    await log("iap-pricing-templates", `delete error: ${message}`, "ERROR");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
