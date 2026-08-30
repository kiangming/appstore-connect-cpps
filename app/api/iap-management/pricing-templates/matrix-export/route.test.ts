/**
 * C3 — route xuất ma trận, ĐI QUA RANH GIỚI HTTP.
 *
 * ⚠ VÌ SAO PHẢI QUA HTTP CHỨ KHÔNG GỌI HÀM. LAYER-GAP #5 (KB §4.14): một
 * tính năng hoàn chỉnh từng nằm chết sau một zod enum cũ ở tầng route, hai
 * chunk liền không ai biết, vì mọi test bên dưới đều gọi thẳng orchestrator.
 * Test hai phía của một schema không chứng minh gì về schema. Nên ở đây mọi
 * ca đều dựng `Request` thật rồi gọi `POST(req)`.
 *
 * SEAM. `fetchDefaultMatrix` / `fetchPerAppMatrix` được mock — DB là thứ
 * không có ở đây. Mọi thứ dưới nó chạy THẬT: `composeMatrix` dựng fixture,
 * `buildTemplateMatrixWorkbook` ghi workbook thật, và các ca về thứ tự cột
 * đọc lại chính bytes trong response. Nghĩa là một route sai không thể được
 * một stub đồng loã.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";

import {
  composeMatrix,
  type MatrixData,
  type TemplateEntryRow,
} from "@/lib/iap-management/queries/template-matrix";

const requireIapSession = vi.hoisted(() => vi.fn());
const IapUnauthorizedError = vi.hoisted(
  () =>
    class extends Error {
      constructor() {
        super("Unauthorized");
      }
    },
);
vi.mock("@/lib/iap-management/auth", () => ({
  requireIapSession,
  IapUnauthorizedError,
}));

const getActiveAccount = vi.hoisted(() => vi.fn());
vi.mock("@/lib/get-active-account", () => ({ getActiveAccount }));

const fetchDefaultMatrix = vi.hoisted(() => vi.fn());
const fetchPerAppMatrix = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/queries/template-matrix", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/iap-management/queries/template-matrix")>(
      "@/lib/iap-management/queries/template-matrix",
    );
  return { ...actual, fetchDefaultMatrix, fetchPerAppMatrix };
});

const maybeSingle = vi.hoisted(() => vi.fn());
vi.mock("@/lib/iap-management/db", () => ({
  iapDb: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  }),
}));

vi.mock("@/lib/logger", () => ({ log: vi.fn() }));

import { POST } from "./route";

// ─── fixtures ────────────────────────────────────────────────────────────────

function row(
  tier_id: string,
  territory_code: string,
  currency_code: string,
  customer_price: number,
): TemplateEntryRow {
  return { tier_id, territory_code, currency_code, customer_price, proceeds: null };
}

const TIER_NAMES = new Map([
  ["TIER_2", "Tier 2"],
  ["TIER_10", "Tier 10"],
]);

/**
 * ⚠ Thứ tự nước cố ý KHÔNG phải alphabet: VNM → USA → THA. Theo tên đầy đủ,
 * alphabet sẽ là Thailand, United States, Vietnam — khác hẳn, nên mọi test về
 * thứ tự dưới đây phân biệt được "lấy từ matrix" với "lấy từ client" hay
 * "sắp lại cho gọn".
 */
const MATRIX: MatrixData = composeMatrix({
  entries: [
    row("TIER_2", "VNM", "VND", 49000),
    row("TIER_2", "USA", "USD", 1.99),
    row("TIER_2", "THA", "THB", 69),
    row("TIER_10", "VNM", "VND", 490000),
  ],
  tierNames: TIER_NAMES,
});

const ALL = ["VNM", "USA", "THA"];

function post(body: unknown, opts: { raw?: string } = {}) {
  return POST(
    new Request("http://localhost/api/iap-management/pricing-templates/matrix-export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: opts.raw ?? JSON.stringify(body),
    }),
  );
}

/**
 * Đọc lại workbook từ chính bytes của response.
 *
 * ⚠ Ghi ra đĩa rồi `readFile` chứ không `load(Buffer)`: kiểu `Buffer` của
 * @types/node hiện tại (`Buffer<ArrayBuffer>`) không gán được cho kiểu
 * `Buffer` mà exceljs khai, và cách duy nhất để `load` biên dịch được là một
 * phép cast — tức là tắt đúng thứ đang bảo vệ mình. Đi qua file cũng trung
 * thực hơn: nó kiểm chính bytes mà trình duyệt sẽ nhận.
 */
async function workbookOf(res: Response): Promise<ExcelJS.Worksheet> {
  const dir = mkdtempSync(join(tmpdir(), "iap-matrix-route-"));
  const file = join(dir, "out.xlsx");
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  requireIapSession.mockResolvedValue({ user: { email: "a@b.c" } });
  getActiveAccount.mockResolvedValue({ id: "acct-server-side" });
  fetchDefaultMatrix.mockResolvedValue({ matrix: MATRIX, header: {} });
  fetchPerAppMatrix.mockResolvedValue({ matrix: MATRIX, header: {} });
  maybeSingle.mockResolvedValue({ data: { bundle_id: "com.vng.demo" }, error: null });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("chưa đăng nhập → 401, không đụng tới DB", async () => {
    requireIapSession.mockRejectedValue(new IapUnauthorizedError());
    const res = await post({ scope: "default", territories: ALL, showDiff: false });
    expect(res.status).toBe(401);
    expect(fetchDefaultMatrix).not.toHaveBeenCalled();
  });
});

describe("⚠ C3.3 — payload bẩn bị từ chối ở ranh giới, không bị ép kiểu", () => {
  const cases: Array<[string, unknown]> = [
    ["scope lạ", { scope: "global", territories: ALL, showDiff: false }],
    ["scope thiếu", { territories: ALL, showDiff: false }],
    ["showDiff là chuỗi", { scope: "default", territories: ALL, showDiff: "false" }],
    ["showDiff thiếu", { scope: "default", territories: ALL }],
    ["territories không phải mảng", { scope: "default", territories: "VNM", showDiff: false }],
    ["territories chứa số", { scope: "default", territories: ["VNM", 7], showDiff: false }],
    ["territories chứa chuỗi rỗng", { scope: "default", territories: ["VNM", "  "], showDiff: false }],
    ["per-app thiếu appId", { scope: "per-app", territories: ALL, showDiff: false }],
    ["per-app appId rỗng", { scope: "per-app", appId: "  ", territories: ALL, showDiff: false }],
  ];
  for (const [name, body] of cases) {
    it(`${name} → 400`, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    });
  }

  it("body rỗng → 400", async () => {
    const res = await post(undefined, { raw: "" });
    expect(res.status).toBe(400);
  });

  it("body không phải JSON → 400", async () => {
    const res = await post(undefined, { raw: "{nope" });
    expect(res.status).toBe(400);
  });

  it("body là mảng → 400", async () => {
    const res = await post([]);
    expect(res.status).toBe(400);
  });

  it('⚠ showDiff="false" KHÔNG được truthy-ép thành true', async () => {
    // Nếu route dùng `Boolean(showDiff)` thì chuỗi "false" thành true và file
    // được tô cam ngay sau khi người dùng vừa tắt highlight.
    const res = await post({ scope: "default", territories: ALL, showDiff: "false" });
    expect(res.status).toBe(400);
  });
});

describe("⚠ C3.3 — territories: [] là 400, KHÔNG phải 'xuất tất cả'", () => {
  it("mảng rỗng → 400 và KHÔNG sinh file nào", async () => {
    const res = await post({ scope: "default", territories: [], showDiff: false });
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("mảng rỗng KHÔNG được hiểu thành cả 3 nước của ma trận", async () => {
    // Chứng âm trực diện của mutation "[] → export tất cả".
    const res = await post({ scope: "default", territories: [], showDiff: false });
    expect(res.status).not.toBe(200);
    expect(res.headers.get("X-Export-Territory-Count")).toBeNull();
  });
});

describe("⚠ C3.3 — mã lạ → 409 kèm danh sách mã, KHÔNG im lặng bỏ", () => {
  it("một mã không có trong matrix → 409", async () => {
    const res = await post({
      scope: "default",
      territories: [...ALL, "PRT"],
      showDiff: false,
    });
    expect(res.status).toBe(409);
  });

  it("thân lỗi LIỆT KÊ mã, không phải đếm (KB §4.21)", async () => {
    const res = await post({
      scope: "default",
      territories: ["VNM", "PRT", "ITA"],
      showDiff: false,
    });
    const body = (await res.json()) as { error: string; unknownTerritories: string[] };
    expect(body.unknownTerritories).toEqual(["PRT", "ITA"]);
    expect(body.error).toContain("PRT");
    expect(body.error).toContain("ITA");
    expect(body.error).not.toMatch(/\b2 unknown\b/);
  });

  it("⚠ KHÔNG trả 200 với file thiếu cột — đó chính là silent drop", async () => {
    const res = await post({
      scope: "default",
      territories: ["VNM", "PRT"],
      showDiff: false,
    });
    expect(res.status).not.toBe(200);
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });
});

describe("⚠ C3.3 — territories là BỘ LỌC, thứ tự luôn từ matrix.markets (M-c)", () => {
  it("client gửi mảng XÁO TRỘN → cột trong file vẫn theo thứ tự matrix", async () => {
    // matrix.markets = [VNM, USA, THA]. Client gửi ngược lại hoàn toàn.
    const res = await post({
      scope: "default",
      territories: ["THA", "USA", "VNM"],
      showDiff: false,
    });
    expect(res.status).toBe(200);
    const ws = await workbookOf(res);
    expect([ws.getCell(1, 2).value, ws.getCell(1, 4).value, ws.getCell(1, 6).value]).toEqual(
      ["Vietnam", "United States", "Thailand"],
    );
  });

  it("mảng xáo trộn khác → vẫn CÙNG một thứ tự file", async () => {
    // Hai hoán vị khác nhau phải cho ra hai file bố cục giống hệt nhau, nếu
    // không thì hai lần export cùng một dữ liệu không so sánh được với nhau.
    const res = await post({
      scope: "default",
      territories: ["USA", "THA", "VNM"],
      showDiff: false,
    });
    const ws = await workbookOf(res);
    expect([ws.getCell(1, 2).value, ws.getCell(1, 4).value, ws.getCell(1, 6).value]).toEqual(
      ["Vietnam", "United States", "Thailand"],
    );
  });

  it("lọc bớt: thứ tự phần còn lại vẫn theo matrix, không theo client", async () => {
    const res = await post({
      scope: "default",
      territories: ["THA", "VNM"], // client đảo; matrix có VNM trước THA
      showDiff: false,
    });
    const ws = await workbookOf(res);
    expect(ws.columnCount).toBe(1 + 2 * 2);
    expect([ws.getCell(1, 2).value, ws.getCell(1, 4).value]).toEqual([
      "Vietnam",
      "Thailand",
    ]);
  });

  it("mã lặp không nhân đôi cột", async () => {
    const res = await post({
      scope: "default",
      territories: ["VNM", "VNM", "USA"],
      showDiff: false,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Export-Territory-Count")).toBe("2");
    expect((await workbookOf(res)).columnCount).toBe(1 + 2 * 2);
  });
});

describe("⚠ C3.3 — account đọc SERVER-SIDE, không nhận từ client (M-d)", () => {
  it("getActiveAccount được gọi và id của nó đi vào query", async () => {
    await post({ scope: "default", territories: ALL, showDiff: false });
    expect(getActiveAccount).toHaveBeenCalledTimes(1);
    expect(fetchDefaultMatrix).toHaveBeenCalledWith("acct-server-side");
  });

  it("per-app: account vẫn từ server, appId từ client", async () => {
    await post({
      scope: "per-app",
      appId: "app-uuid-1",
      territories: ALL,
      showDiff: true,
    });
    expect(fetchPerAppMatrix).toHaveBeenCalledWith("app-uuid-1", "acct-server-side");
  });

  it("⚠ accountId client gửi kèm bị BỎ QUA hoàn toàn", async () => {
    await post({
      scope: "default",
      territories: ALL,
      showDiff: false,
      accountId: "acct-KE-GIAN",
    });
    expect(fetchDefaultMatrix).toHaveBeenCalledWith("acct-server-side");
    expect(fetchDefaultMatrix).not.toHaveBeenCalledWith("acct-KE-GIAN");
  });
});

describe("⚠ C3.3 — phép ĐẾM cột (KB §4.20)", () => {
  it("số cột ghi ra = số mã đã lọc", async () => {
    const res = await post({ scope: "default", territories: ["VNM", "USA"], showDiff: false });
    expect(res.headers.get("X-Export-Territory-Count")).toBe("2");
    expect((await workbookOf(res)).columnCount).toBe(1 + 2 * 2);
  });

  it("bộ lọc đánh rơi/nhân bản cột → throw, KHÔNG ghi file thiếu cột", async () => {
    // Dựng một MatrixData có hai market TRÙNG mã — composeMatrix không bao giờ
    // sinh ra thứ này, nên đây là cách duy nhất chạm được vào cái chốt đếm.
    // Không có chốt đó thì filter trả 2 cột cho 1 mã và file lặng lẽ sai.
    fetchDefaultMatrix.mockResolvedValue({
      matrix: {
        ...MATRIX,
        markets: [MATRIX.markets[0], MATRIX.markets[0]],
      },
      header: {},
    });
    const res = await post({ scope: "default", territories: ["VNM"], showDiff: false });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("dropped columns");
  });
});

describe("không có template → 404", () => {
  it("default: chưa upload → 404, không phải file rỗng", async () => {
    fetchDefaultMatrix.mockResolvedValue(null);
    const res = await post({ scope: "default", territories: ALL, showDiff: false });
    expect(res.status).toBe(404);
  });

  it("per-app: chưa upload → 404", async () => {
    fetchPerAppMatrix.mockResolvedValue(null);
    const res = await post({
      scope: "per-app",
      appId: "app-uuid-1",
      territories: ALL,
      showDiff: false,
    });
    expect(res.status).toBe(404);
  });
});

describe("⚠ C3.4 — response: bytes .xlsx + Content-Disposition", () => {
  it("Content-Type là xlsx và thân là một workbook đọc được", async () => {
    const res = await post({ scope: "default", territories: ALL, showDiff: false });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    // ⚠ Nếu thiếu `await workbook.xlsx.writeBuffer()` thì thân sẽ là chuỗi
    // "[object Promise]" và ExcelJS.load ném ngay ở đây.
    const ws = await workbookOf(res);
    expect(ws.getCell(1, 1).value).toBe("Tier");
  });

  it("tên file Default theo quy ước cũ, đổi đuôi .xlsx", async () => {
    const res = await post({ scope: "default", territories: ALL, showDiff: false });
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="apple-pricing-template-default-\d{8}-\d{4}\.xlsx"$/,
    );
  });

  it("tên file Per-App mang bundle_id đọc từ SERVER", async () => {
    maybeSingle.mockResolvedValue({ data: { bundle_id: "com.vng.demo" }, error: null });
    const res = await post({
      scope: "per-app",
      appId: "app-uuid-1",
      territories: ALL,
      showDiff: true,
    });
    expect(res.headers.get("Content-Disposition")).toMatch(
      /filename="apple-pricing-template-per-app-com\.vng\.demo-\d{8}-\d{4}\.xlsx"$/,
    );
  });

  it("⚠ BẢO MẬT — bundle_id bẩn bị khử trước khi vào Content-Disposition", async () => {
    // Bản thay cho test #11 của csv-export.test.ts. Nó sống ở HAI chỗ: hàm
    // thuần được canh ở C1 (`templateMatrixXlsxFilename` — 3 test), còn đây
    // là chỗ canh rằng ROUTE thật sự đi qua hàm đó. Một dấu `"` lọt vào header
    // sẽ cắt đôi Content-Disposition.
    maybeSingle.mockResolvedValue({
      data: { bundle_id: 'com/bad name"; drop' },
      error: null,
    });
    const res = await post({
      scope: "per-app",
      appId: "app-uuid-1",
      territories: ALL,
      showDiff: false,
    });
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).not.toContain('name"');
    expect(cd).toMatch(/filename="apple-pricing-template-per-app-com_bad_name_[^"]*\.xlsx"$/);
    // đúng hai dấu nháy: mở và đóng filename.
    expect(cd.split('"').length - 1).toBe(2);
  });

  it("header đếm: tier + territory", async () => {
    const res = await post({ scope: "default", territories: ["VNM"], showDiff: false });
    expect(res.headers.get("X-Export-Tier-Count")).toBe("2");
    expect(res.headers.get("X-Export-Territory-Count")).toBe("1");
  });
});

describe("showDiff đi thẳng tới writer (F1 ở tầng route)", () => {
  const DIFFED = composeMatrix({
    entries: [row("TIER_2", "VNM", "VND", 55000)],
    tierNames: TIER_NAMES,
    defaultEntries: [row("TIER_2", "VNM", "VND", 49000)],
  });

  it("showDiff=false → file không có ô cam", async () => {
    fetchPerAppMatrix.mockResolvedValue({ matrix: DIFFED, header: {} });
    const res = await post({
      scope: "per-app",
      appId: "a",
      territories: ["VNM"],
      showDiff: false,
    });
    const ws = await workbookOf(res);
    expect(ws.getCell(3, 2).font?.color?.argb).toBeUndefined();
  });

  it("showDiff=true → file có ô cam", async () => {
    fetchPerAppMatrix.mockResolvedValue({ matrix: DIFFED, header: {} });
    const res = await post({
      scope: "per-app",
      appId: "a",
      territories: ["VNM"],
      showDiff: true,
    });
    const ws = await workbookOf(res);
    expect(ws.getCell(3, 2).font?.color?.argb).toBe("FFB45309");
  });
});
