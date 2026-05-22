import { NextResponse } from "next/server";
import {
  requireIapSession,
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
 * entries automatically.
 *
 * Hotfix 11: scope-conditional admin gate. Deleting a GLOBAL (Default)
 * template requires admin (global blast); APP-scoped templates are open
 * to any signed-in member, consistent with member-uploadable per-app
 * templates.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: { templateId: string } },
) {
  let session;
  try {
    session = await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  // Hotfix 11: pre-fetch scope to enforce admin-only on GLOBAL deletes.
  // Small race window between this read and deleteTemplate's own header
  // load is acceptable — scope_type doesn't change mid-template-life
  // and the team is small.
  const scopeProbe = await iapDb()
    .from("price_tier_templates")
    .select("scope_type")
    .eq("id", ctx.params.templateId)
    .maybeSingle();
  if (scopeProbe.error) {
    return NextResponse.json(
      { error: `Template lookup failed: ${scopeProbe.error.message}` },
      { status: 500 },
    );
  }
  if (!scopeProbe.data) {
    return NextResponse.json(
      { error: `Template ${ctx.params.templateId} does not exist.` },
      { status: 404 },
    );
  }
  if (
    scopeProbe.data.scope_type === "GLOBAL" &&
    session.user.role !== "admin"
  ) {
    return NextResponse.json(
      { error: "Admin role required to remove the Default Template." },
      { status: 403 },
    );
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
