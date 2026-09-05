# UAT — Google IAP · Export picker: phân trang + shift-click

**Arc:** `arc-google-export-picker-paging` · **Đã ship:** `0007c23` trên `origin/main`.
**Đường đi:** `/google-iap-management/apps/<packageName>` → nút **`Export list`** → bước 1 (**`Export list — items to include`**).

> ⚠ **Mọi nhãn dưới đây trích NGUYÊN VĂN từ component** (P27), kèm `file:line`.
> Nếu màn hình hiện chữ **khác**, đó là một phát hiện — ghi lại y nguyên chữ đã thấy, đừng diễn giải.

> ⚠ **Chọn app có ≥ 51 item** cho mục 1–4 (mặc định 50 dòng/trang ⇒ dưới 51 thì chỉ có một trang).
> Mục 5 **cần** một app **< 50 item**.

---

## 1. Phân trang + Rows — [`IapSelectionList.tsx:528`](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L528)

- [ ] Mở picker. Cuối danh sách có thanh footer: bên trái `Showing 1–50 of <N>`, bên phải cụm **`Rows`** → **Prev** → `Page 1 of …` → **Next**.
- [ ] Ô **`Rows`** (aria-label **`Rows per page`**, [:532](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L532)) chỉ có đúng **3** lựa chọn: **20 / 30 / 50**, đang chọn sẵn **50**.
- [ ] Bấm **Next** → sang trang 2, danh sách đổi nội dung.

**⚠ Kỳ vọng M9 — đổi số dòng KHÔNG nhảy về trang 1.** Ở `Rows=20`, bấm **Next** hai lần (đang ở trang 3), rồi đổi `Rows` sang **30**.
→ Phải **vẫn thấy quanh những dòng vừa xem**, KHÔNG bị ném về trang 1.

## 2. Bộ đếm hai tầng — [`:427`](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L427)

- [ ] Góc phải thanh chọn có **hai dòng**: tổng (vd `197 selected`) và, ngay dưới, `<X> of <Y> on this page`.
- [ ] Bỏ tick vài dòng ở trang 1 → sang trang 3. Dòng trên vẫn là **tổng của cả app**, dòng dưới là **của riêng trang đang xem** — hai con số **được phép khác nhau**.
- [ ] Khi có item đã chọn nằm ngoài trang, hiện đúng câu:
      **`<N> selected items are not on this page — still selected, still exported.`** ([:450-452](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L450))

## 3. ⚠ MỤC QUAN TRỌNG NHẤT — bỏ tick ở trang này, đi trang khác, export

> Đây là rủi ro lớn nhất của arc. Picker **mở ra là tick sẵn tất cả**, nên việc thật của mình là **BỎ TICK**.

- [ ] Ở **trang 1**: bỏ tick **2 item**, ghi lại SKU của chúng.
- [ ] Sang **trang 3**: bỏ tick thêm **1 item**, ghi lại SKU.
- [ ] Bấm **`Next — choose countries (<n>)`** → chọn nước → xuất file.
- [ ] **Mở file Excel:** **cả 3 SKU vừa bỏ tick đều KHÔNG có mặt**, và tổng số dòng = tổng item **trừ 3**.

**⚠ Nếu bất kỳ SKU nào trong 3 cái đó xuất hiện trong file → DỪNG, báo ngay.** Đó đúng là lớp lỗi arc này sinh ra để diệt.

## 4. Hai nút chọn hàng loạt — phạm vi phải khác nhau

- [ ] **Checkbox đầu cột tick** (aria-label **`Select all on this page`**, [:407](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L407)) — nhãn đọc `Select all <N> on this page` hoặc `Clear <N> on this page`. **Chỉ tác động TRANG đang xem.**
- [ ] **Nút ở thanh trên** — nhãn `Select all <N> matching` / `Clear all <N>` ([:370-371](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L370)). **Tác động TOÀN BỘ** item đang khớp.
- [ ] ⚠ Khi trang **đang tick đủ**, checkbox đầu cột đổi thành **`Clear …`** và bấm vào thì **BỎ TICK cả trang** — *đây là chủ đích, không phải lỗi.*
- [ ] Gõ vào ô tìm kiếm (aria-label `Search items`) → nút thanh trên đổi số theo **kết quả lọc**, không phải tổng app.
- [ ] **Shift-click:** tick một dòng, giữ **Shift** rồi bấm một dòng khác **cùng trang** → tick cả dải, và **không mất** những gì đã tick ở trang khác.
- [ ] Shift-click ngay sau khi **đổi trang** → hiện câu:
      **`Shift-click selects a range from the last row you ticked, within the rows shown. Ticked this one on its own.`** ([:463-464](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L463))

## 5. `Selected only` + app nhỏ (< 50 item)

- [ ] Bấm **`Selected (<N>)`** ([:390](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L390)) → chỉ còn các dòng đã tick. Bấm **`All`** → quay lại đầy đủ.
- [ ] ⚠ Ở chế độ **`Selected (…)`**, nút `Select all … matching` **BIẾN MẤT** — *chủ đích* ([:362](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L362)): chế độ này để **rà soát / bỏ bớt**, không phải để thêm. Muốn thêm thì bấm **`All`** trước.
- [ ] **Mở app < 50 item:** **KHÔNG** có Prev/Next (thừa), nhưng ô **`Rows`** vẫn còn. Hai tầng đếm khi đó **bằng nhau**.
- [ ] Bỏ tick hết → nút dưới đổi thành **`Select at least 1 item`** và **bấm không được** ([`ExportScopeDialog.tsx:218`](../../components/google-iap-management/iap-list/ExportScopeDialog.tsx#L218)).

---

## Ghi kết quả

| Mục | Đạt | Chữ đã thấy trên màn (nếu khác) |
|---|---|---|
| 1 Phân trang + Rows | ☐ | |
| 2 Đếm hai tầng | ☐ | |
| **3 Bỏ tick xuyên trang → file** | ☐ | |
| 4 Hai nút + shift-click | ☐ | |
| 5 Selected only + app nhỏ | ☐ | |

⚠ **Đổi filter status (All / Active only / Inactive only) sẽ RESET lựa chọn về "tick hết" của nhóm mới** — chủ đích, có ghi trong code. Đừng báo là lỗi; nếu thấy khó dùng thì đó là **feedback thiết kế**, ghi riêng.
