# [GOOGLE-bulkimport-drop-gt] Bỏ "GT Price" / "GT Currency" khỏi Bulk Import của Google — census + thiết kế

**Trạng thái:** census PASS (`e733bfa`). Manager làm rõ + chốt §P4 (2026-10-21, xem §P4-chốt — **đổi hướng so với đề xuất census**). Đang làm bước A (đo ảnh hưởng quá khứ, chỉ đọc); G0/G1 chưa làm.
**Nhánh:** `arc-google-bulkimport-drop-gt-columns` (từ `origin/main` = `121f2b1`).
**Phạm vi:** module Google. Apple không đổi hành vi (Apple đã bỏ GT — KB §36).

Nhãn: **ĐÃ ĐO** · **ĐỌC CODE** (file:line) · **CÓ TRONG SCHEMA** · **CHƯA BIẾT**.
Cách đo: 6 làn census độc lập + 1 làn rà sót, code thật (generator, parser, route preview + execute, orchestrator, publisher-client, adapter); googleapis bị thay bằng stub ném lỗi rồi mock ghi lại mọi body — **không một lần ghi nào lên Google**. FX của `convertRegionPrices` là giả ⇒ số quy đổi trong tài liệu (25740…) là sản phẩm của bản giả; giá GT / giá tier là nguyên văn.

## TL;DR

1. **GT của Google ĐỔI GIÁ THẬT — nhưng chỉ ở dòng định giá bằng quy đổi**: nguồn Google Conversion (`google_default`), hoặc nguồn template mà KHÔNG tier nào khớp dòng đó. Khi đó vùng của GT nhận đúng giá GT, đè giá quy đổi. Khi tier khớp, hoặc dòng có custom prices, GT **hôm nay đã bị bỏ** (diff có/không GT = 0 vùng). ĐÃ ĐO: 756 lượt (21 ca × 3 nguồn × 3 quyết định × 4 currency app); CREATE = OVERWRITE 252/252; bất biến T1 (currency của app không ảnh hưởng giá) đúng 189/189 nhóm.
2. ⇒ **Bỏ GT = bỏ một tính năng định giá** cho đúng các dòng đó: sau thay đổi vùng đó nhận giá quy đổi thay vì giá ghi trong file.
3. **Hai cách "bỏ" dễ nghĩ ra đều sai** (ĐÃ ĐO trên bản sao scratch):
   - xoá GT khỏi danh sách header đã biết ⇒ **MỌI file đang lưu hành bị từ chối CẢ FILE** — kể cả template tải hôm nay — vì `GT Price` khớp luật "trông như cột giá" (`excel-parser.ts:189`);
   - nhận diện rồi bỏ qua kiểu Apple ⇒ file cũ nhận được nhưng **giá GT mất im lặng** (VN 26000 → giá quy đổi) — đúng lớp lỗi H4 vừa diệt.
4. **Định cỡ:** chỉ đếm được từ H4.4 (`64557c9`, lên `origin/main` 2026-10-19 21:26 +07 — khoảng 1 ngày dữ liệu). Trước đó code KHÔNG ghi GT ⇒ **CHƯA BIẾT**. SQL: `docs/google-iap-management/queries/census-google-gt-usage.sql` (§1.4).
5. **Thay thế gần nhất:** dialog **Custom prices** ở bước Preview — request gửi Google **giống từng byte** với GT, với tới mọi vùng. Mất: cột trong file (mỗi dòng mở một dialog, không dán/CSV, mất khi tải lại trang, nhập lại mỗi lần import).
6. Không có code chung nào mang GT với Apple; test Apple GP1/GP2 sẽ lật có chủ đích, GP3 giữ nguyên. **0 migration.**

---

## P1 — Census

### 1.1 Template download hôm nay (ĐÃ ĐO — gọi đúng chuỗi hàm của nút Download)

Sinh ở client: `components/google-iap-management/apps/AppsListClient.tsx:163-170` và `components/google-iap-management/bulk-import/BulkImportWizard.tsx:819-825` truyền `googleIapTemplateSpec` (`lib/google-iap-management/parsers/template-spec.ts:427-446`) vào `DownloadTemplateButton` → `downloadXlsxTemplate` → `buildTemplateWorkbook` (`lib/xlsx-template.ts:146-163`).

- Sheet: `IAP Items`, `Notes` (mọi lựa chọn).
- Header: A `Product ID` · B `Price (USD)` · **C `GT Price`** · **D `GT Currency`** · từ E là cặp `Title (…)` / `Description (…)`.
- Số cột: core `[]` = **4** · 1 locale = 6 · 3 locale = 10 · đủ 82 locale = **168**.
- 3 dòng mẫu: 0.99 / **26000 VND** · 1.99 / **52000 VND** · 22.99 / **598000 VND** (bị bỏ qua theo Product ID mẫu).
- Notes — nguyên văn các dòng GT (core; biến thể khác lệch 1 dòng):
  - **Dòng 9:** `GT Price | Optional | Override price for ONE country, in the currency given in GT Currency. Fill GT Price and GT Currency both, or neither — one without the other keeps the row out. A 0 price, more decimals than the currency allows, or a "." / "," in a currency without decimals keeps the row out. A pricing-template tier that matches the row, or custom prices, replace the GT.`
  - **Dòng 10:** `GT Currency | Optional | Currency code for GT Price, e.g. "VND" — mapped to that currency's primary region. A currency outside the GT list, or one Google Play does not bill that region in, keeps the row out. Write both headers exactly "GT Price" / "GT Currency", and keep both columns or neither — otherwise the file is refused.`
  - **Dòng 14 (core) / 13:** `UNIT REMINDER: "Price (USD)" is US dollars — the header's currency, not the app's. GT Price is a PRICE in the GT Currency you specify on the same row (posted to Google Play as that currency's region price) — it is NOT an exchange rate.`
  - **Dòng 17–20 / 16–19:** bảng minh hoạ, header có cột GT, dòng lặp 26000/52000/598000 VND.

### 1.2 ⭐ GT hôm nay LÀM GÌ (ĐÃ ĐO, route preview + execute thật, Google mock)

| Nguồn giá | CREATE | OVERWRITE | SKIP |
|---|---|---|---|
| **Google Conversion** (`google_default`) | **GT được gửi**: vùng GT = giá GT; các vùng khác quy đổi từ giá file. Fixture thật của Manager: VN quy đổi 25740 → **23000** ×3. GT USD trên US: US 0.99 → 1.29 (giá file chỉ còn làm neo). | **y hệt CREATE** (mảng giá của option đích bị thay toàn bộ; option khác giữ nguyên) | không gửi gì |
| **Template, tier KHỚP** (theo SKU, hoặc giá + currency của file) | **GT bị bỏ** — vùng nhận entry của tier (Tier 1 VN 25000; chọn Alternate Tier A ⇒ VN 5000); tier không có vùng đó ⇒ quy đổi | = CREATE | không gửi |
| **Template, KHÔNG tier nào khớp** | **GT được gửi** như Google Conversion (USD 1.49 → VN 38740 → 26000) | = CREATE | không gửi |
| **Custom prices** (dưới cả 3 nguồn) | **GT bị bỏ** — bộ custom thay (có VN ⇒ 27000; không có VN ⇒ quy đổi, GT mất) | = CREATE | không gửi |

- **Neo quy đổi luôn là giá FILE**, không bao giờ là GT (`orchestration/bulk-import.ts:951-960`).
- **Bảng GT Currency → vùng** (`excel-parser.ts:68-97`, mỗi currency đúng một vùng): nhận 23 cặp (USD→US, EUR→**DE**, GBP→GB, JPY→JP, KRW→KR, TWD→TW, HKD→HK, INR→IN, IDR→ID, THB→TH, VND→VN, PHP→PH, SGD→SG, MYR→MY, AUD→AU, NZD→NZ, CAD→CA, MXN→MX, BRL→BR, RUB→RU, TRY→TR, SAR→SA, AED→AE); từ chối CNY→CN, ARS→AR.
- **Từ chối** (ĐÃ ĐO, giống nhau dưới cả 3 nguồn):
  - **cả FILE** (preview 422): header sai hoa/thường hoặc khoảng trắng (`gt price`, `GT  Price`) — `gt_header_case`; chỉ có một trong hai cột, `GT Curency`, `GT Price (VND)` — `gt_column_missing`;
  - **DÒNG** (Push the rest gửi các dòng còn lại; Hub PARTIAL): CNY/ARS; chỉ điền một ô; sai độ chính xác (26000.5 VND, 1.999 USD); ô chữ `26.000`, `26,000`, `0.00`; 0; -5; `abc`; currency ngoài bảng. ⚠ GT sai từ chối dòng **ngay cả khi tier/custom sẽ thay GT đó**.
  - **lỗ hổng sẵn có:** ô SỐ `26.000` (Excel hiểu là 26) được nhận ⇒ gửi VN = **VND 26** (thấp 1000 lần), Hub SUCCESS.
- **Preview:** `gtPlanOf` → `GtLine` (`components/google-iap-management/bulk-import/execute-payload.ts:165-230`, `PreviewTable.tsx:357-397`): `will be sent` / `replaced by tier …` / `replaced by custom …` / `not sent (Skip)`.
- **Audit:** `BULK_IMPORT_BATCH.per_row_pricing[]` (từ H4.4) ghi `gt {region, currency, price}` và `gt_outcome` ∈ none / kept / replaced_by_tier / replaced_by_custom / not_sent (`bulk-import.ts:1107-1146`); chỉ ghi `regionOverrides[0]`.
- **Cứu dòng hiếm (Q7):** dòng file không phải USD mà quy đổi không trả US — GT trên US cứu được dòng đó (`bulk-import.ts:1027-1039`, ĐÃ ĐO DP6); bỏ GT ⇒ dòng đó bị `conversion_failed`. Google có bao giờ trả quy đổi thiếu US không: **CHƯA BIẾT**.
- **Đường đi** (ĐỌC CODE): generator `template-spec.ts:63-72, 295-299, 324-325, 360-370` → parser `excel-parser.ts:161-165, 201-241, 312-313, 559-602, 623` → preview `preview/route.ts:124-130, 204-210` → wizard `execute-payload.ts:73` → execute `execute/route.ts:210-218` → orchestrator `bulk-import.ts:439, 454-470, 538-542, 858-863, 228-235, 1006-1016, 1107-1146` → adapter `onetime-product-adapter.ts:262-297, 378-396` → `publisher-client.ts:950-960, 1137-1146`.

### 1.3 Mọi chỗ Google nhắc GT

- **Code bulk** (6 lớp): `template-spec.ts` (sinh cột) · `excel-parser.ts` (đọc, kiểm, bảng currency→vùng, `productCols` có GT Price `:512-516`) · `orchestration/file-price.ts:141-159` `fileRegionPriceOf` (chỉ GT dùng: `excel-parser.ts:567`, `bulk-import.ts:459`) · orchestrator (pre-pass, đè giá, bị tier/custom đè, audit) · `execute/route.ts:86, 210-218, 233-237` (nhận `regionOverrides` từ client, chỉ kiểm cấu trúc) · wizard (`PreviewGt`, `gtPlanOf`, `GtLine`, copy `BulkImportWizard.tsx:851, 1535-1556`).
- ⚠ **`regionOverrides` không chỉ là GT:** trong orchestrator nó là chỗ chứa giá tier (`:858`) và custom (`:538`), và là nguồn giá vùng duy nhất của `buildProduct` (`:228`) ⇒ **chỉ bỏ lối GT đi VÀO field, không xoá field**. Form đơn lẻ có field cùng tên — tính năng khác (§1.8).
- `file-price.ts` dùng chung với form đơn lẻ (`IapForm.tsx:30` import `statedPriceError`) ⇒ chỉ bỏ `fileRegionPriceOf`.
- **UI khác:** `components/google-iap-management/pricing-templates/GoogleDefaultReferenceTab.tsx:63` ("template column GT Price/Currency, or per-IAP form input… win over the conversion").
- **Docs:** `docs/user-docs/index.html` section Google (5448, **5460** số cột, 5464, 5479, 5504-5507, 5641-5684) · `docs/google-iap-management/operational-guide.md:363-365, 454-458, 475, 485-495, 586, 613` · KB §35.3 · design H4 (38 dòng) · custom-prices design · api reference · BACKLOG · KB §36 + design Apple (đang ghi "Google giữ GT" — sẽ sai).
- **Test** (ĐÃ ĐO bằng mutation trên 112 file / 1502 test Google + parity): chỉ bỏ cột template ⇒ 9 test / 4 file; parser bỏ GT ⇒ 18 / 4; cả hai ⇒ 25 / 6; gỡ cả máy GT phía sau (gtPlanOf, GtLine, pre-pass, audit, bảng currency→vùng) ⇒ thêm ~26 / 6 (đếm bằng AST + tên test). Cộng: test ghim NGUYÊN VĂN câu ghi chú giá trong wizard (`BulkImportWizard.test.tsx:870-898`), test T1 ghim hình dạng audit `gt: null, gt_outcome: "none"` (`file-currency-invariance.test.ts:1050-1066`), 2 test ghim `headers.length === 4` (`AppsListClient.test.tsx:70`, `BulkImportWizard.test.tsx:228` — grep không thấy, chỉ mutation bắt).
- **Trùng tên, KHÔNG liên quan:** "GT" = Guatemala (`play-regions.snapshot.ts:104`, `region-name.ts:99`, export list `Price in Guatemala (GT)`, fixtures, SQL docs); `&gt;` trong HTML.

### 1.4 ⭐ ĐỊNH CỠ — team có đang dùng GT không?

- **Dữ liệu chỉ có từ H4.4**: `64557c9` (2026-10-19 18:01 +07), lên `origin/main` 2026-10-19 **21:26:42 +07** (cùng H4.2, H4.3; lần push trước là `375b735`, 2026-10-17). Không có thay đổi code bulk Google nào sau đó. Thời điểm Railway deploy: **CHƯA BIẾT**.
- **Trước H4.4: CHƯA BIẾT.** Đo trên code thật `375b735`: GT VND 26000 được gửi lên Google, audit không có trường GT nào; 23 phiên bản `bulk-import.ts` (2026-05-21 → H4.4) không có key GT nào ở payload; `import_batches` không lưu dòng; `iap_prices` bị thay toàn bộ từ Google mỗi lần sync. Một vết duy nhất (floor): dòng Custom bị từ chối giữ GT VN trong `per_row_diagnostic.vn_price_decimal` (từ 2026-08-07). Tool **không lưu file upload** — chỉ lưu tên file (`import_batches.source_filename`).
- **SQL** (chỉ đọc, đã đo trên PGlite + migration thật + audit row do code thật sinh, 2 biến thể SQL sai đều bị bắt): `docs/google-iap-management/queries/census-google-gt-usage.sql` — 3 khối, mỗi khối có dòng TOTAL:
  - **G4-B** (chạy trước): đã ghi per-row pricing chưa (phân loại theo hình dạng payload);
  - **G4-A**: dùng GT từ H4.4, theo app × người chạy, lần gần nhất — `gt_kept_on_google` là con số **chính xác**: GT đã thành giá thật trên store; `rows_with_gt + gt_refused_in_file` chỉ là **sàn**;
  - **G4-C**: trước H4.4 — các import CÓ THỂ đã dùng GT, kèm tên file để hỏi người upload.
- ⚠ **Phải chạy TRƯỚC khi code bỏ GT deploy** (dòng audit của code mới sẽ rơi vào `gt_shape_unexpected`).

### 1.5 Parser theo TÊN hay VỊ TRÍ?

**Theo TÊN** (ĐÃ ĐO): `indexColumns` (`excel-parser.ts:297-347`) so header đã trim; xáo trộn / thêm cột lạ / đảo cột đầu ⇒ kết quả y hệt; Title/Description vẫn map đúng khi dịch cột. Header lạ không chứa "price" ⇒ bỏ qua im lặng; header có chữ "price" mà không phải `Price (XXX)` ⇒ **từ chối cả file**. Locale regex phân biệt hoa thường (`title (Vietnamese)` bị bỏ im lặng — lỗi có từ trước, ngoài arc).

⚠ **Bẫy chép CẢ DÒNG theo vị trí — ở Google NẶNG HƠN Apple** (ĐÃ ĐO): dòng cũ `[sku, 0.99, 26000, VND, "Kim cương", "Gói kim cương"]` dán vào template mới (không GT) ⇒ Title (Vietnamese) = `26000`, Description = `VND`, **0 cảnh báo, 0 từ chối**, title thật mất. Google **không có step Localization**; cảnh báo mất listing chỉ bật khi dòng không có listing nào ⇒ với Overwrite, listing tiếng Việt đang bán sẽ bị thay bằng `26000` / `VND`. Dấu hiệu duy nhất: cột "Default title" ở Preview.

### 1.6 Code chung với Apple

`lib/xlsx-template.ts` và `components/ui/shared/DownloadTemplateButton.tsx`: 0 chữ GT; bỏ GT ở Google **không cần đụng** (mô phỏng: test chung xanh). Không đụng `TEMPLATE_SAMPLE_ROWS_NOTE` (Google so nguyên văn, `excel-parser.ts:373`) và `TEMPLATE_SAMPLE_PRODUCT_IDS`. Không import `APPLE_RETIRED_LEAD_HEADERS` (Apple-only). Test Apple ghim Google (`lib/iap-management/parsers/gt-drop.google-parity.test.ts`): **GP1 lật**, **GP2 lật** (cả nửa file legacy — bất kỳ parser nào thôi ĐỌC GT đều làm nó đỏ), **GP3 giữ** (hằng chung). Ngoài ra: comment 2 test Apple ("BOTH 4 columns… Google's core has it", `AppsListClient.test.tsx:45-48`, `BulkImportWizard.test.tsx:277-280`), lời giải thích của GP test, KB §36 và design Apple đang ghi quyết định 2026-10-20 "không đổi Google" — yêu cầu mới đảo quyết định đó. Không code production Apple nào dùng GT Google. Baseline Apple: 46 file / 489 test bulk-import + parsers xanh.

### 1.7 File Google khác có cột GT?

- Tool sinh ra: CHỈ template bulk import. Export list và matrix export không có (chỉ "Guatemala (GT)").
- File đã commit: CHỈ `docs/google-iap-management/templates/template-item-iap-google.xlsx` (Sheet1!C1/D1, 3 dòng 23000 VND) — file mẫu cũ của Manager.

### 1.8 Form tạo/sửa đơn lẻ

Không có khái niệm "GT" (grep 0), nhưng có tính năng cùng tác dụng: lưới giá theo vùng gõ tay (`IapForm.tsx:1049-1129`, `UnifiedPricingTable`), ĐÃ ĐO gửi `prices.VN = {VND, 26000000000}` giống hệt GT bulk. Là đường code riêng — bỏ GT bulk không đụng. `[GOOGLE-single-edit-server-price-rules]` (BACKLOG, hoãn): phía server của đường đơn lẻ chưa áp `statedPriceOf`; không nhắc GT; quan hệ duy nhất: lo phần server cho thứ tương đương GT ở form. Bỏ GT không đóng, không mở mục này.

### 1.9 DB

Không cột/bảng nào lưu GT (9 migration Google, grep 0 — CÓ TRONG SCHEMA). GT chỉ nằm trong `actions_log.payload` JSONB (`per_row_pricing[].gt / gt_outcome`, từ H4.4); dòng audit cũ giữ nguyên (append-only). ⇒ **Không cần migration.**

---

## P2 — Thiết kế

### 2.1 ⭐ File CŨ có 2 cột GT — phương án (đề xuất, KHÔNG tự chốt)

⚠ Mọi phương án đều phải **nhận diện có chủ đích** 2 tên cột cũ (giữ trong `FIXED_HEADERS`), nếu không MỌI file đang lưu hành bị từ chối cả file (§TL;DR-3).

| | Làm gì | Được | Mất / rủi ro |
|---|---|---|---|
| (a) | nhận, bỏ qua GT, không báo | đơn giản nhất; đúng nguyên văn "không đọc/kiểm" | ⚠ **dòng có điền GT nhận giá KHÁC file, im lặng** (dưới Conversion / template không khớp tier) — trái luật H4 "giá chỉ lấy từ file" |
| (b) | nhận, bỏ qua GT, **cảnh báo** ở preview từng dòng có điền GT: "GT bị bỏ qua — <vùng> sẽ dùng <giá tier / giá quy đổi> thay vì <giá GT>" | file cũ vẫn chạy; người dùng được báo | vẫn **thay bằng một giá khác** (trái luật H4 "từ chối là từ chối DÒNG, không bao giờ thay bằng giá khác"); giá quy đổi chưa biết ở preview nên câu báo không nói được con số; cần kênh hiển thị mới |
| **(c) ⭐ đề xuất** | **từ chối DÒNG có điền ô GT** (bất kỳ ô nào của cặp), lý do nêu cách thay thế: *"GT Price / GT Currency are no longer supported — set this country's price with Custom prices (Preview → Tier → Custom…), or clear the GT cells."* | khớp luật H4: không bao giờ gửi một giá khác giá file ghi; Push the rest vẫn gửi các dòng khác; audit ghi được (`refused_rows`) | dòng có ô GT điền mà tier khớp (hôm nay GT đã không tác dụng) cũng bị từ chối tới khi xoá ô GT — dọn một lần |
| (d) | cột GT có mà trống hết ⇒ nhận như file mới; có ô điền ⇒ (b) hoặc (c) | | (d) + (c) = (c) (dòng ô GT trống luôn được nhận) |

Biến thể (c′): chỉ từ chối dòng mà GT **lẽ ra được giữ** (Conversion / template không khớp tier); dòng tier/custom thay GT thì nhận. Chính xác hơn, nhưng phải biết kết quả tra tier — làm ở preview/orchestrator chứ không ở parser; phức tạp hơn và hai pha. Đề xuất (c) đơn giản: cùng hình dạng với luật H4 hôm nay ("GT sai từ chối dòng ngay cả khi tier/custom sẽ thay").
⚠ (b)/(c) cần parser vẫn **nhìn** ô GT có trống hay không (chỉ kiểm có/không, không đọc giá, không map vùng, không kiểm currency).
⇒ Con số SQL §1.4 cho biết bao nhiêu dòng sẽ gặp từ chối.

### 2.2 Cách thay thế cho người đang dùng GT ("giá riêng ở vùng X cho các sản phẩm này")

| Đường có sẵn | Phạm vi | Cùng lượt import? | Kết quả trên Google so với GT | Khác gì |
|---|---|---|---|---|
| **Dialog Custom prices** (Preview → cột Tier → "Custom…") ⭐ gần nhất | theo sản phẩm, mọi vùng (~173) | có, dưới cả 3 nguồn | **giống từng byte** (ĐÃ ĐO: CREATE, OVERWRITE, VN và JP); dưới template + tier khớp còn làm được thứ GT không làm được (tier + đè một vùng) | không có cột trong file: mỗi dòng một dialog, không dán / CSV / áp cho tất cả; mất khi tải lại trang; nhập lại mỗi lần import. Kiểm giá cùng luật với GT cho ô chữ; server không kiểm cặp vùng/currency (UI không cho chọn sai) |
| Tier đặt tên theo SKU trong template (Default / App) | theo sản phẩm, **lâu dài** | có (mọi lần import sau) | giống từng byte (ĐÃ ĐO) | phải upload lại CẢ template; tier SKU **thay toàn bộ** tier giá (phải chép mọi ô); luật upload template yếu hơn (`26.000` chữ ⇒ lưu 26 VND và GỬI; `26,000` ⇒ bỏ qua chỉ cảnh báo) |
| Entry của tier giá (VN trong "Tier 1") | theo **mức giá** — mọi sản phẩm cùng mức | có | giá từng vùng bằng GT (khác thứ tự) | đổi giá của MỌI sản phẩm ở mức đó, mọi lần sau — không phải "các sản phẩm này" |
| Form sửa đơn lẻ | theo sản phẩm, sau import | không | gửi giống, nhưng chỉ giữ được dưới Conversion khi giá base không đổi; dưới template + tier bị tier thay; lần Overwrite bulk sau sẽ quy đổi lại | |
| Play Console | ngoài tool | — | CHƯA BIẾT | lần Overwrite bulk sau sẽ thay bằng giá quy đổi |

Đề xuất: **Custom prices** cho giá riêng từng đợt; **tier theo SKU** nếu cần lâu dài. (Dán / áp-cho-tất-cả trong dialog Custom có thể thành mục BACKLOG riêng — không làm trong arc này.)

### 2.3 Bỏ code — không để code chết, không đổi bất biến H4

- **Template:** bỏ GT khỏi lead row ⇒ core **2** · 1 locale 4 · đủ **166**; bỏ giá trị GT mẫu; Notes bỏ 2 dòng GT + câu GT trong UNIT REMINDER; bảng minh hoạ và dòng mẫu dựng **theo tên header** bằng một hàm (bài học Apple); thêm câu dặn chép theo từng cột. Tên file giữ (như Apple Q3).
- **Parser:** giữ 2 tên trong `FIXED_HEADERS` (nhận diện cột cũ); bỏ `gt_header_case` / `gt_column_missing`, bỏ đọc / map vùng / `CURRENCY_TO_REGION_OVERRIDES`, bỏ GT khỏi `productCols`; theo 2.1 (c): ô GT điền ⇒ từ chối dòng với lý do + cách thay thế. Parser thôi điền `regionOverrides` (field giữ cho tier/custom).
- **`file-price.ts`:** bỏ `fileRegionPriceOf` (chỉ GT dùng); giữ `filePriceOf` / `statedPriceOf` / `statedPriceError`.
- **Orchestrator / route:** bỏ pre-pass `fileRegionPriceOf` trên override từ client; route execute **không nhận** `regionOverrides` từ client nữa (từ chối nếu khác rỗng) + nâng `PRICING_RULE` lên `file-currency-only/v2` (tab mở trước deploy nhận 409 "preview outdated" thay vì gửi GT — ĐÃ ĐO hôm nay POST thẳng vẫn gửi được GT). Giữ field nội bộ cho tier/custom.
- **Audit:** bỏ `gt` / `gt_outcome` khỏi `per_row_pricing` (hoặc giữ `null` — Q5); dòng bị từ chối vì ô GT nằm trong `refused_rows` (đếm được).
- **Wizard:** bỏ `PreviewGt` / `gtPlanOf` / `GtLine`; sửa copy (`BulkImportWizard.tsx:851, 1535-1556`); `GoogleDefaultReferenceTab.tsx:63`.
- **Bất biến H4 giữ nguyên:** T1 (currency app không ảnh hưởng giá) — fixture GT F5/F10/F11 sửa có chủ đích, các ô khác giữ; luật giá chính (`filePriceOf` / `statedPriceOf`), refused rows, Push the rest, mirror gate C1/C2, Q7 (code giữ; chỉ mất đường GT-trên-US).
- Mất theo (ghi rõ): lỗ hổng ô SỐ `26.000` ⇒ VND 26 biến mất **ở cột GT**. ⚠ Cột giá CHÍNH có cùng lỗ hổng và rộng hơn (§A-thêm) — bỏ GT không đóng nó; BACKLOG `[GOOGLE-bulk-import-price-magnitude]`.

### 2.4 Docs

User guide section Google (dòng §1.3, kể cả **5460** số cột 4 → 2 / 168 → 166) · `operational-guide.md` · KB §35.3 (ghi chú ⟲) + §36 (bỏ câu "Google giữ GT") + mục KB mới · design H4 / custom-prices / Apple GT (ghi chú ⟲, không viết lại lịch sử) · comment 2 test Apple + lời giải thích GP test · thông báo team: GT bỏ, file cũ có ô GT thì dòng đó bị từ chối (theo Q1), cách thay thế = Custom prices, không chép cả dòng.

---

## P3 — Parity + test

- **3.1 Parity Google:** T1 (`file-currency-invariance.test.ts`) giữ mọi ô không GT, sửa có chủ đích F5/F10/F11 + ghim hình dạng audit; luật giá H4, refused rows, Push the rest, mirror gate C1/C2 không đổi.
- **3.2 Apple không đổi:** test Apple xanh; chỉ GP1/GP2 lật có chủ đích (GP3 nguyên văn).
- **3.3 Test mới:** template không còn GT (header + Notes; không bắt nhầm Guatemala) · file mới import đúng · file cũ: GT trống ⇒ như file mới; GT điền / rác ⇒ theo Q1 · dòng trước đây lấy giá từ GT (Conversion / không tier) nay theo đúng thiết kế · tab cũ / POST thẳng mang `regionOverrides` ⇒ 409 / từ chối · bẫy chép cả dòng theo Q6.
- **3.4 Mutation:** template vẫn sinh GT · GT vẫn đè giá · file cũ có ô GT bị bỏ qua im lặng · client `regionOverrides` vẫn được gửi · đổi hành vi Apple ⇒ test Apple đỏ.
- **Chunk đề xuất:** G0 ghim hiện trạng (GT theo nguồn × đường; từ chối; audit; tab cũ) → G1 template + parser + route/orchestrator + wizard + test + docs. 0 migration.

---

## P4 — Câu cần Manager chốt

> **Q1 — File cũ có ô GT điền (§2.1).** Đề xuất **(c)**: từ chối DÒNG đó, lý do nêu cách thay thế; cột GT trống ⇒ nhận như file mới. Lý do: luật H4 "từ chối là từ chối dòng, không bao giờ thay bằng giá khác"; (a) và (b) đều gửi một giá khác giá file ghi. Kèm con số SQL §1.4.
>
> **Q2 — Cách thay thế (§2.2).** Đề xuất: **Custom prices** (giống từng byte trên Google), **tier theo SKU** nếu cần lâu dài; ghi vào user guide + thông báo team.
>
> **Q3 — Migration.** Đề xuất **KHÔNG** (không cột nào lưu GT).
>
> **Q4 — Tab cũ / POST thẳng.** Đề xuất: nâng `PRICING_RULE` → `file-currency-only/v2` + route từ chối `regionOverrides` khác rỗng từ client.
>
> **Q5 — Audit `per_row_pricing.gt` / `gt_outcome`.** Đề xuất **bỏ** hai trường (dòng cũ giữ nguyên; `PRICING_RULE` v2 phân biệt hai thời kỳ).
>
> **Q6 — Bẫy chép cả dòng (§1.5), Google không có step Localization.** Lựa chọn: (i) chỉ câu dặn ở Notes + user guide (như Apple); (ii) thêm kiểm hẹp: dòng có Title là số thuần **và** Description là đúng 3 chữ in hoa ⇒ từ chối dòng "trông như cặp GT cũ dán theo vị trí". Đề xuất **(ii)** — vì với Overwrite, listing đang bán bị thay bằng `26000` / `VND` mà không có lớp chặn nào trước execute.
>
> **Q7 — Xác nhận đảo quyết định 2026-10-20** ("Google dùng GT thật — không đổi hành vi Google", ghi ở KB §36, design Apple, lời giải thích test GP). Arc này sẽ sửa các chỗ đó.
>
> **Q8 — SQL §1.4** phải chạy trên prod **trước** khi code bỏ GT deploy (khuyến nghị: trước khi chốt Q1).

## §P4-chốt — Manager làm rõ + quyết (2026-10-21)

**Bối cảnh Manager làm rõ:** team LUÔN điền GT Price / GT Currency trong file Google, nhưng KHÔNG BAO GIỜ có nhu cầu dùng chúng làm giá thật; Manager tưởng GT không được gửi lên Google. Census đo NGƯỢC LẠI (§1.2). ⇒ Ý định của team: GT không bao giờ có tác dụng ⇒ **GT bị gửi lên Google là LỖI so với ý định**, không phải tính năng cần giữ hay thay thế.

- **Q1 = file có hai cột GT ⇒ HIỆN CẢNH BÁO, KHÔNG CHẶN, KHÔNG DÙNG GT** (thay cho đề xuất (c) của census). GT không bao giờ được đọc làm giá, không kiểm hợp lệ, không gửi lên Google — dù ô có điền hay không, dù giá trị hợp lệ hay rác. Preview hiện cảnh báo bằng CÂU CHỮ (không chỉ số đếm), trước nút Push: cột GT có dữ liệu ⇒ câu báo + số dòng có điền GT; cột GT có mà trống ⇒ cảnh báo nhẹ, gợi ý xoá hai cột. Không chặn Push, không từ chối dòng. Giữ hai tên trong `FIXED_HEADERS`. Server cũng bỏ qua GT (không tin client). Câu chữ cuối: agent đề xuất, Manager duyệt ở gate.
- **Q2 =** không cần cách thay thế; một dòng trong user guide: muốn đặt giá riêng một vùng thì dùng Custom prices.
- **Q3 =** không migration.
- **Q4 =** `PRICING_RULE` → `file-currency-only/v2`; route từ chối `regionOverrides` khác rỗng do client gửi. ⚠ Bắt buộc test chứng minh Custom prices vẫn đúng từng byte như hôm nay (`regionOverrides` vẫn chở giá tier/custom phía server).
- **Q5 =** bỏ trường audit `gt` / `gt_outcome`; dòng audit cũ giữ nguyên; v2 phân biệt hai thời kỳ. Audit mới ghi **số dòng có điền GT** (biết cảnh báo đã hiện bao nhiêu lần), không ghi giá trị GT.
- **Q6 = (ii):** Title là số thuần VÀ Description đúng 3 chữ cái in hoa ⇒ TỪ CHỐI DÒNG, lý do "có vẻ dữ liệu bị lệch cột — đừng chép cả dòng từ template cũ". Mọi locale, CREATE và Overwrite. Lý do khác Apple: Google không có step Localization. Thêm câu dặn chép theo từng cột vào Notes + user guide.
- **Q7 =** xác nhận đảo quyết định 2026-10-20 "không đổi hành vi Google" — yêu cầu mới (2026-10-21). Sửa KB §36, design Apple, test GP1–GP2 có chủ đích, ghi lý do + ngày. GP3 giữ.
- **Q8 =** trước deploy, in lại KHỐI A để Manager chạy lần nữa; `gt_kept_on_google > 0` ⇒ báo danh sách, KHÔNG chặn push.

**Kết quả SQL §1.4 — Manager chạy trên prod 2026-10-21** (`queries/census-google-gt-usage.sql`, nguyên văn Manager báo):
- **Khối B:** 99 = 93 audit dạng trước H4.4 + 6 `import_batches` không có audit (2026-06-01 → 2026-10-15). Shape 1 = 0, shape 3 = 0 ⇒ chưa có lượt import Google nào kể từ H4.4.
- **Khối A:** TOTAL toàn 0 — vì chưa có dữ liệu, KHÔNG phải "không ai dùng".
- **Khối C:** 93 lượt trước H4.4, `gt_trace` = 0, GT không được ghi lại ⇒ CHƯA BIẾT. Người từng import: anhdnt, tiennvt, huongtnd2, thulm2, minhgv. Lượt `google_default` thấy trong kết quả: funzap.portal (tiennvt, 2026-08-07, 39 dòng, `yu.xlsx`) · com.vng.passsdk (minhgv, 2026-07-16, 12 dòng, `template-item-iap-google.xlsx`) · com.vng.cookierun.oven.smash (tiennvt, 2026-06-01, 4 dòng, `anhdo.xlsx`).
- 6 `import_batches` không có audit: hiện tượng trước H4.4 (trước finalize-in-finally), không liên quan GT, không điều tra.

## §A — Ảnh hưởng quá khứ (bước A, chỉ đọc, 2026-10-21)

Đo bằng 5 làn + rà sót: chạy **code cũ của từng commit** (57 commit đụng đường giá, 2026-05-20 → H4.4) lấy bằng `git archive`, Google mock và ghi lại body; FX giả. Không ghi gì lên Google, không Refresh.

### A1 — GT đè giá Google từ khi nào, có đúng mọi phiên bản không

- **GT nằm trong request gửi Google ngay từ commit bulk import Google đầu tiên** (`b762211`, 2026-05-21). Không có giai đoạn nào wizard bỏ `regionOverrides`, GT đi tới vùng khác (bảng currency→vùng không đổi; VND→VN), hay OVERWRITE khác CREATE. Khi API v3 lỗi và rơi về API cũ, body cũ cũng mang GT (ĐÃ ĐO).
- Nhưng GT **chỉ thật sự lên Google** ở dòng (1) được ghi theo **giá quy đổi** (Google Conversion, hoặc template không tier nào khớp, không có custom) **và** (2) không bị từ chối / không làm hỏng batch vì currency. Điều kiện (2) đổi theo giai đoạn:

| Giai đoạn (code) | Điều kiện để GT lên Google (ĐÃ ĐO) |
|---|---|
| P1–P2 `18840e1` → `ab203ad` (2026-05-21 → khoảng 2026-06-01) | wizard ghi đè currency của dòng bằng currency app: app USD / chưa có currency ⇒ GT lên; app VND + file `Price (USD)` 0.99 ⇒ execute 500, không gửi gì; app VND + file `Price (VND)` (số nguyên) ⇒ **GT lên** |
| P3 `84d64b6` / `a54f9fe` → `375b735` (2026-06-01 → 2026-10-19 21:26 +07) | currency của **cột giá trong file khớp currency app** (hoặc app chưa có currency) ⇒ GT lên; khác ⇒ dòng **bị từ chối** (`google_default` / `template_miss`), không gửi. Riêng `84d64b6` (sống 31 phút): app USD + file `Price (VND)` ⇒ gửi USD 25000 + GT |
| Custom prices (template từ 2026-08-08 00:13; mọi nguồn từ 2026-08-08 17:44) | dòng Custom ⇒ GT bị thay |
| P4 H4 (từ 2026-10-19 21:26) | mọi app, không phụ thuộc currency app — **chưa có import nào** (SQL khối B) |

- Giờ push trước 2026-06-29 và giờ Railway deploy: **CHƯA BIẾT** (reflog bắt đầu 2026-06-29). Không cần cho batch có audit — key trong payload cho biết code nào đã ghi; chỉ cần cho 6 batch không audit.

### A2 — Batch Google Conversion (chắc chắn bị ảnh hưởng nếu file có điền GT và dòng không bị từ chối)

- Ba lượt Manager thấy (funzap.portal 2026-08-07 · com.vng.passsdk 2026-07-16 · cookierun.oven.smash 2026-06-01) đều chạy code P2/P3 ⇒ GT đã lên ở mọi dòng **được ghi** (không bị từ chối vì currency, không custom).
- ⚠ Khối C của census gộp theo app × người × nguồn (cộng số dòng, gộp tên file, min/max ngày) và in giờ theo timezone phiên SQL (có thể UTC) ⇒ mỗi "lượt" có thể là nhiều batch. SQL mới liệt kê từng batch.
- Audit trước H4.4 **không có danh sách SKU** cho batch Google Conversion (`per_row_diagnostic` rỗng — chỉ có dòng custom); chỉ có số đếm và `refused_rows`. SKU lấy từ **mirror** theo cửa sổ thời gian quanh batch: CREATE gần như đủ (`iaps.created_at`), OVERWRITE là mức sàn.
- **Danh sách đủ chưa:** section 2 của `queries/audit-gt-past-impact.sql` liệt kê MỌI batch trước H4.4 với `pricing_source` ⇒ Manager xác nhận.

### A3 — Batch template: dòng KHÔNG khớp tier

- **Nhận diện được kèm SKU** cho mọi audit ghi trên đường thành công từ Hotfix 18 (`88f3750`, 2026-05-22): `per_row_diagnostic` có `match_strategy = 'none'`, `entries_count = 0`, `price_provenance` thiếu hoặc `'auto_bootstrap'` (ĐÃ ĐO trên 9 phiên bản). **Giá trị GT không được ghi** (`vn_price_decimal` luôn NULL) ⇒ phải đọc trong file.
- CHƯA BIẾT: code ≤ `b15e7b9` (≤ 2026-05-22 16:37, không có diag); `f07bc38` (chỉ có số đếm); batch mà lời gọi Google ném lỗi (`error`); batch không có audit; batch có `rows_failed > 0` (không biết dòng nào hỏng).
- Manager chọn tier / chấp nhận mặc định **không bao giờ** làm dòng rơi về "không tier + quy đổi" (ĐÃ ĐO).
- Nguồn ngoài DB: log Railway `final_body … template_vn=` = GT VN của dòng không khớp (ĐỌC CODE); thời hạn lưu log CHƯA BIẾT.

### A4 — Kiểm hiện trạng rẻ nhất

- **Mirror được ghi lại sau MỖI bulk import** (`syncIapFromGoogle` trên response `batchUpdate`), không chỉ khi Refresh ⇒ đủ để đọc giá vùng GT của từng SKU **tại lần ghi cuối** mà không gọi Google (ĐÃ ĐO).
- Giá "lẽ ra": dòng template ⇒ tier VN hiện tại (DB; template có thể đã upload lại); dòng quy đổi ⇒ giá quy đổi lúc import **không được lưu ở đâu** — chỉ có giá quy đổi HÔM NAY qua `GET /api/google-iap-management/regions/catalog` (một lần gọi Google chỉ đọc, `convertRegionPrices`).
- **SQL:** `docs/google-iap-management/queries/audit-gt-past-impact.sql` (một câu SELECT, đã đo; section 1 = từng SKU + trạng thái mirror A/B/C + `gt_per_usd` + `tier_vn_today` + `convert_today_url`; section 2 = từng batch; section 3 = TOTAL).
- Chỉ đọc trên Google nếu cần chắc giá HIỆN TẠI: Export list (1 lần gọi / app) hoặc cột "Price live on Google" ở trang item. ⚠ KHÔNG bấm "Refresh" ở danh sách IAP hay "Sync from Google" ở trang item — hai nút đó GHI mirror.
- Không chứng minh được: giá trị GT đã gõ; GT bằng/sát giá quy đổi; sửa trên Console sau lần ghi cuối của mirror; SKU trạng thái C.

### A-thêm — Lỗ hổng "ô SỐ 26.000 = 26" ở cột giá CHÍNH

- **Có, và rộng hơn GT** (ĐÃ ĐO): `Price (VND)` ô số 26 ⇒ neo quy đổi VND 26 cho MỌI vùng, VN = VND 26, Hub SUCCESS; cũng nhận VND 598, JPY 12, KRW 1, IDR 15; `Price (USD)` 1999 / 26000 / 99999 cũng được nhận. Không có kiểm độ lớn nào ở đường bulk (`flagSuspiciousDrops` chỉ ở dialog Custom). Trước H4.2, cả ô CHỮ `"26.000"` cũng được nhận (preview hiện "VND 26.000", gửi VND 26).
- Google có giá sàn theo vùng cho giá purchase option không: **CHƯA BIẾT** — repo không có phản hồi thật nào; các câu "Google enforces floors" trong docs/code là chưa đo.
- Bỏ GT không đóng lỗ hổng này ⇒ BACKLOG `[GOOGLE-bulk-import-price-magnitude]`. Không sửa trong arc này.

## Phát hiện bên lề (không thuộc arc)

- Locale regex của parser Google phân biệt hoa thường: `title (Vietnamese)` bị bỏ im lặng, listing mất (ĐÃ ĐO).
- Comment đầu `excel-parser.ts:10-16` tả cột theo vị trí ("Col A/B/C/D") trong khi code map theo tên.
- Overwrite thay TOÀN BỘ mảng giá của option đích (giá live VN 99000 mất) — có hay không GT; dễ nhầm khi đánh giá việc bỏ GT.
