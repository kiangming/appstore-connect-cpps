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

## ⚠ `[GOOGLE-common-regions-usd-default]` — `defaultCurrencyForRegion` sai 70/173, và giá trị sai **TỚI ĐƯỢC** lệnh ghi Google

**Trạng thái:** ⚠ **CẦN SỬA — đã nâng mức 2026-09-01 sau khi đo 3b.** Trước đó
ghi là "backlog, chưa rõ có tới payload không". Đã trace tới nơi, **có tới**.

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

