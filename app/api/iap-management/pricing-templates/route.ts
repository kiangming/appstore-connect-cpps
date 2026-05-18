import { NextResponse } from "next/server";
import {
  requireIapAdmin,
  IapForbiddenError,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { parsePriceTiersXlsx } from "@/lib/iap-management/parsers/price-tiers";
import {
  replaceTemplate,
  type TemplateScope,
} from "@/lib/iap-management/queries/templates";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * POST /api/iap-management/pricing-templates
 *
 * Upload a pricing template (Default or App-specific). Replace-only per Q-A:
 * any existing template for the same scope is deleted (CASCADE wipes entries)
 * before the new header + entries are inserted.
 *
 * Multipart form fields:
 *   file       — the .xlsx template (required)
 *   scope      — "GLOBAL" or "APP" (required)
 *   app_id     — required when scope=APP
 *
 * Admin-only (Q-IAP.8). Failures return JSON `{ error }`.
 */
export async function POST(req: Request) {
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

  let file: File | null = null;
  let scopeField: string | null = null;
  let appIdField: string | null = null;
  try {
    const form = await req.formData();
    const candidate = form.get("file");
    if (candidate instanceof File) file = candidate;
    const scopeRaw = form.get("scope");
    if (typeof scopeRaw === "string") scopeField = scopeRaw;
    const appIdRaw = form.get("app_id");
    if (typeof appIdRaw === "string") appIdField = appIdRaw;
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart request body." },
      { status: 400 },
    );
  }
  if (!file) {
    return NextResponse.json(
      { error: 'Missing "file" field in form data.' },
      { status: 400 },
    );
  }

  let scope: TemplateScope;
  if (scopeField === "GLOBAL") {
    scope = { kind: "GLOBAL" };
  } else if (scopeField === "APP") {
    if (!appIdField) {
      return NextResponse.json(
        { error: 'scope=APP requires "app_id" in form data.' },
        { status: 400 },
      );
    }
    scope = { kind: "APP", app_id: appIdField };
  } else {
    return NextResponse.json(
      { error: 'scope must be "GLOBAL" or "APP".' },
      { status: 400 },
    );
  }

  let parsed;
  try {
    parsed = await parsePriceTiersXlsx(file);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parse failed";
    await log("iap-pricing-templates", `parse error: ${message}`, "WARN");
    return NextResponse.json({ error: message }, { status: 422 });
  }

  try {
    const result = await replaceTemplate(
      scope,
      parsed,
      session.user.email ?? "unknown",
      file.name,
    );
    await log(
      "iap-pricing-templates",
      `upload ok by ${session.user.email}: scope=${scope.kind} ${scope.kind === "APP" ? scope.app_id : ""} entries=${result.inserted_entry_count}`,
    );
    return NextResponse.json(
      {
        template_id: result.template_id,
        scope_type: result.scope_type,
        scope_app_id: result.scope_app_id,
        inserted_entry_count: result.inserted_entry_count,
        tier_count: parsed.tiers.length,
        territory_count: parsed.territory_count,
        warnings: parsed.warnings,
        audit_batch_id: result.audit_batch_id,
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    await log("iap-pricing-templates", `upload error: ${message}`, "ERROR");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
