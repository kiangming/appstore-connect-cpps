# UAT bằng Excel — "Export for editing" → "Import edited file" (PA2)

**Bảng kỳ vọng dưới đây viết TRƯỚC khi sửa bằng Excel** (2026-10-20). Nó lấy từ cùng một nguồn với test:
- các thao tác và kết quả nằm ở `lib/iap-management/template-reimport/uat-fixtures.test-helper.ts`;
- test `app/api/iap-management/pricing-templates/matrix-reimport.uat-expectations.test.ts` đã chạy chính các thao tác này bằng exceljs, qua route thật trên Postgres thật, và ra **đúng bảng này**.

**Việc của Manager:** làm các thao tác bằng **Excel thật**, lưu, gửi lại 3 file. Agent chạy CÙNG bảng kỳ vọng trên file Excel đó. Khớp ⇒ push cả PA2 một lượt.

**Vì sao file gốc nằm sẵn ở đây, không bấm nút trên app:** PA2 chưa push nên app trên prod chưa có nút. File gốc được sinh bằng **chính route "Export for editing"**, chạy trên Postgres thật (PGlite) với template thật của repo (`docs/iap-management/templates/price-tiers-template.xlsx`). Không đụng dữ liệu prod.
- Test **U0** (cùng file test ở trên) ghim: file gốc ở đây = **đúng** thứ route đó sinh ra **hôm nay** (mọi sheet, ô, định dạng số, ô gộp; chỉ khác giờ export). Writer đổi mà file gốc không đổi theo ⇒ U0 đỏ.
- Sinh lại file gốc (chỉ khi writer đổi có chủ đích): `UAT_REGEN_BASE_FILES=1 npx vitest run app/api/iap-management/pricing-templates/matrix-reimport.uat-expectations.test.ts`.

## Ba file gốc (trong thư mục này)

| File | Template | Nội dung |
|---|---|---|
| `F0-default-for-editing.xlsx` | Default của account **UAT Test Account** (`uat-account`) | toàn bộ template thật: 95 tier × 175 nước = 16 625 giá |
| `F1-per-app-for-editing.xlsx` | Per-App của **UAT Fixture App** (`com.vng.uat.fixture`) | 5 tier × 5 nước, 3 ô `·` |
| `F2-per-app-for-editing.xlsx` | bản sao F1 | dùng cho các ca **bị từ chối** |

Lưới của F1 / F2 (sheet `Per-App Template`):

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

1. Mở file bằng **Excel** (double-click). Nếu có thanh "Enable Editing" thì bấm bật.
2. Sửa **ĐÚNG** các ô trong bảng của file đó: chọn ô → gõ giá trị → Enter. "Xoá trống" là chọn ô rồi bấm **Delete**.
3. **Không** đổi tên sheet, **không** hiện sheet ẩn, **không** sửa ô nào khác.
4. Lưu: **File → Save As…**, giữ định dạng **Excel Workbook (.xlsx)**, thêm `-excel` vào tên, cùng thư mục. Ví dụ `F1-per-app-for-editing-excel.xlsx`.
5. Báo agent đã lưu (hoặc gửi 3 file `-excel`).

⚠ Nếu Excel trên máy dùng **dấu phẩy** làm dấu thập phân: gõ `8,99` thay cho `8.99`, `5000,12345` thay cho `5000.12345`, và công thức ở F2 B6 là `=9,99` thay cho `=9.99`. Kết quả kỳ vọng không đổi (file luôn lưu số và công thức theo dấu chấm, bất kể máy dùng dấu gì).

## F0 — không sửa gì, chỉ Save As

**Kỳ vọng:**
- Xem trước: **0** override mới · **0** đổi giá · **0** bỏ override · **16 625** giữ nguyên · "No changes — the file matches the template".
- Cảnh báo (đúng, không phải lỗi): **16 625** ô mất proceeds — file không có proceeds.
- Nút ghi là **Write anyway** (file không đổi gì vẫn ghi được).
- Khi agent ghi file này (golden test): tier, nước, currency, giá của template **không đổi gì**; proceeds thành trống. Đây là bài số một, chạy qua Excel thật.

## F1 — các thao tác hợp lệ

| Ô | Tier × Nước | Trước | Sửa thành | Kỳ vọng |
|---|---|---|---|---|
| **F4** | Tier 2 × Thailand | `·` | `39` | override MỚI: 39 THB (currency lấy theo header) |
| **D3** | Tier 1 × Vietnam | 25000 | `22000` | đổi giá: 25000 → 22000 VND |
| **H5** | Tier 3 × Japan | 480 | *(Delete — để nguyên ô I5 "JPY")* | bỏ override ⇒ quay về giá Apple |
| **B6** | Tier 10 × United States | 9.99 | `8.99` | đổi giá: 9.99 → 8.99 USD — có cờ **USA** |
| **H6** | Tier 10 × Japan | `·` | `1500` | override MỚI: 1500 JPY |

**Kỳ vọng tổng:**
- **+2** override mới · **~2** đổi giá · **−1** bỏ override (xoá trong file: 1) · **=19** giữ nguyên;
- **23** override sau khi ghi (hiện **22**); nút ghi là **Write 5 changes**.
- Cảnh báo:
  - **1** thay đổi ở cột USA;
  - **22** ô mất proceeds;
  - **không** có cờ ×10, **không** có cờ thang tier.

## F2 — các thao tác phải bị TỪ CHỐI

| Ô | Sửa thành | Lỗi kỳ vọng |
|---|---|---|
| **H1** | `Japan (JPN_USD)` (header nước Nhật) | the header says JPN_USD, but Apple bills JPN in JPY |
| **J3** | `-1` (Tier 1 × Germany) | -1 is not a price |
| **E4** | `USD` (ô **Currency** của Tier 2 × Vietnam) | Currency says "USD" but the column is VNM_VND |
| **A5** | `Tier 05` (tên tier "Tier 3") | "Tier 05" — there is no such tier |
| **B6** | `=9.99` (công thức, Tier 10 × United States) | is a formula |
| **D7** | `5000.12345` (Alternate Tier A × Vietnam) | 5000.12345 has more than 4 decimals |

**Kỳ vọng:**
- **Cả file bị từ chối**, không ghi gì: *"The file cannot be imported: 6 problems. Nothing was written."*
- Đúng 6 lỗi, theo thứ tự **H1, J3, E4, A5, B6, D7**.

## Sau khi có file

Agent thêm một test golden đọc 3 file `-excel` và kiểm đúng bảng trên. Khớp ⇒ push cả PA2. Không khớp ⇒ báo từng ô lệch, chờ Manager.

**Ngoài phạm vi lần này:** Numbers và Google Sheets **CHƯA ĐO** (team dùng Excel). Ai dùng hai app đó thì đo riêng.
