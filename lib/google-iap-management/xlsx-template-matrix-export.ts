/**
 * Export .xlsx cho màn View matrix của Google Pricing Template (Default + Per-App).
 *
 * ─── NGUYÊN TẮC SẢN PHẨM: FILE LÀ ẢNH CHỤP CỦA MÀN ─────────────────────────
 *
 * Manager chốt: data import lên thế nào → hiển thị trên "View matrix" thế nào
 * → export ra ĐÚNG và ĐỦ như vậy. Không thêm, không xoá, không sửa. Ba hệ quả
 * cụ thể, và cả ba đều là chỗ file CSV cũ đã nói KHÁC màn:
 *
 *   F6  ô (tier, region) không có trong template → màn vẽ "·"
 *       (MatrixTable.tsx:104-113) ⇒ file GHI "·", ở CẢ HAI nửa Price và
 *       Currency. CSV cũ `continue` (csv-export.ts:69) và ô đó biến mất hẳn —
 *       82 ô trên template Per-App thật của Manager (Light and Night).
 *   F1  màn có công tắc "Highlight differences" (PerAppMatrixView.tsx:129-142)
 *       ⇒ file bám `showDiff`, KHÔNG bám `defaultTemplateExists`. CSV cũ bám
 *       cái sau (PerAppMatrixView.tsx:78): bỏ tick thì màn sạch mà file vẫn
 *       mang cột diff.
 *   F2  `isDiff` bật CẢ khi chỉ currency khác (template-matrix.ts:112), nên
 *       note phải ghi currency của CẢ HAI bên. CSV cũ chỉ có `default_price`
 *       nên ô khác-mỗi-currency in ra hai số y hệt nhau.
 *       ⚠ F2 được phủ bằng NOTE, không phải bằng "chưa xảy ra". Census đo hai
 *       lần độc lập (Q6c = PASS, Q6d = 0 dòng) rằng hôm nay chưa region nào
 *       mang 2 currency — nhưng đó là trạng thái dữ liệu, không phải bảo đảm.
 *
 * ─── NGUỒN DỮ LIỆU: `MatrixData`, KHÔNG CÓ ĐƯỜNG ĐỌC NÀO KHÁC ──────────────
 *
 * Module này THUẦN. Mọi thứ quyết định nội dung đã do `composeMatrix`
 * (queries/template-matrix.ts:79-152) quyết: tập + thứ tự tier
 * (`matrix.tiers`), tập + thứ tự nước (`matrix.markets`), tên header
 * (`market.name`), currency, giá trị ô, `isDiff`, giá trị Default.
 *
 * ⚠ KHÔNG SORT LẠI GÌ HẾT. Thứ tự nước đến từ thứ tự CỘT trong file .xlsx
 * Manager upload (Hotfix 24, template-matrix.ts:118-132) — `US VN SG MY ID PH
 * TH HK TW`, KHÔNG phải alphabet. Một `.sort()` thêm vào đây sẽ làm file khác
 * màn ở đúng thứ Manager dùng để đọc.
 *
 * ⚠ HẠN CHẾ ĐÃ BIẾT (G2-Q3, Manager đẩy sang arc G1). Thứ tự đó hiện dựa vào
 * thứ tự dòng Postgres trả về khi `fetchEntriesForTemplate` SELECT **không có
 * ORDER BY** (template-matrix.ts:161-164) — hành vi Postgres KHÔNG cam kết.
 * Một `VACUUM FULL` là đủ để đảo cột. Cách sửa đã chốt là thêm cột
 * `sort_order` vào `pricing_template_entries`, và nó cần migration nên thuộc
 * G1. Module này KHÔNG tự bù bằng cách sort — bù ở đây sẽ làm file khác màn.
 *
 * ⚠ TUYỆT ĐỐI KHÔNG dùng nguồn country/tên/mã của Apple
 * (`apple-territories.snapshot`, `TERRITORY_CATALOG`, `toCatalogCode`,
 * `territoryName`). Google Play dùng ISO 3166-1 **alpha-2**; Apple dùng
 * **alpha-3** — KB §4.20. `market.name` đã được `composeMatrix` phân giải sẵn
 * qua `regionNameFromCode` (region-name.ts, nguồn `i18n-iso-countries` +
 * 18 override khớp Google Play Console). Dùng thẳng, không tự viết phép chuyển.
 *
 * ─── VÌ SAO exceljs Ở ĐÂY, VÀ VÌ SAO PHẢI CHẠY SERVER-SIDE ─────────────────
 *
 * ⚠ WRITER LÀ `exceljs`, KHÔNG PHẢI `xlsx`. Đo thật (không đọc doc):
 * `xlsx@0.18.5` CE **vứt màu chữ lúc write** (`FFB45309` không có ở bất kỳ
 * đâu trong archive) và **không ghi nổi freeze panes** (thử 3 biến thể API:
 * `!freeze` chuỗi · `!freeze` object · `!views` — `sheet1.xml` không có
 * `<pane>` ở cả ba). Ma trận 94 hàng cần cả hai.
 *
 * `excel-library-split.structural.test.ts` là hàng rào; file này nằm trong
 * allow-list của nó kèm lý do — và lý do KHÔNG phải câu hàng rào hỏi mặc định
 * ("tại sao ghi workbook Apple từ ngoài writer Apple"): đây KHÔNG PHẢI workbook
 * Apple. Xem comment tại chỗ trong file test.
 *
 * ⚠ exceljs là dependency SERVER-ONLY (KB §4.17). Đo thật: import nó vào màn
 * client làm route `/settings/pricing-templates/default` phình từ 169 kB lên
 * 424 kB First Load JS (+255 kB, gấp 2,5 lần). Vì thế writer chạy qua route
 * server (C4b), không chạy trong browser như `csv-export.ts` cũ.
 */
import ExcelJS from "exceljs";

import { getCurrencyDecimals } from "./google/currency-precision";
import { formatPrice } from "./matrix-price-format";
import type {
  MatrixCell,
  MatrixData,
  MatrixMarket,
} from "./queries/template-matrix";

export type TemplateMatrixScope = "default" | "per-app";

/**
 * numFmt của ô giá — theo currency, có ĐUÔI TUỲ CHỌN.
 *
 *   0 chữ số (VND · IDR · TWD · JPY · KRW · HUF …) → "0"
 *   2 chữ số (USD · SGD · MYR · THB · HKD · PHP …) → "0.00####"
 *   3 chữ số (BHD · KWD · OMR …)                   → "0.000###"
 *
 * ⚠ ĐI NGƯỢC KB §21.4 CÓ CHỦ Ý — xem KB §22. Tóm tắt: bài học "đừng ghi numFmt"
 * đúng cho Apple vì `customer_price` là NUMERIC(18,4) có số chữ số thập phân
 * THAY ĐỔI theo từng ô và một cột chứa nhiều currency, nên mọi format cố định
 * đều sai ở đâu đó và `General` là đáp án duy nhất. Google KHÁC: số chữ số là
 * HẰNG theo currency, và mỗi CỘT có đúng MỘT currency (census Q6b: 11/11
 * region đúng 1 currency). Đo bằng `XLSX.SSF` trên 16 giá trị lấy từ dữ liệu
 * thật: `General` khớp màn 8/16, `0.00` cố định 9/16, công thức này **16/16**.
 * Không có nó, 376/846 ô của file Default hiện `9.9` trong khi màn vẽ `9.90`.
 *
 * ⚠ ĐUÔI `#` LÀ THỨ NGĂN LÀM TRÒN, KHÔNG PHẢI TRANG TRÍ. `micros` mang tối đa
 * 6 chữ số thập phân nên `"#".repeat(6 - d)` luôn đủ chỗ cho mọi phần dư:
 * `0.00####` vẽ `4.901234` nguyên vẹn, còn `0.00` cố định vẽ `4.90` — làm
 * tròn, vi phạm chỉ thị "không round/truncate". Đổi công thức này thành format
 * cố định là mutation bắt buộc phải làm test ĐỎ.
 *
 * ⚠ KHÔNG dính bẫy dấu chấm trơ của `0.####` (KB §21.4): hai chữ `0` là BẮT
 * BUỘC nên dấu `.` không bao giờ đứng một mình. Đo: `0.####` vẽ `35.` ✗ ·
 * `0.00####` vẽ `35.00` ✓.
 */
export function priceNumFmt(currency: string): string {
  const d = getCurrencyDecimals(currency);
  return d === 0 ? "0" : "0." + "0".repeat(d) + "#".repeat(6 - d);
}

/**
 * Ô "(tier, region) này không có trong template".
 *
 * ⚠ U+00B7 MIDDLE DOT — ĐÚNG KÝ TỰ MÀN ĐANG VẼ (MatrixTable.tsx:111), không
 * phải dấu chấm thường, không phải "-", không phải để trống. Chú thích dưới
 * bảng nói nó nghĩa là gì: "empty cell (·) = no override for that tier-market
 * pair (Google auto-equalisation fills)" (DefaultMatrixView.tsx:126-129).
 */
export const EMPTY_CELL = "·";

/**
 * Màu chữ của ô khác Default — amber-700, đúng màu `text-amber-700` màn đang
 * dùng (MatrixTable.tsx:39).
 *
 * ⚠ CÙNG GIÁ TRỊ với `DIFF_FONT_COLOR` của writer matrix Apple
 * (lib/iap-management/xlsx-template-matrix-export.ts:94) — và đó là ĐÚNG, chứ
 * không phải trùng lặp cần gỡ: cùng một dấu hiệu cho cùng một nghĩa ("ô này
 * khác Default"), ở hai module. Bẫy KB §9 là *cùng dấu hiệu, KHÁC nghĩa*.
 *
 * ⚠ CHỮ MÀU, KHÔNG PHẢI NỀN VÀNG. `FFFFF2CC` đã có nghĩa cố định ở file export
 * item list của Apple ("giá này do Apple tự cân bằng",
 * lib/iap-management/xlsx-export.ts:728) — đó mới là màu tuyệt đối không được
 * xuất hiện trong file này.
 *
 * ⚠ KHÔNG có ★ trong ô. Màn có ★ vì ô màn là HTML; ô Excel phải giữ kiểu SỐ
 * để sort/filter/SUM được, mà thêm ký tự vào là biến nó thành chuỗi.
 */
export const DIFF_FONT_COLOR = "FFB45309";

/** Nền hai hàng header — `bg-slate-50` (#F8FAFC) của màn, MatrixTable.tsx:71,80. */
const HEADER_FILL_COLOR = "FFF8FAFC";
/** Màn vẽ ô "·" bằng `text-slate-300` (#CBD5E1), MatrixTable.tsx:109. */
const EMPTY_FONT_COLOR = "FFCBD5E1";
/** Màn dùng `font-mono` cho cột tier và ô giá (MatrixTable.tsx:98,118). */
const DATA_FONT_NAME = "Menlo";
const FONT_SIZE = 10;

const TIER_COLUMN_WIDTH = 20;
const PRICE_COLUMN_WIDTH = 12;
const CURRENCY_COLUMN_WIDTH = 9;

/** Cột cố định bên trái: chỉ có "Tier". Freeze suy ra từ hằng này chứ không
 *  hardcode. */
export const FIXED_COLUMN_COUNT = 1;
/** Hàng 0 = tên nước (merge 2 cột), hàng 1 = Price/Currency. */
export const HEADER_ROW_COUNT = 2;

const SUBHEADERS = ["Price", "Currency"] as const;

const SHEET_NAME: Record<TemplateMatrixScope, string> = {
  default: "Default Template",
  "per-app": "Per-App Template",
};

export interface TemplateMatrixExportInput {
  matrix: MatrixData;
  /**
   * ⚠ BỘ LỌC, KHÔNG BAO GIỜ LÀ THỨ TỰ.
   *
   * Thứ tự cột luôn là thứ tự của `matrix.markets`. Nhận vào mảng MÃ (chứ
   * không phải mảng market đã lọc sẵn) là có chủ ý: nó làm cho việc "client
   * gửi lên thứ tự khác" trở nên BẤT KHẢ THI về mặt cấu trúc, thay vì chỉ là
   * một quy ước ai đó phải nhớ. Hai lần xáo trộn cùng một lựa chọn phải cho
   * ra file byte-identical, nếu không thì hai lần export cùng dữ liệu không so
   * được với nhau.
   */
  regionCodes: ReadonlyArray<string>;
  /** F1 — công tắc "Highlight differences" trên màn. Per-App mới có. */
  showDiff: boolean;
  scope: TemplateMatrixScope;
}

/** Một ô mà glyph màn (và do đó cả file) hiện ít chữ số hơn `price_micros`
 *  đang giữ. Chỉ xảy ra với currency 0 chữ số thập phân. */
export interface TruncatedCell {
  tier: string;
  regionCode: string;
  currency: string;
  priceMicros: string;
}

export interface TemplateMatrixExportResult {
  buffer: Buffer;
  /**
   * ⚠ VAI TRÒ: CƠ CHẾ CÔNG BỐ, KHÔNG PHẢI CƠ CHẾ ĐÚNG-SAI.
   *
   * Nghĩa đúng: "N ô đang hiện ít chữ số hơn DB đang giữ". Dưới thiết kế đã
   * chốt (V4 phương án (a) — ô mang đúng giá trị MÀN vẽ) **không có ô nào
   * hiện SAI**; file khớp màn 7/7 trên mọi ca đã đo. Con số này tồn tại để
   * việc mất chữ số không diễn ra im lặng, chứ không phải để chặn lỗi.
   *
   * ⚠ Đừng "sửa" bằng cách cho writer ghi giá trị đầy đủ. V4 đo: ô mang
   * `25000.5` + numFmt `0` cho ra `25001` — file vừa khác màn vừa làm tròn
   * LÊN, và hỏng KHÔNG ĐỀU (IDR 16000.4 pass do làm tròn xuống, VND 25000.5
   * fail). Xem backlog [GOOGLE-micros-truncation].
   */
  truncatedCells: number;
  truncated: TruncatedCell[];
  /** Số cột NƯỚC thực sự ghi ra. Route dùng làm COUNT assert (§4.20) đối
   *  chiếu với `regionCodes.length`. */
  columnCount: number;
}

// ── Spec trung gian, toạ độ 0-INDEXED ────────────────────────────────────────
// Mọi thứ ở trên dựng dữ liệu thuần bằng toạ độ 0-index, và đúng MỘT hàm ở
// dưới đổi sang API 1-index của exceljs. Chuyển đổi ở một chỗ thì off-by-one
// chỉ có một chỗ để nấp — và toàn bộ test F1/F2/F6 chạy được trên spec mà
// không cần dựng workbook.

interface CellRef {
  r: number;
  c: number;
}

interface MergeRange {
  s: CellRef;
  e: CellRef;
}

/** Ô giá có numFmt. `·` và ô Currency KHÔNG nằm trong danh sách này — đó là
 *  cách bảo đảm numFmt gán THEO Ô chứ không theo CỘT. */
interface PriceCellStyle extends CellRef {
  numFmt: string;
}

/** Ô khác Default: chữ amber (+ note khi đủ dữ kiện). */
interface DiffCellStyle extends CellRef {
  note?: string;
}

export interface TemplateMatrixSheetSpec {
  sheetName: string;
  aoa: Array<Array<string | number | null>>;
  merges: MergeRange[];
  widths: number[];
  freeze: { cols: number; rows: number };
  priceCells: PriceCellStyle[];
  diffCells: DiffCellStyle[];
  emptyCells: CellRef[];
  truncated: TruncatedCell[];
  columnCount: number;
}

/** Cột 0-index của ô Price cho nước thứ `g`. Currency là cột kế bên. */
export function priceColumn(g: number): number {
  return FIXED_COLUMN_COUNT + g * 2;
}

/**
 * Note trên ô khác Default — bản sao của `title` tooltip màn đang có
 * (MatrixTable.tsx:40-44).
 *
 * ⚠ MỘT DÒNG, dấu " → " ở giữa. Màn viết đúng như thế; Apple viết hai dòng vì
 * tooltip của Apple hai dòng. Không đổi cho "đẹp hơn" — nguyên tắc là ảnh chụp.
 *
 * ⚠ GHI CURRENCY CỦA CẢ HAI BÊN (F2). `isDiff` bật cả khi CHỈ currency khác mà
 * giá bằng nhau; một note chỉ ghi hai con số sẽ hiện ra hai số giống hệt nhau
 * và người đọc kết luận ngược lại điều màn đang nói.
 *
 * Trả `undefined` khi không đủ dữ kiện, đúng nhánh guard của màn
 * (MatrixTable.tsx:33-36) — màn vẫn tô màu theo `isDiff` nhưng bỏ tooltip khi
 * thiếu giá trị Default.
 */
export function diffNote(cell: MatrixCell): string | undefined {
  if (!cell.defaultPriceMicros || !cell.defaultCurrency) return undefined;
  const def = formatPrice(cell.defaultPriceMicros, cell.defaultCurrency);
  const cur = formatPrice(cell.priceMicros, cell.currency);
  return `Default: ${def} ${cell.defaultCurrency} → Per-App: ${cur} ${cell.currency}`;
}

/**
 * Giá trị ghi vào ô Price.
 *
 * ⚠ TRẢ VỀ SỐ khi glyph là số. Ô phải giữ kiểu số Excel để sort/filter/SUM
 * được. `Number()` trên glyph an toàn: glyph đã ở ĐƠN VỊ TIỀN (không phải
 * micros), và giá lớn nhất trong dữ liệu thật là 24 999 000 VND —
 * `Number.MAX_SAFE_INTEGER` còn dư 360 lần.
 *
 * ⚠ TRẢ VỀ CHUỖI khi glyph không phải số. Đó là nhánh `catch` của màn: một
 * `price_micros` hỏng làm màn vẽ chuỗi thô, nên file cũng phải mang chuỗi thô
 * — ghi `NaN` vào ô sẽ là file bịa ra một giá trị không ai nhìn thấy.
 */
export function priceCellValue(glyph: string): number | string {
  if (!/^\d+(\.\d+)?$/.test(glyph)) return glyph;
  const n = Number(glyph);
  return Number.isFinite(n) ? n : glyph;
}

/**
 * Ô này có bị mất chữ số khi hiển thị không?
 *
 * Chỉ currency 0 chữ số mới bị: `microsToDecimal(m, 0)` rẽ vào
 * `return whole.toString()` (price-conversion.ts:122-124) và bỏ phần dư.
 * Currency ≥ 1 chữ số đi nhánh `fracRest` nên KHÔNG mất gì.
 */
export function isTruncatedCell(priceMicros: string, currency: string): boolean {
  if (getCurrencyDecimals(currency) !== 0) return false;
  if (!/^\d+$/.test(priceMicros)) return false;
  try {
    return BigInt(priceMicros) % BigInt(1_000_000) !== BigInt(0);
  } catch {
    return false;
  }
}

/**
 * Dựng spec thuần từ `MatrixData`. Không đụng exceljs, không I/O.
 *
 * ⚠ Đây là chỗ DUY NHẤT quyết định nội dung file, và nó không có một dòng
 * logic dữ liệu nào của riêng mình — tập/thứ tự tier, tập/thứ tự nước, tên
 * header, currency, giá trị ô, `isDiff` đều đọc thẳng khỏi `matrix`.
 */
export function buildTemplateMatrixSpec(
  input: TemplateMatrixExportInput,
): TemplateMatrixSheetSpec {
  const { matrix, regionCodes, showDiff, scope } = input;

  if (regionCodes.length === 0) {
    // Backstop cho MỌI caller. Route trả 400 bằng kiểm tra riêng trước khi
    // gọi tới đây (C4b); throw này là để không đường nào — kể cả đường sau
    // này ai đó thêm — sinh ra được một file 1 cột vô nghĩa trong im lặng.
    throw new RangeError(
      "regionCodes rỗng: không có nước nào để export. Đây là lỗi của caller, " +
        "không phải 'export tất cả'.",
    );
  }

  // ⚠ LỌC, KHÔNG SẮP. `matrix.markets` giữ nguyên thứ tự; `filter` bảo toàn
  // thứ tự của mảng nguồn, nên thứ tự cột KHÔNG phụ thuộc thứ tự `regionCodes`.
  const wanted = new Set(regionCodes);
  const markets: MatrixMarket[] = matrix.markets.filter((m) => wanted.has(m.code));

  // ── Hai hàng header ───────────────────────────────────────────────────────
  const headerRow1: Array<string | null> = ["Tier"];
  const headerRow2: Array<string | null> = [null];
  for (const market of markets) {
    // ⚠ `market.name` NGUYÊN BẢN. `composeMatrix` đã gọi `regionNameFromCode`
    // (nguồn Google, alpha-2); khi mã không tra được nó rơi về chính mã in hoa
    // và màn đang hiện đúng chuỗi đó. Sửa ở đây là sửa sai chỗ.
    headerRow1.push(market.name, null);
    headerRow2.push(...SUBHEADERS);
  }

  const priceCells: PriceCellStyle[] = [];
  const diffCells: DiffCellStyle[] = [];
  const emptyCells: CellRef[] = [];
  const truncated: TruncatedCell[] = [];

  // ── Dữ liệu: một hàng mỗi tier, theo ĐÚNG thứ tự composer đã sắp ──────────
  const dataRows: Array<Array<string | number | null>> = matrix.tiers.map(
    (tier, ti) => {
      const r = HEADER_ROW_COUNT + ti;
      const row: Array<string | number | null> = [tier];
      markets.forEach((market, gi) => {
        const c = priceColumn(gi);
        const cell: MatrixCell | undefined =
          matrix.cells[`${tier}|${market.code}`];

        if (!cell) {
          // ⚠ F6 — CẢ HAI NỬA CỦA CẶP. Một ô "·" cạnh một ô Currency trống sẽ
          // làm ô Currency nói một chuyện khác với ô Price ngay bên cạnh nó,
          // trong khi cả hai đang trả lời cùng một câu hỏi.
          row.push(EMPTY_CELL, EMPTY_CELL);
          emptyCells.push({ r, c }, { r, c: c + 1 });
          return;
        }

        const glyph = formatPrice(cell.priceMicros, cell.currency);
        row.push(priceCellValue(glyph), cell.currency);

        // ⚠ numFmt gán THEO Ô, chỉ cho ô Price CÓ GIÁ. Gán theo CỘT sẽ vẽ lại
        // cả ô "·" của cùng cột đó.
        priceCells.push({ r, c, numFmt: priceNumFmt(cell.currency) });

        if (isTruncatedCell(cell.priceMicros, cell.currency)) {
          truncated.push({
            tier,
            regionCode: market.code,
            currency: cell.currency,
            priceMicros: cell.priceMicros,
          });
        }

        // ⚠ F1 — biểu thức NGUYÊN VĂN của màn (MatrixTable.tsx:32).
        if (showDiff && cell.isDiff === true) {
          diffCells.push({ r, c, note: diffNote(cell) });
        }
      });
      return row;
    },
  );

  const merges: MergeRange[] = [
    // Cột "Tier" trải DỌC hết khối header (A1:A2). Không có nó, ô A2 là một
    // ô trống nằm ngay dưới chữ "Tier" và ngay trên hàng dữ liệu đầu tiên —
    // đọc như một ô dữ liệu rỗng chứ không như phần của header. Mọi cột khác
    // đều trải hết khối header (nước merge NGANG 2 cột); cột này trải DỌC.
    { s: { r: 0, c: 0 }, e: { r: HEADER_ROW_COUNT - 1, c: 0 } },
    ...markets.map((_, gi) => ({
      s: { r: 0, c: priceColumn(gi) },
      e: { r: 0, c: priceColumn(gi) + 1 },
    })),
  ];

  const widths = [
    TIER_COLUMN_WIDTH,
    ...markets.flatMap(() => [PRICE_COLUMN_WIDTH, CURRENCY_COLUMN_WIDTH]),
  ];

  return {
    sheetName: SHEET_NAME[scope],
    aoa: [headerRow1, headerRow2, ...dataRows],
    merges,
    widths,
    freeze: { cols: FIXED_COLUMN_COUNT, rows: HEADER_ROW_COUNT },
    priceCells,
    diffCells,
    emptyCells,
    truncated,
    columnCount: markets.length,
  };
}

/**
 * Đổ spec vào exceljs và trả buffer. ĐÂY LÀ HÀM DUY NHẤT đổi 0-index → 1-index.
 */
export async function writeTemplateMatrixXlsx(
  input: TemplateMatrixExportInput,
): Promise<TemplateMatrixExportResult> {
  const spec = buildTemplateMatrixSpec(input);

  const wb = new ExcelJS.Workbook();

  /**
   * ⚠ GHIM DẤU THỜI GIAN — ĐỂ "HAI LẦN EXPORT CÙNG DỮ LIỆU CHO RA FILE
   * GIỐNG HỆT" LÀ ĐÚNG THEO NGHĨA ĐEN.
   *
   * Mặc định exceljs đóng `dcterms:created`/`dcterms:modified` bằng giờ hiện
   * tại vào `docProps/core.xml`. Đo được: hai lần ghi CÙNG input, cách nhau
   * hơn một giây, cho ra hai file khác bytes — và `docProps/core.xml` là part
   * DUY NHẤT khác (mọi part nội dung: sheet1.xml, styles.xml,
   * sharedStrings.xml đều giống hệt).
   *
   * Điều đó biến tính chất thiết kế thành ra "gần đúng": Manager tải hai lần
   * rồi so file sẽ thấy khác nhau mà không có gì trong DỮ LIỆU khác cả, và
   * test byte-identical thì flaky theo đồng hồ (bắt được ở C4b, 1/3 lần chạy).
   *
   * Ghim về epoch — một giá trị hiển nhiên KHÔNG phải ngày thật, nên không ai
   * đọc nó như thông tin. Dấu thời gian thật của bản export nằm ở TÊN FILE
   * (`…-20260831-1035.xlsx`), nên không mất mát gì.
   *
   * ⚠ GIỚI HẠN, ĐÃ ĐO — ĐỪNG HỨA QUÁ. Ghim này làm MỌI PART trong archive
   * giống hệt nhau giữa hai lần ghi (đo: cùng kích thước 6780 B, không part
   * nào khác nội dung). Nhưng buffer THÔ vẫn khác, vì tầng zip của exceljs
   * đóng mtime hiện tại vào từng entry của vỏ ZIP và không phơi ra API nào
   * để chỉnh. ⇒ Tính chất ĐÚNG và kiểm được là "mọi part byte-identical",
   * KHÔNG phải "buffer byte-identical". Test canh đúng câu đó.
   */
  const DETERMINISTIC_STAMP = new Date(0);
  wb.created = DETERMINISTIC_STAMP;
  wb.modified = DETERMINISTIC_STAMP;

  const ws = wb.addWorksheet(spec.sheetName);

  for (const row of spec.aoa) ws.addRow(row);

  for (const m of spec.merges) {
    ws.mergeCells(m.s.r + 1, m.s.c + 1, m.e.r + 1, m.e.c + 1);
  }

  spec.widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  for (let r = 1; r <= HEADER_ROW_COUNT; r += 1) {
    ws.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true, size: FONT_SIZE };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: HEADER_FILL_COLOR },
      };
    });
  }

  // Cột tier + ô giá dùng font mono, theo `font-mono` của màn.
  for (let ri = HEADER_ROW_COUNT; ri < spec.aoa.length; ri += 1) {
    ws.getCell(ri + 1, 1).font = { name: DATA_FONT_NAME, size: FONT_SIZE };
  }

  for (const p of spec.priceCells) {
    const cell = ws.getCell(p.r + 1, p.c + 1);
    cell.numFmt = p.numFmt;
    cell.font = { name: DATA_FONT_NAME, size: FONT_SIZE };
  }

  for (const e of spec.emptyCells) {
    ws.getCell(e.r + 1, e.c + 1).font = {
      name: DATA_FONT_NAME,
      size: FONT_SIZE,
      color: { argb: EMPTY_FONT_COLOR },
    };
  }

  // ⚠ Đặt SAU priceCells: ô diff phải đè font mặc định của ô giá.
  for (const d of spec.diffCells) {
    const cell = ws.getCell(d.r + 1, d.c + 1);
    cell.font = {
      name: DATA_FONT_NAME,
      size: FONT_SIZE,
      bold: true,
      color: { argb: DIFF_FONT_COLOR },
    };
    if (d.note) cell.note = d.note;
  }

  ws.views = [
    {
      state: "frozen",
      xSplit: spec.freeze.cols,
      ySplit: spec.freeze.rows,
    },
  ];

  const raw = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(raw as ArrayBuffer),
    truncatedCells: spec.truncated.length,
    truncated: spec.truncated,
    columnCount: spec.columnCount,
  };
}

/**
 * Tên file .xlsx. Hàm THUẦN, tách khỏi route để test được ở hai tầng —
 * tầng này (chuỗi ra sao) và tầng route (header `Content-Disposition` có bị
 * tách đôi được không).
 *
 * ⚠ ĐÂY LÀ BẢN THAY THẾ TẦNG 1 cho test bảo mật của `csvFilename`
 * ("sanitises unsafe filename characters in the package slug") sắp bị xoá ở
 * C5. Tầng 2 nằm ở `matrix-export/route.test.ts`. Xoá `csv-export.ts` mà
 * không có cả hai là bỏ rơi một test đang canh thật.
 *
 * ⚠ SANITISE LÀ BẮT BUỘC, KHÔNG PHẢI CHO ĐẸP. `package_name` đi vào header
 * HTTP; một giá trị chứa `\r\n` hoặc `"` sẽ tách `Content-Disposition` làm
 * đôi. Whitelist `[a-z0-9._-]` (giống `csvFilename` cũ) loại sạch cả hai.
 *
 * ⚠ Có tiền tố `google-`, khác `csvFilename` cũ (`pricing-template-…csv`).
 * Manager đang phải TỰ ĐỔI TÊN file sau khi tải để phân biệt với file Apple
 * cùng tên — hai file CSV gửi kèm census đều mang tiền tố `google-` do thêm
 * tay. Đặt sẵn ở đây thì thao tác đó biến mất.
 */
export function templateMatrixXlsxFilename(args: {
  scope: TemplateMatrixScope;
  packageName?: string;
  now?: Date;
}): string {
  const d = args.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  if (args.scope === "per-app") {
    const slug = (args.packageName ?? "app").replace(/[^a-z0-9._-]+/gi, "_");
    return `google-pricing-template-per-app-${slug}-${stamp}.xlsx`;
  }
  return `google-pricing-template-default-${stamp}.xlsx`;
}
