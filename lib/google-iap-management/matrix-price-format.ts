/**
 * Glyph của MỘT ô giá trên màn View matrix — một hàm, hai nơi gọi.
 *
 * ─── VÌ SAO NÓ Ở ĐÂY CHỨ KHÔNG PHẢI TRONG MatrixTable ──────────────────────
 *
 * Hàm này vốn nằm private trong `MatrixTable.tsx:18-24`. Nó phải ra khỏi đó vì
 * hai lý do, và lý do thứ hai là lý do BẮT BUỘC:
 *
 *   1. File .xlsx phải vẽ số GIỐNG HỆT màn — đó là nguyên tắc sản phẩm của cả
 *      arc ("file là ảnh chụp của màn"). Chừng nào còn HAI phép hợp thành thì
 *      test parity chỉ đang so writer với chính cách hợp thành của writer, và
 *      KHÔNG chứng minh được file ≡ màn. Hai bản có thể trôi khác nhau mà mọi
 *      test vẫn xanh.
 *
 *   2. ⚠ `MatrixTable.tsx` mở đầu bằng `"use client"`. Writer .xlsx chạy
 *      SERVER-side (exceljs là dependency server-only, KB §4.17). Trong Next 14
 *      App Router, module server import một hàm thường từ module `"use client"`
 *      sẽ nhận về **client-reference proxy chứ không phải hàm** — gọi nó là lỗi
 *      RUNTIME, và `tsc` KHÔNG bắt được vì kiểu khớp hoàn hảo. Đây là bài học
 *      KB §21.3 của arc Apple.
 *
 * ⇒ File này là module THƯỜNG (không `"use client"`). Cả `MatrixTable` (client)
 *   lẫn writer .xlsx (server) đều import từ đây, nên test parity so với hàm
 *   THẬT màn đang gọi chứ không phải với một bản dựng lại.
 *
 * ─── HÀM LÀM GÌ, VÀ KHÔNG LÀM GÌ ───────────────────────────────────────────
 *
 * Đúng phép hợp thành mà màn vẫn dùng: `microsToDecimal` với số chữ số thập
 * phân LẤY THEO CURRENCY. Không phân cách nghìn, không ký hiệu tiền tệ, không
 * làm tròn thêm.
 *
 * ⚠ NHÁNH `catch` KHÔNG THỪA. `price_micros` là cột TEXT không có ràng buộc
 * chữ số (20260520010000_google_iap_mgmt_init.sql), và `microsToDecimal` THROW
 * với chuỗi không khớp `^\d+$` (google/price-conversion.ts:111-113). Màn nuốt
 * lỗi đó và vẽ chuỗi thô; file phải làm y hệt, nếu không thì đúng ô hỏng lại
 * là ô file nói khác màn. Census Q7b đo được 0 dòng như thế trên production.
 *
 * ⚠ Với currency 0 chữ số thập phân (VND · IDR · TWD …), `microsToDecimal`
 * CẮT phần dư (price-conversion.ts:122-124). Đó là hành vi của MÀN, và file
 * bám theo là đúng chủ đích (V4 phương án (a) Manager chốt). Đừng "sửa" ở đây
 * — xem backlog [GOOGLE-micros-truncation].
 */
import { getCurrencyDecimals } from "./google/currency-precision";
import { microsToDecimal } from "./google/price-conversion";

export function formatPrice(priceMicros: string, currency: string): string {
  try {
    return microsToDecimal(priceMicros, getCurrencyDecimals(currency));
  } catch {
    return priceMicros;
  }
}
