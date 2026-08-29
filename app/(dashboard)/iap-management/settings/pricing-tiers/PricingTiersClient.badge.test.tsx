// @vitest-environment jsdom
/**
 * C-D / D2 — badge tab "Default Template" đếm gì.
 *
 * Manager chốt: "x / N account" thay cho số ô. Điều đáng pin KHÔNG phải
 * định dạng chuỗi mà là ĐỊNH NGHĨA hai con số:
 *
 *     tử số  = số account CÓ template
 *     mẫu số = số account ĐANG TỒN TẠI   ← chỗ dễ sai
 *
 * Lấy mẫu số từ danh sách đã lọc (chỉ account có template) sẽ cho 6/6 vĩnh
 * viễn — badge luôn "đủ", và cái nó sinh ra để hiện (có account chưa có
 * template) bị chính nó giấu đi. Account thứ 7 thêm sau migration phải làm
 * badge thành 6/7.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/iap-management/settings/pricing-tiers",
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { PricingTiersClient } from "./PricingTiersClient";
import type {
  AccountTemplateSummary,
  TemplateHeader,
} from "@/lib/iap-management/queries/templates";

function header(id: string): TemplateHeader {
  return {
    id,
    scope_type: "ACCOUNT",
    scope_app_id: null,
    uploaded_at: "2026-08-29T00:00:00Z",
    uploaded_by: "SYSTEM_MIGRATION",
    source_filename: "default.xlsx",
    origin_note: "migration M-1",
  };
}

function renderShell(accountCount: number, withTemplate: number) {
  const accounts = Array.from({ length: accountCount }, (_, i) => ({
    id: `acct-${i}`,
    name: `Account ${i}`,
  }));
  const summaries: AccountTemplateSummary[] = accounts.map((a, i) => ({
    account_id: a.id,
    template: i < withTemplate ? header(`tpl-${i}`) : null,
    entry_count: i < withTemplate ? 1140 : 0,
  }));
  render(
    <PricingTiersClient
      defaultOverview={{
        template: header("tpl-0"),
        tiers: [],
        territory_count: 12,
        populated_entry_count: 1140,
      }}
      appsWithTemplates={[]}
      accounts={accounts}
      accountSummaries={summaries}
      selectedAccountId="acct-0"
      isAdmin
      currentUserEmail="minhgv@vng.com.vn"
    />,
  );
}

describe("D2 — badge 'x / N account'", () => {
  it("trạng thái hôm nay: 6 account, cả 6 có template → 6 / 6", () => {
    renderShell(6, 6);
    expect(screen.getByText("6 / 6 account")).toBeTruthy();
  });

  it("⚠ account thứ 7 thêm sau migration → 6 / 7, KHÔNG phải 7 / 7", () => {
    renderShell(7, 6);
    expect(screen.getByText("6 / 7 account")).toBeTruthy();
    expect(screen.queryByText("7 / 7 account")).toBeNull();
  });

  it("badge KHÔNG còn là số ô — 1140 không được xuất hiện ở dải tab", () => {
    renderShell(6, 6);
    const nav = screen.getByLabelText("Pricing templates tabs");
    expect(nav.textContent).not.toMatch(/1140|1\.140/);
  });

  it("hai badge cạnh nhau cùng LOẠI: đếm scope, không đếm ô", () => {
    renderShell(6, 6);
    const nav = screen.getByLabelText("Pricing templates tabs");
    // Default: "6 / 6 account" · Per-App: "0" (số template app)
    expect(nav.textContent).toMatch(/6 \/ 6 account/);
    expect(nav.textContent).toMatch(/Per-App Templates/);
  });
});
