# Feature: CPP Editor, Localization Manager & Asset Upload

> Đọc file này khi làm việc với CppEditor, LocalizationManager, asset upload (manual).
> Bulk import → xem `docs/bulk-import-design.md`

---

## 1. CPP Editor

**File:** `components/cpp/CppEditor.tsx` (Client)
**Page:** `app/(dashboard)/apps/[appId]/cpps/[cppId]/page.tsx` (Server)

### Server fetch
```typescript
// page.tsx:
GET /api/asc/cpps/${cppId}
→ { cpp, versions: VersionWithLocalizations[] }
// Extract: versions[0], localizations từ versions[0].localizations
→ <CppEditor cpp={cpp} versions={versions} localizations={localizations} appId={appId} />
```

### Props
```typescript
interface Props {
  cpp: AppCustomProductPage;
  versions: VersionWithLocalizations[];
  appId: string;
}
```

### Tabs

**Overview tab:**
- CPP name, ID, deep link (từ version attributes)
- Version state badge
- Danh sách localizations với promo text preview

**Details tab:**
- Input: Name (`PATCH /api/asc/cpps/[cppId]` với `{ name }`)
- Checkbox: Visible (`PATCH /api/asc/cpps/[cppId]` với `{ visible: "VISIBLE"|"HIDDEN" }`)
- Save button + success/error message

**Assets tab:**
- `<LocalizationManager cppId appId versionId initialLocalizations />`

**Preview tab:**
- `<AppStorePreview />` — STUB, chưa implement

---

## 2. Localization Manager

**File:** `components/cpp/LocalizationManager.tsx` (Client, ~900 lines)

### Props
```typescript
interface Props {
  cppId: string;
  versionId: string;
  initialLocalizations: AppCustomProductPageLocalization[];
  appId: string;  // ← cần để pass vào BulkImportDialog
}
```

### State chính
```typescript
const [localizations, setLocalizations] = useState(initialLocalizations);
const [showBulkImport, setShowBulkImport] = useState(false);
const [addingLocale, setAddingLocale] = useState(false);
const [newLocale, setNewLocale] = useState("en-US");
```

### Header actions
- **"Bulk Import"** button (FolderInput icon) → `setShowBulkImport(true)` → `<BulkImportDialog>`
- **"Add Locale"** button → expand dropdown chọn locale

### Add Locale flow
```typescript
POST /api/asc/cpps/${cppId}/localizations  { versionId, locale }
→ refresh: GET /api/asc/screenshot-sets?localizationId=... (lazy load)
→ append vào localizations state
```

### LocalizationRow component (bên trong file)
Mỗi locale có một `LocalizationRow`:

```
[locale code] ▶ [collapse/expand]
  ─────────────────────────────
  Promotional Text
    [textarea / edit mode]  [Save button]

  Device Tabs: [iPhone] [iPad]

  Screenshots section:
    [Device type dropdown]  ← chọn APP_IPHONE_65, APP_IPHONE_67, etc.
                            (sketch cũ — hiện tại: không có dropdown; mỗi set ĐÃ CÓ của locale một khối,
                             label từ lib/cpp/screenshot-specs.ts; chưa có set ⇒ một ô thả vào set mặc định)
    [Existing screenshots grid] (thumbnails 80×160)
    [Dropzone] "Drop PNG files here"
    [Staged files list] + [Upload N screenshots] button

  App Previews section:
    [Device type dropdown]  ← chọn IPHONE_65, IPAD_PRO_3GEN_129, etc.
    [Existing previews grid] (thumbnails + play icon)
    [Dropzone] "Drop MP4 files here"
    [Staged files list] + [Upload N previews] button
```

### Lazy loading sets
```typescript
// Fetch chỉ khi user expand row (open = true):
const [setsLoaded, setSetsLoaded] = useState(false);

useEffect(() => {
  if (open && !setsLoaded) {
    // fetch screenshot-sets + preview-sets
    setLoadingSets(true);
    // GET /api/asc/screenshot-sets?localizationId=...
    // GET /api/asc/preview-sets?localizationId=...
    // → cập nhật screenshotsByType, previewsByType, screenshotSetCache, previewSetCache
    setSetsLoaded(true);
  }
}, [open]);
```

### Screenshot set cache
```typescript
// screenshotSetCache: Map<ScreenshotDisplayType, setId>
// previewSetCache: Map<PreviewType, setId>
// Dùng để không phải tạo lại set mỗi khi upload
```

### Promo text
- View mode: hiển thị text hoặc placeholder "—"
- Edit mode: `<textarea>` + Save/Cancel buttons
- `PATCH /api/asc/localizations/${localizationId}` với `{ promotionalText }`

### Upload trong LocalizationRow
```typescript
// User chọn device tab (iphone/ipad)
// Chọn device type từ dropdown  (cũ — editor không có dropdown: thả ảnh vào khối của set đích,
//   hoặc vào ô fallback khi locale chưa có set: APP_IPHONE_67 / iPad 13")
// Stage files qua Dropzone
// Click "Upload N screenshots":
//   → getOrCreateScreenshotSet(type) → setId
//   → for each file: POST /api/asc/upload (FormData: { screenshotSetId, file })
//   → reload sets sau khi xong
```

### Screenshot/Preview type constants
```typescript
// Screenshots (ScreenshotDisplayType):
APP_IPHONE_67  APP_IPHONE_65  APP_IPHONE_61  APP_IPHONE_58  APP_IPHONE_55  APP_IPHONE_47  APP_IPHONE_40  APP_IPHONE_35
APP_IPAD_PRO_3GEN_129  APP_IPAD_PRO_3GEN_11  APP_IPAD_PRO_129  APP_IPAD_105  APP_IPAD_97
// APP_IPHONE_58 thêm vào union types/asc.ts ở arc `[CPP-bulkimport-iphone-screenshot-sizes]` (2026-11-13).
// ⚠ Map iPhone → display type là SUY LUẬN, chờ UAT iPhone; Face ID (medium) → APP_IPHONE_58 là SUY LUẬN THEO LOẠI TRỪ
//   (ứng viên thay thế APP_IPHONE_61). Xem docs/cpp-management/uat-iphone-screenshot-sizes.md.
// Label + kích thước hợp lệ của từng type: lib/cpp/screenshot-specs.ts (arc `[CPP-bulkimport-ipad-screenshot-sizes]`, 2026-11-06;
// iPhone thêm ở arc `[CPP-bulkimport-iphone-screenshot-sizes]`, 2026-11-13 — label iPhone = tên nhóm Apple, ví dụ
// APP_IPHONE_67 → "iPhone Dynamic Island (large)", APP_IPHONE_65 → "iPhone Face ID (large)").
// Editor kiểm ảnh theo SET ĐÍCH (validateScreenshotForDisplayType), không theo thiết bị — cho cả iPad và iPhone
// (iPhone từ 2026-11-13; trước đó mọi set iPhone nhận cùng 4 cỡ 6.5").
// Locale chưa có set của thiết bị đang chọn ⇒ ô thả ảnh dùng set mặc định từ bảng:
//   iPhone: IPHONE_DEFAULT_DISPLAY_TYPE = APP_IPHONE_67 (Dynamic Island (large)) — chỉ nhận cỡ của nhóm này;
//           ảnh iPhone cỡ khác cho locale đó ⇒ Bulk Import (Manager Q-B)
//   iPad:   IPAD_REQUIRED_DISPLAY_TYPE  = APP_IPAD_PRO_3GEN_129 (iPad 13")

// Previews (PreviewType):
IPHONE_67  IPHONE_65  IPHONE_61  IPHONE_58  IPHONE_55  IPHONE_47  IPHONE_40
IPAD_PRO_3GEN_129  IPAD_PRO_3GEN_11  IPAD_PRO_129  IPAD_105  IPAD_97
```

---

## 3. Manual Asset Upload Flow

### Screenshots
```
User stages files → clicks "Upload N screenshots"
  → POST /api/asc/screenshot-sets  { localizationId, screenshotDisplayType }
     (hoặc dùng cache nếu set đã tồn tại)
  → for each file:
      POST /api/asc/upload  FormData({ screenshotSetId, file })
      ← route server:
        1. reserveScreenshot(setId, fileName, fileSize)
           → ASC: POST /v1/appScreenshots → { id, uploadOperations }
        2. uploadAssetToOperations(uploadOperations, fileBuffer)
           → PUT chunks to presigned URLs
        3. Tính MD5 checksum
        4. confirmScreenshot(screenshotId, checksum)
           → ASC: PATCH /v1/appScreenshots/${id} { uploaded: true, sourceFileChecksum }
```

### App Previews (Video)
```
Tương tự screenshot nhưng:
  → POST /api/asc/preview-sets  { localizationId, previewType }
  → POST /api/asc/upload-preview  FormData({ previewSetId, file })
     route server:
       1. reservePreview(setId, fileName, fileSize, mimeType)
       2. uploadAssetToOperations(...)
       3. confirmPreview(previewId, checksum)
```

---

## 4. API Routes liên quan

| Route | Method | Input | Output |
|---|---|---|---|
| `/api/asc/cpps/[cppId]/localizations` | POST | `{ versionId, locale, promotionalText? }` | Created localization |
| `/api/asc/localizations/[id]` | PATCH | `{ promotionalText }` | Updated localization |
| `/api/asc/screenshot-sets` | GET | `?localizationId=...` | `{ data: AppScreenshotSet[] }` with included screenshots |
| `/api/asc/screenshot-sets` | POST | `{ localizationId, screenshotDisplayType }` | Created set |
| `/api/asc/preview-sets` | GET | `?localizationId=...` | `{ data: AppPreviewSet[] }` with included previews |
| `/api/asc/preview-sets` | POST | `{ localizationId, previewType }` | Created set |
| `/api/asc/upload` | POST | FormData `{ screenshotSetId, file }` | `{ success: true }` |
| `/api/asc/upload-preview` | POST | FormData `{ previewSetId, file }` | `{ success: true }` |

---

## 5. Lưu ý quan trọng

1. **`appId` threading** — `appId` phải được pass từ `CppEditor` → `LocalizationManager` → `BulkImportDialog`. Nếu thiếu, BulkImportDialog không detect được `not-in-app` locales.

2. **409 Conflict** khi tạo screenshot set — set đã tồn tại. Xử lý: re-fetch để lấy ID, không throw error.

3. **Thumbnail trong LocalizationManager** dùng size nhỏ hơn (80×160) so với CppDetailPanel (390×844).

4. **Lazy load** — screenshot/preview sets chỉ fetch khi user expand locale row (`open = true` lần đầu).

5. **BulkImportDialog** được trigger từ header của LocalizationManager (FolderInput icon), KHÔNG phải từ CppDetailPanel.
