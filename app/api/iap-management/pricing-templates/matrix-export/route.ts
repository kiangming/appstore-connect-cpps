/**
 * POST /api/iap-management/pricing-templates/matrix-export
 *
 * Xuất ma trận Pricing Template (Default hoặc Per-App) ra .xlsx — đúng thứ
 * màn "View matrix" đang hiện, đúng tập nước đang hiện sau bộ lọc.
 *
 * PA2 (Manager 2026-10-19, Q-B) — `mode: "edit"` là "Export for editing":
 * file để SỬA rồi import lại. LUÔN đủ mọi nước của template, đọc từ server
 * (không bao giờ từ danh sách nước client — R1 / R1b), header `Name (CODE_CUR)`
 * và một sheet ẩn nói file thuộc template nào. Vắng `mode` ⇒ file để xem,
 * y hệt trước PA2.
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
import { getAppIdentity } from "@/lib/iap-management/queries/iaps";
import { appleCurrencyFor } from "@/lib/iap-management/apple/apple-territories.snapshot";
import {
  fetchDefaultMatrix,
  fetchPerAppMatrix,
  type MatrixData,
  type MatrixMarket,
} from "@/lib/iap-management/queries/template-matrix";
import {
  buildTemplateMatrixWorkbook,
  templateMatrixXlsxFilename,
  type TemplateMatrixScope,
} from "@/lib/iap-management/xlsx-template-matrix-export";
import type { EditExportInfo } from "@/lib/iap-management/template-matrix-edit-spec";
import { log } from "@/lib/logger";

export const runtime = "nodejs";

const LOG_FEATURE = "iap-pricing-template-matrix-export";

interface MatrixExportRequestBody {
  scope?: unknown;
  appId?: unknown;
  territories?: unknown;
  showDiff?: unknown;
  mode?: unknown;
  accountId?: unknown;
}

/** Payload đã qua validate — mọi trường ở đây đã có kiểu thật. */
interface ValidBody {
  scope: TemplateMatrixScope;
  appId: string | null;
  /** Mã nước client xin, ĐÃ khử trùng lặp. Dùng làm BỘ LỌC, không phải thứ tự.
   *  Chỉ có nghĩa ở mode "view". */
  requested: Set<string>;
  showDiff: boolean;
  mode: "view" | "edit";
  /** Edit + Default only: the account the PAGE shows — checked against the
   *  session's account, never used instead of it. */
  pageAccountId: string | null;
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
  const { scope, appId, territories, showDiff, mode, accountId } = body;

  if (scope !== "default" && scope !== "per-app") {
    return badRequest('Field "scope" must be "default" or "per-app".');
  }
  if (mode !== undefined && mode !== "view" && mode !== "edit") {
    return badRequest('Field "mode" must be "view" or "edit".');
  }
  if (mode === "edit") {
    // ⚠ PA2 Q-B — `territories` và `showDiff` KHÔNG được đọc ở mode này, kể
    // cả khi client gửi: file để sửa luôn là CẢ template, và ô của nó không
    // mang tô màu diff (note của diff chứa giá Default — thứ import không
    // được đọc). Không có gì từ client quyết định nội dung file.
    if (scope === "per-app" && (typeof appId !== "string" || appId.trim() === "")) {
      return badRequest('Field "appId" is required when scope is "per-app".');
    }
    // ⚠ A Default file for editing names its account inside (Q-E), and the
    // Manager imports it back on the page of THAT account. The account read
    // below is the session's — shared by every tab — so the page must say
    // which account it shows, or a switch in another tab exports the other
    // account's Default under this page's heading.
    if (scope === "default" && (typeof accountId !== "string" || accountId.trim() === "")) {
      return badRequest('Field "accountId" (the account this page shows) is required when exporting a Default for editing.');
    }
    return {
      scope,
      appId: scope === "per-app" ? (appId as string).trim() : null,
      requested: new Set(),
      showDiff: false,
      mode: "edit",
      pageAccountId: scope === "default" ? (accountId as string).trim() : null,
    };
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
    mode: "view",
    pageAccountId: null,
  };
}

export async function POST(req: Request) {
  let exportedBy = "unknown";
  try {
    const session = await requireIapSession();
    exportedBy = session?.user?.email ?? "unknown";
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
  const { scope, appId, requested, showDiff, mode, pageAccountId } = checked;

  try {
    // ⚠ ACCOUNT ĐỌC Ở SERVER, KHÔNG NHẬN TỪ CLIENT. Bài học C-D: một đường
    // đọc template mặc định mà không nói rõ "của account nào" là chỗ suýt mất
    // 1140 ô. Ở đây nó là câu trả lời cho một câu hỏi khác nhưng cùng một kỷ
    // luật — danh tính đến từ session, dữ liệu hiển thị đến từ client.
    const creds = await getActiveAccount();
    if (pageAccountId !== null && pageAccountId !== creds.id) {
      await log(
        LOG_FEATURE,
        `edit export refused — page account ${pageAccountId} ≠ active account ${creds.id}`,
        "WARN",
      );
      return NextResponse.json(
        {
          error:
            `This page shows the Default template of account ${pageAccountId}, but the account selected ` +
            `in the top bar is now ${creds.name} (${creds.id}) — reload the page, then export again. No file was made.`,
          code: "ACCOUNT_CHANGED",
        },
        { status: 409 },
      );
    }

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

    if (mode === "edit") {
      return await editExport({ matrix, scope, appId, creds, exportedBy });
    }

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
      scope === "per-app" ? ((await getAppIdentity(appId as string))?.bundle_id ?? undefined) : undefined;
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

/**
 * PA2 "Export for editing" (Manager 2026-10-19, Q-B / Q-C / Q-E).
 *
 * ⚠ MỌI nước của template, theo thứ tự `matrix.markets` (Hotfix 24) — đọc từ
 *   server. Theo luật "file là sự thật duy nhất", một nước vắng mặt trong file
 *   là một nước BỊ XOÁ override khi import lại; nên file để sửa không bao giờ
 *   được thiếu nước: không lọc theo màn (R1), không tin danh sách client
 *   (R1b — client có thể chưa biết một nước template vừa thêm).
 */
async function editExport(args: {
  matrix: MatrixData;
  scope: TemplateMatrixScope;
  appId: string | null;
  creds: { id: string; name: string };
  exportedBy: string;
}): Promise<NextResponse> {
  const { matrix, scope, appId, creds, exportedBy } = args;
  const markets = matrix.markets;

  // Header nói MỘT currency cho cả cột (Q-C), và đó phải là currency Apple
  // tính cho nước đó (KB §4.19 — import đọc cùng snapshot và sẽ từ chối
  // header khác). Hai lỗi được gom vào MỘT 409 — sửa template là một lượt
  // upload ở Settings, không phải hai.
  //   • nhiều currency trong một nước: không ghi được thành một file tự nhất
  //     quán — nêu tên nước, không chọn hộ;
  //   • một currency nhưng không phải của Apple: chỉ có thể là sai. Chỉ xét
  //     nước KHÔNG lẫn — `m.currency` là currency gặp đầu tiên, chỉ có nghĩa
  //     khi cột có đúng một currency.
  // Prod không có nước nào như vậy ngày 2026-10-20 (V2 = 0 dòng).
  const currenciesOf = (code: string) => [
    ...new Set(
      matrix.tiers
        .map((t) => matrix.cells[`${t.tier_id}|${code}`]?.currency)
        .filter((c): c is string => c !== undefined),
    ),
  ];
  const appleSays = (code: string) => appleCurrencyFor(code) ?? "— not a territory Apple sells in";
  const mixed = markets.map((m) => ({ code: m.code, currencies: currenciesOf(m.code) })).filter((m) => m.currencies.length > 1);
  const mixedCodes = new Set(mixed.map((m) => m.code));
  const notApple = markets.filter((m) => !mixedCodes.has(m.code) && appleCurrencyFor(m.code) !== m.currency);
  if (mixed.length > 0 || notApple.length > 0) {
    const parts = [
      ...(mixed.length > 0
        ? [
            mixed.map((m) => `${m.code} (${m.currencies.join(", ")} — Apple bills ${appleSays(m.code)})`).join("; ") +
              " hold more than one currency in this template",
          ]
        : []),
      ...(notApple.length > 0
        ? [notApple.map((m) => `${m.code} (${m.currency}, Apple bills ${appleSays(m.code)})`).join("; ")]
        : []),
    ];
    await log(LOG_FEATURE, `edit export refused — currencies: ${parts.join(" | ")}`, "WARN");
    return NextResponse.json(
      {
        error:
          `Cannot export for editing: ${parts.join(". ")}. An editable file states ONE currency per territory, ` +
          "the one Apple bills — fix these territories in the template first (upload a corrected template in Settings).",
        mixedCurrencyTerritories: mixed.map((m) => m.code),
        notAppleCurrencyTerritories: notApple.map((m) => m.code),
      },
      { status: 409 },
    );
  }

  const app = scope === "per-app" ? await getAppIdentity(appId as string) : null;
  if (scope === "per-app" && !app) {
    return NextResponse.json({ error: "App not found." }, { status: 404 });
  }
  const info: EditExportInfo = {
    scope:
      scope === "per-app"
        ? { kind: "APP", appId: appId as string, bundleId: app!.bundle_id, appName: app!.name }
        : { kind: "ACCOUNT", accountId: creds.id, accountName: creds.name },
    exportedAt: new Date().toISOString(),
    exportedBy,
  };

  const workbook = buildTemplateMatrixWorkbook({
    matrix,
    visibleMarkets: markets,
    showDiff: false,
    scope,
    edit: info,
  });
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const filename = templateMatrixXlsxFilename({
    scope,
    bundleId: app?.bundle_id,
    forEditing: true,
  });
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Export-Tier-Count": String(matrix.tiers.length),
      "X-Export-Territory-Count": String(markets.length),
      "X-Export-Mode": "edit",
    },
  });
}
