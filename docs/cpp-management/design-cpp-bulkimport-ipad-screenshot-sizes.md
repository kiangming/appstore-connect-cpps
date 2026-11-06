# [CPP-bulkimport-ipad-screenshot-sizes] Bulk Import CPP — hỗ trợ các kích thước screenshot iPad mới — census + thiết kế

**Trạng thái:** census + thiết kế (2026-11-06). **KHÔNG CODE.** Chờ Manager chốt §P6.
**Nhánh:** `arc-cpp-bulkimport-ipad-screenshot-sizes` (từ `origin/main` = `1a87a75`).
**Phạm vi:** module CPP Manager — step upload screenshot của Bulk Import. Twin path liệt kê ở §1.5.

Nhãn mức chắc: **ĐÃ ĐO** (probe chạy code thật) · **ĐỌC CODE** (file:line) · **CÓ TRONG SCHEMA** (OAS 4.4.1, kèm JSON pointer) · **THEO TÀI LIỆU APPLE (Manager cung cấp)** · **SUY LUẬN** · **CHƯA BIẾT**.
Không có lệnh nào gửi lên Apple trong census này (không upload, không GET).

Cách đo: probe vitest/jsdom tạm (`claude-tmp-ipad-probe.test.ts`, gitignored, không commit) gọi **hàm thật** `validateScreenshot` (`lib/asset-validator.ts`) với 30 kích thước (26 kích thước iPad do Manager cung cấp + 4 kích thước iPhone hôm nay), mỗi kích thước thử với cả `ipad` lẫn `iphone`. `Image` được thay bằng bản giả trả đúng kích thước (jsdom không giải mã được ảnh). Probe cũng gọi **hàm thật** `parseCppFolderStructure` với 8 đường dẫn thư mục.

---

## TL;DR

1. **Tool KHÔNG suy display type từ kích thước ảnh.** Thư mục (`screenshots/ipad/`) quyết định đó là ảnh iPhone hay iPad. Display type là set iPad **đã có** trong locale (set cuối cùng theo thứ tự Apple trả về), hoặc set của locale "ready" đầu tiên, hoặc mặc định `APP_IPAD_PRO_3GEN_129`. Mọi ảnh iPad của một locale đổ chung vào **một** set (ĐỌC CODE §1.3).
2. **Bảng kích thước iPad hôm nay chỉ có 4 mục** (2064×2752, 2048×2732 và bản landscape). Cả 20 kích thước 11" / 10.5" / 9.7" đều bị từ chối ở client (ĐÃ ĐO §1.2). Câu báo lỗi nguyên văn ở §1.4.
3. **OAS 4.4.1 không có display type iPad nào mới**: vẫn đúng 5 giá trị `APP_IPAD_*`, cùng 5 giá trị tool đã biết. OAS **không khai** kích thước pixel nào (§2.2). ⇒ "Kích thước mới" là kích thước mới **bên trong** các display type cũ. Kích thước nào vào display type nào là **SUY LUẬN** — cần đo qua ASC UI (§3.3).
4. **Kích thước mơ hồ duy nhất:** 2048×2732 / 2732×2048, có ở cả nhóm 13" lẫn 12.9" (§3.2).
5. **Lỗ hổng sẵn có (ĐỌC CODE):** nếu locale đã có set iPad khác 13" (vd set 11" tạo trên ASC), ảnh 13" qua được bước kiểm rồi được gửi vào set 11". Tool **không đọc lại `assetDeliveryState`**, nên nếu Apple xử lý ảnh thất bại, tool vẫn báo thành công (§1.3, §2.3).
6. **Thiết kế:** một bảng spec duy nhất (display type → kích thước). Mỗi ảnh iPad được phân loại **theo kích thước** rồi gom theo display type. Dùng chung cho cả 2 dialog bulk + editor (§P4).

---

## P1 — Census logic hiện tại

### 1.1 Step upload screenshot của CPP Bulk Import — luồng từ lúc chọn thư mục tới lúc gọi Apple

Bulk Import nhiều CPP: `components/cpp/CppBulkImportDialog.tsx` (mở từ CPP List).

| Bước | Ở đâu | Làm gì |
|---|---|---|
| 1. Chọn thư mục | `CppBulkImportDialog.tsx:1143-1146` (`<input webkitdirectory>`) | Trình duyệt trả về FileList kèm `webkitRelativePath` |
| 2. Phân loại file | `lib/parseCppFolderStructure.ts:150-160` | `<root>/<CPP>/<locale>/screenshots/<device>/<file>`: `device` (đổi về chữ thường) = `iphone` hoặc `ipad` ⇒ vào `screenshotFiles.iphone` hoặc `.ipad`. Đường dẫn khác bị bỏ qua im lặng. Sắp xếp theo tên file (`:164-172`) |
| 3. Kiểm kích thước | `CppBulkImportDialog.tsx:418-450` | `validateScreenshot(f, device)` cho từng file; lỗi ⇒ `screenshotErrors` |
| 4. Chặn nếu sai | `CppBulkImportDialog.tsx:1023-1035`, `:1514-1522` | locale có lỗi ⇒ CPP bị "blocked (invalid assets)", nút **Import All** bị khoá |
| 5. Chọn display type cho cả CPP | `CppBulkImportDialog.tsx:806-845` | Mặc định `APP_IPAD_PRO_3GEN_129` (`:35`); nếu có locale "ready" thì GET các set của nó, lấy set `APP_IPAD*` **cuối cùng** |
| 6. Chọn display type cho từng locale | `CppBulkImportDialog.tsx:589-622` | GET các set của chính locale đó; set `APP_IPAD*` cuối cùng thắng; không có ⇒ giá trị của bước 5 |
| 7. Lấy hoặc tạo set | `CppBulkImportDialog.tsx:624-647` → `POST /api/asc/screenshot-sets` → `lib/asc-client.ts:542-566` → `POST /v1/appScreenshotSets` | Một set cho **toàn bộ** ảnh iPad của locale |
| 8. Upload từng file | `CppBulkImportDialog.tsx:674-694` → `POST /api/asc/upload` (`app/api/asc/upload/route.ts:23-40`) | Server: reserve (`asc-client.ts:568-590`) → PUT chunk (`:612-633`) → MD5 + commit (`:592-609`) |

### 1.2 Bảng kích thước đang được chấp nhận — một chỗ, 4 mục cho mỗi loại máy

**Một chỗ duy nhất:** `lib/asset-validator.ts:21-30` (`SCREENSHOT_SIZES`, không export). Cả 3 luồng upload dùng chung qua `validateScreenshot` (§1.5).

| Thiết bị | Kích thước nhận (ĐỌC CODE `asset-validator.ts:22-29`) |
|---|---|
| iPhone | 1284×2778 · 2778×1284 · 1242×2688 · 2688×1242 |
| iPad | 2064×2752 · 2752×2064 · 2048×2732 · 2732×2048 |

Bảng không chứa display type. Nó chỉ phân biệt `iphone` / `ipad`.

**ĐÃ ĐO (probe, hàm thật):** đối chiếu với danh sách của Manager —

| Nhóm (tài liệu Apple) | Kích thước | `ipad` | `iphone` |
|---|---|---|---|
| 13" | 2064×2752 · 2752×2064 · 2048×2732 · 2732×2048 | **OK** cả 4 | REJECT |
| 12.9" | 2048×2732 · 2732×2048 | **OK** cả 2 | REJECT |
| 11" | 1488×2266 · 2266×1488 · 1512×2316 · 2316×1512 · 1668×2420 · 2420×1668 · 1668×2388 · 2388×1668 · 1640×2360 · 2360×1640 | **REJECT cả 10** | REJECT |
| 10.5" | 1668×2224 · 2224×1668 | **REJECT cả 2** | REJECT |
| 9.7" | 1536×2008 · 1536×2048 · 2048×1496 · 2048×1536 · 768×1004 · 768×1024 · 1024×748 · 1024×768 | **REJECT cả 8** | REJECT |
| iPhone hôm nay | 1284×2778 · 2778×1284 · 1242×2688 · 2688×1242 | REJECT | OK cả 4 |

### 1.3 ⭐ Tool quyết định "ảnh này thuộc loại màn hình nào" bằng cách nào

**Hai tầng, và không tầng nào dùng kích thước ảnh:**

1. **iPhone hay iPad — theo TÊN THƯ MỤC** (ĐỌC CODE `parseCppFolderStructure.ts:152-155`; ĐÃ ĐO). Probe với 8 đường dẫn:
   - `screenshots/ipad/`, `screenshots/iPad/`, `screenshots/IPAD/` ⇒ iPad (không phân biệt hoa thường).
   - `screenshots/iphone/` ⇒ iPhone.
   - `screenshots/ipad-11/`, `screenshots/ipad 13/`, `screenshots/ipad/11/`, và file nằm thẳng trong `screenshots/` ⇒ **bị bỏ qua im lặng** (không cảnh báo).
2. **Display type — theo SET ĐÃ CÓ, không theo ảnh** (ĐỌC CODE). Chỉ có một biến `ipadSS` cho mỗi locale, chọn theo thứ tự ưu tiên:
   1. locale đã có set `APP_IPAD*` ⇒ lấy **set cuối cùng** trong mảng Apple trả về (`CppBulkImportDialog.tsx:604-609`; thứ tự mảng của Apple: **CHƯA BIẾT**);
   2. nếu không có ⇒ set `APP_IPAD*` cuối cùng của locale "ready" đầu tiên trong CPP (`:812-830`);
   3. nếu vẫn không có ⇒ `DEFAULT_IPAD_SCREENSHOT = "APP_IPAD_PRO_3GEN_129"` (`:35`).

   Mọi ảnh trong `screenshots/ipad/` của locale vào **cùng một set** đó (`:675-680`).

**Không có chỗ nào map kích thước → `screenshotDisplayType`.** Grep `naturalWidth|getImageDimensions` ngoài `asset-validator.ts`: 0 kết quả. Kết quả đọc kích thước chỉ dùng để trả OK / lỗi (`asset-validator.ts:119-126`), rồi bị bỏ đi.

**Hệ quả (ĐỌC CODE, chưa đo trên Apple):**
- Không có set iPad nào ⇒ cả 4 kích thước được nhận đều vào `APP_IPAD_PRO_3GEN_129`.
- Locale (hoặc locale "ready" đầu tiên) đã có set `APP_IPAD_PRO_3GEN_11` / `_105` / `_97` / `_PRO_129` (vd tạo bằng ASC UI) ⇒ ảnh 13" qua được bước kiểm rồi bị gửi vào set đó. Apple xử lý thế nào: **CHƯA BIẾT**. Tool báo thành công dù kết quả ra sao (§2.3).

### 1.4 Ảnh sai kích thước hôm nay bị xử lý thế nào

| Lớp | Hành vi | Nguồn |
|---|---|---|
| Client (bulk) | Từ chối khi Preview; locale/CPP bị chặn; nút Import All bị khoá | `CppBulkImportDialog.tsx:1023-1035`, `:1514-1522`; hiển thị `:1385-1399` |
| Server | **Không kiểm gì.** `/api/asc/upload` nhận mọi file rồi reserve / PUT / commit | `app/api/asc/upload/route.ts:7-46` |
| Apple | **Tool không đọc.** Kết quả xử lý ảnh nằm ở `assetDeliveryState` (bất đồng bộ); tool chỉ kiểm `res.ok` | `CppBulkImportDialog.tsx:689-692`; §2.3 |

**Câu báo lỗi nguyên văn (ĐÃ ĐO).** Dòng hiển thị = `${f.name}: ` + câu này (`CppBulkImportDialog.tsx:433`), dưới tiêu đề `ipad — errors` (`:1395`, CSS `capitalize`):
```
Resolution: got 1668×2388 — expected one of: 2064×2752, 2752×2064, 2048×2732, 2732×2048
Resolution: got 2064×2752 — expected one of: 1284×2778, 2778×1284, 1242×2688, 2688×1242   ← ảnh iPad trong thư mục iphone/
Cannot read image file — file may be corrupted                                            ← asset-validator.ts:128
```

### 1.5 Twin path — mọi chỗ kiểm kích thước screenshot / chọn display type

| Đường | File | Display type chọn thế nào | Kiểm kích thước |
|---|---|---|---|
| **CPP Bulk Import** (nhiều CPP) | `components/cpp/CppBulkImportDialog.tsx` | §1.3 (`:34-37`, `:589-622`, `:806-845`) | `validateScreenshot(f, device)` `:432` |
| **Asset Bulk Import** (một CPP) | `components/cpp/BulkImportDialog.tsx` | **Bản sao** của cùng logic: mặc định `:27-28`, CPP-wide `:259-285`, theo locale `:382-405`, lấy hoặc tạo set `:407-430`, upload `:457-475`. Comment ở dialog nhiều CPP xác nhận là bản chép (`CppBulkImportDialog.tsx:534` "mirrors BulkImportDialog.uploadLocale") | `validateScreenshot` `:186`; chặn `:499-506`, `:837` |
| **CPP Editor** (tay, một locale) | `components/cpp/LocalizationManager.tsx` | Người dùng thả ảnh vào dropzone của một set **đã có** (`:889-930`). Locale chưa có set iPad ⇒ fallback `APP_IPAD_PRO_3GEN_129` (`:856-859`). Không thể thêm set loại thứ hai khi đã có một set (chỉ render dropzone của set đã có) | `validateScreenshot(f, device)`, với `device` suy từ **tên** display type (`:522`: `includes("IPHONE")`) ⇒ kiểm theo bảng iPad chung, **không theo set đích**. Hệ quả: thả ảnh 11" vào set 11" có sẵn vẫn bị từ chối, còn ảnh 13" thả vào set 11" lại qua. Đếm tối đa 10 (`:537-543`) |
| `AssetUploader` | `components/upload/AssetUploader.tsx` | — | **Không kiểm gì.** Không được import ở đâu (grep `AssetUploader`: 0 chỗ dùng) ⇒ code chết |
| IAP review screenshot | `app/api/iap-management/.../create-on-apple/route.ts:72-73`, `update-on-apple/route.ts:63-66` | Resource khác (screenshot review IAP), **không có** `ScreenshotDisplayType` | Chỉ ≤ 8MB + PNG/JPEG. Ngoài phạm vi |
| Screenshot của App Store version | — | Không có trong repo (grep `appStoreVersionLocalization` ngoài IAP: 0) | — |

**Có dùng chung một bảng không?**
- **Bảng kích thước:** CÓ, một chỗ (`asset-validator.ts:21-30`).
- **Kiến thức về display type:** KHÔNG — nằm rải ở 6 chỗ, không chỗ nào nối với kích thước:

| Chỗ | Nội dung |
|---|---|
| `types/asc.ts:102-114` | union 12 giá trị (thiếu `APP_IPHONE_58` so với OAS) |
| `LocalizationManager.tsx:38-48` | danh sách label (thiếu `APP_IPAD_97`, `APP_IPHONE_40`, `_35`) |
| `CppDetailPanel.tsx:40-51` | label |
| `CppBulkImportDialog.tsx:34-37`, `BulkImportDialog.tsx:27-30` | mặc định chép 2 lần |
| `LocalizationManager.tsx:857-859` | fallback (iPhone ở đây là `APP_IPHONE_67`, trong khi 2 dialog dùng `APP_IPHONE_65` — §Phát hiện bên lề) |

### 1.6 Tài liệu / UI / câu chữ đang liệt kê kích thước hoặc display type

| Chỗ | Nội dung | Cập nhật? |
|---|---|---|
| `docs/feature-asset-validation.md:34-35` | bảng kích thước iPhone / iPad (y hệt code) | **Có** |
| `docs/user-guide.md:124`, `:148`, `:162`, `:526` (+ `user-guide.docx` / `.pdf` — cách sinh: CHƯA BIẾT) | thư mục `ipad/`, "ảnh PNG cho iPad"; không có kích thước | **Có** — thêm bảng kích thước + câu "mỗi ảnh tự vào đúng loại màn hình theo kích thước" |
| `CppBulkImportDialog.tsx:1130-1140` (khung "Expected folder structure") | chỉ vẽ `screenshots/iphone/` | Nên thêm `screenshots/ipad/` |
| `CppDetailPanel.tsx:47-51`, `LocalizationManager.tsx:44-47` | label `iPad Pro 12.9" (3rd gen)` cho `APP_IPAD_PRO_3GEN_129` | **Có**, nếu §3.1 xác nhận set này là 13" (SUY LUẬN) |
| `docs/architecture.md:163`, `:213`; `docs/feature-cpp-editor.md:152`; `docs/bulk-import-design.md:128`, `:195`, `:269`; `docs/feature-cpp-bulk-import-design.md:207`, `:487`; `docs/CURRENT-STATE.md:42` | mặc định / danh sách display type | Có (mô tả luật mới) |
| `docs/user-docs/index.html` | không nhắc iPad / kích thước (grep) | Không |

---

## P2 — Đối chiếu OAS (`docs/openapi.oas.v20260717.json`, `info.version` = **4.4.1**)

### 2.1 Enum `ScreenshotDisplayType` — CÓ TRONG SCHEMA

Pointer: `#/components/schemas/ScreenshotDisplayType/enum` (cùng danh sách ở `filter[screenshotDisplayType]` của `#/paths/~1v1~1appCustomProductPageLocalizations~1{id}~1appScreenshotSets/get/parameters`).

| Nhóm | Giá trị trong OAS | Tool có trong `types/asc.ts`? |
|---|---|---|
| iPad (5) | `APP_IPAD_PRO_3GEN_129` · `APP_IPAD_PRO_3GEN_11` · `APP_IPAD_PRO_129` · `APP_IPAD_105` · `APP_IPAD_97` | Có đủ 5 |
| iPhone (8) | `APP_IPHONE_67` · `APP_IPHONE_61` · `APP_IPHONE_65` · `APP_IPHONE_58` · `APP_IPHONE_55` · `APP_IPHONE_47` · `APP_IPHONE_40` · `APP_IPHONE_35` | Có 7, thiếu `APP_IPHONE_58` |
| Khác | `APP_DESKTOP`, `APP_WATCH_*` (5), `APP_APPLE_TV`, `APP_APPLE_VISION_PRO`, `IMESSAGE_APP_*` (12) | Không (ngoài phạm vi) |

⇒ **Không có giá trị iPad nào MỚI** so với tool. OAS không có giá trị tên "13" hay "11 M4". Nhóm 13" của Apple **phải** rơi vào một trong 5 giá trị cũ (§3.1).

### 2.2 Kích thước pixel theo display type — **OAS KHÔNG KHAI**

- `#/components/schemas/ScreenshotDisplayType` chỉ có `type` + `enum`, không có `description` cho schema hay cho từng giá trị.
- Tìm toàn văn file OAS các chuỗi `2064`, `2752`, `2732`, `1668`, `2388`, `2266`, `1488`: **0 kết quả**. `pixel`: 0. Từ `dimension` có 29 lần, chỉ dưới dạng `dimension` / `dimensions` (ngữ cảnh khác, không liên quan ảnh).
- Kích thước chỉ xuất hiện ở **response**: `#/components/schemas/ImageAsset/properties/width` và `/height` (kích thước của ảnh đã upload, không phải luật).

### 2.3 Luồng upload qua API so với code

| Bước | OAS (CÓ TRONG SCHEMA) | Code | Lệch? |
|---|---|---|---|
| Tạo set | `POST /v1/appScreenshotSets`, body `#/components/schemas/AppScreenshotSetCreateRequest`: `attributes.screenshotDisplayType` (bắt buộc) + `relationships.appCustomProductPageLocalization.data {type, id}` | `asc-client.ts:542-566` | Khớp |
| — 409 | `#/paths/~1v1~1appScreenshotSets/post/responses/409` có khai | `app/api/asc/screenshot-sets/route.ts:40-44` trả **500** cho MỌI lỗi ⇒ nhánh `res.status === 409` của 2 dialog (`CppBulkImportDialog.tsx:634-641`, `BulkImportDialog.tsx:417-424`) **không bao giờ chạy** (ĐỌC CODE) | **Lệch** (code chết; không phải mục tiêu của arc) |
| Reserve | `POST /v1/appScreenshots`, `#/components/schemas/AppScreenshotCreateRequest`: `fileName`, `fileSize` (bắt buộc) + `relationships.appScreenshotSet` (bắt buộc) | `asc-client.ts:568-590` (`fileSize` = `file.size`) | Khớp |
| PUT | `uploadOperations[]` = `#/components/schemas/UploadOperation` {`method`, `url`, `length`, `offset`, `requestHeaders[]`} | `asc-client.ts:612-633`: cắt `file.slice(offset, offset+length)`, gửi đúng method + headers, tuần tự | Khớp |
| Commit | `PATCH /v1/appScreenshots/{id}`, `#/components/schemas/AppScreenshotUpdateRequest`: `uploaded`, `sourceFileChecksum` (đều nullable) | `asc-client.ts:592-609`; MD5 tính ở server (`upload/route.ts:36-37`). OAS không khai thuật toán checksum | Khớp |
| Đọc lại trạng thái | `#/components/schemas/AppScreenshot/properties/attributes/properties/assetDeliveryState` → `#/components/schemas/AppMediaAssetState`: `state` ∈ {AWAITING_UPLOAD, UPLOAD_COMPLETE, COMPLETE, FAILED}, `errors[]`, `warnings[]` (`AppMediaStateError` {code, description}); đọc qua `GET /v1/appScreenshots/{id}` | **KHÔNG CÓ.** Response PATCH được trả về client (`upload/route.ts:39-40`) nhưng cả 3 client chỉ kiểm `res.ok`. `types/asc.ts:146-149` thiếu `warnings` | **Thiếu bước** |

Mã lỗi Apple cụ thể khi sai kích thước (vd tên code trong `errors[]`): **OAS KHÔNG KHAI** (tìm `IMAGE_INCORRECT_DIMENSIONS`, `INCORRECT_DIMENSIONS`: 0 kết quả) ⇒ CHƯA BIẾT.

### 2.4 Giới hạn khác

- **Số ảnh tối đa mỗi set: OAS KHÔNG KHAI.** Từ khoá `maxItems` có 0 lần trong toàn file. Chỉ có `limit[appScreenshots]` `maximum: 50` — tham số GET khi `include`, không phải luật upload (`#/paths/~1v1~1appCustomProductPageLocalizations~1{id}~1appScreenshotSets/get/parameters`).
- **Định dạng file, dung lượng: OAS KHÔNG KHAI.** `AppScreenshotCreateRequest` chỉ có `fileName` (string) + `fileSize` (integer), không có enum hay maximum.
- **Tool:** `SCREENSHOT_LIMITS` 3–10 (`asset-validator.ts:32-35`, không ghi nguồn). Tối đa 10 chỉ được kiểm ở **editor** (`validateScreenshotCount`, gọi duy nhất ở `LocalizationManager.tsx:540`); 2 dialog bulk không đếm. Tối thiểu 3 không được kiểm ở đâu (`asset-validator.ts:308-309`, có chủ ý).

---

## P3 — Câu khó: map kích thước → display type

### 3.1 Bảng map

Việc kích thước nào thuộc nhóm nào lấy từ **TÀI LIỆU APPLE (Manager cung cấp)**. Việc nhóm nào ứng với display type nào: **SUY LUẬN** (dựa trên tên enum + 5 nhóm ↔ 5 giá trị). **Không mục nào ĐÃ ĐO.**

| Nhóm | Kích thước (P = portrait, L = landscape) | Display type đề xuất | Mức chắc của map | Hôm nay tool gửi vào |
|---|---|---|---|---|
| 13" | 2064×2752 P · 2752×2064 L · 2048×2732 P · 2732×2048 L | `APP_IPAD_PRO_3GEN_129` | SUY LUẬN (là mặc định của tool. Có ảnh 2064×2752 nào từng lên prod thành công không: CHƯA BIẾT — đo được bằng M1, §3.3) | set iPad đã chọn ở §1.3 (mặc định `APP_IPAD_PRO_3GEN_129`) |
| 12.9" (2nd gen) | 2048×2732 P · 2732×2048 L | `APP_IPAD_PRO_129` | SUY LUẬN (tên không có `3GEN`) | như trên |
| 11" | 1488×2266 · 2266×1488 · 1512×2316 · 2316×1512 · 1668×2420 · 2420×1668 · 1668×2388 · 2388×1668 · 1640×2360 · 2360×1640 | `APP_IPAD_PRO_3GEN_11` | SUY LUẬN. Apple nhận **từng** kích thước này ở set đó không: **CHƯA BIẾT** | bị từ chối ở client |
| 10.5" | 1668×2224 · 2224×1668 | `APP_IPAD_105` | SUY LUẬN | bị từ chối |
| 9.7" | 1536×2008 · 1536×2048 · 2048×1496 · 2048×1536 · 768×1004 · 768×1024 · 1024×748 · 1024×768 | `APP_IPAD_97` | SUY LUẬN | bị từ chối |

Kiểm trùng (tính trên danh sách): trong 26 mục, chỉ có **2048×2732 và 2732×2048** thuộc hai nhóm (13" và 12.9"). Không kích thước iPad nào trùng 4 kích thước iPhone hôm nay. Không có cặp portrait/landscape nào lẫn sang nhóm khác.

### 3.2 Kích thước thuộc nhiều nhóm (2048×2732 / 2732×2048)

- **Hôm nay:** vào set iPad chọn ở §1.3, không quan tâm kích thước. Mặc định là `APP_IPAD_PRO_3GEN_129`.
- **Các lựa chọn:**
  - **(A) Luôn vào 13" (`APP_IPAD_PRO_3GEN_129`).** Giữ nguyên hành vi mặc định hôm nay. Phủ được loại BẮT BUỘC. Theo tài liệu Apple, 12.9" thiếu thì Apple dùng ảnh 13" thu nhỏ ⇒ không mất gì.
  - (B) Luôn vào 12.9" (`APP_IPAD_PRO_129`). Đổi hành vi hôm nay. Loại 13" BẮT BUỘC có thể bị bỏ trống.
  - (C) Gửi vào cả hai set. Ảnh nhân đôi, tốn gấp đôi slot (10/set). Phức tạp.
  - (D) Như (A), nhưng cho phép ghi đè bằng thư mục con (vd `screenshots/ipad-12.9/`). Đổi cấu trúc thư mục, làm tăng phạm vi parser.
- **Đề xuất: (A)**, chưa chốt. Lý do: giữ đúng hành vi hôm nay, phủ loại bắt buộc, không đổi cấu trúc thư mục. Nhu cầu ảnh 12.9" riêng: chưa ai nêu.

### 3.3 Các kích thước 11" mới — CHƯA BIẾT. Cách đo an toàn

OAS và tài liệu Manager gửi không nói kích thước 11" vào display type nào ⇒ **CHƯA BIẾT**. Đề xuất hai phép đo, đều do Manager làm, tool không ghi gì:

**M1 — chỉ đọc, 0 lần ghi (làm trước, nếu có sẵn dữ liệu).** Tìm một CPP (hoặc locale) đã có ảnh iPad 11" / 10.5" / 13" do ai đó upload qua ASC UI:
1. Mở CPP đó trong tool (CPP Editor), mở DevTools ▸ Network, lọc `screenshot-sets`.
2. Chọn request `GET /api/asc/screenshot-sets?localizationId=…` ▸ Response.
3. Ghi lại: với mỗi phần tử `data[]`, ghi `attributes.screenshotDisplayType` + danh sách id ở `relationships.appScreenshots.data`. Với mỗi id đó, ghi `attributes.imageAsset.width` / `height` trong `included[]`.

⇒ Ảnh nào Apple **đã nhận** ở set nào — ĐÃ ĐO, không tốn lần ghi nào. Không chứng minh được điều ngược lại (kích thước X bị từ chối).

**M2 — upload thử qua giao diện ASC (cách đã dùng thành công trước đây, KB §32).** Trên **app/CPP thử nghiệm**, ở một locale nháp:
1. Chuẩn bị ảnh PNG đúng kích thước. Tối thiểu: 1488×2266, 1512×2316, 1668×2420, 1640×2360, 1668×2388 (portrait 11"), 2388×1668 (một landscape 11"), 2064×2752 (13"), 2048×2732 (thả vào ô 12.9"), và 1 ảnh **sai** (vd 1600×2400) vào ô 11" để lấy câu lỗi của Apple.
2. Mở App Store Connect ▸ app thử ▸ Custom Product Page thử ▸ locale nháp. Mở DevTools ▸ Network, bật **Preserve log**, lọc `appScreenshot`.
3. Ở phần iPad, mở danh sách đủ loại màn hình (ASC gọi là "View All Sizes in Media Manager" — tên nút: SUY LUẬN, có thể khác), thả từng ảnh vào ô 11".
4. Với mỗi lần thả, ghi lại:
   - (a) request **tạo set** (nếu có) ▸ Payload: `screenshotDisplayType`;
   - (b) request **reserve** `appScreenshots` ▸ Payload: `fileName`, `fileSize`;
   - (c) request **PATCH** commit, rồi request **GET** sau đó ▸ Response: `assetDeliveryState.state` + `errors[]`;
   - (d) câu lỗi ASC UI hiện trên màn hình (nếu có), chụp nguyên văn.
5. Lặp lại cho ảnh 13" ở ô 13", ảnh 2048×2732 ở ô 12.9".
6. Xoá các ảnh thử khỏi locale nháp. Không submit.

⇒ Kết quả M2 thay cột "Mức chắc" ở §3.1 từ SUY LUẬN thành ĐÃ ĐO. M2 cũng cho mã lỗi thật của Apple (§2.3) để viết câu báo.
**Đề xuất:** làm M2 **trước khi code phần map** (chặn ở push, như checkpoint migration: code có thể viết song song, không push khi chưa có kết quả M2).

### 3.4 "Bắt buộc 13" nếu app chạy trên iPad" và "không có thì Apple dùng ảnh thu nhỏ"

- **Hôm nay tool không bắt buộc gì** (ĐỌC CODE):
  - Bulk không đòi có ảnh iPad.
  - Không kiểm số tối thiểu (`asset-validator.ts:308-309`).
  - Luồng submit không nhắc tới screenshot (grep `screenshot|ipad` trong `app/api/asc/cpps/submit/**`: 0).
  - Tool **không biết** app có chạy trên iPad hay không (không đọc thuộc tính thiết bị của app).
- Với tập kích thước hôm nay, mọi ảnh iPad được nhận đều là cỡ 13" ⇒ "chỉ cần loại lớn nhất" đúng **ngẫu nhiên**. Khi nhận thêm 11" / 10.5" / 9.7", có thể xảy ra trường hợp mới: thư mục `ipad/` chỉ có ảnh 11" ⇒ locale có set 11" mà không có set 13".
- **Đề xuất:** không chặn (Apple chặn lúc submit; tool không biết app có hỗ trợ iPad không). **Cảnh báo ở Preview, không khoá Import:** "locale X: iPad screenshots have no 13-inch set — Apple requires 13-inch for iPad apps". Chỉ hiện khi sau import locale sẽ **không** có set `APP_IPAD_PRO_3GEN_129`.

---

## P4 — Thiết kế (đề xuất, chưa chốt)

### 4.1 Một bảng spec duy nhất

Module mới, thuần (không `"use client"`, không DOM): `lib/cpp/screenshot-specs.ts` (tên: đề xuất).

```ts
// Mỗi display type một mục; thứ tự = thứ tự ưu tiên khi một kích thước thuộc nhiều nhóm (§3.2).
export const SCREENSHOT_SPECS: ReadonlyArray<{
  displayType: ScreenshotDisplayType;
  device: "iphone" | "ipad";
  label: string;                         // 'iPad 13"' … — nguồn cho mọi label UI
  sizes: ReadonlyArray<readonly [w: number, h: number]>;
  source: string;                        // "Apple docs via Manager 2026-11-06" / "ĐÃ ĐO M2 <ngày>"
}>;
export function classifyScreenshot(device, w, h):
  | { ok: true; displayType: ScreenshotDisplayType }
  | { ok: false; error: string };       // câu §4.3
export function sizesFor(device): …     // cho asset-validator + câu báo lỗi
```

- `asset-validator.ts` bỏ `SCREENSHOT_SIZES` riêng, lấy kích thước từ bảng này. `validateScreenshot` trả thêm `displayType`.
- **Phạm vi gộp (Manager chốt, Q4):**
  - **S1** — chỉ kích thước + phân loại (validator + 2 dialog bulk).
  - **S2** — S1 + label / union display type từ cùng bảng (`CppDetailPanel.tsx:40-51`, `LocalizationManager.tsx:38-48`, mặc định ở 2 dialog + editor).
  - **S3** — S2 + **gộp phần chọn set + upload screenshot của 2 dialog bulk thành một hàm dùng chung** (hôm nay là bản chép, §1.5) + editor kiểm theo **set đích** thay vì theo thiết bị.
  - **Đề xuất S3.** Lý do: KB P1 (twin-path — một choke point thay vì vá 2–3 chỗ) và P8 (twin-structure). Nếu chỉ sửa dialog nhiều CPP, dialog một CPP và editor sẽ lệch ngay ngày đầu (editor đang từ chối ảnh 11" kể cả khi thả vào set 11").

### 4.2 Thêm kích thước mới + phân loại theo kích thước

- **iPad:**
  1. Mỗi ảnh trong `screenshots/ipad/` ⇒ đọc kích thước (đã đọc sẵn khi kiểm) ⇒ `classifyScreenshot` ⇒ display type.
  2. Gom theo display type. Lấy hoặc tạo **một set cho mỗi display type** (cache theo type như hôm nay, `ssCache`).
  3. Thứ tự trong mỗi set = thứ tự tên file (giữ `parseCppFolderStructure.ts:164-172`).
- **Bỏ** luật "set iPad cuối cùng đã có / của locale ready đầu tiên" **cho screenshot iPad**. Display type đến từ ảnh, không đến từ set có sẵn. Set có sẵn cùng type vẫn được dùng lại (không tạo trùng).
- **iPhone: giữ nguyên** (thư mục + set có sẵn + mặc định `APP_IPHONE_65`, 4 kích thước). Ngoài phạm vi (Q6).
- **Preview (video): giữ nguyên.** Ngoài phạm vi.
- **Parity:**
  - Mọi kích thước được nhận hôm nay vẫn được nhận.
  - Trường hợp **mặc định** (locale chưa có set iPad, hoặc set có sẵn là `APP_IPAD_PRO_3GEN_129`): vào đúng display type như hôm nay.
  - ⚠ **Một trường hợp CỐ Ý đổi:** locale (hoặc locale ready đầu tiên) đã có set iPad KHÁC 13". Hôm nay ảnh 13" bị đổ vào set đó (§1.3); thiết kế mới đưa vào set 13". Cần Manager xác nhận (Q5).
- **Đếm:** tối đa 10 ảnh mỗi display type, kiểm ở Preview cho cả 2 dialog bulk (hôm nay chỉ editor kiểm). Có cần không: Q4.

### 4.3 Ảnh sai kích thước — báo sớm, câu rõ ràng

Kiểm ở bước Preview như hôm nay (client; chặn Import như hôm nay). Câu đề xuất (UI tiếng Anh, như hiện tại):

```
01.png: 1600×2400 is not a valid iPad screenshot size.
  Valid iPad sizes — 13": 2064×2752, 2752×2064, 2048×2732, 2732×2048 · 12.9": 2048×2732, 2732×2048 ·
  11": 1488×2266, 2266×1488, 1512×2316, 2316×1512, 1668×2420, 2420×1668, 1668×2388, 2388×1668, 1640×2360, 2360×1640 ·
  10.5": 1668×2224, 2224×1668 · 9.7": 1536×2008, 1536×2048, 2048×1496, 2048×1536, 768×1004, 768×1024, 1024×748, 1024×768
```

- Ảnh có cỡ iPhone nằm trong `ipad/` (hoặc ngược lại) ⇒ thêm vế: `— this looks like an iPhone screenshot; move it to screenshots/iphone/`.
- Preview liệt kê, cho mỗi locale, ảnh nào sẽ vào loại màn hình nào (`iPad 13": 01.png, 02.png · iPad 11": 03.png`).
- **Server:** không thêm kiểm ở arc này. Route upload chỉ biết `screenshotSetId`; muốn kiểm phải GET thêm set + tự đọc header PNG/JPEG. Ghi ở bên lề.
- **Đọc lại `assetDeliveryState`:** không làm ở arc này (Apple xử lý bất đồng bộ, cần poll). Ghi ở bên lề — mục BACKLOG đề xuất.

### 4.4 Docs / UI cập nhật

- Docs: mọi chỗ ở §1.6 (bảng kích thước trong `feature-asset-validation.md` + user guide sinh từ cùng danh sách).
- UI: khung "Expected folder structure" (`CppBulkImportDialog.tsx:1130-1140`) thêm `screenshots/ipad/` + một dòng "iPad images are sorted into 13" / 12.9" / 11" / 10.5" / 9.7" automatically by size".
- Label: lấy từ `SCREENSHOT_SPECS.label` (S2).

---

## P5 — Parity + test

### 5.1 G0 — ghim hiện trạng TRƯỚC khi đổi

- **Validator** (mới, jsdom + `Image` giả như probe):
  - 4 kích thước iPad + 4 iPhone ⇒ OK; chéo thiết bị ⇒ REJECT;
  - câu lỗi nguyên văn §1.4;
  - 22 kích thước còn lại trong danh sách Manager ⇒ REJECT hôm nay (khối này lật có chủ đích ở G1, ghi rõ trong test).
- **Parser:** 8 đường dẫn của probe ⇒ đúng thiết bị / bị bỏ qua.
- **Routing (dialog nhiều CPP):** harness `CppBulkImportDialog.test.tsx` đã giả `/screenshot-sets` (`:95`). Ghim:
  - không có set ⇒ `POST /api/asc/screenshot-sets` body `screenshotDisplayType: "APP_IPAD_PRO_3GEN_129"` cho 2064×2752 **và** 2048×2732;
  - có set `APP_IPAD_PRO_3GEN_129` ⇒ dùng lại id, không POST;
  - có set `APP_IPAD_PRO_3GEN_11` ⇒ ảnh 13" vào set 11" (hành vi hôm nay — ca CỐ Ý lật ở G1 nếu Q5 = đổi).
- **Dialog một CPP:** chưa có file test ⇒ dựng harness tối thiểu (S3 sẽ cho cả hai dialog gọi cùng một hàm ⇒ một bộ test bảng + một test nối dây cho mỗi dialog).

### 5.2 Test mới (G1)

- **Theo bảng:** 26 kích thước (portrait + landscape) × display type mong đợi, sinh từ bảng §3.1 viết tay trong test (KHÔNG lấy từ `SCREENSHOT_SPECS`, để mutation bảng làm test đỏ).
- **Kích thước nhiều nhóm:** 2048×2732 / 2732×2048 ⇒ theo Q1.
- **Sai kích thước:** câu §4.3 nguyên văn, đủ 5 nhóm; ảnh iPhone trong `ipad/` có vế gợi ý.
- **Thư mục trộn:** 13" + 11" trong cùng `ipad/` ⇒ 2 set, mỗi set đúng file, giữ thứ tự tên file.
- **Đếm:** 11 ảnh cùng một type ⇒ báo; 6 + 6 ảnh khác type ⇒ qua.
- **Cảnh báo 13":** chỉ có 11" ⇒ cảnh báo, Import không bị khoá.
- **Twin:** cùng một bộ ảnh qua dialog nhiều CPP và dialog một CPP ⇒ cùng dãy `POST screenshot-sets` + `upload`. Editor: ảnh 11" thả vào set 11" ⇒ nhận; ảnh 13" thả vào set 11" ⇒ từ chối.

### 5.3 Mutation (qua `scripts/mutate.sh`)

| Mutation | Phải đỏ |
|---|---|
| Bỏ một kích thước mới (vd 1640×2360) khỏi bảng | test bảng |
| Map một kích thước 11" sang `APP_IPAD_PRO_3GEN_129` | test bảng |
| Đổi display type của 2064×2752 (cũ) sang `APP_IPAD_PRO_129` | test bảng + G0 routing |
| Đảo ưu tiên của 2048×2732 | test nhiều nhóm |
| Một dialog quay về luật "set iPad cuối cùng" | test twin |
| Câu lỗi không còn liệt kê kích thước hợp lệ | test câu lỗi |
| Editor kiểm theo thiết bị thay vì set đích | test editor |
| Bỏ cảnh báo 13" / cảnh báo khoá Import | test cảnh báo |

---

## P6 — Câu cần Manager chốt

> **Q1 — 2048×2732 / 2732×2048 (thuộc cả 13" và 12.9") gửi vào đâu?** (§3.2)
> Đề xuất **(A) luôn vào 13" `APP_IPAD_PRO_3GEN_129`**. Lý do: giống hành vi mặc định hôm nay, phủ loại bắt buộc, theo tài liệu Apple 12.9" thiếu thì dùng ảnh 13" thu nhỏ, không đổi cấu trúc thư mục.
>
> **Q2 — Có đo qua ASC UI trước khi code phần map không?** (§3.3)
> Đề xuất **CÓ: M1 (chỉ đọc) nếu có dữ liệu sẵn, rồi M2 (8–9 lần thả ảnh trên CPP thử, có DevTools)**. Lý do: OAS không khai kích thước. Cả 5 dòng map ở §3.1 là SUY LUẬN, và tool không đọc `assetDeliveryState` nên map sai sẽ **không báo lỗi** — ảnh âm thầm hỏng. Code có thể viết song song; **không push** khi chưa có kết quả M2.
>
> **Q3 — Có bắt buộc 13" không?** (§3.4)
> Đề xuất **KHÔNG chặn; cảnh báo ở Preview** khi locale có ảnh iPad mà sẽ không có set 13". Lý do: tool không biết app có hỗ trợ iPad không; Apple đã chặn lúc submit.
>
> **Q4 — Phạm vi gộp bảng?** (§4.1)
> Đề xuất **S3**: một bảng spec + một hàm chọn set / upload dùng chung cho 2 dialog bulk + editor kiểm theo set đích + label lấy từ bảng + đếm tối đa 10 mỗi type ở bulk. Lý do: KB P1 / P8. Hai dialog đang là bản chép, editor đang từ chối ảnh 11" kể cả khi thả vào set 11".
>
> **Q5 — Locale đã có set iPad KHÁC 13": giữ hành vi hôm nay hay đổi?** (§1.3, §4.2)
> Đề xuất **ĐỔI**: phân loại theo kích thước ảnh. Lý do: hôm nay ảnh 13" bị đổ vào set 11" / 10.5" có sẵn, và tool không biết Apple xử lý ra sao. Đây là ca duy nhất lệch parity, có test ghim ở G0.
>
> **Q6 — iPhone ngoài phạm vi?**
> Đề xuất **CÓ, ngoài phạm vi** (bảng iPhone chỉ có 4 kích thước 6.5"; ghi BACKLOG). Lý do: Manager giao iPad; bảng spec S2 sẽ chừa sẵn chỗ cho iPhone.
>
> **Q7 — Editor: cho thêm set loại thứ hai (vd 11" khi đã có 13")?** (§1.5)
> Hôm nay không thêm được. Đề xuất **ngoài arc này** (ghi BACKLOG). Bulk sẽ tự tạo set theo kích thước; editor chỉ cần kiểm đúng theo set đích (Q4).

---

## Phát hiện bên lề (không thuộc arc — đề xuất ghi BACKLOG khi Manager duyệt)

- `[CPP-asset-delivery-state-unread]` — cả 3 đường upload không đọc `assetDeliveryState` sau commit ⇒ ảnh/video Apple xử lý thất bại vẫn hiện "uploaded successfully" (§2.3). Cùng họ KB P5 (status principle).
- `[CPP-screenshot-set-409-dead-branch]` — `/api/asc/screenshot-sets` (`route.ts:40-44`) và `/api/asc/preview-sets` (`route.ts:43`) trả 500 cho mọi lỗi ⇒ nhánh 409 (set + preview set) của 2 dialog là code chết (§2.3).
- `[CPP-bulk-folder-silent-skip]` — thư mục con lạ dưới `screenshots/` (`ipad-11/`, `ipad/11/`, file nằm thẳng trong `screenshots/`) bị bỏ qua im lặng (ĐÃ ĐO §1.3).
- `[CPP-iphone-default-mismatch]` — editor fallback iPhone `APP_IPHONE_67` (`LocalizationManager.tsx:858`), 2 dialog dùng `APP_IPHONE_65`, còn bảng iPhone chỉ có kích thước 6.5" ⇒ editor đẩy ảnh 6.5" vào set 6.7" khi locale chưa có set iPhone (ĐỌC CODE; Apple xử lý ra sao: CHƯA BIẾT).
- `[CPP-asset-uploader-dead]` — `components/upload/AssetUploader.tsx` không được import ở đâu, không kiểm gì.
- `[CPP-bulk-no-max-count]` — 2 dialog bulk không kiểm tối đa 10 ảnh mỗi set (chỉ editor kiểm). Nếu Q4 = S3 thì thuộc arc này.
- `types/asc.ts:146-149` thiếu `warnings` của `AppMediaAssetState`; union `ScreenshotDisplayType` thiếu `APP_IPHONE_58`.
