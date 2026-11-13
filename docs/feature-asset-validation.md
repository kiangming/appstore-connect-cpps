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

Nguồn sự thật DUY NHẤT: `lib/cpp/screenshot-specs.ts` (arc `[CPP-bulkimport-ipad-screenshot-sizes]`, 2026-11-06). Kích thước theo tài liệu Apple (Manager cung cấp 2026-11-06). Map nhóm → display type **ĐÃ ĐO qua UAT** (báo 2026-11-13, `docs/cpp-management/uat-ipad-screenshot-sizes.md`) cho 13" / 11" / 10.5" / 9.7"; dòng 12.9" CHƯA ĐO (bulk không bao giờ gửi vào set này — Q1).

iPhone (arc `[CPP-bulkimport-iphone-screenshot-sizes]`, 2026-11-13): cùng bảng, cùng cơ chế. Kích thước theo tài liệu Apple (Manager cung cấp 2026-11-13; `source` trong bảng là `IPHONE_APPLE_DOCS` = `"Apple docs via Manager 2026-11-13 — map → display type SUY LUẬN, chờ UAT iPhone"`, riêng Face ID (medium) là `IPHONE_APPLE_DOCS_BY_ELIMINATION` = `"Apple docs via Manager 2026-11-13 — map → APP_IPHONE_58 SUY LUẬN THEO LOẠI TRỪ (ứng viên thay thế: APP_IPHONE_61), chờ UAT iPhone"`). Map nhóm → display type **SUY LUẬN, CHƯA ĐO**: 8 nhóm ↔ 8 giá trị `APP_IPHONE_*` của OAS 4.4.1, ghép theo thứ tự cỡ màn hình. ⚠ **Face ID (medium) → `APP_IPHONE_58` là SUY LUẬN THEO LOẠI TRỪ** (ứng viên thay thế: `APP_IPHONE_61`). Chờ xác nhận bằng UAT iPhone (`docs/cpp-management/uat-iphone-screenshot-sizes.md`); sai ⇒ sửa đúng một dòng bảng spec. Hai dòng được phép dùng chung một display type (merge-safe: một set, kích thước hợp nhất, nhãn dòng đầu) ⇒ phương án "Face ID (medium) → `APP_IPHONE_61`" vẫn là sửa một dòng. Label = tên nhóm của Apple (Manager Q-C), dùng ở Preview, editor, `CppDetailPanel`.

| Device / loại màn hình | Display type | Valid resolutions |
|---|---|---|
| iPhone Dynamic Island (large) | `APP_IPHONE_67` (SUY LUẬN) | 1260×2736, 2736×1260, 1290×2796, 2796×1290, 1320×2868, 2868×1320 |
| iPhone Face ID (large) | `APP_IPHONE_65` (SUY LUẬN) | 1284×2778, 2778×1284, 1242×2688, 2688×1242 |
| iPhone Dynamic Island (medium) | `APP_IPHONE_61` (SUY LUẬN) | 1179×2556, 2556×1179, 1206×2622, 2622×1206 |
| iPhone Face ID (medium) | `APP_IPHONE_58` (SUY LUẬN THEO LOẠI TRỪ — thay thế: `APP_IPHONE_61`) | 1170×2532, 2532×1170, 1125×2436, 2436×1125, 1080×2340, 2340×1080 |
| iPhone Home Button (large) | `APP_IPHONE_55` (SUY LUẬN) | 1242×2208, 2208×1242 |
| iPhone Home Button (medium) | `APP_IPHONE_47` (SUY LUẬN) | 750×1334, 1334×750 |
| iPhone Home Button (4") | `APP_IPHONE_40` (SUY LUẬN) | 640×1096, 640×1136, 1136×600, 1136×640 |
| iPhone Home Button (3.5") | `APP_IPHONE_35` (SUY LUẬN) | 640×920, 640×960, 960×600, 960×640 |
| iPhone Duo — **TỪ CHỐI** | — (OAS 4.4.1 không khai display type nào cho Duo; BACKLOG `[CPP-iphone-duo-screenshots]`) | 1398×2034, 2034×1398, 2007×2853, 2853×2007 |
| iPad 13" | `APP_IPAD_PRO_3GEN_129` | 2064×2752, 2752×2064, 2048×2732, 2732×2048 |
| iPad 12.9" | `APP_IPAD_PRO_129` | 2048×2732, 2732×2048 — ⚠ trùng 13" ⇒ bulk luôn gửi vào 13" (Q1); chỉ editor thả vào set 12.9" có sẵn mới vào đây |
| iPad 11" | `APP_IPAD_PRO_3GEN_11` | 1488×2266, 2266×1488, 1512×2316, 2316×1512, 1668×2420, 2420×1668, 1668×2388, 2388×1668, 1640×2360, 2360×1640 |
| iPad 10.5" | `APP_IPAD_105` | 1668×2224, 2224×1668 |
| iPad 9.7" | `APP_IPAD_97` | 1536×2008, 1536×2048, 2048×1496, 2048×1536, 768×1004, 768×1024, 1024×748, 1024×768 |

- **Bulk Import (2 dialog):** ảnh iPad **và iPhone** (iPhone từ 2026-11-13) được phân loại THEO KÍCH THƯỚC vào display type, mỗi type một set (dùng lại set có sẵn cùng type). Tối đa 10 ảnh mỗi type, tính cả ảnh đã có trên Apple. Locale có ảnh iPad mà không có set 13" ⇒ cảnh báo, không chặn. Trước 2026-11-13, mọi ảnh iPhone của một locale vào MỘT set: set iPhone cuối của locale / của locale ready đầu / mặc định `APP_IPHONE_65` — luật này đã bỏ. Preview video vẫn dò preview type từ preview set có sẵn (không đổi).
- **Cảnh báo iPhone (Manager D3, không khoá Import):** khi ảnh iPhone **hợp lệ** của lần import không có Dynamic Island (large) lẫn Face ID (large) **và** locale chưa có set nào của hai loại đó trên Apple (một set 67 / 65 có sẵn, kể cả rỗng, đều tắt cảnh báo); bỏ qua cảnh báo khi không đọc được set có sẵn (KB P7). Thư mục chỉ có ảnh Duo / sai cỡ ⇒ không có cảnh báo (đã bị chặn bằng lỗi). Câu nguyên văn:
  `No required iPhone screenshots — Apple requires Dynamic Island (large) or Face ID (large) screenshots for apps that run on iPhone. Import is not blocked.`
- **iPhone Duo (Manager D6):** bị từ chối (**chặn** — Import All bị khoá) ở thư mục `iphone/` và ở editor (mọi set iPhone), câu riêng:
  `1398×2034 is an iPhone Duo screenshot size — iPhone Duo is not supported by the App Store Connect API yet; upload it manually on App Store Connect.`
- **Sai cỡ trong `iphone/` (chặn):** `<W>×<H> is not a valid iPhone screenshot size. Valid iPhone sizes — Dynamic Island (large): … · … · Home Button (3.5"): …` (đủ 8 nhóm); ảnh iPad ⇒ gợi ý D8 chen **trước dấu chấm**: `2064×2752 is not a valid iPhone screenshot size — this looks like an iPad screenshot; move it to screenshots/ipad/. Valid iPhone sizes — …`. Preview hiện `<tên file>: ` trước mỗi câu. Trong `ipad/`, gợi ý `— this looks like an iPhone screenshot; move it to screenshots/iphone/` nay nhận ra cả 32 kích thước iPhone (Manager Q-A; trước đó chỉ 4 cỡ 6.5").
- **Editor:** kiểm theo SET ĐÍCH cho cả iPad và iPhone (ảnh 11" vào set 11" được nhận; ảnh 13" vào set 11" bị từ chối; ảnh Face ID (large) vào set Dynamic Island (large) bị từ chối). Ảnh thuộc set khác cùng thiết bị ⇒ câu nêu tên set, ví dụ `Resolution: got 1284×2778 — expected one of: 1260×2736, 2736×1260, 1290×2796, 2796×1290, 1320×2868, 2868×1320 — this is an iPhone Face ID (large) size, not iPhone Dynamic Island (large)`. Locale chưa có set iPhone ⇒ editor dùng `IPHONE_DEFAULT_DISPLAY_TYPE` = `APP_IPHONE_67` (Dynamic Island (large), Manager D5) và chỉ nhận kích thước của nhóm này; ảnh iPhone cỡ khác cho locale đó ⇒ đi Bulk Import (Manager Q-B). Trước 2026-11-13 editor nhận 4 cỡ 6.5" vào MỌI set iPhone.
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
