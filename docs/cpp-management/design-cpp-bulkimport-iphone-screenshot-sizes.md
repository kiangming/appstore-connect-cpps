# [CPP-bulkimport-iphone-screenshot-sizes] Bulk Import CPP — screenshot iPhone theo danh sách kích thước Apple mới nhất — census + G0

**Trạng thái:** census PASS (`20d7822`) · G0 PASS (`3d65f57`) · Manager chốt Q-A..Q-D (§P-chốt) · **G1 đang làm** (§G1).
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

## §P-chốt — Gate G0 PASS + Manager quyết Q-A..Q-D (2026-11-13)

**Gate G0:** PASS (`20d7822` census, `3d65f57` G0).

- **Q-A = CÓ.** Gợi ý "looks like an iPhone screenshot" trong `ipad/` dùng bảng iPhone mới (32 kích thước của 8 nhóm). Hành vi chặn/nhận iPad không đổi. Test iPad xanh không sửa, chỉ lật ca `[G1: Q-A]` đã ghim.
- **Q-B = CHẤP NHẬN.** Fallback của editor lấy từ bảng (Dynamic Island (large) = `APP_IPHONE_67`) và chỉ nhận đúng kích thước nhóm đó. Ảnh 6.5" vào locale chưa có set iPhone ⇒ đi bulk. Ghi user guide.
- **Q-C = label theo tên nhóm Apple:** `iPhone Dynamic Island (large)` · `iPhone Face ID (large)` · `iPhone Dynamic Island (medium)` · `iPhone Face ID (medium)` · `iPhone Home Button (large)` · `iPhone Home Button (medium)` · `iPhone Home Button (4")` · `iPhone Home Button (3.5")`. Áp ở Preview, editor, `CppDetailPanel`.
- **Q-D = DUYỆT nguyên văn:** câu Duo, câu cảnh báo D3, câu sai cỡ theo khuôn §4.3 kèm gợi ý D8.
- **Bộ UAT iPhone:**
  - 32 kích thước, in chữ lên ảnh;
  - bộ phụ: Duo, sai cỡ, ảnh iPad trong `iphone/`, chỉ Dynamic Island (medium);
  - hướng dẫn tiếng Việt, đi từ bộ không import tới bộ import thật;
  - ⚠ ghi nổi bật: Face ID (medium) → `APP_IPHONE_58` là SUY LUẬN THEO LOẠI TRỪ (ứng viên thay thế `APP_IPHONE_61`).
- `APP_IPHONE_58` thêm vào union ⇒ đóng phần iPhone của `[CPP-types-asc-gaps]`.

## §G1 — thực hiện (2026-11-13)

**Đã làm (theo D1–D9 + Q-A..Q-D):**
- **`lib/cpp/screenshot-specs.ts`:**
  - `IPHONE_SCREENSHOT_SPECS`: 8 nhóm × kích thước × label Q-C × `source` (`"Apple docs via Manager 2026-11-13 — map → display type SUY LUẬN, chờ UAT iPhone"`; Face ID (medium): `… APP_IPHONE_58 SUY LUẬN THEO LOẠI TRỪ (ứng viên thay thế: APP_IPHONE_61) …`).
  - `IPHONE_DUO_SIZES` bị từ chối với câu Q-D.
  - `IPHONE_DEFAULT_DISPLAY_TYPE` (D5) và `IPHONE_REQUIRED_DISPLAY_TYPES` (D3) **lấy từ dòng** của bảng theo tên nhóm. Thiếu dòng ⇒ ném lỗi lúc nạp module (không có hằng cũ âm thầm).
  - `classifyScreenshot` cho cả hai thiết bị.
  - `screenshotSizeError`: câu §4.3 cho `iphone/` + gợi ý D8; gợi ý Q-A trong `ipad/` dùng đủ 32 kích thước iPhone, không gồm Duo; câu iPad không đổi.
  - Editor theo set đích cho iPhone (D2); ảnh thuộc set iPhone khác ⇒ câu nêu tên nhóm thật.
- **Merge-safe** (thêm sau soát UAT, xem dưới): hai dòng được dùng chung một display type ⇒ một set (`groupBySpecs`), kích thước hợp nhất (`sizesOfTypeIn`), nhãn dòng đầu (`labelsOf`).
- **`types/asc.ts`:** thêm `APP_IPHONE_58`.
- **`lib/asset-validator.ts`:** `checkScreenshot` trả `displayType` cho iPhone.
- **`lib/cpp/screenshot-upload.ts`:**
  - `groupScreenshots(device, …)`;
  - `checkScreenshotGroups(device, …)`: tối đa 10 mỗi type tính cả ảnh có sẵn (D7), cảnh báo thiếu set bắt buộc (iPad 13"; iPhone 67 hoặc 65, câu Q-D);
  - `groupIpadScreenshots` / `checkIpadGroups` giữ nguyên chữ ký + hành vi.
- **Hai dialog:**
  - bỏ `DEFAULT_IPHONE_SCREENSHOT` / `cppIphoneSS` / `iphoneSS`;
  - upload `[...nhóm iPhone, ...nhóm iPad]` qua `uploadScreenshotGroups`;
  - đọc ảnh có sẵn **một lần** mỗi locale, dùng chung cho hai thiết bị;
  - Preview: mỗi loại màn hình một dòng (nhãn Q-C), cảnh báo trong locale + đếm ở footer (`without required iPhone screenshots`);
  - dò type preview của locale ready nay chỉ GET `preview-sets` (GET `screenshot-sets` ở đó không còn dùng) — **Preview video giữ nguyên hành vi** (`cppIphonePV` / `cppIpadPV`);
  - khung "Expected folder structure" thêm dòng iPhone tự phân loại.
- **Editor:** fallback iPhone = `IPHONE_DEFAULT_DISPLAY_TYPE` (Q-B: chỉ nhận Dynamic Island (large)); label từ bảng (`CppDetailPanel` dùng chung `displayTypeLabel`).
- **Bộ UAT iPhone** (agent dựng, agent đối kháng soát, tôi sửa theo soát):
  - `scripts/uat/gen-iphone-screenshot-kit.py`;
  - 37 PNG (A 32 · B 3 · C 2), kiểm bằng `sips` + IHDR;
  - `lib/cpp/uat-iphone-kit.test.ts` (kể cả ràng `GROUPS` của script với `SLOT_BY_GROUP`);
  - hướng dẫn `docs/cpp-management/uat-iphone-screenshot-sizes.md`.
- **Docs:** `user-guide.md` (bảng iPhone, Q-B, câu chữ, chặn/không chặn), `feature-asset-validation.md`, `feature-cpp-editor.md`, `bulk-import-design.md`, `feature-cpp-bulk-import-design.md`, `CURRENT-STATE.md`, `architecture.md`.

**⚠ Khai báo — test của arc iPad bị sửa (trái với câu "test iPad xanh không sửa" ở §P-chốt / kế hoạch):**
- 3 file test của arc iPad chứa **7 ca ghim hành vi iPHONE** ("iPhone unchanged / out of scope"). G0 iPhone đã bỏ sót, không gắn nhãn `[G1 FLIPS]`. D1/D2/Q-C/Q-D bắt buộc lật chúng.
- Đã lật, mỗi ca gắn `[iPhone G1 FLIPPED] … (was: …)`, header mỗi file ghi rõ:

| File | Ca |
|---|---|
| `lib/cpp/screenshot-specs.test.ts` | `APP_IPHONE_67` theo set đích (tách thành ca riêng) · câu `iphone/` + D8 · nhãn iPhone Q-C |
| `lib/asset-validator.screenshot-sizes.test.ts` | `checkScreenshot` iPhone trả `APP_IPHONE_65` · câu `iphone/` + D8 |
| `components/cpp/ipad-screenshot-routing.baseline.test.tsx` | set 67 có sẵn không còn nhận ảnh 6.5" (× 2 dialog) |

- Thêm: 1 tiêu đề ca iPhone ở file routing iPad đổi chữ "iPhone unchanged", thân giữ nguyên.
- **Không một khẳng định iPad nào đổi** (diff từng hunk đã soát).
- Ca `[G1: Q-A]` nằm trong file iPhone (`iphone-screenshot-sizes.baseline.test.ts`), đã lật.

**Lật có chủ đích (file iPhone G0, khai "was: …"):**
- validator:
  - 28 cỡ iPhone REJECT ⇒ OK; 4 cỡ Duo vẫn REJECT với câu Duo;
  - editor: 8 type, mỗi type chỉ nhận nhóm của nó;
  - ảnh 1179×2556 trong `iphone/` ⇒ nhận; ảnh iPad trong `iphone/` ⇒ gợi ý D8;
  - Q-A.
- routing I3–I7 × 2 dialog; editor fallback từ chối ảnh 6.5" (Q-B); set 67 nhận 1290×2796.
- `[CPP-iphone-default-mismatch]` đóng: cùng ảnh Dynamic Island (large) ⇒ bulk và editor cùng `APP_IPHONE_67`; ảnh 6.5" ⇒ bulk 65, editor từ chối.
- I1/I2/I8 và ca "set 6.5" nhận ảnh 6.5"" giữ nguyên thân (tiêu đề `describe` bỏ chữ "today").
- 1 ca mới gắn `[G1 NEW]`.

**Test mới:**

| File | Số ca | Nội dung |
|---|---|---|
| `lib/cpp/iphone-screenshot-specs.test.ts` | 92 | bảng 32 dòng viết tay; Duo; 8 type theo set đích; câu nguyên văn; Q-A 32 cỡ; nhãn; mặc định / bắt buộc + ca "đi theo dòng"; merge-safe |
| `lib/cpp/screenshot-upload.iphone.test.ts` | 13 | thứ tự nhóm; merge-safe; D7; D3 (8 ca, kể cả `null`) |
| `components/cpp/iphone-screenshot-routing.test.tsx` | 27 | 13 ca × 2 dialog + twin có dãy request viết tay |
| `components/cpp/LocalizationManager.iphone-target.test.tsx` | 5 | |
| `lib/cpp/uat-iphone-kit.test.ts` | 42 | |

**Probe merge-safe — ĐÃ ĐO (2026-11-13):**
- Áp tạm hotfix một dòng "Face ID (medium) → `APP_IPHONE_61`" qua `scripts/mutate.sh`, chạy probe qua **dialog thật** (cả hai).
- Ảnh `01-fim-1170x2532`, `02-dim-1179x2556`, `03-fim-1125x2436` ⇒ cả hai dialog: `POST set APP_IPHONE_61` **một lần**, 3 upload, mỗi ảnh một lần, hai dialog cùng dãy.
- `sizesForDisplayType("APP_IPHONE_61")` = 10 kích thước của hai nhóm; `"APP_IPHONE_58"` = []; nhãn 61 = `iPhone Dynamic Island (medium)`, nhãn 58 = tên thô; editor nhận 1170×2532 trên set 61.
- Khôi phục: md5 khớp.
- Trước khi sửa merge-safe, cùng hotfix đó khiến code tạo **hai nhóm cùng type** ⇒ mỗi ảnh upload hai lần (agent soát UAT phát hiện).

**Hotfix 58→61 làm đỏ gì — ĐÃ ĐO:** 31 test trong 6 file, 0 file iPad. Danh sách ghi trong runbook của hướng dẫn UAT.

**Mutation 25/25 đỏ** (`scripts/mutate.sh`, md5 trước = sau từng lần, `status` sạch):

| Nhóm | Mutation (số test đỏ) |
|---|---|
| 8 kiểu Manager | bỏ 1206×2622 (19) · map Face ID (medium) → 55 (27) · 1284×2778 → 67 (42) · luật cũ ở dialog một CPP (12) / nhiều CPP (11) · bỏ cảnh báo D3 (8) · Duo được nhận (17) · editor mặc định 65 (4) |
| đổi hành vi iPad | ưu tiên 12.9" (22) · mất gợi ý iPhone trong `ipad/` (37) · nhóm iPad upload trước (4) · iPad dùng type bắt buộc của iPhone (5) |
| thêm | Q-A về 4 cỡ (29) · bỏ D8 (7) · bỏ giới hạn 10 cho iPhone (6) · editor iPhone không theo set đích (23) · Preview bỏ dòng iPhone, từng dialog (1 / 1) · đổi nhãn Q-C (18) · đổi câu Duo (13) · `checkScreenshot` iPhone không phân loại (41) · bỏ merge-safe: gom nhóm / kích thước / nhãn (1 / 1 / 1) · script UAT in sai type (1) |

- Thêm một kịch bản hai chỗ sửa: hotfix dòng 65→55 nhưng giữ literal 65 ⇒ ca "FOLLOW their rows" đỏ. Đối chứng (lấy từ dòng) ⇒ ca đó xanh.

**Gauntlet G1:** typecheck sạch · 439 file / 6373 test xanh (1 skip có sẵn; G0: 434 / 6190) · lint 0 lỗi · build xanh.

**Review đối kháng** (workflow: 5 góc nhìn ⇒ mỗi phát hiện 3 agent cố bác bỏ, giữ khi ≥ 2/3):
- 24 phát hiện, 15 xác nhận, 9 bị bác.
- Đã sửa trong G1:
  - khai báo test arc iPad + sửa header / tiêu đề;
  - nhãn `[G1 NEW]`;
  - mặc định / bắt buộc lấy từ dòng;
  - hướng dẫn UAT: điều kiện dùng lại CPP (cả set rỗng), runbook hotfix với danh sách đo được, chạy lại UAT trên CPP mới, bản ghi probe;
  - BACKLOG 409 (mức phơi nhiễm tăng) và `[CPP-preview-default-mismatch]`.
- Sửa ở commit riêng **G1c** (chạm hành vi ngoài kế hoạch, để Manager nhận / bỏ riêng):
  - editor giấu video preview khi type video khác type screenshot đầu tiên;
  - dialog nhiều CPP coi "đọc localization của CPP thất bại" là "rỗng đã biết".

## §G1c — hai sửa từ review đối kháng, chạm hành vi ngoài kế hoạch G1 (2026-11-13; commit riêng để Manager nhận / bỏ riêng)

**1. Editor giấu video preview khi type video ≠ type screenshot đầu tiên** (review: major, 3/3 xác nhận).
- **Nguyên nhân:**
  - Screenshot nay theo kích thước, còn video bulk vẫn vào mặc định của thiết bị (`IPHONE_65` / `IPAD_PRO_3GEN_129`, Preview video giữ nguyên theo quyết định Manager).
  - Locale import với ảnh Dynamic Island (large) + 1 video ⇒ set screenshot `APP_IPHONE_67`, set preview `IPHONE_65`.
  - Editor chỉ ghép preview theo type của set screenshot ĐẦU TIÊN (`LocalizationManager.tsx`, `matchedIphonePreview`) ⇒ báo "There's no preview of this device type.". Thả lại video thì tạo set preview thứ hai (`IPHONE_67`).
  - iPad có cùng lỗi từ G1 iPad (`725a11b`).
- **Sửa:** không khớp đúng type ⇒ dùng set preview có sẵn ĐẦU TIÊN của thiết bị. Khớp đúng type vẫn thắng.
- **Hệ quả kèm** (mới, có test): locale chỉ có video, chưa có set screenshot, nay hiện video (trước: trạng thái rỗng).
- **Không đổi:** đường upload video của bulk; fallback type khi locale chưa có set preview nào (`IPHONE_67` / `IPAD_PRO_3GEN_129`) — lệch với bulk, ghi BACKLOG `[CPP-preview-default-mismatch]`.
- **Test** `components/cpp/LocalizationManager.preview-match.test.tsx` (5 ca, viết trước, đỏ trên code G1 rồi xanh): iPhone 67 / 65, iPad 11" / 13", khớp đúng type vẫn thắng, chỉ có video, không có set preview.

**2. Dialog nhiều CPP: đọc localization của CPP có sẵn thất bại ⇒ "chưa biết", không phải "rỗng"** (review: minor, 3/3).
- **Trước:** GET `/api/asc/cpps/{id}` lỗi ⇒ mọi locale `localizationId = null` ⇒ ảnh có sẵn coi là `Map` rỗng ⇒ cảnh báo thiếu set bắt buộc có thể hiện SAI (locale thật ra có set 67 / 13").
- **Sửa:** `existingLocalesKnown` ⇒ khi đọc lỗi, `existingCounts()` = `null` ⇒ không cảnh báo, không đoán (KB P7). Áp cho **cả iPad** (13") — đổi hành vi iPad ở đúng ca lỗi đọc này.
- Dialog một CPP không có lần đọc này (localization đến từ prop).
- **Test** (3 ca trong `iphone-screenshot-routing.test.tsx`): iPhone, iPad, đối chứng đọc thành công.

**Mutation 4/4 đỏ:** bỏ fallback preview iPhone (2) · iPad (1) · preview đầu tiên thắng khớp đúng type (1) · đọc lỗi lại coi là rỗng (2).

## §UAT-kết quả

*(Chưa chạy — Manager điền sau deploy theo `docs/cpp-management/uat-iphone-screenshot-sizes.md` §"Ghi kết quả".)*

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
