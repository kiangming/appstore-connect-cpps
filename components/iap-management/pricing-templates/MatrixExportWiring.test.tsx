// @vitest-environment jsdom
/**
 * C4.5 — WIRING, KHÔNG PHẢI PATTERN (P26).
 *
 * ⚠ VÌ SAO TEST NÀY TỒN TẠI. Lỗi F1 mà arc này đang sửa KHÔNG phải một lỗi
 * logic: `buildCsv` nhận đúng thứ nó được đưa, `composeMatrix` tính đúng
 * `isDiff`, `MatrixTable` vẽ đúng theo `showDiff`. Mọi mảnh đều đúng. Sai duy
 * nhất ở MỘT DÒNG NỐI DÂY — màn truyền `defaultTemplateExists` vào chỗ đáng lẽ
 * là `showDiff`. Không test nào ở tầng dưới bắt được, vì tầng dưới không biết
 * nó được gọi bằng gì.
 *
 * Nên ở đây render màn thật, bấm nút thật, và đọc CHÍNH body mà `fetch` nhận.
 *
 * SEAM. `fetch` bị spy; mọi thứ phía trên nó chạy thật (state của checkbox,
 * bộ lọc, `visibleMarkets`). `sonner` và `URL.createObjectURL` được mock vì
 * jsdom không có — không phải để né kiểm tra nào.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import {
  composeMatrix,
  type TemplateEntryRow,
} from "@/lib/iap-management/queries/template-matrix";
import { MATRIX_EXPORT_ENDPOINT } from "@/lib/iap-management/matrix-export-download";

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "toast-id"),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { DefaultMatrixView } from "./DefaultMatrixView";
import { PerAppMatrixView } from "./PerAppMatrixView";

function row(
  tier_id: string,
  territory_code: string,
  currency_code: string,
  customer_price: number,
): TemplateEntryRow {
  return { tier_id, territory_code, currency_code, customer_price, proceeds: null };
}

const TIER_NAMES = new Map([
  ["TIER_2", "Tier 2"],
  ["TIER_10", "Tier 10"],
]);

/** Thứ tự nước cố ý không phải alphabet: VNM → USA → THA. */
const MATRIX = composeMatrix({
  entries: [
    row("TIER_2", "VNM", "VND", 49000),
    row("TIER_2", "USA", "USD", 1.99),
    row("TIER_2", "THA", "THB", 69),
    row("TIER_10", "VNM", "VND", 490000),
  ],
  tierNames: TIER_NAMES,
  defaultEntries: [row("TIER_2", "VNM", "VND", 45000)],
});

let fetchSpy: ReturnType<typeof vi.fn>;

/** Response 200 giả — body không quan trọng, thứ đang đo là REQUEST. */
function okResponse() {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob(["x"]),
    headers: new Headers({
      "Content-Disposition": 'attachment; filename="apple-pricing-template.xlsx"',
    }),
  };
}

function errorResponse(status: number, error?: string) {
  return {
    ok: false,
    status,
    json: async () => (error === undefined ? {} : { error }),
    headers: new Headers(),
  };
}

/** Body JSON mà `fetch` vừa nhận. */
function sentBody(): Record<string, unknown> {
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(MATRIX_EXPORT_ENDPOINT);
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const clickExport = () => fireEvent.click(screen.getByRole("button", { name: /Export/i }));

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal("fetch", fetchSpy);
  // jsdom không có hai hàm này; chúng là đường tải file, không phải đối tượng đo.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:x"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("nút Export — nhãn và trạng thái", () => {
  it("nhãn là 'Export XLSX', không còn 'Export CSV'", () => {
    render(<DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />);
    expect(screen.getByRole("button", { name: /Export XLSX/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Export CSV/i })).toBeNull();
  });

  it("bộ lọc ra 0 nước ⇒ nút bị vô hiệu, không gửi request nào", async () => {
    render(<DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />);
    fireEvent.change(screen.getByPlaceholderText(/Search territory/i), {
      target: { value: "khong-co-nuoc-nao-ten-the-nay" },
    });
    const btn = screen.getByRole("button", { name: /Export XLSX/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("⚠ C4.2 — Default gửi đúng payload", () => {
  it("scope=default, showDiff=false, không kèm appId/accountId", async () => {
    render(<DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />);
    clickExport();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const body = sentBody();
    expect(body.scope).toBe("default");
    // Màn Default không có công tắc — `false` là thứ MatrixTable đang nhận.
    expect(body.showDiff).toBe(false);
    expect(body).not.toHaveProperty("appId");
    expect(body).not.toHaveProperty("accountId");
  });

  it("territories = đúng tập đang hiện, theo thứ tự matrix", async () => {
    render(<DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />);
    clickExport();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(sentBody().territories).toEqual(["VNM", "USA", "THA"]);
  });

  it("lọc bớt ⇒ territories co lại theo màn", async () => {
    render(<DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />);
    fireEvent.change(screen.getByPlaceholderText(/Search territory/i), {
      target: { value: "viet" },
    });
    clickExport();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(sentBody().territories).toEqual(["VNM"]);
  });
});

describe("⚠ C4.3 — Per-App gửi showDiff THẬT, không phải defaultTemplateExists", () => {
  const renderPerApp = (defaultTemplateExists = true) =>
    render(
      <PerAppMatrixView
        matrix={MATRIX}
        appId="app-uuid-1"
        appName="Demo"
        bundleId="com.vng.demo"
        uploadedAt={null}
        uploadedBy={null}
        defaultTemplateExists={defaultTemplateExists}
      />,
    );

  it("scope=per-app + appId, không kèm accountId", async () => {
    renderPerApp();
    clickExport();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = sentBody();
    expect(body.scope).toBe("per-app");
    expect(body.appId).toBe("app-uuid-1");
    expect(body).not.toHaveProperty("accountId");
    expect(body).not.toHaveProperty("defaultTemplateExists");
  });

  it("công tắc BẬT (mặc định) ⇒ showDiff: true", async () => {
    renderPerApp(true);
    expect(screen.getByRole("checkbox")).toBeChecked();
    clickExport();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(sentBody().showDiff).toBe(true);
  });

  it("⚠ TẮT công tắc ⇒ showDiff: false, DÙ defaultTemplateExists vẫn true", async () => {
    // ĐÂY LÀ TEST CANH F1. `defaultTemplateExists` không đổi trong ca này —
    // nên một màn gửi nhầm biến đó sẽ gửi `true` và test đỏ. Đó cũng là toàn
    // bộ nội dung của mutation M-a phía dưới.
    renderPerApp(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    clickExport();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(sentBody().showDiff).toBe(false);
  });

  it("bật lại ⇒ showDiff: true — nó theo công tắc, không phải theo lần bấm đầu", async () => {
    renderPerApp(true);
    const box = screen.getByRole("checkbox");
    fireEvent.click(box);
    fireEvent.click(box);
    clickExport();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(sentBody().showDiff).toBe(true);
  });

  it("không có template Default ⇒ không có công tắc, showDiff: false", async () => {
    renderPerApp(false);
    expect(screen.queryByRole("checkbox")).toBeNull();
    clickExport();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(sentBody().showDiff).toBe(false);
  });
});

describe("⚠ C4.4 — lỗi route đọc được, không nuốt thành toast chung chung", () => {
  it("409 hiện nguyên văn câu có TÊN NƯỚC của route", async () => {
    const { toast } = await import("sonner");
    fetchSpy.mockResolvedValue(
      errorResponse(
        409,
        "The pricing template changed since this page was loaded — it no longer covers: PRT, ITA. Reload and try again.",
      ),
    );
    render(<DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />);
    clickExport();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const msg = String((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(msg).toContain("PRT");
    expect(msg).toContain("ITA");
    expect(msg).not.toBe("Export failed");
  });

  it("400 hiện lý do của route", async () => {
    const { toast } = await import("sonner");
    fetchSpy.mockResolvedValue(errorResponse(400, 'Field "showDiff" must be a boolean.'));
    render(<DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />);
    clickExport();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain(
      "showDiff",
    );
  });

  it("404 nói 'chưa có template', không nói 'thất bại'", async () => {
    const { toast } = await import("sonner");
    fetchSpy.mockResolvedValue(
      errorResponse(404, "No Default template for the active account."),
    );
    render(<DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />);
    clickExport();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatch(
      /No Default template/,
    );
  });

  it("thân lỗi rỗng ⇒ vẫn có câu riêng theo status, không phải một câu cho cả ba", async () => {
    const { toast } = await import("sonner");
    fetchSpy.mockResolvedValue(errorResponse(409));
    render(<DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />);
    clickExport();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String((toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatch(
      /reload/i,
    );
  });

  it("thành công ⇒ toast.success, không phải toast.error", async () => {
    const { toast } = await import("sonner");
    render(<DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />);
    clickExport();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });
});
