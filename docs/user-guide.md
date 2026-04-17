# CPP Manager — Hướng dẫn sử dụng

> Dành cho: Team nội bộ sử dụng CPP Manager để upload và quản lý Custom Product Pages trên App Store Connect.

---

## Mục lục

1. [Tổng quan](#1-tổng-quan)
2. [Đăng nhập](#2-đăng-nhập)
3. [Điều hướng giao diện](#3-điều-hướng-giao-diện)
4. [Tạo CPP mới](#4-tạo-cpp-mới)
5. [Chỉnh sửa CPP (CPP Editor)](#5-chỉnh-sửa-cpp-cpp-editor)
6. [Bulk Import Assets (1 CPP)](#6-bulk-import-assets-1-cpp)
7. [CPP Bulk Import (nhiều CPP cùng lúc)](#7-cpp-bulk-import-nhiều-cpp-cùng-lúc)
8. [Submit CPP để Apple Review](#8-submit-cpp-để-apple-review)
9. [Xoá CPP](#9-xoá-cpp)
10. [Export danh sách CPP ra CSV](#10-export-danh-sách-cpp-ra-csv)
11. [Switch App Store Connect Account](#11-switch-app-store-connect-account)
12. [Cấu trúc thư mục chuẩn](#12-cấu-trúc-thư-mục-chuẩn)
13. [Các file template và file hỗ trợ](#13-các-file-template-và-file-hỗ-trợ)
14. [Chuẩn bị metadata.xlsx](#14-chuẩn-bị-metadataxlsx)
15. [Câu hỏi thường gặp](#15-câu-hỏi-thường-gặp)

---

## 1. Tổng quan

CPP Manager là công cụ nội bộ giúp team upload và quản lý **Custom Product Pages (CPP)** lên App Store Connect mà không cần đăng nhập trực tiếp vào trang web Apple.

**Luồng làm việc cơ bản:**
1. Đăng nhập bằng tài khoản Google được cấp phép
2. Chọn app từ danh sách
3. Vào CPP List → tạo, chỉnh sửa, upload, submit CPP
4. Theo dõi trạng thái và quản lý CPP

---

## 2. Đăng nhập

1. Truy cập địa chỉ CPP Manager (hỏi admin nếu chưa có)
2. Nhấn **Sign in with Google**
3. Chọn tài khoản Google của bạn
4. Nếu tài khoản không được cấp phép, sẽ thấy thông báo từ chối — liên hệ admin để được thêm vào danh sách

> **Lưu ý:** Chỉ tài khoản Google nằm trong danh sách được admin cấu hình mới đăng nhập được.

---

## 3. Điều hướng giao diện

### Thanh điều hướng trên cùng (Top Nav)

```
┌─────────────────────────────────────────────────────────────────────┐
│  C CPP Manager │  Apps   Settings  │     [Account ▼]  user@...  [↩] │
└─────────────────────────────────────────────────────────────────────┘
```

| Vị trí | Thành phần | Tác dụng |
|---|---|---|
| Trái | Logo + "CPP Manager" | Nhấn để về trang chủ |
| Giữa | Tab **Apps** | Xem danh sách tất cả apps |
| Giữa | Tab **Settings** | Quản lý ASC accounts (chỉ admin) |
| Phải | **Account Switcher** | Switch giữa các App Store Connect accounts |
| Phải | Email | Email đang đăng nhập |
| Phải | Nút ↩ | Đăng xuất |

### Sub-Nav (khi đang trong 1 app)

```
┌─────────────────────────────────────────────────────────────────────┐
│  [Icon] Tên App                                        [+ New CPP]  │
└─────────────────────────────────────────────────────────────────────┘
```

Hiện ra phía dưới Top Nav khi bạn đang ở trang CPP List hoặc CPP Editor của một app. Nhấn tên app để quay lại CPP List.

---

## 4. Tạo CPP mới

1. Vào tab **Apps** → nhấn vào app cần tạo CPP
2. Nhấn nút **+ New CPP** (góc phải Sub-Nav)
3. Điền thông tin:
   - **Tên CPP** — tên nội bộ để quản lý (ví dụ: "Summer Campaign 2026")
   - **Primary Locale** — ngôn ngữ chính của CPP (thường chọn `English (U.S.)`)
4. Nhấn **Create**

### Sau khi tạo

- CPP mới xuất hiện trong danh sách với trạng thái **Draft**
- Nhấn vào tên CPP để vào **CPP Editor** và bắt đầu thêm nội dung

### Lưu ý

- Tên CPP là tên nội bộ — người dùng App Store không thấy tên này
- CPP ở trạng thái **Draft** sẽ không hiển thị với người dùng cho đến khi được duyệt

---

## 5. Chỉnh sửa CPP (CPP Editor)

Nhấn vào tên CPP trong danh sách để mở CPP Editor. Có 3 tab:

### Tab Overview — Thông tin chung

- Xem trạng thái hiện tại của CPP (Draft / In Review / Approved / Rejected)
- Xem **CPP URL** — link App Store tự động tạo (có thể share sau khi approved)
- Xem và chỉnh **Deep Link** — URL scheme mở thẳng vào màn hình trong app (ví dụ: `myapp://campaign/summer`)

### Tab Details — Locale và Promotional Text

- Xem danh sách locales đã có trong CPP
- Nhấn **+ Add Locale** để thêm locale mới
- Nhấn vào locale để chỉnh **Promotional Text** (tối đa 170 ký tự)

### Tab Assets — Ảnh và Video

Quản lý screenshot và app preview (video) cho từng locale.

**Upload thủ công:**
1. Chọn locale từ dropdown
2. Kéo thả file PNG vào ô **iPhone** hoặc **iPad**
3. Kéo thả file MP4 vào ô **App Previews**
4. Mỗi file upload lần lượt, hiển thị tiến trình

**Bulk Import — upload nhiều file cùng lúc:**
Xem [Phần 6 — Bulk Import Assets](#6-bulk-import-assets-1-cpp)

---

## 6. Bulk Import Assets (1 CPP)

Dùng khi cần upload nhiều locale và nhiều file cho **một CPP đã tồn tại**.

### Bước 1 — Chuẩn bị thư mục

```
ten-folder-bat-ky/
├── en-US/                        ← tên locale: BCP-47 code hoặc tên Apple
│   ├── promo.txt                 ← optional: promotional text
│   ├── screenshots/
│   │   ├── iphone/               ← ảnh PNG cho iPhone
│   │   │   ├── 01_home.png
│   │   │   ├── 02_detail.png
│   │   │   └── 03_checkout.png
│   │   └── ipad/                 ← ảnh PNG cho iPad (nếu có)
│   └── previews/
│       ├── iphone/               ← video MP4 cho iPhone
│       └── ipad/                 ← video MP4 cho iPad
├── Vietnamese/                   ← hoặc dùng "vi"
│   ├── promo.txt
│   └── screenshots/iphone/
└── ja/
    └── screenshots/iphone/
```

**Quy tắc:**
- Tên folder locale: BCP-47 (`en-US`, `vi`) hoặc tên Apple (`English (U.S.)`, `Vietnamese`) — cả hai đều được
- File ảnh/video xử lý theo **thứ tự tên file** (a → z) — đặt số ở đầu tên để kiểm soát thứ tự
- Các thư mục `screenshots/`, `previews/`, `iphone/`, `ipad/` đều optional

### Bước 2 — Tiến hành import

1. Vào CPP Editor → tab **Assets**
2. Nhấn nút **Bulk Import**
3. Kéo thả thư mục vào ô drop, hoặc nhấn **Browse folder**
4. Xem preview danh sách locale:
   - 🟢 **Ready** — locale đã có trong CPP
   - 🔵 **New locale** — sẽ tự động thêm locale vào CPP
   - 🟡 **Not supported by app** — sẽ thêm locale vào app store page trước
   - ⚫ **Skip** — tên folder không hợp lệ hoặc rỗng
5. Nhấn **Remove** trên locale nào muốn bỏ qua
6. Nhấn **Import All** để bắt đầu

### Trong khi import

- Tiến trình hiển thị theo từng locale và từng file
- Nếu 1 locale lỗi, các locale khác vẫn tiếp tục

---

## 7. CPP Bulk Import (nhiều CPP cùng lúc)

Dùng khi cần **tạo nhiều CPP mới** hoặc **thêm assets vào nhiều CPP** cùng lúc.

### Bước 1 — Chuẩn bị thư mục root

```
ten-folder-root/
├── primary-locale.txt            ← BẮT BUỘC khi tạo CPP mới
├── metadata.xlsx                 ← KHUYẾN NGHỊ: deep link + promo text tập trung
│
├── Summer Campaign/              ← tên folder = tên CPP
│   ├── deeplink.txt              ← optional (bỏ qua nếu dùng metadata.xlsx)
│   ├── English (U.S.)/
│   │   ├── promo.txt             ← optional (bỏ qua nếu dùng metadata.xlsx)
│   │   ├── screenshots/
│   │   │   ├── iphone/
│   │   │   └── ipad/
│   │   └── previews/iphone/
│   └── Vietnamese/
│       └── screenshots/iphone/
│
├── Holiday Sale/
│   ├── English (U.S.)/
│   │   └── screenshots/iphone/
│   └── Japanese/
│       └── screenshots/iphone/
│
└── _template/                    ← thư mục bắt đầu _ hoặc . tự động bỏ qua
```

### Bước 2 — Tiến hành import

1. Vào trang **CPP List** của app
2. Nhấn nút **Bulk Import CPPs** (góc trên phải)
3. Kéo thả thư mục root, hoặc nhấn **Browse folder**
4. Xem preview (3 cấp: CPP → Locale → Files):
   - 🔵 **New CPP** — tên chưa tồn tại, sẽ tạo mới
   - 🟢 **Existing** — tên đã có (không phân biệt hoa/thường), chỉ thêm assets
   - ⚫ **Skip** — thư mục rỗng hoặc bắt đầu bằng `_`/`.`
5. Nhấn **Import All**
6. Theo dõi tiến trình (2 CPP chạy song song, locale trong mỗi CPP tuần tự)

### Hệ thống tự phát hiện CPP tồn tại hay mới

- Tên folder **khớp** với CPP đang có (không phân biệt hoa/thường) → merge, không tạo lại
- Tên folder **chưa có** → tạo CPP mới (trạng thái Draft)

---

## 8. Submit CPP để Apple Review

### Submit 1 hoặc nhiều CPP

1. Vào trang **CPP List**
2. Tích checkbox vào CPP cần submit — chỉ CPP ở trạng thái **Draft** mới có thể submit
3. Nhấn nút **Submit** (màu xanh, góc phải action bar)
4. Dialog xác nhận hiển thị danh sách CPP và trạng thái eligible
5. Nhấn **Submit for Review**

### Các trường hợp sau khi nhấn Submit

**Trường hợp 1 — Tất cả thành công:**
- Hệ thống tự động hoàn tất submission
- Dialog kết quả hiển thị danh sách CPP đã submit thành công

**Trường hợp 2 — Một số CPP thất bại (Partial Fail):**

```
┌──────────────────────────────────────────────────────────┐
│  ⚠️  Some CPPs failed to add                             │
│                                                          │
│  2 of 5 CPPs could not be added. Review and decide.      │
│                                                          │
│  ✅  Summer Campaign                                     │
│  ✅  Holiday Sale                                        │
│  ✅  Back to School                                      │
│  ❌  Spring Promo                                        │
│       422 · Invalid version state                        │
│  ❌  Black Friday                                        │
│       409 · Already in another submission                │
│                                                          │
│  [ Rollback ]          [ Submit 3 successful CPPs → ]    │
└──────────────────────────────────────────────────────────┘
```

- **Rollback** — hủy toàn bộ submission, không submit gì cả
- **Submit X CPPs** — tiếp tục submit những CPP đã thêm thành công, bỏ qua CPP lỗi

**Trường hợp 3 — Tất cả thất bại:**
- Nút "Submit" bị vô hiệu hóa
- Chỉ có thể nhấn **Rollback**

### Trạng thái CPP

| Trạng thái | Ý nghĩa |
|---|---|
| **Draft** | Đang soạn thảo, chưa gửi |
| **In Review** | Đã gửi Apple, đang chờ duyệt |
| **Approved** | Apple đã duyệt — CPP hiển thị với người dùng |
| **Rejected** | Apple từ chối — hover vào badge đỏ để xem lý do từ chối |

### Lưu ý

- CPP cần có ít nhất 1 locale với ảnh đủ kích thước — nếu thiếu, Apple trả lỗi 422
- Sau khi submit, CPP không chỉnh sửa được cho đến khi Apple duyệt hoặc từ chối
- Nếu bị **Rejected**: xem lý do trong tooltip badge → tạo version mới → upload lại → submit lại

---

## 9. Xoá CPP

1. Vào trang **CPP List**
2. Tích checkbox vào CPP cần xoá (tích nhiều để xoá nhiều cùng lúc)
3. Nhấn nút **Delete** (action bar bên trái)
4. Xem danh sách CPP sẽ xoá trong dialog xác nhận
5. Nhấn **Confirm Delete**

> ⚠️ **Không thể hoàn tác.** CPP đang **In Review** hoặc **Approved** có thể không xoá được — Apple sẽ trả lỗi.

---

## 10. Export danh sách CPP ra CSV

1. Vào trang **CPP List**
2. Nhấn nút **Export CSV**
3. File `cpps-YYYY-MM-DD.csv` tải về tự động

### Nội dung file CSV

| Column | Nội dung |
|---|---|
| Name | Tên CPP |
| Status | Trạng thái (Draft / In Review / Approved / Rejected) |
| URL | Link App Store của CPP — dùng để share hoặc test deep link |

---

## 11. Switch App Store Connect Account

Nếu team quản lý nhiều Apple Developer accounts (ví dụ: nhiều client):

1. Nhấn vào **Account Switcher** (góc trên phải Top Nav — hiển thị tên account hiện tại)
2. Chọn account muốn switch
3. Trang tự reload — toàn bộ dữ liệu (apps, CPPs) sẽ hiển thị theo account mới

> Account mặc định được chọn khi mới đăng nhập. Sau khi switch, lựa chọn được lưu trong session.

---

## 12. Cấu trúc thư mục chuẩn

### Bulk Import Assets (1 CPP)

```
<ten-folder>/
├── <locale>/
│   ├── promo.txt                 ← optional, UTF-8, tối đa 170 ký tự
│   ├── screenshots/
│   │   ├── iphone/               ← PNG, sắp xếp theo tên file
│   │   └── ipad/
│   └── previews/
│       ├── iphone/               ← MP4
│       └── ipad/
└── <locale-2>/
    └── ...
```

### CPP Bulk Import (nhiều CPP)

```
<root>/
├── primary-locale.txt            ← BCP-47 code (ví dụ: en-US)
├── metadata.xlsx                 ← optional, khuyến nghị
├── <Tên CPP 1>/
│   ├── deeplink.txt              ← optional (bỏ qua nếu dùng metadata.xlsx)
│   ├── <locale>/
│   │   ├── promo.txt             ← optional (bỏ qua nếu dùng metadata.xlsx)
│   │   ├── screenshots/
│   │   │   ├── iphone/
│   │   │   └── ipad/
│   │   └── previews/
│   │       ├── iphone/
│   │       └── ipad/
│   └── <locale-2>/
│       └── ...
└── _ignored/                     ← tên bắt đầu _ hoặc . → tự bỏ qua
```

### Tên locale được chấp nhận

Cả hai dạng đều hợp lệ:

| Tên Apple | BCP-47 code |
|---|---|
| `English (U.S.)` | `en-US` |
| `Vietnamese` | `vi` |
| `Japanese` | `ja` |
| `Chinese (Simplified)` | `zh-Hans` |
| `Chinese (Traditional)` | `zh-Hant` |
| `Korean` | `ko` |
| `French` | `fr-FR` |
| `German` | `de-DE` |
| `Spanish` | `es-ES` |
| `Thai` | `th` |
| `Indonesian` | `id` |
| `Portuguese (Brazil)` | `pt-BR` |

Xem đầy đủ 39 locales trong `public/metadata-template.xlsx`.

---

## 13. Các file template và file hỗ trợ

### `promo.txt` — Promotional Text

- **Vị trí:** Trong thư mục locale (ví dụ: `en-US/promo.txt`)
- **Format:** Plain text, UTF-8, không định dạng đặc biệt
- **Giới hạn:** Tối đa 170 ký tự
- **Lưu ý:** Nếu dùng `metadata.xlsx`, file này bị bỏ qua

```
Khám phá ưu đãi mùa hè với hàng nghìn sản phẩm giảm giá đến 70%. Mua sắm ngay hôm nay!
```

---

### `deeplink.txt` — Deep Link

- **Vị trí:** Trong thư mục gốc của CPP (cùng cấp với các thư mục locale)
- **Format:** 1 dòng chứa URL
- **Lưu ý:** Nếu dùng `metadata.xlsx`, file này bị bỏ qua

```
myapp://campaign/summer2026
```

---

### `primary-locale.txt` — Primary Locale

- **Vị trí:** Thư mục **root** (cùng cấp với các thư mục CPP) — **không phải** trong thư mục CPP
- **Format:** BCP-47 code duy nhất (1 dòng)
- **Bắt buộc** khi batch có CPP mới cần tạo

```
en-US
```

**Nếu file thiếu hoặc giá trị không hợp lệ**, hệ thống fallback theo thứ tự:
1. Locale đầu tiên đã có trong app store page
2. Locale đầu tiên trong thư mục (theo alphabet)
3. `en-US`

---

### `metadata.xlsx` — Excel Metadata *(khuyến nghị)*

- **Vị trí:** Thư mục **root** (cùng cấp với `primary-locale.txt`)
- **Ưu tiên:** Khi có file này → **thắng toàn bộ**, bỏ qua `deeplink.txt` và `promo.txt`
- **Giới hạn:** Tối đa 5MB, chỉ đọc sheet đầu tiên

Xem hướng dẫn chi tiết tại [Phần 14 — Chuẩn bị metadata.xlsx](#14-chuẩn-bị-metadataxlsx).

---

### Tóm tắt: file nào dùng ở đâu

| File | Dùng trong | Vị trí |
|---|---|---|
| `promo.txt` | Bulk Import Assets hoặc CPP Bulk Import (không có metadata.xlsx) | Trong thư mục locale |
| `deeplink.txt` | CPP Bulk Import (không có metadata.xlsx) | Trong thư mục CPP |
| `primary-locale.txt` | CPP Bulk Import | Root folder |
| `metadata.xlsx` | CPP Bulk Import (thay thế promo.txt + deeplink.txt) | Root folder |

---

## 14. Chuẩn bị metadata.xlsx

`metadata.xlsx` là cách quản lý tập trung deep link và promotional text cho nhiều CPP + nhiều locale trong 1 file Excel. **Được khuyến nghị** khi batch có nhiều CPP.

### Tải file mẫu

Tải file template tại: `https://<your-domain>/metadata-template.xlsx`

Hoặc hỏi admin để lấy file.

### Cấu trúc file

| CPP Name | Deep Link | English (U.S.) | Vietnamese | Japanese | ... |
|---|---|---|---|---|---|
| Summer Campaign | myapp://summer | Summer deals up to 70%! | Ưu đãi mùa hè đến 70%! | | |
| Holiday Sale | | Holiday savings! | Ưu đãi ngày lễ! | ホリデーセール | |
| Winter Promo | myapp://winter | | | | |

### Quy tắc cột

| Cột | Quy tắc |
|---|---|
| **CPP Name** | Bắt buộc. Phải khớp **chính xác** (phân biệt hoa/thường) với tên thư mục CPP |
| **Deep Link** | Bắt buộc (có thể để trống). Ô trống = không set deep link |
| **Tên locale** | Dùng tên Apple user-friendly: `Vietnamese`, `English (U.S.)`, `Japanese`,... (không dùng `vi`, `en-US`) |

### Quy tắc ô

- **Ô có giá trị** → cập nhật field đó
- **Ô trống** → bỏ qua, không ghi đè
- **Dòng không có thư mục CPP tương ứng** → bỏ qua (không gây lỗi)
- **Thư mục CPP không có dòng trong Excel** → hiển thị cảnh báo `⚠ No metadata` trong preview, nhưng vẫn import được

### Ví dụ thực tế

Batch gồm 3 CPP, 3 locale (English, Vietnamese, Japanese):

| CPP Name | Deep Link | English (U.S.) | Vietnamese | Japanese |
|---|---|---|---|---|
| Tet Sale 2026 | myapp://tet2026 | Celebrate Tet with us! | Chào Tết 2026! | |
| Summer 2026 | myapp://summer2026 | Summer deals! | Ưu đãi mùa hè! | サマーセール！ |
| Back to School | | Get ready for school! | Chuẩn bị năm học mới! | |

**Kết quả:**
- Tet Sale 2026: deep link set, promo text cho EN + VI (JP bỏ qua)
- Summer 2026: deep link set, promo text cho EN + VI + JP
- Back to School: không có deep link, promo text cho EN + VI

### Lưu ý khi tạo file Excel

- File phải là định dạng `.xlsx` (Excel 2007+)
- Header phải ở **row 1** — không thêm row tiêu đề phụ
- Cột `CPP Name` và `Deep Link` phải có mặt (dù Deep Link có thể để trống hết)
- Tên cột locale phải chính xác — ví dụ `Vietnamese` (không phải `Vietnam` hay `vi`)
- Không dùng công thức Excel — chỉ dùng giá trị text thuần
- Giới hạn promotional text: **170 ký tự** — Excel không cảnh báo nhưng ASC sẽ từ chối nếu dài hơn

---

## 15. Câu hỏi thường gặp

**Q: Thứ tự ảnh trong App Store được quyết định bởi điều gì?**
A: Theo thứ tự tên file (a → z). Đặt số ở đầu tên file để kiểm soát: `01_home.png`, `02_feature.png`, `03_checkout.png`.

**Q: Có thể upload riêng ảnh iPhone và iPad không?**
A: Có. Đặt ảnh iPhone vào `screenshots/iphone/`, iPad vào `screenshots/ipad/`. Nếu chỉ có `iphone/` thì chỉ upload cho iPhone.

**Q: Tôi vừa upload nhầm ảnh, có xóa được không?**
A: CPP Manager chưa hỗ trợ xóa ảnh đơn lẻ qua UI. Vui lòng đăng nhập trực tiếp vào App Store Connect để xóa.

**Q: Submit CPP bị lỗi 422 là gì?**
A: Apple yêu cầu CPP phải có ít nhất 1 screenshot cho locale chính trước khi submit. Upload ảnh trước, sau đó mới submit.

**Q: Submit bị lỗi 409 "Already in another submission"?**
A: CPP đó đang nằm trong một submission khác chưa hoàn tất. Rollback submission đó (nếu có) hoặc đợi nó hoàn tất.

**Q: `primary-locale.txt` để ở đâu?**
A: Trong thư mục **root** (cùng cấp với các thư mục CPP), không phải bên trong thư mục CPP.

**Q: metadata.xlsx có phân biệt hoa/thường trong cột CPP Name không?**
A: **Có.** `Summer Campaign` khác `summer campaign`. Đảm bảo tên trong Excel khớp chính xác với tên thư mục.

**Q: Có thể dùng cả metadata.xlsx lẫn promo.txt trong cùng 1 batch không?**
A: Không. Khi có `metadata.xlsx`, toàn bộ `promo.txt` và `deeplink.txt` trong batch bị bỏ qua.

**Q: CPP ở trạng thái Approved có thể submit lại không?**
A: Không trực tiếp. Cần tạo version mới (qua CPP Editor) → upload assets mới → submit version đó.

**Q: Sau khi submit thì thời gian review mất bao lâu?**
A: Thường 1–3 ngày làm việc, phụ thuộc vào tải review của Apple. Theo dõi trạng thái trong CPP List.
