/**
 * [ACCOUNT-default-template] chunk 2.1 — BÍ DANH scope="GLOBAL" ĐÃ GỠ.
 *
 * C-C giữ tạm `scope="GLOBAL"` như bí danh của `"ACCOUNT"` để một tab trình
 * duyệt mở từ trước lúc deploy không upload hỏng. M-2 (apply 2026-08-29) đã
 * xoá dòng GLOBAL và thu hẹp CHECK của iap_mgmt.price_tier_templates còn
 * 'APP' | 'ACCOUNT', nên bí danh hết lý do tồn tại.
 *
 * Điều bài test này canh KHÔNG phải "GLOBAL bị gỡ" — mà là **gỡ thế nào**:
 * chữ đó phải bị TỪ CHỐI RÕ RÀNG (400 + message đọc được), chứ không rơi âm
 * thầm vào một nhánh nào rồi ghi nhầm chỗ. Đây đúng là ca P-status/silent-
 * fail mà KB §9 mô tả: một `else` không có message, hoặc một nhánh mặc định
 * ghi vào account đang active, đều "chạy được" và không ai thấy gì.
 *
 * Ba khẳng định đi thành bộ ba, cố ý:
 *   1. "GLOBAL"  → 400 + message  (bí danh đã chết, và chết ồn ào)
 *   2. "ACCOUNT" → KHÔNG 400      (đường sống thật chưa bị vạ lây)
 *   3. replaceTemplate KHÔNG được gọi khi scope="GLOBAL" (không ghi gì)
 * Bỏ (2) thì một route `return 400` vô điều kiện vẫn xanh. Bỏ (3) thì một
 * route trả 400 SAU KHI đã ghi vẫn xanh.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireIapSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/iap-management/auth")>(
    "@/lib/iap-management/auth",
  );
  return { ...actual, requireIapSession };
});

// route.ts → queries/templates.ts → asc-account-repository.ts → lib/supabase.ts
// dựng client thật ở module scope (ném khi thiếu env trong test). Stub cho
// import hermetic — cùng quy ước với queries/templates.test.ts.
const findAllAccountsPublic = vi.hoisted(() => vi.fn());
vi.mock("@/lib/asc-account-repository", () => ({
  findAllAccountsPublic,
  findAllAccounts: vi.fn(),
}));

const getActiveAccount = vi.hoisted(() => vi.fn());
vi.mock("@/lib/get-active-account", () => ({ getActiveAccount }));

const replaceTemplate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/queries/templates", () => ({ replaceTemplate }));

const parsePriceTiersXlsx = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/parsers/price-tiers", () => ({ parsePriceTiersXlsx }));

vi.mock("@/lib/iap-management/queries/iaps", () => ({ ensureAppRegistered: vi.fn() }));
vi.mock("@/lib/asc-client", () => ({ getApp: vi.fn() }));

import { POST } from "./route";

const ADMIN = { user: { email: "admin@vng.com.vn", role: "admin" } };
const ACCOUNT_ID = "acct-real-1";

function upload(scope: string): Request {
  const fd = new FormData();
  fd.append("file", new File(["x"], "default.xlsx"));
  fd.append("scope", scope);
  fd.append("account_id", ACCOUNT_ID);
  return new Request("http://localhost/api/iap-management/pricing-templates", {
    method: "POST",
    body: fd,
  });
}

beforeEach(() => {
  requireIapSession.mockReset();
  findAllAccountsPublic.mockReset();
  getActiveAccount.mockReset();
  replaceTemplate.mockReset();
  parsePriceTiersXlsx.mockReset();

  requireIapSession.mockResolvedValue(ADMIN);
  findAllAccountsPublic.mockResolvedValue([{ id: ACCOUNT_ID, name: "MPT" }]);
  parsePriceTiersXlsx.mockResolvedValue({
    tiers: [],
    territory_count: 0,
    warnings: [],
    rows: [],
  });
  replaceTemplate.mockResolvedValue({
    template_id: "tpl-new",
    scope_type: "ACCOUNT",
    scope_app_id: null,
    scope_account_id: ACCOUNT_ID,
    inserted_entry_count: 0,
    audit_batch_id: "batch-1",
  });
});

describe('POST /api/iap-management/pricing-templates — bí danh scope="GLOBAL" đã gỡ', () => {
  it('scope="GLOBAL" → 400 kèm message đọc được, KHÔNG im lặng', async () => {
    const res = await POST(upload("GLOBAL"));
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error?: string };
    // Không chỉ "có 400" — phải có CHỮ giải thích. Một 400 rỗng trên UI hiện
    // ra là "Upload failed" trống trơn, người bấm không biết vì sao.
    expect(body.error, "400 phải kèm message, không được rỗng").toBeTruthy();
    expect(body.error).toMatch(/scope/i);
    // Message phải nêu ĐÚNG hai giá trị hợp lệ, để người đọc log biết phải
    // gửi gì thay thế.
    expect(body.error).toContain("ACCOUNT");
    expect(body.error).toContain("APP");
  });

  it('scope="GLOBAL" KHÔNG ghi gì — replaceTemplate không được gọi', async () => {
    await POST(upload("GLOBAL"));
    expect(replaceTemplate).not.toHaveBeenCalled();
  });

  it('scope="GLOBAL" KHÔNG âm thầm rơi về account đang active', async () => {
    // Nhánh nguy hiểm nhất nếu bí danh bị gỡ ẩu: chữ lạ rơi qua nhánh
    // ACCOUNT rồi dùng getActiveAccount() làm đích ghi.
    await POST(upload("GLOBAL"));
    expect(getActiveAccount).not.toHaveBeenCalled();
  });

  it('scope="ACCOUNT" vẫn đi qua bình thường — không vạ lây', async () => {
    const res = await POST(upload("ACCOUNT"));
    expect(res.status).toBe(200);
    expect(replaceTemplate).toHaveBeenCalledTimes(1);
    expect(replaceTemplate.mock.calls[0][0]).toEqual({
      kind: "ACCOUNT",
      account_id: ACCOUNT_ID,
    });
  });

  it("scope lạ bất kỳ cũng bị từ chối cùng một cách", async () => {
    for (const bogus of ["", "global", "Account", "DEFAULT", "ACCOUNT "]) {
      replaceTemplate.mockClear();
      const res = await POST(upload(bogus));
      expect(res.status, `scope=${JSON.stringify(bogus)} phải bị từ chối`).toBe(400);
      expect(replaceTemplate).not.toHaveBeenCalled();
    }
  });
});
