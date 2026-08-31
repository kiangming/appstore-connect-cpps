/**
 * G1d · D4 — THỨ TỰ CỘT = `sort_order`, không phải alphabet, không phải
 * thứ tự dòng Postgres trả về.
 *
 * ⚠ FIXTURE CỐ Ý ĐẶT `sort_order` NGƯỢC ALPHABET để ba giả thuyết TÁCH
 *   HẲN nhau — nếu đặt xuôi thì cả ba cùng cho một kết quả và test xanh
 *   vì trùng hợp:
 *
 *     region   sort_order      alphabet(region_code)
 *     VN       1               SG
 *     US       2               US
 *     SG       3               VN
 *
 *   • đúng (sort_order)      → VN · US · SG
 *   • sai kiểu alphabet      → SG · US · VN
 *   • sai kiểu region_code   → SG · US · VN
 *   • sai kiểu "thứ tự dòng" → theo thứ tự mảng đưa vào (đã xáo bên dưới)
 *
 * Đây là ca thật, không phải giả định: file .xlsx của Manager sắp cột
 * US·VN·SG·MY·ID·PH·TH·HK·TW — KHÔNG phải alphabet (Hotfix 24).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbSpy } = vi.hoisted(() => ({ dbSpy: vi.fn() }));
vi.mock("../db", () => ({ googleIapDb: dbSpy }));

import { ACCT_A, FakeDb, tpl } from "./__fixtures__/fake-template-db";
import { composeMatrix, fetchDefaultMatrix } from "./template-matrix";
import {
  lookupTemplateEntriesForIdentifier,
  getAccountTemplateOverview,
} from "./templates";
import type { TemplateEntryRow } from "./template-matrix";

const ORDER = [
  { region: "VN", sort: 1, currency: "VND" },
  { region: "US", sort: 2, currency: "USD" },
  { region: "SG", sort: 3, currency: "SGD" },
];

describe("D4 — composeMatrix sắp cột theo sort_order (hàm thuần)", () => {
  /** Cố ý đưa vào theo thứ tự XÁO, để chứng minh kết quả không đến từ
   *  thứ tự dòng. */
  const scrambled: TemplateEntryRow[] = [
    { identifier: "Tier 1", region_code: "SG", currency: "SGD", price_micros: "3", sort_order: 3 },
    { identifier: "Tier 1", region_code: "VN", currency: "VND", price_micros: "1", sort_order: 1 },
    { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "2", sort_order: 2 },
  ];

  it("cột ra theo sort_order, KHÔNG theo alphabet và KHÔNG theo thứ tự dòng", () => {
    const m = composeMatrix(scrambled);
    expect(m.markets.map((x) => x.code)).toEqual(["VN", "US", "SG"]);
    // Nói thẳng hai giả thuyết sai, để khi đỏ thì đọc được ngay là sai kiểu gì.
    expect(m.markets.map((x) => x.code)).not.toEqual(["SG", "US", "VN"]); // alphabet
    expect(m.markets.map((x) => x.code)).not.toEqual(["SG", "VN", "US"]); // thứ tự dòng
    expect(m.columnOrderUnknown).toBe(false);
  });

  it("template THƯA: nước chỉ xuất hiện ở tier sau vẫn về đúng vị trí cột", () => {
    // VN (sort 1) chỉ có ở Tier 9 — tier ĐỨNG SAU. Nếu thứ tự cột được
    // suy ra từ thứ tự gặp, VN sẽ rơi xuống cuối.
    const sparse: TemplateEntryRow[] = [
      { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "2", sort_order: 2 },
      { identifier: "Tier 1", region_code: "SG", currency: "SGD", price_micros: "3", sort_order: 3 },
      { identifier: "Tier 9", region_code: "VN", currency: "VND", price_micros: "1", sort_order: 1 },
    ];
    expect(composeMatrix(sparse).markets.map((x) => x.code)).toEqual([
      "VN",
      "US",
      "SG",
    ]);
  });
});

describe("D3 — sort_order NULL: giữ nguyên thứ tự dòng + KÊU, không rơi về alphabet", () => {
  it("bật cờ columnOrderUnknown và KHÔNG alphabet hoá", () => {
    const withNull: TemplateEntryRow[] = [
      { identifier: "Tier 1", region_code: "VN", currency: "VND", price_micros: "1", sort_order: null },
      { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "2", sort_order: null },
      { identifier: "Tier 1", region_code: "SG", currency: "SGD", price_micros: "3", sort_order: null },
    ];
    const m = composeMatrix(withNull);
    expect(m.columnOrderUnknown).toBe(true);
    // Giữ NGUYÊN thứ tự dòng đến (hành vi trước G1d), KHÔNG phải alphabet.
    expect(m.markets.map((x) => x.code)).toEqual(["VN", "US", "SG"]);
    expect(m.markets.map((x) => x.code)).not.toEqual(["SG", "US", "VN"]);
  });

  it("⚠ ca TRỘN (có NULL lẫn không-NULL): giữ NGUYÊN thứ tự dòng, không sắp một nửa", () => {
    // Ca này là thứ phân biệt `if (!sawNullSortOrder)` với "cứ sắp bừa":
    // nếu vẫn sắp, hàng có sort_order sẽ nhảy lên trước và hàng NULL bị
    // đẩy xuống cuối ⇒ thứ tự cột bị XÁO, mà dữ liệu thì không đủ để
    // biết thứ tự đúng. Khi không biết, KHÔNG ĐƯỢC ĐOÁN — giữ nguyên
    // thứ tự dòng và bật cờ.
    const mixed: TemplateEntryRow[] = [
      { identifier: "Tier 1", region_code: "SG", currency: "SGD", price_micros: "3", sort_order: null },
      { identifier: "Tier 1", region_code: "VN", currency: "VND", price_micros: "1", sort_order: 1 },
      { identifier: "Tier 1", region_code: "US", currency: "USD", price_micros: "2", sort_order: null },
    ];
    const m = composeMatrix(mixed);
    expect(m.columnOrderUnknown).toBe(true);
    expect(m.markets.map((x) => x.code)).toEqual(["SG", "VN", "US"]);
    // Nếu bỏ điều kiện `!sawNullSortOrder`: VN (sort 1) nhảy lên đầu.
    expect(m.markets.map((x) => x.code)).not.toEqual(["VN", "SG", "US"]);
  });
});

describe("D2 — đường đọc DB cũng trả về theo hợp đồng đó", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
    dbSpy.mockReturnValue(db);
    db.templates.push(tpl("tpl-A", { scope_account_id: ACCT_A }));
    // Chèn vào "bảng" theo thứ tự XÁO: nếu truy vấn thiếu ORDER BY thì
    // fake trả về đúng thứ tự chèn này và test sẽ đỏ.
    for (const r of [ORDER[2], ORDER[0], ORDER[1]]) {
      db.entries.push({
        template_id: "tpl-A",
        identifier: "Tier 1",
        region_code: r.region,
        currency: r.currency,
        price_micros: String(r.sort),
        sort_order: r.sort,
      });
    }
  });

  it("fetchDefaultMatrix cho ra cột theo sort_order", async () => {
    const m = await fetchDefaultMatrix(ACCT_A);
    expect(m?.markets.map((x) => x.code)).toEqual(["VN", "US", "SG"]);
    expect(m?.columnOrderUnknown).toBe(false);
  });
});

/**
 * D2 — hai ĐƯỜNG ĐỌC còn lại cũng phải trả entry theo `sort_order`.
 *
 * ⚠ Vì sao cần riêng khối này: `composeMatrix` nay sắp cột TƯỜNG MINH,
 *   nên thứ tự dòng SQL trả về không còn quan sát được QUA MA TRẬN. Hai
 *   đường dưới đây thì trả entry THẲNG cho người gọi, nên hợp đồng thứ tự
 *   của chúng là quan sát được — và phải được ghim, nếu không việc "hợp
 *   nhất hai đường đọc" chỉ là lời hứa trong comment.
 */
describe("D2 — hợp đồng thứ tự của hai đường đọc trả entry thẳng", () => {
  let db2: FakeDb;
  beforeEach(() => {
    db2 = new FakeDb();
    dbSpy.mockReturnValue(db2);
    db2.templates.push(tpl("tpl-A", { scope_account_id: ACCT_A }));
    for (const r of [ORDER[2], ORDER[0], ORDER[1]]) {
      db2.entries.push({
        template_id: "tpl-A",
        identifier: "Tier 1",
        region_code: r.region,
        currency: r.currency,
        price_micros: String(r.sort),
        sort_order: r.sort,
      });
    }
  });

  it("lookupTemplateEntriesForIdentifier trả theo sort_order, không alphabet", async () => {
    const entries = await lookupTemplateEntriesForIdentifier({
      scope: "ACCOUNT",
      accountId: ACCT_A,
      appId: null,
      identifier: "Tier 1",
    });
    expect(entries.map((e) => e.regionCode)).toEqual(["VN", "US", "SG"]);
    expect(entries.map((e) => e.regionCode)).not.toEqual(["SG", "US", "VN"]);
  });

  it("getAccountTemplateOverview: sampleEntries theo (identifier, sort_order)", async () => {
    const ov = await getAccountTemplateOverview(ACCT_A);
    expect(ov.sampleEntries.map((e) => e.regionCode)).toEqual([
      "VN",
      "US",
      "SG",
    ]);
    // Đây chính là đường TRƯỚC G1d sắp theo region_code (alphabet).
    expect(ov.sampleEntries.map((e) => e.regionCode)).not.toEqual([
      "SG",
      "US",
      "VN",
    ]);
  });
});
