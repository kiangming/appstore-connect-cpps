/**
 * C-C [ACCOUNT-default-template] — CÁCH LY GIỮA CÁC ACCOUNT.
 *
 * Đây là invariant CHÍNH của cả arc, phát biểu đúng một câu:
 *
 *     đọc template mặc định của account A KHÔNG BAO GIỜ được trả về
 *     template của account B.
 *
 * Trước arc này, câu đó vô nghĩa — chỉ có một template dùng chung, ai đọc
 * cũng ra nó. Sau M-1 thì sáu account có sáu template nội dung y hệt nhau,
 * nên một lỗi cách ly sẽ KHÔNG lộ ra: đọc nhầm của account khác vẫn ra giá
 * đúng. Nó chỉ lộ vào ngày đầu tiên một account upload template riêng —
 * và lúc đó thì đã đẩy giá sai lên Apple rồi.
 *
 * Nên fake DB dưới đây THẬT SỰ LỌC theo các `.eq()` mà code gọi, thay vì
 * assert lên tham số. Khác biệt quan trọng: một fake ghi-nhận-tham-số vẫn
 * xanh nếu code gọi `.eq("scope_account_id", …)` rồi bỏ qua kết quả; fake
 * này thì không — nó trả về hàng mà bộ lọc thật sẽ trả về.
 * Cùng tinh thần với bài isolation của key pool.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fromMock = vi.hoisted(() => vi.fn());
vi.mock("../db", () => ({ iapDb: () => ({ from: fromMock }) }));
vi.mock("@/lib/asc-account-repository", () => ({ findAllAccounts: vi.fn() }));

import {
  getDefaultTemplate,
  getTemplateSummary,
  templateExists,
  replaceTemplate,
  type TemplateScope,
} from "./templates";

// ── Fixture: HAI account, HAI template, nội dung KHÁC nhau ────────────────
// Giá khác nhau là cố ý: nếu cách ly hỏng, test hỏng vì GIÁ, không phải vì
// một chuỗi id — đúng cách lỗi này sẽ biểu hiện ở production.
const TEMPLATES = [
  {
    id: "tpl-acct-A",
    scope_type: "ACCOUNT",
    scope_app_id: null,
    scope_account_id: "acct-A",
    uploaded_at: "2026-08-28T00:00:00Z",
    uploaded_by: "SYSTEM_MIGRATION",
    source_filename: "default.xlsx",
  },
  {
    id: "tpl-acct-B",
    scope_type: "ACCOUNT",
    scope_app_id: null,
    scope_account_id: "acct-B",
    uploaded_at: "2026-08-28T00:00:00Z",
    uploaded_by: "SYSTEM_MIGRATION",
    source_filename: "default.xlsx",
  },
  {
    id: "tpl-app-1",
    scope_type: "APP",
    scope_app_id: "app-1",
    scope_account_id: null,
    uploaded_at: "2026-08-01T00:00:00Z",
    uploaded_by: "manager",
    source_filename: "app1.xlsx",
  },
  // ⚠ Dòng GLOBAL cũ. M-2 (apply 2026-08-29) đã XOÁ nó khỏi DB thật — nhưng
  //   nó Ở LẠI fixture này CỐ Ý: bài test không canh "DB có sạch không" (đó
  //   là việc của verify M2-V1), nó canh "code có đi tìm nó không". Bỏ dòng
  //   này khỏi fixture thì một query lọc scope_type='GLOBAL' cắm lại về sau
  //   sẽ trả rỗng và test vẫn xanh — mất đúng cái đang canh (C4).
  {
    id: "tpl-global-legacy",
    scope_type: "GLOBAL",
    scope_app_id: null,
    scope_account_id: null,
    uploaded_at: "2026-05-18T00:00:00Z",
    uploaded_by: "minhgv@vng.com.vn",
    source_filename: "legacy.xlsx",
  },
];

const ENTRIES: Record<string, Array<Record<string, unknown>>> = {
  "tpl-acct-A": [
    { tier_id: "TIER_10", territory_code: "VNM", currency_code: "VND", customer_price: 249000, proceeds: null },
  ],
  "tpl-acct-B": [
    { tier_id: "TIER_10", territory_code: "VNM", currency_code: "VND", customer_price: 999999, proceeds: null },
  ],
  "tpl-global-legacy": [
    { tier_id: "TIER_10", territory_code: "VNM", currency_code: "VND", customer_price: 111111, proceeds: null },
  ],
};

interface Recorded {
  table: string;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  inserted?: Record<string, unknown> | Array<Record<string, unknown>>;
}

let calls: Recorded[] = [];

/** Builder giả có LỌC thật theo `.eq()` / `.is()` đã ghi nhận. */
function makeBuilder(table: string) {
  const rec: Recorded = { table, eq: [], is: [] };
  calls.push(rec);

  const rowsFor = (): Array<Record<string, unknown>> => {
    let rows: Array<Record<string, unknown>> =
      table === "price_tier_templates"
        ? [...TEMPLATES]
        : Object.entries(ENTRIES).flatMap(([tid, es]) =>
            es.map((e) => ({ ...e, template_id: tid })),
          );
    for (const [col, val] of rec.eq) rows = rows.filter((r) => r[col] === val);
    for (const [col, val] of rec.is) rows = rows.filter((r) => r[col] === val);
    return rows;
  };

  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = chain;
  b.order = chain;
  b.range = chain;
  b.eq = (col: string, val: unknown) => {
    rec.eq.push([col, val]);
    return b;
  };
  b.is = (col: string, val: unknown) => {
    rec.is.push([col, val]);
    return b;
  };
  b.insert = (payload: Record<string, unknown> | Array<Record<string, unknown>>) => {
    rec.inserted = payload;
    return b;
  };
  b.upsert = chain;
  b.update = chain;
  b.delete = chain;
  b.single = () => Promise.resolve({ data: { id: "new-id" }, error: null });
  b.maybeSingle = () => {
    const rows = rowsFor();
    if (rows.length > 1) {
      // Đúng cách PostgREST hành xử — và đúng ca mà census cảnh báo.
      return Promise.resolve({ data: null, error: { message: "PGRST116: multiple rows" } });
    }
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  };
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    const rows = rowsFor();
    return Promise.resolve({ data: rows, error: null, count: rows.length }).then(
      resolve,
      reject,
    );
  };
  return b;
}

beforeEach(() => {
  calls = [];
  fromMock.mockReset();
  fromMock.mockImplementation((table: string) => makeBuilder(table));
});

describe("C-C — cách ly template theo account", () => {
  it("account A đọc ra template CỦA A, không phải của B", async () => {
    const a = await getDefaultTemplate("acct-A");
    expect(a?.template.id).toBe("tpl-acct-A");
    expect(a?.entries[0]?.customer_price).toBe(249000);
  });

  it("account B đọc ra template CỦA B — giá khác hẳn A", async () => {
    const b = await getDefaultTemplate("acct-B");
    expect(b?.template.id).toBe("tpl-acct-B");
    expect(b?.entries[0]?.customer_price).toBe(999999);
  });

  it("account chưa có template → null, KHÔNG rơi sang template của account khác", async () => {
    const c = await getDefaultTemplate("acct-C-moi-tao");
    expect(c).toBeNull();
  });

  it("templateExists trả đúng theo từng account", async () => {
    expect(await templateExists({ kind: "ACCOUNT", account_id: "acct-A" })).toBe(true);
    expect(await templateExists({ kind: "ACCOUNT", account_id: "acct-C-moi-tao" })).toBe(
      false,
    );
  });

  it("getTemplateSummary cách ly theo account", async () => {
    expect((await getTemplateSummary({ kind: "ACCOUNT", account_id: "acct-A" }))?.template.id)
      .toBe("tpl-acct-A");
    expect(await getTemplateSummary({ kind: "ACCOUNT", account_id: "acct-C-moi-tao" }))
      .toBeNull();
  });

  it("⚠ C4 — KHÔNG đường nào còn nhìn thấy dòng GLOBAL cũ", async () => {
    // Dòng legacy vẫn nằm trong fixture (đúng như DB tới khi M-2 chạy).
    // Không lời gọi nào dưới đây được phép trả về nó.
    const reads = [
      await getDefaultTemplate("acct-A"),
      await getDefaultTemplate("acct-B"),
      await getDefaultTemplate("acct-khong-ton-tai"),
    ];
    for (const r of reads) {
      expect(r?.template.id).not.toBe("tpl-global-legacy");
      expect(r?.entries[0]?.customer_price).not.toBe(111111);
    }
    // Và không bộ lọc nào đi tìm 'GLOBAL' nữa.
    const filteredOnGlobal = calls.some((c) =>
      c.eq.some(([col, val]) => col === "scope_type" && val === "GLOBAL"),
    );
    expect(
      filteredOnGlobal,
      "Còn query lọc scope_type='GLOBAL' — M-2 đã xoá dòng đó, nên query " +
        "này trả rỗng cho MỌI account, im lặng.",
    ).toBe(false);
  });

  it("APP scope không lẫn với ACCOUNT scope", async () => {
    const app = await getTemplateSummary({ kind: "APP", app_id: "app-1" });
    expect(app?.template.id).toBe("tpl-app-1");
  });
});

describe("C-C — hình dạng bản GHI (CHECK coherence của M-1)", () => {
  /** Payload header mà replaceTemplate gửi cho supabase. */
  async function insertedHeader(scope: TemplateScope) {
    await replaceTemplate(
      scope,
      { tiers: [], territory_count: 0, warnings: [], rows: [] } as never,
      "tester",
      "f.xlsx",
    ).catch(() => undefined);
    const rec = calls.find(
      (c) => c.table === "price_tier_templates" && c.inserted !== undefined,
    );
    return rec?.inserted as Record<string, unknown> | undefined;
  }

  it("scope ACCOUNT ghi scope_account_id, để scope_app_id NULL", async () => {
    const row = await insertedHeader({ kind: "ACCOUNT", account_id: "acct-A" });
    expect(row).toMatchObject({
      scope_type: "ACCOUNT",
      scope_account_id: "acct-A",
      scope_app_id: null,
    });
  });

  it("scope APP ghi scope_app_id, để scope_account_id NULL", async () => {
    const row = await insertedHeader({ kind: "APP", app_id: "app-1" });
    expect(row).toMatchObject({
      scope_type: "APP",
      scope_app_id: "app-1",
      scope_account_id: null,
    });
  });

  it("KHÔNG bao giờ ghi 'GLOBAL' nữa", async () => {
    const row = await insertedHeader({ kind: "ACCOUNT", account_id: "acct-A" });
    expect(row?.scope_type).not.toBe("GLOBAL");
  });

  it("⚠ DB từ chối (CHECK coherence) thì replaceTemplate NÉM, không nuốt", async () => {
    // Mô phỏng đúng thứ Postgres trả về khi ghi ACCOUNT thiếu
    // scope_account_id: constraint violation trên INSERT header.
    fromMock.mockImplementation((table: string) => {
      const b = makeBuilder(table) as Record<string, unknown>;
      if (table === "price_tier_templates") {
        b.single = () =>
          Promise.resolve({
            data: null,
            error: {
              message:
                'new row for relation "price_tier_templates" violates check ' +
                'constraint "price_tier_templates_scope_coherent_check"',
            },
          });
      }
      return b;
    });

    await expect(
      replaceTemplate(
        { kind: "ACCOUNT", account_id: "acct-A" },
        { tiers: [], territory_count: 0, warnings: [], rows: [] } as never,
        "tester",
        "f.xlsx",
      ),
    ).rejects.toThrow(/scope_coherent_check|template header/i);
  });
});
