// @vitest-environment jsdom
/**
 * G1e · E2 — badge đếm trên tab "Default Template".
 *
 * ĐỊNH NGHĨA (nhắc lại ở đây để test và code không trôi khỏi nhau):
 *   TỬ SỐ  = số account có `template != null`.
 *   MẪU SỐ = số account ĐANG TỒN TẠI.
 *
 * ⚠ Fixture CỐ Ý 7 account / 6 có template, để hai giả thuyết TÁCH NHAU:
 *     đúng  → "6 / 7 account"
 *     sai   → "6 / 6 account"  (mẫu số lấy từ danh sách đã lọc)
 *   Nếu fixture để 6/6 thì cả hai cách tính cho cùng kết quả và test xanh
 *   vì trùng hợp — badge sẽ mãi là N/N và account thứ 7 chưa cấu hình
 *   không bao giờ lộ ra.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { PricingTemplatesClient } from "./PricingTemplatesClient";
import type {
  AccountTemplateSummary,
  PricingTemplateRow,
} from "@/lib/google-iap-management/queries/templates";

const ACCOUNTS = Array.from({ length: 7 }, (_, i) => ({
  id: `acct-${i}`,
  name: `Account ${i}`,
}));

function tpl(accountId: string): PricingTemplateRow {
  return {
    id: `tpl-${accountId}`,
    scope_type: "ACCOUNT",
    scope_app_id: null,
    scope_account_id: accountId,
    uploaded_at: "2026-05-21T00:00:00Z",
    uploaded_by: "minhgv@vng.com.vn",
    source_filename: "t.xlsx",
    origin_note: null,
  };
}

// 6 account đầu CÓ template; account thứ 7 (acct-6) CHƯA có.
const SUMMARIES: AccountTemplateSummary[] = ACCOUNTS.map((a, i) => ({
  account_id: a.id,
  template: i < 6 ? tpl(a.id) : null,
  entry_count: i < 6 ? 846 : 0,
}));

describe("E2 — mẫu số là account ĐANG TỒN TẠI, không phải account có template", () => {
  it("7 account / 6 có template → badge '6 / 7 account'", () => {
    render(
      <PricingTemplatesClient
        defaultOverview={{
          template: tpl("acct-0"),
          tierCount: 94,
          territoryCount: 9,
          entryCount: 846,
          sampleEntries: [],
        }}
        appTemplates={[]}
        cachedApps={[]}
        accounts={ACCOUNTS}
        accountSummaries={SUMMARIES}
        selectedAccountId="acct-0"
        canEditDefault
      />,
    );
    const badges = screen.getAllByTestId("tab-badge");
    const text = badges.map((b) => b.textContent).join(" | ");
    expect(text).toContain("6 / 7 account");
    // Đây là kết quả của cách tính SAI — phải không xuất hiện.
    expect(text).not.toContain("6 / 6 account");
    expect(text).not.toContain("7 / 7 account");
  });
});
