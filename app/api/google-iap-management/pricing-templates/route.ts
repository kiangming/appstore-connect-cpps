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
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import {
  requireGoogleIapAdmin,
  GoogleIapForbiddenError,
  GoogleIapUnauthorizedError,
} from "@/lib/google-iap-management/auth";
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
  // ⚠ G1b — từ vựng trên dây đổi "GLOBAL" → "ACCOUNT". Bên gửi là
  //   DefaultTemplateTab.tsx (form.append("scope", …)), đổi cùng commit.
  if (scopeRaw !== "ACCOUNT" && scopeRaw !== "APP") {
    return NextResponse.json(
      { error: "scope must be 'ACCOUNT' or 'APP'." },
      { status: 400 },
    );
  }
  const scope = scopeRaw;

  // ⚠ ACCOUNT ĐỌC Ở SERVER, KHÔNG NHẬN TỪ CLIENT. Đây là đường GHI đè
  //   Default Template — để client tự khai account là mở đúng cửa cho
  //   một request nắn tay ghi đè Default của account khác.
  //   (Gate admin cho Replace/Remove thuộc G1c, chưa làm ở đây.)
  const accounts = await listAccounts().catch(() => []);
  const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
  if (!accountId) {
    return NextResponse.json(
      { error: "No Google Console accounts configured." },
      { status: 400 },
    );
  }

  // ⚠ C1 — Replace Default Template = hành động cấp account ⇒ CHỈ ADMIN.
  //   Đối xứng với Remove ở [id]/route.ts: gác một đường mà bỏ đường kia
  //   thì cái gate không có tác dụng gì, vì Replace ghi đè cũng mất bản
  //   cũ y như Remove.
  //   Scope APP giữ quy tắc cũ (mọi user đã đăng nhập) — quyết định
  //   Manager, và đó đúng là quy tắc route này đang chạy trước G1c.
  if (scope === "ACCOUNT") {
    try {
      await requireGoogleIapAdmin();
    } catch (err) {
      if (err instanceof GoogleIapUnauthorizedError) {
        return NextResponse.json({ error: err.message }, { status: 401 });
      }
      if (err instanceof GoogleIapForbiddenError) {
        return NextResponse.json({ error: err.message }, { status: 403 });
      }
      throw err;
    }
  }

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
      ...(scope === "APP"
        ? { scope, appId: appId as string, accountId: null as null }
        : { scope, accountId, appId: null as null }),
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
