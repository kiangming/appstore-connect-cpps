# Import lại file export Matrix view vào Pricing Template (Apple) — CENSUS + KHẢ THI + THIẾT KẾ

**Tag:** `[TEMPLATE-xlsx-reimport]` · **Module:** Apple IAP Management ·
**Trạng thái:** census xong + một vòng phản biện, **chờ Manager chốt P7**. Chưa
code. Thiết kế đề xuất cần **1 migration (chỉ thêm một function, không đổi bảng)**
— §5.4.

> **Yêu cầu Manager.** Trong Settings → Pricing templates (Default pricing / Per-app
> pricing): **format A** = file template dùng để IMPORT; **format B** = file .xlsx
> EXPORT ra từ "Open matrix view". Muốn round-trip: export B → sửa vài ô → import B
> lại vào đúng Default / Per-app đó.
>
> **Ngữ nghĩa đã chốt:** ô Manager KHÔNG đụng giữ nguyên ý nghĩa — ô đang thừa
> hưởng giá Apple vẫn thừa hưởng (vẫn đi theo Apple khi Apple đổi giá), ô đang
> override vẫn override đúng giá cũ. Chỉ ô Manager SỬA mới thành override giá mới.
> **Bài nghiệm thu số một:** export B rồi import lại nguyên trạng ⇒ template KHÔNG
> ĐỔI GÌ.

**Nhãn bằng chứng dùng trong file này**

| Nhãn | Nghĩa |
|---|---|
| **ĐÃ ĐO** | đã chạy thật và thấy output (lệnh/fixture ghi kèm) |
| **ĐỌC CODE** | đọc tại `file:line` |
| **CÓ TRONG SCHEMA** | có trong migration SQL `file:line` |
| **CHƯA BIẾT** | chưa xác lập được — kèm cách đo |

**Census được làm thế nào.**
- **Vòng 1 — census:** 5 lane độc lập (format A · format B · ngữ nghĩa + DB · quy
  tắc KB · độ bền), mỗi lane có **một verifier đối kháng riêng** dò lại từng
  `file:line` và chạy lại từng phép đo. Kết quả: 185 claim; verifier trả 192 phán
  quyết — **161 CONFIRMED · 29 PARTLY** (sai số dòng / nhãn đo quá tay / thiếu chi
  tiết — đã sửa trong file này) **· 2 UNVERIFIABLE · 0 WRONG** — cộng 57 phát hiện
  census bỏ sót (đã gộp vào đây).
- **Vòng 2 — phản biện bản thiết kế:** 4 agent tấn công độc lập (dò lại 131
  citation · phá cơ chế · đối chiếu quy tắc KB · khả thi khi code). Kết quả: 1
  BLOCKER, 18 MAJOR, 31 MINOR. **Cả 19 BLOCKER/MAJOR đã được xử lý trong bản này**,
  đánh dấu ⟲ ở chỗ thiết kế đổi vì phản biện.
- File B mẫu được sinh bằng **chính route POST thật**, chỉ mock 4 seam (session,
  active account, `iapDb` giả lập PostgREST, logger). Độ bền đo trên **Microsoft
  Excel 16.104 và Numbers 14.4 thật** trên máy này, chỉ trên bản sao trong
  scratchpad. Google Sheets: **CHƯA BIẾT** (không có quyền truy cập).

---

## TL;DR — câu chặn cửa

1. **B là ma trận THƯA, không phải ĐẦY.** Ô không có entry được ghi ký tự `·`
   (U+00B7) vào **cả ô Price lẫn ô Currency**. Ô có entry ghi số. Trạng thái
   override/thừa hưởng nằm ở **giá trị ô**, không nằm ở màu (§2.1–2.2). ⇒ Lỗi im
   lặng "mọi ô thành override" mà brief lo **không xảy ra** với B — miễn là `·`
   được đọc về đúng nghĩa "không có entry".
2. **Nhưng B hôm nay KHÔNG import an toàn được.** Có **9 đường mất dữ liệu / ghi
   sai im lặng** khác (§2.4), nặng nhất là: file export có thể đã bị **LỌC** (chỉ
   một phần nước) và REPLACE-ONLY sẽ xoá mọi override của các nước bị lọc; file
   **không có mã nước, không có scope, không có version**; B không mang proceeds;
   và đường ghi hôm nay **không có transaction** — với B, DB là bản sao duy nhất,
   nên một lần ghi đứt giữa chừng là mất **vĩnh viễn** (⟲ BLOCKER của vòng phản biện).
3. **Đề xuất (chờ chốt):** cơ chế **M3 — "ô tự nói trạng thái, ảnh chụp nằm ở
   server"**. Giá trị ô quyết định (số = override, `·` = thừa hưởng). File export
   mang kèm một sheet thông tin nhỏ (scope + `template_id` + digest + bảng danh
   tính dòng/cột). Import chỉ ghi khi template trên server **vẫn đúng là bản đã
   export — cả id lẫn nội dung** (digest). Diff rỗng ⇒ **không ghi gì**. Có ghi
   ⇒ **một function Postgres duy nhất**, kiểm-và-thay trong **một transaction**.
   Nút import đặt **cạnh nút Export trên Matrix view**, không đụng 3 nút upload
   format A.

---

## P1 — CENSUS HAI FORMAT

### 1.1 FORMAT A — template import

**Parser:** `lib/iap-management/parsers/price-tiers.ts` → `parsePriceTiersXlsx`.
**Route:** `POST /api/iap-management/pricing-templates`
(`app/api/iap-management/pricing-templates/route.ts`).
**Đường ghi:** `replaceTemplate(scope, parsed: PriceTiersParseResult, …)`
(`lib/iap-management/queries/templates.ts:574-727`).

| Mục | Sự thật | Nhãn · bằng chứng |
|---|---|---|
| Sheet | chỉ đọc `SheetNames[0]`, tên phải đúng `price_tiers` (phân biệt hoa thường); `price_tiers` ở vị trí thứ 2 ⇒ bị từ chối | ĐỌC CODE `price-tiers.ts:36`, `:149-158` · ĐÃ ĐO (sheet `Default Template` ⇒ 422, `replaceTemplate` 0 lần gọi) |
| Số dòng header | 2: hàng 0 = nước, hàng 1 = `Price`/`Proceeds`; dữ liệu từ hàng 2 | ĐỌC CODE `:161-165`, `:180`, `:224` |
| Header nước | regex `/^(.+?)\s*\(([A-Z]{3})_([A-Z]{3})\)\s*$/`, chỉ ở cột lẻ 1,3,5… (cột chẵn bị bỏ qua im lặng); ví dụ `United States (USA_USD)` | ĐỌC CODE `:37`, `:180-197` |
| Hướng ma trận | **dòng = tier**, **cặp cột = territory** (Price, Proceeds) | ĐỌC CODE `:191-196` |
| Nhận diện territory | **alpha-3 + currency nằm trong header**; tên nước người gõ bị **bỏ đi** lúc parse (`Kosovo (XKS_EUR)` chỉ còn `XKS`/`EUR`) | ĐỌC CODE `:184-196` · ĐÃ ĐO |
| Cột tier | `Free Tier` → `FREE` · `Tier N` → `TIER_N` · `Alternate Tier X` → `ALT_X`; tên khác ⇒ bỏ dòng + **warning** | ĐỌC CODE `:90-106`, `:229-233` |
| Sub-header sai | chỉ **warning**, không chặn | ĐỌC CODE `:206-217` |
| Giá trị ô | số; chuỗi thì `Number(value.replace(/,/g,""))` ⇒ ⚠ chuỗi `"1,99"` thành **199**, `"49.000"` thành **49** | ĐỌC CODE `:115-122` · ĐÃ ĐO |
| **Ô trống (Q-I)** | Price + Proceeds cùng trống ⇒ **không có entry** cho (tier, territory) = không override | ĐỌC CODE `:109-113`, `:242-243` · test `price-tiers.test.ts:45-56` |
| Ô nửa vời | Price có, Proceeds trống ⇒ entry với `proceeds=null`; Proceeds có, Price trống ⇒ bỏ + warning | ĐỌC CODE `:247-263` |
| Ký tự `·` | **lỗi cứng**: `Expected numeric value at row 3 col 2 (USA Price), got: "·"` ⇒ 422 | ĐÃ ĐO |
| File mẫu thật `docs/iap-management/templates/price-tiers-template.xlsx` | 1 sheet `price_tiers`, `!ref A1:MM97`, 95 tier × 175 territory, **đầy** (0 ô trống), 43 currency, numFmt `0.00`; parse thật ⇒ 16 625 entry, 0 warning | ĐÃ ĐO |

**Upload UI — 3 surface, cùng một route:**

| Surface | Gửi gì | Nhãn |
|---|---|---|
| Settings → Default tab | `scope=ACCOUNT` + `account_id` = account của **chip** (`?account=`), không phải TopNav | ĐỌC CODE `DefaultTemplateTab.tsx:87-96`; `settings/pricing-tiers/page.tsx:41-47` |
| Settings → Per-App tab | `scope=APP` + `apple_app_id` (route phân giải qua `getApp` của account **active**) | ĐỌC CODE `PerAppTemplateTab.tsx:95-103`; `route.ts:143-161` |
| App detail | `scope=APP` + `app_id` (UUID nội bộ) | ĐỌC CODE `AppPricingTemplateSection.tsx:47-53` |

Không surface nào có preview/dry-run trước khi REPLACE (ĐỌC CODE
`route.ts:176-214`). Cả ba có một **confirm dựa trên dữ liệu lúc tải trang** khi
template hiện tại do người khác upload (`DefaultTemplateTab.tsx:147-159`,
`PerAppTemplateTab.tsx:154-156`, `AppPricingTemplateSection.tsx:97-98`) — không
thấy được upload xảy ra sau khi trang đã tải. Mọi response 2xx được báo là "đã
thay" (`DefaultTemplateTab.tsx:113-128`). Không có nút "tải template trống" cho
format A (ĐÃ ĐO: grep).

### 1.2 FORMAT B — export Matrix view (file sinh từ route thật)

**Một đường export duy nhất** cho cả Default lẫn Per-App: một route POST
`app/api/iap-management/pricing-templates/matrix-export/route.ts`, một writer
`buildTemplateMatrixWorkbook` (`lib/iap-management/xlsx-template-matrix-export.ts`),
một helper client `lib/iap-management/matrix-export-download.ts`. Scope chỉ đổi tên
sheet và tên file (`:113-116`, `:336`). Hai page, hai view, hai fetcher
(`fetchDefaultMatrix` / `fetchPerAppMatrix`) cùng đổ vào `composeMatrix`
(`queries/template-matrix.ts:95`). — ĐỌC CODE.

**Dump file `01-default-all.xlsx`** (route thật; fixture: tier FREE/1/2/10/ALT_1/ALT_A,
nước chèn theo thứ tự VNM, THA, USA, XKS, JPN, thưa, một giá trị kiểu chuỗi
`"1.9900"` — **giả lập** ca PostgREST trả NUMERIC dạng chuỗi, việc thật sự xảy ra
hay không là CHƯA BIẾT, Phụ lục A) — **ĐÃ ĐO**. `∅` = ô trống, **không phải** `·`:

```
SheetNames      ["Default Template"]            (Per-App: ["Per-App Template"]) — đúng 1 sheet, visible
!merges         A1:A2, B1:C1, D1:E1, F1:G1, …    (mỗi nước phủ 2 cột)
freeze          xSplit=1, ySplit=2, topLeftCell=B3
row 1           Tier | Vietnam | ∅ | Thailand | ∅ | United States | ∅ | XKS | ∅ | Japan | ∅
row 2           ∅ (merge) | Price | Currency | Price | Currency | …
row 3           Free Tier | 0 | VND | · | · | …
row 4           Tier 1    | … | … | 0.99 | USD | …
row 5           Tier 2    | 49000 | VND | … | 1.99 | USD      ← chuỗi "1.9900" được ghi thành số <v>1.99</v>
…               ALT_A (tier_id rơi về vì thiếu tên — chỉ tái hiện được khi cố ý bỏ khỏi price_tiers)
numFmt          KHÔNG có khối <numFmts> trong styles.xml; mọi cellXfs numFmtId=0 (General)
sheet phụ       KHÔNG có. Không definedNames, không docProps/custom.xml.
```

| Mục | Sự thật | Nhãn · bằng chứng |
|---|---|---|
| Ô (tier, territory) **không có entry** | chuỗi `·` (U+00B7, 1 shared string, `t="s"`) ở **cả** Price và Currency; chữ xám `FFCBD5E1` | ĐỌC CODE `xlsx-template-matrix-export.ts:78`, `:216-221`, `:280-292` · ĐÃ ĐO XML `<c r="D3" t="s"><v>10</v></c>`, sst[10]=`·` |
| Ô **có entry** | Price = số thuần (`<v>`, không `t`, không numFmt); Currency = mã currency **của entry đó** | ĐỌC CODE `:161-164`, `:223` · ĐÃ ĐO |
| Header nước | **chỉ tên hiển thị** `market.name = territoryName(code)`; **KHÔNG** có alpha-3, **KHÔNG** có currency ở bất kỳ đâu trong header; Kosovo ghi `XKS` (territoryName rơi về mã) | ĐỌC CODE `:198-207`; `template-matrix.ts:157` · ĐÃ ĐO (grep mọi part: `VNM`=0, `(VNM_VND)`=0) |
| Màu cam `FFB45309` (đậm, cả Price + Currency) + note trên ô Price | **chỉ** Per-App, **chỉ** khi bật `showDiff`, **chỉ** ô mà cả Per-App lẫn Default cùng có entry và khác giá hoặc khác currency. ⇒ nghĩa là "**override Per-App khác override Default**", KHÔNG phải "override vs thừa hưởng" | ĐỌC CODE `template-matrix.ts:133-140`; writer `:296-311` · ĐÃ ĐO (file 02: B4 25000 vs Default 22000 ⇒ cam + note `Default: 22000 VND\nPer-App: 25000 VND`; ô Per-App `·` đè lên Default 49000 ⇒ `·` xám thường) |
| Default có `showDiff`? | Không có tác dụng: view hard-code `showDiff:false`, và Default được dựng **không** kèm `defaultEntries` nên `isDiff` không bao giờ được set. Gửi `true` ra file khác `false` ở **không part nào ngoài** `docProps/core.xml` | ĐỌC CODE `DefaultMatrixView.tsx:74`; `template-matrix.ts:125`, `:289` · ĐÃ ĐO (so từng part) |
| **Lọc** | Màn có search (tên hoặc alpha-3) + currency + 5 châu lục; nút Export gửi `territories = visibleMarkets.map(m => m.code)`; route giữ `matrix.markets.filter(...)` ⇒ **file có thể chỉ chứa MỘT PHẦN số nước**. **Không có lọc tier** — mọi tier luôn có dòng | ĐỌC CODE `DefaultMatrixView.tsx:38-52`, `:69`; `PerAppMatrixView.tsx:56-70`, `:88`; route `:212-214` · ĐÃ ĐO (body `['XKS','THA']` ⇒ file 2 nước, 6 tier) |
| Tier/nước nào xuất hiện | chỉ tier/nước có **≥ 1 entry trong chính template đó**; thứ tự nước = thứ tự xuất hiện đầu tiên trong luồng entry đọc từ DB (không phải alphabet, không phải thứ tự client) | ĐỌC CODE `template-matrix.ts:107-123`, `:154-161` · ĐÃ ĐO |
| Thứ tự tier | non-`ALT_` trước, `ALT_` sau, collator số trên **tier_name** | ĐỌC CODE `template-matrix.ts:78-90`, `:143` |
| Proceeds | **KHÔNG có trong file**. DB có đọc ra (`template-matrix.ts:227`) nhưng `composeMatrix` vứt (`MatrixCell` không có field, `:58-67`, `:119-122`) | ĐÃ ĐO (grep mọi giá trị proceeds của fixture = 0 hit) |
| Scope / account / app / template_id / uploaded_at | **KHÔNG có trong file.** Gợi ý duy nhất: tên sheet (nói *loại* scope, không nói *của ai*). Tên file có bundle id (Per-App) — nằm ngoài nội dung file | ĐÃ ĐO (grep mọi part); `:380-396` |
| Account của Default export | luôn là account **active ở TopNav** (`getActiveAccount`), không phải chip | ĐỌC CODE route `:153`; `default-matrix/page.tsx:18-19` |
| Hai lần export cùng dữ liệu | **khác byte**: `docProps/core.xml` mang giờ export + mỗi entry ZIP mang mtime (writer Apple không ghim; việc ghim epoch ở KB §24.2 là của **writer Google**, `lib/google-iap-management/xlsx-template-matrix-export.ts:471-472`) | ĐÃ ĐO (2 export cách 2.6 s) |

### 1.3 Bảng so sánh A vs B, cột đối cột

| Khía cạnh | A (import) | B (export) | Loại |
|---|---|---|---|
| Tên sheet | `price_tiers`, phải là sheet đầu | `Default Template` / `Per-App Template` | **khác cách viết** |
| Hàng header 1 | `Tên nước (AAA_CCC)` | `Tên nước` (theo `territoryName`, không mã) | **chỉ A có mã + currency** |
| Hàng header 2 | `Price` / `Proceeds` | `Price` / `Currency` | **cặp thứ 2 khác hẳn nghĩa** |
| Cột 0 | tên tier (Manager gõ) | `tier_name` từ bảng `price_tiers` (toàn cục) | giống chuỗi trong thực tế (mọi `tier_name` đều do parser A ghi — ĐỌC CODE `templates.ts:619-632`, `price-tiers.ts:278`) |
| Ô "không override" | **trống** | **`·`** | **cùng nghĩa, khác cách viết** |
| Ô override | số | số | giống |
| Currency | mỗi **cột** một currency (từ header) | mỗi **ô** một currency | **khác tầng** (cấu trúc nội bộ chứa được currency từng ô — `ParsedTerritoryPrice.currency_code`, `price-tiers.ts:39-46`) |
| Proceeds | có (tuỳ chọn) | **không** | **chỉ A** |
| Merge / freeze / màu / note | không | có (trang trí) | **chỉ B**, import phải bỏ qua |
| Tập nước | mọi cột Manager viết | chỉ nước có ≥ 1 entry, **có thể đã lọc** | **chỉ B có thể thiếu** |
| Scope / version | không (scope do UI gửi) | không | — |
| numFmt | `0.00` | General (không numFmt) | không ảnh hưởng giá trị đọc |

---

## P2 — ⭐ CÂU CHẶN CỬA: B THƯA HAY ĐẦY

### 2.1 Export B ghi gì vào ô KHÔNG override?

**`·` — không ghi giá Apple.** Chính writer nói rõ lý do chọn `·` thay vì để trống:
để không lẫn với một ô "không ghi được vì lý do khác" (`xlsx-template-matrix-export.ts:68-78`).
Màn hình cũng vẽ đúng ký tự đó (`MatrixTable.tsx:105-115`), và chú thích của màn
**Default** nói: *"empty cell (·) = no override for that tier-territory pair (Apple
auto-equalisation fills)"* (`DefaultMatrixView.tsx:147-151`). — ĐỌC CODE + ĐÃ ĐO.

Với **Per-App**, `·` cũng có nghĩa "không có entry Per-App" ⇒ khi tạo IAP bằng
nguồn APP_TEMPLATE, nước đó được **Apple tự cân bằng** — **KHÔNG** lùi về giá
Default theo từng ô: orchestrator đọc đúng MỘT template
(`pricing-orchestration.ts:423-428`, filter entry `:436-438`). `composeMatrix` chỉ
gắn giá Default vào ô **đã có** entry Per-App, không bao giờ chép ô chỉ-có-ở-Default
sang (`template-matrix.ts:133-135`). — ĐỌC CODE.

⚠ **Tài liệu người dùng đang nói ngược code** ở đúng điểm này:
`docs/user-docs/index.html:4246` ("phần thiếu sẽ fallback Default") và `:4344` vs
`:2096` ("Apple auto-equalisation fills") — cùng một file tự mâu thuẫn. Yêu cầu
của Manager ("ô không override thừa hưởng giá **Apple**") khớp **code**. Arc này
phải sửa luôn hai dòng kia (KB P46 — sửa cả bản vẽ/bản copy, không chỉ code) —
nếu không, chính bản copy của tính năng sẽ dạy sai nghĩa của ô `·`.

### 2.2 B có đánh dấu override vs thừa hưởng không?

**Có, và đó là giá trị ô** (`số` vs `·`), không phải màu. Không có comment, sheet,
ký hiệu hay ★ nào khác cho override/thừa hưởng (ĐÃ ĐO, lane B). Màu cam mang một
nghĩa khác (Per-App ≠ Default, §1.2) và **phải bị import bỏ qua hoàn toàn**.

⟲ **Một giới hạn phải nói thẳng (KB P37).** `·` chỉ có một nghĩa khi đường đọc
của export không thể sót dòng. Đường đọc đó **có thể** sót (R6, §2.4): một dòng
không được đọc cũng được ghi thành `·`. Nên trong file **thô**, `·` có hai nguồn
gốc ("không có entry" hoặc "không đọc được"). Thiết kế chỉ coi `·` là "không có
entry" **sau khi** digest ở bước 5 (P3) xác nhận file khớp DB — tiền điều kiện của
P37 đúng cho file **đã kiểm**, không đúng cho file thô.

### 2.3 Độ bền của từng cách đánh dấu — ĐÃ ĐO trên app thật

| Thứ cần sống sót | exceljs → SheetJS (đọc/ghi lại) | **Excel 16.104** mở → Save | **Numbers 14.4** mở → Export Excel | Google Sheets |
|---|---|---|---|---|
| Giá trị `·` | ✅ | ✅ | ✅ — nhưng ⟲ **gắn numFmt `@` (Text)** vào mọi ô chuỗi, kể cả ô `·` ⇒ mở lại bằng Excel rồi nhập số vào ô đó thì Excel lưu thành **CHỮ** (ĐÃ ĐO: `160` → `{t:"s", v:"160"}`) | CHƯA BIẾT |
| Số (giá trị) | ✅ bit-identical | ✅ — nhưng **ghi lại `<v>` 17 chữ số** cho số không biểu diễn ngắn được: `12345.6789` → `12345.678900000001`, `4.9` → `4.9000000000000004`; SheetJS đọc ra **đúng double cũ** | ✅ (giữ dạng ngắn) | CHƯA BIẾT |
| Màu chữ / note | ✅ | ✅ (note: xuống dòng `\n` → `\r\n`) | note giữ nhưng **bị chèn tiền tố `Author:\n`** | CHƯA BIẾT |
| Sheet `hidden` | ✅ | ✅ (vẫn hidden) | ⚠ **thành VISIBLE**, nội dung giữ nguyên — ⟲ **chỉ đã đo với chuỗi ngắn + số**; UUID / thời gian ISO / chuỗi digest qua Numbers: **CHƯA ĐO** | CHƯA BIẾT |
| Sheet `veryHidden` | ✅ | ✅ | ❌ **MẤT HẲN** | CHƯA BIẾT |
| Defined names | ✅ | ✅ | ❌ **MẤT** | CHƯA BIẾT |
| Document properties (title/keywords…) | ✅ | ✅ | ❌ **MẤT** | CHƯA BIẾT |
| Custom doc properties | exceljs **không ghi được** (ĐỌC CODE `node_modules/exceljs/lib/xlsx/xlsx.js:483-505`) | — | — | — |
| Thứ tự sheet | ✅ | ✅ | ⚠ **chèn sheet `Export Summary` LÊN ĐẦU** (mặc định AppleScript; mặc định của UI Numbers: CHƯA BIẾT) | CHƯA BIẾT |
| Vùng ô | ✅ | ✅ (`A1:G7` giữ nguyên) | ⟲ **đệm thêm ô rỗng** quanh lưới (đo: `A1:G7` → `A1:G10`, +21 ô stub; sheet phụ +1 cột) — giá trị không đổi | CHƯA BIẾT |

Sửa đúng **một** ô trong Excel rồi Save ⇒ chỉ XML của ô đó đổi; mọi ô khác giữ y
bản Excel trước đó (ĐÃ ĐO). ⚠ Mọi "sửa ô" trong phép đo được đặt qua AppleScript
`formula local` (tương đương nhập tay, nhưng **chưa đo bằng phím thật** — máy không
cấp quyền assistive access). Excel còn **tự gắn numFmt** (`#,##0` / `#,##0.00`) vào ô
được nhập có dấu phân cách hàng nghìn — giá trị `<v>` không đổi, nên reader đọc
giá trị thô là đủ. Sort / copy-paste: **CHƯA BIẾT (chỉ suy luận)** — sort chỉ một
cột kiểu "continue with current selection" sẽ tách giá khỏi tên tier mà mọi ô vẫn
hợp lệ ⇒ chỉ một **preview diff** mới lộ ra (§6.1).

**Kết luận cho thiết kế (đã đo):**
- Thứ duy nhất sống sót qua **mọi** app đã thử là **nội dung ô hiển thị**
  (`·`, số, chữ). Màu: không dùng làm căn cứ ghi, đúng như brief cảnh báo.
- Nếu cần một sheet thông tin: dùng `hidden` (sống qua Excel; Numbers làm hiện ra
  nhưng giữ nội dung), **cấm** `veryHidden` / defined names / doc properties
  (Numbers xoá sạch). **Tìm sheet theo TÊN, không theo vị trí** (Numbers chèn
  `Export Summary` lên đầu). Và vì Numbers làm sheet đó **hiện ra cho người sửa**,
  mọi giá trị trong nó phải được **đối chiếu với server**, không được tin (P3 bước 4).
- So "ô có đổi không" phải so **giá trị đã chuẩn hoá về 4 chữ số thập phân**
  (NUMERIC(18,4)), không bao giờ so chuỗi `<v>` và không dùng `===` (§4.2).
- "Có dòng/cột thừa không" phải xét **ô có giá trị khác rỗng**, không xét `!ref`
  hay số ô stub (Numbers đệm ô rỗng).

### 2.4 Nhưng B KHÔNG import an toàn được — 9 đường mất dữ liệu im lặng

B thưa đúng nghĩa, nên lỗi "mọi ô thành override" không xảy ra. Nhưng đưa B ngây
thơ qua REPLACE-ONLY vẫn hỏng theo 9 cách khác, **cách nào cũng im lặng**:

| # | Đường hỏng | Hậu quả | Nhãn · bằng chứng |
|---|---|---|---|
| **R1** | **Export đã lọc** (search/currency/châu lục) | REPLACE xoá **mọi override của các nước bị lọc** — kể cả file không sửa gì. Đây đúng là P4 ("gửi một tập con thì các phần tử bị bỏ ngoài sẽ bị xoá", KB:3169) | ĐÃ ĐO (file lọc 2/5 nước) |
| **R2** | B không mang proceeds | mọi `proceeds` thành NULL — **thấy được** ở cột Proceeds của Settings (`TemplateEntriesTable.tsx:224-226`); template migrate từ GLOBAL có proceeds trên đủ 1140 ô (`m1_additive.sql:101-106`). Proceeds **không** đi vào đường ghi Apple (`price-schedules.ts:32-45`) | ĐÃ ĐO (round-trip 11 083 entry: 100 % giá đúng, **11 083 proceeds mất**) |
| **R3** | Header không có mã nước | phải đảo ngược tên → mã. Đảo `territoryName` là đơn ánh trên 175 + ISO (ĐÃ ĐO: 0 trùng), nhưng đó là một phép chuyển tự viết (§4.20 cấm) và phụ thuộc phiên bản `i18n-iso-countries` (`^7.14.0`) lúc import | ĐÃ ĐO |
| **R4** | Không có scope trong file | import file account A vào account B. **Đang xảy ra được hôm nay**: tab Default làm việc trên account của **chip**, còn "Open matrix view" mở và export account **TopNav** (`DefaultTemplateTab.tsx:287`, `:303` — link không mang account; màn matrix không hề hiện tên account) ⇒ chip = B, TopNav = A ⇒ Manager export A, bấm Replace trên chip B ⇒ ghi giá A vào B | ĐỌC CODE |
| **R5** | Không có version | ghi đè thầm lặng bản người khác vừa upload. Guard duy nhất hôm nay là confirm dựa trên dữ liệu lúc tải trang (§1.1) — không thấy upload xảy ra sau đó; form không mang version; `replaceTemplate` xoá "header hiện tại của scope" chứ không xoá "header client đã thấy" (`templates.ts:634-644`) | ĐỌC CODE |
| **R6** | Đường đọc của export phân trang **không ORDER BY** | `fetchAllEntries` dùng `count` + `.range()` không `order` (`template-matrix.ts:212-229`). ⟲ **Có chủ đích**: Hotfix 24 dựa vào chính thứ tự heap này để giữ thứ tự cột Manager upload (`template-matrix.ts:145-153`) — thêm `ORDER BY tier_id, territory_code` sẽ đảo cột thành alphabet. Nhưng Postgres không cam kết thứ tự ổn định giữa các request ⇒ có thể **sót dòng** ⇒ ô đó export thành `·` ⇒ import lại thì **xoá override** | ĐỌC CODE · thực tế prod: CHƯA BIẾT |
| **R7** | `replaceTemplate` không bao giờ là no-op, và **không có transaction** | file y hệt vẫn sinh template id mới, uploaded_at/by mới, `origin_note` → NULL, upsert `price_tiers` **toàn cục**, thêm `import_batches` + `actions_log`. Xoá-rồi-chèn ~17 lô **không transaction** (`templates.ts:567-573`): đứt giữa chừng ⇒ mất phần chưa chèn. ⟲ Với format A, Manager còn file gốc để upload lại; **với B, DB là bản sao duy nhất của các ô không đụng** ⇒ đứt giữa chừng là **mất vĩnh viễn**, và lần thử lại bị 409 vì id đã đổi. Trong lúc ghi, orchestrator và bulk import đọc thấy template thiếu/vắng và **lùi về Apple** (`pricing-orchestration.ts:429-434`) | ĐỌC CODE |
| **R8** | Tên tier trong file đi vào bảng `price_tiers` toàn cục | một dòng tier gõ khác chữ ⇒ đổi tên tier cho **mọi** account/app (`templates.ts:619-632`) | ĐỌC CODE |
| **R9** | Nhập số theo locale (máy đo: `en_VN`, dấu thập phân `,`) | Excel biến `49,000` thành **số 49** (VND lệch 1000× — im lặng); `2.49` thành **CHỮ** `"2.49"`; parser A biến chữ `"1,99"` thành **199** và chữ `"49.000"` thành **49** | ĐÃ ĐO (Excel thật, nhập qua `formula local`; `readNumericCell`) |

⇒ **Câu trả lời P2:** B **thưa** về ngữ nghĩa, và `·` là một dấu bền (sống qua Excel
và Numbers). Round-trip **khả thi**, nhưng **không phải** bằng cách nới parser A
cho nhận B. Cần (i) sửa export để file mang được scope + version + danh tính dòng/cột
+ phạm vi đã lọc, (ii) import B đối chiếu với server, gộp phần ngoài phạm vi, không
ghi khi không có gì đổi, (iii) **đường ghi phải nguyên tử** trước khi B được phép ghi.

---

## P3 — CƠ CHẾ NHẬN BIẾT "Ô MANAGER ĐÃ SỬA"

### M1 — so với giá Apple hiện tại lúc import → ❌ loại

Ngoài hai lỗi brief đã nêu (Apple đổi giá giữa chừng ⇒ ô không đụng bị ghim giá cũ
thành override; Manager cố ý override bằng đúng giá Apple ⇒ bị coi là thừa hưởng),
M1 **còn không áp được vào B**: ô thừa hưởng trong B là `·`, không mang giá Apple
nào để so. Muốn làm M1 phải gọi Apple lúc import (175 nước × N tier), tức đưa một
nguồn sai đi vào đường ghi. Loại.

### M2 — nhúng ảnh chụp từng ô vào file → ⚠ chạy được nhưng thừa

Nhúng (giá + trạng thái) từng ô vào sheet ẩn; import so ô với ảnh chụp. Không dính
lỗi Apple đổi giá. Nhưng:
- **Chỗ chứa không bền**: `veryHidden` mất trong Numbers, `hidden` hiện ra cho
  Manager sửa (ĐÃ ĐO §2.3). Ảnh chụp bị sửa tay thì import tin vào một ảnh chụp sai.
- **Thừa**: B đã ghi trạng thái ngay trong giá trị ô (`·` / số), nên ảnh chụp từng ô
  chỉ còn việc phát hiện "đã đổi" — mà việc đó DB làm tốt hơn (M3).
- **File cũ** (export trước tính năng): không có ảnh chụp ⇒ từ chối (giống M3).

### M3 — ⭐ ĐỀ XUẤT: "ô tự nói trạng thái, ảnh chụp nằm ở server"

**Ý chính.** Ô B đã tự nói trạng thái của nó: **số = override ở giá đó**, **`·` =
không override** — đúng nghĩa Q-I của format A, chỉ khác cách viết (với giới hạn
P37 ở §2.2: chỉ sau khi digest khớp). Thứ còn thiếu là **biết file được export từ
bản template NÀO, và bản đó có còn nguyên không**. Hai lớp kiểm:

1. **`template_id` — điều kiện CẦN.** Mỗi lần REPLACE sinh id mới (ĐỌC CODE
   `templates.ts:647-657`; default `gen_random_uuid()`
   `20260519000000_iap_mgmt_pricing_templates.sql:24`). Id khác hoặc template đã bị
   xoá ⇒ có người đã REPLACE/Remove ⇒ **dừng** (ca f). Rẻ, và cho thông báo rõ.
2. **`covered_digest` — điều kiện ĐỦ.** ⟲ Id **không đổi** vẫn chưa chứng minh nội
   dung không đổi: không code nào UPDATE entry tại chỗ và INSERT duy nhất là
   `replaceTemplate` (ĐỌC CODE `templates.ts:676`), **nhưng** entry vẫn có thể bị
   **XOÁ dưới cùng một id** — `replacePriceTiers` (legacy) xoá mọi dòng
   `price_tiers` và FK `ON DELETE CASCADE` kéo theo entry của mọi template
   (`queries/price-tiers.ts:334-337`; `20260519000000:55`); SQL tay (Path G) cũng có
   thể sửa. Digest so nội dung DB **lúc import** với nội dung file **lúc export**,
   bắt được cả hai loại (đổi id hay không) lẫn R6 (export đọc sót). ⚠ Vì thế digest
   **không bao giờ được coi là thừa** — kể cả sau khi R6 được sửa (Phụ lục B).

Khi cả hai khớp ⇒ DB lúc này **chính là** trạng thái lúc export trên phạm vi file ⇒
**ảnh chụp đã có sẵn ở server**, đáng tin hơn mọi sheet ẩn trong file.

**Sheet thông tin `_import_info`** (thêm vào export, `state: hidden`, đặt SAU sheet
chính — đề xuất, chờ chốt ở P7). ⟲ Manifest được **tính ở route** (từ
`AppleMatrixResult.header`, `visibleMarkets`, `matrix.cells`) qua một module
server-only dùng `node:crypto`; writer chỉ **serialise** nó — giữ writer "zero data
logic" (§21.1; `xlsx-template-matrix-export.ts:21-24`), và giữ `node:crypto` ngoài
mọi module mà client có thể import (§21.3).

| Khoá | Ví dụ | Dùng để | Tin hay kiểm? |
|---|---|---|---|
| `format` / `version` | `apple-template-matrix` / `1` | nhận diện format (§5.3), từ chối version lạ | kiểm |
| `scope` + `account_id` hoặc `app_id` (+ `bundle_id` để báo lỗi dễ đọc) | `ACCOUNT` / `vng-corp` | khoá scope (§4.1) | **so với scope đích từ request** |
| `template_id`, `template_uploaded_at`, `template_uploaded_by` | uuid · ISO · email | thẻ phiên bản (ca f) + nội dung thông báo xung đột | **so với DB** |
| `template_market_order` | toàn bộ mã nước của template, đúng thứ tự cột màn đang hiện | giữ thứ tự cột khi ghi (Hotfix 24, ⟲ §4.5) + biết file có bị lọc không | **tập hợp phải bằng tập nước trong DB** |
| bảng **cột** của file: vị trí → `territory_code`, `header_text` | `B` → `VNM`, `Vietnam` | danh tính nước — không bao giờ đảo tên → mã (R3, §4.3) | **mã phải duy nhất và có trong DB; header file phải bằng `header_text`** |
| bảng **dòng**: vị trí → `tier_id`, `tier_name` | `3` → `FREE`, `Free Tier` | danh tính tier (§4.4) | ⟲ **tập tier_id phải BẰNG tập tier của template trong DB** (không có lọc tier); `tier_name` phải bằng `price_tiers.tier_name` hiện tại; cột A của file phải bằng `tier_name` |
| `covered_entry_count`, `covered_digest` | `16625` · `sha256:…` | điều kiện ĐỦ ở trên | **tính lại từ DB** |

`covered_digest` = SHA-256 của: bảng dòng + bảng cột (theo vị trí) + các dòng
`tier_id⇥territory_code⇥currency⇥canon(price)⇥canon(proceeds)` đã sort của **đúng các
entry nằm trong phạm vi file**. ⟲ Đưa hai bảng danh tính **vào** digest: một manifest
bị sửa (ví dụ Manager sort riêng cột `tier_id` trong sheet Numbers đã làm hiện ra —
lane phản biện đã dựng được ca này: file **không sửa gì** mà giá TIER_2 và TIER_10
đổi chỗ cho nhau) sẽ làm digest server tính lại lệch với digest trong file.

**Thuật toán import B (planner thuần, không I/O, không gọi Apple):**

```
vào:  file đã đọc (manifest + các ô thật sự có trong sheet)
      · scope đích (từ REQUEST — màn Manager đang đứng — không từ file)
      · template hiện tại của scope đích: header + entries (đọc có ORDER BY, chỉ dùng
        để so/digest — KHÔNG BAO GIỜ dùng làm thứ tự hiển thị)
      · price_tiers.tier_name hiện tại

1  manifest hợp lệ (format, version, đủ khoá, kiểu đúng)  sai → 422 MANIFEST_INVALID
2  manifest.scope == scope đích                            sai → 409 SCOPE_MISMATCH
3  template hiện tại tồn tại && id == manifest.template_id sai → 409 TEMPLATE_CHANGED (kèm ai/lúc nào)
4  đối chiếu danh tính với SERVER và cấu trúc file:
     – tier_id trong bảng dòng duy nhất, tập == tập tier của template trong DB;
       manifest.tier_name == price_tiers.tier_name(tier_id); cột A file == tier_name
     – territory_code trong bảng cột duy nhất, đều có trong DB; header file == header_text;
       tập template_market_order == tập nước trong DB
     – "Price"/"Currency" đúng chỗ
     – không có ô MANG GIÁ TRỊ (khác rỗng, khác stub) nào ngoài lưới manifest —
       duyệt các khoá ô thật sự tồn tại, không dựa vào !ref (miễn nhiễm <dimension> phồng
       và ô đệm của Numbers)                                sai → 422 STRUCTURE_CHANGED (kèm địa chỉ ô)
5  digest(DB ∩ phạm vi, bảng danh tính) == manifest.covered_digest
                                                           sai → 409 FILE_DB_MISMATCH
                                                           ("file và template hiện tại không khớp —
                                                            export lại"; nguyên nhân có thể là export
                                                            đọc sót HOẶC entry bị xoá dưới cùng id)
6  phân loại từng ô Price trong phạm vi (đọc { cellFormula: true, sheetStubs: true }):
     ô có .f (bất kể .t/.v)                       → KHÔNG HỢP LỆ (công thức) — kiểm .f TRƯỚC .v,
                                                     vì công thức không có cache đọc ra {t:"z", v:0}
     t='n', hữu hạn, ≥ 0, < 9e11, Math.round(x·1e4)/1e4 === x  → SỐ
     chuỗi `·` sau trim                            → `·`
     không có ô / t='z' không .f / chuỗi rỗng      → TRỐNG
     chuỗi trông như số                            → theo Manager chốt Q11
     còn lại                                       → KHÔNG HỢP LỆ
   ô Currency: chỉ được `·`, trống, hoặc đúng currency của ô (quy tắc ở bước 7)
                                                           có KHÔNG HỢP LỆ → 422, liệt kê HẾT địa chỉ
7  dựng trạng thái mong muốn:
     trong phạm vi:  SỐ p  → có entry DB và canon bằng nhau ⇒ GIỮ NGUYÊN DÒNG DB (currency + proceeds)
                             có entry DB, canon khác   ⇒ {canon(p), currency CỦA DÒNG DB, proceeds: null}
                             không có entry DB         ⇒ {canon(p), currency = currency DUY NHẤT của nước
                                                          đó trong template; 0 hoặc ≥2 currency ⇒ 422 ô đó,
                                                          không đoán; không bao giờ lấy từ manifest}
                     `·`   → không entry
                     TRỐNG → theo Manager chốt ca d (đề xuất: không entry)
     ngoài phạm vi (nước bị lọc): GIỮ NGUYÊN DÒNG DB
8  diff(DB, mong muốn) theo khoá (tier_id, territory_code), so TOÀN DÒNG
   (currency_code, canon(price), canon(proceeds)); rỗng ⇒ NO_CHANGE — KHÔNG GHI GÌ
9  trả plan + plan_hash = hash(danh sách mong muốn theo thứ tự ghi + template_id)
```

**Thứ tự ghi** ⟲: planner xếp danh sách mong muốn **theo nước** (đúng thứ tự
`template_market_order`), trong mỗi nước theo thứ tự dòng. `composeMatrix` dựng thứ
tự cột từ lần xuất hiện đầu tiên của mỗi nước trong luồng đọc
(`template-matrix.ts:145-161`), nên chèn theo nước thì thứ tự cột sau khi ghi **đúng
bằng** thứ tự Manager đang thấy — cùng giả định "heap order = insertion order" mà
Hotfix 24 đang dựa vào. (Format A vẫn chèn theo tier như hôm nay.)

**Commit** ⟲: client gửi lại file + `intent=commit` + `plan_hash`; server chạy lại 1–9,
đòi `plan_hash` khớp (thứ được ghi = đúng thứ Manager đã xem), rồi gọi **một
function Postgres** làm trong **một transaction**: khoá header của scope →
`id == expected` (sai ⇒ `RAISE` mã TEMPLATE_CHANGED) → số entry hiện tại == số
planner đã đọc (sai ⇒ TEMPLATE_CONTENT_CHANGED — chặn ca cascade chen vào giữa lúc
planner đọc và lúc ghi) → xoá header (CASCADE) → chèn header → chèn entries theo
đúng thứ tự mảng (`WITH ORDINALITY`). Đứt ở bất kỳ đâu ⇒ **rollback, template cũ
còn nguyên**; người đọc đồng thời thấy bản cũ hoặc bản mới, không bao giờ thấy nửa
vời (MVCC). Nhánh B **không upsert `price_tiers`** (B không thêm được tier — §4.8 —
nên không có gì để upsert, và không bao giờ đổi tên tier toàn cục, R8). Audit
(`import_batches` + `actions_log`) ghi **sau** khi function trả về, kiểm `error` của
từng insert (P2); xung đột ⇒ **không** ghi batch FAILED, chỉ log WARN. Route map
xung đột sang **409**, không phải 500 (hôm nay mọi lỗi của `replaceTemplate` thành
500 — `route.ts:210-214`). Đường ghi cho cả A lẫn B: P7-Q15.

**Bảy ca bắt buộc — với M3:**

| Ca | Kết quả | Vì sao |
|---|---|---|
| **a** ô không sửa, đang thừa hưởng | vẫn thừa hưởng | ô vẫn là `·` ⇒ không entry (bước 7), digest đã xác nhận `·` này là "không có entry" (bước 5) |
| **b** ô không sửa, đang override | vẫn override, **đúng dòng DB cũ** (cả currency + proceeds) | canon bằng nhau ⇒ giữ nguyên dòng — kể cả khi Excel đã ghi lại `<v>` 17 chữ số (ĐÃ ĐO: SheetJS đọc ra đúng double) |
| **c** ô sửa | override giá mới, `proceeds = NULL` (proceeds cũ thuộc giá cũ) | canon khác ⇒ dòng mới, currency lấy từ dòng DB. `·` → số = override mới (currency: quy tắc bước 7); số → `·` = bỏ override |
| **d** ô Manager XOÁ TRỐNG | **HỎI Manager** (P7-Q2). Đề xuất: **= bỏ override → thừa hưởng**, giống Q-I của A, và preview hiện rõ "override → thừa hưởng". Đo được: xoá ô Price trong Excel ⇒ ô mất `<v>`, ô Currency bên cạnh **vẫn giữ** `USD` ⇒ thiết kế bỏ qua ô Currency khi Price trống | ĐÃ ĐO (Excel `edit_clear`) |
| **e** Apple đổi giá nền giữa export và import, ô không sửa | vẫn thừa hưởng, đi theo giá Apple **mới** | ô là `·`, không mang giá; planner **không đọc giá Apple** ở bất kỳ bước nào ⇒ không thể có so sánh với Apple. ⟲ Đường import B cũng không gọi Apple **lần nào**: B phân giải app bằng DB, không qua `getApp` (§4.1) |
| **f** người khác sửa template giữa export và import | **phát hiện được, dừng, không ghi** | REPLACE nào cũng đổi `template_id` ⇒ bước 3 ⇒ 409 kèm "ai/lúc nào"; xoá entry dưới cùng id ⇒ bước 5 ⇒ 409; đua đúng lúc ghi ⇒ kiểm trong transaction ⇒ 409. Dương tính giả: người khác upload **y hệt** ⇒ vẫn 409 (an toàn: export lại là xong). ⟲ Chính mình bấm commit **hai lần** (mất response) ⇒ lần 2 thấy id đã đổi; server tra `actions_log` của scope, thấy template hiện tại sinh từ đúng `plan_hash` này ⇒ trả "đã ghi ở lần trước", không nói "bị người khác thay". Nút commit khoá theo một ref "đã commit" vĩnh viễn, không theo cờ tạm (P12) |
| **g** file thiếu `_import_info` (export cũ, hoặc sheet bị xoá) | **từ chối rõ ràng**, không lùi về M1 | "không biết thì không ghi" (KB P7 :3220; §32.10 — REFUSE là kết quả hạng nhất). Thông báo: "File này export trước khi có tính năng import lại / thiếu sheet thông tin — export lại từ Open matrix view" |

---

## P4 — CÁC CHỖ KHÁC DỄ SAI

### 4.1 Phạm vi (scope) — CHẶN import chéo account / chéo app

- **Hôm nay file B không có scope** (ĐÃ ĐO §1.2). Đề xuất nhúng vào `_import_info`.
- **Scope đích luôn đến từ REQUEST** (màn Manager đang đứng), **không bao giờ từ
  file**: file chỉ dùng để đối chiếu. Để file tự chọn đích ghi là đúng cái
  "never-from-the-client contract" đi ngược chiều (KB §25.2, P35 tại :6687).
- Default: giữ nguyên cổng hiện có — admin **trước** mọi tra cứu (KB §25.1, P34 tại
  :6668; code đang đúng thứ tự `route.ts:97` trước `:135`), `account_id` bắt buộc từ
  client và đối chiếu danh sách account thật (`route.ts:122-142`). Rồi mới so với
  `manifest.account_id`.
- Per-App: ⟲ nhánh B **chỉ nhận `app_id` (UUID nội bộ)** và phân giải bằng DB.
  Nhánh `apple_app_id` hôm nay gọi `getApp` Apple rồi `ensureAppRegistered` (một lần
  ghi DB) **trước** khi parse (`route.ts:145-155`) — B không đi đường đó: B đòi
  template đã tồn tại, nên app chắc chắn đã đăng ký; app lạ ⇒ 409. Nhờ vậy preview
  B **không ghi gì và không gọi Apple**. ⚠ Hôm nay route upload APP và export Per-App
  đều **không** kiểm app thuộc account nào — việc có sẵn, ngoài phạm vi; thiết kế
  này chỉ thêm `manifest.app_id == app_id đích`.
- **Lỗ hổng R4 hiện tại**: màn Default matrix phải **nói ra** nó đang hiển thị
  account nào (KB §19.9 tại :6272-6276: "the unsaid inference is the defect"). Với
  nút import đặt trên chính màn matrix (P7-Q12), đích ghi = đúng account màn đang
  hiện, gửi tường minh `account_id` từ props của server component.

### 4.2 Số — round-trip từng ô

| Phép đo | Kết quả | Nhãn |
|---|---|---|
| 18 giá trị (0 · 0.99 · 1.99 · 0.1 · 0.3 · 1.999 · 4.9 · 9.9 · 35 · 49000 · 12345.6789 · 99999.9999 · 0.0001 · 1234567.89 …, cộng chuỗi `"1.9900"`, `"49000.0000"`, `"0.9900"`) qua exceljs → SheetJS | **bit-identical**; chuỗi được ghi dạng ngắn nhất (`"1.9900"` → `<v>1.99</v>`) | ĐÃ ĐO |
| `<v>` kiểu Excel 17 chữ số (`1.9899999999999999`, `12345.678900000001`, `4.9000000000000004`, `1.99E0`) | đọc ra **đúng double gốc** | ĐÃ ĐO |
| Double khác thật (kết quả công thức: `0.30000000000000004`, `1.9899999999999998`) | `!==` gốc, chỉ bằng sau chuẩn hoá 4 chữ số | ĐÃ ĐO |
| `Math.round(x·1e4)` an toàn | chỉ khi `|x| < ~9.007e11` (x·1e4 < 2⁵³): đúng ở `900719925474.0991`, **sai** ở `987654321098.7653` — xa dưới trần cột NUMERIC(18,4). Giá thật (VND ~2.5e8) nằm sâu trong vùng an toàn | ĐÃ ĐO |
| PostgREST trả `NUMERIC` là số hay chuỗi? | CHƯA BIẾT — comment trong code tự mâu thuẫn; một phép đo một dòng ở Phụ lục A | CHƯA BIẾT |
| `NUMERIC(18,4)` có làm tròn nhiễu float khi INSERT? | CHƯA BIẾT (máy không có Postgres) | CHƯA BIẾT |

**Quy tắc (ghim bằng test):**
- So sánh: một hàm duy nhất `canon(x) = Math.round(Number(x) * 1e4)` cho **cả hai
  phía** (giá trị DB — có thể là chuỗi; giá trị file). Từ chối `|x| ≥ 9e11`.
- ⟲ Nhận một ô số khi **`Math.round(x*1e4)/1e4 === x`**. Quy tắc cũ của bản nháp
  (`|x·1e4 − round| > 1e-6`) **sai**: nó từ chối chính giá trị `1234567.89` trong
  bảng đo (và ~12 % số 4-chữ-số-thập-phân trong khoảng `[0, 1e9)` — ĐÃ ĐO), làm bài số
  một đỏ trên file không sửa gì. Quy tắc mới nhận mọi giá trị hợp lệ kể cả dạng
  17 chữ số của Excel, từ chối `1.99999`, `0.30000000000000004` (ĐÃ ĐO). Một double
  tính ra (0.1+0.2) bị **từ chối chứ không làm tròn** — chiều an toàn.
- Dòng **mới** ghi `canon(p)/1e4`; dòng **không đổi** giữ nguyên dòng DB.

⚠ Vì sao chuyện này không chỉ là thẩm mỹ: bulk import phân giải tier bằng **`===`
tuyệt đối** trên giá USA (`tier-order.ts:100-109`), trong khi đường ghi Apple dung
sai 0.001 (`price-points.ts:101-115`). Một giá USA lệch 1 ulp làm tier đó **không
phân giải được** trong bulk import (ĐÃ ĐO: `cands(1.9900000000000002) = []`).

### 4.3 Territory

- B dùng **tên** (`territoryName`), A dùng **alpha-3 trong header**; DB lưu alpha-3
  (`price-tiers.ts:191-195`).
- KB §4.20 (:964) cấm tự viết phép chuyển alpha-2/alpha-3. Đảo tên → mã còn tệ hơn:
  `i18n-iso-countries.getAlpha3Code` **đảo hỏng** 4/175 nước (`CHN` "China
  mainland", `LAO`, `MAC`, `XKS`) — ĐÃ ĐO.
- ⇒ **Danh tính nước lấy từ bảng cột của `_import_info`** (mã nguyên văn từ DB),
  được **đối chiếu với DB** (mã phải có trong template). Chữ header file chỉ dùng
  để kiểm vị trí: header cột i phải bằng `header_text` cột i trong manifest. ⟲ Bản
  nháp còn đòi header == `territoryName(code)` **hiện tại**; bỏ, vì nó buộc mọi file
  đã export vào phiên bản `i18n-iso-countries` (`^7.14.0`, `package.json:34`) — một
  lần bump minor đổi tên một nước là mọi file cũ bị từ chối (KB P41). Kiểm "mã có
  trong DB" + digest đã đủ chặn manifest bị sửa.

### 4.4 Tier

- B có cả tier thường lẫn `ALT_*` (ĐÃ ĐO). Danh tính: **`tier_id` theo dòng trong
  manifest**, ⟲ đối chiếu ba chiều: tập `tier_id` == tập tier của template trong DB
  (không có lọc tier, nên mọi tier có entry đều phải có dòng); `manifest.tier_name ==
  price_tiers.tier_name(tier_id)`; chữ ở cột A == `tier_name`. Không dựa vào thứ tự.
- Hai bộ sắp xếp tier trong repo — `compareTierId` (`tier-order.ts:61-78`) và
  `compareTiers` của composer (`template-matrix.ts:78-90`) — **cho cùng kết quả trên
  dữ liệu thật** (ĐÃ ĐO), lệch trên `ALT_1A` vs `ALT_2` (chỉ là tiềm ẩn). Thiết kế
  không phụ thuộc thứ tự tier nên không bị ảnh hưởng.
- Nhánh B **không upsert `price_tiers`** ⇒ import B **không bao giờ đổi tên tier
  toàn cục** (R8), và không thể ghi đè một lần đổi tên do người khác làm giữa
  preview và commit.

### 4.5 Khoá hiện có — hội tụ về đường ghi A (P1)

- ⟲ **Điểm hội tụ là `FlatTemplateEntry[]`** — đúng dạng dòng DB, và đúng thứ format
  A tạo ra qua `flattenTemplateEntries(parsed)` (`price-tiers.ts:317-333`) — rồi đi
  **chung một hàm ghi**. `replaceTemplate` hôm nay việc đầu tiên đã là flatten
  (`templates.ts:581`), nên đổi tham số sang danh sách phẳng (kèm metadata tier tuỳ
  chọn) không mở đường ghi thứ hai. ⇒ **Khả thi: CHẮC.**
- **REPLACE-ONLY (Q-A, KB:179) giữ nguyên**: lệnh ghi vẫn thay toàn bộ template.
  Phần "gộp" (giữ nước ngoài phạm vi, giữ dòng không đổi) làm **trước** lệnh ghi,
  trong planner thuần. ⚠ Backlog Google kết luận round-trip cần "**một chế độ ghi
  thứ hai**" (`docs/google-iap-management/BACKLOG.md:66-67`). File này chọn cách đọc
  khác, nói rõ ra: **một** hàm ghi, ngữ nghĩa thay-toàn-bộ không đổi; khác biệt nằm
  ở chỗ *tập mong muốn được dựng từ đâu*, không ở chỗ ghi.
- **Q-K (fail-soft)** không bị đụng: entry nào không khớp price point Apple vẫn ra
  `partial-template-fail` ở lần định giá sau, như hôm nay.
- **Không nới `parsePriceTiersXlsx`**: parser này còn một consumer thứ hai là route
  legacy `POST /api/iap-management/pricing-tiers` → `replacePriceTiers`
  (`app/api/iap-management/pricing-tiers/route.ts:58`). B có reader riêng, A giữ
  nguyên từng byte.
- **Twin Google: NGOÀI PHẠM VI** (P8). Google có writer, `replaceTemplate` và cột
  `sort_order` riêng (KB §25.7) — khác Apple ở đúng chỗ thứ tự cột. Arc này chỉ cập
  nhật câu `BACKLOG.md:66-70` mô tả gap của Apple (sẽ lỗi thời).

### 4.6 Cột USA mang hai nghĩa

Ô USA của template **bị loại khỏi danh sách override** gửi Apple
(`pricing-orchestration.ts:436-438`; base của orchestrator luôn là USA — không
caller nào truyền `baseTerritory`, `:314`; `iaps.base_territory` chỉ đi vào
`customPricesDivergeFromApple`, `update-on-apple/route.ts:271-278`). Nhưng với nguồn
template, bulk import lấy **chính ô USA/USD đó** làm (i) danh sách tier hợp lệ và
(ii) **giá base USD** gửi Apple (`listUsdTiersForSource`, `templates.ts:298-328`;
`bulk-import/execute/route.ts:488`, `:567-569`). Còn single create/update lấy base từ
bảng legacy `price_tier_territories`. — ĐỌC CODE.

⇒ Sửa ô USA trong B **không** đổi giá USA khi tạo lẻ, nhưng **đổi tier nào bulk
import chấp nhận VÀ đổi giá base USD gửi Apple** cho IAP tạo bằng bulk import nguồn
template; xoá ô USA làm tier đó **không dùng được** trong bulk import nguồn template.
⇒ Preview phải **gắn cờ riêng** mọi thay đổi ở cột USA với đúng câu đó.

### 4.7 Ô chữ, công thức, locale, vùng ô

- **Ô chữ trông như số** — sinh ra theo hai đường đã đo: Excel `en_VN` khi nhập
  `2.49`, và ⟲ **mọi** lần nhập số vào ô `·` của một file đã qua Numbers (Numbers gắn
  `@`). Không dùng `readNumericCell` (nó xoá mọi dấu phẩy ⇒ `"1,99"` → 199). Lựa chọn
  ở P7-Q11.
- **Ô công thức** ⟲: phải đọc với **`{ cellFormula: true, sheetStubs: true }`** — chỉ
  `cellFormula: true` thì công thức **không có giá trị cache** vẫn biến mất (đọc như
  ô trống ⇒ theo ca d thành "bỏ override" im lặng). Với cả hai cờ, nó hiện ra là
  `{t:"z", f:"…", v:0}` ⇒ phải kiểm `.f` **trước** `.v`, không thì đọc thành giá 0
  (ĐÃ ĐO, exceljs ghi `{formula}` không `result` đúng dạng này).
- `49,000` → số 49 trên máy `en_VN` (ĐÃ ĐO) **không phát hiện được ở tầng parse**. Chỗ
  duy nhất lộ ra là preview: gắn cờ đỏ khi giá mới / giá cũ > 10× hoặc < 0.1×. ⟲ Với
  **override mới** (`·` → số) không có giá cũ để so: so với các tier kề nhau trong
  cùng cột (thang giá theo tier phải đơn điệu) và, với Per-App, với giá Default của
  cùng ô; gãy thang hoặc lệch > 10× ⇒ cờ đỏ. Cờ chỉ cảnh báo, không chặn.
- `<dimension>` phồng (`A1:XFD1048576`) làm `sheet_to_json(defval:'')` chạy > 60 s
  trên một file **17 KB** — trần 10 MB không chặn được — **trong route Node**, chặn
  event loop của service `web` (ĐÃ ĐO; rủi ro **có sẵn** ở parser A — Phụ lục B).
  Reader B **không** gọi `sheet_to_json` trên `!ref`: nó duyệt các khoá ô thật sự có
  trong object sheet (O(số ô), miễn nhiễm `<dimension>`). Nhận diện format dùng
  `XLSX.read(buf, { bookSheets: true })` (chỉ đọc tên sheet — đo: 1 ms trên file
  `<dimension>` phồng).
- Số âm, `0b11`, `0x10`, `1e3` đều lọt `readNumericCell`; DB không có CHECK nào trên
  `customer_price`. Reader B chỉ nhận ô kiểu số `≥ 0` (và chuỗi theo Q11).

### 4.8 Sửa cấu trúc

v1 đề xuất **chỉ cho sửa giá trị ô Price trong lưới có sẵn**. Thêm/xoá/đổi chỗ
dòng hoặc cột, đổi tên header/tier ⇒ từ chối kèm địa chỉ ô. ⟲ Nói thẳng hệ quả:
tier/nước **chưa có entry nào** thì không có dòng/cột trong B, nên B không thêm được
chúng; và vì không có export A cũng như nút tải template trống (§1.1), "dùng format
A" nghĩa là **tự dựng tay một file A đầy đủ** — đúng đường dẫn tới R1–R3. Một lối
khác (P7-Q10): export thêm dòng cho **mọi** tier trong `price_tiers` (toàn `·` nếu
trống) để thêm override cho tier mới chỉ là sửa giá trị ô — nhưng làm file khác màn
(§21.1).

---

## P5 — PHƯƠNG ÁN TỔNG

### 5.1 Các phương án

**(a) Chỉ sửa EXPORT** — thêm `_import_info`. File chưa import được; là **điều kiện
cần** của (c) và (d). ~4 file nguồn + 3–4 test. Rủi ro thấp. CHẮC.

**(b) Chỉ thêm parser nhận B như hôm nay** (đổi tên sheet, đảo tên → mã, `·` = trống)
→ ❌ **không đạt yêu cầu**: R1 (file lọc xoá dữ liệu), R2 (mất proceeds), R4 (không
chặn được sai account — kể cả ca chip ≠ TopNav đang tồn tại), R5 (không phát hiện
được ca f), R6, R7 đều còn nguyên; ca f và g không có lời giải. Nêu ra để loại.

**(c) ⭐ (a) + reader B + planner M3 + preview + hàm ghi nguyên tử** — đề xuất.

| | |
|---|---|
| Làm gì | **Export:** route dùng `result.header` (hôm nay bị bỏ, `route.ts:172`), gọi `loadBundleId` **trước** khi dựng workbook (hôm nay sau, `:241-242`), tính manifest server-side, **từ chối (500) nếu thiếu `template_id`** — không bao giờ ghi manifest thiếu id; writer thêm `_import_info` **sau** sheet chính (đo: `sheet1.xml`, rels và `comments1.xml` giữ nguyên từng byte, danh sách shared string cũ là tiền tố của danh sách mới). **Import:** reader B (SheetJS, tìm sheet theo tên); planner thuần (P3); route upload hiện có thêm nhánh nhận diện + giao thức `intent` (§5.3); `replaceTemplate` nhận danh sách phẳng + gọi function Postgres nguyên tử; nút **"Nhập file đã sửa"** cạnh **"Export XLSX"** trên Matrix view (P7-Q12) + modal preview; màn Default matrix hiện tên account |
| Số file (ước) ⟲ | **nguồn ~15–16**: `xlsx-template-matrix-export.ts`, `matrix-export/route.ts`, **mới** `template-matrix-file/spec.ts` (hằng số dùng chung writer↔reader, không crypto — theo tiền lệ `parsers/template-spec.ts:1-10`), **mới** `template-matrix-file/manifest.ts` (server-only, digest), **mới** `parsers/template-matrix-file.ts`, **mới** `template-reimport/plan.ts`, `pricing-templates/route.ts`, `queries/templates.ts` (danh sách phẳng, lỗi xung đột có kiểu, gọi function), **mới** helper client + kiểu response dùng chung (P29), **mới** `MatrixImportButton.tsx`, **mới** `TemplateReimportPreviewModal.tsx`, `MatrixFilterBar.tsx` hoặc hai view, `DefaultMatrixView.tsx` + `default-matrix/page.tsx` (tên account, vai trò, `account_id`), `per-app-matrix/[appId]/page.tsx` · **migration 1** (function) · **test ~10–12 file**: 6–8 mới (reader, planner, route nhánh B, round-trip với fixture app thật, function/queries, wiring hai màn) + sửa `excel-library-split.structural.test.ts` (reader B; và vá điểm mù `await import("xlsx")`), `matrix-export/route.test.ts` (5 chỗ mock `header: {}` phải thành header thật), 2–3 test writer (chữ ký mới) · **docs 5**: KB, `pricing-templates-guide.md`, `docs/user-docs/index.html` (callout `:2042-2043` + mâu thuẫn `:4246`/`:4344`), `TODO.md`, `docs/google-iap-management/BACKLOG.md:66-70` |
| Rủi ro | function nhận ~16 600 entry qua một lời gọi RPC (~1.5–2 MB JSON) — giới hạn kích thước request của Supabase/PostgREST: **CHƯA BIẾT**, đo ở UAT; nếu vượt, cần bảng staging (đổi schema). Non-transaction của đường ghi A: tuỳ Q15. Google Sheets: CHƯA BIẾT |
| CHẮC | hội tụ về `FlatTemplateEntry[]` + một hàm ghi; `·` + số sống qua Excel/Numbers; thẻ phiên bản đổi ở mỗi REPLACE; manifest đủ dữ liệu từ route hiện có (đo); thêm sheet không làm đỏ test nào (không test nào đếm số sheet — grep) |
| CHƯA BIẾT | Google Sheets; PostgREST trả NUMERIC dạng gì; NUMERIC có hút nhiễu float; mặc định "summary worksheet" của UI Numbers; UUID/ISO/digest qua Numbers; giới hạn kích thước RPC |

**(d) (a) + đổi B sang đúng bố cục A** (`Vietnam (VNM_VND)`, `Price | Proceeds`, ô
trống thay `·`) rồi import B bằng parser A + planner.
- Lợi: một parser.
- Hại: phá §21.1 (header khác màn, cột Currency biến mất); bỏ dấu `·` đã được chọn
  có chủ đích để tránh "một giá trị hai nghĩa" (`xlsx-template-matrix-export.ts:68-78`);
  đưa proceeds vào file ⇒ phát sinh câu hỏi "Manager sửa proceeds thì sao"; ô trống
  trong A lại mang hai nghĩa (chưa bao giờ có / vừa bị xoá). Vẫn cần `_import_info`
  và hàm ghi nguyên tử. ⇒ **Không đề xuất.**

> Ngoài lề, để Manager cân nhắc: **(e) sửa ô ngay trên Matrix view** (không qua file)
> tránh được mọi rủi ro Excel/locale/Numbers ở P2/§4.7, nhưng là một arc UI lớn hơn
> và nằm ngoài brief. Nó vẫn cần hàm ghi nguyên tử + thẻ phiên bản.

### 5.2 Bảng so sánh nhanh

| | (a) | (b) | **(c)** | (d) |
|---|---|---|---|---|
| Bài số một (import nguyên trạng ⇒ 0 đổi) | — | ❌ (R1, R2, R7) | ✅ | ✅ nếu có planner |
| Ca e (Apple đổi giá) | — | ✅ | ✅ | ✅ |
| Ca f (người khác sửa) | — | ❌ | ✅ | ✅ |
| Chặn sai scope | — | ❌ | ✅ | ✅ |
| Đứt giữa chừng không mất dữ liệu | — | ❌ | ✅ (function nguyên tử) | ✅ nếu có |
| Giữ §21.1 | ✅ | ✅ | ✅ (sheet chính không đổi) | ❌ |
| Proceeds | — | mất | giữ (ô không đổi) | phải đưa vào file |

### 5.3 Nhận diện format + giao thức preview/commit ⟲

Phía server, trên **cùng** route upload, **sau** cổng auth + phân giải scope (dùng
chung, không tạo route song sinh):

0. `file.size > 10 MB` ⇒ gọi thẳng `parsePriceTiersXlsx(file)` (giữ nguyên thông
   báo + thứ tự kiểm cũ; B dùng cùng trần).
1. Nhận diện bằng `XLSX.read(buf, { bookSheets: true })` — chỉ tên sheet.
2. `SheetNames[0] === "price_tiers"` ⇒ **A**, đi đường cũ **nguyên vẹn**.
3. Có sheet tên `_import_info` (tìm theo tên — Numbers chèn `Export Summary` lên đầu)
   ⇒ **B**.
4. Có sheet `Default Template` / `Per-App Template` nhưng **không** có `_import_info`
   ⇒ từ chối: "file export trước khi có tính năng / sheet thông tin đã bị xoá —
   export lại".
5. Còn lại ⇒ **gọi** `parsePriceTiersXlsx(file)` nguyên văn — không chép thông báo
   lỗi của nó (SheetJS đọc mọi byte rác thành một sheet `Sheet1`, ĐÃ ĐO; và 11 test
   `route.scope-rejection.test.ts` gửi body 1 byte `"x"` với parser được mock — chỉ
   xanh được nếu nhánh này **ủy quyền** cho parser).

**Giao thức B** (P47 + P5): form có thêm trường **`intent`**:
- `intent=preview` ⇒ 200 `{kind: "preview", …}` — **không bao giờ** mang
  `template_id` hay `inserted_entry_count`, không ghi gì.
- `intent=commit` + `plan_hash` ⇒ lời gọi **duy nhất** được ghi.
- File B tới theo **dạng request cũ** (không `intent` — tức từ một trong 3 nút
  upload format A, hoặc tab mở từ trước deploy) ⇒ **409 `PREVIEW_REQUIRED`**, 0 lần
  ghi, thông báo: "Đây là file export từ Matrix view — dùng nút **Nhập file đã sửa**
  trên Matrix view". Vì sao 409 mà không 200: cả 3 nút upload A coi **mọi 2xx là "đã
  thay"** (`DefaultTemplateTab.tsx:113-128`, `PerAppTemplateTab.tsx:118-133`,
  `AppPricingTemplateSection.tsx:68-81`) — một preview 200 lọt vào đó sẽ hiện toast
  "đã thay — 0 ô" trong khi không có gì được ghi.

Không hỏi Manager chọn format: tên sheet của hai format rời nhau, nên không có ca mơ
hồ thật. Preview **nói ra** format đã nhận diện. (P7-Q6.)

### 5.4 Migration — một function, không đổi bảng ⟲

Bản nháp nói "không cần migration". **Sai**, vì BLOCKER R7: không có transaction thì
B không được phép ghi. supabase-js không có transaction phía client
(`templates.ts:567-573`); cách duy nhất là một function Postgres. Repo đã có tiền lệ
(`supabase/migrations/20260423000000_store_mgmt_ticket_engine_rpc.sql`, module Store).

- **1 migration**: `CREATE FUNCTION iap_mgmt.replace_template_tx(...)` — không thêm
  bảng, không thêm cột, không đổi CHECK. Theo checkpoint migration của CLAUDE.md:
  **Manager chạy SQL + verify queries trong Supabase SQL Editor; chặn PUSH, không chặn
  code**. SQL + verify ship trong báo cáo trước khi code xong.
- Audit **không** cần migration: dùng lại `action_type = 'PRICE_TIER_IMPORT'` — có
  trong CHECK hiện hành (lần định nghĩa lại cuối cùng theo tên file:
  `supabase/migrations/20260817000000_iap_mgmt_actions_log_set_territories.sql:51-61`)
  — và `import_batches.template_version` là `TEXT` **không CHECK**
  (`20260515000000_iap_mgmt_init.sql:161`). Thêm action_type mới mới cần migration
  (bẫy P2).
- `replaceTemplate` cần thêm tham số, nói đủ ⟲: `expectedTemplateId`,
  `expectedEntryCount`, `templateVersion` (`matrix-reimport-v1`; hôm nay hard-code ở
  `templates.ts:599-600`), `auditExtra` (payload: `source_format`, `based_on_template_id`,
  `plan_hash`, số ô giữ / đổi / thêm / bỏ / ngoài phạm vi), `skipTierUpsert`.
  ⚠ `created_count` hôm nay = số dòng của **cả** template (`:686-687`); với B, một
  lần sửa 1 ô sẽ ghi "16 625 created" — nghĩa mới cho một con số cũ (KB §4.21 cấm).
  Ghi số thật vào payload và định nghĩa rõ `created_count` = "số dòng đã chèn" trong
  KB.

---

## P6 — PREVIEW + PARITY + TEST

### 6.1 Preview diff (đề xuất giao diện — chưa chốt)

```
┌ Nhập file Matrix đã sửa — Default · VNG Corp (vng-corp) ─────────────────────┐
│ File: apple-pricing-template-default-20261015-2210.xlsx   Format: Matrix v1 │
│ Export từ bản template: 18/05 bởi manager@…  ✓ vẫn là bản hiện tại           │
│                                                                              │
│  ● 3 ô đổi giá (override → override)   ● 1 override mới (thừa hưởng → giá)   │
│  ● 2 bỏ override (giá → thừa hưởng)     ○ 16 619 ô giữ nguyên                 │
│  ○ 163 nước KHÔNG có trong file (export đã lọc) — giữ nguyên                 │
│  ⚠ 1 thay đổi ở cột USA — đổi tier bulk import chấp nhận VÀ giá base USD     │
│    gửi Apple cho IAP tạo bằng bulk import nguồn template                     │
│  ⛔ 1 ô lệch > 10× — kiểm lại kiểu nhập số (vd. "49,000" thành 49)           │
│                                                                              │
│  Tier       Nước      Cũ              Mới             Loại                    │
│  Tier 5     Vietnam   129 000 VND  →  49 VND          ⛔ đổi giá ×0.0004      │
│  Tier 1     Japan     ·            →  160 JPY         override mới            │
│  Tier 2     USA       1.99 USD     →  ·               ⚠ bỏ override (USA)     │
│  …                                                                           │
│                                       [ Huỷ ]   [ Ghi 6 thay đổi ]           │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **0 thay đổi** ⇒ modal nói "Không có thay đổi — không ghi gì", **không có nút ghi**,
  và server không gọi hàm ghi.
- Toast sau khi ghi đọc số từ diff thật, không phải "đã thay N entry" (P5).
- Xung đột (409) nói đúng chuyện đã xảy ra: *"Template đã được thay lúc 14:02 bởi
  x@… sau khi bạn export — template KHÔNG bị thay đổi bởi lần nhập này. Export lại
  rồi sửa trên file mới."*
- Nút import đặt trên Matrix view ⇒ **3 nút upload format A không đổi gì**, và các
  confirm "sẽ thay toàn bộ N ô" của chúng (`DefaultTemplateTab.tsx:455-507`,
  `PerAppTemplateTab.tsx:154-160`, `AppPricingTemplateSection.tsx:96-103`) không bao
  giờ bắn ra cho file B (nếu Q12 chọn tái dùng nút Replace thì cả ba confirm + mockup
  `design/account-default-template-mockup.html:310-324` phải sửa — P46).

### 6.2 Parity — format A không đổi hành vi

- Nhánh A gọi đúng `parsePriceTiersXlsx(file)` rồi hàm ghi như hôm nay; nút upload A
  không đổi.
- Ghim: test route với một file A chụp lại **đúng dữ liệu** truyền vào hàm ghi
  (trước/sau như nhau, kể cả thứ tự dòng — chèn theo tier như hôm nay); file A chứa
  `·` vẫn 422 với đúng thông báo cũ; 11 test `route.scope-rejection.test.ts` + 11 test
  `price-tiers.test.ts` xanh nguyên; nhánh "không truyền `expectedTemplateId`" được
  ghim riêng ở tầng queries (P42).
- Nếu Q15 chọn W1 (function nguyên tử cho cả A), A **khác** ở đúng một điểm: lỗi giữa
  chừng giờ rollback thay vì để template thiếu — ghi rõ trong KB, không gọi là
  "không đổi".
- Hàng rào Excel: reader B dùng `xlsx` (KB §4.17: xlsx đọc, exceljs ghi). ⚠ Fence
  không nhìn thấy `await import("xlsx")` (ĐÃ ĐO), và danh sách `PARSERS` chỉ có 2
  parser Google (`excel-library-split.structural.test.ts:189-192`). Đề xuất: cho
  `importsPkg` (`:224`) bắt cả `import("xlsx")`, đưa cả 2 parser Apple + reader B vào
  `PARSERS` — sửa điểm mù thay vì nới một allowlist (P39/P40).

### 6.3 Test nghiệm thu tối thiểu

**Độ trung thực của fake (bắt buộc, KB §19.6, §25.3):** fake ở tầng `iapDb`/PostgREST;
NUMERIC trả về **dạng chuỗi** (vì CHƯA BIẾT); phân trang không ORDER BY trả thứ tự
**không ổn định**; `.eq()` **thật sự lọc**, với **hai account mang giá KHÁC nhau**.
Mọi test từ chối phải khẳng định **mã lỗi cụ thể**, không chỉ "409, không ghi" — vì
bước 3, bước 5 và kiểm trong function chồng nhau, một mutation tắt một bước vẫn ra
409 qua bước khác (§25.6). Writer và reader dùng chung `spec.ts` nên round-trip
writer→reader **tự nhất quán theo cấu tạo** (P36): chỉ **fixture do app thật lưu ra**
mới là chốt không phải tautology.

| # | Test | Tầng |
|---|---|---|
| **T1 — BÀI SỐ MỘT** | writer thật → bytes → reader thật → planner → route: **0 thay đổi, hàm ghi KHÔNG được gọi, `template_id` không đổi**. Biến thể: Default · Per-App `showDiff` bật/tắt · export đã lọc · file đã qua **Excel thật** · file đã qua **Numbers thật** (có `Export Summary`, ô đệm, sheet `_import_info` hiện ra, mọi khoá manifest đọc lại đúng kiểu + giá trị) | P31: dưới tầng thấp nhất |
| **T1b** ⟲ | sửa **đúng một ô** rồi commit: bắt dữ liệu truyền vào hàm ghi; **mọi dòng khác** bằng dòng DB từng field (currency, giá, **proceeds**) và **thứ tự cột** sau khi ghi không đổi. Biến thể: export đã lọc, Per-App | planner + route |
| T2 | 7 ca a–g, mỗi ca một test có tên; ca b có thêm một ô sửa kèm để thực sự có lần ghi | planner + route |
| T3 | số §4.2: DB trả chuỗi `"1.9900"` vs file `1.99` ⇒ không đổi; `<v>` 17 chữ số ⇒ không đổi; **`1234567.89` và `2844767.5218` không đổi ⇒ NO_CHANGE**; `1.99999` ⇒ 422; `49000 → 49` ⇒ preview gắn cờ; override mới `·` → `49` giữa thang VND ⇒ gắn cờ | planner |
| T4 | scope: file account A vào account B ⇒ 409 `SCOPE_MISMATCH` **và 0 lần ghi**; file app X vào app Y ⇒ 409; non-admin + account không tồn tại ⇒ **403, không phải 400/404** (P34); nhánh B Per-App **không gọi Apple lần nào** (đo theo thời gian, P19) | route |
| T5 | export thiếu dòng (DB có entry mà file ghi `·`) ⇒ 409 `FILE_DB_MISMATCH`; ⟲ **entry bị xoá dưới cùng `template_id`** (cascade `price_tiers`) ⇒ 409 `FILE_DB_MISMATCH`, 0 lần ghi | route |
| T6 | cấu trúc: chèn/xoá/đổi chỗ cột, dòng; đổi tên header/tier; ô công thức (3 fixture: exceljs không `result`, `<f>…</f><v></v>` vá tay, công thức có cache); ô chữ-số; đổi currency; ⟲ **manifest bị sửa** (sort riêng cột `tier_id`; đổi một `territory_code`; thêm dòng tier không có trong DB) ⇒ 422/409, liệt kê **mọi** địa chỉ, 0 lần ghi | reader + planner |
| T7 | `plan_hash` lệch ⇒ 409; ⟲ gửi file B theo **đúng FormData cũ** (không `intent`) ⇒ 409 `PREVIEW_REQUIRED`, hàm ghi 0 lần | route |
| T8 | parity A (§6.2) | route + parser |
| T9 | REPLACE chen giữa preview và commit ⇒ 409 `TEMPLATE_CHANGED`, template của người kia còn nguyên, **`price_tiers` không bị chạm**, không có dòng `import_batches` FAILED | queries + function |
| **T10** ⟲ | **đứt giữa chừng**: tiêm lỗi ở lô entry thứ 2 trong function ⇒ template cũ còn **nguyên vẹn và đọc được** | function (SQL verify) |
| **T11** ⟲ | **wiring hai màn** (KB §21.2 F1 / P26): render `DefaultMatrixView` và `PerAppMatrixView` thật, chọn file B, khẳng định request 1 mang `intent=preview` + đúng trường scope (`account_id` / `app_id`), modal hiện, commit mang `plan_hash`; bỏ nhánh B khỏi một màn ⇒ chỉ test màn đó đỏ | component |
| T12 | commit hai lần (mất response) ⇒ lần 2 trả "đã ghi ở lần trước", không phải TEMPLATE_CHANGED | route |

Fixture Excel/Numbers: **commit file do app thật lưu ra**, không viết tay (P27 —
"fixture viết tay là một lời khẳng định về route, không phải bằng chứng"), buộc vào
`version` của manifest như golden file.

### 6.4 Mutation đề xuất (mỗi cái phải ĐỎ)

| Mutation | Test phải đỏ |
|---|---|
| Thêm so sánh với giá Apple (hoặc Default) để đoán "thừa hưởng" | **ca e** (Apple đổi giá giữa chừng + khẳng định import **không gọi Apple lần nào**) |
| Coi `·` là override ở giá Default/Apple | **T1** |
| Dựng lại MỌI ô số thành dòng mới (bỏ nhánh "giữ dòng DB") | ⟲ **T1b** (proceeds các dòng khác thành NULL) — T1 không bắt được vì T1 không ghi |
| Bỏ short-circuit "diff rỗng không ghi" | **T1** (hàm ghi bị gọi) |
| Coi nước ngoài phạm vi là "không entry" (REPLACE thuần) | **T1 – biến thể export đã lọc** |
| Ghi theo thứ tự đọc có ORDER BY thay vì `template_market_order` | ⟲ **T1b** (thứ tự cột đổi) |
| Bỏ kiểm scope / lấy scope đích từ manifest thay vì request | **T4** |
| Bỏ kiểm `template_id` | **ca f** (khẳng định mã `TEMPLATE_CHANGED`) |
| Bỏ kiểm digest | **T5** (cả hai biến thể) |
| Bỏ đối chiếu danh tính với server (bước 4) | ⟲ **T6 – manifest bị sửa** |
| So `===` thay vì `canon`; quy tắc thập phân cũ `> 1e-6` | **T3** |
| Đọc chỉ `cellFormula: true` (bỏ `sheetStubs`) / kiểm `.v` trước `.f` | ⟲ **T6 – công thức không cache** |
| Đổi nghĩa ô trống (theo cái Manager chốt ở ca d) | **ca d** |
| Hàm ghi xoá theo scope thay vì theo `expectedTemplateId` | **T9** |
| Bỏ transaction (ghi tuần tự ngoài function) | ⟲ **T10** |
| Preview trả 200 cho request dạng cũ | ⟲ **T7** |
| Cho nhánh B chạy khi `SheetNames[0] === "price_tiers"` | **T8** |
| Bỏ nhánh B khỏi một màn matrix | ⟲ **T11** (chỉ màn đó) |

Áp mutation bằng `scripts/mutate.sh apply/restore` — không `git checkout` (CLAUDE.md).

---

## P7 — CÂU CẦN MANAGER CHỐT

> **Q1 — Cơ chế nhận biết ô đã sửa.** Đề xuất **M3** (giá trị ô là trạng thái +
> `template_id` là điều kiện cần + digest là điều kiện đủ; ảnh chụp là DB). *Lý do:*
> `·` đã mang trạng thái và sống qua Excel/Numbers; DB đáng tin hơn sheet ẩn; không
> bao giờ đọc giá Apple ⇒ ca e đúng do cấu trúc. Phương án khác: M2 (ảnh chụp từng ô
> trong file).

> **Q2 — Ca d: ô Manager XOÁ TRỐNG nghĩa là gì?** Đề xuất **= bỏ override (thừa
> hưởng)**, giống Q-I của A, và preview hiện từng ô như vậy. Khác: (ii) từ chối ô
> trống — bắt nhập `·`; (iii) coi như không đổi. *Lý do đề xuất:* xoá ô là cách tự
> nhiên nhất để nói "bỏ giá này"; preview chặn được xoá nhầm.

> **Q3 — Ca f: template bị người khác thay giữa export và import.** Đề xuất **dừng,
> 409, không ghi gì, nói ai/lúc nào, bảo export lại**. Không gộp 3 chiều ở v1.

> **Q4 — Ca g: file không có sheet thông tin.** Đề xuất **từ chối rõ ràng, không lùi
> về M1**. *Lý do:* "không biết thì không ghi" (KB P7, §32.10).

> **Q5 — Khoá scope.** Đề xuất: scope đích **luôn từ màn đang đứng**, file chỉ để
> đối chiếu; lệch ⇒ 409. **Kèm:** màn Default matrix hiện tên account (vá R4). Import
> Default B chỉ cho **admin** (giống A) — xác nhận: member export được nhưng nút
> import Default ẩn với member (route vẫn trả 403).

> **Q6 — Nhận diện format.** Đề xuất **tự động theo tên sheet** (§5.3); preview nói
> ra format đã nhận. Khác: Manager chọn tay.

> **Q7 — File export đã LỌC.** Đề xuất **cho import, giữ nguyên mọi nước không có
> trong file**, preview liệt kê số nước được giữ. Khác: từ chối mọi file đã lọc.

> **Q8 — Sheet thông tin.** (i) Đề xuất `hidden`, tên `_import_info`, đặt sau sheet
> chính (Excel giấu; Numbers làm hiện ra nhưng giữ nội dung — và mọi giá trị trong
> nó đều được đối chiếu với server). Khác: visible kèm cảnh báo "đừng sửa". (ii) Chấp
> nhận export **thêm một sheet** (sheet chính không đổi — §21.1 giữ cho nội dung màn)?
> (iii) Có ký HMAC sheet đó bằng secret server không? Đề xuất **không** ở v1: digest
> đã bao gồm hai bảng danh tính, và mọi khoá còn lại đều so với server.

> **Q9 — Proceeds.** Đề xuất: ô không đổi **giữ proceeds cũ**; ô sửa ⇒ `proceeds =
> NULL`. Khác: đưa proceeds vào file (phải trả lời "Manager sửa proceeds thì sao").

> **Q10 — Sửa cấu trúc ở v1.** Đề xuất **chỉ sửa giá trị ô**; thêm/xoá/đổi chỗ dòng,
> cột ⇒ từ chối. Hệ quả cần chấp nhận: thêm tier/nước chưa có entry = tự dựng tay một
> file A đầy đủ (§4.8). Khác: export thêm dòng cho mọi tier trong `price_tiers` (file
> khác màn).

> **Q11 — Ô chữ trông như số** (Excel `en_VN` khi nhập `2.49`; **mọi** ô `·` sau khi
> file qua Numbers). (i) **Từ chối mọi ô chữ** + liệt kê địa chỉ — an toàn nhất, nhưng
> luồng "Numbers rồi Excel" không thêm được override mới. (ii) ⭐ Đề xuất: **chỉ nhận
> chuỗi không mơ hồ** — `^\d+$` hoặc `^\d+\.\d{1,2}$`; từ chối mọi chuỗi có dấu phẩy và
> mọi chuỗi đúng **3** chữ số sau dấu chấm (`49.000` có thể là 49 nghìn theo kiểu
> Việt Nam); preview ghi rõ "ô này là chữ, đã hiểu thành số X".

> **Q12 — Chỗ đặt nút import.** ⟲ Đề xuất: **nút "Nhập file đã sửa" cạnh "Export
> XLSX" trên Matrix view** (Default + Per-App — hai màn dùng chung thanh lọc). *Lý do:*
> export và import thành một cặp ở một chỗ; đích ghi = đúng scope màn đang hiện; **3
> nút upload format A không đổi một dòng** (parity tuyệt đối, không đụng các confirm
> "thay toàn bộ"); bề mặt twin còn 2 thay vì 3. Khác: tái dùng nút Replace/Upload ở cả
> 3 surface (phải sửa cả ba confirm + mockup).

> **Q13 — Ngưỡng cờ đỏ độ lớn** (§4.7). Đề xuất 10× / 0.1× cho ô đổi giá; gãy thang
> giá theo tier hoặc lệch > 10× so với Default cho override mới.

> **Q14 — App bảng tính Manager dùng thật?** Excel / Numbers / Google Sheets. Nếu là
> Google Sheets ⇒ cần **một vòng UAT đo thật** trước khi code reader (§2.3 toàn
> CHƯA BIẾT).

> **Q15 — Ghi nguyên tử** ⟲ (BLOCKER của vòng phản biện). (W1) ⭐ **Một function
> Postgres cho CẢ A lẫn B** — một hàm ghi (P1), A được nguyên tử miễn phí (khác hôm
> nay đúng ở chỗ lỗi giữa chừng thì rollback). (W2) Function chỉ cho B, A giữ ghi tuần
> tự — **hai hàm ghi**, trái P1. (W3) Không function — **không chấp nhận được**: B mất
> dữ liệu vĩnh viễn khi đứt. Cả W1, W2 đều cần 1 migration (Path G, chặn push).

> **Q16 — Stale-tab cho format A.** Một commit B có thể bị một upload A từ tab cũ ghi
> đè thầm lặng (R5 vẫn đúng với A). Ba surface A đều có sẵn id header lúc tải trang.
> Gửi kèm `expectedTemplateId` cho A luôn (409 → tải lại trang) trong arc này, hay để
> backlog? Đề xuất: **backlog** (đổi hành vi A, ngoài brief) — nhưng ghi rõ giới hạn.

> **Q17 — Route legacy `POST /api/iap-management/pricing-tiers`.** Không UI nào gọi,
> nhưng gọi được (admin) và một lần gọi xoá entry của **mọi** template mọi account
> (Phụ lục B). Thiết kế B chịu được nó (digest), nhưng nó vẫn là quả mìn. Tắt route
> trong arc này hay arc riêng? Đề xuất: **arc riêng, ưu tiên cao**.

---

## Phụ lục A — SQL Manager chạy (chỉ đọc) để thay CHƯA BIẾT bằng số

```sql
-- A1. Proceeds còn trên bao nhiêu entry (quyết định Q9 có quan trọng không)
SELECT t.scope_type, t.scope_account_id, t.scope_app_id,
       count(*) AS n, count(*) FILTER (WHERE e.proceeds IS NULL) AS null_proceeds
FROM iap_mgmt.price_tier_templates t
JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
GROUP BY 1,2,3;

-- A2. Có nước nào mang 2 currency trong cùng một template không
--     (≥ 1 dòng ⇒ override mới ở nước đó sẽ bị 422 theo quy tắc bước 7)
SELECT template_id, territory_code, count(DISTINCT currency_code)
FROM iap_mgmt.price_tier_template_entries
GROUP BY 1,2 HAVING count(DISTINCT currency_code) > 1;

-- A3. Số chữ số thập phân THỰC (cột NUMERIC(18,4) luôn có scale 4, nên đếm
--     chữ số sau khi bỏ số 0 ở đuôi — chạy được mọi phiên bản Postgres)
SELECT currency_code,
       max(length(rtrim(split_part(customer_price::text, '.', 2), '0'))) AS real_decimals,
       count(*) FILTER (WHERE customer_price <> trunc(customer_price)
                          AND customer_price >= 1e6) AS fractional_ge_1e6
FROM iap_mgmt.price_tier_template_entries GROUP BY 1 ORDER BY 2 DESC;

-- A4. NUMERIC(18,4) có hút nhiễu float không (§4.2)
SELECT 1.9900000000000002::numeric(18,4), 1.98999::numeric(18,4);

-- A5. Phiên bản Postgres (cho function ở §5.4)
SELECT version();
```

Và một phép đo Node một dòng (PostgREST trả NUMERIC dạng gì):
`typeof (await iapDb().from('price_tier_template_entries').select('customer_price').limit(1)).data[0].customer_price`

## Phụ lục B — Lỗi CÓ SẴN lộ ra trong census (ngoài phạm vi; đề xuất backlog)

| Tag đề xuất | Vấn đề | Nhãn · bằng chứng |
|---|---|---|
| `[PRICETIERS-legacy-delete-all]` ⚠ | `replacePriceTiers` xoá **mọi** dòng `price_tiers` ⇒ FK `ON DELETE CASCADE` xoá entry của **mọi** template mọi account (dưới **cùng** template id), và `iaps.tier_id` → NULL. Route `POST /api/iap-management/pricing-tiers` vẫn gọi được (admin), không UI nào dùng. (P7-Q17) | ĐỌC CODE `queries/price-tiers.ts:334-337` · CÓ TRONG SCHEMA `20260519000000:55`, `20260515010000:55-58` |
| `[TEMPLATE-parse-dimension-hang]` ⚠ | file 17 KB với `<dimension ref="A1:XFD1048576">` làm parser A chạy > 60 s **trong route Node** (chặn event loop service `web`); member nào cũng gửi được qua scope APP | ĐÃ ĐO |
| `[TEMPLATE-parse-comma]` | `readNumericCell` xoá mọi dấu phẩy: chữ `"1,99"` → 199, `"49.000"` → 49; nhận số âm | ĐÃ ĐO |
| `[TEMPLATE-matrix-unordered-paging]` | `fetchAllEntries` và `getTemplateOverview` phân trang không ORDER BY. ⟲ **RÀNG BUỘC KHI SỬA:** thứ tự heap này **chính là** thứ tự cột Hotfix 24 (`template-matrix.ts:145-153`) — **cấm** sửa bằng `ORDER BY tier_id, territory_code` (đảo cột thành alphabet). Phải phân trang bằng một khoá ổn định không quyết định thứ tự hiển thị, hoặc lưu thứ tự cột tường minh (như `sort_order` bên Google, KB §25.7). ⚠ **Sửa xong việc này KHÔNG làm digest của import B thừa** — digest còn bắt entry bị xoá dưới cùng id | ĐỌC CODE `template-matrix.ts:224-229`; `templates.ts:510-514` |
| `[TEMPLATE-replace-atomic]` | `replaceTemplate` xoá-rồi-chèn không transaction (Q15 xử lý); upload trùng (tier/nước) và giá ≥ 15 chữ số nguyên qua được parser nhưng bị Postgres từ chối **sau khi** template cũ đã bị xoá; upload **0 entry** được chấp nhận, để lại header rỗng | ĐỌC CODE `templates.ts:567-573` · CÓ TRONG SCHEMA `20260519000000:58`, `:62` · ĐÃ ĐO (parser) |
| `[TEMPLATE-matrix-account-label]` | màn Default matrix không nói account; diff Per-App so với Default của account TopNav chứ không phải account sở hữu app | ĐỌC CODE |
| `[USERDOCS-perapp-fallback]` | user docs nói Per-App "fallback Default" (`index.html:4246`, `:4344`), code nói Apple; lý do của khoá Q-D ("overrides cascade narrowest-first", KB:182) đọc như fallback từng ô — nên viết lại là "theo nguồn, không theo ô" | ĐỌC CODE |
| (P2) | `actions_log` / `import_batches` update trong `replaceTemplate` không kiểm `error` | ĐỌC CODE `templates.ts:685-703`, `:713-726` |
| `[EXCEL-fence-dynamic-import]` | fence Excel không thấy `await import("xlsx")`; `PARSERS` chỉ có parser Google — 2 parser Apple nằm ngoài luật "parser chỉ dùng xlsx" | ĐÃ ĐO |
| `[TEMPLATE-numbers-summary-sheet]` | file A xuất qua Numbers có `Export Summary` đứng đầu ⇒ parser A từ chối | ĐÃ ĐO |
| — | route upload APP tự đăng ký app (ghi DB) **trước** khi parse; file hỏng (422) vẫn để lại app đã đăng ký | ĐÃ ĐO |
| — | `TODO.md:213-214` / KB §21.8 nói gap proceeds "cần một đường đọc mới" — **quá tay**: DB đã đọc proceeds, chỉ composer vứt (`template-matrix.ts:227` vs `:119-122`). Với M3 thì gap này **biến mất** (ô không đổi giữ dòng DB) | ĐÃ ĐO |
| — | KB đánh số P34, P35 **hai lần** với hai nghĩa (:3819/:6668, :3878/:6687) — trích phải kèm số mục | ĐỌC CODE |

---

## CHECKPOINT

- [x] P1 census hai format, dump từ route thật
- [x] P2 câu chặn cửa: **B thưa** (dấu `·` ở giá trị ô, bền qua Excel + Numbers);
      nhưng 9 đường hỏng im lặng R1–R9 nếu import ngây thơ — R7 là BLOCKER
- [x] P3–P6 cơ chế M3, ca a–g, chỗ dễ sai, phương án, preview, test, mutation
- [x] Vòng phản biện 4 góc: 1 BLOCKER + 18 MAJOR đã xử lý (⟲)
- [ ] **Manager chốt P7 (Q1–Q17)** + chạy Phụ lục A
- [ ] Sau khi chốt: arc code — **1 migration (function), Path G: chặn push tới khi
      Manager chạy SQL + verify** — cắt nhánh mới ở ranh giới arc
