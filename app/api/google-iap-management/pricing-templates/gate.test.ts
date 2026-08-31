/**
 * G1c · C1+C2 — GATE ADMIN cho Replace VÀ Remove Default Template.
 *
 * ⚠ VÌ SAO PHẢI GÁC CẢ HAI ĐƯỜNG. Replace là delete-rồi-insert: bản cũ
 *   biến mất y hệt như khi bấm Remove. Gác một đường và bỏ đường kia thì
 *   cái gate không bảo vệ gì cả — chỉ đổi nút mà người ta phải bấm.
 *
 * ⚠ VÌ SAO DELETE PHẢI ĐỌC `scope_type` TRƯỚC (C2). Route xoá theo id
 *   trần. Không đọc trước thì gate chỉ có hai lựa chọn, cả hai đều sai:
 *   gác tất cả (đổi quy tắc của template APP, vốn cho mọi user đã đăng
 *   nhập) hoặc không gác gì (ai đăng nhập cũng xoá được Default của cả
 *   6 account). Thứ tự đọc-rồi-gác chính là thứ các test dưới ghim.
 *
 * QUY TẮC HIỆN CÓ CHO SCOPE APP — đọc từ code, không tự đặt: trước G1c cả
 * hai route chỉ kiểm `getServerSession`, không có role check. Manager chốt
 * giữ nguyên vai trò đó cho APP; phần thêm cho APP là quyền SỞ HỮU
 * (account), không phải role.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  requireGoogleIapAdmin: vi.fn(),
  getTemplateScopeById: vi.fn(),
  deleteTemplate: vi.fn(),
  replaceTemplate: vi.fn(),
  listAccounts: vi.fn(),
  readActiveAccountId: vi.fn(),
  resolveActiveAccountId: vi.fn(),
  getAppById: vi.fn(),
  appendAction: vi.fn(),
  parsePricingTemplate: vi.fn(),
  googleIapDb: vi.fn(),
}));

// ⚠ Hai lớp lỗi phải nằm TRONG vi.hoisted: `vi.mock` được kéo lên đầu
//   file, nên một `class` khai ở thân module chưa khởi tạo xong khi
//   factory chạy ("Cannot access before initialization").
const { ForbiddenError, UnauthorizedError } = vi.hoisted(() => {
  class ForbiddenError extends Error {
    constructor() {
      super("Admin role required for this Google IAP Management action.");
      this.name = "GoogleIapForbiddenError";
    }
  }
  class UnauthorizedError extends Error {
    constructor() {
      super("Sign in required for Google IAP Management.");
      this.name = "GoogleIapUnauthorizedError";
    }
  }
  return { ForbiddenError, UnauthorizedError };
});

vi.mock("next-auth", () => ({ getServerSession: h.getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/google-iap-management/auth", () => ({
  requireGoogleIapAdmin: h.requireGoogleIapAdmin,
  GoogleIapForbiddenError: ForbiddenError,
  GoogleIapUnauthorizedError: UnauthorizedError,
}));
vi.mock("@/lib/google-iap-management/queries/templates", () => ({
  getTemplateScopeById: h.getTemplateScopeById,
  deleteTemplate: h.deleteTemplate,
  replaceTemplate: h.replaceTemplate,
}));
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({
  listAccounts: h.listAccounts,
}));
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId: h.readActiveAccountId,
  resolveActiveAccountId: h.resolveActiveAccountId,
}));
vi.mock("@/lib/google-iap-management/repository/apps", () => ({
  getAppById: h.getAppById,
}));
vi.mock("@/lib/google-iap-management/repository/actions-log", () => ({
  appendAction: h.appendAction,
}));
vi.mock("@/lib/google-iap-management/parsers/pricing-template-parser", () => ({
  parsePricingTemplate: h.parsePricingTemplate,
}));
vi.mock("@/lib/google-iap-management/db", () => ({ googleIapDb: h.googleIapDb }));

import { DELETE } from "./[id]/route";
import { POST } from "./route";

const ACCT_A = "acct-aaaa";

beforeEach(() => {
  vi.clearAllMocks();
  h.getServerSession.mockResolvedValue({ user: { email: "u@vng.com.vn" } });
  h.listAccounts.mockResolvedValue([{ id: ACCT_A, status: "verified" }]);
  h.readActiveAccountId.mockReturnValue(ACCT_A);
  h.resolveActiveAccountId.mockReturnValue(ACCT_A);
  h.requireGoogleIapAdmin.mockResolvedValue({ user: { role: "admin" } });
  h.deleteTemplate.mockResolvedValue(undefined);
  h.appendAction.mockResolvedValue(undefined);
});

function accountTemplate(over: Record<string, unknown> = {}) {
  return {
    id: "tpl-1",
    scope_type: "ACCOUNT",
    scope_app_id: null,
    scope_account_id: ACCT_A,
    uploaded_by: "SYSTEM_MIGRATION",
    origin_note: "bản sao",
    ...over,
  };
}

describe("C2 — DELETE đọc scope_type TRƯỚC khi xoá", () => {
  it("tra scope trước, và KHÔNG xoá gì khi id không tồn tại", async () => {
    h.getTemplateScopeById.mockResolvedValue(null);
    const res = await DELETE(new Request("http://x"), {
      params: { id: "tpl-missing" },
    });
    expect(res.status).toBe(404);
    expect(h.getTemplateScopeById).toHaveBeenCalledWith("tpl-missing");
    expect(h.deleteTemplate).not.toHaveBeenCalled();
  });

  it("gate được áp DỰA TRÊN scope đọc ra, không phải đoán", async () => {
    h.getTemplateScopeById.mockResolvedValue(accountTemplate());
    await DELETE(new Request("http://x"), { params: { id: "tpl-1" } });
    // Đọc xong mới gác: cả hai đều được gọi, và probe đứng trước.
    expect(h.getTemplateScopeById).toHaveBeenCalled();
    expect(h.requireGoogleIapAdmin).toHaveBeenCalled();
    expect(
      h.getTemplateScopeById.mock.invocationCallOrder[0],
    ).toBeLessThan(h.requireGoogleIapAdmin.mock.invocationCallOrder[0]);
  });
});

describe("C1 — Remove Default (scope ACCOUNT) chỉ dành cho admin", () => {
  it("KHÔNG phải admin → 403, và KHÔNG xoá gì", async () => {
    h.getTemplateScopeById.mockResolvedValue(accountTemplate());
    h.requireGoogleIapAdmin.mockRejectedValue(new ForbiddenError());
    const res = await DELETE(new Request("http://x"), {
      params: { id: "tpl-1" },
    });
    expect(res.status).toBe(403);
    expect(h.deleteTemplate).not.toHaveBeenCalled();
  });

  it("admin → xoá được", async () => {
    h.getTemplateScopeById.mockResolvedValue(accountTemplate());
    const res = await DELETE(new Request("http://x"), {
      params: { id: "tpl-1" },
    });
    expect(res.status).toBe(200);
    expect(h.deleteTemplate).toHaveBeenCalledWith("tpl-1");
  });

  it("admin của account KHÁC → 404, không xoá Default của account này", async () => {
    h.getTemplateScopeById.mockResolvedValue(
      accountTemplate({ scope_account_id: "acct-bbbb" }),
    );
    const res = await DELETE(new Request("http://x"), {
      params: { id: "tpl-1" },
    });
    expect(res.status).toBe(404);
    expect(h.deleteTemplate).not.toHaveBeenCalled();
  });
});

describe("C1 — template APP giữ QUY TẮC CŨ: mọi user đã đăng nhập", () => {
  it("không phải admin vẫn xoá được template APP của app thuộc account mình", async () => {
    h.getTemplateScopeById.mockResolvedValue({
      id: "tpl-app",
      scope_type: "APP",
      scope_app_id: "app-1",
      scope_account_id: null,
      uploaded_by: "u@vng.com.vn",
      origin_note: null,
    });
    h.requireGoogleIapAdmin.mockRejectedValue(new ForbiddenError());
    h.getAppById.mockResolvedValue({
      id: "app-1",
      google_console_account_id: ACCT_A,
    });
    const res = await DELETE(new Request("http://x"), {
      params: { id: "tpl-app" },
    });
    expect(res.status).toBe(200);
    expect(h.deleteTemplate).toHaveBeenCalledWith("tpl-app");
    // Không hề gọi tới gate admin cho nhánh APP.
    expect(h.requireGoogleIapAdmin).not.toHaveBeenCalled();
  });

  it("template APP của account KHÁC → 404 (quyền sở hữu, không phải role)", async () => {
    h.getTemplateScopeById.mockResolvedValue({
      id: "tpl-app",
      scope_type: "APP",
      scope_app_id: "app-of-B",
      scope_account_id: null,
      uploaded_by: "u@vng.com.vn",
      origin_note: null,
    });
    h.getAppById.mockResolvedValue(null); // getAppById lọc account → không thấy
    const res = await DELETE(new Request("http://x"), {
      params: { id: "tpl-app" },
    });
    expect(res.status).toBe(404);
    expect(h.deleteTemplate).not.toHaveBeenCalled();
  });
});

describe("C1 — Replace (upload) scope ACCOUNT cũng chỉ dành cho admin", () => {
  function uploadRequest(scope: string) {
    const form = new FormData();
    form.append("file", new File(["x"], "t.xlsx"));
    form.append("scope", scope);
    return new Request("http://x", { method: "POST", body: form });
  }

  it("KHÔNG phải admin → 403, và KHÔNG ghi gì", async () => {
    h.requireGoogleIapAdmin.mockRejectedValue(new ForbiddenError());
    const res = await POST(uploadRequest("ACCOUNT"));
    expect(res.status).toBe(403);
    expect(h.replaceTemplate).not.toHaveBeenCalled();
    // Gate phải chặn TRƯỚC cả bước parse file.
    expect(h.parsePricingTemplate).not.toHaveBeenCalled();
  });

  it("admin → đi tiếp tới bước parse", async () => {
    h.parsePricingTemplate.mockReturnValue({
      errors: ["stop-here"],
      warnings: [],
      entries: [],
    });
    const res = await POST(uploadRequest("ACCOUNT"));
    expect(h.requireGoogleIapAdmin).toHaveBeenCalled();
    expect(res.status).toBe(422); // dừng ở lỗi parse — đã qua được gate
  });
});
