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

  // ── ACCOUNT ĐÍCH CỦA LỆNH GHI ─────────────────────────────────────────
  //
  // ⚠ ĐÃ ĐỔI Ở G1e so với G1b, có chủ ý. G1b viết ở đây "KHÔNG NHẬN TỪ
  //   CLIENT" và lấy thẳng account đang active từ cookie. Điều đó đúng
  //   CHỪNG NÀO màn hình chỉ xem được Default của account đang active.
  //   G1e cho phép chip chọn XEM account khác mà KHÔNG đổi active account
  //   (quyết định Manager), nên từ lúc đó cookie KHÔNG CÒN trả lời được
  //   câu "Manager đang muốn ghi vào account nào" — chỉ màn hình biết.
  //
  //   An toàn KHÔNG đến từ việc giấu giá trị này, mà từ hai lớp:
  //     (1) ĐỐI CHIẾU: `account_id` phải nằm trong listAccounts(); client
  //         không bịa ra được một account, cũng không trỏ ra ngoài tập
  //         account mà công cụ quản lý;
  //     (2) GATE ADMIN của G1c ngay bên dưới.
  //   Thiếu (1) thì đây đúng là cửa ghi đè Default của account bất kỳ.
  // ⚠ C1 — Replace Default Template = hành động cấp account ⇒ CHỈ ADMIN.
  //   Đối xứng với Remove ở [id]/route.ts: gác một đường mà bỏ đường kia
  //   thì cái gate không có tác dụng gì, vì Replace ghi đè cũng mất bản
  //   cũ y như Remove.
  //   Scope APP giữ quy tắc cũ (mọi user đã đăng nhập) — quyết định
  //   Manager, và đó đúng là quy tắc route này đang chạy trước G1c.
  //
  // ⚠ GATE PHẢI ĐỨNG TRƯỚC MỌI PHÉP ĐỌC VỀ ACCOUNT. Bản G1e đầu đặt gate
  //   SAU bước đối chiếu `account_id`, và như thế người KHÔNG phải admin
  //   gửi một id bịa sẽ nhận 404 còn gửi id thật sẽ nhận 403 — tức là
  //   route trả lời giúp câu "id này có tồn tại không" cho đúng người
  //   không được phép biết. Gác trước thì mọi câu trả lời cho người đó
  //   đều là 403, không rò rỉ gì.
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

  const accounts = await listAccounts().catch(() => []);
  if (accounts.length === 0) {
    return NextResponse.json(
      { error: "No Google Console accounts configured." },
      { status: 400 },
    );
  }
  const requestedAccountId = form.get("account_id");
  let accountId: string;
  if (typeof requestedAccountId === "string" && requestedAccountId !== "") {
    if (!accounts.some((a) => a.id === requestedAccountId)) {
      // 404 chứ không 403: không xác nhận id đó có tồn tại hay không.
      return NextResponse.json(
        { error: "Account not found." },
        { status: 404 },
      );
    }
    accountId = requestedAccountId;
  } else {
    // Không gửi account_id → giữ hành vi cũ: account đang active.
    const fallback = resolveActiveAccountId(accounts, readActiveAccountId());
    if (!fallback) {
      return NextResponse.json(
        { error: "No Google Console accounts configured." },
        { status: 400 },
      );
    }
    accountId = fallback;
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
