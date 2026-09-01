# UAT — Export item list (arc G-EXPORT)

**Cho:** Manager bấm thử trên tool.
**Màn:** `/google-iap-management/apps/<packageName>` — chọn một app có nhiều IAP.
**Ngày soạn:** 2026-09-01 · commit `0955ff1`.

> ⚠ **Mọi chuỗi in `đậm nghiêng` dưới đây là NGUYÊN VĂN đọc từ component**, không
> viết lại từ trí nhớ. Thấy chữ khác chữ ở đây ⇒ đó là phát hiện, ghi lại.

> ⚠ **Không có bước nào ở đây tốn thêm request Google ngoài lần bấm Export cuối.**
> Mở dialog, đổi filter, gõ tìm kiếm, tick/bỏ tick — tất cả đọc dữ liệu đã có
> trên màn. Nếu thấy màn quay vòng / chờ mạng khi làm mấy việc đó ⇒ **báo ngay**,
> đó là lỗi.

---

## A. Vào luồng

| # | Bấm gì | Kỳ vọng thấy |
|---|---|---|
| A1 | Nút **Export list** trên toolbar (cạnh **Refresh**) | Mở hộp thoại, tiêu đề ***Export list — items to include***, dòng phụ ***Step 1 of 2 · countries are chosen next*** |
| A2 | — | ⚠ **Không** phải tải file ngay. Trước arc này bấm là tải luôn. |

## B. Bước 1 — filter trạng thái

| # | Bấm gì | Kỳ vọng thấy |
|---|---|---|
| B1 | Nhìn nhóm 3 lựa chọn | ***All items*** · ***Active only*** · ***Inactive only***, mỗi dòng có **số đếm** bên phải |
| B2 | Cộng hai số | `Active only` + `Inactive only` = `All items` |
| B3 | ⚠ Đọc dòng chữ nền vàng ngay dưới | ***Google calls a purchase option ACTIVE or INACTIVE_PUBLISHED; this tool counts both as "Active". "Inactive" is everything else.*** |
| B4 | — | ⚠ **B3 là mục quan trọng nhất của phần này.** Nếu dòng đó biến mất hoặc rút gọn thành kiểu "Filter by status", **báo ngay**: nhãn "Active" khi đó đang nói dối, vì nó gộp cả state `INACTIVE_PUBLISHED` của Google. |
| B5 | Đọc dòng chữ xám dưới nữa | Nói số đếm lấy từ danh sách trên màn, đồng bộ lần **Refresh** gần nhất, và file dựng live nên nếu lệch thì **file theo Google** |
| B6 | Chọn **Active only** | Danh sách item bên dưới **chỉ còn item active**; số ở nút đi tiếp đổi theo |

## C. Bước 1 — picker chọn item

| # | Bấm gì | Kỳ vọng thấy |
|---|---|---|
| C1 | Nhìn tiêu đề khối danh sách | ***Items (N of M selected)*** |
| C2 | — | ⚠ **Mặc định tick HẾT.** Mở lên là mọi item đã có dấu tick. |
| C3 | Nút đi tiếp | ***Next — choose countries (N)***, N = số item đang tick |
| C4 | Bỏ tick 1 item | N ở nút **giảm 1** |
| C5 | ⚠ Bỏ tick **hết** | Nút **mờ đi**, đổi chữ thành ***Select at least 1 item*** |
| C6 | — | ⚠ **C5 quan trọng:** nút phải MỜ. Nếu bấm được và vẫn ra file ⇒ báo ngay (nó sẽ export nhầm "tất cả"). |
| C7 | Bỏ tick hết rồi bấm ***Select all (N)*** | Tick lại toàn bộ, nút sáng lại |
| C8 | Gõ vào ô ***Search by SKU or name…*** một chuỗi khớp vài item | Danh sách rút gọn; **bộ đếm `N selected` KHÔNG tụt** |
| C9 | — | ⚠ **C8 quan trọng:** nếu số tụt khi gõ tìm kiếm ⇒ tool đang làm mất lựa chọn, báo ngay. |
| C10 | Với search đang bật, nhìn dòng chữ nhỏ | Nói còn bao nhiêu item đã tick đang **bị search che** (kiểu *"… hidden by the current search — still selected, still exported."*) |
| C11 | Với search đang bật, bấm ***Select all*** | Chỉ tick/bỏ tick **những item khớp search**, không đụng phần còn lại |
| C12 | Xoá search, cuộn xuống cuối (app > 50 item) | Nút ***Show more*** — chữ nói còn bao nhiêu VÀ nói chúng **vẫn nằm trong file** |
| C13 | — | ⚠ **C12:** dòng chưa hiện **vẫn được export**. Nếu nút chỉ ghi "Show more" trơn ⇒ báo. |
| C14 | Đổi lựa chọn trạng thái (vd All → Active only) | Tick **reset về toàn bộ item của lựa chọn mới**, ô search rỗng lại |

## D. Bước 2 — chọn nước (dialog dùng chung)

| # | Bấm gì | Kỳ vọng thấy |
|---|---|---|
| D1 | Bấm ***Next — choose countries (N)*** | Hộp thoại ***Export options***, dòng phụ ***Choose which countries & currencies to include in the exported file.*** |
| D2 | ⚠ Đọc bộ đếm góc phải | ***173 of 173 selected*** |
| D3 | — | ⚠ **D2 LÀ MỤC CHẶN CỬA CỦA ARC NÀY.** Nếu thấy **183** ⇒ lỗi R2 tái phát, **báo ngay và dừng UAT**. |
| D4 | Gõ `Russia` vào ô tìm | ⚠ **Tìm thấy Nga.** Trước arc này Nga **không có** trong danh sách |
| D5 | Gõ lần lượt `Belarus`, `Gibraltar`, `Bermuda`, `Vatican` | Đều tìm thấy — 15 nước trước đây không tick được |
| D6 | Gõ `Andorra`, rồi `Monaco`, rồi `China` | ⚠ **Không tìm thấy.** Đây là 3 trong 25 mục Google không bán, đã bỏ |
| D7 | Nhìn nhóm tiêu đề | 5 nhóm: `ASIA` · `EUROPE` · `AMERICAS` · `AFRICA` · `OCEANIA` |
| D8 | — | ⚠ **Không có nhóm `MIDDLE EAST`** — đúng, đó là cách module Google phân nhóm (khác Apple, cố ý) |
| D9 | Nút export | ***Export 173 countries*** |
| D10 | Bỏ tick hết | Nút mờ, ghi ***Select at least 1 country*** |

## E. File tải về

| # | Làm gì | Kỳ vọng thấy |
|---|---|---|
| E1 | Tick hết nước, bấm export, mở file | Tên `IAP-export-<package>-YYYYMMDD.xlsx` |
| E2 | ⚠ Đọc **hàng header thứ 1** | `Price in Vietnam (VN)` — **tên nước + mã**, không phải `Price in VN` |
| E3 | Đọc **hàng header thứ 2** | Vẫn là cặp `Price` \| `Currency` — hàng này **không đổi** |
| E4 | Tìm cột Macao | ⚠ Ghi `Price in Macao (MO)` — **không phải `Macau`**. File cũ ghi Macau, chữ đó vốn sai |
| E5 | Tìm cột Vatican / British Virgin Islands / Micronesia | `Price in Vatican City (VA)` · `Price in British Virgin Islands (VG)` · `Price in Micronesia (FM)` |
| E6 | Tìm cột Côte d'Ivoire | `Price in Côte d’Ivoire (CI)` — **có dấu ô và dấu nháy cong**, không phải `Cote d'Ivoire` |
| E7 | — | ⚠ **E6:** nếu thấy `CÃ´te` hoặc ký tự lạ ⇒ lỗi mã hoá, báo ngay |
| E8 | Đếm số dòng dữ liệu | Bằng số N ở nút bước 1 |

## F. ⚠ Ô `—` — tick nước không ai có giá

| # | Làm gì | Kỳ vọng thấy |
|---|---|---|
| F1 | Chạy lại export. Ở bước 2 bấm **Clear all**, rồi tick **đúng 2 nước**: một nước app CÓ bán (vd Vietnam) và một nước chắc chắn KHÔNG có giá (vd **Eritrea** hoặc **Somalia**) | — |
| F2 | Mở file | ⚠ **CÓ ĐỦ 2 CẶP CỘT**, kể cả nước không có giá |
| F3 | Nhìn cột nước không có giá | Mọi ô ghi **`—`** (gạch ngang dài), không để trống |
| F4 | — | ⚠ **F2/F3 là mục quan trọng thứ hai của arc.** Trước đây cột đó **biến mất hoàn toàn** — câu hỏi bị gỡ thay vì được trả lời. Nếu nay vẫn mất cột ⇒ báo ngay. |
| F5 | Nhìn nhóm cột `Localization N` của một item ít locale | Vẫn **để trống**, **không** phải `—` |
| F6 | — | ⚠ **F5 cố ý khác F3.** Ô nước `—` = "không có giá ở đây". Ô localization trống = "item này ít locale hơn hàng rộng nhất" — hai chuyện khác nhau. |

## G. Công bố "N item bỏ qua" (cần dựng tình huống)

| # | Làm gì | Kỳ vọng thấy |
|---|---|---|
| G1 | Export với **All items**, tick hết | Thông báo kiểu *"Exported N items."* |
| G2 | Export với **Active only** | Thông báo có thêm *"M items skipped by the "active" filter."* |
| G3 | ⚠ **Dựng lệch:** trên **Play Console**, deactivate 1 item đang active. **KHÔNG bấm Refresh** trên tool. Quay lại tool export **Active only** | Thông báo phải nói **cả hai số** và nói file theo Google, kiểu: *"The list on screen showed 9 — Google's live data differs, and the file follows Google. Refresh to update the list."* |
| G4 | — | ⚠ **G3:** nếu chỉ báo số đã export mà **không** nhắc gì tới độ lệch ⇒ báo ngay. Người dùng sẽ cầm file thiếu 1 dòng so với số vừa đọc mà không biết vì sao. |
| G5 | Bấm **Refresh** rồi export lại | Hai số khớp, câu độ lệch biến mất |

## H. Không hồi quy

| # | Làm gì | Kỳ vọng thấy |
|---|---|---|
| H1 | **Bulk Activate** → mở modal | Danh sách tick, ***Select all (N)***, bộ đếm `N selected` — **y như trước**, ⚠ **không** có ô search |
| H2 | Chạy thử Bulk Activate / Bulk Deactivate một item | Hoạt động y như trước arc này |
| H3 | — | ⚠ H1/H2: picker export dùng chung component với modal này. Nếu modal đổi hành vi ⇒ báo, đó là hồi quy. |
| H4 | Sang module **Apple**, mở Export list của một app | Bước 2 vẫn hiện **175** nước của Apple, không phải 173 |
| H5 | — | ⚠ H4: hai module dùng **chung một dialog**. Nếu Apple hiện 173 ⇒ arc này đã làm hỏng bên Apple, báo ngay. |

---

## Chỗ cần báo ngay và dừng UAT

1. **D3** — dialog nước hiện **183** thay vì 173 ⇒ lỗi R2 tái phát.
2. **F2** — tick nước không có giá mà **mất cột**.
3. **B4** — mất dòng chữ `INACTIVE_PUBLISHED`.
4. **C6** — bỏ tick hết mà vẫn export được.
5. **H5** — module Apple bị đổi số nước.

## Chỗ *không* phải lỗi

- Không có nhóm **MIDDLE EAST** ở bước 2 (D8) — cố ý, module Google dùng 5 nhóm.
- Nhãn nước khác file export cũ ở **16 chỗ** (E4, E5, E6) — cố ý, nay lấy từ Play Console.
- Bulk Activate **không** có ô search (H1) — cố ý, không đổi UI đường ghi đang chạy.
