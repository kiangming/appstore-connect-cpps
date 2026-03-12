# Bulk Import CPP Assets — Design Document

**Date:** 2026-03-12
**Status:** Implemented

---

## Mục tiêu

Cho phép team upload toàn bộ assets (promo text + screenshots + app previews) của nhiều locale cho một CPP chỉ bằng một thao tác: chọn folder → xem preview → xác nhận → upload.

---

## Cấu trúc folder quy ước

```
<import-root>/
├── en-US/
│   ├── promo.txt               ← optional, plain text
│   ├── screenshots/
│   │   ├── iphone/             ← PNG files, sorted lexicographically
│   │   └── ipad/               ← PNG files, sorted lexicographically
│   └── previews/
│       ├── iphone/             ← MP4 files
│       └── ipad/               ← MP4 files
├── vi/
│   ├── promo.txt
│   └── screenshots/
│       └── iphone/
└── ja/
    └── ...
```

**Quy tắc:**
- Tên folder = BCP-47 locale code (case-insensitive so sánh với data ASC)
- `promo.txt` optional — nếu thiếu, không cập nhật promo text
- `screenshots/` và `previews/` optional — nếu thiếu, bỏ qua media type đó
- `iphone/` → map tới iPhone device type của CPP
- `ipad/` → map tới iPad device type của CPP
- File trong `iphone/` và `ipad/` xử lý theo thứ tự lexicographic
- Subfolder không nhận dạng được bên trong `screenshots/` hoặc `previews/` bị bỏ qua

---

## Locale Status — 4 trạng thái

| Status | Label hiển thị | Màu | Ý nghĩa |
|---|---|---|---|
| `ready` | Ready | Xanh lá | Locale đã tồn tại trong CPP — sẵn sàng upload |
| `new-locale` | New locale | Xanh dương | Locale hợp lệ, có trong app nhưng chưa có trong CPP — sẽ được tạo tự động |
| `not-in-app` | Not supported by app | Cam | Locale hợp lệ nhưng chưa có trong app's store page localizations — sẽ được thêm vào app trước, sau đó thêm vào CPP |
| `skip` | Skip | Xám | Tên folder không phải BCP-47 hợp lệ, hoặc folder rỗng (không có content nào) |

### Logic phân loại locale

```typescript
// 1. Kiểm tra regex BCP-47 và có content không
if (!LOCALE_REGEX.test(data.locale) || !hasContent) {
  status = "skip";
}
// 2. Locale đã tồn tại trong CPP
else if (existingCppLocalizations.has(localeKey)) {
  status = "ready";
}
// 3. Fetch thành công từ app-info-localizations nhưng locale không có trong app
else if (appLocalesFetched && !appLocales.has(localeKey)) {
  status = "not-in-app";
}
// 4. Locale có trong app nhưng chưa có trong CPP
else {
  status = "new-locale";
}
```

**Lưu ý `appLocalesFetched` flag:** Phân biệt giữa 3 trường hợp:
- Fetch thành công, có dữ liệu → detect `not-in-app` bình thường
- Fetch thành công, app chưa có locale nào → tất cả locale đều `not-in-app` (đúng với app mới)
- Fetch thất bại → fallback sang `new-locale` (không block import)

---

## Kiến trúc — Component tree

```
CppEditor (props: appId, cppId, ...)
└── LocalizationManager (props: appId, cppId, versionId, initialLocalizations)
    └── BulkImportDialog (props: appId, cppId, versionId, existingLocalizations, onClose, onComplete)
        ├── Step "drop"       — FolderDropZone
        ├── Step "validating" — spinner
        ├── Step "preview"    — ImportPreviewList
        ├── Step "uploading"  — LocaleProgressList
        └── Step "done"       — summary + Done button
```

**`appId` threading:** `appId` được truyền từ `CppEditor` → `LocalizationManager` → `BulkImportDialog` để:
1. Fetch danh sách locale của app (phát hiện `not-in-app`)
2. Thêm locale mới vào app store page trước khi upload CPP

---

## Data Flow chi tiết

### Phase 1 — Parse & Validate (client-side)

```
User drops / browses folder
  → FileList (webkitdirectory — mỗi File có webkitRelativePath)
  → parseFolderStructure(files)        [lib/parseFolderStructure.ts]
      → nhóm files theo locale folder đầu tiên
      → tách promo.txt, screenshots/iphone, screenshots/ipad, previews/iphone, previews/ipad
  → fetch GET /api/asc/apps/${appId}/app-info-localizations
      → trả về { locales: string[], appInfoId: string }
      → set appLocales + appLocalesFetched = true
  → với mỗi locale: phân loại status theo 4 trạng thái trên
  → setPlans(importPlans) → setStep("preview")
```

### Phase 2 — Upload Orchestration

```
User clicks "Import All"
  → lọc active = plans không bị excluded và status !== "skip"
  → Detect CPP-wide device types:
      → tìm readyPlan đầu tiên có localizationId
      → fetch GET /api/asc/screenshot-sets?localizationId=...
      → fetch GET /api/asc/preview-sets?localizationId=...
      → extract iPhone/iPad device types từ existing sets
      → lưu vào deviceDefaults (fallback nếu fetch thất bại: APP_IPHONE_65 / APP_IPAD_PRO_3GEN_129)
  → for each locale (sequential):
      → uploadLocale(plan, deviceDefaults, onFile)
```

### Phase 3 — Per-locale Upload (`uploadLocale`)

```
Step 0 (chỉ khi status === "not-in-app"):
  → POST /api/asc/apps/${appId}/app-info-localizations { locale }
  → Thêm locale vào app store page trước

Step 1 — Create / Update CPP localization:
  → Nếu chưa có localizationId:
      POST /api/asc/cpps/${cppId}/localizations { versionId, locale, promotionalText }
      → lưu localizationId mới
  → Nếu đã có localizationId và promoText != null:
      PATCH /api/asc/localizations/${localizationId} { promotionalText }

Step 2 — Fetch existing sets (để resolve device types cụ thể của locale này):
  → GET /api/asc/screenshot-sets?localizationId=...  → điền ssCache + override iphoneSS/ipadSS
  → GET /api/asc/preview-sets?localizationId=...    → điền pvCache + override iphonePV/ipadPV
  → Nếu locale mới tạo (không có existing sets): dùng deviceDefaults từ CPP-wide detection

Step 3 — Upload screenshots:
  → for [iphone files, iphoneSS], [ipad files, ipadSS]:
      → getOrCreateSS(type) → screenshotSetId
          (POST /api/asc/screenshot-sets nếu chưa có; xử lý 409 conflict)
      → for each file:
          FormData { screenshotSetId, file }
          POST /api/asc/upload

Step 4 — Upload previews:
  → for [iphone files, iphonePV], [ipad files, ipadPV]:
      → getOrCreatePV(type) → previewSetId
          (POST /api/asc/preview-sets nếu chưa có; xử lý 409 conflict)
      → for each file:
          FormData { previewSetId, file }
          POST /api/asc/upload-preview
```

---

## Device Type Detection — Cơ chế

**Vấn đề:** Screenshot set của CPP có thể là `APP_IPHONE_65` (6.5") hoặc `APP_IPHONE_67` (6.7") — không thể hardcode.

**Giải pháp 2-tầng:**

1. **CPP-wide defaults** — trước vòng upload, fetch existing sets của một "ready" locale:
   ```typescript
   const readyPlan = active.find(p => p.status === "ready" && p.localizationId);
   // fetch screenshot-sets + preview-sets của readyPlan
   // extract cppIphoneSS, cppIpadSS, cppIphonePV, cppIpadPV
   const deviceDefaults = { cppIphoneSS, cppIpadSS, cppIphonePV, cppIpadPV };
   ```

2. **Per-locale override** — bên trong `uploadLocale`, fetch sets của locale đó (nếu đã tồn tại):
   ```typescript
   let iphoneSS = deviceDefaults.cppIphoneSS; // bắt đầu từ CPP defaults
   // fetch existing sets của localizationId này
   // nếu thấy set iPhone/iPad → override iphoneSS / ipadSS
   ```

**Fallback defaults** (khi không detect được):
```typescript
const DEFAULT_IPHONE_SCREENSHOT = "APP_IPHONE_65";   // iPhone 6.5"
const DEFAULT_IPAD_SCREENSHOT   = "APP_IPAD_PRO_3GEN_129";
const DEFAULT_IPHONE_PREVIEW    = "IPHONE_65";
const DEFAULT_IPAD_PREVIEW      = "IPAD_PRO_3GEN_129";
```

---

## API Routes được sử dụng

| Method | Endpoint | Mục đích |
|---|---|---|
| GET | `/api/asc/apps/${appId}/app-info-localizations` | Lấy danh sách locale của app (detect not-in-app) |
| POST | `/api/asc/apps/${appId}/app-info-localizations` | Thêm locale mới vào app store page |
| POST | `/api/asc/cpps/${cppId}/localizations` | Tạo CPP localization mới |
| PATCH | `/api/asc/localizations/${localizationId}` | Cập nhật promotional text |
| GET | `/api/asc/screenshot-sets?localizationId=...` | Lấy existing screenshot sets |
| POST | `/api/asc/screenshot-sets` | Tạo screenshot set mới |
| GET | `/api/asc/preview-sets?localizationId=...` | Lấy existing preview sets |
| POST | `/api/asc/preview-sets` | Tạo preview set mới |
| POST | `/api/asc/upload` | Upload file screenshot |
| POST | `/api/asc/upload-preview` | Upload file app preview (video) |

---

## TypeScript Types (thực tế)

```typescript
type LocaleStatus = "ready" | "new-locale" | "not-in-app" | "skip";
type Step = "drop" | "validating" | "preview" | "uploading" | "done";

interface ImportPlan {
  locale: string;
  status: LocaleStatus;
  promoText: string | null;           // null = không có promo.txt hoặc file rỗng
  screenshotFiles: { iphone: File[]; ipad: File[] };
  previewFiles: { iphone: File[]; ipad: File[] };
  localizationId: string | null;      // null nếu locale chưa tồn tại trong CPP
  excluded: boolean;                  // user có thể bỏ qua locale cụ thể
}

interface LocaleProgress {
  locale: string;
  status: "pending" | "running" | "done" | "error";
  currentFile: string | null;
  error: string | null;
}

interface Props {                     // BulkImportDialog props
  appId: string;
  cppId: string;
  versionId: string;
  existingLocalizations: AppCustomProductPageLocalization[];
  onClose: () => void;
  onComplete: () => void;
}
```

---

## Error Handling

| Tình huống | Hành vi |
|---|---|
| Tên folder không phải BCP-47 hợp lệ | Status `skip` — bỏ qua |
| Folder rỗng (không có content) | Status `skip` — bỏ qua |
| Fetch app locales thất bại | `appLocalesFetched = false` → fallback sang `new-locale` thay vì block |
| `promo.txt` thiếu | Bỏ qua update promo text, tiếp tục upload assets |
| Không có `screenshots/` hay `previews/` | Bỏ qua media type đó cho locale |
| Thêm locale vào app thất bại (not-in-app step) | Throw error, locale báo failed trong progress |
| Tạo CPP localization thất bại | Throw error, locale báo failed |
| Screenshot set đã tồn tại (409 conflict) | Re-fetch để lấy ID hiện tại, tiếp tục |
| Upload file thất bại | Retry 1 lần sau 1s; nếu vẫn lỗi → locale báo failed, tiếp tục batch |
| ASC API 5xx | Retry 1 lần sau 1s (`fetchWithRetry`) |
| Detect device type thất bại | Dùng defaults (`APP_IPHONE_65` / `APP_IPAD_PRO_3GEN_129`) |

---

## UI — Các bước

### Step "drop" — Folder Drop Zone
- Drop zone dashed border, hover highlight
- Label + hướng dẫn cấu trúc folder
- Nút "Browse folder…" (trigger `<input webkitdirectory>`)
- Code minh hoạ cấu trúc folder ngay bên dưới

### Step "validating"
- Spinner toàn màn hình trong modal
- Text: "Parsing folder structure…"

### Step "preview" — Review trước khi upload
- Banner amber nếu có locale `not-in-app`: "N locales have locale codes not supported by this app yet. They will be added to the app's store page localizations first, then imported into this CPP."
- Danh sách locale rows (collapsible):
  - Locale code | Status badge | promo text preview | số screenshots | số previews | nút Remove
  - Expand → xem chi tiết file names + note cảnh báo theo status
- Footer: "X locales to import (Y will be added to app first)" + nút Cancel + nút **Import All**

### Step "uploading"
- Mỗi locale một row: icon trạng thái (spinner / checkmark / x) + tên locale + tên file đang upload
- Không thể đóng modal trong lúc upload

### Step "done"
- Summary: "X locales imported · Y failed"
- Nút **Done** → `onComplete()` + `onClose()`

---

## Files liên quan

| File | Vai trò |
|---|---|
| `components/cpp/BulkImportDialog.tsx` | Component chính — toàn bộ logic UI + upload |
| `lib/parseFolderStructure.ts` | Parse `FileList` thành `ImportPlan[]` |
| `components/cpp/LocalizationManager.tsx` | Host BulkImportDialog, truyền `appId` |
| `app/(dashboard)/apps/[appId]/cpps/[cppId]/page.tsx` | Truyền `appId` vào `CppEditor` |
| `components/cpp/CppEditor.tsx` | Truyền `appId` vào `LocalizationManager` |
| `app/api/asc/apps/[appId]/app-info-localizations/route.ts` | GET + POST app-level localizations |
| `app/api/asc/screenshot-sets/route.ts` | GET + POST screenshot sets |
| `app/api/asc/preview-sets/route.ts` | GET + POST preview sets |
| `app/api/asc/upload/route.ts` | Upload screenshot file |
| `app/api/asc/upload-preview/route.ts` | Upload preview (video) file |

---

## Decision Log

| Quyết định | Alternatives | Lý do |
|---|---|---|
| Locale-first folder structure | Device-first (`iphone/en-US/`) | Trực quan hơn cho team nội dung; khớp với model ASC |
| `webkitdirectory` input | zip upload, server-side sync | Không cần infra mới; files ở lại client-side |
| Plain `.txt` cho promo text | JSON manifest, YAML | Đơn giản nhất cho người không technical |
| Status `not-in-app` riêng biệt | Gộp vào `new-locale` | Cần xử lý thêm bước POST vào app trước; cần UI rõ ràng để user hiểu |
| `appLocalesFetched` flag | Chỉ check `appLocales.size > 0` | Phân biệt đúng "fetch thất bại" vs "app chưa có locale nào" |
| CPP-wide device detect trước upload | Detect inline mỗi locale | Một lần fetch cho cả batch; new locales dùng đúng device type của CPP |
| Default `APP_IPHONE_65` (6.5") | `APP_IPHONE_67` (6.7") | Khớp với device type thực tế trong data từ ASC |
| Retry 1 lần, tiếp tục batch | Abort on first error | Partial success tốt hơn all-or-nothing với batch lớn |
| Sequential locale processing | Full parallel | Tránh ASC API rate limit; progress tracking đơn giản hơn |
| Append screenshots (không xoá cũ) | Replace / delete-then-upload | Safe hơn cho MVP; tránh mất data ngoài ý muốn |
