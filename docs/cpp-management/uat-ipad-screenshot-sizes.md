# UAT — kích thước screenshot iPad mới (Bulk Import CPP)

**Arc:** `[CPP-bulkimport-ipad-screenshot-sizes]` · **Khi nào:** ngay sau khi Railway deploy G1.
**Vì sao có UAT này:** thay phép đo M2 (Manager chốt Q2, 2026-11-06). Bảng "kích thước → loại màn hình" trong tool là **SUY LUẬN** từ tài liệu Apple. OAS không khai kích thước, và tool chưa đọc trạng thái xử lý ảnh của Apple (BACKLOG `[CPP-asset-delivery-state-unread]`). ⇒ **UAT này là lớp chặn duy nhất**: nếu một kích thước bị map sai, nó chỉ lộ ra ở đây.

**Bộ ảnh:** `docs/cpp-management/uat-ipad-screenshot-sizes/`
- PNG RGB, không alpha, 72 dpi.
- Mỗi ảnh in sẵn kích thước, nhóm màn hình và **ô phải rơi vào** (`SLOT: 11"`…), để nhận ra ngay trên ASC.
- Sinh lại: `python3 -I scripts/uat/gen-ipad-screenshot-kit.py`.

| Bộ | Thư mục để chọn trong tool | Nội dung | Dùng để |
|---|---|---|---|
| **C** | `C-no-13in/` | 1 ảnh 11" | Xem cảnh báo "không có 13"" — **không import** |
| **B** | `B-wrong-size/` | 1 ảnh SAI 1600×2400 | Xem tool **chặn** — **không import** |
| **A** | `A-import/` | 24 ảnh iPad đúng kích thước | **Import thật**, rồi kiểm trên ASC |

Cả ba bộ có cùng cấu trúc `<bộ>/UAT iPad Sizes/en-US/screenshots/ipad/…`, trong đó `UAT iPad Sizes` = tên CPP, `en-US` = locale.

---

## Chuẩn bị (2 phút)

1. Chọn **app thử nghiệm** trong tool (không dùng app đang bán).
2. **Tên CPP:**
   - Tool tìm CPP theo tên thư mục `UAT iPad Sizes` (không phân biệt hoa thường).
   - Chưa có CPP tên đó ⇒ tool **tạo CPP mới** tên đó trên app thử nghiệm. Như vậy là được.
   - Muốn dùng CPP thử có sẵn ⇒ đổi tên thư mục `UAT iPad Sizes` (trong cả 3 bộ) thành đúng tên CPP đó.
3. **Locale:** app thử phải có `en-US`. Nếu không, tool sẽ **thêm `en-US` vào trang store của app** trước khi import. Muốn tránh việc này ⇒ đổi tên thư mục `en-US` thành một locale app đã có.
4. Làm **đúng thứ tự C → B → A**. C phải chạy khi CPP chưa có ảnh 13"; sau A thì đã có, nên cảnh báo sẽ không hiện nữa.

---

## Bước 1 — Bộ C: cảnh báo không có 13" (không import)

1. App thử ▸ **Bulk Import** (nhiều CPP) ▸ chọn thư mục `C-no-13in`.
2. Ở Preview, kiểm:
   - [ ] Dòng dưới cùng có: **`· 1 locale without iPad 13" screenshots`** (màu cam).
   - [ ] Mở CPP ▸ mở locale: thấy `iPad 11": 01-11in-only-1668x2388.png` và khung cam **`ipad — warnings`** với câu: `No iPad 13" screenshots — Apple requires iPad 13" screenshots for apps that run on iPad. Import is not blocked.`
   - [ ] Nút **Import All** vẫn bấm được (cảnh báo không khoá).
3. **Đóng dialog, KHÔNG import.**

## Bước 2 — Bộ B: ảnh sai kích thước bị chặn (không import)

1. **Bulk Import** ▸ chọn thư mục `B-wrong-size`.
2. Ở Preview, kiểm:
   - [ ] Dòng dưới cùng: **`· 1 CPP blocked (invalid assets)`** (màu đỏ).
   - [ ] Nút **Import All** bị mờ, không bấm được.
   - [ ] Mở CPP ▸ mở locale ▸ khung đỏ `ipad — errors`: `99-WRONG-1600x2400.png: 1600×2400 is not a valid iPad screenshot size. Valid iPad sizes — 13": 2064×2752, … · 9.7": …, 1024×768`.
3. **Đóng dialog, KHÔNG import.**

## Bước 3 — Bộ A: import 24 ảnh

1. **Bulk Import** ▸ chọn thư mục `A-import`.
2. Ở Preview, mở CPP ▸ mở locale, kiểm có đúng 4 dòng:
   - [ ] `iPad 13": 01-…, 02-…, 03-…, 04-…`
   - [ ] `iPad 11": 05-… … 14-…` (10 ảnh)
   - [ ] `iPad 10.5": 15-…, 16-…`
   - [ ] `iPad 9.7": 17-… … 24-…` (8 ảnh)
   - [ ] Không có khung đỏ, không có khung cam.
3. Bấm **Import All** ⇒ chờ **`Done — 1 succeeded`**.

## Bước 4 — Kiểm trên App Store Connect (bước quan trọng nhất)

Đợi vài phút để Apple xử lý ảnh, rồi mở **App Store Connect** ▸ app thử ▸ **Custom Product Pages** ▸ `UAT iPad Sizes` ▸ locale `en-US` ▸ phần iPad ▸ mở danh sách đủ loại màn hình (ASC ghi kiểu "View All Sizes in Media Manager" — tên nút có thể khác).

| Ô trên ASC | Phải có (theo thứ tự) | Số ảnh |
|---|---|---|
| **iPad 13"** | `01` 2064×2752 · `02` 2752×2064 · `03` 2048×2732 · `04` 2732×2048 | 4 |
| **iPad 12.9"** | **TRỐNG** — đúng chủ ý: 2048×2732 / 2732×2048 luôn vào 13" (Q1); Apple dùng ảnh 13" thu nhỏ | 0 |
| **iPad 11"** | `05` 1488×2266 · `06` 2266×1488 · `07` 1512×2316 · `08` 2316×1512 · `09` 1668×2420 · `10` 2420×1668 · `11` 1668×2388 · `12` 2388×1668 · `13` 1640×2360 · `14` 2360×1640 | 10 |
| **iPad 10.5"** | `15` 1668×2224 · `16` 2224×1668 | 2 |
| **iPad 9.7"** | `17` 1536×2008 · `18` 1536×2048 · `19` 2048×1496 · `20` 2048×1536 · `21` 768×1004 · `22` 768×1024 · `23` 1024×748 · `24` 1024×768 | 8 |

Kiểm từng ô:
- [ ] Chữ `SLOT: …` in trên mỗi ảnh **trùng** với ô nó đang nằm.
- [ ] Đủ số ảnh như bảng, đúng thứ tự `01 → 24`.
- [ ] **Không ảnh nào** báo lỗi xử lý (biểu tượng cảnh báo, ảnh trống / xám, chữ kiểu "processing failed").

## Bước 5 (khuyên làm, 1 phút) — đọc trạng thái xử lý của Apple bằng DevTools

Tool chưa tự hiện trạng thái này, nhưng có sẵn trong dữ liệu tool đã đọc:

1. Trong tool, mở CPP `UAT iPad Sizes` (CPP Editor) ▸ mở DevTools ▸ tab **Network** ▸ lọc `screenshot-sets`.
2. Mở locale `en-US` ▸ chọn request `screenshot-sets?localizationId=…` ▸ **Response**.
3. Kiểm:
   - [ ] Trong `data[]`, các `attributes.screenshotDisplayType` có: `APP_IPAD_PRO_3GEN_129`, `APP_IPAD_PRO_3GEN_11`, `APP_IPAD_105`, `APP_IPAD_97` (và **không** có `APP_IPAD_PRO_129`).
   - [ ] Trong `included[]`, **cả 24** ảnh có `attributes.assetDeliveryState.state` = **`COMPLETE`**. Có ảnh `FAILED` ⇒ chép nguyên `errors[]` của ảnh đó.
   - [ ] `attributes.imageAsset.width` / `height` của mỗi ảnh khớp tên file.

---

## Nếu có ảnh sai ô hoặc lỗi xử lý

Gửi lại: tên file · ô thực tế trên ASC · `assetDeliveryState` + `errors[]` (bước 5) · ảnh chụp màn hình.

**Cách sửa: đúng MỘT dòng** trong `lib/cpp/screenshot-specs.ts` (`IPAD_SCREENSHOT_SPECS`). Chuyển kích thước đó sang đúng nhóm, hoặc bỏ nó nếu Apple không nhận. Sửa đúng dòng tương ứng trong bảng test viết tay `lib/cpp/screenshot-specs.test.ts`. Gauntlet ⇒ hotfix. Không đổi gì khác.

## Dọn dẹp

- Không submit CPP thử.
- Có thể xoá CPP `UAT iPad Sizes` (hoặc chỉ xoá ảnh) sau khi xong.
- Nếu tool đã thêm `en-US` vào app thử (xem Chuẩn bị, bước 3): giữ hay xoá tuỳ Manager.

## Ghi kết quả

Ghi vào design `docs/cpp-management/design-cpp-bulkimport-ipad-screenshot-sizes.md` §UAT-kết quả:
- ngày, app/CPP thử;
- từng ô: ĐẠT / SAI (kèm chi tiết);
- kết quả bước 5.

Khi ĐẠT hết: đổi `source` của các dòng trong bảng spec từ `"Apple docs via Manager 2026-11-06"` thành `"ĐÃ ĐO UAT <ngày>"`.
