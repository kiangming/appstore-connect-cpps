/**
 * C1 — writer .xlsx cho ma trận Pricing Template.
 *
 * Ba `describe` đầu mang tên F6 / F1 / F2 vì chúng canh đích danh ba chỗ mà
 * đường CSV cũ nói khác màn "View matrix". Đây không phải test hồi quy chung
 * chung: mỗi cái tương ứng một dòng code cũ có thật, và mutation tương ứng ở
 * C6 là bẻ đúng dòng đó rồi xem test này đỏ.
 *
 * ⚠ File test này import `xlsx` (cho `XLSX.SSF`, engine number-format của
 * Excel) trong khi module nó test import `exceljs`. Không vi phạm hàng rào
 * `excel-library-split.structural.test.ts`: hàng rào chỉ quét file KHÔNG phải
 * test (`sourceFiles()`, dòng 105 lọc `.test.tsx?`). SSF ở đây là dụng cụ đo,
 * không phải đường ghi — nó tồn tại để test so glyph Excel sẽ vẽ với glyph
 * màn đang vẽ, thay vì để tôi tự khẳng định hai bên bằng nhau.
 */
import { describe, it, expect } from "vitest";
import XLSX from "xlsx";
import type ExcelJS from "exceljs";

import { formatPrice } from "./matrix-price-format";
import {
  buildTemplateMatrixWorkbook,
  templateMatrixXlsxFilename,
  EMPTY_CELL,
  DIFF_FONT_COLOR,
} from "./xlsx-template-matrix-export";
import {
  composeMatrix,
  type MatrixData,
  type TemplateEntryRow,
} from "./queries/template-matrix";

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
  ["ALT_A", "Alternate Tier A"],
]);

/** Dựng workbook rồi trả về worksheet duy nhất của nó. */
function sheet(
  matrix: MatrixData,
  opts: {
    showDiff?: boolean;
    scope?: "default" | "per-app";
    visibleMarkets?: MatrixData["markets"];
  } = {},
): ExcelJS.Worksheet {
  const wb = buildTemplateMatrixWorkbook({
    matrix,
    visibleMarkets: opts.visibleMarkets ?? matrix.markets,
    showDiff: opts.showDiff ?? false,
    scope: opts.scope ?? "default",
  });
  return wb.worksheets[0];
}

/** Đọc một hàng thành mảng giá trị thô, 1-indexed như exceljs. */
function rowValues(ws: ExcelJS.Worksheet, r: number, width: number) {
  return Array.from({ length: width }, (_, i) => ws.getCell(r, i + 1).value);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("⚠ F6 — ô thưa phải GHI '·', không được biến mất khỏi file", () => {
  // csv-export.ts:64 `if (!cell) continue` làm ô (tier, territory) vắng mặt
  // biến mất hẳn; màn thì vẽ "·" kèm chú thích "no override for that
  // tier-territory pair". Trên template Per-App thật đó là 5 576 ô.
  const matrix = composeMatrix({
    entries: [row("TIER_2", "USA", "USD", 1.99), row("TIER_10", "VNM", "VND", 49000)],
    tierNames: TIER_NAMES,
  });

  it("ô (tier, territory) không có trong template ghi ra U+00B7", () => {
    const ws = sheet(matrix);
    // markets = [USA, VNM] (thứ tự xuất hiện). Tier 2 không có VNM.
    expect(ws.getCell(3, 4).value).toBe("·");
    expect(ws.getCell(3, 4).value).toBe(EMPTY_CELL);
    expect((ws.getCell(3, 4).value as string).codePointAt(0)).toBe(0x00b7);
  });

  it("ghi vào CẢ HAI nửa của cặp — Price lẫn Currency", () => {
    const ws = sheet(matrix);
    expect(ws.getCell(3, 4).value).toBe(EMPTY_CELL); // Price
    expect(ws.getCell(3, 5).value).toBe(EMPTY_CELL); // Currency
  });

  it("số hàng dữ liệu = số tier, không phải số ô đã điền", () => {
    const ws = sheet(matrix);
    // 2 hàng header + 2 tier. Nếu ô thưa bị `continue` thì lưới sẽ méo.
    expect(ws.rowCount).toBe(4);
    expect(ws.columnCount).toBe(1 + 2 * 2);
  });

  it("ô thưa KHÔNG bị nhầm thành số 0", () => {
    const ws = sheet(matrix);
    expect(typeof ws.getCell(3, 4).value).toBe("string");
    expect(ws.getCell(3, 4).value).not.toBe(0);
  });
});

describe("⚠ F1 — file bám showDiff, KHÔNG bám defaultTemplateExists", () => {
  // csv-export bám `defaultTemplateExists` (PerAppMatrixView.tsx:81): tắt
  // công tắc "Highlight differences" thì màn sạch mà file vẫn có cột diff.
  const matrix = composeMatrix({
    entries: [row("TIER_2", "VNM", "VND", 55000)],
    tierNames: TIER_NAMES,
    defaultEntries: [row("TIER_2", "VNM", "VND", 49000)],
  });

  it("dữ liệu CÓ ô khác Default — tiền đề của test này", () => {
    expect(matrix.cells["TIER_2|VNM"].isDiff).toBe(true);
  });

  it("showDiff=false ⇒ KHÔNG ô nào mang màu cam và KHÔNG ô nào có note", () => {
    const ws = sheet(matrix, { showDiff: false, scope: "per-app" });
    const price = ws.getCell(3, 2);
    expect(price.font?.color?.argb).toBeUndefined();
    expect(price.note).toBeUndefined();
    expect(ws.getCell(3, 3).font?.color?.argb).toBeUndefined();
  });

  it("showDiff=true ⇒ ô đó mang màu cam và có note", () => {
    const ws = sheet(matrix, { showDiff: true, scope: "per-app" });
    expect(ws.getCell(3, 2).font?.color?.argb).toBe(DIFF_FONT_COLOR);
    expect(ws.getCell(3, 2).note).toBeDefined();
  });

  it("giá trị ô KHÔNG đổi theo showDiff — chỉ cách vẽ đổi", () => {
    expect(sheet(matrix, { showDiff: false }).getCell(3, 2).value).toBe(55000);
    expect(sheet(matrix, { showDiff: true }).getCell(3, 2).value).toBe(55000);
  });
});

describe("⚠ F2 — ô khác MỖI currency vẫn phải nói ra là nó khác", () => {
  // `isDiff` bật cả khi `def.currency !== cell.currency` (template-matrix.ts:
  // 138-139). CSV cũ chỉ có `default_customer_price` nên ca này in ra hai con
  // số y hệt nhau: file nói "không khác", màn nói "khác".
  const matrix = composeMatrix({
    entries: [row("TIER_2", "KHM", "USD", 1.99)],
    tierNames: TIER_NAMES,
    defaultEntries: [row("TIER_2", "KHM", "KHR", 1.99)],
  });

  it("giá bằng nhau nhưng currency khác ⇒ isDiff", () => {
    expect(matrix.cells["TIER_2|KHM"].isDiff).toBe(true);
  });

  it("ô được tô cam dù hai con số giống hệt nhau", () => {
    const ws = sheet(matrix, { showDiff: true, scope: "per-app" });
    expect(ws.getCell(3, 2).font?.color?.argb).toBe(DIFF_FONT_COLOR);
  });

  it("note ghi currency của CẢ HAI bên, nếu không thì nó vô nghĩa ở ca này", () => {
    const ws = sheet(matrix, { showDiff: true, scope: "per-app" });
    const note = String(ws.getCell(3, 2).note);
    expect(note).toContain("Default: 1.99 KHR");
    expect(note).toContain("Per-App: 1.99 USD");
  });

  it("⚠ isDiff nhưng KHÔNG có giá trị Default ⇒ vẫn tô cam, KHÔNG có note", () => {
    // Bản thay cho `formatPriceForCsv > returns empty string for undefined`
    // của csv-export.test.ts. Cột CSV cũ để rỗng khi thiếu giá trị Default;
    // ở đây "rỗng" tương ứng với KHÔNG SINH note.
    //
    // ⚠ `composeMatrix` không bao giờ sinh ra tổ hợp này (isDiff chỉ được đặt
    // khi tìm thấy entry Default), nên phải dựng tay — nhưng nhánh guard thì
    // có thật trong `diffNote`, và bỏ nó đi sẽ ghi ra "Default: undefined
    // undefined" chứ không nổ. Màn cũng guard đúng như vậy: tô màu theo
    // `isDiff`, còn tooltip thì bỏ khi thiếu giá trị (MatrixTable.tsx:32-35).
    const m: MatrixData = {
      tiers: [{ tier_id: "TIER_2", tier_name: "Tier 2", is_alternate: false }],
      markets: [{ code: "VNM", name: "Vietnam", currency: "VND", continent: "Asia" }],
      cells: { "TIER_2|VNM": { customerPrice: 49000, currency: "VND", isDiff: true } },
      currenciesUsed: ["VND"],
      continentCounts: { Asia: 1, Europe: 0, Americas: 0, Africa: 0, Oceania: 0 },
    };
    const ws = sheet(m, { showDiff: true, scope: "per-app" });
    expect(ws.getCell(3, 2).font?.color?.argb).toBe(DIFF_FONT_COLOR);
    expect(ws.getCell(3, 2).note).toBeUndefined();
  });

  it("note mang đúng hai giá trị của tooltip màn khi giá cũng khác", () => {
    const m = composeMatrix({
      entries: [row("TIER_2", "VNM", "VND", 385000)],
      tierNames: TIER_NAMES,
      defaultEntries: [row("TIER_2", "VNM", "VND", 349000)],
    });
    const ws = sheet(m, { showDiff: true, scope: "per-app" });
    expect(String(ws.getCell(3, 2).note)).toBe(
      "Default: 349000 VND\nPer-App: 385000 VND",
    );
  });
});

describe("thứ tự lấy NGUYÊN từ matrix — không sort lại (M5)", () => {
  it("thứ tự tier là thứ tự composer đã sắp, không phải alphabet", () => {
    // Alphabet thuần sẽ cho "Tier 10" trước "Tier 2"; composer sắp
    // numeric-aware nên "Tier 2" phải đứng trước.
    const matrix = composeMatrix({
      entries: [
        row("TIER_10", "USA", "USD", 9.99),
        row("TIER_2", "USA", "USD", 1.99),
        row("ALT_A", "USA", "USD", 4.99),
      ],
      tierNames: TIER_NAMES,
    });
    const ws = sheet(matrix);
    expect([ws.getCell(3, 1).value, ws.getCell(4, 1).value, ws.getCell(5, 1).value]).toEqual([
      "Tier 2",
      "Tier 10",
      "Alternate Tier A",
    ]);
    expect(matrix.tiers.map((t) => t.tier_name)).toEqual([
      ws.getCell(3, 1).value,
      ws.getCell(4, 1).value,
      ws.getCell(5, 1).value,
    ]);
  });

  it("thứ tự nước là thứ tự cột file Excel Manager upload, không phải alphabet", () => {
    // Thứ tự vào: VNM, USA, THA. Alphabet theo tên sẽ là Thailand, United
    // States, Vietnam — khác hẳn, nên test phân biệt được hai đằng.
    const matrix = composeMatrix({
      entries: [
        row("TIER_2", "VNM", "VND", 49000),
        row("TIER_2", "USA", "USD", 1.99),
        row("TIER_2", "THA", "THB", 69),
      ],
      tierNames: TIER_NAMES,
    });
    const ws = sheet(matrix);
    expect([ws.getCell(1, 2).value, ws.getCell(1, 4).value, ws.getCell(1, 6).value]).toEqual([
      "Vietnam",
      "United States",
      "Thailand",
    ]);
  });

  it("header nước lấy market.name nguyên bản — Kosovo vẫn hiện 'XKS' (Q4)", () => {
    const matrix = composeMatrix({
      entries: [row("TIER_2", "XKS", "EUR", 1.99)],
      tierNames: TIER_NAMES,
    });
    // territoryName không phân giải được XKS nên rơi về chính mã; màn đang
    // hiện đúng vậy, và file phải hiện đúng vậy.
    expect(matrix.markets[0].name).toBe("XKS");
    expect(sheet(matrix).getCell(1, 2).value).toBe("XKS");
  });
});

describe("ô giá là SỐ Excel, không phải chuỗi (M4)", () => {
  const matrix = composeMatrix({
    entries: [row("TIER_2", "VNM", "VND", 49000), row("TIER_2", "USA", "USD", 1.99)],
    tierNames: TIER_NAMES,
  });

  it("số nguyên và số thập phân đều ghi ra kiểu number", () => {
    const ws = sheet(matrix);
    expect(typeof ws.getCell(3, 2).value).toBe("number");
    expect(ws.getCell(3, 2).value).toBe(49000);
    expect(typeof ws.getCell(3, 4).value).toBe("number");
    expect(ws.getCell(3, 4).value).toBe(1.99);
  });

  it("currency vẫn là chuỗi, cạnh ô số", () => {
    const ws = sheet(matrix);
    expect(ws.getCell(3, 3).value).toBe("VND");
    expect(ws.getCell(3, 5).value).toBe("USD");
  });

  it("NUMERIC do Supabase trả về dạng CHUỖI vẫn ghi ra number", () => {
    // formatPriceForCsv cũ có test riêng cho ca này; cơ chế không biến mất
    // chỉ vì định dạng file đổi.
    const m = composeMatrix({
      entries: [
        { ...row("TIER_2", "VNM", "VND", 0), customer_price: "25000.0000" as unknown as number },
      ],
      tierNames: TIER_NAMES,
    });
    const ws = sheet(m);
    expect(ws.getCell(3, 2).value).toBe(25000);
    expect(typeof ws.getCell(3, 2).value).toBe("number");
  });

  it("KHÔNG ô nào chứa ★ — ★ ở lại trên màn (Q3)", () => {
    const m = composeMatrix({
      entries: [row("TIER_2", "VNM", "VND", 55000)],
      tierNames: TIER_NAMES,
      defaultEntries: [row("TIER_2", "VNM", "VND", 49000)],
    });
    const ws = sheet(m, { showDiff: true, scope: "per-app" });
    for (let r = 1; r <= ws.rowCount; r += 1) {
      for (const v of rowValues(ws, r, ws.columnCount)) {
        expect(String(v ?? "")).not.toContain("★");
      }
    }
  });
});

describe("KHÔNG ô nào mang custom numFmt (M7 — lỗi dấu ',' Manager báo)", () => {
  const matrix = composeMatrix({
    entries: [
      row("TIER_2", "VNM", "VND", 49000),
      row("TIER_2", "USA", "USD", 1.99),
      row("TIER_10", "USA", "USD", 460),
    ],
    tierNames: TIER_NAMES,
  });

  it("mọi ô giá để numFmt trống ⇒ numFmtId=0 ⇒ Excel General", () => {
    const ws = sheet(matrix);
    for (let r = 3; r <= ws.rowCount; r += 1) {
      for (let c = 2; c <= ws.columnCount; c += 2) {
        expect(ws.getCell(r, c).numFmt).toBeUndefined();
      }
    }
  });

  it('không ô nào mang "0.####" — format vẽ ra "49000." rồi thành "49000,"', () => {
    const ws = sheet(matrix);
    for (let r = 1; r <= ws.rowCount; r += 1) {
      for (let c = 1; c <= ws.columnCount; c += 1) {
        expect(ws.getCell(r, c).numFmt).not.toBe("0.####");
      }
    }
  });
});

describe("parity glyph — Excel vẽ đúng thứ màn đang vẽ", () => {
  // Đo bằng SSF (engine number-format của Excel do SheetJS ship), không phải
  // bằng khẳng định. `formatPrice` là hàm THẬT màn dùng — MatrixTable import
  // đúng module này.
  const VALUES = [49000, 1.99, 0.99, 460, 18.98, 0, 25000, 9.9, 1.999, 379000, 11999000];

  it('SSF.format("General", v) === formatPrice(v) trên mọi giá trị đại diện', () => {
    for (const v of VALUES) {
      expect(XLSX.SSF.format("General", v)).toBe(formatPrice(v));
    }
  });

  it('"0.####" thì KHÔNG — nó thêm một dấu phân cách thập phân thừa', () => {
    // Test này pin NGUYÊN NHÂN, để lần sau ai đó định "làm đẹp" bằng cách
    // thêm numFmt lại thì có chỗ đọc được vì sao đừng.
    expect(XLSX.SSF.format("0.####", 49000)).toBe("49000.");
    expect(formatPrice(49000)).toBe("49000");
  });

  it("format của ô trong workbook thật render ra đúng glyph màn", () => {
    const matrix = composeMatrix({
      entries: VALUES.map((v, i) => row("TIER_2", `T${i}`, "USD", v)),
      tierNames: TIER_NAMES,
    });
    const ws = sheet(matrix);
    for (let g = 0; g < VALUES.length; g += 1) {
      const cell = ws.getCell(3, 2 + g * 2);
      const rendered = XLSX.SSF.format(cell.numFmt ?? "General", cell.value as number);
      expect(rendered).toBe(formatPrice(VALUES[g]));
    }
  });
});

describe("hình dạng sheet: 2 hàng header, merge, freeze", () => {
  const matrix = composeMatrix({
    entries: [
      row("TIER_2", "VNM", "VND", 49000),
      row("TIER_2", "USA", "USD", 1.99),
    ],
    tierNames: TIER_NAMES,
  });

  it("hàng 1 = Tier + tên nước, hàng 2 = Price/Currency", () => {
    const ws = sheet(matrix);
    expect(ws.getCell(1, 1).value).toBe("Tier");
    expect(rowValues(ws, 2, 5)).toEqual(["Tier", "Price", "Currency", "Price", "Currency"]);
    //                                     ↑ ô A2 nằm trong merge dọc A1:A2 nên
    //                                       exceljs soi giá trị của ô chủ.
  });

  it("'Tier' merge dọc A1:A2; mỗi nước merge ngang 2 cột", () => {
    const ws = sheet(matrix);
    expect(ws.getCell("A2").isMerged).toBe(true);
    expect(ws.getCell("A2").master.address).toBe("A1");
    expect(ws.getCell(1, 3).master.address).toBe("B1"); // Currency của nước 1
    expect(ws.getCell(1, 5).master.address).toBe("D1"); // Currency của nước 2
  });

  it("merge ngang KHÔNG tràn sang nước kế bên", () => {
    const ws = sheet(matrix);
    expect(ws.getCell(1, 4).master.address).toBe("D1");
    expect(ws.getCell(1, 4).master.address).not.toBe("B1");
  });

  it("freeze 1 cột + 2 hàng — cột Tier đứng yên khi cuộn ngang", () => {
    const ws = sheet(matrix);
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 1, ySplit: 2 });
  });

  it("bề rộng cột: một giá trị mỗi cột, Tier rộng nhất", () => {
    const ws = sheet(matrix);
    expect(ws.getColumn(1).width).toBe(20);
    expect(ws.getColumn(2).width).toBe(12);
    expect(ws.getColumn(3).width).toBe(9);
  });

  it("tên sheet theo scope", () => {
    expect(sheet(matrix, { scope: "default" }).name).toBe("Default Template");
    expect(sheet(matrix, { scope: "per-app" }).name).toBe("Per-App Template");
  });

  it("KHÔNG ô dữ liệu nào mang fill — nền vàng có nghĩa khác ở export item", () => {
    const ws = sheet(matrix);
    for (let r = 3; r <= ws.rowCount; r += 1) {
      for (let c = 1; c <= ws.columnCount; c += 1) {
        expect(ws.getCell(r, c).fill).toBeUndefined();
      }
    }
  });
});

describe("visibleMarkets lọc cột, và chỉ lọc", () => {
  const matrix = composeMatrix({
    entries: [
      row("TIER_2", "VNM", "VND", 49000),
      row("TIER_2", "USA", "USD", 1.99),
      row("TIER_2", "THA", "THB", 69),
    ],
    tierNames: TIER_NAMES,
  });

  it("chỉ nước trong visibleMarkets ra cột", () => {
    const onlyAsia = matrix.markets.filter((m) => m.continent === "Asia");
    const ws = sheet(matrix, { visibleMarkets: onlyAsia });
    expect(ws.columnCount).toBe(1 + onlyAsia.length * 2);
    expect(ws.getCell(1, 2).value).toBe("Vietnam");
    expect(ws.getCell(1, 4).value).toBe("Thailand");
  });

  it("lọc hết ⇒ sheet chỉ còn cột Tier, không throw", () => {
    const ws = sheet(matrix, { visibleMarkets: [] });
    expect(ws.columnCount).toBe(1);
    expect(ws.getCell(1, 1).value).toBe("Tier");
    expect(ws.rowCount).toBe(3); // 2 header + 1 tier
  });
});

describe("templateMatrixXlsxFilename", () => {
  it("scope default", () => {
    expect(
      templateMatrixXlsxFilename({ scope: "default", now: new Date(2026, 4, 23, 14, 7) }),
    ).toBe("apple-pricing-template-default-20260523-1407.xlsx");
  });

  it("scope per-app kèm slug bundle-id", () => {
    expect(
      templateMatrixXlsxFilename({
        scope: "per-app",
        bundleId: "com.vng.passsdk",
        now: new Date(2026, 4, 23, 9, 30),
      }),
    ).toBe("apple-pricing-template-per-app-com.vng.passsdk-20260523-0930.xlsx");
  });

  it("chặn ký tự không an toàn trong slug", () => {
    expect(
      templateMatrixXlsxFilename({
        scope: "per-app",
        bundleId: 'com/bad name"',
        now: new Date(2026, 4, 23, 0, 0),
      }),
    ).toMatch(/^apple-pricing-template-per-app-com_bad_name_-\d{8}-\d{4}\.xlsx$/);
  });
});
