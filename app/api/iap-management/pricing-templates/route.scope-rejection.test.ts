/**
 * [ACCOUNT-default-template] chunk 2.1 + 2.6 — HAI NHƯỢNG BỘ BACK-COMPAT
 * CỦA C-C, GỠ CÙNG NHAU.
 *
 * Cả hai sinh ra cùng lúc, cùng lý do ("tab trình duyệt mở từ trước lúc
 * deploy C-C không upload hỏng"), nên cùng hết hạn lúc deploy xong:
 *   • bí danh `scope="GLOBAL"`  → chunk 2.1
 *   • fallback account_id thiếu → chunk 2.6
 * Gỡ một nửa cửa sổ là không gỡ, nên hai bộ khẳng định ở cùng một file.
 *
 * ── PHẦN 1 — BÍ DANH scope="GLOBAL" ĐÃ GỠ.
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
 *
 * ── PHẦN 2 — FALLBACK account_id ĐÃ GỠ (chunk 2.6).
 *
 * Nhượng bộ này NGUY HIỂM HƠN bí danh GLOBAL, và đáng nói ra vì sao: bí
 * danh chỉ chấp nhận một chữ thừa rồi làm ĐÚNG việc; fallback thì làm SAI
 * việc — nó ghi vào account đang active ở TopNav khi client định nói một
 * account khác. Tab Default cho phép xem account B trong khi TopNav là A,
 * nên "rơi về active" chính là ca ghi đè 1140 ô thật của A, im lặng, và
 * bản mất là bản Manager đang không mở.
 *
 * Chốt kiểm nặng nhất ở phần này KHÔNG phải mã 400 — mà là
 * `getActiveAccount` KHÔNG ĐƯỢC GỌI. Một route trả 400 sau khi đã hỏi
 * account active vẫn còn nhánh đó sống; chỉ lời gọi vắng mặt mới chứng
 * minh nhánh đã chết.
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
/** Account đang active ở TopNav — KHÁC account client chỉ định, cố ý. */
const ACTIVE_ACCOUNT_ID = "acct-active-KHAC";

/**
 * accountId = null ⇒ KHÔNG gửi trường account_id (ca của chunk 2.6).
 * ⚠ Sentinel là `null`, KHÔNG phải `undefined`: truyền `undefined` tường
 *   minh vào một tham số có giá trị mặc định thì JS KÍCH HOẠT giá trị mặc
 *   định, nên `upload("ACCOUNT", undefined)` vẫn gửi account_id và bài test
 *   "thiếu account_id" lại đo đúng ca CÓ account_id. Đã dẫm phải một lần.
 */
function upload(scope: string, accountId: string | null = ACCOUNT_ID): Request {
  const fd = new FormData();
  fd.append("file", new File(["x"], "default.xlsx"));
  fd.append("scope", scope);
  if (accountId !== null) fd.append("account_id", accountId);
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
  findAllAccountsPublic.mockResolvedValue([
    { id: ACCOUNT_ID, name: "MPT" },
    { id: ACTIVE_ACCOUNT_ID, name: "NCV" },
  ]);
  // ⚠ getActiveAccount PHẢI trả một account dùng được, dù đường sống không
  //   bao giờ gọi tới nó. Lý do là chuyện của mutation testing: nếu mock trả
  //   undefined thì route có nhánh fallback sẽ SẬP với "Cannot read
  //   properties of undefined" — vẫn đỏ, nhưng đỏ vì tai nạn, và output
  //   không nói được ca hỏng thật. Với mock dùng được, route mang fallback
  //   chạy TRỌN VẸN và ghi vào ACTIVE_ACCOUNT_ID — đúng ca production —
  //   nên khẳng định mới là thứ nổ, kèm câu chữ giải thích.
  //   Id cố ý KHÁC ACCOUNT_ID: giống nhau thì "ghi nhầm chỗ" vô hình.
  getActiveAccount.mockResolvedValue({ id: ACTIVE_ACCOUNT_ID, name: "NCV" });
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

describe("POST /api/iap-management/pricing-templates — fallback account_id đã gỡ (2.6)", () => {
  const NOT_INFERRED =
    "route ghi vào ACCOUNT ĐANG ACTIVE thay vì account client chỉ định — " +
    "đó chính là ca ghi đè 1140 ô của một account Manager đang không nhìn, " +
    "im lặng. Nhánh fallback phải chết hẳn, không phải chết nửa vời.";

  it("thiếu hẳn account_id → 400 kèm message nêu rõ trường nào thiếu", async () => {
    const res = await POST(upload("ACCOUNT", null));
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error?: string };
    expect(body.error, "400 phải kèm message, không được rỗng").toBeTruthy();
    expect(body.error).toContain("account_id");
    // Message phải nói ra CA HỎNG, không chỉ nói "thiếu trường". Người đọc
    // log cần biết vì sao route không tự đoán giúp.
    expect(body.error).toMatch(/never inferred|active account/i);
  });

  it("⚠ thiếu account_id thì KHÔNG hỏi getActiveAccount", async () => {
    await POST(upload("ACCOUNT", null));
    expect(getActiveAccount, NOT_INFERRED).not.toHaveBeenCalled();
  });

  it("thiếu account_id thì KHÔNG ghi gì — replaceTemplate không được gọi", async () => {
    await POST(upload("ACCOUNT", null));
    expect(replaceTemplate, NOT_INFERRED).not.toHaveBeenCalled();
    // Nếu có ghi, ghi vào đâu là thông tin quan trọng nhất trong output —
    // nêu đích danh để người đọc thấy ngay đó là account KHÁC.
    expect(
      replaceTemplate.mock.calls.map((c) => c[0]),
      `KHÔNG được ghi gì. Nếu thấy { kind: "ACCOUNT", account_id: ` +
        `"${ACTIVE_ACCOUNT_ID}" } ở đây thì đó là account ĐANG ACTIVE, ` +
        `không phải account nào client yêu cầu — ${NOT_INFERRED}`,
    ).toEqual([]);
  });

  it('account_id = "" bị từ chối y như thiếu hẳn', async () => {
    // Chuỗi rỗng lọt qua `typeof x === "string"` ở khâu đọc form nhưng là
    // FALSY ở khâu kiểm — nếu ai đó đổi `!accountIdField` thành một phép so
    // sánh với undefined, ca này lặng lẽ quay lại nhánh active.
    const res = await POST(upload("ACCOUNT", ""));
    expect(res.status).toBe(400);
    expect(getActiveAccount, NOT_INFERRED).not.toHaveBeenCalled();
    expect(replaceTemplate).not.toHaveBeenCalled();
  });

  it("account_id lạ (không có trong danh sách thật) → 400, vẫn không suy đoán", async () => {
    const res = await POST(upload("ACCOUNT", "acct-khong-ton-tai"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("acct-khong-ton-tai");
    expect(getActiveAccount, NOT_INFERRED).not.toHaveBeenCalled();
    expect(replaceTemplate).not.toHaveBeenCalled();
  });

  it("scope=APP KHÔNG cần account_id — không vạ lây sang nhánh còn lại", async () => {
    // Hai caller thật (PerAppTemplateTab, AppPricingTemplateSection) gửi
    // scope=APP và không bao giờ gửi account_id. Nếu khâu kiểm bị đặt nhầm
    // chỗ (trước phép rẽ nhánh scope) thì cả hai đứt.
    const fd = new FormData();
    fd.append("file", new File(["x"], "app.xlsx"));
    fd.append("scope", "APP");
    fd.append("app_id", "internal-uuid-1");
    const res = await POST(
      new Request("http://localhost/api/iap-management/pricing-templates", {
        method: "POST",
        body: fd,
      }),
    );
    expect(res.status).toBe(200);
    expect(replaceTemplate.mock.calls[0][0]).toEqual({
      kind: "APP",
      app_id: "internal-uuid-1",
    });
  });
});
