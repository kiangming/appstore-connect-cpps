/**
 * G1b · B2 — CÁCH LY THEO ACCOUNT cho các hàm đọc template.
 *
 * ⚠ VÌ SAO FILE NÀY TỒN TẠI RIÊNG, VÀ VÌ SAO NÓ KHẲNG ĐỊNH BẰNG GIÁ TRỊ.
 *
 * `templateExists` và `getTemplateAvailability` là hai hàm count/head.
 * Chúng KHÔNG NÉM LỖI khi đọc thiếu bộ lọc account — chúng TRẢ VỀ SỐ, và
 * số đó sai một cách im lặng. Một test kiểu "có ném không" sẽ XANH y
 * nguyên sau khi ai đó xoá mất mệnh đề `.eq("scope_account_id", …)`.
 *
 * Hệ quả thật, không phải giả định: `getTemplateAvailability` nuôi
 * `pickByPriority` (PricingSourceSelector.tsx:61-65) — chính chỗ quyết
 * định template nào được dùng để ĐẨY GIÁ LÊN GOOGLE. `templateExists` là
 * pre-flight của bulk import. Đọc thừa template của account khác nghĩa là
 * radio "Default Template" sáng lên cho một account chưa hề cấu hình gì,
 * rồi giá của account khác đi lên store.
 *
 * ⚠ FIXTURE ĐƯỢC CHỌN ĐỂ ĐỘT BIẾN LÀM ĐỔI GIÁ TRỊ, không chỉ đổi mệnh đề:
 *   account A KHÔNG có template, account B CÓ.
 *   Bỏ bộ lọc account ⇒ A "nhìn thấy" template của B ⇒ false thành true.
 *   Đó đúng là ca hỏng ngoài đời, và nó bắt được bằng giá trị trả về.
 *   Bộ thứ hai (A và B đều có, tier khác nhau) khẳng định A đếm ra 1 chứ
 *   không phải 2.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbSpy } = vi.hoisted(() => ({ dbSpy: vi.fn() }));
vi.mock("../db", () => ({ googleIapDb: dbSpy }));

import {
  templateExists,
  getTemplateAvailability,
  listTemplateTiers,
  findTemplateId,
  replaceTemplate,
  listAppTemplates,
} from "./templates";

import {
  ACCT_A,
  ACCT_B,
  FakeDb,
  tpl,
} from "./__fixtures__/fake-template-db";

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  dbSpy.mockReturnValue(db);
});

describe("B2 — account A KHÔNG được nhìn thấy template của account B", () => {
  beforeEach(() => {
    // A chưa cấu hình gì; B đã có Default.
    db.templates.push(tpl("tpl-B", { scope_account_id: ACCT_B }));
    db.entries.push({
      template_id: "tpl-B",
      identifier: "Tier 1",
      region_code: "VN",
      currency: "VND",
      price_micros: "27000000000",
      sort_order: 1,
    });
  });

  it("templateExists(A) = false, KHÔNG phải true nhờ template của B", async () => {
    await expect(
      templateExists({ scope: "ACCOUNT", accountId: ACCT_A, appId: null }),
    ).resolves.toBe(false);
    await expect(
      templateExists({ scope: "ACCOUNT", accountId: ACCT_B, appId: null }),
    ).resolves.toBe(true);
  });

  it("getTemplateAvailability(A).defaultExists = false — radio Default KHÔNG được sáng", async () => {
    const a = await getTemplateAvailability({
      accountId: ACCT_A,
      appId: null,
    });
    expect(a.defaultExists).toBe(false);

    const b = await getTemplateAvailability({
      accountId: ACCT_B,
      appId: null,
    });
    expect(b.defaultExists).toBe(true);
  });

  it("findTemplateId(A) = null — không mượn id template của B", async () => {
    await expect(
      findTemplateId({ scope: "ACCOUNT", accountId: ACCT_A, appId: null }),
    ).resolves.toBeNull();
    await expect(
      findTemplateId({ scope: "ACCOUNT", accountId: ACCT_B, appId: null }),
    ).resolves.toBe("tpl-B");
  });
});

describe("B2 — hai account đều có template: A phải đếm ra 1, không phải 2", () => {
  beforeEach(() => {
    db.templates.push(
      tpl("tpl-A", { scope_account_id: ACCT_A }),
      tpl("tpl-B", { scope_account_id: ACCT_B }),
    );
    db.entries.push(
      {
        template_id: "tpl-A",
        identifier: "Tier A1",
        region_code: "VN",
        currency: "VND",
        price_micros: "1",
        sort_order: 1,
      },
      {
        template_id: "tpl-B",
        identifier: "Tier B1",
        region_code: "VN",
        currency: "VND",
        price_micros: "2",
        sort_order: 1,
      },
    );
  });

  it("listTemplateTiers(A) trả ĐÚNG 1 tier của A", async () => {
    const tiers = await listTemplateTiers({
      scope: "ACCOUNT",
      accountId: ACCT_A,
      appId: null,
    });
    expect(tiers).toEqual(["Tier A1"]);
    expect(tiers).toHaveLength(1);
  });

  it("findTemplateId phân biệt đúng hai account", async () => {
    await expect(
      findTemplateId({ scope: "ACCOUNT", accountId: ACCT_A, appId: null }),
    ).resolves.toBe("tpl-A");
    await expect(
      findTemplateId({ scope: "ACCOUNT", accountId: ACCT_B, appId: null }),
    ).resolves.toBe("tpl-B");
  });
});

describe("B3 — replaceTemplate chỉ được xoá Default CỦA CHÍNH account đó", () => {
  it("Replace cho A không đụng tới template của B", async () => {
    db.templates.push(
      tpl("tpl-A", { scope_account_id: ACCT_A }),
      tpl("tpl-B", { scope_account_id: ACCT_B }),
    );
    db.entries.push({
      template_id: "tpl-B",
      identifier: "Tier B1",
      region_code: "VN",
      currency: "VND",
      price_micros: "2",
      sort_order: 1,
    });

    await replaceTemplate({
      scope: "ACCOUNT",
      accountId: ACCT_A,
      appId: null,
      uploadedBy: "minhgv@vng.com.vn",
      sourceFilename: "new.xlsx",
      entries: [
        {
          identifier: "Tier A2",
          regionCode: "VN",
          currency: "VND",
          priceMicros: "9",
        },
      ],
    });

    // Bản của B còn nguyên, cả header lẫn entry.
    expect(db.templates.some((t) => t.id === "tpl-B")).toBe(true);
    expect(db.entries.filter((e) => e.template_id === "tpl-B")).toHaveLength(1);
    // Bản cũ của A đã bị thay, và A có đúng 1 header.
    expect(db.templates.some((t) => t.id === "tpl-A")).toBe(false);
    expect(
      db.templates.filter((t) => t.scope_account_id === ACCT_A),
    ).toHaveLength(1);
  });
});

describe("C4 — listAppTemplates KHÔNG được liệt kê template APP của account khác", () => {
  it("chỉ trả template của app thuộc account đang hỏi", async () => {
    db.templates.push(
      tpl("tpl-app-A", {
        scope_type: "APP",
        scope_app_id: "app-A",
        scope_account_id: null,
      }),
      tpl("tpl-app-B", {
        scope_type: "APP",
        scope_app_id: "app-B",
        scope_account_id: null,
      }),
    );
    db.apps.push(
      {
        id: "app-A",
        package_name: "com.vng.a",
        display_name: "A",
        google_console_account_id: ACCT_A,
      },
      {
        id: "app-B",
        package_name: "com.vng.b",
        display_name: "B",
        google_console_account_id: ACCT_B,
      },
    );
    db.entries.push({
      template_id: "tpl-app-A",
      identifier: "Tier 1",
      region_code: "VN",
      currency: "VND",
      price_micros: "1",
      sort_order: 1,
    });

    const listed = await listAppTemplates(ACCT_A);
    expect(listed.map((x) => x.package_name)).toEqual(["com.vng.a"]);
    expect(listed).toHaveLength(1);

    const listedB = await listAppTemplates(ACCT_B);
    expect(listedB.map((x) => x.package_name)).toEqual(["com.vng.b"]);
  });
});
