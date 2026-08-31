/**
 * C4b — test route matrix-export.
 *
 * Route là chunk rủi ro nhất của arc: nó là chỗ DUY NHẤT nhận dữ liệu từ
 * client. Mọi test ở đây canh đúng một câu hỏi — "thứ client gửi lên có thể
 * làm file khác đi so với màn không?".
 *
 * Writer KHÔNG mock: mỗi request đi qua `writeTemplateMatrixXlsx` thật và trả
 * ra bytes thật, vì phần lớn khẳng định dưới đây là về FILE chứ không về JSON.
 * Chỉ mock những gì chạm I/O ngoài: session, account, app, và hai hàm đọc
 * ma trận.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));

const listAccounts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/google-accounts", () => ({
  listAccounts,
}));

const getAppById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/repository/apps", () => ({ getAppById }));

const readActiveAccountId = vi.hoisted(() => vi.fn());
const resolveActiveAccountId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/active-account", () => ({
  readActiveAccountId,
  resolveActiveAccountId,
}));

const fetchDefaultMatrix = vi.hoisted(() => vi.fn());
const fetchPerAppMatrix = vi.hoisted(() => vi.fn());
vi.mock("@/lib/google-iap-management/queries/template-matrix", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/google-iap-management/queries/template-matrix")
  >("@/lib/google-iap-management/queries/template-matrix");
  return { ...actual, fetchDefaultMatrix, fetchPerAppMatrix };
});

import { POST } from "./route";
import {
  composeMatrix,
  type TemplateEntryRow,
} from "@/lib/google-iap-management/queries/template-matrix";

const ACCOUNT_ID = "acc-1";

function row(
  identifier: string,
  region_code: string,
  currency: string,
  price_micros: string,
): TemplateEntryRow {
  return { identifier, region_code, currency, price_micros };
}

/** Thứ tự nước = thứ tự file .xlsx Manager upload, KHÔNG alphabet. */
const ENTRIES: TemplateEntryRow[] = [
  row("Tier 1", "US", "USD", "990000"),
  row("Tier 1", "VN", "VND", "25000000000"),
  row("Tier 1", "SG", "SGD", "1480000"),
  row("Tier 1", "TH", "THB", "35000000"),
];
const MATRIX = composeMatrix(ENTRIES);
const ALL = ["US", "VN", "SG", "TH"];

function req(body: unknown): Request {
  return new Request("http://localhost/api/google-iap-management/pricing-templates/matrix-export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Request với body KHÔNG phải JSON hợp lệ. */
function rawReq(body: string): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** Bảng {tên part → nội dung} của một .xlsx. Đọc bằng `unzip -p`, không qua
 *  thư viện Excel — cùng kỷ luật với C2. */
async function allParts(res: Response): Promise<Record<string, string>> {
  const dir = mkdtempSync(join(tmpdir(), "route-parts-"));
  const file = join(dir, "a.xlsx");
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const names = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.endsWith("/"));
  const out: Record<string, string> = {};
  for (const n of names) {
    const esc = n.replace(/[[\]*?\\]/g, (ch) => `\\${ch}`);
    const content = execFileSync("unzip", ["-p", file, esc], { encoding: "utf8" });
    if (content.length === 0) throw new Error(`đọc part rỗng: ${n}`);
    out[n] = content;
  }
  return out;
}

/** Giải nén .xlsx từ response và trả về sheet1 + bảng sharedStrings. Đọc
 *  bằng `unzip -p` chứ không qua thư viện Excel — cùng kỷ luật với C2. */
async function readXlsx(res: Response): Promise<{ sheet: string; strings: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "route-xlsx-"));
  const file = join(dir, "a.xlsx");
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const part = (name: string) =>
    execFileSync("unzip", ["-p", file, name], { encoding: "utf8" });
  const strings = [
    ...part("xl/sharedStrings.xml").matchAll(/<si>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/g),
  ].map((m) => m[1]);
  return { sheet: part("xl/worksheets/sheet1.xml"), strings };
}

const okBody = (over: Record<string, unknown> = {}) => ({
  scope: "default",
  regionCodes: ALL,
  showDiff: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getServerSession.mockResolvedValue({ user: { email: "a@b.c" } });
  listAccounts.mockResolvedValue([{ id: ACCOUNT_ID, status: "verified" }]);
  readActiveAccountId.mockReturnValue(ACCOUNT_ID);
  resolveActiveAccountId.mockReturnValue(ACCOUNT_ID);
  fetchDefaultMatrix.mockResolvedValue(MATRIX);
  fetchPerAppMatrix.mockResolvedValue(MATRIX);
  getAppById.mockResolvedValue({
    id: "app-1",
    google_console_account_id: ACCOUNT_ID,
    package_name: "vng.games.lightandnight",
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe("auth", () => {
  it("không có session → 401, và KHÔNG chạm DB", async () => {
    getServerSession.mockResolvedValue(null);
    const res = await POST(req(okBody()));
    expect(res.status).toBe(401);
    expect(fetchDefaultMatrix).not.toHaveBeenCalled();
    expect(listAccounts).not.toHaveBeenCalled();
  });
});

describe("⚠ 4b.4 — payload bẩn: từ chối bằng 400, không ép kiểu", () => {
  it.each([
    { name: "body rỗng", body: {} },
    { name: "scope lạ", body: okBody({ scope: "global" }) },
    { name: "scope thiếu", body: { regionCodes: ALL, showDiff: false } },
    { name: "showDiff là chuỗi", body: okBody({ showDiff: "false" }) },
    { name: "showDiff thiếu", body: { scope: "default", regionCodes: ALL } },
    { name: "regionCodes không phải mảng", body: okBody({ regionCodes: "US" }) },
    { name: "regionCodes là object", body: okBody({ regionCodes: { 0: "US" } }) },
    { name: "phần tử không phải string", body: okBody({ regionCodes: ["US", 7] }) },
    { name: "phần tử là chuỗi rỗng", body: okBody({ regionCodes: ["US", "  "] }) },
    { name: "per-app thiếu appId", body: okBody({ scope: "per-app" }) },
    { name: "per-app appId rỗng", body: okBody({ scope: "per-app", appId: "  " }) },
  ])("$name → 400", async ({ body }) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toHaveProperty("error");
    // Không request nào trong nhóm này được phép chạm tới tầng đọc dữ liệu.
    expect(fetchDefaultMatrix).not.toHaveBeenCalled();
    expect(fetchPerAppMatrix).not.toHaveBeenCalled();
  });

  it("JSON hỏng → 400 'Invalid JSON body.'", async () => {
    const res = await POST(rawReq("{not json"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid JSON body." });
  });

  it("body là MẢNG → 400 (typeof [] === 'object', dễ lọt)", async () => {
    const res = await POST(rawReq(JSON.stringify(["US"])));
    expect(res.status).toBe(400);
  });

  it("⚠ showDiff='false' KHÔNG bị ép thành true bằng truthiness", async () => {
    // Nếu ép, file sẽ tô amber trong khi người dùng vừa TẮT công tắc — đúng
    // lớp lỗi F1 mà cả arc này sinh ra để gỡ.
    const res = await POST(req(okBody({ showDiff: "false" })));
    expect(res.status).toBe(400);
  });
});

describe("⚠ regionCodes rỗng → 400, KHÔNG phải 'export tất cả'", () => {
  it("[] bị từ chối và không sinh file nào", async () => {
    const res = await POST(req(okBody({ regionCodes: [] })));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/No markets selected/i);
    expect(fetchDefaultMatrix).not.toHaveBeenCalled();
  });
});

describe("⚠ mã lạ → 409 NÊU TÊN, không im lặng bỏ", () => {
  it("409 kèm danh sách mã, không phải số đếm", async () => {
    const res = await POST(req(okBody({ regionCodes: ["US", "KH", "MM"] })));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; unknownRegionCodes: string[] };
    expect(body.unknownRegionCodes).toEqual(["KH", "MM"]);
    // ⚠ TÊN chứ không phải đếm: "2 mã lạ" không nói được gì.
    expect(body.error).toContain("KH, MM");
    expect(body.error).not.toMatch(/\b2 (unknown|region)/i);
  });

  it("mã lạ KHÔNG bị lặng lẽ bỏ để xuất file thiếu cột", async () => {
    const res = await POST(req(okBody({ regionCodes: ["US", "ZZ"] })));
    expect(res.status).toBe(409);
    expect(res.headers.get("Content-Type")).not.toContain("spreadsheet");
  });
});

describe("⚠ regionCodes LÀ BỘ LỌC, KHÔNG BAO GIỜ LÀ THỨ TỰ", () => {
  /**
   * ⚠ SO TỪNG PART, KHÔNG SO BUFFER THÔ — và đây là một giới hạn ĐÃ ĐO chứ
   * không phải một phép so lỏng tay.
   *
   * Bản đầu của test này so `Buffer.equals` và FLAKY 1/3 lần chạy full suite.
   * Đo ra hai nguồn phi-tất-định, cả hai đều là dấu thời gian:
   *   1. `docProps/core.xml` — exceljs đóng `dcterms:created/modified` bằng
   *      giờ hiện tại. ĐÃ GHIM về epoch trong writer, nay giống hệt.
   *   2. mtime của từng entry trong VỎ ZIP — tầng zip của exceljs đóng, không
   *      phơi API nào để chỉnh. ZIP lưu DOS time granularity 2 giây nên hai
   *      request cách nhau đủ lâu rơi vào hai ô khác nhau.
   * Sau khi ghim (1), MỌI PART giống hệt và tổng kích thước bằng nhau; chỉ
   * còn (2) làm bytes thô khác.
   *
   * ⇒ Tính chất đúng và kiểm được là "mọi part byte-identical". Nó vẫn bắt
   *   trọn thứ cần bắt: một thay đổi thứ tự cột nằm trong `sheet1.xml`.
   */
  async function expectSamePartsAcross(responses: Response[]) {
    const parts = await Promise.all(responses.map(allParts));
    const base = parts[0];
    for (const other of parts.slice(1)) {
      expect(Object.keys(other).sort()).toEqual(Object.keys(base).sort());
      for (const name of Object.keys(base)) {
        expect(other[name], `part ${name} khác nhau`).toBe(base[name]);
      }
    }
  }

  it("mảng XÁO TRỘN → mọi part byte-identical", async () => {
    const a = await POST(req(okBody({ regionCodes: ["US", "VN", "SG", "TH"] })));
    const b = await POST(req(okBody({ regionCodes: ["TH", "SG", "VN", "US"] })));
    const c = await POST(req(okBody({ regionCodes: ["SG", "US", "TH", "VN"] })));
    expect(a.status).toBe(200);
    await expectSamePartsAcross([a, b, c]);
  });

  it("mã lặp không làm đổi file (khử trùng lặp trước khi đếm)", async () => {
    const a = await POST(req(okBody({ regionCodes: ALL })));
    const b = await POST(req(okBody({ regionCodes: ["US", "US", "VN", "SG", "TH", "VN"] })));
    expect(b.status).toBe(200);
    await expectSamePartsAcross([a, b]);
  });

  it("lọc bớt nước → ít cột hơn, và thứ tự là US-rồi-TH chứ không TH-rồi-US", async () => {
    // Client gửi ["TH","US"]; file phải theo thứ tự `matrix.markets` (US trước).
    const res = await POST(req(okBody({ regionCodes: ["TH", "US"] })));
    expect(res.status).toBe(200);
    const { sheet, strings } = await readXlsx(res);

    // Tier + 2 nước × 2 = 5 cột; 2 hàng header + 1 tier = 3 hàng.
    expect(sheet).toContain('<dimension ref="A1:E3"/>');

    // Hai ô header tên nước là B1 và D1 — đọc qua sharedStrings.
    const nameAt = (ref: string) => {
      const m = sheet.match(new RegExp(`<c r="${ref}"[^>]*t="s"[^>]*><v>(\\d+)</v>`));
      // `throw` thay `expect(...).not.toBeNull()` + `!`: cùng thông báo khi
      // hỏng, nhưng kiểu thu hẹp được nên không cần non-null assertion.
      if (!m) throw new Error(`ô ${ref} không phải shared string`);
      return strings[Number(m[1])];
    };
    expect([nameAt("B1"), nameAt("D1")]).toEqual(["United States", "Thailand"]);
  });
});

describe("⚠ account đọc SERVER-SIDE, không lấy từ body", () => {
  it("accountId trong body bị BỎ QUA — resolver vẫn quyết định", async () => {
    const res = await POST(
      req(okBody({ accountId: "acc-KHAC", account_id: "acc-KHAC" })),
    );
    expect(res.status).toBe(200);
    // Resolver được gọi với danh sách account thật + cookie, không với body.
    expect(resolveActiveAccountId).toHaveBeenCalledWith(
      [{ id: ACCOUNT_ID, status: "verified" }],
      ACCOUNT_ID,
    );
  });

  it("không có account nào cấu hình → 400", async () => {
    listAccounts.mockResolvedValue([]);
    resolveActiveAccountId.mockReturnValue(null);
    const res = await POST(req(okBody()));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("No Google Console accounts configured"),
    });
  });

  it("⚠ per-app: app thuộc account KHÁC → 404, không lộ sự tồn tại", async () => {
    getAppById.mockResolvedValue({
      id: "app-1",
      google_console_account_id: "acc-KHAC",
      package_name: "com.other.app",
    });
    const res = await POST(req(okBody({ scope: "per-app", appId: "app-1" })));
    expect(res.status).toBe(404);
    expect(fetchPerAppMatrix).not.toHaveBeenCalled();
  });
});

describe("không có template → 404", () => {
  it("Default chưa upload", async () => {
    fetchDefaultMatrix.mockResolvedValue(null);
    const res = await POST(req(okBody()));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("No Default template"),
    });
  });

  it("Per-App chưa upload", async () => {
    fetchPerAppMatrix.mockResolvedValue(null);
    const res = await POST(req(okBody({ scope: "per-app", appId: "app-1" })));
    expect(res.status).toBe(404);
  });
});

describe("phản hồi thành công", () => {
  it("200, đúng MIME, Content-Disposition, X-Truncated-Cells", async () => {
    const res = await POST(req(okBody()));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="google-pricing-template-default-\d{8}-\d{4}\.xlsx"$/,
    );
    expect(res.headers.get("X-Truncated-Cells")).toBe("0");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("X-Truncated-Cells đếm thật, không hardcode 0", async () => {
    fetchDefaultMatrix.mockResolvedValue(
      composeMatrix([
        row("Tier 1", "VN", "VND", "25000500000"), // ⚠ 0 chữ số + có dư
        row("Tier 1", "US", "USD", "990000"),
      ]),
    );
    const res = await POST(req(okBody({ regionCodes: ["VN", "US"] })));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Truncated-Cells")).toBe("1");
  });

  it("per-app: tên file mang package slug", async () => {
    const res = await POST(req(okBody({ scope: "per-app", appId: "app-1" })));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(
      "google-pricing-template-per-app-vng.games.lightandnight-",
    );
  });

  it("body là file .xlsx thật (chữ ký ZIP PK)", async () => {
    const res = await POST(req(okBody()));
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(buf.byteLength).toBeGreaterThan(1000);
  });
});

describe("⚠ BẢO MẬT — package_name không tách được Content-Disposition", () => {
  // Đây là TẦNG 2 của bản thay thế cho test bảo mật của `csvFilename`
  // ("sanitises unsafe filename characters in the package slug") sắp xoá ở C5.
  // Tầng 1 là test của chính `templateMatrixXlsxFilename`.
  it.each([
    'evil"\r\nSet-Cookie: a=b',
    "a\r\nContent-Length: 0",
    'x"; filename="other.xlsx',
    "../../etc/passwd",
  ])("package_name %j không sinh header nhiều dòng", async (bad) => {
    getAppById.mockResolvedValue({
      id: "app-1",
      google_console_account_id: ACCOUNT_ID,
      package_name: bad,
    });
    const res = await POST(req(okBody({ scope: "per-app", appId: "app-1" })));
    expect(res.status).toBe(200);
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).not.toMatch(/[\r\n]/);
    // Đúng HAI dấu nháy kép: mở và đóng quanh tên file, không hơn.
    expect((cd.match(/"/g) ?? []).length).toBe(2);
    // ⚠ KHÔNG khẳng định "chuỗi Set-Cookie không xuất hiện": sau khi sanitise,
    // nó còn lại như VĂN BẢN trong tên file (`evil_Set-Cookie_a_b`) và ở đó
    // nó vô hại — nguy hiểm là TÁCH ĐƯỢC HEADER, không phải chứa chữ đó.
    // Hai khẳng định ở trên (không CR/LF, đúng 2 dấu nháy) mới là tính chất
    // thật. Thêm: `/` bị loại nên path traversal không đi được vào tên file.
    expect(cd).not.toContain("/");
  });
});

describe("⚠ COUNT ASSERT — thà 500 còn hơn file thiếu cột", () => {
  it("writer trả về ít cột hơn số nước đã xin → 500, không phục vụ file", async () => {
    // Dựng ca không thể xảy ra qua đường bình thường (mã lạ đã bị 409 chặn),
    // đúng vai của một assert: bắt cái lẽ ra không xảy ra. Ở đây ép bằng cách
    // cho `markets` chứa MÃ TRÙNG — filter khớp 2, nhưng Set requested chỉ có 1.
    const weird = composeMatrix([row("Tier 1", "US", "USD", "990000")]);
    weird.markets = [...weird.markets, { ...weird.markets[0] }];
    fetchDefaultMatrix.mockResolvedValue(weird);
    const res = await POST(req(okBody({ regionCodes: ["US"] })));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/dropped columns|short file/i);
  });
});
