# Step mới: chọn localization nào xử lý — census + thiết kế

**Arc:** `[BULKIMPORT-loc-step]` · **Ngày:** 2026-09-23 · **Trạng thái:** census + thiết kế **ĐÃ DUYỆT**, 6 câu **ĐÃ CHỐT**; chờ Manager duyệt cách trình bày M-1 · **CHƯA CODE**

> ### ✅ Manager chốt (2026-09-23)
>
> | | Chốt | Ghi chú |
> |---|---|---|
> | **Q1** | **CẶP** — tick theo locale | Parser bắt buộc cặp (`:301-306` throw nếu lệch), và "sửa tên giữ mô tả cũ" **không** phải nhu cầu thật. ⚠ M-1 là yêu cầu **NHÌN THẤY** cái gì đổi, **không** phải để tick riêng. Nếu sau này cần tách: Apple **cho** (`V2UpdateRequest` cả hai `nullable`) nhưng **parser phải đổi trước**. |
> | **Q2** | **Cột + untick lẻ (tri-state)** | ⚠ **KHÔNG port luật Apple "không bao giờ xoá"** từ arc picker. Ở đây mặc định có tick sẵn ⇒ việc thật là **TRỪ ĐI**, giống ca Google. **Header FULL ⇒ clear cả cột.** |
> | **Q3** | **CÓ** — hiện state + so Apple, 0 request | ⭐ **VÀ: ô giống hệt Apple ⇒ MẶC ĐỊNH UNTICK.** Đây mới là thứ giải đúng ca Manager, quan trọng hơn cả checkbox. Ô ACTIVE hiện rõ "sửa sẽ tạo version mới + duyệt lại". |
> | **Q4** | **Ô (item × locale)** | Mẫu số từ **số ô THẬT** — `items[i].localizations` chỉ chứa cặp có **cả hai** ô non-empty (`iap-items.ts:389`), nên **không** phải `rows × pairs`. |
> | **Q5** | **Vẫn hiện, mờ** | |
> | **Q6** | **CÓ** — probe `included[]` trước khi code | Xem §Probe Q6 cuối file. |
>
> ### Manager chỉnh mockup
> - **M-1** — tách rõ **Display Name** vs **Description** trong phần hiển thị thay đổi. ⏳ *còn chờ chọn cách trình bày, xem §M-1.*
> - **M-2** — nhãn step 3: `"Preview"` → **`"Preview itemID & Price"`**. ✅ *chỉ đổi nhãn.*

## Vấn đề

File template chứa **sẵn mọi thứ** — price lẫn localization (giống hệt cái đang có trên ASC). Nhưng nhu cầu thật thường chỉ là sửa **một phần**.

Ca thật 2026-09-22: Manager chỉ muốn update **price**. Tool xử lý cả localization ⇒ 20 item dính `409 "Cannot edit InAppPurchaseLocalization when it is in ACTIVE state"` — **và lẽ ra chúng không cần đụng tới localization chút nào.**

⇒ Màn preview hiện tại không phân biệt được khi nào cần gọi API localization, khi nào bỏ qua.

---

## P1 — CENSUS

### P1.1 Stepper: mọi chỗ phải sửa

⚠ **Line number trong brief đã cũ** (brief ghi `type Step (:101)`, `handleNext (:364)`, `Back (:679)`). Số thật sau khi arc W1 ship:

| # | Vị trí thật | Nội dung | Phải sửa gì |
|---|---|---|---|
| 1 | `BulkImportWizard.tsx:114` | `type Step = 1 \| 2 \| 3 \| 4 \| 5;` | → thêm `6` |
| 2 | `:226` | `useState<Step>(1)` | không đổi |
| 3 | `:364` `handleNext()` | `if (step === 1)` hub-tracking start | không đổi (vẫn là 1→2) |
| 4 | `:393` | `setStep((s) => ((s + 1) as Step))` | không đổi |
| 5 | `:528` | `setStep(5)` — nhảy tới Result sau execute | → `setStep(6)` |
| 6 | `:619` | `<Stepper step={step} />` | không đổi |
| 7 | `:689` | `{step === 4 && (` — Territories | → `step === 5` |
| 8 | `:741` | `{step === 5 && result && (` — Result | → `step === 6` |
| 9 | `:755` | nút Back `setStep(s > 1 ? s-1 : s)` | không đổi |
| 10 | `:756` | `disabled={step === 1 \|\| step === 5 \|\| executing}` | → `step === 6` |
| 11 | `:763` | `{step < 4 && (` — nút Next | → `step < 5` |
| 12 | `:781` | `{step === 4 && (` — nút Execute | → `step === 5` |
| 13 | `:905` | `labels = ["Excel","Screenshots","Preview","Territories","Result"]` | **M-2** → `["Excel","Screenshots","Preview itemID & Price","Localization","Territories","Result"]` |
| 14 | `:930` | `{n < 4 && (` — đường nối giữa các bước | → `n < 5` |

⚠ **`:930` là chỗ dễ sót nhất.** Nó không phải so sánh `step`, nó so `n` (chỉ số nhãn) để quyết định vẽ gạch nối — với 5 nhãn thì `n < 4` đã SAI SẴN (nhãn thứ 5 "Result" không có gạch trước nó nhưng nhãn thứ 4 thì có… thực ra `n<4` nghĩa là chỉ vẽ 3 gạch cho 5 nhãn ⇒ **thiếu 1 gạch từ trước arc này**). Sửa thành `n < labels.length` thì đúng cho cả hôm nay lẫn mai.

### P1.1b Test phụ thuộc số bước

⚠ **Không test nào hard-code `step === N`.** Chúng lái wizard bằng cách **bấm Next N lần** rồi đợi `territory-picker-footer`. Thêm một bước ⇒ mọi helper phải bấm thêm một lần:

| File | Vị trí | Hiện tại |
|---|---|---|
| `execute-fault.test.tsx` | `:164` | `for (let i = 0; i < 3; i++)` → **4** |
| `BulkImportWizard.territories.test.tsx` | `:152` | `for (let i = 0; i < 3; i++)` → **4** |
| `BulkImportWizard.test.tsx` | `:213`, `:216` (`goToStep3`) | 2 lần click → **3** |

### P1.2 Parser đọc cột localization

`lib/iap-management/parsers/iap-items.ts:79`:

```ts
const LOCALE_HEADER_RE = /^(Display Name|Description) \((.+)\)$/;
```

Cặp được dựng ở `:312`:

```ts
pairs.push({ display_col: col, description_col: col + 1, locale: code, locale_name: localeName });
```

⚠ **Display Name PHẢI đứng ngay trước Description cùng locale** — `:301-306` throw nếu không. Cặp là **đơn vị**, không tách rời ở tầng parse.

Kết quả: `ParsedIapItem.localizations: ParsedIapLocalization[]` — `{locale, locale_name, display_name, description}`.

⚠ **`items[i].localizations` chỉ chứa cặp mà CẢ HAI ô non-empty** (`:389` *"Both empty → skip silently"*; một ô trống ⇒ warn + skip). Nên **số locale của một item ≤ `locale_pair_count` của header**. Quan trọng cho D5.

### P1.2b Tiền lệ "parse nhưng KHÔNG dùng"

`template-spec.ts:166-167` nói thẳng: GT Price / GT Currency *"are currently NOT applied for Apple (parsed into `base_price`/`base_currency`, **consumed nowhere downstream**)"*. Grep xác nhận: ngoài parser + type, không nơi nào đọc chúng.

⚠ **Khuôn này KHÔNG nên tái dùng cho localization.** Nó là bỏ qua **im lặng** — người dùng không thấy gì. Đó đúng là lớp lỗi arc này sinh ra để diệt: 20 dòng hỏng vì tool làm một việc mà Manager không biết nó sẽ làm. Bỏ qua phải **hiển thị được và chọn được**.

### P1.3 Preview hiện tại hiển thị localization thế nào

**Một con số duy nhất.** `BulkImportWizard.tsx:1438` cột `Loc`, `:1446` `localesFilled = d.source.localizations.length`, render ở `:1502`.

⇒ Manager thấy "1" và không biết **nội dung** là gì, **có khác Apple không**, hay **có sửa được không**. Đây là nguyên nhân UI của sự cố.

Ngoài ra `:1395-1397` hiện `Unrecognised locale columns skipped: …` từ `parsed.skipped_locales`.

### P1.4 Đường preview → execute, và khuôn override

⭐ **Khuôn `tier_overrides` là tiền lệ đúng, và nó đã chạy:**

```
TierCell (UI chọn)
  → tierOverrides state
  → config.tier_overrides (route.ts:364)
  → áp ở route.ts:464-476, THẮNG giá trị auto
```

Localization dùng **đúng khuôn này** được: UI chọn → field trong `config` → route áp.

### P1.5 Route nhận gì

`route.ts:361-375` — `config` là **JSON thô**, `JSON.parse`, **không có zod**. Chỉ một fallback: `default_mode` không hợp lệ → `"OVERWRITE"`.

⚠⚠ **Và đây là điều quan trọng nhất của census:** `route.ts:391`

```ts
// ── Re-parse Excel server-side (don't trust the client) ──────────────────
parsed = await parseIapItemsXlsx(excel);
```

⇒ **Server tự parse lại file.** Client **không** gửi danh sách localization. Nên "danh sách locale được phép xử lý" phải là **một field trong `config`** — giống hệt `tier_overrides` và `availability_selection`.

Thêm field ⇒ đụng: kiểu inline ở `:361-375` + một chỗ áp. **Không đụng FormData, không đụng parser, không đụng migration.**

### P1.6 ⚠ Chặn IGNORE ở tầng nào

`item.localizations` được đọc ở **8 chỗ**: `route.ts:946 · 968 · 971 · 1241 · 1249` (CREATE) và `:1393 · 1477 · 1615` (OVERWRITE).

| Tầng | Đánh giá |
|---|---|
| **UI** | ⛔ **Yếu nhất** — client gửi gì server tin nấy. Và server **re-parse** file nên UI không kiểm soát được data. |
| **Parser** | ⛔ Sai chỗ — parser mô tả FILE, không mô tả Ý ĐỊNH. `skipped_locales` sẽ lẫn hai nghĩa. |
| **Planner** | ⛔ Chỉ phủ OVERWRITE (`planLocalizationSync`). CREATE path không đi qua nó. |
| **Route, MỘT choke point ngay sau parse** | ✅ **ĐÚNG** |

⭐ **Đề xuất: lọc `item.localizations` MỘT LẦN, ngay sau `parseIapItemsXlsx`, trước `resolveConflicts`.** Cả 8 chỗ đọc thấy danh sách đã lọc ⇒ **không phải sửa chỗ nào trong số 8**. Cùng hình dạng với `resolveBatchAvailabilitySelection` (`route.ts:565`) — config → resolve một lần → mọi thứ phía sau dùng kết quả.

⚠ Và nó là **trust boundary đúng**: server áp lựa chọn lên data server tự parse.

---

## P2 — CÂU THIẾT KẾ

### D1 — Đơn vị chọn: CẶP hay tách Name/Description?

| | Cặp (1 checkbox/locale) | Tách (2 checkbox) |
|---|---|---|
| Khớp parser | ✅ cặp là đơn vị (`:301-306` throw nếu lệch) | ❌ ngược thiết kế parser |
| Khớp Apple API | ⚠ `V2UpdateRequest` có **cả hai** nullable ⇒ gửi riêng ĐƯỢC | ✅ |
| Số checkbox với N=39 | 39 | 78 |

⭐ **Đề xuất: CẶP.** Không phải vì API không cho tách — API cho. Mà vì: (a) parser bắt buộc cặp, tách ở UI sẽ tạo một đơn vị không tồn tại ở tầng dưới; (b) "sửa tên mà giữ mô tả cũ" — **KHÔNG ĐỌC ĐƯỢC từ repo có phải nhu cầu thật không, cần Manager**; (c) nếu sau này cần, thêm tách vào trong một cặp đã chọn dễ hơn gộp hai checkbox lại.

### D2 — Độ mịn: cấp CỘT hay cấp Ô?

Manager nói "checkbox ở từng cột". Nhưng cấp cột áp cho **mọi dòng** — không diễn đạt được "sửa locale này cho 5 item, không cho 83 item còn lại".

| | Cấp cột | Cấp ô (item × locale) |
|---|---|---|
| Số widget (88 dòng × 3 locale) | 3 | **264** |
| Diễn đạt được ca hỗn hợp | ❌ | ✅ |

⭐ **Đề xuất: cột làm mặc định + cho untick lẻ từng ô** — đúng khuôn **header tri-state** vừa ship ở arc picker. Checkbox cột có 3 trạng thái: tick-all / untick-all / **dở dang** (khi có ô lẻ bị untick). Manager thường chỉ cần cấp cột; ai cần cấp ô thì vẫn có.

⚠ **Đánh đổi phải nói rõ:** tri-state cột là thứ đã có tiền lệ trong repo nhưng **chưa từng làm trên ma trận 2 chiều**. Chi phí cao hơn cột-thuần một chunk.

### D3 — ⭐⭐ HIỂN THỊ STATE: hoá ra MIỄN PHÍ

Đây là phát hiện lớn nhất của census.

**Câu hỏi:** hiện "localization này đang ACTIVE" và "giá trị trong file có khác Apple không" tốn bao nhiêu request?

**Trả lời: 0.**

`GET /v1/apps/{id}/inAppPurchasesV2` — endpoint mà `listAllInAppPurchases` (`client.ts:74-110`) **đã gọi sẵn** ở `page.tsx:54` và `route.ts:413` — chấp nhận:

```
include: ['inAppPurchaseLocalizations', 'content', 'appStoreReviewScreenshot', …]
fields[inAppPurchaseLocalizations]: ['name', 'locale', 'description', 'state', 'inAppPurchaseV2']
```

⇒ Thêm `&include=inAppPurchaseLocalizations` vào **chính lượt gọi đang chạy** là có đủ `name` + `description` + `state` của **mọi** localization của **mọi** item.

⭐ Và khuôn đã có sẵn: `listAllInAppPurchases` đã nhận `opts?: { includeAvailability?: boolean }` (`client.ts:77`) — thêm một cờ nữa là cùng hình dạng, không phát minh gì.

⚠ **Hai cảnh báo phải nêu:**

1. **Bẫy JSON:API (CLAUDE.md invariant).** Map localization → IAP phải đi từ phía **primary**: `iap.relationships.inAppPurchaseLocalizations.data` — đã verify schema **có `data`**. **KHÔNG** map ngược từ `included[]` (resource trong `included` chỉ có `links`). Tiền lệ đọc `included[]` đã có: `availabilities.ts:330-341`.
2. **Payload lớn hơn.** N item × M locale trong `included[]`. Với 88 item × 39 locale = ~3.400 resource. **KHÔNG ĐỌC ĐƯỢC từ repo** Apple có cap `included` không — **cần probe thật 1 lần**.

**Bản tối giản (nếu Manager không muốn rủi ro payload):** chỉ so **file vs file** — không hỏi Apple. Mất: không biết ô nào ACTIVE, không biết ô nào **không đổi**. ⇒ Mất luôn tính năng giá trị nhất: **ô không đổi thì mặc định untick** — chính là ca của Manager.

### D4 — Mặc định phải GIỐNG HỆT hôm nay

"Ignore all" **không tick** + mọi cột **tick** ⇒ `localizationSelection` phủ toàn bộ ⇒ bộ lọc ở P1.6 là **no-op** ⇒ `item.localizations` không đổi một phần tử nào.

⭐ **Đây là parity gate của arc**, và nó ghim được bằng test: cùng input, `resolveConflicts` + `planLocalizationSync` cho ra **kết quả y hệt** khi selection ở mặc định.

### D5 — Đơn vị đếm ở confirm dialog

Nhất quán với D1+D2 ⇒ đơn vị là **Ô = (item × locale)**.

⭐ **Đề xuất câu chữ hai tầng**, vì một con số không đủ:

```
Sẽ xử lý:      124 localization  (62 item × 2 locale)
Sẽ bỏ qua:      64 localization  (1 locale bị untick toàn bộ + 2 ô lẻ)
```

⚠ **Mẫu số phải là số ô THẬT**, không phải `88 × locale_pair_count` — vì `items[i].localizations` chỉ chứa cặp có cả hai ô non-empty (P1.2).

### D6 — Popover "detail"

| Đã có | Vị trí | Dùng được? |
|---|---|---|
| `ExpandableErrorCell` | `components/ui/shared/ExpandableErrorCell.tsx` | ⚠ **gần đúng** — có summary + nút "Detail"/"Close", cùng palette `#0071E3`. Nhưng **mở INLINE**, không nổi ra ngoài, và **không có click-outside**. |
| click-outside | `AccountSwitcher.tsx:42-46` · `CppList.tsx:488-492` · `GoogleAccountSwitcher.tsx:59-63` | ⚠ **BA bản sao inline**, không có hook chung |

⭐ **Đề xuất:** mở rộng `ExpandableErrorCell` thêm prop `variant="popover"` thay vì viết component thứ hai — nó đã có đúng ngữ nghĩa và đúng màu. ⚠ Và **rút click-outside thành một hook dùng chung** trong cùng chunk: đã có **3 bản sao**, viết bản thứ tư là đúng bẫy twin-path (CLAUDE.md P1).

### D7 — Scroll ngang N cặp locale

⭐ **`MatrixTable.tsx` là tiền lệ mạnh nhất** — nó đã giải đúng bài toán này cho N territory:

```
:22  sticky left-0 bg-white border-r-2 … w-[180px] min-w-[180px] max-w-[180px]   ← cột trái ghim
:60  overflow-auto, maxHeight: min(72vh, 720px)
:61  border-separate border-spacing-0 w-max min-w-full
:66  sticky top-0 z-30  (góc)      :75  sticky top-0 z-20  (header)
```

⇒ Tái dùng **khuôn** (sticky cột Product ID + sticky header + `w-max`). ⚠ Không tái dùng **component** — `MatrixTable` nhận `MatrixData` (tier × territory), hình dạng khác.

`IapLocalizationSection.tsx:144` cũng có `overflow-x-auto` + `DataTable` nhưng không sticky — yếu hơn cho N cột.

### D8 — "Ignore all" tick thì có SKIP step không?

| | Skip | Vẫn hiện (mờ) |
|---|---|---|
| Số click | ít hơn 1 | +1 |
| Manager thấy mình đã chọn gì | ❌ | ✅ |

⭐ **Đề xuất: VẪN HIỆN, mờ đi.** Lý do là dữ kiện của chính sự cố này: **hậu quả của việc bỏ qua một bước là không nhìn thấy nó.** Manager tick "Ignore all" ở lần chạy trước, ba ngày sau chạy lại — nếu step tự biến mất thì không có gì nhắc rằng localization đang bị bỏ qua. Một step mờ **có đếm** ("64 localization sẽ bỏ qua") là lời nhắc rẻ nhất.

⚠ Và Manager mô tả "tick ⇒ **disable (hiển thị mờ)** toàn bộ thông tin localization" — tức là **đã** chọn "vẫn hiện, mờ đi". Mục này chỉ xác nhận lại, không phải câu mở.

---

## P3 — KHẢ THI + CHI PHÍ

| Hạng mục | Số lượng |
|---|---|
| File code đổi | **5** — `BulkImportWizard.tsx` (stepper + step mới) · `execute/route.ts` (config field + choke point lọc) · `client.ts` (cờ include) · `ExpandableErrorCell.tsx` (variant popover) · hook click-outside (mới) |
| File test đổi | **3** helper đếm click Next (`execute-fault` `:164` · `territories` `:152` · `BulkImportWizard` `:213,216`) |
| Test mới | selection model · lọc ở choke point · parity gate D4 · tri-state cột |
| **Migration** | **KHÔNG** |
| Request Apple thêm | **0** (D3 dùng lượt gọi đang chạy) |

### ⚠ PARITY GATE — flow price KHÔNG được đổi hành vi

Ba cách chứng minh, dùng cả ba:

1. **Test hiện có PASS không sửa assertion** — chỉ sửa **cách lái** (bấm Next thêm 1 lần). Mọi assertion về price/tier/territory giữ nguyên **nguyên văn**. Sửa assertion nào = khai đích danh.
2. **Diff rỗng trên file thuộc đường price** — `conflict-resolution.ts` · `tier-order.ts` · `price-tiers.ts` · `pricing-orchestration.ts` · `overwrite-pricing-decision.ts`. Kiểm bằng `md5` trước/sau.
3. **Test parity D4** — selection ở mặc định ⇒ `item.localizations` **y hệt** input.

### Rủi ro hồi quy

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Sót một `step === N` | ⚠ **cao nhất** — 8 chỗ, `:930` dùng `n` không phải `step` | bảng P1.1 + test đi hết 6 bước |
| `included[]` quá lớn (D3) | trung bình | probe 1 lần trước khi code |
| Bản sao click-outside thứ 4 | thấp | rút hook chung trong cùng chunk |

---

## P4 — MOCKUP

`docs/iap-management/design/bulk-import-localization-step-mockup.html`

Dữ liệu thật: `com.vng.nikki.*` · "Item box ingame" · Vietnamese · `"188 Vàng"` (giá trị Apple hiện tại, từ ảnh ASC của Manager) vs `"188 Vàng."` (giá trị trong file).

⚠ Mockup vẽ **3 cặp locale** để thấy vấn đề scroll ngang, dù file mẫu chỉ có 1 (Vietnamese). Hai locale kia đánh dấu rõ là **minh hoạ**.

---

## P5 — CÂU CẦN MANAGER CHỐT

### ❓ Q1 (D1) — Checkbox cho cả CẶP, hay tách Name/Description?
**(a) Cặp** *(đề xuất)* · (b) tách đôi
⚠ Apple **cho** gửi riêng. Câu hỏi là nghiệp vụ: **"sửa Display Name mà giữ nguyên Description cũ" có phải nhu cầu thật không?** Repo không trả lời được.

### ❓ Q2 (D2) — Cấp cột, hay cột + untick lẻ từng ô?
**(a) Cột + untick lẻ (tri-state header)** *(đề xuất)* · (b) chỉ cấp cột
⚠ (b) rẻ hơn một chunk nhưng **không diễn đạt được** "sửa locale này cho vài item". Nếu ca đó chưa bao giờ xảy ra thì (b) đủ.

### ❓ Q3 (D3) — Có hiện state + so sánh với Apple không?
**(a) CÓ, dùng `include=inAppPurchaseLocalizations`** *(đề xuất — 0 request thêm)* · (b) bản tối giản, chỉ so file
⚠ (a) mở khoá thứ giá trị nhất: **ô không đổi mặc định untick** — đúng ca của Manager. Rủi ro duy nhất là payload `included[]`, đóng bằng **1 probe**.

### ❓ Q4 (D5) — Đơn vị đếm?
**(a) Ô = item × locale, kèm ngoặc giải thích** *(đề xuất)* · (b) số locale · (c) số item

### ❓ Q5 (D8) — "Ignore all" thì skip step?
**(a) Vẫn hiện, mờ đi** *(đề xuất, và khớp mô tả gốc của Manager)* · (b) skip

### ❓ Q6 *(census sinh ra)* — Probe `included` trước khi code?
1 request `GET /v1/apps/{id}/inAppPurchasesV2?limit=200&include=inAppPurchaseLocalizations` trên app thật, đo kích thước + đếm `included[]`. **Không ghi gì.** Nếu Apple cap hoặc payload quá lớn thì Q3 phải là (b), và biết trước rẻ hơn biết sau.

---

## §M-1 — Tách Display Name vs Description: ba cách, một đánh đổi

Manager: *"nhìn vào KHÔNG BIẾT cái đổi là display name hay description."*

⚠ Đây là yêu cầu về **HIỂN THỊ**, không phải về độ mịn tick — Q1 đã chốt tick theo **cặp**.

| | Cách | Được | Mất |
|---|---|---|---|
| **(a)** ⭐ *đang vẽ* | Hai dòng có nhãn `Name` / `Desc`. Chỉ trường **thật sự đổi** được tô nền amber + mũi tên `→`; trường không đổi thu về một dòng mờ kèm `· không đổi` | Trả lời thẳng câu của Manager. Vẫn thấy trường kia **còn nguyên** — ngữ cảnh quan trọng khi quyết định có tick hay không | ⚠ Hàng cao gấp **~2,5×** (3 → 7-8 dòng). 88 item ⇒ cuộn dọc nhiều hơn hẳn |
| **(b)** | Chỉ hiện trường ĐỔI; trường không đổi ẩn vào popover `detail` | Gọn nhất, hàng thấp | Mất ngữ cảnh "cái kia vẫn nguyên". Ô "đổi cả hai" và ô "chỉ đổi Name" trông **giống nhau** cho tới khi bấm detail |
| **(c)** | Hai **cột con** `Name` / `Desc` dưới mỗi locale | Hàng thấp lại, so sánh theo cột dễ | ⚠ **Gấp đôi số cột** phải cuộn ngang — 3 locale ⇒ 6 cột, 39 locale ⇒ **78 cột**. Đi ngược đúng vấn đề D7 |

⭐ **Đề xuất (a).** Không phải vì nó gọn — nó là cách **tốn chiều cao nhất**. Mà vì ba lý do:
1. Nó trả lời đúng câu Manager hỏi, ngay trên bảng, **không cần bấm gì**.
2. Ô "đổi cả hai" và ô "chỉ đổi Name" **phải phân biệt được bằng mắt** — đó là cả nội dung của M-1, và (b) làm mất điều đó.
3. Với Q3 đã bật, **rất nhiều ô sẽ ở trạng thái "giống hệt Apple"** và thu về 2 dòng mờ. Chiều cao trung bình thật sẽ thấp hơn 2,5× khá nhiều — ⚠ nhưng **KHÔNG ĐỌC ĐƯỢC** tỉ lệ thật cho tới khi có dữ liệu của Manager.

⚠ **Chỉ (c) là không đảo ngược rẻ** (nó đổi hình dạng bảng). (a) ↔ (b) đổi qua lại chỉ là CSS + một điều kiện render.

---

## §Bug CÓ SẴN được sửa kèm — KHÔNG phải hệ quả của arc này

Census tìm ra **BA** chỗ prose/đếm bị lệch, **tất cả cùng một gốc**: SC7 chèn step `Territories` vào giữa mà không cập nhật những chỗ đếm bước.

| # | Vị trí | Sai gì |
|---|---|---|
| 1 | `BulkImportWizard.tsx:930` | `{n < 4 && …}` vẽ gạch nối, nhưng có **5** nhãn ⇒ chỉ vẽ **3** gạch, **thiếu 1** |
| 2 | `BulkImportWizard.tsx:1712` | `<h2>Step 4 — Result</h2>` — nhưng Result render ở `{step === 5 …}` (`:741`) ⇒ **lệch một** |
| 3 | `IAP-MANAGEMENT-KNOWLEDGE-BASE.md:1350` | `Excel → Screenshots → Preview → Result` — **thiếu hẳn Territories** |

⚠ **Arc này sửa cả ba** (`n < labels.length`, sửa tiêu đề, sửa KB) — nhưng **ghi rõ trong commit message và backlog rằng đây là bug CÓ SẴN được sửa kèm**, không phải hệ quả của arc. Nếu không, một lần `git blame` về sau sẽ đổ lỗi nhầm.

⭐ **Bài học dùng lại được:** *chèn một step vào giữa wizard thì thứ vỡ không phải logic — nó là mọi chỗ ĐẾM bước bằng hằng số.* Arc này **đang chèn một step nữa**, nên nó là ứng viên số một để lặp lại đúng lỗi đó. Bảng P1.1 tồn tại chính vì thế.

---

## §Probe Q6 — cách chạy cho Manager

**Mục tiêu:** trước khi code, biết `include=inAppPurchaseLocalizations` trả về bao nhiêu resource và payload lớn cỡ nào. **1 request, chỉ đọc, không ghi gì.**

⚠ Cần JWT ASC — repo ký server-side (`lib/asc-jwt.ts`), không lộ ra client, nên **KHÔNG ĐỌC ĐƯỢC cách lấy token từ repo cho một lệnh curl thủ công**. Hai đường:

**Đường A — qua chính tool** (thêm tạm route chỉ-đọc, chạy một lần, xoá). ⚠ Là code sản phẩm ⇒ **ngoài phạm vi lượt này**, cần Manager cho phép riêng.

**Đường B — Manager tự chạy với token ASC sẵn có** (⭐ khuyến nghị):

```
APP_ID=<apple numeric app id>
TOKEN=<ASC JWT>

curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.appstoreconnect.apple.com/v1/apps/$APP_ID/inAppPurchasesV2?limit=200&include=inAppPurchaseLocalizations" \
  -o /tmp/probe.json

wc -c /tmp/probe.json
jq '{iap: (.data|length), included: (.included|length), has_next: (.links.next != null)}' /tmp/probe.json
jq '[.included[].type] | group_by(.) | map({type: .[0], n: length})' /tmp/probe.json
jq '.included[0].attributes | keys' /tmp/probe.json
```

> **KỲ VỌNG — cách đọc:**
> - `included` ≈ `iap × số locale/item`, và `.included[0].attributes | keys` **có `"state"`** ⇒ **Q3 chạy được, 0 request thêm.** Code tiếp bình thường.
> - `included` **nhỏ hơn nhiều** so với kỳ vọng, hoặc `has_next: true` xuất hiện sớm ⇒ ⚠ **Apple đang cap `included`.** Khi đó Q3 phải lùi về bản tối giản (chỉ so file vs file) — và **ô giống Apple sẽ KHÔNG tự untick được**, tức mất đúng thứ Q3 sinh ra để có.
> - `keys` **thiếu `state`** ⇒ thêm `&fields[inAppPurchaseLocalizations]=name,locale,description,state` rồi chạy lại.
> - `wc -c` — con số để quyết có cần `fields[...]` thu hẹp không.

⚠ **Chạy trên app THẬT có nhiều locale**, đừng chạy trên app test 1 locale — app test sẽ cho kết quả "ổn" cho một tình huống không tồn tại.

---

## KHÔNG ĐỌC ĐƯỢC TỪ REPO

| Câu | Cần gì |
|---|---|
| "Sửa tên mà giữ mô tả" có phải nhu cầu thật? | **Manager** (Q1) |
| Apple có cap `included[]` không? | **Probe 1 request** (Q6) |
| Nội dung ô thật của 10 dòng trong file NIKKI | Chỉ có: `com.vng.nikki.*`, "Item box ingame", Vietnamese, `"188 Vàng"`. Mockup dùng đúng chừng đó, phần còn lại đánh dấu minh hoạ. |
