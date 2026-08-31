/**
 * G1b · B5 — HÀNG RÀO: mọi truy cập THẲNG vào hai bảng template phải nằm
 * trong đúng hai file `queries/`.
 *
 * ⚠ VAI CỦA HÀNG RÀO NÀY LÀ **GIỮ**, KHÔNG PHẢI **TÌM**. Đây là điểm
 *   khác Apple, và đừng mượn kỳ vọng của Apple sang đây.
 *   Census (2026-08-30) và một phép đo lại độc lập ở B0 đều cho cùng kết
 *   quả: 24/24 chỗ chạm hai bảng ĐÃ nằm trong hai file queries/ — module
 *   Google chưa từng có query inline ở tầng page/route. Bên Apple hàng
 *   rào tương ứng được viết để TÌM RA những chỗ vi phạm đang tồn tại;
 *   ở đây không có gì để tìm.
 *
 *   Nói cách khác: nếu file này ĐỎ, đó KHÔNG phải "hàng rào phát hiện nợ
 *   kỹ thuật cũ" — đó là "vừa có người mở một đường đọc mới đi vòng qua
 *   `applyScopeFilter`". Từ G1b, đi vòng qua choke point nghĩa là đọc
 *   template mà không lọc account.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠ ALLOW-LIST TƯỜNG MINH. Thêm tên vào đây là một quyết định thiết kế,
 *   không phải một thao tác sửa test cho xanh. Xem test "không nới
 *   allow-list" ngay dưới.
 */
const ALLOWED = [
  "lib/google-iap-management/queries/templates.ts",
  "lib/google-iap-management/queries/template-matrix.ts",
] as const;

const ROOTS = [
  "lib/google-iap-management",
  "app/api/google-iap-management",
  "app/(dashboard)/google-iap-management",
  "components/google-iap-management",
];

const TABLE_ACCESS = /\.from\(\s*["'](pricing_templates|pricing_template_entries)["']\s*\)/;

function walk(dir: string, out: string[] = []): string[] {
  let items: string[];
  try {
    items = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of items) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

function offendingFiles(): string[] {
  const hits: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      // File test và fixture được loại: chúng GIẢ LẬP bảng chứ không đọc
      // thật, và chính chúng là thứ chứng minh choke point còn răng.
      if (/\.test\.tsx?$/.test(file) || file.includes("__fixtures__")) continue;
      if (ALLOWED.includes(file as (typeof ALLOWED)[number])) continue;
      if (TABLE_ACCESS.test(readFileSync(file, "utf-8"))) hits.push(file);
    }
  }
  return hits;
}

describe("B5 — hàng rào truy cập bảng template", () => {
  it("phép đo tự chứng minh nó đọc được thật (không phải quét vào chỗ trống)", () => {
    // Một hàng rào quét 0 file luôn XANH và không canh gì cả. Chốt chặn
    // này làm cái xanh giả đó thành đỏ.
    const scanned = ROOTS.flatMap((r) => walk(r));
    expect(scanned.length).toBeGreaterThan(50);

    // Và nó phải thật sự khớp được mẫu nó đi tìm — kiểm trên chính hai
    // file trong allow-list.
    for (const allowed of ALLOWED) {
      expect(TABLE_ACCESS.test(readFileSync(allowed, "utf-8"))).toBe(true);
    }
  });

  it("không file nào NGOÀI allow-list chạm thẳng hai bảng", () => {
    expect(offendingFiles()).toEqual([]);
  });

  it("không nới allow-list: đúng HAI file, đúng hai tên đó", () => {
    // ⚠ Chốt chặn thật sự của B5. Không có nó, cách dễ nhất để làm test
    //   trên xanh trở lại là thêm file mới vào ALLOWED — tức là hợp thức
    //   hoá đúng thứ hàng rào sinh ra để chặn. Nới danh sách này phải là
    //   một sửa đổi CÓ Ý, đọc được trong diff.
    expect([...ALLOWED]).toEqual([
      "lib/google-iap-management/queries/templates.ts",
      "lib/google-iap-management/queries/template-matrix.ts",
    ]);
    expect(ALLOWED).toHaveLength(2);
  });
});
