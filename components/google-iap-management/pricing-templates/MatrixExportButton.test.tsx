// @vitest-environment jsdom
/**
 * C4 — test nút Export trên HAI màn matrix.
 *
 * ─── VÌ SAO TEST Ở ĐÂY CHỨ KHÔNG PHẢI Ở LỚP DƯỚI ──────────────────────────
 *
 * Lệch F1 của đường CSV cũ là MỘT DÒNG NỐI DÂY: `buildCsv` nhận đúng thứ nó
 * được đưa, `composeMatrix` tính `isDiff` đúng, `MatrixTable` render `showDiff`
 * đúng — màn truyền SAI BIẾN vào lời gọi export, và không tầng nào bên dưới
 * thấy được, vì các tầng đó không biết chúng được gọi với cái gì.
 *
 * ⇒ Test duy nhất bắt được lớp lỗi ấy là: render MÀN THẬT, bấm NÚT THẬT, đọc
 *   BODY mà `fetch` nhận được.
 *
 * ⚠ FIXTURE ĐẶT `showDiff` VÀ `defaultTemplateExists` KHÁC GIÁ TRỊ NHAU.
 * Nếu để bằng nhau thì gửi nhầm biến vẫn ra cùng kết quả và test vô nghĩa —
 * nó sẽ xanh trong khi lỗi vẫn còn nguyên.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";

import { DefaultMatrixView } from "./DefaultMatrixView";
import { PerAppMatrixView } from "./PerAppMatrixView";
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

const ENTRIES: TemplateEntryRow[] = [
  row("Tier 1", "US", "USD", "990000"),
  row("Tier 1", "VN", "VND", "25000000000"),
  row("Tier 1", "TH", "THB", "35000000"),
];
const MATRIX = composeMatrix(ENTRIES);
const PER_APP = composeMatrix(ENTRIES, [
  row("Tier 1", "US", "USD", "990000"),
  row("Tier 1", "VN", "VND", "29000000000"),
  row("Tier 1", "TH", "THB", "35000000"),
]);

const fetchMock = vi.fn();

/** Response giả của route: .xlsx + hai header route thật có trả. */
function xlsxResponse(over: { truncated?: number; filename?: string } = {}) {
  const headers = new Headers({
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${over.filename ?? "google-pricing-template-default-20260831-1035.xlsx"}"`,
    "X-Truncated-Cells": String(over.truncated ?? 0),
  });
  return {
    ok: true,
    status: 200,
    headers,
    blob: async () => new Blob(["PK"]),
    json: async () => ({}),
  };
}

function errorResponse(status: number, body: Record<string, unknown>) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    blob: async () => new Blob([]),
    json: async () => body,
  };
}

/** Body JSON mà `fetch` nhận được ở lần gọi thứ n. */
function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}"));
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(xlsxResponse());
  // jsdom không có hai API này.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:x"),
    revokeObjectURL: vi.fn(),
  });
  HTMLAnchorElement.prototype.click = vi.fn();
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const clickExport = async () => {
  await userEvent.click(screen.getByRole("button", { name: /export xlsx/i }));
};

// ═══════════════════════════════════════════════════════════════════════════

describe("nhãn nút", () => {
  it("là 'Export XLSX', không còn 'Export CSV'", () => {
    render(
      <DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />,
    );
    expect(screen.getByRole("button", { name: /export xlsx/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export csv/i })).toBeNull();
  });

  it("0 nước sau bộ lọc → nút disabled (route trả 400 cho mảng rỗng)", async () => {
    render(
      <DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />,
    );
    await userEvent.type(
      screen.getByPlaceholderText(/search market/i),
      "khong-co-nuoc-nao-ten-nhu-vay",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /export xlsx/i })).toBeDisabled(),
    );
  });
});

describe("màn Default gửi đúng payload", () => {
  it("scope=default, không có appId, showDiff=false (màn không có công tắc)", async () => {
    render(
      <DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />,
    );
    await clickExport();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/google-iap-management/pricing-templates/matrix-export",
    );
    const body = sentBody();
    expect(body.scope).toBe("default");
    expect(body.showDiff).toBe(false);
    expect(body).not.toHaveProperty("appId");
    expect(body.regionCodes).toEqual(["US", "VN", "TH"]);
  });

  it("regionCodes theo bộ lọc đang có trên màn, giữ thứ tự matrix.markets", async () => {
    render(
      <DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />,
    );
    await userEvent.type(screen.getByPlaceholderText(/search market/i), "viet");
    await clickExport();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody().regionCodes).toEqual(["VN"]);
  });
});

describe("⚠ F1 — màn Per-App gửi CÔNG TẮC, không gửi defaultTemplateExists", () => {
  /**
   * ⚠ HAI BIẾN NÀY PHẢI KHÁC GIÁ TRỊ NHAU trong mọi ca dưới đây.
   * `defaultTemplateExists = true` (có Default để so) nhưng người dùng TẮT
   * công tắc ⇒ `showDiff = false`. Đường CSV cũ gửi biến thứ nhất, nên file
   * vẫn mang cột diff trong khi màn đã sạch ★.
   */
  function renderPerApp() {
    return render(
      <PerAppMatrixView
        matrix={PER_APP}
        appId="app-uuid-1"
        packageName="vng.games.lightandnight"
        appDisplayName="Light and Night"
        uploadedAt={null}
        uploadedBy={null}
        defaultTemplateExists={true}
      />,
    );
  }

  it("TẮT công tắc → gửi showDiff=false, dù defaultTemplateExists=true", async () => {
    renderPerApp();
    // Mặc định công tắc BẬT (useState(defaultTemplateExists)); tắt nó đi.
    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("checkbox")).not.toBeChecked();

    await clickExport();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = sentBody();
    // ⚠ Khẳng định chịu lực: false ≠ defaultTemplateExists (true).
    expect(body.showDiff).toBe(false);
    expect(body).not.toHaveProperty("defaultTemplateExists");
  });

  it("BẬT công tắc → gửi showDiff=true", async () => {
    renderPerApp();
    expect(screen.getByRole("checkbox")).toBeChecked();
    await clickExport();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody().showDiff).toBe(true);
  });

  it("gửi scope=per-app + appId, và KHÔNG gửi accountId", async () => {
    renderPerApp();
    await clickExport();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = sentBody();
    expect(body.scope).toBe("per-app");
    expect(body.appId).toBe("app-uuid-1");
    // Danh tính đến từ session + cookie ở server. Gửi accountId lên là nói
    // rằng client có quyền chọn account.
    expect(body).not.toHaveProperty("accountId");
    expect(body).not.toHaveProperty("account_id");
    // Đúng BỐN trường, không hơn.
    expect(Object.keys(body).sort()).toEqual([
      "appId",
      "regionCodes",
      "scope",
      "showDiff",
    ]);
  });
});

describe("lỗi route hiện ra ĐỌC ĐƯỢC, không nuốt thành toast chung", () => {
  it("409 → hiện TÊN nước lạ, lấy từ unknownRegionCodes", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(409, {
        error: "server prose có thể đổi",
        unknownRegionCodes: ["KH", "MM"],
      }),
    );
    render(
      <DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />,
    );
    await clickExport();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("KH, MM");
    expect(alert).toHaveTextContent(/reload/i);
  });

  it("400 → nêu lý do của server", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(400, { error: 'Field "showDiff" must be a boolean.' }),
    );
    render(
      <DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />,
    );
    await clickExport();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'Field "showDiff" must be a boolean.',
    );
  });

  it("404 → 'chưa có template'", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(404, { error: "No Default template uploaded yet." }),
    );
    render(
      <DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />,
    );
    await clickExport();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No Default template uploaded yet.",
    );
  });

  it("lỗi không có JSON body → vẫn nói được mã HTTP", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      blob: async () => new Blob([]),
      json: async () => {
        throw new Error("not json");
      },
    });
    render(
      <DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />,
    );
    await clickExport();
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 500");
  });
});

describe("banner X-Truncated-Cells — vai CÔNG BỐ, không phải báo lỗi", () => {
  it("0 ô → không có banner nào", async () => {
    render(
      <DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />,
    );
    await clickExport();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("N ô → banner nói 'ít chữ số hơn dữ liệu gốc', KHÔNG dùng chữ error/failed", async () => {
    fetchMock.mockResolvedValue(xlsxResponse({ truncated: 3 }));
    render(
      <DefaultMatrixView matrix={MATRIX} uploadedAt={null} uploadedBy={null} />,
    );
    await clickExport();
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("3 cells");
    expect(status).toHaveTextContent(/fewer decimal digits/i);
    expect(status.textContent ?? "").not.toMatch(/error|failed|invalid/i);
    // Và nó KHÔNG phải alert — không tô đỏ, không đọc như lỗi.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
