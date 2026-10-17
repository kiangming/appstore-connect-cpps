# Bulk import Google — dò "đã tồn tại" + an toàn giá khi Overwrite — CENSUS + THIẾT KẾ

**Tag:** `[GOOGLE-ballisticherotwid-missing-legacy-default]` · **Module:** Google IAP
Management · **Trạng thái:** census xong (chỉ đọc + đo bằng mock, không gọi Google,
không chạm DB), **chờ Manager chốt**. Chưa code.

Runbook SQL: [`queries/read-ballisticherotwid-missing-options.sql`](queries/read-ballisticherotwid-missing-options.sql)
(Q0–Q11, P-Q1, E-Q1–E-Q6, D8-Q0–Q2 — chạy thử trên DDL thật bằng PGlite, 0 lỗi).

Nhãn: **ĐÃ ĐO** · **ĐỌC CODE** · **CÓ TRONG SCHEMA** · **CHƯA BIẾT**.
Census: 2 workflow, 16 agent (8 lane + 8 verifier đối kháng); 159 claim (102 + 57), 1 WRONG đã
sửa (tên package playtogether — có ứng viên trong mockup), còn lại CONFIRMED/PARTLY.

---

## 0. Đã chốt bằng dữ liệu production (Manager chạy SQL)

- Batch `a14c2e4d` 03:21:51 → FAILED 28/28. 28 SKU được mirror LẦN ĐẦU lúc 03:25:01,
  SAU lần import; IAPS_LIST_SYNC duy nhất lúc 03:25:10, `google_returned = 28`.
- ⇒ Mirror rỗng vì app **chưa từng được Refresh danh sách item** kể từ khi app row được
  tạo (2026-05-21). `.catch(() => [])` không phải thủ phạm lần này.
- ⇒ Cả 28 SKU đã có trên Google. `error_details = []`, reasons `["failedPrecondition"]`.
- Q10: cùng câu lỗi ở 3 app (playtogether 07-03, tinywar 09-21 ×2, ballisticherotwid
  10-16), id option khác nhau mỗi app.

---

## 1. ⭐ AN TOÀN GIÁ — E1–E4

### E1 — Banner "currency TWD · locale zh-TW" lấy từ đâu

- **Chỉ từ `apps.default_currency` / `default_language`**, đọc một lần lúc tải trang
  (`bulk-import/page.tsx:32`, `:47-48` → `BulkImportWizard.tsx:775-803`). Không phụ
  thuộc pricing source, template hay header file. — ĐỌC CODE
- Preview route đọc lại hàng app ở mỗi request; dòng `0.99 USD → 33.000000 TWD` chỉ ra
  được khi `apps.default_currency = TWD` **và** nguồn giá là template (google_default với
  app TWD thì mọi dòng bị REFUSE). ⇒ Lúc ~03:21 DB đang giữ TWD; batch dùng
  default_template hoặc app_template. — ĐÃ ĐO
- `0.99 USD →` ⇒ file dùng header **`Price (USD)`** (header chung dưới app TWD sẽ hiện
  `0.99 TWD`). Header `Price (USD)` luôn được parse là USD, bất kể app currency
  (`excel-parser.ts:181-194`). — ĐÃ ĐO
- **Execute đọc LẠI `apps.default_currency` lúc bấm Push** (`execute/route.ts:139`,
  `:302`) và tính lại cross-currency từ đầu; payload wizard không mang `resolution` của
  preview. ⇒ Preview hiện một đằng, execute có thể làm một nẻo nếu currency đổi giữa
  chừng. — ĐÃ ĐO
- `apps.default_language` không ảnh hưởng dữ liệu bulk gửi lên: `buildProduct` gán cứng
  `defaultLanguage: "en-US"` (`bulk-import.ts:262`), adapter ghi v3 không gửi trường
  này. Chỉ để hiện banner. — ĐỌC CODE

### E2 — Cái gì đã đổi TWD/zh-TW → USD/en-US

- Chỉ có **hai** chỗ ghi hai cột này, cùng qua `updateAppDefaults`
  (`repository/apps.ts:127-148`):
  1. **Refresh danh sách app**: bỏ qua app đã có đủ hai default
     (`apps/refresh/route.ts:101-104`); thiếu thì language = `AppDetails.defaultLanguage`
     (giá trị thật trên Play Console), currency = **đoán** từ language (`zh-TW → TWD`,
     `region-currency-map.ts:35`). ⇒ **Không thể** đổi một currency đã có. — ĐÃ ĐO
  2. **Refresh IAP** (`batchSyncIapsFromGoogle`, `iaps.ts:759-769`): ghi đè **vô điều
     kiện** từ sản phẩm đầu tiên Google trả về. Currency = currency của vùng **US** (không
     có US thì vùng đầu tiên) — `onetime-product-adapter.ts:124-133`; language = listing
     đầu tiên, hoặc **`"en-US"` bịa ra** khi không có listing (`:152-153`). — ĐÃ ĐO
- ⇒ Thủ phạm là **Refresh IAP lúc 03:25:10**, không phải refresh danh sách app 03:58.
  Độ chắc: CAO nhưng gián tiếp (đã liệt kê hết đường ghi; không có bản ghi giá trị cũ).
  Bằng chứng trực tiếp khả dĩ: Supabase edge logs — một `PATCH /rest/v1/apps?id=eq.<id>`
  trong 03:25:01–03:25:10. — ĐỌC CODE + suy luận có căn cứ
- ⚠ **Model v3 của Google không có currency mặc định của app, cũng không có giá/ngôn ngữ
  mặc định theo sản phẩm** (discovery `OneTimeProduct` :2952; giá theo từng vùng, bằng
  đúng currency của vùng :3205). Comment `iaps.ts:623-627` ("Google enforces app-wide
  defaults… ground truth") **sai** với đường đọc v3. ⇒ **Cả TWD (đoán từ ngôn ngữ) lẫn
  USD (suy từ vùng US) đều KHÔNG phải "currency của app" theo Google.** — CÓ TRONG SCHEMA
- Lỗi mang tính **hệ thống**: mọi app có Refresh IAP qua v3 mà sản phẩm đầu có vùng US đều
  bị ghi `default_currency = USD`, kể cả app VND/TWD. Language bị thay từ giá trị thật
  của Play Console sang heuristic. — ĐÃ ĐO
- **Lịch sử: CHƯA BIẾT.** Không bảng lịch sử; `apps.updated_at` đã bị lần UPSERT 03:58
  ghi đè (trigger chạy cả khi upsert — ĐÃ ĐO trên PGlite). Dấu vân tay gián tiếp duy nhất
  trong DB: `cross_currency_*` của payload batch (E-Q3). Railway có tên đồng tiền:
  `[google-iap:bulk-import:cross-currency] resolved sku=… → TWD/33000000`.

### E3 — Đường OVERWRITE gửi giá theo currency nào, và ghi gì lên sản phẩm live

- Body v3 **không có currency cấp sản phẩm**: mỗi vùng mang currency riêng (của entry
  template hoặc của `convertRegionPrices`). "Ghi giá TWD vào app USD" **không** phải cơ chế
  rủi ro thật. — ĐÃ ĐO
- **Nhưng currency lật vẫn KHÔNG vô hại** (verifier E34):
  - dòng `Price (USD)` **không có tier khớp**: app TWD ⇒ REFUSE (template_miss, 0 lời gọi
    Google); app USD ⇒ rơi xuống auto-bootstrap ⇒ **OVERWRITE bằng giá convert của Google
    cho cả 173 vùng**, dù nguồn là Default Template (`bulk-import.ts:943`). — ĐÃ ĐO
  - header chung: cùng ô `30` ⇒ TWD 30 (app TWD) hay USD 30 (app USD) — lệch ~30 lần. — ĐÃ ĐO
  - app USD tra tier theo **SKU trước** (`templates.ts:803-819`), app TWD chỉ khớp anchor
    ⇒ có thể chọn tier khác lần 03:21. — ĐỌC CODE
  - google_default: app TWD ⇒ REFUSE toàn bộ; app USD ⇒ **ghi thật** theo convert. — ĐÃ ĐO
- **Overwrite THAY TOÀN BỘ cấu hình giá/vùng của MỘT purchase option đang bán** (đo bằng
  mock, chạy code thật `executeBulkImport → batchUpsertInAppProducts → adapter`):
  1. `regionalPricingAndAvailabilityConfigs` của option đích bị thay nguyên khối bằng
     (template ∪ convert): vùng live không có trong đó bị **bỏ khỏi body** (mock: XK);
     vùng chưa từng bán được **thêm** (mock: live 6 vùng → body 173 vùng). — ĐÃ ĐO
  2. Mọi vùng bị đặt cứng `availability: "AVAILABLE"` (`adapter.ts:274`) ⇒ vùng đang
     `NO_LONGER_AVAILABLE` (mock: BY, RU) bị mở bán lại. — ĐÃ ĐO
  3. Option đích = buyOption có `legacyCompatible:true`, không có thì buyOption ĐẦU TIÊN
     theo thứ tự Google trả (`adapter.ts:313-323`). Option kia giữ nguyên giá cũ ⇒ hai
     option mang hai bộ giá khác nhau. — ĐÃ ĐO
  4. `batchUpdateStates` **luôn ACTIVATE** option đích (`bulk-import.ts:260` status
     "active") ⇒ SKU đang inactive sẽ bị **bật lại**. Manager nói 28 SKU "phần lớn
     active" ⇒ có SKU sẽ bị bật. — ĐÃ ĐO
  5. `updateMask` gồm `listings,…,taxAndComplianceSettings,offerTags,restrictedPaymentCountries`
     nhưng body chỉ có `packageName, productId, listings, purchaseOptions` ⇒ listings
     **bị thay** bằng listings của file; ba trường cấp sản phẩm vắng mặt có thể bị **xoá**
     (`restrictedPaymentCountries` rỗng = gỡ mọi giới hạn thanh toán). — listings ĐÃ ĐO;
     xoá trường vắng mặt CHƯA BIẾT
  6. Option không phải đích được gửi lại nguyên văn, kể cả trường output-only `state`;
     Google xử lý ra sao: CHƯA BIẾT.
  7. Sau khi chạy, mirror có thể ghi giá của option **không** được sửa (đường đọc lấy
     buyOption đầu, đường ghi lấy option legacyCompatible — `adapter.ts:108-115` vs
     `:313-323`; comment `:307-311` nói "cùng thứ tự" là sai). — ĐÃ ĐO
- `33.000000 TWD` **chỉ là hiển thị** (`preview/route.ts:281` `microsToDecimal(…, 6)`);
  giá lên dây đúng `Money{TWD, units "33"}`. 33 TWD là **entry của template**, không phải
  quy đổi. — ĐÃ ĐO ⇒ `[GOOGLE-preview-currency-6dp]` là lỗi hiển thị, độ ưu tiên thấp.
- Banner nói sai cơ chế: "numeric values are interpreted in the app's configured
  currency" — thực tế `Price (USD)` là USD (`template-spec.ts:60`) rồi quy đổi qua tier.

### E4 — ⛔ KẾT LUẬN: chạy lại import này bây giờ **KHÔNG AN TOÀN**. Manager KHÔNG chạy.

Mirror nay đầy ⇒ preview ra **EXISTING 28** ⇒ chỉ được chọn Overwrite hoặc Skip.
Overwrite sẽ, trên 28 sản phẩm **đang bán**: thay toàn bộ giá/vùng của option đích, mở
bán lại vùng đã tắt, thêm vùng chưa từng bán, bật lại SKU inactive, thay listings, và có
thể xoá giới hạn thanh toán/thuế cấp sản phẩm — **không có bước nào cho Manager xem trước
thay đổi so với live** (preview không đọc Google). Thêm: currency của app đã bị lật bởi
một heuristic, nên dòng không có tier khớp sẽ được ghi bằng giá convert thay vì bị từ
chối.

Cách duy nhất chắc chắn không ghi gì: **Skip cả 28 dòng** — tức là không làm gì.
Overwrite thử 1 SKU vẫn chịu đủ ngữ nghĩa thay-toàn-bộ ở trên cho SKU đó.

Nếu cần đổi giá 28 SKU trước khi có bản sửa: làm tay trên Play Console.

---

## 2. THIẾT KẾ D0–D11 (chờ chốt)

⚠ Danh sách D1–D8 Manager nhắc tới **không có trong repo**. Dưới đây dựng lại theo mô tả
trong tin nhắn của Manager; **D5 Manager chưa mô tả — tôi điền theo phát hiện census,
cần Manager xác nhận**. D9–D11 là mục mới từ census lượt này.

| # | Việc | Bịt ca nào | Ưu tiên |
|---|---|---|---|
| **D0** ⭐ | **"Chưa từng đọc ≠ đọc ra rỗng".** App row chưa từng có một lần Refresh IAP toàn danh sách thành công ⇒ preview **không** được coi mirror rỗng là "chưa có item": chặn bước tiếp, kèm nút Refresh (bấm tay). Nguồn trạng thái: (i) đề xuất — cột mới `apps.iaps_last_synced_at` do Refresh IAP ghi (1 migration, Path G); (ii) không migration — tra `actions_log IAPS_LIST_SYNC` theo `target_id = app.id`, `scope IS NULL` (⚠ `appendAction` nuốt lỗi insert ⇒ có thể chặn nhầm — chiều an toàn). App row tạo lại (H7) có id mới ⇒ tự bị chặn đúng. ⚠ **Không tự Refresh trong preview khi D9 chưa sửa** — Refresh hôm nay lật currency của app. | đúng ca 10-16 | cao, rẻ |
| **D1** | **Execute xác minh tồn tại phía server bằng Google** ngay trước khi ghi: một `onetimeproducts.batchGet` cho mọi SKU của batch (discovery :11415). SKU có trên Google mà dòng là `create` ⇒ **từ chối** dòng/lần chạy, nói rõ "đã tồn tại — Refresh rồi chọn Overwrite/Skip"; **không tự đổi sang overwrite** (overwrite phá huỷ — E3). Dòng overwrite dùng luôn kết quả batchGet làm option live. batchGet lỗi ⇒ từ chối cả lần chạy (không biết ⇒ không ghi). ⚠ batchGet trả gì cho SKU không tồn tại (lỗi hay bỏ qua): CHƯA BIẾT — phải đo trước. | mọi ca mirror cũ/thiếu | chốt chặn chính |
| **D2** | Preview **không nuốt lỗi** đọc mirror: bỏ `.catch(() => [])` (`preview/route.ts:128`) ⇒ trả lỗi rõ, không bao giờ "mọi dòng NEW" khi chưa biết. | H3e | cao, rẻ |
| **D3** | Banner preview hiện trạng thái mirror: "Danh sách item đồng bộ lần cuối HH:MM bởi X (N item)" hoặc "**CHƯA TỪNG** đồng bộ". Sửa luôn câu banner sai về currency (E3). | hiểu nhầm | trung bình |
| **D4** | Fallback API cũ: thôi bắt **mọi** lỗi. FAILED_PRECONDITION/INVALID_ARGUMENT là lỗi về body — API cũ không sửa được; app đã migrate thì API cũ trả "Please migrate". Tối thiểu: không fallback với 4xx của v3, và không bọc các bước **sau** khi v3 đã ghi (hôm nay một lỗi map sau ghi vẫn gọi legacy và báo "new API failed (?)" — vi phạm P5). Chọn: thu hẹp trigger hay bỏ hẳn trên đường ghi. | nhiễu + sai trạng thái | trung bình |
| **D5** (điền thay) | `listIapsForApp` **phân trang** như hai hàm anh em cùng file (`iaps.ts:60-73` vs `:97-124`, `:424-448`) — mirror > 1000 dòng ⇒ SKU xếp cuối thành NEW. ⚠ Manager xác nhận D5 gốc là gì. | H5 | trung bình |
| **D6** | **Không hardcode thêm id option.** Mọi đường ghi lên sản phẩm có sẵn phải đọc option thật (D1 cung cấp); `"buy"` chỉ dùng khi Google **xác nhận** sản phẩm chưa tồn tại. Đã xác nhận: id khác nhau mỗi app (legacy-base / default / legacy+default). | lặp lỗi lần 4 | nguyên tắc |
| **D7** | `batchUpdate` có atomic không: **CHƯA ĐO**. Dữ liệu nghiêng "không ghi gì" (rows_success 0), nhưng FAILED **không chứng minh** điều đó (verifier: fallback bọc cả bước sau ghi). Cách đo rẻ: lịch sử thay đổi trên Play Console của 1 SKU quanh 03:21. | — | câu hỏi mở |
| **D8** | Cùng cơ chế ở app khác: SQL D8-Q0–Q2 đã viết. Kỳ vọng: **tinywar** ⇒ `MIRROR_EMPTY_CREATE` (cùng cơ chế, cùng code create/overwrite — chỉ khác shape payload lỗi vì trước O1-O3); **playtogether 07-03** ⇒ nhiều khả năng `PRE_RMW_OVERWRITE` — code trước `4fbcdd5` gửi `"buy"` cho **mọi** dòng kể cả overwrite, và docs cho thấy mirror của nó đã đầy (≈293+109) trước 07-03 ⇒ **trigger khác**, chung gốc "không đọc option thật". Không gộp theo câu lỗi. | — | chạy SQL |
| **D9** ⭐ mới | **Refresh IAP thôi ghi đè default của app từ heuristic của adapter** (`iaps.ts:759-769`). Language: lấy từ `edits.details` (giá trị thật), không từ listing đầu / `"en-US"` bịa. Currency: v3 không có khái niệm này ⇒ cần Manager chốt "app currency" trong tool **nghĩa là gì** (nó điều khiển cross-currency, refuse google_default, custom price, header chung) — đề xuất: một thiết lập Manager chọn tường minh, không suy. Sửa comment sai `:623-627`. | lật currency âm thầm, hệ thống | **cao** |
| **D10** ⭐ mới | **Overwrite không được thay mù cấu hình live.** (a) Preview phải đọc live (batchGet) và hiện **diff theo SKU**: vùng thêm/bỏ, giá đổi, availability lật, state bị bật, option đích, listings bị thay. (b) Chốt ngữ nghĩa với Manager: "Overwrite = thay toàn bộ" hay "chỉ cập nhật vùng có trong file, giữ vùng/availability/state còn lại" (P4 read-modify-write); không đặt cứng AVAILABLE; không activate option đang inactive trừ khi file yêu cầu; `updateMask` chỉ gồm trường body thực sự mang. | rủi ro giá ở E3 | **cao — chặn mọi lần chạy lại** |
| **D11** mới | Execute **giữ ảnh chụp currency** preview đã dùng; currency của app đổi giữa preview và push ⇒ từ chối, bắt preview lại (hôm nay execute đọc lại âm thầm). | preview ≠ execute | trung bình |

**Thứ tự đề xuất (rẻ → đắt):** D2 · D0 · D3 (không migration nếu chọn nguồn actions_log)
→ D9 (phải trước mọi auto-refresh) → D1 (+ đo batchGet) → D10 (+ chốt ngữ nghĩa) → D11,
D4, D5. Cho tới khi có D10: **không Overwrite sản phẩm live qua bulk import.**

---

## 3. Câu cần Manager chốt

1. **D0 nguồn trạng thái**: cột mới (migration) hay đọc `actions_log`?
2. **D1 khi phát hiện SKU đã có mà dòng là Create**: từ chối dòng đó hay cả lần chạy?
3. **D4**: thu hẹp fallback (theo lớp lỗi nào) hay bỏ hẳn trên đường ghi?
4. **D5 gốc** của Manager là gì?
5. **D9 "app currency" nghĩa là gì** trong tool, khi Google v3 không có khái niệm đó?
   Và có sửa tay hàng app này về giá trị đúng không (⚠ Refresh IAP kế tiếp sẽ lật lại
   cho tới khi có D9)? Giá trị thật: language — đọc trên Play Console; currency — CHƯA BIẾT.
6. **D10 ngữ nghĩa Overwrite**: thay toàn bộ hay chỉ vùng có trong file?
7. **Chạy SQL** E-Q3 (currency lúc execute), P-Q1 (số vùng/SKU, SKU inactive), D8-Q2.

## 4. Phát hiện phụ

- Đổi `zh-TW → en-US` làm form tạo/sửa IAP đòi title en-US (`iap-form/IapForm.tsx:566-568`).
- Override `GT Price/GT Currency` bị bỏ qua âm thầm với nguồn template (`bulk-import.ts:286`, `:948`).
- Dòng `import_batches` mồ côi `IN_PROGRESS` khi lỗi ném ngoài try (`bulk-import.ts:319-329`, `:766-784`).
- Một số dòng log lỗi Google không qua `redactSecrets` / trần 200 ký tự
  (`publisher-client.ts:1118-1122`, `:1214-1218`; `bulk-import.ts:1116-1120`, `:1195-1197`).
- Comment/tài liệu lệch code: banner wizard; JSDoc Props wizard ("threaded into the
  execute payload"); `iaps.ts:623-624` ("carries both" nhưng code dùng `||`);
  `excel-parser.ts:315`; migration `20260521000000:13-15`.

---

## 5. Lượt 2026-10-16 (chiều) — H2.3 · H4 · C2.1 (census đã kiểm đối kháng)

### 5.1 Quyết định Manager làm đổi thiết kế D0–D11

- **Không chặn tool** (không hotfix chặn Overwrite, không tắt Overwrite). C3 chờ kết quả H2.
- ⭐ **Currency trong file import là nguồn DUY NHẤT cho giá ghi lên Google.** `apps.default_currency`
  (dù `'guessed'` hay `'declared'`) không được ảnh hưởng giá. Hệ quả:
  - **D9 đổi nghĩa:** currency/language của app KHÔNG còn là điều kiện import (C2.1). Thẻ khai báo
    trên trang app giữ nguyên, không gắn với gate.
  - **D11 hết ý nghĩa** (giữ currency giữa preview và execute) — khi currency của app không còn
    tham gia giá.
- Trigger chống rollback (Q1): KHÔNG làm. Bước thủ công trong verify SQL là đủ.

### 5.2 H2.3 — ảnh chụp 03:25 KHÔNG còn trong DB (ĐÃ ĐO bằng code + PGlite)

Lượt OVERWRITE 54de7054 (07:24:59 UTC, code `ac3043f` — a8cbedc chỉ được push lúc 07:45:01) đi
`bulk-import.ts:1183-1199 → syncIapFromGoogle (iaps.ts:242-300)` cho mỗi SKU thành công:
upsert `iaps` (giữ `id`, `created_at`), **xoá toàn bộ rồi chèn lại** `iap_listings` + `iap_prices`
từ PHẢN HỒI của Google. Bản mirror 03:25 đã mất từ ≈07:25. Runbook lưu trạng thái SAU Overwrite +
dấu vết batch: [`queries/snapshot-ballisticherotwid-after-overwrite.sql`](queries/snapshot-ballisticherotwid-after-overwrite.sql).
Cấu hình trước Overwrite chỉ có thể còn NGOÀI DB: Supabase backup/PITR (chỉ khôi phục ra DB riêng),
file Export tải trong 03:25–07:24 UTC, log Railway.

Phát hiện phụ — ảnh hưởng H2 (chưa đo trên Google thật):
- Mirror lưu giá/status/default_* của **buyOption ĐẦU TIÊN** (`onetime-product-adapter.ts:108-115`),
  còn Overwrite ghi option **legacyCompatible** (`:313-323`). Thứ tự option trong phản hồi Google:
  CHƯA BIẾT. Phân biệt bằng Σ `n_price_regions` ở S1 (≈174 ⇒ option không bị đụng).
- `updateMask` của Overwrite gồm `taxAndComplianceSettings, offerTags, restrictedPaymentCountries`
  (`publisher-client.ts:348-349, :971`) nhưng body không mang các trường đó (`adapter :400-405`) ⇒
  có thể đã bị đặt về mặc định trên Google (CHƯA BIẾT). Mirror chưa bao giờ lưu các trường này.
- Listings bị thay **trên Google** (mask có `listings`), không chỉ trong mirror.
- Overwrite gửi ACTIVATE cho option đích (`bulk-import.ts:260` `status: "active"`) ⇒ SKU …0.99
  (inactive lúc 03:25) có thể đang được bán.
- `syncIapFromGoogle` không transaction, không kiểm lỗi DELETE (`iaps.ts:269, :284`).
- Fallback legacy gửi `allowMissing=true` cho MỌI dòng, kể cả dòng overwrite mà GET live lỗi
  (`publisher-client.ts:1241-1248`).

### 5.3 H4 — currency của app ĐANG ảnh hưởng giá ghi lên Google (ĐÃ ĐO, vi phạm yêu cầu)

Đo bằng vitest trên code thật (googleapis mock, FX giả — chỉ đo **neo nào được đưa cho Google**),
trên cả HEAD và cây đã deploy `ac3043f`: **12/12 cặp "cùng file, app USD vs app TWD" cho kết quả
KHÁC** (body khác hoặc dòng bị từ chối). Không riêng header USD: lỗi là "currency trong file ≠
currency của app".

| # | Chỗ | Lớp | Hiệu ứng |
|---|---|---|---|
| S-a | parser: header chung `Price`/`Default Price`/`Base Price` ⇒ currency = app (`excel-parser.ts:195-211`) | (a)+(b) | defaultPrice, tra tier, neo convertRegionPrices |
| S-c | `detectCrossCurrencyTrigger` (`cross-currency.ts:86-112`) | (b)+(d) | đưa dòng vào nhánh cross (bỏ khớp theo SKU); Google Conversion ⇒ TỪ CHỐI |
| S-d | entry currency-của-app trong tier (`cross-currency.ts:188-228`) | (a)+(b) | neo quy đổi cho mọi vùng ngoài tier; tier thiếu entry ⇒ từ chối |
| S-e | custom prices: `appCurrencyForCustom` (`bulk-import.ts:387, :451-485`) | (a)+(b)+(d) | dưới template bắt buộc có entry app-currency và nó thành neo |
| S-g | `buildProduct` defaultPrice → US-stamp khi bootstrap lỗi (`adapter :278-289`), fallback legacy (`publisher-client :1239-1250`) | (a) | US=TWD 35 (đo); defaultPrice legacy theo app |
| S-b | wizard→execute mang `baseCurrency` của preview; execute tin client (`execute/route.ts:188-200, :228-229`) | (a) | chất mang của S-a |
| — | E1 lịch sử 2026-05-21 → 06-01 (`18840e1`…`a54f9fe`): wizard gửi `baseCurrency: appDefaultCurrency ?? r.baseCurrency` | (a) | MỌI dòng định giá theo currency app |

Phát hiện phụ (độc lập với currency app — cần Manager):
- Dưới nguồn template, giá GT trong file bị **thay bằng entry của tier** (`bulk-import.ts:947-952`, `:286`).
- Cột giá thứ hai bị **bỏ qua im lặng** (first-wins, `excel-parser.ts:180-194`).
- `PreviewTable` ghi "Auto-converted from USD" cứng — sai khi neo không phải USD, và hiện cả trên
  dòng đã bị từ chối (C2.1 đổi thành "Auto-converted by Google" / "Not sent — refused").

Ghi chú đáng giá: app **không có currency** (NULL) ⇒ không nhánh cross-currency, mọi dòng định giá
theo currency cột giá của chính nó; chỉ còn: header chung đọc là USD, custom-dưới-template bị từ chối.

### 5.4 THIẾT KẾ SỬA H4 — CHỜ GATE (chưa code; chunk riêng sau C2.1)

1. **MỘT choke point:** `filePriceOf(row) → {currency, priceMicros} | {refused, reason}` (module mới
   `orchestration/file-price.ts`). Mọi bước định giá (tra tier ở preview + orchestrator, neo bootstrap,
   defaultPrice của buildProduct, custom pre-pass) chỉ đọc hàm này.
2. **Gỡ currency của app ở tầng KIỂU:** xoá `ParseOptions.appDefaultCurrency` + nhánh fallback của
   parser, `BulkImportInput.appDefaultCurrency`, `cross-currency.ts`, `resolvedDefaultPrice`,
   `appCurrencyForCustom`, prop `appDefaultCurrency` của wizard/CustomPricesDialog ⇒ đưa lại là lỗi tsc.
3. **Tra tier:** `findRowCandidates({sku, currency file, micros file})` như nhánh same-currency hôm
   nay; vùng ngoài tier quy đổi từ GIÁ FILE.
4. **Google Conversion:** quy đổi từ giá file; KHÔNG từ chối vì lệch currency (⇒ dòng trước đây bị
   từ chối nay SẼ GHI — Manager xác nhận).
5. **Custom prices:** neo và defaultPrice luôn là giá file; không đòi entry currency app.
6. **Header chung không ghi currency** — Manager chọn: O1 (đề xuất) từ chối file "ghi rõ currency,
   vd Price (USD)" · O2 coi là USD · O3 Manager khai currency cho từng lượt import · O4 cột Currency mỗi dòng.
7. **Đóng twin path:** execute không tin `baseCurrency`/`priceHeaderSource` của client (parse lại file
   hoặc ràng preview bằng hash/token); từ chối file có >1 cột giá; US-stamp chỉ khi giá file là USD
   (hoặc từ chối khi bootstrap lỗi); fallback legacy gửi giá file — bị từ chối là lỗi trung thực.
8. **Audit:** mọi dòng ghi `file_currency`, header, neo `{currency, micros}`; batch ghi
   `pricing_rule: "file-currency-only/v1"`.
9. **Chữ:** banner (thay câu C2.1), Notes sheet `template-spec.ts:351-354`, cảnh báo parser
   `:400-414`, `template-spec.ts:18-24`, `design-bulk-import-template-download.md:18`.
10. **Test:** T1 bất biến route-level preview→execute với app USD/TWD/VND/NULL ⇒ body batchUpdate
    giống hệt (đỏ hôm nay trên cả hai cây); T2 structural cấm `appDefaultCurrency|default_currency|appCurrency`
    trong đường định giá; T3–T10 theo từng mục trên. **Mutation** M1–M7: đưa currency app trở lại
    parser / neo bootstrap / neo custom / từ chối lệch currency / execute nhận 'inferred' / đọc
    `app.default_currency` ở preview / US-stamp giá không phải file ⇒ ĐỎ.

Cần Manager chốt: O1–O4 · template miss = quy đổi hay từ chối · GT dưới template · chính sách US-stamp ·
chấp nhận fallback legacy từ chối · form tạo/sửa đơn lẻ (pre-fill currency từ app) có thuộc yêu cầu không.

Đo lượt import cũ của 7 app lệch currency: [`queries/audit-app-currency-price-influence.sql`](queries/audit-app-currency-price-influence.sql)
(theo batch, không theo SKU; header/`priceHeaderSource`/currency app lúc chạy KHÔNG được lưu ⇒
nhiều lớp là CHƯA BIẾT).

### 5.5 C2.1 — đã làm (chờ gate)

Gate chỉ còn D0; backfill một lần `20261016020000` (luật + khác biệt với route ghi trong header
migration); banner preview thay bằng mô tả đúng hành vi HÔM NAY (ghim nguyên văn bằng test).
Code định giá giữ **nguyên văn** bản đã deploy — nhưng ĐẦU VÀO của nó đổi theo C2-d: không còn
Refresh nào ghi `apps.default_currency`, nên app cache mới (hoặc đang NULL) sẽ ở NULL ⇒ định giá
không có currency app tham gia (gần với quyết định "file là nguồn duy nhất" hơn); app đang có giá trị
(kể cả 'guessed') giữ nguyên giá trị đó cho tới chunk H4.
Verify + thứ tự chạy: [`queries/verify-c1-c2-migrations.sql`](queries/verify-c1-c2-migrations.sql).

### 5.6 Dry-run backfill trên PRODUCTION (Manager chạy, 2026-10-17) + chunk C2.1a

**Số đo (ĐÃ ĐO, prod):** 271 hàng app; C1 + C2 đã chạy, V1.1–V2.5 khớp. Dry-run D1:
**34** app được backfill · **234** chưa từng có lượt Refresh nào tới bước audit · **2** chỉ có
Refresh ra 0 sản phẩm (`vng.games.tamquoc.chienky` mirror 16, `vng.g8.Phim` mirror 0) · **1** chỉ
có Refresh trước mốc c7edca0 (`com.vng.lineage2mvn`, 12 item lúc đó, mirror nay 21). D2 = 0, D2b = 0.
Manager chốt: chấp nhận gunnymobi.vn (14:58, 30/30), giữ synced>0, chấp nhận mọi điều kiện loại.

**⚠ KB — 5/7 app lệch currency CHƯA TỪNG có một lần Refresh IAP đầy đủ:** `com.vng.codmvn`
(mirror 28) · `gdo.projectx5` (27) · `vng.games.tamquoc.chienky` (16, lượt duy nhất 2026-10-12 trả
0 sản phẩm) · `com.gs2.omg` (5) · `vnggames.ananta.vn` (3). Mirror của chúng chỉ chứa hàng do tool
tạo ⇒ **mọi lượt import cũ của 5 app này đã chạy trên một mirror chưa từng được đọc từ Google**
(đúng hình dạng sự cố 彈彈英雄: SKU đã có trên Google bị coi là NEW ⇒ CREATE ⇒ Google từ chối).
Sau deploy cả 5 bị chặn tới khi Refresh thành công.

**Phát hiện phụ:** 彈彈英雄 có một lượt Refresh đầy đủ lúc 2026-10-16 08:49:11 UTC (SAU Overwrite,
code cũ) ⇒ mirror hiện là trạng thái 08:49, và code cũ đã đặt `default_language` = zh-TW (listing đầu
của sản phẩm đầu). Pháp y R3 Manager đã đóng (hiện trạng đúng ý team).

**C2.1a (chunk nhỏ trước push):** route Refresh IAP KHÔNG đóng dấu `iaps_last_synced_at` khi
Google trả 0 sản phẩm mà mirror còn item chưa bị đánh dấu xoá — một quy tắc duy nhất
`decideMirrorStamp` (bulk-import-mirror-gate.ts), một định nghĩa "mirror còn item"
`countLiveMirrorItems` (repository/iaps.ts) trùng điều kiện của backfill (`deleted_on_google_at IS
NULL`), test structural ghim hai phía. Không đóng dấu ⇒ log `[google-iap:iap-refresh] NOT stamping`,
audit `stamp_decision: skip:EMPTY_LIST_WITH_MIRROR_ITEMS`, response `mirror_warning` hiện trong wizard
và trang app. Mirror rỗng + Google rỗng ⇒ vẫn đóng dấu. Phần còn lại của D5 (không xoá mirror, cảnh
báo khi list rỗng ở mọi nơi, lượt đọc `incoming_below_…` mà route vẫn đóng dấu) ở C6.

