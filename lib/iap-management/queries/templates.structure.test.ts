/**
 * Pricing templates — STRUCTURAL fitness test (C-B, [ACCOUNT-default-template]).
 *
 * ─── VÌ SAO TEST NÀY TỒN TẠI ───────────────────────────────────────────────
 *
 * C-A siết chữ ký: mọi hàm đọc template mặc định BẮT BUỘC nhận `accountId`,
 * nên `tsc` bắt được 12 call site. Nhưng nó bỏ lọt đúng MỘT đường, và bỏ lọt
 * một cách có hệ thống chứ không phải ngẫu nhiên:
 *
 *     app/(dashboard)/iap-management/settings/pricing-tiers/
 *       per-app-matrix/[appId]/page.tsx  →  defaultTemplateExists()
 *         iapDb().from("price_tier_templates").eq("scope_type", "GLOBAL")
 *
 * Nó gọi thẳng supabase. Không hàm nào, không kiểu nào để `tsc` bám vào —
 * siết bao nhiêu chữ ký cũng không chạm tới được. Sau C-A nó vẫn xanh, và
 * cái xanh đó là bằng chứng cho sự tồn tại của file này.
 *
 * Nguy hiểm của nó không phải "code xấu": sau C-C, câu hỏi đúng là "ACCOUNT
 * NÀY đã có template chưa". Một query hỏi `scope_type='GLOBAL'` sau khi M-2
 * xoá dòng GLOBAL sẽ trả `false` cho MỌI account — im lặng, và UI sẽ nói
 * "chưa có template" trong khi có đủ cả sáu.
 *
 * ─── ĐIỀU TEST NÀY ÉP ──────────────────────────────────────────────────────
 *
 * Hai bảng `price_tier_templates` và `price_tier_template_entries` chỉ được
 * chạm từ các file trong ALLOW bên dưới. Mọi nơi khác phải đi qua helper —
 * và helper thì có `accountId` trong chữ ký, tức quay về địa hạt của `tsc`.
 *
 * ⚠ ALLOW là DANH SÁCH TƯỜNG MINH, không phải heuristic ("file nào trong
 *   thư mục queries/", "file nào tên *repository*"). Heuristic sẽ tự động
 *   kết nạp file mới — mà bắt file MỚI mới là việc chính của test này.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..", "..");

/**
 * Hai file DUY NHẤT được phép chạm hai bảng.
 *
 * ⚠ Thêm một dòng vào đây là một quyết định thiết kế, không phải một bước
 *   sửa test cho xanh. Câu hỏi phải trả lời trước khi thêm: "chỗ này lấy
 *   accountId ở đâu, và vì sao nó không thể đi qua helper?"
 *
 * ⚠ KHÔNG thêm route/page vào danh sách này. Một allow-list có route trong
 *   đó là lời mời cho route thứ hai. Route DELETE từng query thẳng bảng và
 *   đã được chuyển sang `getTemplateScopeById()` chính vì lẽ đó.
 */
const ALLOW = [
  "lib/iap-management/queries/templates.ts",
  "lib/iap-management/queries/template-matrix.ts",
] as const;

/** Hai bảng Apple. KHÔNG bao gồm bảng của Google
 *  (google_iap_mgmt.pricing_templates / pricing_template_entries) — module
 *  riêng, schema riêng, guard riêng nếu sau này cần. */
const TABLES = ["price_tier_templates", "price_tier_template_entries"] as const;

/** `.from("<table>")` — đúng cách supabase-js mở một truy vấn. */
function tableAccessPattern(table: string): RegExp {
  return new RegExp(String.raw`\.from\(\s*["'\`]${table}["'\`]\s*\)`, "g");
}

/**
 * Mọi file nguồn không-phải-test dưới lib/ app/ components/ types/.
 *
 * File test bị loại có chủ ý: test mock `iapDb()` và dựng chuỗi truy vấn giả
 * để kiểm chính lớp repository — cấm chúng nhắc tên bảng là cấm chỗ đang
 * kiểm bảng.
 */
function allSourceFiles(): string[] {
  const roots = ["lib", "app", "components", "types"];
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (
        (full.endsWith(".ts") || full.endsWith(".tsx")) &&
        !full.endsWith(".test.ts") &&
        !full.endsWith(".test.tsx")
      ) {
        out.push(full.slice(ROOT.length + 1));
      }
    }
  };
  for (const r of roots) walk(join(ROOT, r));
  return out;
}

/** Nguồn đã gỡ comment: một comment nhắc tên bảng (chính file này khuyến
 *  khích viết) không được tính là truy cập. */
function readCodeOnly(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

interface Hit {
  file: string;
  table: string;
  count: number;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of allSourceFiles()) {
    const code = readCodeOnly(file);
    for (const table of TABLES) {
      const n = code.match(tableAccessPattern(table))?.length ?? 0;
      if (n > 0) hits.push({ file, table, count: n });
    }
  }
  return hits;
}

describe("price_tier_templates — chỉ repository được chạm bảng", () => {
  /**
   * ⚠ SELF-CHECK. Một scanner âm thầm ngừng khớp sẽ tìm thấy 0 vi phạm và
   * PASS RỖNG — đúng bẫy mà KB §9 P2 mô tả cho guard action_type. Nên trước
   * khi khẳng định "không ai vi phạm", phải chứng minh scanner còn nhìn thấy
   * những truy cập mà ta BIẾT là có.
   */
  it("scanner còn hoạt động: thấy truy cập trong CẢ HAI file repository", () => {
    const hits = scan();
    for (const allowed of ALLOW) {
      const found = hits.filter((h) => h.file === allowed);
      expect(
        found.length,
        `SELF-CHECK HỎNG: không thấy truy cập bảng nào trong ${allowed}. ` +
          `Hoặc file đã đổi tên/bị xoá, hoặc regex đã ngừng khớp — và khi đó ` +
          `phép kiểm bên dưới PASS RỖNG, không chứng minh gì cả.`,
      ).toBeGreaterThan(0);
    }
  });

  it("scanner nhìn thấy cả hai bảng, không chỉ bảng header", () => {
    const hits = scan();
    for (const table of TABLES) {
      expect(
        hits.filter((h) => h.table === table).length,
        `SELF-CHECK HỎNG: 0 truy cập tới ${table} trong toàn bộ source. ` +
          `Bảng entries từng KHÔNG được census soi — nếu regex của nó chết ` +
          `thì một query inline chạm entries sẽ lọt hoàn toàn.`,
      ).toBeGreaterThan(0);
    }
  });

  it("không file nào ngoài ALLOW chạm hai bảng", () => {
    const offenders = scan().filter(
      (h) => !(ALLOW as readonly string[]).includes(h.file),
    );

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : "\n\nTRUY CẬP THẲNG BẢNG NGOÀI REPOSITORY:\n" +
          offenders
            .map((o) => `  ${o.file}  →  .from("${o.table}")  ×${o.count}`)
            .join("\n") +
          "\n\nĐi qua helper trong lib/iap-management/queries/templates.ts:\n" +
          "  đọc header/entries  → getDefaultTemplate(accountId) | getAppTemplate(appId)\n" +
          "  chỉ cần tồn tại?    → templateExists(scope)\n" +
          "  chỉ cần đếm?        → getTemplateSummary(scope)\n" +
          "  tra theo id?        → getTemplateScopeById(templateId)\n" +
          "  ma trận?            → fetchDefaultMatrix(accountId) | fetchPerAppMatrix(appId, accountId)\n\n" +
          "Vì sao: query inline không có chữ ký, nên tsc không bắt được khi\n" +
          "ngữ nghĩa 'template mặc định' đổi từ GLOBAL sang theo-account.\n" +
          "Đúng một đường như thế đã lọt qua C-A — xem đầu file test này.\n",
    ).toEqual([]);
  });

  it("ALLOW không chứa route hay page", () => {
    for (const allowed of ALLOW) {
      expect(
        allowed.startsWith("lib/"),
        `ALLOW chứa "${allowed}" — không phải file lib/. Route và page phải ` +
          `đi qua repository; xem ghi chú ở khai báo ALLOW.`,
      ).toBe(true);
    }
  });
});
