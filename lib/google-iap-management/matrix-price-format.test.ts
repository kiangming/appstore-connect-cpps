/**
 * C3 — test cho module glyph dùng chung, và GUARD CẤU TRÚC cho bẫy KB §21.3.
 *
 * Hàm này là điểm nối duy nhất giữa màn (client) và writer .xlsx (server).
 * Test hành vi ở đây; bằng chứng CẢ HAI bên thật sự gọi nó nằm ở đột biến
 * (đổi thân hàm → đỏ ở MatrixTable.test.tsx, xlsx-template-matrix-export.test.ts
 * và xlsx-template-matrix-file.test.ts cùng lúc).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { formatPrice } from "./matrix-price-format";

describe("formatPrice — phép hợp thành mà màn và file dùng chung", () => {
  it.each([
    // Giá trị thật từ 2 file CSV Manager gửi.
    { micros: "990000", currency: "USD", glyph: "0.99" },
    { micros: "4900000", currency: "MYR", glyph: "4.90" }, // ⚠ số 0 cuối
    { micros: "35000000", currency: "THB", glyph: "35.00" }, // ⚠ hai số 0
    { micros: "8000000", currency: "HKD", glyph: "8.00" },
    { micros: "49000000", currency: "PHP", glyph: "49.00" },
    { micros: "1480000", currency: "SGD", glyph: "1.48" },
    { micros: "390000", currency: "MMK", glyph: "0.39" },
    { micros: "25000000000", currency: "VND", glyph: "25000" }, // 0 chữ số
    { micros: "16000000000", currency: "IDR", glyph: "16000" },
    { micros: "33000000", currency: "TWD", glyph: "33" },
    { micros: "1990000", currency: "BHD", glyph: "1.990" }, // 3 chữ số
  ])("$currency $micros → $glyph", ({ micros, currency, glyph }) => {
    expect(formatPrice(micros, currency)).toBe(glyph);
  });

  it("currency 2 chữ số + micros có dư: KHÔNG cắt (nhánh fracRest)", () => {
    expect(formatPrice("4901234", "MYR")).toBe("4.901234");
  });

  it("⚠ currency 0 chữ số + micros có dư: CẮT phần dư — hành vi của MÀN", () => {
    // Không phải lỗi của hàm này: `microsToDecimal(m, 0)` trả phần nguyên
    // (price-conversion.ts:122-124) và màn vẫn luôn vẽ như thế. File bám theo
    // là chủ đích (V4 phương án (a)). Xem backlog [GOOGLE-micros-truncation].
    expect(formatPrice("25000500000", "VND")).toBe("25000");
    expect(formatPrice("33700000", "TWD")).toBe("33");
  });

  it("price_micros hỏng → trả CHUỖI THÔ, không throw (nhánh catch)", () => {
    expect(formatPrice("not-a-number", "USD")).toBe("not-a-number");
    expect(formatPrice("", "USD")).toBe("");
    expect(formatPrice("-1", "USD")).toBe("-1");
  });

  it("currency lạ → mặc định 2 chữ số, không throw", () => {
    expect(formatPrice("1990000", "ZZZ")).toBe("1.99");
  });
});

describe("⚠ GUARD CẤU TRÚC — bẫy KB §21.3", () => {
  const SELF = join(process.cwd(), "lib/google-iap-management/matrix-price-format.ts");

  it("module này KHÔNG được mang chỉ thị \"use client\"", () => {
    // Nếu nó thành module client, writer .xlsx (chạy server) sẽ nhận về
    // client-reference proxy chứ không phải hàm — gọi là lỗi RUNTIME, và
    // `tsc` KHÔNG bắt vì kiểu khớp hoàn hảo. Đó chính là lý do hàm phải rời
    // khỏi `MatrixTable.tsx`; để nó trôi ngược lại thì công cốc.
    const src = readFileSync(SELF, "utf8");
    expect(src).not.toMatch(/^\s*["']use client["']/m);
  });

  it("module này chỉ import từ `lib/`, không import từ `components/`", () => {
    // Chiều an toàn là components → lib. Chiều ngược lại kéo module client
    // vào đồ thị của server và tái lập đúng cái bẫy trên.
    const src = readFileSync(SELF, "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/(^|\/)components\//);
      expect(spec.startsWith("@/components")).toBe(false);
    }
  });
});
