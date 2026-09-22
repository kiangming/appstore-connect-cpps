# Thứ tự ưu tiên khi một giá khớp NHIỀU tier — census + thiết kế

**Arc:** `[TIER-TIEBREAK-priority]` · **Ngày:** 2026-09-22 · **Trạng thái:** ✅ ĐÃ SHIP chunk PA-3, chờ gate push

> ### Kết quả 4 SQL (Manager đã chạy) + quyết định
>
> - **SQL 1:** 5 nhóm trùng giá (`$0.99 · $1.99 · $2.99 · $3.99 · $4.99`),
>   **TẤT CẢ đều TIER-vs-ALT**, **không** ca TIER-vs-TIER nào. Lặp ở cả 6
>   account template lẫn 4 app template. ⚠ `$0.99` có **BỐN** tier
>   (`TIER_1, ALT_1, ALT_A, ALT_B`).
> - **SQL 3 — câu định đoạt:** ALT và TIER **KHÔNG tương đương**. Trùng USD
>   nhưng lệch giá ở nước khác: `$0.99 → 75/175 nước · $1.99 → 13 · $2.99 → 8
>   · $3.99 → 11 · $4.99 → 9`. ⇒ Câu "KHÔNG ĐỌC ĐƯỢC TỪ REPO" ở cuối file này
>   **nay đã có câu trả lời** — ghi ở **KB §26.1**.
> - **SQL 4:** 26 item đang dùng ALT (`ALT_2:8 · ALT_1:6 · ALT_3:5 · ALT_5:4
>   · ALT_4:2 · ALT_B:1 · ALT_A:0`).
>
> **Chốt:** PA-3 · Q1=(a) chỉ bulk import · Q2=(a) để nguyên 26 item,
> không backfill · Q3=(b) bộ lọc 3.4-B · Q4=(a) có, sửa luôn
> `TIER_10 > TIER_2`.
>
> ⚠ **CẢI CHÍNH.** Bản census đầu viết *"26 item sẽ âm thầm đổi giá khi import
> lại"* — **sai về mức độ**. Chúng không tự đổi gì (không có đường re-resolve);
> và khi có import lại thì dropdown nằm ở **Step 3 Preview, TRƯỚC Execute**, nên
> không có gì âm thầm. Yêu cầu "cảnh báo chống rủi ro tự động" đã **bỏ** — không
> có rủi ro tự động. Xem KB §26.3.

Yêu cầu Manager: *"khi price của item trùng với nhiều tier, tool đang ưu tiên Alternate Tier. Muốn ưu tiên Tier thường trước; cần Alt thì tự chọn lại."*

---

## P1 — Câu chặn cửa: hành vi hiện tại là gì

### P1.1 Chỗ resolve price → tier

Grep `resolveTierByUsdPrice` + `customer_price ===` trên toàn repo (trừ `node_modules`, `.next`, Google). **Đúng HAI** chỗ so khớp giá → tier:

| # | Vị trí | Vai trò |
|---|---|---|
| **A** | `lib/iap-management/queries/price-tiers.ts:171-183` `resolveTierByUsdPrice` | **Bộ giải duy nhất.** Quyết định tier nào được chọn. |
| **B** | `app/(dashboard)/iap-management/apps/[appId]/bulk-import/BulkImportWizard.tsx:1495` | Lọc danh sách **ứng viên** cho dropdown ở Step 3. Không quyết định, chỉ liệt kê. |

Không có chỗ thứ ba. `IapForm` (tạo/sửa IAP đơn lẻ) **không suy tier từ giá** — xem P2.1.

### P1.2 Cơ chế ưu tiên — CHÍNH XÁC

Nguyên văn `price-tiers.ts:171-183`:

```ts
export function resolveTierByUsdPrice(
  priceUsd: number,
  tiers: readonly UsdTierEntry[],
): string | null {
  if (priceUsd === 0) return "FREE";
  const matches = tiers.filter((t) => t.customer_price === priceUsd);   // :176
  if (matches.length === 0) return null;                                // :177
  // Manager spec: ORDER BY tier_id ASC LIMIT 1                         // :178
  const sorted = [...matches].sort((a, b) =>                            // :179
    a.tier_id.localeCompare(b.tier_id),                                 // :180
  );
  return sorted[0].tier_id;                                             // :182
}
```

| Câu hỏi | Trả lời |
|---|---|
| Có sort không? | **CÓ** — `.sort()` tường minh tại `:179-181`, theo `tier_id`, chiều ASC. |
| Có `.find()` lấy phần tử đầu mảng không? | **KHÔNG.** `.filter()` rồi sort rồi `[0]`. Thứ tự mảng đầu vào **không** ảnh hưởng kết quả. |
| Có ORDER BY ở DB không? | Có nhưng **không liên quan**: `price-tiers.ts:155` và `templates.ts:320` đều `.order("customer_price")` — sắp theo GIÁ, không theo tier_id. Trong một nhóm cùng giá, thứ tự Postgres trả về là không xác định — nhưng sort ở `:179` đã ghi đè nó. |
| Có biểu thức nào nhắc "alternate" không? | **KHÔNG, không một chữ nào** trong hàm này. |

### ⭐ P1.2 — KẾT LUẬN: QUYẾT ĐỊNH hay NGẪU NHIÊN?

**Cả hai — và đó mới là câu trả lời đúng.** Cần tách làm hai tầng:

- **Tầng 1 — determinism: LÀ QUYẾT ĐỊNH.** Có sort tường minh. Cùng input luôn ra cùng output. **Không** phải hệ quả của thứ tự Postgres.
- **Tầng 2 — chọn ALT: LÀ TÁC DỤNG PHỤ.** Quyết định được ghi là *"ORDER BY tier_id ASC"* — một quy tắc về **tính xác định**, không phải về **ưu tiên loại tier**. Việc Alt thắng là hệ quả tình cờ của quy ước đặt tên id: chuỗi `"ALT_"` đứng trước `"TIER_"` theo thứ tự chữ cái.

Chạy thật, không suy diễn:

```
ALT_A    vs TIER_1   => -1  winner: ALT_A
ALT_5    vs TIER_87  => -1  winner: ALT_5
TIER_2   vs TIER_10  =>  1  winner: TIER_10     ← lexicographic, KHÔNG phải số
sort(["TIER_87","ALT_5","TIER_9","ALT_A"]) => ALT_5, ALT_A, TIER_87, TIER_9
```

⇒ **Manager mô tả ĐÚNG 100%.** Alt luôn thắng Tier khi trùng giá.

### ⭐⭐ Ba bằng chứng cho thấy ý định ban đầu KHÔNG phải là ưu tiên Alt

**1. Test hiện có tự mâu thuẫn** — `lib/iap-management/queries/price-tiers.test.ts:26-31`:

```ts
it("returns TIER_5 for price 4.99 (tier_id ASC tie-break wins over ALT_5)", () => {
  // Manager SQL spec: ORDER BY tier_id ASC LIMIT 1.
  // "ALT_5".localeCompare("TIER_5") → negative; "ALT_5" sorts first.
  // So per literal spec, the answer is ALT_5. Verify the actual rule:
  expect(resolveTierByUsdPrice(4.99, tiers)).toBe("ALT_5");
});
```

**Tiêu đề nói `TIER_5`. Assertion nói `ALT_5`.** Comment ghi lại nguyên quá trình vỡ lẽ. Người viết test **mong đợi TIER_5**, phát hiện ra ALT_5, rồi sửa assertion mà **không sửa tiêu đề**. Đây là hồ sơ của một tác dụng phụ bị phát hiện rồi chấp nhận, không phải một lựa chọn được cân nhắc.

**2. Repo đã có sorter đặt primary TRƯỚC alternate — ở chỗ khác.** `lib/iap-management/queries/template-matrix.ts:83-89`:

```ts
/** Apple tier sort: primary (non-`ALT_`) tiers first, alternate last; … */
function compareTiers(a: MatrixTier, b: MatrixTier): number {
  if (a.is_alternate !== b.is_alternate) return a.is_alternate ? 1 : -1;
  return COLLATOR.compare(a.tier_name, b.tier_name);
}
```

**3. Và `price-tiers.ts` tự nó cũng có** — `sortTierId` ở `:270-287`, **cách hàm resolve đúng 87 dòng**, xếp hạng `FREE(0) → TIER_<n>(1) → ALT_<số>(2) → ALT_<chữ>(3)`, numeric-aware. `resolveTierByUsdPrice` **không gọi nó**.

⇒ Thứ tự Manager muốn **đã tồn tại trong repo ở hai chỗ**. Chỉ bộ giải là không dùng.

### P1.3 Tier vs Alternate phân biệt bằng cột nào

# **KHÔNG CÓ CỘT NÀO.**

`grep -rn "is_alternate" supabase/migrations/` → **0 kết quả**. Phân biệt hoàn toàn bằng **tiền tố của `tier_id`**, suy ra trong code (`price-tiers.ts:211`, `:77`, `templates.ts:532`, `template-matrix.ts:112` — 4 bản sao của cùng một biểu thức `startsWith("ALT_")`).

Hợp đồng nằm ở **CHECK constraint** — `supabase/migrations/20260515010000_iap_mgmt_tier_id_text.sql:47`:

```sql
CHECK (tier_id ~ '^(FREE|TIER_[0-9]+|ALT_[0-9A-Z]+)$');
```

Sinh ra ở `lib/iap-management/parsers/price-tiers.ts:96` (`TIER_${n}`) và `:101` (`ALT_${X}`).

⇒ **Hình dạng id TỰ phân biệt được**, và CHECK ở DB bảo đảm nó. Không cần migration để sửa arc này.

Bảng dữ liệu (hai nguồn, tuỳ `pricing_source` của batch):

| Nguồn | Bảng | Cột |
|---|---|---|
| `APPLE` (cache cũ) | `iap_mgmt.price_tier_territories` | `tier_id, territory_code, currency_code, customer_price, proceeds` |
| `DEFAULT_TEMPLATE` / `APP_TEMPLATE` | `iap_mgmt.price_tier_template_entries` | `template_id, tier_id, territory_code, currency_code, customer_price, proceeds` |

### P1.4 SQL — bao nhiêu ca trùng giá trong dữ liệu thật

#### SQL 1 — nhóm trùng giá ở cache APPLE

```sql
SELECT customer_price,
       COUNT(*)                                        AS n_tiers,
       COUNT(*) FILTER (WHERE tier_id ~ '^TIER_')      AS n_standard,
       COUNT(*) FILTER (WHERE tier_id ~ '^ALT_')       AS n_alternate,
       array_agg(tier_id ORDER BY tier_id)             AS tier_ids,
       CASE
         WHEN COUNT(*) FILTER (WHERE tier_id ~ '^TIER_') > 0
          AND COUNT(*) FILTER (WHERE tier_id ~ '^ALT_')  > 0 THEN 'TIER-ALT'
         WHEN COUNT(*) FILTER (WHERE tier_id ~ '^ALT_')  > 1 THEN 'ALT-ALT'
         ELSE 'TIER-TIER'
       END                                             AS loai_trung
FROM   iap_mgmt.price_tier_territories
WHERE  territory_code = 'USA' AND currency_code = 'USD'
GROUP  BY customer_price
HAVING COUNT(*) > 1
ORDER  BY customer_price;
```

> **KỲ VỌNG — cách đọc:**
> - `loai_trung = 'TIER-ALT'` ⇒ **đúng những nhóm arc này thay đổi kết quả.** Đếm số dòng này = số mức giá bị ảnh hưởng.
> - `'ALT-ALT'` ⇒ đổi ưu tiên **không giúp gì** — vẫn cần tie-break trong nhóm Alt (sẽ do `sortTierId` xử lý: ALT_số trước ALT_chữ).
> - `'TIER-TIER'` ⇒ ⚠ nếu có, tie-break hiện tại **sai theo kiểu khác**: `TIER_10` thắng `TIER_2` vì so chuỗi. `sortTierId` sửa luôn ca này.
> - **Bảng rỗng** ⇒ arc không đáng làm trên nguồn APPLE. Chạy tiếp SQL 2.

#### SQL 2 — nhóm trùng giá trong từng pricing template

```sql
SELECT t.id                                            AS template_id,
       t.scope_type, t.scope_account_id, t.scope_app_id,
       e.customer_price,
       COUNT(*)                                        AS n_tiers,
       array_agg(e.tier_id ORDER BY e.tier_id)         AS tier_ids,
       COUNT(*) FILTER (WHERE e.tier_id ~ '^TIER_') > 0
         AND COUNT(*) FILTER (WHERE e.tier_id ~ '^ALT_') > 0 AS co_tier_va_alt
FROM   iap_mgmt.price_tier_template_entries e
JOIN   iap_mgmt.price_tier_templates t ON t.id = e.template_id
WHERE  e.territory_code = 'USA' AND e.currency_code = 'USD'
GROUP  BY t.id, t.scope_type, t.scope_account_id, t.scope_app_id, e.customer_price
HAVING COUNT(*) > 1
ORDER  BY t.scope_type, t.id, e.customer_price;
```

> **KỲ VỌNG:** `co_tier_va_alt = true` ⇒ template đó có mức giá bị ảnh hưởng. ⚠ Con số ở đây quan trọng hơn SQL 1 nếu batch dùng `DEFAULT_TEMPLATE`/`APP_TEMPLATE` — bulk import đọc `listUsdTiersForSource` (`templates.ts:297`), không phải cache cũ.

#### ⭐ SQL 3 — CÂU QUYẾT ĐỊNH VỀ RỦI RO: hai tier trùng giá USD có trùng giá ở nước khác không?

```sql
WITH tie AS (
  SELECT customer_price
  FROM   iap_mgmt.price_tier_territories
  WHERE  territory_code = 'USA' AND currency_code = 'USD'
  GROUP  BY customer_price HAVING COUNT(*) > 1
),
members AS (
  SELECT p.tier_id, p.customer_price AS usd
  FROM   iap_mgmt.price_tier_territories p JOIN tie ON tie.customer_price = p.customer_price
  WHERE  p.territory_code = 'USA' AND p.currency_code = 'USD'
)
SELECT m.usd,
       COUNT(DISTINCT t.territory_code)                                  AS so_nuoc,
       COUNT(DISTINCT t.territory_code) FILTER (
         WHERE t.territory_code IN (
           SELECT territory_code FROM iap_mgmt.price_tier_territories x
           JOIN members m2 ON m2.tier_id = x.tier_id AND m2.usd = m.usd
           GROUP BY territory_code HAVING COUNT(DISTINCT x.customer_price) > 1
         ))                                                              AS so_nuoc_LECH_GIA,
       array_agg(DISTINCT m.tier_id)                                     AS tier_ids
FROM   members m
JOIN   iap_mgmt.price_tier_territories t ON t.tier_id = m.tier_id
GROUP  BY m.usd
ORDER  BY m.usd;
```

> **KỲ VỌNG — đây là câu định đoạt rủi ro P2.3:**
> - `so_nuoc_LECH_GIA = 0` ⇒ các tier trùng giá USD **giống hệt nhau ở mọi nước** ⇒ đổi ALT_5 → TIER_5 **không đổi một đồng nào**. Arc thành thuần tuý dọn dẹp, rủi ro ~0.
> - `so_nuoc_LECH_GIA > 0` ⇒ ⚠ **chúng KHÁC nhau ở N nước.** Đổi tier sẽ đổi giá thật ở N nước đó. Khi ấy câu hỏi P6-2 (item cũ có re-resolve không) trở thành câu hỏi tiền bạc, không phải câu hỏi kỹ thuật.
>
> ⚠ **KHÔNG ĐỌC ĐƯỢC TỪ REPO:** repo chỉ ghi *cách mã hoá* Alternate Tier (`parsers/price-tiers.ts:17-19`), **không** ghi ý nghĩa nghiệp vụ của nó. Tôi không suy đoán Alt khác Tier ở chỗ nào — SQL này đo thẳng.

#### SQL 4 — bao nhiêu item ĐÃ TẠO đang nằm trên một ALT có "song sinh" TIER cùng giá

```sql
WITH usd AS (
  SELECT tier_id, customer_price FROM iap_mgmt.price_tier_territories
  WHERE territory_code='USA' AND currency_code='USD'
),
alt_co_song_sinh AS (
  SELECT a.tier_id AS alt_id, s.tier_id AS tier_id, a.customer_price
  FROM   usd a JOIN usd s ON s.customer_price = a.customer_price
  WHERE  a.tier_id ~ '^ALT_' AND s.tier_id ~ '^TIER_'
)
SELECT x.alt_id, x.tier_id AS se_doi_thanh, x.customer_price,
       COUNT(i.id) AS so_item_dang_dung
FROM   alt_co_song_sinh x
LEFT   JOIN iap_mgmt.iaps i ON i.tier_id = x.alt_id
GROUP  BY x.alt_id, x.tier_id, x.customer_price
ORDER  BY so_item_dang_dung DESC;
```

> **KỲ VỌNG:** `so_item_dang_dung` = số IAP sẽ **đổi tier nếu Manager import lại** file Excel cũ sau khi deploy. Tổng cột này là quy mô rủi ro P2.3. **Bằng 0 ⇒ không item nào bị ảnh hưởng.**

---

## P2 — Phạm vi ảnh hưởng

### P2.1 Đường nào dùng kết quả resolve

| Đường | Có dùng `resolveTierByUsdPrice`? | Vị trí |
|---|---|---|
| **Bulk import — preview (Step 3)** | ✅ CÓ | `BulkImportWizard.tsx:423` → `enrichWithTiers` → `conflict-resolution.ts:158` |
| **Bulk import — execute** | ✅ CÓ | `execute/route.ts:458` → cùng `enrichWithTiers` |
| **Tạo IAP đơn lẻ (form)** | ❌ KHÔNG | `IapForm.tsx:752-770` — `<select>` trên **toàn bộ** tier, người dùng chọn thẳng. `create-on-apple/route.ts:194` dùng `form.tier_id`. |
| **Update on Apple** | ❌ KHÔNG | `update-on-apple/route.ts:226` — `form.tier_id ?? cached.tier_id`. |
| **Pricing template apply** | ❌ KHÔNG | Đọc `tier_id` đã có; không suy từ giá. |
| **Sync states** | ❌ KHÔNG | `grep "tier" sync-states/route.ts` → **0 kết quả**. |

⇒ **Chỉ bulk import.** Phạm vi hẹp hơn nhiều so với lo ngại ban đầu.

### P2.2 Twin-path?

**Bộ giải: KHÔNG có bản sao.** Cả preview lẫn execute gọi **cùng một** `enrichWithTiers` → cùng một `resolveTierByUsdPrice`. Sửa một chỗ là xong cả hai. ✅

⚠ **NHƯNG có một twin ở tầng liệt kê ứng viên** — `BulkImportWizard.tsx:1495`:

```ts
return usdTiers.filter((t) => t.customer_price === priceUsd);
```

Đây là **bản sao thứ hai** của vị ngữ `customer_price === priceUsd` (bản gốc ở `price-tiers.ts:176`). Hai bản đang giống nhau; không có gì bắt chúng phải giống nhau mãi. Đây đúng khuôn **P1 twin-path** của CLAUDE.md — nên rút về một choke point chung trong arc này.

⚠ Và một twin nữa, **đã tồn tại từ trước arc này**: `sortTierId` có **hai bản y hệt** ở `price-tiers.ts:270` và `templates.ts:568`. Comment ở `templates.ts:566-567` đã tự thú: *"once price-tiers.ts retires, can be lifted to a shared util"*. Nếu arc này dùng `sortTierId` làm quy tắc mới, đây là lúc gộp — ngược lại sẽ thành **ba** bản.

### P2.3 Ảnh hưởng tới item ĐÃ TẠO

**Không có đường tự động re-resolve.** `iap_mgmt.iaps.tier_id` chỉ đổi khi có người chạy một trong các đường ghi. `sync-states` không đụng tier.

⚠ **NHƯNG rủi ro thật nằm ở OVERWRITE của bulk import** — `lib/iap-management/bulk-import/overwrite-pricing-decision.ts:47-63`:

```ts
const tierUnchanged = resolvedTierId === cachedTierId;
return { shouldRunPricing: true, tierUnchanged, preFixWouldSkip: tierUnchanged };
```

`shouldRunPricing` **LUÔN `true`** khi có tier (Hotfix 23 cố ý bỏ tối ưu "chỉ chạy khi tier đổi"). ⇒ Manager import lại **chính file Excel cũ** sau khi deploy:

1. dòng đang ở `ALT_5` sẽ resolve thành `TIER_5`,
2. pricing stage chạy, POST `/v1/inAppPurchasePriceSchedules` (replace-all),
3. giá trên Apple đổi theo `TIER_5`.

**Giá USD không đổi** (hai tier trùng giá USD — đó là lý do chúng tie). **Giá ở nước khác thì chưa biết** — **SQL 3 ở P1.4 là thứ trả lời câu đó.** Đây là rủi ro phải nêu rõ với Manager, và nó **không** thể quyết bằng đọc code.

### P2.4 Test nào ghim hành vi "ưu tiên Alt"

**CÓ — đúng MỘT.** `lib/iap-management/queries/price-tiers.test.ts:30`:

```ts
expect(resolveTierByUsdPrice(4.99, tiers)).toBe("ALT_5");
```

Ghim bằng **giá trị thật** (`"ALT_5"`), không phải bằng hằng số của code. Fixture `:13` có comment `// intentional same-price collision with TIER_5` ⇒ ca trùng giá là **cố ý dựng ra để test**, không phải tình cờ.

⚠ Dòng `:34` (`toBe("ALT_A")`) **KHÔNG** ghim tie-break: ở fixture, `ALT_A` là tier **duy nhất** ở giá 0.69 — không có tie. Dòng này đúng dưới mọi quy tắc, **không cần sửa**.

⇒ **Chính xác 1 assertion phải sửa**, và tiêu đề của nó (`:26`) vốn đã nói TIER_5.

`grep TierCell|ambiguous` trong toàn bộ test → **không test nào chạm dropdown chọn tier**. Đó là UI chưa từng được khẳng định.

---

## P3 — "User select lại": UI hiện có gì

### P3.1 + P3.2 — ⭐ ĐÃ CÓ SẴN, ở bulk import

`BulkImportWizard.tsx:1476-1531` — `TierCell`, render tại `:1426` trong bảng preview Step 3:

```ts
const candidates = useMemo(() => {                       // :1491
  if (priceUsd === 0) return usdTiers.filter((t) => t.tier_id === "FREE");
  return usdTiers.filter((t) => t.customer_price === priceUsd);   // :1495
}, [priceUsd, usdTiers]);

const selected = overrideTierId ?? autoTierId;           // :1498
const ambiguous = candidates.length > 1;                 // :1499
```

- `ambiguous === false` → hiện text thường (`formatTierWithPrice`).
- `ambiguous === true` → hiện **`<select>` viền amber**, tooltip *"Same USD price matches N tiers — pick one"*; khi Manager đã chọn thì đổi sang viền xanh Apple `#0071E3`.
- Lựa chọn chảy qua `tierOverrides` → `config.tier_overrides` → `execute/route.ts:466-476`, **thắng** giá trị auto-resolve.

⇒ **Yêu cầu "tự chọn lại" của Manager KHÔNG phải tính năng mới.** Nó đã chạy. Việc còn lại chỉ là đổi **giá trị mặc định** mà dropdown mở ra.

**Nhãn có phân biệt Tier vs Alt không?** Có — `formatTierWithPrice` (`price-tiers.ts:43-56`) render `Tier 5 ($4.99)` vs `Alt Tier 5 ($4.99)`.

⚠ **Nhưng thứ tự option thì KHÔNG xác định.** `candidates` là `usdTiers.filter(...)`, mà `usdTiers` chỉ `.order("customer_price")` (`price-tiers.ts:155`, `templates.ts:320`) — **trong một nhóm cùng giá, thứ tự Postgres trả về là tuỳ ý**. Đây mới đúng là "hệ quả ngẫu nhiên của thứ tự DB" mà brief cảnh báo: nó **không** nằm ở bộ giải, nó nằm ở **dropdown**.

### P3.3 Chi phí

Không phải tính năng mới ⇒ chi phí gần bằng 0 cho phần "chọn lại". Chi phí thật nằm ở (a) đổi quy tắc mặc định, (b) sắp thứ tự option cho xác định.

### P3.4 ⚠ Bulk import 88 dòng thì "chọn lại" nghĩa là gì

Ba lựa chọn — **KHÔNG tự chốt, xem P6-3**:

| | Phương án | Ưu | Nhược |
|---|---|---|---|
| **3.4-A** | **Giữ nguyên cơ chế hiện có**: mặc định TIER, dòng nào trùng giá thì hiện dropdown amber ở Step 3, Manager sửa dòng nào cần. | Không thêm gì. Đã chạy. Chỉ dòng mơ hồ mới đòi chú ý — 88 dòng nhưng có thể chỉ 3 dòng amber. | Vẫn phải cuộn tìm dòng amber trong bảng dài. |
| **3.4-B** | **A + bộ lọc "chỉ hiện dòng cần chọn tier"** ở Step 3 + đếm ở đầu bảng (*"3 dòng khớp nhiều tier"*). | Biến việc cuộn tìm thành việc bấm một nút. Rẻ (client-side filter trên dữ liệu đã có). | Thêm một control vào Step 3. |
| **3.4-C** | **Thêm cột `Tier` vào template Excel** — Manager ghi thẳng `ALT_5` khi muốn. | Quyết định nằm trong file, lặp lại được, không cần ngồi bấm. | Đổi template ⇒ đụng parser + tài liệu + file mẫu của Manager. Đắt nhất. **Và trùng chức năng với dropdown đã có.** |

**Đề xuất: 3.4-B.** A là nền đã có; B chỉ thêm một bộ lọc client-side, giải đúng nỗi lo "88 dòng thì tìm ở đâu". C đắt và chồng lấn — để dành nếu sau này Manager cần lặp lại cùng một lựa chọn qua nhiều lần import.

---

## P4 — Đánh giá khả thi

### PA-1 — Đảo điều kiện trong `resolveTierByUsdPrice` (ưu tiên non-ALT)

| | |
|---|---|
| File đổi | **1** (`price-tiers.ts`) |
| Đụng đường ghi Apple? | Gián tiếp — qua bulk import OVERWRITE (P2.3) |
| Migration | **Không** |
| Test phải sửa | 1 assertion (`price-tiers.test.ts:30`) |

⚠ **Chỉ sửa được một nửa.** Nó bỏ tác dụng phụ ALT nhưng **giữ nguyên** tie-break lexicographic ⇒ `TIER_10` vẫn thắng `TIER_2`. Đổi một hành vi không mong muốn lấy một hành vi không mong muốn khác, ít lộ hơn.

### ⭐ PA-2 — Dùng `sortTierId` (thứ hạng tường minh) làm quy tắc tie-break — **ĐỀ XUẤT**

| | |
|---|---|
| File đổi | **2-3**: `price-tiers.ts` (export `sortTierId`, cho resolver dùng), `templates.ts` (bỏ bản sao, import bản chung), tuỳ chọn `BulkImportWizard.tsx` (sắp option dropdown) |
| Đụng đường ghi Apple? | Như PA-1 |
| Migration | **Không** |
| Test phải sửa | 1 assertion (`price-tiers.test.ts:30`) |
| Thêm | Test mới cho quy tắc tie-break + mutation |

⭐ **Vì sao đáng hơn PA-1, đúng như brief nêu:** PA-1 đảo một điều kiện; PA-2 **biến một hành vi không xác định thành một hợp đồng**. Cụ thể nó sửa **ba** thứ cùng lúc:

1. `TIER_*` trước `ALT_*` — thứ Manager yêu cầu.
2. `TIER_2` trước `TIER_10` — tie-break **theo số**, không theo chuỗi. Ca này PA-1 **không** chạm tới.
3. `ALT_1` trước `ALT_A` — có thứ hạng trong nhóm Alt, thay vì tuỳ chuỗi.

Và nó **không phát minh quy tắc mới**: `sortTierId` đã tồn tại, đã đúng thứ tự Manager muốn, nằm cách hàm resolve 87 dòng trong cùng file. Arc chỉ là **nối hai thứ đã có**.

⚠ Kèm điều kiện: `sortTierId` đang có **hai bản y hệt** (`price-tiers.ts:270`, `templates.ts:568`). PA-2 phải **gộp về một**, nếu không sẽ thành ba bản — đúng cái bẫy P1 twin-path. Comment `templates.ts:566-567` đã báo trước điều này.

### PA-3 — PA-2 + rút vị ngữ "tier nào khớp giá này" về một choke point

Thêm so với PA-2: bỏ bản sao `customer_price === priceUsd` ở `BulkImportWizard.tsx:1495`, đổi thành hàm chung (ví dụ `candidateTiersForPrice`) mà **cả** resolver **và** dropdown đều gọi.

| | |
|---|---|
| File đổi | **3-4** |
| Lợi | Dropdown và bộ giải không thể lệch nhau; thứ tự option trở nên xác định (cùng `sortTierId`) ⇒ giải luôn vấn đề ngẫu nhiên ở P3.2 |
| Rủi ro thêm | Thấp — cả hai chỗ đang cùng logic, chỉ rút chung |

### PA-4 — Không đổi mặc định, chỉ làm dropdown dễ thấy hơn

Giữ nguyên bộ giải; thêm bộ lọc/đếm ở Step 3 (3.4-B). **Không** giải yêu cầu của Manager (mặc định vẫn ra Alt) — liệt kê để so sánh, không đề xuất.

### Bảng so sánh

| | PA-1 | **PA-2** | PA-3 | PA-4 |
|---|---|---|---|---|
| Đạt yêu cầu Manager | ✅ | ✅ | ✅ | ❌ |
| Sửa luôn `TIER_10 > TIER_2` | ❌ | ✅ | ✅ | ❌ |
| Thứ tự dropdown xác định | ❌ | ⚠ tuỳ chọn | ✅ | ❌ |
| Gộp twin `sortTierId` | ❌ | ✅ | ✅ | ❌ |
| Số file | 1 | 2-3 | 3-4 | 1 |
| Migration | Không | Không | Không | Không |

**Đề xuất: PA-3** (tức PA-2 + choke point). Chênh lệch so với PA-2 là ~1 file, đổi lại đóng luôn cả hai twin và biến thứ tự dropdown thành xác định. Nếu Manager muốn phạm vi nhỏ nhất thì **PA-2** vẫn đạt đủ yêu cầu.

---

## P5 — Thiết kế UI

Mockup: `docs/iap-management/design/tier-tiebreak-mockup.html`

Palette lấy từ component thật (`BulkImportWizard.tsx`, `IapForm.tsx`): Apple blue **`#0071E3`** (hover `#0077ED`, đậm `#0062c4`), amber cho trạng thái mơ hồ, slate cho chữ. **Không** dùng emerald (đó là Google).

Các state vẽ trong mockup:
1. **Ca không trùng** — text thường, không có control (`ambiguous === false`).
2. **Ca trùng giá, mặc định là Tier thường** — dropdown viền amber, mở ra `Tier 5 ($4.99)` (SAU khi đổi).
3. **Người dùng đổi sang Alt** — viền chuyển xanh Apple, đánh dấu là override.
4. **So sánh TRƯỚC/SAU** — cùng một dòng, dưới quy tắc cũ vs quy tắc mới.
5. **3.4-B** — thanh lọc *"Chỉ hiện dòng cần chọn tier (3)"*.

---

## P6 — Câu cần Manager chốt

### ❓ Q1 — Đổi thứ tự áp cho đường nào?

Census cho thấy **chỉ bulk import** dùng bộ giải (P2.1); form đơn lẻ và update-on-apple để người dùng chọn thẳng.

- **(a) Chỉ bulk import** — tức là mọi đường đang dùng nó. *(khuyến nghị — không có đường nào khác để loại trừ)*
- (b) Có đường nào Manager muốn giữ nguyên hành vi cũ không?

**Đề xuất (a).** Không phải vì đã cân nhắc rồi loại (b), mà vì (b) **không có đối tượng**: chỉ tồn tại một đường.

### ❓ Q2 — Item ĐÃ TẠO: re-resolve hay để nguyên?

⚠ **Đây là câu đắt nhất, và cần SQL 3 + SQL 4 (P1.4) trước khi trả lời.**

- **(a) Để nguyên** — không viết script backfill. Item cũ giữ tier cũ tới khi có người import lại. *(khuyến nghị)*
- (b) Backfill: đổi mọi item đang ở `ALT_x` sang `TIER_n` song sinh + đẩy lại giá lên Apple.

**Đề xuất (a)**, và lý do là một dữ kiện chứ không phải sở thích: OVERWRITE **luôn** đẩy lại pricing (`overwrite-pricing-decision.ts:47-63`), nên mỗi lần import lại đã là một cơ hội tự nhiên để hội tụ. Một backfill hàng loạt sẽ đổi giá ở **mọi** nước cho **mọi** item cùng lúc, và **SQL 3 chưa chạy thì chưa ai biết mức đổi là bao nhiêu**.

⚠ Dù chọn (a), Manager **vẫn cần biết** rằng lần import lại kế tiếp của file Excel cũ sẽ đổi tier cho các dòng đó. Đó **không** phải hồi quy — đó là hành vi mới đang làm đúng việc. Nhưng nó sẽ xảy ra **im lặng** nếu không ai nói trước.

### ❓ Q3 — Bulk import cho chọn ở đâu? (P3.4)

- **(a) 3.4-A** — giữ nguyên dropdown Step 3 đã có, không thêm gì.
- **(b) 3.4-B** — thêm bộ lọc *"chỉ hiện dòng cần chọn tier"* + số đếm. *(khuyến nghị)*
- (c) 3.4-C — thêm cột `Tier` vào template Excel.

**Đề xuất (b).** (a) đã đủ về chức năng nhưng bắt Manager tự dò dòng amber giữa 88 dòng; (b) rẻ và giải đúng chỗ đau. (c) đắt và chồng lấn với dropdown đã có — để dành nếu sau này cần lặp lại lựa chọn qua nhiều lần import.

### ❓ Q4 (mới — census sinh ra, brief chưa hỏi) — Có sửa luôn `TIER_10` thắng `TIER_2` không?

Tie-break hiện tại so **chuỗi**, nên trong một nhóm toàn tier thường, `TIER_10` vẫn thắng `TIER_2`. PA-1 không chạm; **PA-2/PA-3 sửa miễn phí** vì `sortTierId` vốn numeric-aware.

- **(a) Có** — nhận luôn, không tốn thêm gì. *(khuyến nghị)*
- (b) Không — chỉ đổi đúng ALT vs TIER.

**Đề xuất (a).** ⚠ Nhưng nó **chỉ có tác dụng nếu SQL 1 cho ra nhóm `TIER-TIER`**. Nếu không có nhóm nào như vậy trong dữ liệu thật thì đây là hợp đồng phòng xa, không phải bản sửa lỗi — và vẫn đáng lấy vì chi phí bằng 0.

---

## Việc KHÔNG đọc được từ repo

| Câu | Cần gì |
|---|---|
| Alternate Tier khác Tier thường ở chỗ nào về **nghiệp vụ**? | ✅ **ĐÃ TRẢ LỜI** bằng SQL 3 — lệch giá ở nước khác, `$0.99` lệch 75/175. Ghi vĩnh viễn ở **KB §26.1** để không phải hỏi lần hai. |
| Có bao nhiêu ca trùng giá trong dữ liệu thật? | ✅ **5 nhóm, tất cả TIER-vs-ALT** (SQL 1). KB §26.2. |
| Bao nhiêu item sẽ đổi tier nếu import lại? | ✅ **26 item** (SQL 4) — và chỉ đổi nếu Manager import lại VÀ không chọn lại ở dropdown. KB §26.3. |
