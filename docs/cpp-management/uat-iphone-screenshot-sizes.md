# UAT — kích thước screenshot iPhone mới (Bulk Import CPP)

**Arc:** `[CPP-bulkimport-iphone-screenshot-sizes]` · **Khi nào:** ngay sau khi Railway deploy G1.
**Vì sao có UAT này (Manager D9):**
- Kích thước của từng nhóm màn hình lấy **theo tài liệu Apple** (Manager cung cấp 2026-11-13).
- **Nhóm → display type là SUY LUẬN:** 8 nhóm ghép với 8 giá trị `APP_IPHONE_*` của OAS 4.4.1 theo thứ tự cỡ màn hình. OAS không khai kích thước pixel nào.
- Tool chưa đọc trạng thái xử lý ảnh của Apple (BACKLOG `[CPP-asset-delivery-state-unread]`).
- ⇒ **UAT này là lớp chặn duy nhất**: nếu một nhóm bị map sai, nó chỉ lộ ra ở đây.

> ### ⚠ Face ID (medium) → `APP_IPHONE_58` là SUY LUẬN THEO LOẠI TRỪ
> Đây là dòng kém chắc nhất của bảng. Tên enum là "58" nhưng nhóm này có cả 1170×2532 (màn 6.1"). Ứng viên thay thế: `APP_IPHONE_61`.
> **Kiểm thật kỹ 6 ảnh `15` → `20`** ở Bước 4 và Bước 5:
> 1170×2532 · 2532×1170 · 1125×2436 · 2436×1125 · 1080×2340 · 2340×1080
> - nằm **chung một ô**, đúng ô của chữ `FACE ID (MEDIUM)` / `API: APP_IPHONE_58` in trên ảnh;
> - cả 6 có `assetDeliveryState.state` = **`COMPLETE`**.
>
> Sai ⇒ sửa **một dòng** bảng spec (xem "Nếu có ảnh sai ô"), hotfix. Nếu ứng viên `APP_IPHONE_61` đúng thì hai nhóm medium sẽ **dùng chung** `APP_IPHONE_61`. Bảng spec chịu được việc này: code gom thành **một** set, mỗi ảnh upload **một lần**. Đã đo bằng probe trên code G1 với hotfix áp tạm (design §G1).

**iPhone Duo không upload được:** OAS 4.4.1 không có display type nào cho Duo (Manager D6). Tool chặn ảnh Duo với câu riêng. Theo dõi ở BACKLOG `[CPP-iphone-duo-screenshots]` (hạn Apple 04/2027).

**Bộ ảnh:** `docs/cpp-management/uat-iphone-screenshot-sizes/`
- PNG RGB, không alpha, 72 dpi.
- Mỗi ảnh in sẵn 3 dòng: kích thước, **tên nhóm Apple** (vd `FACE ID (MEDIUM)`) và **display type phải vào** (vd `API: APP_IPHONE_58`), để nhận ra ngay trên ASC.
- Mỗi nhóm một màu nền.
- Sinh lại: `python3 -I scripts/uat/gen-iphone-screenshot-kit.py`.

| Bộ | Thư mục để chọn trong tool | Nội dung | Dùng để |
|---|---|---|---|
| **C** | `C-warning/` | 2 ảnh, chỉ nhóm Dynamic Island (medium) | Xem cảnh báo thiếu ảnh iPhone bắt buộc — **không import** |
| **B** | `B-blocked/` | 3 ảnh: 1 Duo, 1 iPad 13", 1 sai cỡ 1200×2400 | Xem tool **chặn** cả 3 — **không import** |
| **A** | `A-import/` | 32 ảnh, mỗi kích thước iPhone một ảnh (8 nhóm) | **Import thật**, rồi kiểm trên ASC |

Cả ba bộ có cùng cấu trúc `<bộ>/UAT iPhone Sizes/en-US/screenshots/iphone/…`, trong đó `UAT iPhone Sizes` = tên CPP, `en-US` = locale.

---

## Chuẩn bị (2 phút)

1. Chọn **app thử nghiệm** trong tool (không dùng app đang bán).
2. **Tên CPP:**
   - Tool tìm CPP theo tên thư mục `UAT iPhone Sizes` (không phân biệt hoa thường).
   - Chưa có CPP tên đó ⇒ tool **tạo CPP mới** tên đó trên app thử nghiệm. Như vậy là được.
   - Muốn dùng CPP thử có sẵn ⇒ đổi tên thư mục `UAT iPhone Sizes` (trong cả 3 bộ) thành đúng tên CPP đó. Locale đó của CPP **phải chưa có set iPhone nào — kể cả set rỗng** (mọi loại), vì 3 lý do:
     - ảnh có sẵn được cộng vào giới hạn 10 ảnh mỗi loại ⇒ có thể chặn bộ A;
     - số ảnh ở bước 4 sẽ lệch;
     - set 67 / 65 có sẵn, **kể cả rỗng** (vd còn lại sau một lần upload bị ngắt), sẽ tắt cảnh báo của bộ C.
     CPP cũng phải có version **chưa submit** (còn sửa được). Không chắc ⇒ dùng tên CPP mới.
3. **Locale:** app thử phải có `en-US`. Nếu không, tool sẽ **thêm `en-US` vào trang store của app** trước khi import (Preview ghi `Not supported by app`, dòng dưới cùng thêm `(1 locale will be added to app first)`). Muốn tránh việc này ⇒ đổi tên thư mục `en-US` (trong cả 3 bộ) thành một locale app đã có.
4. **Bình thường, không phải lỗi:** bộ ảnh không có `primary-locale.txt`. Vì vậy Preview của cả 3 bộ sẽ hiện:
   - banner vàng `No primary-locale.txt found in root folder — using first supported locale as fallback for each new CPP.`;
   - `⚠ fallback locale` trên dòng CPP;
   - `(fallback)` sau locale chính.
   Locale chính vẫn là `en-US` (locale duy nhất trong bộ).
5. Làm **đúng thứ tự C → B → A**. Vì sao:
   - Cảnh báo của C chỉ hiện khi locale **chưa có set** Dynamic Island (large) (`APP_IPHONE_67`) hoặc Face ID (large) (`APP_IPHONE_65`) trên Apple.
   - Bộ A tạo cả hai set đó ⇒ sau A, chạy lại C sẽ **không** thấy cảnh báo nữa.
   - ⇒ Dùng một CPP / locale **mới**. Muốn chạy lại C sau A thì cần CPP mới (đổi tên thư mục CPP).

---

## Bước 1 — Bộ C: cảnh báo thiếu ảnh iPhone bắt buộc (không import)

1. App thử ▸ **Bulk Import** (nhiều CPP) ▸ chọn thư mục `C-warning`.
2. Ở Preview, kiểm:
   - [ ] Dòng dưới cùng có: **`· 1 locale without required iPhone screenshots`** (màu cam).
   - [ ] Mở CPP ▸ mở locale: dưới `Screenshots` có đúng 1 dòng:
     `iPhone Dynamic Island (medium): 01-di-medium-only-1179x2556.png, 02-di-medium-only-1206x2622.png`
   - [ ] Khung cam **`Iphone — Warnings`** với đúng câu (không có tên file phía trước). Code ghi `iphone — warnings`; class CSS `capitalize` viết hoa chữ cái đầu của **mỗi từ**.
     `No required iPhone screenshots — Apple requires Dynamic Island (large) or Face ID (large) screenshots for apps that run on iPhone. Import is not blocked.`
   - [ ] Không có khung đỏ `Iphone — Errors`.
   - [ ] Nút **Import All** vẫn bấm được (cảnh báo không khoá).
3. **Đóng dialog, KHÔNG import.**

Với CPP / locale **mới** (hoặc locale có sẵn nhưng **không có set iPhone nào, kể cả set rỗng**), cảnh báo **phải** hiện. Không thấy ⇒ Bước 1 **SAI**, ghi lại. Trước khi ghi SAI với CPP dùng lại, kiểm ở CPP Editor rằng tab iPhone của locale không có khối set nào.
(Nhánh "không đọc được set có sẵn ⇒ bỏ qua cảnh báo thay vì đoán" chỉ áp cho locale **đã có** trên Apple.)

## Bước 2 — Bộ B: 3 ảnh bị chặn (không import)

1. **Bulk Import** ▸ chọn thư mục `B-blocked`.
2. Ở Preview, kiểm:
   - [ ] Dòng dưới cùng: **`· 1 CPP blocked (invalid assets)`** (màu đỏ).
   - [ ] Dòng CPP và dòng locale có **`❌ invalid assets`**.
   - [ ] Nút **Import All** bị mờ, không bấm được.
   - [ ] Mở CPP ▸ mở locale ▸ dưới `Screenshots` **không có** dòng nhóm nào (cả 3 ảnh bị loại).
   - [ ] Khung đỏ **`Iphone — Errors`**, đúng 3 câu theo thứ tự, mỗi câu bắt đầu bằng `<tên file>: `:
     1. Duo — nguyên văn:
        `97-DUO-1398x2034.png: 1398×2034 is an iPhone Duo screenshot size — iPhone Duo is not supported by the App Store Connect API yet; upload it manually on App Store Connect.`
     2. Ảnh iPad trong `iphone/` — có gợi ý chuyển thư mục:
        `98-IPAD-2064x2752.png: 2064×2752 is not a valid iPhone screenshot size — this looks like an iPad screenshot; move it to screenshots/ipad/. Valid iPhone sizes — Dynamic Island (large): 1260×2736, … · Home Button (3.5"): 640×920, 640×960, 960×600, 960×640`
     3. Sai cỡ — **không** có gợi ý:
        `99-WRONG-1200x2400.png: 1200×2400 is not a valid iPhone screenshot size. Valid iPhone sizes — Dynamic Island (large): 1260×2736, … · Home Button (3.5"): 640×920, 640×960, 960×600, 960×640`
   - [ ] Không có khung cam `Iphone — Warnings`.
3. **Đóng dialog, KHÔNG import.**

Phần `Valid iPhone sizes — …` đầy đủ (giống nhau ở câu 2 và 3):

```
Valid iPhone sizes — Dynamic Island (large): 1260×2736, 2736×1260, 1290×2796, 2796×1290, 1320×2868, 2868×1320 · Face ID (large): 1284×2778, 2778×1284, 1242×2688, 2688×1242 · Dynamic Island (medium): 1179×2556, 2556×1179, 1206×2622, 2622×1206 · Face ID (medium): 1170×2532, 2532×1170, 1125×2436, 2436×1125, 1080×2340, 2340×1080 · Home Button (large): 1242×2208, 2208×1242 · Home Button (medium): 750×1334, 1334×750 · Home Button (4"): 640×1096, 640×1136, 1136×600, 1136×640 · Home Button (3.5"): 640×920, 640×960, 960×600, 960×640
```

## Bước 3 — Bộ A: import 32 ảnh

1. **Bulk Import** ▸ chọn thư mục `A-import`.
2. Ở Preview, mở CPP ▸ mở locale. Dòng locale ghi `32 shots`. Dưới `Screenshots` có đúng 8 dòng, mỗi loại màn hình một dòng, theo thứ tự:
   - [ ] `iPhone Dynamic Island (large): 01-… … 06-…` (6 ảnh)
   - [ ] `iPhone Face ID (large): 07-… … 10-…` (4 ảnh)
   - [ ] `iPhone Dynamic Island (medium): 11-… … 14-…` (4 ảnh)
   - [ ] `iPhone Face ID (medium): 15-… … 20-…` (6 ảnh)
   - [ ] `iPhone Home Button (large): 21-…, 22-…` (2 ảnh)
   - [ ] `iPhone Home Button (medium): 23-…, 24-…` (2 ảnh)
   - [ ] `iPhone Home Button (4"): 25-… … 28-…` (4 ảnh)
   - [ ] `iPhone Home Button (3.5"): 29-… … 32-…` (4 ảnh)
   - [ ] Không có khung đỏ `Iphone — Errors`, không có khung cam `Iphone — Warnings`. Dòng dưới cùng không có `blocked` hay `without required iPhone screenshots`.
3. Bấm **Import All** ⇒ chờ:
   - **`Done — 1 succeeded`** ở **phần đầu** dialog, dưới tiêu đề `CPP Bulk Import`;
   - **`1 CPP imported`** ở dòng dưới cùng.
   - Có `failed` ⇒ chép nguyên dòng lỗi đỏ dưới CPP / locale.

## Bước 4 — Kiểm trên App Store Connect (bước quan trọng nhất)

Đợi vài phút để Apple xử lý ảnh, rồi mở **App Store Connect** ▸ app thử ▸ **Custom Product Pages** ▸ `UAT iPhone Sizes` ▸ locale `en-US` ▸ phần iPhone ▸ mở danh sách đủ loại màn hình (ASC ghi kiểu "View All Sizes in Media Manager" — tên nút có thể khác).

**ASC gọi tên các ô iPhone thế nào** (tên nhóm như "Dynamic Island", hay cỡ inch như 6.9" / 6.5" / 6.1"…) là **CHƯA BIẾT**. Vì vậy:
- đối chiếu bằng **chữ in trên ảnh** (tên nhóm + `API: …`), không bằng tên ô;
- bước 5 (DevTools) là chỗ đọc display type chắc chắn.

| Nhóm Apple (nhãn trong tool) | Display type (API) | Phải có (theo thứ tự) | Số ảnh |
|---|---|---|---|
| Dynamic Island (large) — `iPhone Dynamic Island (large)` | `APP_IPHONE_67` | `01` 1260×2736 · `02` 2736×1260 · `03` 1290×2796 · `04` 2796×1290 · `05` 1320×2868 · `06` 2868×1320 | 6 |
| Face ID (large) — `iPhone Face ID (large)` | `APP_IPHONE_65` | `07` 1284×2778 · `08` 2778×1284 · `09` 1242×2688 · `10` 2688×1242 | 4 |
| Dynamic Island (medium) — `iPhone Dynamic Island (medium)` | `APP_IPHONE_61` | `11` 1179×2556 · `12` 2556×1179 · `13` 1206×2622 · `14` 2622×1206 | 4 |
| ⚠ Face ID (medium) — `iPhone Face ID (medium)` | `APP_IPHONE_58` (**suy luận theo loại trừ**) | `15` 1170×2532 · `16` 2532×1170 · `17` 1125×2436 · `18` 2436×1125 · `19` 1080×2340 · `20` 2340×1080 | 6 |
| Home Button (large) — `iPhone Home Button (large)` | `APP_IPHONE_55` | `21` 1242×2208 · `22` 2208×1242 | 2 |
| Home Button (medium) — `iPhone Home Button (medium)` | `APP_IPHONE_47` | `23` 750×1334 · `24` 1334×750 | 2 |
| Home Button (4") — `iPhone Home Button (4")` | `APP_IPHONE_40` | `25` 640×1096 · `26` 640×1136 · `27` 1136×600 · `28` 1136×640 | 4 |
| Home Button (3.5") — `iPhone Home Button (3.5")` | `APP_IPHONE_35` | `29` 640×920 · `30` 640×960 · `31` 960×600 · `32` 960×640 | 4 |

> **⚠ Face ID (medium) → `APP_IPHONE_58` là SUY LUẬN THEO LOẠI TRỪ.** Kiểm riêng `15` → `20` (1170×2532 · 2532×1170 · 1125×2436 · 2436×1125 · 1080×2340 · 2340×1080): cùng một ô, không lẫn với ô Dynamic Island (medium) (`11` → `14`), và ở bước 5 cả 6 ảnh `COMPLETE` trong set `APP_IPHONE_58`.

Kiểm từng ô:
- [ ] 8 ô iPhone có ảnh. Mỗi ô chỉ chứa ảnh có **cùng** tên nhóm + `API: …` in trên ảnh (không ô nào trộn hai nhóm).
- [ ] Đủ số ảnh như bảng, đúng thứ tự số file tăng dần.
- [ ] **Không ảnh nào** báo lỗi xử lý (biểu tượng cảnh báo, ảnh trống / xám, chữ kiểu "processing failed").
- [ ] Ghi lại ASC gọi tên từng ô là gì (để điền vào design, thay cho CHƯA BIẾT ở trên).

Thêm (không bắt buộc): trong tool, mở CPP Editor ▸ locale `en-US` ▸ tab **iPhone**. Mỗi set một khối có nhãn (vd `iPhone Face ID (medium)`) và `Current (N)`, với N khớp cột "Số ảnh". Thứ tự các khối theo thứ tự Apple trả về.

## Bước 5 (BẮT BUỘC với iPhone, 2 phút) — đọc display type + trạng thái xử lý của Apple bằng DevTools

Tool chưa tự hiện trạng thái này, nhưng có sẵn trong dữ liệu tool đã đọc. Với iPhone, đây là cách duy nhất đọc chắc display type của từng ô (vì tên ô trên ASC là CHƯA BIẾT).

1. Trong tool, mở CPP `UAT iPhone Sizes` (CPP Editor) ▸ mở DevTools ▸ tab **Network** ▸ lọc `screenshot-sets`.
2. Mở locale `en-US` ▸ chọn request `screenshot-sets?localizationId=…` ▸ **Response**.
3. Kiểm:
   - [ ] Trong `data[]`, các `attributes.screenshotDisplayType` có **đủ 8**: `APP_IPHONE_67`, `APP_IPHONE_65`, `APP_IPHONE_61`, `APP_IPHONE_58`, `APP_IPHONE_55`, `APP_IPHONE_47`, `APP_IPHONE_40`, `APP_IPHONE_35` (mỗi loại một set).
   - [ ] Trong `included[]`, **cả 32** ảnh có `attributes.assetDeliveryState.state` = **`COMPLETE`**. Có ảnh `FAILED` ⇒ chép nguyên `errors[]` của ảnh đó.
   - [ ] `attributes.imageAsset.width` / `height` của mỗi ảnh khớp tên file.
   - [ ] **Ảnh nào ở set nào:** ảnh trong `included[]` không trỏ ngược về set của nó. Lấy danh sách id ở `data[]` ▸ set ▸ `relationships.appScreenshots.data`, rồi tìm id đó trong `included[]` ▸ `attributes.fileName`. Ít nhất làm cho set `APP_IPHONE_58`: phải đúng 6 file `15-faceid-medium-…` → `20-faceid-medium-…`.

---

## Nếu có ảnh sai ô hoặc lỗi xử lý

Gửi lại: tên file · ô thực tế trên ASC · display type của set chứa nó (bước 5) · `assetDeliveryState` + `errors[]` · ảnh chụp màn hình.

**Cách sửa: đúng MỘT dòng** trong `lib/cpp/screenshot-specs.ts` (`IPHONE_SCREENSHOT_SPECS`), tức là dòng của nhóm sai:
- Đổi `displayType` của nhóm đó, hoặc chuyển / bỏ kích thước Apple không nhận.
- **Face ID (medium) → ứng viên `APP_IPHONE_61`** (type mà Dynamic Island (medium) đang dùng):
  - Hai dòng **được phép** dùng chung một type. Code gom thành **một** set `APP_IPHONE_61`, editor nhận kích thước của cả hai nhóm, nhãn hiển thị là nhãn dòng đầu (`iPhone Dynamic Island (medium)`). Đã đo bằng probe, xem design §G1.
  - Khi đó set 61 của bộ A sẽ có **10 ảnh** (`11` → `20`), vừa đủ giới hạn 10.
  - Set `APP_IPHONE_58` cũ (do lần UAT đầu tạo ra) sẽ hiện tên thô `APP_IPHONE_58` trong editor ⇒ xoá set / ảnh đó trên ASC.
- Sửa các test ghim mapping cũ, mỗi ca lật kèm ghi chú "was: …" (KHÔNG xoá test). Với hotfix Face ID (medium) → `APP_IPHONE_61`, danh sách **đã đo** (áp hotfix tạm qua `scripts/mutate.sh`, 2026-11-13) là **31 test trong 6 file**, không có file iPad nào:
  - `lib/cpp/iphone-screenshot-specs.test.ts` (12):
    - 6 dòng Face ID (medium) của bảng;
    - `sizes … APP_IPHONE_58` và `… APP_IPHONE_61` (61 nay nhận cả 10 kích thước của hai nhóm, 58 rỗng);
    - 2 câu editor (`… Face ID (medium) image on the Dynamic Island (medium) set` thành **nhận**; `the right image on its set`);
    - nhãn Q-C (`APP_IPHONE_58` không còn nhãn);
    - ca "every one of the 13 … display types … has a label" (bỏ `APP_IPHONE_58` khỏi danh sách đó).
  - `lib/cpp/uat-iphone-kit.test.ts` (7): ảnh `15` → `20` và ca "Preview of the whole kit".
  - `lib/cpp/screenshot-upload.iphone.test.ts` (2): thứ tự nhóm, câu "Too many … Face ID (medium)" (nhãn nay là `iPhone Dynamic Island (medium)`).
  - `components/cpp/iphone-screenshot-routing.test.tsx` (7): thư mục trộn, "one image per group" (7 set thay vì 8), Preview, twin.
  - `components/cpp/LocalizationManager.iphone-target.test.tsx` (3): 3 ca dùng set `APP_IPHONE_58`.
- Khi đổi display type: chữ `API: …` in trên ảnh bộ A thành cũ. ⇒ Sửa nhóm đó trong `scripts/uat/gen-iphone-screenshot-kit.py` + trong `SLOT_BY_GROUP` của `lib/cpp/uat-iphone-kit.test.ts` (một test ràng hai chỗ này với nhau), rồi sinh lại bộ ảnh.
- Mặc định (D5) và loại bắt buộc (D3) **đi theo dòng** của bảng (lấy theo tên nhóm), không cần sửa tay khi hotfix dòng Dynamic Island (large) / Face ID (large).
- **Chạy lại UAT sau hotfix trên một CPP MỚI** (đổi tên thư mục `UAT iPhone Sizes` trong cả 3 bộ), hoặc xoá hết ảnh iPhone của locale đó trước. Nếu không, ảnh có sẵn cộng vào giới hạn 10 sẽ chặn bộ A (vd Dynamic Island (large) 6 + 6 = 12). Con số "set 61 có 10 ảnh" ở trên chỉ đúng với locale trống. Sau hotfix 58→61, Bước 3 hiện **7** dòng, Bước 5 có **7** display type.
- Gauntlet ⇒ hotfix.

Cùng luật cho mọi dòng khác.

## Dọn dẹp

- Không submit CPP thử.
- Có thể xoá CPP `UAT iPhone Sizes` (hoặc chỉ xoá ảnh) sau khi xong.
- Nếu tool đã thêm `en-US` vào app thử (xem Chuẩn bị, bước 3): giữ hay xoá tuỳ Manager.

## Ghi kết quả

Ghi vào design `docs/cpp-management/design-cpp-bulkimport-iphone-screenshot-sizes.md` §UAT-kết quả:
- ngày, app/CPP thử;
- bước 1–3: ĐẠT / SAI (kèm câu chữ thực tế nếu khác);
- từng nhóm ở bước 4: ĐẠT / SAI (kèm chi tiết) + tên ô ASC hiển thị;
- kết quả bước 5, nhất là set `APP_IPHONE_58`.

Khi ĐẠT hết: đổi `source` của 8 dòng `IPHONE_SCREENSHOT_SPECS` (hiện `"Apple docs via Manager 2026-11-13 — map → display type SUY LUẬN, chờ UAT iPhone"`, và với Face ID (medium) là câu `… SUY LUẬN THEO LOẠI TRỪ …`) thành `"ĐÃ ĐO qua UAT <ngày> (đường code thật, <commit>)"`, như bảng iPad.

Sinh lại bộ ảnh: `python3 -I scripts/uat/gen-iphone-screenshot-kit.py` (rồi `npx vitest run lib/cpp/uat-iphone-kit.test.ts`).
