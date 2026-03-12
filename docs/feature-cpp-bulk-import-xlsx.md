# Feature: CPP Bulk Import — Excel Metadata (metadata.xlsx)

**Date:** 2026-03-12
**Status:** ✅ Implemented
**Scope:** Nâng cấp CPP Bulk Import để đọc `deepLink` và `promoText` từ file `metadata.xlsx` thay vì `deeplink.txt` / `promo.txt`

---

## Mục tiêu

Cho phép team khai báo deeplink và promotional text cho nhiều CPP + nhiều locale trong **1 file Excel duy nhất**, thay vì phải tạo nhiều file `.txt` rải rác trong từng folder. Giúp dễ chỉnh sửa, review, và chia sẻ nội dung trước khi import.

---

## Understanding Lock (confirmed)

- **Cái gì:** `metadata.xlsx` tùy chọn đặt trong root folder, chứa CPP Name, Deep Link, và Promo Text theo locale
- **Tại sao:** Quản lý tập trung dễ hơn nhiều file text rải rác
- **Ai dùng:** Team nội bộ 2–5 người
- **Ràng buộc:** Parse client-side (SheetJS dynamic import), max 5MB, formula disabled, không API mới
- **Non-goals:** Không server-side parse, không validate nội dung text, không filter/sort

---

## Folder Structure (sau khi nâng cấp)

```
<import-root>/
├── primary-locale.txt            ← vẫn dùng như cũ (unchanged)
├── metadata.xlsx                 ← MỚI: optional, chứa deepLink + promoText
├── Summer Campaign/
│   ├── deeplink.txt              ← BỎ QUA nếu có metadata.xlsx
│   ├── English (U.S.)/
│   │   ├── promo.txt             ← BỎ QUA nếu có metadata.xlsx
│   │   ├── screenshots/iphone/
│   │   └── previews/iphone/
│   └── Vietnamese/
│       ├── promo.txt             ← BỎ QUA nếu có metadata.xlsx
│       └── screenshots/iphone/
├── Holiday Sale/
│   └── Japanese/
│       └── screenshots/iphone/
└── _template/                    ← skip như cũ
```

**Quy tắc ưu tiên:**
- Nếu `metadata.xlsx` **có mặt** → Excel thắng toàn bộ: bỏ qua `deeplink.txt` và `promo.txt` của tất cả CPPs
- Nếu `metadata.xlsx` **vắng mặt** → flow cũ hoạt động bình thường (backward compatible 100%)

---

## Template Excel (metadata.xlsx)

### Format

| CPP Name | Deep Link | English (U.S.) | Vietnamese | Japanese |
|---|---|---|---|---|
| Summer Campaign | myapp://campaign/summer | Summer deals await! | Ưu đãi mùa hè! | |
| Holiday Sale | | Holiday savings! | | ホリデーセール |
| Winter Promo | myapp://promo/winter | | | |

### Quy tắc columns

| Column | Bắt buộc | Mô tả |
|---|---|---|
| `CPP Name` | ✅ | Tên CPP, phải khớp **chính xác** (case sensitive) với tên folder |
| `Deep Link` | ✅ | Deep link URL cho CPP (ô trống = không có deeplink) |
| `<Locale Name>` | ❌ | Tên locale user-friendly Apple (vd: `English (U.S.)`, `Vietnamese`). Số lượng cột locale không giới hạn |

**Format validation:**
- Sheet đọc: sheet đầu tiên (index 0)
- Row đầu tiên = header row
- Column `CPP Name` và `Deep Link` phải tồn tại (exact match, case sensitive)
- Không có column locale nào = không cung cấp promoText, deepLink vẫn được đọc
- File không có 2 column bắt buộc → lỗi hard, dừng toàn bộ parse

---

## Assumptions

| # | Assumption |
|---|---|
| A1 | `metadata.xlsx` là **optional** — không có file → flow cũ (deeplink.txt / promo.txt) hoạt động bình thường |
| A2 | Nếu có `metadata.xlsx` → Excel thắng toàn bộ: bỏ qua `deeplink.txt` VÀ `promo.txt` của TẤT CẢ CPPs |
| A3 | Chỉ đọc **sheet đầu tiên** (index 0) |
| A4 | Columns bắt buộc: `CPP Name` và `Deep Link` (case sensitive exact match) |
| A5 | Matching CPP Name: **case sensitive**, exact match với tên folder CPP |
| A6 | CPP folder không có row trong Excel → warning badge `"No metadata"` trong preview, user tự chọn include/exclude |
| A7 | Row Excel không có folder tương ứng → bỏ qua silently, không báo lỗi |
| A8 | Excel sai format (thiếu column bắt buộc, file không đọc được) → hard error, toàn bộ parse dừng, hiển thị lỗi rõ |
| A9 | Tên locale column = user-friendly Apple name → map qua `localeCodeFromName()` trong `lib/locale-utils.ts` |
| A10 | Locale column trong Excel nhưng không có folder CPP tương ứng → promoText vẫn được áp dụng khi upload |
| A11 | Ô Excel trống → giá trị null (không cập nhật deepLink / promoText) |
| A12 | File size limit: **5MB**. Vượt quá → hard error trước khi parse |
| A13 | Parse hoàn toàn client-side: `xlsx` (SheetJS) với dynamic import, `cellFormula: false` |

---

## Design

### Bước 1 — Detect `metadata.xlsx` trong `parseCppFolderStructure`

```typescript
// Trong parseCppFolderStructure, detect file tên metadata.xlsx ở root level:
// parts.length === 2 && parts[1].toLowerCase() === "metadata.xlsx"
// → lưu vào ParsedCppStructure.metadataFile: File | null
```

`ParsedCppStructure` được nâng cấp:
```typescript
export interface ParsedCppStructure {
  primaryLocaleFile: File | null;
  metadataFile: File | null;        // ← MỚI
  cpps: ParsedCppFolder[];
}
```

### Bước 2 — Parse Excel thành `ExcelMetadata`

File mới: `lib/parseMetadataXlsx.ts`

```typescript
export interface ExcelCppRow {
  cppName: string;
  deepLink: string | null;
  promoTexts: Record<string, string>;  // locale short-code → promo text
}

export interface ExcelMetadata {
  rows: ExcelCppRow[];                 // indexed by cppName for O(1) lookup
}

// Throws ExcelParseError với message rõ nếu format sai
export async function parseMetadataXlsx(file: File): Promise<ExcelMetadata>
```

**Logic parse:**
```
1. Check file.size <= 5MB → throw nếu vượt
2. Dynamic import SheetJS: const XLSX = await import('xlsx')
3. file.arrayBuffer() → XLSX.read(buffer, { type: 'array', cellFormula: false, cellHTML: false })
4. Lấy sheet đầu tiên: workbook.Sheets[workbook.SheetNames[0]]
5. XLSX.utils.sheet_to_json(sheet, { header: 1 }) → rows[][]
6. Row 0 = headers, validate có "CPP Name" và "Deep Link"
7. Với mỗi header column >= index 2:
   - localeCodeFromName(header) → nếu không map được, bỏ qua column đó
8. Map rows 1..N → ExcelCppRow[]
   - Trim whitespace, ô trống = null
9. Return { rows }
```

### Bước 3 — Merge vào `CppImportPlan` trong `CppBulkImportDialog`

Trong `processFiles()`:

```typescript
// Sau khi parseCppFolderStructure():
const { primaryLocaleFile, metadataFile, cpps: parsedCpps } = parseCppFolderStructure(fileArr);

let excelMetadata: ExcelMetadata | null = null;
let excelParseError: string | null = null;

if (metadataFile) {
  try {
    excelMetadata = await parseMetadataXlsx(metadataFile);
  } catch (e) {
    excelParseError = e instanceof Error ? e.message : "Failed to parse metadata.xlsx";
    // Hard stop: setExcelError(excelParseError); setStep("drop"); return;
  }
}
```

Khi build `CppImportPlan` per CPP:
```typescript
const excelRow = excelMetadata?.rows.find(r => r.cppName === cppData.cppName) ?? null;
const hasMetadataFile = metadataFile !== null;
const metadataMatched = excelRow !== null;

// deepLink: Excel thắng nếu có file, ngược lại dùng deeplink.txt
const deepLink = hasMetadataFile
  ? (excelRow?.deepLink ?? null)
  : await readDeepLinkTxt(cppData.deepLinkFile);

// promoText per locale: Excel thắng nếu có file
// Trong LocaleCppImportPlan:
const promoText = hasMetadataFile
  ? (excelRow?.promoTexts[localeData.locale] ?? null)
  : await readPromoTxt(localeData.promoTextFile);
```

**Thêm fields vào `CppImportPlan`:**
```typescript
interface CppImportPlan {
  // ... fields hiện tại ...
  metadataSource: "excel" | "files" | "none";  // MỚI: nguồn metadata
  metadataWarning: boolean;                     // MỚI: true nếu có Excel nhưng không khớp tên
}
```

### Bước 4 — UI trong Preview Step

**Banner khi Excel parse error (hard stop ở drop step):**
```
┌─────────────────────────────────────────────────────┐
│ ⚠ metadata.xlsx: Missing required columns "CPP Name"│
│   and "Deep Link". Please check the file format and │
│   re-import.                                  [X]   │
└─────────────────────────────────────────────────────┘
```

**Badge mới trong CPP row (preview step):**

| Trường hợp | Badge |
|---|---|
| Excel có + khớp | `[Excel]` badge xanh lá nhỏ bên cạnh deepLink |
| Excel có + không khớp tên | Warning icon `⚠ No metadata` màu amber |
| Excel không có | Không thay đổi UI (dùng file-based như cũ) |

**Mockup CPP row trong preview — khi có Excel:**
```
▼ Summer Campaign     [Existing]           [Remove]
  primary: en-US
  metadata: ✅ excel  deep link: myapp://campaign/summer
  └ English (U.S.)   [Ready]   "Summer deals await!"   5 shots
  └ Vietnamese       [Ready]   "Ưu đãi mùa hè!"        3 shots

▼ Winter Promo        [New CPP]  ⚠ No metadata  [Remove]
  primary: en-US (fallback ⚠)
  └ English (U.S.)   [New locale]   3 shots
```

---

## Error Handling

| Tình huống | Hành vi |
|---|---|
| File > 5MB | Hard error tại drop step: "metadata.xlsx exceeds 5MB limit" |
| File không đọc được (corrupt) | Hard error: "Failed to read metadata.xlsx" |
| Thiếu column "CPP Name" hoặc "Deep Link" | Hard error: "metadata.xlsx: Missing required column 'CPP Name'" |
| Tên locale column không map được | Bỏ qua column đó, không báo lỗi |
| CPP folder không có row Excel | Warning badge `⚠ No metadata` trong preview — user vẫn có thể upload |
| Row Excel không có folder | Bỏ qua silently |
| Ô deepLink trống | deepLink = null (không PATCH version) |
| Ô promoText trống | promoText = null (không update promo text) |

---

## Files đã tạo / sửa

| File | Action | Ghi chú |
|---|---|---|
| `lib/parseMetadataXlsx.ts` | ✅ Tạo mới | Pure function parse xlsx → `ExcelMetadata` với `byName` Map |
| `lib/parseCppFolderStructure.ts` | ✅ Sửa | Detect `metadata.xlsx` → `ParsedCppStructure.metadataFile` |
| `components/cpp/CppBulkImportDialog.tsx` | ✅ Sửa | Integrate ExcelMetadata vào `processFiles()`, thêm warning UI |
| `package.json` | ✅ Sửa | Thêm `xlsx` (SheetJS) package |
| `public/metadata-template.xlsx` | ✅ Tạo mới | Template file 41 columns (CPP Name, Deep Link, 39 locales). Vietnamese + English (U.S.) ưu tiên đầu. Có 2 example rows. Freeze 2 cột đầu + header |

**Không cần:**
- API route mới
- Server-side changes
- Type changes trong `types/asc.ts`

---

## Decision Log

| Quyết định | Alternatives | Lý do |
|---|---|---|
| `metadata.xlsx` đặt trong root folder, tên cố định | Input riêng trong UI, đặt tùy nơi | Consistent với `primary-locale.txt`; không thêm UI phức tạp |
| Excel thắng toàn bộ khi có file | Merge (promo.txt thắng per-locale) | Đơn giản, rõ ràng — không có conflict rules phức tạp |
| Matching CPP Name: case sensitive | Case insensitive | Consistent với tên folder thực tế; tránh nhầm lẫn khi có Summer Campaign vs summer campaign |
| CPP không khớp → warning, không block | Block hard | Team nhỏ, user biết rõ data; warning đủ để thông báo |
| SheetJS dynamic import | exceljs, read-excel-file | De-facto standard; dynamic import → 0 initial bundle cost; formula disabled |
| 5MB limit | 10MB, không giới hạn | Đủ cho vài chục CPP × vài locale; bảo vệ khỏi file malformed lớn |
| Chỉ đọc sheet đầu tiên | Named sheet, user chọn | YAGNI — team sẽ dùng template chuẩn |

---

## Implementation (hoàn thành)

1. ✅ **`npm install xlsx`** — SheetJS dynamic import, 5MB limit, formula disabled
2. ✅ **`lib/parseMetadataXlsx.ts`** — parse xlsx → `ExcelMetadata` với `byName: Map<string, ExcelCppRow>` cho O(1) lookup
3. ✅ **`lib/parseCppFolderStructure.ts`** — detect `metadata.xlsx` ở root → `ParsedCppStructure.metadataFile`
4. ✅ **`components/cpp/CppBulkImportDialog.tsx`**:
   - Parse Excel trong `processFiles()` — hard stop + banner đỏ nếu lỗi format → quay về drop step
   - Excel thắng toàn bộ: deepLink + promoText từ Excel, bỏ qua `deeplink.txt` / `promo.txt`
   - CPP không khớp Excel → badge `⚠ no metadata` + banner amber trong preview
   - Expanded CPP: hiển thị `metadata: ✓ excel` hoặc `⚠ not found in metadata.xlsx`
   - Folder structure hint trong drop step được cập nhật để mention `metadata.xlsx`
5. ✅ **`public/metadata-template.xlsx`** — template để download/dùng làm mẫu

**Test cases cần verify:**
- Folder có `metadata.xlsx` hợp lệ → deepLink + promoText được áp dụng
- Folder có `metadata.xlsx` thiếu column bắt buộc → hard error, quay về drop step
- Folder có `metadata.xlsx` + tên CPP không khớp → warning badge, vẫn upload được
- Folder không có `metadata.xlsx` → flow cũ (deeplink.txt / promo.txt) hoạt động bình thường
