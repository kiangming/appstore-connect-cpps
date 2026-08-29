# Default Price Template theo từng ASC account — CENSUS + THIẾT KẾ

**Tag:** `[ACCOUNT-default-template]` · **Trạng thái:** census xong, **chờ Manager
chốt P1 + số liệu P0.5**. Chưa code, chưa migration.

> **Yêu cầu Manager:** hiện Default price template dùng CHUNG cho mọi account
> App Store trong tool. Muốn mỗi account tự upload và dùng Default Template của
> riêng account đó.

---

## P0 — CENSUS HIỆN TRẠNG

### 0.1 Schema hiện tại

`supabase/migrations/20260519000000_iap_mgmt_pricing_templates.sql`

**`iap_mgmt.price_tier_templates`** (header — 1 dòng / 1 lần upload)

| Cột | Kiểu | Ràng buộc |
|---|---|---|
| `id` | UUID | PK, `gen_random_uuid()` |
| `scope_type` | TEXT | **NOT NULL, `CHECK (scope_type IN ('GLOBAL','APP'))`** |
| `scope_app_id` | UUID | `REFERENCES iap_mgmt.apps(id) ON DELETE CASCADE`, nullable |
| `uploaded_at` | TIMESTAMPTZ | NOT NULL, `NOW()` |
| `uploaded_by` | TEXT | NOT NULL |
| `source_filename` | TEXT | nullable |

CHECK thứ hai (coherence, table-level):

```sql
CHECK ( (scope_type='GLOBAL' AND scope_app_id IS NULL)
     OR (scope_type='APP'    AND scope_app_id IS NOT NULL) )
```

Index / unique:

| Tên | Định nghĩa | Ý nghĩa |
|---|---|---|
| `idx_..._templates_global_unique` | `UNIQUE (scope_type) WHERE scope_type='GLOBAL'` | **tối đa 1 template GLOBAL trong toàn hệ thống** |
| `idx_..._templates_app_unique` | `UNIQUE (scope_app_id) WHERE scope_type='APP'` | tối đa 1 template / app |
| `idx_..._templates_uploaded` | `(uploaded_at DESC)` | list |

**`iap_mgmt.price_tier_template_entries`** (sparse cells)

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `template_id` | UUID | `REFERENCES price_tier_templates(id) ON DELETE CASCADE` |
| `tier_id` | TEXT | `REFERENCES price_tiers(tier_id) ON DELETE CASCADE` |
| `territory_code` | TEXT | |
| `currency_code` | TEXT | |
| `customer_price` | NUMERIC(18,4) | NOT NULL |
| `proceeds` | NUMERIC(18,4) | nullable (sparse template chỉ cần customer_price) |
| **PK** | | `(template_id, tier_id, territory_code)` |

Index: `(template_id, tier_id)`. RLS bật, không policy → chỉ `service_role`.

**Trả lời trực tiếp:**
- Hiện có **2 scope**: `GLOBAL` và `APP`.
- **Khoá phân biệt** = cặp `(scope_type, scope_app_id)`, ép bằng **2 partial
  unique index** chứ không phải unique constraint thường. `GLOBAL` phân biệt
  bằng chính hằng `scope_type='GLOBAL'` — **không có cột nào khác** để một
  GLOBAL thứ hai tồn tại. Đây là ràng buộc phải mở nếu muốn N account.

### 0.2 Chuỗi phân giải nguồn giá

⚠ Điểm quan trọng: **orchestrator KHÔNG tự chọn nguồn.** Nó *nhận* nguồn đã
chọn. Q-D "most-specific default" nằm ở **UI**, không nằm ở orchestrator.

**Nơi quyết định (Q-D):**
[`components/iap-management/iap-form/PricingSourceSelector.tsx:22-28`](components/iap-management/iap-form/PricingSourceSelector.tsx#L22-L28)

```ts
export function defaultPricingSource(
  defaultTemplateAvailable: boolean,
  appTemplateAvailable: boolean,
): PricingSourceKind {
  if (appTemplateAvailable) return "APP_TEMPLATE";
  if (defaultTemplateAvailable) return "DEFAULT_TEMPLATE";
  return "APPLE";
}
```

và `resolveInitialPricingSource(stored, …)` (dòng 40-47) — **lựa chọn đã lưu
luôn thắng Q-D** (Q-J).

**Nơi thực thi:**
[`lib/iap-management/apple/pricing-orchestration.ts:418-422`](lib/iap-management/apple/pricing-orchestration.ts#L418-L422)

```ts
if (source.kind !== "APPLE") {
  const template: TemplateWithEntries | null =
    source.kind === "DEFAULT_TEMPLATE"
      ? await getDefaultTemplate()          // ← không nhận tham số nào
      : await getAppTemplate(source.app_id);
  if (!template) { /* fallback APPLE, chỉ console.warn */ }
```

`getDefaultTemplate()` không nhận tham số — đó chính là chỗ "dùng chung".

**Nếu thêm tầng ACCOUNT thì chèn ở đâu:**

| # | Hàm / vị trí | Phải đổi gì |
|---|---|---|
| 1 | `templates.ts` → `TemplateScope` | thêm biến thể `{ kind: "ACCOUNT"; account_id }` |
| 2 | `templates.ts` → `applyScopeFilter` | thêm nhánh lọc `scope_account_id` |
| 3 | `templates.ts` → `fetchTemplateHeader` | ⚠ **`.maybeSingle()`** — xem cảnh báo dưới |
| 4 | `templates.ts` → `getDefaultTemplate()` | → `getAccountTemplate(account_id)` |
| 5 | `templates.ts` → `getTemplateSummary` | scope mới đi qua nguyên vẹn |
| 6 | `templates.ts` → `listUsdTiersForSource` | `UsdTierSource` cần account_id |
| 7 | `templates.ts` → `replaceTemplate` | ghi `scope_account_id`, `template_version` |
| 8 | `template-matrix.ts` → `fetchTemplateId` | `ScopeQuery` + filter account |
| 9 | `pricing-orchestration.ts` → `PricingSource` | `DEFAULT_TEMPLATE` mang thêm `account_id` |
| 10 | 4 route dựng `PricingSource` | truyền `creds.id` (đã có sẵn trong tay) |

⚠ **CẢNH BÁO `.maybeSingle()`** — `fetchTemplateHeader` với scope GLOBAL hiện
lọc `.eq("scope_type","GLOBAL").is("scope_app_id", null)` rồi `.maybeSingle()`.
Nếu có **N dòng** thoả filter đó, PostgREST trả lỗi `PGRST116` và
`fetchTemplateHeader` **throw**. Nghĩa là: bất kỳ phương án nào tạo nhiều dòng
mà quên thêm bộ lọc account vào **mọi** đường đọc GLOBAL sẽ làm **hỏng ngay**
Settings + App detail + New IAP + bulk-import preview. Danh sách đầy đủ đường
đọc GLOBAL ở §0.4.

### 0.3 `iaps.pricing_source` — TOÀN BỘ nơi narrow/switch

CHECK constraint sống ở **2 cột, 2 migration khác nhau**:

| Cột | Migration | CHECK |
|---|---|---|
| `iap_mgmt.iaps.pricing_source` | `20260520000000_iap_mgmt_p1j_hotfix.sql:24` | `IS NULL OR IN ('APPLE','DEFAULT_TEMPLATE','APP_TEMPLATE')` |
| `iap_mgmt.iaps.custom_prices_baseline_pricing_source` | `20260812000000_iap_mgmt_custom_prices.sql:103` | cùng tập giá trị |

**Bảng đầy đủ nơi giá trị bị chép tay / narrow** (grep, không tin `tsc` — P29):

| Lớp | File:dòng | Hình thức |
|---|---|---|
| **Type gốc** | `lib/iap-management/validation.ts:34` | `type PricingSourceKind = "APPLE" \| "DEFAULT_TEMPLATE" \| "APP_TEMPLATE"` |
| **Type gốc #2** | `lib/iap-management/apple/pricing-orchestration.ts:61-64` | `type PricingSource` (union object — **bản chép tay thứ 2**) |
| **Type gốc #3** | `lib/iap-management/queries/templates.ts:221-224` | `type UsdTierSource` (**bản chép tay thứ 3**) |
| DB row type | `lib/iap-management/queries/iaps.ts:39` | union chép tay trong `IapDbRow` |
| DB patch type | `lib/iap-management/queries/iaps.ts:226` | union chép tay trong patch |
| zod | `app/api/iap-management/apps/[appId]/iaps/route.ts:34-35` | `z.enum([...])` |
| zod | `app/api/iap-management/iaps/[iapId]/route.ts:34-35` | `z.enum([...])` |
| zod | `app/api/iap-management/iaps/[iapId]/custom-prices/route.ts:55` | `z.enum([...])` |
| Route narrow | `create-on-apple/route.ts:343-351` | ternary `APP_TEMPLATE → DEFAULT_TEMPLATE → APPLE` |
| Route narrow | `update-on-apple/route.ts:74-78, 347-351` | union chép tay **trong signature hàm** + ternary |
| Route narrow | `bulk-import/execute/route.ts:424-430` | ternary dựng `PricingSource` |
| Route narrow | `custom-prices/baseline/route.ts:105-106, 141-146` | ép kiểu từ query-string (`as PricingSourceKind`) |
| **UI radio** | `components/…/PricingSourceSelector.tsx:70-100` | 3 `<Option kind=…>` + Q-D resolver |
| UI badge/copy | `components/…/UpdateChangesPreviewModal.tsx:286-294` | so sánh 2 giá trị |
| UI copy | `components/…/CustomPricesDialog.tsx:374, 411` | in thẳng giá trị ra màn hình |
| UI state | `BulkImportWizard.tsx:260-270, 523-533, 1478-1480` | `Record<PricingSourceKind, …>` + ternary hiển thị |
| Page payload | `bulk-import/page.tsx:38-43, 66-78` | `Record<PricingSourceKind, UsdTierEntry[]>` dựng tay |
| Model | `custom-prices/model.ts:75, 232-238, 270, 349-350` | fingerprint + diff text |
| Repository | `custom-prices/repository.ts:47, 52, 57-68` | 3 cột `custom_prices_baseline_*` |
| Tests | `PricingSourceSelector.test.tsx`, `model.test.ts`, `repository.test.ts`, `write-kind.test.ts`, `custom-prices-gates.test.ts`, `pricing-orchestration*.test.ts`, `BulkImportWizard*.test.tsx`, `conflict-*.test.tsx` | literal rải khắp |

**⇒ Kết luận 0.3:** thêm một giá trị enum mới = **~20 file sản phẩm + ~9 file
test**, trong đó **3 bản type chép tay** và **2 CHECK constraint** không cái nào
`tsc` bắt được. Đây chính là §4.20/P29: biên `fetch` và union chép tay là chỗ
`tsc` mù.

**Điểm sáng (đừng phóng đại rủi ro):** ghi vào `iaps.pricing_source` đi qua
`createIap` / `updateIap` và **cả hai đều kiểm tra `res.error` rồi throw**
(`queries/iaps.ts:177`, `:248`). Nên nếu CHECK thiếu giá trị thì **lỗi
NỔ TO, không im lặng**. Rủi ro P2 im lặng chỉ nằm ở `actions_log` — và ta
**không cần** `action_type` mới (xem 0.4).

### 0.4 UI hiện tại

**Route:** `/iap-management/settings/pricing-tiers` (member vào được; Default
tab read-only cho non-admin — Hotfix 11).

| Thành phần | File | Vai trò |
|---|---|---|
| Page server | `settings/pricing-tiers/page.tsx` | `getTemplateOverview({kind:"GLOBAL"})` + `listAppsWithTemplates()`, truyền `isAdmin`, `currentUserEmail` |
| Client shell | `PricingTiersClient.tsx` | 2 tab: **Default Template** / **Per-App Templates** (`useState<Tab>`) |
| Tab Default | `DefaultTemplateTab.tsx` | 4 stat card · nút Upload/Replace · Remove · link "Open matrix view" · empty state |
| Tab Per-App | `PerAppTemplateTab.tsx` | **live-fetch app theo account đang active** |
| Bảng entries | `components/…/pricing-tiers/TemplateEntriesTable.tsx` | |
| Matrix | `default-matrix/page.tsx` + `DefaultMatrixView.tsx` | |

**Đọc template ra sao:** Server Component → `getTemplateOverview({kind:"GLOBAL"})`
→ `fetchTemplateHeader` (`.maybeSingle()`) → count `exact/head` → range-fetch
1000 dòng/lần (IAP.p1.j Issue 2 — bug 16.800 entry bị cắt còn 1000).

**Upload đi đường nào:** `DefaultTemplateTab` dựng `FormData{file, scope:"GLOBAL"}`
→ `POST /api/iap-management/pricing-templates` → gate admin khi
`scope==='GLOBAL'` → `parsePriceTiersXlsx` → `replaceTemplate` (xoá header cũ →
insert header mới → insert entries theo lô 1000) → `import_batches` +
`actions_log{action_type:'PRICE_TIER_IMPORT'}` → `router.refresh()`.

**Xoá:** `DELETE /api/iap-management/pricing-templates/[templateId]` — đọc trước
`scope_type` để gate admin cho GLOBAL.

**Tab Per-App ĐÃ có khái niệm scope hẹp hơn — tái dùng được gì:**

| Cơ chế đã có | Tái dùng được | Ghi chú |
|---|---|---|
| `POST /pricing-templates` nhận `scope` từ form field | ✅ **thêm `scope=ACCOUNT` là đủ**, không cần route mới | |
| Gate admin theo scope trong cùng 1 route | ✅ | ACCOUNT chọn gate nào là câu hỏi Manager |
| `replaceTemplate(scope, …)` replace-only | ✅ nguyên vẹn | |
| DELETE gate theo `scope_type` | ✅ | |
| Live-fetch theo account đang active (`/api/iap-management/asc-apps` → `getActiveAccount()`) | ⚠ **đây là mô hình (ii)** của câu hỏi 1.3 | |
| Modal xác nhận "ghi đè template của người khác" (so `uploaded_by` vs `currentUserEmail`) | ✅ nên bê nguyên sang tab Default | hiện tab Default **không có** bảo vệ này |
| `TemplateEntriesTable`, matrix view, stat card | ✅ | |

⚠ **`action_type` KHÔNG cần giá trị mới** — upload/delete template đều dùng
`PRICE_TIER_IMPORT` và scope nằm trong `payload`. Tránh được trọn vẹn bẫy P2
(`actions_log` CHECK silent-fail). **Đừng thêm `ACCOUNT_TEMPLATE_IMPORT`.**

**Danh sách ĐẦY ĐỦ đường đọc scope GLOBAL** (phải sửa hết, nếu sót → `PGRST116`):

| # | File:dòng | Gọi gì |
|---|---|---|
| 1 | `settings/pricing-tiers/page.tsx:26` | `getTemplateOverview({kind:"GLOBAL"})` |
| 2 | `settings/pricing-tiers/default-matrix/page.tsx:16` | `fetchDefaultMatrix()` |
| 3 | `settings/pricing-tiers/per-app-matrix/[appId]/page.tsx:37` | **query inline** `.eq("scope_type","GLOBAL")` |
| 4 | `apps/[appId]/page.tsx:125` | `getTemplateSummary({kind:"GLOBAL"})` |
| 5 | `apps/[appId]/iaps/new/page.tsx:40` | `getTemplateSummary({kind:"GLOBAL"})` |
| 6 | `apps/[appId]/iaps/[iapId]/page.tsx:137` | `getTemplateSummary({kind:"GLOBAL"})` |
| 7 | `apps/[appId]/bulk-import/page.tsx:67,71` | `listUsdTiersForSource` + `getTemplateSummary` |
| 8 | `bulk-import/execute/route.ts:446` | `listUsdTiersForSource(pricingSource)` |
| 9 | `custom-prices/baseline/route.ts:146` | `getDefaultTemplate()` |
| 10 | `pricing-orchestration.ts:421` | `getDefaultTemplate()` |

### 0.5 SỐ LIỆU PRODUCTION — **cần Manager chạy trước khi chốt thiết kế**

📄 **File SQL:** `docs/iap-management/queries/census-account-default-template.sql`
(read-only, 7 nhóm query, chạy trong Supabase SQL Editor).

| Query | Trả lời | Vì sao cần |
|---|---|---|
| **Q1** | có mấy template GLOBAL, bao nhiêu entry/tier/territory | 0 dòng ⇒ rủi ro migration = 0 |
| **Q2** | **bao nhiêu IAP đang `pricing_source='DEFAULT_TEMPLATE'`, phân bố theo account/app** | ⚠ **con số quyết định** |
| Q2b | phân bố toàn bộ `pricing_source` (kể cả NULL) | mẫu số để đọc Q2 |
| **Q3/Q3b** | bao nhiêu template APP, thuộc account nào | ảnh hưởng chuỗi phân giải |
| Q4 | danh sách account + số app mỗi account | chính là **N** trong phương án "nhân bản cho N account" |
| **Q5/Q5b** | ⚠ **app có `asc_account_id IS NULL`** | **điểm mù**: không suy ra được account |
| Q6 | phân bố `custom_prices_baseline_pricing_source` | cột thứ 2 mang cùng enum, rất dễ quên |
| Q7 | lịch sử upload/delete template từ `actions_log` | ai đang dùng surface này |

⚠ **Điểm mù Q5 giải thích trước:** `iap_mgmt.apps.asc_account_id` là **TEXT
nullable, soft-reference** (không FK, vì `asc_accounts` ở schema `public` —
invariant #9), và **chỉ được ghi từ IAP.p1.j trở đi**. App đăng ký trước đó =
NULL. Ngoài ra `apps.apple_app_id` là **UNIQUE toàn cục**, không unique theo
account — nghĩa là mô hình dữ liệu hiện tại **giả định 1 app chỉ thuộc 1
account**. Giả định này đúng trên thực tế Apple, nhưng nó nghĩa là: đường duy
nhất đi từ IAP → account là `iaps.app_id → apps.asc_account_id`, và đường đó
**đứt ở mọi dòng NULL**.

### 0.6 Google có chạm gì tới pricing templates không?

**KHÔNG chạm** — đã grep như P8 yêu cầu. Kết quả:

- Google có **hệ thống template riêng, bảng riêng**:
  `google_iap_mgmt.pricing_templates` + `pricing_template_entries`
  (`20260520010000_google_iap_mgmt_init.sql:278-322`).
- **Không có dòng code Google nào** đọc/ghi `iap_mgmt.price_tier_template*`
  (grep `price_tier_template` → 0 hit trong `**/google-iap-management/**`).
- Không có lib dùng chung giữa 2 module cho phần template.

⚠ **NHƯNG đây là một CỔNG (P8 — twin-structure), phải nói rõ:** schema Google
**sao chép nguyên xi** mô hình 2-scope của Apple — cùng `CHECK (scope_type IN
('GLOBAL','APP'))`, cùng 2 partial unique index, comment còn ghi *"matching the
iap_mgmt p1.a pattern"*. Google cũng có nhiều `google_console_accounts` và
Default Template của Google **cũng đang dùng chung cho mọi console account** —
tức Google có **đúng cùng một vấn đề**, chưa được yêu cầu sửa.

Thêm nữa, `google_iap_mgmt.apps` có **`google_console_account_id UUID NOT NULL
REFERENCES … ` + `UNIQUE(account, package_name)`** — nghĩa là **Google đã
account-scope ở tầng app chặt hơn Apple** (Apple chỉ có TEXT nullable, không
FK). Cho nên khi nào port sang Google thì **đừng copy 1:1**: cấu trúc đích chặt
hơn, backfill của Google gần như miễn phí, trong khi của Apple thì không.

**Đề xuất:** arc này **chỉ làm Apple**, và ghi lại Google như backlog item đã
biết. Nếu Manager muốn làm cả hai thì nói ngay từ bây giờ — thiết kế không đổi,
nhưng khối lượng gần gấp đôi và Google cần census riêng.

### 0.7 `asc_accounts` — lấy id/name ra sao, tiền lệ nào đã có

**Bảng** `public.asc_accounts` (`20260407000000_create_asc_accounts.sql`):

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | **TEXT PK** | slug người đặt, vd `"vng"`, `"vngsing"` — **không phải UUID** |
| `name` | TEXT | tên hiển thị, vd `"VNG Corp"` |
| `key_id`, `issuer_id` | TEXT | không bí mật |
| `private_key_enc` | TEXT | AES-256-GCM |
| `is_active` | BOOLEAN | soft delete |

**Cách đọc trong code** (đừng query thẳng, đã có repository):

| Hàm | File | Dùng khi |
|---|---|---|
| `findAllAccounts()` | `lib/asc-account-repository.ts:78` | cần cả credential (server) |
| `findAllAccountsPublic()` | cùng file | **chỉ id/name/keyId — dùng cho UI** |
| `findAccountById(id)` | | |
| `getActiveAccount()` | `lib/get-active-account.ts:22` | account đang chọn ở AccountSwitcher (đọc `session.activeAccountId`, fallback account đầu tiên) |

Cache in-memory 5 phút (`CACHE_TTL_MS`), `invalidateAccountCache()` khi sửa.

**Tiền lệ "chọn account rồi làm gì đó" — có 3, và chúng KHÔNG giống nhau:**

| # | Surface | Mô hình | File |
|---|---|---|---|
| **A** | **Settings → API Key Pool** | **liệt kê TOÀN BỘ account, nhóm theo account, + `<select>` "— Chọn account —" trong form Add** | `settings/key-pool/KeyPoolClient.tsx:335, 488-501` |
| B | Settings → Pricing Templates → tab Per-App | **bám account đang active**: `GET /api/iap-management/asc-apps` → `getActiveAccount()` | `PerAppTemplateTab.tsx:56-83` |
| C | TopNav AccountSwitcher | đổi `session.activeAccountId`, ẩn khi chỉ có 1 account | `components/layout/AccountSwitcher.tsx` |

⚠ **A chính là phương án (i) của câu hỏi 1.3, và nó ĐÃ SHIP, ĐÃ QUA UAT, nằm
ngay tab kế bên** (`SettingsTabs`: Pricing Tiers · Hub Tracking · API Key Pool).
Key Pool còn cố ý **hiển thị cả account chưa có key nào**, với lý do viết thẳng
trong code:

> *"The account is still listed. Hiding it would make 'no pool key'
> indistinguishable from 'account does not exist', and the first is the normal
> state for most accounts."*

Đó là lập luận áp dụng nguyên si cho "account chưa có Default Template".

---

## P1 — CÂU HỎI CHO MANAGER (đóng khung — chưa tự chốt)

### 1.1 Template GLOBAL hiện có xử lý thế nào?

⚠ **Câu trả lời phụ thuộc số Q1 + Q2 của census.** Ba lựa chọn:

| | Phương án | Dữ liệu production | IAP đang dùng `DEFAULT_TEMPLATE` | Migration cần gì |
|---|---|---|---|---|
| **(a)** | **Bỏ hẳn GLOBAL** | dòng GLOBAL + toàn bộ entry bị xoá | ⚠ **MẤT nguồn giá** cho đến khi account tương ứng upload lại. Orchestrator không nổ — nó `console.warn` rồi **âm thầm rơi về APPLE** (`pricing-orchestration.ts:424-430`), tức giá ra khác mà không ai được báo | 1 migration xoá; **Manager phải upload lại cho từng account TRƯỚC khi deploy** |
| **(b)** | **Giữ làm fallback** khi account chưa có template | không mất gì | không mất nguồn giá | migration chỉ thêm cột/giá trị; **rẻ nhất, rủi ro thấp nhất** |
| **(c)** | **Nhân bản thành template của cả N account rồi bỏ GLOBAL** | N × (số entry GLOBAL) dòng mới. Nếu GLOBAL có 16.800 entry × 3 account = ~50k dòng | không mất nguồn giá, hành vi **giống hệt hôm nay** ngay sau migrate | 1 migration `INSERT … SELECT` nhân bản + xoá GLOBAL. ⚠ **N lấy từ Q4**, và **app NULL account (Q5) không thuộc N nào** |

**Ý kiến của tôi (chưa chốt):** **(b)** nếu Q2 > 0, **(c)** nếu Manager muốn
"mỗi account tự chịu trách nhiệm" một cách sạch sẽ và Q1 cho thấy GLOBAL không
quá lớn. **(a) chỉ an toàn khi Q2 = 0.**

⚠ **Bẫy chung cho cả (a) và (c):** app có `asc_account_id IS NULL` (Q5) không
map được về account nào → sau migrate chúng **không có Default Template**, và
lại rơi im lặng về APPLE. Bất kỳ phương án nào bỏ GLOBAL đều phải kèm **backfill
`apps.asc_account_id`** hoặc giữ một fallback.

### 1.2 Chuỗi phân giải mới?

| | Chuỗi | Hệ quả |
|---|---|---|
| **(i)** | `app → account → global → Apple` | Có lưới an toàn: account chưa upload thì vẫn có giá cũ. **Bắt buộc nếu chọn 1.1(b).** Đổi lại: 4 tầng, khó giải thích "vì sao giá này ra từ đâu", và template GLOBAL sống mãi như một cái bóng |
| **(ii)** | `app → account → Apple` | Sạch, đúng ý "mỗi account tự lo". Đổi lại: **account quên upload = im lặng rơi về Apple auto-equalize**. Ghép với 1.1(a)/(c) |

⚠ Dù chọn gì, tôi đề nghị **kèm 1 việc bắt buộc**: khi rơi tầng vì thiếu
template, hiện tại chỉ có `console.warn`. Nên **nâng thành outcome nhìn thấy
được** trong audit + UI (badge "nguồn giá đã rơi về Apple"). Đây là KB "status
principle" — trạng thái phải phản ánh chuyện thật sự xảy ra.

### 1.3 UI: dropdown chọn account, hay bám AccountSwitcher?

| | Phương án | Ưu | Nhược |
|---|---|---|---|
| **(i)** | **Dropdown chọn account ngay trong tab Default** | Thấy **tất cả** account trong 1 màn — biết ngay account nào **chưa** có template (chính là điều Manager sẽ muốn kiểm tra nhất). **Có tiền lệ đã ship: Settings → API Key Pool, tab kế bên, cùng `SettingsTabs`.** Không phải rời trang để so sánh | Thêm 1 control; page server phải nạp danh sách account |
| **(ii)** | **Bám account đang active ở AccountSwitcher** | Rẻ hơn: `getActiveAccount()` đã có sẵn; đúng mô hình tab Per-App đang dùng | Phải **đổi account rồi quay lại** mới xem được template khác → không bao giờ thấy toàn cảnh. ⚠ Nặng hơn: **AccountSwitcher tự ẩn khi chỉ có 1 account** (`AccountSwitcher.tsx:51`) — nếu sau này còn 1 account thì màn hình mất luôn chỉ báo "đang xem account nào" |

**Đề xuất (chờ chốt):** **(i)**, vì tiền lệ Key Pool đã trả sẵn chi phí thiết
kế và vì "account nào chưa có template" là câu hỏi vận hành số một. Nếu Manager
chọn (ii) thì **bắt buộc** phải in tên account thật to trong tab Default, không
được dựa vào AccountSwitcher (nó có thể ẩn).

### 1.4 `pricing_source`: cần giá trị mới hay giữ nguyên nghĩa?

| | Phương án | Chi phí | Đánh đổi |
|---|---|---|---|
| **(A)** | **Giữ `'DEFAULT_TEMPLATE'`**, đổi *nghĩa* thành "template mặc định **của account này**" | **0 migration enum · 0 N-layer cascade · 0 file trong bảng §0.3 phải sửa** | ⚠ **Nghĩa của dữ liệu cũ đổi**: dòng IAP ghi `DEFAULT_TEMPLATE` từ tháng 5/2026 nghĩa là "template dùng chung", đọc lại hôm nay sẽ hiểu thành "template của account X". Không có cách phân biệt hai thứ **hồi tố**. Nhãn UI cũng nên đổi ("Default Template" → "Default Template của account") |
| **(B)** | **Thêm `'ACCOUNT_TEMPLATE'`** thành 4 nguồn | **2 CHECK constraint + 3 bản type chép tay + 3 zod + 4 route + 6 điểm UI + ~9 file test** (bảng §0.3) | Dữ liệu cũ giữ nguyên nghĩa; UI có 4 radio. Nhưng khi đó `DEFAULT_TEMPLATE` là gì? Nếu 1.1 bỏ GLOBAL thì nó thành **giá trị chết** — enum có một nhánh không ai chọn được nữa, chỉ tồn tại vì dữ liệu cũ |

**Đề xuất (chờ chốt): (A).** Lý do không chỉ là rẻ: nếu Manager chọn 1.1(a)
hoặc 1.1(c) — tức GLOBAL biến mất — thì `ACCOUNT_TEMPLATE` và `DEFAULT_TEMPLATE`
sẽ **không bao giờ cùng tồn tại**, và thêm giá trị thứ 4 chỉ để phân biệt hai
thứ mà người dùng không còn chọn được cả hai là **chia đôi enum để mô tả một
khái niệm**. Chỉ chọn (B) khi 1.1(b) được chốt **và** Manager thật sự cần đọc
lại lịch sử phân biệt "giá này ra từ template chung hay template account".

⚠ Nếu chọn (B): nhớ **cột thứ hai** `custom_prices_baseline_pricing_source`
(migration `20260812000000`) — cùng CHECK, cùng tập giá trị, rất dễ quên.

---

## P2 — THIẾT KẾ (3 phương án)

> Cả 3 đều **forward-only** (invariant #7) và đều chạy tay theo **Path G** —
> Manager chạy SQL trong Supabase SQL Editor, code **không push** cho tới khi
> Manager xác nhận SQL đã chạy + verify query pass.

### Phương án 1 — `scope_type='ACCOUNT'` + giữ nguyên enum `pricing_source` ⭐ ĐỀ XUẤT

**Schema đổi gì**

```sql
-- 1. Cột account (TEXT — asc_accounts.id là TEXT, và cross-schema FK bị cấm
--    bởi invariant #9, giống hệt cách apps.asc_account_id đã làm).
ALTER TABLE iap_mgmt.price_tier_templates
  ADD COLUMN IF NOT EXISTS scope_account_id TEXT;

-- 2. Mở CHECK scope_type — DROP/ADD, additive, giữ nguyên 2 giá trị cũ.
ALTER TABLE iap_mgmt.price_tier_templates
  DROP CONSTRAINT IF EXISTS price_tier_templates_scope_type_check;
ALTER TABLE iap_mgmt.price_tier_templates
  ADD CONSTRAINT price_tier_templates_scope_type_check
  CHECK (scope_type IN ('GLOBAL', 'APP', 'ACCOUNT'));

-- 3. CHECK coherence (constraint bảng, phải DROP tên cũ rồi ADD lại).
ALTER TABLE iap_mgmt.price_tier_templates
  ADD CONSTRAINT price_tier_templates_scope_coherent_check CHECK (
       (scope_type='GLOBAL'  AND scope_app_id IS NULL     AND scope_account_id IS NULL)
    OR (scope_type='APP'     AND scope_app_id IS NOT NULL AND scope_account_id IS NULL)
    OR (scope_type='ACCOUNT' AND scope_app_id IS NULL     AND scope_account_id IS NOT NULL)
  );

-- 4. Replace-only cho scope mới: tối đa 1 template / account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_iap_mgmt_price_tier_templates_account_unique
  ON iap_mgmt.price_tier_templates(scope_account_id)
  WHERE scope_type = 'ACCOUNT';
```

⚠ **Về gợi ý "additive column thay vì mở CHECK":** ở đây tôi **vẫn đề nghị mở
CHECK**, và lý do là bẫy KB §9 P2 **không áp dụng cho cột này**. P2 nói về
`actions_log.action_type`, nơi writer **nuốt lỗi** nên CHECK thiếu = mất dữ liệu
im lặng. Còn ghi vào `price_tier_templates` đi qua `replaceTemplate`, và nó
**kiểm tra `headerIns.error` rồi throw** (`templates.ts:539-543`) → CHECK thiếu
sẽ làm **upload báo lỗi đỏ ngay trên màn hình**. Không im lặng. Đổi lại,
`scope_type='ACCOUNT'` khiến schema **nói đúng sự thật**, thay vì để
`'GLOBAL'` mang nghĩa "không global" (xem PA-3).

**Migration dữ liệu** — theo lựa chọn 1.1:

- (b) fallback: **không đụng** dòng GLOBAL. Zero-risk.
- (c) nhân bản: `INSERT … SELECT` nhân entry cho từng account trong Q4, rồi
  `DELETE` dòng GLOBAL (CASCADE tự dọn entry). SQL sẽ viết riêng khi Manager chốt N.
- (a) bỏ hẳn: `DELETE FROM iap_mgmt.price_tier_templates WHERE scope_type='GLOBAL'`
  — **chỉ chạy sau khi mọi account đã upload**.

**Chuỗi phân giải:** `APP_TEMPLATE` → `DEFAULT_TEMPLATE` (nay = template của
account đang thao tác, `account_id = creds.id`) → [GLOBAL nếu chọn 1.1(b)] →
Apple.

`creds.id` **đã có sẵn** ở cả 4 call-site dựng `PricingSource`
(`create-on-apple`, `update-on-apple`, `bulk-import/execute`,
`custom-prices/baseline`) — không phải thread thêm gì qua nhiều lớp.

**Số file phải đổi:** ~**20 file sản phẩm** (10 đường đọc GLOBAL ở §0.4 + 4
route dựng source + `templates.ts` + `template-matrix.ts` +
`pricing-orchestration.ts` + `update-orchestration.ts` + 3 file UI Settings +
`PricingSourceSelector` copy) + **1 migration** + **~6 file test**.
**Enum `pricing_source`: 0 file** (đó là điểm mấu chốt).

**Rủi ro với dữ liệu đang chạy**

| Rủi ro | Mức | Xử lý |
|---|---|---|
| Sót 1 trong 10 đường đọc GLOBAL → `.maybeSingle()` gặp N dòng → `PGRST116` throw | 🔴 cao | test cấu trúc: grep `scope_type.*GLOBAL` phải = 0 ngoài lớp fallback |
| App `asc_account_id IS NULL` (Q5) không có account → rơi về Apple **im lặng** | 🔴 cao | 1.1(b) fallback, hoặc backfill trước, **và** nâng cảnh báo thành outcome nhìn thấy |
| Nghĩa dữ liệu `DEFAULT_TEMPLATE` cũ đổi (1.4-A) | 🟡 vừa | ghi vào guide + comment migration |
| Nhân bản (1.1c) làm phình bảng ~N×16.8k dòng | 🟢 thấp | vẫn nhỏ với Postgres; PK đã đúng |

**Test / mutation đề xuất**

1. `templates.test.ts` — `applyScopeFilter` cho ACCOUNT lọc đúng cột; hai
   account khác nhau **không** thấy template của nhau.
2. **Mutation thật:** xoá bộ lọc `scope_account_id` trong `fetchTemplateHeader`
   → test **phải đỏ** (nếu vẫn xanh thì test đang không chứng minh gì).
3. `pricing-orchestration.test.ts` — `DEFAULT_TEMPLATE` gọi
   `getAccountTemplate(<account_id>)` đúng id; account khác không bị đọc nhầm.
4. **Test cấu trúc chống hồi quy §0.4:** quét source, mọi truy cập
   `price_tier_templates` với `scope_type='GLOBAL'` phải nằm trong danh sách
   cho phép (chỉ lớp fallback). Mẫu có sẵn:
   `pool-keys.structural.test.ts`, `custom-prices/structure.test.ts`.
5. Test verify CHECK: insert `scope_type='ACCOUNT'` + `scope_account_id IS NULL`
   phải bị từ chối (chạy trong verify SQL, không phải vitest).

---

### Phương án 2 — `scope_type='ACCOUNT'` + thêm `pricing_source='ACCOUNT_TEMPLATE'`

Giống PA-1 về schema template, **cộng thêm**:

```sql
ALTER TABLE iap_mgmt.iaps DROP CONSTRAINT IF EXISTS iaps_pricing_source_check;
ALTER TABLE iap_mgmt.iaps ADD CONSTRAINT iaps_pricing_source_check
  CHECK (pricing_source IS NULL OR pricing_source IN
    ('APPLE','DEFAULT_TEMPLATE','APP_TEMPLATE','ACCOUNT_TEMPLATE'));

ALTER TABLE iap_mgmt.iaps DROP CONSTRAINT IF EXISTS iaps_custom_prices_baseline_pricing_source_check;
ALTER TABLE iap_mgmt.iaps ADD CONSTRAINT iaps_custom_prices_baseline_pricing_source_check
  CHECK (custom_prices_baseline_pricing_source IS NULL
      OR custom_prices_baseline_pricing_source IN
    ('APPLE','DEFAULT_TEMPLATE','APP_TEMPLATE','ACCOUNT_TEMPLATE'));
```

**Chuỗi phân giải:** `APP_TEMPLATE` → `ACCOUNT_TEMPLATE` → `DEFAULT_TEMPLATE`
(global cũ) → Apple. UI thành **4 radio**.

**Số file:** PA-1 (~20) **+ ~12 file** enum (bảng §0.3: 3 bản type chép tay, 3
zod, 4 route ternary, `iaps.ts` ×2 union, `model.ts`, `repository.ts`,
`BulkImportWizard` + `bulk-import/page.tsx` `Record<PricingSourceKind,…>`,
`UpdateChangesPreviewModal`, `CustomPricesDialog`) **+ ~9 file test**.

**Rủi ro riêng:** đây đúng là hình dạng §4.20/P29 — 3 union chép tay + 2 `Record`
dựng tay, `tsc` **không** báo khi thiếu nhánh (`Record` thiếu key **sẽ** báo,
nhưng ternary chuỗi và zod thì **không**). Phải grep, không tin compiler.
Ngoài ra nếu 1.1 bỏ GLOBAL thì `DEFAULT_TEMPLATE` thành giá trị chết.

**Chỉ chọn PA-2 khi** Manager chốt 1.1(b) **và** cần đọc lịch sử phân biệt
"template chung" vs "template account".

---

### Phương án 3 — không mở CHECK: thêm cột, diễn giải lại `'GLOBAL'`

```sql
ALTER TABLE iap_mgmt.price_tier_templates
  ADD COLUMN IF NOT EXISTS scope_account_id TEXT;

DROP INDEX IF EXISTS iap_mgmt.idx_iap_mgmt_price_tier_templates_global_unique;
CREATE UNIQUE INDEX idx_iap_mgmt_price_tier_templates_global_unique
  ON iap_mgmt.price_tier_templates(scope_account_id)
  WHERE scope_type = 'GLOBAL';         -- NULL-friendly: dòng legacy vẫn sống
```

`scope_type='GLOBAL'` + `scope_account_id = 'vng'` ⇒ "Default của account vng".
Dòng cũ (`scope_account_id IS NULL`) tự nhiên trở thành fallback → **1.1(b) gần
như miễn phí**.

**Ưu:** không đụng CHECK nào; migration ngắn nhất; enum `pricing_source` giữ
nguyên (như PA-1).

**Nhược — và đây là lý do tôi không đề xuất:**

1. **Tên nói dối.** `scope_type='GLOBAL'` mà không global. Mọi người đọc code
   sau này — kể cả Claude ở session sau — sẽ đọc sai. Đúng loại nợ mà CLAUDE.md
   đã dặn ở phần branch-naming: *"a name that lies a little more with every
   commit, and eventually somebody trusts it."*
2. **Partial unique index cũ phải DROP**, không phải chỉ thêm. Trong lúc DROP →
   CREATE, ràng buộc "tối đa 1 GLOBAL" tạm biến mất.
3. **Không phân biệt được** "template account chưa upload" với "template legacy
   dùng chung" bằng `scope_type` — phải luôn kèm `IS NULL` ở mọi query.
4. Phần code phải sửa **gần y hệt PA-1** (10 đường đọc + 4 route) — tiết kiệm
   chỉ đúng ~15 dòng SQL, đổi lấy một cái tên sai vĩnh viễn.

---

### So sánh nhanh

| | PA-1 ⭐ | PA-2 | PA-3 |
|---|---|---|---|
| CHECK `scope_type` | mở (+`ACCOUNT`) | mở (+`ACCOUNT`) | **không đụng** |
| CHECK `pricing_source` ×2 | không đụng | **mở cả 2** | không đụng |
| Số file sản phẩm | ~20 | ~32 | ~20 |
| Số file test | ~6 | ~15 | ~6 |
| Schema tự mô tả đúng | ✅ | ✅ | ❌ |
| Nghĩa dữ liệu cũ | đổi (1.4-A) | giữ | đổi |
| Rủi ro chính | sót đường đọc GLOBAL | + N-layer cascade | tên sai vĩnh viễn |

---

## P3 — MOCKUP

📄 `docs/iap-management/design/account-default-template-mockup.html`

Bám khuôn mockup-first Cycle 31 (`pool-key-management-mockup.html`): Tailwind
CDN, `.state-shell` mỗi trạng thái, palette `#0071E3`, chú thích tiếng Việt.

Các trạng thái vẽ:

1. **Có template** — account đang xem, stat card, bảng tier.
2. **Chưa có template** — empty state của **account này**, kèm chỉ báo account
   khác đã có (câu hỏi vận hành số một).
3. **Đang upload** — nút spinner, cảnh báo replace-only.
4. **Thanh account** — tất cả account, đánh dấu account nào có/không có
   template (phương án 1.3-i), cùng biến thể 1.3-ii để so sánh trực tiếp.
5. **Modal ghi đè** — bê từ tab Per-App sang (hiện tab Default chưa có).

---

## CHECKPOINT

⏸ **DỪNG — chờ Manager:**
1. Chạy `docs/iap-management/queries/census-account-default-template.sql`, gửi
   lại kết quả (đặc biệt **Q2** và **Q5**).
2. Chốt **1.1** (GLOBAL: bỏ / fallback / nhân bản).
3. Chốt **1.2** (chuỗi phân giải), **1.3** (UI), **1.4** (enum).
4. Review mockup.

Sau khi có 4 mục trên: chốt phương án, viết migration + verify SQL, gửi Manager
chạy tay (Path G), rồi mới code. **Không push cho tới khi Manager xác nhận SQL
đã chạy và verify query pass.**
