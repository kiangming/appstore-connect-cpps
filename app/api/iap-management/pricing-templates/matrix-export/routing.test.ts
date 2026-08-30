/**
 * C3.2 — `matrix-export` là SIBLING TĨNH của `[templateId]`. Đừng tin, hãy đo.
 *
 * Next ưu tiên segment tĩnh trước segment động, nên `/matrix-export` không
 * rơi vào `[templateId]`. Đó là hành vi có tài liệu — và một hành vi có tài
 * liệu vẫn là một giả định cho tới khi có gì đó đỏ được khi nó sai.
 *
 * File này canh bằng HAI tầng, có chủ đích:
 *
 *   TẦNG 1 — CẤU TRÚC, luôn chạy. Kể cả nếu Next có đổi ý về thứ tự ưu tiên,
 *   một POST vẫn KHÔNG THỂ bị route động phục vụ, vì route động không export
 *   POST. Đây là tính chất thật sự bảo vệ được, và nó không cần build.
 *
 *   TẦNG 2 — MANIFEST SAU BUILD. `.next/server/app-paths-manifest.json` là
 *   thứ Next thực sự biên dịch ra, không phải thứ ta tin nó làm. Chỉ chạy khi
 *   đã build (vitest sẽ báo SKIP chứ không lặng lẽ xanh) — pre-push checklist
 *   chạy build ở bước 4 nên nó luôn được kiểm trước khi push.
 *
 * ⚠ Hình dạng này đã sống sẵn trong repo: phía Google,
 * `pricing-templates/availability/` là sibling tĩnh của
 * `pricing-templates/[id]/` và cả hai có mặt riêng trong manifest. Tầng 2
 * khẳng định luôn điều đó, để nếu tiền lệ ấy mất thì ta biết.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MATRIX_EXPORT = "app/api/iap-management/pricing-templates/matrix-export/route.ts";
const TEMPLATE_ID = "app/api/iap-management/pricing-templates/[templateId]/route.ts";
const MANIFEST = join(ROOT, ".next/server/app-paths-manifest.json");

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("⚠ C3.2 tầng 1 — cấu trúc: POST không thể rơi vào route động", () => {
  it("matrix-export có route.ts riêng và nó export POST", () => {
    expect(existsSync(join(ROOT, MATRIX_EXPORT))).toBe(true);
    expect(read(MATRIX_EXPORT)).toMatch(/export async function POST\b/);
  });

  it("⚠ [templateId] KHÔNG export POST — nên không có handler nào để rơi vào", () => {
    // Đây là điều làm cho câu "tĩnh thắng động" thành ra không cần thiết
    // phải đúng: kể cả khi nó sai, kết quả xấu nhất là 405, không bao giờ là
    // một handler khác chạy với `templateId = "matrix-export"`.
    const code = read(TEMPLATE_ID);
    expect(code).not.toMatch(/export async function POST\b/);
    expect(code).not.toMatch(/export async function GET\b/);
    expect(code).toMatch(/export async function DELETE\b/);
  });

  it("hai route là hai file khác nhau, không phải một file dùng chung", () => {
    expect(read(MATRIX_EXPORT)).not.toBe(read(TEMPLATE_ID));
    expect(read(MATRIX_EXPORT)).toContain("matrix-export");
  });
});

describe("⚠ C3.2 tầng 2 — manifest sau build: Next biên dịch ra route riêng", () => {
  const built = existsSync(MANIFEST);
  const manifest = (): Record<string, string> =>
    JSON.parse(readFileSync(MANIFEST, "utf8"));

  it.skipIf(!built)(
    "manifest có key riêng cho /matrix-export, trỏ tới đúng file của nó",
    () => {
      const m = manifest();
      const key = "/api/iap-management/pricing-templates/matrix-export/route";
      expect(Object.keys(m)).toContain(key);
      expect(m[key]).toBe(
        "app/api/iap-management/pricing-templates/matrix-export/route.js",
      );
    },
  );

  it.skipIf(!built)("route động vẫn tồn tại riêng, không bị nuốt", () => {
    const m = manifest();
    expect(Object.keys(m)).toContain(
      "/api/iap-management/pricing-templates/[templateId]/route",
    );
    // Hai key, hai file — không key nào trỏ vào file của key kia.
    expect(m["/api/iap-management/pricing-templates/[templateId]/route"]).not.toBe(
      m["/api/iap-management/pricing-templates/matrix-export/route"],
    );
  });

  it.skipIf(!built)(
    "tiền lệ phía Google vẫn còn: availability là sibling tĩnh của [id]",
    () => {
      // Nếu tiền lệ này biến mất thì lập luận trong header route cần viết lại,
      // nên nó được canh chứ không chỉ được nhắc tới.
      const keys = Object.keys(manifest());
      expect(keys).toContain(
        "/api/google-iap-management/pricing-templates/availability/route",
      );
      expect(keys).toContain("/api/google-iap-management/pricing-templates/[id]/route");
    },
  );
});
