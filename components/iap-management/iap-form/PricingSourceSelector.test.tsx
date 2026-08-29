// @vitest-environment jsdom
// C-C: file này vốn chỉ test hai hàm thuần (environment 'node' là đủ).
// Thêm render test cho phần disable/tooltip nên phải opt-in jsdom —
// vitest.config.ts đặt environment mặc định là 'node'.
/**
 * Unit tests for PricingSourceSelector (IAP.p1.f).
 *
 * Verifies the Q-D most-specific resolver + UI gating of disabled options.
 * The selector is intentionally dumb — parent owns state — so tests focus on
 * (1) the pure default resolver and (2) the radio's disabled semantics.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  defaultPricingSource,
  resolveInitialPricingSource,
  PricingSourceSelector,
} from "./PricingSourceSelector";

describe("defaultPricingSource — Q-D most-specific resolver", () => {
  it("picks APP_TEMPLATE when both are available", () => {
    expect(defaultPricingSource(true, true)).toBe("APP_TEMPLATE");
  });

  it("picks DEFAULT_TEMPLATE when only the default is available", () => {
    expect(defaultPricingSource(true, false)).toBe("DEFAULT_TEMPLATE");
  });

  it("falls back to APPLE when no template is configured", () => {
    expect(defaultPricingSource(false, false)).toBe("APPLE");
  });

  it("picks APP_TEMPLATE when only the app template is available", () => {
    // The Default template can be missing while the app has its own.
    // This is rare but possible — should still surface the app override.
    expect(defaultPricingSource(false, true)).toBe("APP_TEMPLATE");
  });
});

// IAP.p1.j Issue 1 — Save Draft round-trip MUST preserve the Manager's
// explicit choice even when Q-D would have picked a more specific source.
describe("resolveInitialPricingSource — Q-J persistence over Q-D default", () => {
  it("preserves stored APPLE even when both templates are available", () => {
    expect(resolveInitialPricingSource("APPLE", true, true)).toBe("APPLE");
  });

  it("preserves stored DEFAULT_TEMPLATE when an app template also exists", () => {
    expect(resolveInitialPricingSource("DEFAULT_TEMPLATE", true, true)).toBe(
      "DEFAULT_TEMPLATE",
    );
  });

  it("preserves stored APP_TEMPLATE regardless of default availability", () => {
    expect(resolveInitialPricingSource("APP_TEMPLATE", false, true)).toBe(
      "APP_TEMPLATE",
    );
  });

  it("falls back to Q-D default when no stored value (fresh draft)", () => {
    expect(resolveInitialPricingSource(undefined, true, false)).toBe(
      "DEFAULT_TEMPLATE",
    );
    expect(resolveInitialPricingSource(null, false, true)).toBe(
      "APP_TEMPLATE",
    );
    expect(resolveInitialPricingSource(undefined, false, false)).toBe("APPLE");
  });
});

/**
 * C-C [ACCOUNT-default-template] — "chưa có Default Template" nay là sự thật
 * của MỘT account, không phải của hệ thống.
 *
 * Ca này chưa gặp trên production (6/6 account đều có template sau M-1),
 * nhưng account tạo SAU migration sẽ gặp ngay lần đầu mở form — và không có
 * hook nào tự tạo template cho account mới (đã xác nhận ở census P2.4).
 */
describe("PricingSourceSelector — account chưa có Default Template", () => {
  function renderSelector(available: boolean, accountName?: string) {
    const onChange = vi.fn();
    render(
      <PricingSourceSelector
        value="APPLE"
        onChange={onChange}
        defaultTemplateAvailable={available}
        appTemplateAvailable={false}
        defaultTemplateAccountName={accountName}
      />,
    );
    return { onChange };
  }

  it("DISABLE option Default khi account chưa có template", () => {
    renderSelector(false, "VNG Corp");
    const radio = screen.getByRole("radio", { name: /Default Template/i });
    expect(radio).toBeDisabled();
  });

  it("copy nói RÕ TÊN ACCOUNT + chỉ đúng chỗ upload", () => {
    renderSelector(false, "VNG Corp");
    // Không chấp nhận câu chung chung: phải nêu account nào và đi đâu sửa.
    // Tên account cố ý xuất hiện ở CẢ tiêu đề lẫn dòng giải thích, nên
    // getAllByText — getByText sẽ ném vì nhiều khớp.
    expect(screen.getAllByText(/VNG Corp/).length).toBeGreaterThan(1);
    expect(screen.getByText(/Chưa có Default Template cho account/)).toBeTruthy();
    expect(screen.getByText(/Settings → Pricing Templates/)).toBeTruthy();
  });

  it("tooltip trên option bị disable cũng mang tên account", () => {
    renderSelector(false, "VNG Corp");
    const radio = screen.getByRole("radio", { name: /Default Template/i });
    const label = radio.closest("label");
    expect(label?.getAttribute("title") ?? "").toMatch(/VNG Corp/);
  });

  it("KHÔNG disable khi account đã có template, và tiêu đề mang tên account", () => {
    renderSelector(true, "VNG Corp");
    const radio = screen.getByRole("radio", { name: /Default Template/i });
    expect(radio).not.toBeDisabled();
    expect(screen.getByText(/Default Template · VNG Corp/)).toBeTruthy();
  });

  it("thiếu tên account thì vẫn nói được câu có nghĩa (không in 'undefined')", () => {
    renderSelector(false, undefined);
    const radio = screen.getByRole("radio", { name: /Default Template/i });
    expect(radio).toBeDisabled();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });
});
