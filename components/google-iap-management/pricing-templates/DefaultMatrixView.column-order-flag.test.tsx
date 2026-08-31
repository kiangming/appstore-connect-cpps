// @vitest-environment jsdom
/**
 * G1e · E4 — cờ `columnOrderUnknown` phải ĐƯỢC CÔNG BỐ trên màn.
 *
 * ⚠ VAI LÀ CÔNG BỐ, KHÔNG PHẢI BÁO LỖI. Giá trong bảng hoàn toàn đúng;
 *   chỉ THỨ TỰ CỘT là không bảo đảm (template upload trước khi có
 *   `sort_order`, và M-1 chưa backfill nó).
 *
 * ⚠ Điều test này thật sự canh: cờ KHÔNG BỊ NUỐT. `composeMatrix` bật cờ
 *   rất đúng (D3 đã ghim), nhưng một cờ đúng mà màn không hiện thì người
 *   xem vẫn tin nhầm vào một thứ tự cột không bảo đảm — và đó chính là
 *   tình trạng trước G1d, chỉ khác là nay ta BIẾT mà không nói.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { DefaultMatrixView } from "./DefaultMatrixView";
import { composeMatrix, type TemplateEntryRow } from "@/lib/google-iap-management/queries/template-matrix";

function rows(sortOrder: number | null): TemplateEntryRow[] {
  return [
    { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "990000", sort_order: sortOrder },
    { identifier: "Tier 1", region_code: "VN", currency: "VND", price_micros: "25000000000", sort_order: sortOrder === null ? null : sortOrder + 1 },
  ];
}

describe("E4 — công bố thứ tự cột chưa xác định", () => {
  it("template THIẾU sort_order → hiện lời công bố", () => {
    const matrix = composeMatrix(rows(null));
    expect(matrix.columnOrderUnknown).toBe(true);
    render(<DefaultMatrixView matrix={matrix} uploadedAt={null} uploadedBy={null} />);
    expect(screen.getByTestId("column-order-unknown")).toHaveTextContent(
      /thứ tự cột.*chưa xác định/i,
    );
  });

  it("template CÓ sort_order → KHÔNG hiện (không làm phiền vô cớ)", () => {
    const matrix = composeMatrix(rows(1));
    expect(matrix.columnOrderUnknown).toBe(false);
    render(<DefaultMatrixView matrix={matrix} uploadedAt={null} uploadedBy={null} />);
    expect(screen.queryByTestId("column-order-unknown")).not.toBeInTheDocument();
  });
});
