# CPP Manager — Hướng dẫn sử dụng

> Dành cho: Team nội bộ sử dụng CPP Manager để upload và quản lý Custom Product Pages trên App Store Connect.

---

## Mục lục

1. [Tổng quan](#1-tổng-quan)
2. [Tạo CPP mới](#2-tạo-cpp-mới)
3. [Chỉnh sửa CPP (CPP Editor)](#3-chỉnh-sửa-cpp-cpp-editor)
4. [Bulk Import CPP Assets (1 CPP)](#4-bulk-import-cpp-assets-1-cpp)
5. [CPP Bulk Import (nhiều CPP cùng lúc)](#5-cpp-bulk-import-nhiều-cpp-cùng-lúc)
6. [Xoá CPP](#6-xoá-cpp)
7. [Export danh sách CPP ra CSV](#7-export-danh-sách-cpp-ra-csv)
8. [Submit CPP để Apple Review](#8-submit-cpp-để-apple-review)
9. [Cấu trúc thư mục chuẩn](#9-cấu-trúc-thư-mục-chuẩn)
10. [Các file template và file hỗ trợ](#10-các-file-template-và-file-hỗ-trợ)

---

## 1. Tổng quan

CPP Manager là công cụ nội bộ giúp team upload và quản lý **Custom Product Pages (CPP)** lên App Store Connect mà không cần đăng nhập trực tiếp vào trang web Apple.

**Màn hình chính:**
```
┌──────────────┬──────────────────────────────────────────┐
│  Sidebar     │  Nội dung chính                          │
│              │                                          │
│  📱 Apps     │  Danh sách apps / Danh sách CPP          │
│  ⚙ Settings │                                          │
└──────────────┴──────────────────────────────────────────┘
```

**Luồng cơ bản:**
1. Chọn app từ danh sách
2. Vào trang CPP List của app đó
3. Tạo / chỉnh sửa / upload / submit CPP

---

## 2. Tạo CPP mới

### Cách tạo

1. Vào **CPP List** của app cần tạo CPP
2. Nhấn nút **+ New CPP** (góc trên phải)
3. Điền thông tin:
   - **Tên CPP** — tên hiển thị nội bộ (ví dụ: "Summer Campaign 2026")
   - **Primary Locale** — ngôn ngữ chính của CPP (thường là `English (U.S.)`)
4. Nhấn **Create**

### Sau khi tạo

- CPP mới xuất hiện trong danh sách với trạng thái **Draft**
- Click vào tên CPP để vào **CPP Editor** và bắt đầu thêm nội dung

### Lưu ý

- Tên CPP không cần trùng với tên trên App Store — đây là tên nội bộ để quản lý
- CPP được tạo ở trạng thái **Draft** (chưa gửi Apple review) và không hiển thị với người dùng

---

## 3. Chỉnh sửa CPP (CPP Editor)

CPP Editor có 3 tab chính:

### Tab Overview — Thông tin chung
- Xem trạng thái CPP (Draft / In Review / Approved / Rejected)
- Xem và chỉnh **Deep Link** (URL scheme mở trực tiếp vào phần trong app)
- Xem **CPP URL** (link Apple tạo tự động)

### Tab Details — Nội dung locale
- Xem danh sách locale đã có trong CPP
- Thêm locale mới (nhấn **+ Add Locale**)
- Chỉnh sửa **Promotional Text** cho từng locale

### Tab Assets — Ảnh và video
Quản lý screenshot và app preview (video) cho từng locale:

**Upload thủ công:**
1. Chọn locale từ dropdown
2. Kéo thả file ảnh (PNG) vào vùng drop zone của **iPhone** hoặc **iPad**
3. Kéo thả file video (MP4) vào vùng **App Previews**
4. File upload theo thứ tự lần lượt

**Bulk Import (nhiều file cùng lúc):**
Xem [Phần 4 — Bulk Import CPP Assets](#4-bulk-import-cpp-assets-1-cpp)

---

## 4. Bulk Import CPP Assets (1 CPP)

Dùng khi cần upload **nhiều locale và nhiều file** cho một CPP đã tồn tại.

### Bước 1 — Chuẩn bị thư mục

Tạo cấu trúc thư mục theo quy ước sau:

```
ten-folder-bat-ky/
├── en-US/                        ← tên locale (BCP-47 code HOẶC tên Apple)
│   ├── promo.txt                 ← optional: nội dung promotional text
│   ├── screenshots/
│   │   ├── iphone/               ← ảnh PNG cho iPhone, đặt tên theo thứ tự
│   │   │   ├── 01_home.png
│   │   │   ├── 02_detail.png
│   │   │   └── 03_checkout.png
│   │   └── ipad/                 ← ảnh PNG cho iPad (nếu app hỗ trợ iPad)
│   └── previews/
│       ├── iphone/               ← video MP4 cho iPhone
│       └── ipad/                 ← video MP4 cho iPad
├── vi/                           ← locale tiếng Việt (hoặc dùng "Vietnamese")
│   ├── promo.txt
│   └── screenshots/
│       └── iphone/
└── ja/
    └── screenshots/
        └── iphone/
```

**Quy tắc đặt tên:**
- Tên thư mục locale: dùng **BCP-47 code** (`en-US`, `vi`, `ja`) hoặc **tên Apple** (`English (U.S.)`, `Vietnamese`, `Japanese`) — cả hai đều được chấp nhận
- File ảnh trong `iphone/` và `ipad/` được xử lý theo **thứ tự tên file** (lexicographic) — đặt tên có số thứ tự ở đầu để kiểm soát thứ tự
- Các thư mục `screenshots/`, `previews/`, `iphone/`, `ipad/` là **optional** — không có thì bỏ qua

### Bước 2 — Import

1. Vào **CPP Editor** → tab **Assets**
2. Nhấn nút **Bulk Import**
3. Kéo thả thư mục đã chuẩn bị vào vùng drop, hoặc nhấn **Browse folder**
4. Xem preview: danh sách locale kèm số file và trạng thái
5. Kiểm tra trạng thái từng locale:
   - 🟢 **Ready** — locale đã có trong CPP, sẵn sàng upload
   - 🔵 **New locale** — locale sẽ được thêm tự động vào CPP
   - 🟡 **Not supported by app** — locale chưa có trong app store page, sẽ được thêm vào app trước
   - ⚫ **Skip** — tên thư mục không hợp lệ hoặc thư mục rỗng
6. Nhấn **Import All** để bắt đầu upload
7. Xem tiến trình theo từng locale và từng file

### Lưu ý

- Upload theo thứ tự từng locale (không song song) để tránh rate limit
- Nếu locale lỗi, các locale còn lại vẫn tiếp tục upload
- Có thể nhấn **Remove** trên locale nào đó trong bước preview để bỏ qua locale đó

---

## 5. CPP Bulk Import (nhiều CPP cùng lúc)

Dùng khi cần **tạo nhiều CPP mới** hoặc **thêm assets vào nhiều CPP** cùng một lúc.

### Bước 1 — Chuẩn bị thư mục root

```
ten-folder-root/
├── primary-locale.txt            ← bắt buộc: locale chính dùng chung cho TẤT CẢ CPP mới
├── metadata.xlsx                 ← optional: file Excel chứa deep link + promo text (khuyến nghị)
│
├── Summer Campaign/              ← tên thư mục = tên CPP
│   ├── deeplink.txt              ← optional: deep link riêng (bỏ qua nếu có metadata.xlsx)
│   ├── English (U.S.)/           ← thư mục locale (tên Apple hoặc BCP-47)
│   │   ├── promo.txt             ← optional (bỏ qua nếu có metadata.xlsx)
│   │   ├── screenshots/
│   │   │   ├── iphone/
│   │   │   └── ipad/
│   │   └── previews/
│   │       └── iphone/
│   └── Vietnamese/
│       ├── promo.txt
│       └── screenshots/iphone/
│
├── Holiday Sale/
│   ├── deeplink.txt
│   ├── English (U.S.)/
│   │   └── screenshots/iphone/
│   └── Japanese/
│       └── screenshots/iphone/
│
└── _template/                    ← thư mục bắt đầu bằng _ hoặc . sẽ bị bỏ qua tự động
```

### Bước 2 — Import

1. Vào trang **CPP List** của app
2. Nhấn nút **Bulk Import CPPs**
3. Kéo thả thư mục root vào vùng drop, hoặc nhấn **Browse folder**
4. Xem preview (3-cấp: CPP → Locale → Files):
   - 🔵 **New CPP** — tên CPP chưa tồn tại, sẽ được tạo mới
   - 🟢 **Existing** — tên CPP đã có (so sánh không phân biệt hoa/thường), chỉ thêm locale/assets
   - ⚫ **Skip** — thư mục rỗng hoặc bắt đầu bằng `_`/`.`
5. Nhấn **Import All**
6. Theo dõi tiến trình (2 CPP chạy song song, locale trong mỗi CPP chạy tuần tự)

### CPP tồn tại hay CPP mới?

Hệ thống tự động nhận diện:
- **Tên folder khớp** với CPP đang có (không phân biệt hoa/thường) → merge, không tạo lại
- **Tên folder mới** → tạo CPP mới
- Sau khi tạo CPP mới, trạng thái là **Draft**, chưa submit

---

## 6. Xoá CPP

### Xoá 1 hoặc nhiều CPP

1. Vào trang **CPP List**
2. Tích checkbox vào CPP cần xoá (tích nhiều để xoá nhiều cùng lúc)
3. Nhấn nút **Delete** xuất hiện trên action bar
4. Xem danh sách CPP sẽ xoá trong dialog xác nhận
5. Nhấn **Confirm Delete** để xoá

### Lưu ý

- **Không thể hoàn tác** — xoá CPP sẽ xoá vĩnh viễn khỏi App Store Connect
- CPP đang ở trạng thái **In Review** hoặc **Approved** có thể không xoá được — Apple sẽ trả lỗi

---

## 7. Export danh sách CPP ra CSV

1. Vào trang **CPP List**
2. Nhấn nút **Export CSV** (góc trên phải, cạnh "Bulk Import CPPs")
3. File CSV được tải về tự động với tên `cpps-YYYY-MM-DD.csv`

### Nội dung file CSV

```
Name,Status,URL
Summer Campaign,Draft,https://apps.apple.com/us/app/myapp/id123?ppid=abc123
Holiday Sale,Approved,https://apps.apple.com/us/app/myapp/id123?ppid=def456
```

| Column | Nội dung |
|---|---|
| Name | Tên CPP |
| Status | Trạng thái (Draft / In Review / Approved / Rejected) |
| URL | Link App Store của CPP — dùng để share hoặc test |

---

## 8. Submit CPP để Apple Review

### Submit 1 hoặc nhiều CPP

1. Vào trang **CPP List**
2. Tích checkbox vào CPP cần submit (chỉ CPP ở trạng thái **Draft** mới có thể submit)
3. Nhấn nút **Submit** (màu xanh, góc trên phải action bar)
4. Dialog xác nhận hiển thị danh sách CPP sẽ submit:
   - ✓ Eligible — CPP có thể submit
   - ⚠ Not eligible — CPP không ở trạng thái Draft (sẽ bỏ qua)
5. Nhấn **Submit for Review** để gửi
6. Kết quả hiện theo từng CPP (thành công / lỗi)

### Trạng thái CPP sau khi submit

| Trạng thái | Ý nghĩa |
|---|---|
| **Draft** | Đang soạn thảo, chưa gửi |
| **In Review** | Đã gửi Apple, đang chờ duyệt |
| **Approved** | Apple đã duyệt — CPP hiển thị với người dùng |
| **Rejected** | Apple từ chối — hover vào badge đỏ để xem lý do |

### Lưu ý

- CPP cần có ít nhất 1 locale với đủ assets trước khi submit — nếu thiếu assets, Apple sẽ trả lỗi 422 và hiện thông báo trong kết quả
- Sau khi submit, CPP không còn chỉnh sửa được cho đến khi Apple duyệt hoặc từ chối

---

## 9. Cấu trúc thư mục chuẩn

### Bulk Import Assets (1 CPP)

```
<ten-folder>/
├── <locale>/
│   ├── promo.txt
│   ├── screenshots/
│   │   ├── iphone/   ← PNG files
│   │   └── ipad/     ← PNG files
│   └── previews/
│       ├── iphone/   ← MP4 files
│       └── ipad/     ← MP4 files
└── <locale-2>/
    └── ...
```

### CPP Bulk Import (nhiều CPP)

```
<root>/
├── primary-locale.txt            ← BCP-47 code (ví dụ: en-US)
├── metadata.xlsx                 ← optional (khuyến nghị)
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
├── <Tên CPP 2>/
│   └── ...
└── _ignored/                     ← thư mục bắt đầu _ hoặc . sẽ bị bỏ qua
```

### Tên locale được chấp nhận

Cả hai dạng sau đây đều hợp lệ cho tên thư mục locale:

| Tên Apple (user-friendly) | BCP-47 code |
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

Xem đầy đủ 39 locales Apple hỗ trợ trong file `public/metadata-template.xlsx`.

---

## 10. Các file template và file hỗ trợ

### `promo.txt` — Promotional Text

- **Mục đích:** Chứa nội dung promotional text cho 1 locale
- **Vị trí:** Trong thư mục locale (ví dụ: `en-US/promo.txt`)
- **Format:** Plain text, UTF-8, không có định dạng đặc biệt

```
Khám phá ưu đãi mùa hè với hàng nghìn sản phẩm giảm giá đến 70%. Mua sắm ngay hôm nay!
```

- **Giới hạn:** Apple giới hạn 170 ký tự cho promotional text
- **Lưu ý:** Nếu không có file này, promotional text của locale đó sẽ không được cập nhật. Nếu dùng `metadata.xlsx`, file này bị bỏ qua.

---

### `deeplink.txt` — Deep Link

- **Mục đích:** URL scheme mở thẳng vào màn hình cụ thể trong app
- **Vị trí:** Trong thư mục gốc của CPP (cùng cấp với các thư mục locale)
- **Format:** 1 dòng duy nhất chứa URL

```
myapp://campaign/summer2026
```

**Ví dụ thực tế:**
```
myapp://product/123
```

- **Lưu ý:** Nếu dùng `metadata.xlsx`, file này bị bỏ qua.

---

### `primary-locale.txt` — Primary Locale

- **Mục đích:** Chỉ định locale chính dùng khi tạo CPP mới trong **CPP Bulk Import**
- **Vị trí:** Trong thư mục **root** (cùng cấp với các thư mục CPP), **không phải** bên trong thư mục CPP
- **Format:** BCP-47 code duy nhất

```
en-US
```

**Các giá trị phổ biến:**
- `en-US` — English (U.S.)
- `vi` — Vietnamese
- `ja` — Japanese

**Nếu file thiếu hoặc giá trị không hợp lệ:** Hệ thống tự fallback theo thứ tự ưu tiên:
1. Locale đầu tiên đã có trong app store page
2. Locale đầu tiên trong thư mục (theo alphabet)
3. `en-US`

---

### `metadata.xlsx` — Excel Metadata *(khuyến nghị)*

- **Mục đích:** Quản lý tập trung deep link và promotional text cho nhiều CPP + nhiều locale trong 1 file Excel
- **Vị trí:** Trong thư mục **root** (cùng cấp với `primary-locale.txt`)
- **Ưu tiên:** Khi có file này → **Excel thắng toàn bộ**, bỏ qua `deeplink.txt` và `promo.txt`

**Cấu trúc file:**

| CPP Name | Deep Link | English (U.S.) | Vietnamese | Japanese |
|---|---|---|---|---|
| Summer Campaign | myapp://summer | Summer deals! | Ưu đãi mùa hè! | |
| Holiday Sale | | Holiday savings! | | ホリデーセール |
| Winter Promo | myapp://winter | | | |

**Quy tắc:**
- **Row 1** = header (bắt buộc có cột `CPP Name` và `Deep Link`)
- **Cột `CPP Name`** — phải khớp **chính xác** (phân biệt hoa/thường) với tên thư mục CPP
- **Cột `Deep Link`** — ô trống = không set deep link
- **Cột locale** — tên cột dùng tên Apple user-friendly (ví dụ: `Vietnamese`, không phải `vi`)
- **Ô trống** = không cập nhật giá trị đó
- **Dòng trong Excel không có thư mục CPP tương ứng** → bỏ qua
- **Thư mục CPP không có dòng trong Excel** → hiển thị cảnh báo `⚠ No metadata` trong preview

**Download template:** Tải file mẫu tại `/metadata-template.xlsx` từ server (hoặc hỏi admin)

**Giới hạn:** File tối đa 5MB. Chỉ đọc sheet đầu tiên.

---

### Tóm tắt: file nào dùng ở đâu?

| File | Dùng khi | Vị trí |
|---|---|---|
| `promo.txt` | Bulk Import 1 CPP hoặc CPP Bulk Import (không có metadata.xlsx) | Trong thư mục locale |
| `deeplink.txt` | CPP Bulk Import (không có metadata.xlsx) | Trong thư mục CPP |
| `primary-locale.txt` | CPP Bulk Import | Root folder (cùng cấp CPP folders) |
| `metadata.xlsx` | CPP Bulk Import (thay thế promo.txt + deeplink.txt) | Root folder |

---

## Câu hỏi thường gặp

**Q: Thứ tự ảnh trong App Store được quyết định bởi điều gì?**
A: Theo thứ tự tên file lexicographic. Đặt tên file có số thứ tự ở đầu (ví dụ: `01_home.png`, `02_detail.png`) để kiểm soát thứ tự hiển thị.

**Q: Có thể upload ảnh iPhone và iPad riêng không?**
A: Có. Đặt ảnh iPhone vào thư mục `screenshots/iphone/` và ảnh iPad vào `screenshots/ipad/`. Nếu chỉ có thư mục `iphone/` thì chỉ upload cho iPhone.

**Q: Tôi vừa upload nhầm ảnh, có xoá được không?**
A: Hiện tại CPP Manager chưa hỗ trợ xoá ảnh đơn lẻ qua UI. Vui lòng đăng nhập trực tiếp vào App Store Connect để xoá ảnh.

**Q: Tại sao submit CPP bị lỗi 422?**
A: Apple yêu cầu CPP phải có ít nhất 1 screenshot cho locale chính trước khi submit. Hãy upload ảnh cho CPP trước khi submit.

**Q: `primary-locale.txt` cần đặt trong thư mục CPP hay thư mục root?**
A: Đặt trong **thư mục root** (cùng cấp với các thư mục CPP), dùng chung cho toàn bộ batch.

**Q: Metadata.xlsx có phân biệt hoa/thường khi so sánh tên CPP không?**
A: Có. Cột `CPP Name` trong Excel phải khớp **chính xác** với tên thư mục CPP.
