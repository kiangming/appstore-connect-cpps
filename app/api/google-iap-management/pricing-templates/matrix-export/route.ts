/**
 * POST /api/google-iap-management/pricing-templates/matrix-export
 *
 * Xuất ma trận Google Pricing Template (Default hoặc Per-App) ra .xlsx — đúng
 * thứ màn "View matrix" đang hiện, đúng tập nước đang hiện sau bộ lọc.
 *
 * ─── VÌ SAO LÀ ROUTE SERVER CHỨ KHÔNG DỰNG FILE Ở CLIENT ───────────────────
 *
 * Đường CSV cũ dựng file ngay trong trình duyệt (`csv-export.ts`
 * → `triggerCsvDownload`). Không làm được nữa: writer dùng `exceljs`, mà
 * exceljs là dependency SERVER-ONLY (KB §4.17). Đo thật, không đọc doc: import
 * nó vào màn client làm `/settings/pricing-templates/default` phình từ
 * **169 kB lên 424 kB** First Load JS (+255 kB, gấp 2,5 lần).
 *
 * ⚠ HỆ QUẢ: tập nước sau bộ lọc là state của CLIENT, nên nó phải đi lên đây.
 * Và thứ gì client gửi lên thì phải validate. Khối validate bên dưới là phần
 * đáng đọc nhất của file này.
 *
 * ─── ROUTING: `matrix-export` LÀ SIBLING TĨNH CỦA `[id]` ───────────────────
 *
 * Thư mục `pricing-templates/` đã có `[id]/route.ts` (DELETE). Next ưu tiên
 * segment tĩnh trước segment động nên `/matrix-export` không rơi vào `[id]`.
 * KHÔNG tin suông — `routing.test.ts` cạnh file này canh hai tầng. Tiền lệ đã
 * sống sẵn ngay trong thư mục này: `availability/` và `tier-entries/` cũng là
 * sibling tĩnh của `[id]/`.
 *
 * ─── SESSION GUARD: THEO KHUÔN GOOGLE, KHÔNG THEO KHUÔN APPLE ──────────────
 *
 * Dùng `getServerSession(authOptions)` inline — đúng khuôn của BỐN route anh
 * em trong chính thư mục này (`route.ts:21-24`, `[id]/route.ts:18-21`,
 * `availability/route.ts:22-25`, `tier-entries/route.ts:45-48`). KHÔNG dùng
 * `requireGoogleIapSession()` của `lib/google-iap-management/auth.ts`: docblock
 * của nó tự giới hạn phạm vi cho các route hub-tracking, và phần còn lại của
 * module cố ý giữ khuôn inline. Apple thì ngược lại — Apple có
 * `requireIapSession()` dùng chung; chép sang đây sẽ là khuôn của module khác.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth";
import {
  readActiveAccountId,
  resolveActiveAccountId,
} from "@/lib/google-iap-management/active-account";
import { getAppById } from "@/lib/google-iap-management/repository/apps";
import { listAccounts } from "@/lib/google-iap-management/repository/google-accounts";
import {
  fetchDefaultMatrix,
  fetchPerAppMatrix,
  type MatrixMarket,
} from "@/lib/google-iap-management/queries/template-matrix";
import {
  templateMatrixXlsxFilename,
  writeTemplateMatrixXlsx,
  type TemplateMatrixScope,
} from "@/lib/google-iap-management/xlsx-template-matrix-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface MatrixExportRequestBody {
  scope?: unknown;
  appId?: unknown;
  regionCodes?: unknown;
  showDiff?: unknown;
}

/** Payload đã qua validate — mọi trường ở đây đã có kiểu thật. */
interface ValidBody {
  scope: TemplateMatrixScope;
  appId: string | null;
  /** Mã nước client xin, ĐÃ khử trùng lặp. Dùng làm BỘ LỌC, không phải thứ tự. */
  requested: Set<string>;
  showDiff: boolean;
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * ⚠ VALIDATE CHẶT, KHÔNG ÉP KIỂU. Mọi trường sai bị từ chối bằng 400 kèm câu
 * nói rõ sai chỗ nào, thay vì ép về một giá trị "hợp lý" rồi xuất một file
 * không ai yêu cầu. Một `showDiff: "false"` ép thành `true` bằng truthiness sẽ
 * tô amber một file mà người dùng vừa tắt công tắc highlight — file nói khác
 * màn, đúng lớp lỗi F1 mà cả arc này sinh ra để gỡ.
 */
function validate(body: MatrixExportRequestBody): ValidBody | NextResponse {
  const { scope, appId, regionCodes, showDiff } = body;

  if (scope !== "default" && scope !== "per-app") {
    return badRequest('Field "scope" must be "default" or "per-app".');
  }
  if (typeof showDiff !== "boolean") {
    return badRequest('Field "showDiff" must be a boolean.');
  }
  if (!Array.isArray(regionCodes)) {
    return badRequest('Field "regionCodes" must be an array of region codes.');
  }
  if (regionCodes.some((c) => typeof c !== "string" || c.trim() === "")) {
    return badRequest('Field "regionCodes" must contain non-empty strings only.');
  }
  // ⚠ MẢNG RỖNG LÀ 400, KHÔNG PHẢI "XUẤT TẤT CẢ". `[]` chỉ đến từ một client
  // bug hoặc một UI cho bấm khi bộ lọc không còn nước nào; mở rộng nó thành
  // "tất cả" là lặng lẽ xuất một file KHÁC hẳn thứ màn đang hiện. Ở trạng thái
  // đó màn hiện "No markets match the active filters" (MatrixTable.tsx:53-61),
  // và một file rỗng nghĩa là gì thì không ai định nghĩa — nên nó bị từ chối
  // ở đây thay vì được đoán.
  if (regionCodes.length === 0) {
    return badRequest(
      "No markets selected — the matrix view has nothing to export. " +
        "Clear the filters and try again.",
    );
  }
  // ⚠ per-app thì PHẢI có appId. Thiếu mà vẫn chạy tiếp sẽ rơi xuống nhánh
  // Default và xuất nhầm template — sai file, không phải lỗi to tiếng.
  if (scope === "per-app" && (typeof appId !== "string" || appId.trim() === "")) {
    return badRequest('Field "appId" is required when scope is "per-app".');
  }

  return {
    scope,
    appId: scope === "per-app" ? (appId as string).trim() : null,
    // Khử trùng lặp: mã lặp không phải một lời nói dối, và bộ lọc là Set nên
    // nó vô hại. Nhưng phép ĐẾM ở dưới dùng kích thước ĐÃ khử trùng lặp, để
    // một client gửi 3 lần "VN" không thể làm phép đếm ấy tự đúng.
    requested: new Set(regionCodes as string[]),
    showDiff,
  };
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = (await req.json().catch(() => null)) as MatrixExportRequestBody | null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return badRequest("Invalid JSON body.");
  }
  const checked = validate(raw);
  if (checked instanceof NextResponse) return checked;
  const { scope, appId, requested, showDiff } = checked;

  try {
    // ⚠ ACCOUNT ĐỌC Ở SERVER, KHÔNG NHẬN TỪ CLIENT. Body không có trường
    // account nào, và nếu client gửi thêm thì nó bị bỏ qua — `validate` chỉ
    // đọc bốn trường nó biết. Danh tính đến từ cookie + session; dữ liệu hiển
    // thị mới đến từ client. Kỷ luật này là thứ arc Apple đã chốt sau ca suýt
    // ghi đè 1140 ô của một account đang không nhìn.
    const accounts = await listAccounts().catch(() => []);
    const accountId = resolveActiveAccountId(accounts, readActiveAccountId());
    if (!accountId) {
      return NextResponse.json(
        {
          error:
            "No Google Console accounts configured. Add one in Settings → " +
            "Google Console Accounts first.",
        },
        { status: 400 },
      );
    }

    // Per-App cần `package_name` cho tên file. Lấy luôn dịp này để KIỂM app
    // có thuộc account đang active không.
    //
    // ⚠ SIẾT CÓ CHỦ Ý, CHỈ TRÊN SURFACE MỚI NÀY. Census phát hiện
    // `settings/pricing-templates/per-app/[appId]/page.tsx:31` gọi
    // `getAppById(appId)` mà KHÔNG lọc account — biết `appId` là xem được
    // template của account khác. Route này không lặp lại lỗ đó. Màn cũ giữ
    // nguyên hành vi (sửa nó là việc của arc G1, cùng chỗ với `listAppTemplates`).
    // Trả 404 chứ không 403: không xác nhận cho người gọi rằng id đó có tồn tại.
    let packageName: string | undefined;
    if (scope === "per-app" && appId) {
      const app = await getAppById(appId);
      if (!app || app.google_console_account_id !== accountId) {
        return NextResponse.json(
          { error: "App not found for the active Google Console account." },
          { status: 404 },
        );
      }
      packageName = app.package_name;
    }

    const matrix =
      scope === "per-app"
        ? await fetchPerAppMatrix(appId as string)
        : await fetchDefaultMatrix();

    // ⚠ CÙNG ĐƯỜNG ĐỌC VỚI MÀN (B8). `fetchDefaultMatrix` / `fetchPerAppMatrix`
    // là đúng hai hàm hai page đang gọi. Dựng một đường đọc riêng cho export
    // là cách chắc chắn nhất để sáu tháng nữa file và màn nói khác nhau mà
    // không test nào thấy.
    if (!matrix) {
      return NextResponse.json(
        {
          error:
            scope === "per-app"
              ? "No Per-App template for this app."
              : "No Default template uploaded yet.",
        },
        { status: 404 },
      );
    }

    // ── Mã lạ → 409, KHÔNG im lặng bỏ ────────────────────────────────────────
    //
    // Một mã client xin mà ma trận không có chỉ đến từ hai chỗ: client bug,
    // hoặc template bị upload đè trong khoảng giữa lúc mở màn và lúc bấm nút
    // (template là REPLACE-ONLY nên chuyện này có thật). Cả hai đều cần người
    // biết. Lặng lẽ bỏ đi sẽ cho ra một file thiếu cột mà không có gì trong
    // file nói vì sao.
    //
    // ⚠ 409 chứ không 400: request không sai cú pháp, nó chỉ không còn khớp
    // với dữ liệu nữa. Và ⚠ LIỆT KÊ MÃ, không phải đếm — "3 mã lạ" không nói
    // được gì; "KH MM" nói ngay là template đã đổi.
    const known = new Set(matrix.markets.map((m) => m.code));
    const unknown = [...requested].filter((code) => !known.has(code));
    if (unknown.length > 0) {
      console.warn(
        `[google-iap:matrix-export] unknown region codes: ${unknown.join(" ")}`,
      );
      return NextResponse.json(
        {
          error:
            "The pricing template changed since this page was loaded — " +
            `it no longer covers: ${unknown.join(", ")}. Reload and try again.`,
          unknownRegionCodes: unknown,
        },
        { status: 409 },
      );
    }

    // ── THỨ TỰ CỘT ĐẾN TỪ `matrix.markets`, KHÔNG TỪ MẢNG CLIENT ────────────
    //
    // ⚠ ĐÂY LÀ DÒNG QUAN TRỌNG NHẤT CỦA ROUTE — và nó là một dòng KHÔNG CÓ.
    // Route KHÔNG sắp `requested` lại, KHÔNG chuyển nó thành mảng có thứ tự,
    // KHÔNG đưa thứ tự nào xuống writer. Nó chỉ chuyển tiếp tập mã; writer tự
    // `matrix.markets.filter(...)` (C1), nên thứ tự cột là thứ tự CỘT trong
    // file .xlsx Manager upload (Hotfix 24) — thứ Manager dùng để đọc bảng, và
    // KHÔNG phải alphabet. Hai lần xáo trộn cùng một lựa chọn phải cho file
    // byte-identical.
    const visibleMarkets: MatrixMarket[] = matrix.markets.filter((m) =>
      requested.has(m.code),
    );

    // ⚠ ĐẾM (KB §4.20). Tới đây `unknown` đã rỗng nên hai số này PHẢI bằng
    // nhau. Một khẳng định về HÌNH DẠNG vẫn pass khi bộ lọc đánh rơi một nước;
    // một TỔNG thì không. Ghi ra file thiếu cột thì im lặng hơn là throw.
    if (visibleMarkets.length !== requested.size) {
      throw new Error(
        `Region filter dropped columns: asked ${requested.size}, matched ` +
          `${visibleMarkets.length}. Refusing to write a short file.`,
      );
    }

    const result = await writeTemplateMatrixXlsx({
      matrix,
      regionCodes: [...requested],
      showDiff,
      scope,
    });

    // ⚠ COUNT ASSERT tầng hai — trên số cột writer THỰC SỰ ghi ra, không trên
    // số cột route tính được. Hai phép đếm khác nhau ở hai bên của một lời gọi
    // hàm; chúng chỉ bằng nhau khi writer làm đúng thứ nó nói.
    if (result.columnCount !== requested.size) {
      throw new Error(
        `Writer wrote ${result.columnCount} market columns, expected ` +
          `${requested.size}. Refusing to serve a short file.`,
      );
    }

    const filename = templateMatrixXlsxFilename({ scope, packageName });

    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": XLSX_MIME,
        // ⚠ `filename` đã đi qua whitelist `[a-z0-9._-]` trong
        // `templateMatrixXlsxFilename` — `\r`, `\n`, `"` đều bị thay bằng `_`,
        // nên `package_name` không tách được header này làm đôi. Đó là tầng 2
        // của bản thay thế cho test bảo mật của `csvFilename` (tầng 1 là test
        // của chính hàm tên file); `route.test.ts` canh đúng ca đó.
        "Content-Disposition": `attachment; filename="${filename}"`,
        // Số ô mà màn (và do đó cả file) hiện ít chữ số hơn `price_micros`
        // đang giữ. CÔNG BỐ, không phải lỗi — xem docblock của
        // `TemplateMatrixExportResult.truncatedCells`.
        "X-Truncated-Cells": String(result.truncatedCells),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to build the .xlsx export.";
    console.error(`[google-iap:matrix-export] ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
