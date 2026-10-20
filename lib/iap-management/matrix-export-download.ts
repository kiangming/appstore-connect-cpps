/**
 * Gọi route xuất ma trận rồi tải file về — dùng chung cho cả hai màn matrix.
 *
 * ⚠ MODULE NÀY KHÔNG ĐỘNG TỚI exceljs. Nó chỉ `fetch` và đẩy blob xuống đĩa;
 * việc dựng workbook nằm ở server (KB §4.17 — exceljs là dependency
 * server-only, kéo vào bundle browser là đúng thứ quyết định đó tránh).
 *
 * Khuôn tải file lấy từ `IapListClient.tsx:433-460`: đọc tên file từ
 * `Content-Disposition` thay vì tự đoán, để tên file là thứ SERVER quyết —
 * server là nơi biết `bundle_id` thật và là nơi đã khử ký tự nguy hiểm.
 *
 * ─── VÌ SAO LỖI KHÔNG BỊ NUỐT THÀNH MỘT CÂU CHUNG ──────────────────────────
 *
 * Route trả ba loại từ chối khác nhau và mỗi loại dẫn tới một hành động khác
 * nhau của người dùng:
 *
 *   400  payload sai / bộ lọc không còn nước nào  → sửa bộ lọc
 *   404  chưa có template cho scope này            → đi upload
 *   409  template đã đổi từ lúc mở màn             → tải lại trang
 *
 * Gộp cả ba thành "Export failed" là buộc người đọc phải đoán xem mình vừa
 * làm sai gì. Thân lỗi của route đã mang sẵn câu nói rõ (409 còn liệt kê
 * đích danh mã nước), nên ở đây dùng nguyên văn nó; chuỗi dự phòng chỉ dùng
 * khi thân rỗng, và cũng đặt riêng theo status thay vì một câu cho cả ba.
 */

export interface MatrixExportRequest {
  scope: "default" | "per-app";
  /** Bắt buộc khi scope = "per-app". Route từ chối 400 nếu thiếu. */
  appId?: string;
  /** Mã nước đang hiện sau bộ lọc. Route dùng làm BỘ LỌC, không phải thứ tự. */
  territories: string[];
  /** Trạng thái THẬT của công tắc "Highlight differences" trên màn (F1). */
  showDiff: boolean;
}

export const MATRIX_EXPORT_ENDPOINT =
  "/api/iap-management/pricing-templates/matrix-export";

/** Câu dự phòng khi route trả lỗi mà thân không có `error`. Một câu cho mỗi
 *  status, vì ba status này dẫn tới ba hành động khác nhau. */
function fallbackMessage(status: number): string {
  if (status === 400) return "The export request was rejected — check the filters.";
  if (status === 401) return "Session expired — sign in again.";
  if (status === 404) return "No pricing template has been uploaded for this scope yet.";
  if (status === 409)
    return "The pricing template changed since this page was loaded — reload and try again.";
  return `Export failed (${status}).`;
}

/**
 * Trả `null` khi tải thành công, hoặc câu lỗi để caller đưa vào toast.
 *
 * ⚠ Không tự gọi toast: giữ module này thuần I/O để test được mà không phải
 * mock thư viện toast, và để mỗi màn tự quyết hiển thị ra sao.
 */
export async function downloadMatrixExport(
  req: MatrixExportRequest,
): Promise<string | null> {
  // ⚠ CHỈ bốn trường này. KHÔNG gửi accountId — danh tính do session quyết,
  // route tự đọc (kỷ luật C-D). KHÔNG gửi defaultTemplateExists — cái file
  // phải bám là CÔNG TẮC, không phải sự tồn tại của template Default (F1).
  const res = await postAndDownload(JSON.stringify(req), `apple-pricing-template-${req.scope}.xlsx`);
  return res.ok ? null : res.error;
}

export type MatrixEditExportResult =
  | { ok: true; tierCount: number | null; territoryCount: number | null }
  | { ok: false; error: string };

/**
 * PA2.3 — "Export for editing" (Manager Q-B). ⚠ KHÔNG gửi `territories` hay
 * `showDiff`: file để sửa luôn là CẢ template, đọc ở server — một danh sách
 * nước từ màn (đã lọc, hoặc cũ) là đúng thứ làm import lại xoá override.
 *
 * Default: gửi `accountId` = account TRANG NÀY đang hiện. Route đọc account
 * từ session (dùng chung mọi tab); đổi account ở tab khác rồi bấm nút ở tab
 * này sẽ ra file của account KHÁC với tên trên màn — route so hai cái và từ
 * chối (409) thay vì lặng lẽ xuất nhầm.
 *
 * Kết quả mang SỐ TIER / SỐ NƯỚC server thật sự ghi vào file (header
 * X-Export-*), để toast nói đúng file chứ không phải màn lúc tải trang.
 */
export async function downloadMatrixExportForEditing(
  req: { scope: "default"; accountId: string } | { scope: "per-app"; appId: string },
): Promise<MatrixEditExportResult> {
  const body =
    req.scope === "default"
      ? { scope: req.scope, accountId: req.accountId, mode: "edit" }
      : { scope: req.scope, appId: req.appId, mode: "edit" };
  return postAndDownload(JSON.stringify(body), `apple-pricing-template-${req.scope}-for-editing.xlsx`);
}

/** The toast after "Export for editing": what the SERVER put in the file. */
export function editExportSuccessMessage(r: { tierCount: number | null; territoryCount: number | null }): string {
  return r.tierCount !== null && r.territoryCount !== null
    ? `Exported for editing: ${r.tierCount} tiers × ${r.territoryCount} territories — the whole template.`
    : "Exported for editing — the whole template.";
}

async function postAndDownload(body: string, fallbackFilename: string): Promise<MatrixEditExportResult> {
  const res = await fetch(MATRIX_EXPORT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? fallbackMessage(res.status) };
  }

  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match?.[1] ?? fallbackFilename;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  const count = (name: string) => {
    const v = res.headers.get(name);
    return v !== null && /^\d+$/.test(v) ? Number(v) : null;
  };
  return { ok: true, tierCount: count("X-Export-Tier-Count"), territoryCount: count("X-Export-Territory-Count") };
}
