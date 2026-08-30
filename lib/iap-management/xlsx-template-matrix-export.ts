/**
 * Export .xlsx cho màn View matrix của Pricing Template (Default + Per-App).
 *
 * ─── NGUYÊN TẮC SẢN PHẨM: FILE LÀ ẢNH CHỤP CỦA MÀN ─────────────────────────
 *
 * Manager chốt: data import lên thế nào → hiển thị trên "View matrix" thế nào
 * → export ra ĐÚNG và ĐỦ như vậy. Không thêm, không xoá, không sửa. Hệ quả
 * cụ thể, và cả ba đều là chỗ file CSV cũ đã nói khác màn:
 *
 *   F6  ô (tier, territory) không có trong template → màn vẽ "·"
 *       (MatrixTable.tsx:111-119) ⇒ file GHI "·". CSV cũ `continue` và ô đó
 *       biến mất hẳn khỏi file — 5 576 ô trên template Per-App thật.
 *   F1  màn có công tắc "Highlight differences" ⇒ file bám `showDiff`, KHÔNG
 *       bám `defaultTemplateExists`. CSV cũ bám cái sau: tắt công tắc thì màn
 *       sạch mà file vẫn có cột diff.
 *   F2  `isDiff` bắt CẢ currency (template-matrix.ts:138-139), nên note phải
 *       ghi currency của cả hai bên. CSV cũ chỉ có `default_customer_price`
 *       nên ô khác-mỗi-currency in ra y hệt nhau: file nói "không khác", màn
 *       nói "khác".
 *
 * ─── NGUỒN DỮ LIỆU: `MatrixData`, KHÔNG CÓ ĐƯỜNG ĐỌC NÀO KHÁC ──────────────
 *
 * Module này THUẦN. Mọi thứ quyết định nội dung đã do `composeMatrix` quyết:
 * tập + thứ tự tier (`matrix.tiers`), tập + thứ tự nước (`matrix.markets`),
 * tên header (`market.name`), currency, giá trị ô, `isDiff`, giá trị Default.
 *
 * ⚠ KHÔNG SORT LẠI GÌ HẾT. Thứ tự nước đến từ thứ tự CỘT trong file .xlsx
 * Manager upload (Hotfix 24, template-matrix.ts:145-161) — VN trước, rồi SEA,
 * rồi thị trường lớn. Nó KHÔNG phải alphabet. Một `.sort()` thêm vào đây sẽ
 * làm file khác màn ở đúng thứ Manager dùng để đọc.
 *
 * ⚠ KHÔNG gọi `columnHeaderLabel` / `columnDisplayName` của export item list.
 * KB §4.20: template nói ALPHA-3 (`USA`, `XKS` — parser đọc từ header
 * "United States (USA_USD)", parsers/price-tiers.ts:37), còn export item list
 * nói alpha-2 vì data của nó đến từ Apple API. Hai hàm kia gọi `toAppleCode`
 * với giả định input là alpha-2. `market.name` đã được `composeMatrix` phân
 * giải sẵn — dùng thẳng, và không tự viết phép chuyển nào.
 *
 * ─── VÌ SAO exceljs Ở ĐÂY ──────────────────────────────────────────────────
 *
 * ⚠ WRITER LÀ `exceljs`, KHÔNG PHẢI `xlsx` (KB §4.17). File này cần font màu,
 * freeze panes và note — `xlsx@0.18.5` CE nhận style rồi ném đi lúc write.
 * `excel-library-split.structural.test.ts` là hàng rào; file này nằm trong
 * allow-list của nó kèm lý do.
 */
import ExcelJS from "exceljs";

import { formatPrice } from "./matrix-price-format";
import type {
  MatrixCell,
  MatrixData,
  MatrixMarket,
} from "./queries/template-matrix";

export type TemplateMatrixScope = "default" | "per-app";

export interface TemplateMatrixExportInput {
  matrix: MatrixData;
  /** Tập nước SAU khi lọc trên màn. Dùng làm bộ LỌC — thứ tự cột vẫn là thứ
   *  tự của chính mảng này, mà màn dựng bằng `matrix.markets.filter(...)`
   *  (DefaultMatrixView.tsx:40-54) nên nó đã giữ nguyên thứ tự gốc. */
  visibleMarkets: ReadonlyArray<MatrixMarket>;
  /** F1 — công tắc "Highlight differences" trên màn. Per-App mới có. */
  showDiff: boolean;
  scope: TemplateMatrixScope;
}

/**
 * Ô "(tier, territory) này không có trong template".
 *
 * ⚠ U+00B7 MIDDLE DOT — ĐÚNG KÝ TỰ MÀN ĐANG VẼ (MatrixTable.tsx:117), không
 * phải dấu chấm thường, không phải "-", không phải để trống. Chú thích dưới
 * bảng nói nó nghĩa là gì: "no override for that tier-territory pair (Apple
 * auto-equalisation fills)". Để trống sẽ làm ô này lẫn với một ô mà file
 * không ghi được vì lý do khác — đúng lớp lỗi "một giá trị hai nghĩa" mà
 * export item list đã phải gỡ bằng `—` (xlsx-export.ts:57-70).
 */
const EMPTY_CELL = "·";

/**
 * Màu chữ của ô khác Default — amber-700, đúng màu `text-amber-700` màn đang
 * dùng (MatrixTable.tsx:38).
 *
 * ⚠ CHỮ MÀU, KHÔNG PHẢI NỀN VÀNG. `FFFFF2CC` đã có nghĩa cố định trong file
 * export item list: "giá này do Apple tự cân bằng" (xlsx-export.ts:673-681).
 * Hai file .xlsx của cùng module Apple mà dùng chung một màu nền cho hai
 * nghĩa khác nhau là đúng cái bẫy KB §9 nói tới — một dấu hiệu cùng hình
 * dạng mang nghĩa khác ở surface khác. Màu chữ vs màu nền giữ hai file phân
 * biệt được ngay từ cái liếc đầu tiên.
 *
 * ⚠ KHÔNG có ★ trong ô. Màn có ★ vì ô màn là HTML; ô Excel phải giữ kiểu SỐ
 * để sort/filter/tính được, mà thêm ký tự vào là biến nó thành chuỗi.
 */
const DIFF_FONT_COLOR = "FFB45309";

const HEADER_FILL_COLOR = "FFF8FAFC";
const EMPTY_FONT_COLOR = "FFCBD5E1";
const DATA_FONT_NAME = "Menlo";
const FONT_SIZE = 10;

const TIER_COLUMN_WIDTH = 20;
const PRICE_COLUMN_WIDTH = 12;
const CURRENCY_COLUMN_WIDTH = 9;

/** Cột cố định bên trái: chỉ có "Tier". Freeze suy ra từ hằng này chứ không
 *  hardcode, y như export item list làm với 4 cột của nó. */
const FIXED_COLUMN_COUNT = 1;
/** Hàng 0 = tên nước (merge 2 cột), hàng 1 = Price/Currency. */
const HEADER_ROW_COUNT = 2;

const SUBHEADERS = ["Price", "Currency"] as const;

const SHEET_NAME: Record<TemplateMatrixScope, string> = {
  default: "Default Template",
  "per-app": "Per-App Template",
};

// ── Spec trung gian, toạ độ 0-INDEXED ────────────────────────────────────────
// Cùng cách làm với xlsx-export.ts: mọi thứ ở trên dựng dữ liệu thuần bằng
// toạ độ 0-index, và đúng MỘT hàm ở dưới đổi sang API 1-index của exceljs.
// Chuyển đổi ở một chỗ thì off-by-one chỉ có một chỗ để nấp.

interface CellRef {
  r: number;
  c: number;
}

interface MergeRange {
  s: CellRef;
  e: CellRef;
}

interface StyledCell extends CellRef {
  font?: Partial<ExcelJS.Font>;
  fill?: ExcelJS.FillPattern;
  alignment?: Partial<ExcelJS.Alignment>;
  /** Bản sao của tooltip trên màn. Chỉ có trên ô Price của cặp diff. */
  note?: string;
}

interface SheetSpec {
  aoa: Array<Array<string | number | null>>;
  widths: number[];
  merges: MergeRange[];
  styles: StyledCell[];
  freeze: { cols: number; rows: number };
}

/**
 * Giá trị ghi vào ô Price.
 *
 * ⚠ TRẢ VỀ SỐ, KHÔNG PHẢI CHUỖI. Ô phải giữ kiểu số Excel để sort / filter /
 * tính được, và để giá trị trong file là giá trị NGUYÊN BẢN của DB chứ không
 * phải một bản đã được vẽ thành chữ.
 *
 * ⚠ `MatrixCell.customerPrice` khai kiểu `number`, nhưng PostgREST trả
 * `NUMERIC` qua JSON và Supabase có thể đưa về chuỗi — `formatPriceForCsv` cũ
 * đã phải phòng đúng ca này và có test riêng cho nó. Ép về số ở đây; thứ
 * không ép được thì giữ nguyên chuỗi thay vì ghi `NaN` vào file.
 */
function priceCellValue(value: number | string): number | string {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : String(value);
}

/**
 * Note trên ô khác Default — bản sao của `title` tooltip màn đang có
 * (MatrixTable.tsx:39-43).
 *
 * ⚠ GHI CURRENCY CỦA CẢ HAI BÊN (F2). `isDiff` bật cả khi CHỈ currency khác
 * mà giá bằng nhau; một note chỉ ghi hai con số sẽ hiện ra hai số giống hệt
 * nhau và người đọc kết luận ngược lại điều màn đang nói.
 *
 * Trả `undefined` khi không đủ dữ kiện, đúng nhánh guard của màn — màn vẫn tô
 * màu theo `isDiff` nhưng bỏ tooltip khi thiếu giá trị Default.
 */
function diffNote(cell: MatrixCell): string | undefined {
  if (cell.defaultCustomerPrice === undefined || !cell.defaultCurrency) {
    return undefined;
  }
  return (
    `Default: ${formatPrice(cell.defaultCustomerPrice)} ${cell.defaultCurrency}\n` +
    `Per-App: ${formatPrice(cell.customerPrice)} ${cell.currency}`
  );
}

/** Cột 0-index của ô Price cho nước thứ `g`. Currency là cột kế bên. */
function priceColumn(g: number): number {
  return FIXED_COLUMN_COUNT + g * 2;
}

export function buildTemplateMatrixSheetSpec(
  input: TemplateMatrixExportInput,
): SheetSpec {
  const { matrix, visibleMarkets, showDiff } = input;

  // ── Hai hàng header ───────────────────────────────────────────────────────
  const headerRow1: Array<string | null> = ["Tier"];
  const headerRow2: Array<string | null> = [null];
  for (const market of visibleMarkets) {
    // ⚠ `market.name` NGUYÊN BẢN. `composeMatrix` đã gọi `territoryName` với
    // mã alpha-3; khi ISO không biết mã đó (Kosovo `XKS`) nó rơi về chính mã,
    // và màn đang hiện đúng chuỗi đó. Sửa chỗ này là sửa `territoryName`, mà
    // hàm đó dùng chung với View Detail + export item list ⇒ arc riêng.
    headerRow1.push(market.name, null);
    headerRow2.push(...SUBHEADERS);
  }

  // ── Dữ liệu: một hàng mỗi tier, theo ĐÚNG thứ tự composer đã sắp ──────────
  const dataRows: Array<Array<string | number | null>> = matrix.tiers.map(
    (tier) => {
      const row: Array<string | number | null> = [tier.tier_name];
      for (const market of visibleMarkets) {
        const cell: MatrixCell | undefined =
          matrix.cells[`${tier.tier_id}|${market.code}`];
        if (!cell) {
          // ⚠ F6 — CẢ HAI NỬA CỦA CẶP. Một ô "·" cạnh một ô Currency trống sẽ
          // làm ô Currency nói một chuyện khác với ô Price ngay bên cạnh nó,
          // trong khi cả hai đang trả lời cùng một câu hỏi.
          row.push(EMPTY_CELL, EMPTY_CELL);
          continue;
        }
        row.push(priceCellValue(cell.customerPrice), cell.currency);
      }
      return row;
    },
  );

  const aoa = [headerRow1, headerRow2, ...dataRows];

  // ── Merge: "Tier" phủ dọc 2 hàng header, mỗi nước phủ ngang 2 cột ─────────
  const merges: MergeRange[] = [
    { s: { r: 0, c: 0 }, e: { r: HEADER_ROW_COUNT - 1, c: 0 } },
  ];
  for (let g = 0; g < visibleMarkets.length; g += 1) {
    merges.push({
      s: { r: 0, c: priceColumn(g) },
      e: { r: 0, c: priceColumn(g) + 1 },
    });
  }

  // ── Style ─────────────────────────────────────────────────────────────────
  const styles: StyledCell[] = [];
  const totalColumns = FIXED_COLUMN_COUNT + visibleMarkets.length * 2;
  const headerFill: ExcelJS.FillPattern = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: HEADER_FILL_COLOR },
  };
  for (let c = 0; c < totalColumns; c += 1) {
    for (let r = 0; r < HEADER_ROW_COUNT; r += 1) {
      styles.push({
        r,
        c,
        // Đậm cho hàng tên nước và cho cột Tier; "Price"/"Currency" là nhãn
        // phụ nên để thường, đúng như file mẫu Manager đã duyệt.
        font: { bold: r === 0 || c === 0, size: FONT_SIZE },
        fill: headerFill,
        alignment: {
          horizontal: c === 0 ? "left" : "center",
          vertical: "middle",
        },
      });
    }
  }

  const dataFont: Partial<ExcelJS.Font> = {
    name: DATA_FONT_NAME,
    size: FONT_SIZE,
  };
  matrix.tiers.forEach((tier, ri) => {
    const r = HEADER_ROW_COUNT + ri;
    // ⚠ Q5 — KHÔNG mang badge "Alt" của màn sang cột Tier. Tên đã tự nói:
    // "Alternate Tier 5". Badge trên màn là trang trí cho một chuỗi đã đủ.
    styles.push({ r, c: 0, font: dataFont });
    visibleMarkets.forEach((market, gi) => {
      const c = priceColumn(gi);
      const cell: MatrixCell | undefined =
        matrix.cells[`${tier.tier_id}|${market.code}`];
      if (!cell) {
        const emptyFont: Partial<ExcelJS.Font> = {
          ...dataFont,
          color: { argb: EMPTY_FONT_COLOR },
        };
        styles.push({ r, c, font: emptyFont, alignment: { horizontal: "right" } });
        styles.push({
          r,
          c: c + 1,
          font: emptyFont,
          alignment: { horizontal: "center" },
        });
        return;
      }
      // ⚠ F1 — `showDiff`, KHÔNG phải "có template Default hay không". Tắt
      // công tắc trên màn thì file cũng phải sạch.
      const isDiff = showDiff && cell.isDiff === true;
      const font: Partial<ExcelJS.Font> = isDiff
        ? { ...dataFont, bold: true, color: { argb: DIFF_FONT_COLOR } }
        : dataFont;
      styles.push({
        r,
        c,
        font,
        alignment: { horizontal: "right" },
        // Note chỉ gắn ô Price: một note lặp lại trên ô Currency ngay cạnh
        // không nói thêm gì mà lại nhân đôi số comment trong file.
        ...(isDiff ? { note: diffNote(cell) } : {}),
      });
      // ⚠ Tô CẢ Currency. Một ô Price cam cạnh một ô Currency đen trông như
      // lỗi vẽ chứ không như một câu khẳng định.
      styles.push({ r, c: c + 1, font, alignment: { horizontal: "center" } });
    });
  });

  const widths = [
    TIER_COLUMN_WIDTH,
    ...visibleMarkets.flatMap(() => [PRICE_COLUMN_WIDTH, CURRENCY_COLUMN_WIDTH]),
  ];

  return {
    aoa,
    widths,
    merges,
    styles,
    // ⚠ Freeze 1 cột + 2 hàng, suy ra từ hằng chứ không gõ số. Cột Tier phải
    // đứng yên khi cuộn ngang — file Per-App thật có 351 cột — và hai hàng
    // header phải đứng yên khi cuộn dọc.
    freeze: { cols: FIXED_COLUMN_COUNT, rows: HEADER_ROW_COUNT },
  };
}

export function buildTemplateMatrixWorkbook(
  input: TemplateMatrixExportInput,
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  addSheet(wb, SHEET_NAME[input.scope], buildTemplateMatrixSheetSpec(input));
  return wb;
}

/**
 * ⚠ CHỖ DUY NHẤT TRONG MODULE NÀY LÁI exceljs. Mọi thứ ở trên là dữ liệu
 * thuần, 0-index; hàm này đổi sang 1-index đúng một lần.
 */
function addSheet(wb: ExcelJS.Workbook, name: string, spec: SheetSpec): void {
  const ws = wb.addWorksheet(name);
  for (const row of spec.aoa) {
    ws.addRow(row.map((v) => v ?? null));
  }
  spec.widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
  for (const m of spec.merges) {
    ws.mergeCells(m.s.r + 1, m.s.c + 1, m.e.r + 1, m.e.c + 1);
  }
  for (const s of spec.styles) {
    const cell = ws.getCell(s.r + 1, s.c + 1);
    if (s.font) cell.font = s.font as ExcelJS.Font;
    if (s.fill) cell.fill = s.fill;
    if (s.alignment) cell.alignment = s.alignment;
    if (s.note) cell.note = s.note;
    // ⚠ KHÔNG set `cell.numFmt`. Không set ⇒ numFmtId=0 ⇒ Excel General ⇒
    // `styles.xml` KHÔNG có khối <numFmts> nào. Format cũ `"0.####"` có dấu
    // "." là ký tự LITERAL nên luôn được vẽ ra kể cả khi phần thập phân rỗng:
    // 49000 hiện thành "49000." — và trên máy dùng "," làm phân cách thập
    // phân thì thành "49000,", đúng thứ Manager báo. Đo bằng SSF trên 10 giá
    // trị đại diện: General là format số DUY NHẤT trùng khít glyph màn.
    // Cái không tồn tại thì không trôi được.
  }
  ws.views = [
    { state: "frozen", xSplit: spec.freeze.cols, ySplit: spec.freeze.rows },
  ];
}

/**
 * Quy ước tên file — giữ nguyên quy ước của đường CSV mà nó thay thế, chỉ đổi
 * đuôi. Giữ nguyên là có chủ đích: Manager đã có file cũ trong thư mục tải
 * về, và một quy ước đặt tên đổi cùng lúc với định dạng sẽ làm hai file của
 * cùng một template trông như hai thứ khác nhau.
 */
export function templateMatrixXlsxFilename(args: {
  scope: TemplateMatrixScope;
  bundleId?: string;
  now?: Date;
}): string {
  const d = args.now ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  if (args.scope === "per-app") {
    // Chặn ký tự lạ trước khi nó vào Content-Disposition.
    const slug = (args.bundleId ?? "app").replace(/[^a-z0-9._-]+/gi, "_");
    return `apple-pricing-template-per-app-${slug}-${stamp}.xlsx`;
  }
  return `apple-pricing-template-default-${stamp}.xlsx`;
}

export { EMPTY_CELL, DIFF_FONT_COLOR, FIXED_COLUMN_COUNT, HEADER_ROW_COUNT };
