/**
 * G1c · C5 — biến thể modal xác nhận Replace.
 *
 * ⚠ Test này tồn tại để chặn ĐÚNG MỘT phép "sửa cho gọn" rất dễ xảy ra:
 *   thay `origin_note !== null` bằng `uploaded_by === "SYSTEM_MIGRATION"`.
 *   Hai biểu thức đó TRÙNG NHAU trên dữ liệu ngay sau migration, nên một
 *   test chỉ dùng fixture "bản sao chuẩn" sẽ XANH cho cả hai. Fixture bên
 *   dưới cố ý tách chúng ra.
 */
import { describe, it, expect } from "vitest";
import { replaceConfirmVariant } from "./replace-confirm";

describe("C5 — phân biệt bản sao migration với bản người thật upload", () => {
  it("bản do migration nhân bản → biến thể xanh", () => {
    expect(
      replaceConfirmVariant({ origin_note: "Bản sao tự động (G1/M-1)…" }),
    ).toBe("untouched-clone");
  });

  it("bản người thật upload → biến thể đỏ", () => {
    expect(replaceConfirmVariant({ origin_note: null })).toBe(
      "human-authored",
    );
  });

  it("⚠ uploaded_by='SYSTEM_MIGRATION' mà origin_note=NULL vẫn là BẢN NGƯỜI THẬT", () => {
    // Ca tách hai biểu thức. `uploaded_by` là email người dùng nhập được;
    // một người trùng đúng chuỗi đó KHÔNG được biến bản của họ thành
    // "bản máy sinh" rồi bị ghi đè dưới nhãn màu xanh.
    expect(
      replaceConfirmVariant({
        origin_note: null,
        // @ts-expect-error — cột này CỐ Ý không nằm trong tham số của hàm;
        // để ở đây làm chứng rằng hàm không hề nhìn tới nó.
        uploaded_by: "SYSTEM_MIGRATION",
      }),
    ).toBe("human-authored");
  });

  it("⚠ origin_note CÒN mà uploaded_by là người thật vẫn là BẢN SAO", () => {
    // Ca tách theo chiều ngược lại.
    expect(
      replaceConfirmVariant({
        origin_note: "Bản sao tự động (G1/M-1)…",
        // @ts-expect-error — xem chú thích trên.
        uploaded_by: "minhgv@vng.com.vn",
      }),
    ).toBe("untouched-clone");
  });

  it("chuỗi rỗng vẫn là 'đã có dấu vết' — chỉ NULL mới là bản người thật", () => {
    expect(replaceConfirmVariant({ origin_note: "" })).toBe("untouched-clone");
  });
});
