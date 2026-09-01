# UAT — R5 · freeze 3 cột đầu (+ hai mục còn treo)

**Cho:** Manager. **Ngày:** 2026-09-01 · commit `60be2a1`.
**Cần:** một file export mới tải về từ `/google-iap-management/apps/<pkg>` →
**Export list**.

> ⚠ **File cũ tải trước hôm nay sẽ KHÔNG có freeze.** Phải export lại.

> ⚠ **Đây là lần đầu file được ghi bằng thư viện khác** (đổi từ SheetJS sang
> exceljs, vì SheetJS không ghi được freeze). Phần **B** dưới đây là kiểm
> không-hồi-quy: những thứ phải y hệt như trước. Test tự động đã so 53/53 ô và
> 10/10 merge với file cũ, nhưng mắt người vẫn nên xem qua một lượt.

---

## A. Freeze — cái R5 làm

| # | Làm gì | Kỳ vọng |
|---|---|---|
| A1 | Mở file, **cuộn NGANG hết cỡ** (kéo sang phải qua hết các cột nước) | ⚠ Ba cột **Product ID · Product Name · Status** **ĐỨNG YÊN** ở bên trái |
| A2 | Trong lúc cuộn ngang, nhìn hàng trên cùng | Tên nước và dòng `Price` ‖ `Currency` của nó cuộn theo — **chỉ 3 cột trái đứng yên**, không phải cả bảng |
| A3 | **Cuộn DỌC** xuống cuối danh sách item | ⚠ **CẢ HAI** hàng header đứng yên: hàng tên nước **và** hàng `Price`/`Currency` |
| A4 | — | ⚠ **A3 quan trọng:** nếu chỉ hàng 1 đứng yên còn hàng `Price`/`Currency` trôi mất, đó là **lỗi** — cột giá khi đó trôi khỏi chữ nói nó là nửa nào của cặp. |
| A5 | Cuộn ngang **và** dọc cùng lúc (kéo tới góc dưới-phải) | Ô giao nhau vẫn thấy: 3 cột trái **và** 2 hàng header |

## B. Không hồi quy — sau khi đổi thư viện ghi file

| # | Kiểm gì | Kỳ vọng |
|---|---|---|
| B1 | Header cột Việt Nam | `Price in Vietnam (VN)` |
| B2 | Cột Macao | `Price in Macao (MO)` — ⚠ **không phải** `Macau` |
| B3 | Cột Bờ Biển Ngà | `Price in Côte d’Ivoire (CI)` — có dấu **ô** và dấu nháy **cong** |
| B4 | — | ⚠ **B3:** thấy `CÃ´te` hoặc `Cote d'Ivoire` (nháy thẳng) ⇒ **lỗi mã hoá, báo ngay** |
| B5 | Cột Thổ Nhĩ Kỳ | `Price in Türkiye (TR)` — có dấu **ü** |
| B6 | Độ rộng cột | Không cột nào vỡ/dính chữ. Product ID rộng, Status hẹp, các cột giá đều nhau |
| B7 | Hai hàng header | Hàng 1 tên nước (gộp 2 ô), hàng 2 `Price` ‖ `Currency` — **y như trước** |
| B8 | Nếu có tick nước mà không item nào có giá | Cột vẫn có, mọi ô ghi `—` |
| B9 | Số dòng dữ liệu | Bằng số item đã chọn ở bước 1 |
| B10 | Mở file bằng Excel **và** Google Sheets nếu tiện | Cả hai mở được, không báo file hỏng |

---

## ⚠ HAI MỤC UAT CÒN TREO TỪ TRƯỚC — nhắc lại

Manager chưa báo hai mục này ở vòng UAT trước.

### B4 (cũ) — dòng chữ `INACTIVE_PUBLISHED` dưới filter

| # | Làm gì | Kỳ vọng |
|---|---|---|
| T1 | Bấm **Export list** → nhìn **ngay dưới** ba lựa chọn trạng thái | Một dòng chữ **nền vàng**, nguyên văn: |

> ***Google calls a purchase option ACTIVE or INACTIVE_PUBLISHED; this tool
> counts both as "Active". "Inactive" is everything else.***

⚠ Nếu dòng đó **không hiện** hoặc bị rút gọn kiểu "Filter by status" ⇒ **báo
ngay**. Nhãn "Active" khi đó đang nói dối: nó gộp cả state
`INACTIVE_PUBLISHED` của Google.

### H5 (cũ) — module **APPLE** không hồi quy

Dialog chọn nước **dùng chung** giữa hai module, và R5 vừa đụng cả hàng rào
thư viện Excel dùng chung.

| # | Làm gì | Kỳ vọng |
|---|---|---|
| T2 | Sang module **Apple** → một app → **Export list** → bước chọn nước | Bộ đếm hiện **175** (số của Apple), **không phải 173** |
| T3 | Export thử một file Apple, mở ra | File Apple vẫn như cũ: có cột **Base Country**, **4 cột trái** freeze (Apple freeze 4, Google freeze 3 — khác nhau là **đúng**) |
| T4 | — | ⚠ Apple hiện 173, hoặc file Apple hỏng ⇒ **báo ngay và dừng** |

---

## Báo ngay và dừng

1. **A1** — cuộn ngang mà 3 cột trái trôi mất.
2. **A3** — chỉ 1 hàng header đứng yên thay vì 2.
3. **B4** — thấy `CÃ´te` (lỗi mã hoá).
4. **T1** — mất dòng chữ `INACTIVE_PUBLISHED`.
5. **T4** — module Apple bị hồi quy.

## Không phải lỗi

- Apple freeze **4** cột còn Google freeze **3** — Apple có thêm cột Base
  Country, Google không có.
- File export tải **trước 2026-09-01** không có freeze — phải export lại.
- Tên nước khác file export cũ ở 16 chỗ — đã đổi từ vòng trước, lấy từ Play
  Console.
