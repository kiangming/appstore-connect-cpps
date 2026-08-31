/**
 * C1 — test cho writer .xlsx ma trận Pricing Template (Google).
 *
 * Toàn bộ test ở đây chạy trên SPEC THUẦN (`buildTemplateMatrixSpec`) — không
 * dựng workbook, không I/O. Kiểm ở tầng byte nằm ở C2.
 *
 * Giá trị dùng làm fixture lấy từ DỮ LIỆU THẬT: 2 file CSV Manager export ra
 * ngày 2026-08-30 (Default 94 tier × 9 region = 846 ô đầy; Per-App
 * `vng.games.lightandnight` 41 tier × 11 region = 451 ô, 369 có giá, 82 ô thưa).
 */
import { describe, it, expect } from "vitest";
import { SSF } from "xlsx";

import {
  buildTemplateMatrixSpec,
  diffNote,
  templateMatrixXlsxFilename,
  isTruncatedCell,
  priceCellValue,
  priceColumn,
  priceNumFmt,
  DIFF_FONT_COLOR,
  EMPTY_CELL,
  FIXED_COLUMN_COUNT,
  HEADER_ROW_COUNT,
  type TemplateMatrixExportInput,
} from "./xlsx-template-matrix-export";
import { formatPrice } from "./matrix-price-format";
import { getCurrencyDecimals } from "./google/currency-precision";
import { microsToDecimal } from "./google/price-conversion";
import { composeMatrix, type TemplateEntryRow } from "./queries/template-matrix";

function row(
  identifier: string,
  region_code: string,
  currency: string,
  price_micros: string,
): TemplateEntryRow {
  return { identifier, region_code, currency, price_micros };
}

/** Ma trận Default rút gọn, giữ ĐÚNG thứ tự nước của file thật:
 *  US VN SG MY ID PH TH HK TW (không phải alphabet — Hotfix 24). */
const DEFAULT_ENTRIES: TemplateEntryRow[] = [
  row("Tier 1", "US", "USD", "990000"),
  row("Tier 1", "VN", "VND", "25000000000"),
  row("Tier 1", "SG", "SGD", "1480000"),
  row("Tier 1", "MY", "MYR", "4900000"),
  row("Tier 1", "ID", "IDR", "16000000000"),
  row("Tier 1", "PH", "PHP", "49000000"),
  row("Tier 1", "TH", "THB", "35000000"),
  row("Tier 1", "HK", "HKD", "8000000"),
  row("Tier 1", "TW", "TWD", "33000000"),
];

const ALL_CODES = ["US", "VN", "SG", "MY", "ID", "PH", "TH", "HK", "TW"];

function input(
  over: Partial<TemplateMatrixExportInput> = {},
): TemplateMatrixExportInput {
  return {
    matrix: composeMatrix(DEFAULT_ENTRIES),
    regionCodes: ALL_CODES,
    showDiff: false,
    scope: "default",
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Ba lệch mà file CSV cũ mắc — mỗi cái một test nói rõ nó canh gì
// ═══════════════════════════════════════════════════════════════════════════

describe("⚠ F6 — ô thưa: màn vẽ '·' nên file GHI '·', ở CẢ HAI nửa", () => {
  it("ghi EMPTY_CELL vào cả ô Price lẫn ô Currency, không bỏ ô", () => {
    // Tier 2 chỉ có US — 8 nước còn lại là ô thưa. CSV cũ `continue`
    // (csv-export.ts:69) làm 8 ô đó biến mất hẳn khỏi file.
    const matrix = composeMatrix([
      ...DEFAULT_ENTRIES,
      row("Tier 2", "US", "USD", "1990000"),
    ]);
    const spec = buildTemplateMatrixSpec(input({ matrix }));

    const tier2Rows = spec.aoa.filter((r) => r[0] === "Tier 2");
    expect(tier2Rows).toHaveLength(1);
    const tier2 = tier2Rows[0];
    // US có giá; 8 nước còn lại phải là "·" × 2 nửa = 16 ô.
    expect(tier2.filter((v) => v === EMPTY_CELL)).toHaveLength(16);
    // Hàng vẫn đủ độ dài: 1 cột tier + 9 nước × 2.
    expect(tier2).toHaveLength(FIXED_COLUMN_COUNT + ALL_CODES.length * 2);
  });

  it("ô '·' KHÔNG nằm trong priceCells nên KHÔNG được gán numFmt", () => {
    const matrix = composeMatrix([
      ...DEFAULT_ENTRIES,
      row("Tier 2", "US", "USD", "1990000"),
    ]);
    const spec = buildTemplateMatrixSpec(input({ matrix }));
    // 9 ô giá của Tier 1 + 1 ô giá của Tier 2 = 10, không hơn.
    expect(spec.priceCells).toHaveLength(10);
    // 8 ô thưa × 2 nửa.
    expect(spec.emptyCells).toHaveLength(16);
    const priceKeys = new Set(spec.priceCells.map((p) => `${p.r}|${p.c}`));
    for (const e of spec.emptyCells) {
      expect(priceKeys.has(`${e.r}|${e.c}`)).toBe(false);
    }
  });
});

describe("⚠ F1 — file bám công tắc showDiff, KHÔNG bám 'có Default template'", () => {
  const perApp = composeMatrix(
    [row("Tier 1", "US", "USD", "990000"), row("Tier 1", "VN", "VND", "25000000000")],
    [row("Tier 1", "US", "USD", "990000"), row("Tier 1", "VN", "VND", "29000000000")],
  );

  it("showDiff=true → ô khác Default vào diffCells", () => {
    const spec = buildTemplateMatrixSpec(
      input({ matrix: perApp, regionCodes: ["US", "VN"], showDiff: true, scope: "per-app" }),
    );
    expect(spec.diffCells).toHaveLength(1); // chỉ VN khác
  });

  it("showDiff=false → KHÔNG ô nào được đánh dấu, dù Default vẫn tồn tại", () => {
    // Đây chính là ca CSV cũ nói sai: nó truyền `defaultTemplateExists`
    // (PerAppMatrixView.tsx:78) nên bỏ tick công tắc thì màn sạch mà file vẫn
    // mang cột diff. `matrix` ở đây VẪN có defaultPriceMicros/isDiff.
    const spec = buildTemplateMatrixSpec(
      input({ matrix: perApp, regionCodes: ["US", "VN"], showDiff: false, scope: "per-app" }),
    );
    expect(perApp.cells["Tier 1|VN"].isDiff).toBe(true); // dữ liệu vẫn nói "khác"
    expect(spec.diffCells).toHaveLength(0); // …nhưng file im, đúng như màn
  });
});

describe("⚠ F2 — note ghi currency CẢ HAI BÊN", () => {
  it("ô khác nhau CHỈ Ở CURRENCY vẫn nói được nó khác ở đâu", () => {
    // CSV cũ chỉ có cột `default_price` nên ca này in ra hai con số y hệt
    // nhau: file nói "không khác", màn nói "khác".
    const note = diffNote({
      priceMicros: "990000",
      currency: "USD",
      defaultPriceMicros: "990000",
      defaultCurrency: "SGD",
      isDiff: true,
    });
    expect(note).toBe("Default: 0.99 SGD → Per-App: 0.99 USD");
    // Hai con số giống nhau — chỉ currency phân biệt được. Nếu note bỏ
    // currency thì chuỗi thành "Default: 0.99 → Per-App: 0.99".
    expect(note).toContain("SGD");
    expect(note).toContain("USD");
  });

  it("thiếu giá trị Default → không có note, nhưng ô VẪN được tô màu", () => {
    // Đúng nhánh guard của màn (MatrixTable.tsx:33-36): tô theo isDiff, bỏ
    // tooltip khi thiếu dữ kiện. Không có guard thì note thành
    // "Default: undefined undefined".
    expect(
      diffNote({ priceMicros: "990000", currency: "USD", isDiff: true }),
    ).toBeUndefined();

    const matrix = composeMatrix([row("Tier 1", "US", "USD", "990000")]);
    matrix.cells["Tier 1|US"].isDiff = true; // isDiff không kèm giá trị Default
    const spec = buildTemplateMatrixSpec(
      input({ matrix, regionCodes: ["US"], showDiff: true, scope: "per-app" }),
    );
    expect(spec.diffCells).toHaveLength(1);
    expect(spec.diffCells[0].note).toBeUndefined();
  });

  it("note mirror ĐÚNG tooltip màn: một dòng, dấu ' → ' ở giữa", () => {
    // MatrixTable.tsx:42 — `Default: … → Per-App: …`. Apple viết hai dòng vì
    // tooltip Apple hai dòng; đổi cho "đẹp hơn" là thôi ảnh chụp.
    const note = diffNote({
      priceMicros: "25000000000",
      currency: "VND",
      defaultPriceMicros: "29000000000",
      defaultCurrency: "VND",
      isDiff: true,
    });
    expect(note).toBe("Default: 29000 VND → Per-App: 25000 VND");
    expect(note).not.toContain("\n");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Thứ tự — lấy từ matrix, KHÔNG lấy từ regionCodes
// ═══════════════════════════════════════════════════════════════════════════

describe("thứ tự cột lấy từ matrix.markets, regionCodes chỉ là BỘ LỌC", () => {
  it("giữ thứ tự upload (US VN SG MY ID PH TH HK TW), không alphabet", () => {
    const spec = buildTemplateMatrixSpec(input());
    const names = spec.aoa[0].filter((v): v is string => typeof v === "string").slice(1);
    expect(names).toEqual([
      "United States", "Vietnam", "Singapore", "Malaysia", "Indonesia",
      "Philippines", "Thailand", "Hong Kong", "Taiwan",
    ]);
  });

  it("⚠ regionCodes XÁO TRỘN cho ra spec y hệt — thứ tự không đến từ nó", () => {
    const a = buildTemplateMatrixSpec(input({ regionCodes: ALL_CODES }));
    const b = buildTemplateMatrixSpec(
      input({ regionCodes: ["TW", "MY", "US", "TH", "ID", "HK", "VN", "PH", "SG"] }),
    );
    expect(b.aoa).toEqual(a.aoa);
    expect(b.merges).toEqual(a.merges);
    expect(b.priceCells).toEqual(a.priceCells);
  });

  it("lọc bớt nước thì cột giảm, thứ tự các cột còn lại KHÔNG đổi", () => {
    const spec = buildTemplateMatrixSpec(input({ regionCodes: ["TH", "US", "VN"] }));
    const names = spec.aoa[0].filter((v): v is string => typeof v === "string").slice(1);
    expect(names).toEqual(["United States", "Vietnam", "Thailand"]);
    expect(spec.columnCount).toBe(3);
  });

  it("thứ tự tier lấy từ matrix.tiers (numeric-aware, Alternate xuống cuối)", () => {
    const matrix = composeMatrix([
      row("Tier 10", "US", "USD", "990000"),
      row("Alternate Tier 1", "US", "USD", "990000"),
      row("Tier 2", "US", "USD", "990000"),
    ]);
    const spec = buildTemplateMatrixSpec(input({ matrix, regionCodes: ["US"] }));
    expect(spec.aoa.slice(HEADER_ROW_COUNT).map((r) => r[0])).toEqual(
      matrix.tiers,
    );
    expect(matrix.tiers).toEqual(["Tier 2", "Tier 10", "Alternate Tier 1"]);
  });

  it("regionCodes rỗng THROW — không đường nào sinh ra file 1 cột", () => {
    expect(() => buildTemplateMatrixSpec(input({ regionCodes: [] }))).toThrow(
      RangeError,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Kiểu ô + numFmt
// ═══════════════════════════════════════════════════════════════════════════

describe("ô Price là SỐ; ô Currency và ô '·' không có numFmt", () => {
  it("ô Price mang number, ô Currency mang string", () => {
    const spec = buildTemplateMatrixSpec(input());
    const r = spec.aoa[HEADER_ROW_COUNT];
    expect(typeof r[priceColumn(0)]).toBe("number"); // US price
    expect(r[priceColumn(0)]).toBe(0.99);
    expect(typeof r[priceColumn(0) + 1]).toBe("string"); // US currency
    expect(r[priceColumn(0) + 1]).toBe("USD");
  });

  it("numFmt gán THEO Ô — mỗi ô Price đúng một mục, không gán theo cột", () => {
    const spec = buildTemplateMatrixSpec(input());
    expect(spec.priceCells).toHaveLength(9);
    // Ô Currency không bao giờ nằm trong priceCells.
    for (const p of spec.priceCells) {
      expect((p.c - FIXED_COLUMN_COUNT) % 2).toBe(0);
    }
  });

  it("numFmt theo currency: 0 chữ số → '0', 2 chữ số → '0.00####'", () => {
    expect(priceNumFmt("VND")).toBe("0");
    expect(priceNumFmt("IDR")).toBe("0");
    expect(priceNumFmt("TWD")).toBe("0");
    expect(priceNumFmt("USD")).toBe("0.00####");
    expect(priceNumFmt("MYR")).toBe("0.00####");
    expect(priceNumFmt("BHD")).toBe("0.000###"); // 3 chữ số
  });

  it("glyph không phải số → ô giữ CHUỖI THÔ, đúng nhánh catch của màn", () => {
    // price_micros là cột TEXT không ràng buộc chữ số; màn nuốt lỗi và vẽ
    // chuỗi thô (MatrixTable.tsx:21-23). Ghi NaN sẽ là file bịa giá trị.
    expect(formatPrice("not-a-number", "USD")).toBe("not-a-number");
    expect(priceCellValue("not-a-number")).toBe("not-a-number");
    const matrix = composeMatrix([row("Tier 1", "US", "USD", "not-a-number")]);
    const spec = buildTemplateMatrixSpec(input({ matrix, regionCodes: ["US"] }));
    expect(spec.aoa[HEADER_ROW_COUNT][priceColumn(0)]).toBe("not-a-number");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Parity: glyph Excel vẽ ra == glyph màn vẽ
// ═══════════════════════════════════════════════════════════════════════════

describe("parity — SSF vẽ ô ra ĐÚNG chuỗi màn đang vẽ", () => {
  // `SSF` là chính cài đặt ngữ pháp format của Excel. Test này là chỗ con số
  // 376/846 ô sai của file CSV cũ bị chặn: `General` vẽ 9.9 trong khi màn vẽ
  // 9.90.
  const REAL = [
    { cur: "USD", micros: "990000" }, { cur: "VND", micros: "25000000000" },
    { cur: "SGD", micros: "1480000" }, { cur: "MYR", micros: "4900000" },
    { cur: "IDR", micros: "16000000000" }, { cur: "PHP", micros: "49000000" },
    { cur: "THB", micros: "35000000" }, { cur: "HKD", micros: "8000000" },
    { cur: "TWD", micros: "33000000" }, { cur: "MMK", micros: "390000" },
    { cur: "PHP", micros: "11999000000" }, { cur: "VND", micros: "24999000000000" },
    { cur: "BHD", micros: "1990000" },
  ];

  it.each(REAL)("$cur micros=$micros — Excel và màn vẽ giống hệt", ({ cur, micros }) => {
    const screen = microsToDecimal(micros, getCurrencyDecimals(cur));
    const drawn = SSF.format(priceNumFmt(cur), priceCellValue(screen) as number);
    expect(drawn).toBe(screen);
  });

  it("⚠ đuôi '#' là thứ ngăn LÀM TRÒN — numFmt cố định sẽ cắt", () => {
    // Currency 2 chữ số nhưng micros có phần dư: hàm màn KHÔNG cắt
    // (nhánh fracRest), nên ô mang giá trị đầy đủ và numFmt phải vẽ đủ.
    const screen = microsToDecimal("4901234", getCurrencyDecimals("MYR"));
    expect(screen).toBe("4.901234");
    expect(SSF.format(priceNumFmt("MYR"), 4.901234)).toBe("4.901234");
    // Đối chứng: format cố định làm tròn — đây là mutation phải ĐỎ ở C6.
    expect(SSF.format("0.00", 4.901234)).toBe("4.90");
  });

  it("⚠ '0.00####' không dính bẫy dấu chấm trơ của '0.####' (KB §21.4)", () => {
    expect(SSF.format("0.####", 35)).toBe("35.");
    expect(SSF.format("0.00####", 35)).toBe("35.00");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// V4 — currency 0 chữ số có phần dư (cam kết V4.3)
// ═══════════════════════════════════════════════════════════════════════════

describe("⚠ V4 — currency 0 chữ số + micros có dư: ô mang ĐÚNG giá trị màn", () => {
  /**
   * Ba ca, và ca IDR là ca BẮT BUỘC phải có.
   *
   * Dưới biến thể sai (ô mang giá trị ĐẦY ĐỦ, tức `microsToDecimal(m, 6)`),
   * numFmt "0" làm tròn half-away-from-zero:
   *   VND 25000.5 → 25001  ✗ (màn 25000)
   *   TWD 33.7    → 34     ✗ (màn 33)
   *   IDR 16000.4 → 16000  ✓ PASS DO MAY — làm tròn XUỐNG
   * Thiếu ca IDR thì test vẫn xanh với một nửa lỗi, và người sửa sẽ tin là
   * mình đã canh xong.
   */
  const CASES = [
    { cur: "VND", micros: "25000500000", screen: "25000", underBug: 25001 },
    { cur: "TWD", micros: "33700000", screen: "33", underBug: 34 },
    { cur: "IDR", micros: "16000400000", screen: "16000", underBug: 16000 },
  ];

  it.each(CASES)(
    "$cur micros=$micros → ô mang $screen (KHÔNG phải giá trị đầy đủ)",
    ({ cur, micros, screen }) => {
      const matrix = composeMatrix([row("Tier 1", "XX", cur, micros)]);
      const spec = buildTemplateMatrixSpec(
        input({ matrix, regionCodes: ["XX"] }),
      );
      const value = spec.aoa[HEADER_ROW_COUNT][priceColumn(0)];

      // Khẳng định 1 — ô mang đúng con số màn vẽ, không phải bản đầy đủ.
      expect(value).toBe(Number(screen));
      expect(String(value)).not.toContain(".");

      // Khẳng định 2 — Excel vẽ ra đúng chuỗi màn vẽ.
      expect(SSF.format(priceNumFmt(cur), value as number)).toBe(
        microsToDecimal(micros, getCurrencyDecimals(cur)),
      );
    },
  );

  it.each(CASES)(
    "$cur — biến thể 'ghi đầy đủ' cho ra $underBug: chứng minh ca này CÓ răng",
    ({ cur, micros, underBug }) => {
      // Không test code sản phẩm — test rằng ca fixture này PHÂN BIỆT được
      // hai thiết kế. Nếu một ngày SSF đổi cách làm tròn, ca nào mất khả năng
      // phân biệt sẽ lộ ra ở đây chứ không âm thầm thành test rỗng.
      const full = Number(microsToDecimal(micros, 6));
      expect(SSF.format(priceNumFmt(cur), full)).toBe(String(underBug));
    },
  );

  it("đếm truncatedCells — cơ chế CÔNG BỐ, không phải cơ chế đúng-sai", () => {
    // Dưới thiết kế (a) không ô nào hiện SAI; con số này chỉ nói "N ô đang
    // hiện ít chữ số hơn DB đang giữ".
    expect(isTruncatedCell("25000500000", "VND")).toBe(true);
    expect(isTruncatedCell("25000000000", "VND")).toBe(false);
    expect(isTruncatedCell("4900001", "MYR")).toBe(false); // 2 chữ số: không mất gì
    expect(isTruncatedCell("not-a-number", "VND")).toBe(false);

    const matrix = composeMatrix([
      row("Tier 1", "VN", "VND", "25000500000"),
      row("Tier 1", "US", "USD", "990000"),
    ]);
    const spec = buildTemplateMatrixSpec(
      input({ matrix, regionCodes: ["VN", "US"] }),
    );
    expect(spec.truncated).toEqual([
      { tier: "Tier 1", regionCode: "VN", currency: "VND", priceMicros: "25000500000" },
    ]);
  });

  it("dữ liệu thật hiện tại: 0 ô bị cắt cụt (khớp census Q7 = 0 dòng)", () => {
    const spec = buildTemplateMatrixSpec(input());
    expect(spec.truncated).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Hình dạng sheet
// ═══════════════════════════════════════════════════════════════════════════

describe("hình dạng sheet", () => {
  it("hai hàng header, tên nước merge 2 cột, sub-header Price|Currency", () => {
    const spec = buildTemplateMatrixSpec(input());
    expect(spec.aoa[0][0]).toBe("Tier");
    expect(spec.aoa[1][0]).toBeNull();
    expect(spec.aoa[1].slice(1, 3)).toEqual(["Price", "Currency"]);
    // 1 merge DỌC cho cột Tier + 9 merge NGANG cho 9 nước.
    expect(spec.merges).toHaveLength(1 + 9);
    expect(spec.merges[0]).toEqual({ s: { r: 0, c: 0 }, e: { r: 1, c: 0 } });
    expect(spec.merges[1]).toEqual({ s: { r: 0, c: 1 }, e: { r: 0, c: 2 } });
  });

  it("cột Tier merge DỌC A1:A2 — A2 không phải ô dữ liệu rỗng", () => {
    const spec = buildTemplateMatrixSpec(input({ regionCodes: ["US"] }));
    const tierMerge = spec.merges[0];
    expect(tierMerge.s).toEqual({ r: 0, c: 0 });
    expect(tierMerge.e).toEqual({ r: HEADER_ROW_COUNT - 1, c: 0 });
    // Mọi merge còn lại là NGANG trong hàng 0.
    for (const m of spec.merges.slice(1)) {
      expect(m.s.r).toBe(0);
      expect(m.e.r).toBe(0);
      expect(m.e.c - m.s.c).toBe(1);
    }
  });

  it("freeze suy ra từ hằng, không hardcode", () => {
    const spec = buildTemplateMatrixSpec(input());
    expect(spec.freeze).toEqual({
      cols: FIXED_COLUMN_COUNT,
      rows: HEADER_ROW_COUNT,
    });
  });

  it("tên sheet theo scope", () => {
    expect(buildTemplateMatrixSpec(input()).sheetName).toBe("Default Template");
    expect(
      buildTemplateMatrixSpec(input({ scope: "per-app" })).sheetName,
    ).toBe("Per-App Template");
  });

  it("màu diff là amber-700 của màn, KHÔNG phải vàng FFFFF2CC của Apple", () => {
    expect(DIFF_FONT_COLOR).toBe("FFB45309");
    expect(DIFF_FONT_COLOR).not.toBe("FFFFF2CC");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tên file — TẦNG 1 của bản thay thế cho test bảo mật của `csvFilename`
// (tầng 2 ở app/api/.../matrix-export/route.test.ts, canh header thật)
// ═══════════════════════════════════════════════════════════════════════════

describe("templateMatrixXlsxFilename", () => {
  const now = new Date(2026, 7, 31, 10, 35); // 2026-08-31 10:35 local

  it("scope default: có tiền tố google- và dấu thời gian YYYYMMDD-HHmm", () => {
    // ⚠ Tiền tố `google-` là CHỦ ĐÍCH, khác `csvFilename` cũ. Manager đang
    // phải tự đổi tên file sau khi tải để phân biệt với file Apple cùng tên —
    // hai file CSV gửi kèm census đều mang tiền tố đó do thêm tay.
    expect(templateMatrixXlsxFilename({ scope: "default", now })).toBe(
      "google-pricing-template-default-20260831-1035.xlsx",
    );
  });

  it("scope per-app: kèm package slug", () => {
    expect(
      templateMatrixXlsxFilename({
        scope: "per-app",
        packageName: "vng.games.lightandnight",
        now,
      }),
    ).toBe("google-pricing-template-per-app-vng.games.lightandnight-20260831-1035.xlsx");
  });

  it("per-app thiếu packageName → 'app', không phải 'undefined'", () => {
    expect(templateMatrixXlsxFilename({ scope: "per-app", now })).toContain(
      "per-app-app-",
    );
  });

  it.each([
    { bad: 'evil"\r\nSet-Cookie: a=b', why: "CRLF + nháy kép" },
    { bad: "a\r\nContent-Length: 0", why: "CRLF" },
    { bad: 'x"; filename="other.xlsx', why: "nháy kép + dấu chấm phẩy" },
    { bad: "../../etc/passwd", why: "path traversal" },
    { bad: "a b\tc", why: "khoảng trắng + tab" },
  ])(
    "⚠ BẢO MẬT — sanitise $why: không còn ký tự tách được header",
    ({ bad }) => {
      const name = templateMatrixXlsxFilename({
        scope: "per-app",
        packageName: bad,
        now,
      });
      // Whitelist [a-z0-9._-] cộng với các ký tự cố định của khuôn tên.
      expect(name).toMatch(/^google-pricing-template-per-app-[A-Za-z0-9._-]+-\d{8}-\d{4}\.xlsx$/);
      expect(name).not.toMatch(/[\r\n"';\\/]/);
    },
  );
});
