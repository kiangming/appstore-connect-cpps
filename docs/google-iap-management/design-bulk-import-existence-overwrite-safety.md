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

**Cập nhật phạm vi 2026-10-19** (map `[GOOGLE-single-edit-server-price-rules]`, §6.5 — đo trên mock tại `64557c9`):
- **D10 gồm cả SỬA ĐƠN LẺ, không chỉ bulk Overwrite** (KB P8). Ba phần dùng chung code với sửa đơn lẻ, đã đo:
  - ép `AVAILABLE` (adapter `onetime-product-adapter.ts:274`, `:287`) — sửa chỉ title vẫn gửi lại BY
    (`NO_LONGER_AVAILABLE` live) là AVAILABLE;
  - mask thuế: `FULL_UPDATE_MASK` có `taxAndComplianceSettings` mà body không mang (`publisher-client.ts:348-349`);
  - thay toàn bộ cấu hình vùng của option đích (adapter `:381-386`).

  Tự động ACTIVATE và tự sinh listing en-US vẫn chỉ ở bulk.
- **D4:** phương án **(A) tách riêng, làm sau `[GOOGLE-single-edit-server-price-rules]`** là ĐỀ XUẤT, CHƯA CHỐT
  (các phương án (A)/(B)/(C) ở §6.5). Câu D4 ở §3 mục 3 vẫn mở.

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
  ⚠ *Đính chính 2026-10-17 (§5.7):* chỉ với dòng template KHỚP tier hoặc resolve cross-currency; dòng
  template KHÔNG khớp vẫn gửi GT (`:943`, `:947`); custom prices thay GT dưới MỌI nguồn (`:475`).
- Dòng `import_batches` mồ côi `IN_PROGRESS` khi lỗi ném ngoài try (`bulk-import.ts:319-329`, `:766-784`).
- Một số dòng log lỗi Google không qua `redactSecrets` / trần 200 ký tự
  (`publisher-client.ts:1118-1122`, `:1214-1218`; `bulk-import.ts:1116-1120`, `:1195-1197`).
- Comment/tài liệu lệch code: banner wizard; JSDoc Props wizard ("threaded into the
  execute payload"); `iaps.ts:623-624` ("carries both" nhưng code dùng `||`);
  `excel-parser.ts:315`; migration `20260521000000:13-15`.
  ⚠ *2026-10-17:* ba mục đầu (banner wizard, JSDoc Props, `iaps.ts:623-624`) đã bị C2 `ace8fc9` xoá;
  còn lại `excel-parser.ts:315` và migration `20260521000000:13-15`.

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
⚠ *2026-10-17:* phép đo trên chạy bằng harness tạm NGOÀI repo. Nay thay bằng test T1 trong repo
(§5.7) — đo lại trên HEAD `375b735`: **33/33** tổ hợp (file × nguồn giá) cho kết quả phụ thuộc
currency app.

| # | Chỗ | Lớp | Hiệu ứng |
|---|---|---|---|
| S-a | ~~parser: header chung `Price`/`Default Price`/`Base Price` ⇒ currency = app (`excel-parser.ts:195-211`)~~ **ĐÓNG ở H4.1** (header như vậy ⇒ từ chối file, Q1) | (a)+(b) | defaultPrice, tra tier, neo convertRegionPrices |
| S-c | **ĐÓNG ở H4.2** — `detectCrossCurrencyTrigger` (`cross-currency.ts:86-112`) | (b)+(d) | đưa dòng vào nhánh cross (bỏ khớp theo SKU); Google Conversion ⇒ TỪ CHỐI |
| S-d | **ĐÓNG ở H4.2** — entry currency-của-app trong tier (`cross-currency.ts:188-228`) | (a)+(b) | neo quy đổi cho mọi vùng ngoài tier; tier thiếu entry ⇒ từ chối |
| S-e | **ĐÓNG ở H4.2** — custom prices: `appCurrencyForCustom` (`bulk-import.ts:387, :451-485`) | (a)+(b)+(d) | dưới template bắt buộc có entry app-currency và nó thành neo |
| S-g | **ĐÓNG ở H4.2** — `buildProduct` defaultPrice → US-stamp khi bootstrap lỗi (`adapter :278-289`), fallback legacy (`publisher-client :1239-1250`) | (a) | US=TWD 35 (đo); defaultPrice legacy theo app |
| S-b | *(H4.2: baseCurrency giờ là currency của header file, không còn mang currency app; execute vẫn tin client — kiểm lại phía server ở H4.3, Q9)* wizard→execute mang `baseCurrency` của preview; execute tin client (`execute/route.ts:188-200, :228-229`) | (a) | chất mang của S-a |
| S-i | **ĐÓNG ở H4.2** — *(bổ sung 2026-10-18, T1 F6 ở H4.1)* preview báo dòng cross-currency "will be refused on push" (`preview/route.ts:435-438`), nhưng dòng có custom prices dưới Google Conversion bỏ qua nhánh cross-currency ở execute (`bulk-import.ts:512`) nên VẪN được gửi | (d) | preview nói khác execute, và chỉ khi currency app ≠ currency file |
| S-h | **ĐÓNG ở H4.2** — *(bổ sung 2026-10-18, T1 F8)* dòng có trigger cross-currency tra tier CHỈ theo (neo, giá), KHÔNG thử tier đặt tên theo SKU (`preview/route.ts:260-264`, `bulk-import.ts:566-570` → `cross-currency.ts:162-182`); dòng không trigger thử SKU trước (`templates.ts:803-819`) | (b) | tier theo SKU chỉ được dùng khi currency app = currency file hoặc app không có currency |
| — | E1 lịch sử 2026-05-21 → 06-01 (`18840e1`…`a54f9fe`): wizard gửi `baseCurrency: appDefaultCurrency ?? r.baseCurrency` | (a) | MỌI dòng định giá theo currency app |

Phát hiện phụ (độc lập với currency app — cần Manager):
- Dưới nguồn template, giá GT trong file bị **thay bằng entry của tier** (`bulk-import.ts:947-952`, `:286`).
- Cột giá thứ hai bị **bỏ qua im lặng** (first-wins, `excel-parser.ts:180-194`). **ĐÓNG ở H4.1** (Q10).
- `PreviewTable` ghi "Auto-converted from USD" cứng — sai khi neo không phải USD, và hiện cả trên
  dòng đã bị từ chối (C2.1 đổi thành "Auto-converted by Google" / "Not sent — refused").

Ghi chú đáng giá: app **không có currency** (NULL) ⇒ không nhánh cross-currency, mọi dòng định giá
theo currency cột giá của chính nó; chỉ còn: header chung đọc là USD, custom-dưới-template bị từ chối.

### 5.4 THIẾT KẾ SỬA H4 — ĐÃ GATE 2026-10-17 (quyết định cuối ở §5.7)

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
   ⚠ *Đã chốt khác (§5.7):* Q8 — BỎ HẲN fallback legacy trên đường batch upsert (không sửa currency
   của nó); Q9 — execute kiểm lại TỪNG DÒNG phía server (không parse lại file, không hash/token).
8. **Audit:** mọi dòng ghi `file_currency`, header, neo `{currency, micros}`; batch ghi
   `pricing_rule: "file-currency-only/v1"`.
9. **Chữ:** banner (thay câu C2.1), Notes sheet `template-spec.ts:351-354`, ~~cảnh báo parser~~ (đã xoá ở H4.1 cùng nhánh header chung)
   `:400-414`, `template-spec.ts:18-24`, `design-bulk-import-template-download.md:18`.
   ⚠ *Thêm sau review H4.2:* mọi file còn nói luật custom cũ (`custom_no_app_currency_entry`, entry currency
   app bắt buộc, dialog chặn Save): `google-api-reference.md` (~:219-226), `docs/user-docs/index.html`
   (~:5486-5495), `operational-guide.md` (:470, :524), `design-bulk-import-custom-prices.md` — tra lại bằng
   `grep -rn custom_no_app_currency_entry docs`.
10. **Test:** T1 bất biến route-level preview→execute với app USD/TWD/VND/NULL ⇒ body batchUpdate
    giống hệt (đỏ hôm nay trên cả hai cây); T2 structural cấm `appDefaultCurrency|default_currency|appCurrency`
    trong đường định giá; T3–T10 theo từng mục trên. **Mutation** M1–M7: đưa currency app trở lại
    parser / neo bootstrap / neo custom / từ chối lệch currency / execute nhận 'inferred' / đọc
    `app.default_currency` ở preview / US-stamp giá không phải file ⇒ ĐỎ.
    ⚠ *2026-10-17 (§5.7):* T1 của H4.0 XANH — nó ghim hiện trạng (phụ thuộc currency app), chạy trên
    một cây (`375b735`); H4.2 lật nó, kèm bảng kỳ vọng suy ra tay + khẳng định theo luật.

Cần Manager chốt: O1–O4 · template miss = quy đổi hay từ chối · GT dưới template · chính sách US-stamp ·
chấp nhận fallback legacy từ chối · form tạo/sửa đơn lẻ (pre-fill currency từ app) có thuộc yêu cầu không.
⚠ *Đã trả lời 2026-10-17 — xem bảng Q1–Q10 ở §5.7* (form đơn lẻ: ngoài H4, chỉ là giá điền sẵn sửa được).

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

### 5.7 H4 — kế hoạch Manager đã chốt (2026-10-17) + H4.0

**Truy vết lại trước khi lập kế hoạch** (4 nhánh song song + kiểm đối kháng từng khẳng định, đọc
code tại HEAD `375b735`; 223/224 khẳng định CONFIRMED — khẳng định còn lại, "bản ghi duy nhất của giá
cuối là một dòng console VN, không lưu", SAI: `per_row_diagnostic` lưu giá VN của dòng template/custom
và `iap_prices` lưu giá Google trả về; đã sửa trước khi viết mục này). Ba điều chỉnh so với §4/§5.3:
- GT dưới template: chỉ bị thay khi dòng KHỚP tier (`bulk-import.ts:947-952`) hoặc resolve
  cross-currency (`:286`); không khớp ⇒ GT vẫn gửi (`:943`). Custom prices thay GT dưới mọi nguồn
  (`:475`). Mọi lần bỏ đều im lặng. Câu ghi chú wizard "with a pricing template the tier's price is
  used instead" (`BulkImportWizard.tsx:1490-1491` tại `375b735`) sai ở hai ca đó.
- GT chưa bao giờ được kiểm độ chính xác trước push: `decimalToMicros` ném trong `buildProduct`
  (`:234`), gọi ở `:1131` ngoài mọi try ⇒ cả batch 500, `import_batches` kẹt `IN_PROGRESS`.
- Bảng vùng của GT lệch catalog Play (snapshot 2026-09-01): `CNY→CN` (CN không có trong catalog),
  `ARS→AR` (Google bán AR bằng USD, `play-regions.snapshot.ts:76`).

**Manager chốt** (Q1–Q7, Q9, Q10 theo đề xuất; Q8 đổi):

| # | Quyết định |
|---|---|
| Q1 | Header `Price` / `Default Price` / `Base Price` (không ghi currency) ⇒ preview TỪ CHỐI file |
| Q2 | Bỏ nhánh cross-currency: mọi dòng tra tier theo SKU rồi currency + giá **của file**; defaultPrice + neo = giá file |
| Q3 | Template không khớp ⇒ quy đổi từ giá file, hiện rõ từng dòng |
| Q4 | Google Conversion, currency file ≠ app ⇒ quy đổi từ giá file (dòng trước bị từ chối nay SẼ GHI) |
| Q5 | GT: H4 KHÔNG đổi ngữ nghĩa; preview hiện GT + "sẽ gửi / bị tier thay / bị custom thay"; audit `gt: kept\|dropped\|none` |
| Q6 | Custom prices: neo + defaultPrice luôn là giá file; bỏ yêu cầu entry currency app (cả Save gate) |
| Q7 | US-stamp chỉ khi giá file là USD; quy đổi lỗi mà file không phải USD ⇒ từ chối dòng |
| Q8 | **ĐỔI:** BỎ HẲN fallback legacy (`inappproducts.batchUpdate`) trên đường batch upsert (một phần D4); lỗi API mới báo nguyên văn, có cấu trúc. 5 chỗ fallback còn lại để chunk D4 |
| Q9 | Execute kiểm lại từng dòng phía server (currency, độ chính xác giá + GT, cặp vùng/currency GT); sai ⇒ từ chối DÒNG; bỏ `priceHeaderSource` |
| Q10 | Từ chối file >1 cột giá; `Price (XXX)` phải là currency Play có bán; GT sai độ chính xác báo ở preview; sửa CNY/ARS |

Các bước: H4.0 (nhánh `arc-google-h4-file-currency-pricing` + T1 ghim hiện trạng) → H4.1 parser
(`filePriceOf`, Q1, Q10) → H4.2 định giá preview + orchestrator cùng commit (Q2–Q8; **T1 lật**) →
H4.3 execute + UI (Q9, Q5) → H4.4 audit + câu chữ. Push CHUNG một lượt sau H4.4.

**H4.0 — T1** ([`bulk-import/file-currency-invariance.test.ts`](../../app/api/google-iap-management/apps/%5BpackageName%5D/bulk-import/file-currency-invariance.test.ts)):
route preview + execute THẬT, parser, orchestrator, cross-currency, template queries, publisher
client, adapter. Phía wizard dùng CHÍNH code của wizard: ánh xạ dòng preview, chọn tier ban đầu, gate
Push (độ chính xác) và TOÀN BỘ body execute (`execute-payload.ts`), gate Save của custom prices
(`customAppCurrencyGate`, `custom-prices.ts`) — tách ra ở H4.0, hành vi không đổi (kiểm chênh lệch
trên 285 tổ hợp đầu vào). Một test jsdom của wizard bắt body fetch THẬT gửi tới execute và so với
builder ⇒ wizard thêm/sửa gì sau builder (vd đóng dấu currency app vào `baseCurrency`) là ĐỎ.
Giả: googleapis (không gửi gì), DB trong bộ nhớ (truy vấn chưa hỗ trợ / single() >1 dòng / thiếu tỷ
giá giả ⇒ ghi lỗi, test đỏ), session, account + credentials, app row, mirror IAP, sản phẩm live mà GET
trả về, audit, Hub. `convertRegionPrices` giả trả lại đúng giá vùng của neo — là tạo tác của bản giả:
Google làm gì với vùng gốc là **CHƯA BIẾT** (chỉ đo được bằng lệnh ghi lên Google — Manager chấp nhận).
Ma trận 11 file × 3 nguồn giá × 4 currency app (USD, TWD, VND, không có), mỗi ô chạy HAI LẦN: CREATE
và OVERWRITE (H4.0b, xem dưới) — gồm SKU trùng tên tier
(F8), giá / GT sai độ chính xác (F9, F10), GT trên dòng template không khớp (F11). So sánh: gate Push
và gate Save phía client, từ chối ở preview, dòng bị từ chối ở execute, neo `convertRegionPrices`,
**toàn bộ** request `batchUpdate`, các lệnh đổi trạng thái purchase option. Hiện trạng ghim: **33/33**
tổ hợp phụ thuộc currency app (`EXPECTED_GROUPS_TODAY`) + bảng 132 ô (`EXPECTED_TODAY`; ví dụ F7
`US=TWD 30`, F8 tier của SKU chỉ được dùng khi app USD/NULL, F9 app TWD: Push bị chặn và gọi thẳng
execute ⇒ 500). Bộ đếm mỗi lượt: ≤1 `batchUpdate`, 0 fallback legacy, 0 GET sản phẩm live.
**Khi lật ở H4.2:** "mọi nhóm thành `NULL+TWD+USD+VND`" CHƯA ĐỦ (từ chối mọi dòng cũng đạt). H4.2 phải
thay `EXPECTED_TODAY` bằng `EXPECTED_H4` suy ra TAY từ Q1–Q7 trước khi chạy, và thêm khẳng định theo
luật: neo = currency + giá của header; không từ chối ngoài các ca Q1/Q7/Q9/Q10; vùng GT mang giá GT khi
không khớp tier; custom xuất hiện nguyên văn; chặn suy biến (F3 ≠ F4 dưới google_default).
**T1 KHÔNG phủ Q8** (v3 luôn thành công nên fallback không thể chạm tới): H4.2 thêm test riêng — v3 lỗi
⇒ lỗi có cấu trúc trả nguyên văn, `inappproducts.batchUpdate` không bao giờ được gọi.

**H4.0b — Overwrite có định giá qua cùng thư viện với CREATE không? CÓ** (đọc code tại `dfc6366`):
- Orchestrator không rẽ nhánh giá theo `decision`: `decision` chỉ dùng để bỏ dòng Skip
  (`bulk-import.ts:338`), đặt cờ `isOverwrite: row.decision === "overwrite"` (`:1170`) và đếm kết quả
  (`:1192`). `buildProduct` (`:1131`), cross-currency, tra tier, custom, neo quy đổi chạy y hệt cho cả hai.
  Preview: `exists` chỉ là cờ hiển thị và bộ đếm (`preview/route.ts:411`, `:462-463`).
- Khác biệt DUY NHẤT nằm ở `batchUpsertInAppProducts`: dòng Overwrite GET sản phẩm live
  (`publisher-client.ts:1104-1124`) rồi adapter thay `regionalPricingAndAvailabilityConfigs` của option
  đích (`onetime-product-adapter.ts:378-385`) bằng ĐÚNG mảng giá mà CREATE dùng — mảng đó dựng bởi
  `buildRegionalPricing(iap)` trước khi rẽ nhánh (`:361-362`). Option khác giữ nguyên (`:375-377`).
- Đọc currency app ở chỗ nào riêng cho Overwrite không? KHÔNG: adapter không có tham chiếu nào (grep
  `appCurrency|default_currency|appDefaultCurrency`: chỉ một comment ở `:58`); trong `publisher-client.ts`
  `appCurrency` chỉ có ở `legacyFallbackBody` (`:686-701`), do insert/patch ĐƠN LẺ gọi (`:762`, `:850`),
  không phải đường batch. ⇒ Overwrite thừa hưởng NGUYÊN các chỗ A1–A8 + S-h, không thêm chỗ nào.
- ⇒ T1 mở rộng: mỗi ô chạy thêm một lượt OVERWRITE (mirror có SKU, Manager chọn Overwrite, GET live trả
  sản phẩm có option `legacy-base` + option `promo`). Khẳng định mới: **phần GIÁ của Overwrite = của CREATE
  ở cả 132 ô** (gate client, từ chối, neo, mảng giá của option đích), nhóm theo currency app giống nhau ở
  cả 33 tổ hợp; option đích là `legacy-base`, option `promo` trở về NGUYÊN VẸN; 92 ô gửi CREATE ⇔ 92 ô gửi
  OVERWRITE; mỗi Overwrite được gửi GET live đúng 1 lần. Bất biến H4.2 thiết lập cho CREATE vì vậy buộc
  đúng cho Overwrite. Chỉ phần GIÁ thuộc H4; "thay mù" (ép AVAILABLE, tự ACTIVATE, mask thuế) vẫn là D10.


**H4.1 — parser: file là nguồn duy nhất, MỘT choke point** (`orchestration/file-price.ts`):
- `filePriceOf({currency, priceDecimal})` / `fileRegionPriceOf({region, currency, priceDecimal})`: danh
  sách currency = catalog Play đo được (`PLAY_REGIONS`, 61 currency); độ chính xác = `decimalToMicros`;
  GT: cặp vùng/currency phải đúng như Google bill. Không nhận currency app (test structural cho cả
  `file-price.ts` lẫn parser). Parser không còn tham số currency app (`ParseOptions` xoá; preview gọi
  `parseIapTemplate(buffer)`).
- **Q1:** header không ghi currency (`Price` / `Default Price` / `Base Price`, mọi kiểu hoa/thường) ⇒
  TỪ CHỐI file. **Q10:** đúng MỘT cột giá — nhận `Price (XXX)` ở mọi kiểu hoa/thường và cả dạng có
  `Default`/`Base` phía trước; hai cột trở lên (mọi thứ tự) ⇒ từ chối file; header nào khác có chữ "price"
  (vd `Price USD`, `Price (US$)`, `Unit price`) ⇒ từ chối file, không còn bị bỏ qua im lặng; `Price (XXX)`
  mà XXX không phải currency Play bill (ABC, CNY, ARS…) ⇒ từ chối file.
- Dòng có giá hoặc GT không gửi đúng được (không phải số; nhiều số lẻ hơn currency cho phép; GT ở cặp
  vùng/currency Google không bill — `CNY→CN` (CN không bán), `ARS→AR` (AR bill bằng USD), giữ trong bảng
  CÓ CHỦ Ý để bị từ chối với lý do thật) ⇒ dòng KHÔNG được nhập; một thông báo nêu MỌI lý do của dòng.
  Preview trả các dòng đó trong `refusedRows`; wizard liệt kê bằng khung đỏ và **CHẶN Push** tới khi sửa
  file (như gate độ chính xác cũ) — không bao giờ nhập một phần mà im lặng. Tóm tắt "No row can be imported:
  N row(s) were not imported" đếm cả dòng bị từ chối lẫn dòng thiếu giá, hiện cùng thông báo dòng mẫu.
- Ô số: nhiễu số thực ≤ 1e-9 (vd 25999.99999999996) đọc thành giá trị 6 chữ số lẻ; số lẻ THẬT thứ 7+
  (4.9999999, 0.0000001) đi nguyên tới kiểm độ chính xác ⇒ dòng bị từ chối, không bị làm tròn thành giá khác.
- Câu ghi chú giá trong wizard đổi phần parser cùng commit (pin nguyên văn cập nhật; comment test sửa: pin
  chữ KHÔNG phát hiện được thay đổi giá — T1 làm việc đó).
- T1 (cùng commit): **3/33** tổ hợp bất biến trọn vẹn (F1 bị từ chối ở preview). F9/F10: wizard chặn Push
  với MỌI currency app, nhưng tab mở từ trước / POST thẳng vẫn gửi dòng đó và câu trả lời của server còn
  phụ thuộc currency app (500 vs từ chối; dưới template GT bị thay) ⇒ T1 mô phỏng cả POST thẳng, vẫn tách
  tới H4.3 (Q9). 24 tổ hợp còn lại tới H4.2. F6 dưới Google Conversion tách thêm vì cảnh báo preview sai
  (S-i). Ô gửi `batchUpdate`: 82 (CREATE = OVERWRITE), ghim con số chính xác.
- **Còn chờ Manager chốt** (hành vi cũ giữ nguyên): GT Currency không có trong bảng (vd `XYZ`), hoặc chỉ
  điền một trong hai ô GT ⇒ bỏ GT + cảnh báo, dòng vẫn nhập theo giá chính (vùng đó nhận giá quy đổi thay
  vì GT trong file). Đề xuất: thống nhất thành từ chối dòng như các lỗi GT khác.
- Dung sai cũ ghi nhận (không đổi ở H4.1): số 0 lẻ ở cuối được nhận với currency 0 chữ số lẻ (`"26.000"`
  VND ⇒ 26, có thể là dấu phân cách nghìn — Hotfix 5 cố ý nhận `"23000.00"`); giá 0 được nhận (Google có
  nhận giá 0 không: CHƯA BIẾT).

**H4.2 — định giá preview + orchestrator (cùng commit), Q2–Q8 + (a), (b) — Manager 2026-10-18:**
- **Một đường định giá cho mọi dòng.** Xoá hẳn `orchestration/cross-currency.ts` (+ test), nhánh
  cross-currency ở preview và orchestrator, `resolvedDefaultPrice`, `appCurrencyForCustom`,
  `BulkImportInput.appDefaultCurrency` (execute không còn truyền `app.default_currency`). Mọi dòng tra
  tier: tier đặt tên theo SKU trước, rồi tier có giá bằng **giá + currency của file** (Q2); không khớp
  ⇒ Google quy đổi từ giá file (Q3); Google Conversion không bao giờ từ chối vì currency (Q4). Neo
  `convertRegionPrices` và `defaultPrice` = giá file, mọi dòng (kể cả custom — Q6).
- **Choke point:** pre-pass ở orchestrator đưa giá chính + GT của file qua `filePriceOf` /
  `fileRegionPriceOf`; sai ⇒ từ chối DÒNG (`file_price_invalid`), không còn ném 500 cả batch.
- **Q7:** quy đổi lỗi (hoặc không trả US) và giá file không phải USD ⇒ từ chối dòng
  (`conversion_failed`); giá file USD thì US-stamp bằng chính giá file. Kiểm ở orchestrator, adapter
  dùng chung với sửa đơn lẻ KHÔNG đổi.
- **Q6:** bỏ yêu cầu entry currency app — cả refusal `custom_no_app_currency_entry` ở server lẫn gate
  Save trong dialog (`findAppCurrencyEntry` / `customAppCurrencyGate` xoá).
- **Q8:** đường batch upsert KHÔNG còn fallback legacy (`inappproducts.batchUpdate` + wrapper xoá); lỗi v3
  trả nguyên văn, có cấu trúc. 5 fallback đơn lẻ còn lại để D4.
- **(a)** currency không có số lẻ (theo bảng độ chính xác — VND, IDR, KRW, JPY, TWD…): ô CHỮ có "." hoặc
  "," ⇒ từ chối dòng ("có thể là dấu phân cách nghìn"); ô SỐ giữ cách đọc. Hotfix 5 (nhận số 0 lẻ ở cuối)
  giữ cho currency CÓ số lẻ ("0.990" USD). **(b)** giá chính hoặc GT = 0 ⇒ từ chối dòng.
- **GT thiếu một ô / currency ngoài bảng** ⇒ từ chối dòng (Manager chốt theo đề xuất). GT header sai
  hoa/thường (`gt price`) ⇒ từ chối file; `GT Price` / `GT Currency` đúng chữ không bị bắt nhầm (test).
- **Trạng thái Hub (P5):** dòng bị từ chối vì giá file (`file_price_invalid`, `conversion_failed`) tính là
  FAILED cho trạng thái kết thúc (như từ chối custom) — `priceRefusedRows`.
- **UI cùng commit (câu chữ phải đổi cùng định giá):** câu ghi chú giá của wizard thành MỘT đoạn không phụ
  thuộc currency app; wizard / dialog / trang không còn prop currency app; preview không trả `appCurrency`;
  cảnh báo "Tier lookup failed" không còn hứa "refused per-row"; Notes sheet của template tải về bỏ câu
  cross-currency. Kiểu `resolution` cross-currency trong UI là đồ thừa, dọn ở H4.3.
- **T1 lật:** 33/33 tổ hợp bất biến cho CREATE và OVERWRITE; kết quả đúng bằng bảng `EXPECTED_H4` suy
  ra TAY từ Q1–Q7 TRƯỚC khi chạy code (bản có dấu thời gian 23:17:05, md5 `9e6009…bb`, không sửa sau
  đó; khớp ngay lần chạy đầu); khẳng định theo luật tính từ file (neo = currency + giá header; từ chối chỉ
  ở F7/F9/F10; giá US luôn USD; custom và GT đúng nguyên văn) + chặn suy biến; 84 ô gửi. Test Q8 riêng ở
  mức route (v3 lỗi ⇒ 403 + lý do nguyên văn, `inappproducts.batchUpdate` 0 lần) và ở mức publisher.
  **T2** structural: không file nào trên đường định giá bulk import đọc currency app.
- **Sau review đối kháng H4.2 (4 lăng kính + kiểm chứng):**
  - **CSV / file chữ lách (a)** (MAJOR, đã đo): SheetJS đoán số cho file chữ ⇒ "26.000" dưới `Price (VND)`
    thành SỐ 26, bỏ qua luật dấu phân cách, gửi giá thấp 1000 lần. Sửa ở chỗ đọc duy nhất:
    `XLSX.read(…, { raw: true })` ⇒ ô của file chữ luôn là CHỮ (ô xlsx không đổi). Test CSV.
  - **Thiếu cả CỘT GT** (`GT Price` mà không có `GT Currency`, hoặc gõ sai "GT Curency") ⇒ trước bỏ mọi GT
    im lặng; nay từ chối FILE, nêu cột thiếu (`gt_column_missing`) — cùng luật "cả hai hoặc không".
  - **Lý do Q7** tách theo nhánh: quy đổi LỖI ⇒ "không gửi khi thiếu quy đổi (các nước không có trong
    tier/custom sẽ không có giá)"; quy đổi KHÔNG CÓ US ⇒ "không có giá US đúng". Điều kiện từ chối giữ
    nguyên (Q7 nguyên văn): dòng tier/custom có US vẫn bị từ chối khi quy đổi lỗi — ⚠ câu hỏi cho Manager
    ở báo cáo H4.2.
  - **`import_batches`** nhánh có push: dòng bị từ chối tính vào `rows_failed` + `FAILED` như hai nhánh
    kia (một luật cho cả ba; CHECK chỉ cho PENDING/IN_PROGRESS/COMPLETE/FAILED).
  - **Test bổ sung:** T1 ghi trạng thái Hub thật (72 ô bị từ chối ⇒ FAILED, 168 ô gửi ⇒ SUCCESS — chốt
    `priceRefusedRows` đầu-cuối), so Overwrite/CREATE thêm `regionsVersion`; kết quả T1 thêm **tier ứng viên
    của preview** (cái Manager thấy và chọn) — mutation "preview tra tier theo currency app" trước chỉ đỏ ở T2
    vì fallback SKU→giá của orchestrator tìm lại đúng tier, request gửi Google không đổi; T2 cấm `inappproducts.batchUpdate`
    trong TOÀN file publisher; Q8 thêm 503 + Error trơn; bar O1 (`throwBothFailed`) chuyển sang
    `getInAppProduct` (5 fallback còn lại đều kết thúc ở hàm đó); `bulk-import.price-refusals.test.ts` chốt 2 nhánh Q7
    T1 không phủ (USD + quy đổi lỗi ⇒ VẪN gửi; TWD + quy đổi không có US ⇒ từ chối) + bộ đếm.
  - **Câu chữ:** Notes sheet hàng GT (trước "dropped with a warning"), câu tier/GT của ghi chú wizard,
    header orchestrator (fallback legacy, bootstrap "non-fatal"), `status-mapping.ts` (từ chối không còn là
    "skipped").
  - **KHÔNG sửa ở H4.2 (ghi BACKLOG / H4.4):** giá CUSTOM chưa áp (a)/(b) — quyết định Manager chỉ nêu ô
    file và GT, validator dùng chung với form sửa đơn lẻ ⇒ `[GOOGLE-custom-prices-separator-zero]`; entry
    tier sai độ chính xác vẫn ném cả batch (`[GOOGLE-bulk-import-db-throws-outside-try]`).

**H4.3 — execute + UI (Q9, Q5) + custom (a)/(b) + tier sai độ chính xác — Manager 2026-10-18/19:**
- **(a)/(b) cho giá gõ tay (Manager chốt 1):** quy tắc nằm ở MỘT hàm `statedPriceOf` / `statedPriceError`
  (`orchestration/file-price.ts`), dùng chung cho file (`filePriceOf` = cổng Play + `statedPriceOf`), dialog
  custom (`validateCustomPrices`), form sửa đơn lẻ (`IapForm` `validateDecimal` + cổng gọi Google của
  `fetchDerivedForBase`) và kiểm lại phía server (pre-pass custom của orchestrator). **KHÔNG** đặt vào
  `validateDecimalForCurrency`: đã đo — form tự điền giá cache dạng `"26000.00"` (microsToDecimal(m,2)) và
  route catalog trả `"26000.000000"`; luật (a) ở đó chặn MỌI lần sửa item mặc định VND (kể cả chỉ đổi tên).
  Sửa hai nguồn điền: `form-state.ts` (số nguyên ở currency 0 số lẻ ⇒ không dấu chấm; TWD 6.30 giữ nguyên —
  không làm tròn) và route catalog (`stripTrailingZeros`, một bản chung trong `price-conversion.ts`).
  Thứ tự luật đổi nhẹ: phần lẻ không thể là nhóm nghìn ("30.5", "26.50", "6.3000" — 1, 2 hoặc ≥4 chữ số) báo
  bằng lời của luật độ chính xác (Google tự viết TWD 6.30 — gọi nó "dấu phân cách nghìn" là sai hướng); ",", nhiều
  ".", phần lẻ toàn 0 hoặc ĐÚNG 3 chữ số ("49.900") vẫn là lời dấu phân cách. Tập giá trị bị từ chối không đổi. Phía server của sửa đơn lẻ CHƯA có (a)/(b) (BACKLOG).
- **Q7 (Manager chốt 2):** giữ từ chối dòng đã có giá US khi quy đổi lỗi. Lý do nói rõ "Google's price
  conversion failed temporarily (…) — this is not a problem with the row's data: run this row again later".
  Ba lớp, mỗi lớp nói đúng nguyên nhân: lỗi mạng / 5xx / 408 / 429 / không có HTTP status ⇒ "temporary"
  (đúng lời Manager); 400 INVALID_ARGUMENT ⇒ "Google rejected the file price … as invalid — check the price";
  4xx khác (401, 403 PERMISSION_DENIED — lớp sự cố 2026-10-12 —, 404, 400 token invalid_grant) ⇒ "an access,
  account or app problem, not the row's data, and not temporary". Nhánh "không có giá US" giữ lời riêng.
- **Q9:** kiểm từng dòng phía server đã có từ H4.2 (pre-pass `filePriceOf` / `fileRegionPriceOf`). H4.3
  thêm: giá custom kiểm bằng `statedPriceOf` ở orchestrator (một đường từ chối — route chỉ kiểm cấu trúc;
  bộ custom rỗng ⇒ từ chối dòng thay vì 400 cả batch); sửa lỗi orchestrator ghi đè lý do từ chối của route
  ("no country prices were supplied") và dấu chấm kép. Bỏ `priceHeaderSource` khắp nơi. ⚠ Tab xem trước
  TRƯỚC H4 (đang chạy production) gửi `inferred` + currency app và tier đã khớp chéo currency — không gì
  trong dòng nói điều đó. Thay bằng `pricing_rule: "file-currency-only/v1"` (`lib/google-iap-management/
  bulk-import-contract.ts`, dùng chung client + route) do `buildExecuteRequestBody` gửi; thiếu ⇒ 409
  `PREVIEW_OUTDATED` ("Reload this page, then upload the file and run Preview again" — tab cũ chạy code cũ,
  upload lại trong cùng tab sẽ gửi lại đúng body cũ), không ghi gì, Hub FAILED.
  `regionOverrides` / `listings` sai cấu trúc ⇒ 400 sạch (trước: TypeError không bắt).
- **Dòng bị từ chối trong preview (Manager chốt ở H4.1 gate):** hiện TRONG bảng preview (hàng "Not imported"
  + lý do, không có nút quyết định / tier / custom). Push cho phần còn lại sau hộp xác nhận nêu số dòng bị bỏ
  và tên từng dòng; Cancel không đụng Hub run. Dòng bị bỏ gửi lên server qua `droppedRows` (cùng builder),
  dedupe theo rowNumber (với dòng gửi và với nhau), tối đa `MAX_DROPPED_ROWS` = 20000 (wizard tắt Push trên
  mức đó bằng CÙNG hằng số — không bao giờ gặp 400 "malformed"); orchestrator tính vào `rows_total`, `refusedRows` (kind `refused_in_file`, theo thứ tự
  file), `import_batches.rows_failed`, audit (`dropped_in_file_rows`); route đếm Hub bằng `rowsRefused` (mọi
  kind, cả kind mới). Hộp xác nhận đóng khi wizard rời bước preview (không thể hiện lại trên một preview KHÁC)
  và nút OK kiểm lại cùng cổng với Push. Done: tiêu đề theo kết quả (complete / finished — N not imported
  (X failed at Google, Y not sent) / nothing imported), tile "Not sent", liệt kê MỌI dòng không gửi theo tên,
  chia "left out in the file" / "refused at push", không cắt 20, không lặp "Row N (sku)" (dòng Google báo lỗi
  chỉ có số đếm — kết quả không mang tên từng dòng). Không còn dòng biến mất im lặng: dòng ghi một sản phẩm
  (giá, GT Price, title hoặc description) mà thiếu Product ID (trước: biến mất hoàn toàn) và dòng trống giá
  (trước: chỉ cảnh báo) giờ là dòng bị từ chối có lý do. KHÔNG tính: công thức kéo xuống cho kết quả rỗng / 0,
  GT Currency điền tràn, cột lạ, ghi chú "delete the sample rows" của template.
- **GT trong preview (Q5):** `gtPlanOf` (execute-payload.ts) đọc ĐÚNG các biểu thức `buildExecuteRows` gửi ⇒
  dòng "GT VN 26000 VND · will be sent / replaced by tier "X" (VN …) / replaced by custom (…) / depends on the
  tier you pick / not sent (Skip)". Giá tier chỉ biết cho VN (TierCandidate) — nước khác nói "the tier's price,
  or Google's conversion if the tier has none". Tra tier lỗi ở preview ⇒ `tierMatchedBy: "lookup_failed"`:
  cột Tier "Tier lookup failed — run Preview again" và GT "unknown" (trước: giống hệt "không có tier").
- **Tier sai độ chính xác (gộp vào H4.3):** `storedRegionPriceOf` (cùng `statedPriceOf`, trên micros —
  "26000.000000" không phải dấu phân cách) kiểm entry của tier NGAY SAU khi tra, trước bộ đếm lựa chọn ⇒ từ chối
  DÒNG `tier_price_invalid` (nêu tier, nước, lý do, "Fix the tier in Settings → Pricing Templates"); batch chạy
  tiếp, kết thúc đúng trạng thái. Áp cả (b): entry 0 bị từ chối (cùng chiều với dialog, vốn đã chặn seed 0).
  KHÔNG kiểm cặp vùng/currency với snapshot (Hotfix 9: snapshot có thể lệch catalog sống). Thêm lưới an toàn
  quanh `buildProduct`: nếu vẫn ném ⇒ từ chối dòng `price_build_failed` (kind riêng — không thể che một kiểm
  tra bị gỡ). Các chỗ "DB ném ngoài try" còn lại (templateExists, findTemplateId, tra tier/SKU/probe, tier mất
  entry, >100 dòng) là cơ chế KHÁC (lỗi DB/mạng/logic, không phải dữ liệu giá) ⇒ vẫn ở
  `[GOOGLE-bulk-import-db-throws-outside-try]`.
- **Dọn:** kiểu `PreviewResolution` / `resolution` cross-currency, nhánh UI tương ứng, cổng precision dùng
  `filePriceOf`.
- **Test:** T1 vẫn 33/33, bảng tay không đổi (md5 `9e6009…bb`); thêm test đầu-cuối "push the rest" qua route
  thật (1 tạo + 2 bỏ ⇒ import_batches 3/FAILED/2, Hub PARTIAL). Route: `PREVIEW_OUTDATED`, droppedRows dedupe,
  400 cấu trúc, Hub đếm mọi kind. Orchestrator: tier 30.5 / 0, bộ đếm lựa chọn, custom (a)/(b) + lý do của
  route, dropped rows, Q7 4 nhánh phân loại, lưới `price_build_failed`. Wizard: hàng refused trong bảng, hộp
  xác nhận (không gửi trước khi xác nhận; Cancel không huỷ Hub run; Confirm ⇒ đúng 1 execute kèm droppedRows),
  Done liệt kê đủ + tile cộng đúng tổng, GT labels. Form đơn lẻ + dialog: "26.000"/"0" bị chặn, seed không bị chặn.

**H4.4 — audit, finalize-in-finally, câu chữ, kiểm template trước push — Manager 2026-10-19:**
- **Chốt gate H4.3:** Q7 ba lớp · entry tier = 0 ⇒ từ chối · dòng trống giá ⇒ từ chối (batch PARTIAL) · làm
  finalize-in-finally trong H4.4.
- **finalize-in-finally (KB P10):** thân `executeBulkImport` chạy trong try/finally sau khi chèn hàng
  `import_batches`; mọi lối ra hợp lệ đóng hàng qua MỘT hàm `finalizeImportBatch` (đánh dấu đã đóng TRƯỚC khi
  ghi — finally không bao giờ ghi đè một kết quả thật; kiểm `error` của lần ghi, lỗi ⇒ log, KB P2). Lối ra ném
  lỗi (DB/mạng khi tra template, tier trôi, >100 dòng, …) ⇒ finally đóng `FAILED`, `rows_failed` = số dòng
  không Skip (không dòng nào đã ghi: mọi chỗ ném đều trước bước push). Lỗi vẫn tới route như trước. Đây là
  cơ chế đóng hàng — các chỗ ném đó vẫn là lỗi cả batch, không phải từ chối dòng (BACKLOG). Batch đóng bởi
  finally vẫn có một dòng audit (`closed_by: "finally"`, `pricing_rule`, `price_header`, nguyên nhân), và log
  ghi nguyên nhân. Giới hạn: nếu chính lần GHI đóng hàng thất bại, hàng còn `IN_PROGRESS` (có log).
- ⟲ 2026-10-21 ([GOOGLE-bulkimport-drop-gt], design `design-bulkimport-drop-gt-columns.md`): GT không còn được đọc; `pricing_rule` lên `file-currency-only/v2`, `gt` / `gt_outcome` bỏ khỏi `per_row_pricing`, thêm `gt_rows_with_data`. Đoạn dưới là thiết kế H4.4 tại thời điểm đó.
- **Audit (§5.4 mục 8):** payload `BULK_IMPORT_BATCH` thêm `pricing_rule: "file-currency-only/v1"`,
  `price_header` (header giá đúng như file ghi — parser → preview → wizard → builder → route → orchestrator;
  đây là dữ kiện mà audit cũ không có, §5.3) và `per_row_pricing` cho mọi dòng gửi trong `rows` (dòng bị
  bỏ trong file nằm ở `refused_rows`, kind `refused_in_file`): `file_currency`, `file_price`, `gt` +
  `gt_outcome` (`none` / `kept` / `replaced_by_tier` / `replaced_by_custom` / `not_sent`), `anchor
  {currency, price_micros}` gửi Google quy đổi (ghi cả khi quy đổi lỗi), `regions_version` mà REQUEST đã ghim
  + `regions_version_from` (`conversion` / `publisher_default`; null nếu không gửi), `outcome` lấy SAU bước
  push (`written` / `google_failed` / `cache_sync_failed` / `google_rejected` / `skipped` / kind từ chối).
  Khoá theo object dòng (rowNumber không bảo đảm duy nhất với POST trực tiếp).
- **Câu (ii):** ghi chú giá của wizard mở đầu bằng "Prices come only from the file." (C2.1 đã ship câu (i);
  câu (ii) chờ tới khi bản sửa giá làm nó đúng).
- **SQL chỉ đọc trước push:** `queries/audit-template-entries-h4.sql` — CHẠY TỪNG CÂU (SQL Editor chỉ hiện câu
  cuối; câu chặn push đặt cuối). Q1 tổng quan · Q2 entry lệch catalog Play mà H4 không kiểm (vẫn gửi) · Q3 dòng
  import nào có thể bị từ chối (dự báo dư, không bao giờ thiếu) · Q4 CÂU CHẶN PUSH: entry H4 sẽ từ chối. Hai
  bảng nhúng (độ chính xác currency, 173 vùng Play) sinh từ code và được test ghim; phần còn lại của file ghim
  bằng md5; quy tắc từ chối của SQL được so với `storedRegionPriceOf` trên 476 tổ hợp. Chưa chạy thử trên
  Postgres (máy không có) — câu chỉ đọc.


---

## 6. `[GOOGLE-single-edit-server-price-rules]` — KẾ HOẠCH, HOÃN

**⏸ HOÃN 2026-10-19 (Manager).** Lý do: không gấp — đường bulk (dùng chính) đã sửa ở H4; form đơn lẻ đã
chặn "26.000"/0 ở phía trình duyệt từ H4.3; prod có 0 entry tier hỏng (§35.5 KB: Q1 0 dòng, Q4 0 dòng);
quy đổi lỗi hiếm. Lỗ còn lại chỉ ở phía server (tab cũ chưa reload / gọi API trực tiếp).

**Tham chiếu:** mọi `file:line` dưới đây là tại commit `64557c9` (H4.4 — đã lên `origin/main`). Kế hoạch
chép NGUYÊN từ báo cáo bước 4 gửi Manager ngày 2026-10-19; CHƯA CODE dòng nào.
**⚠ Mọi ô ĐÃ ĐO là đo trên MOCK:** code thật chạy, Google/DB/đăng nhập là giả, bảng tỷ giá do agent đặt ra.
Phản ứng thật của Google ở mọi ô là **CHƯA BIẾT**. Nguồn: 4 agent đọc code + chạy probe, 1 agent kiểm chéo
(probe ở scratchpad, repo không đổi); các `file:line` chính đã grep lại.

Câu cần Manager quyết trước khi làm: §6.6 (Q-a → Q-g), phương án D4 ở §6.5.

### 6.1 Mọi chỗ ở server đơn lẻ có tính hoặc kiểm giá

Không chỗ nào đi qua `statedPriceOf` / `filePriceOf` / `storedRegionPriceOf`. Cách tra: grep
`file-price|statedPrice|storedRegionPriceOf|filePriceOf|classifyConversionFailure` trên cả hai route,
`create-iap`, `update-iap`, `publisher-client`, adapter và `regions-helper` ⇒ exit 1, không có kết quả.

| Chỗ | Đường | Làm gì hôm nay |
|---|---|---|
| `iaps/route.ts:128-134` | tạo | lọc dòng; thiếu currency thì tự thành `"USD"` (`:132`) |
| `iaps/route.ts:138-173` | tạo | tra tier, rồi **thay hết** các dòng gõ tay bằng `microsToDecimal(e.priceMicros, 6)` → chuỗi `"x.000000"` (`:168-172`) |
| `create-iap.ts:101` | tạo | base qua `decimalToMicros(base, currency)`: chỉ kiểm số lẻ, nhận 0 |
| `create-iap.ts:108-114` | tạo | dòng gõ tay và dòng tier qua cùng một hàm, không phân biệt nguồn |
| `create-iap.ts:149-159` | tạo | quy đổi lỗi thì bỏ qua mọi lớp lỗi rồi gửi tiếp |
| `iaps/[sku]/route.ts:136-144` | sửa | lọc dòng; thiếu currency thì thành `"USD"` (`:141`); đọc cờ `dirty` |
| `iaps/[sku]/route.ts:146-188` | sửa | **bản sao** nhánh tier của route tạo; dòng tier mang `dirty:false` (`:182-187`) |
| `update-iap.ts:109-117` | sửa | dòng dirty: kiểm số lẻ (`:114`); dòng non-dirty (gồm cả dòng tier): **không kiểm** (`:115`) |
| `update-iap.ts:124` | sửa | base: chỉ kiểm số lẻ |
| `update-iap.ts:150` | sửa | ảnh chụp trước khi sửa lấy `default_currency ?? "USD"` |
| `update-iap.ts:219-239` | sửa | base đổi ⇒ quy đổi ghi đè **mọi** vùng, kể cả dòng tier (`:233`) |
| `update-iap.ts:248-254` | sửa | quy đổi lỗi thì bỏ qua, patch vẫn gửi với regionsVersion `"2022/02"` |
| `iaps/route.ts:198-206`, `iaps/[sku]/route.ts:214-220` | cả hai | một Error thường thành HTTP **500** |

(`iaps/…` = `app/api/google-iap-management/apps/[packageName]/iaps/…`; `create-iap.ts` / `update-iap.ts` ở
`lib/google-iap-management/orchestration/`.)

**Nơi ghi giá lên Google** (grep tên hàm ghi, bỏ file test): chỉ có `create-iap.ts:176`, `update-iap.ts:270`
và `bulk-import.ts:1220`. Không có đường ghi giá đơn lẻ nào khác.

**Test hiện có:** chưa có test nào cho `create-iap` hay cho route POST/PATCH `iaps`.

### 6.2 Bảng 3 đường × các trường hợp

Ghi chú về các ô của Sửa:
- **"Base đổi"** là trường hợp thường khi chọn tier: form dời base về giá USD của tier (`IapForm.tsx:499-505`).
- **"noOp"** nghĩa là server trả `hasChanges:false`, nhưng form vẫn báo "updated" (`IapForm.tsx:739`).

| Trường hợp | Bulk hôm nay | Tạo đơn lẻ hôm nay | Sửa đơn lẻ hôm nay | Sau chunk (cả 3 đường) |
|---|---|---|---|---|
| Tier TWD 30.5 (sai số lẻ) | từ chối `tier_price_invalid` (`bulk-import.ts:819-833`) | **500**, câu báo lỗi không nêu tier hay vùng | base không đổi ⇒ **gửi** TWD 30.5; base đổi ⇒ quy đổi đè lên; base đổi + quy đổi lỗi ⇒ **gửi** 30.5 với `2022/02` | từ chối `tier_price_invalid`, cùng câu lý do; đơn lẻ trả **422**, 0 lệnh ghi |
| Tier giá 0 | từ chối | **gửi** TW=0 (201) | **gửi** 0, hoặc bị quy đổi đè | như trên |
| Gõ "26.000" VND | từ chối `custom_invalid_price` (`:524`) | **gửi** VND 26 | **gửi** VND 26 | từ chối, cùng câu (a) |
| Gõ 0 | từ chối | **gửi** 0 | **gửi** 0 | từ chối, cùng câu (b) |
| Base gõ "26.000" VND / 0 | từ chối `file_price_invalid` | **gửi**, quy đổi từ VND 26 / 0 | **gửi**, quy đổi lại cả catalog từ VND 26 / 0 | từ chối |
| Quy đổi lỗi, base không USD | từ chối `conversion_failed`, 3 lớp lỗi (`:1026-1038`) | 201, **US mang giá TWD/VND**, `2022/02` | có US ⇒ noOp, thay đổi base **mất**; không có US ⇒ US = VND; có tier ⇒ vùng ngoài tier **bị rớt** | từ chối, 3 lớp lỗi (phạm vi ở đơn lẻ chờ Q-b) |
| Quy đổi lỗi, base USD | gửi, chỉ có US, `2022/02` | giống bulk | đổi base ⇒ noOp; chỉ sửa title ⇒ patch với `2022/02` | **chờ Q-b** |

Ba đường chỉ cho cùng kết quả ở hai ca: các ca đối chứng (giá đúng), và "quy đổi lỗi + base USD" giữa bulk
và tạo đơn lẻ.

### 6.3 Một choke point duy nhất (P1)

1. **Module thuần mới** `lib/google-iap-management/orchestration/item-price-rules.ts`:
   - **Chuyển nguyên văn từ `bulk-import.ts`:**
     - `classifyConversionFailure` (`:272-292`);
     - `conversionFailedReason` (`:294-317`): nhận "head + giá" thay vì cả `BulkImportRow`;
     - điều kiện Q7 (`:1026-1027`) thành `conversionRefusal()`;
     - kiểm entry tier (`:819-833`) thành `tierEntriesRefusal()`;
     - vòng kiểm giá custom (`:515-530`) thành `statedPricesRefusal()`.
   - **Bulk import ngược lại** các hàm này. T1 và `bulk-import.price-refusals.test.ts` phải xanh mà **không
     sửa dòng test nào**. Đó là bằng chứng chỉ chuyển chỗ, không đổi hành vi.
2. **`checkItemPrices()`** cho hai đường đơn lẻ, gọi trong `createIapOnGoogle` và `updateIapOnGoogle`
   **trước mọi lệnh gọi Google**. Luật chọn theo **ai viết ra giá đó**:

   | Ai viết giá | Gồm những giá nào | Kiểm thế nào |
   |---|---|---|
   | Manager gõ | base khi tạo, dòng khi tạo, dòng dirty khi sửa, base khi sửa **nếu Manager đổi nó** | `statedPriceOf` |
   | Tier trong template | entry tier, ở dạng **micros** | `storedRegionPriceOf` |
   | Google viết | dòng non-dirty, base không đổi, giá do Google quy đổi | **không kiểm**; gửi lại nguyên byte (TWD 6.30 vẫn là 6300000) |

   - Phép đổi số không kèm currency (`update-iap.ts:115`) chuyển vào module này.
   - Không được áp `statedPriceOf` lên chuỗi `"x.000000"` mà route tạo ra. ĐÃ ĐO: làm vậy thì mọi tier
     VND/TWD/JPY hợp lệ đều bị từ chối.
3. **Gộp hai nhánh tier** (`iaps/route.ts:138-173` và `[sku]/route.ts:146-188`) vào một helper. Helper giữ
   entry ở dạng micros kèm nguồn, và bỏ bước đổi sang chuỗi.
4. **Bỏ `?? "USD"`** ở `:132` và `:141`. Thiếu currency hoặc currency rỗng thì từ chối với câu của bulk
   "missing its country or currency" (`bulk-import.ts:520-522`). ĐÃ ĐO: currency `""` hôm nay đi tới Google
   thành `currencyCode ""`.
5. **`conversionRefusal()`** chạy sau bước quy đổi và trước `insertInAppProduct` / `patchInAppProduct`. Nó ở
   tầng orchestrator, **không** nằm trong adapter hay trong khối `try` của publisher. ĐÃ ĐO: đặt ở đó thì
   fallback legacy nuốt mất lời từ chối và gửi body chưa kiểm lên API cũ.
6. **Lỗi trả về:** ném `PriceRefusalError`. Hai route bắt nó trước và trả **422**
   `{error, code:"PRICE_REFUSED", kind, refusals[]}`. Form đã hiện `body.error` (`IapForm.tsx:680`, `:735`),
   nên không cần đổi UI để hiện câu báo.
7. **Client đồng bộ với server (P14):** form sửa hiện chỉ *cảnh báo* entry tier sai. Cần chặn luôn ở form bằng
   `storedRegionPriceOf`, chạy trên `priceMicros` mà route tier-entries đã trả về. Nếu không, Manager thấy
   cảnh báo vàng rồi lại nhận 422.

### 6.4 Test bất biến và mutation

**File:** `app/api/google-iap-management/apps/[packageName]/iaps/price-rules-invariance.test.ts`.
- Chạy ba route thật: bulk execute, POST `iaps`, PATCH `iaps/[sku]`.
- Dùng googleapis giả trong bộ nhớ, `fakeDb` của T1 và `queries/templates.ts` thật.
- Một bảng CASES, kèm ba bộ chuyển đổi: `toBulkRow`, `toCreateBody`, `toEditBody`.

**Phải khẳng định:**
1. Kết quả bulk == tạo == sửa. Kết quả được chuẩn hoá thành {verdict, kind, lớp lỗi quy đổi, giá gửi đi ở các
   vùng ca đó nêu + US, regionsVersion}.
2. Mỗi kết quả bằng một **EXPECTED ghim bằng tay**. Chỉ so ba đường với nhau thì không bắt được lỗi bên trong
   module chung, vì cả ba sẽ sai giống nhau.
3. Ca bị từ chối ⇒ 0 lệnh ghi, kể cả `inappproducts.*` legacy.
4. Các ca riêng của Sửa, theo ai viết giá:
   - TWD 6.30 không đụng tới ⇒ gửi lại 6300000;
   - seed tab cũ `"26000.00"` không đổi ⇒ qua;
   - base gõ "26.000" ⇒ từ chối.
5. Kiểm cấu trúc: bốn file đơn lẻ không import `decimalToMicros` / `microsToDecimal`.

**Không khẳng định** availability, mask hay option, vì đó là việc của D10; khẳng định ở đây sẽ ghim hành vi
hiện tại của D10. Ca "gõ tay dưới tier" để ngoài test cho đến khi có Q-f.

**Mutation** (chỉ qua `scripts/mutate.sh`), mỗi cái phải đỏ đúng lý do:

| # | Sửa gì | Ca phải đỏ |
|---|---|---|
| M1 | `storedRegionPriceOf` trong module luôn trả ok | EXPECTED đỏ (so ba đường vẫn xanh) |
| M2 | route sửa đổi tier lại thành chuỗi `dirty:false` | A/B ở đường sửa |
| M3 | áp `statedPriceOf` lên dòng non-dirty | ca TWD 6.30 |
| M4 | chuyển bước kiểm ra sau lệnh ghi | ca 0 lệnh ghi |
| M5 | bỏ luật từ chối currency trống | ca currency `""` |
| M6 | đường tạo bỏ `conversionRefusal` | ca quy đổi lỗi ở đường tạo |
| M7 | base khi sửa luôn coi là Manager gõ | ca seed tab cũ |
| M8 | base khi sửa luôn coi là Google viết | ca base "26.000" |
| M9 | `PriceRefusalError` trả 500 | ca mã trạng thái |
| M10 | vòng custom của bulk quay về `decimalToMicros` | C/D |

**Đề xuất thứ tự commit** (giống H4.0 → H4.4):
- S0: test ghim hiện trạng;
- S1: chuyển luật bulk sang module, không đổi hành vi;
- S2: hai đường đơn lẻ đi qua choke point, các ca lật xanh;
- S3: client đồng bộ + tài liệu + BACKLOG.

### 6.5 Quan hệ với D4 và D10 (đề xuất, chưa gộp)

**D4 — 5 fallback legacy trong `publisher-client.ts`:**
- Năm chỗ:
  - list `:244`;
  - get `:299`;
  - insert `:757-771`, chỉ được gọi từ đường tạo;
  - patch `:844-860`, chỉ được gọi từ đường sửa;
  - delete `:864`, 0 nơi gọi.

  Chỉ insert và patch mang giá.
- **Chạm chung** với chunk này ở hai lệnh gọi `create-iap.ts:176-178` và `update-iap.ts:270-277`
  (`appCurrency` ở `:276`), cùng `legacyFallbackBody` (`:686-701`).
- Bước kiểm đặt trước publisher, nên lời từ chối **không bao giờ** tới fallback (ĐÃ ĐO: 0 lệnh gọi Google).
- Còn lệch: khi v3 trả lỗi, ba đường xử lý khác nhau:
  - bulk trả nguyên văn lỗi;
  - tạo đơn lẻ gọi lại API cũ với cùng body;
  - sửa đơn lẻ gọi API cũ với `defaultPrice` bị thay. ĐÃ ĐO: base gõ VND 26 tới API cũ thành USD 0.99.
- Phương án:
  - (A) tách riêng, làm sau chunk này;
  - (B) gộp phần ghi (insert/patch + `legacyFallbackBody`), làm lật 6 test hiện có;
  - (C) làm D4 trước: không cần, vì chunk này không phụ thuộc D4.
- **Đề xuất: (A).** (CHƯA CHỐT — Manager quyết.)

**D10 — Overwrite thay thế mù:**
- Phần dùng chung với sửa đơn lẻ, ĐÃ ĐO:
  - ép `AVAILABLE` (adapter `:274`, `:287`): sửa chỉ title vẫn gửi lại BY là AVAILABLE;
  - `FULL_UPDATE_MASK` có trường thuế mà body không có (`publisher-client.ts:348-349`);
  - thay toàn bộ cấu hình vùng của option đích (adapter `:381-386`).
- Tự động ACTIVATE và tự sinh listing en-US chỉ có ở bulk.
- Chunk này **không đụng** các dòng đó ⇒ **đề xuất tách**. Phạm vi D10 nay gồm cả sửa đơn lẻ (P8) — đã ghi
  vào bảng §2.
- Việc "sửa + tier + quy đổi lỗi ⇒ rớt vùng" chỉ đóng được trong chunk này nếu Q-b chọn từ chối.

### 6.6 Cần Manager quyết trước khi code

- **Q-a — Khi sửa, tier thắng hay quy đổi thắng?**
  - Hôm nay quy đổi đè giá tier (`update-iap.ts:233`), trong khi UI ghi "tier's region prices will replace…"
    (`IapForm.tsx:976-977`).
  - Nếu quy đổi vẫn thắng, từ chối tier sai sẽ chặn một giá mà Google không bao giờ nhận.
- **Q-b — Quy đổi lỗi khi sửa thì sao?**
  - Từ chối mọi lần đổi base mà quy đổi lỗi, hay theo đúng bulk (từ chối khi không phải USD, gửi khi USD)?
  - Sửa chỉ title mà quy đổi lỗi thì cho qua không?
- **Q-c — Server biết base có do Manager gõ không bằng cách nào?**
  - Form đã theo dõi `baseDirty` (`IapForm.tsx:241`, đặt ở `:504`, `:1000`, `:1029`) nhưng chưa gửi lên server.
  - So với cache thì bị cấm (`form-state.ts:30-33`), và sai khi `default_currency` NULL: form lấy currency của
    app (`:115-118`), server lấy "USD" (`update-iap.ts:150`).
  - *Đề xuất:* gửi `baseDirty` + một contract marker như `pricing_rule`; tab cũ nhận 409 "reload".
- **Q-d — Có kiểm cặp vùng/currency cho dòng gõ tay không?** Giá custom của bulk không kiểm. *Đề xuất: không.*
- **Q-e — Base đơn lẻ kiểm bằng `statedPriceOf` hay `filePriceOf`?** `filePriceOf` có thêm cổng currency, nên
  sẽ từ chối ARS/CNY mà form đang cho chọn (ĐÃ ĐO). *Đề xuất: `statedPriceOf`*, ghi backlog việc sửa danh sách
  currency của form.
- **Q-f — Giá gõ tay dưới tier, cái nào thắng?** Bulk: custom thắng tier. Đơn lẻ: tier thay hết dòng gõ tay.
  Phải chọn một.
- **Q-g — Giá 0 do Google viết có cho qua không?** *Đề xuất: cho qua* (KB (d)).

**SQL chỉ-đọc để định cỡ Q-c** (cột đã có trong schema: `20260520010000_google_iap_mgmt_init.sql:137`,
`20260702120000_google_iap_mgmt_deleted_on_google.sql:22`):
```sql
SELECT count(*) FROM google_iap_mgmt.iaps
WHERE default_currency IS NULL AND deleted_on_google_at IS NULL;
```

### 6.7 Phát hiện ngoài phạm vi: chỉ ghi BACKLOG, không code trong chunk này

- Sửa chỉ title mà quy đổi lỗi vẫn patch với `2022/02`.
- Dòng USD của bulk mà quy đổi lỗi cũng ghim `2022/02`, trái với comment của chính nó
  (`bulk-import.ts:1023-1025`).
- Tier không tồn tại: đơn lẻ trả 404, bulk ném lỗi cả batch.
- Form không đọc `hasChanges`, nên báo "updated" cả khi không có gì thay đổi (`IapForm.tsx:739`).
- Dòng dirty gõ sau khi đổi base bị quy đổi đè mà không có cảnh báo.
- Sửa chỉ title ghi giá của buyOption đầu tiên đè lên `legacy-base` (đo trên mock; thứ tự option thật của
  Google CHƯA BIẾT).
- `COMMON_REGIONS` để AR=ARS, còn snapshot của Play tính AR bằng USD.

(Mỗi mục có một dòng trong BACKLOG, mục "Phát hiện ngoài phạm vi khi lập kế hoạch
`[GOOGLE-single-edit-server-price-rules]`".)
