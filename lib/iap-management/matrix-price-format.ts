/**
 * Glyph của MỘT ô giá trên màn View matrix — một hàm, hai nơi gọi.
 *
 * ─── VÌ SAO NÓ Ở ĐÂY CHỨ KHÔNG PHẢI TRONG MatrixTable ──────────────────────
 *
 * Hàm này vốn nằm private trong `MatrixTable.tsx`. Nó phải ra khỏi đó vì hai
 * lý do, và lý do thứ hai là lý do bắt buộc:
 *
 *   1. Note trên ô khác-Default trong file .xlsx là bản sao của tooltip trên
 *      màn, nên hai bên phải vẽ số GIỐNG HỆT nhau. Chép hàm sang chỗ khác là
 *      cách chắc chắn nhất để sáu tháng nữa chúng khác nhau.
 *   2. ⚠ `MatrixTable.tsx` mở đầu bằng `"use client"`. Writer .xlsx chạy
 *      SERVER-side (KB §4.17 — exceljs là dependency server-only). Trong
 *      Next 14 App Router, module server import một hàm thường từ module
 *      `"use client"` sẽ nhận về client-reference proxy chứ không phải hàm —
 *      gọi nó là lỗi runtime, và là lỗi chỉ lộ ra khi build/chạy thật chứ
 *      không phải khi `tsc`. Census xác nhận trong repo KHÔNG có tiền lệ nào
 *      `lib/` import từ một module `"use client"`; `territory-name.ts` mà
 *      `queries/template-matrix.ts` vẫn import là module THƯỜNG, không phải
 *      ngoại lệ cho quy tắc này.
 *
 * ⇒ File này là module thường. Cả `MatrixTable` (client) lẫn writer .xlsx
 *   (server) đều import từ đây, nên test parity so với hàm THẬT của màn chứ
 *   không phải với một bản chép.
 *
 * ─── HÀM LÀM GÌ, VÀ KHÔNG LÀM GÌ ───────────────────────────────────────────
 *
 * `toFixed(4)` rồi cắt số 0 vô nghĩa ở đuôi: `25000.0000` → `"25000"`,
 * `0.9900` → `"0.99"`. Cột DB là `NUMERIC(18,4)` nên `toFixed(4)` là CHÍNH
 * XÁC TUYỆT ĐỐI — đây là cắt số 0 thừa, KHÔNG phải làm tròn. Không có dấu
 * phân cách nghìn, không có ký hiệu tiền tệ.
 *
 * ⚠ Trong file .xlsx, ô giá được ghi bằng SỐ THÔ, không đi qua hàm này —
 * Excel tự vẽ bằng format General, và bảng đo đã xác nhận General cho ra
 * đúng glyph này trên mọi giá trị đại diện. Hàm này chỉ dùng cho phần CHỮ:
 * tooltip trên màn và note trong ô .xlsx.
 */
export function formatPrice(value: number | string): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toFixed(4).replace(/\.?0+$/, "");
}
