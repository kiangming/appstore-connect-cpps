/**
 * Upload (replace) a pricing template — POST handler (g1.j).
 *
 * Accepts multipart-form with:
 *   - file: .xlsx pricing template
 *   - scope: 'GLOBAL' | 'APP'
 *   - appId (when scope=APP): UUID of the cached app
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import { parsePricingTemplate } from "@/lib/google-iap-management/parsers/pricing-template-parser";
import { replaceTemplate } from "@/lib/google-iap-management/queries/templates";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";
import { googleIapDb } from "@/lib/google-iap-management/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "'file' field is required." }, { status: 400 });
  }

  const scopeRaw = form.get("scope");
  if (scopeRaw !== "GLOBAL" && scopeRaw !== "APP") {
    return NextResponse.json(
      { error: "scope must be 'GLOBAL' or 'APP'." },
      { status: 400 },
    );
  }
  const scope = scopeRaw;

  let appId: string | null = null;
  if (scope === "APP") {
    const raw = form.get("appId");
    if (typeof raw !== "string" || raw.trim() === "") {
      return NextResponse.json(
        { error: "appId is required when scope='APP'." },
        { status: 400 },
      );
    }
    appId = raw.trim();
    // Validate the app exists.
    const { data, error } = await googleIapDb()
      .from("apps")
      .select("id")
      .eq("id", appId)
      .maybeSingle();
    if (error || !data) {
      return NextResponse.json(
        { error: `App ${appId} not found.` },
        { status: 404 },
      );
    }
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = parsePricingTemplate(buffer, buffer.byteLength);

  if (parsed.errors.length > 0) {
    return NextResponse.json(
      { errors: parsed.errors, warnings: parsed.warnings },
      { status: 422 },
    );
  }
  if (parsed.entries.length === 0) {
    return NextResponse.json(
      {
        error: "No template entries parsed. Check sheet format.",
        warnings: parsed.warnings,
      },
      { status: 422 },
    );
  }

  try {
    const result = await replaceTemplate({
      scope,
      appId,
      uploadedBy: session.user.email,
      sourceFilename: file.name,
      entries: parsed.entries,
    });

    await appendAction({
      actionType: "PRICING_TEMPLATE_UPLOAD",
      actorEmail: session.user.email,
      targetId: result.templateId,
      payload: {
        scope,
        app_id: appId,
        source_filename: file.name,
        entry_count: result.insertedEntryCount,
        tier_count: parsed.tierCount,
        territory_count: parsed.territoryCount,
        warnings: parsed.warnings,
      },
    });

    return NextResponse.json({
      template_id: result.templateId,
      inserted_entry_count: result.insertedEntryCount,
      tier_count: parsed.tierCount,
      territory_count: parsed.territoryCount,
      warnings: parsed.warnings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
