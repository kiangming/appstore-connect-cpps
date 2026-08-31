// @vitest-environment jsdom
/**
 * G1e · E1/E2/E3/E5/E6/E7 — giao diện Default Template theo account.
 *
 * ⚠ TÍNH CHẤT ĐẮT NHẤT Ở ĐÂY LÀ E1: chip chọn account chỉ ĐIỀU HƯỚNG
 *   (`?account=`), TUYỆT ĐỐI KHÔNG đổi active account của module. Nếu nó
 *   đổi, một cú bấm để XEM biến thành một cú bấm đổi NGỮ CẢNH của cả
 *   module — danh sách app, bulk import, single-IAP form đều bám theo
 *   active account.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  writeActiveAccountId: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, refresh: h.refresh }),
}));
// Nếu component lỡ gọi hàm này thì test E1 sẽ bắt được.
vi.mock("@/lib/google-iap-management/active-account", () => ({
  writeActiveAccountId: h.writeActiveAccountId,
}));

import { DefaultTemplateTab } from "./DefaultTemplateTab";
import type {
  AccountTemplateSummary,
  PricingTemplateRow,
  TemplateOverview,
} from "@/lib/google-iap-management/queries/templates";

const ACCOUNTS = [
  { id: "acct-a", name: "VNG Corp" },
  { id: "acct-b", name: "VNG Sing" },
  { id: "acct-c", name: "VNGG Sing" },
];

function tpl(over: Partial<PricingTemplateRow> = {}): PricingTemplateRow {
  return {
    id: "tpl-1",
    scope_type: "ACCOUNT",
    scope_app_id: null,
    scope_account_id: "acct-a",
    uploaded_at: "2026-05-21T00:00:00Z",
    uploaded_by: "minhgv@vng.com.vn",
    source_filename: "t.xlsx",
    origin_note: null,
    ...over,
  };
}

function overview(template: PricingTemplateRow | null): TemplateOverview {
  return {
    template,
    tierCount: template ? 94 : 0,
    territoryCount: template ? 9 : 0,
    entryCount: template ? 846 : 0,
    sampleEntries: [],
  };
}

const SUMMARIES: AccountTemplateSummary[] = [
  { account_id: "acct-a", template: tpl(), entry_count: 846 },
  {
    account_id: "acct-b",
    template: tpl({ id: "tpl-2", scope_account_id: "acct-b", origin_note: "bản sao (M-1)" }),
    entry_count: 846,
  },
  // acct-c CHƯA có template — cố ý.
  { account_id: "acct-c", template: null, entry_count: 0 },
];

function renderTab(opts: Partial<Parameters<typeof DefaultTemplateTab>[0]> = {}) {
  return render(
    <DefaultTemplateTab
      overview={overview(tpl())}
      accounts={ACCOUNTS}
      summaries={SUMMARIES}
      selectedAccountId="acct-a"
      {...opts}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("E1 — chip chọn account", () => {
  it("hiện ĐỦ account, KỂ CẢ account chưa có template", () => {
    renderTab();
    for (const a of ACCOUNTS) {
      expect(screen.getByTestId(`account-chip-${a.id}`)).toBeInTheDocument();
    }
    // Chính là account chưa có template — ẩn nó đi thì "chưa cấu hình" và
    // "không tồn tại" nhìn giống hệt nhau.
    expect(screen.getByTestId("account-chip-acct-c")).toHaveTextContent(
      "chưa có",
    );
  });

  it("chip đang xem có dấu phân biệt, và tiêu đề thẻ đổi theo", () => {
    renderTab({ selectedAccountId: "acct-b", overview: overview(tpl({ scope_account_id: "acct-b" })) });
    expect(screen.getByTestId("account-chip-acct-b")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(screen.getByTestId("account-chip-acct-a")).toHaveAttribute(
      "data-selected",
      "false",
    );
    expect(screen.getByTestId("selected-account-label")).toHaveTextContent(
      "VNG Sing",
    );
  });

  it("⚠ bấm chip chỉ ĐIỀU HƯỚNG ?account= — KHÔNG đổi active account", () => {
    renderTab();
    fireEvent.click(screen.getByTestId("account-chip-acct-b"));

    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0]).toContain("account=acct-b");
    // Khẳng định quan trọng nhất của E1.
    expect(h.writeActiveAccountId).not.toHaveBeenCalled();
  });

  it("nhãn chip gồm tên account + id dạng mono", () => {
    renderTab();
    const chip = screen.getByTestId("account-chip-acct-a");
    expect(chip).toHaveTextContent("VNG Corp");
    expect(chip).toHaveTextContent("acct-a");
  });
});

describe("E3 — pill nguồn gốc từ origin_note", () => {
  it("origin_note != null → hiện pill", () => {
    renderTab({ overview: overview(tpl({ origin_note: "bản sao (M-1)" })) });
    expect(screen.getByTestId("origin-pill")).toBeInTheDocument();
  });

  it("origin_note = null → KHÔNG pill, dù uploaded_by là SYSTEM_MIGRATION", () => {
    // Ca tách hai biểu thức: nếu ai đó đổi điều kiện sang so chuỗi
    // uploaded_by thì test này đỏ.
    renderTab({
      overview: overview(
        tpl({ origin_note: null, uploaded_by: "SYSTEM_MIGRATION" }),
      ),
    });
    expect(screen.queryByTestId("origin-pill")).not.toBeInTheDocument();
  });

  it("pill TỰ biến mất sau Replace — bản mới có origin_note = NULL", () => {
    const { rerender } = renderTab({
      overview: overview(tpl({ origin_note: "bản sao (M-1)" })),
    });
    expect(screen.getByTestId("origin-pill")).toBeInTheDocument();
    // Replace sinh bản mới: origin_note NULL, uploaded_by là người thật.
    rerender(
      <DefaultTemplateTab
        overview={overview(tpl({ id: "tpl-new", origin_note: null }))}
        accounts={ACCOUNTS}
        summaries={SUMMARIES}
        selectedAccountId="acct-a"
      />,
    );
    expect(screen.queryByTestId("origin-pill")).not.toBeInTheDocument();
  });
});

describe("E5 — account CHƯA có template", () => {
  it("hiện lời giải thích thay vì bảng rỗng trống trơn", () => {
    renderTab({ selectedAccountId: "acct-c", overview: overview(null) });
    expect(screen.getByTestId("empty-state-note")).toHaveTextContent(
      /chưa có Default Template/i,
    );
  });

  it("không có template thì KHÔNG hiện nút Remove", () => {
    renderTab({ selectedAccountId: "acct-c", overview: overview(null) });
    expect(screen.queryByText("Remove")).not.toBeInTheDocument();
  });
});

describe("E6 — bảng toàn cảnh N account", () => {
  it("một dòng cho MỖI account, kể cả account chưa có template", () => {
    renderTab();
    const table = screen.getByTestId("overview-table");
    for (const a of ACCOUNTS) {
      expect(within(table).getByTestId(`overview-row-${a.id}`)).toBeInTheDocument();
    }
  });

  it("cột Nguồn gốc phân biệt bản sao migration với người thật", () => {
    renderTab();
    const rowB = screen.getByTestId("overview-row-acct-b");
    expect(rowB).toHaveTextContent("bản sao migration");
    const rowA = screen.getByTestId("overview-row-acct-a");
    expect(rowA).toHaveTextContent("minhgv@vng.com.vn");
  });

  it("account chưa có template hiện '—' ở Số ô, không phải 0", () => {
    renderTab();
    expect(screen.getByTestId("overview-row-acct-c")).toHaveTextContent("—");
  });
});

describe("E7 — không phải admin", () => {
  it("readOnly → hiện khoá, ẩn Remove", () => {
    renderTab({ readOnly: true });
    expect(screen.getByTestId("readonly-lock")).toBeInTheDocument();
    expect(screen.queryByText("Remove")).not.toBeInTheDocument();
  });

  it("admin → không có khoá, có Remove", () => {
    renderTab({ readOnly: false });
    expect(screen.queryByTestId("readonly-lock")).not.toBeInTheDocument();
    expect(screen.getByText("Remove")).toBeInTheDocument();
  });
});

describe("E3 — modal Replace dùng ĐÚNG hàm của G1c, không dựng bản thứ hai", () => {
  const SRC = readFileSync(
    "components/google-iap-management/pricing-templates/DefaultTemplateTab.tsx",
    "utf-8",
  );

  it("phép đo tự chứng minh nó đọc đúng file", () => {
    expect(SRC.length).toBeGreaterThan(2000);
    expect(SRC).toContain("DefaultTemplateTab");
  });

  it("gọi replaceConfirmVariant — không tự dựng lại quy tắc", () => {
    expect(SRC).toContain("replaceConfirmVariant");
  });

  /** Bỏ comment khối và comment dòng, chỉ giữ phần CHẠY ĐƯỢC.
   *
   *  ⚠ Vì sao phải lọc: bản đầu của test này cấm chuỗi trên TOÀN FILE và
   *  đỏ ngay — thủ phạm là một COMMENT đang giải thích "đừng dùng
   *  uploaded_by". Một hàng rào bắt luôn cả lời cảnh báo chống lại chính
   *  nó sẽ ép người sau XOÁ lời giải thích để test xanh, tức là làm code
   *  tệ đi. Đo cho đúng tầng, đừng nới điều kiện. */
  function codeOnly(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
  }

  it("phép lọc comment tự chứng minh nó còn giữ được phần code", () => {
    const code = codeOnly(SRC);
    expect(code).toContain("replaceConfirmVariant");
    expect(code.length).toBeGreaterThan(1000);
  });

  it("⚠ KHÔNG có phép so chuỗi uploaded_by === 'SYSTEM_MIGRATION' trong CODE", () => {
    // Hằng số đó do migration 20260831000000 ghi ra. So chuỗi ở UI là dựng
    // một bản sao của một hằng số nằm trong file SQL — hai bản sẽ trôi
    // khỏi nhau và KHÔNG có gì bắt được. `origin_note` là cột, có kiểu.
    expect(codeOnly(SRC)).not.toContain("SYSTEM_MIGRATION");
  });
});
