import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

import { parsePricingTemplate } from "./pricing-template-parser";

function makeBuffer(
  rows: Array<Array<string | number>>,
  sheetName = "price_tiers",
): { buf: Buffer; size: number } {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
  return { buf, size: buf.byteLength };
}

describe("parsePricingTemplate", () => {
  it("parses minimal tier-keyed template", () => {
    const { buf, size } = makeBuffer([
      ["", "US - USD - United States", "VN - VND - Vietnam"],
      ["Tier 1", 0.99, 25000],
      ["Tier 2", 1.99, 49000],
    ]);
    const result = parsePricingTemplate(buf, size);
    expect(result.errors).toEqual([]);
    expect(result.tierCount).toBe(2);
    expect(result.territoryCount).toBe(2);
    // G1d — `sortOrder` = thứ tự CỘT trong file (US=1, VN=2), lặp lại y
    // nguyên ở mọi hàng: nó thuộc về cột, không thuộc về ô.
    expect(result.entries).toEqual([
      { identifier: "Tier 1", regionCode: "US", currency: "USD", priceMicros: "990000", sortOrder: 1 },
      { identifier: "Tier 1", regionCode: "VN", currency: "VND", priceMicros: "25000000000", sortOrder: 2 },
      { identifier: "Tier 2", regionCode: "US", currency: "USD", priceMicros: "1990000", sortOrder: 1 },
      { identifier: "Tier 2", regionCode: "VN", currency: "VND", priceMicros: "49000000000", sortOrder: 2 },
    ]);
  });

  it("skips empty cells (sparse template)", () => {
    const { buf, size } = makeBuffer([
      ["", "US - USD - United States", "VN - VND - Vietnam"],
      ["Tier 1", 0.99, ""],
      ["Tier 2", "", 49000],
    ]);
    const result = parsePricingTemplate(buf, size);
    // ⚠ Ca THƯA là ca đáng giá nhất: VN vẫn mang sortOrder 2 dù nó là
    //   entry DUY NHẤT của Tier 2. `sortOrder` bám vào CỘT, nên template
    //   thưa vẫn dựng lại đúng thứ tự cột — đây chính là điều mà cách cũ
    //   (suy ra thứ tự cột từ thứ tự dòng đến) làm sai.
    expect(result.entries).toEqual([
      { identifier: "Tier 1", regionCode: "US", currency: "USD", priceMicros: "990000", sortOrder: 1 },
      { identifier: "Tier 2", regionCode: "VN", currency: "VND", priceMicros: "49000000000", sortOrder: 2 },
    ]);
  });

  it("warns on unrecognised territory headers but keeps valid ones", () => {
    const { buf, size } = makeBuffer([
      ["", "Garbage column", "US - USD - United States"],
      ["Tier 1", 1, 0.99],
    ]);
    const result = parsePricingTemplate(buf, size);
    expect(result.territoryCount).toBe(1);
    expect(result.warnings.join("\n")).toMatch(/Garbage/);
    // ⚠ Cột "Garbage column" đứng TRƯỚC cột US trong file nhưng bị loại,
    //   và US vẫn là sortOrder 1 — đánh số chạy trên CỘT HỢP LỆ, liên
    //   tiếp 1..N, không chừa lỗ. Cùng thang với backfill của M-1
    //   (ROW_NUMBER() cũng liên tiếp), nên template cũ và mới so được.
    expect(result.entries).toEqual([
      { identifier: "Tier 1", regionCode: "US", currency: "USD", priceMicros: "990000", sortOrder: 1 },
    ]);
  });

  it("errors when no valid territory columns exist", () => {
    const { buf, size } = makeBuffer([
      ["", "bad", "alsobad"],
      ["Tier 1", 1, 2],
    ]);
    const result = parsePricingTemplate(buf, size);
    expect(result.errors.join("\n")).toMatch(/No valid territory/);
  });

  it("warns on duplicate tier identifiers; first wins", () => {
    const { buf, size } = makeBuffer([
      ["", "US - USD - United States"],
      ["Tier 1", 0.99],
      ["Tier 1", 1.99],
    ]);
    const result = parsePricingTemplate(buf, size);
    expect(result.tierCount).toBe(1);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].priceMicros).toBe("990000");
    expect(result.warnings.join("\n")).toMatch(/Duplicate/);
  });

  it("falls back gracefully when sheet name differs from expected", () => {
    const { buf, size } = makeBuffer(
      [
        ["", "US - USD - United States"],
        ["Tier 1", 0.99],
      ],
      "Pricing",
    );
    const result = parsePricingTemplate(buf, size);
    expect(result.warnings.join("\n")).toMatch(/Pricing/);
    expect(result.entries.length).toBe(1);
  });

  it("rejects oversized buffer up front", () => {
    const fake = Buffer.alloc(0);
    const result = parsePricingTemplate(fake, 10 * 1024 * 1024);
    expect(result.errors.join("\n")).toMatch(/too large/);
  });
});
