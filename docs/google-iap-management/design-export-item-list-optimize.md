# Export Item List — tối ưu (arc G-EXPORT) · CENSUS + THIẾT KẾ

**Trạng thái:** census xong, thiết kế xong, **CHƯA CODE**. Chờ Manager chốt
9 câu ở §5.
**Nhánh:** `arc-google-export-item-optimize` (cắt ở ranh giới arc,
`rev-list HEAD...origin/main` = `0 0`, nhánh cũ `arc-google-account-default-template`
xoá bằng `-d`).
**Ngày:** 2026-08-31.

Ba yêu cầu Manager:

| | Yêu cầu |
|---|---|
| **R1** | Export item phải cho **chọn item** và **lọc theo trạng thái** Active/Inactive |
| **R2** | Kiểm chứng danh sách **183 country** — của Google hay tool tự dựng? |
| **R3** | Header cột country: từ mã ISO → **"Country name (country code)"** |

---

## P1 — R2: câu chặn cửa. **NGHI VẤN CỦA MANAGER LÀ ĐÚNG.**

### 1.0 Kết luận trước, chứng cứ sau

> ### ⚠ Danh sách 183 KHÔNG PHẢI của Google.
> Nó là `TERRITORY_CATALOG` — hằng nằm trong **module APPLE**
> ([`lib/iap-management/territory-catalog.ts:364`](../../lib/iap-management/territory-catalog.ts#L364)) —
> và bản thân nó cũng **không phải lấy từ Apple**: 183 dòng `{code, currency, region}`
> gõ tay, tên nước phân giải bằng `i18n-iso-countries`.
>
> **Code tự nói ra điều này.** Docblock của dialog dùng chung, nguyên văn:
> ```
> ⚠ THE TWO STORES DO NOT SELL TO THE SAME PLACES …
> Apple passes its own 175 … Google passes nothing and keeps all 183.
> ```
> — [`components/iap-management/ExportOptionsDialog.tsx:52-56`](../../components/iap-management/ExportOptionsDialog.tsx#L52-L56)

Nhưng có một **phân biệt then chốt** mà nếu bỏ qua sẽ thiết kế sai:

| Bề mặt | Nguồn danh sách | Của ai |
|---|---|---|
| **Dialog "Export options"** (chỗ Manager thấy 183) | `TERRITORY_CATALOG` (Apple module) | ❌ **KHÔNG phải Google** |
| **Cột trong FILE .xlsx** | `Object.keys(product.prices)` — union region **Google trả về live** | ✅ **Là Google thật** |

Tức là: **danh sách để TICK sai nguồn; danh sách CỘT trong file thì đúng nguồn.**
Hai chỗ khác nhau và phải sửa khác nhau.

### 1.1 Trace đủ chuỗi — header cột country trong file đến từ đâu

```
components/google-iap-management/iap-list/IapListClient.tsx:607   <ExportOptionsDialog … />   ← 3 props, KHÔNG truyền `catalog`
         └─ components/iap-management/ExportOptionsDialog.tsx:81  catalog = TERRITORY_CATALOG  ← DEFAULT = Apple module, 183
              └─ lib/iap-management/territory-catalog.ts:364      TERRITORY_CATALOG = buildCatalog()
                   └─ …:340-357                                   buildCatalog() ← RAW[] gõ tay (183 dòng)
                        └─ …:337-339                              resolveName() ← i18n-iso-countries
         │
         └─ onExport(codes | null)
              └─ IapListClient.tsx:169-180   POST /export  body { territories }
                   └─ app/api/…/export/route.ts:82,91      → buildExportPlan(products, territories)
                        └─ lib/google-iap-management/xlsx-export.ts:112-129
                             territorySet ← Object.keys(row.prices)   ← ⚠ GOOGLE LIVE
                             territories  ← allTerritories ∩ selection
                        └─ …:144   headerRow1.push(`Price in ${t}`)   ← ⚠ MÃ TRẦN, đây là chỗ R3 sửa
```

**Chốt:**
- Chuỗi ký tự trong header hiện tại là **`Price in <mã>`** —
  [`xlsx-export.ts:144`](../../lib/google-iap-management/xlsx-export.ts#L144).
- `<mã>` là key của `product.prices`, mà key đó do adapter đặt từ
  `regionalPricingAndAvailabilityConfigs[].regionCode` của Google —
  [`onetime-product-adapter.ts:171-180`](../../lib/google-iap-management/google/onetime-product-adapter.ts#L171-L180).
  **Là mã Google, không phải mã catalog.**
- Còn **183** là con số của **dialog**, không phải của file. Số cột trong file
  = số region có giá thật (∩ selection). Hai con số này chưa từng được đối chiếu.
  ⇒ **Q1/Q3 của SQL census** trả lời.

### 1.2 grep: phía Google có import gì từ module Apple không?

Chạy: `grep -rn "<symbol>" --include='*.ts' --include='*.tsx' app lib components`

| Symbol | Hit trong `lib/google-iap-management/` hoặc `app/api/google-iap-management/` | Ghi chú |
|---|---|---|
| `TERRITORY_CATALOG` | **0 import.** 1 hit **comment** tại [`xlsx-template-matrix-export.ts:45`](../../lib/google-iap-management/xlsx-template-matrix-export.ts#L45) — là câu **CẤM dùng**, không phải dùng | — |
| `ALL_TERRITORY_CODES` | 0 | — |
| `toCatalogCode` | **0 import.** 1 hit comment cùng chỗ (`xlsx-template-matrix-export.ts:45`) | — |
| `territoryName` | **0 import.** 1 hit comment (`xlsx-template-matrix-export.ts:46`) | — |
| `apple-territories.snapshot` | **0 import.** 1 hit comment cùng chỗ | — |
| `toAlpha2` | 0 | chỉ tồn tại trong `lib/iap-management/xlsx-export.ts` |
| `toAppleCode` | 0 | — |

`grep -rn "iap-management" … lib/google-iap-management app/api/google-iap-management app/(dashboard)/google-iap-management components/google-iap-management | grep -v google-iap-management | grep -E "import|from"` → **0 hit.**

> ### ⚠ PHÁT HIỆN CHÍNH — và nó KHÔNG nằm ở chỗ grep thường soi
> **Tầng `lib/` + `app/api/` của Google SẠCH.** Không một import Apple nào.
> Rò rỉ nằm **duy nhất ở tầng UI**, và là một **import trực tiếp component**,
> không phải import hằng:
>
> ```
> components/google-iap-management/iap-list/IapListClient.tsx:35
>   import { ExportOptionsDialog } from "@/components/iap-management/ExportOptionsDialog";
> ```
>
> Dialog này **mặc định** `catalog = TERRITORY_CATALOG`
> ([ExportOptionsDialog.tsx:81](../../components/iap-management/ExportOptionsDialog.tsx#L81)),
> và Google gọi nó với **đúng 3 prop**, không truyền `catalog`
> ([IapListClient.tsx:607-611](../../components/google-iap-management/iap-list/IapListClient.tsx#L607-L611)).
>
> ⚠ **Vì thế mọi grep tìm tên HẰNG ở phía Google đều ra 0 hit và kết luận
> "Google không dùng đồ Apple" — kết luận đó sai.** Sự phụ thuộc đi qua
> *default parameter của một component dùng chung*. Đây là biến thể mới của
> P1 twin-path: không phải hai đường code, mà **một đường code với một
> default vô hình**.

### 1.3 Google có nguồn region riêng không? — **CÓ, ba nguồn, và một trong đó là chính tắc**

| # | Nguồn | Là gì | Có phải nguồn danh sách export không |
|---|---|---|---|
| 1 | [`regions.ts:19-50`](../../lib/google-iap-management/regions.ts#L19-L50) `COMMON_REGIONS` | **30 entry** gõ tay, docblock tự khai "curated subset … v1" | ❌ Không. Quá thiếu. |
| 2 | [`region-name.ts:84-94`](../../lib/google-iap-management/region-name.ts#L84-L94) `getAllRegions()` | **~250 mã ISO 3166-1** từ `i18n-iso-countries`, **KHÔNG có currency**, gồm cả nước Google không bán | ❌ Không. Quá thừa, và thiếu currency. |
| 3 | [`region-continent.ts`](../../lib/google-iap-management/region-continent.ts) | Bảng alpha-2 → 5 bucket châu lục (109 dòng), **chỉ để lọc pill trên màn ma trận** | ❌ Không. Không phải danh sách bán hàng. Census cũ ghi "243 mã" — con số đó nói về `i18n-iso-countries`, không phải file này. |
| 4 | **[`app/api/google-iap-management/regions/catalog/route.ts`](../../app/api/google-iap-management/regions/catalog/route.ts)** | **⭐ ĐƯỜNG CHÍNH TẮC ĐÃ CÓ SẴN.** Gọi `monetization.convertRegionPrices` → trả `{regionCode, currency}[]` = **đúng tập region Google hỗ trợ, kèm currency Google tính tiền** | ✅ **CÓ. Đây là câu trả lời.** |

**Bảng DB lưu region của Google:** có, nhưng là **hệ quả** chứ không phải nguồn —
`google_iap_mgmt.iap_prices.region_code`
([migration:184-193](../../supabase/migrations/20260520010000_google_iap_mgmt_init.sql#L184-L193))
và `pricing_template_entries`. Đây là tập region **đã có sản phẩm đặt giá**, là
**tập con** của tập Google hỗ trợ. Không thể dùng thay.

**Route #4 đã có auth, đã có 4 caller đang chạy production**
(`IapForm.tsx:428`, `CustomPricesDialog.tsx:157`). Docblock của nó nói thẳng vì
sao nó tồn tại — và mô tả đúng cái lỗ hổng R2 đang hỏi:

> WHY THIS EXISTS: the custom-prices dialog must list every country Google
> sells in … and the tool has no such list locally.
> — [regions/catalog/route.ts:7-9](../../app/api/google-iap-management/regions/catalog/route.ts#L7-L9)

⚠ **Nghịch lý cần Manager biết:** dialog custom-prices đã dùng danh sách Google
thật từ 2026; dialog export **cùng lúc đó** vẫn dùng 183 của Apple. Hai dialog,
hai nguồn, trong cùng một module.

### 1.4 So ba tập

| Tập | Con số | Đo được chưa |
|---|---|---|
| A — đang dùng ở dialog export | **183** (đếm máy: `grep -c '^  { code: "'` = 183; test Apple ghim `catalog.size === 183`) | ✅ đo rồi |
| B — region Google **THẬT** | ❓ | ❌ **chưa ai đo** — cần phép đo M1 (§1.5) |
| C — region trong **dữ liệu production** | ❓ | ❌ cần Manager chạy SQL |

**SQL cho tập C đã viết:**
[`docs/google-iap-management/queries/census-google-export-item-list.sql`](queries/census-google-export-item-list.sql)
— Q1 (đếm), Q2 (liệt kê + currency), **Q3 (so A ↔ C, in ra `only_in_catalog` và
`only_in_data`)**. Read-only, mỗi query có dòng KỲ VỌNG.

⚠ **Q3 `only_in_data` là cột quan trọng nhất trong toàn bộ census này.** Mã nào
xuất hiện ở đó là mã Google **đang dùng thật** mà Manager **không tick được**
trong dialog — đúng lớp lỗi `[EXPORT-catalog-missing-11]` bên Apple, nhưng ở
Google thì chưa ai biết nó có tồn tại không.

### 1.5 `[GOOGLE-regions-unmeasured]` — arc này có cần không?

**CÓ, nhưng chỉ cần cho R2, và không chặn R1/R3.**

- R1 (chọn item + lọc trạng thái): **không cần**. Không đụng region.
- R3 (tên nước): **không cần**. Sửa cách hiển thị mã, không sửa tập mã.
- R2 (kiểm chứng 183): **cần**. Không có B thì chỉ nói được "183 sai nguồn",
  không nói được "sai bao nhiêu và sai chỗ nào".

**PHÉP ĐO M1 — trình Manager duyệt, KHÔNG tự chạy**

| | |
|---|---|
| **Cách rẻ nhất** | `GET /api/google-iap-management/regions/catalog?packageName=<package đã cache>` |
| **Số request Google** | **ĐÚNG 1** — route gọi đúng một lần `convertRegionPrices` ([regions-helper.ts:85](../../lib/google-iap-management/google/regions-helper.ts#L85)) |
| **Ghi gì không** | **Không.** Read-only tuyệt đối, route không có INSERT/UPDATE. Không cache (cố ý — docblock dòng 20-25). |
| **Cần gì** | Session đăng nhập + 1 Google Console account đã verified + 1 package đã cache. Chạy bằng trình duyệt đang đăng nhập, dán URL. |
| **Trả về** | `{ regions: [{regionCode, currency}, …], regionsVersion }` |
| **Ai chạy** | **Manager** — cần credential production. |
| **Rủi ro** | Gần như không. Rủi ro duy nhất: tiêu 1 quota request. |

Kết quả M1 + Q3 khép kín được phép so ba tập, và đồng thời **đóng luôn**
`[GOOGLE-regions-unmeasured]` — mục đang chặn 2 việc khác:
"P8 gate on any catalog widening" và "any Google equivalent of
`[Q-EXPORT.apple-only-picker]`" ([TODO.md:668](../../TODO.md)).

⚠ **Đừng đọc `[GOOGLE-regions-unmeasured]` trong BACKLOG.md là "KHÔNG ĐỌC ĐƯỢC".**
Dòng đó ([BACKLOG.md:76-77](BACKLOG.md)) viết ở thời điểm tag chưa có trong repo;
nay TODO.md:666-668 đã có mô tả đầy đủ. Census này cập nhật lại.

---

## P2 — R1: chọn item + lọc trạng thái

### 2.1 Đường export hiện tại

| | |
|---|---|
| **Nút** | "Export list" — [IapListClient.tsx:320-327](../../components/google-iap-management/iap-list/IapListClient.tsx#L320-L327), màn `/google-iap-management/apps/[packageName]` |
| **Mở** | `ExportOptionsDialog` (chọn nước) → `handleConfirmExport` ([:169](../../components/google-iap-management/iap-list/IapListClient.tsx#L169)) |
| **Route** | `POST /api/google-iap-management/apps/[packageName]/export` |
| **Lấy dữ liệu từ đâu** | **LIVE từ Google**, không đọc mirror: `listInAppProducts(jwt, packageName)` ([route.ts:90](../../app/api/google-iap-management/apps/[packageName]/export/route.ts#L90)) |
| **Phân trang** | Có, trong `newListOneTimeProducts` ([publisher-client.ts:105-128](../../lib/google-iap-management/google/publisher-client.ts#L105-L128)): `pageSize = 1000`, đi theo `nextPageToken`, cap 100 trang |
| **Chi phí Google mỗi lần export** | ⭐ **1 request** cho app dưới 1000 item. Trần IAP/app của Google là 1000 ⇒ **thực tế luôn là 1**. (Nếu API mới lỗi → fallback legacy, cũng 1 request phân trang.) |

> ### ⚠ ĐÂY LÀ CHỖ TUYỆT ĐỐI KHÔNG ĐƯỢC PORT 1:1 TỪ APPLE
> Bên Apple, export tốn **~3 request MỖI ITEM** (`REQUESTS_PER_ITEM = 3`,
> [ExportItemWizard.tsx:91](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L91)),
> nên "chọn item" ở Apple là **tính năng tiết kiệm tiền** — design doc Apple
> gọi đó là acceptance criterion số một.
>
> **Bên Google, chọn item tiết kiệm ĐÚNG 0 REQUEST.** List luôn là 1 call trả
> về toàn bộ app. Giá trị của R1 ở Google **hoàn toàn khác**: nó thu hẹp
> **FILE** (ít dòng, và ít cột hơn vì union region hẹp lại), không thu hẹp
> **CHI PHÍ**.
>
> ⇒ Mọi copy UI kiểu "ước tính ~N request" của Apple **phải bỏ**, không port.
> Ghi một con số chi phí sai còn tệ hơn không ghi.

### 2.2 "Active/Inactive" ở Google là gì trong DỮ LIỆU THẬT

**Ba tầng, và chúng KHÔNG bằng nhau:**

| Tầng | Chỗ | Giá trị |
|---|---|---|
| **Google API** | `OneTimeProduct.purchaseOptions[i].state` | `string` — googleapis 171.4.0 khai `state?: string \| null`, **không enum hoá** ([v3.d.ts](../../node_modules/googleapis/build/src/apis/androidpublisher/v3.d.ts), "Output only. The state of the purchase option"). Code tool biết ít nhất: `ACTIVE`, `INACTIVE_PUBLISHED`; docblock adapter còn nhắc `DRAFT` ([adapter:16-19](../../lib/google-iap-management/google/onetime-product-adapter.ts#L16-L19)) |
| **Tool (adapter)** | `mapStateToStatus` [adapter:117-122](../../lib/google-iap-management/google/onetime-product-adapter.ts#L117-L122) | `ACTIVE` **hoặc** `INACTIVE_PUBLISHED` → `"active"`; **mọi thứ khác** → `"inactive"` |
| **Mirror DB** | `google_iap_mgmt.iaps.status` [migration:134-136](../../supabase/migrations/20260520010000_google_iap_mgmt_init.sql#L134-L136) | `TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'))`, có index `idx_google_iap_mgmt_iaps_status` |

> ### ⚠ CÂU MANAGER PHẢI BIẾT TRƯỚC KHI CHỐT FILTER
> `"active"` của tool **gộp hai state khác nhau của Google**:
> ```ts
> if (state === "ACTIVE" || state === "INACTIVE_PUBLISHED") return "active";
> ```
> Cái tên `INACTIVE_PUBLISHED` tự nó đã mâu thuẫn với nhãn `active`.
> Đây đúng là **"the status principle"** trong KB §9 P5: một status hiển thị
> phải phản ánh kết quả thật, không phải nhãn tiện tay.
>
> ⚠ **KHÔNG ĐỌC ĐƯỢC — cần Manager / cần đo:** vì sao `INACTIVE_PUBLISHED`
> được xếp vào `active`, và Google Play Console hiển thị state đó là gì.
> Không có comment nào trong repo giải thích, và googleapis không enum hoá.
> Grep toàn repo `INACTIVE_PUBLISHED` → chỉ 1 hit, chính dòng code đó.

**Có mirror không:** ✅ có. `iaps.status` được ghi mỗi lần Refresh. Q4 của SQL
đếm phân bố thật.

**⚠ Mirror vs LIVE — điểm lệch mà thiết kế phải xử:** picker đọc **mirror**
(`initialIaps`, [page.tsx:49](../../app/(dashboard)/google-iap-management/apps/[packageName]/page.tsx#L49)),
export đọc **LIVE**. Nếu ai đó đổi status trên Play Console sau lần Refresh
cuối, filter và file sẽ **không khớp**: Manager lọc "Active" được 10 item,
file ra 9 dòng Active + 1 dòng Inactive.

**Ba lựa chọn cho Manager (§5, Q-R1.2) — KHÔNG tự chọn:**

| Phương án | Lọc ở đâu | Ưu | Nhược |
|---|---|---|---|
| **A** | Lọc **client, trên mirror** | Đơn giản nhất; picker và nút Export nói cùng một con số | File có thể lệch filter khi mirror cũ |
| **B** | Gửi `statusFilter` xuống route, lọc **server trên kết quả LIVE** | File **luôn** đúng filter; vẫn **0 request thêm** (route đã có dữ liệu live trong tay) | Số dòng file có thể ≠ số item picker hiển thị ⇒ **phải công bố độ lệch**, không im lặng |
| **C** | Cả hai: picker lọc mirror để chọn, route lọc lại live để đảm bảo | Đúng nhất | Phức tạp nhất; vẫn phải công bố lệch |

**Đề xuất: B + công bố.** Lý do: file là hiện vật Manager gửi đi, nó phải đúng
với chính nó. Kèm theo, response trả thêm header `X-Export-Filtered-Out` để UI
nói thẳng "3 item bạn chọn đã đổi trạng thái trên Google, không nằm trong file"
— **im lặng bỏ là lớp lỗi arc này đang đi gỡ.**

### 2.3 Filter có tốn request Google không?

**KHÔNG — 0 request, cho cả ba phương án.**

- Picker đọc `initialIaps`, là prop **đã có sẵn** từ server component, nguồn
  `listIapsWithDefaultLocale(app.id)` = DB mirror
  ([page.tsx:49](../../app/(dashboard)/google-iap-management/apps/[packageName]/page.tsx#L49)).
  Đổi filter = lọc mảng trong RAM.
- Nếu chọn phương án B, route lọc trên `products` **đã fetch xong** — không
  gọi thêm.

⇒ **Khoá được lock kiểu Apple: "đổi filter = 0 request Google".** Và ở Google
lock này **mạnh hơn** Apple: kể cả bấm Export cũng vẫn chỉ 1 request, bất kể
chọn 1 item hay 500.

### 2.4 Picker chọn item — đã có sẵn cơ chế chưa?

**Bảng danh sách chính: KHÔNG có checkbox.**
[IapListClient.tsx:438-478](../../components/google-iap-management/iap-list/IapListClient.tsx#L438-L478)
— 6 cột `Name · SKU · Price · Status · Type · Last synced`, không cột chọn.

**Nhưng `BulkStatusModal` ĐÃ CÓ một picker Google-native:**
[BulkStatusModal.tsx](../../components/google-iap-management/iap-list/BulkStatusModal.tsx) (743 dòng)

| Đã có | Chưa có |
|---|---|
| ✅ Checkbox từng dòng (`toggleOne`, :243) | ❌ Ô search |
| ✅ "Select all (N)" (`toggleAll`, :252) | ❌ Windowing / "Show more" |
| ✅ Đếm "N selected" (:589) | ❌ Tách thành component dùng lại được — nó là `SelectionList` **nội bộ** trong file (:545+) |
| ✅ Lọc theo eligibility = **theo `status`** (`eligible`, :124) | |

⚠ Đáng chú ý: `eligible` của BulkStatusModal **chính là filter Active/Inactive**
mà R1 đang xin — chỉ khác là nó bị buộc cứng vào mode (activate ⇒ lấy
`inactive`; deactivate ⇒ lấy `active`).

**Chi phí dựng picker cho export — hai hướng:**

| Hướng | Việc | Rủi ro |
|---|---|---|
| **T1 — tách `SelectionList` ra component chung trong module Google** | Rút :545-620 ra `components/google-iap-management/iap-list/ItemSelectionList.tsx`, thêm slot cho search + filter chip; BulkStatusModal dùng lại nguyên hành vi | ⚠ Đụng đường ghi đang chạy production (bulk activate/deactivate). Cần parity gate chứng minh BulkStatusModal **không đổi hành vi** |
| **T2 — viết picker riêng cho export, không đụng BulkStatusModal** | An toàn tuyệt đối cho đường ghi | ⚠ **P1 twin-path**: hai danh sách chọn item trong cùng một màn, hai luật "select all", trôi xa nhau ở lần sửa đầu tiên. Đúng cái bẫy `BulkItemPicker` bên Apple được viết ra để tránh |

**Đề xuất: T1.** Nhưng phụ thuộc **Q5 của SQL** (quy mô): nếu app lớn nhất
> ~60 item thì search + windowing là bắt buộc, và khi đó T1 phải thêm cả hai
vào `SelectionList` — tức đụng BulkStatusModal nhiều hơn. Chốt sau khi có số.

**⚠ Lock P8 — kiểm lại, còn đúng:**
`ExportOptionsDialog` **vẫn dùng chung** hai module. Bằng chứng: import ở cả
[Google IapListClient.tsx:35](../../components/google-iap-management/iap-list/IapListClient.tsx#L35)
và [Apple ExportItemWizard.tsx:73](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L73).
Arc G2/G3 phía Apple **không phá lock**: nó thêm prop tuỳ chọn `catalog`
(mặc định = hành vi cũ) rồi truyền `APPLE_TERRITORY_CATALOG` từ **ngoài** —
[ExportOptionsDialog.tsx:48-64](../../components/iap-management/ExportOptionsDialog.tsx#L48-L64).

**Arc này CÓ đụng nó** — và đó là cách duy nhất sửa R2 cho Google:
truyền `catalog={<catalog Google>}` từ phía Google, **y hệt cách Apple đã làm**.
Không sửa gì bên trong dialog ⇒ P8 vẫn nguyên.

⚠ Ghi chú lệch tài liệu phát hiện lúc census (**không thuộc arc này, không sửa
ở đây**): docblock `ExportItemWizard.tsx:12` còn viết *"Step 2's territory list
is `TERRITORY_CATALOG`, 183 entries"* — sai từ arc G3, vì dòng 306 truyền
`APPLE_TERRITORY_CATALOG` (175). Đúng lớp `[GUIDE-label-drift]`.

### 2.5 Contract route — hiện nhận gì, thêm gì

**Hiện tại:** `interface ExportRequestBody { territories?: string[] | null }`
([route.ts:47-49](../../app/api/google-iap-management/apps/[packageName]/export/route.ts#L47-L49)).
`territories` không phải mảng ⇒ `null` ⇒ không lọc ([:82](../../app/api/google-iap-management/apps/[packageName]/export/route.ts#L82)).

**Đề xuất thêm:**
```ts
interface ExportRequestBody {
  territories?: string[] | null;
  /** SKU. Vắng/null = mọi item. `[]` = 400. Không rỗng = đúng các SKU này. */
  selectedSkus?: string[] | null;
  /** Vắng/null = mọi trạng thái. */
  statusFilter?: "active" | "inactive" | null;   // ← chỉ nếu Manager chọn PA B/C
}
```

**Bài học Apple — kiểm lại từng cái, và có cái KHÔNG như Manager nhớ:**

| Luật | Apple làm gì | Google **đã** có chưa |
|---|---|---|
| `[]` rỗng → **400**, không hiểu thành "export tất cả" | ✅ [Apple export route:46,144-149](../../app/api/iap-management/apps/[appId]/export/route.ts#L144-L149) | ✅ **ĐÃ CÓ TRONG MODULE GOOGLE** — `matrix-export/route.ts:106` "⚠ MẢNG RỖNG LÀ 400, KHÔNG PHẢI 'XUẤT TẤT CẢ'". Route export item thì **chưa** ⇒ thêm. |
| ID lạ → **409 nêu tên**, không im lặng bỏ | ⚠ **KHÔNG PHẢI ở route export item của Apple.** Route đó cố ý **KHÔNG** validate trước — nó gửi id đi, Apple 404, và id rơi vào **failure sheet** ([:38-44](../../app/api/iap-management/apps/[appId]/export/route.ts)). 409-nêu-tên là của **matrix-export**, một route khác ([Apple matrix-export:174-200](../../app/api/iap-management/pricing-templates/matrix-export/route.ts#L174-L200)) | ✅ **ĐÃ CÓ** ở `matrix-export/route.ts:244-268` phía Google, kèm `unknownRegionCodes`. Route export item **chưa** có gì. |

> ### ⚠ ĐỪNG PORT 409 VÀO ĐƯỜNG NÀY MỘT CÁCH MÁY MÓC
> Hai route giải quyết hai bài toán khác nhau:
> - **matrix-export** đọc từ **DB**, biết chắc tập mã hợp lệ ⇒ so được ⇒ 409.
> - **export item** đọc **LIVE từ Google** ⇒ chỉ biết SKU nào tồn tại **sau
>   khi** đã fetch. Apple chọn: cứ gửi, ai chết thì ghi vào failure sheet,
>   "a visible failure beats an invisible omission".
>
> Ở Google có một điểm khác nữa: `listInAppProducts` trả **toàn bộ** item, nên
> route **thật sự biết** SKU nào lạ ngay sau 1 request. ⇒ **409 khả thi ở
> Google trong khi không khả thi ở Apple.**
> Đây là câu Manager chốt: **Q-R1.4** ở §5.

---

## P3 — R3: tên nước đầy đủ

### 3.1 Tên nước lấy từ đâu

**Google API KHÔNG trả tên nước.** `convertRegionPrices` trả
`{regionCode, price{currencyCode,…}}` — không có trường tên
([regions-helper.ts:86-97](../../lib/google-iap-management/google/regions-helper.ts#L86-L97)).
`OneTimeProduct` cũng chỉ có `regionCode`.

⇒ **Bắt buộc dùng nguồn nội bộ.** Và nguồn đó **đã có sẵn, trong module Google**:

**[`lib/google-iap-management/region-name.ts:63-69`](../../lib/google-iap-management/region-name.ts#L63-L69) — `regionNameFromCode(code)`**
- Nguồn: `i18n-iso-countries` (ISO 3166-1, tiếng Anh)
- Cộng **18 override** khớp nhãn Google Play Console hiển thị thật
  ([:36-55](../../lib/google-iap-management/region-name.ts#L36-L55)):
  `US → United States` (ISO: "United States of America"),
  `KR → South Korea`, `TW → Taiwan`, `VN → Vietnam`, `MO → Macau`, …
- Đã dùng ở màn Edit + ma trận template ⇒ **đổi header export sang nó thì file
  và màn nói cùng một tên**.

> ### ⚠ NÓI RÕ VỚI MANAGER: ĐÂY LÀ TÊN ISO, KHÔNG PHẢI "TÊN CỦA GOOGLE"
> Google không phát hành danh sách tên nước qua API này. 18 override là kết
> quả **đối chiếu tay với Play Console** (docblock ghi "Verified against
> Manager reference Image 2"), không phải dữ liệu Google trả về.
> ⇒ Với các nước **ngoài** 18 override, tên hiển thị là **tên ISO 3166-1**, có
> thể khác chữ Play Console dùng. Ví dụ ISO gọi Bờ Biển Ngà là
> `"Côte d'Ivoire"`. Đây là **hạn chế đã biết**, không phải bug.

### 3.2 Mã Google là alpha-2 — xác nhận

**Code khai (3 chỗ độc lập):**
- [`regions.ts:14`](../../lib/google-iap-management/regions.ts#L14) — `code: string; // ISO 3166-1 alpha-2`
- [`region-name.ts:4-5`](../../lib/google-iap-management/region-name.ts#L4-L5) — "Google Play uses ISO 3166-1 alpha-2 country codes in InAppProduct.prices"
- [`xlsx-template-matrix-export.ts:46`](../../lib/google-iap-management/xlsx-template-matrix-export.ts#L46) — "Google Play dùng ISO 3166-1 **alpha-2**; Apple dùng **alpha-3** — KB §4.20"

**Dữ liệu thật: CHƯA XÁC NHẬN — cần Manager chạy Q2b.**
Q2b trả về mọi `region_code` không khớp `^[A-Z]{2}$`. **KỲ VỌNG: 0 dòng.**
Một dòng ở đó bác bỏ toàn bộ thiết kế R3.

⚠ Tôi **không** kết luận alpha-2 từ ba comment trên. Ba comment là lời khai của
code, không phải phép đo. Q2b là phép đo.

**Format đích:** `Price in Vietnam (VN)` — bám sát chuỗi hiện tại
`Price in VN` (chỉ chèn tên), và trùng format Apple đã chốt ở E4
(`Price in Thailand (TH)`, [export-column-order.ts:75](../../lib/iap-management/export-column-order.ts#L75)).

### 3.3 Ca tên == mã (không phân giải được)

`regionNameFromCode` rơi về **chính mã in hoa** khi `i18n-iso-countries` không
có entry ([region-name.ts:67-68](../../lib/google-iap-management/region-name.ts#L67-L68)).

**Luật xử — bê nguyên bài học Apple E4:**
```ts
const name = regionNameFromCode(code);
return name !== code ? `Price in ${name} (${code})` : `Price in ${code}`;
```
Tức **rút gọn còn mã trần**, KHÔNG in `XK (XK)`.

> ### ⚠ Ở GOOGLE PHÉP KIỂM ĐƠN GIẢN HƠN APPLE — VÀ ĐÓ LÀ ĐIỀU PHẢI CHỨNG MINH, KHÔNG PHẢI GIẢ ĐỊNH
> Apple phải so **hai** mã (`name !== code && name !== toAppleCode(code)`) vì
> cột dùng alpha-2 còn `territoryName` nói alpha-3 — Kosovo cho ra
> `Price in XKS (XK)`, hai mã cạnh nhau, không mã nào là tên
> ([export-column-order.ts:82-88](../../lib/iap-management/export-column-order.ts#L82-L88)).
>
> **Google không có ca đó**: `regionNameFromCode` nhận alpha-2 và fallback về
> **chính mã alpha-2 đó**, cùng một chuỗi. Nên một phép so là đủ.
> ⚠ Điều kiện: Q2b phải sạch. Nếu Q2b ra dòng nào, luận điểm này sập.

### 3.4 KB §4.20 — không tự viết phép chuyển

✅ **Arc này không cần chuyển mã gì cả.** Google alpha-2 → `regionNameFromCode`
nhận alpha-2 → xong. Không `toAlpha2`, không `toCatalogCode`, không `toAppleCode`.
**Chốt chặn cho chunk sau: nếu thấy mình sắp viết một phép chuyển mã, dừng lại —
nghĩa là đã lấy nhầm nguồn.**

---

## P4 — Đánh giá khả thi, chunk, mockup

### 4.1 Khả thi + chi phí

| YC | Khả thi | Số file đổi | Request Google | Migration |
|---|---|---|---|---|
| **R3** tên nước | ✅ **Dễ nhất.** Hàm đã có, cùng module | **1** (`xlsx-export.ts`) + test | **0** | Không |
| **R1a** lọc trạng thái | ✅ Dữ liệu đã có ở mirror | 2-3 | **0** | Không |
| **R1b** chọn item | ✅ Nhưng cần chốt T1/T2 và cần Q5 | 3-4 | **0** | Không |
| **R2** sửa nguồn 183 | ⚠ **Khả thi, nhưng CHẶN bởi phép đo M1** | 2-3 | **+1 mỗi lần mở dialog** (nếu lấy live) | Không |

⚠ **R2 có một cái giá mà R1/R3 không có:** nếu dialog export chuyển sang dùng
danh sách Google thật, nó phải **gọi `regions/catalog` khi mở** ⇒ dialog từ
0 request thành **1 request**, và có thể **fail/chậm**. Dialog custom-prices đã
chấp nhận đánh đổi này. Cần Manager chốt (Q-R2.2).

### 4.2 Chunk đề xuất

| Chunk | Nội dung | Gate | Phụ thuộc |
|---|---|---|---|
| **X0** | Manager chạy SQL census + duyệt phép đo M1 | Có kết quả Q1-Q7 + kết quả M1 | — |
| **X1** | **R3** — header `Price in Vietnam (VN)` | 23 test hiện có của `xlsx-export.test.ts` xanh + test mới: format đúng, ca fallback rút gọn, **test ĐẾM số ca rút gọn** trên tập mã thật từ Q7 | X0 (Q2b) |
| **X2** | **R1a** — filter trạng thái | Lock "đổi filter = 0 request"; test filter + test độ lệch mirror/live được công bố | X0 (Q4) |
| **X3** | **R1b** — picker chọn item + contract route (`selectedSkus`, `[]`→400) | Parity gate BulkStatusModal (nếu T1); test `[]`→400; test SKU lạ theo quyết định Q-R1.4 | X2 |
| **X4** | **R2** — thay nguồn catalog dialog Google | Test: dialog Google **không** còn đọc `TERRITORY_CATALOG`; đối chiếu số với M1 | X0 (M1) |

⚠ **X1 độc lập hoàn toàn** — không phụ thuộc R1/R2, sửa 1 file, có thể ship
trước nếu Manager muốn thấy kết quả sớm.

### 4.3 Parity gate

- **X1:** file export với `selectedTerritories = null` phải có **đúng số cột
  và đúng thứ tự cột** như trước; **chỉ chuỗi header đổi**. Test so nguyên
  `headerRow2` + `!merges` + `!cols` không đổi.
- **X3 (nếu T1):** BulkStatusModal — bộ test hiện có
  (`BulkStatusModal.test.tsx`) phải xanh **không sửa một dòng nào**. Sửa test
  = đã đổi hành vi đường ghi.
- **X4:** `ExportOptionsDialog` — không sửa file. Test cấu trúc: grep
  `TERRITORY_CATALOG` trong cây `components/google-iap-management/` = 0 hit.

### 4.4 Mutation đề xuất

Theo KB §9 P10 (acceptance chứng minh bằng cách **phá** rồi xem test đỏ):

| # | Phá gì | Test nào PHẢI đỏ |
|---|---|---|
| M-a | Bỏ nhánh fallback ở X1, luôn in `Name (CODE)` | Test ca tên==mã (phải thấy `XX (XX)`) |
| M-b | Đổi `[]` → coi như `null` ở route | Test `[]`→400 |
| M-c | Lọc status **trước** khi dedupe SKU | Test đếm dòng file |
| M-d | Ở X4, bỏ prop `catalog`, để rơi về default | Test cấu trúc "0 hit `TERRITORY_CATALOG`" |

⚠ M-d là mutation quan trọng nhất của arc: nó chính là **cách lỗi R2 đã xảy ra
lần đầu** — một default vô hình, không ai truyền, không grep nào thấy.

### 4.5 Mockup

**HTML mockup** (đụng UI): [`mockups/g-export-item-picker.html`](mockups/g-export-item-picker.html)
— wizard 2 bước cho Google, dựng theo palette emerald của module Google
(**không** dùng navy `#0c447c` của Apple), có chip filter trạng thái, có ô
search, có dòng công bố độ lệch mirror/live.

**FILE MẪU sinh từ dữ liệu thật: ⚠ KHÔNG LÀM ĐƯỢC — cần Manager.**
Sinh file mẫu cần (a) danh sách region thật và (b) SKU/tên/giá thật. Cả hai
nằm sau Q1-Q7 + M1. **Không bịa dữ liệu.** Mockup chỉ minh hoạ **quy tắc đổi
chuỗi header**, và các mã dùng trong minh hoạ lấy từ `COMMON_REGIONS`
([regions.ts:19-50](../../lib/google-iap-management/regions.ts#L19-L50)) —
là hằng có thật trong repo, **không phải** dữ liệu production.

---

## §5 — CÂU CẦN MANAGER CHỐT

> ### ▸ Q-R2.1 — Xác nhận phát hiện: dialog export Google đang dùng catalog của module Apple (183, gõ tay, không phải của Google). Có sửa trong arc này không?
> **Đề xuất: CÓ, nhưng để chunk X4, sau khi có M1.**
> Lý do: sửa mà chưa biết tập Google thật thì chỉ đổi một danh sách sai lấy
> một danh sách khác chưa kiểm chứng.

> ### ▸ Q-R2.2 — Duyệt PHÉP ĐO M1 (1 request Google, read-only, Manager chạy)?
> **Đề xuất: DUYỆT.** Rẻ nhất có thể (1 request), không ghi gì, và nó đóng
> luôn `[GOOGLE-regions-unmeasured]` — mục đang chặn 2 việc khác.

> ### ▸ Q-R2.3 — Nếu M1 cho thấy Google hỗ trợ tập khác 183: dialog lấy danh sách **live** (1 request mỗi lần mở) hay **snapshot ghim trong repo** (0 request, phải cập nhật tay)?
> **Đề xuất: SNAPSHOT ghim + test ghim số**, giống `apple-territories.snapshot.ts`.
> Lý do: dialog export là đường **đọc**, sai currency không gây hỏng ghi như
> Hotfix 9. Đổi lại giữ được "mở dialog = 0 request".
> ⚠ Đánh đổi: snapshot **sẽ** cũ đi. Cần đi kèm ngày đo trong file.

> ### ▸ Q-R1.1 — Lọc trạng thái theo **cột `iaps.status` của tool** (2 giá trị) hay theo **`state` thô của Google** (≥3 giá trị, gồm `INACTIVE_PUBLISHED`)?
> **Đề xuất: cột tool (2 giá trị), VÌ ĐÓ LÀ CÁI ĐANG CÓ** — nhưng nhãn phải
> ghi rõ. ⚠ Bài học Apple ngược lại (Apple **cố ý** hiện `state` thô để độ
> lệch nhìn thấy được). Ở Google chưa ai đo hai trục có lệch không ⇒ chưa có
> cơ sở để hiện thô. Cần Manager biết `active` đang gộp 2 state.

> ### ▸ Q-R1.2 — Lọc ở đâu: **A** client/mirror · **B** server/live · **C** cả hai?
> **Đề xuất: B + công bố độ lệch.** File phải đúng với chính nó; và độ lệch
> phải nói ra, không im lặng.

> ### ▸ Q-R1.3 — Picker: **T1** tách `SelectionList` dùng chung với BulkStatusModal, hay **T2** viết riêng cho export?
> **Đề xuất: T1**, chốt lại sau khi có Q5 (quy mô). T2 là P1 twin-path.

> ### ▸ Q-R1.4 — SKU lạ trong `selectedSkus`: **409 nêu tên** (Google biết được sau 1 request) hay **cứ export + ghi vào sheet lỗi** (cách Apple)?
> **Đề xuất: 409 nêu tên.** Ở Google route thật sự biết được ngay sau list
> call, nên 409 rẻ và rõ hơn sheet lỗi. (Apple không chọn được vì không
> enumerate.)

> ### ▸ Q-R3.1 — Chốt format `Price in Vietnam (VN)`?
> **Đề xuất: CÓ.** Trùng format Apple E4 đã dùng, và bám sát chuỗi hiện tại.

> ### ▸ Q-R3.2 — Chấp nhận tên là **tên ISO** (18 override khớp Play Console, phần còn lại theo ISO)?
> **Đề xuất: CÓ**, và ghi vào user guide. Google không phát hành tên nước qua
> API ⇒ không có lựa chọn "tên của Google".

> ### ▸ Q-ORDER — Ship X1 (R3) trước, độc lập?
> **Đề xuất: CÓ.** 1 file, 0 request, không chờ SQL nào ngoài Q2b.

---

## Phụ lục — việc phát hiện thêm, KHÔNG thuộc arc này

| # | Việc | Ghi chú |
|---|---|---|
| A1 | `[GOOGLE-export-intersection-silent-drop]` **vẫn còn sống** — [`xlsx-export.ts:127-129`](../../lib/google-iap-management/xlsx-export.ts#L127-L129) | Tick một nước không item nào có giá ⇒ **không có cột nào cả**, không `—`, không ghi chú. Apple đã sửa ở E2. ⚠ Nếu làm X4 mà chưa sửa cái này thì X4 làm nó **tệ hơn** |
| A2 | Docblock `ExportItemWizard.tsx:12` sai từ arc G3 ("183 entries") | `[GUIDE-label-drift]` |
| A3 | `BACKLOG.md:76-77` ghi `[GOOGLE-regions-unmeasured]` là "KHÔNG ĐỌC ĐƯỢC — cần Manager" | Đã lỗi thời; TODO.md:666-668 có đủ mô tả |
