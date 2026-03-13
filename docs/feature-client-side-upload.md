# Client-Side Direct Upload — Design Document

> Status: **PENDING DEVELOPMENT**
> Priority: 🟡 Should (quan trọng nếu deploy Vercel, upload nhiều assets)
> Estimated effort: ~3-4 giờ (Claude)

---

## Bối cảnh & Vấn đề

### Upload flow hiện tại (server-proxied)

```
Browser → POST /api/asc/upload (Next.js server) → PUT Apple CDN
```

- File đi qua Vercel server 2 lần (upload lên Vercel + upload sang Apple CDN)
- Vercel free tier: 100GB bandwidth/tháng — với nhiều video preview (50-500MB mỗi file), limit này dễ đạt
- Vercel serverless function: timeout 60s / 300s (Pro), max body 4.5MB (Hobby) — videos lớn sẽ bị reject
- Docker self-host: không bị Vercel limit nhưng server vẫn phải xử lý double bandwidth

### Upload flow mới (client-side direct)

```
Browser → POST /api/asc/reserve (Next.js server)  ← chỉ reserve slot
         ← uploadOperations (presigned URLs + headers)
Browser → PUT Apple CDN (trực tiếp, bypass Vercel)
Browser → POST /api/asc/confirm (Next.js server)  ← confirm với checksum
```

- Server chỉ xử lý metadata nhỏ (reserve + confirm), không đụng đến file
- File upload đi thẳng từ browser lên Apple CDN
- Không tốn Vercel bandwidth cho file data

---

## Yêu cầu

- Screenshots và video previews đều upload trực tiếp từ browser
- Không thay đổi UX — user vẫn drag & drop như cũ
- Progress indication vẫn hoạt động
- Error handling: nếu reserve thành công nhưng upload CDN fail, hiện lỗi rõ ràng
- Backward compatible: không break Docker deploy

---

## Design

### Phần 1: API Routes mới / refactored

#### `POST /api/asc/reserve-screenshot` (MỚI)

```typescript
// Body: { screenshotSetId, fileName, fileSize, mimeType }
// → gọi ascFetch POST /v1/appScreenshots
// → trả về { screenshotId, uploadOperations }
// (không nhận file, chỉ nhận metadata)
```

#### `POST /api/asc/confirm-screenshot` (MỚI)

```typescript
// Body: { screenshotId, md5Checksum }
// → gọi ascFetch PATCH /v1/appScreenshots/{id} với { uploaded: true, sourceFileChecksum }
// → trả về confirmed screenshot object
```

#### `POST /api/asc/reserve-preview` (MỚI, tách từ upload-preview)

```typescript
// Body: { previewSetId, fileName, fileSize, mimeType }
// → gọi ascFetch POST /v1/appPreviews
// → trả về { previewId, uploadOperations }
```

#### `POST /api/asc/confirm-preview` (MỚI, tách từ upload-preview)

```typescript
// Body: { previewId, md5Checksum }
// → gọi ascFetch PATCH /v1/appPreviews/{id} với { uploaded: true, sourceFileChecksum }
```

> **Routes cũ** (`/api/asc/upload` và `/api/asc/upload-preview`) giữ nguyên cho backward compat,
> hoặc xóa nếu không còn dùng. Decision: **xóa** sau khi migrate xong.

### Phần 2: Client-side upload utility

```typescript
// lib/upload-utils.ts

// Upload file trực tiếp lên Apple CDN theo uploadOperations
export async function uploadToOperations(
  uploadOperations: UploadOperation[],
  file: File,
  onProgress?: (percent: number) => void
): Promise<void>;

// Compute MD5 checksum client-side (dùng SubtleCrypto API)
export async function computeMD5(file: File): Promise<string>;
```

**Lưu ý:** `SubtleCrypto` không hỗ trợ MD5 trực tiếp (chỉ SHA-*). Cần dùng `spark-md5` package hoặc implement MD5 bằng WebCrypto polyfill.
- **Decision: Dùng `spark-md5`** — lightweight (5KB gzipped), no dependency, browser compatible.

### Phần 3: Update LocalizationManager

Thay đổi `handleUploadScreenshot()` và `handleUploadPreview()` trong `LocalizationManager.tsx`:

**Before (server-proxied):**
```typescript
const formData = new FormData();
formData.append("screenshotSetId", setId);
formData.append("file", file);
await fetch("/api/asc/upload", { method: "POST", body: formData });
```

**After (client-side direct):**
```typescript
// 1. Reserve slot
const { screenshotId, uploadOperations } = await fetch("/api/asc/reserve-screenshot", {
  method: "POST",
  body: JSON.stringify({ screenshotSetId: setId, fileName: file.name, fileSize: file.size, mimeType: file.type }),
}).then(r => r.json());

// 2. Upload directly to Apple CDN
await uploadToOperations(uploadOperations, file, (pct) => setProgress(pct));

// 3. Compute MD5 và confirm
const md5 = await computeMD5(file);
await fetch("/api/asc/confirm-screenshot", {
  method: "POST",
  body: JSON.stringify({ screenshotId, md5Checksum: md5 }),
});
```

### Phần 4: Update BulkImportDialog

`BulkImportDialog.tsx` dùng cùng pattern upload trong vòng lặp multi-file. Update tương tự.

---

## CORS Considerations

Apple CDN `uploadOperations` trả về presigned URL với `method: "PUT"` và custom headers.
Browser PUT request đến Apple CDN có thể gặp CORS preflight issue.

**Cần verify:** Thực tế ASC's `uploadOperations` URLs có Accept CORS từ browser không.

Nếu CORS blocked:
- **Fallback:** Giữ server-proxy cho upload, chỉ optimize bằng streaming (không buffer toàn bộ file)
- **Alternative:** Dùng `multipart/form-data` streaming qua Next.js route với `stream: true`

> ⚠️ **Risk:** Đây là điểm chưa được verify. Phải test thực tế trước khi implement toàn bộ.
> Nếu Apple CDN block CORS → fallback về server-proxy nhưng thêm streaming để giảm memory pressure.

---

## Dependencies mới

- `spark-md5` — tính MD5 checksum client-side (browser compatible)
  ```bash
  npm install spark-md5
  npm install -D @types/spark-md5
  ```

---

## Files cần thay đổi

| File | Thay đổi |
|---|---|
| `lib/asc-client.ts` | Thêm `reserveScreenshot()`, `confirmScreenshot()`, `reservePreview()`, `confirmPreview()` (tách từ existing) |
| `lib/upload-utils.ts` | Tạo mới — `uploadToOperations()` + `computeMD5()` |
| `app/api/asc/reserve-screenshot/route.ts` | Tạo mới |
| `app/api/asc/confirm-screenshot/route.ts` | Tạo mới |
| `app/api/asc/reserve-preview/route.ts` | Tạo mới |
| `app/api/asc/confirm-preview/route.ts` | Tạo mới |
| `app/api/asc/upload/route.ts` | Xóa (sau khi migrate) |
| `app/api/asc/upload-preview/route.ts` | Xóa (sau khi migrate) |
| `components/cpp/LocalizationManager.tsx` | Update `handleUploadScreenshot()` + `handleUploadPreview()` |
| `components/cpp/BulkImportDialog.tsx` | Update upload loop |

---

## Testing Plan

1. Upload 1 screenshot nhỏ (PNG ~500KB) → verify hiển thị đúng trong UI
2. Upload 1 video preview (MP4 ~30MB) → verify upload thành công, không timeout
3. Upload batch 10+ screenshots trong BulkImport → verify tất cả complete
4. Upload với bad network (throttle DevTools) → verify progress indicator + error handling
5. Verify Vercel function logs không thấy file data pass qua

---

## Decision Log

| Quyết định | Lý do |
|---|---|
| Tách thành reserve + confirm routes riêng | Single responsibility; dễ test; confirm có thể gọi lại nếu CDN upload thành công nhưng confirm chưa gọi |
| Dùng `spark-md5` (không phải WebCrypto) | SubtleCrypto không support MD5; spark-md5 lightweight và battle-tested |
| Xóa routes cũ sau migrate | YAGNI; không giữ dead code |
| CORS cần verify trước | Nếu blocked, fallback streaming — không assume |
| Không thay đổi UX | Ưu tiên backward compat với workflow hiện tại của team |
