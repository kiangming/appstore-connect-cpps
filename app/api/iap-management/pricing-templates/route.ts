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
import { findAllAccountsPublic } from "@/lib/asc-account-repository";
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
 *   scope      — "ACCOUNT" or "APP" (required). Giá trị khác → 400 kèm
 *                message, KHÔNG rơi âm thầm vào nhánh nào.
 *                ⚠ Bí danh "GLOBAL" ĐÃ GỠ (2026-08-29, sau khi M-2 apply).
 *                  M-2 đã thu hẹp CHECK của iap_mgmt.price_tier_templates
 *                  còn 'APP' | 'ACCOUNT' và xoá dòng GLOBAL, nên nhận chữ
 *                  đó chỉ còn là một cách ghi nhầm chỗ mà không ai thấy.
 *   account_id — khi scope=ACCOUNT: account NÀO. **BẮT BUỘC** — thiếu nó
 *                là 400, KHÔNG có fallback. Từng có một nhánh rơi về
 *                account đang active cho tab trình duyệt mở từ trước lúc
 *                deploy C-C; đã GỠ 2026-08-29 (chunk 2.6) cùng cửa sổ với
 *                bí danh scope="GLOBAL".
 *   app_id     — required when scope=APP
 *
 * Hotfix 11: scope-conditional admin gate. `scope=ACCOUNT` (Default
 * Template của một account) remains admin-only — bán kính nổ là mọi app
 * của account đó. `scope=APP` (per-app override) is open to any signed-in
 * member. Failures return JSON `{ error }`.
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
  let accountIdField: string | null = null;
  let appleAppIdField: string | null = null;
  try {
    const form = await req.formData();
    const candidate = form.get("file");
    if (candidate instanceof File) file = candidate;
    const scopeRaw = form.get("scope");
    if (typeof scopeRaw === "string") scopeField = scopeRaw;
    const appIdRaw = form.get("app_id");
    if (typeof appIdRaw === "string") appIdField = appIdRaw;
    const accountIdRaw = form.get("account_id");
    if (typeof accountIdRaw === "string") accountIdField = accountIdRaw;
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
  if (scopeField === "ACCOUNT") {
    // Hotfix 11 giữ nguyên tinh thần: template mặc định là admin-only. Bán
    // kính nổ hẹp lại — một account thay vì toàn hệ thống — nhưng vẫn là
    // "mọi app của account này", nên vẫn admin.
    if (session.user.role !== "admin") {
      return NextResponse.json(
        { error: "Admin role required to upload the Default Template." },
        { status: 403 },
      );
    }
    // ⚠ C-D — CHỖ NGUY HIỂM NHẤT CỦA CHUNK NÀY.
    //   Tab Default cho phép Manager XEM và THAY template của một account
    //   KHÁC account đang active ở TopNav. Nếu route tự suy account từ
    //   getActiveAccount(), thì "chọn account B rồi bấm Replace" sẽ ghi đè
    //   template của A — mất 1140 ô thật, im lặng, và bản bị mất là bản
    //   Manager đang không nhìn.
    //   Nên account đến TỪ CLIENT, và được đối chiếu với danh sách thật
    //   trước khi dùng (soft-ref: không FK nào làm việc này giúp).
    // ⚠ KHÔNG CÓ NHÁNH FALLBACK, và sự vắng mặt đó là nội dung chính của
    //   đoạn này. "Account đang active ở TopNav" và "account Manager đang
    //   chọn ở dãy chip" là HAI THỨ KHÁC NHAU; suy ra cái thứ nhất khi
    //   client định nói cái thứ hai chính là ca ghi đè 1140 ô thật của một
    //   account mà Manager đang không nhìn — im lặng, và bản mất là bản
    //   không ai đang mở. Một 400 ồn ào rẻ hơn vô hạn so với ca đó.
    //   Nhánh fallback cũ tồn tại cho tab trình duyệt mở từ trước lúc deploy
    //   C-C; gỡ 2026-08-29 (chunk 2.6) cùng cửa sổ với bí danh
    //   scope="GLOBAL" — gỡ một nửa cửa sổ là không gỡ.
    //   ⚠ Chuỗi rỗng cũng rơi vào đây, cố ý: `!""` là true, nên một
    //   `account_id=""` bị từ chối thay vì lặng lẽ thành account active.
    if (!accountIdField) {
      return NextResponse.json(
        {
          error:
            'scope=ACCOUNT requires "account_id" in form data. The target ' +
            "account must be stated by the caller — it is never inferred " +
            "from the active account, because writing to the active account " +
            "instead of the specified one silently overwrites a template " +
            "nobody is looking at.",
        },
        { status: 400 },
      );
    }
    const known = await findAllAccountsPublic();
    if (!known.some((a) => a.id === accountIdField)) {
      return NextResponse.json(
        { error: `Unknown ASC account "${accountIdField}".` },
        { status: 400 },
      );
    }
    scope = { kind: "ACCOUNT", account_id: accountIdField };
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
      { error: 'scope must be "ACCOUNT" or "APP".' },
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
        scope_account_id: result.scope_account_id,
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
