/**
 * C4b.3 — `matrix-export` là SIBLING TĨNH của `[id]`. Đừng tin, hãy đo.
 *
 * Next ưu tiên segment tĩnh trước segment động, nên `/matrix-export` không rơi
 * vào `[id]`. Đó là hành vi có tài liệu — và một hành vi có tài liệu vẫn là
 * một giả định cho tới khi có gì đó đỏ được khi nó sai.
 *
 * Canh bằng HAI tầng, có chủ đích:
 *
 *   TẦNG 1 — CẤU TRÚC, luôn chạy, không cần build. Kể cả nếu Next đổi ý về
 *   thứ tự ưu tiên, một POST vẫn KHÔNG THỂ bị route động phục vụ, vì route
 *   động không export POST. Đây là tính chất thật sự bảo vệ được: kết quả xấu
 *   nhất là 405, không bao giờ là một handler khác chạy với `id =
 *   "matrix-export"` rồi đi xoá template.
 *
 *   TẦNG 2 — MANIFEST SAU BUILD. `.next/server/app-paths-manifest.json` là thứ
 *   Next thực sự biên dịch ra, không phải thứ ta tin nó làm. Chỉ chạy khi đã
 *   build — và khi chưa build thì vitest báo **SKIP nhìn thấy được**, không
 *   lặng lẽ xanh. Pre-push checklist chạy `npm run build` ở bước 4 nên tầng
 *   này luôn được kiểm trước khi push.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIR = "app/api/google-iap-management/pricing-templates";
const MATRIX_EXPORT = `${DIR}/matrix-export/route.ts`;
const DYNAMIC_ID = `${DIR}/[id]/route.ts`;
const MANIFEST = join(ROOT, ".next/server/app-paths-manifest.json");

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("⚠ C4b.3 tầng 1 — cấu trúc: POST không thể rơi vào route động", () => {
  it("matrix-export có route.ts riêng và nó export POST", () => {
    expect(existsSync(join(ROOT, MATRIX_EXPORT))).toBe(true);
    expect(read(MATRIX_EXPORT)).toMatch(/export async function POST\b/);
  });

  it("⚠ [id] KHÔNG export POST — nên không có handler nào để rơi vào", () => {
    const code = read(DYNAMIC_ID);
    expect(code).not.toMatch(/export async function POST\b/);
    expect(code).not.toMatch(/export async function GET\b/);
    expect(code).toMatch(/export async function DELETE\b/);
  });

  it("hai route là hai file khác nhau", () => {
    expect(read(MATRIX_EXPORT)).not.toBe(read(DYNAMIC_ID));
    expect(read(MATRIX_EXPORT)).toContain("matrix-export");
  });

  it("route mới khai runtime nodejs — exceljs không chạy trên edge", () => {
    expect(read(MATRIX_EXPORT)).toMatch(/export const runtime = "nodejs"/);
  });
});

describe("⚠ C4b.3 tầng 2 — manifest sau build: Next biên dịch ra route riêng", () => {
  /**
   * ⚠ "TỒN TẠI" KHÔNG ĐỦ — PHẢI "MỚI HƠN ROUTE".
   *
   * Gặp thật khi viết chunk này: `.next/` còn từ lần build trước, nên
   * `existsSync` = true và tầng 2 CHẠY — trên một manifest chưa hề biết route
   * mới. Kết quả là ĐỎ GIẢ.
   *
   * Chiều ngược lại còn tệ hơn và im lặng: xoá một route rồi chạy test mà
   * không build lại, manifest cũ vẫn còn key đó ⇒ tầng 2 XANH GIẢ. Cùng một
   * họ lỗi với `git diff` trên file untracked và `unzip -p` trả rỗng — công
   * cụ dùng để KIỂM phải tự chứng minh nó đang đọc thứ nó nói là đang đọc.
   *
   * ⇒ Điều kiện chạy là mtime(manifest) ≥ mtime(route.ts). Manifest cũ ⇒ SKIP
   *   nhìn thấy được, không đỏ giả và không xanh giả. `npm run build` (bước 4
   *   của pre-push checklist) luôn làm nó mới lại.
   */
  const mtime = (p: string) => statSync(p).mtimeMs;
  const built =
    existsSync(MANIFEST) && mtime(MANIFEST) >= mtime(join(ROOT, MATRIX_EXPORT));
  const manifest = (): Record<string, string> =>
    JSON.parse(readFileSync(MANIFEST, "utf8"));

  it("manifest phải MỚI HƠN route thì tầng 2 mới có nghĩa", () => {
    // Test này LUÔN chạy và chỉ ghi lại trạng thái, để lần chạy nào cũng nói
    // rõ tầng 2 có hiệu lực hay không — thay vì để ba dòng SKIP im lìm.
    expect(typeof built).toBe("boolean");
    if (!built) {
      console.warn(
        "[routing.test] manifest thiếu hoặc cũ hơn route.ts — tầng 2 SKIP. " +
          "Chạy `npm run build` để kiểm tầng này.",
      );
    }
  });
  const key = (seg: string) =>
    `/api/google-iap-management/pricing-templates/${seg}/route`;

  it.skipIf(!built)(
    "manifest có key riêng cho /matrix-export, trỏ tới đúng file của nó",
    () => {
      const m = manifest();
      expect(Object.keys(m)).toContain(key("matrix-export"));
      expect(m[key("matrix-export")]).toBe(
        "app/api/google-iap-management/pricing-templates/matrix-export/route.js",
      );
    },
  );

  it.skipIf(!built)("route động [id] vẫn tồn tại riêng, không bị nuốt", () => {
    const m = manifest();
    expect(Object.keys(m)).toContain(key("[id]"));
    // Hai key, hai file — không key nào trỏ vào file của key kia.
    expect(m[key("[id]")]).not.toBe(m[key("matrix-export")]);
  });

  it.skipIf(!built)(
    "tiền lệ cùng thư mục vẫn còn: availability + tier-entries cũng là sibling tĩnh",
    () => {
      // Lập luận trong header route dựa vào tiền lệ này. Nếu nó biến mất thì
      // lập luận cần viết lại, nên nó được canh chứ không chỉ được nhắc tới.
      const keys = Object.keys(manifest());
      expect(keys).toContain(key("availability"));
      expect(keys).toContain(key("tier-entries"));
      expect(keys).toContain(key("[id]"));
    },
  );
});
