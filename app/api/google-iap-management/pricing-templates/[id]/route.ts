/**
 * Delete a pricing template — DELETE handler (g1.j).
 * Cascades to entries via FK ON DELETE CASCADE.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import {
  deleteTemplate,
  getTemplateScopeById,
} from "@/lib/google-iap-management/queries/templates";
import {
  requireGoogleIapAdmin,
  GoogleIapForbiddenError,
  GoogleIapUnauthorizedError,
} from "@/lib/google-iap-management/auth";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import { getAppById } from "@/lib/google-iap-management/repository/apps";
import { appendAction } from "@/lib/google-iap-management/repository/actions-log";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = params.id;
  if (!id) {
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  }

  // ⚠ C2 — ĐỌC scope_type TRƯỚC KHI XOÁ. Không có bước này thì gate bên
  //   dưới không biết mình đang gác cái gì: hoặc gác cả template APP
  //   (đổi quy tắc hiện có), hoặc không gác gì (ai đăng nhập cũng xoá
  //   được Default của cả 6 account). Đọc trước, gác sau.
  const probe = await getTemplateScopeById(id);
  if (!probe) {
    return NextResponse.json({ error: "Template not found." }, { status: 404 });
  }

  const accounts = await listAccounts().catch(() => []);
  const activeAccountId = resolveActiveAccountId(accounts, readActiveAccountId());

  if (probe.scope_type === "ACCOUNT") {
    // C1 — Remove Default Template = hành động cấp account ⇒ CHỈ ADMIN.
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
    // Và chỉ được xoá Default CỦA CHÍNH account đang active.
    if (probe.scope_account_id !== activeAccountId) {
      return NextResponse.json({ error: "Template not found." }, { status: 404 });
    }
  } else {
    // ⚠ QUY TẮC HIỆN CÓ CHO TEMPLATE APP — GIỮ NGUYÊN, đọc từ code chứ
    //   không tự đặt: route này trước G1c chỉ kiểm `getServerSession`,
    //   tức MỌI USER ĐÃ ĐĂNG NHẬP đều xoá được, không có role check.
    //   Manager chốt giữ nguyên vai trò đó cho scope APP.
    //   Phần THÊM ở đây không phải role mà là quyền sở hữu: template APP
    //   của account khác thì không được đụng (cùng lớp rò rỉ C4).
    if (!activeAccountId || !probe.scope_app_id) {
      return NextResponse.json({ error: "Template not found." }, { status: 404 });
    }
    const app = await getAppById(probe.scope_app_id, activeAccountId);
    if (!app) {
      return NextResponse.json({ error: "Template not found." }, { status: 404 });
    }
  }

  try {
    await deleteTemplate(id);
    await appendAction({
      actionType: "PRICING_TEMPLATE_UPLOAD",
      actorEmail: session.user.email ?? null,
      targetId: id,
      payload: {
        action: "delete",
        scope_type: probe.scope_type,
        scope_account_id: probe.scope_account_id,
        scope_app_id: probe.scope_app_id,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
