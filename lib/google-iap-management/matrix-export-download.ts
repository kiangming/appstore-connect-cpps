/**
 * Gọi route matrix-export và tải file về — dùng chung cho HAI màn matrix.
 *
 * ─── VÌ SAO LÀ MODULE RIÊNG ────────────────────────────────────────────────
 *
 * `DefaultMatrixView` và `PerAppMatrixView` gọi cùng một route với cùng một
 * cách xử lý lỗi. Chép đôi ra hai màn là cách chắc chắn nhất để sáu tháng nữa
 * một màn báo lỗi 409 nêu tên nước còn màn kia nuốt thành "Export failed".
 *
 * Khuôn tải theo ĐÚNG khuôn đang có của module Google
 * (`IapListClient.tsx:169-208` — export item list): `fetchWithTimeout` → kiểm
 * `res.ok` → đọc `error` từ JSON → `res.blob()` → lấy tên file từ
 * `Content-Disposition` → anchor + `createObjectURL` → `revokeObjectURL` → đọc
 * một header phụ để hiện tóm tắt. KHÔNG chép khuôn Apple
 * (`lib/iap-management/matrix-export-download.ts`) — module này có khuôn riêng
 * và nó đã qua UAT.
 *
 * ⚠ Module THƯỜNG (không "use client"): nó chỉ chạm `window`/`document` bên
 * trong hàm, và cả hai màn gọi nó đều là client component. Giữ nó ở `lib/`
 * cho phép test nó ở môi trường jsdom mà không phải dựng React.
 */
import { fetchWithTimeout } from "./client/refresh-fetch";
import type { TemplateMatrixScope } from "./xlsx-template-matrix-export";

/** 60s: file Default thật là 94 tier × 9 nước và writer chạy server-side. */
const EXPORT_TIMEOUT_MS = 60_000;

const ENDPOINT = "/api/google-iap-management/pricing-templates/matrix-export";

export interface MatrixExportRequest {
  scope: TemplateMatrixScope;
  /** Bắt buộc khi scope = "per-app". */
  appId?: string;
  /** ⚠ BỘ LỌC, không phải thứ tự — server bỏ qua thứ tự của mảng này. */
  regionCodes: string[];
  /** ⚠ F1 — trạng thái THẬT của công tắc "Highlight differences" trên màn. */
  showDiff: boolean;
}

export interface MatrixExportResult {
  filename: string;
  /** Từ header `X-Truncated-Cells`. CÔNG BỐ, không phải lỗi. */
  truncatedCells: number;
}

/** Lỗi có đọc được — mang theo đủ thứ để màn nói được chuyện gì xảy ra. */
export class MatrixExportError extends Error {
  readonly status: number;
  /** Chỉ có ở 409: mã nước mà template không còn phủ. */
  readonly unknownRegionCodes: string[] | null;

  constructor(status: number, message: string, unknownRegionCodes?: string[]) {
    super(message);
    this.name = "MatrixExportError";
    this.status = status;
    this.unknownRegionCodes = unknownRegionCodes ?? null;
  }
}

/**
 * Câu hiện lên màn cho một lỗi export.
 *
 * ⚠ 409 KHÔNG dùng câu prose của server — nó tự dựng câu từ
 * `unknownRegionCodes`. Lý do: danh sách mã là DỮ LIỆU, còn câu prose là văn
 * bản có thể đổi; bám vào dữ liệu thì màn không im lặng hỏng khi server đổi
 * chữ. Các mã còn lại dùng `message` của server vì server là chỗ biết lý do.
 */
export function describeMatrixExportError(err: unknown): string {
  if (err instanceof MatrixExportError) {
    if (err.status === 409 && err.unknownRegionCodes?.length) {
      return (
        "The pricing template changed since this page was loaded — it no longer " +
        `covers: ${err.unknownRegionCodes.join(", ")}. Reload the page and try again.`
      );
    }
    return err.message;
  }
  if (err instanceof Error) {
    return err.message.includes("timed out")
      ? "The export took too long. Try again, or narrow the market filter."
      : err.message;
  }
  return "Export failed.";
}

/** Tên file dự phòng khi `Content-Disposition` thiếu/hỏng. */
function fallbackFilename(scope: TemplateMatrixScope): string {
  return `google-pricing-template-${scope}.xlsx`;
}

export async function downloadMatrixExport(
  request: MatrixExportRequest,
): Promise<MatrixExportResult> {
  const res = await fetchWithTimeout(
    ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // ⚠ CHỈ BỐN TRƯỜNG. Không gửi `accountId` — danh tính đến từ session +
      // cookie ở server; một `accountId` gửi lên sẽ bị route bỏ qua, nhưng
      // gửi nó vẫn sai vì nó nói rằng client có quyền chọn account.
      // Không gửi `defaultTemplateExists` — file phải bám CÔNG TẮC (F1).
      body: JSON.stringify({
        scope: request.scope,
        ...(request.appId ? { appId: request.appId } : {}),
        regionCodes: request.regionCodes,
        showDiff: request.showDiff,
      }),
    },
    EXPORT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      unknownRegionCodes?: string[];
    };
    throw new MatrixExportError(
      res.status,
      body.error ?? `Export failed (HTTP ${res.status}).`,
      body.unknownRegionCodes,
    );
  }

  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match?.[1] ?? fallbackFilename(request.scope);

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const raw = res.headers.get("X-Truncated-Cells");
  const truncatedCells = raw !== null && /^\d+$/.test(raw) ? Number(raw) : 0;
  return { filename, truncatedCells };
}

/**
 * Câu banner khi có ô bị cắt chữ số.
 *
 * ⚠ VAI TRÒ LÀ CÔNG BỐ, KHÔNG PHẢI BÁO LỖI. Dưới thiết kế đã chốt (V4 phương
 * án (a)) không ô nào hiện SAI — file khớp màn ở mọi ca đã đo. Con số này chỉ
 * nói "chỗ này màn đang hiện ít chữ số hơn dữ liệu gốc đang giữ", để việc mất
 * chữ số không diễn ra im lặng. Câu chữ vì thế không có "error", không có
 * "failed", không có màu đỏ.
 */
export function truncatedCellsNotice(count: number): string | null {
  if (count <= 0) return null;
  return (
    `${count} cell${count === 1 ? "" : "s"} in this file show fewer decimal ` +
    "digits than the stored data holds — the file matches what the screen " +
    "shows. Currencies with no decimal places (VND, IDR, TWD…) are displayed " +
    "as whole numbers."
  );
}
