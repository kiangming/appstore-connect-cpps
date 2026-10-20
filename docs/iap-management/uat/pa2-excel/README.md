# UAT bằng Excel — "Export for editing" → "Import edited file" (PA2)

**Bảng kỳ vọng dưới đây viết TRƯỚC khi sửa bằng Excel** (2026-10-20), và code hôm nay đã cho ra đúng bảng này.

**Việc của Manager:** mở 3 file bằng **Excel thật**, sửa đúng các ô ghi dưới đây, **Save As** sang tên mới, báo agent. Chỉ vậy thôi — Manager **không** cần bấm gì trên app. Agent nạp 3 file đó qua đúng đường "Import edited file" và so với bảng kỳ vọng. Khớp ⇒ push cả PA2 một lượt. Lệch ⇒ agent báo từng ô lệch, chờ Manager.

## Lấy file gốc

- Ba file **chỉ có trên máy dev** (`lap15063-local`) — commit chưa push nên GitHub chưa có. Mở thư mục: trong Finder bấm **⌘⇧G**, dán đường dẫn dưới đây, bấm Enter:
  `/Users/lap15063-local/Documents/DEV/appstore-connect-cpps/docs/iap-management/uat/pa2-excel/`
- Manager không ngồi máy này: nhờ dev gửi 3 file; sửa xong gửi lại 3 file `-excel` để dev đặt vào đúng thư mục trên.
- ⚠ **KHÔNG** bấm "Export for editing" trên app prod để lấy file: nút đó chưa lên prod (PA2 chưa push). Ba file ở đây chính là thứ nút đó sinh ra, chạy trên một database thử — nên UAT không đụng template thật nào.

| File gốc | Template | Nội dung |
|---|---|---|
| `F0-default-for-editing.xlsx` | Default của account **UAT Test Account** (`uat-account`) | toàn bộ template thật: 95 tier × 175 nước = 16 625 giá |
| `F1-per-app-for-editing.xlsx` | Per-App của **UAT Fixture App** (`com.vng.uat.fixture`) | 5 tier × 5 nước; 3 cặp ô `·` (F4:G4, H6:I6, J7:K7) ⇒ 22 giá |
| `F2-per-app-for-editing.xlsx` | bản sao y hệt F1 | dùng cho các ca **bị từ chối** |

Lưới của F1 / F2 (sheet `Per-App Template`). Hàng 1 là ô gộp hai cột (B1:C1, D1:E1, …):

|   | A | B–C | D–E | F–G | H–I | J–K |
|---|---|---|---|---|---|---|
| 1 | Tier | United States (USA_USD) | Vietnam (VNM_VND) | Thailand (THA_THB) | Japan (JPN_JPY) | Germany (DEU_EUR) |
| 2 | | Price · Currency | Price · Currency | Price · Currency | Price · Currency | Price · Currency |
| 3 | Tier 1 | 0.99 · USD | 25000 · VND | 35 · THB | 160 · JPY | 0.99 · EUR |
| 4 | Tier 2 | 1.99 · USD | 49000 · VND | **·** · **·** | 320 · JPY | 1.99 · EUR |
| 5 | Tier 3 | 2.99 · USD | 79000 · VND | 99 · THB | 480 · JPY | 2.99 · EUR |
| 6 | Tier 10 | 9.99 · USD | 249000 · VND | 349 · THB | **·** · **·** | 9.99 · EUR |
| 7 | Alternate Tier A | 0.99 · USD | 5000 · VND | 9 · THB | 160 · JPY | **·** · **·** |

## Cách làm (giống nhau cho cả 3 file)

1. Mở **đúng file gốc của mục đó** bằng **Excel** (double-click). Có thanh "Enable Editing" thì bấm bật. Nếu Excel báo *"We found a problem with some content…"* thì **dừng**, báo agent, **không** bấm Yes.
2. Sửa **ĐÚNG** các ô trong bảng của file đó: chọn ô → gõ giá trị → **Return**.
   - "Xoá trống" là: chọn ô → bấm **delete** → bấm **Return**. **Không** bấm Esc (Esc trả lại giá cũ). Xong thì ô đó phải trống.
3. **Không** đổi tên sheet, **không** hiện sheet ẩn, **không** sửa ô nào khác.
4. Lưu: **File → Save As…** (⇧⌘S). ⚠ **KHÔNG** bấm Save / ⌘S — nó ghi đè file gốc. Giữ định dạng **Excel Workbook (.xlsx)**, cùng thư mục, đặt tên **đúng**:
   - `F0-default-for-editing-excel.xlsx`
   - `F1-per-app-for-editing-excel.xlsx`
   - `F2-per-app-for-editing-excel.xlsx`

   Lỡ bấm Save trên file gốc: báo agent, đừng sửa tiếp.
5. Báo agent "đã lưu". Lưu cùng thư mục là đủ — agent tự đọc, không cần đính kèm.

**Dấu thập phân của máy.** Cách biết: mở F1, nhìn ô B3 — Excel hiện `0.99` là máy dùng dấu **chấm**, hiện `0,99` là máy dùng dấu **phẩy**.
- Máy dùng dấu phẩy: gõ `8,99` thay cho `8.99`, `5000,12345` thay cho `5000.12345`, và công thức ở F2 B6 là `=9,99` thay cho `=9.99`. Kết quả kỳ vọng không đổi (file luôn lưu số và công thức theo dấu chấm).
- Gõ xong, số phải **căn phải** trong ô. Căn trái nghĩa là Excel hiểu thành chữ — gõ lại theo dấu của máy.
- Không thêm dấu hàng nghìn: gõ `22000`, không gõ `22.000` hay `22,000`.

## F0 — mở `F0-default-for-editing.xlsx`, không sửa gì, chỉ Save As

Lưu thành `F0-default-for-editing-excel.xlsx`.

**Kỳ vọng (agent kiểm khi nạp file):**
- Xem trước: **0** override mới · **0** đổi giá · **0** bỏ override · **16 625** giữ nguyên · "No changes — the file matches the template".
- Cảnh báo (đúng, không phải lỗi): **16 625** ô mất proceeds — file không có proceeds.
- Nút ghi là **Write anyway** (file không đổi gì vẫn ghi được).
- Ghi xong: tier, nước, currency, giá của template **không đổi gì**; proceeds thành trống. Đây là bài số một, chạy qua Excel thật.

## F1 — mở `F1-per-app-for-editing.xlsx` (file gốc), các thao tác hợp lệ

| Ô | Tier × Nước | Trước | Sửa thành | Kỳ vọng |
|---|---|---|---|---|
| **F4** | Tier 2 × Thailand | `·` | `39` | override MỚI: 39 THB (currency lấy theo header) |
| **D3** | Tier 1 × Vietnam | 25000 | `22000` | đổi giá: 25000 → 22000 VND |
| **H5** | Tier 3 × Japan | 480 | *(xoá trống: delete → Return; để nguyên ô I5 "JPY")* | bỏ override ⇒ quay về giá Apple |
| **B6** | Tier 10 × United States | 9.99 | `8.99` | đổi giá: 9.99 → 8.99 USD — có cờ **USA** |
| **H6** | Tier 10 × Japan | `·` | `1500` | override MỚI: 1500 JPY |

Kiểm trước khi lưu: H5 trống, I5 vẫn "JPY". Lưu thành `F1-per-app-for-editing-excel.xlsx`.

**Kỳ vọng tổng:**
- **+2** override mới · **~2** đổi giá · **−1** bỏ override (xoá trong file: 1) · **=19** giữ nguyên;
- **23** override sau khi ghi (hiện **22**); nút ghi là **Write 5 changes**.
- Cảnh báo:
  - **1** thay đổi ở cột USA;
  - **22** ô mất proceeds;
  - **không** có cảnh báo nào khác (không ×10, không thang tier, không "no USA column", không "USA column is not in USD").

## F2 — mở `F2-per-app-for-editing.xlsx` (file GỐC, không phải file F1 vừa lưu), các thao tác phải bị TỪ CHỐI

Trước khi sửa, lưới phải giống bảng "Lưới của F1 / F2" ở trên (B6 = 9.99).

| Ô | Trước | Sửa thành | Lỗi kỳ vọng |
|---|---|---|---|
| **H1** | `Japan (JPN_JPY)` | `Japan (JPN_USD)` — ô gộp H1:I1: bấm vào, gõ đè cả chữ, Return | the header says JPN_USD, but Apple bills JPN in JPY |
| **J3** | `0.99` | `-1` (Tier 1 × Germany) | -1 is not a price |
| **E4** | `VND` | `USD` (ô **Currency** của Tier 2 × Vietnam) | Currency says "USD" but the column is VNM_VND |
| **A5** | `Tier 3` | `Tier 05` (tên tier) | "Tier 05" — there is no such tier |
| **B6** | `9.99` | `=9.99` (công thức; máy dấu phẩy: `=9,99`) | is a formula |
| **D7** | `5000` | `5000.12345` (máy dấu phẩy: `5000,12345`) | 5000.12345 has more than 4 decimals |

Lưu thành `F2-per-app-for-editing-excel.xlsx`.

**Kỳ vọng:**
- **Cả file bị từ chối**, không ghi gì: *"The file cannot be imported: 6 problems. Nothing was written."*
- Đúng 6 lỗi, theo thứ tự **H1, J3, E4, A5, B6, D7**. Câu lỗi thật dài hơn cột "Lỗi kỳ vọng" — chỉ cần câu trong cột nằm trong câu lỗi.

## Sau khi có file

Agent thêm một test golden đọc chính 3 file `-excel` và kiểm đúng bảng trên. Khớp ⇒ push cả PA2. Không khớp ⇒ báo từng ô lệch, chờ Manager.

**Ngoài phạm vi lần này:** Numbers và Google Sheets **CHƯA ĐO** (team dùng Excel). Ai dùng hai app đó thì đo riêng (BACKLOG [TEMPLATE-reimport-other-spreadsheet-apps]).

---

## Dành cho agent (Manager bỏ qua)

- Thao tác + kết quả kỳ vọng nằm ở MỘT chỗ: `lib/iap-management/template-reimport/uat-fixtures.test-helper.ts`. `app/api/iap-management/pricing-templates/matrix-reimport.uat-expectations.test.ts` áp chúng bằng exceljs lên file gốc, nạp qua route thật trên Postgres thật (PGlite), và ra đúng bảng trên.
- File gốc sinh bằng chính route "Export for editing" trên PGlite, seed `seedPa2UatFixtures` (template thật `docs/iap-management/templates/price-tiers-template.xlsx`). Test **U0** ghim: file gốc = đúng thứ route sinh ra hôm nay (mọi sheet, ô, định dạng số, ô gộp; chỉ khác giờ export). Writer đổi có chủ đích ⇒ sinh lại:
  `UAT_REGEN_BASE_FILES=1 npx vitest run app/api/iap-management/pricing-templates/matrix-reimport.uat-expectations.test.ts`
- Test golden: đọc thẳng 3 file `-excel` (không lưu lại bằng exceljs), cùng kỳ vọng `F0_EXPECTED` (kể cả bước ghi + so tập entry), `F1_EXPECTED`, `F2_EXPECTED_PROBLEMS`.
- F2 làm từ F1-excel cũng ra đúng 6 lỗi (đã đo) — test golden KHÔNG phân biệt được; chỉ hướng dẫn ở trên canh việc này.
- Excel tạo file khoá `~$<tên>.xlsx` cạnh file đang mở. Trước commit: `git status` thư mục này, chỉ commit 3 file `*-excel.xlsx`, không bao giờ `~$*`. File gốc bị ghi đè (Manager lỡ ⌘S) ⇒ U0 đỏ — sinh lại bằng lệnh trên, rồi nhờ Manager làm lại file đó.
