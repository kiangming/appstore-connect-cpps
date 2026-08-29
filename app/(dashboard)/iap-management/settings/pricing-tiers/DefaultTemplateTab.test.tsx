// @vitest-environment jsdom
/**
 * C-D [ACCOUNT-default-template] — tab Default theo account.
 *
 * Sáu điểm được pin ở đây, mỗi điểm là một cách hỏng đã lường trước:
 *
 *   (a) upload ghi nhầm account   — mất 1140 ô THẬT của một account mà
 *                                   Manager đang không nhìn. Nguy hiểm nhất.
 *   (b) ẩn account chưa có template — "chưa có" và "không tồn tại" nhìn giống
 *                                   hệt nhau (lập luận đã viết ở Key Pool).
 *   (c) badge sai mẫu số          — 7/7 thay vì 6/7 giấu đi đúng thứ badge
 *                                   sinh ra để hiện.
 *   (d) pill nguồn gốc không tắt   — "chưa ai cấu hình riêng" nói dối sau khi
 *                                   đã có người cấu hình.
 *   (e) modal ca migration dùng "their" — đọc như có đồng nghiệp tên
 *                                   SYSTEM_MIGRATION.
 *   (f) phân biệt modal bằng chuỗi 'SYSTEM_MIGRATION' — bản sao hằng số của
 *                                   file SQL, sẽ trôi.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { DefaultTemplateTab } from "./DefaultTemplateTab";
import type {
  AccountTemplateSummary,
  TemplateHeader,
  TemplateOverview,
} from "@/lib/iap-management/queries/templates";

const ACCOUNTS = [
  { id: "vng-corp", name: "VNG Corp" },
  { id: "vng-sing", name: "VNG Sing" },
  { id: "account-moi", name: "Account Mới" }, // ⚠ CHƯA có template
];

function header(over: Partial<TemplateHeader> = {}): TemplateHeader {
  return {
    id: "tpl-1",
    scope_type: "ACCOUNT",
    scope_app_id: null,
    uploaded_at: "2026-08-29T00:00:00Z",
    uploaded_by: "SYSTEM_MIGRATION",
    source_filename: "default.xlsx",
    origin_note: "Nhân bản từ template GLOBAL 3cbdeaa2… — migration M-1.",
    ...over,
  };
}

function overview(template: TemplateHeader | null): TemplateOverview {
  return {
    template,
    tiers: [],
    territory_count: template ? 12 : 0,
    populated_entry_count: template ? 1140 : 0,
  };
}

const SUMMARIES: AccountTemplateSummary[] = [
  { account_id: "vng-corp", template: header({ id: "tpl-corp" }), entry_count: 1140 },
  { account_id: "vng-sing", template: header({ id: "tpl-sing" }), entry_count: 1140 },
  { account_id: "account-moi", template: null, entry_count: 0 },
];

function renderTab(opts: {
  selected?: string;
  template?: TemplateHeader | null;
  currentUserEmail?: string;
} = {}) {
  const template = opts.template === undefined ? header() : opts.template;
  render(
    <DefaultTemplateTab
      overview={overview(template)}
      accounts={ACCOUNTS}
      summaries={SUMMARIES}
      selectedAccountId={opts.selected ?? "vng-corp"}
      currentUserEmail={opts.currentUserEmail ?? "minhgv@vng.com.vn"}
    />,
  );
}

function uploadFile() {
  const input = screen.getByTestId("file-input") as HTMLInputElement;
  const file = new File(["x"], "t.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ template_id: "t", inserted_entry_count: 1140 }),
    })),
  );
});

describe("(a) ⚠ upload ghi vào ĐÚNG account đang chọn", () => {
  it("gửi account_id = account đang chọn, không phải account đầu danh sách", async () => {
    renderTab({ selected: "vng-sing", template: null }); // null ⇒ upload thẳng, không modal
    uploadFile();

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = (fetch as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as { body: FormData };
    expect(body.body.get("account_id")).toBe("vng-sing");
    expect(body.body.get("scope")).toBe("ACCOUNT");
  });

  it("đổi account đang chọn thì account_id gửi đi cũng đổi theo", async () => {
    renderTab({ selected: "account-moi", template: null });
    uploadFile();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = (fetch as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as { body: FormData };
    expect(body.body.get("account_id")).toBe("account-moi");
  });
});

describe("(b) dropdown hiện ĐỦ account, kể cả account chưa có template", () => {
  it("account chưa có template vẫn xuất hiện, kèm nhãn 'chưa có'", () => {
    renderTab();
    const chip = screen.getByTestId("account-chip-account-moi");
    expect(chip).toBeTruthy();
    expect(chip.textContent).toMatch(/chưa có/);
  });

  it("mọi account đều có chip — ẩn bớt là hỏng", () => {
    renderTab();
    for (const a of ACCOUNTS) {
      expect(screen.getByTestId(`account-chip-${a.id}`)).toBeTruthy();
    }
  });

  it("nhãn là TÊN account, id đứng sau (khuôn Key Pool)", () => {
    renderTab();
    const chip = screen.getByTestId("account-chip-vng-corp");
    expect(chip.textContent).toMatch(/VNG Corp/);
    expect(chip.textContent).toMatch(/vng-corp/);
  });

  it("chip của account đang xem được đánh dấu — không nhầm được", () => {
    renderTab({ selected: "vng-sing" });
    expect(
      screen.getByTestId("account-chip-vng-sing").getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen.getByTestId("account-chip-vng-corp").getAttribute("aria-current"),
    ).toBeNull();
  });
});

describe("(d) pill nguồn gốc bám origin_note", () => {
  it("HIỆN khi template do migration nhân bản", () => {
    renderTab({ template: header() });
    expect(screen.getByTestId("origin-pill").textContent).toMatch(/chưa ai cấu hình riêng/);
  });

  it("BIẾN MẤT khi đã có người upload đè (origin_note = null)", () => {
    renderTab({ template: header({ origin_note: null, uploaded_by: "minhgv@vng.com.vn" }) });
    expect(screen.queryByTestId("origin-pill")).toBeNull();
  });

  it("bảng toàn cảnh cũng dùng cùng một cờ", () => {
    renderTab();
    expect(screen.getByTestId("overview-row-vng-corp").textContent).toMatch(/do migration/);
    expect(screen.getByTestId("overview-row-account-moi").textContent).not.toMatch(
      /do migration/,
    );
  });
});

describe("(e)(f) modal thay template — hai biến thể, phân biệt bằng origin_note", () => {
  it("ca DO MIGRATION: modal thông tin, KHÔNG có chữ 'their'/'của người khác'", () => {
    renderTab({ template: header() }); // origin_note != null
    uploadFile();
    const modal = screen.getByTestId("replace-modal-migrated");
    expect(modal.textContent).toMatch(/do migration nhân bản/i);
    expect(modal.textContent).toMatch(/chưa ai cấu hình riêng/i);
    expect(modal.textContent).not.toMatch(/their/i);
    // Không được đổ tên "SYSTEM_MIGRATION" vào mặt người đọc như một con người.
    expect(modal.textContent).not.toMatch(/SYSTEM_MIGRATION/);
  });

  it("ca ĐỒNG NGHIỆP THẬT: modal đỏ, nêu đích danh người upload", () => {
    renderTab({
      template: header({ origin_note: null, uploaded_by: "anhntq@vng.com.vn" }),
      currentUserEmail: "minhgv@vng.com.vn",
    });
    uploadFile();
    const modal = screen.getByTestId("replace-modal-someone-else");
    expect(modal.textContent).toMatch(/anhntq@vng\.com\.vn/);
    expect(modal.textContent).toMatch(/không phải bạn/);
  });

  it("⚠ (f) discriminator là origin_note, KHÔNG phải chuỗi uploaded_by", () => {
    // uploaded_by = 'SYSTEM_MIGRATION' NHƯNG origin_note = null.
    // Nếu code so chuỗi uploaded_by thì sẽ ra modal "migrated" — sai: bản này
    // KHÔNG do migration tạo, và nó không phải của người đang đăng nhập, nên
    // phải là modal đỏ.
    renderTab({
      template: header({ origin_note: null, uploaded_by: "SYSTEM_MIGRATION" }),
      currentUserEmail: "minhgv@vng.com.vn",
    });
    uploadFile();
    expect(screen.queryByTestId("replace-modal-migrated")).toBeNull();
    expect(screen.getByTestId("replace-modal-someone-else")).toBeTruthy();
  });

  it("chính mình upload lần trước → không modal, upload thẳng", async () => {
    renderTab({
      template: header({ origin_note: null, uploaded_by: "minhgv@vng.com.vn" }),
      currentUserEmail: "minhgv@vng.com.vn",
    });
    uploadFile();
    expect(screen.queryByTestId("replace-modal-migrated")).toBeNull();
    expect(screen.queryByTestId("replace-modal-someone-else")).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  });

  it("Huỷ modal thì KHÔNG upload", () => {
    renderTab({ template: header() });
    uploadFile();
    fireEvent.click(screen.getByText("Huỷ"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("xác nhận modal thì upload đúng account đang chọn", async () => {
    renderTab({ selected: "vng-sing", template: header() });
    uploadFile();
    fireEvent.click(screen.getByTestId("replace-confirm"));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = (fetch as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as { body: FormData };
    expect(body.body.get("account_id")).toBe("vng-sing");
  });
});

describe("empty state của account chưa có template (mockup State 2)", () => {
  it("nói rõ tên account + hệ quả 'không còn tầng global đỡ'", () => {
    renderTab({ selected: "account-moi", template: null });
    expect(screen.getByText(/Chưa có Default Template cho Account Mới/)).toBeTruthy();
    expect(screen.getByText(/không còn tầng global đỡ phía sau/i)).toBeTruthy();
  });
});
