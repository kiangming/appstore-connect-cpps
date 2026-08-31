/**
 * C2 — round-trip BYTE test cho writer .xlsx ma trận Pricing Template (Google).
 *
 * ─── VÌ SAO KHÔNG ĐỌC LẠI BẰNG exceljs ─────────────────────────────────────
 *
 * `xlsx-template-matrix-export.test.ts` (C1) canh MÔ HÌNH ĐỐI TƯỢNG — spec
 * thuần, trước khi có file. File này canh thứ khác hẳn: **cái thực sự nằm
 * trong archive**. Đọc lại bằng exceljs sẽ không phân biệt được hai thứ đó,
 * vì exceljs có thể chuẩn hoá lúc đọc (điền mặc định, gộp style, bỏ phần nó
 * không hiểu) — nói cách khác, nó có thể trả về đúng thứ ta vừa đưa vào kể cả
 * khi thứ đó chưa từng được ghi ra bytes.
 *
 * ⇒ Toàn bộ file này đọc bằng `execFileSync("unzip", ["-p", …])` và làm việc
 *   trên chuỗi XML thô. Chứng minh hai tầng canh hai thứ khác nhau nằm ở khối
 *   mutation cuối file.
 *
 * ─── KHÁC ARC APPLE — ĐỪNG CHÉP ASSERTION SANG ─────────────────────────────
 *
 * ⚠ `styles.xml` của file này PHẢI CÓ `<numFmts count="1">` với
 * `formatCode="0.00####"`. Arc Apple khẳng định điều NGƯỢC LẠI ("không có
 * khối `<numFmts>` nào") vì Apple cố ý không ghi numFmt (KB §21.4). Google
 * ghi numFmt theo currency, có lý do riêng (KB §22, viết ở C6). Chép
 * assertion của Apple sang đây sẽ làm test đỏ vì một quyết định ĐÚNG.
 *
 * ⚠ Format `"0"` (currency 0 chữ số) KHÔNG xuất hiện trong `<numFmts>` —
 * nó là **built-in `numFmtId="1"`** của Excel. Assertion phải đi tìm nó ở
 * `cellXfs`, không ở `numFmts`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  writeTemplateMatrixXlsx,
  DIFF_FONT_COLOR,
  EMPTY_CELL,
  type TemplateMatrixExportInput,
} from "./xlsx-template-matrix-export";
import { composeMatrix, type TemplateEntryRow } from "./queries/template-matrix";

function row(
  identifier: string,
  region_code: string,
  currency: string,
  price_micros: string,
): TemplateEntryRow {
  return { identifier, region_code, currency, price_micros };
}

/**
 * Fixture cố ý gói đủ mọi thứ file này phải canh, trong một sheet nhỏ:
 *   Tier 1 · US = 0.99 USD (2 chữ số → numFmt tuỳ biến 164, KHÔNG diff)
 *   Tier 1 · VN = 25000500000 micros VND (0 chữ số → numFmt built-in 1,
 *                 CÓ diff so với Default 29000 → chữ amber + note,
 *                 VÀ là ca V4: màn cắt cụt còn 25000)
 *   Tier 2 · US = 1.99 USD           → hàng có ô thưa
 *   Tier 2 · VN = (không có)         → "·" ở CẢ HAI nửa
 */
const MATRIX = composeMatrix(
  [
    row("Tier 1", "US", "USD", "990000"),
    row("Tier 1", "VN", "VND", "25000500000"),
    row("Tier 2", "US", "USD", "1990000"),
  ],
  [
    row("Tier 1", "US", "USD", "990000"),
    row("Tier 1", "VN", "VND", "29000000000"),
  ],
);

const INPUT: TemplateMatrixExportInput = {
  matrix: MATRIX,
  regionCodes: ["US", "VN"],
  showDiff: true,
  scope: "per-app",
};

/** Toạ độ trong file fixture, đặt tên để assertion đọc được. */
const CELL = {
  tierHeader: "A1",
  usPrice: "B3", // 0.99 USD — KHÔNG diff
  usCurrency: "C3",
  vnPrice: "D3", // 25000 VND — CÓ diff, có note, ca V4
  vnCurrency: "E3",
  emptyPrice: "D4", // "·"
  emptyCurrency: "E4", // "·"
} as const;

let PARTS: string[] = [];
const XML: Record<string, string> = {};

/** Đọc một part ra chuỗi. `unzip -p` ghi thẳng ra stdout, không giải nén ra
 *  đĩa — và quan trọng hơn: không đi qua bất kỳ thư viện Excel nào. */
function part(name: string): string {
  const cached = XML[name];
  if (cached !== undefined) return cached;
  throw new Error(`part chưa được nạp: ${name}`);
}

/**
 * `unzip` đối xử tên part như GLOB, nên `[Content_Types].xml` — part BẮT BUỘC
 * của mọi file .xlsx — bị đọc thành một character class và không khớp gì cả:
 * `unzip` in "caution: filename not matched" và thoát rc=11.
 *
 * ⚠ Cách escape ĐO ĐƯỢC, không suy (thử trên một zip dựng tay):
 *     "[Content_Types].xml"        → rc=11  ✗
 *     "[[]Content_Types[]].xml"    → rc=11  ✗  (bọc CẢ `]` là SAI — `]`
 *                                              ngoài class vốn đã là nghĩa đen,
 *                                              bọc lại thành class rỗng hỏng)
 *     "[[]Content_Types].xml"      → rc=0   ✓
 *     "\\[Content_Types\\].xml"    → rc=0   ✓  ← dùng cách này: một quy tắc
 *                                              cho mọi ký tự meta
 * `execFileSync` không qua shell nên dấu `\` tới thẳng `unzip`.
 */
const GLOB_META = /[[\]*?\\]/g;
function globEscape(name: string): string {
  return name.replace(GLOB_META, (ch) => `\\${ch}`);
}

beforeAll(async () => {
  const out = await writeTemplateMatrixXlsx(INPUT);
  const dir = mkdtempSync(join(tmpdir(), "gmatrix-"));
  const file = join(dir, "matrix.xlsx");
  writeFileSync(file, out.buffer);

  PARTS = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.endsWith("/"));

  for (const p of PARTS) {
    const content = execFileSync("unzip", ["-p", file, globEscape(p)], {
      encoding: "utf8",
    });
    // `unzip -p` thoát 0 kèm cảnh báo khi tên không khớp, nên chuỗi rỗng là
    // dấu hiệu part KHÔNG được đọc — không phải part rỗng. Nổ ngay, kẻo mọi
    // assertion "không chứa X" phía dưới đều xanh một cách vô nghĩa.
    if (content.length === 0) {
      throw new Error(`đọc part rỗng: ${p} — glob escape hỏng?`);
    }
    XML[p] = content;
  }
});

// ── helper đọc XML thô ───────────────────────────────────────────────────────

/** Bắt buộc khớp. `throw` thay cho `expect(...).not.toBeNull()` + `!`: cùng
 *  một thông báo khi hỏng, nhưng kiểu thu hẹp được nên không cần non-null
 *  assertion — và helper dùng được cả ngoài thân `it()`. */
function mustMatch(hay: string, re: RegExp, what: string): RegExpMatchArray {
  const m = hay.match(re);
  if (!m) throw new Error(`không thấy ${what}`);
  return m;
}

/** `<c r="D3" s="4"><v>25000</v></c>` → nguyên chuỗi thẻ `<c>` của ô. */
function cellXml(ref: string): string {
  return mustMatch(
    part("xl/worksheets/sheet1.xml"),
    new RegExp(`<c r="${ref}"[^>]*(?:/>|>.*?</c>)`),
    `ô ${ref} trong sheet1.xml`,
  )[0];
}

/** Chỉ số style (`s="…"`) của ô; `null` khi ô không mang style. */
function styleIndex(ref: string): number | null {
  const m = cellXml(ref).match(/\ss="(\d+)"/);
  return m ? Number(m[1]) : null;
}

/** Như trên nhưng bắt buộc phải có — dùng cho ô mà thiết kế nói CHẮC CHẮN
 *  mang style (ô giá, ô diff). Ô không style ở đó là lỗi, không phải nhánh. */
function mustStyleIndex(ref: string): number {
  const s = styleIndex(ref);
  if (s === null) throw new Error(`ô ${ref} không mang s= — không có style`);
  return s;
}

/** Phần tử `<xf>` thứ n của `cellXfs`, bắt buộc tồn tại. */
function cellXf(index: number): string {
  const xf = children("cellXfs")[index];
  if (xf === undefined) throw new Error(`cellXfs[${index}] không tồn tại`);
  return xf;
}

/** Tách `<fonts>` / `<cellXfs>` thành mảng phần tử con theo thứ tự = id. */
function children(block: "fonts" | "cellXfs"): string[] {
  const m = mustMatch(
    part("xl/styles.xml"),
    new RegExp(`<${block}[^>]*>([\\s\\S]*?)</${block}>`),
    `khối <${block}> trong styles.xml`,
  );
  const tag = block === "fonts" ? "font" : "xf";
  return m[1].match(new RegExp(`<${tag}[^>]*(?:/>|>[\\s\\S]*?</${tag}>)`, "g")) ?? [];
}

/** Giá trị `<v>` của ô — chuỗi thô đúng như nằm trong file. */
function rawValue(ref: string): string {
  return mustMatch(cellXml(ref), /<v>([^<]*)<\/v>/, `<v> trong ô ${ref}`)[1];
}

/** Ô kiểu `t="s"` trỏ vào sharedStrings — trả về chuỗi thật. */
function sharedString(ref: string): string {
  expect(cellXml(ref)).toContain('t="s"');
  const idx = Number(rawValue(ref));
  const items =
    part("xl/sharedStrings.xml").match(/<si>[\s\S]*?<\/si>/g) ?? [];
  expect(items.length, "sharedStrings rỗng").toBeGreaterThan(idx);
  return (items[idx].match(/<t[^>]*>([\s\S]*?)<\/t>/) ?? ["", ""])[1];
}

// ═══════════════════════════════════════════════════════════════════════════

describe("C2 · giá trị ô — đọc THẲNG từ XML", () => {
  it("⚠ V4 — ô VND (micros 25000500000) mang <v>25000</v> trong FILE", () => {
    // Đây là ca duy nhất còn lại mà file có thể nói dối. Biến thể "ghi đầy
    // đủ" sẽ đặt 25000.5 vào đây và Excel vẽ ra 25001 (làm tròn LÊN) trong
    // khi màn vẽ 25000. Kiểm ở tầng bytes vì đây là con số thật sự được ghi.
    expect(rawValue(CELL.vnPrice)).toBe("25000");
    expect(rawValue(CELL.vnPrice)).not.toContain(".");
  });

  it("ô giá là SỐ — không có t=\"s\"", () => {
    // `t="s"` = shared string. Ô giá thành chuỗi thì mất sort/filter/SUM,
    // đúng thứ Manager đã duyệt phải giữ.
    expect(cellXml(CELL.usPrice)).not.toContain('t="s"');
    expect(cellXml(CELL.vnPrice)).not.toContain('t="s"');
    expect(rawValue(CELL.usPrice)).toBe("0.99");
  });

  it("ô Currency LÀ chuỗi — hai nửa của cặp mang hai kiểu khác nhau", () => {
    expect(sharedString(CELL.usCurrency)).toBe("USD");
    expect(sharedString(CELL.vnCurrency)).toBe("VND");
  });

  it("⚠ F6 — ô thưa: '·' mã hoá U+00B7, không mojibake, ở CẢ HAI nửa", () => {
    // Mojibake điển hình khi UTF-8 bị đọc như latin-1: "Â·". Nếu nó lọt vào
    // file thì màn nói "·" còn file nói một thứ khác.
    for (const ref of [CELL.emptyPrice, CELL.emptyCurrency]) {
      const s = sharedString(ref);
      expect(s).toBe(EMPTY_CELL);
      expect(s.codePointAt(0)).toBe(0x00b7);
      expect(s).not.toContain("Â"); // Â
      expect(s).toHaveLength(1);
    }
  });
});

describe("C2 · merge + freeze", () => {
  it("cột Tier merge DỌC A1:A2", () => {
    expect(part("xl/worksheets/sheet1.xml")).toContain('<mergeCell ref="A1:A2"/>');
  });

  it("mỗi nước đúng MỘT merge NGANG 2 cột; tổng = 1 dọc + N ngang", () => {
    const sheet = part("xl/worksheets/sheet1.xml");
    const refs = [...sheet.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1]);

    // ⚠ SO THEO TẬP, KHÔNG THEO THỨ TỰ — đo được: spec đưa vào
    // [A1:A2, B1:C1, D1:E1] nhưng exceljs ghi ra [B1:C1, D1:E1, A1:A2].
    // Thứ tự `<mergeCell>` trong file là chi tiết cài đặt của exceljs và
    // Excel không quan tâm; pin nó ở đây sẽ làm test đỏ khi nâng exceljs mà
    // chẳng bảo vệ điều gì. Thứ tự do TA quyết định được pin ở tầng spec (C1).
    expect([...refs].sort()).toEqual(["A1:A2", "B1:C1", "D1:E1"]);
    expect(sheet).toContain(`<mergeCells count="${refs.length}">`);
    expect(refs).toHaveLength(1 + INPUT.regionCodes.length);
  });

  it("freeze: <pane xSplit=\"1\" ySplit=\"2\" … state=\"frozen\"/>", () => {
    const pane = mustMatch(
      part("xl/worksheets/sheet1.xml"),
      /<pane [^>]*\/>/,
      "<pane> — freeze không được ghi ra bytes",
    )[0];
    expect(pane).toContain('xSplit="1"');
    expect(pane).toContain('ySplit="2"');
    expect(pane).toContain('state="frozen"');
  });
});

describe("C2 · chữ amber — đi HẾT chuỗi tham chiếu", () => {
  it("<fonts> có đúng một font mang FFB45309", () => {
    const withColor = children("fonts").filter((f) => f.includes(DIFF_FONT_COLOR));
    expect(withColor).toHaveLength(1);
    expect(withColor[0]).toContain("<b/>"); // đậm, như màn
  });

  it("ô diff → s= → cellXfs[n] → fontId trỏ ĐÚNG font amber, có applyFont", () => {
    // Đây là chỗ một test lười sẽ chỉ grep "FFB45309 có trong archive" rồi
    // dừng — mà màu nằm trong styles.xml KHÔNG chứng minh ô nào đang dùng nó.
    const fonts = children("fonts");
    const amberFontId = fonts.findIndex((f) => f.includes(DIFF_FONT_COLOR));
    expect(amberFontId).toBeGreaterThanOrEqual(0);

    const xf = cellXf(mustStyleIndex(CELL.vnPrice));
    expect(xf).toContain(`fontId="${amberFontId}"`);
    expect(xf).toContain('applyFont="1"');
  });

  it("⚠ CHỨNG ÂM — ô KHÔNG diff không trỏ tới font amber", () => {
    // Không có nửa này thì một writer tô amber cho MỌI ô vẫn qua được test
    // trên.
    const fonts = children("fonts");
    const amberFontId = fonts.findIndex((f) => f.includes(DIFF_FONT_COLOR));
    const xfs = children("cellXfs");

    for (const ref of [CELL.usPrice, CELL.usCurrency, CELL.emptyPrice, CELL.tierHeader]) {
      const s = styleIndex(ref);
      if (s === null) continue; // ô không style thì chắc chắn không amber
      expect(xfs[s], `cellXfs[${s}] cho ô ${ref}`).toBeDefined();
      expect(xfs[s]).not.toContain(`fontId="${amberFontId}"`);

    }
  });

  it("⚠ KHÔNG có FFFFF2CC — vàng đó có nghĩa khác ở export item list Apple", () => {
    // KB §9: cùng dấu hiệu, khác nghĩa. FFFFF2CC = "Apple tự cân bằng giá"
    // (lib/iap-management/xlsx-export.ts:728). Nó không được xuất hiện ở đây.
    for (const p of PARTS) expect(XML[p]).not.toContain("FFFFF2CC");
  });
});

describe("C2 · note — đủ BỐN mảnh, và đúng ô", () => {
  it("comments1.xml + vmlDrawing1.vml có mặt trong archive", () => {
    expect(PARTS).toContain("xl/comments1.xml");
    expect(PARTS).toContain("xl/drawings/vmlDrawing1.vml");
  });

  it("sheet1.xml có <legacyDrawing r:id> trỏ tới vmlDrawing qua rels", () => {
    // Thiếu mảnh này thì Excel không vẽ note ra, dù comments1.xml vẫn nằm
    // trong file — tức note "có trong archive" mà người mở không thấy.
    const rId = mustMatch(
      part("xl/worksheets/sheet1.xml"),
      /<legacyDrawing r:id="([^"]+)"\/>/,
      "<legacyDrawing>",
    )[1];
    const rels = part("xl/worksheets/_rels/sheet1.xml.rels");
    const rel = mustMatch(
      rels,
      new RegExp(`<Relationship Id="${rId}"[^>]*/>`),
      `Relationship Id=${rId} trong rels`,
    )[0];
    expect(rel).toContain("vmlDrawing");
    expect(rels).toContain("comments1.xml");
  });

  it("⚠ note gắn vào ô Price, KHÔNG nhân đôi sang ô Currency", () => {
    const refs = [
      ...part("xl/comments1.xml").matchAll(/<comment ref="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(refs).toEqual([CELL.vnPrice]);
    expect(refs).not.toContain(CELL.vnCurrency);
  });

  it("⚠ F2 — nội dung note ghi currency CẢ HAI BÊN", () => {
    const text = part("xl/comments1.xml");
    expect(text).toContain("Default: 29000 VND → Per-App: 25000 VND");
  });
});

describe("C2 · numFmt — ⚠ Google KHÁC Apple ở chính chỗ này", () => {
  it("styles.xml CÓ <numFmts count=\"1\"> với formatCode=\"0.00####\"", () => {
    // ⚠ Arc Apple khẳng định NGƯỢC LẠI ("không có khối <numFmts>"). Chép
    // assertion đó sang đây sẽ làm test đỏ vì một quyết định ĐÚNG. KB §22.
    const styles = part("xl/styles.xml");
    expect(styles).toContain('<numFmts count="1">');
    expect(styles).toContain('formatCode="0.00####"');
  });

  it("ô USD (2 chữ số) trỏ tới numFmt TUỲ BIẾN (id ≥ 164)", () => {
    const styles = part("xl/styles.xml");
    const id = mustMatch(
      styles,
      /<numFmt numFmtId="(\d+)" formatCode="0\.00####"\/>/,
      "khai báo numFmt 0.00####",
    )[1];
    expect(Number(id)).toBeGreaterThanOrEqual(164); // vùng dành cho format tuỳ biến

    const xf = cellXf(mustStyleIndex(CELL.usPrice));
    expect(xf).toContain(`numFmtId="${id}"`);
    expect(xf).toContain('applyNumberFormat="1"');
  });

  it("⚠ ô VND (0 chữ số) dùng BUILT-IN numFmtId=\"1\", không nằm trong <numFmts>", () => {
    // Format "0" là built-in của Excel; đi tìm nó trong <numFmts> sẽ không
    // thấy và dễ kết luận nhầm là "numFmt không được ghi".
    const xf = cellXf(mustStyleIndex(CELL.vnPrice));
    expect(xf).toContain('numFmtId="1"');
    expect(xf).toContain('applyNumberFormat="1"');
    expect(part("xl/styles.xml")).not.toContain('formatCode="0"');
  });

  it("⚠ ô Currency và ô '·' KHÔNG mang numFmt của ô giá", () => {
    // numFmt gán THEO Ô chứ không theo CỘT. Gán theo cột sẽ vẽ lại cả "·".
    const styles = part("xl/styles.xml");
    const customId = mustMatch(styles, /<numFmt numFmtId="(\d+)"/, "numFmt tuỳ biến")[1];
    const xfs = children("cellXfs");
    for (const ref of [CELL.usCurrency, CELL.vnCurrency, CELL.emptyPrice, CELL.emptyCurrency]) {
      const s = styleIndex(ref);
      if (s === null) continue;
      expect(xfs[s], `cellXfs[${s}] cho ô ${ref}`).toBeDefined();
      expect(xfs[s]).not.toContain(`numFmtId="${customId}"`);
      expect(xfs[s]).not.toContain('numFmtId="1"');
    }
  });
});

describe("C2 · vỏ file", () => {
  it("đúng một sheet, tên theo scope", () => {
    expect(part("xl/workbook.xml")).toContain('name="Per-App Template"');
    expect(PARTS.filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))).toHaveLength(1);
  });

  it("dimension phủ hết vùng dữ liệu đã ghi", () => {
    // 2 hàng header + 2 tier = 4 hàng; 1 cột tier + 2 nước × 2 = 5 cột.
    expect(part("xl/worksheets/sheet1.xml")).toContain('<dimension ref="A1:E4"/>');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ký tự đặc biệt trong DỮ LIỆU — bản thay cho csv-export.test.ts #7
// ═══════════════════════════════════════════════════════════════════════════

describe("⚠ ký tự đặc biệt trong tier: sống sót nguyên vẹn vào file", () => {
  /**
   * Bản thay cho `csv-export.test.ts` #7 ("quotes fields containing commas /
   * quotes / newlines — RFC 4180").
   *
   * ⚠ ĐỪNG BỎ TEST NÀY VÌ "CSV KHÔNG CÒN NÊN KHÔNG CẦN ESCAPE NỮA". Cái nó
   * canh không phải dấu nháy của CSV — nó canh rằng **một tên tier do Manager
   * đặt, chứa ký tự bất kỳ, đi vào file mà không hỏng và không đổi**. Định
   * dạng đổi thì rủi ro đổi hình dạng chứ không biến mất: .xlsx là XML, nên
   * `&`, `<`, `>` phải được escape đúng, còn `,` và `"` thì phải KHÔNG bị
   * đụng tới (CSV cần, XML không). Cả hai vế đều sai được.
   *
   * Đây đúng là lớp lỗi §21.6 của arc Apple: một test trông như đã lỗi thời
   * theo định dạng cũ, mà thật ra đang canh một tính chất của DỮ LIỆU.
   */
  const NASTY = [
    { label: "dấu phẩy", tier: "Tier, special" },
    { label: "nháy kép", tier: 'Tier "quoted"' },
    { label: "và + ngoặc nhọn", tier: "Tier <b>1</b> & Co" },
    { label: "xuống dòng", tier: "Tier\nwrapped" },
    { label: "nháy đơn + apostrophe", tier: "Côte d'Ivoire tier" },
    { label: "phi-ASCII", tier: "Tier Việt — Türkiye" },
  ];

  it.each(NASTY)("$label — đọc lại từ file ra ĐÚNG chuỗi gốc", async ({ tier }) => {
    const matrix = composeMatrix([row(tier, "US", "USD", "990000")]);
    const out = await writeTemplateMatrixXlsx({
      matrix,
      regionCodes: ["US"],
      showDiff: false,
      scope: "default",
    });
    const dir = mkdtempSync(join(tmpdir(), "gmatrix-nasty-"));
    const file = join(dir, "m.xlsx");
    writeFileSync(file, out.buffer);
    const read = (n: string) =>
      execFileSync("unzip", ["-p", file, globEscape(n)], { encoding: "utf8" });

    const sheet = read("xl/worksheets/sheet1.xml");
    const shared = read("xl/sharedStrings.xml");

    // A3 = ô tier của hàng dữ liệu đầu tiên.
    const m = sheet.match(/<c r="A3"[^>]*t="s"[^>]*><v>(\d+)<\/v>/);
    if (!m) throw new Error("ô A3 không phải shared string");
    const items = shared.match(/<si>[\s\S]*?<\/si>/g) ?? [];
    const raw = (items[Number(m[1])].match(/<t[^>]*>([\s\S]*?)<\/t>/) ?? ["", ""])[1];

    // Un-escape XML để so với chuỗi gốc.
    const decoded = raw
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#10;/g, "\n")
      .replace(/&amp;/g, "&");
    expect(decoded).toBe(tier);
  });

  it("`&` và `<` ĐƯỢC escape trong XML; `,` và `\"` thì KHÔNG bị đụng tới", async () => {
    // Hai vế của cùng một sự thật: XML cần escape ba ký tự, CSV cần escape ba
    // ký tự KHÁC. Lẫn hai bộ vào nhau là cách file hỏng mà vẫn "trông ổn".
    const matrix = composeMatrix([
      row('A & B < C, D "E"', "US", "USD", "990000"),
    ]);
    const out = await writeTemplateMatrixXlsx({
      matrix,
      regionCodes: ["US"],
      showDiff: false,
      scope: "default",
    });
    const dir = mkdtempSync(join(tmpdir(), "gmatrix-esc-"));
    const file = join(dir, "m.xlsx");
    writeFileSync(file, out.buffer);
    const shared = execFileSync("unzip", ["-p", file, "xl/sharedStrings.xml"], {
      encoding: "utf8",
    });
    expect(shared).toContain("&amp;");
    expect(shared).toContain("&lt;");
    // `,` là ký tự thường trong XML — không được biến thành gì cả.
    expect(shared).toContain(",");
    // XML KHÔNG bị hỏng: mọi `&` đều mở đầu một entity hợp lệ.
    expect(shared).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/);
  });
});
