# Import lại file export Matrix view vào Pricing Template (Apple) — CENSUS + KHẢ THI + THIẾT KẾ

**Tag:** `[TEMPLATE-xlsx-reimport]` · **Module:** Apple IAP Management ·
**Trạng thái (2026-10-19):** Manager **đổi ngữ nghĩa** — "file là sự thật duy nhất".
Census lại theo ngữ nghĩa mới ở **LƯỢT 2** ngay dưới đây — đó là phần HIỆN HÀNH; chờ
Manager chốt câu ⛔ ở §L2.6. Chưa code. Phần lượt 1 bên dưới giữ nguyên làm bằng chứng;
mục nào bỏ theo quyết định Manager có đánh dấu **⛔ BỎ theo quyết định Manager
2026-10-19** tại chỗ (không xoá), bảng đối chiếu đầy đủ ở §L2.7.
*(Trạng thái lượt 1, đã thay: "census xong + một vòng phản biện, chờ Manager chốt P7;
thiết kế cần 1 migration — §5.4".)*

> **Yêu cầu Manager.** Trong Settings → Pricing templates (Default pricing / Per-app
> pricing): **format A** = file template dùng để IMPORT; **format B** = file .xlsx
> EXPORT ra từ "Open matrix view". Muốn round-trip: export B → sửa vài ô → import B
> lại vào đúng Default / Per-app đó.
>
> **Ngữ nghĩa đã chốt:** ô Manager KHÔNG đụng giữ nguyên ý nghĩa — ô đang thừa
> hưởng giá Apple vẫn thừa hưởng (vẫn đi theo Apple khi Apple đổi giá), ô đang
> override vẫn override đúng giá cũ. Chỉ ô Manager SỬA mới thành override giá mới.
> **Bài nghiệm thu số một:** export B rồi import lại nguyên trạng ⇒ template KHÔNG
> ĐỔI GÌ.

**Nhãn bằng chứng dùng trong file này**

| Nhãn | Nghĩa |
|---|---|
| **ĐÃ ĐO** | đã chạy thật và thấy output (lệnh/fixture ghi kèm) |
| **ĐỌC CODE** | đọc tại `file:line` |
| **CÓ TRONG SCHEMA** | có trong migration SQL `file:line` |
| **CHƯA BIẾT** | chưa xác lập được — kèm cách đo |

**Census được làm thế nào.**
- **Vòng 1 — census:** 5 lane độc lập (format A · format B · ngữ nghĩa + DB · quy
  tắc KB · độ bền), mỗi lane có **một verifier đối kháng riêng** dò lại từng
  `file:line` và chạy lại từng phép đo. Kết quả: 185 claim; verifier trả 192 phán
  quyết — **161 CONFIRMED · 29 PARTLY** (sai số dòng / nhãn đo quá tay / thiếu chi
  tiết — đã sửa trong file này) **· 2 UNVERIFIABLE · 0 WRONG** — cộng 57 phát hiện
  census bỏ sót (đã gộp vào đây).
- **Vòng 2 — phản biện bản thiết kế:** 4 agent tấn công độc lập (dò lại 131
  citation · phá cơ chế · đối chiếu quy tắc KB · khả thi khi code). Kết quả: 1
  BLOCKER, 18 MAJOR, 31 MINOR. **Cả 19 BLOCKER/MAJOR đã được xử lý trong bản này**,
  đánh dấu ⟲ ở chỗ thiết kế đổi vì phản biện.
- File B mẫu được sinh bằng **chính route POST thật**, chỉ mock 4 seam (session,
  active account, `iapDb` giả lập PostgREST, logger). Độ bền đo trên **Microsoft
  Excel 16.104 và Numbers 14.4 thật** trên máy này, chỉ trên bản sao trong
  scratchpad. Google Sheets: **CHƯA BIẾT** (không có quyền truy cập).

---

# ⭐ LƯỢT 2 (2026-10-19) — NGỮ NGHĨA "FILE LÀ SỰ THẬT DUY NHẤT" — HIỆN HÀNH

> **Quyết định Manager 2026-10-19 (nguyên văn):**
> 1. **FILE LÀ SỰ THẬT DUY NHẤT.** Import xong, template = đúng những gì trong file.
>    KHÔNG quan tâm template đã có gì trước đó (khớp khoá REPLACE-ONLY Q-A).
> 2. **Ô CÓ GIÁ** ⇒ override đúng giá đó.
> 3. **Ô TRỐNG** ⇒ không override ⇒ theo giá Apple. Xoá trống một ô đang override =
>    bỏ override, quay về theo giá Apple.
>
> ⇒ KHÔNG cần cơ chế "nhận biết ô đã sửa": không so với trạng thái hiện tại, không ảnh
> chụp lúc export, không dò xung đột khi người khác sửa giữa chừng.
> ⇒ **BÀI NGHIỆM THU SỐ MỘT:** export B rồi import lại NGUYÊN TRẠNG ⇒ template KHÔNG ĐỔI
> GÌ — không ô thừa hưởng nào thành override.
> Kèm: **KHÔNG** dùng heuristic "ô có giá bằng giá Apple hiện tại thì coi là thừa hưởng".

**Hệ quả cho bản này.** Cơ chế M1/M2/M3 (template_id, digest, `_import_info` làm thẻ
phiên bản, planner gộp), ca f, và giao thức `plan_hash` **bỏ theo quyết định Manager**.
Mỗi mục bỏ có đánh dấu tại chỗ ở lượt 1. §L2.7 là bảng KEEP / CHANGE / DROPPED cho từng
mục cũ.

**Lượt 2 được làm thế nào.**
- 4 lane độc lập + 1 critic dò lại từng `file:line` và chạy lại các phép đo nghi ngờ:
  - danh tính nước + currency;
  - độ đầy đủ của export;
  - đường ghi + tier + số;
  - preview + giá Apple + scope.
- Fixture thật:
  - template A thật `docs/iap-management/templates/price-tiers-template.xlsx` (95 tier × 175
    nước = 16 625 entry, 0 warning, 43 currency) → parser thật → `replaceTemplate` thật trên
    fake `iapDb` → `POST` thật của route export → đọc lại bằng SheetJS;
  - đường đọc và ràng buộc DB đo trên **Postgres 17.5 thật (PGlite)**, dùng DDL đọc nguyên
    văn từ migration.
- Không gọi Apple hay Supabase thật. Repo không đổi trong lúc đo; probe nằm ở scratchpad
  của phiên.
- Nhãn bằng chứng như bảng ở trên. Mọi `file:line` tại `aa1fb49` (code Apple không đổi từ
  commit gốc `ac3043f` của lượt 1 — diff rỗng trên mọi đường dẫn Apple).

## L2.1 P1 — Census hai format (lượt 1 §1.1–§1.3 vẫn đúng; đo lại + bổ sung)

Đo lại trên template thật, kết quả khớp lượt 1:
- **A** (`lib/iap-management/parsers/price-tiers.ts`):
  - sheet đầu phải tên `price_tiers`;
  - hàng 1 là `Tên (AAA_CCC)` — regex `TERRITORY_HEADER_RE` `:37`, chỉ ở cột lẻ; mã và
    currency lấy từ header, tên bị bỏ;
  - hàng 2 là `Price`/`Proceeds`; dòng = tier, cặp cột = territory;
  - ô trống ⇒ không entry (`isBlankCell` `:109-113`) = khoá **Q-I** (KB:187).
- **B** (`lib/iap-management/xlsx-template-matrix-export.ts`): ĐÃ ĐO.
  - Đúng 1 sheet `Default Template` / `Per-App Template`.
  - Hàng 1 **chỉ tên** nước: `headerRow1.push(market.name, null)` `:205`; tên từ
    `territoryName(code)` (`queries/template-matrix.ts:157`).
  - Hàng 2 là `Price | Currency`.
  - Ô có entry ghi số + currency **của chính ô đó** (`:223`); ô không entry ghi `·` vào
    **cả hai** nửa (`:216-221`, hằng `:78`).
  - Không numFmt. Parser A đọc B ⇒ 422 `Expected sheet "price_tiers" but found "Default
    Template"`.

**Bổ sung lượt 2:**
- **B mang 1/175 mã nước.** Quét đủ 10 part ZIP: chỉ có `XKS`, vì `territoryName` rơi về
  chính mã với Kosovo (`components/iap-management/view-detail/territory-name.ts:43`).
  Không có `(AAA_CCC)` hay `(AAA)` nào. ĐÃ ĐO.
- **Tên không phải danh tính ổn định.** ĐÃ ĐO:
  - tên trong file A của Manager khác tên B ở 16/175 nước (`Korea, Republic of` vs
    `South Korea`, BRN, CIV, MKD, TZA, GMB…);
  - hai hệ tên trong repo (`APPLE_TERRITORY_CATALOG` vs `territoryName`) lệch nhau 7/175.
- Màn hình hiện tên + badge currency của cột (`MatrixTable.tsx:79-82`), không hiện mã.
  Twin Google cũng chỉ ghi tên (`lib/google-iap-management/xlsx-template-matrix-export.ts:351`).
- Route export chỉ log WARN/ERROR, không log lần export thành công ⇒ **số file B đã phát
  cho team: CHƯA BIẾT** (cần Manager).

## L2.2 P2 — ⭐ B THƯA HAY ĐẦY: **B THƯA**

**Bằng chứng** (ĐÃ ĐO ở cả 4 lane, cộng ĐỌC CODE):
- Writer ghi `·` vào ô không có entry (`:216-221`). Không chỗ nào ghi giá Apple (grep).
- Template thật (lưới đầy) ⇒ 16 625 ô số, 0 ô `·`. Fixture thưa 11 entry ⇒ 11 ô số + 18 ô `·`.
- Per-App 12 entry ⇒ đúng 12 ô số. Không lọt giá chỉ-có-ở-Default: composer chỉ gắn giá
  Default vào ô đã có entry Per-App (`template-matrix.ts:133-140`).

⇒ **Phương án hai sheet** (`Template` + `Effective prices`) của Manager chỉ đặt ra khi B
ĐẦY ⇒ **không kích hoạt**. Nếu vẫn muốn một sheet `Effective prices` chỉ để xem, nó vấp
đúng kết quả §L2.5: không có nguồn "giá Apple hiện tại" nào mà không phải gọi Apple.

**B đọc theo luật 1–3:**
- Ô số ⇒ override đúng giá đó (luật 2).
- `·`, ô trống, ô stub (Numbers đệm), cột/dòng không có trong file ⇒ không override ⇒ giá
  Apple (luật 3, luật 1).
- ⇒ Đọc nguyên văn thì "không ô thừa hưởng nào thành override" đúng **do cấu tạo**: không
  cần heuristic, không so với DB, không so với Apple.
- Per-App: `·` = **giá Apple, KHÔNG phải giá Default**. Orchestrator đọc đúng MỘT template
  (`lib/iap-management/apple/pricing-orchestration.ts:423-438`); thiếu template thì lùi về
  APPLE (`:429-434`).
- Ô Currency cạnh một ô Price trống/`·` ⇒ bỏ qua (Excel giữ `USD` cạnh ô Price vừa xoá —
  đo lượt 1, ca d).
- Màu cam + note của Per-App ⇒ bỏ qua. Note còn chứa giá Default ⇒ reader không được đọc
  comments.

**⚠ Thưa là điều kiện CẦN, chưa ĐỦ.** `·` hoặc "vắng mặt" chỉ nói thật khi đủ cả ba:
1. đường đọc của export không sót dòng;
2. file chứa **mọi** nước của template;
3. file nói được cột nào là nước nào.

Hỏng một điều ⇒ một override bị đọc thành "không có" ⇒ luật 1 xoá nó **im lặng** ⇒ bài
số một đỏ. Hôm nay **cả ba đều hỏng được** (§L2.3).

**Phương án (a) "parser nhận B → chuẩn hoá về entry thưa của A" còn thiếu gì để qua bài
số một:**

| # | Thiếu | Bằng chứng | Chặn bài #1? |
|---|---|---|---|
| 1 | **Mã nước trong file** | B chỉ có tên (L2.1); đảo tên → mã bị cấm (KB §4.20 `:964-996`), thư viện trượt 4/175 (CHN, LAO, MAC, XKS) — ĐÃ ĐO | **CÓ** — phải sửa EXPORT; file B cũ ⇒ từ chối |
| 2 | **File đã lọc / thiếu nước** | §L2.3.6 — file Asia-only xoá 12 255/16 625 override; file không mang dấu hiệu đã lọc — ĐÃ ĐO | **CÓ** — cần Manager chốt (Q-B) |
| 3 | **Đường đọc sót dòng (R6)** | §L2.3.6 — PG 17.5 thật: sót 1 225–1 400/16 625, route vẫn 200, 0 log — ĐÃ ĐO | **CÓ** — phải sửa export (O0 + O2/O3/O4) |
| 4 | **Proceeds** | B không có ⇒ mọi lần ghi đặt NULL (16 625/16 625, ĐÃ ĐO) | Câu định nghĩa bài #1 (Q-A/Q-G) |
| 5 | **Currency của override mới** | ô `·` → gõ giá thì ô Currency vẫn `·` (ĐÃ ĐO) | Không chặn bài #1; chặn luật 2 cho ô mới (Q-D) |
| 6 | **Scope** | file không mang account/app (0 hit mọi part) | **CÓ** nếu import qua Settings — chip ≠ TopNav (Q-E) |

## L2.3 P3 — Chỗ dễ sai (theo luật mới)

### L2.3.1 Round-trip số

- Cột giá: `customer_price NUMERIC(18,4) NOT NULL`, `proceeds NUMERIC(18,4)`
  (`supabase/migrations/20260519000000_iap_mgmt_pricing_templates.sql:58`, `:61`).
  CÓ TRONG SCHEMA.
- Writer dùng `Number()`, không đặt numFmt (General).
- **ĐÃ ĐO (round-trip đủ):**
  - 16 625/16 625 giá đi writer → SheetJS bằng nhau theo `Object.is` với giá trị gốc; 0
    lệch; currency 16 625/16 625 bằng nhau.
  - Ghi lại **toàn bộ** 16 625 `<v>` sang dạng 17 chữ số kiểu Excel (13 005 chuỗi đổi) ⇒
    SheetJS vẫn đọc ra đúng 16 625/16 625.
  - Danh sách 24 giá trị khó (gồm chuỗi `"1.9900"`, `"49000.0000"`) qua 24/24.
- **Sửa §4.2 lượt 1:** luật `Math.round(x·1e4)/1e4 === x` chỉ đúng **dưới 2³⁸ ≈ 2.749e11**,
  không phải 9.007e11 (ĐÃ ĐO: hỏng đầu tiên ở `274 880 423 993.7410`). Luật thay thế không
  có trần: `/^\d+(\.\d{1,4})?$/.test(String(x))` — 0 lỗi trên `[0, 9e11)`, nhận dạng 17
  chữ số của Excel, từ chối `0.30000000000000004` và `1.99999`. Giá thật lớn nhất 2.5e7 ⇒
  không ảnh hưởng thực tế.
- **Hơn 4 chữ số thập phân:** A để Postgres làm tròn im lặng — `0.00004 → 0.0000` (một
  override bằng **0**), `2.99995 → 3.0000` (ĐÃ ĐO). Luật 2 nói "override **đúng** giá đó" ⇒
  đề xuất B từ chối, A giữ hành vi cũ (Q-J).
- **Luật ghim bằng test:**
  - (a) writer → reader: `Object.is(cell.v, Number(db))` cho MỌI entry của template thật,
    cộng biến thể 17 chữ số;
  - (b) bài số một (DB trước vs sau): cùng tập khoá (tier_id, territory_code); mỗi khoá
    currency `===` và `canon(x) = Math.round(Number(x)·1e4)` bằng nhau. Dùng `canon` vì
    PostgREST trả NUMERIC là số hay chuỗi vẫn CHƯA BIẾT — fake phải có một biến thể trả
    chuỗi;
  - (c) luật ô của reader B: `t === 'n'`, hữu hạn, ≥ 0, ≤ 4 chữ số thập phân theo luật
    regex, kiểm `.f` **trước** `.v`; còn lại ⇒ 422 liệt kê địa chỉ;
  - (d) trần cứng xa dưới `1e14` (1e14 ⇒ `numeric field overflow`, ĐÃ ĐO).

### L2.3.2 Territory

- B dùng **tên**, A dùng **alpha-3 trong header**, DB lưu alpha-3.
- KB §4.20 (`IAP-MANAGEMENT-KNOWLEDGE-BASE.md:964-996`) cấm tự viết phép chuyển
  alpha-2/alpha-3. Đổi tên → mã không có trong chữ của §4.20, nhưng cùng lớp lỗi: rơi về
  chuỗi thô trông hợp lý, chỉ phép ĐẾM bắt được.
- Grep `getAlpha3Code|getAlpha2Code` trong code production = 0: repo không có hàm tên → mã.
- Đảo `territoryName` trên 175 mã snapshot hôm nay là đơn ánh (0 trùng — ĐÃ ĐO), nhưng đó
  chính là reverse-map bị cấm. Nó phụ thuộc thư viện thả nổi `^7.14.0` (KB P41), bảng
  override tự viết và snapshot.
- ⇒ **Mã nước phải nằm trong chính file.** Lượt 1 dựa vào bảng cột trong `_import_info` +
  đối chiếu DB; cả hai đã bỏ.
- **Mã trong file phải được kiểm**, vì không tầng nào chặn mã hỏng (ĐÃ ĐO, PGlite):
  - `territory_code` nhận `'Vietnam'`, `'vnm'`, `''`; parser A nhận mọi `[A-Z]{3}` (kể cả
    `ZZZ`);
  - theo luật 1, gõ nhầm `Vietnam (VMN)` ⇒ mọi override VNM biến mất + một entry rác `VMN`,
    về sau ra `partial-template-fail`.
  - Kiểm theo danh sách nào: Q-I.
- **File B cũ (không mã):** chỉ có thể **từ chối rõ ràng** và bảo export lại. Không đoán
  ngược tên → mã, không dùng `XKS` lỡ có sẵn để nhận một nửa file.

### L2.3.3 Tier

- Cột A của B = `tier_name` (`template-matrix.ts:111`).
- Parser thật cho đúng 95/95 tier_id từ 95 tên thật, kể cả `Alternate Tier A/B/1..5` →
  `ALT_*` (ĐÃ ĐO). Ràng buộc: CHECK `20260515010000_iap_mgmt_tier_id_text.sql:45-47`.
- **A gặp tên lạ thì cảnh báo rồi bỏ dòng** (`price-tiers.ts:229-233`). Dưới luật 1 = **xoá
  mọi override của tier đó**, và UI chỉ báo "1 parse warning" SAU khi đã ghi ⇒ reader B phải
  **từ chối (422)**, không cảnh báo.
- **Gõ sai tạo tier mới toàn cục:**
  - `Tier 05` → `TIER_05`, `Alternate Tier 1A` → `ALT_1A`: qua CHECK ⇒ upsert vào bảng
    `price_tiers` **toàn cục** (`templates.ts:619-632`) ⇒ override chuyển sang id mới, id cũ
    mất override, tier mới hiện trong dropdown tạo lẻ của **mọi** account (ĐÃ ĐO);
  - `Alternate Tier a` ⇒ đổi tên ALT_A toàn cục (chỉ khác hoa thường).
  - Lượt 1 R8 hẹp lại: tên không đổi thì upsert vô hại.
- Bộ sắp xếp:
  - `compareTiers` của composer (`template-matrix.ts:87-90`) == `compareTierId`
    (`tier-order.ts:61-78`) trên dữ liệu thật; lệch trên `ALT_1A`;
  - không ảnh hưởng danh tính (khớp theo tên);
  - **có** ảnh hưởng thứ tự cột với template thưa: nước chỉ có ở dòng ALT có thể đổi chỗ
    sau một lần import nguyên trạng (KOR/JPN — ĐÃ ĐO trên fake).
- Tên `tier_id` thô (rơi về khi thiếu tên) không parse được, nhưng thực tế không tới được
  (FK NOT NULL + `tier_name` NOT NULL) — CÓ TRONG SCHEMA.

### L2.3.4 Khoá hiện có + P1 (một đường ghi)

- **Hội tụ đúng nghĩa P1** (ĐÃ ĐO): B → `PriceTiersParseResult` (proceeds `null`) → **chính
  `replaceTemplate`, không đổi byte nào**.
  - Template thật qua writer → reader → `replaceTemplate` ⇒ cùng tập entry (16 625 khoá,
    currency, giá).
  - `price-tiers.ts`, `flattenTemplateEntries`, `replaceTemplate` giữ nguyên (md5
    `price-tiers.ts` = `589367186fdcd845afa2fb3fe3fae215`).
  - Phần mới duy nhất: reader B + nhánh nhận diện ở route.
- **REPLACE-ONLY (Q-A, KB:179)** chính là luật 1. **Q-K fail-soft (KB:189)** không bị đụng.
- **`replaceTemplate` không bao giờ no-op — nay là ngữ nghĩa, không phải lỗi.** Mỗi lần
  ghi, kể cả file y nguyên, giống hệt A hôm nay:
  - `template_id` mới, `uploaded_at`/`uploaded_by` mới, `source_filename` = tên file B;
  - `origin_note` → NULL (insert `templates.ts:647-657` không set) ⇒ pill "migrated" biến mất;
  - `created_count` = số dòng đã chèn = cả template — đúng, vì B thật sự thay toàn bộ (mối
    lo §5.4 lượt 1 biến mất).

  ⇒ Bài số một phải định nghĩa trên **tập entry** (Q-A).
- **Transaction (R7) HẾT là BLOCKER** (ĐÃ ĐO): đứt tạm giữa chừng (chunk 5) ⇒ upload lại
  **đúng file đó** cho ra đúng trạng thái file — file là trạng thái đích đầy đủ, không có
  kiểm id nên không có 409. Còn lại, giống A hôm nay:
  - **Lỗi tất định sau bước xoá thì thử lại không chữa:** tràn `NUMERIC` (1e14), trùng
    (tier, nước) ⇒ template dở (ĐÃ ĐO). ⇒ Reader B **phải từ chối trước** mọi thứ Postgres
    sẽ từ chối sau bước xoá. Trùng dòng tier thì hỏng ở upsert, TRƯỚC bước xoá (PGlite: lỗi
    `21000`) ⇒ an toàn.
  - **Cửa sổ đọc dở:** trong lúc ghi, orchestrator / bulk import thấy template thiếu tier
    (ĐÃ ĐO: 29/95 tier ở chunk 5).
  - **MỚI:** export đúng lúc người khác đang ghi ⇒ file dở dang (200, 29/95 tier) ⇒ theo
    luật 1, import lại file đó làm **cụt** template. O0 (§L2.3.6) không bắt được, vì count
    khớp với trạng thái dở (Q-L).
  - Lỗi trả 500 + lỗi thô (`pricing-templates/route.ts:210-214`); không câu nào nói
    "template đang dở — upload lại đúng file này".

### L2.3.5 Scope

- **File không mang scope** (ĐÃ ĐO: grep account id, template id, app UUID, bundle id,
  `ACCOUNT`, `scope` trong mọi part ⇒ 0 hit). Chỉ còn tên sheet — nói *loại* scope, không
  nói *của ai*.
- **Chip ≠ TopNav vẫn sống** (ĐỌC CODE, ĐÃ ĐO lại):
  - tab Default ghi vào account của **chip**: `form.append("account_id",
    selectedAccountId)` (`app/(dashboard)/iap-management/settings/pricing-tiers/DefaultTemplateTab.tsx:96`);
  - link "Open matrix view" không mang account (`:287`, `:303`);
  - trang matrix + route export đọc account **TopNav** (`default-matrix/page.tsx:18-19`,
    `matrix-export/route.ts:153`), và màn không hiện tên account.
- **File của account khác không lộ trong diff:** file account B so với account A ra 7 ô
  đổi nhỏ (tỉ lệ 1.02–1.14), không cờ nào bắn (ĐÃ ĐO) ⇒ **chặn hay cảnh báo đều cần ghi
  scope vào file lúc export**.
- Phân quyền:
  - export + trang Default matrix mở cho member;
  - upload ACCOUNT chỉ admin (`pricing-templates/route.ts:97-102`);
  - upload APP không có cổng admin, và đường `apple_app_id` gọi Apple + ghi DB **trước**
    khi parse (`:143-161`).
- ⇒ Q-E (P6).

### L2.3.6 (MỚI) Export có ĐẦY ĐỦ không — tiền điều kiện của bài số một

Theo luật 1, cái gì vắng trong file bị **XOÁ** khi import. Bài số một vì thế đòi export
phải đầy đủ. Hôm nay nó hỏng theo ba đường độc lập:

**(i) Bộ lọc — R1.**
- Nút Export gửi `territories: visibleMarkets.map(m => m.code)`
  (`components/iap-management/pricing-templates/DefaultMatrixView.tsx:69`,
  `PerAppMatrixView.tsx:88`); route chỉ giữ các mã đó (`matrix-export/route.ts:212-214`).
- **File không mang dấu hiệu đã lọc** (ĐÃ ĐO): so từng part, file Asia-only chỉ khác file
  đủ ở `sheet1.xml` + `sharedStrings.xml`.
- Import nguyên văn file Asia-only ⇒ **xoá 12 255/16 625 override** ở 129 nước (ĐÃ ĐO).
- ⇒ Luật 1 và bài số một **mâu thuẫn nhau trên file đã lọc** (Q-B).
- Câu "file = ảnh chụp màn, đúng tập nước sau lọc" (KB §21.1 `:6386-6397`; route `:4-5`;
  writer `:4-8`) có còn ràng buộc file **import được** không: Q-B.

**(i′) R1b — MỚI: file KHÔNG lọc cũng có thể thiếu nước.**
- Guard 409 của route chỉ một chiều: chỉ chặn "client xin nước mà server không có"
  (`:185-202`). Phép đếm `:220-225` so với `requested.size`, không so với
  `matrix.markets.length`.
- ⇒ Template **thêm** KOR sau khi trang đã tải ⇒ export vẫn 200, thiếu KOR ⇒ import lại xoá
  95 override KOR (ĐÃ ĐO).

**(ii) Đường đọc — R6.** `fetchAllEntries` (`template-matrix.ts:210-236`):
- `count` là một request riêng, các trang là request khác (không cùng snapshot);
- `.range()` không `.order()`;
- không kiểm `rowsRead == count`, không kiểm khoá distinct;
- composer ghi đè ô trùng im lặng (`:119-122`).

Đo trên Postgres 17.5 thật (PGlite, dữ liệu thật):
- Planner đổi plan giữa các OFFSET trong CÙNG một lần đọc (Index Scan ↔ Bitmap Heap Scan)
  ⇒ dòng trùng và dòng sót **bù nhau đúng bằng `count`**: sót **1 225–1 400/16 625**, mất
  trọn TIER_4…TIER_9.
- Qua route thật: 200, 0 log, và màn hình hiện **cùng cái lỗ**, không cảnh báo.
- Critic đo lại độc lập: lật plan xảy ra **cả ở `random_page_cost = 4`** (mặc định) tuỳ
  dữ liệu/stats ⇒ `SHOW random_page_cost` một mình không trả lời được. Prod: **CHƯA BIẾT**.
- PostgREST `max_rows` < 1000 ⇒ 8 500/16 625, vẫn 200, 0 log (ĐÃ ĐO trên fake).
- Ràng buộc Hotfix 24 (không được `ORDER BY tier_id, territory_code` vì cột sẽ thành
  alphabet — `template-matrix.ts:145-153`) **vẫn đúng** (ĐÃ ĐO).
- Nhưng thứ tự được bảo vệ đó **tự nó không ổn định**: heap ≠ thứ tự upload ngay cả khi
  chèn mới (free-space map), và thứ tự hiển thị đổi theo plan (ĐÃ ĐO).
- `fetchEntries` (`templates.ts:153-160`) **đã** phân trang có `.order(tier_id)
  .order(territory_code)` ⇒ đường ghi giá Apple đọc template đủ; chỉ đường đọc matrix bị
  lộ. Twin cùng lỗi: `getTemplateOverview` (`templates.ts:509-514`) ⇒ sửa ở MỘT choke point
  (P1).
- **Dưới ngữ nghĩa mới, lỗi hiển thị này thành mất dữ liệu:** không còn digest đỡ, ô sót
  thành `·` ⇒ import lại xoá override.

**(iii) Proceeds — R2.**
- B không có proceeds ⇒ mọi lần ghi đặt NULL cho **mọi** entry (ĐÃ ĐO 16 625/16 625).
- Proceeds chỉ để hiển thị, đúng một bề mặt: cột Proceeds tab Default
  (`TemplateEntriesTable.tsx:224-226`).
- Không đường ghi / quyết định nào đọc proceeds: grep `proceeds` trong module Apple;
  orchestrator chỉ dùng tier / territory / customer_price. CÓ TRONG SCHEMA:
  "informational" (`20260519000000:59-61`).
- "Giữ proceeds cho ô không đổi" cần so với trạng thái hiện tại ⇒ trái luật 1 (Q-G).

**(iv) Currency của override mới.**
- Gõ giá vào ô `·` ⇒ ô Currency vẫn `·` (ĐÃ ĐO).
- DB nhận **mọi** chuỗi khác NULL: `currency_code TEXT NOT NULL`, không CHECK (`:57`);
  PGlite nhận `'·'`, `''`, `'vnd'` (ĐÃ ĐO) ⇒ reader ngây thơ ghi `'·'` vào DB im lặng.
- Đường ghi Apple bỏ qua currency (khớp số tiền theo currency Apple thật của nước đó —
  `pricing-orchestration.ts:472-474`). Nhưng currency sai vẫn hỏng thật:
  - USA ≠ `'USD'` ⇒ tier biến mất khỏi bulk import và khỏi giá base USD
    (`templates.ts:317-320` `.eq("currency_code","USD")`);
  - `''` ⇒ giá custom Manager gõ biến mất im lặng (ĐÃ ĐO);
  - nhãn sai dẫn Manager gõ giá theo currency khác.
- Ô **đã** mang Currency phải ghi đúng giá trị đó (bài số một) — không tính lại. Chỉ ô `·`
  → giá mới cần một nguồn currency (Q-D):
  - C1: currency duy nhất của cột trong file (175/175 cột thật có đúng 1);
  - C2: currency trong header (cần O1b/O2);
  - C3: `appleCurrencyFor` (`lib/iap-management/apple/apple-territories.snapshot.ts:145-147`
    — ảnh chụp Apple 2026-08-27, 0 caller production, khớp 175/175 header A thật);
  - C4: bắt Manager tự gõ.
  - **Cấm:** `TERRITORY_CATALOG` (KB:939 "currency comes from Apple, never from the territory
    code"; lệch 96/175 — ĐÃ ĐO), và đọc template hiện tại (trái luật 1).

## L2.4 P4 — Phương án

**Đối chiếu ba ứng viên trong brief:**
- **(a) chỉ parser nhận B:** không chạy được nếu không đảo tên → mã (bị cấm), và vẫn hở R1 /
  R1b / R6 ⇒ ❌ một mình.
- **(b) chỉ sửa export:** điều kiện cần (mã nước, độ phủ, đọc đủ), chưa import được.
- **(c) kết hợp:** = các phương án dưới.
- Hai sheet: không cần (B thưa).

**Lõi chung cho cả ba phương án** (giữ P1 — một đường ghi `replaceTemplate`, không pipeline
thứ hai sau bước parse):
- **Reader B mới** dưới `lib/iap-management/parsers/` (để fence Excel thấy được). Nó tìm
  sheet theo **tên**, duyệt các ô thật sự có (không dùng `sheet_to_json` trên `!ref`), và trả
  `PriceTiersParseResult` với proceeds `null`.
- **Tiền kiểm chặt:** 422 kèm địa chỉ ô, **không ghi gì**, khi gặp:
  - tên tier lạ / không chuẩn;
  - mã nước sai;
  - trùng (tier, nước);
  - công thức, ô chữ, số âm, > 4 chữ số thập phân, ≥ trần;
  - ô Currency bị sửa.

  Đây là thứ thay transaction làm cửa chặn của B.
- **Nhận diện format** trong route upload hiện có:
  - 0) file > 10 MB ⇒ parser A (thông báo của nó);
  - 1) `SheetNames[0] === "price_tiers"` ⇒ A **nguyên văn**;
  - 2) đúng một tên sheet B ở bất kỳ vị trí nào (Numbers chèn `Export Summary` lên đầu) và
    không có `price_tiers` ⇒ B;
  - 3) còn lại ⇒ gọi `parsePriceTiersXlsx` nguyên văn (422 của A).

  ĐÃ ĐO trên 13 hình dạng file: mọi kết quả của A không đổi.
- **Câu báo khi ghi đứt:** "template đang dở — upload lại đúng file này".
- **O0 ở export, bắt buộc:** `rowsRead == count == distinct(tier|territory)`; lệch ⇒ từ chối
  export. O0 bắt mọi ca dup+sót đã đo và ca `max_rows`.

**PA1 — Đọc B theo luật 1, sửa export cho đủ** (tối thiểu, 0 migration, không preview)

| | |
|---|---|
| Làm gì | **Export:** header `Vietnam (VNM_VND)` (O1b — đúng regex của A, mang cả mã lẫn currency, cho thêm cột); lọc: F-a hoặc F-b′ (Q-B); đọc đủ: O0 + O2 (nội dung đọc có thứ tự PK như `fetchEntries`, thứ tự cột vẫn lấy như hôm nay) ở MỘT chỗ, phủ cả `getTemplateOverview`. **Import:** reader B + nhận diện, qua 3 nút Replace sẵn có (confirm "thay toàn bộ" và toast "N entries" của chúng giờ đúng nghĩa với B); currency C2 + ô Currency bị sửa ⇒ 422 (D2); proceeds NULL. **R4:** link "Open matrix view" mang `?account=<chip>`, trang + route export dùng account đó (đối chiếu danh sách account thật), màn hiện tên account |
| Số file (ước) | nguồn ~10–11 (writer, route export, `template-matrix.ts`, `templates.ts`, MỚI reader + spec dùng chung writer↔reader, route upload, `DefaultTemplateTab.tsx`, `default-matrix/page.tsx`, `DefaultMatrixView.tsx`, helper download) · test ~8–9 (2 writer, route export, reader mới, nhánh B route upload, round-trip file thật, fake đảo trang, fence Excel, trang `?account=`) · docs 5 · **migration 0** |
| Rủi ro | header file khác màn (§21.1) — trừ khi màn cũng hiện mã; mọi file B cũ bị từ chối; cửa sổ "export lúc đang ghi" còn; thứ tự cột không bảo đảm; không preview ⇒ file sai account / file xoá hàng loạt chỉ bị chặn bởi luật cấu trúc; Numbers gắn `@` ⇒ ô gõ sau đó thành chữ (Q-K); lệch twin Google |
| CHẮC (ĐÃ ĐO) | P1 một đường ghi; số 16 625/16 625; B thưa; nhận diện không đổi kết quả A; O2 đủ dữ liệu 16/16; trùng tier chặn trước bước xoá |
| CHƯA BIẾT | prod có dính R6 không; Google Sheets; PostgREST trả NUMERIC dạng gì; bất thường currency trên prod (V1–V5) |

Biến thể **F-b′** của PA1 giữ được §21.1 cho file xem:
- "Export XLSX" giữ nguyên (file đúng màn, chỉ tên, không mã) ⇒ import tự từ chối như B cũ;
- nút mới "Export để sửa" xuất đủ nước, có mã;
- chính chỗ chứa mã kiêm luôn dấu "file import được".

**PA2 — PA1 + preview chỉ hiển thị + scope stamp + nút import trên Matrix view**

| | |
|---|---|
| Làm gì | preview đọc template hiện tại **chỉ để HIỂN THỊ**, không bao giờ dùng làm tập ghi (§L2.5); stamp scope (một dòng hiện, hoặc sheet info `hidden`) so với đích lấy từ REQUEST ⇒ 409 `SCOPE_MISMATCH`; nút "Nhập file" cạnh "Export XLSX" (`MatrixFilterBar.tsx:83-94`), gửi `account_id`/`app_id` từ props server; import Default chỉ cho admin; 3 nút Settings: từ chối file B kèm câu hướng dẫn, hoặc dùng chung component preview |
| Số file (ước) | nguồn ~17–20 (PA1 + nút + modal preview + diff thuần + helper client + hai view matrix + trang Per-App + `intent` ở route) · test ~12–14 · docs 5 · migration 0 |
| Rủi ro | Manager phải đồng ý đọc trạng thái hiện tại để hiển thị (Q-F); twin surface (2 màn matrix, +3 bề mặt Settings) ⇒ P1/P8; toast phải lấy số từ diff tính lại lúc commit (P5); stamp trong sheet `hidden` hiện ra ở Numbers; file chưa có stamp chặn hay cảnh báo |
| CHẮC | file sai account không phát hiện được nếu không có stamp (ĐÃ ĐO); diff 0/0/0 trên file nguyên trạng (ĐÃ ĐO) |
| CHƯA BIẾT | ngân sách + độ trễ nếu preview gọi Apple (O1-a, tối đa ~89 request) |

**PA3 — PA1 hoặc PA2 + 1 migration (Path G): `sort_order` + RPC thay template nguyên tử
cho CẢ A lẫn B**

| | |
|---|---|
| Làm gì | cột `sort_order` trên entries (tiền lệ Google `supabase/migrations/20260831000000_google_iap_mgmt_account_templates_m1_additive.sql`); function xoá + chèn trong MỘT transaction; các đường đọc `ORDER BY` PK / `sort_order` ⇒ đủ dữ liệu, tất định; xoá cửa sổ đọc-dở và trạng thái dở tất định; thứ tự cột vào được bài số một |
| Số file (ước) | +1 migration · +3–4 nguồn · +3–4 test (SQL verify, tiêm lỗi giữa chừng, round-trip thứ tự cột) · KB · **chặn PUSH** tới khi Manager chạy SQL + verify, không chặn code |
| Rủi ro | backfill từ thứ tự vật lý hiện tại có thể đóng băng một thứ tự đã sai; kích thước payload RPC (~1.5–2 MB) CHƯA BIẾT; A đổi hành vi ở đúng một điểm (lỗi giữa chừng ⇒ rollback) |
| CHẮC | có tiền lệ Google; đọc có thứ tự đủ dữ liệu trong mọi lần đo |

**Không đề xuất:**
- **Chuyển B sang workbook A rồi chạy parser A.** ĐÃ ĐO cho cùng kết quả trên file sạch,
  nhưng thừa hưởng luật dễ dãi của A (xoá dấu phẩy, nhận số âm, cảnh báo-rồi-bỏ) ⇒ dưới
  luật 1 thành xoá im lặng.
- **Short-circuit "file = DB ⇒ không ghi".**
  - Đó là một phép so với trạng thái hiện tại làm ĐỔI hành vi, trái luật 1.
  - Nó gây gãy: file y nguyên giữ cả 16 625 proceeds, sửa đúng 1 ô thì mất hết.
  - Bài số một (tập entry) không cần nó: luôn ghi vẫn ra cùng tập entry (ĐÃ ĐO).

## L2.5 P5 — Preview + parity + test + mutation

### L2.5.1 Preview diff (đề xuất — chưa chốt; có preview hay không là Q-F)

**"Giá Apple sẽ áp" — census nguồn** (Q-R):
- **Không** có nguồn tin được nào mà không gọi Apple:
  - không bảng DB nào cache giá Apple (grep `CREATE TABLE` mọi migration `iap_mgmt`);
  - bảng legacy `price_tier_territories` là file Manager upload cũ, toàn cục (không có
    account), theo tier địa phương — tiền lệ J-1 đã từ chối nó làm nguồn giá
    (`lib/iap-management/queries/price-point-donor.ts:17-25`);
  - template GLOBAL đã xoá (M-2);
  - cache chỉ sống trong một request.
- Nguồn duy nhất là câu trả lời của chính Apple:
  `GET /v1/inAppPurchasePricePoints/{usaPointId}/equalizations`.
  - 0 caller trong repo; endpoint mới ⇒ áp checklist KB §10.3.
  - Tốn 1 + d request, d = số giá base USD khác nhau (≤ 88 với file thật) ⇒ tối đa ~89
    request / preview ≈ 2.5 % ngân sách giờ của một key.
  - Cần một IAP donor + credentials của **account đích**.
- **Giá Apple tính theo giá base USD, không theo tier địa phương**, và base khác nhau theo
  đường tạo IAP:
  - bulk import lấy ô USA của template (`bulk-import/execute/route.ts:488`, `:567-569`);
  - tạo lẻ / cập nhật lấy bảng legacy (`create-on-apple/route.ts:317-320`,
    `update-on-apple/route.ts:325-328`).

  ⇒ Cùng một ô có thể có hai "giá Apple".
- Template không bao giờ định giá lại IAP đã có trên Apple ⇒ "sẽ áp" nghĩa là ở lần
  tạo/cập nhật/bulk import SAU, theo quy đổi của Apple lúc đó.
- Lựa chọn:
  - O1-a: gọi equalizations, có trần, lỗi thì hiện không số;
  - O1-a′: catalog từng nước + "cùng chỉ số p" — giả thuyết mới đo trên 2 dòng USD;
  - O1-b: chỉ ghi "theo giá Apple (tự quy đổi)", 0 lần gọi;
  - O1-c: giá bảng legacy, ghi rõ "không phải giá Apple" — trái J-1;
  - O1-d: mặc định O1-b, có nút "Xem giá Apple".

**Giao diện đề xuất:**
```
┌ Nhập file vào Default template · <Tên account> (<account_id>) ───────────────┐
│ File: apple-pricing-template-default-20261019.xlsx · Nhận diện: Matrix (B)   │
│ [tuỳ Q-E] File export từ: <account> ✓ khớp | !! khác account đích            │
│ Sau khi ghi, template = ĐÚNG nội dung file này.                              │
│   + 1 override mới   ~ 2 đổi giá   − 2 bỏ override (về giá Apple)            │
│   = 7 giữ nguyên     Sau ghi: 10 override (hiện tại 11)                      │
│ !! 3 nước có override nhưng KHÔNG có cột trong file → bỏ 8 override          │
│ !! Cột USA: 1 thay đổi   !! 1 ô lệch >10× (kiểu "49,000" → 49)               │
│ (i) File không mang proceeds → 9 ô đang có proceeds sẽ thành trống           │
│ (i) IAP đã có trên Apple giữ nguyên giá; template mới áp cho lần tạo/sửa sau │
│ Tier    Nước      Hiện tại     File        Loại            Sẽ áp             │
│ Tier 2  Vietnam   49 000 VND → 49 VND      đổi ×0.001 !!   49 VND            │
│ Tier 10 Japan     ·          → 1 500       override mới    1 500 JPY         │
│ Tier 2  Thailand  69 THB     → ·           bỏ override     giá Apple [Q-R]   │
│ Tier 1  USA       0.99 USD   → (trống)     bỏ (USA) !!     Tier 1 không còn  │
│                                                            dùng được ở bulk  │
│                                         [ Huỷ ]  [ Ghi 13 thay đổi ]          │
└──────────────────────────────────────────────────────────────────────────────┘
```
- Per-App: dòng "bỏ override" ghi rõ "về giá Apple (**KHÔNG** phải giá Default)".
- Tổng số tách hai nhóm: "bỏ" do ô bị xoá/`·`, và "bỏ" do cột vắng.
- Cột USA có cờ riêng (§4.6 lượt 1, đã đo lại): đổi ô USA đổi tier bulk import chấp nhận
  VÀ giá base USD; xoá ô USA ⇒ tier không dùng được trong bulk import nguồn template.
- Cờ độ lớn:
  - ô đổi giá: 10× / 0.1×;
  - override mới: so với các tier kề nhau cùng cột trong FILE (thang giá phải đơn điệu).
  - Cờ chỉ cảnh báo, không chặn. File sai account qua được mọi cờ độ lớn (ĐÃ ĐO) ⇒ cờ không
    thay được stamp.
- 0 thay đổi ⇒ preview nói "0 thay đổi". Việc server có ghi hay không: mặc định **vẫn
  ghi** (xem "Không đề xuất" ở §L2.4) — Manager chốt ở Q-F.

### L2.5.2 Parity — format A không đổi hành vi

- Không đổi byte nào:
  - `price-tiers.ts` (md5 trên — còn consumer thứ hai là route legacy
    `pricing-tiers/route.ts:58`);
  - thứ tự nhánh A của route (auth → form → cổng scope → APP `getApp`/`ensureAppRegistered`
    → parse 422 → `replaceTemplate` 500);
  - chuỗi ghi + payload `replaceTemplate` cho file A;
  - 3 bề mặt upload.
- Ghim bằng test sẵn có: 11 test `route.scope-rejection.test.ts` (gửi body `"x"` với parser
  mock — chỉ xanh nếu nhánh 3 ủy quyền cho parser), 11 `price-tiers`, 11 account-isolation,
  15 smoke.
- Fence Excel: route không import `xlsx` tĩnh; reader B + nhận diện nằm dưới `parsers/` và
  thêm vào `PARSERS` (`excel-library-split.structural.test.ts:189-192`). Fence vẫn mù với
  `await import("xlsx")` (`:224-225`).

### L2.5.3 Test nghiệm thu

| # | Test | Tầng |
|---|---|---|
| **T1 — BÀI SỐ MỘT** | writer thật → bytes → reader thật → `replaceTemplate` → DB: **tập entry trước = sau** (khoá + currency + `canon(giá)`). Biến thể: Default · Per-App `showDiff` bật/tắt · file đã qua **Excel thật** · file đã qua **Numbers thật** (fixture do app thật lưu ra, không viết tay — P27). Proceeds khẳng định riêng theo Q-A/Q-G | dưới tầng thấp nhất |
| T1b | sửa đúng một ô ⇒ mọi entry khác bằng nhau (khoá / currency / giá) | reader + route |
| T2 | ca a (thừa hưởng giữ thừa hưởng) · b (override giữ giá + currency) · c (ô sửa ⇒ override giá mới) · d (ô xoá trống ⇒ bỏ override — luật 3) · e (Apple đổi giá giữa chừng ⇒ import không đọc Apple lần nào) | reader + route |
| T3 | số: 16 625 giá thật + biến thể 17 chữ số; DB trả chuỗi `"1.9900"`; > 4 chữ số ⇒ 422; ≥ trần ⇒ 422 | reader |
| T4 | scope theo Q-E (file account A vào B ⇒ chặn/cảnh báo/qua; đích luôn từ request) | route |
| T5 | **export đầy đủ:** fake đảo trang + PGlite ép đổi plan ⇒ file đủ HOẶC export bị từ chối, không bao giờ 200 thiếu; R1b (template thêm nước sau khi trang tải) | route export |
| T6 | cấu trúc: tên tier lạ / không chuẩn, mã nước sai, cột trùng, công thức (3 fixture), ô chữ, ô Currency bị sửa ⇒ 422 liệt kê mọi địa chỉ, 0 lần ghi | reader |
| T7 | nhận diện: 13 hình dạng file — kết quả A không đổi | route |
| T8 | parity A (§L2.5.2) | route + parser |

### L2.5.4 Mutation (mỗi cái phải làm một test ĐỎ đúng lý do; áp qua `scripts/mutate.sh`)

| Mutation | Test phải đỏ |
|---|---|
| ⭐ Coi ô có giá bằng giá Apple / Default là thừa hưởng (heuristic) | T2 ca e (+ T1 nếu fake trả giá Apple trùng) |
| ⭐ Ô trống bị **bỏ qua** (giữ override cũ) thay vì bỏ override | T2 ca d |
| ⭐ Import đọc sheet "Effective prices" (chỉ nếu chọn hai sheet) | T1 |
| Coi `·` là override ở giá Default/Apple | T1 |
| Bỏ O0 ở export | T5 |
| Export lấy danh sách nước của client thay vì server | T5 (R1b) |
| Reader nhận tên tier lạ kèm warning thay vì 422 | T6 |
| Lấy currency ô mới từ `TERRITORY_CATALOG` | T2 ca c |
| Nhận ô Currency đã bị sửa | T6 |
| Đảo tên → mã thay vì đọc mã trong file | T6 (file B cũ phải bị từ chối) |
| So `===` thay vì `canon`; luật thập phân cũ | T3 |
| Kiểm `.v` trước `.f` / bỏ `sheetStubs` | T6 công thức |
| Cho nhánh B chạy khi `SheetNames[0] === "price_tiers"` | T8 |
| Bỏ kiểm scope / lấy scope đích từ file (nếu có stamp) | T4 |

## L2.6 P6 — Câu hỏi cho Manager

⛔ = chặn thiết kế · ○ = chốt trước khi code, không đổi hình dạng thiết kế. *(nghiêng)* =
phương án lane nghiêng về, chỉ để tham khảo.

**Ba câu của brief:**
- **File sai scope** → Q-E.
- **Nhận diện A/B:** đề xuất **tự động theo tên sheet** (tên rời nhau; 13 hình dạng file
  đã đo); file mơ hồ ⇒ câu 422 của A, không đoán (+ Q-V).
- **Hai sheet:** không kích hoạt — B thưa (§L2.2).

| # | Câu | Lựa chọn |
|---|---|---|
| ⛔ **Q-A** | Bài số một "template KHÔNG ĐỔI GÌ" tính trên gì? Import lại nguyên trạng ⇒ tập entry giống hệt 16 625/16 625 (ĐÃ ĐO), nhưng proceeds → NULL, `template_id`/`uploaded_*`/`source_filename` mới, pill "migrated" mất — y như A hôm nay; thứ tự cột không bảo đảm | (i) chỉ tập entry *(nghiêng)* · (ii) + proceeds ⇒ bắt buộc đưa proceeds vào file · (iii) + thứ tự cột ⇒ bắt buộc PA3 · (iv) + metadata ⇒ cần short-circuit (trái luật 1) |
| ⛔ **Q-B** | File export đã LỌC / thiếu nước: luật 1 + bài số một mâu thuẫn (Asia-only ⇒ xoá 12 255/16 625) | F-a export luôn đủ nước (danh sách server) · F-b′ "Export XLSX" để xem (không mã ⇒ import từ chối) + "Export để sửa" (đủ nước, có mã) *(nghiêng)* · F-c file tự khai độ phủ, import từ chối file thiếu · F-d import nguyên văn + preview báo to |
| ⛔ **Q-C** | Đưa mã nước vào B | O1a `Vietnam (VNM)` · O1b `Vietnam (VNM_VND)` — giống A, kèm currency *(nghiêng)* · O2 thêm một hàng mã · O3 sheet thông tin theo vị trí (đổi chỗ cột ⇒ lệch im lặng; Numbers làm hiện ra). Kèm: màn có hiện mã cho khớp §21.1 không? twin Google có làm cho đối xứng không? |
| ⛔ **Q-D** | Currency của override mới (ô `·` → gõ giá) + ô Currency bị sửa | nguồn: C1 cột trong file · C2 header *(nghiêng, cần O1b/O2)* · C3 snapshot Apple · C4 Manager gõ. Ô Currency bị sửa: từ chối kèm địa chỉ *(nghiêng)* · bỏ qua · nhận nguyên văn. Có chuẩn hoá `usd` → `USD`? |
| ⛔ **Q-E** | Chỗ đặt nút import + scope (câu P6 của brief) | nút: 3 nút Replace ở Settings · cạnh "Export XLSX" trên Matrix view · cả hai. File account/app khác: **chặn** (cần stamp) · **cảnh báo** + bắt xác nhận (cần stamp) · **cho qua** (diff không lộ — ĐÃ ĐO). File chưa có stamp: chặn hay cảnh báo? Sửa chip ≠ TopNav (`?account=` + hiện tên account) trong arc này? File `Per-App Template` vào Default (và ngược lại): từ chối *(nghiêng)* hay cho? |
| ⛔ **Q-F** | Preview: có được ĐỌC template hiện tại chỉ để HIỂN THỊ không (luật "không so với trạng thái hiện tại" nói về nhận biết ô đã sửa)? Bắt buộc, tuỳ chọn, hay không có? File 0 thay đổi có bỏ qua bước ghi không? | đề xuất: được đọc để hiển thị; file 0 thay đổi **vẫn ghi** (bỏ qua ghi = để trạng thái cũ quyết hành vi, trái luật 1) |
| ⛔ **Q-G** | Proceeds (đi cặp Q-A) | P-i đưa vào file (đổi bố cục B) · P-ii chấp nhận NULL *(nghiêng)* · P-iii giữ cho ô không đổi (cần so với trạng thái hiện tại) · P-iv bỏ proceeds khỏi template |
| ○ Q-H | Cột tier: tên lạ ⇒ từ chối cả file (422)? Cho thêm dòng tier MỚI (sẽ hiện cho mọi account)? Từ chối cách viết không chuẩn (`Tier 05`, `Alternate Tier a`)? | đề xuất: từ chối tên lạ + không chuẩn; tier mới — hỏi |
| ○ Q-I | Kiểm mã nước theo snapshot 175 nước (đóng chặt tới lần refresh) hay mọi `[A-Z]{3}` như A? Áp cho cả A không? | — |
| ○ Q-J | Giá > 4 chữ số thập phân: B từ chối, A giữ hành vi cũ? | đề xuất: có |
| ○ Q-K | Ô chữ trông như số (Numbers gắn `@` ⇒ ô gõ sau đó thành chữ) | (i) từ chối mọi ô chữ · (ii) chỉ nhận chuỗi không mơ hồ |
| ○ Q-L | Cửa sổ "export lúc đang ghi ⇒ file dở": chấp nhận, hay làm PA3? | — |
| ○ Q-M | Đường đọc: O0 bắt buộc; thêm O2 đọc hai lần *(nghiêng, 0 migration)* · O1 kiểm-rồi-từ-chối (có thể chặn export tới lần ANALYZE sau) · O3/O4 (migration) | — |
| ○ Q-N | File B cũ: đã phát bao nhiêu, có ai đang sửa dở? Xác nhận: từ chối + bảo export lại, KHÔNG đoán ngược tên → mã | — |
| ○ Q-O | Hotfix 24: thứ tự cột = thứ tự upload còn là yêu cầu? Nếu còn, chỉ PA3 bảo đảm được (heap ≠ thứ tự upload — ĐÃ ĐO) | — |
| ○ Q-P | Sửa cấu trúc dưới luật 1: cho thêm/xoá cột, dòng? (phụ thuộc Q-C: O1 thêm cột được, O3 thì không) | — |
| ○ Q-Q | File 0 override, hoặc thiếu cột USA: luật 1 coi là hợp lệ, nhưng trang hiện "No Default Template uploaded yet" và mọi dòng bulk import nguồn template ra ERROR (`templates.ts:311-327`) — A hôm nay cũng nhận | chặn · cảnh báo · cho qua |
| ○ Q-R | Giá Apple trong preview (nếu có preview) | O1-a · O1-a′ · O1-b *(nghiêng)* · O1-c · O1-d; hiện base USD nào (bulk, tạo lẻ, cả hai)? |
| ○ Q-S | App bảng tính Manager dùng thật (Excel / Numbers / Google Sheets)? Google Sheets ⇒ cần một vòng UAT đo thật | — |
| ○ Q-U | Route legacy `POST /api/iap-management/pricing-tiers` vẫn xoá entry của mọi template mọi account (`queries/price-tiers.ts:334-337`): tắt trong arc này hay arc riêng? | đề xuất: arc riêng, ưu tiên cao |
| ○ Q-V | File B bị đổi tên sheet sẽ nhận câu lỗi của A. So tên sheet không phân biệt hoa thường? | — |

**Thứ tự chốt gợi ý:** Q-A → Q-G → Q-B → Q-C → Q-D → Q-E → Q-F; các câu ○ chốt song
song khi code.

## L2.7 Đối chiếu lượt 1 — KEEP / CHANGE / ⛔ DROPPED (bỏ theo quyết định Manager)

| Mục lượt 1 | Kết luận lượt 2 |
|---|---|
| TL;DR-1 "B thưa" | **KEEP** (đo lại ×4) |
| TL;DR-2 "9 đường hỏng, R7 BLOCKER" | **CHANGE** — R7 hết là blocker; R1, R3, R6 thành điều kiện chặn |
| TL;DR-3 M3 | **⛔ DROPPED** |
| §1.1–§1.3 | **KEEP** (+ L2.1) |
| §2.1, §2.3 | **KEEP** |
| §2.2 giới hạn P37 | **KEEP — nặng hơn**: không còn digest đỡ ⇒ chặn ở export (O0) |
| R1 file lọc | **CHANGE** — thành hành vi của luật 1, mâu thuẫn bài số một (Q-B); cách vá cũ "giữ nước ngoài phạm vi" đọc trạng thái hiện tại ⇒ bỏ. **Thêm R1b** |
| R2 proceeds | **CHANGE** — "ô không đổi giữ proceeds" cần so DB ⇒ bỏ; thành câu định nghĩa (Q-A/Q-G) |
| R3 không mã | **CHANGE → chặn**: mã phải nằm trong file (Q-C) |
| R4 không scope | **KEEP** (Q-E) |
| R5 không version | **⛔ DROPPED** — không dò xung đột; hệ quả được chấp nhận: người ghi sau thắng, file cũ import lại đè bản mới hơn |
| R6 phân trang | **CHANGE → tiền điều kiện**, đã đo trên PG thật |
| R7 transaction | **CHANGE** — hạ cấp (re-upload chữa được); thêm "export lúc đang ghi"; "409 khi thử lại" bỏ |
| R8 tên tier toàn cục | **CHANGE (hẹp)** — rủi ro thật là gõ sai tạo id mới |
| R9 số theo locale | **KEEP** (luật ô reader + cờ độ lớn) |
| P3 M1 | **⛔ DROPPED** (vẫn cấm) |
| P3 M2 | **⛔ DROPPED** |
| P3 M3 + planner (bước 1–3, 5, 7–9), `_import_info` thẻ phiên bản, thứ tự ghi theo nước, commit `plan_hash` | **⛔ DROPPED** — chỉ sống: phân loại ô (bước 6), kiểm cấu trúc (một phần bước 4, trong reader), "đích lấy từ request" (bước 2) |
| Ca a, d, e | **KEEP** (d: đã chốt bởi luật 3) |
| Ca b, c | **CHANGE** — proceeds NULL; currency ô mới theo Q-D, không lấy từ dòng DB |
| Ca f | **⛔ DROPPED** |
| Ca g | **CHANGE** — thành "file không có mã nước (B cũ) ⇒ từ chối" |
| §4.1 | **KEEP một phần** — đích từ request; so với manifest bỏ; stamp tuỳ Q-E |
| §4.2 | **KEEP + SỬA** trần 2³⁸ / luật regex |
| §4.3 | **CHANGE** — mã lấy từ file, không đối chiếu DB |
| §4.4 | **CHANGE** — danh tính = tên chuẩn ở cột A; từ chối tên lạ |
| §4.5 | **KEEP, đơn giản hơn** — `replaceTemplate` không đổi; planner gộp bỏ; "nhánh B không upsert `price_tiers`" bỏ |
| §4.6 cột USA | **KEEP** (+ file thiếu cột USA, Q-Q) |
| §4.7 | **KEEP** |
| §4.8 sửa cấu trúc | **CHANGE** — luật 1 cho phép; tuỳ Q-C/Q-P |
| §5.1(a)/(b)/(d) | **CHANGE** → PA1/PA2/PA3 ở L2.4 |
| §5.1(c) M3 | **⛔ DROPPED** |
| §5.2 | **CHANGE** (làm lại ở L2.4) |
| §5.3 | **KEEP** nhận diện (tinh thành luật 0–3); giao thức `intent` + `PREVIEW_REQUIRED` chỉ còn nếu preview bắt buộc; mã `TEMPLATE_CHANGED`/`FILE_DB_MISMATCH` **⛔ DROPPED** |
| §5.4 migration | **CHANGE** — B không cần migration; function nguyên tử thành gia cố tuỳ chọn (PA3) |
| §6.1 | **CHANGE** — tuỳ chọn, chỉ hiển thị (L2.5.1) |
| §6.2 | **KEEP** |
| T1, T1b, T2, T3, T6, T8, T11 | **CHANGE / KEEP** theo L2.5.3 |
| T5 (digest) | **CHANGE** → test đầy đủ phía export |
| T7 (`plan_hash`), T9, T10, T12 | **⛔ DROPPED** (T10 chỉ còn nếu PA3) |
| §6.4 mutation digest / template_id / plan_hash / gộp / "dựng mọi ô thành dòng mới" | **⛔ DROPPED** — còn lại ở L2.5.4 |
| P7 Q1, Q2 | **đã trả lời** bởi quyết định Manager |
| P7 Q3, Q16 | **⛔ DROPPED** |
| P7 Q4–Q15, Q17 | **CHANGE** → Q-A…Q-V ở L2.6 |
| Phụ lục A | **KEEP + THÊM** (L2.8) |
| Phụ lục B | **KEEP** phần lớn; `[TEMPLATE-matrix-unordered-paging]` thăng thành **tiền điều kiện**; câu "digest không bao giờ thừa" và "với M3 gap proceeds biến mất" **⛔ DROPPED** |

## L2.8 SQL chỉ đọc cho Manager (thêm vào Phụ lục A)

```sql
-- V1. Ràng buộc thật trên bảng entries (migration nói: PK + 2 FK, không CHECK currency/territory)
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'iap_mgmt.price_tier_template_entries'::regclass ORDER BY 1;

-- V3. Nước mang > 1 currency trong cùng một template (A không tạo được; SQL tay thì có)
SELECT template_id, territory_code, array_agg(DISTINCT currency_code)
  FROM iap_mgmt.price_tier_template_entries
 GROUP BY 1,2 HAVING count(DISTINCT currency_code) > 1;

-- V4. Mã sai dạng đang lưu (không phải 3 chữ hoa)
SELECT template_id, territory_code, currency_code, count(*)
  FROM iap_mgmt.price_tier_template_entries
 WHERE territory_code !~ '^[A-Z]{3}$' OR currency_code !~ '^[A-Z]{3}$'
 GROUP BY 1,2,3;

-- V5. Dòng USA không ghi USD (tier đó vô hình với bulk import, templates.ts:317-320)
SELECT template_id, tier_id, currency_code FROM iap_mgmt.price_tier_template_entries
 WHERE territory_code = 'USA' AND currency_code <> 'USD';

-- ALT. Nước chỉ có ở dòng Alternate tier (đổi chỗ cột khi import lại — §L2.3.3)
SELECT template_id, territory_code FROM iap_mgmt.price_tier_template_entries
 GROUP BY 1,2 HAVING bool_and(tier_id LIKE 'ALT\_%');

-- R6-a. Kích thước template
SELECT template_id, count(*) FROM iap_mgmt.price_tier_template_entries
 GROUP BY 1 ORDER BY 2 DESC;
-- R6-b. Với template lớn nhất: plan có đổi giữa các OFFSET không (Index Scan … lookup
--       vs Bitmap Heap / Seq ⇒ R6 đang sống trên prod). Chạy 3 lần: OFFSET 0, 8000, 15000.
EXPLAIN SELECT tier_id, territory_code, currency_code, customer_price, proceeds
  FROM iap_mgmt.price_tier_template_entries
 WHERE template_id = '<id>' LIMIT 1000 OFFSET 0;
```
- **V2** (currency lưu ≠ snapshot Apple) cần bảng 175 cặp nước–currency nhúng trong SQL.
  Theo bài học H4.4, bảng đó phải **sinh từ code** (`apple-territories.snapshot.ts`) và được
  test ghim, không chép tay ⇒ ship cùng arc code.
- **Không SQL:** đọc `Max rows` trong Supabase Dashboard → API settings (PostgREST
  `max_rows`).
- **Kiểm tay:** export Default matrix không lọc, đếm ô số trong Excel (`=COUNT` trên các cột
  Price), so với số entry ở tab Default.
- ⚠ `EXPLAIN` chỉ là ảnh chụp: stats đổi sau mỗi `ANALYZE`, nên một lần đo "ổn" không loại
  được R6 — O0 vẫn phải xây.

## L2.9 ⭐ Manager CHỐT (2026-10-19 / 20) — kế hoạch PA2 ĐÃ DUYỆT

**Câu chặn thiết kế (§L2.6):**
- **Q-A:** bài số một so trên **tập entry** (khoá tier + nước, currency, giá).
- **Q-G:** CHẤP NHẬN proceeds thành NULL sau import, với điều kiện đã xác nhận bằng code:
  không đường ghi giá nào đọc proceeds.
  - Cách tra: grep `proceeds` trong module Apple, bỏ test và comment. 0 lần ở
    `pricing-orchestration.ts`, bulk import `execute/route.ts`, `create-on-apple`,
    `update-on-apple`, custom-prices baseline.
  - Proceeds chỉ để hiển thị: `TemplateEntriesTable.tsx:224-225`.
- **Q-B: HAI NÚT.**
  - "Export XLSX": để xem, lọc theo nước đang hiện như hôm nay.
  - "Export for editing": LUÔN xuất ĐỦ mọi nước của template, đọc từ server, không dựa vào danh
    sách nước client ⇒ hết R1 và R1b.
  - Import CHỈ nhận file "for editing".
- **Q-C:** header `Vietnam (VNM_VND)`.
- **Q-D:** currency của override mới lấy từ HEADER. Ô Currency khác header ⇒ từ chối, lý do rõ.
- **Q-E:** nút import NGAY trên matrix view, cạnh nút export. File "for editing" ghi scope (loại
  template + account/app id). Sai scope ⇒ CHẶN, thông báo rõ file thuộc account/app nào.
  Chép template giữa account = tính năng riêng (BACKLOG).
- **Q-F:** CÓ preview diff: thêm / đổi / bỏ override ("quay về theo giá Apple") + tổng số.
  - Được đọc template hiện tại CHỈ để hiển thị; khi ghi, file vẫn là sự thật duy nhất.
  - BỎ con số "giá Apple sẽ áp".
  - File 0 thay đổi vẫn cho ghi.
- **Phương án: PA2** (0 migration). Không PA3: ghi đứt giữa chừng thì upload lại đúng file là chữa
  được.

**Mặc định giữ nguyên:**
- **Q-H:** tier lạ / không chuẩn / không có trong `price_tiers` ⇒ từ chối; cho thêm dòng của tier đã
  có trong `price_tiers`.
- **Q-I:** mã nước kiểm theo snapshot 175 nước; format A không đổi.
- **Q-J:** > 4 chữ số thập phân ⇒ từ chối.
- **Q-K:** chỉ nhận chuỗi không mơ hồ.
- **Q-L:** chấp nhận cửa sổ "export lúc đang ghi".
- **Q-N:** file B cũ ⇒ từ chối, bảo export lại.
- **Q-P:** cho thêm / xoá / đổi chỗ dòng, cột (danh tính lấy từ header); mọi thay đổi hiện trong
  preview.
- **Q-Q:** file 0 giá ⇒ từ chối (file rỗng không được xoá sạch template); thiếu cột USA ⇒ cảnh báo
  trong preview.
- **Q-U:** route legacy xoá mọi tier ⇒ arc riêng.
- Nhãn nút tiếng Anh như UI hiện tại.

**Ba câu khác:**
- `?account=` vào link "Open matrix view": **KHÔNG** cần — scope đã ghi trong file, màn hiện
  tên account.
- PA2 làm trên nhánh `arc-matrix-reimport-design` (3 commit docs đi cùng code).
- **Q-S: Manager dùng EXCEL.** Fixture UAT ở PA2.3 làm bằng Excel thật: agent soạn trước danh sách ô
  → giá trị; Manager export, sửa đúng các ô đó, lưu bằng Excel, gửi lại.
  **Numbers và Google Sheets: CHƯA ĐO, ngoài phạm vi UAT lần này** (team dùng Excel). Ai dùng hai
  app đó sau này thì đo riêng.

**R6 (tiền điều kiện) đã lên `main`:** `c95388d` (KB §21.9).

**Thứ tự chunk:**
- PA2.0: test ghim hiện trạng;
- PA2.1: "Export for editing" — route + writer, chưa có nút;
- PA2.2: reader `parsers/template-matrix-edit.ts` + route upload thêm `intent=preview|commit`, scope,
  diff;
- PA2.3: UI (hai nút + modal preview + tên account trên màn) + docs + fixture Excel.

Mỗi chunk: gauntlet 4/4 + mutation; commit, chưa push, chờ gate.

**Tiến độ (2026-10-20):**
- **PA2.0** `ca91fcf` — test ghim hiện trạng.
- **PA2.1** `8f2d91e` — "Export for editing".
- **PA2.2** `3a2ac53` — reader + route preview/commit; bài số một xanh trên Postgres thật.
- **PA2.3** — Manager chốt thêm 2026-10-20:
  - (1) currency trên header PHẢI bằng currency Apple thu ở nước đó. Prod SQL V2: 175 dòng snapshot / 14 template / 28 707 entry / **0 dòng lệch** ⇒ reader kiểm theo `appleCurrencyFor`, export từ chối template lưu currency khác;
  - (2) reader vào `XLSX_ALLOWED` + `PARSERS` (làm ở PA2.2, Manager xác nhận ở gate PA2.2);
  - (3) tra app theo UUID gộp về `getAppIdentity`.
  - Cùng chunk: UI (hai nút + modal preview + tên account trên màn Default), docs, UAT Excel (`docs/iap-management/uat/pa2-excel/`).
  - Review đối kháng 4 làn (UI / server / docs / tests) trước commit: 0 BLOCKER, 5 MAJOR, 23 MINOR. Đã sửa trong chunk:
    - màn trống của cả hai trang matrix có `Import edited file` — không có nó, ghi đứt ở đợt đầu (mọi Per-App) làm lời khuyên "import the same file again" không làm theo được (cửa Settings trả 409);
    - Export for editing của Default gửi account của TRANG, khác session ⇒ 409 (hai tab);
    - hai lỗi currency của export gom MỘT 409, nêu currency Apple thu;
    - step 2.7 của runbook snapshot so cả currency (`scripts/territory-snapshot-drift.mjs`);
    - dialog: một file mỗi lần (nút khoá tới khi dialog đóng), byte đọc một lần, focus/Esc/Tab, lỗi ghi ⇒ toast + reload, không câu trả lời ⇒ "may or may not have been written", bảng 200 hàng ưu tiên hàng có cờ / bỏ override;
    - toast export lấy số từ header server;
    - test: bấm nút thật (P26), Per-App mở cho member (UI + route), cờ ×10 / thang tier (`diff.test.ts`), nội dung preview đủ hàng, toast từ commit, W9 commit thật, U0 ghim file gốc UAT = export hôm nay.
  - **Gate PA2.3 PASS** `26dd65b` (2026-10-20). Format A không kiểm currency header với Apple: Manager chọn **chấp nhận** (prod 0 ô lệch, guide ghi cách sửa); cảnh báo không chặn ⇒ BACKLOG [IAP-formatA-header-currency-warning]. Ba mục chưa làm ⇒ BACKLOG [TEMPLATE-reimport-focus-return], [TEMPLATE-reimport-header-currency-cells], [TEMPLATE-reimport-other-spreadsheet-apps].
- **Còn:** SQL V2 chạy lại trên prod trước push (≠ 0 dòng ⇒ DỪNG, Manager quyết) + Manager chạy UAT Excel ⇒ test golden đọc chính 3 file ⇒ push cả PA2.

---

# LƯỢT 1 (2026-10-16) — census + thiết kế M3 (giữ làm bằng chứng; các mục bỏ có đánh dấu)

## TL;DR — câu chặn cửa

> ⛔ **Mục 3 BỎ theo quyết định Manager 2026-10-19** (M3). Mục 1 giữ; mục 2 đổi — xem §L2.2,
> §L2.3.

1. **B là ma trận THƯA, không phải ĐẦY.** Ô không có entry được ghi ký tự `·`
   (U+00B7) vào **cả ô Price lẫn ô Currency**. Ô có entry ghi số. Trạng thái
   override/thừa hưởng nằm ở **giá trị ô**, không nằm ở màu (§2.1–2.2). ⇒ Lỗi im
   lặng "mọi ô thành override" mà brief lo **không xảy ra** với B — miễn là `·`
   được đọc về đúng nghĩa "không có entry".
2. **Nhưng B hôm nay KHÔNG import an toàn được.** Có **9 đường mất dữ liệu / ghi
   sai im lặng** khác (§2.4), nặng nhất là: file export có thể đã bị **LỌC** (chỉ
   một phần nước) và REPLACE-ONLY sẽ xoá mọi override của các nước bị lọc; file
   **không có mã nước, không có scope, không có version**; B không mang proceeds;
   và đường ghi hôm nay **không có transaction** — với B, DB là bản sao duy nhất,
   nên một lần ghi đứt giữa chừng là mất **vĩnh viễn** (⟲ BLOCKER của vòng phản biện).
3. **Đề xuất (chờ chốt):** cơ chế **M3 — "ô tự nói trạng thái, ảnh chụp nằm ở
   server"**. Giá trị ô quyết định (số = override, `·` = thừa hưởng). File export
   mang kèm một sheet thông tin nhỏ (scope + `template_id` + digest + bảng danh
   tính dòng/cột). Import chỉ ghi khi template trên server **vẫn đúng là bản đã
   export — cả id lẫn nội dung** (digest). Diff rỗng ⇒ **không ghi gì**. Có ghi
   ⇒ **một function Postgres duy nhất**, kiểm-và-thay trong **một transaction**.
   Nút import đặt **cạnh nút Export trên Matrix view**, không đụng 3 nút upload
   format A.

---

## P1 — CENSUS HAI FORMAT

### 1.1 FORMAT A — template import

**Parser:** `lib/iap-management/parsers/price-tiers.ts` → `parsePriceTiersXlsx`.
**Route:** `POST /api/iap-management/pricing-templates`
(`app/api/iap-management/pricing-templates/route.ts`).
**Đường ghi:** `replaceTemplate(scope, parsed: PriceTiersParseResult, …)`
(`lib/iap-management/queries/templates.ts:574-727`).

| Mục | Sự thật | Nhãn · bằng chứng |
|---|---|---|
| Sheet | chỉ đọc `SheetNames[0]`, tên phải đúng `price_tiers` (phân biệt hoa thường); `price_tiers` ở vị trí thứ 2 ⇒ bị từ chối | ĐỌC CODE `price-tiers.ts:36`, `:149-158` · ĐÃ ĐO (sheet `Default Template` ⇒ 422, `replaceTemplate` 0 lần gọi) |
| Số dòng header | 2: hàng 0 = nước, hàng 1 = `Price`/`Proceeds`; dữ liệu từ hàng 2 | ĐỌC CODE `:161-165`, `:180`, `:224` |
| Header nước | regex `/^(.+?)\s*\(([A-Z]{3})_([A-Z]{3})\)\s*$/`, chỉ ở cột lẻ 1,3,5… (cột chẵn bị bỏ qua im lặng); ví dụ `United States (USA_USD)` | ĐỌC CODE `:37`, `:180-197` |
| Hướng ma trận | **dòng = tier**, **cặp cột = territory** (Price, Proceeds) | ĐỌC CODE `:191-196` |
| Nhận diện territory | **alpha-3 + currency nằm trong header**; tên nước người gõ bị **bỏ đi** lúc parse (`Kosovo (XKS_EUR)` chỉ còn `XKS`/`EUR`) | ĐỌC CODE `:184-196` · ĐÃ ĐO |
| Cột tier | `Free Tier` → `FREE` · `Tier N` → `TIER_N` · `Alternate Tier X` → `ALT_X`; tên khác ⇒ bỏ dòng + **warning** | ĐỌC CODE `:90-106`, `:229-233` |
| Sub-header sai | chỉ **warning**, không chặn | ĐỌC CODE `:206-217` |
| Giá trị ô | số; chuỗi thì `Number(value.replace(/,/g,""))` ⇒ ⚠ chuỗi `"1,99"` thành **199**, `"49.000"` thành **49** | ĐỌC CODE `:115-122` · ĐÃ ĐO |
| **Ô trống (Q-I)** | Price + Proceeds cùng trống ⇒ **không có entry** cho (tier, territory) = không override | ĐỌC CODE `:109-113`, `:242-243` · test `price-tiers.test.ts:45-56` |
| Ô nửa vời | Price có, Proceeds trống ⇒ entry với `proceeds=null`; Proceeds có, Price trống ⇒ bỏ + warning | ĐỌC CODE `:247-263` |
| Ký tự `·` | **lỗi cứng**: `Expected numeric value at row 3 col 2 (USA Price), got: "·"` ⇒ 422 | ĐÃ ĐO |
| File mẫu thật `docs/iap-management/templates/price-tiers-template.xlsx` | 1 sheet `price_tiers`, `!ref A1:MM97`, 95 tier × 175 territory, **đầy** (0 ô trống), 43 currency, numFmt `0.00`; parse thật ⇒ 16 625 entry, 0 warning | ĐÃ ĐO |

**Upload UI — 3 surface, cùng một route:**

| Surface | Gửi gì | Nhãn |
|---|---|---|
| Settings → Default tab | `scope=ACCOUNT` + `account_id` = account của **chip** (`?account=`), không phải TopNav | ĐỌC CODE `DefaultTemplateTab.tsx:87-96`; `settings/pricing-tiers/page.tsx:41-47` |
| Settings → Per-App tab | `scope=APP` + `apple_app_id` (route phân giải qua `getApp` của account **active**) | ĐỌC CODE `PerAppTemplateTab.tsx:95-103`; `route.ts:143-161` |
| App detail | `scope=APP` + `app_id` (UUID nội bộ) | ĐỌC CODE `AppPricingTemplateSection.tsx:47-53` |

Không surface nào có preview/dry-run trước khi REPLACE (ĐỌC CODE
`route.ts:176-214`). Cả ba có một **confirm dựa trên dữ liệu lúc tải trang** khi
template hiện tại do người khác upload (`DefaultTemplateTab.tsx:147-159`,
`PerAppTemplateTab.tsx:154-156`, `AppPricingTemplateSection.tsx:97-98`) — không
thấy được upload xảy ra sau khi trang đã tải. Mọi response 2xx được báo là "đã
thay" (`DefaultTemplateTab.tsx:113-128`). Không có nút "tải template trống" cho
format A (ĐÃ ĐO: grep).

### 1.2 FORMAT B — export Matrix view (file sinh từ route thật)

**Một đường export duy nhất** cho cả Default lẫn Per-App: một route POST
`app/api/iap-management/pricing-templates/matrix-export/route.ts`, một writer
`buildTemplateMatrixWorkbook` (`lib/iap-management/xlsx-template-matrix-export.ts`),
một helper client `lib/iap-management/matrix-export-download.ts`. Scope chỉ đổi tên
sheet và tên file (`:113-116`, `:336`). Hai page, hai view, hai fetcher
(`fetchDefaultMatrix` / `fetchPerAppMatrix`) cùng đổ vào `composeMatrix`
(`queries/template-matrix.ts:95`). — ĐỌC CODE.

**Dump file `01-default-all.xlsx`** (route thật; fixture: tier FREE/1/2/10/ALT_1/ALT_A,
nước chèn theo thứ tự VNM, THA, USA, XKS, JPN, thưa, một giá trị kiểu chuỗi
`"1.9900"` — **giả lập** ca PostgREST trả NUMERIC dạng chuỗi, việc thật sự xảy ra
hay không là CHƯA BIẾT, Phụ lục A) — **ĐÃ ĐO**. `∅` = ô trống, **không phải** `·`:

```
SheetNames      ["Default Template"]            (Per-App: ["Per-App Template"]) — đúng 1 sheet, visible
!merges         A1:A2, B1:C1, D1:E1, F1:G1, …    (mỗi nước phủ 2 cột)
freeze          xSplit=1, ySplit=2, topLeftCell=B3
row 1           Tier | Vietnam | ∅ | Thailand | ∅ | United States | ∅ | XKS | ∅ | Japan | ∅
row 2           ∅ (merge) | Price | Currency | Price | Currency | …
row 3           Free Tier | 0 | VND | · | · | …
row 4           Tier 1    | … | … | 0.99 | USD | …
row 5           Tier 2    | 49000 | VND | … | 1.99 | USD      ← chuỗi "1.9900" được ghi thành số <v>1.99</v>
…               ALT_A (tier_id rơi về vì thiếu tên — chỉ tái hiện được khi cố ý bỏ khỏi price_tiers)
numFmt          KHÔNG có khối <numFmts> trong styles.xml; mọi cellXfs numFmtId=0 (General)
sheet phụ       KHÔNG có. Không definedNames, không docProps/custom.xml.
```

| Mục | Sự thật | Nhãn · bằng chứng |
|---|---|---|
| Ô (tier, territory) **không có entry** | chuỗi `·` (U+00B7, 1 shared string, `t="s"`) ở **cả** Price và Currency; chữ xám `FFCBD5E1` | ĐỌC CODE `xlsx-template-matrix-export.ts:78`, `:216-221`, `:280-292` · ĐÃ ĐO XML `<c r="D3" t="s"><v>10</v></c>`, sst[10]=`·` |
| Ô **có entry** | Price = số thuần (`<v>`, không `t`, không numFmt); Currency = mã currency **của entry đó** | ĐỌC CODE `:161-164`, `:223` · ĐÃ ĐO |
| Header nước | **chỉ tên hiển thị** `market.name = territoryName(code)`; **KHÔNG** có alpha-3, **KHÔNG** có currency ở bất kỳ đâu trong header; Kosovo ghi `XKS` (territoryName rơi về mã) | ĐỌC CODE `:198-207`; `template-matrix.ts:157` · ĐÃ ĐO (grep mọi part: `VNM`=0, `(VNM_VND)`=0) |
| Màu cam `FFB45309` (đậm, cả Price + Currency) + note trên ô Price | **chỉ** Per-App, **chỉ** khi bật `showDiff`, **chỉ** ô mà cả Per-App lẫn Default cùng có entry và khác giá hoặc khác currency. ⇒ nghĩa là "**override Per-App khác override Default**", KHÔNG phải "override vs thừa hưởng" | ĐỌC CODE `template-matrix.ts:133-140`; writer `:296-311` · ĐÃ ĐO (file 02: B4 25000 vs Default 22000 ⇒ cam + note `Default: 22000 VND\nPer-App: 25000 VND`; ô Per-App `·` đè lên Default 49000 ⇒ `·` xám thường) |
| Default có `showDiff`? | Không có tác dụng: view hard-code `showDiff:false`, và Default được dựng **không** kèm `defaultEntries` nên `isDiff` không bao giờ được set. Gửi `true` ra file khác `false` ở **không part nào ngoài** `docProps/core.xml` | ĐỌC CODE `DefaultMatrixView.tsx:74`; `template-matrix.ts:125`, `:289` · ĐÃ ĐO (so từng part) |
| **Lọc** | Màn có search (tên hoặc alpha-3) + currency + 5 châu lục; nút Export gửi `territories = visibleMarkets.map(m => m.code)`; route giữ `matrix.markets.filter(...)` ⇒ **file có thể chỉ chứa MỘT PHẦN số nước**. **Không có lọc tier** — mọi tier luôn có dòng | ĐỌC CODE `DefaultMatrixView.tsx:38-52`, `:69`; `PerAppMatrixView.tsx:56-70`, `:88`; route `:212-214` · ĐÃ ĐO (body `['XKS','THA']` ⇒ file 2 nước, 6 tier) |
| Tier/nước nào xuất hiện | chỉ tier/nước có **≥ 1 entry trong chính template đó**; thứ tự nước = thứ tự xuất hiện đầu tiên trong luồng entry đọc từ DB (không phải alphabet, không phải thứ tự client) | ĐỌC CODE `template-matrix.ts:107-123`, `:154-161` · ĐÃ ĐO |
| Thứ tự tier | non-`ALT_` trước, `ALT_` sau, collator số trên **tier_name** | ĐỌC CODE `template-matrix.ts:78-90`, `:143` |
| Proceeds | **KHÔNG có trong file**. DB có đọc ra (`template-matrix.ts:227`) nhưng `composeMatrix` vứt (`MatrixCell` không có field, `:58-67`, `:119-122`) | ĐÃ ĐO (grep mọi giá trị proceeds của fixture = 0 hit) |
| Scope / account / app / template_id / uploaded_at | **KHÔNG có trong file.** Gợi ý duy nhất: tên sheet (nói *loại* scope, không nói *của ai*). Tên file có bundle id (Per-App) — nằm ngoài nội dung file | ĐÃ ĐO (grep mọi part); `:380-396` |
| Account của Default export | luôn là account **active ở TopNav** (`getActiveAccount`), không phải chip | ĐỌC CODE route `:153`; `default-matrix/page.tsx:18-19` |
| Hai lần export cùng dữ liệu | **khác byte**: `docProps/core.xml` mang giờ export + mỗi entry ZIP mang mtime (writer Apple không ghim; việc ghim epoch ở KB §24.2 là của **writer Google**, `lib/google-iap-management/xlsx-template-matrix-export.ts:471-472`) | ĐÃ ĐO (2 export cách 2.6 s) |

### 1.3 Bảng so sánh A vs B, cột đối cột

| Khía cạnh | A (import) | B (export) | Loại |
|---|---|---|---|
| Tên sheet | `price_tiers`, phải là sheet đầu | `Default Template` / `Per-App Template` | **khác cách viết** |
| Hàng header 1 | `Tên nước (AAA_CCC)` | `Tên nước` (theo `territoryName`, không mã) | **chỉ A có mã + currency** |
| Hàng header 2 | `Price` / `Proceeds` | `Price` / `Currency` | **cặp thứ 2 khác hẳn nghĩa** |
| Cột 0 | tên tier (Manager gõ) | `tier_name` từ bảng `price_tiers` (toàn cục) | giống chuỗi trong thực tế (mọi `tier_name` đều do parser A ghi — ĐỌC CODE `templates.ts:619-632`, `price-tiers.ts:278`) |
| Ô "không override" | **trống** | **`·`** | **cùng nghĩa, khác cách viết** |
| Ô override | số | số | giống |
| Currency | mỗi **cột** một currency (từ header) | mỗi **ô** một currency | **khác tầng** (cấu trúc nội bộ chứa được currency từng ô — `ParsedTerritoryPrice.currency_code`, `price-tiers.ts:39-46`) |
| Proceeds | có (tuỳ chọn) | **không** | **chỉ A** |
| Merge / freeze / màu / note | không | có (trang trí) | **chỉ B**, import phải bỏ qua |
| Tập nước | mọi cột Manager viết | chỉ nước có ≥ 1 entry, **có thể đã lọc** | **chỉ B có thể thiếu** |
| Scope / version | không (scope do UI gửi) | không | — |
| numFmt | `0.00` | General (không numFmt) | không ảnh hưởng giá trị đọc |

---

## P2 — ⭐ CÂU CHẶN CỬA: B THƯA HAY ĐẦY

### 2.1 Export B ghi gì vào ô KHÔNG override?

**`·` — không ghi giá Apple.** Chính writer nói rõ lý do chọn `·` thay vì để trống:
để không lẫn với một ô "không ghi được vì lý do khác" (`xlsx-template-matrix-export.ts:68-78`).
Màn hình cũng vẽ đúng ký tự đó (`MatrixTable.tsx:105-115`), và chú thích của màn
**Default** nói: *"empty cell (·) = no override for that tier-territory pair (Apple
auto-equalisation fills)"* (`DefaultMatrixView.tsx:147-151`). — ĐỌC CODE + ĐÃ ĐO.

Với **Per-App**, `·` cũng có nghĩa "không có entry Per-App" ⇒ khi tạo IAP bằng
nguồn APP_TEMPLATE, nước đó được **Apple tự cân bằng** — **KHÔNG** lùi về giá
Default theo từng ô: orchestrator đọc đúng MỘT template
(`pricing-orchestration.ts:423-428`, filter entry `:436-438`). `composeMatrix` chỉ
gắn giá Default vào ô **đã có** entry Per-App, không bao giờ chép ô chỉ-có-ở-Default
sang (`template-matrix.ts:133-135`). — ĐỌC CODE.

⚠ **Tài liệu người dùng đang nói ngược code** ở đúng điểm này:
`docs/user-docs/index.html:4246` ("phần thiếu sẽ fallback Default") và `:4344` vs
`:2096` ("Apple auto-equalisation fills") — cùng một file tự mâu thuẫn. Yêu cầu
của Manager ("ô không override thừa hưởng giá **Apple**") khớp **code**. Arc này
phải sửa luôn hai dòng kia (KB P46 — sửa cả bản vẽ/bản copy, không chỉ code) —
nếu không, chính bản copy của tính năng sẽ dạy sai nghĩa của ô `·`.

### 2.2 B có đánh dấu override vs thừa hưởng không?

**Có, và đó là giá trị ô** (`số` vs `·`), không phải màu. Không có comment, sheet,
ký hiệu hay ★ nào khác cho override/thừa hưởng (ĐÃ ĐO, lane B). Màu cam mang một
nghĩa khác (Per-App ≠ Default, §1.2) và **phải bị import bỏ qua hoàn toàn**.

⟲ **Một giới hạn phải nói thẳng (KB P37).** `·` chỉ có một nghĩa khi đường đọc
của export không thể sót dòng. Đường đọc đó **có thể** sót (R6, §2.4): một dòng
không được đọc cũng được ghi thành `·`. Nên trong file **thô**, `·` có hai nguồn
gốc ("không có entry" hoặc "không đọc được"). Thiết kế chỉ coi `·` là "không có
entry" **sau khi** digest ở bước 5 (P3) xác nhận file khớp DB — tiền điều kiện của
P37 đúng cho file **đã kiểm**, không đúng cho file thô.

### 2.3 Độ bền của từng cách đánh dấu — ĐÃ ĐO trên app thật

| Thứ cần sống sót | exceljs → SheetJS (đọc/ghi lại) | **Excel 16.104** mở → Save | **Numbers 14.4** mở → Export Excel | Google Sheets |
|---|---|---|---|---|
| Giá trị `·` | ✅ | ✅ | ✅ — nhưng ⟲ **gắn numFmt `@` (Text)** vào mọi ô chuỗi, kể cả ô `·` ⇒ mở lại bằng Excel rồi nhập số vào ô đó thì Excel lưu thành **CHỮ** (ĐÃ ĐO: `160` → `{t:"s", v:"160"}`) | CHƯA BIẾT |
| Số (giá trị) | ✅ bit-identical | ✅ — nhưng **ghi lại `<v>` 17 chữ số** cho số không biểu diễn ngắn được: `12345.6789` → `12345.678900000001`, `4.9` → `4.9000000000000004`; SheetJS đọc ra **đúng double cũ** | ✅ (giữ dạng ngắn) | CHƯA BIẾT |
| Màu chữ / note | ✅ | ✅ (note: xuống dòng `\n` → `\r\n`) | note giữ nhưng **bị chèn tiền tố `Author:\n`** | CHƯA BIẾT |
| Sheet `hidden` | ✅ | ✅ (vẫn hidden) | ⚠ **thành VISIBLE**, nội dung giữ nguyên — ⟲ **chỉ đã đo với chuỗi ngắn + số**; UUID / thời gian ISO / chuỗi digest qua Numbers: **CHƯA ĐO** | CHƯA BIẾT |
| Sheet `veryHidden` | ✅ | ✅ | ❌ **MẤT HẲN** | CHƯA BIẾT |
| Defined names | ✅ | ✅ | ❌ **MẤT** | CHƯA BIẾT |
| Document properties (title/keywords…) | ✅ | ✅ | ❌ **MẤT** | CHƯA BIẾT |
| Custom doc properties | exceljs **không ghi được** (ĐỌC CODE `node_modules/exceljs/lib/xlsx/xlsx.js:483-505`) | — | — | — |
| Thứ tự sheet | ✅ | ✅ | ⚠ **chèn sheet `Export Summary` LÊN ĐẦU** (mặc định AppleScript; mặc định của UI Numbers: CHƯA BIẾT) | CHƯA BIẾT |
| Vùng ô | ✅ | ✅ (`A1:G7` giữ nguyên) | ⟲ **đệm thêm ô rỗng** quanh lưới (đo: `A1:G7` → `A1:G10`, +21 ô stub; sheet phụ +1 cột) — giá trị không đổi | CHƯA BIẾT |

Sửa đúng **một** ô trong Excel rồi Save ⇒ chỉ XML của ô đó đổi; mọi ô khác giữ y
bản Excel trước đó (ĐÃ ĐO). ⚠ Mọi "sửa ô" trong phép đo được đặt qua AppleScript
`formula local` (tương đương nhập tay, nhưng **chưa đo bằng phím thật** — máy không
cấp quyền assistive access). Excel còn **tự gắn numFmt** (`#,##0` / `#,##0.00`) vào ô
được nhập có dấu phân cách hàng nghìn — giá trị `<v>` không đổi, nên reader đọc
giá trị thô là đủ. Sort / copy-paste: **CHƯA BIẾT (chỉ suy luận)** — sort chỉ một
cột kiểu "continue with current selection" sẽ tách giá khỏi tên tier mà mọi ô vẫn
hợp lệ ⇒ chỉ một **preview diff** mới lộ ra (§6.1).

**Kết luận cho thiết kế (đã đo):**
- Thứ duy nhất sống sót qua **mọi** app đã thử là **nội dung ô hiển thị**
  (`·`, số, chữ). Màu: không dùng làm căn cứ ghi, đúng như brief cảnh báo.
- Nếu cần một sheet thông tin: dùng `hidden` (sống qua Excel; Numbers làm hiện ra
  nhưng giữ nội dung), **cấm** `veryHidden` / defined names / doc properties
  (Numbers xoá sạch). **Tìm sheet theo TÊN, không theo vị trí** (Numbers chèn
  `Export Summary` lên đầu). Và vì Numbers làm sheet đó **hiện ra cho người sửa**,
  mọi giá trị trong nó phải được **đối chiếu với server**, không được tin (P3 bước 4).
- So "ô có đổi không" phải so **giá trị đã chuẩn hoá về 4 chữ số thập phân**
  (NUMERIC(18,4)), không bao giờ so chuỗi `<v>` và không dùng `===` (§4.2).
- "Có dòng/cột thừa không" phải xét **ô có giá trị khác rỗng**, không xét `!ref`
  hay số ô stub (Numbers đệm ô rỗng).

### 2.4 Nhưng B KHÔNG import an toàn được — 9 đường mất dữ liệu im lặng

B thưa đúng nghĩa, nên lỗi "mọi ô thành override" không xảy ra. Nhưng đưa B ngây
thơ qua REPLACE-ONLY vẫn hỏng theo 9 cách khác, **cách nào cũng im lặng**:

| # | Đường hỏng | Hậu quả | Nhãn · bằng chứng |
|---|---|---|---|
| **R1** | **Export đã lọc** (search/currency/châu lục) | REPLACE xoá **mọi override của các nước bị lọc** — kể cả file không sửa gì. Đây đúng là P4 ("gửi một tập con thì các phần tử bị bỏ ngoài sẽ bị xoá", KB:3169) | ĐÃ ĐO (file lọc 2/5 nước) |
| **R2** | B không mang proceeds | mọi `proceeds` thành NULL — **thấy được** ở cột Proceeds của Settings (`TemplateEntriesTable.tsx:224-226`); template migrate từ GLOBAL có proceeds trên đủ 1140 ô (`m1_additive.sql:101-106`). Proceeds **không** đi vào đường ghi Apple (`price-schedules.ts:32-45`) | ĐÃ ĐO (round-trip 11 083 entry: 100 % giá đúng, **11 083 proceeds mất**) |
| **R3** | Header không có mã nước | phải đảo ngược tên → mã. Đảo `territoryName` là đơn ánh trên 175 + ISO (ĐÃ ĐO: 0 trùng), nhưng đó là một phép chuyển tự viết (§4.20 cấm) và phụ thuộc phiên bản `i18n-iso-countries` (`^7.14.0`) lúc import | ĐÃ ĐO |
| **R4** | Không có scope trong file | import file account A vào account B. **Đang xảy ra được hôm nay**: tab Default làm việc trên account của **chip**, còn "Open matrix view" mở và export account **TopNav** (`DefaultTemplateTab.tsx:287`, `:303` — link không mang account; màn matrix không hề hiện tên account) ⇒ chip = B, TopNav = A ⇒ Manager export A, bấm Replace trên chip B ⇒ ghi giá A vào B | ĐỌC CODE |
| **R5** | Không có version | ghi đè thầm lặng bản người khác vừa upload. Guard duy nhất hôm nay là confirm dựa trên dữ liệu lúc tải trang (§1.1) — không thấy upload xảy ra sau đó; form không mang version; `replaceTemplate` xoá "header hiện tại của scope" chứ không xoá "header client đã thấy" (`templates.ts:634-644`) | ĐỌC CODE |
| **R6** | Đường đọc của export phân trang **không ORDER BY** | `fetchAllEntries` dùng `count` + `.range()` không `order` (`template-matrix.ts:212-229`). ⟲ **Có chủ đích**: Hotfix 24 dựa vào chính thứ tự heap này để giữ thứ tự cột Manager upload (`template-matrix.ts:145-153`) — thêm `ORDER BY tier_id, territory_code` sẽ đảo cột thành alphabet. Nhưng Postgres không cam kết thứ tự ổn định giữa các request ⇒ có thể **sót dòng** ⇒ ô đó export thành `·` ⇒ import lại thì **xoá override** | ĐỌC CODE · thực tế prod: CHƯA BIẾT |
| **R7** | `replaceTemplate` không bao giờ là no-op, và **không có transaction** | file y hệt vẫn sinh template id mới, uploaded_at/by mới, `origin_note` → NULL, upsert `price_tiers` **toàn cục**, thêm `import_batches` + `actions_log`. Xoá-rồi-chèn ~17 lô **không transaction** (`templates.ts:567-573`): đứt giữa chừng ⇒ mất phần chưa chèn. ⟲ Với format A, Manager còn file gốc để upload lại; **với B, DB là bản sao duy nhất của các ô không đụng** ⇒ đứt giữa chừng là **mất vĩnh viễn**, và lần thử lại bị 409 vì id đã đổi. Trong lúc ghi, orchestrator và bulk import đọc thấy template thiếu/vắng và **lùi về Apple** (`pricing-orchestration.ts:429-434`) | ĐỌC CODE |
| **R8** | Tên tier trong file đi vào bảng `price_tiers` toàn cục | một dòng tier gõ khác chữ ⇒ đổi tên tier cho **mọi** account/app (`templates.ts:619-632`) | ĐỌC CODE |
| **R9** | Nhập số theo locale (máy đo: `en_VN`, dấu thập phân `,`) | Excel biến `49,000` thành **số 49** (VND lệch 1000× — im lặng); `2.49` thành **CHỮ** `"2.49"`; parser A biến chữ `"1,99"` thành **199** và chữ `"49.000"` thành **49** | ĐÃ ĐO (Excel thật, nhập qua `formula local`; `readNumericCell`) |

> 2026-10-19: **R5** ⛔ **BỎ theo quyết định Manager 2026-10-19** (không dò xung đột). R1, R2, R3, R6, R7, R8 **đổi vai** theo
> ngữ nghĩa mới — xem §L2.3 và bảng §L2.7.

⇒ **Câu trả lời P2:** B **thưa** về ngữ nghĩa, và `·` là một dấu bền (sống qua Excel
và Numbers). Round-trip **khả thi**, nhưng **không phải** bằng cách nới parser A
cho nhận B. Cần (i) sửa export để file mang được scope + version + danh tính dòng/cột
+ phạm vi đã lọc, (ii) import B đối chiếu với server, gộp phần ngoài phạm vi, không
ghi khi không có gì đổi, (iii) **đường ghi phải nguyên tử** trước khi B được phép ghi.

---

## P3 — CƠ CHẾ NHẬN BIẾT "Ô MANAGER ĐÃ SỬA"

> ⛔ **BỎ theo quyết định Manager 2026-10-19**: toàn bộ P3 (M1, M2, M3, planner, `_import_info` làm thẻ
> phiên bản, digest, commit `plan_hash`). Manager chốt "KHÔNG cần cơ chế nhận biết ô đã
> sửa". Chỉ còn sống trong reader B: phân loại ô (bước 6) và kiểm cấu trúc (một phần bước 4)
> — xem §L2.4, §L2.7. M1 vẫn cấm.

### M1 — so với giá Apple hiện tại lúc import → ❌ loại

Ngoài hai lỗi brief đã nêu (Apple đổi giá giữa chừng ⇒ ô không đụng bị ghim giá cũ
thành override; Manager cố ý override bằng đúng giá Apple ⇒ bị coi là thừa hưởng),
M1 **còn không áp được vào B**: ô thừa hưởng trong B là `·`, không mang giá Apple
nào để so. Muốn làm M1 phải gọi Apple lúc import (175 nước × N tier), tức đưa một
nguồn sai đi vào đường ghi. Loại.

### M2 — nhúng ảnh chụp từng ô vào file → ⚠ chạy được nhưng thừa

Nhúng (giá + trạng thái) từng ô vào sheet ẩn; import so ô với ảnh chụp. Không dính
lỗi Apple đổi giá. Nhưng:
- **Chỗ chứa không bền**: `veryHidden` mất trong Numbers, `hidden` hiện ra cho
  Manager sửa (ĐÃ ĐO §2.3). Ảnh chụp bị sửa tay thì import tin vào một ảnh chụp sai.
- **Thừa**: B đã ghi trạng thái ngay trong giá trị ô (`·` / số), nên ảnh chụp từng ô
  chỉ còn việc phát hiện "đã đổi" — mà việc đó DB làm tốt hơn (M3).
- **File cũ** (export trước tính năng): không có ảnh chụp ⇒ từ chối (giống M3).

### M3 — ⭐ ĐỀ XUẤT: "ô tự nói trạng thái, ảnh chụp nằm ở server"

**Ý chính.** Ô B đã tự nói trạng thái của nó: **số = override ở giá đó**, **`·` =
không override** — đúng nghĩa Q-I của format A, chỉ khác cách viết (với giới hạn
P37 ở §2.2: chỉ sau khi digest khớp). Thứ còn thiếu là **biết file được export từ
bản template NÀO, và bản đó có còn nguyên không**. Hai lớp kiểm:

1. **`template_id` — điều kiện CẦN.** Mỗi lần REPLACE sinh id mới (ĐỌC CODE
   `templates.ts:647-657`; default `gen_random_uuid()`
   `20260519000000_iap_mgmt_pricing_templates.sql:24`). Id khác hoặc template đã bị
   xoá ⇒ có người đã REPLACE/Remove ⇒ **dừng** (ca f). Rẻ, và cho thông báo rõ.
2. **`covered_digest` — điều kiện ĐỦ.** ⟲ Id **không đổi** vẫn chưa chứng minh nội
   dung không đổi: không code nào UPDATE entry tại chỗ và INSERT duy nhất là
   `replaceTemplate` (ĐỌC CODE `templates.ts:676`), **nhưng** entry vẫn có thể bị
   **XOÁ dưới cùng một id** — `replacePriceTiers` (legacy) xoá mọi dòng
   `price_tiers` và FK `ON DELETE CASCADE` kéo theo entry của mọi template
   (`queries/price-tiers.ts:334-337`; `20260519000000:55`); SQL tay (Path G) cũng có
   thể sửa. Digest so nội dung DB **lúc import** với nội dung file **lúc export**,
   bắt được cả hai loại (đổi id hay không) lẫn R6 (export đọc sót). ⚠ Vì thế digest
   **không bao giờ được coi là thừa** — kể cả sau khi R6 được sửa (Phụ lục B).

Khi cả hai khớp ⇒ DB lúc này **chính là** trạng thái lúc export trên phạm vi file ⇒
**ảnh chụp đã có sẵn ở server**, đáng tin hơn mọi sheet ẩn trong file.

**Sheet thông tin `_import_info`** (thêm vào export, `state: hidden`, đặt SAU sheet
chính — đề xuất, chờ chốt ở P7). ⟲ Manifest được **tính ở route** (từ
`AppleMatrixResult.header`, `visibleMarkets`, `matrix.cells`) qua một module
server-only dùng `node:crypto`; writer chỉ **serialise** nó — giữ writer "zero data
logic" (§21.1; `xlsx-template-matrix-export.ts:21-24`), và giữ `node:crypto` ngoài
mọi module mà client có thể import (§21.3).

| Khoá | Ví dụ | Dùng để | Tin hay kiểm? |
|---|---|---|---|
| `format` / `version` | `apple-template-matrix` / `1` | nhận diện format (§5.3), từ chối version lạ | kiểm |
| `scope` + `account_id` hoặc `app_id` (+ `bundle_id` để báo lỗi dễ đọc) | `ACCOUNT` / `vng-corp` | khoá scope (§4.1) | **so với scope đích từ request** |
| `template_id`, `template_uploaded_at`, `template_uploaded_by` | uuid · ISO · email | thẻ phiên bản (ca f) + nội dung thông báo xung đột | **so với DB** |
| `template_market_order` | toàn bộ mã nước của template, đúng thứ tự cột màn đang hiện | giữ thứ tự cột khi ghi (Hotfix 24, ⟲ §4.5) + biết file có bị lọc không | **tập hợp phải bằng tập nước trong DB** |
| bảng **cột** của file: vị trí → `territory_code`, `header_text` | `B` → `VNM`, `Vietnam` | danh tính nước — không bao giờ đảo tên → mã (R3, §4.3) | **mã phải duy nhất và có trong DB; header file phải bằng `header_text`** |
| bảng **dòng**: vị trí → `tier_id`, `tier_name` | `3` → `FREE`, `Free Tier` | danh tính tier (§4.4) | ⟲ **tập tier_id phải BẰNG tập tier của template trong DB** (không có lọc tier); `tier_name` phải bằng `price_tiers.tier_name` hiện tại; cột A của file phải bằng `tier_name` |
| `covered_entry_count`, `covered_digest` | `16625` · `sha256:…` | điều kiện ĐỦ ở trên | **tính lại từ DB** |

`covered_digest` = SHA-256 của: bảng dòng + bảng cột (theo vị trí) + các dòng
`tier_id⇥territory_code⇥currency⇥canon(price)⇥canon(proceeds)` đã sort của **đúng các
entry nằm trong phạm vi file**. ⟲ Đưa hai bảng danh tính **vào** digest: một manifest
bị sửa (ví dụ Manager sort riêng cột `tier_id` trong sheet Numbers đã làm hiện ra —
lane phản biện đã dựng được ca này: file **không sửa gì** mà giá TIER_2 và TIER_10
đổi chỗ cho nhau) sẽ làm digest server tính lại lệch với digest trong file.

**Thuật toán import B (planner thuần, không I/O, không gọi Apple):**

```
vào:  file đã đọc (manifest + các ô thật sự có trong sheet)
      · scope đích (từ REQUEST — màn Manager đang đứng — không từ file)
      · template hiện tại của scope đích: header + entries (đọc có ORDER BY, chỉ dùng
        để so/digest — KHÔNG BAO GIỜ dùng làm thứ tự hiển thị)
      · price_tiers.tier_name hiện tại

1  manifest hợp lệ (format, version, đủ khoá, kiểu đúng)  sai → 422 MANIFEST_INVALID
2  manifest.scope == scope đích                            sai → 409 SCOPE_MISMATCH
3  template hiện tại tồn tại && id == manifest.template_id sai → 409 TEMPLATE_CHANGED (kèm ai/lúc nào)
4  đối chiếu danh tính với SERVER và cấu trúc file:
     – tier_id trong bảng dòng duy nhất, tập == tập tier của template trong DB;
       manifest.tier_name == price_tiers.tier_name(tier_id); cột A file == tier_name
     – territory_code trong bảng cột duy nhất, đều có trong DB; header file == header_text;
       tập template_market_order == tập nước trong DB
     – "Price"/"Currency" đúng chỗ
     – không có ô MANG GIÁ TRỊ (khác rỗng, khác stub) nào ngoài lưới manifest —
       duyệt các khoá ô thật sự tồn tại, không dựa vào !ref (miễn nhiễm <dimension> phồng
       và ô đệm của Numbers)                                sai → 422 STRUCTURE_CHANGED (kèm địa chỉ ô)
5  digest(DB ∩ phạm vi, bảng danh tính) == manifest.covered_digest
                                                           sai → 409 FILE_DB_MISMATCH
                                                           ("file và template hiện tại không khớp —
                                                            export lại"; nguyên nhân có thể là export
                                                            đọc sót HOẶC entry bị xoá dưới cùng id)
6  phân loại từng ô Price trong phạm vi (đọc { cellFormula: true, sheetStubs: true }):
     ô có .f (bất kể .t/.v)                       → KHÔNG HỢP LỆ (công thức) — kiểm .f TRƯỚC .v,
                                                     vì công thức không có cache đọc ra {t:"z", v:0}
     t='n', hữu hạn, ≥ 0, < 9e11, Math.round(x·1e4)/1e4 === x  → SỐ
     chuỗi `·` sau trim                            → `·`
     không có ô / t='z' không .f / chuỗi rỗng      → TRỐNG
     chuỗi trông như số                            → theo Manager chốt Q11
     còn lại                                       → KHÔNG HỢP LỆ
   ô Currency: chỉ được `·`, trống, hoặc đúng currency của ô (quy tắc ở bước 7)
                                                           có KHÔNG HỢP LỆ → 422, liệt kê HẾT địa chỉ
7  dựng trạng thái mong muốn:
     trong phạm vi:  SỐ p  → có entry DB và canon bằng nhau ⇒ GIỮ NGUYÊN DÒNG DB (currency + proceeds)
                             có entry DB, canon khác   ⇒ {canon(p), currency CỦA DÒNG DB, proceeds: null}
                             không có entry DB         ⇒ {canon(p), currency = currency DUY NHẤT của nước
                                                          đó trong template; 0 hoặc ≥2 currency ⇒ 422 ô đó,
                                                          không đoán; không bao giờ lấy từ manifest}
                     `·`   → không entry
                     TRỐNG → theo Manager chốt ca d (đề xuất: không entry)
     ngoài phạm vi (nước bị lọc): GIỮ NGUYÊN DÒNG DB
8  diff(DB, mong muốn) theo khoá (tier_id, territory_code), so TOÀN DÒNG
   (currency_code, canon(price), canon(proceeds)); rỗng ⇒ NO_CHANGE — KHÔNG GHI GÌ
9  trả plan + plan_hash = hash(danh sách mong muốn theo thứ tự ghi + template_id)
```

**Thứ tự ghi** ⟲: planner xếp danh sách mong muốn **theo nước** (đúng thứ tự
`template_market_order`), trong mỗi nước theo thứ tự dòng. `composeMatrix` dựng thứ
tự cột từ lần xuất hiện đầu tiên của mỗi nước trong luồng đọc
(`template-matrix.ts:145-161`), nên chèn theo nước thì thứ tự cột sau khi ghi **đúng
bằng** thứ tự Manager đang thấy — cùng giả định "heap order = insertion order" mà
Hotfix 24 đang dựa vào. (Format A vẫn chèn theo tier như hôm nay.)

**Commit** ⟲: client gửi lại file + `intent=commit` + `plan_hash`; server chạy lại 1–9,
đòi `plan_hash` khớp (thứ được ghi = đúng thứ Manager đã xem), rồi gọi **một
function Postgres** làm trong **một transaction**: khoá header của scope →
`id == expected` (sai ⇒ `RAISE` mã TEMPLATE_CHANGED) → số entry hiện tại == số
planner đã đọc (sai ⇒ TEMPLATE_CONTENT_CHANGED — chặn ca cascade chen vào giữa lúc
planner đọc và lúc ghi) → xoá header (CASCADE) → chèn header → chèn entries theo
đúng thứ tự mảng (`WITH ORDINALITY`). Đứt ở bất kỳ đâu ⇒ **rollback, template cũ
còn nguyên**; người đọc đồng thời thấy bản cũ hoặc bản mới, không bao giờ thấy nửa
vời (MVCC). Nhánh B **không upsert `price_tiers`** (B không thêm được tier — §4.8 —
nên không có gì để upsert, và không bao giờ đổi tên tier toàn cục, R8). Audit
(`import_batches` + `actions_log`) ghi **sau** khi function trả về, kiểm `error` của
từng insert (P2); xung đột ⇒ **không** ghi batch FAILED, chỉ log WARN. Route map
xung đột sang **409**, không phải 500 (hôm nay mọi lỗi của `replaceTemplate` thành
500 — `route.ts:210-214`). Đường ghi cho cả A lẫn B: P7-Q15.

**Bảy ca bắt buộc — với M3:**

> 2026-10-19: ca **f** **BỎ theo quyết định Manager 2026-10-19**; ca **g** đổi thành "file không có mã nước ⇒
> từ chối"; ca **b, c** đổi (proceeds NULL, currency ô mới theo Q-D); ca **d** đã chốt bởi luật 3.
> Xem §L2.5.3.

| Ca | Kết quả | Vì sao |
|---|---|---|
| **a** ô không sửa, đang thừa hưởng | vẫn thừa hưởng | ô vẫn là `·` ⇒ không entry (bước 7), digest đã xác nhận `·` này là "không có entry" (bước 5) |
| **b** ô không sửa, đang override | vẫn override, **đúng dòng DB cũ** (cả currency + proceeds) | canon bằng nhau ⇒ giữ nguyên dòng — kể cả khi Excel đã ghi lại `<v>` 17 chữ số (ĐÃ ĐO: SheetJS đọc ra đúng double) |
| **c** ô sửa | override giá mới, `proceeds = NULL` (proceeds cũ thuộc giá cũ) | canon khác ⇒ dòng mới, currency lấy từ dòng DB. `·` → số = override mới (currency: quy tắc bước 7); số → `·` = bỏ override |
| **d** ô Manager XOÁ TRỐNG | **HỎI Manager** (P7-Q2). Đề xuất: **= bỏ override → thừa hưởng**, giống Q-I của A, và preview hiện rõ "override → thừa hưởng". Đo được: xoá ô Price trong Excel ⇒ ô mất `<v>`, ô Currency bên cạnh **vẫn giữ** `USD` ⇒ thiết kế bỏ qua ô Currency khi Price trống | ĐÃ ĐO (Excel `edit_clear`) |
| **e** Apple đổi giá nền giữa export và import, ô không sửa | vẫn thừa hưởng, đi theo giá Apple **mới** | ô là `·`, không mang giá; planner **không đọc giá Apple** ở bất kỳ bước nào ⇒ không thể có so sánh với Apple. ⟲ Đường import B cũng không gọi Apple **lần nào**: B phân giải app bằng DB, không qua `getApp` (§4.1) |
| **f** người khác sửa template giữa export và import | **phát hiện được, dừng, không ghi** | REPLACE nào cũng đổi `template_id` ⇒ bước 3 ⇒ 409 kèm "ai/lúc nào"; xoá entry dưới cùng id ⇒ bước 5 ⇒ 409; đua đúng lúc ghi ⇒ kiểm trong transaction ⇒ 409. Dương tính giả: người khác upload **y hệt** ⇒ vẫn 409 (an toàn: export lại là xong). ⟲ Chính mình bấm commit **hai lần** (mất response) ⇒ lần 2 thấy id đã đổi; server tra `actions_log` của scope, thấy template hiện tại sinh từ đúng `plan_hash` này ⇒ trả "đã ghi ở lần trước", không nói "bị người khác thay". Nút commit khoá theo một ref "đã commit" vĩnh viễn, không theo cờ tạm (P12) |
| **g** file thiếu `_import_info` (export cũ, hoặc sheet bị xoá) | **từ chối rõ ràng**, không lùi về M1 | "không biết thì không ghi" (KB P7 :3220; §32.10 — REFUSE là kết quả hạng nhất). Thông báo: "File này export trước khi có tính năng import lại / thiếu sheet thông tin — export lại từ Open matrix view" |

---

## P4 — CÁC CHỖ KHÁC DỄ SAI

### 4.1 Phạm vi (scope) — CHẶN import chéo account / chéo app

- **Hôm nay file B không có scope** (ĐÃ ĐO §1.2). Đề xuất nhúng vào `_import_info`.
- **Scope đích luôn đến từ REQUEST** (màn Manager đang đứng), **không bao giờ từ
  file**: file chỉ dùng để đối chiếu. Để file tự chọn đích ghi là đúng cái
  "never-from-the-client contract" đi ngược chiều (KB §25.2, P35 tại :6687).
- Default: giữ nguyên cổng hiện có — admin **trước** mọi tra cứu (KB §25.1, P34 tại
  :6668; code đang đúng thứ tự `route.ts:97` trước `:135`), `account_id` bắt buộc từ
  client và đối chiếu danh sách account thật (`route.ts:122-142`). Rồi mới so với
  `manifest.account_id`.
- Per-App: ⟲ nhánh B **chỉ nhận `app_id` (UUID nội bộ)** và phân giải bằng DB.
  Nhánh `apple_app_id` hôm nay gọi `getApp` Apple rồi `ensureAppRegistered` (một lần
  ghi DB) **trước** khi parse (`route.ts:145-155`) — B không đi đường đó: B đòi
  template đã tồn tại, nên app chắc chắn đã đăng ký; app lạ ⇒ 409. Nhờ vậy preview
  B **không ghi gì và không gọi Apple**. ⚠ Hôm nay route upload APP và export Per-App
  đều **không** kiểm app thuộc account nào — việc có sẵn, ngoài phạm vi; thiết kế
  này chỉ thêm `manifest.app_id == app_id đích`.
- **Lỗ hổng R4 hiện tại**: màn Default matrix phải **nói ra** nó đang hiển thị
  account nào (KB §19.9 tại :6272-6276: "the unsaid inference is the defect"). Với
  nút import đặt trên chính màn matrix (P7-Q12), đích ghi = đúng account màn đang
  hiện, gửi tường minh `account_id` từ props của server component.

### 4.2 Số — round-trip từng ô

| Phép đo | Kết quả | Nhãn |
|---|---|---|
| 18 giá trị (0 · 0.99 · 1.99 · 0.1 · 0.3 · 1.999 · 4.9 · 9.9 · 35 · 49000 · 12345.6789 · 99999.9999 · 0.0001 · 1234567.89 …, cộng chuỗi `"1.9900"`, `"49000.0000"`, `"0.9900"`) qua exceljs → SheetJS | **bit-identical**; chuỗi được ghi dạng ngắn nhất (`"1.9900"` → `<v>1.99</v>`) | ĐÃ ĐO |
| `<v>` kiểu Excel 17 chữ số (`1.9899999999999999`, `12345.678900000001`, `4.9000000000000004`, `1.99E0`) | đọc ra **đúng double gốc** | ĐÃ ĐO |
| Double khác thật (kết quả công thức: `0.30000000000000004`, `1.9899999999999998`) | `!==` gốc, chỉ bằng sau chuẩn hoá 4 chữ số | ĐÃ ĐO |
| `Math.round(x·1e4)` an toàn | chỉ khi `|x| < ~9.007e11` (x·1e4 < 2⁵³): đúng ở `900719925474.0991`, **sai** ở `987654321098.7653` — xa dưới trần cột NUMERIC(18,4). Giá thật (VND ~2.5e8) nằm sâu trong vùng an toàn | ĐÃ ĐO |
| PostgREST trả `NUMERIC` là số hay chuỗi? | CHƯA BIẾT — comment trong code tự mâu thuẫn; một phép đo một dòng ở Phụ lục A | CHƯA BIẾT |
| `NUMERIC(18,4)` có làm tròn nhiễu float khi INSERT? | CHƯA BIẾT (máy không có Postgres) | CHƯA BIẾT |

**Quy tắc (ghim bằng test):**
- So sánh: một hàm duy nhất `canon(x) = Math.round(Number(x) * 1e4)` cho **cả hai
  phía** (giá trị DB — có thể là chuỗi; giá trị file). Từ chối `|x| ≥ 9e11`.
- ⟲ Nhận một ô số khi **`Math.round(x*1e4)/1e4 === x`**. Quy tắc cũ của bản nháp
  (`|x·1e4 − round| > 1e-6`) **sai**: nó từ chối chính giá trị `1234567.89` trong
  bảng đo (và ~12 % số 4-chữ-số-thập-phân trong khoảng `[0, 1e9)` — ĐÃ ĐO), làm bài số
  một đỏ trên file không sửa gì. Quy tắc mới nhận mọi giá trị hợp lệ kể cả dạng
  17 chữ số của Excel, từ chối `1.99999`, `0.30000000000000004` (ĐÃ ĐO). Một double
  tính ra (0.1+0.2) bị **từ chối chứ không làm tròn** — chiều an toàn.
- Dòng **mới** ghi `canon(p)/1e4`; dòng **không đổi** giữ nguyên dòng DB.

⚠ Vì sao chuyện này không chỉ là thẩm mỹ: bulk import phân giải tier bằng **`===`
tuyệt đối** trên giá USA (`tier-order.ts:100-109`), trong khi đường ghi Apple dung
sai 0.001 (`price-points.ts:101-115`). Một giá USA lệch 1 ulp làm tier đó **không
phân giải được** trong bulk import (ĐÃ ĐO: `cands(1.9900000000000002) = []`).

### 4.3 Territory

- B dùng **tên** (`territoryName`), A dùng **alpha-3 trong header**; DB lưu alpha-3
  (`price-tiers.ts:191-195`).
- KB §4.20 (:964) cấm tự viết phép chuyển alpha-2/alpha-3. Đảo tên → mã còn tệ hơn:
  `i18n-iso-countries.getAlpha3Code` **đảo hỏng** 4/175 nước (`CHN` "China
  mainland", `LAO`, `MAC`, `XKS`) — ĐÃ ĐO.
- ⇒ **Danh tính nước lấy từ bảng cột của `_import_info`** (mã nguyên văn từ DB),
  được **đối chiếu với DB** (mã phải có trong template). Chữ header file chỉ dùng
  để kiểm vị trí: header cột i phải bằng `header_text` cột i trong manifest. ⟲ Bản
  nháp còn đòi header == `territoryName(code)` **hiện tại**; bỏ, vì nó buộc mọi file
  đã export vào phiên bản `i18n-iso-countries` (`^7.14.0`, `package.json:34`) — một
  lần bump minor đổi tên một nước là mọi file cũ bị từ chối (KB P41). Kiểm "mã có
  trong DB" + digest đã đủ chặn manifest bị sửa.

### 4.4 Tier

- B có cả tier thường lẫn `ALT_*` (ĐÃ ĐO). Danh tính: **`tier_id` theo dòng trong
  manifest**, ⟲ đối chiếu ba chiều: tập `tier_id` == tập tier của template trong DB
  (không có lọc tier, nên mọi tier có entry đều phải có dòng); `manifest.tier_name ==
  price_tiers.tier_name(tier_id)`; chữ ở cột A == `tier_name`. Không dựa vào thứ tự.
- Hai bộ sắp xếp tier trong repo — `compareTierId` (`tier-order.ts:61-78`) và
  `compareTiers` của composer (`template-matrix.ts:78-90`) — **cho cùng kết quả trên
  dữ liệu thật** (ĐÃ ĐO), lệch trên `ALT_1A` vs `ALT_2` (chỉ là tiềm ẩn). Thiết kế
  không phụ thuộc thứ tự tier nên không bị ảnh hưởng.
- Nhánh B **không upsert `price_tiers`** ⇒ import B **không bao giờ đổi tên tier
  toàn cục** (R8), và không thể ghi đè một lần đổi tên do người khác làm giữa
  preview và commit.

### 4.5 Khoá hiện có — hội tụ về đường ghi A (P1)

- ⟲ **Điểm hội tụ là `FlatTemplateEntry[]`** — đúng dạng dòng DB, và đúng thứ format
  A tạo ra qua `flattenTemplateEntries(parsed)` (`price-tiers.ts:317-333`) — rồi đi
  **chung một hàm ghi**. `replaceTemplate` hôm nay việc đầu tiên đã là flatten
  (`templates.ts:581`), nên đổi tham số sang danh sách phẳng (kèm metadata tier tuỳ
  chọn) không mở đường ghi thứ hai. ⇒ **Khả thi: CHẮC.**
- **REPLACE-ONLY (Q-A, KB:179) giữ nguyên**: lệnh ghi vẫn thay toàn bộ template.
  Phần "gộp" (giữ nước ngoài phạm vi, giữ dòng không đổi) làm **trước** lệnh ghi,
  trong planner thuần. ⚠ Backlog Google kết luận round-trip cần "**một chế độ ghi
  thứ hai**" (`docs/google-iap-management/BACKLOG.md:66-67`). File này chọn cách đọc
  khác, nói rõ ra: **một** hàm ghi, ngữ nghĩa thay-toàn-bộ không đổi; khác biệt nằm
  ở chỗ *tập mong muốn được dựng từ đâu*, không ở chỗ ghi.
- **Q-K (fail-soft)** không bị đụng: entry nào không khớp price point Apple vẫn ra
  `partial-template-fail` ở lần định giá sau, như hôm nay.
- **Không nới `parsePriceTiersXlsx`**: parser này còn một consumer thứ hai là route
  legacy `POST /api/iap-management/pricing-tiers` → `replacePriceTiers`
  (`app/api/iap-management/pricing-tiers/route.ts:58`). B có reader riêng, A giữ
  nguyên từng byte.
- **Twin Google: NGOÀI PHẠM VI** (P8). Google có writer, `replaceTemplate` và cột
  `sort_order` riêng (KB §25.7) — khác Apple ở đúng chỗ thứ tự cột. Arc này chỉ cập
  nhật câu `BACKLOG.md:66-70` mô tả gap của Apple (sẽ lỗi thời).

### 4.6 Cột USA mang hai nghĩa

Ô USA của template **bị loại khỏi danh sách override** gửi Apple
(`pricing-orchestration.ts:436-438`; base của orchestrator luôn là USA — không
caller nào truyền `baseTerritory`, `:314`; `iaps.base_territory` chỉ đi vào
`customPricesDivergeFromApple`, `update-on-apple/route.ts:271-278`). Nhưng với nguồn
template, bulk import lấy **chính ô USA/USD đó** làm (i) danh sách tier hợp lệ và
(ii) **giá base USD** gửi Apple (`listUsdTiersForSource`, `templates.ts:298-328`;
`bulk-import/execute/route.ts:488`, `:567-569`). Còn single create/update lấy base từ
bảng legacy `price_tier_territories`. — ĐỌC CODE.

⇒ Sửa ô USA trong B **không** đổi giá USA khi tạo lẻ, nhưng **đổi tier nào bulk
import chấp nhận VÀ đổi giá base USD gửi Apple** cho IAP tạo bằng bulk import nguồn
template; xoá ô USA làm tier đó **không dùng được** trong bulk import nguồn template.
⇒ Preview phải **gắn cờ riêng** mọi thay đổi ở cột USA với đúng câu đó.

### 4.7 Ô chữ, công thức, locale, vùng ô

- **Ô chữ trông như số** — sinh ra theo hai đường đã đo: Excel `en_VN` khi nhập
  `2.49`, và ⟲ **mọi** lần nhập số vào ô `·` của một file đã qua Numbers (Numbers gắn
  `@`). Không dùng `readNumericCell` (nó xoá mọi dấu phẩy ⇒ `"1,99"` → 199). Lựa chọn
  ở P7-Q11.
- **Ô công thức** ⟲: phải đọc với **`{ cellFormula: true, sheetStubs: true }`** — chỉ
  `cellFormula: true` thì công thức **không có giá trị cache** vẫn biến mất (đọc như
  ô trống ⇒ theo ca d thành "bỏ override" im lặng). Với cả hai cờ, nó hiện ra là
  `{t:"z", f:"…", v:0}` ⇒ phải kiểm `.f` **trước** `.v`, không thì đọc thành giá 0
  (ĐÃ ĐO, exceljs ghi `{formula}` không `result` đúng dạng này).
- `49,000` → số 49 trên máy `en_VN` (ĐÃ ĐO) **không phát hiện được ở tầng parse**. Chỗ
  duy nhất lộ ra là preview: gắn cờ đỏ khi giá mới / giá cũ > 10× hoặc < 0.1×. ⟲ Với
  **override mới** (`·` → số) không có giá cũ để so: so với các tier kề nhau trong
  cùng cột (thang giá theo tier phải đơn điệu) và, với Per-App, với giá Default của
  cùng ô; gãy thang hoặc lệch > 10× ⇒ cờ đỏ. Cờ chỉ cảnh báo, không chặn.
- `<dimension>` phồng (`A1:XFD1048576`) làm `sheet_to_json(defval:'')` chạy > 60 s
  trên một file **17 KB** — trần 10 MB không chặn được — **trong route Node**, chặn
  event loop của service `web` (ĐÃ ĐO; rủi ro **có sẵn** ở parser A — Phụ lục B).
  Reader B **không** gọi `sheet_to_json` trên `!ref`: nó duyệt các khoá ô thật sự có
  trong object sheet (O(số ô), miễn nhiễm `<dimension>`). Nhận diện format dùng
  `XLSX.read(buf, { bookSheets: true })` (chỉ đọc tên sheet — đo: 1 ms trên file
  `<dimension>` phồng).
- Số âm, `0b11`, `0x10`, `1e3` đều lọt `readNumericCell`; DB không có CHECK nào trên
  `customer_price`. Reader B chỉ nhận ô kiểu số `≥ 0` (và chuỗi theo Q11).

### 4.8 Sửa cấu trúc

v1 đề xuất **chỉ cho sửa giá trị ô Price trong lưới có sẵn**. Thêm/xoá/đổi chỗ
dòng hoặc cột, đổi tên header/tier ⇒ từ chối kèm địa chỉ ô. ⟲ Nói thẳng hệ quả:
tier/nước **chưa có entry nào** thì không có dòng/cột trong B, nên B không thêm được
chúng; và vì không có export A cũng như nút tải template trống (§1.1), "dùng format
A" nghĩa là **tự dựng tay một file A đầy đủ** — đúng đường dẫn tới R1–R3. Một lối
khác (P7-Q10): export thêm dòng cho **mọi** tier trong `price_tiers` (toàn `·` nếu
trống) để thêm override cho tier mới chỉ là sửa giá trị ô — nhưng làm file khác màn
(§21.1).

---

## P5 — PHƯƠNG ÁN TỔNG

### 5.1 Các phương án

**(a) Chỉ sửa EXPORT** — thêm `_import_info`. File chưa import được; là **điều kiện
cần** của (c) và (d). ~4 file nguồn + 3–4 test. Rủi ro thấp. CHẮC.

**(b) Chỉ thêm parser nhận B như hôm nay** (đổi tên sheet, đảo tên → mã, `·` = trống)
→ ❌ **không đạt yêu cầu**: R1 (file lọc xoá dữ liệu), R2 (mất proceeds), R4 (không
chặn được sai account — kể cả ca chip ≠ TopNav đang tồn tại), R5 (không phát hiện
được ca f), R6, R7 đều còn nguyên; ca f và g không có lời giải. Nêu ra để loại.

**(c) ⭐ (a) + reader B + planner M3 + preview + hàm ghi nguyên tử** — đề xuất.

> ⛔ **BỎ theo quyết định Manager 2026-10-19** (M3). Phương án hiện hành: PA1/PA2/PA3 ở §L2.4.

| | |
|---|---|
| Làm gì | **Export:** route dùng `result.header` (hôm nay bị bỏ, `route.ts:172`), gọi `loadBundleId` **trước** khi dựng workbook (hôm nay sau, `:241-242`), tính manifest server-side, **từ chối (500) nếu thiếu `template_id`** — không bao giờ ghi manifest thiếu id; writer thêm `_import_info` **sau** sheet chính (đo: `sheet1.xml`, rels và `comments1.xml` giữ nguyên từng byte, danh sách shared string cũ là tiền tố của danh sách mới). **Import:** reader B (SheetJS, tìm sheet theo tên); planner thuần (P3); route upload hiện có thêm nhánh nhận diện + giao thức `intent` (§5.3); `replaceTemplate` nhận danh sách phẳng + gọi function Postgres nguyên tử; nút **"Nhập file đã sửa"** cạnh **"Export XLSX"** trên Matrix view (P7-Q12) + modal preview; màn Default matrix hiện tên account |
| Số file (ước) ⟲ | **nguồn ~15–16**: `xlsx-template-matrix-export.ts`, `matrix-export/route.ts`, **mới** `template-matrix-file/spec.ts` (hằng số dùng chung writer↔reader, không crypto — theo tiền lệ `parsers/template-spec.ts:1-10`), **mới** `template-matrix-file/manifest.ts` (server-only, digest), **mới** `parsers/template-matrix-file.ts`, **mới** `template-reimport/plan.ts`, `pricing-templates/route.ts`, `queries/templates.ts` (danh sách phẳng, lỗi xung đột có kiểu, gọi function), **mới** helper client + kiểu response dùng chung (P29), **mới** `MatrixImportButton.tsx`, **mới** `TemplateReimportPreviewModal.tsx`, `MatrixFilterBar.tsx` hoặc hai view, `DefaultMatrixView.tsx` + `default-matrix/page.tsx` (tên account, vai trò, `account_id`), `per-app-matrix/[appId]/page.tsx` · **migration 1** (function) · **test ~10–12 file**: 6–8 mới (reader, planner, route nhánh B, round-trip với fixture app thật, function/queries, wiring hai màn) + sửa `excel-library-split.structural.test.ts` (reader B; và vá điểm mù `await import("xlsx")`), `matrix-export/route.test.ts` (5 chỗ mock `header: {}` phải thành header thật), 2–3 test writer (chữ ký mới) · **docs 5**: KB, `pricing-templates-guide.md`, `docs/user-docs/index.html` (callout `:2042-2043` + mâu thuẫn `:4246`/`:4344`), `TODO.md`, `docs/google-iap-management/BACKLOG.md:66-70` |
| Rủi ro | function nhận ~16 600 entry qua một lời gọi RPC (~1.5–2 MB JSON) — giới hạn kích thước request của Supabase/PostgREST: **CHƯA BIẾT**, đo ở UAT; nếu vượt, cần bảng staging (đổi schema). Non-transaction của đường ghi A: tuỳ Q15. Google Sheets: CHƯA BIẾT |
| CHẮC | hội tụ về `FlatTemplateEntry[]` + một hàm ghi; `·` + số sống qua Excel/Numbers; thẻ phiên bản đổi ở mỗi REPLACE; manifest đủ dữ liệu từ route hiện có (đo); thêm sheet không làm đỏ test nào (không test nào đếm số sheet — grep) |
| CHƯA BIẾT | Google Sheets; PostgREST trả NUMERIC dạng gì; NUMERIC có hút nhiễu float; mặc định "summary worksheet" của UI Numbers; UUID/ISO/digest qua Numbers; giới hạn kích thước RPC |

**(d) (a) + đổi B sang đúng bố cục A** (`Vietnam (VNM_VND)`, `Price | Proceeds`, ô
trống thay `·`) rồi import B bằng parser A + planner.
- Lợi: một parser.
- Hại: phá §21.1 (header khác màn, cột Currency biến mất); bỏ dấu `·` đã được chọn
  có chủ đích để tránh "một giá trị hai nghĩa" (`xlsx-template-matrix-export.ts:68-78`);
  đưa proceeds vào file ⇒ phát sinh câu hỏi "Manager sửa proceeds thì sao"; ô trống
  trong A lại mang hai nghĩa (chưa bao giờ có / vừa bị xoá). Vẫn cần `_import_info`
  và hàm ghi nguyên tử. ⇒ **Không đề xuất.**

> Ngoài lề, để Manager cân nhắc: **(e) sửa ô ngay trên Matrix view** (không qua file)
> tránh được mọi rủi ro Excel/locale/Numbers ở P2/§4.7, nhưng là một arc UI lớn hơn
> và nằm ngoài brief. Nó vẫn cần hàm ghi nguyên tử + thẻ phiên bản.

### 5.2 Bảng so sánh nhanh

| | (a) | (b) | **(c)** | (d) |
|---|---|---|---|---|
| Bài số một (import nguyên trạng ⇒ 0 đổi) | — | ❌ (R1, R2, R7) | ✅ | ✅ nếu có planner |
| Ca e (Apple đổi giá) | — | ✅ | ✅ | ✅ |
| Ca f (người khác sửa) | — | ❌ | ✅ | ✅ |
| Chặn sai scope | — | ❌ | ✅ | ✅ |
| Đứt giữa chừng không mất dữ liệu | — | ❌ | ✅ (function nguyên tử) | ✅ nếu có |
| Giữ §21.1 | ✅ | ✅ | ✅ (sheet chính không đổi) | ❌ |
| Proceeds | — | mất | giữ (ô không đổi) | phải đưa vào file |

### 5.3 Nhận diện format + giao thức preview/commit ⟲

> 2026-10-19: nhận diện theo tên sheet **giữ** (tinh thành luật 0–3, §L2.4). Giao thức
> `intent`/`plan_hash` và mã `TEMPLATE_CHANGED`/`FILE_DB_MISMATCH` **BỎ theo quyết định Manager 2026-10-19**; `PREVIEW_REQUIRED`
> chỉ còn nếu Manager chọn preview bắt buộc (Q-F).

Phía server, trên **cùng** route upload, **sau** cổng auth + phân giải scope (dùng
chung, không tạo route song sinh):

0. `file.size > 10 MB` ⇒ gọi thẳng `parsePriceTiersXlsx(file)` (giữ nguyên thông
   báo + thứ tự kiểm cũ; B dùng cùng trần).
1. Nhận diện bằng `XLSX.read(buf, { bookSheets: true })` — chỉ tên sheet.
2. `SheetNames[0] === "price_tiers"` ⇒ **A**, đi đường cũ **nguyên vẹn**.
3. Có sheet tên `_import_info` (tìm theo tên — Numbers chèn `Export Summary` lên đầu)
   ⇒ **B**.
4. Có sheet `Default Template` / `Per-App Template` nhưng **không** có `_import_info`
   ⇒ từ chối: "file export trước khi có tính năng / sheet thông tin đã bị xoá —
   export lại".
5. Còn lại ⇒ **gọi** `parsePriceTiersXlsx(file)` nguyên văn — không chép thông báo
   lỗi của nó (SheetJS đọc mọi byte rác thành một sheet `Sheet1`, ĐÃ ĐO; và 11 test
   `route.scope-rejection.test.ts` gửi body 1 byte `"x"` với parser được mock — chỉ
   xanh được nếu nhánh này **ủy quyền** cho parser).

**Giao thức B** (P47 + P5): form có thêm trường **`intent`**:
- `intent=preview` ⇒ 200 `{kind: "preview", …}` — **không bao giờ** mang
  `template_id` hay `inserted_entry_count`, không ghi gì.
- `intent=commit` + `plan_hash` ⇒ lời gọi **duy nhất** được ghi.
- File B tới theo **dạng request cũ** (không `intent` — tức từ một trong 3 nút
  upload format A, hoặc tab mở từ trước deploy) ⇒ **409 `PREVIEW_REQUIRED`**, 0 lần
  ghi, thông báo: "Đây là file export từ Matrix view — dùng nút **Nhập file đã sửa**
  trên Matrix view". Vì sao 409 mà không 200: cả 3 nút upload A coi **mọi 2xx là "đã
  thay"** (`DefaultTemplateTab.tsx:113-128`, `PerAppTemplateTab.tsx:118-133`,
  `AppPricingTemplateSection.tsx:68-81`) — một preview 200 lọt vào đó sẽ hiện toast
  "đã thay — 0 ô" trong khi không có gì được ghi.

Không hỏi Manager chọn format: tên sheet của hai format rời nhau, nên không có ca mơ
hồ thật. Preview **nói ra** format đã nhận diện. (P7-Q6.)

### 5.4 Migration — một function, không đổi bảng ⟲

> 2026-10-19: **đổi** — dưới ngữ nghĩa mới B **không cần** migration (re-upload đúng file chữa
> được lần ghi đứt — ĐÃ ĐO). Function nguyên tử thành gia cố tuỳ chọn cho cả A lẫn B (PA3,
> §L2.4). Các tham số `expectedTemplateId` / `expectedEntryCount` / `plan_hash` **BỎ theo quyết định Manager 2026-10-19**.

Bản nháp nói "không cần migration". **Sai**, vì BLOCKER R7: không có transaction thì
B không được phép ghi. supabase-js không có transaction phía client
(`templates.ts:567-573`); cách duy nhất là một function Postgres. Repo đã có tiền lệ
(`supabase/migrations/20260423000000_store_mgmt_ticket_engine_rpc.sql`, module Store).

- **1 migration**: `CREATE FUNCTION iap_mgmt.replace_template_tx(...)` — không thêm
  bảng, không thêm cột, không đổi CHECK. Theo checkpoint migration của CLAUDE.md:
  **Manager chạy SQL + verify queries trong Supabase SQL Editor; chặn PUSH, không chặn
  code**. SQL + verify ship trong báo cáo trước khi code xong.
- Audit **không** cần migration: dùng lại `action_type = 'PRICE_TIER_IMPORT'` — có
  trong CHECK hiện hành (lần định nghĩa lại cuối cùng theo tên file:
  `supabase/migrations/20260817000000_iap_mgmt_actions_log_set_territories.sql:51-61`)
  — và `import_batches.template_version` là `TEXT` **không CHECK**
  (`20260515000000_iap_mgmt_init.sql:161`). Thêm action_type mới mới cần migration
  (bẫy P2).
- `replaceTemplate` cần thêm tham số, nói đủ ⟲: `expectedTemplateId`,
  `expectedEntryCount`, `templateVersion` (`matrix-reimport-v1`; hôm nay hard-code ở
  `templates.ts:599-600`), `auditExtra` (payload: `source_format`, `based_on_template_id`,
  `plan_hash`, số ô giữ / đổi / thêm / bỏ / ngoài phạm vi), `skipTierUpsert`.
  ⚠ `created_count` hôm nay = số dòng của **cả** template (`:686-687`); với B, một
  lần sửa 1 ô sẽ ghi "16 625 created" — nghĩa mới cho một con số cũ (KB §4.21 cấm).
  Ghi số thật vào payload và định nghĩa rõ `created_count` = "số dòng đã chèn" trong
  KB.

---

## P6 — PREVIEW + PARITY + TEST

### 6.1 Preview diff (đề xuất giao diện — chưa chốt)

> 2026-10-19: **đổi** — bản hiện hành ở §L2.5.1 (chỉ hiển thị; bỏ dòng "export từ bản …
> ✓ vẫn là bản hiện tại" và "163 nước giữ nguyên" — **BỎ theo quyết định Manager 2026-10-19**).

```
┌ Nhập file Matrix đã sửa — Default · VNG Corp (vng-corp) ─────────────────────┐
│ File: apple-pricing-template-default-20261015-2210.xlsx   Format: Matrix v1 │
│ Export từ bản template: 18/05 bởi manager@…  ✓ vẫn là bản hiện tại           │
│                                                                              │
│  ● 3 ô đổi giá (override → override)   ● 1 override mới (thừa hưởng → giá)   │
│  ● 2 bỏ override (giá → thừa hưởng)     ○ 16 619 ô giữ nguyên                 │
│  ○ 163 nước KHÔNG có trong file (export đã lọc) — giữ nguyên                 │
│  ⚠ 1 thay đổi ở cột USA — đổi tier bulk import chấp nhận VÀ giá base USD     │
│    gửi Apple cho IAP tạo bằng bulk import nguồn template                     │
│  ⛔ 1 ô lệch > 10× — kiểm lại kiểu nhập số (vd. "49,000" thành 49)           │
│                                                                              │
│  Tier       Nước      Cũ              Mới             Loại                    │
│  Tier 5     Vietnam   129 000 VND  →  49 VND          ⛔ đổi giá ×0.0004      │
│  Tier 1     Japan     ·            →  160 JPY         override mới            │
│  Tier 2     USA       1.99 USD     →  ·               ⚠ bỏ override (USA)     │
│  …                                                                           │
│                                       [ Huỷ ]   [ Ghi 6 thay đổi ]           │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **0 thay đổi** ⇒ modal nói "Không có thay đổi — không ghi gì", **không có nút ghi**,
  và server không gọi hàm ghi.
- Toast sau khi ghi đọc số từ diff thật, không phải "đã thay N entry" (P5).
- Xung đột (409) nói đúng chuyện đã xảy ra: *"Template đã được thay lúc 14:02 bởi
  x@… sau khi bạn export — template KHÔNG bị thay đổi bởi lần nhập này. Export lại
  rồi sửa trên file mới."*
- Nút import đặt trên Matrix view ⇒ **3 nút upload format A không đổi gì**, và các
  confirm "sẽ thay toàn bộ N ô" của chúng (`DefaultTemplateTab.tsx:455-507`,
  `PerAppTemplateTab.tsx:154-160`, `AppPricingTemplateSection.tsx:96-103`) không bao
  giờ bắn ra cho file B (nếu Q12 chọn tái dùng nút Replace thì cả ba confirm + mockup
  `design/account-default-template-mockup.html:310-324` phải sửa — P46).

### 6.2 Parity — format A không đổi hành vi

- Nhánh A gọi đúng `parsePriceTiersXlsx(file)` rồi hàm ghi như hôm nay; nút upload A
  không đổi.
- Ghim: test route với một file A chụp lại **đúng dữ liệu** truyền vào hàm ghi
  (trước/sau như nhau, kể cả thứ tự dòng — chèn theo tier như hôm nay); file A chứa
  `·` vẫn 422 với đúng thông báo cũ; 11 test `route.scope-rejection.test.ts` + 11 test
  `price-tiers.test.ts` xanh nguyên; nhánh "không truyền `expectedTemplateId`" được
  ghim riêng ở tầng queries (P42).
- Nếu Q15 chọn W1 (function nguyên tử cho cả A), A **khác** ở đúng một điểm: lỗi giữa
  chừng giờ rollback thay vì để template thiếu — ghi rõ trong KB, không gọi là
  "không đổi".
- Hàng rào Excel: reader B dùng `xlsx` (KB §4.17: xlsx đọc, exceljs ghi). ⚠ Fence
  không nhìn thấy `await import("xlsx")` (ĐÃ ĐO), và danh sách `PARSERS` chỉ có 2
  parser Google (`excel-library-split.structural.test.ts:189-192`). Đề xuất: cho
  `importsPkg` (`:224`) bắt cả `import("xlsx")`, đưa cả 2 parser Apple + reader B vào
  `PARSERS` — sửa điểm mù thay vì nới một allowlist (P39/P40).

### 6.3 Test nghiệm thu tối thiểu

> 2026-10-19: T5 (digest), T7 (`plan_hash`), T9, T12 **BỎ theo quyết định Manager 2026-10-19**; T10 chỉ còn nếu PA3.
> Bản hiện hành: §L2.5.3.

**Độ trung thực của fake (bắt buộc, KB §19.6, §25.3):** fake ở tầng `iapDb`/PostgREST;
NUMERIC trả về **dạng chuỗi** (vì CHƯA BIẾT); phân trang không ORDER BY trả thứ tự
**không ổn định**; `.eq()` **thật sự lọc**, với **hai account mang giá KHÁC nhau**.
Mọi test từ chối phải khẳng định **mã lỗi cụ thể**, không chỉ "409, không ghi" — vì
bước 3, bước 5 và kiểm trong function chồng nhau, một mutation tắt một bước vẫn ra
409 qua bước khác (§25.6). Writer và reader dùng chung `spec.ts` nên round-trip
writer→reader **tự nhất quán theo cấu tạo** (P36): chỉ **fixture do app thật lưu ra**
mới là chốt không phải tautology.

| # | Test | Tầng |
|---|---|---|
| **T1 — BÀI SỐ MỘT** | writer thật → bytes → reader thật → planner → route: **0 thay đổi, hàm ghi KHÔNG được gọi, `template_id` không đổi**. Biến thể: Default · Per-App `showDiff` bật/tắt · export đã lọc · file đã qua **Excel thật** · file đã qua **Numbers thật** (có `Export Summary`, ô đệm, sheet `_import_info` hiện ra, mọi khoá manifest đọc lại đúng kiểu + giá trị) | P31: dưới tầng thấp nhất |
| **T1b** ⟲ | sửa **đúng một ô** rồi commit: bắt dữ liệu truyền vào hàm ghi; **mọi dòng khác** bằng dòng DB từng field (currency, giá, **proceeds**) và **thứ tự cột** sau khi ghi không đổi. Biến thể: export đã lọc, Per-App | planner + route |
| T2 | 7 ca a–g, mỗi ca một test có tên; ca b có thêm một ô sửa kèm để thực sự có lần ghi | planner + route |
| T3 | số §4.2: DB trả chuỗi `"1.9900"` vs file `1.99` ⇒ không đổi; `<v>` 17 chữ số ⇒ không đổi; **`1234567.89` và `2844767.5218` không đổi ⇒ NO_CHANGE**; `1.99999` ⇒ 422; `49000 → 49` ⇒ preview gắn cờ; override mới `·` → `49` giữa thang VND ⇒ gắn cờ | planner |
| T4 | scope: file account A vào account B ⇒ 409 `SCOPE_MISMATCH` **và 0 lần ghi**; file app X vào app Y ⇒ 409; non-admin + account không tồn tại ⇒ **403, không phải 400/404** (P34); nhánh B Per-App **không gọi Apple lần nào** (đo theo thời gian, P19) | route |
| T5 | export thiếu dòng (DB có entry mà file ghi `·`) ⇒ 409 `FILE_DB_MISMATCH`; ⟲ **entry bị xoá dưới cùng `template_id`** (cascade `price_tiers`) ⇒ 409 `FILE_DB_MISMATCH`, 0 lần ghi | route |
| T6 | cấu trúc: chèn/xoá/đổi chỗ cột, dòng; đổi tên header/tier; ô công thức (3 fixture: exceljs không `result`, `<f>…</f><v></v>` vá tay, công thức có cache); ô chữ-số; đổi currency; ⟲ **manifest bị sửa** (sort riêng cột `tier_id`; đổi một `territory_code`; thêm dòng tier không có trong DB) ⇒ 422/409, liệt kê **mọi** địa chỉ, 0 lần ghi | reader + planner |
| T7 | `plan_hash` lệch ⇒ 409; ⟲ gửi file B theo **đúng FormData cũ** (không `intent`) ⇒ 409 `PREVIEW_REQUIRED`, hàm ghi 0 lần | route |
| T8 | parity A (§6.2) | route + parser |
| T9 | REPLACE chen giữa preview và commit ⇒ 409 `TEMPLATE_CHANGED`, template của người kia còn nguyên, **`price_tiers` không bị chạm**, không có dòng `import_batches` FAILED | queries + function |
| **T10** ⟲ | **đứt giữa chừng**: tiêm lỗi ở lô entry thứ 2 trong function ⇒ template cũ còn **nguyên vẹn và đọc được** | function (SQL verify) |
| **T11** ⟲ | **wiring hai màn** (KB §21.2 F1 / P26): render `DefaultMatrixView` và `PerAppMatrixView` thật, chọn file B, khẳng định request 1 mang `intent=preview` + đúng trường scope (`account_id` / `app_id`), modal hiện, commit mang `plan_hash`; bỏ nhánh B khỏi một màn ⇒ chỉ test màn đó đỏ | component |
| T12 | commit hai lần (mất response) ⇒ lần 2 trả "đã ghi ở lần trước", không phải TEMPLATE_CHANGED | route |

Fixture Excel/Numbers: **commit file do app thật lưu ra**, không viết tay (P27 —
"fixture viết tay là một lời khẳng định về route, không phải bằng chứng"), buộc vào
`version` của manifest như golden file.

### 6.4 Mutation đề xuất (mỗi cái phải ĐỎ)

> 2026-10-19: các mutation về digest / `template_id` / `plan_hash` / gộp nước ngoài phạm vi /
> "dựng mọi ô số thành dòng mới" **BỎ theo quyết định Manager 2026-10-19**. Bản hiện hành: §L2.5.4.

| Mutation | Test phải đỏ |
|---|---|
| Thêm so sánh với giá Apple (hoặc Default) để đoán "thừa hưởng" | **ca e** (Apple đổi giá giữa chừng + khẳng định import **không gọi Apple lần nào**) |
| Coi `·` là override ở giá Default/Apple | **T1** |
| Dựng lại MỌI ô số thành dòng mới (bỏ nhánh "giữ dòng DB") | ⟲ **T1b** (proceeds các dòng khác thành NULL) — T1 không bắt được vì T1 không ghi |
| Bỏ short-circuit "diff rỗng không ghi" | **T1** (hàm ghi bị gọi) |
| Coi nước ngoài phạm vi là "không entry" (REPLACE thuần) | **T1 – biến thể export đã lọc** |
| Ghi theo thứ tự đọc có ORDER BY thay vì `template_market_order` | ⟲ **T1b** (thứ tự cột đổi) |
| Bỏ kiểm scope / lấy scope đích từ manifest thay vì request | **T4** |
| Bỏ kiểm `template_id` | **ca f** (khẳng định mã `TEMPLATE_CHANGED`) |
| Bỏ kiểm digest | **T5** (cả hai biến thể) |
| Bỏ đối chiếu danh tính với server (bước 4) | ⟲ **T6 – manifest bị sửa** |
| So `===` thay vì `canon`; quy tắc thập phân cũ `> 1e-6` | **T3** |
| Đọc chỉ `cellFormula: true` (bỏ `sheetStubs`) / kiểm `.v` trước `.f` | ⟲ **T6 – công thức không cache** |
| Đổi nghĩa ô trống (theo cái Manager chốt ở ca d) | **ca d** |
| Hàm ghi xoá theo scope thay vì theo `expectedTemplateId` | **T9** |
| Bỏ transaction (ghi tuần tự ngoài function) | ⟲ **T10** |
| Preview trả 200 cho request dạng cũ | ⟲ **T7** |
| Cho nhánh B chạy khi `SheetNames[0] === "price_tiers"` | **T8** |
| Bỏ nhánh B khỏi một màn matrix | ⟲ **T11** (chỉ màn đó) |

Áp mutation bằng `scripts/mutate.sh apply/restore` — không `git checkout` (CLAUDE.md).

---

## P7 — CÂU CẦN MANAGER CHỐT

> 2026-10-19: **thay bằng §L2.6.** Q1, Q2 đã được Manager trả lời; Q3, Q16 **BỎ theo quyết định Manager 2026-10-19**;
> các câu còn lại đổi thành Q-A…Q-V.

> **Q1 — Cơ chế nhận biết ô đã sửa.** Đề xuất **M3** (giá trị ô là trạng thái +
> `template_id` là điều kiện cần + digest là điều kiện đủ; ảnh chụp là DB). *Lý do:*
> `·` đã mang trạng thái và sống qua Excel/Numbers; DB đáng tin hơn sheet ẩn; không
> bao giờ đọc giá Apple ⇒ ca e đúng do cấu trúc. Phương án khác: M2 (ảnh chụp từng ô
> trong file).

> **Q2 — Ca d: ô Manager XOÁ TRỐNG nghĩa là gì?** Đề xuất **= bỏ override (thừa
> hưởng)**, giống Q-I của A, và preview hiện từng ô như vậy. Khác: (ii) từ chối ô
> trống — bắt nhập `·`; (iii) coi như không đổi. *Lý do đề xuất:* xoá ô là cách tự
> nhiên nhất để nói "bỏ giá này"; preview chặn được xoá nhầm.

> **Q3 — Ca f: template bị người khác thay giữa export và import.** Đề xuất **dừng,
> 409, không ghi gì, nói ai/lúc nào, bảo export lại**. Không gộp 3 chiều ở v1.

> **Q4 — Ca g: file không có sheet thông tin.** Đề xuất **từ chối rõ ràng, không lùi
> về M1**. *Lý do:* "không biết thì không ghi" (KB P7, §32.10).

> **Q5 — Khoá scope.** Đề xuất: scope đích **luôn từ màn đang đứng**, file chỉ để
> đối chiếu; lệch ⇒ 409. **Kèm:** màn Default matrix hiện tên account (vá R4). Import
> Default B chỉ cho **admin** (giống A) — xác nhận: member export được nhưng nút
> import Default ẩn với member (route vẫn trả 403).

> **Q6 — Nhận diện format.** Đề xuất **tự động theo tên sheet** (§5.3); preview nói
> ra format đã nhận. Khác: Manager chọn tay.

> **Q7 — File export đã LỌC.** Đề xuất **cho import, giữ nguyên mọi nước không có
> trong file**, preview liệt kê số nước được giữ. Khác: từ chối mọi file đã lọc.

> **Q8 — Sheet thông tin.** (i) Đề xuất `hidden`, tên `_import_info`, đặt sau sheet
> chính (Excel giấu; Numbers làm hiện ra nhưng giữ nội dung — và mọi giá trị trong
> nó đều được đối chiếu với server). Khác: visible kèm cảnh báo "đừng sửa". (ii) Chấp
> nhận export **thêm một sheet** (sheet chính không đổi — §21.1 giữ cho nội dung màn)?
> (iii) Có ký HMAC sheet đó bằng secret server không? Đề xuất **không** ở v1: digest
> đã bao gồm hai bảng danh tính, và mọi khoá còn lại đều so với server.

> **Q9 — Proceeds.** Đề xuất: ô không đổi **giữ proceeds cũ**; ô sửa ⇒ `proceeds =
> NULL`. Khác: đưa proceeds vào file (phải trả lời "Manager sửa proceeds thì sao").

> **Q10 — Sửa cấu trúc ở v1.** Đề xuất **chỉ sửa giá trị ô**; thêm/xoá/đổi chỗ dòng,
> cột ⇒ từ chối. Hệ quả cần chấp nhận: thêm tier/nước chưa có entry = tự dựng tay một
> file A đầy đủ (§4.8). Khác: export thêm dòng cho mọi tier trong `price_tiers` (file
> khác màn).

> **Q11 — Ô chữ trông như số** (Excel `en_VN` khi nhập `2.49`; **mọi** ô `·` sau khi
> file qua Numbers). (i) **Từ chối mọi ô chữ** + liệt kê địa chỉ — an toàn nhất, nhưng
> luồng "Numbers rồi Excel" không thêm được override mới. (ii) ⭐ Đề xuất: **chỉ nhận
> chuỗi không mơ hồ** — `^\d+$` hoặc `^\d+\.\d{1,2}$`; từ chối mọi chuỗi có dấu phẩy và
> mọi chuỗi đúng **3** chữ số sau dấu chấm (`49.000` có thể là 49 nghìn theo kiểu
> Việt Nam); preview ghi rõ "ô này là chữ, đã hiểu thành số X".

> **Q12 — Chỗ đặt nút import.** ⟲ Đề xuất: **nút "Nhập file đã sửa" cạnh "Export
> XLSX" trên Matrix view** (Default + Per-App — hai màn dùng chung thanh lọc). *Lý do:*
> export và import thành một cặp ở một chỗ; đích ghi = đúng scope màn đang hiện; **3
> nút upload format A không đổi một dòng** (parity tuyệt đối, không đụng các confirm
> "thay toàn bộ"); bề mặt twin còn 2 thay vì 3. Khác: tái dùng nút Replace/Upload ở cả
> 3 surface (phải sửa cả ba confirm + mockup).

> **Q13 — Ngưỡng cờ đỏ độ lớn** (§4.7). Đề xuất 10× / 0.1× cho ô đổi giá; gãy thang
> giá theo tier hoặc lệch > 10× so với Default cho override mới.

> **Q14 — App bảng tính Manager dùng thật?** Excel / Numbers / Google Sheets. Nếu là
> Google Sheets ⇒ cần **một vòng UAT đo thật** trước khi code reader (§2.3 toàn
> CHƯA BIẾT).

> **Q15 — Ghi nguyên tử** ⟲ (BLOCKER của vòng phản biện). (W1) ⭐ **Một function
> Postgres cho CẢ A lẫn B** — một hàm ghi (P1), A được nguyên tử miễn phí (khác hôm
> nay đúng ở chỗ lỗi giữa chừng thì rollback). (W2) Function chỉ cho B, A giữ ghi tuần
> tự — **hai hàm ghi**, trái P1. (W3) Không function — **không chấp nhận được**: B mất
> dữ liệu vĩnh viễn khi đứt. Cả W1, W2 đều cần 1 migration (Path G, chặn push).

> **Q16 — Stale-tab cho format A.** Một commit B có thể bị một upload A từ tab cũ ghi
> đè thầm lặng (R5 vẫn đúng với A). Ba surface A đều có sẵn id header lúc tải trang.
> Gửi kèm `expectedTemplateId` cho A luôn (409 → tải lại trang) trong arc này, hay để
> backlog? Đề xuất: **backlog** (đổi hành vi A, ngoài brief) — nhưng ghi rõ giới hạn.

> **Q17 — Route legacy `POST /api/iap-management/pricing-tiers`.** Không UI nào gọi,
> nhưng gọi được (admin) và một lần gọi xoá entry của **mọi** template mọi account
> (Phụ lục B). Thiết kế B chịu được nó (digest), nhưng nó vẫn là quả mìn. Tắt route
> trong arc này hay arc riêng? Đề xuất: **arc riêng, ưu tiên cao**.

---

## Phụ lục A — SQL Manager chạy (chỉ đọc) để thay CHƯA BIẾT bằng số

```sql
-- A1. Proceeds còn trên bao nhiêu entry (quyết định Q9 có quan trọng không)
SELECT t.scope_type, t.scope_account_id, t.scope_app_id,
       count(*) AS n, count(*) FILTER (WHERE e.proceeds IS NULL) AS null_proceeds
FROM iap_mgmt.price_tier_templates t
JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
GROUP BY 1,2,3;

-- A2. Có nước nào mang 2 currency trong cùng một template không
--     (≥ 1 dòng ⇒ override mới ở nước đó sẽ bị 422 theo quy tắc bước 7)
SELECT template_id, territory_code, count(DISTINCT currency_code)
FROM iap_mgmt.price_tier_template_entries
GROUP BY 1,2 HAVING count(DISTINCT currency_code) > 1;

-- A3. Số chữ số thập phân THỰC (cột NUMERIC(18,4) luôn có scale 4, nên đếm
--     chữ số sau khi bỏ số 0 ở đuôi — chạy được mọi phiên bản Postgres)
SELECT currency_code,
       max(length(rtrim(split_part(customer_price::text, '.', 2), '0'))) AS real_decimals,
       count(*) FILTER (WHERE customer_price <> trunc(customer_price)
                          AND customer_price >= 1e6) AS fractional_ge_1e6
FROM iap_mgmt.price_tier_template_entries GROUP BY 1 ORDER BY 2 DESC;

-- A4. NUMERIC(18,4) có hút nhiễu float không (§4.2)
SELECT 1.9900000000000002::numeric(18,4), 1.98999::numeric(18,4);

-- A5. Phiên bản Postgres (cho function ở §5.4)
SELECT version();
```

Và một phép đo Node một dòng (PostgREST trả NUMERIC dạng gì):
`typeof (await iapDb().from('price_tier_template_entries').select('customer_price').limit(1)).data[0].customer_price`

## Phụ lục B — Lỗi CÓ SẴN lộ ra trong census (ngoài phạm vi; đề xuất backlog)

| Tag đề xuất | Vấn đề | Nhãn · bằng chứng |
|---|---|---|
| `[PRICETIERS-legacy-delete-all]` ⚠ | `replacePriceTiers` xoá **mọi** dòng `price_tiers` ⇒ FK `ON DELETE CASCADE` xoá entry của **mọi** template mọi account (dưới **cùng** template id), và `iaps.tier_id` → NULL. Route `POST /api/iap-management/pricing-tiers` vẫn gọi được (admin), không UI nào dùng. (P7-Q17) | ĐỌC CODE `queries/price-tiers.ts:334-337` · CÓ TRONG SCHEMA `20260519000000:55`, `20260515010000:55-58` |
| `[TEMPLATE-parse-dimension-hang]` ⚠ | file 17 KB với `<dimension ref="A1:XFD1048576">` làm parser A chạy > 60 s **trong route Node** (chặn event loop service `web`); member nào cũng gửi được qua scope APP | ĐÃ ĐO |
| `[TEMPLATE-parse-comma]` | `readNumericCell` xoá mọi dấu phẩy: chữ `"1,99"` → 199, `"49.000"` → 49; nhận số âm | ĐÃ ĐO |
| `[TEMPLATE-matrix-unordered-paging]` | `fetchAllEntries` và `getTemplateOverview` phân trang không ORDER BY. ⟲ **RÀNG BUỘC KHI SỬA:** thứ tự heap này **chính là** thứ tự cột Hotfix 24 (`template-matrix.ts:145-153`) — **cấm** sửa bằng `ORDER BY tier_id, territory_code` (đảo cột thành alphabet). Phải phân trang bằng một khoá ổn định không quyết định thứ tự hiển thị, hoặc lưu thứ tự cột tường minh (như `sort_order` bên Google, KB §25.7). ⚠ **Sửa xong việc này KHÔNG làm digest của import B thừa** — digest còn bắt entry bị xoá dưới cùng id | ĐỌC CODE `template-matrix.ts:224-229`; `templates.ts:510-514` |
| `[TEMPLATE-replace-atomic]` | `replaceTemplate` xoá-rồi-chèn không transaction (Q15 xử lý); upload trùng (tier/nước) và giá ≥ 15 chữ số nguyên qua được parser nhưng bị Postgres từ chối **sau khi** template cũ đã bị xoá; upload **0 entry** được chấp nhận, để lại header rỗng | ĐỌC CODE `templates.ts:567-573` · CÓ TRONG SCHEMA `20260519000000:58`, `:62` · ĐÃ ĐO (parser) |
| `[TEMPLATE-matrix-account-label]` | màn Default matrix không nói account; diff Per-App so với Default của account TopNav chứ không phải account sở hữu app | ĐỌC CODE |
| `[USERDOCS-perapp-fallback]` | user docs nói Per-App "fallback Default" (`index.html:4246`, `:4344`), code nói Apple; lý do của khoá Q-D ("overrides cascade narrowest-first", KB:182) đọc như fallback từng ô — nên viết lại là "theo nguồn, không theo ô" | ĐỌC CODE |
| (P2) | `actions_log` / `import_batches` update trong `replaceTemplate` không kiểm `error` | ĐỌC CODE `templates.ts:685-703`, `:713-726` |
| `[EXCEL-fence-dynamic-import]` | fence Excel không thấy `await import("xlsx")`; `PARSERS` chỉ có parser Google — 2 parser Apple nằm ngoài luật "parser chỉ dùng xlsx" | ĐÃ ĐO |
| `[TEMPLATE-numbers-summary-sheet]` | file A xuất qua Numbers có `Export Summary` đứng đầu ⇒ parser A từ chối | ĐÃ ĐO |
| — | route upload APP tự đăng ký app (ghi DB) **trước** khi parse; file hỏng (422) vẫn để lại app đã đăng ký | ĐÃ ĐO |
| — | `TODO.md:213-214` / KB §21.8 nói gap proceeds "cần một đường đọc mới" — **quá tay**: DB đã đọc proceeds, chỉ composer vứt (`template-matrix.ts:227` vs `:119-122`). Với M3 thì gap này **biến mất** (ô không đổi giữ dòng DB) | ĐÃ ĐO |
| — | KB đánh số P34, P35 **hai lần** với hai nghĩa (:3819/:6668, :3878/:6687) — trích phải kèm số mục | ĐỌC CODE |

---

## CHECKPOINT

- [x] P1 census hai format, dump từ route thật
- [x] P2 câu chặn cửa: **B thưa** (dấu `·` ở giá trị ô, bền qua Excel + Numbers);
      nhưng 9 đường hỏng im lặng R1–R9 nếu import ngây thơ — R7 là BLOCKER
- [x] P3–P6 cơ chế M3, ca a–g, chỗ dễ sai, phương án, preview, test, mutation
- [x] Vòng phản biện 4 góc: 1 BLOCKER + 18 MAJOR đã xử lý (⟲)
- [x] ~~Manager chốt P7 (Q1–Q17)~~ — **BỎ theo quyết định Manager 2026-10-19**: ngữ nghĩa "file là sự thật duy nhất"
- [x] **Lượt 2** (2026-10-19): census lại theo ngữ nghĩa mới — P1, P2 (**B thưa**), P3, P4
      (PA1/PA2/PA3), P5, P6 (§L2.1–§L2.8)
- [ ] **Manager chốt §L2.6** (⛔ Q-A, Q-G, Q-B, Q-C, Q-D, Q-E, Q-F) + chạy SQL §L2.8 + Phụ lục A
- [ ] Sau khi chốt: arc code — PA1/PA2 **0 migration**; PA3 có 1 migration (Path G: chặn push
      tới khi Manager chạy SQL + verify) — cắt nhánh mới ở ranh giới arc
