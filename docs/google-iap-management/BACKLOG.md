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

## `[GOOGLE-regions-unmeasured]`

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

---

## `[GOOGLE-template-column-order]` — G2-Q3, đẩy sang arc G1

**Trạng thái:** Manager đã chốt đẩy sang G1 vì cần **migration**.

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
| *(ghi chú tài liệu)* User Guide mục **Apple** Pricing matrix còn hướng dẫn bấm "Export CSV" | 2026-08-31, commit riêng `fix-apple-guide-export-xlsx` | Grep toàn guide ra **4 chỗ**, không phải 3 — chỗ thứ tư (`<li>Export bảng giá ra CSV…`) **không chứa cụm "Export CSV"** nên sửa theo trí nhớ chắc chắn sót. Sót của arc `[TEMPLATE-xlsx]` phía Apple |
