# CPP Manager — Backlog

Mỗi mục có **tag**, **vì sao chưa làm**, và **đường đúng khi làm**. Tag dùng để grep; đừng đổi tên tag đã phát ra ngoài.
Nguồn chung của các mục dưới đây: census arc `[CPP-bulkimport-ipad-screenshot-sizes]`
(`docs/cpp-management/design-cpp-bulkimport-ipad-screenshot-sizes.md`, 2026-11-06). Manager duyệt ghi BACKLOG 2026-11-06.

---

## `[CPP-iphone-screenshot-sizes]` — bảng iPhone chỉ có 4 kích thước 6.5"

**⚠ ƯU TIÊN CAO** (Manager 2026-11-06, Q6).

- **Hiện trạng (ĐỌC CODE):** `lib/asset-validator.ts:22-25` chỉ nhận 1284×2778 · 2778×1284 · 1242×2688 · 2688×1242. Mọi kích thước iPhone khác bị từ chối ở client trong cả 3 luồng upload.
- **Vì sao chưa làm:** arc iPad chỉ làm iPad (Q6). Danh sách kích thước iPhone hiện hành của Apple: CHƯA đối chiếu.
- **Đường đúng:** Manager cung cấp danh sách Apple hiện hành (như arc iPad). Thêm vào bảng spec của arc iPad (`lib/cpp/screenshot-specs.ts`, đã chừa chỗ cho iPhone). Phân loại theo kích thước như iPad. G0 ghim 4 kích thước hôm nay. Làm kèm `[CPP-iphone-default-mismatch]`.

## `[CPP-iphone-default-mismatch]` — mặc định iPhone lệch giữa editor và 2 dialog bulk

- **Hiện trạng (ĐỌC CODE):**
  - Editor dùng fallback `APP_IPHONE_67` (`components/cpp/LocalizationManager.tsx:857-858`).
  - 2 dialog bulk dùng `APP_IPHONE_65` (`CppBulkImportDialog.tsx:34`, `BulkImportDialog.tsx:27`).
  - Bảng kích thước iPhone chỉ có cỡ 6.5" ⇒ editor đẩy ảnh 6.5" vào set 6.7" khi locale chưa có set iPhone. Apple xử lý ra sao: CHƯA BIẾT.
- **Đường đúng:** làm cùng `[CPP-iphone-screenshot-sizes]`. Display type đến từ kích thước ảnh, không đến từ một hằng số mặc định.

## `[CPP-asset-delivery-state-unread]` — tool không đọc `assetDeliveryState` sau commit

**⚠ ƯU TIÊN CAO** (Manager 2026-11-06). Lý do: map display type sai hay Apple xử lý ảnh lỗi đều IM LẶNG. Với arc iPad, UAT end-to-end là lớp chặn duy nhất.

- **Hiện trạng (ĐỌC CODE):**
  - `app/api/asc/upload/route.ts:39-40` trả response PATCH về client.
  - Cả 3 client chỉ kiểm `res.ok`: `CppBulkImportDialog.tsx:689-692`, `BulkImportDialog.tsx:470-473`, `LocalizationManager.tsx:631-634`.
  - Video cũng vậy (`/api/asc/upload-preview`).
- **OAS (4.4.1):** `#/components/schemas/AppMediaAssetState`: `state` ∈ {AWAITING_UPLOAD, UPLOAD_COMPLETE, COMPLETE, FAILED}, `errors[]`, `warnings[]`. Đọc qua `GET /v1/appScreenshots/{id}`. Mã lỗi cụ thể: OAS KHÔNG KHAI.
- **Đường đúng:** Apple xử lý bất đồng bộ ⇒ cần poll có giới hạn sau commit, hoặc một bước "kiểm lại" sau khi import xong. Kết quả FAILED phải hiện thành lỗi của file (KB P5 — status principle). Đo trước: commit xong bao lâu thì `state` thành COMPLETE / FAILED (CHƯA BIẾT).

## `[CPP-screenshot-set-409-dead-branch]` — nhánh 409 của 2 dialog không bao giờ chạy

- **Hiện trạng (ĐỌC CODE):**
  - `/api/asc/screenshot-sets` (`route.ts:40-44`) và `/api/asc/preview-sets` (`route.ts:43`) trả 500 cho MỌI lỗi.
  - Nhánh `res.status === 409` ở `CppBulkImportDialog.tsx:634-641` (+ preview `:659-666`) và `BulkImportDialog.tsx:417-424` (+ preview) là code chết.
  - OAS có khai 409 cho `POST /v1/appScreenshotSets` (`#/paths/~1v1~1appScreenshotSets/post/responses/409`).
- **Đường đúng:** route trả đúng status của Apple. Lúc đó nhánh 409 mới có hiệu lực ⇒ cần test.

## `[CPP-bulk-folder-silent-skip]` — thư mục con lạ dưới `screenshots/` bị bỏ qua im lặng

- **Hiện trạng (ĐÃ ĐO, test G0 `lib/screenshot-folder-parsers.baseline.test.ts`):** `screenshots/ipad-11/`, `screenshots/ipad 13/`, `screenshots/ipad/11/`, và file nằm thẳng trong `screenshots/` đều không được nhận, không cảnh báo. Cả 2 parser đều vậy.
- **Đường đúng:** Preview hiện danh sách file bị bỏ qua kèm lý do. Không đổi cấu trúc thư mục.

## `[CPP-asset-uploader-dead]` — `components/upload/AssetUploader.tsx` là code chết

- **Hiện trạng (ĐỌC CODE):** không được import ở đâu (grep `AssetUploader`: 0 chỗ dùng). Không kiểm gì.
- **Đường đúng:** xoá (kèm cập nhật `CLAUDE.md` mục CPP Project Structure, nơi còn liệt kê `upload/AssetUploader.tsx`).

## `[CPP-bulk-no-max-count]` — 2 dialog bulk không kiểm tối đa 10 ảnh mỗi set

**→ ĐƯA VÀO arc `[CPP-bulkimport-ipad-screenshot-sizes]`** (Manager chốt Q4 = S3: đếm tối đa 10 ảnh mỗi display type ở bulk). Giữ mục để grep.

- **Hiện trạng (ĐỌC CODE):** `validateScreenshotCount` chỉ được gọi ở `LocalizationManager.tsx:540`.

## `[CPP-types-asc-gaps]` — `types/asc.ts` thiếu so với OAS 4.4.1

- `AppMediaAssetState` thiếu `warnings` (`types/asc.ts:146-149`, `:188-191`).
- Union `ScreenshotDisplayType` thiếu `APP_IPHONE_58` (`types/asc.ts:102-114`).
- **Đường đúng:** đồng bộ khi làm `[CPP-asset-delivery-state-unread]` / `[CPP-iphone-screenshot-sizes]`.

## `[CPP-two-folder-parsers]` — hai parser thư mục cho hai dialog bulk

Manager 2026-11-06 (gate G0): KHÔNG gộp trong arc iPad (G1 không đổi luật thư mục).

- **Hiện trạng (ĐỌC CODE + test G0 `lib/screenshot-folder-parsers.baseline.test.ts`):**
  - `lib/parseCppFolderStructure.ts` (nhiều CPP, `<root>/<CPP>/<locale>/…`) và `lib/parseFolderStructure.ts` (một CPP, `<root>/<locale>/…`) chép cùng luật `screenshots/<iphone|ipad>/<file>`, `previews/…`, `promo.txt`, sắp xếp theo tên.
  - Test G0 ghim cả hai trên cùng 8 đường dẫn.
- **Đường đúng:** khi có dịp đụng luật thư mục (vd `[CPP-bulk-folder-silent-skip]`), gộp về một hàm đọc phần `<locale>/…` dùng chung, mỗi dialog chỉ khác tiền tố.

## `[CPP-editor-add-second-set]` — editor không thêm được set loại thứ hai

Manager 2026-11-06 (Q7): ngoài phạm vi arc iPad.

- **Hiện trạng (ĐỌC CODE):** `LocalizationManager.tsx:856-930`:
  - locale chưa có set nào của thiết bị ⇒ chỉ có dropzone fallback (`APP_IPAD_PRO_3GEN_129` / `APP_IPHONE_67`);
  - đã có set ⇒ chỉ render dropzone của các set đã có.
  - ⇒ không thêm được set 11" khi đã có set 13".
- **Đường đúng:** editor cho chọn display type từ bảng spec khi thêm set. Kiểm theo set đích (arc iPad đã làm phần kiểm).
