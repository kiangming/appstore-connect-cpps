/**
 * C2 — ĐỪNG TIN OBJECT MODEL, ĐỌC FILE.
 *
 * Mọi test C1 hỏi object model của exceljs. Model đó có thể giữ một thứ mà
 * writer không bao giờ serialize — `xlsx@0.18.5` hành xử đúng như vậy: nó
 * NHẬN `cell.s = { fill: … }` rồi lặng lẽ vứt lúc write, để lại `styles.xml`
 * chỉ có hai pattern mặc định (KB §4.17). Một bộ test chỉ hỏi model sẽ xanh
 * trên xlsx và ship ra file không có màu nào.
 *
 * Nên các test ở đây ghi .xlsx thật, giải nén, đọc XML. Cùng khuôn với
 * `export-workbook-file.test.ts` của export item list.
 *
 * MUTATION cho C2:
 *   gỡ freeze          → `<pane>` biến mất khỏi sheet1.xml → FAIL
 *   gỡ font cam        → `FFB45309` biến mất khỏi styles.xml, và chuỗi
 *                        fontId→xf→`<c s="…">` đứt → FAIL Ở TẦNG BYTES
 *
 * ⚠ Vì sao phải có mutation thứ hai: một test đọc bytes mà vẫn xanh khi gỡ
 * màu thì nó đang đọc thứ khác. Đây là cách duy nhất chứng minh test này
 * thật sự đọc file chứ không phải đọc lại model qua một đường vòng.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTemplateMatrixWorkbook,
  DIFF_FONT_COLOR,
  EMPTY_CELL,
} from "./xlsx-template-matrix-export";
import { composeMatrix, type TemplateEntryRow } from "./queries/template-matrix";

function row(
  tier_id: string,
  territory_code: string,
  currency_code: string,
  customer_price: number,
): TemplateEntryRow {
  return { tier_id, territory_code, currency_code, customer_price, proceeds: null };
}

const TIER_NAMES = new Map<string, string>([
  ["TIER_2", "Tier 2"],
  ["TIER_10", "Tier 10"],
]);

/**
 * Lưới cố định dùng cho cả file test — chọn để mỗi ca cần canh đều có mặt
 * đúng một lần, ở một địa chỉ ô gọi tên được:
 *
 *        A          B         C          D            E
 *   1  Tier      Vietnam ─────────    United States ─────────
 *   2            Price     Currency   Price        Currency
 *   3  Tier 2    385000    VND        1.99         USD      ← B3 khác Default
 *   4  Tier 10   900000    VND        ·            ·        ← D4/E4 ô thưa
 *
 * Thứ tự nước là VNM rồi USA (thứ tự xuất hiện), KHÔNG phải alphabet — nếu
 * writer sort lại thì mọi địa chỉ ô dưới đây lệch và test đỏ.
 */
const MATRIX = composeMatrix({
  entries: [
    row("TIER_2", "VNM", "VND", 385000),
    row("TIER_2", "USA", "USD", 1.99),
    row("TIER_10", "VNM", "VND", 900000),
  ],
  tierNames: TIER_NAMES,
  defaultEntries: [
    row("TIER_2", "VNM", "VND", 349000), // → diff
    row("TIER_2", "USA", "USD", 1.99), // → giống, không diff
  ],
});

/** ⚠ Điểm mấu chốt: bytes trên đĩa, không phải workbook trong bộ nhớ. */
async function writeAndUnzip() {
  const wb = buildTemplateMatrixWorkbook({
    matrix: MATRIX,
    visibleMarkets: MATRIX.markets,
    showDiff: true,
    scope: "per-app",
  });
  const dir = mkdtempSync(join(tmpdir(), "iap-tmpl-matrix-"));
  const file = join(dir, "out.xlsx");
  writeFileSync(file, Buffer.from(await wb.xlsx.writeBuffer()));
  const part = (name: string) =>
    execFileSync("unzip", ["-p", file, name], { encoding: "utf8" });
  const parts = () =>
    execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).split("\n");
  return { file, part, parts };
}

/** Thẻ `<c>` đầy đủ của một ô, đọc thô từ XML. */
function cellTag(sheetXml: string, ref: string): string {
  const m = new RegExp(`<c r="${ref}"(?:[^>]*/>|[^>]*>[\\s\\S]*?</c>)`).exec(sheetXml);
  if (!m) throw new Error(`không thấy ô ${ref} trong sheet1.xml`);
  return m[0];
}

/** Chỉ số `s="…"` (cellXfs index) của một ô, hoặc null khi ô không có style. */
function styleIndex(sheetXml: string, ref: string): number | null {
  const m = /\ss="(\d+)"/.exec(cellTag(sheetXml, ref));
  return m ? Number(m[1]) : null;
}

/** Danh sách `<font>` theo đúng thứ tự — index chính là fontId. */
function fonts(stylesXml: string): string[] {
  const block = /<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(stylesXml);
  if (!block) throw new Error("styles.xml không có khối <fonts>");
  return block[1].match(/<font>[\s\S]*?<\/font>/g) ?? [];
}

/** Danh sách `<xf>` trong cellXfs — index chính là giá trị `s=` của ô. */
function cellXfs(stylesXml: string): string[] {
  const block = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!block) throw new Error("styles.xml không có khối <cellXfs>");
  return block[1].match(/<xf\b[^>]*\/?>/g) ?? [];
}

/** Bảng shared string theo thứ tự — index chính là `<v>` của ô `t="s"`. */
function sharedStrings(xml: string): string[] {
  return (xml.match(/<si>[\s\S]*?<\/si>/g) ?? []).map(
    (si) => /<t[^>]*>([\s\S]*?)<\/t>/.exec(si)?.[1] ?? "",
  );
}

let sheet: string;
let styles: string;
let strings: string;
let partNames: string[];

beforeAll(async () => {
  const out = await writeAndUnzip();
  sheet = out.part("xl/worksheets/sheet1.xml");
  styles = out.part("xl/styles.xml");
  strings = out.part("xl/sharedStrings.xml");
  partNames = out.parts();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("⚠ C2 — hình học sống sót qua zip: merge + freeze", () => {
  it("merge: A1:A2 (cột Tier) + đúng N merge ngang, N = số nước", () => {
    const refs = (sheet.match(/<mergeCell ref="([A-Z]+\d+:[A-Z]+\d+)"\/>/g) ?? []).map(
      (m) => /ref="([^"]+)"/.exec(m)![1],
    );
    expect(refs).toContain("A1:A2"); // "Tier" phủ dọc hai hàng header
    expect(refs).toContain("B1:C1"); // Vietnam  → Price + Currency
    expect(refs).toContain("D1:E1"); // United States
    // ⚠ ĐẾM, không chỉ "có mặt" (KB §4.20: shape đúng ở bảng chữ cái sai vẫn
    // pass, tổng thì không). 1 dọc + 1 mỗi nước.
    expect(refs).toHaveLength(1 + MATRIX.markets.length);
    expect(sheet).toContain(`<mergeCells count="${1 + MATRIX.markets.length}">`);
  });

  it("merge ngang không tràn sang cặp kế bên", () => {
    // Nếu builder tính bề rộng merge từ độ dài chữ thay vì đếm cột thì
    // "United States" (13 ký tự) sẽ đẩy merge lệch — file vẫn mở được và vẫn
    // sai.
    expect(sheet).not.toMatch(/<mergeCell ref="B1:[E-Z]/);
    expect(sheet).not.toMatch(/<mergeCell ref="C1:/);
  });

  it("freeze: <pane xSplit=\"1\" ySplit=\"2\" state=\"frozen\"> có trong sheet1.xml", () => {
    expect(sheet).toMatch(/<pane[^>]*xSplit="1"/);
    expect(sheet).toMatch(/<pane[^>]*ySplit="2"/);
    expect(sheet).toMatch(/<pane[^>]*state="frozen"/);
  });

  it("xSplit là 1, KHÔNG phải 2 — split 2 sẽ ghim Price và thả Currency trôi", () => {
    // Cùng lý do export item list freeze 4 chứ không 5.
    expect(sheet).not.toMatch(/<pane[^>]*xSplit="2"/);
    expect(sheet).not.toMatch(/<pane[^>]*xSplit="0"/);
  });
});

describe("⚠ C2 — font cam có mặt VÀ được ô trỏ tới", () => {
  // "Màu nằm đâu đó trong styles.xml" là một khẳng định yếu: một màu được
  // định nghĩa mà không ô nào tham chiếu là một bảng màu thừa, không phải một
  // ô được tô. Test này đi hết chuỗi: font → fontId → cellXfs → `s=` của ô.

  it("styles.xml định nghĩa một <font> mang màu B45309", () => {
    expect(styles).toContain(DIFF_FONT_COLOR);
    expect(fonts(styles).some((f) => f.includes(DIFF_FONT_COLOR))).toBe(true);
  });

  it("ô B3 (khác Default) trỏ tới đúng cái xf dùng font đó", () => {
    const fontId = fonts(styles).findIndex((f) => f.includes(DIFF_FONT_COLOR));
    expect(fontId).toBeGreaterThanOrEqual(0);

    const s = styleIndex(sheet, "B3");
    expect(s).not.toBeNull();
    const xf = cellXfs(styles)[s!];
    expect(xf).toBeDefined();
    expect(xf).toMatch(new RegExp(`fontId="${fontId}"`));
    expect(xf).toContain('applyFont="1"');
  });

  it("nửa Currency của cặp (C3) trỏ tới CÙNG font cam đó", () => {
    // Một ô Price cam cạnh một ô Currency đen đọc ra như lỗi vẽ.
    const fontId = fonts(styles).findIndex((f) => f.includes(DIFF_FONT_COLOR));
    const xf = cellXfs(styles)[styleIndex(sheet, "C3")!];
    expect(xf).toMatch(new RegExp(`fontId="${fontId}"`));
  });

  it("ô KHÔNG khác Default (D3) KHÔNG trỏ tới font cam", () => {
    // Chứng âm: thiếu nó thì một writer tô cam mọi ô vẫn qua được ba test trên.
    const fontId = fonts(styles).findIndex((f) => f.includes(DIFF_FONT_COLOR));
    const xf = cellXfs(styles)[styleIndex(sheet, "D3")!];
    expect(xf).not.toMatch(new RegExp(`fontId="${fontId}"`));
  });

  it("⚠ KHÔNG có nền vàng FFFFF2CC — màu đó có nghĩa khác ở export item list", () => {
    // Hai file .xlsx của cùng module Apple dùng chung một màu nền cho hai
    // nghĩa khác nhau là bẫy KB §9. Ô khác-Default dùng màu CHỮ.
    expect(styles).not.toContain("FFFFF2CC");
  });
});

describe("⚠ C2 — KHÔNG có khối <numFmts> trong styles.xml", () => {
  // Canh trực tiếp lỗi Việc 1 ở tầng bytes: "0.####" chứa dấu "." literal nên
  // luôn vẽ ra một phân cách thập phân kể cả với số nguyên (49000 → "49000.",
  // và "49000," trên máy dùng dấu phẩy). Không set numFmt ⇒ numFmtId=0 ⇒ khối
  // này không tồn tại. Cái không tồn tại thì không trôi được.

  it("file không khai báo numFmt tuỳ biến nào", () => {
    expect(styles).not.toContain("<numFmts");
    expect(styles).not.toContain("formatCode");
  });

  it('không có chuỗi "0.####" ở bất kỳ đâu trong styles.xml', () => {
    expect(styles).not.toContain("0.####");
  });

  it("mọi <xf> trong cellXfs đều numFmtId=0 và không applyNumberFormat", () => {
    for (const xf of cellXfs(styles)) {
      expect(xf).toMatch(/numFmtId="0"/);
      expect(xf).not.toContain('applyNumberFormat="1"');
    }
  });
});

describe("⚠ C2 — ô giá là SỐ trong XML, không phải shared string", () => {
  // Kiểm KIỂU trong XML, không chỉ kiểm giá trị: một ô ghi chuỗi "385000"
  // đọc lại vẫn ra "385000" nhưng Excel không sort/filter/tính được nó.

  it('B3 không có t="s" và mang <v>385000</v>', () => {
    const tag = cellTag(sheet, "B3");
    expect(tag).not.toContain('t="s"');
    expect(tag).not.toContain('t="str"');
    expect(tag).toContain("<v>385000</v>");
  });

  it("số thập phân giữ nguyên bản, không bị làm tròn hay cắt", () => {
    const tag = cellTag(sheet, "D3");
    expect(tag).not.toContain('t="s"');
    expect(tag).toContain("<v>1.99</v>");
  });

  it('ô Currency thì NGƯỢC LẠI — nó là chuỗi, có t="s"', () => {
    // Chứng âm cho hai test trên: nếu writer ghi mọi thứ thành số hoặc mọi
    // thứ thành chuỗi, một trong hai phía sẽ đỏ.
    expect(cellTag(sheet, "C3")).toContain('t="s"');
  });

  it("không ô giá nào lọt vào bảng shared string", () => {
    expect(sharedStrings(strings)).not.toContain("385000");
    expect(sharedStrings(strings)).not.toContain("1.99");
  });
});

describe("⚠ C2 — '·' mã hoá đúng U+00B7, không mojibake", () => {
  // Cùng lý do export item list phải test `—` ở tầng file: "·" là ký tự
  // non-ASCII duy nhất writer này phát ra. Một part ghi bằng latin-1 sẽ
  // round-trip qua chính reader của exceljs trông vẫn ổn, rồi mở trong Excel
  // ra "Â·". Chỉ bytes mới nói được.

  it("sharedStrings chứa U+00B7, không phải entity, không phải mojibake", () => {
    expect(strings).toContain("·");
    expect(sharedStrings(strings)).toContain(EMPTY_CELL);
    expect(strings).not.toContain("&#183;");
    expect(strings).not.toContain("&middot;");
    expect(strings).not.toContain("Â");
  });

  it("ô thưa D4 trỏ đúng vào mục '·' của bảng shared string", () => {
    // Chuỗi đầy đủ: ô → index → bảng. Chỉ kiểm "bảng có '·'" thì một writer
    // ghi "·" nhầm chỗ vẫn qua.
    const idx = sharedStrings(strings).indexOf(EMPTY_CELL);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(cellTag(sheet, "D4")).toContain(`<v>${idx}</v>`);
    expect(cellTag(sheet, "E4")).toContain(`<v>${idx}</v>`);
  });

  it("ô thưa KHÔNG rỗng và KHÔNG là số 0 trong file", () => {
    expect(cellTag(sheet, "D4")).toContain('t="s"');
    expect(cellTag(sheet, "D4")).not.toContain("<v>0</v>");
  });
});

describe("⚠ C2 — note tới được file: comments1.xml + vmlDrawing1.vml", () => {
  it("cả hai part đều có trong archive", () => {
    // Excel cần CẢ HAI: comments1.xml là nội dung, vmlDrawing1.vml là cái hộp
    // vẽ ra nó. Thiếu vml thì note có trong file mà Excel không hiện.
    expect(partNames).toContain("xl/comments1.xml");
    expect(partNames).toContain("xl/drawings/vmlDrawing1.vml");
  });

  it("sheet1.xml tham chiếu legacyDrawing — nếu không, note mồ côi", () => {
    expect(sheet).toMatch(/<legacyDrawing r:id="rId\d+"\/>/);
  });

  it("note gắn đúng ô B3 và ghi currency CẢ HAI bên (Q9/F2)", async () => {
    const { part } = await writeAndUnzip();
    const comments = part("xl/comments1.xml");
    expect(comments).toContain('<comment ref="B3"');
    expect(comments).toContain("Default: 349000 VND");
    expect(comments).toContain("Per-App: 385000 VND");
  });

  it("chỉ ô Price mang note — không nhân đôi sang ô Currency", async () => {
    const { part } = await writeAndUnzip();
    const comments = part("xl/comments1.xml");
    const refs = (comments.match(/<comment ref="([A-Z]+\d+)"/g) ?? []).map(
      (m) => /ref="([^"]+)"/.exec(m)![1],
    );
    expect(refs).toEqual(["B3"]);
  });

  it("ô KHÔNG khác Default không sinh note nào", async () => {
    const { part } = await writeAndUnzip();
    expect(part("xl/comments1.xml")).not.toContain('ref="D3"');
  });
});

describe("⚠ C2 — chứng âm: showDiff=false thì file KHÔNG có màu lẫn note", () => {
  // F1 ở tầng bytes. C1 đã canh ở object model; đây là chỗ chứng minh nó cũng
  // đúng trên đĩa — và cũng là chứng âm cho toàn bộ describe font cam ở trên.
  it("không FFB45309 trong styles.xml, không part comments nào", async () => {
    const wb = buildTemplateMatrixWorkbook({
      matrix: MATRIX,
      visibleMarkets: MATRIX.markets,
      showDiff: false,
      scope: "per-app",
    });
    const dir = mkdtempSync(join(tmpdir(), "iap-tmpl-matrix-nodiff-"));
    const file = join(dir, "out.xlsx");
    writeFileSync(file, Buffer.from(await wb.xlsx.writeBuffer()));
    const names = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" });
    const stylesXml = execFileSync("unzip", ["-p", file, "xl/styles.xml"], {
      encoding: "utf8",
    });
    expect(stylesXml).not.toContain(DIFF_FONT_COLOR);
    expect(names).not.toContain("xl/comments1.xml");
    expect(names).not.toContain("vmlDrawing");
  });
});
