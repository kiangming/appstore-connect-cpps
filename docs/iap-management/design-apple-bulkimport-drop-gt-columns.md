# [APPLE-bulkimport-drop-gt] Bỏ "GT Price" / "GT Currency" khỏi Bulk Import của Apple — census + thiết kế

**Trạng thái:** census PASS (`cdd5135`); Manager chốt §P4 (2026-10-20, xem §P4-chốt). G0 (ghim hiện trạng) xong — chờ gate; G1 chưa làm.
**Nhánh:** `arc-apple-bulkimport-drop-gt-columns` (cắt từ `origin/main` = `bf48692`).
**Phạm vi:** CHỈ module Apple. Google dùng GT thật (H4) — không đổi một hành vi nào của Google.

Nhãn: **ĐÃ ĐO** (đã chạy code thật, có output) · **ĐỌC CODE** (file:line) · **CÓ TRONG SCHEMA** (migration) · **CHƯA BIẾT**.
Cách đo: 6 làn census độc lập + 1 làn rà sót, chạy code thật (generator, parser, route execute thật; chỉ giả lập Apple HTTP / Supabase / Hub) trong scratch, repo không đổi.

## TL;DR

1. **GT không ảnh hưởng gì tới thứ ghi lên Apple, vào DB hay vào audit** (ĐÃ ĐO). Parser đọc GT vào `base_price` / `base_currency` rồi **không code production nào đọc lại**.
2. **Hôm nay GT có MỘT chỗ kiểm, và nó từ chối CẢ FILE**: ô GT Price không phải số (`abc`, `23 000`, `23000đ`, `TRUE`) ⇒ `Row N: expected numeric GT Price, got "…"` — Step 1 báo đỏ; execute trả 422, Hub đóng FAILED (ĐÃ ĐO). Bỏ kiểm ⇒ các file đó **được nhận**. Mọi ca GT khác hôm nay đã được nhận im lặng.
3. **Parser tìm cột theo TÊN** (ĐÃ ĐO): bỏ 2 cột, dời, đảo thứ tự ⇒ cùng dữ liệu. Nhưng **"chỉ xoá 2 header khỏi danh sách"** sẽ làm mỗi file cũ hiện **2 cảnh báo "Skipped unexpected header"** — đó KHÔNG phải phương án (a) nào cả, phải xử lý có chủ đích (§2.1).
4. **Không có code chung nào mang GT với Google.** Đổi gói gọn trong 2 file nguồn Apple (`template-spec.ts`, `iap-items.ts`) + test + docs. Hai file chung `lib/xlsx-template.ts` và `DownloadTemplateButton.tsx` **không được đụng**.
5. **Không cột DB nào lưu GT** ⇒ không cần migration.

---

## P1 — Census

### 1.1 Template tải về hôm nay (ĐÃ ĐO — gọi đúng chuỗi hàm của nút Download)

Template sinh **ở client**, không có route API: `AppsListClient.tsx:90` và `BulkImportWizard.tsx:945` truyền `getSpec={appleIapTemplateSpec}` vào `DownloadTemplateButton` (`components/ui/shared/DownloadTemplateButton.tsx:138`) → `downloadXlsxTemplate` → `buildTemplateWorkbook` (`lib/xlsx-template.ts:119-162`).

| Biến thể (chọn ở modal) | File | Sheet | Header sheet "IAP Items" |
|---|---|---|---|
| `[]` (mặc định UI) | `apple-iap-bulk-import-template-core.xlsx` | `IAP Items`, `Notes` | A `Product ID` · B `Reference Name` · C `Type` · D `Price (USD)` · **E `GT Price`** · **F `GT Currency`** (6 cột) |
| 1 locale (Vietnamese) | `…-1-locale.xlsx` | như trên | 6 cột trên + `Display Name (Vietnamese)`, `Description (Vietnamese)` (8 cột) |
| full (`undefined`) | `apple-iap-bulk-import-template.xlsx` | như trên | 6 + 39×2 = **84 cột** |

Ba dòng mẫu ghi ô E2:F4 là **chuỗi rỗng có thật** (`{t:'s', v:''}`).

Sheet **Notes** — 4 chỗ nhắc GT (số dòng Excel thật, giống nhau ở cả 3 biến thể):

- **N11:** `GT Price | Optional | ⚠ Currently NOT applied for Apple: the import parses this column (with GT Currency) but nothing downstream consumes it — Apple pricing comes from Price (USD) → tier inference → price schedule. Safe to leave blank (the sample rows do).`
- **N12:** `GT Currency | Optional | ⚠ Currently NOT applied for Apple — see GT Price. Currency code for GT Price, e.g. "VND", if you fill the pair anyway.`
- **N15:** `UNIT REMINDER: "Price (USD)" is US dollars — it is what actually drives Apple pricing (tier inference → price schedule). GT Price / GT Currency are parsed but currently NOT applied for Apple; if filled, GT Price is a PRICE in GT Currency, NOT an exchange rate.`
- **N18–N21:** bảng minh hoạ — header có `GT Price`, `GT Currency`; 3 dòng mẫu có 2 ô GT trống.

⇒ Câu "Currently NOT applied for Apple" **XÁC NHẬN** (nguyên văn ở N11, N12; viết thường ở N15).

### 1.2 Mọi chỗ Apple nhắc GT

| Chỗ | Làm gì với GT | Vai trò |
|---|---|---|
| `lib/iap-management/parsers/template-spec.ts:52-59` | `APPLE_LEAD_HEADERS.gtPrice/gtCurrency` — nguồn DUY NHẤT, chung cho generator **và** parser | sinh cột · đọc |
| `template-spec.ts:62-63, :157-159` | `APPLE_LEAD_HEADER_ROW = Object.values(…)` ⇒ GT ở idx 4, 5 mọi biến thể | sinh cột |
| `template-spec.ts:173-181, :201-203` | `SAMPLE_ROW_VALUES.gtPrice/gtCurrency = ""`; ghi vào ô theo tên cột | sinh cột |
| `template-spec.ts:218-250` | `LEAD_NOTES.gtPrice/gtCurrency` (N11, N12) — `Record` theo key ⇒ TS ép xoá khi bỏ key | docs (Notes) |
| `template-spec.ts:291` | câu UNIT REMINDER (N15) — **chuỗi tự do, TS không bắt** | docs (Notes) |
| `template-spec.ts:299-313` | bảng minh hoạ Notes: header theo hằng, **dòng theo VỊ TRÍ** `[id, ref, '', priceUsd, v.gtPrice, v.gtCurrency, …]` | sinh cột (Notes) |
| `template-spec.ts:16, :153-156, :161-172` | comment "6 lead + 39 = 84", lý do để trống GT | docs (comment) |
| `template-spec.ts:135-140, :320-322` | bất biến "template FULL byte-identical… giữ tên file nên nội dung không được lặng lẽ đổi" | docs (bất biến) |
| `lib/iap-management/parsers/iap-items.ts:24-28, :69-73` | doc header liệt kê GT; câu `:27` "pricing stage skips on missing base currency" **SAI** | docs |
| `iap-items.ts:95-96` | `ParsedIapItem.base_price` / `base_currency` — đích của GT | truyền tiếp |
| `iap-items.ts:162-168, :260-261` | `LeadColumnIndex.gtPrice/gtCurrency = findHeaderIndex(…)` (trim, không phân biệt hoa thường) | đọc |
| `iap-items.ts:263-269` | `leadClaimed` giữ chỗ 2 cột GT để vòng quét locale không cảnh báo | bỏ qua |
| `iap-items.ts:376-380` | `basePrice = readOptionalCellNumber(…, "GT Price")`, `baseCurrency = readCol(…)` (không kiểm) | đọc · **kiểm** |
| `iap-items.ts:126-148` | `readOptionalCellNumber` — **throw cả file**; doc comment `:126-131` ghi "row-level error" **SAI**. ⚠ Price (USD) cũng dùng (`:375`) ⇒ **giữ hàm** | kiểm |
| `iap-items.ts:368-371` | comment "pricing-orchestration treats empty base_currency as no tier" **SAI** (grep: không có) | docs |
| `iap-items.ts:415-416` | `items.push({…, base_price, base_currency})` | truyền tiếp |
| `lib/iap-management/bulk-import/localization-selection.ts:28-31, :93-105` | comment lấy GT làm ví dụ "silent drop"; `{...it}` chép base_* đi tiếp, không đọc | docs · truyền tiếp |
| `lib/iap-management/bulk-import/conflict-resolution.ts:34, :68-80, :150-170` | `decision.source` mang nguyên item; chỉ đọc `price_usd, product_id, reference_name` | truyền tiếp |
| `app/(dashboard)/…/bulk-import/BulkImportWizard.tsx:1486-1489` | parse ở client; lỗi GT hiện đỏ ở Step 1 — **chỗ DUY NHẤT chữ GT tới UI** | hiển thị (lỗi) |
| `BulkImportWizard.tsx:1568-1571` | chỉ hiện SỐ LƯỢNG cảnh báo cấp file: "N parse warning(s) — open with caution" | hiển thị |
| `app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts:397-405` | server parse lại; lỗi GT ⇒ 422 + Hub FAILED | kiểm |
| Test (15 file mang `base_price`/`base_currency`; 5 file / 9 test đỏ khi bỏ GT) | xem §3 | test |
| `docs/iap-management/templates/item-iap-template.xlsx` | file legacy Apple: E1/F1 GT, E2:F4 = 23000/VND; app KHÔNG phục vụ; `parsers.smoke.test.ts:106-116` đọc nó | fixture |
| Docs: `docs/user-docs/index.html` 1335, 1343, 1347, 1964-1970 · KB 1215, 1370, 2036-2057 · `design-bulk-import-template-download.md` 32-40, 98, 105-106, 146 (ô Apple), 187, 189-190, 289, 381 · `design-bulk-import-locale-picker.md` 13, 198-199, 206, 242 · `design-bulk-import-localization-step.md` 112 · `UAT-MV28-30.md` 155 | mô tả GT / số cột của Apple | docs |

⚠ **Trùng tên, KHÔNG liên quan, không được đụng:** `territory-catalog.ts:252` (`GT` = Guatemala); `base_price`/`base_territory` của custom-prices baseline (`custom-prices/baseline/route.ts:60,197-224`, `CustomPricesDialog.tsx:176,369`), của price schedule (`iap-detail.ts`, `IapPriceScheduleSection.tsx:153-163`); `iaps.base_territory`.

### 1.3 ⭐ GT có ảnh hưởng gì tới thứ ghi lên Apple không?

**Không.** ĐÃ ĐO + ĐỌC CODE.

- Đường đi: parser → `ParsedIapItem.base_price/base_currency` (`iap-items.ts:376-380, :415-416`) → `applyLocalizationSelection` (chỉ đọc `localizations, product_id`) → `resolveConflicts` (đọc `price_usd, product_id, reference_name`) → `enrichWithTiers` (chỉ `price_usd`, `conflict-resolution.ts:158`) → execute route (`item = decision.source`; mọi truy cập `item.*` là `localizations, product_id, reference_name, type, type_source` — không có `base_*`).
- Body gửi Apple: `createInAppPurchase` `{appId, name, productId, inAppPurchaseType}` (`route.ts:951-957`); OVERWRITE `{name}` (`:1386-1388`); localization `{iapId, locale, name, description}`; giá: `applyPricingSchedule({appleIapId, localTierId, usdPrice, source, iapType, precheck, audit})` — `usdPrice` từ map tier→USD, không từ GT (`:1038-1039, :1555`).
- DB: `iaps` upsert liệt kê từng cột (`:1736-1798`); `actions_log` payload = `...PerIapResult` (không có field GT) (`:1807-1822`); `import_batches` chỉ có đếm + nhãn.
- **ĐÃ ĐO (route execute thật):** cùng lô 2 dòng chạy 5 lần — GT trống · `23000/VND` · `-5/zzz` · `1,99/VND` · không có cột GT ⇒ cả 17 lời gọi ghi lại và response **giống từng byte**; chuỗi `23000`, `VND`, `base_` không xuất hiện. Đối chứng: chép route ra scratch, nhét `base_*` vào audit ⇒ phép so ĐỎ.
- **ĐÃ ĐO (làn DB):** file 5 dòng (CREATE / OVERWRITE / SKIP / 2 ERROR), GT = `987654.321 / ZQXCUR` ⇒ 16 lần ghi DB (import_batches, iaps ×2, actions_log BULK_IMPORT_CREATE ×5, SET_PRICE_SCHEDULE ×2, …) **không có** GT; Hub, log console cũng không.

**Ca hôm nay bị TỪ CHỐI vì GT ⇒ sau thay đổi được NHẬN** (ĐÃ ĐO):

| GT Price | Hôm nay | Sau |
|---|---|---|
| `abc` · `23 000` · `23000đ` · ô boolean `TRUE` | **cả file bị từ chối**: `Row N: expected numeric GT Price, got "…"` — Step 1 đỏ; execute 422, Hub run FAILED kèm câu đó | nhận, import như file không có GT |

Không có ca GT nào hôm nay sinh cảnh báo hay lỗi CẤP DÒNG. Nhận im lặng sẵn: số âm, currency viết thường / lạ (`ZZZ`) / là số, chỉ điền một ô của cặp, thiếu cột. (`1,99` đọc thành 199, `23.000` thành 23 — vô hại vì không ai dùng.)

### 1.4 ⭐ Parser đọc cột theo TÊN hay VỊ TRÍ?

**Theo TÊN** (ĐỌC CODE + ĐÃ ĐO).

- `findHeaderIndex` (`iap-items.ts:153-159`): so tên sau `trim`, không phân biệt hoa thường; mọi cột lead tìm theo tên (`:255-262`). Không index cố định, không kiểm số cột, không so shape file với template (`:236-253`). Sheet chọn theo tên `IAP Items`, không có thì lấy sheet đầu (`:208-214`).
- Cột localization: vòng quét (`:280-319`) bỏ qua cột đã là lead (`leadClaimed`), nhận `Display Name (X)` theo `LOCALE_HEADER_RE` (`:79`); **ràng buộc vị trí DUY NHẤT** là `Description (X)` phải nằm NGAY sau `Display Name (X)` (`:299-307`) — vị trí tương đối, không tuyệt đối.
- **ĐÃ ĐO** trên fixture legacy + template full 84 cột + template 3 locale: (ii) bỏ 2 cột GT, (iii) dời GT xuống cuối, (iv) đảo 6 cột lead ⇒ kết quả **IDENTICAL** với layout hôm nay (trừ field GT); localization nhận đúng locale ở mọi layout.
- **Header lạ:** không lỗi, không coi là locale — chỉ thêm cảnh báo `Skipped unexpected header at column N: "…" (expected "Display Name (Locale)")` (`:292-297`); header rỗng bỏ qua im lặng.
- ⚠ **Hệ quả cho file cũ:** nếu chỉ bỏ GT khỏi danh sách header đã biết, 2 cột GT rơi vào vòng quét ⇒ **2 cảnh báo** (ĐÃ ĐO trên bản sao scratch): dữ liệu vẫn IDENTICAL, nhưng wizard hiện "2 parse warning(s) — open with caution" **không kèm nội dung** (`BulkImportWizard.tsx:1568-1571`) — Manager thấy cảnh báo khó hiểu cho một file hợp lệ. File cũ còn giữ dòng mẫu thì hiện **3** (thêm "1 example row(s) skipped", cùng mảng). Header GT viết thường (`gt price`) hôm nay vẫn được nhận, sau đó cũng thành header lạ.

**Chỗ phụ thuộc VỊ TRÍ (không phải parser):**

1. **Bảng minh hoạ trong Notes** (`template-spec.ts:305-313`): dòng viết theo vị trí. Bỏ key GT mà giữ `v.gtPrice/v.gtCurrency` ⇒ header 6 ô, dòng 8 ô, `Display Name` trỏ vào ô rỗng — **TS không báo** (ĐÃ ĐO trên bản sửa naive).
2. **Test** `iap-items.test.ts` (`rowWith` theo vị trí, 23000/VND ở idx 4-5) và `template-spec.test.ts` (`makeDataRow` dùng `indexOf('GT Price')` ⇒ ghi `row[-1]` không báo lỗi; dòng core 6 ô `:401-409`).
3. **Người dùng chép dòng THEO VỊ TRÍ** từ file cũ (6 cột lead) sang template mới (4 cột lead) ⇒ giá trị GT trượt vào ô locale: ĐÃ ĐO `display_name '23000'`, `description 'VND'`, **0 cảnh báo**. Parser không phát hiện được (dữ liệu hợp lệ về hình thức).

### 1.5 ⭐ Code chung với Google

**Không có symbol chung nào mang GT** (ĐỌC CODE + ĐÃ ĐO).

| Thứ | Apple | Google | Chung? |
|---|---|---|---|
| Hằng header GT | `APPLE_LEAD_HEADERS` (`template-spec.ts:52-59`) | `GOOGLE_GT_PRICE_HEADER/GOOGLE_GT_CURRENCY_HEADER` (`lib/google-iap-management/parsers/template-spec.ts:63-64`) | không |
| Parser | `iap-items.ts` (`findHeaderIndex`, `LOCALE_HEADER_RE` local, không export) | `excel-parser.ts` riêng | không |
| Kiểm giá | — | `orchestration/file-price.ts` (`filePriceOf / statedPriceOf / fileRegionPriceOf`); grep `file-price` trong 4 thư mục Apple: 0 | không |
| Dựng workbook / tải file | `lib/xlsx-template.ts`, `components/ui/shared/DownloadTemplateButton.tsx` — generic, **0 chữ GT** | dùng chung | **có — KHÔNG ĐỤNG** |

⚠ **Hai hằng chung KHÔNG được sửa:** `TEMPLATE_SAMPLE_ROWS_NOTE` (`lib/xlsx-template.ts:51-52` — Google nhận dòng note bằng so **nguyên văn**, `excel-parser.ts:373`) và `TEMPLATE_SAMPLE_PRODUCT_IDS` (`:42-46` — danh sách bỏ qua của CẢ HAI parser). Đổi bất kỳ ⇒ đổi hành vi Google.

Cạnh import khác (không liên quan GT): Google dùng `lib/iap-management/concurrency.ts`, `pagination/page-slice.ts`; Apple import type `Continent` từ Google (`territory-continent.ts:22`).

**ĐÃ ĐO:** trỏ 2 file nguồn Apple sang bản đã bỏ GT (redirect vitest) ⇒ fingerprint template Google (spec JSON + CSV ghi/đọc lại) **trùng từng byte** ở cả 4 lựa chọn locale; fixture Google `template-item-iap-google.xlsx` cho cùng `regionOverrides` (sha `379b164101f0b7c1`) trước/sau; **10 file / 258 test GT của Google xanh**, 110 file / 1502 test Google + UI chung xanh.

Docs chung 2 module: `docs/user-docs/index.html` (Apple: `data-page="apple-bulk-import"` dòng 1279–2015; Google: 5421–5683 — GT Google ở 5444, 5460, 5475, 5500-5503, 5637-5680, **giữ**); `design-bulk-import-template-download.md` (dòng Google 118, 128-129, 140, 202-203, 296, 317 **giữ**; `:146` chỉ sửa ô Apple); `design-bulk-import-locale-picker.md:200` (Google, **giữ**); KB `:2100-2140`, `§35.3 :9056-9057` (Google, **giữ**).

### 1.6 File Apple khác có cột GT

- **Do tool sinh ra:** CHỈ template bulk import. List export (`/api/iap-management/apps/[appId]/export`, `xlsx-export.ts:495-660`) và matrix export (view + edit) **không có** GT Price/GT Currency — chữ "GT" duy nhất ở đó là Guatemala (`Price in Guatemala (GT)`, `Guatemala (GTM_GTQ)`) (ĐÃ ĐO).
- **File đã commit:** quét mọi `.xlsx/.csv` trong repo (15 file + `metadata.xlsx` trong `public/sample-import.zip`): chỉ 2 file có header GT — `docs/iap-management/templates/item-iap-template.xlsx` (**Apple legacy**, không phục vụ cho người dùng; test smoke đọc) và `docs/google-iap-management/templates/template-item-iap-google.xlsx` (**Google — giữ nguyên**) (ĐÃ ĐO).
- **File người dùng đang giữ:** mọi template đã tải trước thay đổi + file làm việc của team ⇒ chính là "file cũ" của §2.1.

### 1.7 DB

- **Không cột/bảng nào lưu GT**, Apple lẫn Google: grep `gt_price|gt_currency|base_price|base_currency` trên 56 migration = 0 (CÓ TRONG SCHEMA). `iaps.base_territory` (`20260515000000_iap_mgmt_init.sql:94`, DEFAULT 'USA') và `custom_prices_baseline_base_territory` **không phải GT** — không được xoá.
- Chỗ tự do duy nhất là `actions_log.payload` (JSONB): ĐÃ ĐO không có GT trong mọi payload; `git log -S` trên route execute (37 commit): chưa từng có `base_price/base_currency` hay `...item`. Dữ liệu prod thật: **CHƯA BIẾT** (chưa query) — SQL chỉ đọc ở §P4.
- `import_batches.template_version = 'iap-items-v1'` (`route.ts:545`): không code app nào đọc (chỉ ghi).
- ⇒ **Không cần migration.**

---

## P2 — Thiết kế

### 2.1 File CŨ còn 2 cột GT — đề xuất, KHÔNG tự chốt

⚠ **"Không làm gì" KHÔNG phải (a):** chỉ xoá 2 header khỏi danh sách đã biết ⇒ file cũ hiện 2 cảnh báo chung chung (§1.4). Muốn (a) hay (b) đều phải **nhận diện có chủ đích** 2 tên `GT Price` / `GT Currency` là "cột cũ đã bỏ" — giữ chỗ (`leadClaimed`) nhưng **không đọc, không kiểm**. Danh sách này chỉ ở Apple (`APPLE_RETIRED_LEAD_HEADERS` trong `template-spec.ts`), không chạm hằng Google.

| | Làm gì | Được | Mất |
|---|---|---|---|
| **(a) ⭐ đề xuất** | nhận, bỏ qua 2 cột, không kiểm, không báo | đúng nguyên văn "không cần kiểm tra"; file cũ = file mới, 0 cảnh báo; không thêm UI | ai điền GT tưởng có tác dụng thì không được nhắc — nhưng GT **chưa từng** có tác dụng, và Notes cũ đã ghi "NOT applied" |
| (b) | nhận, bỏ qua, hiện 1 dòng thông tin ở preview | người dùng biết cột bị bỏ | cần một kênh "thông tin" MỚI: wizard hôm nay chỉ đếm cảnh báo ("open with caution"), đẩy vào đó là báo động giả cho file hợp lệ; thêm UI + test |
| (c) | từ chối, bảo tải template mới | — | ngược yêu cầu "không cần kiểm tra"; chặn mọi file cũ của team |

### 2.2 Template download + Notes

- Bỏ 2 key khỏi `APPLE_LEAD_HEADERS` ⇒ core **4 cột** (`Product ID, Reference Name, Type, Price (USD)`), 1 locale 6, full **4 + 78 = 82**.
- Bỏ `gtPrice/gtCurrency` khỏi `SAMPLE_ROW_VALUES`, `LEAD_NOTES`, data rows.
- **Bảng minh hoạ Notes dựng THEO TÊN header** (như data rows), không theo vị trí — để thêm/bớt cột không thể lệch nữa (sửa gốc của bẫy §1.4-1).
- Viết lại UNIT REMINDER, bỏ câu GT: `"Price (USD)" is US dollars — it is what drives Apple pricing (tier inference → price schedule).`
- Thêm một câu không nhắc cột đã bỏ, chặn bẫy chép theo vị trí (§1.4-3): `Copying rows from another file? Copy column by column under the same headers — column positions can differ between template versions.`
- Tên file giữ nguyên (xem Q3).

### 2.3 Code Apple — không để code chết

- `iap-items.ts`: bỏ `gtPrice/gtCurrency` khỏi `LeadColumnIndex` và phần đọc `:376-380`; bỏ `base_price/base_currency` khỏi `ParsedIapItem` (không reader production — ĐÃ ĐO bằng typecheck in-memory: chỉ test + chính chỗ gán); thêm giữ chỗ cho `APPLE_RETIRED_LEAD_HEADERS` (theo 2.1).
- **Giữ** `readOptionalCellNumber` (Price (USD) dùng); sửa doc comment sai ("row-level error" → throw cả file).
- Sửa comment sai/lỗi thời: `iap-items.ts:24-28, :69-73, :368-371`; `template-spec.ts:16, :135-140 (bất biến), :153-156, :161-172, :320-322`; `localization-selection.ts:28-31` (đổi ví dụ "silent drop").
- `import_batches.template_version`: giữ `'iap-items-v1'` (xem Q4).
- **Không đụng:** `lib/xlsx-template.ts`, `DownloadTemplateButton.tsx`, mọi file `*google-iap-management*`, các `base_price/base_territory` trùng tên (§1.2 ⚠).

### 2.4 Docs

- `docs/user-docs/index.html` (CHỈ section Apple 1279–2015): `:1335` (6 cột core / 84 cột → 4 / 82), `:1343` (bỏ dòng bảng GT), `:1347`, `:1964-1970` (ví dụ header + 3 dòng mẫu). Thêm 1 câu: file cũ còn 2 cột GT vẫn nhập được, 2 cột đó bị bỏ qua.
- KB: `:1215, :1370` (84-col), `:2036-2057` (Hotfix 27 — ghi chú "GT bỏ 2026-10-xx") + mục KB mới cho arc.
- Design docs (chỉ phần Apple): `design-bulk-import-template-download.md` 32-40, 98, 105-106, 146 (ô Apple), 187, 189-190, 289, 381; `design-bulk-import-locale-picker.md` 13, 198-199, 206, 242; `design-bulk-import-localization-step.md:112`.
- `docs/iap-management/UAT-MV28-30.md:155` (kỳ vọng thả file legacy) — theo 2.1(a) vẫn đúng, ghi chú thêm.
- File legacy `item-iap-template.xlsx`: **giữ nguyên** — nó chính là fixture "file cũ" cho test §3.

---

## P3 — Parity + test

**3.1 Parity Apple** (test hiện có + mới): cột khác, localization, tier, giá, preview, execute, step Localization không đổi.
- Test mới **P-old-new:** cùng dữ liệu ở (i) layout cũ có GT (kể cả GT rác `abc`, `-5`, `ZZZ`, `TRUE`), (ii) layout mới ⇒ parse ra **deep-equal** (items + warnings); file cũ **0 cảnh báo** do GT (theo 2.1a).
- Test mới **P-route:** route execute thật — file cũ GT rác ⇒ 200 và **cùng lời gọi Apple / cùng ghi DB** như file mới (như harness đã đo ở §1.3, đưa vào repo).
- Fixture legacy `item-iap-template.xlsx`: vẫn 3 item, 0 cảnh báo (sửa `parsers.smoke.test.ts:106-116` bỏ assert base_*).

**3.2 Parity Google:** không sửa assertion Google nào; chạy lại 10 file / 258 test GT Google; `git diff --stat origin/main -- '*google-iap-management*'` = trống.

**3.3 Test mới cho template:** header core = đúng `["Product ID","Reference Name","Type","Price (USD)"]`; full 82; `not.toContain("GT Price")` / `"GT Currency"` ở header **và** Notes; bảng minh hoạ Notes: mỗi giá trị đúng dưới header của nó. Test chống nhầm spec Apple/Google (`AppsListClient.test.tsx:45`, `BulkImportWizard.test.tsx:279`): hai core đều còn 4 cột ⇒ phân biệt bằng nội dung (`Reference Name` ∈ Apple, `GT Price` ∈ Google), không bằng độ dài.

**Test phải sửa (ĐÃ ĐO, 5 file / 9 test đỏ khi bỏ GT):** `template-spec.test.ts` (:58, :164, :301, :372, :447), `iap-items.test.ts:128`, `parsers.smoke.test.ts:114`, `AppsListClient.test.tsx:45`, `BulkImportWizard.test.tsx:279`. Thêm **15 file** test dựng `ParsedIapItem` có `base_*`: typecheck bắt 10 (7 file thừa thuộc tính + 3 file assert giá trị); **5 file dùng cast** (`as unknown as`…) nên TS không bắt — phải grep tay (`git grep -l 'base_price\|base_currency' -- '*.test.ts*'`, trừ custom-prices). ⚠ Fixture theo vị trí trong `iap-items.test.ts` (`rowWith`): sửa đồng thời LEAD và dòng, không được chỉ xoá header.

**3.4 Mutation (qua `scripts/mutate.sh`):**
- template vẫn sinh cột GT ⇒ ĐỎ (3.3);
- parser còn kiểm GT (file cũ GT `abc` bị từ chối) ⇒ ĐỎ (P-old-new);
- bỏ giữ chỗ cột cũ (2 cảnh báo quay lại) ⇒ ĐỎ;
- bảng Notes quay về theo vị trí ⇒ ĐỎ;
- parser đọc theo vị trí (vd. cột locale tính từ idx 6) ⇒ ĐỎ (P-old-new layout dời cột);
- đổi hành vi Google (vd. bỏ GT khỏi spec Google) ⇒ test Google ĐỎ.

**Chia chunk đề xuất:** G0 ghim hiện trạng (fingerprint template Google; parse fixture legacy; hành vi "GT rác ⇒ từ chối" hôm nay) → G1 đổi template + parser + test + docs. 0 migration.

---

## P4 — Câu cần Manager chốt

> **Q1 — File cũ còn cột GT (§2.1).** Đề xuất **(a)**: nhận, bỏ qua, không kiểm, không báo — có nhận diện 2 tên cột cũ để không sinh cảnh báo chung chung. Lý do: đúng nguyên văn "không cần kiểm tra"; GT chưa từng có tác dụng ở Apple; (b) cần một kênh thông tin mới vì wizard hôm nay chỉ đếm cảnh báo.
>
> **Q2 — Migration DB (§1.7).** Đề xuất **KHÔNG**: không cột nào lưu GT. Tuỳ chọn, chỉ đọc, để chắc chắn prod chưa từng ghi GT vào audit:
> ```sql
> SELECT action_type, count(*) FROM iap_mgmt.actions_log
>  WHERE payload::text ~* '(base_price|base_currency|gt price|gt currency|gt_price|gt_currency)'
>  GROUP BY 1;
> ```
> Kỳ vọng: 0 dòng.
>
> **Q3 — Tên file template full (§1.2, bất biến `template-spec.ts:135-140`).** Nội dung đổi 84 → 82 cột nhưng tên giữ `apple-iap-bulk-import-template.xlsx`. Đề xuất **giữ tên** (đổi là có chủ đích, có ghi; file cũ vẫn nhập được) và sửa câu bất biến. Phương án khác: đổi tên để phân biệt file mới/cũ trong Downloads.
>
> **Q4 — Nhãn `import_batches.template_version` (`'iap-items-v1'`).** Đề xuất **giữ**: không ai đọc, và file cũ vẫn được nhận nên nhãn mới cũng không phân biệt được hình dạng file.

## §P4-chốt — Manager quyết (2026-10-20)

- **Q1 = (a):** nhận file cũ, bỏ qua 2 cột GT, KHÔNG kiểm, KHÔNG báo. 2 tên cột cũ nằm trong danh sách "cột cũ đã bỏ" CHỈ cho Apple, để file cũ không sinh cảnh báo "Skipped unexpected header".
- **Q2 = KHÔNG migration.** Manager chạy trên prod **2026-10-20**:
  ```sql
  SELECT action_type, count(*) FROM iap_mgmt.actions_log
  WHERE payload::text ~* '(base_price|base_currency|gt price|gt currency|gt_price|gt_currency)'
  GROUP BY 1;
  ```
  ⇒ **0 dòng**: `actions_log` chưa từng lưu GT.
- **Q3 = GIỮ** tên `apple-iap-bulk-import-template.xlsx`; sửa comment bất biến `template-spec.ts:135-140` cho đúng việc nội dung đổi từ 84 xuống 82 cột.
- **Q4 = GIỮ** `template_version = 'iap-items-v1'`.
- **Ca chép CẢ DÒNG từ file cũ sang template mới** (§1.4-3, ĐÃ ĐO: GT trượt vào `Display Name` / `Description`, 0 cảnh báo): **KHÔNG thêm code phát hiện.** Lớp chặn:
  1. câu dặn trong sheet Notes: chép dữ liệu theo từng cột, không chép cả dòng từ template cũ;
  2. **step 4 Localization** đã hiện từng ô theo nhãn Name / Desc, tô sáng trường khác bản đang bán, TRƯỚC execute ⇒ giá trị GT lọt vào sẽ lộ ở đó;
  3. một câu cảnh báo ngắn trong user guide (G1).

## Tiến độ

- **G0** — ghim hiện trạng, chưa đổi hành vi (`lib/iap-management/parsers/gt-columns.baseline.test.ts` T1–T3 template + P1–P4 parser; `app/api/iap-management/apps/[appId]/bulk-import/execute/gt-columns.route.test.ts` R1–R2 route thật; `lib/iap-management/parsers/gt-drop.google-parity.test.ts` GP1–GP3 Google). Mutation 5/5 đỏ.
- **G1** — chưa làm.

## Phát hiện bên lề (không thuộc arc, ghi để BACKLOG)

- Số `Row N` trong lỗi parser là chỉ số SAU khi `sheet_to_json(blankrows:false)` bỏ dòng trống ⇒ trên template sinh ra (có dòng trống ngăn cách) câu lỗi nói `Row 6` khi ô thật ở dòng 7 (ĐÃ ĐO). Ảnh hưởng mọi lỗi theo dòng, có từ trước.
- Wizard chỉ hiện SỐ cảnh báo cấp file, không hiện nội dung (`BulkImportWizard.tsx:1568-1571`) — người dùng không biết cảnh báo nói gì.
