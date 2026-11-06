# Feature: Asset Validation trước khi Upload

> Status: ✅ Implemented (2026-03-17)

---

## Tổng quan

Validate screenshot và video trước khi upload vào ASC. File fail bị block ngay khi drop — không vào upload queue.

Tích hợp vào 3 flow: Manual Upload, Bulk Import, CPP Bulk Import.

---

## Config

```env
# .env.local
NEXT_PUBLIC_ASSET_VALIDATION_DEEP=true   # true = ffmpeg.wasm | false = basic only
```

- `NEXT_PUBLIC_` prefix vì validation chạy client-side
- Mặc định: `true`
- `false` → chỉ validate những gì browser đọc được + checklist reminder

---

## Validation Rules

### Screenshot

Nguồn sự thật DUY NHẤT: `lib/cpp/screenshot-specs.ts` (arc `[CPP-bulkimport-ipad-screenshot-sizes]`, 2026-11-06). Kích thước theo tài liệu Apple (Manager cung cấp 2026-11-06); map nhóm → display type là SUY LUẬN, xác nhận bằng UAT (`docs/cpp-management/uat-ipad-screenshot-sizes.md`).

| Device / loại màn hình | Display type | Valid resolutions |
|---|---|---|
| iPhone (giữ nguyên, ngoài phạm vi arc) | set có sẵn / mặc định `APP_IPHONE_65` | 1284×2778, 2778×1284, 1242×2688, 2688×1242 |
| iPad 13" | `APP_IPAD_PRO_3GEN_129` | 2064×2752, 2752×2064, 2048×2732, 2732×2048 |
| iPad 12.9" | `APP_IPAD_PRO_129` | 2048×2732, 2732×2048 — ⚠ trùng 13" ⇒ bulk luôn gửi vào 13" (Q1); chỉ editor thả vào set 12.9" có sẵn mới vào đây |
| iPad 11" | `APP_IPAD_PRO_3GEN_11` | 1488×2266, 2266×1488, 1512×2316, 2316×1512, 1668×2420, 2420×1668, 1668×2388, 2388×1668, 1640×2360, 2360×1640 |
| iPad 10.5" | `APP_IPAD_105` | 1668×2224, 2224×1668 |
| iPad 9.7" | `APP_IPAD_97` | 1536×2008, 1536×2048, 2048×1496, 2048×1536, 768×1004, 768×1024, 1024×748, 1024×768 |

- **Bulk Import (2 dialog):** ảnh iPad được phân loại THEO KÍCH THƯỚC vào display type, mỗi type một set (dùng lại set có sẵn cùng type). Tối đa 10 ảnh mỗi type, tính cả ảnh đã có trên Apple. Locale có ảnh iPad mà không có set 13" ⇒ cảnh báo, không chặn.
- **Editor:** kiểm theo SET ĐÍCH (ảnh 11" vào set 11" được nhận; ảnh 13" vào set 11" bị từ chối).
- Tối thiểu 3 ảnh: không kiểm (luật lúc submit).

Đọc qua: `new Image()` → `width/height`

### Video — Basic mode (`ASSET_VALIDATION_DEEP=false`)

| Tiêu chí | iPhone | iPad |
|---|---|---|
| Resolution | 886×1920 hoặc 1920×886 | 1200×1600 hoặc 1600×1200 |
| Format | .m4v, .mp4, .mov | .m4v, .mp4, .mov |
| Duration | 15–30s | 15–30s |
| File size | ≤500MB | ≤500MB |
| Max count | 3 | 3 |

Kèm checklist reminder (không block):
```
□ FPS ≤ 30
□ Bitrate 10–12 Mbps
□ Audio: AAC 256kbps, Stereo, 44.1kHz or 48kHz
□ Stereo config: 1 track 2-ch or 2 tracks 1-ch
```

### Video — Deep mode (`ASSET_VALIDATION_DEEP=true`, ffmpeg.wasm)

Tất cả basic + thêm (hard errors):

| Tiêu chí | Giá trị hợp lệ |
|---|---|
| FPS | ≤ 30 |
| Bitrate | 10,000–12,000 kbps |
| Audio codec | aac |
| Audio bitrate | ~256kbps |
| Sample rate | 44100 hoặc 48000 Hz |
| Audio channels | stereo (2 channels) |

Stereo channel mapping (1 track 2-ch vs 2 track 1-ch): **warning only** (không block) vì ffmpeg.wasm không verify chính xác.

---

## Architecture

### Files mới

| File | Mô tả |
|---|---|
| `lib/asset-validator.ts` | Core validation logic — dùng chung cho cả 3 flow |
| `lib/ffmpeg-loader.ts` | Lazy load + cache ffmpeg.wasm instance |

### Interface

```typescript
type DeviceType = "iphone" | "ipad";

interface ValidationResult {
  ok: boolean;
  errors: string[];    // Hard errors → block upload
  warnings: string[];  // Chỉ hiện khi deep mode OFF
}

validateScreenshot(file: File, device: DeviceType): Promise<ValidationResult>
validateVideo(file: File, device: DeviceType): Promise<ValidationResult>
```

### ffmpeg.wasm — Single-threaded mode

Dùng single-threaded WASM (không cần SharedArrayBuffer) → **không cần COOP/COEP headers** → không break external resources (Apple CDN, v.v.).

Trade-off: chậm hơn ~2–3x so với multi-threaded, nhưng với use case chỉ đọc metadata (không transcode) vẫn đủ nhanh (<2s/file).

```typescript
// lib/ffmpeg-loader.ts
let instance: FFmpeg | null = null;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (instance) return instance;
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  instance = new FFmpeg();
  await instance.load({ /* single-thread core URL */ });
  return instance;
}
```

Load lazy: chỉ khi có video được drop lần đầu.

### ffmpeg.wasm — Concurrency mutex

**Vấn đề:** ffmpeg.wasm dùng singleton + Emscripten virtual filesystem (FS) không thread-safe. Khi CPP Bulk Import validate nhiều video song song (nested `Promise.all`), các `writeFile` + `exec` calls xung đột → `ErrnoError: FS error` → fallback về basic mode → hiển thị checklist thay vì pass/fail.

**Fix (trong `lib/asset-validator.ts`):**

```typescript
// Module-level promise queue — serializes all validateVideoDeep calls
let ffmpegQueue: Promise<void> = Promise.resolve();

async function validateVideoDeep(...) {
  // Acquire slot
  let releaseQueue!: () => void;
  const myTurn = ffmpegQueue;
  ffmpegQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
  await myTurn;

  try {
    // ...ffmpeg operations...
    // Named handler để off() đúng — tránh listener leak
    const logHandler = ({ message }: { message: string }) => { ... };
    ffmpeg.on("log", logHandler);
    try { await ffmpeg.exec([...]); } catch { /* expected */ }
    ffmpeg.off("log", logHandler);
    // ...
  } finally {
    releaseQueue(); // Luôn release dù có lỗi
  }
}
```

Screenshots vẫn chạy song song (không dùng ffmpeg), chỉ video bị serialize.

---

## UI — Validation States

### Per-file badge

| State | Icon | Color |
|---|---|---|
| `validating` | spinner | slate |
| `pass` | ✓ | green |
| `fail` | ✗ | red — không upload |
| `warning` | ℹ | amber — upload được |

### Error messages (actionable)

```
❌ Resolution: got 1080×1920, expected 886×1920 or 1920×886
❌ Duration: 12s — must be 15–30 seconds
❌ File size: 623MB — max 500MB
❌ FPS: 60fps — max 30fps
❌ Bitrate: 8.2 Mbps — must be 10–12 Mbps
❌ Audio: mono — stereo required
```

### Bulk Import flows — aggregate lên CPP/locale level

```
CPP: Summer Campaign
  ├── vi  ✅ 5 screenshots  ✅ 1 video
  ├── en  ❌ 2 screenshots (invalid resolution) — BLOCKED
  └── ja  ✅ 5 screenshots  ⚠️  1 video (check manually)
```

"Start Import" disabled nếu có bất kỳ ❌.

---

## Integration Points

### Flow 1: Manual Upload (`LocalizationManager.tsx`)
- `onDrop` → `validateScreenshot()` / `validateVideo()`
- fail → error inline, không thêm vào state
- pass → queue upload như hiện tại
- Số lượng check: `existingCount + newValidFiles ≤ max`

### Flow 2: Bulk Import (`BulkImportDialog.tsx`)
- Parse folder → validate tất cả files trong step Preview (`Promise.all`)
- Hiển thị status per-locale per-device
- "Start Import" disabled nếu có ❌

### Flow 3: CPP Bulk Import (`CppBulkImportDialog.tsx`)
- Validate tất cả assets của tất cả CPPs (`Promise.all`)
- Aggregate lên CPP level
- CPP bị block highlighted rõ trong preview list
- "Start Import" disabled nếu có CPP nào ❌

---

## Files thay đổi

| File | Thay đổi |
|---|---|
| `lib/asset-validator.ts` | **NEW** |
| `lib/ffmpeg-loader.ts` | **NEW** |
| `components/cpp/LocalizationManager.tsx` | Gọi validator trong onDrop |
| `components/cpp/BulkImportDialog.tsx` | Validate trong step preview |
| `components/cpp/CppBulkImportDialog.tsx` | Validate trong step preview |
| `.env.local` | Thêm `NEXT_PUBLIC_ASSET_VALIDATION_DEEP=true` |
| `package.json` | Thêm `@ffmpeg/ffmpeg`, `@ffmpeg/util` |

---

## Decision Log

| Quyết định | Alternatives | Lý do |
|---|---|---|
| ffmpeg.wasm client-side | ffprobe server-side, basic only | Full coverage, không cần server infra, hoạt động trên Vercel |
| Single-threaded ffmpeg.wasm | Multi-threaded (SharedArrayBuffer) | Tránh COOP/COEP headers, không break external resources |
| Config qua env var `NEXT_PUBLIC_ASSET_VALIDATION_DEEP` | Runtime toggle UI | Đơn giản, consistent với config pattern hiện tại |
| Block hard khi fail | Warn + bypass | Apple reject nếu asset sai → better fail fast |
| Validate on drop (immediate) | Validate on submit | Feedback sớm hơn cho user |
| Stereo config là warning, không block | Block | ffmpeg.wasm không verify chính xác channel mapping |
