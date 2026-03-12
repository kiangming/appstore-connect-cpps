# CPP Bulk Import — Design Document

**Date:** 2026-03-12
**Status:** ✅ Implemented — đang production
**Scope:** Tạo nhiều CPPs cùng lúc từ folder structure, kế thừa cơ chế từ `BulkImportDialog`

> ✅ **Nâng cấp đã implement:** Đọc deepLink + promoText từ `metadata.xlsx` (optional, đặt trong root folder).
> Excel thắng toàn bộ khi có file — bỏ qua `deeplink.txt` / `promo.txt`. Xem chi tiết tại [`docs/feature-cpp-bulk-import-xlsx.md`](feature-cpp-bulk-import-xlsx.md)

---

## Mục tiêu

Cho phép team tạo hàng loạt CPPs với đầy đủ locales + assets chỉ bằng một thao tác: chuẩn bị folder trên máy → chọn folder → review → upload. Giảm từ N × (tạo CPP + thêm locale + upload ảnh) thủ công xuống còn 1 click.

---

## Folder Structure Convention

```
<import-root>/
├── primary-locale.txt            ← BCP-47 code, dùng CHUNG cho tất cả CPPs mới (e.g. "en-US")
├── Summer Campaign/              ← tên CPP (tên folder = tên CPP)
│   ├── deeplink.txt              ← optional: deep link URL cho CPP này (e.g. "myapp://summer")
│   ├── English (U.S.)/           ← tên locale user-friendly (hoặc "en-US" — cả hai đều OK)
│   │   ├── promo.txt
│   │   ├── screenshots/
│   │   │   ├── iphone/           ← PNG, sorted lexicographically
│   │   │   └── ipad/
│   │   └── previews/
│   │       ├── iphone/           ← MP4
│   │       └── ipad/
│   └── Vietnamese/               ← tên user-friendly, được map → "vi"
│       ├── promo.txt
│       └── screenshots/iphone/
├── Holiday Sale/
│   ├── deeplink.txt              ← optional: deep link riêng cho CPP này
│   └── Japanese/
│       └── ...
└── _template/                    ← bắt đầu bằng _ hoặc . → bị bỏ qua (skip)
```

**Quy tắc parsing:**
- `primary-locale.txt` đặt ở **root folder** (cùng cấp các CPP folders), dùng chung cho toàn bộ batch
- Folder con trực tiếp của `import-root` = CPP folder (tên folder = tên CPP)
- Folder bắt đầu bằng `_` hoặc `.` bị skip
- Tên locale folder chấp nhận **cả hai dạng**:
  - User-friendly Apple name: `"Vietnamese"`, `"English (U.S.)"`, `"Chinese (Simplified)"`
  - BCP-47 short-code: `"vi"`, `"en-US"`, `"zh-Hans"` (backward compatible)
  - Mapping qua `lib/locale-map.json` (39 locales)
- Nếu `primary-locale.txt` thiếu/invalid → fallback: ưu tiên locale đã có trong app → locale đầu alphabet → `"en-US"`
- **Bug fix:** Trước khi tạo CPP mới, nếu primaryLocale chưa có trong app → tự động thêm vào app trước (`POST app-info-localizations`)

---

## CPP Status — 3 trạng thái

| Status | Label | Màu | Ý nghĩa |
|---|---|---|---|
| `new` | New CPP | Blue | Tên chưa tồn tại trong app → sẽ tạo mới |
| `existing` | Existing | Green | Tên khớp (case-insensitive) với CPP đang có → merge (thêm locale/assets) |
| `skip` | Skip | Gray | Folder rỗng, tên không hợp lệ, hoặc bắt đầu bằng `_`/`.` |

**Locale Status** (kế thừa nguyên từ `BulkImportDialog`):
`ready` | `new-locale` | `not-in-app` | `skip`

---

## TypeScript Types

```typescript
// ── CPP level ──────────────────────────────────────────────────
type CppImportStatus = "new" | "existing" | "skip";

interface CppImportPlan {
  name: string;                          // tên folder = tên CPP
  status: CppImportStatus;
  primaryLocale: string;                 // từ primary-locale.txt hoặc fallback
  primaryLocaleSource: "file" | "fallback";
  deepLink: string | null;               // từ deeplink.txt trong CPP folder (optional)
  existingCppId: string | null;          // null nếu status === "new"
  locales: LocaleCppImportPlan[];
  excluded: boolean;
}

// ── Locale level (gần giống ImportPlan trong BulkImportDialog) ──
interface LocaleCppImportPlan {
  locale: string;
  status: LocaleStatus;                  // "ready"|"new-locale"|"not-in-app"|"skip"
  promoText: string | null;
  screenshotFiles: { iphone: File[]; ipad: File[] };
  previewFiles: { iphone: File[]; ipad: File[] };
  localizationId: string | null;
  excluded: boolean;
}

// ── Progress tracking ───────────────────────────────────────────
type CppUploadStatus = "pending" | "running" | "done" | "error";

interface CppProgress {
  name: string;
  status: CppUploadStatus;
  error: string | null;
  locales: LocaleProgress[];             // kế thừa từ BulkImportDialog
}

interface LocaleProgress {
  locale: string;
  status: "pending" | "running" | "done" | "error";
  currentFile: string | null;
  error: string | null;
}
```

---

## Architecture — Component Tree

```
CppsPage  (app/(dashboard)/apps/[appId]/cpps/page.tsx)
└── CppList (components/cpp/CppList.tsx)
    └── [header] "Bulk Import CPPs" button  ← TRIGGER
        └── CppBulkImportDialog  (components/cpp/CppBulkImportDialog.tsx)  ← NEW
            ├── Step "drop"       — FolderDropZone (webkitdirectory)
            ├── Step "validating" — spinner
            ├── Step "preview"    — CppImportTree (3-level collapsible)
            ├── Step "uploading"  — CppProgressList (2 running in parallel)
            └── Step "done"       — summary + Done button
```

**Lib mới:**
```
lib/parseCppFolderStructure.ts   ← NEW: parse root → CppImportPlan[] (gọi parseFolderStructure per CPP)
```

**Props của `CppBulkImportDialog`:**
```typescript
interface Props {
  appId: string;
  existingCpps: AppCustomProductPage[];   // để detect "existing" vs "new"
  onClose: () => void;
  onComplete: () => void;
}
```

---

## Data Flow chi tiết

### Phase 1 — Parse & Validate

```
User drops / browses folder (webkitdirectory)
  → FileList → parseCppFolderStructure(files, existingCpps)
      1. Nhóm files theo cấp 1 (CPP folder)
      2. Bỏ qua folder bắt đầu bằng _ hoặc .
      3. Đọc primary-locale.txt trong mỗi CPP folder
      4. Gọi parseFolderStructure(cppFiles) cho từng CPP
            → LocaleCppImportPlan[] per CPP
      5. Match tên CPP với existingCpps (case-insensitive)
            → status: "new" | "existing" | "skip"
      6. Nếu "existing": lấy existingCppId, fetch localization IDs
  → fetch GET /api/asc/apps/${appId}/app-info-localizations
      → build appLocales set (detect "not-in-app" per locale)
  → setPlans(cppImportPlans) → setStep("preview")
```

### Phase 2 — Upload Orchestration (concurrency = 2)

```typescript
// Worker pool pattern:
const queue = activePlans.slice(); // CPPs chưa excluded + status !== "skip"

async function worker() {
  while (queue.length > 0) {
    const plan = queue.shift()!;
    await uploadCpp(plan);
  }
}

// Chạy 2 workers song song:
await Promise.all([worker(), worker()]);
```

### Phase 3 — Per-CPP Upload (`uploadCpp`)

```
Step 1 — Tạo hoặc lấy CPP:
  → Nếu status === "new":
      POST /api/asc/cpps  { appId, name: plan.name, locale: plan.primaryLocale }
      → lưu cppId mới
  → Nếu status === "existing":
      dùng plan.existingCppId trực tiếp

Step 2 — Lấy versionId:
  → GET /api/asc/cpps/${cppId}
      → versions[0].id = versionId (dùng cho tạo locale mới)
  → Nếu plan.deepLink có giá trị:
      PATCH /api/asc/versions/${versionId}  { deepLink }
      → updateCppVersion() → cập nhật deep link cho CPP version này

Step 3 — Detect CPP-wide device types (kế thừa từ BulkImportDialog):
  → Tìm locale "ready" đầu tiên có localizationId
  → fetch GET /api/asc/screenshot-sets?localizationId=...
  → fetch GET /api/asc/preview-sets?localizationId=...
  → extract cppIphoneSS, cppIpadSS, cppIphonePV, cppIpadPV
  → Fallback: APP_IPHONE_65 / APP_IPAD_PRO_3GEN_129

Step 4 — Upload từng locale (sequential trong CPP):
  → Gọi uploadLocale(locale, deviceDefaults, onFile)
      ← hàm này kế thừa NGUYÊN SI từ BulkImportDialog
         (không-in-app → thêm vào app → tạo localization → upload assets)
```

---

## Error Handling

| Tình huống | Hành vi |
|---|---|
| `primary-locale.txt` thiếu hoặc invalid | Fallback sang locale đầu tiên (alphabet); hiển thị warning "Using fallback locale: xx" |
| CPP name trùng với existing (case-insensitive) | Status `existing` — không tạo lại, chỉ merge |
| Tạo CPP thất bại (API error) | CPP báo `error`, bỏ qua tất cả locales của CPP đó, tiếp tục batch |
| Rate limit 429 | Exponential backoff: 2s → 4s → 8s (3 retries); nếu vẫn fail → CPP error |
| ASC API 5xx | Retry 1 lần sau 1s (kế thừa `fetchWithRetry` từ BulkImportDialog) |
| Locale upload fail | Locale error; CPP vẫn tiếp tục các locale còn lại |
| Tất cả locales của CPP fail | CPP báo `error` overall |
| Worker 1 fail ở CPP X | Worker 2 tiếp tục CPP khác trong queue; không ảnh hưởng |

**Exponential backoff (mới so với BulkImportDialog):**
```typescript
async function fetchWithBackoff(fn: () => Promise<Response>, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fn();
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
      continue;
    }
    if (!res.ok && res.status >= 500 && attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    return res;
  }
  return fn();
}
```

---

## API Routes cần thêm / đã có

| Route | Status | Dùng cho |
|---|---|---|
| `POST /api/asc/cpps` | ✅ Đã có | Tạo CPP mới |
| `GET /api/asc/cpps/[cppId]` | ✅ Đã có | Lấy versionId sau khi tạo |
| `POST /api/asc/cpps/[cppId]/localizations` | ✅ Đã có | Tạo locale mới trong CPP |
| `PATCH /api/asc/localizations/[id]` | ✅ Đã có | Update promo text |
| `PATCH /api/asc/versions/[versionId]` | ✅ Đã có | Update deep link sau khi lấy versionId |
| `GET /api/asc/apps/[appId]/app-info-localizations` | ✅ Đã có | Detect not-in-app |
| `POST /api/asc/apps/[appId]/app-info-localizations` | ✅ Đã có | Thêm locale vào app |
| `GET/POST /api/asc/screenshot-sets` | ✅ Đã có | Screenshot sets |
| `GET/POST /api/asc/preview-sets` | ✅ Đã có | Preview sets |
| `POST /api/asc/upload` | ✅ Đã có | Upload screenshot |
| `POST /api/asc/upload-preview` | ✅ Đã có | Upload preview |

---

## Files cần tạo / sửa

| File | Action | Ghi chú |
|---|---|---|
| `lib/parseCppFolderStructure.ts` | **Tạo mới** | Parse root → `CppImportPlan[]`, gọi `parseFolderStructure` per CPP |
| `components/cpp/CppBulkImportDialog.tsx` | **Tạo mới** | Component chính (~800-1000 lines) |
| `components/cpp/CppList.tsx` | **Sửa** | Thêm "Bulk Import CPPs" button + trigger dialog |
| `app/(dashboard)/apps/[appId]/cpps/page.tsx` | **Sửa** | Pass `cpps` xuống `CppList` để detect existing CPPs |

---

## UI Design — Mockups

### Step "drop" — Folder Drop Zone

```
┌─────────────────────────────────────────────────────┐
│  CPP Bulk Import                              [X]   │
│  Drop a folder containing CPP subfolders            │
├─────────────────────────────────────────────────────┤
│                                                     │
│         ┌──────────────────────────────┐            │
│         │                              │            │
│         │        📁  (icon)            │            │
│         │                              │            │
│         │  Drop your CPPs folder here  │            │
│         │  Each subfolder = one CPP    │            │
│         │                              │            │
│         │    [  Browse folder…  ]      │            │
│         └──────────────────────────────┘            │
│                                                     │
│  Expected structure:                                │
│  ┌────────────────────────────────────────────┐    │
│  │  my-cpps/                                  │    │
│  │  ├── Summer Campaign/                      │    │
│  │  │   ├── primary-locale.txt  ← "en-US"    │    │
│  │  │   ├── en-US/promo.txt                  │    │
│  │  │   └── en-US/screenshots/iphone/        │    │
│  │  └── Holiday Sale/                         │    │
│  │      ├── primary-locale.txt  ← "ja"       │    │
│  │      └── ja/screenshots/iphone/           │    │
│  └────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

---

### Step "preview" — Review Tree

```
┌─────────────────────────────────────────────────────┐
│  CPP Bulk Import                              [X]   │
│  3 CPPs found — review before importing             │
├─────────────────────────────────────────────────────┤
│                                                     │
│ ▶ Summer Campaign          [New CPP]    [Remove]   │
│   primary: en-US                                    │
│   └ en-US   [Ready]        5 shots · 1 preview     │
│   └ vi      [New locale]   3 shots                 │
│                                                     │
├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤
│                                                     │
│ ▼ Holiday Sale             [Existing]   [Remove]   │ ← expanded
│   primary: ja (fallback ⚠)                         │ ← warning nếu dùng fallback
│   ┌────────────────────────────────────────────┐   │
│   │ └ ja    [New locale]   4 shots · 2 previews│   │
│   │   └ promo: "Holiday special sale..."       │   │
│   │   └ iPhone: 01.png, 02.png, 03.png, 04.png │   │
│   │   └ Previews: iphone: video_01.mp4, ...   │   │
│   └────────────────────────────────────────────┘   │
│                                                     │
├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤
│                                                     │
│ ▶ _template                [Skip]                  │ ← dimmed
│                                                     │
├─────────────────────────────────────────────────────┤
│  [Cancel]     2 CPPs to import    [Import All →]   │
└─────────────────────────────────────────────────────┘
```

**Chi tiết preview tree:**
- **CPP row:** chevron expand/collapse | tên CPP | status badge | số locales | nút Remove
- **Expanded CPP:** primary locale (+ warning nếu fallback) + danh sách locale rows
- **Locale row:** indent 1 cấp | locale code | status badge | số assets (có thể expand thêm)
- **Expanded locale:** indent 2 cấp | promo text preview | danh sách file names
- **Skip CPPs:** dimmed 50%, không có Remove button

---

### Step "uploading" — Progress (2 concurrent)

```
┌─────────────────────────────────────────────────────┐
│  CPP Bulk Import                                    │
│  Uploading… 1 done · 1 running · 1 pending         │
├─────────────────────────────────────────────────────┤
│                                                     │
│ ✓  Summer Campaign                    [done]       │
│    ✓ en-US     ✓ vi                               │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│ ⟳  Holiday Sale                      [running]    │
│    ✓ en-US     ⟳ ja                               │
│                 └ Uploading 03.png…               │
│                                                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│ ○  Winter Promo                      [pending]     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Icon legend:**
- `✓` (green CheckCircle2) — done
- `⟳` (blue Loader2 spinning) — running
- `○` (gray circle) — pending
- `✕` (red XCircle) — error

---

### Step "done" — Summary

```
┌─────────────────────────────────────────────────────┐
│  CPP Bulk Import                              [X]   │
│  Done — 2 imported · 1 failed                      │
├─────────────────────────────────────────────────────┤
│                                                     │
│ ✓  Summer Campaign                                 │
│ ✓  Holiday Sale                                    │
│ ✕  Winter Promo                                    │
│    └ Error: Failed to create localization for vi   │
│                                                     │
├─────────────────────────────────────────────────────┤
│  2 CPPs imported        1 failed     [ Done ]      │
└─────────────────────────────────────────────────────┘
```

---

## Trigger UI trên CPP List

```
CPP List page header:
┌──────────────────────────────────────────────────────────┐
│ Custom Product Pages                                     │
│ Manage CPPs for app com.example.app              [appId] │
│                                          ┌─────────────┐ │
│                           [Bulk Import CPPs] [+ New CPP]│ │
│                                          └─────────────┘ │
└──────────────────────────────────────────────────────────┘
```

"Bulk Import CPPs" button: outline style (border, white bg) — phân biệt với "+ New CPP" (solid blue).

---

## Parsed từ lib/parseCppFolderStructure.ts

```typescript
// Input: FileList từ webkitdirectory
// Output: CppImportPlan[]

export function parseCppFolderStructure(
  files: File[],
  existingCpps: AppCustomProductPage[]
): CppImportPlan[] {
  // 1. Nhóm files theo segment[0] (CPP folder name)
  // 2. Bỏ qua folder bắt đầu bằng _ hoặc .
  // 3. Đọc primary-locale.txt → validate BCP-47
  //    → fallback sang locale đầu tiên nếu thiếu/invalid
  // 4. Gọi parseFolderStructure(cppFiles) cho phần còn lại
  //    (dùng segments[1..] thay vì segments[0..])
  // 5. Match tên vs existingCpps (case-insensitive trim)
  //    → status: "new" | "existing" | "skip"
  // 6. existingCppId từ matched CPP nếu "existing"
}
```

---

## Luồng tổng quát (sequence diagram text)

```
User                  CppBulkImportDialog      API Routes         ASC API
 │                           │                     │                 │
 │── drop folder ──────────▶ │                     │                 │
 │                           │── parseCppFolder ──▶│                 │
 │                           │── GET app-info-locs ▶── GET /appInfos ▶│
 │                           │◀── locales[] ────── │◀──────────────── │
 │                           │── setStep(preview) ─│                 │
 │                           │                     │                 │
 │── click Import All ──────▶│                     │                 │
 │                           │── worker 1: CPP-A ──│                 │
 │                           │── worker 2: CPP-B ──│                 │
 │                           │                     │                 │
 │                           │   [CPP-A] POST cpps ▶── POST /appCPPs ▶│
 │                           │   [CPP-A] GET cppId ▶── GET /appCPPs  ▶│
 │                           │   [CPP-A] uploadLocale (per locale)    │
 │                           │   [CPP-B] POST cpps ▶── (parallel) ───▶│
 │                           │       ...           │                 │
 │                           │── setStep(done) ────│                 │
 │◀── onComplete() ──────────│                     │                 │
```

---

## Assumptions đã confirmed (và thay đổi so với design ban đầu)

| # | Assumption | Ghi chú |
|---|---|---|
| A1 | Trigger nằm trên CPP List page (cạnh "+ New CPP") | ✅ |
| A2 | CPP "existing" = tên khớp case-insensitive với CPP trong app | ✅ |
| A3 | `primary-locale.txt` thiếu/invalid → fallback có thứ tự ưu tiên: in-app locale → đầu alphabet → "en-US" | ✅ Cải thiện so với design ban đầu |
| A4 | CPP existing → không tạo lại, chỉ merge locale + assets | ✅ |
| A5 | **Concurrency = 2** CPPs song song; từng CPP xử lý locale tuần tự bên trong | ✅ |
| A6 | Modal dialog, không navigate away | ✅ |
| A7 | Device type defaults: `APP_IPHONE_65` / `APP_IPAD_PRO_3GEN_129` | ✅ |
| A8 | Không submit CPP for review — chỉ tạo ở trạng thái `PREPARE_FOR_SUBMISSION` | ✅ |
| A9 | Folder bắt đầu bằng `_` hoặc `.` bị skip tự động | ✅ |
| A10 | **[MỚI]** `primary-locale.txt` đặt ở root folder, không phải trong từng CPP folder | ✅ Thay đổi so với design v1 |
| A11 | **[MỚI]** Tên locale folder dùng Apple user-friendly name ("Vietnamese") hoặc short-code ("vi") | ✅ Thay đổi so với design v1 |
| A12 | **[MỚI]** Nếu primaryLocale chưa có trong app → thêm vào app trước khi tạo CPP (fix 409 error) | ✅ Bug fix |
| A13 | **[MỚI]** `deeplink.txt` optional trong mỗi CPP folder root → đọc content → PATCH version sau khi tạo | ✅ Implemented |

---

## Decision Log

| Quyết định | Alternatives | Lý do |
|---|---|---|
| `primary-locale.txt` để chỉ định primary locale | Fallback-only, user chọn trong UI | File rõ ràng, reproducible; dễ kiểm tra lại |
| Concurrency = 2 | Sequential (1), 3-4 parallel | Doubles throughput; rate limit risk thấp; progress UI còn rõ ràng |
| Worker pool pattern (shift từ queue) | Promise.all cố định | Dynamic — nếu một CPP nhanh sẽ lấy CPP tiếp theo ngay |
| Exponential backoff cho 429 (2s/4s/8s) | Fixed delay, abort | Safe hơn với rate limit không xác định của Apple |
| Kế thừa `uploadLocale()` nguyên si | Copy + paste | DRY; bug fix ở một chỗ lan sang cả hai |
| Không cần API route mới | Thêm batch endpoint | Tất cả operations đã có; đơn giản hơn |
| Trigger ở CPP List header | CPP Editor, Settings page | Đây là nơi user tư duy "tôi muốn tạo nhiều CPP" |
| Skip folder `_` / `.` tự động | Require explicit opt-in | Convention phổ biến (.gitignore, node_modules); không phải hỏi |

---

## Implementation Plan (thứ tự)

1. **`lib/parseCppFolderStructure.ts`** — pure function, testable độc lập
2. **`components/cpp/CppBulkImportDialog.tsx`** — component chính
   - Steps: drop → validating → preview → uploading → done
   - Reuse: `uploadLocale()` extract ra shared util hoặc duplicate có chú thích rõ
   - Exponential backoff thay thế `fetchWithRetry` hiện tại
3. **`components/cpp/CppList.tsx`** — thêm "Bulk Import CPPs" button + state dialog
4. **`app/(dashboard)/apps/[appId]/cpps/page.tsx`** — pass `cpps` data xuống `CppList`
5. **Test thủ công** với folder có: 1 CPP mới + 1 CPP existing + 1 folder skip
