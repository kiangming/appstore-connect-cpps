# Google IAP Management — Backlog

Mỗi mục có **tag**, **vì sao chưa làm**, và **đường đúng khi làm**. Tag dùng để
grep; đừng đổi tên tag đã phát ra ngoài.

---

## `[GOOGLE-micros-truncation]`

**Trạng thái:** ghi nhận, chưa sửa. Census Q7 = **0 dòng** trên production.

Giá hiển thị mất chữ số ở hai chỗ, cả hai đều ở phía **màn**, không phải phía
file export:

| Chỗ | Trích |
|---|---|
| Màn cắt cụt im lặng | [`google/price-conversion.ts:122-124`](../../lib/google-iap-management/google/price-conversion.ts) — `displayDecimals === 0` → `return whole.toString()`, bỏ luôn `remainder` |
| Parser không kiểm precision | [`parsers/pricing-template-parser.ts:164`](../../lib/google-iap-management/parsers/pricing-template-parser.ts) — gọi `decimalToMicros(decimal)` **không truyền currency**, nên bỏ qua kiểm tra ở `price-conversion.ts:64-79`. Một ô `25000.5` ở cột VND **vào được DB** |

⚠⚠ **ĐỪNG SỬA BẰNG CÁCH CHO WRITER GHI GIÁ TRỊ ĐẦY ĐỦ.** Đã đo (V4): ô mang
`25000.5` + `numFmt "0"` cho ra **`25001`** — file vừa khác màn vừa **làm tròn
LÊN**, và hỏng **không đều** (IDR `16000.4` → `16000` pass do làm tròn xuống,
VND `25000.5` → `25001` fail). Một lần soi tay vài ô sẽ thấy "ổn".

⇒ **Đường đúng bắt đầu từ MÀN**, không từ file. Nếu Manager muốn giữ phần dư
thì phải quyết màn hiện nó thế nào trước; file bám theo sau. Hôm nay file đang
làm đúng: nó khớp màn ở mọi ca đã đo, và số ô mất chữ số được **công bố** qua
header `X-Truncated-Cells` + banner, chứ không im lặng.

**Con trỏ:** ↔ `[GOOGLE-template-raw-micros-sheet]`

---

## `[GOOGLE-template-raw-micros-sheet]`

**Trạng thái:** đề xuất, chưa duyệt.

Nếu sau này cần file mang **giá trị đầy đủ** (không phải giá trị màn vẽ),
đường **đúng** là thêm **một sheet phụ** — ví dụ `raw_micros` — chứa
`price_micros` nguyên bản, và **giữ sheet chính đúng là ảnh chụp của màn**.

⚠ Đường **sai** là đổi ô của sheet chính: xem `[GOOGLE-micros-truncation]`.
Hai đường này trông giống nhau ("cho file mang số đầy đủ") nhưng một cái giữ
được nguyên tắc sản phẩm còn cái kia phá nó.

**Con trỏ:** ↔ `[GOOGLE-micros-truncation]`

---

## `[GOOGLE-template-xlsx-reimport]`

**Trạng thái:** ghi nhận. File export **chưa nạp ngược lại được** — có chủ ý,
không phải thiếu sót.

Bộ nạp ([`parsers/pricing-template-parser.ts`](../../lib/google-iap-management/parsers/pricing-template-parser.ts))
cần sheet tên `price_tiers`, header dạng `VN - VND - Vietnam` ở hàng đầu và
**một cột tier** ở trái. File export có bố cục khác hẳn:

| | Bộ nạp cần | File export có |
|---|---|---|
| Tên sheet | `price_tiers` | `Default Template` / `Per-App Template` |
| Hàng header | 1 | **2** (tên nước gộp, rồi `Price` ‖ `Currency`) |
| Cột mỗi nước | 1 (giá) | **2** (Price + Currency) |
| Ô thưa | không có | `·` — bộ nạp sẽ coi là chuỗi không parse được |

⇒ Round-trip không phải đổi tên cột, mà là **một chế độ ghi thứ hai**. Chưa ai
yêu cầu, nên chưa làm.

*(Đối chiếu: Apple có mục tương đương `[TEMPLATE-xlsx-reimport]`, KB §21.8 —
nhưng lý do khác: bên Apple thiếu hẳn `proceeds` trong `MatrixData`.)*

---

## ✅ `[GOOGLE-regions-unmeasured]` — ĐÃ ĐO XONG, ĐÓNG 2026-09-01

**Trạng thái:** ✅ **ĐÓNG.** Con số là **173**.

Ba nguồn độc lập trùng khít 100%, 0 mã lệch ở bất kỳ cặp nào:

| Nguồn | Kết quả |
|---|---|
| **M1** — `GET /api/google-iap-management/regions/catalog?packageName=…` (1 request, đọc thuần, Manager chạy) | 173 cặp `{regionCode, currency}`, `regionsVersion` **"2025/03"** |
| **Q7** — `SELECT DISTINCT region_code FROM google_iap_mgmt.iap_prices` (308.933 dòng giá / 1.794 IAP) | 173 mã |
| **Play Console**, màn **Pricing** (Manager cung cấp) | 173 mã + currency |

Số học khép kín với catalog cũ: `183 − 25 + 15 = 173`, `158 + 25 = 183`, `158 + 15 = 173`.

- **15 mã Google BÁN mà catalog 183 THIẾU** (Manager không tick được):
  `AW BM BY CF ER GI KY LY RU SO TC VA VG YE ZW`
- **25 mã catalog CÓ mà Google không bán** (tick xong không ra cột):
  `AD AF BB BI BN BT CN ET GQ GY KI LS ME MG MH MR MW NR PW ST SZ TL TV VC XK`

⚠ **`regionsVersion` là cơ chế phát hiện drift, và nó TỐT HƠN cách bên Apple.**
Google **tự khai** version của catalog region; Apple phải so từng mã để biết
danh sách đã đổi. X4 phải dùng chỗ này, **không bê drift-detection của Apple**.

⚠ Việc còn lại KHÔNG thuộc mục này: dialog export vẫn đang tick 183 —
đó là **X4**, không phải mục đo lường này.

<details><summary>Nội dung cũ (trước khi đo)</summary>

**Trạng thái:** ⚠ **KHÔNG ĐỌC ĐƯỢC — cần Manager.** Tag này nằm ngoài repo;
grep `docs/` = 0 hit. Nội dung và ba backlog nó đang chặn chưa xác định được.

Arc G2 (export .xlsx) **không cần** con số đó: nó chỉ đọc
`pricing_template_entries`, và tập region ở đó là tập **Manager upload**, không
phải tập Google hỗ trợ. Nguyên tắc "file là ảnh chụp của màn" cấm mở rộng danh
sách nước.

**Phép đo đã thiết kế, chưa chạy — đúng 1 request:**

```
GET /api/google-iap-management/regions/catalog?packageName=<package đã cache>
```
Route đã tồn tại, đã có auth. Bên trong gọi đúng một lần `convertRegionPrices`
([`google/regions-helper.ts:85`](../../lib/google-iap-management/google/regions-helper.ts)).
Đọc-thuần, không ghi gì. Cần credential production ⇒ Manager duyệt trước.

</details>

---

## ✅ `[GOOGLE-template-column-order]` — G2-Q3 · ĐÃ ĐÓNG ở arc G1 (chunk G1d)

**Trạng thái:** ✅ **XONG.** `sort_order` đã có trong
`google_iap_mgmt.pricing_template_entries` (M-1 backfill theo `ctid` cho cả 10
template đang có; parser ghi từ G1d trở đi). Hai đường đọc đã hợp nhất về
`(identifier, sort_order)`, và `composeMatrix` sắp cột **tường minh** theo
`sort_order` thay vì dựa vào thứ tự dòng. Ca thiếu `sort_order` không âm thầm
rơi về alphabet mà bật cờ `columnOrderUnknown` để màn công bố.
Giữ lại phần mô tả bên dưới làm ghi chép lý do.

Thứ tự cột trong cả màn lẫn file hiện dựa vào **thứ tự dòng Postgres trả về khi
`SELECT` không có `ORDER BY`** ([`queries/template-matrix.ts:161-164`](../../lib/google-iap-management/queries/template-matrix.ts)).
Hotfix 24 cố ý dựa vào nó để giữ thứ tự cột của file `.xlsx` Manager upload
(`US VN SG MY ID PH TH HK TW` — không phải alphabet).

⚠ Postgres **không cam kết** hành vi đó. Một `VACUUM FULL` là đủ để đảo cột —
màn và file cùng đảo, nhưng hai bản export cùng dữ liệu ở hai thời điểm sẽ
khác bố cục.

**Cách sửa đã chốt:** thêm cột `sort_order INT` vào
`google_iap_mgmt.pricing_template_entries`, parser ghi chỉ số cột lúc upload,
mọi đường đọc `ORDER BY sort_order`.

⚠ Writer .xlsx **cố ý không tự bù bằng `.sort()`** — bù ở đó sẽ làm file khác
màn, tức chữa một lỗi bằng cách tạo một lỗi khác. Hạn chế này ghi trong
docblock của [`xlsx-template-matrix-export.ts`](../../lib/google-iap-management/xlsx-template-matrix-export.ts).

---

## ✅ Arc `G-EXPORT` — Export item list · ĐÓNG 2026-09-01

Ba yêu cầu Manager, cả ba xong:

| | Yêu cầu | Chunk | Commit |
|---|---|---|---|
| **R3** | Header cột `Price in Vietnam (VN)` | X1 | `332c863` |
| — | Nhãn nước lấy từ Play Console (bỏ bảng vá 18 mục) | — | `96ca745` |
| **R1a** | Filter Active / Inactive | X2 | `3bc58ba` |
| **R1b** | Picker chọn item (T1 tách `BulkStatusModal`) | X3 | `3a6ab6f` |
| **R2** | Dialog dùng 173 nước của Google, bỏ 183 của Apple | X4 | `0955ff1` |

**Hai tag đóng theo:** `[GOOGLE-regions-unmeasured]` (đo ra **173**, ba nguồn
khớp 100%) và `[GOOGLE-export-intersection-silent-drop]` (tick nước không có
giá nay ra cột với ô `—`).

**Năm meta-rule mới vào KB:** P34 (rò rỉ qua default parameter) · P35 (override
thừa và load-bearing nhìn giống hệt nhau) · P36 (test tự nhất quán không bao
giờ đỏ — cần fingerprint) · P37 (đừng port quy ước nhiều-dấu sang pipeline chỉ
có một trạng thái) · P38 (một console, hai danh sách nước).

**Bảy tag còn mở** sinh ra từ arc này, không thuộc phạm vi nó:
`[GOOGLE-common-regions-usd-default]` · `[GOOGLE-promote-hardcoded-usd]` ·
`[GOOGLE-select-250-regions]` (⚠ ba cái này là **một họ** — xem mục nối ở trên,
đề xuất gom một arc riêng) · `[GOOGLE-play-console-two-lists]` ·
`[GOOGLE-suite-timeout-flake]` · `[GUIDE-label-drift]` ·
`[APPLE-export-wizard-docblock-183]` (TODO.md, module Apple).

---

## Đã đóng

| Tag | Đóng khi nào | Ghi chú |
|---|---|---|
| **`[GOOGLE-account-default-template]`** — arc G1, tách Default Template theo account | **2026-09-01 · SHIPPED** | M-1 (`20260831000000`) + M-2 (`20260901000000`) đều đã apply + verify xanh trên production (M2-V0 13/13). Chi tiết ngay dưới bảng |
| `[GOOGLE-template-column-order]` — G2-Q3 thứ tự cột | 2026-09-01, chunk G1d | `sort_order` + hợp nhất hai đường đọc. Mô tả gốc giữ ở mục phía trên |
| *(ghi chú tài liệu)* User Guide mục **Apple** Pricing matrix còn hướng dẫn bấm "Export CSV" | 2026-08-31, commit riêng `fix-apple-guide-export-xlsx` | Grep toàn guide ra **4 chỗ**, không phải 3 — chỗ thứ tư (`<li>Export bảng giá ra CSV…`) **không chứa cụm "Export CSV"** nên sửa theo trí nhớ chắc chắn sót. Sót của arc `[TEMPLATE-xlsx]` phía Apple |

### `[GOOGLE-account-default-template]` — trạng thái đóng sổ

**Đã ship gì.** Default Pricing Template của Google tách từ MỘT bản dùng chung
thành **một bản cho mỗi Google Console account** (6 account). Kèm theo: gate
admin cho Replace/Remove, bịt hai rò rỉ cross-account (`listAppTemplates`,
`getAppById`), cột `sort_order` ghim thứ tự cột, và UI chọn account.

**Migration.** `20260831000000` (M-1, thuần cộng thêm) và `20260901000000`
(M-2, xoá GLOBAL + thu hẹp CHECK + drop `..._global_unique`) — **cả hai đã
apply + verify xanh** trên production.

**UAT.** Xanh ở U1 (chip 6 account) · U2 (chip KHÔNG đổi active account) ·
U3 (badge) · U4 (pill) · Export XLSX không hồi quy.
⏸ **U6/U6b (Replace thật + modal hai biến thể) HOÃN** theo quyết định Manager —
để lại cho lần dùng thật; issue phát sinh thì Manager báo sau.

**⚠ RỦI RO MANAGER ĐÃ CHẤP NHẬN — đọc trước khi xử lý sự cố.**
Sau M-2, **đường lui "rollback code" KHÔNG còn dùng được**: code trước G1b đọc
`scope_type='GLOBAL'`, mà M-2 đã xoá dòng đó và bỏ luôn giá trị `'GLOBAL'` khỏi
CHECK. Deploy lại bản code cũ sẽ thấy 0 template ở mọi đường đọc Default.
**Đường lui còn lại: phục hồi từ 2 bảng backup bằng SQL** —
`pricing_templates_backup_global` và `pricing_template_entries_backup_global`
(1 header / 846 entry, còn nguyên). Chậm hơn, nhưng không mất dữ liệu.
Vì thế hai bảng đó **chưa được dọn** — xem tag
`[GOOGLE-g1-backup-cleanup]` bên trên.

---

## `[GOOGLE-copy-template-across-accounts]` — hoãn từ đầu arc G1

**Trạng thái:** chưa làm, Manager đã chốt hoãn ngay khi mở arc G1.

Sau khi Default Template tách theo account, một thao tác hay dùng sẽ là "lấy
bảng của account A đặt sang account B" — hiện phải tải `.xlsx` từ A rồi upload
lại vào B. Nút **copy template sang account khác** làm thẳng việc đó.

⚠ Khi làm, đọc trước hai thứ đã có: `replaceConfirmVariant`
([`replace-confirm.ts`](../../lib/google-iap-management/replace-confirm.ts)) —
copy vào một account đã có bản người thật upload phải hiện đúng biến thể ĐỎ; và
gate admin ở [`pricing-templates/route.ts`](../../app/api/google-iap-management/pricing-templates/route.ts)
— copy là đường GHI, phải gác y như Replace.

---

## `[GOOGLE-g1-backup-cleanup]` — dọn 2 bảng backup của M-1

**Trạng thái:** ⏸ **CHỜ ĐIỀU KIỆN**, không phải chờ người làm.

Hai bảng `pricing_templates_backup_global` và
`pricing_template_entries_backup_global` là **đường lui duy nhất** còn lại sau
M-2 (rollback code không dùng được nữa — code cũ đọc `GLOBAL`, mà M-2 đã xoá
dòng đó).

**Điều kiện dọn (F4):** đã có **ít nhất một lần Replace/upload THẬT thành công
sau deploy** — không phải chỉ xem màn hình.

⚠ Điều kiện này **CHƯA thoả**: mục U6/U6b của
[UAT G1](uat-g1-account-default-template.md) bị hoãn theo quyết định Manager
(UAT xanh ở U1–U4 + Export XLSX; U6 để lại cho lần dùng thật). Giữ backup cho
tới khi thoả. Câu dọn ghi sẵn ở cuối
[verify-google-account-default-template.sql](queries/verify-google-account-default-template.sql)
mục M2-V6.

---

## `[GOOGLE-play-console-two-lists]` — Play Console có HAI danh sách nước, đừng lấy nhầm

**Trạng thái:** ⚠ **GHI ĐỂ NGƯỜI SAU KHÔNG LẤY NHẦM.** Không phải việc cần làm.

Play Console phát hành **hai** danh sách quốc gia khác nhau, và chúng **không
bằng nhau**:

| Màn | Số mục | Trả lời câu gì |
|---|---|---|
| **Pricing** (country + currency) | **173** | "bán được ở đâu" — nước có currency để đặt giá |
| **Country targeting / distribution** | **176** | "phân phối được ở đâu" — nước app xuất hiện được |

Khác biệt đã đo: danh sách 176 **có** `CN CU IR SD` và một mục **"Rest of
World"** (không phải mã ISO), và **thiếu `CF`**.

⚠ **Toàn bộ arc export dùng danh sách PRICING (173).** Nó là tập khớp
`convertRegionPrices`, tức tập tool thực sự đặt giá được.

⚠ **Nếu sau này có màn cần "nước phân phối được"** — ví dụ một bề mặt về
availability chứ không phải giá — thì đó là **tập KHÁC, nguồn KHÁC**, và
`PLAY_CONSOLE_LABELS` (region-name.ts) **không** phải nguồn cho nó. Mục này
tồn tại vì trong arc này đã có một lần suýt lấy nhầm: bản 176 mục được gửi
trước, và chỉ bị bác bỏ nhờ phép so bằng máy với M1.

---

## `[GOOGLE-common-regions-usd-default]` — `defaultCurrencyForRegion` sai 70/173, tới được lệnh ghi, **nhưng chưa nổ lần nào**

**Trạng thái:** ⚠ **CẦN SỬA — XẾP SAU X3/X4.** Đã hạ mức 2026-09-01 sau khi đo
production. Lịch sử mức: "backlog, chưa rõ có tới payload" → "CẦN SỬA, chen
trước X3/X4" (khi trace xong đường tới payload) → **"CẦN SỬA, sau X3/X4"** (khi
đo ra chưa có thiệt hại thật).

### ⚠ CĂN CỨ HẠ MỨC — và HAI ĐIỀU KHÔNG ĐƯỢC KẾT LUẬN TỪ NÓ

Manager chạy `queries/y1-pre-currency-damage-check.sql` trên production
(2026-09-01):

| | |
|---|---|
| dòng giá trong mirror | **308.933** |
| region ngoài 173 | **0** |
| **currency lệch** | ⭐ **0** |
| IAP dính | **0** |
| Q2 · Q2b · Q3 · Q5 | **0 dòng** |
| `AF` (đường B) từng xuất hiện trong mirror | **chưa bao giờ** |

Mirror ghi từ **response của Google** (`repository/iaps.ts:287-291`), nên 0 dòng
nghĩa là **Google chưa từng nhận và giữ một cặp `{region, currency}` sai**.

> ### ⚠ ĐỪNG ĐỌC "0 DÒNG" THÀNH "AN TOÀN RỒI". Hai điều nó KHÔNG chứng minh:
>
> **1. Nó KHÔNG chứng minh Google từ chối `{AT, USD}`.** 0 dòng khớp với **cả
> hai** giả thuyết, và query không phân biệt được: (a) Google từ chối cặp sai,
> hoặc (b) **chưa ai đi qua đường đó bao giờ**. Muốn biết chắc vẫn phải chạy
> phép đo **Y1** (1 request ghi trên IAP nháp) — **hoãn, không huỷ**.
>
> **2. "0 dòng" chỉ đáng tin tới lần Refresh gần nhất của TỪNG IAP.** Q4 đo:
> 1.794 IAP, 0 never-synced, mới nhất hôm nay, **cũ nhất 102 ngày**. Với nhóm
> cũ đó, một lần ghi sai xảy ra sau lần sync cuối **chưa hiện lên**. Chạy
> Refresh rồi chạy lại Q2 sẽ chặt hơn.
>
> ⇒ **Defect vẫn CÓ THẬT trong code** — 70/173 mã sai currency, đường tới
> payload đã trace đủ 6 mắt. Nó chỉ **CHƯA NỔ**. Hạ mức là xếp lại thứ tự, không
> phải đóng.

### Sai bao nhiêu — đo với 173 cặp `{code, currency}` thật của M1

[`regions.ts:56-58`](../../lib/google-iap-management/regions.ts) —
`defaultCurrencyForRegion(code)` tra `COMMON_REGIONS` (**30 mục**) và trả
**`"USD"`** cho mọi mã không có trong đó.

| | Số |
|---|---|
| 173 thị trường Google bán, **có** trong `COMMON_REGIONS` | 28 |
| **không** có ⇒ hàm trả `USD` | **145** |
| … trong đó Google thật sự dùng `USD` ⇒ **đúng do may** | 76 |
| … Google dùng currency **khác** ⇒ **SAI** | **69** |
| cộng `AR` — có trong bảng nhưng **giá trị sai** (`ARS`, Google tính `USD`) | +1 |
| **TỔNG SAI** | ⚠ **70 / 173** |

69 mã fallback sai, nhóm theo currency thật — **28 nước EUR** là nhóm lớn nhất:

```
EUR (28)  AT BE BF BG BJ CF CY EE FI GA GR GW HR IE IS LT LU LV
          MC ML MT NE PT SI SK SM TG VA
CHF (2) CH LI   ·   XOF (2) CI SN
41 mã còn lại, mỗi mã một currency riêng: BD BO CL CM CO CR CZ DK DZ EG GE
GH GI HU IL IQ JO KE KZ LK MA MM MN MO NG NO PE PK PL PY QA RO RS SE TZ UA ZA
```

⚠ `COMMON_REGIONS` còn chứa **2 mã Google KHÔNG bán**: `CN`, và **`EU`** —
*không phải mã ISO 3166-1 nào cả*, trong khi `InAppProduct.prices` của Google
keyed theo **mã quốc gia**.

### ⚠ Giá trị sai đó ĐI TỚI ĐÂU — chuỗi đầy đủ, không suy diễn

```
IapForm.tsx:335   addRegionOverride()      currency: defaultCurrencyForRegion(next.code)
IapForm.tsx:346   updateOverride()      →  applyManagerEdit(…, defaultCurrencyForRegion)
                                           override-merge.ts:86-88 — ĐỔI REGION ⇒ RE-DERIVE CURRENCY
        ↓
iap-save-body.ts:68            currency: r.currency
        ↓
app/api/…/iaps/[sku]/route.ts:141   currency: (r.currency ?? "USD").trim()
        ↓
orchestration/update-iap.ts:112     prices[r.region] = { currency: r.currency.trim().toUpperCase(), … }
orchestration/update-iap.ts:190     prices[region]   = { currency: p.currency, … }   ← payload InAppProduct["prices"]
```

⇒ **Không phải chỉ hiển thị. Nó là giá trị được gửi đi.**

### ⚠ ĐÍNH CHÍNH (2026-09-01) — bản đầu của mục này nêu VÍ DỤ SAI và PHẠM VI QUÁ RỘNG

Bản đầu viết *"đổi nước sang **Đức** thì EUR bị thay bằng USD"*. **Sai:** `DE`
**có** trong `COMMON_REGIONS`, nên `defaultCurrencyForRegion("DE")` trả đúng
`EUR` (đo bằng code). Ví dụ đúng là các nước EUR **không** nằm trong 30 mục:
`AT` `BE` `PT` `CH` `NO` `SE` `PL` … — đã đo, đều trả `USD`.

Và phạm vi hẹp hơn bản đầu nói: trình sửa region override nằm trong khối
**`{!isEdit && (`** ([`IapForm.tsx:1032`](../../components/google-iap-management/iap-form/IapForm.tsx#L1032))
⇒ **chỉ có ở màn New IAP.** Màn Edit dùng `UnifiedPricingTable`, và bảng đó chỉ
gửi `{ priceDecimal }`
([`UnifiedPricingTable.tsx:456`](../../components/google-iap-management/iap-form/UnifiedPricingTable.tsx#L456))
⇒ **không đổi được nước** ⇒ nhánh re-derive currency của `applyManagerEdit`
**không bao giờ chạy ở Edit mode**.

Defect không đổi; ví dụ và phạm vi thì đổi. Chi tiết đầy đủ ở báo cáo trả lời
Manager 2026-09-01 và ở `queries/y1-pre-currency-damage-check.sql`.

**Đường thật sự tới được từ giao diện (đều ở New IAP):**
1. **Đổi nước của một dòng đã có** — `<select>` mỗi dòng
   ([`IapForm.tsx:1062-1071`](../../components/google-iap-management/iap-form/IapForm.tsx#L1062))
   liệt kê **250 mã ISO** từ `getAllRegions()`; đổi nó gọi
   `updateOverride(i, { region })` → `applyManagerEdit` →
   `override-merge.ts:87` re-derive currency. **Đây là đường dễ xảy ra nhất.**
2. **Nút "Add region"** ([`IapForm.tsx:1104`](../../components/google-iap-management/iap-form/IapForm.tsx#L1104))
   — dòng mới nhận nước **đầu tiên chưa dùng** theo thứ tự alphabet của
   `getAllRegions()`, tức **`AF` (Afghanistan)**, và `AF` **không** nằm trong
   173 nước Google bán. Currency điền `USD`.

**Một đường thứ ba, ở Edit mode, KHÔNG qua `defaultCurrencyForRegion`:**
`UnifiedPricingTable.tsx:467` gọi `onAddOverrideForRegion(region, row.live?.currency ?? "USD")`
— khi hàng **không có giá live** trên Google, nó đóng cứng `"USD"` bất kể nước
nào. Cùng hậu quả, nguyên nhân khác; sửa `defaultCurrencyForRegion` **không**
chạm tới nó.

**Hai điều kiện giảm nhẹ, đã kiểm:**
1. Dòng không có `priceDecimal` bị **loại** trước khi gửi
   (route:138 và [`update-iap.ts:110`](../../lib/google-iap-management/orchestration/update-iap.ts#L110)
   `if (!r.priceDecimal.trim()) continue;`). Chỉ dòng Manager đã gõ giá mới đi tới Google.
2. Đường **promote-to-override** KHÔNG dính: `UnifiedPricingTable.tsx:467`
   truyền `row.live?.currency` — currency **thật của Google** — nên
   `currency || defaultCurrencyForRegion(region)` ở `IapForm.tsx:392` gần như
   không bao giờ chạm nhánh phải.
3. Ô currency **sửa được** trên UI ([`IapForm.tsx:1083`](../../components/google-iap-management/iap-form/IapForm.tsx#L1083))
   — Manager chữa được, **nếu để ý**. Giá trị tự điền sai mà trông hợp lệ thì
   không có gì gợi ý phải để ý.

### ⚠ Ghi im lặng hay bị từ chối ồn ào — CHƯA ĐO, và nó quyết định mức độ

Bằng chứng trong repo nghiêng mạnh về **bị từ chối**:
[`regions-helper.ts:52-54`](../../lib/google-iap-management/google/regions-helper.ts#L52)
ghi Google **rejects the patch** khi currency của một nước lệch khỏi catalog
(ca Bulgaria BGN→EUR, Hotfix 9). Nếu đúng vậy thì hậu quả là **Manager bị báo
lỗi khó hiểu cho một giá trị chính tool tự điền** — tệ, nhưng không phải ghi sai
dữ liệu âm thầm.

⚠ **Không kết luận khi chưa đo.** Ca của Hotfix 9 là lệch **version**, ca này là
currency sai thẳng — gần nhau, không đồng nhất.

**PHÉP ĐO ĐỀ XUẤT (chưa chạy, cần Manager duyệt):** trên **một IAP nháp**,
thêm override `DE` với currency `USD` + một giá, bấm Save, đọc phản hồi Google.
- Google **từ chối** ⇒ giữ mức "sửa để hết báo lỗi khó hiểu".
- Google **nhận** ⇒ nâng lên **ghi sai âm thầm**, mức nghiêm trọng nhất.
1 request ghi, trên item nháp, có thể xoá sau.

### Hướng sửa (chưa làm)

Bỏ hẳn `defaultCurrencyForRegion` khỏi ba đường trên và lấy currency từ
`/api/google-iap-management/regions/catalog` — route **đã tồn tại**, đã trả
đúng 173 cặp, và form **đã gọi nó rồi**
([`IapForm.tsx:428`](../../components/google-iap-management/iap-form/IapForm.tsx#L428)).
Tức nguồn đúng đã nằm sẵn trong cùng component; ba chỗ kia chỉ đang không dùng.
⚠ Cùng hình dạng với lỗi R2: nguồn đúng có sẵn, một đường khác vẫn đọc nguồn cũ.


⟶ **2026-10-18 — H4.1 (Google bulk import):** cùng họ, thêm một điểm: `COMMON_CURRENCIES` (dropdown
currency của `IapForm`, lấy từ bảng này) còn đưa ra `CNY` (CN không có trong catalog đo 2026-09-01) và
`ARS` (Google bill AR bằng USD — `play-regions.snapshot.ts:76`). Bulk import đã THÔI dùng `regions.ts`
từ H4.1: bảng GT riêng trong `excel-parser.ts`, mỗi GT kiểm theo catalog qua `fileRegionPriceOf`
(`orchestration/file-price.ts`). Hướng sửa của mục này giữ nguyên (gom vào arc của họ, xem dưới).

---

## `[GOOGLE-promote-hardcoded-usd]` — promote-to-override đóng cứng `"USD"` khi hàng không có giá live

**Trạng thái:** ⚠ **CẦN SỬA — XẾP SAU X3/X4.** Lỗi **ĐỘC LẬP**, phát hiện
2026-09-01 khi trace `[GOOGLE-common-regions-usd-default]`.

[`UnifiedPricingTable.tsx:467`](../../components/google-iap-management/iap-form/UnifiedPricingTable.tsx#L467):

```tsx
onAddOverrideForRegion(row.region_code, row.live?.currency ?? "USD")
```

`row.live` là `{ currency, price_micros } | null`
([`unified-pricing.ts:52`](../../lib/google-iap-management/unified-pricing.ts#L52)).
Khi **null** — hàng chưa có giá live trên Google — nút "override" stamp
`"USD"` **bất kể nước nào**.

> ### ⚠ CÙNG HẬU QUẢ, NGUYÊN NHÂN KHÁC — SỬA CÁI KIA KHÔNG CHẠM TỚI NÓ
> `"USD"` ở đây là **hằng đóng cứng tại chỗ**, không đi qua
> `defaultCurrencyForRegion`. Thay hàm đó bằng `regions/catalog` sẽ để lại
> dòng này y nguyên. Một `grep defaultCurrencyForRegion` khi sửa sẽ **không**
> ra nó — đúng lớp P1 twin-path.
>
> ### ⚠ VÀ NÓ Ở MÀN KHÁC. ĐỪNG GỘP KHI SỬA.
> | | màn | căn cứ |
> |---|---|---|
> | `[GOOGLE-common-regions-usd-default]` đường A/B | **New IAP** | trình sửa override nằm trong `{!isEdit && (` — [`IapForm.tsx:1032`](../../components/google-iap-management/iap-form/IapForm.tsx#L1032) |
> | **mục này** | **Edit IAP** | `UnifiedPricingTable` chỉ render dưới `{isEdit && (` |
>
> Hai màn, hai đường code, hai lần sửa. Gộp làm một sẽ sửa được một nửa và
> tưởng là xong.

**Chưa gây hại tính tới 2026-09-01** — cùng phép đo Y1-PRE, 0/308.933 dòng lệch.
Mọi cảnh báo về giới hạn của "0 dòng" ở
`[GOOGLE-common-regions-usd-default]` áp dụng y hệt cho mục này.

---

## `[GOOGLE-select-250-regions]` — `<select>` nước liệt kê 250 mã ISO thay vì 173 nước Google bán

**Trạng thái:** ⚠ **CẦN SỬA — XẾP SAU X3/X4.** Phát hiện 2026-09-01.

[`IapForm.tsx:1062-1071`](../../components/google-iap-management/iap-form/IapForm.tsx#L1062)
dựng `<option>` từ `getAllRegions()` — **250 mã ISO 3166-1**
([`region-name.ts:84-94`](../../lib/google-iap-management/region-name.ts#L84)),
không phải **173** mã Google Play thực sự bán.

**Hệ quả đo được:** `addRegionOverride()`
([`IapForm.tsx:326-341`](../../components/google-iap-management/iap-form/IapForm.tsx#L326))
lấy **nước đầu tiên chưa dùng** theo thứ tự alphabet của `getAllRegions()`. Đo
bằng code: mục đầu là **`AF` — Afghanistan**, và **`AF` không nằm trong 173**.

> ### ⚠ THAO TÁC MẶC ĐỊNH NHẤT CHO RA MỘT NƯỚC KHÔNG BÁN ĐƯỢC.
> Bấm "Add region" rồi không đổi gì = một dòng override cho một thị trường
> Google không bán, currency `USD`. Không có gì trên màn nói điều đó.

> ### ⚠ CÙNG HỌ VỚI LỖI R2 — và đó là lý do mục này đáng ghi riêng
> R2: dialog export tick **183** mã của module Apple thay vì 173 của Google.
> Mục này: form Edit/New chọn **250** mã ISO thay vì 173 của Google.
> Cùng một hình dạng: **một danh sách nước rộng hơn thực tế, lấy từ nguồn
> không phải Google, và không ai đối chiếu.** R2 phải đo mới phát hiện; mục
> này phát hiện được nhờ đã có con số 173.

---

## ⚠ BA MỤC TRÊN LÀ MỘT HỌ — gom thành MỘT arc sau X4, đừng sửa lẻ

`[GOOGLE-common-regions-usd-default]` · `[GOOGLE-promote-hardcoded-usd]` ·
`[GOOGLE-select-250-regions]` là **ba triệu chứng của một nguyên nhân**: màn
Create/Edit IAP dựng danh sách nước và currency từ **nguồn nội bộ cũ**
(`COMMON_REGIONS` 30 mục · `getAllRegions()` 250 mã ISO · một hằng `"USD"`
đóng cứng) thay vì từ Google.

**Nguồn đúng đã tồn tại và đã chạy production:**
[`GET /api/google-iap-management/regions/catalog`](../../app/api/google-iap-management/regions/catalog/route.ts)
— trả đúng **173 cặp `{regionCode, currency}`** từ `convertRegionPrices`.

⚠ **Và chính hai component đó đã gọi nó rồi**:
[`CustomPricesDialog.tsx:157`](../../components/google-iap-management/bulk-import/CustomPricesDialog.tsx#L157)
và [`IapForm.tsx:428`](../../components/google-iap-management/iap-form/IapForm.tsx#L428).
Nguồn đúng nằm **trong cùng file**; ba đường kia chỉ đang không dùng.

⇒ **Đề xuất: một arc riêng sau X4**, sửa cả ba cùng lúc qua một nguồn.
Sửa lẻ từng mục thì mỗi lần chỉ đóng một triệu chứng, và cái còn lại vẫn cho
ra đúng dữ liệu sai đó — như `[GOOGLE-promote-hardcoded-usd]` sẽ sống sót
nguyên vẹn qua một bản sửa `defaultCurrencyForRegion`.

---

## ❌ `[GOOGLE-export-status-dropdown]` — ĐÃ CÂN NHẮC, ĐÃ LOẠI 2026-09-01

**Trạng thái:** ❌ **KHÔNG LÀM.** Ghi lại để lần sau không ai đề xuất lại.

Đề xuất: đổi 3 radio của filter trạng thái (`ExportScopeDialog`) thành
**dropdown** cho gọn. Census đo rồi loại, ba lý do:

1. **Chỉ tiết kiệm ~2 dòng.** Phần chiếm chỗ nhất trong khối đó là **block chú
   thích `INACTIVE_PUBLISHED`**, và block đó **không được bỏ** — X2 dựng nó có
   test canh, ở cả tầng UI lẫn tầng lib (đối chiếu thẳng source adapter).
   Đổi control không chạm gì tới phần thực sự chiếm chỗ.
2. **Mất một tính chất đang có:** 3 radio cho thấy **cả ba số cùng lúc**
   (60 / 55 / 5 lúc UAT) mà không phải mở gì. Dropdown chỉ hiện số của lựa
   chọn hiện tại; nhét số vào `<option>` thì phải mở mới thấy — mà đó chính là
   thông tin Manager dùng để quyết chọn cái nào.
3. **Tốn 2 test phải sửa** (`radiogroup` role, `getByRole("radio")`) cho một
   thay đổi không giải quyết vấn đề nó nhắm tới.

⚠ Manager **không nêu được chỗ nào đang chật cụ thể**, nên không thu gọn dialog
trong arc này. Nếu sau này có chỗ chật thật, hãy nêu **chỗ đó**, đừng bắt đầu
lại từ control này.

---

## ℹ️ `xlsx` phía Google: nay CHỈ ĐỌC, không ghi (R5, 2026-09-01)

Sau khi export item-list chuyển sang `exceljs`, **không còn file Google nào GHI
workbook bằng `xlsx`**. Danh sách `XLSX_ALLOWED` phía Google còn đúng:

- `parsers/pricing-template-parser.ts` — đọc file Manager upload
- `parsers/excel-parser.ts` — đọc file Manager upload
- `__fixtures__/read-workbook.ts` — test helper, đọc lại file đã ghi

Hàng rào nay phát biểu thành **VAI TRÒ** chứ không phải danh sách file:
`excel-library-split.structural.test.ts` — *"in the Google module, `xlsx` may
READ and may not WRITE"*. Chặt hơn trước, không phải lỏng hơn.

⚠ **Nâng version `xlsx` KHÔNG giải quyết được freeze/styling** — `0.18.5` là
bản npm **cuối cùng**, hai thứ đó là tính năng **Pro**. Đã ghim thành assertion
(`pkg.dependencies.xlsx === "^0.18.5"`) để một lần bump version rơi đúng vào đó
và phải được biện minh. **Đừng đề xuất lại.**

---

## `[GOOGLE-suite-timeout-flake]` — full suite không xanh tất định trên máy dev

**Trạng thái:** ⚠ **GHI SỐ LIỆU, KHÔNG SỬA TRONG ARC NÀY.** Manager đã chốt
tiêu chí gate: chấp nhận "xanh khi chạy riêng + full suite chỉ đỏ do timeout,
không do assertion".

**Số liệu đo 2026-09-01.**

Tại `332c863` (sau X1), 8 lần chạy `npx vitest run` toàn bộ:

| | kết quả |
|---|---|
| xanh hoàn toàn | **3** lần (`4885/4885`) |
| đỏ | **3** lần — 1 đỏ, 1 đỏ, 4 đỏ |
| *(2 lần còn lại ở trạng thái test khác, không tính)* | |

⚠ **100% các ca đỏ là `Error: Test timed out in 5000ms`. Không một
AssertionError nào.** Tổng số test luôn là `4885` — chỉ tỉ lệ pass/fail đổi.

Tại `4e4d4ad` (**TRƯỚC** X1, chạy trong worktree riêng), 3 lần:

| run 1 | run 2 | run 3 |
|---|---|---|
| 1 đỏ | **37 đỏ** (35 trong đó là timeout) | 1 đỏ |

⇒ **Flake có trước X1 và ở đó nặng hơn.** X1 sửa một module thuần, đồng bộ,
không I/O / không React / không timer, và `git diff --stat -- components/` qua
range X1 là **rỗng**.

**Bốn test hay đỏ nhất** (đều xanh 5/5 khi chạy riêng):

| File | Test |
|---|---|
| `app/api/store-submissions/sync/gmail/route.test.ts` | `missing X-Cron-Secret header → 401` |
| `components/google-iap-management/bulk-import/BulkImportWizard.test.tsx:544` | `'Import another' resets the tracking state machine` |
| `components/google-iap-management/iap-form/IapForm.sc2.test.tsx` | `a pure Sync from Google leaves NOTHING to submit` |
| `components/iap-management/ExportOptionsDialog.apple-catalog.test.tsx` | `⚠ MUTATION (b) — Select all ticks 175, not 183` |

⚠ Ba module khác nhau (store-submissions, Google IAP, Apple IAP) ⇒ **không phải
lỗi của một module**, là hành vi dưới tải song song. Không có `testTimeout` khai
trong `vitest.config` ⇒ đang dùng mặc định 5000ms.

**Số liệu bổ sung 2026-09-04 — arc APPLE `arc-apple-export-picker-paging` (Y1+Y2).**

6 lần chạy toàn bộ suite tại `d3a3106`/`b6ca37f` (`5105` test, `361` file):

| # | điều kiện | thời lượng | đỏ |
|---|---|---|---|
| 1 | có vitest khác chạy chồng | 116s | 4 |
| 2 | có vitest khác chạy chồng | 103s | 1 |
| 3 | có vitest khác chạy chồng | 67s | 10 |
| 4 | chạy một mình | **44.7s** | **0** |
| 5 | chạy một mình, **ngay sau `npm run build`** | 98.4s | 2 |
| 6 | chạy một mình, không build trước | 57.0s | 1 |

⚠ **100% vẫn là `Test timed out in 5000ms`. 0 AssertionError, cả 6 lần.**
Test đỏ hay gặp nhất vẫn đúng cái #1 của bảng trên:
`store-submissions/sync/gmail > missing X-Cron-Secret header → 401` (4/6 lần).
`IapForm.sc2.test.tsx` cũng xuất hiện — cũng đã có tên trong bảng.

**Một tên MỚI vào nhóm nhạy tải, ghi để biết chứ KHÔNG để đuổi:**
`IapListClient.export-paging.test.tsx > ⚠ Y2.4 … the page-1 id is in the payload`
— đỏ **1/6** lần (lần 5). Chạy riêng: **390ms** trên hạn mức 5000ms, tức còn
**12.8×** dư địa. Nó là test integration nặng nhất arc này (render cả trang +
45 dòng + dialog 175 nước), nên nó là ứng viên tự nhiên cho một hạn mức 5s bị
tải làm trượt — không phải một test chậm.

⚠ **CẢI CHÍNH BÁO CÁO Y2.** Báo cáo Y2 kết luận nguyên nhân là "các process
vitest chạy chồng nhau" và nói suite "xanh hoàn toàn khi chạy sạch". **Sai, và
sai vì kết luận từ MỘT lần chạy** (lần 4). Lần 5 và 6 đều chạy một mình mà vẫn
đỏ. Nguyên nhân thật vẫn **chưa xác định** — chồng process chỉ làm nó nặng
thêm. Đây đúng là flake đã được ghi ở đây từ 2026-09-01, không phải phát hiện
mới.

⚠ Dấu hiệu `[vitest-pool]: Failed to start forks worker` mà
`TODO.md [VITEST-coldstart-flake-recurrence]` trích **KHÔNG xuất hiện** trong
cả 3 log đã lưu của arc này (`grep -c` = 0). Cùng *hình dạng* (timeout 5s,
không assertion, cùng tên test), **khác dấu hiệu** ⇒ chưa đủ cơ sở nói là cùng
một cơ chế. Ghi lại đúng như đo được.

**Đối chiếu 3 điều kiện chặn bên dưới: KHÔNG điều kiện nào thoả.**
(1) không có AssertionError nào; (2) `Y2.4` xanh 390ms và `gmail` xanh 19/19
khi chạy riêng; (3) tỉ lệ đỏ không quá ~50% và không chặn gate nào.
⇒ **Không sửa `vitest.config`, không sửa test.** Theo đúng luật đã ghi ở dưới.

**KHI NÀO PHẢI ĐIỀU TRA** (điều kiện chặn, không phải cảm tính):
1. một lần đỏ là **AssertionError**, không phải timeout; **hoặc**
2. một test đỏ **cả khi chạy riêng**; **hoặc**
3. tỉ lệ đỏ vượt ~50% và chặn được một gate thật (không ai push được).

Hướng đã nghĩ tới, chưa thử: nâng `testTimeout`, hoặc giảm `maxConcurrency` /
đổi `pool`. **Không đụng cho tới khi một trong ba điều kiện trên xảy ra** — sửa
config test để đuổi một flake chưa hiểu là cách làm nó im lặng, không phải hết.

---

## `[GUIDE-label-drift]` — Guide §3 khai sai endpoint của Refresh

**Trạng thái:** ⚠ **NGOÀI PHẠM VI arc export, ghi lại.**

`docs/google-iap-management/operational-guide.md` §3 bước 1 viết Refresh đồng bộ
qua Publisher **`inappproducts.list`** — đó là endpoint **legacy**.

Code hiện tại đi
[`monetization.onetimeproducts.list`](../../lib/google-iap-management/google/publisher-client.ts#L105)
trước, **chỉ** rơi về `inappproducts.list` khi API mới lỗi
([`publisher-client.ts:170-185`](../../lib/google-iap-management/google/publisher-client.ts#L170)).

Cùng lớp với `[GUIDE-label-drift]` bên Apple: guide khẳng định một điều về code
mà không ai kiểm lại khi code đổi.


---

## `[GOOGLE-no-item-last-update]` — Google KHÔNG trả "last update" cho từng IAP

**Trạng thái:** 📌 **GHI NHẬN, KHÔNG ĐỀ XUẤT ARC.** Manager hỏi "có hay không";
đáp án là **KHÔNG**, và không có việc gì phải làm tiếp trừ khi Manager mở.

Android Publisher v3 (`revision 20260520`) không có `updateTime` /
`lastModified` / `etag` trên `InAppProduct` (13 prop), `OneTimeProduct` (8),
`Subscription` (7), `OneTimeProductPurchaseOption` (8) — không ở LIST, không ở
GET, không ở response của WRITE. Gần nhất là `OneTimeProduct.regionsVersion`
nhưng đó là version **catalog vùng bán toàn cục** (`"2025/03"`), không phải dấu
vết sửa item.

⇒ Không thể xây "sync thông minh chỉ kéo item đã đổi", không thể conditional-GET
bằng etag, và **không thể** hiển thị "Google sửa item này lúc nào".
`iaps.last_synced_at` / `updated_at` / `created_at` đều là thời gian **của
tool**, không phải của Google.

Chi tiết + cách đo: `design-export-picker-paging.md` Phần B.

---

## `[GOOGLE-dark-mode-gap]` — module Google chưa làm dark mode

**Trạng thái:** 📌 GHI NHẬN, **KHÔNG mở arc.**

Dark mode là thật trong repo (`next-themes` + `tailwind.config.ts:4`
`darkMode: ["class"]` + `components/layout/ThemeToggle.tsx`), nhưng cả 4 file
luồng export Google có **0 `dark:`**; `ExportScopeDialog.tsx:107` đặt `bg-white`
cứng ⇒ dialog trắng trong dark mode.

⚠ Luồng export Google **hôm nay đã trộn** dark-aware với dark-blind:
`ExportOptionsDialog` — bước 2 của chính luồng này, import ở
`IapListClient.tsx:35` — có **31 `dark:`**. `PageNav` (dùng từ chunk 2) có 10.
Nên PageNav **không tạo lớp lỗi mới**, nó chỉ làm một lệch đã tồn tại dễ thấy
hơn. Sửa đúng chỗ là làm dark mode cho module Google, không phải né PageNav.

---

## `[SHARED-lib-extraction]` — nếu sau này muốn `lib/shared/`

**Trạng thái:** 📌 GHI NHẬN. **Arc kiến trúc riêng, ĐỘC LẬP với quyết định
PageNav** (việc 1 đã chốt dùng lại PageNav, không nâng).

Chi phí đo được: **8 file** — 6 import site + 2 file di chuyển
(`page-slice.ts` + `page-slice.test.ts`). **0 test ghim đường dẫn** (không có
structural test nào `readFileSync` trên đường dẫn này), nên là refactor cơ học.

6 import site: `app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx:30`
· `components/ui/iap/PageNav.tsx:36` · `components/ui/iap/PageNav.test.tsx:19`
· `components/iap-management/item-picker/BulkItemPicker.tsx:85`
· `components/google-iap-management/apps/AppsListClient.tsx:23`
· `components/google-iap-management/iap-list/IapListClient.tsx:23`

⚠ Nâng `page-slice` **không** trả lời gì cho `PageNav` — PageNav là React
component, không vào `lib/` được. Đừng gộp hai câu hỏi làm một lần nữa.

---

## `[RANGE-SELECT-two-implementations]` — hai bản shift-click cùng phép cắt

**Trạng thái:** 📌 GHI NHẬN. **KHÔNG gộp trong arc này** — chunk 2 đang mở,
gộp giữa chừng là đổi nền dưới chân.

Hai file tính **cùng một phép cắt bao gồm hai đầu**:
`lib/iap-management/apple/item-range-select.ts` (25 dòng code) và
`lib/google-iap-management/item-range-select.ts` (22 dòng code).

**Khác nhau ở đâu — đọc và liệt kê, không mô tả chung:**

| | Apple | Google |
|---|---|---|
| Tên hàm | `resolveRangeIds` | `resolveRangeSkus` |
| Tham số 1 | `readonly RangeSelectableRow[]` (mảng **object**) | `readonly string[]` (mảng **id trần**) |
| Kiểu phụ trợ | `export interface RangeSelectableRow { appleIapId: string }` | **không có** |
| Tra vị trí | `.findIndex((r) => r.appleIapId === …)` ×2 | `.indexOf(…)` ×2 |
| Trả về | `.slice(...).map((r) => r.appleIapId)` | `.slice(...)` (đã là string) |
| `addRangeToSelection` | **giống hệt** — cùng chữ ký, cùng thân | **giống hệt** |
| Test kèm | `item-range-select.test.ts` + `.order.test.ts` | `item-range-select.test.ts` + `.structural.test.ts` |

⇒ Khác biệt thực chất **chỉ là hình dạng đầu vào** (object có trường
`appleIapId` vs string trần). Toán học (min/max/slice bao gồm hai đầu, ba nhánh
`null`) **trùng khít**. `addRangeToSelection` **đã trùng byte-for-byte về logic**.

**Điều kiện gộp — gộp khi CẢ BA đúng:**
1. Chunk 2 đã gate xong (không còn arc nào đang sửa hai file này);
2. Bản gộp nhận **id trần** (`readonly string[]`) và Apple map `appleIapId` ở
   call site — vì đó là phía có thể đổi mà không mất thông tin, chiều ngược lại
   ép Google bọc string vào object cho không;
3. Cả `.order.test.ts` (Apple) lẫn `.structural.test.ts` (Google) chạy được trên
   bản gộp **mà không nới assertion nào** — nới một assertion để gộp cho gọn là
   đổi bằng chứng lấy sự gọn gàng.

⚠ Nếu (3) không đạt thì **đừng gộp**: hai bản 22-25 dòng sống cạnh nhau rẻ hơn
một bản dùng chung mà không ai dám sửa.

---

## `[GOOGLE-tinywar-missing-default]` — `com.vnggames.tankarena.tinywar` hỏng 25/25 hai lần, "Missing: default"

**CHỈ GHI NHẬN. CHƯA ĐIỀU TRA.** Mục này mở ra trong arc
`arc-google403-error-observability` (2026-10-12) khi Manager chạy Query B
để điều tra sự cố 403 của `vng.games.tamquoc.chienky`. Dòng tinywar nằm
cùng kết quả truy vấn đó và **không thuộc phạm vi arc ấy** — arc ấy chỉ
sửa 3 lỗ quan sát, không chạm logic purchase option.

### Dữ kiện — nguyên văn từ Query B, không thêm diễn giải

| | |
|---|---|
| Package | `com.vnggames.tankarena.tinywar` |
| Ngày | 2026-09-21 |
| Kết quả | **25/25 hỏng, HAI lần** |
| Thông điệp | `"Product must list all of its existing purchase options. Missing: default"` |
| Chạy lại thành công? | **KHÔNG thấy** trong kết quả Query B |

### ⚠ Vì sao mục này ĐÁNG NGỜ chứ không phải "đã biết rồi"

Chuỗi `"must list all of its existing purchase options. Missing: …"`
**đã được biết và đã được xử lý** — đó chính là lý do đường
read-modify-write tồn tại: `batchUpsertInAppProducts` GET sản phẩm live
trước, rồi gửi TOÀN BỘ purchase option thật trong body PATCH
([publisher-client.ts](../../lib/google-iap-management/google/publisher-client.ts),
khối `OVERWRITE_GET_CONCURRENCY`).

Nhưng mọi ghi nhận trước đây đều là **`Missing: legacy-base`** —
id mà sản phẩm tạo bằng API `inappproducts.*` cũ mang. Ở đây là
**`Missing: default`**, một id thứ BA, chưa từng thấy trong repo.

⚠ Cùng họ với `[feedback_google_purchase_option_id_twin_path]`: "buy" là
**quy ước, không phải hằng số của Google**; legacy mang "legacy-base";
nay xuất hiện "default". Mỗi lần đoán id là một lần hỏng.

### ⚠ ĐỪNG kết luận gì từ việc "không thấy lần chạy lại thành công"

Query B `LIMIT 20` và sắp theo `created_at DESC`. Không thấy lần thành
công **không chứng minh** không có lần nào — có thể nó nằm ngoài 20 dòng.
Phải truy vấn riêng theo package trước khi nói tinywar "vẫn đang hỏng".

### Việc cần làm khi mở arc (chưa làm)

1. Truy vấn `actions_log` riêng cho package này, bỏ `LIMIT 20`, xem có
   lần chạy lại thành công nào sau 2026-09-21 không.
2. ⭐ Chạy lại MỘT lần sau khi O1-O3 đã deploy — nay payload giữ
   `error_details[]` kèm `@type` + `metadata`, nhiều khả năng nêu đích
   danh option id mà Google đang đòi, thay vì chỉ một câu chữ.
3. Chỉ sau đó mới quyết định có sửa `resolve-purchase-options.ts` không.
   **Đừng hardcode thêm `"default"` vào danh sách đoán** — đó là lần thứ
   ba lặp lại cùng một sai lầm; nếu phải sửa thì sửa theo hướng *luôn đọc
   option thật từ Google*, không theo hướng thêm một ứng viên nữa.

⟶ **2026-10-16:** cơ chế khả dĩ đã được census ở mục
`[GOOGLE-ballisticherotwid-missing-legacy-default]` ngay dưới (preview
tính NEW từ mirror DB ⇒ body CREATE chỉ có `"buy"`). Chưa kiểm preview của
tinywar có đúng là NEW không — chạy Q10 của runbook dưới.

---

## `[GOOGLE-ballisticherotwid-missing-legacy-default]` — 彈彈英雄 báo NEW 28 nhưng Google nói sản phẩm ĐÃ có option `legacy`, `default`

**CENSUS XONG (2026-10-16, chỉ đọc + đo bằng mock, không gọi Google). CHƯA SỬA.**
Nhánh `arc-google-missing-purchase-options`. Runbook:
[`queries/read-ballisticherotwid-missing-options.sql`](queries/read-ballisticherotwid-missing-options.sql).

Triệu chứng: `com.vnggames.ballisticherotwid` (TWD, zh-TW), preview `Total 28 ·
NEW 28 · EXISTING 0`, execute: `batch upsert: new API failed
(FAILED_PRECONDITION) Product must list all of its existing purchase options.
Missing: legacy, default — legacy fallback also failed (PERMISSION_DENIED)
Please migrate to the new publishing API.`

### Đã xác lập (code + đo bằng mock; 102 claim, 0 sai qua verifier)

1. **Tool không hỏi Google "có chưa" ở bất kỳ bước nào.** Preview đọc CHỈ mirror
   `google_iap_mgmt.iaps` (`preview/route.ts:6`, `:128`); execute tin `decision`
   client gửi, thiếu thì `"create"` (`execute/route.ts:177`); dòng NEW không có UI
   đổi sang Overwrite (`PreviewTable.tsx:301-327`).
2. **`listIapsForApp(app.id).catch(() => [])`** (`preview/route.ts:128`): lỗi đọc DB
   ⇒ "mọi dòng NEW", HTTP 200, `warnings=[]`, không log — giống từng byte mirror rỗng
   thật (ĐÃ ĐO). Cùng lớp "không biết ≠ không có".
3. **Không có chuỗi "API cũ 403 ⇒ danh sách rỗng"**: Refresh hỏng cả hai đường ⇒ 500,
   KHÔNG ghi gì, mirror giữ nguyên (ĐÃ ĐO). Nhưng list API mới trả `[]` thì KHÔNG
   fallback và ghi `synced 0` (ĐÃ ĐO).
4. **Đường CREATE**: một option `"buy"` (`DEFAULT_PURCHASE_OPTION_ID`,
   `onetime-product-adapter.ts:228`), `allowMissing:true`, `updateMask` gồm
   `purchaseOptions`, KHÔNG GET (`publisher-client.ts:1155`). Discovery: `allowMissing`
   chỉ TẠO khi sản phẩm chưa có; có rồi ⇒ là UPDATE. API mới không có lệnh "chỉ tạo".
   Mock đúng ca này ⇒ tái tạo **từng ký tự** câu lỗi production.
5. **Đường OVERWRITE** GET live rồi gửi đủ `["legacy","default"]` (ĐÃ ĐO) — nếu preview
   nói EXISTS thì body đã đúng về danh sách option.
6. Op `batch upsert` + chỉ một lệnh Google trong try ⇒ sản phẩm bị báo "Missing" CHẮC
   CHẮN đã đi theo dạng CREATE ⇒ **≥ 1 trong 28 SKU đã tồn tại trên Google**. Bao nhiêu
   SKU: CHƯA BIẾT (một `batchUpdate` cho cả 28; một lần throw ⇒ cả 28 bị đếm hỏng).
7. Nửa `PERMISSION_DENIED … Please migrate` là **hệ quả** của fallback vô điều kiện
   (`publisher-client.ts:1239`, bắt MỌI lỗi kể cả FAILED_PRECONDITION), không phải
   nguyên nhân thứ hai. Đây là bằng chứng thật đầu tiên trong repo rằng API cũ bị chặn
   cho một app cụ thể; nó KHÔNG chứng minh ứng viên (c) của chienky (lỗi chienky khác
   chữ: "The caller does not have permission").

### CHƯA BIẾT — cần Manager

- Vì sao mirror không có các SKU (H1/H2/H3a-e/H2b/H5/H7) ⇒ runbook Q0-Q9.
- `legacy` / `default` là gì: repo và tài liệu công khai của Google đều không nêu id
  nào; discovery chỉ nói có "automatically migrated purchase options" (trạng thái
  `INACTIVE_PUBLISHED`) mà không nêu id ⇒ Play Console hoặc một GET đọc.
- `error_details` của lần hỏng có nêu productId không ⇒ runbook Q6 (response HTTP của
  execute KHÔNG mang trường này với lỗi hai-đường).

### Phát hiện phụ (chưa ghi tag riêng)

- `listIapsForApp` không phân trang (`iaps.ts:60-73`) — mirror > 1000 dòng ⇒ SKU xếp
  cuối thành NEW; anh em cùng file đều phân trang.
- Nhãn "synced …" trên trang IAP là `apps.last_synced_at` của refresh DANH SÁCH APP,
  không phải mirror IAP; Refresh IAP chỉ bấm tay, trang bulk import không báo độ cũ.
- Fallback batch gửi `input.body` thô — bản sửa app-currency `19051e8` chỉ vào
  insert/patch (twin-path P1). Fallback còn gửi lại cả dòng overwrite mà guard RMW đã
  cố ý bỏ ra.
- Runbook chienky (`read-chienky-403-full-error.sql:94-96`) map FAILED_PRECONDITION ⇒
  "trạng thái app chặn ghi" — sai với lỗi lần này (lỗi về danh sách option trong body);
  §1 của nó thiếu `error_fallback_http_status/_reasons/_details`.
- Test `publisher-client.dual-path-error.test.ts:148` giả định "Please migrate" đi kèm
  `FAILED_PRECONDITION`; production cho thấy `PERMISSION_DENIED`.
- Tài liệu lệch code: `bulk-import.ts:4-8` (allowMissing:true cho mọi dòng),
  `google-api-reference.md` §3/§12 (ghi còn dùng API cũ), §10 log `package=` (code là
  `pkg=`), `operational-guide.md:73-75`.

### Việc tiếp — rẻ → đắt (CHƯA LÀM)

1. Manager chạy runbook Q0, Q1, Q6, Q8, Q10 (miễn phí, chỉ đọc).
2. Manager grep Railway: `pkg=com.vnggames.ballisticherotwid` (xem dòng
   `method=monetization.onetimeproducts.list` và `BOTH PATHS FAILED op=list`).
3. Manager xem Play Console một SKU (`com.vnggames.ballisticherotwid.0.99`): option ids,
   "Backwards compatible", ngày tạo, người tạo.
4. Manager Export app (đọc Google, KHÔNG ghi DB) ⇒ biết list của Google có thấy 28 SKU
   không.
5. Chỉ sau đó mới thiết kế sửa code — hướng: preview không nuốt lỗi đọc; execute xác
   minh tồn tại phía server bằng cách **đọc option thật từ Google** trước khi chọn
   create/overwrite; **đừng hardcode thêm id** (`legacy`, `default` là lần thứ 3–4 của
   cùng một sai lầm, xem `[GOOGLE-tinywar-missing-default]`).

---

## `[GOOGLE-preview-currency-6dp]` — banner preview nói "theo currency của app" nhưng bảng hiện 0.99 USD → 33.000000 TWD

**CHỈ GHI NHẬN, CHƯA ĐIỀU TRA** (Manager yêu cầu xem riêng, 2026-10-16). Cùng màn
preview bulk import của `com.vnggames.ballisticherotwid`: banner nói giá trị được
hiểu theo currency của app, nhưng bảng hiển thị quy đổi `0.99 USD → 33.000000 TWD`
(6 chữ số thập phân). Hai điểm cần xem: (1) banner và bảng có đang nói hai điều khác
nhau không; (2) vì sao TWD hiện 6 chữ số — gợi ý duy nhất đã thấy là
`microsToDecimal(…, 6)` ở `preview/route.ts:281` (chưa xác minh đó là chỗ render).

⟶ **2026-10-16 (cập nhật):** đã xác minh — `33.000000` CHỈ là hiển thị
(`microsToDecimal(…, 6)`); giá lên dây đúng `Money{TWD, units "33"}`, và 33 TWD là
entry của template. Ưu tiên thấp. Chi tiết: `design-bulk-import-existence-overwrite-safety.md` §1 E3.

⟶ **2026-10-18 — ĐÓNG bởi H4.2.** Dòng "0.99 USD → 33.000000 TWD" là giá đã resolve theo entry
currency-app của tier (`appCurrencyPrice`, `microsToDecimal(…, 6)` ở nhánh cross-currency của preview).
H4.2 xoá hẳn nhánh đó (preview không còn gọi `microsToDecimal`, không còn trả `appCurrencyPrice`); banner
"theo currency của app" đã bị C2.1 thay, và câu ghi chú giá H4.2 không còn nhắc currency app.

---

## `[GOOGLE-refresh-flips-app-currency]` ⚠ — Refresh IAP ghi đè currency/language của app bằng heuristic

**CENSUS XONG, CHƯA SỬA (2026-10-16).** Thiết kế: D9 trong
[`design-bulk-import-existence-overwrite-safety.md`](design-bulk-import-existence-overwrite-safety.md).

`batchSyncIapsFromGoogle` (`repository/iaps.ts:759-769`) ghi đè **vô điều kiện**
`apps.default_currency` = currency của vùng **US** của sản phẩm đầu tiên (adapter
`onetime-product-adapter.ts:124-133`) và `default_language` = listing đầu tiên hoặc
`"en-US"` bịa ra (`:152-153`). Google v3 **không có** currency mặc định của app
(discovery `OneTimeProduct`); comment `iaps.ts:623-627` sai. Đã đo: app TWD/zh-TW bị lật
thành USD/en-US ở lần Refresh IAP đầu tiên. Hệ quả: lật nghĩa cross-currency / refuse
google_default / header chung / custom price của **cả app**, và form IAP đòi title en-US.
Mang tính hệ thống: mọi app có Refresh IAP qua v3 mà sản phẩm đầu có vùng US. Runbook
E-Q6 liệt kê app nghi bị lật.

⛔ **Liên quan an toàn giá:** với `com.vnggames.ballisticherotwid`, KHÔNG chạy lại bulk
import (mirror nay đầy ⇒ Overwrite 28 sản phẩm đang bán; ngữ nghĩa Overwrite thay toàn bộ
giá/vùng/availability/state của option đích — D10). Xem §1 E4 của tài liệu thiết kế.

---

## `[GOOGLE-declarable-locales-unmeasured]` — 82 locale khai báo được chưa đối chiếu Google (Q2)

**BACKLOG (Manager 2026-10-16).** Thẻ khai báo language của app (C2) chỉ nhận 82 locale của template
(`GOOGLE_LOCALE_OPTIONS`, `lib/google-iap-management/app-defaults.ts` `DECLARABLE_LANGUAGES`).
Chưa đo danh sách locale Google Play thật sự nhận (P38: một danh sách của vendor là danh sách API
đồng ý). App có language mặc định ngoài 82 locale ⇒ không khai báo được. Không chặn gì từ C2.1
(language không còn là điều kiện import).

---

## `[GOOGLE-bulk-import-language-unused]` — bulk import không dùng language của app (gắn D10)

**BACKLOG (Manager 2026-10-16).** `buildProduct` cố định `defaultLanguage: "en-US"` và tổng hợp
listing `en-US` khi file thiếu (`orchestration/bulk-import.ts:221-226, :262`). Language Manager khai
báo trên trang app không đi vào bất kỳ body nào của bulk import. Xử lý cùng D10 (Overwrite không thay
mù listing). D11 (giữ currency giữa preview và execute) — ĐÓNG, hết ý nghĩa sau quyết định
"currency trong file là nguồn duy nhất cho giá".

---

## `[GOOGLE-refresh-stamps-degraded-read]` — route Refresh vẫn đóng dấu "đầy đủ" cho lượt đọc suy giảm (D5)

**GHI NHẬN 2026-10-16 (C2.1).** Route IAP refresh đóng dấu `iaps_last_synced_at` khi `failed === 0`
(`iaps/refresh/route.ts`), kể cả khi chính bộ reconcile đã đánh giá lượt đọc là suy giảm
(`flag_reconcile_skipped = 'incoming_below_50pct_of_cached'`, `repository/iaps.ts`) hoặc trả 0 sản
phẩm. Backfill C2.1 loại cả hai — route chưa. Cũng: fallback legacy có thể trả một tập con mà audit
vẫn `failed=0` (chỉ log Railway `list fallback pkg=` cho biết); vòng phân trang dừng im lặng sau
100 trang. Xử lý trong chunk D5 (C6).

⟶ **2026-10-17 — C2.1a:** ca "Google trả 0 sản phẩm trong khi mirror còn item" ĐÃ SỬA: route không
đóng dấu, ghi log + audit + báo Manager (`decideMirrorStamp`; ca thật `vng.games.tamquoc.chienky`
2026-10-12, mirror 16). Mirror rỗng + Google rỗng vẫn đóng dấu. CÒN MỞ ở C6: lượt đọc
`incoming_below_50pct_of_cached` (route vẫn đóng dấu), fallback legacy trả tập con, trần 100 trang.

---

## `[GOOGLE-custom-prices-value-based-row-500]` — giá tuỳ chỉnh trên dòng "Price" chung có số lẻ ⇒ cả lượt push lỗi 500

**GHI NHẬN 2026-10-16 (review C2.1, ĐÃ ĐO trên code thật, Google mock).** App TWD/VND, header
`Price` (không ghi currency), giá `0.99`, nguồn Google Conversion, có custom prices ⇒ execute trả
**HTTP 500 cho cả batch**: dòng custom bỏ qua cross-currency (`bulk-import.ts:512`), rồi
`buildProduct` gọi `decimalToMicros("0.99", "TWD")` và ném (`bulk-import.ts:254`, gọi ở `:1131`).
Wizard không chặn trước (`computePrecisionViolations` bỏ qua dòng không phải same_currency;
CustomPricesDialog cho Save khi không có entry currency app dưới Google Conversion). Xử lý trong
chunk H4 (currency trong file là nguồn duy nhất) — C2.1 không đổi logic định giá.

⟶ **2026-10-18 — ĐÓNG bởi H4.1 + H4.2.** Header `Price` (không currency) bị từ chối từ H4.1; từ H4.2
mọi dòng (kể cả custom) neo vào giá file đã qua `filePriceOf` ở pre-pass của orchestrator — giá FILE (và
GT) sai bị từ chối TỪNG DÒNG (`file_price_invalid`), không còn ném ra ngoài try. (Entry của TIER thì vẫn
có thể ném — xem `[GOOGLE-bulk-import-db-throws-outside-try]`.)

---

## `[GOOGLE-parser-sheet-offset-columns]` — sheet có vùng dữ liệu không bắt đầu ở cột A ⇒ mọi cột đọc lệch

**GHI NHẬN 2026-10-17 (truy vết H4; ĐÃ CHẠY THỬ bằng `parseIapTemplate` thật).** Header được đánh số
từ cột đầu vùng dữ liệu (`excel-parser.ts:385-386`: `for (let c = range.s.c; …) headerRow.push(…)`),
nhưng ô lại được đọc theo vị trí đó như số cột TUYỆT ĐỐI (`:425` SKU, `:434` giá, `:444-445` GT). Đo:
sheet có `!ref = "B1:C2"` (cột A trống) ⇒ **0 dòng**, không lỗi, chỉ cảnh báo "No data rows found
after the header." — dòng bị bỏ im lặng ở `:426` (`if (sku === "") continue;`). Cùng dữ liệu nhưng
`!ref` bắt đầu từ A ⇒ đọc đúng 1 dòng. Chỉ xảy ra khi thẻ `<dimension>` của file bắt đầu sau cột A
(Excel ghi như vậy khi cột A trống). Bố cục khác có thể đọc giá / GT từ cột bên cạnh. Chưa có test nào
với `range.s.c > 0`. Ngoài H4.

---

## `[GOOGLE-bulk-import-duplicate-sku]` — cùng một Product ID xuất hiện 2 lần trong file không bị chặn

**GHI NHẬN 2026-10-17 (truy vết H4).** Không có chỗ khử trùng SKU ở parser, preview, execute,
orchestrator hay wizard (grep `duplicate|seenSku|dedupe` trên 5 file đó: 0 kết quả). Hai dòng cùng
SKU được gửi chung một batch; kết quả trên Google (một dòng thắng, hay cả batch bị từ chối — sau Q8
không còn fallback đỡ): CHƯA BIẾT. Custom prices khoá theo SKU
(`BulkImportWizard` → `execute-payload.ts` `state.customPrices[r.sku]`) nên một bộ custom áp cho cả
hai dòng. Ngoài H4.

---

## `[GOOGLE-bulk-import-db-throws-outside-try]` — lỗi DB khi tra template ở execute làm hỏng CẢ batch

**GHI NHẬN 2026-10-17 (truy vết H4).** Các lần tra template trong `executeBulkImport` nằm ngoài mọi
try: `bulk-import.ts:553`, `:566`, `:599` (cross-currency), `:854` (tier đã chọn), `:898` (SKU),
`:923` (probe); và hai lần đọc mức batch `:766` (`templateExists`) và `:786` (`findTemplateId`). Chỉ
probe ở `:912` có bọc. Lỗi DB ⇒ cả request lỗi, `import_batches` kẹt
`IN_PROGRESS`. Trong khi đó cảnh báo ở preview hứa "affected rows will be REFUSED at push time
(per-row fail-soft)" (`preview/route.ts:440`) — sai. H4.2 xoá nhánh cross-currency (`:553-599`) và
đổi lỗi GIÁ thành từ chối dòng; các lần tra template còn lại vẫn mở sau H4.

⟶ **2026-10-18 — H4.2:** ba lần tra của nhánh cross-currency (`:553`, `:566`, `:599` cũ) đã bị xoá cùng
nhánh đó, và lỗi GIÁ CỦA FILE (giá chính + GT) giờ là từ chối từng dòng. CÒN MỞ:
- các lần tra template còn lại vẫn ngoài try — `templateExists`, `findTemplateId`, tier đã chọn, SKU,
  entries của probe (số dòng đã đổi sau H4.2; tra bằng tên hàm trong `bulk-import.ts`);
- **entry của tier sai độ chính xác** (ĐÃ ĐO ở review H4.2): parser template đổi giá không kèm currency
  (`pricing-template-parser.ts` `decimalToMicros(decimal)`), nên tier có TW = TWD 30.5 được lưu. Khi một
  dòng khớp tier đó, `buildProduct` → `decimalToMicros(r.priceDecimal, r.currency)` ném NGOÀI try ⇒ cả
  batch 500 (dòng hợp lệ cũng không gửi), `import_batches` kẹt `IN_PROGRESS`. Sửa đúng chỗ: kiểm độ chính
  xác theo currency MỘT lần khi tải template lên (cùng luật `getCurrencyDecimals`).

⟶ **2026-10-19 — H4.3:** entry tier sai độ chính xác (và entry 0) giờ là từ chối DÒNG `tier_price_invalid`
(`storedRegionPriceOf`, kiểm ngay sau khi tra); thêm lưới `price_build_failed` quanh `buildProduct`. Mục
"entry của tier sai độ chính xác" ở trên ĐÓNG. CÒN MỞ — cơ chế KHÁC (lỗi DB/mạng hoặc logic, không phải dữ
liệu giá), vẫn ném ngoài try, `import_batches` kẹt `IN_PROGRESS` (đã đo ở map H4.3): `templateExists`, "chưa
upload template", `findTemplateId`, tra tier đã chọn, tier đã chọn mất entry (drift), có ứng viên mà không
chọn, tra SKU, tra entries của probe, >1 ứng viên, `BATCH_MAX` (101 dòng ⇒ 500 + IN_PROGRESS). Đề xuất riêng
(cần Manager): finalize-in-finally cho `import_batches` (KB P10 — mặc định FAILED, kiểm `error` của update)
xoá "kẹt IN_PROGRESS" cho cả 10 chỗ nhưng KHÔNG biến chúng thành từ chối dòng. Ba update của `import_batches`
hiện không kiểm `error` (P2).

⟶ **2026-10-19 — H4.4:** finalize-in-finally (Manager chốt) — chỗ ném nào cũng được finally đóng `FAILED`
(test `bulk-import.finalize.test.ts`), kèm một dòng audit `closed_by: "finally"` có nguyên nhân. Ngoại lệ duy
nhất: chính lần GHI đóng hàng bị DB từ chối / ném — khi đó có log `import_batches close FAILED|THREW` và hàng
còn `IN_PROGRESS`. Ba lần ghi đóng hàng giờ
kiểm `error` (P2). CÒN MỞ: các chỗ ném đó vẫn làm CẢ batch lỗi (500) thay vì từ chối từng dòng — một lỗi DB
khi tra tier của một dòng chặn mọi dòng khác.
---

## `[GOOGLE-custom-prices-separator-zero]` — giá CUSTOM chưa áp luật (a) dấu phân cách / (b) giá 0

**GHI NHẬN 2026-10-18 (review H4.2, ĐÃ ĐO).** Quyết định (a)/(b) của Manager nêu ô FILE và GT. Giá custom
gõ trong dialog đi đường khác: `validateCustomPrices` → `validateDecimalForCurrency` (dialog),
`execute/route.ts` (cùng hàm), `decimalToMicros` (pre-pass custom của orchestrator). Cả ba nhận "26.000" VND
(= 26 VND, Hotfix 5 cho số 0 lẻ ở cuối) và "0". Dialog có cảnh báo `flagSuspiciousDrops` khi có cột tham
chiếu (tier / giá quy đổi), nhưng không chặn Save. Google trả gì cho 26 VND / 0 JPY: CHƯA BIẾT.
⚠ Validator và `RegionPriceCell` dùng chung với form sửa đơn lẻ (header `CustomPricesDialog.tsx` cấm hai
nơi lệch nhau) ⇒ mở rộng (a)/(b) đổi luôn form đơn lẻ. **Cần Manager:** có áp (a)/(b) cho giá gõ tay từng
nước không? Nếu có: thêm luật MỘT lần trong `validateDecimalForCurrency` (hoặc một wrapper cả hai bề mặt
gọi) — route và orchestrator thừa hưởng; không vá riêng dialog.

⟶ **2026-10-19 — ĐÓNG bởi H4.3** (Manager chốt: áp (a)/(b), form đơn lẻ đổi theo). Cách làm: phương án
"wrapper", KHÔNG phải "trong validateDecimalForCurrency" — đã đo, phương án đó chặn mọi lần sửa item mặc
định VND vì form tự điền `"26000.00"`. Một hàm `statedPriceOf` / `statedPriceError` (file-price.ts) cho
file + dialog + form + kiểm lại custom ở server; sửa hai nguồn điền (form-state.ts, route catalog). Phía
server của sửa đơn lẻ: xem `[GOOGLE-single-edit-server-price-rules]`.

---

## `[GOOGLE-bulk-import-no-landed-price-check]` — bulk import không kiểm giá đã thật sự lên Google

**GHI NHẬN 2026-10-17 (truy vết H4, bất đối xứng twin-structure — KB P8).** Sửa đơn lẻ so giá gửi với
giá Google trả về (`update-iap.ts:284` `verifyPricingLanded`). Bulk import coi dòng là
created/overwritten khi slot phản hồi khác null và `syncIapFromGoogle` chạy được
(`bulk-import.ts:1183-1199`); không so sánh gì. Giá Google trả về được lưu vào `iap_prices`; giá GỬI
chỉ còn giá VN của dòng template/custom (`per_row_diagnostic`), bảng giá gửi đầy đủ và neo không được
lưu (H4.4 bổ sung neo vào audit). Ngoài H4.

---

## `[GOOGLE-single-edit-legacy-fallback-currency]` — fallback legacy của sửa đơn lẻ dùng currency cache của IAP

**GHI NHẬN 2026-10-17 (truy vết H4).** Comment `update-iap.ts:272` nói "The app's configured currency,
from cache", nhưng `:276` truyền `input.current.iap.default_currency` — currency của chính IAP, do
adapter lấy từ vùng US (hoặc vùng đầu) của phản hồi Google, không phải `apps.default_currency`.
`legacyFallbackBody` (`publisher-client.ts:686-701`) chỉ đổi `defaultPrice` khi currency khác giá trị
đó VÀ bảng giá có một entry bằng currency đó ⇒ fallback căn defaultPrice theo currency vùng US của IAP thay vì currency app; app không phải USD
⇒ API cũ nhận sai currency. Thuộc 5 chỗ fallback còn lại của chunk D4
(Manager 2026-10-17: H4 chỉ bỏ fallback của đường batch upsert).
*2026-10-19:* ĐÃ ĐO trên mock — base gõ VND 26 tới API cũ thành USD 0.99. Phương án D4 **(A) tách riêng, làm sau
`[GOOGLE-single-edit-server-price-rules]`** là ĐỀ XUẤT, CHƯA CHỐT (design doc §6.5).

---

## `[GOOGLE-single-edit-server-price-rules]` — sửa/tạo đơn lẻ: server chưa áp (a)/(b), tier sai được gửi thẳng

**GHI NHẬN 2026-10-19 (map H4.3, ĐÃ ĐỌC code).** Từ H4.3 form đơn lẻ chặn "26.000" (VND…) và giá 0 ở CLIENT
(`statedPriceError`). Phía server (`iaps/[sku]` PATCH → `update-iap.ts`, `iaps` POST → `create-iap.ts`) chỉ
dùng `decimalToMicros` (nhận số 0 lẻ ở cuối, nhận 0) — tab cũ hoặc gọi API trực tiếp lách được. Bất đối xứng
với bulk (KB P8). Cùng họ: một entry tier sai độ chính xác có BA kết quả — bulk từ chối dòng (H4.3), tạo đơn
lẻ ném (create-iap.ts, `decimalToMicros(…, currency)`), SỬA đơn lẻ GỬI THẲNG lên Google (dòng tier
`dirty:false` ⇒ `update-iap.ts` đổi không kèm currency). ⚠ Không áp (a) phía server cho base edit-mode và dòng
tier (chuỗi máy tạo `"x.000000"` / `"x.00"`); chỉ dòng Manager gõ (dirty) + base ở create mode + entry tier
qua `storedRegionPriceOf`. Cần Manager.

**⏸ HOÃN 2026-10-19 (Manager).** Không gấp: bulk (đường dùng chính) đã sửa ở H4; form đơn lẻ chặn "26.000"/0
ở trình duyệt từ H4.3; prod 0 entry tier hỏng; quy đổi lỗi hiếm. Lỗ còn lại chỉ ở server (tab cũ chưa reload /
gọi API trực tiếp). **Kế hoạch đầy đủ** (chỗ tính giá file:line, bảng 3 đường × ca, choke point, test bất biến +
10 mutation, D4/D10): `design-bulk-import-existence-overwrite-safety.md` §6 — tại commit `64557c9`, mọi ô ĐÃ ĐO
là đo trên mock.

**CHỜ Manager quyết (đề xuất hiện có trong ngoặc):**
- **Q-a** Khi sửa, tier thắng hay quy đổi thắng? (hôm nay quy đổi đè tier, `update-iap.ts:233`; UI nói tier thay)
- **Q-b** Quy đổi lỗi khi sửa: từ chối mọi lần đổi base, hay theo đúng bulk (từ chối khi không USD, gửi khi USD)?
  Sửa chỉ title mà quy đổi lỗi có cho qua?
- **Q-c** Server biết base do Manager gõ bằng cách nào? (đề xuất: gửi `baseDirty` form đã có + một contract marker
  như `pricing_rule`; tab cũ nhận 409 "reload")
- **Q-d** Kiểm cặp vùng/currency cho dòng gõ tay? (đề xuất: không — giá custom của bulk không kiểm)
- **Q-e** Base đơn lẻ qua `statedPriceOf` hay `filePriceOf`? (đề xuất: `statedPriceOf`; `filePriceOf` sẽ từ chối
  ARS/CNY mà form cho chọn)
- **Q-f** Giá gõ tay dưới tier, cái nào thắng? (bulk: custom thắng; đơn lẻ: tier thay hết) — chưa có đề xuất
- **Q-g** Giá 0 do Google viết có cho qua? (đề xuất: cho qua, KB (d))

**SQL chỉ-đọc định cỡ Q-c** (cột có trong schema: init `:137`, deleted_on_google `:22`):
```sql
SELECT count(*) FROM google_iap_mgmt.iaps
WHERE default_currency IS NULL AND deleted_on_google_at IS NULL;
```

---

## `[GOOGLE-template-upload-price-check]` — tải pricing template lên không kiểm giá theo currency

**GHI NHẬN 2026-10-19 (map H4.3, ĐÃ ĐO).** `pricing-template-parser.ts` đổi giá bằng `decimalToMicros(decimal)`
KHÔNG kèm currency ⇒ lưu được TWD 30.5, giá 0, và "26.000" dạng chữ (lưu thành 26 — mất văn bản gốc, nên
lúc push KHÔNG thể phát hiện); cặp vùng/currency không kiểm (AR ARS lưu được, gửi được). Ô sai hiện bị cảnh báo
rồi BỎ (vùng đó rơi về quy đổi của Google — giá Manager không viết). H4.3 chặn được độ chính xác + 0 lúc push
(`tier_price_invalid`), không chặn được "26.000". Sửa đúng: kiểm qua `statedPriceOf` (theo kiểu ô) lúc tải lên,
TỪ CHỐI cả file (422) thay vì cảnh báo + bỏ. Kèm một SQL đọc-thôi điểm danh `pricing_template_entries` hiện có
(micros không chia hết 10^(6-decimals), entry 0, cặp sai) để biết template nào đang dính `tier_price_invalid`.

---

## `[GOOGLE-bulk-import-hub-run-reuse]` — retry sau execute lỗi gửi lại run đã đóng; preview lại bỏ rơi run cũ

**GHI NHẬN 2026-10-19 (map H4.3, ĐÃ ĐO bằng probe wizard).** (1) Execute trả lỗi ⇒ wizard về preview, Push bật
lại, lần bấm sau gửi CÙNG `hub_run_id` mà server đã đóng FAILED (Hub xử lý lần đóng thứ hai thế nào: CHƯA BIẾT).
(2) Back rồi Preview lại ⇒ mỗi lần start một run mới, run trước không bị cancel ⇒ kẹt RUNNING. Có từ trước H4;
hộp xác nhận H4.3 KHÔNG đổi hành vi này (Cancel không đụng run). Sửa cần quyết định: retry mở run mới, hay
retry không theo dõi.


---

## Phát hiện ngoài phạm vi khi lập kế hoạch `[GOOGLE-single-edit-server-price-rules]` (2026-10-19, đo trên mock tại `64557c9`)

Mỗi dòng một mục; chưa làm. Nguồn: design doc `design-bulk-import-existence-overwrite-safety.md` §6.7.
- `[GOOGLE-edit-title-only-pins-2022-02]` — sửa chỉ title mà quy đổi lỗi vẫn patch, ghim regionsVersion `2022/02` (bẫy Hotfix 9 trên một lần sửa không đổi giá).
- `[GOOGLE-bulk-usd-conversion-failed-pin]` — dòng USD của bulk mà quy đổi lỗi vẫn gửi, ghim `2022/02`, trái với chính comment lý do từ chối dòng không-USD (`bulk-import.ts:1023-1025`).
- `[GOOGLE-missing-tier-asymmetry]` — tier không tồn tại: đơn lẻ trả 404 (`iaps/route.ts:160-167`), bulk ném lỗi cả batch.
- `[GOOGLE-edit-noop-success-toast]` — form không đọc `hasChanges`, báo "updated on Google Play" cả khi server trả noOp (`IapForm.tsx:739`).
- `[GOOGLE-edit-dirty-after-base-change]` — dòng dirty gõ SAU khi đổi base bị quy đổi của server đè (`update-iap.ts:231-239`), không có cảnh báo (cảnh báo của form chỉ đếm dòng dirty lúc re-derive).
- `[GOOGLE-edit-first-buyoption-price]` — sửa chỉ title ghi giá của buyOption ĐẦU TIÊN đè lên `legacy-base` (đọc chọn option đầu `onetime-product-adapter.ts:108-115`, ghi chọn option legacy `:313-323`); thứ tự option thật của Google CHƯA BIẾT. Gần D10.
- `[GOOGLE-common-regions-ar-ars]` — `COMMON_REGIONS` để AR=ARS (`regions.ts:45`), còn snapshot Play tính AR bằng USD (`play-regions.snapshot.ts:76`). Cùng họ `[GOOGLE-common-regions-usd-default]`.

---

## `[GOOGLE-twd-decimals]` — code coi TWD là tiền 0 số lẻ, nhưng Google đang giữ một giá TWD 6.30

**GHI NHẬN 2026-10-19.** `currency-precision.ts:45-46` (Hotfix 5, `e42683b`, 2026-05-21) đặt `TWD: 0` ("Google
Play Console treats TWD as 0 in practice") — CHƯA TỪNG ĐO. Dữ liệu thật ngược lại: `com.vng.passsdk.2508111020`
có TW = **TWD 6.30** do Google viết (`diagnostics/price-precision-audit.md:22-24`; 1/1.661 giá TWD trong cache có
số lẻ). ⇒ Tool có thể đang TỪ CHỐI giá TWD hợp lệ ở mọi chỗ Manager gõ hoặc tool giữ giá (form, file bulk, custom,
entry tier qua `storedRegionPriceOf`). Giá do Google viết không bị đụng (gửi lại nguyên byte, KB §10.13.K (d)).
HUF (cũng 0 thay vì 2 theo ISO 4217) khớp dữ liệu: 0/1.661 giá có số lẻ.

**Ảnh hưởng hiện tại:** 0 entry trên prod (SQL kiểm template trước H4: Q4 0 dòng).

**Đường đúng khi làm:** đo KHÔNG ghi — **không ghi thử lên Google chỉ để đo.** Ví dụ: SQL chỉ-đọc đếm giá TWD/HUF
có số lẻ trong cache (`iap_prices.price_micros` TEXT, init `:184-191`):
```sql
SELECT currency, count(*) FROM google_iap_mgmt.iap_prices
WHERE currency IN ('TWD','HUF') AND (price_micros::numeric % 1000000) <> 0
GROUP BY currency;
```
cộng với tài liệu/Play Console của Google về độ chính xác TWD. Đổi bảng ⇒ SQL `queries/audit-template-entries-h4.sql`
và test ghim của nó đổi theo (bảng `decimals` sinh từ code).
