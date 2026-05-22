import { NextResponse } from "next/server";
import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { parsePriceTiersXlsx } from "@/lib/iap-management/parsers/price-tiers";
import {
  replaceTemplate,
  type TemplateScope,
} from "@/lib/iap-management/queries/templates";
import { ensureAppRegistered } from "@/lib/iap-management/queries/iaps";
import { getActiveAccount } from "@/lib/get-active-account";
import { getApp } from "@/lib/asc-client";
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
 * Hotfix 11: scope-conditional admin gate. `scope=GLOBAL` (Default
 * Template) remains admin-only — global blast radius. `scope=APP`
 * (per-app override) is open to any signed-in member. Failures return
 * JSON `{ error }`.
 */
export async function POST(req: Request) {
  let session;
  try {
    session = await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  let file: File | null = null;
  let scopeField: string | null = null;
  let appIdField: string | null = null;
  let appleAppIdField: string | null = null;
  try {
    const form = await req.formData();
    const candidate = form.get("file");
    if (candidate instanceof File) file = candidate;
    const scopeRaw = form.get("scope");
    if (typeof scopeRaw === "string") scopeField = scopeRaw;
    const appIdRaw = form.get("app_id");
    if (typeof appIdRaw === "string") appIdField = appIdRaw;
    // IAP.p1.j Issue 3: Settings → Per-App tab live-fetches Apple's app
    // catalog and sends the Apple numeric ID; the route resolves to the
    // internal iap_mgmt.apps UUID via ensureAppRegistered (auto-registers
    // apps the Manager hasn't yet drafted an IAP for). The App detail
    // section continues to send the resolved internal UUID directly.
    const appleAppIdRaw = form.get("apple_app_id");
    if (typeof appleAppIdRaw === "string") appleAppIdField = appleAppIdRaw;
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
    // Hotfix 11: Default Template upload is admin-only (global blast).
    if (session.user.role !== "admin") {
      return NextResponse.json(
        { error: "Admin role required to upload the Default Template." },
        { status: 403 },
      );
    }
    scope = { kind: "GLOBAL" };
  } else if (scopeField === "APP") {
    let internalAppId = appIdField;
    if (!internalAppId && appleAppIdField) {
      try {
        const creds = await getActiveAccount();
        const appRes = await getApp(creds, appleAppIdField);
        internalAppId = await ensureAppRegistered({
          apple_app_id: appleAppIdField,
          bundle_id: appRes.data.attributes.bundleId,
          name: appRes.data.attributes.name,
          // IAP.p1.j Issue 4: capture the ASC account at first registration.
          asc_account_id: creds.id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Apple lookup failed";
        await log("iap-pricing-templates", `apple_app_id resolve failed: ${msg}`, "ERROR");
        return NextResponse.json({ error: msg }, { status: 502 });
      }
    }
    if (!internalAppId) {
      return NextResponse.json(
        { error: 'scope=APP requires "app_id" (internal UUID) or "apple_app_id" in form data.' },
        { status: 400 },
      );
    }
    scope = { kind: "APP", app_id: internalAppId };
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
