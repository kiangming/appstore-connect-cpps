# [CPP-bulkimport-iphone-screenshot-sizes] Bulk Import CPP — screenshot iPhone theo danh sách kích thước Apple mới nhất — census + G0

**Trạng thái:** census xong (2026-11-13) — không phát hiện điều gì trái D1–D9 ⇒ **G0 xong** (§G0), chờ gate G0. G1 chưa làm.
**Nhánh:** `arc-cpp-bulkimport-iphone-screenshot-sizes` (từ `origin/main` = `82cde53`).
**Mở BACKLOG:** `[CPP-iphone-screenshot-sizes]` + `[CPP-iphone-default-mismatch]` (arc xử lý cả hai). Ghi mới: `[CPP-iphone-duo-screenshots]` (D6).
**Khuôn:** arc iPad (`design-cpp-bulkimport-ipad-screenshot-sizes.md`, KB §38).

Nhãn: **ĐÃ ĐO** (probe / test gọi hàm thật) · **ĐỌC CODE** (file:line) · **CÓ TRONG SCHEMA** (OAS 4.4.1, JSON pointer) · **THEO TÀI LIỆU APPLE** (danh sách Manager cung cấp 2026-11-13 — "Apple docs via Manager 2026-11-13", KHÔNG phải đã đo) · **SUY LUẬN** · **CHƯA BIẾT**. Không có lệnh nào gửi lên Apple trong census này.

---

## TL;DR

1. **Hôm nay chỉ 4 kích thước iPhone được nhận** (Face ID (large) 6.5"). 32 kích thước còn lại trong danh sách Apple, kể cả 4 kích thước Duo, bị từ chối ở thư mục `iphone/` (ĐÃ ĐO, §C1).
2. **Ảnh iPhone vẫn đi luật cũ.** Một set cho mọi ảnh iPhone của locale: set iPhone cuối / của locale ready đầu / `APP_IPHONE_65`. Editor có fallback `APP_IPHONE_67` và nhận 4 cỡ 6.5" vào **mọi** set iPhone (ĐÃ ĐO).
3. **OAS 4.4.1 có đúng 8 display type iPhone. KHÔNG có loại nào cho iPhone Duo** (§C2) ⇒ D6: Duo ngoài phạm vi.
4. **9 nhóm Apple, 8 nhóm có display type.** Map 8 ↔ 8 là **SUY LUẬN** (như iPad). **Không kích thước nào thuộc hai nhóm**, và không trùng kích thước iPad (ĐÃ ĐO trên danh sách) ⇒ D4 không cần dùng.
5. Không có gì trái D1–D9. Có **4 hệ quả cần Manager chốt ở gate** (§Câu cho gate): gợi ý iPad mở rộng (Q-A), fallback editor (Q-B), label (Q-C), câu Duo + câu cảnh báo (Q-D).

---

## C1 — Hiện trạng iPhone trên `82cde53`

### Bảng và hàm (ĐỌC CODE)

| Chỗ | Nội dung |
|---|---|
| `lib/cpp/screenshot-specs.ts:81-83` | `IPHONE_SCREENSHOT_SIZES` — 4 kích thước, cấp thiết bị, KHÔNG có display type |
| `screenshot-specs.ts:128-129` | `sizesForDisplayType`: mọi type không phải iPad ⇒ cùng 4 kích thước ⇒ editor nhận 4 cỡ 6.5" vào MỌI set iPhone |
| `screenshot-specs.ts:138-141` | `screenshotSizeError("iphone")`: câu `Resolution: got W×H — expected one of: <4 cỡ>`; không có gợi ý ảnh iPad nằm nhầm `iphone/` |
| `screenshot-specs.ts:144-146` | gợi ý "looks like an iPhone screenshot" ở thư mục `ipad/` chỉ dựa trên 4 kích thước đó |
| `lib/asset-validator.ts:131` | `checkScreenshot`: `displayType` chỉ tính cho iPad; iPhone ⇒ `null` |
| `screenshot-specs.ts:95-103` | label iPhone (`iPhone 6.7"` …); thiếu `APP_IPHONE_58` |
| `types/asc.ts:102-114` | union `ScreenshotDisplayType` thiếu `APP_IPHONE_58` (`[CPP-types-asc-gaps]`) |

### Luật chọn set iPhone (ĐỌC CODE) — arc iPad để nguyên

| | Dialog nhiều CPP (`CppBulkImportDialog.tsx`) | Dialog một CPP (`BulkImportDialog.tsx`) |
|---|---|---|
| Mặc định | `DEFAULT_IPHONE_SCREENSHOT = "APP_IPHONE_65"` `:42` | `:35` |
| Type của locale ready đầu (CPP-wide) | `:799`, `:819` | `:290`, `:304` |
| Set iPhone CUỐI của chính locale thắng | `:620`, `:634` | `:406`, `:420` |
| Một nhóm iPhone đưa vào hàm upload dùng chung | `:680` `{ displayType: iphoneSS, files: plan.screenshotFiles.iphone }` | `:464` |
| Preview video iPhone (GIỮ NGUYÊN) | `:621`, `:642`, `:800`, `:826` | `:291` … |

- **Editor:** fallback khi locale chưa có set iPhone là `"APP_IPHONE_67"` (`components/cpp/LocalizationManager.tsx:841`). Ảnh được kiểm bằng `validateScreenshotForDisplayType(f, type)` (`:514`), nhưng với iPhone hàm này trả về 4 cỡ 6.5" bất kể type (xem `sizesForDisplayType` ở trên).
- **⇒ `[CPP-iphone-default-mismatch]` (ĐÃ ĐO, test G0):** cùng một ảnh 6.5", cùng một locale chưa có set iPhone ⇒ bulk POST `APP_IPHONE_65`, editor POST `APP_IPHONE_67`.

### Kích thước bị từ chối hôm nay (ĐÃ ĐO — probe + test G0, hàm thật)

| Nhóm (tài liệu Apple) | Kích thước | `iphone/` | `ipad/` | editor, set 67 / 65 / 61 |
|---|---|---|---|---|
| iPhone Duo | 1398×2034 · 2034×1398 · 2007×2853 · 2853×2007 | REJECT | REJECT | REJECT |
| Dynamic Island (large) | 1260×2736 · 2736×1260 · 1290×2796 · 2796×1290 · 1320×2868 · 2868×1320 | REJECT | REJECT | REJECT |
| **Face ID (large)** | 1284×2778 · 2778×1284 · 1242×2688 · 2688×1242 | **OK** | REJECT (+ gợi ý) | **OK cả 3** |
| Dynamic Island (medium) | 1179×2556 · 2556×1179 · 1206×2622 · 2622×1206 | REJECT | REJECT | REJECT |
| Face ID (medium) | 1170×2532 · 2532×1170 · 1125×2436 · 2436×1125 · 1080×2340 · 2340×1080 | REJECT | REJECT | REJECT |
| Home Button (large) | 1242×2208 · 2208×1242 | REJECT | REJECT | REJECT |
| Home Button (medium) | 750×1334 · 1334×750 | REJECT | REJECT | REJECT |
| Home Button (4") | 640×1096 · 640×1136 · 1136×600 · 1136×640 | REJECT | REJECT | REJECT |
| Home Button (3.5") | 640×920 · 640×960 · 960×600 · 960×640 | REJECT | REJECT | REJECT |

⇒ 36 kích thước: 4 OK, **32 REJECT** (28 sẽ được nhận ở G1; 4 Duo vẫn từ chối nhưng đổi câu — D6).

Câu lỗi nguyên văn hôm nay:
- `iphone/`, ảnh 1179×2556: `Resolution: got 1179×2556 — expected one of: 1284×2778, 2778×1284, 1242×2688, 2688×1242`
- `iphone/`, ảnh iPad 2064×2752: cùng câu đó, không có gợi ý.
- `ipad/`, ảnh 1284×2778: `… — this looks like an iPhone screenshot; move it to screenshots/iphone/. …`
- `ipad/`, ảnh 1179×2556: không có gợi ý.

---

## C2 — OAS 4.4.1 (`docs/openapi.oas.v20260717.json`, `info.version` = 4.4.1)

**Display type iPhone (CÓ TRONG SCHEMA)** — `#/components/schemas/ScreenshotDisplayType/enum`, cùng danh sách ở `filter[screenshotDisplayType]` của `#/paths/~1v1~1appCustomProductPageLocalizations~1{id}~1appScreenshotSets/get/parameters`:

`APP_IPHONE_67` · `APP_IPHONE_61` · `APP_IPHONE_65` · `APP_IPHONE_58` · `APP_IPHONE_55` · `APP_IPHONE_47` · `APP_IPHONE_40` · `APP_IPHONE_35` — **8 giá trị** (đúng thứ tự trong enum). Ngoài ra có 7 giá trị `IMESSAGE_APP_IPHONE_*` (ngoài phạm vi). `PreviewType` có 8 giá trị `IPHONE_*` tương ứng.

**iPhone Duo — OAS KHÔNG KHAI.**
- Đã tra: toàn văn file với `DUO` / `Duo` / `duo` / `IPHONE_69` / `IPHONE_63` / `INNER` / `OUTER` ⇒ 0 kết quả.
- `Fold` có 7 kết quả, nhưng chỉ là `CiFilesAndFoldersRule` / `filesAndFoldersRule` (Xcode Cloud), không liên quan thiết bị.
- Kích thước Duo `1398` / `2034` / `2007` / `2853` ⇒ 0 kết quả.
- ⇒ **D6: Duo NGOÀI PHẠM VI.**

**Kích thước pixel:** OAS KHÔNG KHAI (như iPad). `#/components/schemas/ScreenshotDisplayType` chỉ có `type` + `enum`. Không tìm thấy `1320`, `2868`, `1179`, `2556`.

**D5:** `APP_IPHONE_67` CÓ TRONG SCHEMA ⇒ đề xuất của Manager (mặc định = Dynamic Island (large)) dùng được.

---

## C3 — Map kích thước ⇒ display type

Nhóm của từng kích thước: **THEO TÀI LIỆU APPLE**. Nhóm ⇒ display type: **SUY LUẬN** — 8 nhóm có display type ↔ 8 giá trị enum, ghép theo thứ tự cỡ màn hình và chuỗi "thiếu ⇒ dùng ảnh của nhóm X" trong danh sách. **Không dòng nào ĐÃ ĐO.**

| Nhóm | Kích thước | Display type đề xuất | Mức chắc | Ghi chú |
|---|---|---|---|---|
| Dynamic Island (large) | 1260×2736 · 2736×1260 · 1290×2796 · 2796×1290 · 1320×2868 · 2868×1320 | `APP_IPHONE_67` | SUY LUẬN | mặc định mới (D5) |
| Face ID (large) | 1284×2778 · 2778×1284 · 1242×2688 · 2688×1242 | `APP_IPHONE_65` | SUY LUẬN (= hành vi mặc định hôm nay) | |
| Dynamic Island (medium) | 1179×2556 · 2556×1179 · 1206×2622 · 2622×1206 | `APP_IPHONE_61` | SUY LUẬN | |
| Face ID (medium) | 1170×2532 · 2532×1170 · 1125×2436 · 2436×1125 · 1080×2340 · 2340×1080 | `APP_IPHONE_58` | SUY LUẬN | ⚠ gồm 1170×2532 (iPhone 12/13/14, màn 6.1") dù tên enum là "58"; ghép theo loại trừ |
| Home Button (large) | 1242×2208 · 2208×1242 | `APP_IPHONE_55` | SUY LUẬN | |
| Home Button (medium) | 750×1334 · 1334×750 | `APP_IPHONE_47` | SUY LUẬN | |
| Home Button (4") | 640×1096 · 640×1136 · 1136×600 · 1136×640 | `APP_IPHONE_40` | SUY LUẬN | |
| Home Button (3.5") | 640×920 · 640×960 · 960×600 · 960×640 | `APP_IPHONE_35` | SUY LUẬN | |
| iPhone Duo | 1398×2034 · 2034×1398 · 2007×2853 · 2853×2007 | — | OAS KHÔNG KHAI | từ chối, câu riêng (D6) |

- **Trùng nhóm:** 36 dòng, 0 kích thước thuộc hai nhóm; 0 kích thước trùng bảng iPad (ĐÃ ĐO trên danh sách, probe + test G0 "36 → REJECT ở `ipad/`"). ⇒ D4 không cần dùng. Thứ tự ưu tiên của bảng iPhone không ảnh hưởng tới kết quả.
- **Kiểm chứng:** bằng UAT end-to-end sau deploy (D9), như iPad.

---

## C4 — Dùng lại khuôn UAT iPad

| Phần | Dùng lại được? |
|---|---|
| `scripts/uat/gen-ipad-screenshot-kit.py` (PNG RGB không alpha, 72 dpi, zlib thuần) | **Có.** Thêm danh sách iPhone + tham số thư mục `iphone`. Font bitmap thiếu glyph cho chữ in mới (`F`, `H`, `Y`, `V` cho "FACE ID", "HOME", "DYNAMIC", "DUO"…) ⇒ thêm glyph. Đề xuất: đổi thành một script cho cả hai thiết bị, hoặc script iPhone riêng (giữ nguyên script iPad) |
| Cấu trúc thư mục `<bộ>/UAT …/en-US/screenshots/<device>/` | **Có**, đổi `ipad` → `iphone` |
| Test ràng bộ ảnh với bảng (đọc IHDR, `lib/cpp/uat-ipad-kit.test.ts`) | **Có**, chép cho bộ iPhone |
| Hướng dẫn `uat-ipad-screenshot-sizes.md` | **Có**, đổi bảng kỳ vọng |
| Số ảnh mỗi display type | 32 kích thước có type, mỗi type ≤ 6 ⇒ **một locale đủ** (≤ 10/type) |

Bộ đề xuất:
- **A:** 32 ảnh, import thật.
- **B:** 1 ảnh sai cỡ + 1 ảnh Duo, phải bị chặn với câu Duo riêng.
- **C:** chỉ ảnh Dynamic Island (medium), để xem cảnh báo D3.

---

## Đối chiếu D1–D9 — không có điều trái

| | Census nói gì |
|---|---|
| D1 cùng cơ chế với iPad | Được: hàm upload dùng chung đã nhận một danh sách nhóm; chỉ cần thay `{ displayType: iphoneSS, … }` bằng các nhóm iPhone theo kích thước, rồi bỏ `iphoneSS` / `cppIphoneSS` / `DEFAULT_IPHONE_SCREENSHOT`. Preview video GIỮ `cppIphonePV` |
| D2 editor theo set đích | `sizesForDisplayType` hiện trả cùng 4 cỡ cho mọi type iPhone ⇒ đổi sang bảng theo type |
| D3 cảnh báo thiếu 67 / 65 | Làm như cảnh báo 13" (`checkIpadGroups`) |
| D4 trùng nhóm | Không có ca trùng |
| D5 mặc định = Dynamic Island (large) | `APP_IPHONE_67` có trong enum. Sau D1, bulk không còn dùng mặc định (type đến từ kích thước) ⇒ "mặc định" chỉ còn là fallback của editor |
| D6 Duo | OAS KHÔNG KHAI ⇒ ngoài phạm vi; BACKLOG `[CPP-iphone-duo-screenshots]` đã ghi |
| D7 tối đa 10 | Logic G1b dùng lại được nguyên |
| D8 gợi ý ảnh iPad trong `iphone/` | Đối xứng với `screenshot-specs.ts:144-146` |
| D9 UAT | §C4 |

### Câu cho gate (hệ quả, không trái quyết định)

> **Q-A — Gợi ý trong thư mục `ipad/` mở rộng theo bảng iPhone mới?**
> Hôm nay gợi ý "this looks like an iPhone screenshot" chỉ nhận ra 4 cỡ 6.5" (ĐÃ ĐO: ảnh 1179×2556 trong `ipad/` không có gợi ý). Nếu dùng bảng iPhone mới cho gợi ý này, **câu lỗi iPad đổi** cho 28 kích thước iPhone mới nằm nhầm `ipad/`. Hành vi chặn/nhận iPad không đổi; test iPad hiện có vẫn xanh không sửa.
> Đề xuất **CÓ** (đối xứng D8). G0 đã ghim hiện trạng ở ca `[G1: Manager Q-A]`.
>
> **Q-B — Fallback editor = `APP_IPHONE_67` + D2 ⇒ ảnh 6.5" không thả được vào locale chưa có set iPhone.**
> Hôm nay editor đẩy ảnh 6.5" vào set 6.7" mới (ĐÃ ĐO; đây là một phần của "mismatch"). Sau D2 + D5, set 6.7" chỉ nhận Dynamic Island (large). Muốn ảnh 6.5" thì đi bulk (tự vào 65), hoặc chờ `[CPP-editor-add-second-set]`. Cùng hành vi với iPad (fallback 13" chỉ nhận 13").
> Đề xuất **chấp nhận**.
>
> **Q-C — Label display type iPhone.**
> Đề xuất dùng tên nhóm của Apple: `iPhone Dynamic Island (large)` · `iPhone Face ID (large)` · `iPhone Dynamic Island (medium)` · `iPhone Face ID (medium)` · `iPhone Home Button (large)` · `iPhone Home Button (medium)` · `iPhone Home Button (4")` · `iPhone Home Button (3.5")`.
> Label hôm nay (`iPhone 6.7"`, …) đổi theo; xuất hiện ở Preview, editor, `CppDetailPanel`.
>
> **Q-D — Câu chữ (UI tiếng Anh, như hiện tại).**
> - **Duo (D6):** `1398×2034 is an iPhone Duo screenshot size — iPhone Duo is not supported by the App Store Connect API yet; upload it manually on App Store Connect.`
> - **Cảnh báo (D3):** `No required iPhone screenshots — Apple requires Dynamic Island (large) or Face ID (large) screenshots for apps that run on iPhone. Import is not blocked.`
> - **Sai cỡ trong `iphone/`:** cùng khuôn §4.3 của iPad, liệt kê 8 nhóm, kèm gợi ý D8 khi là ảnh iPad.

---

## §G0 — ghim hiện trạng iPhone (2026-11-13, chưa đổi hành vi)

Kỳ vọng viết TAY. Không sửa một ký tự nào của test iPad: harness hai dialog được **chép** sang fixture mới `components/cpp/__fixtures__/bulk-dialog-harness.tsx`; test iPad giữ bản của nó.

- **`lib/cpp/iphone-screenshot-sizes.baseline.test.ts`** (85 test, jsdom, `Image` giả):
  - 4 cỡ Face ID (large) ⇒ OK — parity, phải giữ.
  - **[G1 FLIPS]** 32 cỡ còn lại (kể cả Duo) ⇒ REJECT ở `iphone/`.
  - 36 cỡ ⇒ REJECT ở `ipad/` — giữ.
  - **[G1 FLIPS]** editor: 7 type iPhone đều nhận 1284×2778 và từ chối 1290×2796.
  - Câu lỗi nguyên văn: **[G1 FLIPS]** ảnh 1179×2556 / ảnh iPad trong `iphone/`; gợi ý `ipad/` cho ảnh 6.5" (giữ); **[G1: Q-A]** ảnh 1179×2556 trong `ipad/` hôm nay không có gợi ý.
- **`components/cpp/iphone-screenshot-routing.baseline.test.tsx`** (19 test). Routing `describe.each` qua **cả hai dialog**, parser + validator thật, chỉ giả `fetch`:

| # | Kịch bản | Dãy request ghim | G1 |
|---|---|---|---|
| I1 | chưa có set iPhone, 2 ảnh 6.5" | POST `APP_IPHONE_65` ⇒ 2 upload, theo thứ tự tên file | giữ |
| I2 | có set 65 | dùng lại, không POST | giữ |
| I3 | có set 67 | ảnh 6.5" vào **set 67** | **lật** |
| I4 | có set 65 rồi 67 | set iPhone **cuối** (67) thắng | **lật** |
| I5 | set của chính locale (ja 67) vs locale ready (en 65) | set của locale thắng | **lật** |
| I6 | locale mới, locale ready có set 67 | POST **`APP_IPHONE_67`** cho ảnh 6.5" | **lật** |
| I7 | ảnh 1290×2796 | bị chặn, không gửi gì | **lật** |
| I8 | (chỉ dialog nhiều CPP) CPP mới tinh | POST `APP_IPHONE_65` trên localization tạo cùng CPP | giữ |

  - **Editor (component thật):**
    - **[G1 FLIPS]** locale chưa có set iPhone ⇒ fallback nhận ảnh 6.5", upload POST `APP_IPHONE_67`;
    - **[G1 FLIPS]** set 67 có sẵn từ chối 1290×2796;
    - set 65 nhận ảnh 6.5" (giữ).
  - **[G1 FLIPS] `[CPP-iphone-default-mismatch]`:** cùng ảnh 6.5", locale chưa có set ⇒ bulk `APP_IPHONE_65`, editor `APP_IPHONE_67`.

- **Mutation 11/11 đỏ** (`scripts/mutate.sh`, md5 trước = sau, `status` sạch):

| # | Mutation | Đỏ |
|---|---|---|
| 1 | thêm 1290×2796 vào bảng iPhone | 13 |
| 2 | bỏ 1242×2688 | 11 |
| 3 | mặc định dialog nhiều CPP → 67 | 2 |
| 4 | mặc định dialog một CPP → 67 | 2 |
| 5 | fallback editor → 65 | 2 |
| 6 | dialog một CPP bỏ dò set iPhone theo locale | 1 |
| 7 | dialog nhiều CPP bỏ dò type của locale ready | 1 |
| 8 | set iPhone ĐẦU thắng | 1 |
| 9 | đổi câu lỗi iPhone | 2 |
| 10 | gợi ý `ipad/` mở rộng sang 1179×2556 | 1 |
| 11 | editor kiểm iPhone theo set đích | 3 |

- **Gauntlet:** xem commit G0.

## G1 — kế hoạch (sau gate G0, theo D1–D9)

- **Bảng spec:**
  - `IPHONE_SCREENSHOT_SPECS` — 8 type × kích thước × label × `source: "Apple docs via Manager 2026-11-13"`.
  - `IPHONE_DUO_SIZES` riêng (từ chối, câu D6).
  - `IPHONE_REQUIRED_DISPLAY_TYPES = [67, 65]`; mặc định iPhone = `APP_IPHONE_67` (D5).
  - Thêm `APP_IPHONE_58` vào union `types/asc.ts`.
- **`checkScreenshot`:** trả `displayType` cho cả iPhone. Hai dialog gom ảnh iPhone theo type (như iPad) và bỏ `iphoneSS` / `cppIphoneSS` / `DEFAULT_IPHONE_SCREENSHOT`. Preview video giữ `cppIphonePV`.
- **`checkIpadGroups` → tổng quát hoá** cho cả hai thiết bị: giới hạn 10 (D7) + cảnh báo thiếu set bắt buộc (D3: 13" cho iPad; 67 hoặc 65 cho iPhone).
- **Editor:** kiểm theo set đích (D2); fallback lấy từ bảng.
- **Preview:** mỗi type một dòng; câu lỗi kèm gợi ý D8; Q-A theo quyết định ở gate.
- **Test:**
  - test iPad xanh, KHÔNG sửa;
  - bảng 36 dòng viết tay;
  - twin hai dialog;
  - editor theo set đích;
  - mọi ca `[G1 FLIPS]` lật có khai ("was: …").
- **Mutation:** bỏ một kích thước mới · map sai type · đổi type của cỡ 6.5" · iPhone đi luật cũ · bỏ cảnh báo D3 · đổi hành vi iPad.
- **Bộ UAT iPhone + hướng dẫn tiếng Việt** (§C4).
