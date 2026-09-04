# Google IAP — Export picker: phân trang + shift-click (census + thiết kế)

**Arc:** `arc-google-export-picker-paging` · **Trạng thái:** ⛔ CHỜ MANAGER DUYỆT — chưa code sản phẩm.
**Khuôn tham chiếu (KHÔNG phải nguồn sự thật):** `docs/iap-management/design-export-picker-paging-range.md` (Apple).

> ⚠ Mọi khẳng định dưới đây trích `file:line` đã grep lại trên HEAD của arc này.
> Chỗ nào không đọc được thì ghi thẳng "KHÔNG ĐỌC ĐƯỢC — cần Manager".

---

# PHẦN B — GOOGLE CÓ TRẢ "LAST UPDATE" CHO TỪNG ITEM KHÔNG?

## B6. Kết luận một dòng

> **KHÔNG.** Google Play Android Publisher v3 **không trả bất kỳ trường thời điểm
> cập nhật nào** cho in-app product / one-time product / subscription — không ở
> LIST, không ở GET, không ở response của WRITE. Không có `updateTime`, không có
> `lastModified`, **không có cả `etag`** trên các schema catalog. Chi phí để lấy
> "last update" cho N item là **không xác định được ở bất kỳ giá** — dữ liệu
> không tồn tại trong API.

## B1. Nguồn đã đọc

| File | version | `revision` |
|---|---|---|
| `docs/google-iap-management/api/google-android-publisher-v3-discovery.json` | androidpublisher v3 | **20260520** |
| `docs/google-iap-management/api/google-play-developer-reporting-v1beta1-discovery.json` | playdeveloperreporting v1beta1 | **20260519** |

⚠ Hai file này chụp ngày **2026-05-20 / 2026-05-19** (mtime file trong repo cũng là
20/5). Hôm nay là 2026-09-04 → **cũ ~3.5 tháng**. Kết luận "KHÔNG CÓ" đúng với
bản này. Nếu Manager cần chắc tuyệt đối, cần đối chiếu discovery doc mới của
Google — nhưng một trường mới xuất hiện trong 3 tháng là **rất khó**, vì
`InAppProduct` là API legacy đã đóng băng và `OneTimeProduct` là API mới mà
Google thiết kế lại từ đầu **vẫn không đặt timestamp vào**.

## B2–B3. Bảng trường — cách đo

Không grep văn xuôi. Script duyệt **đệ quy mọi cấp lồng** của discovery doc, chỉ
lấy **KHOÁ trong `properties`** (bài học P44 — hit trong `description` trông y
hệt hit thật).

### Trên 4 schema catalog — TRỐNG SẠCH

| Schema | Số property | Trường mang nghĩa "cập nhật lúc nào" |
|---|---|---|
| `InAppProduct` (legacy) | 13 | **KHÔNG CÓ TRƯỜNG NÀO** |
| `OneTimeProduct` (API mới) | 8 | **KHÔNG CÓ** (chỉ `regionsVersion`, xem B4) |
| `Subscription` | 7 | **KHÔNG CÓ TRƯỜNG NÀO** |
| `OneTimeProductPurchaseOption` | 8 | **KHÔNG CÓ TRƯỜNG NÀO** |

`InAppProduct` đủ 13 property, không sót: `defaultLanguage` · `defaultPrice` ·
`gracePeriod` · `listings` · `managedProductTaxesAndComplianceSettings` ·
`packageName` · `prices` · `purchaseType` · `sku` · `status` ·
`subscriptionPeriod` · `subscriptionTaxesAndComplianceSettings` · `trialPeriod`.

### Đếm thô toàn file (khoá JSON, cả 335 schema)

| Chuỗi khoá | Số lần xuất hiện trong androidpublisher v3 |
|---|---|
| `"updateTime"` | **0** |
| `"lastUpdateTime"` | 1 — **`AppRecoveryAction`** (app recovery, không liên quan IAP) |
| `"etag"` | 2 — `DeferralContext`, `SubscriptionPurchaseV2` (**giao dịch**, không phải catalog) |
| `"lastModified"` | 2 — `DeveloperComment`, `UserComment` (**review của user**) |

⇒ 9 trường đúng-tên trên toàn bộ 335 schema, **không trường nào thuộc catalog sản phẩm**.

### Bảng theo format B6 yêu cầu

| Trường | Schema | Có ở LIST? | Có ở GET? | Format |
|---|---|---|---|---|
| *(không tồn tại)* | `InAppProduct` | — | — | — |
| *(không tồn tại)* | `OneTimeProduct` | — | — | — |
| *(không tồn tại)* | `Subscription` | — | — | — |
| `regionsVersion.version` | `OneTimeProduct` | ✅ có | ✅ có | `string`, vd `"2025/03"` — **KHÔNG phải thời gian** |
| `lastUpdateTime` | `AppRecoveryAction` | n/a | n/a | `google-datetime` — **sai domain** |
| `etag` | `SubscriptionPurchaseV2` | n/a | n/a | `string` — **domain giao dịch, không phải catalog** |

⚠ Câu hỏi quan trọng nhất của B3 ("có ở LIST hay chỉ ở GET?") **không áp dụng**:
không có trường nào để mà hỏi. Cả `inappproducts.list` → `InappproductsListResponse`
lẫn `monetization.onetimeproducts.list` → `ListOneTimeProductsResponse` chỉ chứa
mảng item + `nextPageToken` — item bên trong đúng là `InAppProduct` /
`OneTimeProduct` ở trên.

### Play Developer Reporting v1beta1 — không phải chỗ để hỏi

Không có schema nào tên chứa `inapp` / `product` / `purchase` / `sku` /
`monetization` / `subscription`. API này chỉ có crash / ANR / error-issue metrics.
**Không chứa catalog IAP.** Loại khỏi câu hỏi.

## B4. Cái gần nhất — và vì sao KHÔNG thay được

**`OneTimeProduct.regionsVersion.version`** là ứng viên duy nhất.

Discovery mô tả nguyên văn:
- trên `OneTimeProduct`: *"Output only. The version of the regions configuration that was used to generate the one-time product."*
- trên `RegionsVersion.version`: *"…Each time the supported locations substantially change, the version will be incremented."*

⇒ Đây là **version của catalog VÙNG BÁN của Google** (toàn cục, vd `"2025/03"`),
tăng khi Google đổi danh sách quốc gia — **không phải** dấu vết sửa item.
**Hai item sửa cách nhau 6 tháng vẫn mang cùng một giá trị.** Không dùng thay được.

**Không có ứng viên nào khác.** Không `etag` trên catalog ⇒ cũng không làm được
conditional-GET / phát hiện đổi bằng etag.

## B5. Phía code — phân biệt "tool sync" vs "Google sửa"

| Cột | Ai ghi | Nghĩa |
|---|---|---|
| `google_iap_mgmt.iaps.last_synced_at` | **TOOL** — [`repository/iaps.ts:252`](../../lib/google-iap-management/repository/iaps.ts#L252), [`iaps.ts:669`](../../lib/google-iap-management/repository/iaps.ts#L669), [`orchestration/bulk-status.ts:294`](../../lib/google-iap-management/orchestration/bulk-status.ts#L294) — tất cả là `new Date().toISOString()` | **Lúc TOOL kéo/đẩy item.** Không nói gì về việc Google sửa. |
| `iaps.updated_at` | **Postgres trigger** `set_updated_at()` → `NEW.updated_at = NOW()` ([migration `20260520010000…:37-41`](../../supabase/migrations/20260520010000_google_iap_mgmt_init.sql#L37), trigger [:150-152](../../supabase/migrations/20260520010000_google_iap_mgmt_init.sql#L150)) | **Lúc DÒNG DB bị ghi.** Vẫn là thời gian của mình. |
| `iaps.created_at` | Postgres `DEFAULT NOW()` | Lúc tool thấy item lần đầu. |

⇒ **Cả ba cột đều là thời gian CỦA TOOL.** Manager đang hỏi **cái thứ hai**
(lúc Google/người khác sửa item) — **không cột nào trả lời được**, và không thể
làm cột đó vì API không cung cấp dữ liệu.

⚠ Tự đính chính (P44 — áp cho chính mình): lượt grep đầu của tôi cắt bằng
`head -20` và **chỉ thấy hit của `store-submissions`**, suýt kết luận sai rằng
`last_synced_at` là cột khai-mà-không-ai-ghi. Grep lại không cắt → ra 3 writer
thật ở trên. Con số trong bảng là của lần grep thứ hai.

## Backlog (một dòng, KHÔNG đề xuất arc)

→ đã ghi vào `docs/google-iap-management/BACKLOG.md` mục `[GOOGLE-no-item-last-update]`.

---

# PHẦN A — CENSUS + THIẾT KẾ PICKER

## P1 — CÂU CHẶN CỬA

### P1.1 — "Show more" giới hạn HIỂN THỊ hay LỰA CHỌN? → **CHỈ HIỂN THỊ. ĐI TIẾP.**

Nút hiện tại ([`IapSelectionList.tsx:197-208`](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L197)):

```
Show more — {hidden} more match{es} and {is/are} still included in the export
```

**Payload gửi route** — dòng dựng payload:

```ts
// components/google-iap-management/iap-list/IapListClient.tsx:275
selectedSkus: allCandidatesSelected ? null : [...selectedSkus],
```

⇒ Payload dựng **từ tập tick `selectedSkus`**, không từ tập matching. Một item
**chưa hiện VÀ chưa tick** thì **KHÔNG** nằm trong payload.

**Vậy câu chữ trên nút có sai không? → KHÔNG SAI, nhưng đúng vì một lý do
NGƯỢC với cách đọc tự nhiên.** Chốt chặn thật nằm ở đây:

```ts
// components/google-iap-management/iap-list/IapListClient.tsx:197-202
function openExportFlow() {
  setStatusFilter("all");
  // ⚠ EVERYTHING SELECTED IS THE DEFAULT …
  setSelectedSkus(new Set(liveItems.map((i) => i.sku)));
```

⇒ **Mặc định là TICK HẾT.** Item bị window che vẫn **đang được tick**, nên nó
được export — **không phải** vì export bỏ qua tick, mà vì **nó đã tick sẵn**.
Đổi filter cũng reset về tick-hết ([`IapListClient.tsx:215`](../../components/google-iap-management/iap-list/IapListClient.tsx#L215)).

**KẾT LUẬN P1.1:** window là **RENDER BOUND thuần tuý**. Tập chọn độc lập hoàn
toàn với window. **Phân trang KHÔNG đổi nghĩa tập chọn ⇒ ĐI TIẾP, không phải
đổi hợp đồng tính năng.**

⚠ **NHƯNG PHÁT HIỆN NÀY ĐỔI THIẾT KẾ** — xem P3-G1: Google mặc định **tick hết**,
Apple mặc định **rỗng**. Đây là khác biệt lớn nhất giữa hai module trong arc này.

### P1.2 — Mô hình lựa chọn

| Hỏi | Đáp | Trích |
|---|---|---|
| State gì, kiểu gì | `useState<Set<string>>` — **Set các SKU** | [`IapListClient.tsx:117`](../../components/google-iap-management/iap-list/IapListClient.tsx#L117) |
| Có sentinel `"all"` không | **KHÔNG.** Set luôn là danh sách SKU thật | [`IapListClient.tsx:117`](../../components/google-iap-management/iap-list/IapListClient.tsx#L117) |
| Reset khi nào | (a) mở flow → tick hết `liveItems`; (b) đổi status filter → tick hết candidate mới | [:197-207](../../components/google-iap-management/iap-list/IapListClient.tsx#L197), [:210-218](../../components/google-iap-management/iap-list/IapListClient.tsx#L210) |
| `null` xuất hiện ở đâu | **CHỈ ở biên gửi request**, khi mọi candidate đều tick | [:275](../../components/google-iap-management/iap-list/IapListClient.tsx#L275) |

✅ **KHÔNG có sentinel trong state** ⇒ **không có bẫy "bỏ tick một item khi đang
select-all"** mà brief cảnh báo. `null` chỉ được **tính ra** tại thời điểm gửi
(`allCandidatesSelected`), state bên dưới luôn là danh sách thật. Giống Apple ở
điểm này.

### P1.3 — Contract route export: XÁC NHẬN CẢ BA CÒN ĐÚNG TRÊN HEAD

File: [`app/api/google-iap-management/apps/[packageName]/export/route.ts`](../../app/api/google-iap-management/apps/%5BpackageName%5D/export/route.ts)

| Luật đã chốt arc trước | Còn đúng? | Trích |
|---|---|---|
| `[]` → **400** | ✅ | `if (Array.isArray(rawSkus) && rawSkus.length === 0) { … { status: 400 } }` — [:125-132](../../app/api/google-iap-management/apps/%5BpackageName%5D/export/route.ts#L125); thêm một 400 nữa khi lọc xong rỗng [:138-141](../../app/api/google-iap-management/apps/%5BpackageName%5D/export/route.ts#L138) |
| SKU lạ → **409 NÊU TÊN** | ✅ | `unknownSkus: unknown` + `${unknown.join(", ")}` … `{ status: 409 }` — [:179-190](../../app/api/google-iap-management/apps/%5BpackageName%5D/export/route.ts#L179) |
| filter mode lạ → rơi về `all`, **KHÔNG 400** | ✅ | `isExportStatusFilter(body.statusFilter) ? body.statusFilter : "all"` — [:102-104](../../app/api/google-iap-management/apps/%5BpackageName%5D/export/route.ts#L102); comment [:93](../../app/api/google-iap-management/apps/%5BpackageName%5D/export/route.ts#L93) nói rõ "an unrecognised value degrades to all rather than 400" |
| `selectedSkus` sai kiểu (không mảng) | ✅ 400 | [:119-122](../../app/api/google-iap-management/apps/%5BpackageName%5D/export/route.ts#L119) |

⇒ **Cả ba còn đúng.** Arc này **không đụng route** — contract giữ nguyên.

---

## P2 — CENSUS PICKER + HẠ TẦNG

### P2.1 — Component, quy mô, nguồn item

| Hỏi | Đáp |
|---|---|
| Component | [`components/google-iap-management/iap-list/IapSelectionList.tsx`](../../components/google-iap-management/iap-list/IapSelectionList.tsx) — **211 dòng** |
| Vỏ chứa | [`ExportScopeDialog.tsx`](../../components/google-iap-management/iap-list/ExportScopeDialog.tsx) — **223 dòng**, render picker ở [:167-191](../../components/google-iap-management/iap-list/ExportScopeDialog.tsx#L167) |
| Chủ state | [`IapListClient.tsx`](../../components/google-iap-management/iap-list/IapListClient.tsx) — **868 dòng** |
| Item từ đâu | **PROP NẠP SẴN.** `items` ← `candidates` ← `props.items` ← trang. **KHÔNG fetch riêng** |
| Cơ chế "Show more" | `windowSize` prop; `visible = matching.slice(0, windowSize)` [:106-107](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L106) |
| Bước nhảy | `PICKER_WINDOW_STEP = 50` [`IapListClient.tsx:59`](../../components/google-iap-management/iap-list/IapListClient.tsx#L59); `onShowMore` cộng thêm 50 [:722](../../components/google-iap-management/iap-list/IapListClient.tsx#L722) |
| Window CHỈ NỞ | ✅ `setPickerWindow((n) => n + PICKER_WINDOW_STEP)` — không bao giờ co |

### P2.2 — ⚠ CÓ MẤY CONSUMER? → **HAI. VÀ MỘT LÀ ĐƯỜNG GHI.**

| # | Consumer | file:line | Loại | Truyền `query`/`windowSize`? |
|---|---|---|---|---|
| A | `ExportScopeDialog` | [`ExportScopeDialog.tsx:167`](../../components/google-iap-management/iap-list/ExportScopeDialog.tsx#L167) | **ĐỌC** (export ra file) | ✅ có cả hai |
| **A′** | **`BulkStatusModal`** | [`BulkStatusModal.tsx:584`](../../components/google-iap-management/iap-list/BulkStatusModal.tsx#L584) | 🔴 **GHI** | ❌ **KHÔNG truyền gì** |

**A′ là đường GHI, đã xác minh:** `BulkStatusModal` POST tới
`/iaps/bulk-activate` hoặc `/iaps/bulk-deactivate`
([`BulkStatusModal.tsx:298-307`](../../components/google-iap-management/iap-list/BulkStatusModal.tsx#L298)),
xuống `batchUpdateStates` trên Google Play
([`BulkStatusModal.tsx:629`](../../components/google-iap-management/iap-list/BulkStatusModal.tsx#L629)).
**Tick sai ở đây = đổi trạng thái bán hàng thật trên store.**

⇒ **GOOGLE CÓ ĐƯỜNG GHI ⇒ ÁP CÙNG LUẬT APPLE. Arc KHÔNG rẻ hơn một bậc.**
`paged?: boolean` **mặc định TẮT**, vì rủi ro không đối xứng: export sai thì
export lại; **ghi sai thì đã lên store**.

✅ **Tin tốt: khuôn opt-in-default-off ĐÃ TỒN TẠI SẴN.** `search` và `windowSize`
vốn đã optional và A′ đã không truyền — docblock [:23-32](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L23)
ghi rõ lý do ("Adding a search box to Bulk Activate would be a UI change to a
shipped write path, decided by nobody, riding in on a refactor"). Thêm `paged?`
là **đi tiếp một khuôn đã có**, không phải dựng khuôn mới.

### P2.3 — Search/filter

| Hỏi | Đáp |
|---|---|
| Lọc theo trường nào | `` `${iap.default_title ?? ""} ${iap.sku}` `` → lowercase → `.includes(needle)` — [`IapSelectionList.tsx:85-90`](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L85). Tức **tên + SKU**. |
| Gõ search có mất tick không | ❌ **KHÔNG.** Search chỉ lọc render; `selected` là Set độc lập. Có sẵn dòng nhắc "N selected items are hidden by the current search — still selected, still exported" [:155-161](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L155) |
| **Có gate theo số dòng không** | ❌ **KHÔNG CÓ GATE.** Ô search bật/tắt **theo PROP** (`searchable = typeof query === "string" && Boolean(onQueryChange)` [:104](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L104)), không theo `rows.length`. |

⚠ **Bẫy Apple KHÔNG tồn tại ở Google.** Apple từng gate ô search ở
`rows.length > 60` → app 45 item chia 3 trang mà không có ô search. Google
không có ngưỡng nào ⇒ **không cần sửa, và cũng không được thêm ngưỡng vào**.
Danh sách ngoài cũng vậy: ô search render vô điều kiện
([`IapListClient.tsx:497-505`](../../components/google-iap-management/iap-list/IapListClient.tsx#L497)).

### P2.4 — Màn NGOÀI đã phân trang chưa? Tái dùng được gì?

**✅ ĐÃ PHÂN TRANG RỒI — và đã dùng chung hạ tầng của Apple.**

```ts
// components/google-iap-management/iap-list/IapListClient.tsx:23
import { computePageMeta } from "@/lib/iap-management/pagination/page-slice";
// :55
const PAGE_SIZE = 20;
// :149-150
const meta = computePageMeta(filtered.length, page, PAGE_SIZE);
const slice = filtered.slice(meta.startIndex, meta.endIndex);
```

Prev/Next hiện là **JSX inline** [:589-616](../../components/google-iap-management/iap-list/IapListClient.tsx#L589), render khi `filtered.length > PAGE_SIZE`.

| Tài sản | Google tái dùng được? | Căn cứ |
|---|---|---|
| `lib/iap-management/pagination/page-slice.ts` (`computePageMeta`) | ✅ **ĐANG DÙNG RỒI** | `IapListClient.tsx:23` **và** `components/google-iap-management/apps/AppsListClient.tsx` — 2 chỗ trong module Google |
| `components/ui/iap/PageNav.tsx` | ✅ **Dùng được** | Presentational thuần, không state, không toán ([`PageNav.tsx:17-21`](../../components/ui/iap/PageNav.tsx#L17)); palette **slate trung tính, KHÔNG mang accent Apple**; đã có `leading?` slot đúng chỗ Manager muốn đặt Rows dropdown ([:45-48](../../components/ui/iap/PageNav.tsx#L45)) và `dense?` cho dialog ([:49-50](../../components/ui/iap/PageNav.tsx#L49)) |

**⚠ Hàng rào import chéo module — ĐÃ ĐỌC, KHÔNG CHẶN.**

`lib/iap-management/excel-library-split.structural.test.ts` **chỉ fence THƯ VIỆN
EXCEL** (`xlsx` vs `exceljs`) — 8 assertion, đều về hai package đó
([:233-334](../../lib/iap-management/excel-library-split.structural.test.ts#L233)).
**Không có allow-list import chéo module nào để phải thêm dòng.**

Và cross-module import Google→Apple **đã là chuyện đang diễn ra, 7 chỗ**:

```
lib/google-iap-management/export-territory-catalog.ts        -> @/lib/iap-management/territory-catalog
lib/google-iap-management/google/publisher-client.ts         -> @/lib/iap-management/concurrency
lib/google-iap-management/orchestration/bulk-import.ts       -> @/lib/iap-management/concurrency
components/google-iap-management/iap-list/IapListClient.tsx  -> @/lib/iap-management/pagination/page-slice
components/google-iap-management/iap-list/IapListClient.tsx  -> @/components/ui/iap/StatusDot      ← COMPONENT
components/google-iap-management/apps/AppsListClient.tsx     -> @/lib/iap-management/pagination/page-slice
app/api/google-iap-management/.../bulk-import/preview/route.ts -> @/lib/iap-management/concurrency
```

⇒ **`StatusDot` đã là một COMPONENT dùng chung xuyên module, ngay trong chính
file này.** Dùng `PageNav` là **đi theo tiền lệ đã có**, không phải mở cửa mới.
Vẫn nêu ở P6-Q3 để Manager biết mình đang xác nhận một quyết định thiết kế, chứ
không phải bị ép.

⚠ **Một lệch nhỏ, phải nói:** `PageNav` có biến thể `dark:` ([:63](../../components/ui/iap/PageNav.tsx#L63), [:68](../../components/ui/iap/PageNav.tsx#L68)); picker Google **không có `dark:` ở đâu cả**. Không hỏng — chỉ là ở dark mode thanh nav sẽ đổi màu còn phần trên dialog thì không. Xem P6-Q3.

### P2.5 — Thứ tự có ỔN ĐỊNH không (điều kiện sống của shift-click)?

**✅ ỔN ĐỊNH VÀ TOÀN PHẦN.** Kiểm từng hop:

| Hop | Có sắp lại không | Trích |
|---|---|---|
| DB | `.order("sku", { ascending: true })` — `sku` nằm trong `UNIQUE (app_id, sku)` ⇒ **không có tie** | [`repository/iaps.ts:67`](../../lib/google-iap-management/repository/iaps.ts#L67); UNIQUE ở [migration :142](../../supabase/migrations/20260520010000_google_iap_mgmt_init.sql#L142) |
| `liveItems` | `.filter()` — giữ thứ tự | [`IapListClient.tsx:123-126`](../../components/google-iap-management/iap-list/IapListClient.tsx#L123) |
| `candidates` (status filter) | `.filter()` — giữ thứ tự | [`ExportScopeDialog.tsx:97`](../../components/google-iap-management/iap-list/ExportScopeDialog.tsx#L97) |
| `matching` (search) | `.filter()` — giữ thứ tự | [`IapSelectionList.tsx:105`](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L105) |
| `visible` (window) | `.slice()` — giữ thứ tự | [`IapSelectionList.tsx:106-107`](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L106) |
| Control sort ở client | **KHÔNG CÓ** | `grep '\.sort('` trên `components/google-iap-management/` + `repository/iaps.ts` → **0 kết quả** |
| Refetch khi mở dialog | **KHÔNG THỂ** — test cấu trúc cấm `fetch`/`useEffect` trong cả picker lẫn dialog | [`export-status-filter.test.ts:178-219`](../../lib/google-iap-management/export-status-filter.test.ts#L178) |
| Render | `visible.map()` — map thường, **KHÔNG virtualised** | [`IapSelectionList.tsx:164`](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L164) |

⇒ **"Dải" có nghĩa chặt chẽ.** Thứ tự không đổi giữa hai lần click.

### P2.6 — ⚠ CHI PHÍ REQUEST: chọn ít item **TIẾT KIỆM 0 REQUEST**

Xác nhận bằng code, **không copy lập luận Apple**:

```ts
// app/api/.../export/route.ts:151  — LẤY CẢ APP, KHÔNG NHÌN selectedSkus
const products = await listInAppProducts(jwt, packageName);
// :195-197 — lọc CLIENT-SIDE, SAU KHI ĐÃ TẢI HẾT
const chosen = selectedSkus
  ? live.filter((p) => selectedSkus.includes(p.sku ?? ""))
  : live;
```

Và list là **1 request** cho app ≤1000 item:
```ts
// lib/google-iap-management/google/publisher-client.ts:102
const NEW_API_LIST_PAGE_SIZE = 1000;
// :117 pageSize: NEW_API_LIST_PAGE_SIZE   → vòng do/while dừng ngay khi hết nextPageToken
```
Docblock legacy path [:136-138](../../lib/google-iap-management/google/publisher-client.ts#L136) ghi rõ: *"apps sit exactly at Google's 1000-IAP ceiling"*.

⇒ **Giá trị của việc chọn ít = THU HẸP FILE + giảm công tick tay. KHÔNG phải tiền request.**
**MỌI copy "ước tính ~N request" của Apple PHẢI BỎ** — và hiện tại đã bỏ sẵn:
`ExportScopeDialog` docblock [:13-17](../../components/google-iap-management/iap-list/ExportScopeDialog.tsx#L13) đã ghi *"there is deliberately NO 'estimated cost' copy here"*. **Giữ nguyên điều đó.**

**LOCK phải giữ (mở picker · đổi trang · đổi lựa chọn · đổi page size = 0 request)
— GHIM BẰNG CẤU TRÚC, ĐÃ CÓ SẴN:**

```ts
// lib/google-iap-management/export-status-filter.test.ts:178-197  (IapSelectionList)
expect(src).not.toMatch(/\bfetch\s*\(/);
expect(src).not.toMatch(/fetchWithTimeout/);
expect(src).not.toMatch(/useEffect/);
// :199-219  (ExportScopeDialog) — cùng ba assertion
```
⇒ Arc này **chỉ cần mở rộng** allow-list file sang component paging mới (nếu tách file), **không cần phát minh cơ chế mới**.

---

## P3 — MÔ HÌNH CHỌN

M1–M10 Manager đã chốt được **áp nguyên cho Google**, với **hai điều chỉnh do
census tìm ra lý do thật** (G1, G2 dưới đây). Không có điểm nào khác lệch.

| | Chốt | Áp cho Google |
|---|---|---|
| M1 | Cộng dồn xuyên trang | ✅ y nguyên — `Set<string>` đã cộng dồn sẵn |
| M2 | Bộ đếm HAI TẦNG | ✅ **và là BẮT BUỘC hơn Apple** — xem G1 |
| M3 | Search lọc TOÀN BỘ rồi mới chia trang | ✅ y nguyên — `matching` rồi mới `slice` |
| M4 | Gõ→tick→xoá search, tick vẫn còn | ✅ đã đúng sẵn hôm nay [:155-161](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L155) |
| M5 | "Select all in page" khi search = tick trang ĐÃ LỌC | ✅ y nguyên |
| M6 | 20/30/50, DROPDOWN, footer cụm phải trước Prev | ✅ y nguyên — `PageNav.leading` đúng chỗ đó |
| M7 | BA cơ chế phân biệt bằng LOẠI CONTROL | ⚠ **có xung đột — G2** |
| M8 | Shift-click cộng dồn, anchor là ID, flip trang xoá anchor, có hint | ✅ y nguyên — ID ổn định (P2.5) |
| M9 | Đổi page size NEO VIEWPORT | ✅ y nguyên |
| M10 | "Selected only" | ✅ CÓ LÀM |

### ⚠ G1 — GOOGLE MẶC ĐỊNH TICK HẾT; APPLE MẶC ĐỊNH RỖNG

Đây là **khác biệt lớn nhất** giữa hai module trong arc này
([`IapListClient.tsx:199-202`](../../components/google-iap-management/iap-list/IapListClient.tsx#L199)).

**Hệ quả 1 — "đang thấy ≠ đang chọn" ở Google ĐÃ HAI CHIỀU TỪ HÔM NAY, chưa cần
phân trang.** App 200 item: mở picker → 200 tick, màn hiện 50. **150 dòng đang
được tick mà chưa từng hiện ra.** Rủi ro mà brief lo phân trang tạo ra thì
Google **đã sống chung với nó rồi** — phân trang không tạo lớp lỗi mới ở đây,
nó chỉ **đổi cách dòng biến mất** (trôi sang trang khác thay vì chưa nở tới).

⇒ **M2 (đếm hai tầng) ở Google không phải tiện nghi — nó vá một thứ đang mờ sẵn.**
Tầng "tổng" đã có (`{selectedInScope} of {candidates.length} selected`
[`ExportScopeDialog.tsx:164`](../../components/google-iap-management/iap-list/ExportScopeDialog.tsx#L164)
và `{selectedTotal} selected` [`IapSelectionList.tsx:152`](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L152));
**tầng "trên trang đang xem" là cái mới.**

**Hệ quả 2 — bài toán Manager than thực ra là "BỎ tick", không phải "tick".**
Muốn 30 item trong app 200 item, hôm nay thao tác là:
1. bấm checkbox "Select all" (đang **checked**) → **bỏ tick cả 200**
2. tick 30 item mong muốn (kèm "Show more" ×3 nếu chúng nằm sau dòng 50, hoặc search)

⇒ Mọi phép đo "số click" ở P4 phải tính **bước 1**, và nút "bỏ tick tất cả"
**phải còn sống** sau arc này.

### ⚠ G2 — M7(B) "KHÔNG BAO GIỜ XOÁ" XUNG ĐỘT VỚI MẶC ĐỊNH TICK-HẾT

Checkbox select-all **hiện tại** là **all-matching-scoped VÀ CÓ XOÁ**:

```ts
// components/google-iap-management/iap-list/IapListClient.tsx:231-241
function toggleAllSkus(matchingSkus: string[]) {
  const everyMatchSelected = matchingSkus.every((s) => prev.has(s));
  …  if (everyMatchSelected) next.delete(sku); else next.add(sku);
```

M7 yêu cầu checkbox đầu cột → **phạm vi TRANG** + **không bao giờ xoá**. Nếu áp
thẳng, **thao tác "bỏ tick cả 200 bằng 1 click" biến mất** — đúng cái bước 1 mà
Manager cần nhất.

**Đề xuất (chờ duyệt — P6-Q1):** giữ M7 nguyên vẹn, và **chuyển việc xoá-toàn-bộ
sang control (A)**:

| Control | Phạm vi | Hành vi | Nhãn |
|---|---|---|---|
| **(A)** NÚT ở toolbar | **toàn bộ matching** | tick hết ↔ **xoá hết** | `Select all 197` ↔ `Clear all 197` |
| **(B)** CHECKBOX đầu cột tickbox | **trang hiện tại** | tri-state; bấm = **tick nốt trang**, không xoá | `Select all 20 on this page` ↔ `Clear 20 on this page` |
| **(C)** shift-click | **dải trong trang** | cộng dồn, không đảo | không có control riêng |

⚠ Đây **là một thay đổi hành vi lên một control đã ship** (checkbox từ
all-matching → page-scoped). Không lén được, nên hỏi ở P6-Q1.

⚠ Ghi chú M7(B) khi đang ở chế độ "Selected only" (M10): checkbox hiện **checked
+ nhãn Clear**, **không special-case** — đúng như Manager chốt.

---

## P4 — KHẢ THI + PROS/CONS

Đo bằng **thao tác cho app 197 item** (con số minh hoạ; số thật cần Q5 census —
xem P6-Q4). Mặc định **tick hết 197** (G1).

| | (1) Chỉ phân trang | (2) Chỉ shift-click | (3) Cả hai |
|---|---|---|---|
| **Số file đổi** | 4: `IapSelectionList` · `ExportScopeDialog` · `IapListClient` · 1 test cấu trúc | **2**: `IapSelectionList` · `IapListClient` (anchor state) | 4 (cùng tập với (1)) |
| **Đụng component dùng chung** | ✅ `IapSelectionList` — **có A′ đường GHI** ⇒ cần `paged?` default OFF | ✅ cùng file — cần `rangeSelect?` default OFF | ✅ cả hai cờ, cùng default OFF |
| **Rủi ro silent-drop** | 🔴 **CAO NHẤT** — dòng đã tick trôi khỏi màn (xem ⚠ dưới) | 🟢 **THẤP NHẤT** — không chạm được dòng chưa render ⇒ không chọn được cái chưa thấy | 🟠 = (1); shift-click không cộng thêm rủi ro |
| **Độ phức tạp state** | +`page`, +`pageSize`; M9 neo viewport; reset trang khi search/filter | +`anchorSku` (1 biến, xoá khi flip trang/đổi search) | +3 biến, có ràng buộc chéo (flip trang ⇒ xoá anchor) |
| **30 item LIỀN NHAU** | 1 (Clear all) + 30 tick + ~1 lần đổi trang ≈ **32** | 1 (Clear all) + 1 click + 1 shift-click = **3** | **3** (nếu dải nằm trong 1 trang; page size 50 giúp điều này) |
| **30 item RẢI RÁC** | 1 + ~30 tick + flip trang ≈ **32+** | 1 + ~30 tick + "Show more" ≈ **32+** | 1 + ~30 tick ≈ **31** |

### ⚠ KHÔNG NHẬN CÔNG LỐ

**Không hướng nào giảm số click cho 30 item RẢI RÁC.** ~30 tick vẫn là ~30 tick.
Cái cải thiện là **TÌM** (search đã có sẵn, không phải công của arc này) và
**ĐỊNH HƯỚNG** (biết mình đang ở đâu trong bao nhiêu, thay vì một danh sách nở
dần không đáy). Arc Apple đo ra đúng như vậy; census Google **không tìm được lý
do nào để nói khác**.

Chỗ arc này thật sự thắng lớn là **dải liền nhau: ~32 → 3 thao tác.**

### ⚠ RỦI RO LỚN NHẤT — và một sắc thái riêng của Google

Brief nêu: hôm nay window **chỉ NỞ RA** nên dòng đã thấy không bao giờ rời màn;
phân trang cho phép dòng **ĐÃ TICK trôi khỏi màn** ⇒ "đang thấy ≠ đang chọn"
thành **HAI CHIỀU**. Đúng lớp lỗi `[GOOGLE-export-intersection-silent-drop]` vừa dọn.

**Ở Google, chiều nguy hiểm hơn đã mở sẵn (G1):** vì mặc định tick hết, hôm nay
đã có 147/197 dòng "đang chọn mà chưa từng thấy". Phân trang **mở nốt chiều còn
lại** (đã thấy → trôi đi). Nên:

- rủi ro **không phải mới toanh**, nhưng **cộng dồn**;
- **M2 đếm hai tầng là điều kiện bắt buộc để mở (1)**, không phải tuỳ chọn;
- **M10 "Selected only"** là van an toàn thật sự: nó biến "cái tôi đã chọn" thành
  một danh sách **duyệt được**, thứ hôm nay hoàn toàn không có.

### Thứ tự triển khai — shift-click TRƯỚC, có đúng cho Google không?

**✅ ĐÚNG, và ở Google lý do còn mạnh hơn Apple.**

1. Rủi ro thấp hơn hẳn: shift-click **không thể chạm dòng chưa render** ⇒ không
   thể chọn cái chưa thấy. Nó không đụng vào "đang thấy ≠ đang chọn" ở cả hai chiều.
2. 2 file thay vì 4, không cần `PageNav`, không cần quyết định import chéo module.
3. **Nó là hướng thắng lớn nhất** (32→3 cho dải liền nhau), nên ship trước là ship
   phần giá trị cao nhất với rủi ro thấp nhất.
4. Nó **không phụ thuộc** phân trang: shift-click trong window "Show more" hiện
   tại chạy được ngay.

⇒ Đề xuất: **Chunk 1 = shift-click (M8) + đếm hai tầng (M2)**; **Chunk 2 = phân
trang (M6/M9) + Selected only (M10) + G2**. Gate riêng từng chunk.

---

## P5 — MOCKUP

`docs/google-iap-management/mockups/g-export-picker-paging.html`

Palette đọc từ component thật, **không dùng navy/xanh Apple**:
`emerald-600 #059669` (nút chính), `emerald-700 #047857`, `emerald-500 #10b981`,
`emerald-50 #ecfdf5`, `slate-*`, `amber-50/200/800` (ô STATUS_FILTER_NOTE).
Đã grep: **không có `#0c447c` / `#0071E3` nào trong `components/google-iap-management/`.**

9 state bắt buộc đều có: trang 1 · trang giữa · trang cuối (trang ngắn) · tick
một phần (indeterminate) · đã tick ở trang khác (hai tầng đếm lệch) · search
đang bật · đang "select all" · dải shift-click · "Selected only".

⚠ **DỮ LIỆU TRONG MOCKUP LÀ GIẢ ĐỊNH, VÀ MOCKUP TỰ NÓI RA ĐIỀU ĐÓ.**
Repo **không chứa** SKU/packageName production nào (đã grep `docs/**/*.md`,
`lib/google-iap-management/__fixtures__/` → không có). Mockup dùng SKU **đúng
hình dạng** (`com.vng.<app>.<item>` reverse-DNS như `packageName` Google) với
n=197, và **in cảnh báo ngay trên đầu trang**. Số thật lấy bằng P6-Q4.

---

## P6 — CÂU CẦN MANAGER CHỐT

### Q1 — 🔴 CHẶN CHUNK 2. Checkbox select-all đổi phạm vi: có đồng ý không?

M7 biến checkbox đầu cột từ **all-matching + có xoá** → **page-scoped + không
bao giờ xoá**, và chuyển việc xoá-toàn-bộ sang **nút (A) ở toolbar**. Đây là
**đổi hành vi một control đã ship** (G2).

**Đề xuất: ĐỒNG Ý, theo bảng G2.**
**Lý do:** M7 phân biệt phạm vi bằng **loại control** để người dùng đọc phạm vi
từ **vị trí**, không từ trí nhớ — đó là cái làm phân trang an toàn. Giữ checkbox
all-matching thì hai control cùng hình dạng mà khác phạm vi, tệ hơn hẳn. Và thao
tác "xoá hết trong 1 click" **không mất**, chỉ **chuyển sang nút có nhãn nói rõ
`Clear all 197`** — vốn còn rõ ràng hơn một checkbox im lặng.

### Q2 — 🔴 CHẶN CẢ HAI CHUNK. Cờ `paged?` / `rangeSelect?` mặc định TẮT cho đường GHI: xác nhận?

`IapSelectionList` có **2 consumer, A′ = `BulkStatusModal` là đường GHI** thật
(`batchUpdateStates` lên Google Play) — P2.2.

**Đề xuất: XÁC NHẬN — mặc định TẮT, y như Apple.**
**Lý do:** rủi ro không đối xứng (export sai → export lại; ghi sai → đã lên
store). Khuôn opt-in-default-off **đã có sẵn** trong file này cho `search` /
`windowSize` với đúng lý do đó ([:23-32](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L23)) ⇒ đây là đi tiếp, không phải dựng mới.
Kèm **test cấu trúc** khẳng định `BulkStatusModal` không truyền hai cờ này.

### Q3 — 🟠 Không chặn. Dùng lại `PageNav` của module Apple, hay viết riêng cho Google?

**Đề xuất: DÙNG LẠI `@/components/ui/iap/PageNav`.**
**Lý do:** (a) `IapListClient.tsx` **đã** import `computePageMeta` **và**
`StatusDot` từ module Apple — tiền lệ component đã có, ngay trong chính file
này; (b) `PageNav` palette **slate trung tính**, không mang accent Apple; (c) nó
đã có sẵn `leading?` (chỗ Manager muốn đặt Rows dropdown) và `dense?` (cho
dialog); (d) hàng rào duy nhất trong repo chỉ fence **thư viện Excel**, không
đụng tới đây.
**Cái phải chấp nhận nếu duyệt:** `PageNav` có biến thể `dark:`, picker Google
thì không ⇒ ở dark mode thanh nav lệch tông phần thân dialog. Sửa được sau, rẻ.
**Nếu Manager muốn tránh cross-module hẳn** thì phương án B là copy ~60 dòng
sang `components/ui/google-iap/` — nhưng đó **là** twin-path P1, và tôi không
khuyến nghị.

### Q4 — 🟠 Không chặn code, CHẶN việc chốt page size mặc định. Số item thật mỗi app?

Mockup đang giả định n=197. **Repo không có dữ liệu thật.**
**Đề nghị Manager chạy Q5 trong** `docs/google-iap-management/queries/census-google-export-item-list.sql`
(READ-ONLY, đã có sẵn, không cần viết mới) và gửi lại `package_name` /
`total_items` / `live_items`.
**Vì sao cần:** nếu app lớn nhất chỉ ~60 item thì page size mặc định nên là 50
(gần như 1 trang, phân trang gần như tàng hình); nếu có app 500+ thì mặc định 20
hợp lý hơn. **Chốt mặc định mà không có số này là đoán.**

### Q5 — 🟢 Nhỏ. Thứ tự chunk: shift-click trước, phân trang sau — duyệt?

**Đề xuất: DUYỆT** (lý lẽ ở cuối P4). Chunk 1 rủi ro thấp nhất, giá trị cao
nhất, 2 file, không cần Q1/Q3.

---

## Những gì arc này KHÔNG làm

- ❌ Không đụng `export/route.ts` — contract P1.3 giữ nguyên.
- ❌ Không đụng `BulkStatusModal` (đường GHI).
- ❌ Không thêm bất kỳ copy "ước tính ~N request" nào (P2.6).
- ❌ Không thêm gate số-dòng cho ô search (P2.3 — Google vốn không có, đừng nhập khẩu bug Apple).
- ❌ Không làm gì với phát hiện Phần B ngoài một dòng backlog.
