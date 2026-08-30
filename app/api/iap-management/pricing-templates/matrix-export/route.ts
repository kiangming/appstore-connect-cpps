/**
 * POST /api/iap-management/pricing-templates/matrix-export
 *
 * Xuất ma trận Pricing Template (Default hoặc Per-App) ra .xlsx — đúng thứ
 * màn "View matrix" đang hiện, đúng tập nước đang hiện sau bộ lọc.
 *
 * ─── VÌ SAO LÀ ROUTE SERVER CHỨ KHÔNG DỰNG FILE Ở CLIENT ───────────────────
 *
 * Đường CSV cũ dựng file ngay trong trình duyệt (`triggerCsvDownload`). Không
 * làm được nữa: writer dùng `exceljs`, mà exceljs là dependency SERVER-ONLY
 * (KB §4.17) — kéo nó vào bundle browser là đúng thứ quyết định đó tránh.
 *
 * ⚠ HỆ QUẢ: tập nước sau bộ lọc là state của CLIENT, nên nó phải đi lên đây.
 * Và thứ gì client gửi lên thì phải validate. Xem khối validate bên dưới —
 * đó là phần đáng đọc nhất của file này.
 *
 * ─── ROUTING: `matrix-export` LÀ SIBLING TĨNH CỦA `[templateId]` ───────────
 *
 * Next ưu tiên segment tĩnh trước segment động, nên `/matrix-export` không
 * rơi vào `[templateId]`. Điều này KHÔNG được tin suông — có test trong
 * `matrix-export.routing.test.ts`. Hình dạng này cũng đã sống sẵn trong repo
 * ở phía Google: `pricing-templates/availability/` là sibling tĩnh của
 * `pricing-templates/[id]/`, và cả hai đều có mặt riêng trong
 * `app-paths-manifest.json` sau build.
 */
import { NextResponse } from "next/server";

import {
  requireIapSession,
  IapUnauthorizedError,
} from "@/lib/iap-management/auth";
import { getActiveAccount } from "@/lib/get-active-account";
import { iapDb } from "@/lib/iap-management/db";
import {
  fetchDefaultMatrix,
  fetchPerAppMatrix,
  type MatrixMarket,
} from "@/lib/iap-management/queries/template-matrix";
import {
  buildTemplateMatrixWorkbook,
  templateMatrixXlsxFilename,
  type TemplateMatrixScope,
} from "@/lib/iap-management/xlsx-template-matrix-export";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

const LOG_FEATURE = "iap-pricing-template-matrix-export";

interface MatrixExportRequestBody {
  scope?: unknown;
  appId?: unknown;
  territories?: unknown;
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
 * ⚠ VALIDATE CHẶT, KHÔNG ÉP KIỂU. Mọi trường bị từ chối bằng 400 kèm câu nói
 * rõ sai chỗ nào, thay vì ép về giá trị "hợp lý" rồi xuất một file không ai
 * yêu cầu. Một `showDiff: "false"` ép thành `true` bằng truthiness sẽ tô cam
 * một file mà người dùng vừa tắt highlight.
 */
function validate(body: MatrixExportRequestBody): ValidBody | NextResponse {
  const { scope, appId, territories, showDiff } = body;

  if (scope !== "default" && scope !== "per-app") {
    return badRequest('Field "scope" must be "default" or "per-app".');
  }
  if (typeof showDiff !== "boolean") {
    return badRequest('Field "showDiff" must be a boolean.');
  }
  if (!Array.isArray(territories)) {
    return badRequest('Field "territories" must be an array of territory codes.');
  }
  if (territories.some((t) => typeof t !== "string" || t.trim() === "")) {
    return badRequest('Field "territories" must contain non-empty strings only.');
  }
  // ⚠ MẢNG RỖNG LÀ 400, KHÔNG PHẢI "XUẤT TẤT CẢ" — cùng tiền lệ với route
  // export item list. `[]` chỉ đến từ một client bug hoặc một UI cho bấm khi
  // bộ lọc không còn nước nào; mở rộng nó thành "tất cả" là lặng lẽ xuất một
  // file KHÁC hẳn thứ màn đang hiện. Màn ở trạng thái đó hiện "No territories
  // match the active filters", và một file rỗng nghĩa là gì thì không ai định
  // nghĩa — nên nó bị từ chối ở đây thay vì được đoán.
  if (territories.length === 0) {
    return badRequest(
      "No territories selected — the matrix view has nothing to export. " +
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
    // nó vô hại. Nhưng phép đếm ở dưới dùng kích thước ĐÃ khử trùng lặp, để
    // một client gửi 3 lần "USA" không thể làm phép đếm ấy tự đúng.
    requested: new Set(territories as string[]),
    showDiff,
  };
}

async function loadBundleId(appId: string): Promise<string | null> {
  const { data, error } = await iapDb()
    .from("apps")
    .select("bundle_id")
    .eq("id", appId)
    .maybeSingle();
  if (error) throw new Error(`App lookup failed: ${error.message}`);
  return (data as { bundle_id: string } | null)?.bundle_id ?? null;
}

export async function POST(req: Request) {
  try {
    await requireIapSession();
  } catch (err) {
    if (err instanceof IapUnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const raw = (await req.json().catch(() => null)) as MatrixExportRequestBody | null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return badRequest("Invalid JSON body.");
  }
  const checked = validate(raw);
  if (checked instanceof NextResponse) return checked;
  const { scope, appId, requested, showDiff } = checked;

  try {
    // ⚠ ACCOUNT ĐỌC Ở SERVER, KHÔNG NHẬN TỪ CLIENT. Bài học C-D: một đường
    // đọc template mặc định mà không nói rõ "của account nào" là chỗ suýt mất
    // 1140 ô. Ở đây nó là câu trả lời cho một câu hỏi khác nhưng cùng một kỷ
    // luật — danh tính đến từ session, dữ liệu hiển thị đến từ client.
    const creds = await getActiveAccount();

    const result =
      scope === "per-app"
        ? await fetchPerAppMatrix(appId as string, creds.id)
        : await fetchDefaultMatrix(creds.id);

    if (!result) {
      return NextResponse.json(
        {
          error:
            scope === "per-app"
              ? "No Per-App template for this app."
              : "No Default template for the active account.",
        },
        { status: 404 },
      );
    }

    const { matrix } = result;

    // ── Mã lạ → 409, KHÔNG im lặng bỏ ────────────────────────────────────────
    //
    // Một mã client xin mà ma trận không có chỉ đến từ hai chỗ: client bug,
    // hoặc template bị upload đè trong khoảng giữa lúc mở màn và lúc bấm nút.
    // Cả hai đều cần người biết. Lặng lẽ bỏ nó đi sẽ cho ra một file thiếu
    // cột mà không có gì trong file nói vì sao — đúng lớp lỗi silent-drop mà
    // arc export item list đã phải gỡ.
    //
    // ⚠ 409 chứ không 400: request không sai cú pháp, nó chỉ không còn khớp
    // với dữ liệu nữa. Và ⚠ LIỆT KÊ MÃ, không phải đếm (KB §4.21) — "3 mã
    // lạ" không nói được gì; "PRT ITA" nói được ngay là template đã đổi.
    const known = new Set(matrix.markets.map((m) => m.code));
    const unknown = [...requested].filter((code) => !known.has(code));
    if (unknown.length > 0) {
      await log(
        LOG_FEATURE,
        `unknown territories in export request: ${unknown.join(" ")}`,
        "WARN",
      );
      return NextResponse.json(
        {
          error:
            "The pricing template changed since this page was loaded — " +
            `it no longer covers: ${unknown.join(", ")}. Reload and try again.`,
          unknownTerritories: unknown,
        },
        { status: 409 },
      );
    }

    // ── THỨ TỰ CỘT ĐẾN TỪ `matrix.markets`, KHÔNG TỪ MẢNG CLIENT ────────────
    //
    // ⚠ ĐÂY LÀ DÒNG QUAN TRỌNG NHẤT CỦA ROUTE. `requested` chỉ được hỏi
    // "có/không". Thứ tự nước là thứ tự CỘT trong file .xlsx Manager upload
    // (Hotfix 24) — đó là thứ Manager dùng để đọc bảng, và nó KHÔNG phải
    // alphabet. Nếu lấy thứ tự từ mảng client thì một `JSON.stringify` của
    // một `Set` được duyệt khác đi, hay một client sắp lại cho "gọn", sẽ đổi
    // bố cục file mà không ai sửa gì cả.
    const visibleMarkets: MatrixMarket[] = matrix.markets.filter((m) =>
      requested.has(m.code),
    );

    // ⚠ ĐẾM (KB §4.20 điểm 3). Một khẳng định về HÌNH DẠNG vẫn pass khi mã ở
    // sai bảng chữ cái; một TỔNG thì không. Tới đây `unknown` đã rỗng nên hai
    // số này phải bằng nhau — lệch nghĩa là bộ lọc vừa đánh rơi một nước, và
    // ghi ra một file thiếu cột thì im lặng hơn là throw.
    if (visibleMarkets.length !== requested.size) {
      throw new Error(
        `Territory filter dropped columns: expected ${requested.size}, ` +
          `got ${visibleMarkets.length}.`,
      );
    }

    const workbook = buildTemplateMatrixWorkbook({
      matrix,
      visibleMarkets,
      showDiff,
      scope,
    });

    // ⚠ `writeBuffer()` CỦA exceljs LÀ ASYNC — khác `write()` đồng bộ của
    // xlsx. Thiếu `await` ở đây sẽ gửi một Promise vào NextResponse và tải về
    // một file có đúng nội dung "[object Promise]".
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    // bundle_id đọc ở SERVER, không nhận từ client — nó đi vào tên file, và
    // tên file đi vào Content-Disposition.
    const bundleId =
      scope === "per-app" ? ((await loadBundleId(appId as string)) ?? undefined) : undefined;
    const filename = templateMatrixXlsxFilename({ scope, bundleId });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        // Hai con số này trả lời "file vừa rồi có gì", để toast phía client
        // nói được điều gì đó thật thay vì "xong".
        "X-Export-Tier-Count": String(matrix.tiers.length),
        "X-Export-Territory-Count": String(visibleMarkets.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate export";
    await log(LOG_FEATURE, `export failed: ${message}`, "ERROR");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
