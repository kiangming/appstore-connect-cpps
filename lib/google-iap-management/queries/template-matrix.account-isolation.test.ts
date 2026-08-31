/**
 * G1b · B3 — ĐƯỜNG ẨN: `fetchPerAppMatrix` tự đọc Default Template BÊN
 * TRONG nó, nên grep ở tầng page KHÔNG nhìn thấy lời gọi đó.
 *
 * ⚠ HAI TÍNH CHẤT ĐỘC LẬP ĐƯỢC GHIM Ở ĐÂY, và chúng phải ĐỎ RIÊNG:
 *
 *   1. `fetchDefaultMatrix(accountId)` đọc Default CỦA ACCOUNT ĐƯỢC
 *      TRUYỀN VÀO.
 *   2. `fetchPerAppMatrix({appId, accountId})` — đường ẩn — đọc Default
 *      CỦA ACCOUNT SỞ HỮU APP để so ô diff.
 *
 * Đột biến chỉ ở (2) mà (1) vẫn xanh thì test còn ghim đúng call site;
 * nếu cả hai cùng đỏ nghĩa là test đang ghim điểm nghẽn dùng chung chứ
 * KHÔNG ghim call site — khi đó sửa test, đừng hạ đột biến.
 *
 * ⚠ FIXTURE THEO QUYẾT ĐỊNH (b) CỦA MANAGER (2026-08-31):
 *   app "app-1" THUỘC account B. Account A cũng có Default, GIÁ KHÁC.
 *   Trong đời thật A là account đang active trong cookie còn B là chủ
 *   app — hai thứ tách nhau vì `getAppById` không lọc account. Nếu
 *   `fetchPerAppMatrix` lấy account theo cookie (A) thay vì chủ sở hữu
 *   (B), ô Default trong ma trận sẽ mang giá của A. Khẳng định dưới đây
 *   đọc đúng con số đó, nên đột biến ấy làm test ĐỎ chứ không lọt.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbSpy } = vi.hoisted(() => ({ dbSpy: vi.fn() }));
vi.mock("../db", () => ({ googleIapDb: dbSpy }));

import {
  ACCT_A,
  ACCT_B,
  FakeDb,
  tpl,
} from "./__fixtures__/fake-template-db";
import { fetchDefaultMatrix, fetchPerAppMatrix } from "./template-matrix";

const APP_OWNED_BY_B = "app-1";

/** Giá Default của A và B CỐ Ý KHÁC NHAU — đó là thứ phân biệt "đọc đúng
 *  account" với "đọc nhầm account" bằng một con số đọc được. */
const PRICE_DEFAULT_A = "100000000";
const PRICE_DEFAULT_B = "200000000";
const PRICE_PER_APP = "999000000";

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  dbSpy.mockReturnValue(db);

  db.templates.push(
    tpl("tpl-default-A", { scope_account_id: ACCT_A }),
    tpl("tpl-default-B", { scope_account_id: ACCT_B }),
    tpl("tpl-perapp", {
      scope_type: "APP",
      scope_app_id: APP_OWNED_BY_B,
      scope_account_id: null,
    }),
  );
  const cell = (template_id: string, price_micros: string) => ({
    template_id,
    identifier: "Tier 1",
    region_code: "VN",
    currency: "VND",
    price_micros,
    sort_order: 1,
  });
  db.entries.push(
    cell("tpl-default-A", PRICE_DEFAULT_A),
    cell("tpl-default-B", PRICE_DEFAULT_B),
    cell("tpl-perapp", PRICE_PER_APP),
  );
});

describe("B3(1) — fetchDefaultMatrix đọc Default của đúng account truyền vào", () => {
  it("A thấy giá của A", async () => {
    const m = await fetchDefaultMatrix(ACCT_A);
    expect(m?.cells["Tier 1|VN"]?.priceMicros).toBe(PRICE_DEFAULT_A);
  });

  it("B thấy giá của B", async () => {
    const m = await fetchDefaultMatrix(ACCT_B);
    expect(m?.cells["Tier 1|VN"]?.priceMicros).toBe(PRICE_DEFAULT_B);
  });
});

describe("B3(2) — ĐƯỜNG ẨN: fetchPerAppMatrix so với Default của ACCOUNT SỞ HỮU APP", () => {
  it("app thuộc B ⇒ ô Default mang giá của B, KHÔNG phải của A", async () => {
    const m = await fetchPerAppMatrix({
      appId: APP_OWNED_BY_B,
      accountId: ACCT_B,
    });
    const cell = m?.cells["Tier 1|VN"];

    // Giá của chính template Per-App.
    expect(cell?.priceMicros).toBe(PRICE_PER_APP);
    // ⚠ Khẳng định quan trọng nhất của B3: nền so sánh là Default của B.
    expect(cell?.defaultPriceMicros).toBe(PRICE_DEFAULT_B);
    expect(cell?.defaultPriceMicros).not.toBe(PRICE_DEFAULT_A);
    expect(cell?.isDiff).toBe(true);
  });

  it("truyền nhầm account A (mô phỏng lấy theo cookie) cho ra nền so sánh KHÁC — đó là thứ hợp đồng cấm", async () => {
    // Test này KHÔNG khẳng định hành vi mong muốn; nó chứng minh hai
    // account cho ra hai kết quả khác nhau, tức phép đo ở test trên thật
    // sự phân biệt được, chứ không phải xanh vì mọi đường đều giống nhau.
    const wrong = await fetchPerAppMatrix({
      appId: APP_OWNED_BY_B,
      accountId: ACCT_A,
    });
    expect(wrong?.cells["Tier 1|VN"]?.defaultPriceMicros).toBe(
      PRICE_DEFAULT_A,
    );
  });
});
