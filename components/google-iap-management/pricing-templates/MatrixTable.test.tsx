// @vitest-environment jsdom
/**
 * C3 — test cho MÀN View matrix, và là NỬA CÒN LẠI của phép chứng minh
 * "file ≡ màn".
 *
 * ─── VÌ SAO FILE NÀY PHẢI TỒN TẠI ──────────────────────────────────────────
 *
 * Trước C3 có HAI phép hợp thành glyph: một trong writer .xlsx, một private
 * trong `MatrixTable.tsx`. Cả hai cùng gọi `microsToDecimal` +
 * `getCurrencyDecimals`, nên nhìn thì giống — nhưng **phép hợp thành là hai
 * bản**. Hệ quả: test parity của writer (C1) chỉ đang so writer với CHÍNH
 * cách hợp thành của writer. Nó KHÔNG chứng minh được file giống màn; hai bản
 * hoàn toàn có thể trôi khác nhau mà mọi test vẫn xanh.
 *
 * C3 gộp về `lib/google-iap-management/matrix-price-format.ts`. Bằng chứng
 * việc gộp là THẬT nằm ở đột biến: đổi thân hàm chung phải làm ĐỎ **cả** test
 * ở đây **lẫn** test của writer. Nếu chỉ một bên đỏ thì vẫn còn hai bản.
 *
 * ⇒ Vì thế mọi assertion về con số ở đây đều so với `formatPrice` NHẬP TỪ
 *   MODULE CHUNG, không phải với chuỗi gõ tay — chuỗi gõ tay sẽ giữ nguyên
 *   khi thân hàm đổi, và đột biến sẽ không bắt được.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { MatrixTable } from "./MatrixTable";
import { formatPrice } from "@/lib/google-iap-management/matrix-price-format";
import {
  composeMatrix,
  type TemplateEntryRow,
} from "@/lib/google-iap-management/queries/template-matrix";

function row(
  identifier: string,
  region_code: string,
  currency: string,
  price_micros: string,
): TemplateEntryRow {
  return { identifier, region_code, currency, price_micros };
}

/** Giá trị THẬT từ file CSV Manager gửi, chọn đúng những ca mà phép hợp thành
 *  quyết định kết quả:
 *    MYR 4900000     → "4.90"  — số 0 cuối, ca 376/846 ô mà General làm hỏng
 *    THB 35000000    → "35.00" — mất CẢ HAI chữ số thập phân nếu sai
 *    VND 25000000000 → "25000" — currency 0 chữ số
 *    USD 990000      → "0.99"  — không có gì đặc biệt, đối chứng
 */
const ENTRIES: TemplateEntryRow[] = [
  row("Tier 1", "US", "USD", "990000"),
  row("Tier 1", "MY", "MYR", "4900000"),
  row("Tier 1", "TH", "THB", "35000000"),
  row("Tier 1", "VN", "VND", "25000000000"),
  // Tier 2 chỉ có US ⇒ 3 ô thưa.
  row("Tier 2", "US", "USD", "1990000"),
];

const MATRIX = composeMatrix(ENTRIES);

function renderTable(showDiff = false, matrix = MATRIX) {
  return render(
    <MatrixTable
      matrix={matrix}
      visibleMarkets={matrix.markets}
      showDiff={showDiff}
    />,
  );
}

/** Ô (tier, region) trên màn, lấy theo vị trí cột — `visibleMarkets` giữ
 *  nguyên thứ tự `matrix.markets`. */
function cellText(tier: string, regionCode: string, matrix = MATRIX): string {
  const rowEl = screen.getByRole("row", { name: new RegExp(`^${tier}\\b`) });
  const cells = within(rowEl).getAllByRole("cell");
  const idx = matrix.markets.findIndex((m) => m.code === regionCode);
  expect(idx, `không thấy cột ${regionCode}`).toBeGreaterThanOrEqual(0);
  return cells[idx].textContent ?? "";
}

describe("MatrixTable — glyph đến từ MODULE CHUNG", () => {
  it.each([
    { region: "US", micros: "990000", currency: "USD" },
    { region: "MY", micros: "4900000", currency: "MYR" },
    { region: "TH", micros: "35000000", currency: "THB" },
    { region: "VN", micros: "25000000000", currency: "VND" },
  ])(
    "$region — màn vẽ ĐÚNG formatPrice($micros, $currency)",
    ({ region, micros, currency }) => {
      renderTable();
      // ⚠ So với hàm CHUNG, không với chuỗi gõ tay. Gõ tay "4.90" vào đây sẽ
      // làm đột biến thân hàm không bắt được — test vẫn xanh vì cả hai vế
      // đều đứng yên.
      expect(cellText("Tier 1", region)).toBe(formatPrice(micros, currency));
    },
  );

  it("số 0 cuối phần thập phân được giữ — đây là ca 376/846 ô", () => {
    renderTable();
    // Khẳng định phụ, bằng chuỗi tường minh, để người đọc thấy giá trị thật
    // mà không phải chạy hàm trong đầu. Khẳng định CHÍNH là test ở trên.
    expect(cellText("Tier 1", "MY")).toBe("4.90");
    expect(cellText("Tier 1", "TH")).toBe("35.00");
  });

  it("currency 0 chữ số thập phân không có phần thập phân", () => {
    renderTable();
    expect(cellText("Tier 1", "VN")).toBe("25000");
  });

  it("price_micros hỏng → màn vẽ CHUỖI THÔ (nhánh catch của hàm chung)", () => {
    // Cột price_micros là TEXT không ràng buộc chữ số. Nhánh này là thứ file
    // .xlsx cũng phải bắt chước, nên nó phải nằm trong hàm chung chứ không
    // phải trong một bản riêng của màn.
    const matrix = composeMatrix([row("Tier 1", "US", "USD", "not-a-number")]);
    renderTable(false, matrix);
    expect(cellText("Tier 1", "US", matrix)).toBe(
      formatPrice("not-a-number", "USD"),
    );
    expect(cellText("Tier 1", "US", matrix)).toBe("not-a-number");
  });
});

describe("MatrixTable — quy ước màn mà file phải bắt chước", () => {
  it("ô thưa vẽ '·' (U+00B7)", () => {
    renderTable();
    const text = cellText("Tier 2", "VN");
    expect(text).toBe("·");
    expect(text.codePointAt(0)).toBe(0x00b7);
  });

  it("showDiff=false → không ★, không chữ amber", () => {
    const matrix = composeMatrix(
      [row("Tier 1", "VN", "VND", "25000000000")],
      [row("Tier 1", "VN", "VND", "29000000000")],
    );
    expect(matrix.cells["Tier 1|VN"].isDiff).toBe(true); // dữ liệu nói "khác"
    renderTable(false, matrix);
    expect(cellText("Tier 1", "VN", matrix)).not.toContain("★"); // …màn im
    expect(document.querySelector(".text-amber-700")).toBeNull();
  });

  it("showDiff=true → ★ + chữ amber-700 + tooltip ghi currency HAI bên", () => {
    const matrix = composeMatrix(
      [row("Tier 1", "VN", "VND", "25000000000")],
      [row("Tier 1", "VN", "VND", "29000000000")],
    );
    renderTable(true, matrix);
    expect(cellText("Tier 1", "VN", matrix)).toContain("★");
    expect(document.querySelector(".text-amber-700")).not.toBeNull();

    const tip = document.querySelector("[title]")?.getAttribute("title") ?? "";
    // Cùng chuỗi mà `diffNote` của writer dựng — hai bên phải nói y hệt.
    expect(tip).toBe(
      `Default: ${formatPrice("29000000000", "VND")} VND → Per-App: ${formatPrice(
        "25000000000",
        "VND",
      )} VND`,
    );
  });
});
