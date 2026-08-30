-- ═══════════════════════════════════════════════════════════════════════════
-- CENSUS — Google IAP Management · Pricing Templates
-- Phục vụ 2 nâng cấp Manager yêu cầu:
--   G1 — tách Default Template theo từng Google Console account
--   G2 — thay Export CSV bằng Export .xlsx
--
-- ⚠ ĐỌC TRƯỚC KHI CHẠY
--   • TOÀN BỘ query dưới đây là READ-ONLY. Không có INSERT / UPDATE / DELETE
--     / ALTER / CREATE. Chạy được nhiều lần, không đổi dữ liệu.
--   • Chạy trong Supabase SQL Editor. Copy kết quả gửi lại.
--   • Mỗi query có dòng "KỲ VỌNG" — đó là điều CODE nói phải đúng. Nếu kết
--     quả LỆCH khỏi kỳ vọng thì đó là phát hiện, không phải lỗi của query.
--
-- ⚠ KHÁC APPLE — ĐỌC KỸ TRƯỚC KHI SO SÁNH VỚI census-account-default-template.sql
--   1. Google CÓ bảng account riêng: `google_iap_mgmt.google_console_accounts`
--      (Apple mượn `public.asc_accounts` của CPP Manager).
--   2. `google_iap_mgmt.apps.google_console_account_id` là UUID **NOT NULL
--      + FK ON DELETE CASCADE** — KHÔNG có app nào account NULL được. Bên
--      Apple cột tương ứng là TEXT nullable soft-ref nên có điểm mù; bên
--      Google điểm mù đó KHÔNG tồn tại (Q6 dưới đây chứng minh, không giả định).
--   3. ⚠ `google_iap_mgmt.iaps` **KHÔNG CÓ cột `pricing_source`**. Bên Apple
--      `iap_mgmt.iaps.pricing_source` trả lời trực tiếp "bao nhiêu IAP đang
--      dùng Default". Bên Google nguồn giá chỉ được ghi lại theo TỪNG LẦN
--      IMPORT (`import_batches.pricing_source`) — xem Q3/Q3b, và đọc phần
--      cảnh báo ở Q3 trước khi kết luận.
--   4. Google dùng bộ region riêng (alpha-2, do Google Play quyết định),
--      KHÔNG dùng `apple-territories.snapshot` / `TERRITORY_CATALOG`.
--
-- Schema: tất cả bảng dưới đây nằm trong `google_iap_mgmt`. Không JOIN
-- cross-schema (CLAUDE.md invariant #9) — mọi JOIN ở đây đều trong 1 schema.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ Q1. Có bao nhiêu template GLOBAL, bao nhiêu entry? ═════════════════════
-- Đây là câu chặn cửa của G1: một dòng GLOBAL duy nhất dùng chung mọi account.
--
-- KỲ VỌNG: **0 hoặc 1 dòng.** Partial unique index
--   `idx_google_iap_mgmt_pricing_templates_global_unique`
--   (20260520010000_google_iap_mgmt_init.sql) ép TỐI ĐA 1 dòng GLOBAL trong
--   toàn hệ thống.
--   • 0 dòng  ⇒ chưa từng upload Default Template ⇒ rủi ro migration G1 = 0,
--               không cần nhân bản gì cả.
--   • 1 dòng  ⇒ đây chính là bản Default đang dùng chung; entry_count của nó
--               là số ô sẽ phải nhân bản cho mỗi account.
--   • ≥2 dòng ⇒ KHÔNG THỂ XẢY RA. Nếu thấy, index đã bị drop bằng tay ⇒ DỪNG,
--               báo lại trước khi làm bất cứ gì khác.
-- Đối chiếu với file CSV Manager gửi: bản Default hiện tại là 94 tier × 9
-- region = 846 entry (ma trận đầy, không ô thưa).
SELECT
  t.id                              AS template_id,
  t.scope_type,
  t.scope_app_id,
  t.uploaded_at,
  t.uploaded_by,
  t.source_filename,
  COUNT(e.identifier)               AS entry_count,
  COUNT(DISTINCT e.identifier)      AS tier_count,
  COUNT(DISTINCT e.region_code)     AS region_count
FROM google_iap_mgmt.pricing_templates t
LEFT JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'GLOBAL'
GROUP BY t.id, t.scope_type, t.scope_app_id, t.uploaded_at, t.uploaded_by,
         t.source_filename;


-- ─── Q1b. Ma trận GLOBAL có ĐẦY không, hay thưa? ───────────────────────────
-- Số ô thưa = tier_count × region_count − entry_count.
--
-- KỲ VỌNG: `sparse_cells = 0` (ma trận đầy), khớp file CSV Manager gửi
-- (846 dòng = 94 × 9). Nếu > 0 thì bản trên DB đã bị thay so với file CSV,
-- và con số đó chính là số ô mà Export CSV hiện tại ĐANG BỎ RƠI (lỗi F6).
SELECT
  COUNT(DISTINCT e.identifier)   AS tier_count,
  COUNT(DISTINCT e.region_code)  AS region_count,
  COUNT(*)                       AS entry_count,
  COUNT(DISTINCT e.identifier) * COUNT(DISTINCT e.region_code) - COUNT(*)
                                 AS sparse_cells
FROM google_iap_mgmt.pricing_template_entries e
JOIN google_iap_mgmt.pricing_templates t ON t.id = e.template_id
WHERE t.scope_type = 'GLOBAL';


-- ═══ Q2. Có bao nhiêu template PER-APP, thuộc app nào, ACCOUNT nào? ═════════
-- ⚠ Câu này cũng trả lời một câu hỏi phụ quan trọng cho G1: các template
-- per-app HIỆN ĐANG nằm rải ở mấy account. Nếu tất cả nằm ở 1 account thì
-- màn "Per-App Templates" hiện tại (KHÔNG lọc theo account —
-- queries/templates.ts:124-188 `listAppTemplates()` select toàn bộ scope APP)
-- đang vô tình đúng; nếu nằm ở ≥2 account thì màn đó ĐANG hiện template của
-- account mà Manager không nhìn.
--
-- KỲ VỌNG: mỗi app tối đa 1 dòng (partial unique index
--   `idx_google_iap_mgmt_pricing_templates_app_unique`).
--   Có ít nhất 1 dòng cho `vng.games.lightandnight` với
--   tier_count = 41, region_count = 11, entry_count = 369
--   (khớp file CSV per-app Manager gửi: 369 dòng, 41 tier, 11 region).
SELECT
  acc.display_name                  AS account_name,
  acc.id                            AS account_id,
  acc.status                        AS account_status,
  ap.package_name,
  ap.display_name                   AS app_name,
  t.id                              AS template_id,
  t.uploaded_at,
  t.uploaded_by,
  t.source_filename,
  COUNT(e.identifier)               AS entry_count,
  COUNT(DISTINCT e.identifier)      AS tier_count,
  COUNT(DISTINCT e.region_code)     AS region_count,
  COUNT(DISTINCT e.identifier) * COUNT(DISTINCT e.region_code) - COUNT(e.identifier)
                                    AS sparse_cells
FROM google_iap_mgmt.pricing_templates t
JOIN google_iap_mgmt.apps ap  ON ap.id = t.scope_app_id
JOIN google_iap_mgmt.google_console_accounts acc
                              ON acc.id = ap.google_console_account_id
LEFT JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'APP'
GROUP BY acc.display_name, acc.id, acc.status, ap.package_name, ap.display_name,
         t.id, t.uploaded_at, t.uploaded_by, t.source_filename
ORDER BY acc.display_name, ap.package_name;


-- ─── Q2b. Template APP mà app đã bị xoá khỏi cache (mồ côi) ────────────────
-- `listAppTemplates()` (queries/templates.ts:177) lặng lẽ `skip` các dòng
-- này — chúng KHÔNG hiện trên UI nhưng vẫn chiếm slot unique index.
--
-- KỲ VỌNG: **0 dòng.** FK `scope_app_id REFERENCES apps(id) ON DELETE CASCADE`
-- lẽ ra đã dọn. Nếu > 0 ⇒ có dòng lọt qua CASCADE ⇒ báo lại.
SELECT t.id AS template_id, t.scope_app_id, t.uploaded_at, t.uploaded_by
FROM google_iap_mgmt.pricing_templates t
LEFT JOIN google_iap_mgmt.apps ap ON ap.id = t.scope_app_id
WHERE t.scope_type = 'APP' AND ap.id IS NULL;


-- ═══ Q3. Bao nhiêu product/IAP đang dùng nguồn Default? ════════════════════
-- ⚠⚠ ĐỌC KỸ — CÂU NÀY KHÔNG TRẢ LỜI ĐƯỢC TRỰC TIẾP TRÊN GOOGLE.
--
-- Bên Apple, `iap_mgmt.iaps.pricing_source` lưu nguồn giá TRÊN TỪNG IAP nên
-- đếm được chính xác. Bên Google, `google_iap_mgmt.iaps` **KHÔNG CÓ cột đó**
-- (xem 20260520010000_google_iap_mgmt_init.sql phần "3. iaps" — các cột là
-- sku / purchase_type / status / default_currency / default_price_micros /
-- last_synced_at / deleted_on_google_at, hết).
--
-- Nguồn giá bên Google chỉ được ghi theo TỪNG LẦN IMPORT, ở
-- `import_batches.pricing_source`. Nghĩa là câu trả lời khả dĩ nhất là:
--   "bao nhiêu LẦN IMPORT đã dùng default_template, và chạm bao nhiêu dòng"
-- chứ KHÔNG phải "bao nhiêu IAP hiện đang gắn với Default".
--
-- ⇒ Hệ quả cho G1, phải nói thẳng với Manager: **bỏ/tách GLOBAL trên Google
--   KHÔNG làm mất nguồn giá của IAP nào**, vì không IAP nào đang trỏ tới
--   template. Giá đã được đẩy sang Google rồi và nằm ở Google. Template chỉ
--   là nguồn TRA CỨU tại thời điểm import/save. Đây là điểm khiến G1 bên
--   Google RẺ HƠN HẲN bên Apple — nhưng phải xác nhận bằng Q3/Q3b chứ không
--   được giả định.
--
-- KỲ VỌNG Q3: mỗi pricing_source một dòng. `default_template` > 0 nghĩa là
-- surface này có người dùng thật. `NULL` = batch tạo trước khi cột được ghi.
SELECT
  COALESCE(b.pricing_source, '(NULL — batch cũ)') AS pricing_source,
  COUNT(*)                        AS batch_count,
  SUM(b.rows_total)               AS rows_total,
  SUM(b.rows_success)             AS rows_success,
  MIN(b.created_at)               AS first_seen,
  MAX(b.created_at)               AS last_seen
FROM google_iap_mgmt.import_batches b
GROUP BY b.pricing_source
ORDER BY batch_count DESC;


-- ─── Q3b. Nguồn Default dùng ở app nào / account nào ───────────────────────
-- KỲ VỌNG: liệt kê các app đã từng import bằng `default_template`. Nếu 0
-- dòng ⇒ Default Template chưa từng được dùng để import ⇒ G1 gần như không
-- có rủi ro dữ liệu, chỉ còn rủi ro code (đường đọc GLOBAL, xem báo cáo A6).
SELECT
  acc.display_name        AS account_name,
  ap.package_name,
  ap.display_name         AS app_name,
  b.pricing_source,
  COUNT(*)                AS batch_count,
  SUM(b.rows_success)     AS rows_success,
  MAX(b.created_at)       AS last_used
FROM google_iap_mgmt.import_batches b
JOIN google_iap_mgmt.apps ap ON ap.id = b.app_id
JOIN google_iap_mgmt.google_console_accounts acc
                             ON acc.id = ap.google_console_account_id
WHERE b.pricing_source IN ('default_template', 'app_template')
GROUP BY acc.display_name, ap.package_name, ap.display_name, b.pricing_source
ORDER BY acc.display_name, ap.package_name, b.pricing_source;


-- ─── Q3c. Single-IAP Create/Edit cũng chọn nguồn — có ghi lại ở đâu không? ──
-- Route single-IAP (`app/api/.../iaps/route.ts:139`, `iaps/[sku]/route.ts:147`)
-- nhận `pricingSource` trong body nhưng KHÔNG ghi nó vào `iaps`, và
-- `actions_log` cho IAP_CREATE / IAP_UPDATE có thể có hoặc không mang nó
-- trong payload.
--
-- KỲ VỌNG: nếu cột `payload->>'pricing_source'` toàn NULL ⇒ đường single-IAP
-- KHÔNG để lại dấu vết nguồn giá nào. Đó là kết luận cần biết, không phải lỗi.
SELECT
  l.action_type,
  COALESCE(l.payload->>'pricing_source', '(không có trong payload)') AS pricing_source_in_payload,
  COUNT(*)          AS n,
  MAX(l.created_at) AS last_seen
FROM google_iap_mgmt.actions_log l
WHERE l.action_type IN ('IAP_CREATE', 'IAP_UPDATE', 'BULK_IMPORT_BATCH')
GROUP BY l.action_type, l.payload->>'pricing_source'
ORDER BY l.action_type, n DESC;


-- ═══ Q4. Danh sách account Google + số app mỗi account ═════════════════════
-- Đây chính là **N** trong phương án "nhân bản Default cho N account" của G1.
--
-- KỲ VỌNG: ≥1 dòng (nếu 0 thì mọi trang /google-iap-management/* đều đang
-- redirect về hub — xem pricing-templates/page.tsx:23). `status='verified'`
-- là account dùng được; `pending`/`invalid` vẫn được resolver chọn làm
-- fallback (active-account.ts:101-103) nên VẪN phải được nhân bản template.
SELECT
  acc.id                AS account_id,
  acc.display_name      AS account_name,
  acc.service_account_email,
  acc.status,
  acc.verified_at,
  acc.created_at,
  COUNT(ap.id)                                              AS app_count,
  COUNT(*) FILTER (WHERE pt.id IS NOT NULL)                 AS app_template_count
FROM google_iap_mgmt.google_console_accounts acc
LEFT JOIN google_iap_mgmt.apps ap ON ap.google_console_account_id = acc.id
LEFT JOIN google_iap_mgmt.pricing_templates pt
       ON pt.scope_app_id = ap.id AND pt.scope_type = 'APP'
GROUP BY acc.id, acc.display_name, acc.service_account_email, acc.status,
         acc.verified_at, acc.created_at
ORDER BY acc.display_name;


-- ─── Q4b. Tổng số IAP mỗi account (quy mô ảnh hưởng) ───────────────────────
-- KỲ VỌNG: dùng để cân nhắc thứ tự roll-out G1 (account nhiều IAP nhất nên
-- được xác nhận trước). `flagged_deleted` = item đã biến mất khỏi Google.
SELECT
  acc.display_name                                              AS account_name,
  COUNT(DISTINCT ap.id)                                         AS app_count,
  COUNT(i.id)                                                   AS iap_count,
  COUNT(i.id) FILTER (WHERE i.deleted_on_google_at IS NOT NULL)  AS flagged_deleted
FROM google_iap_mgmt.google_console_accounts acc
LEFT JOIN google_iap_mgmt.apps ap ON ap.google_console_account_id = acc.id
LEFT JOIN google_iap_mgmt.iaps i  ON i.app_id = ap.id
GROUP BY acc.display_name
ORDER BY iap_count DESC;


-- ═══ Q5. App nào có account NULL? ══════════════════════════════════════════
-- ⚠ Bên Apple đây là ĐIỂM MÙ lớn (`apps.asc_account_id` TEXT nullable, không
-- FK). Bên Google cột là
--   `google_console_account_id UUID NOT NULL REFERENCES
--    google_console_accounts(id) ON DELETE CASCADE`
-- nên NULL là KHÔNG THỂ.
--
-- KỲ VỌNG: **0 dòng, luôn luôn.** Query này chạy để CHỨNG MINH điều đó chứ
-- không phải để tìm. Nếu > 0 dòng ⇒ NOT NULL đã bị drop bằng tay ⇒ DỪNG.
SELECT ap.id, ap.package_name, ap.display_name, ap.google_console_account_id
FROM google_iap_mgmt.apps ap
WHERE ap.google_console_account_id IS NULL;


-- ─── Q5b. App trỏ tới account không tồn tại (FK bị phá) ────────────────────
-- KỲ VỌNG: **0 dòng.** FK ép. Chạy để chứng minh, giống Q5.
SELECT ap.id, ap.package_name, ap.google_console_account_id
FROM google_iap_mgmt.apps ap
LEFT JOIN google_iap_mgmt.google_console_accounts acc
       ON acc.id = ap.google_console_account_id
WHERE acc.id IS NULL;


-- ─── Q5c. Cùng một package_name nằm ở NHIỀU account? ───────────────────────
-- UNIQUE là `(google_console_account_id, package_name)` — KHÔNG unique toàn
-- cục. Nghĩa là schema CHO PHÉP một package thuộc 2 account. Nếu điều đó có
-- thật thì "Default theo account" là bắt buộc chứ không chỉ là tiện lợi.
--
-- KỲ VỌNG: nhiều khả năng 0 dòng. Nếu > 0 ⇒ đây là LẬP LUẬN MẠNH NHẤT cho G1,
-- đưa vào báo cáo.
SELECT ap.package_name, COUNT(DISTINCT ap.google_console_account_id) AS account_count,
       STRING_AGG(DISTINCT acc.display_name, ' · ') AS accounts
FROM google_iap_mgmt.apps ap
JOIN google_iap_mgmt.google_console_accounts acc
     ON acc.id = ap.google_console_account_id
GROUP BY ap.package_name
HAVING COUNT(DISTINCT ap.google_console_account_id) > 1
ORDER BY account_count DESC;


-- ═══ Q6. Mã region trong template mà nguồn danh sách nước KHÔNG có ═════════
-- Nguồn tên nước của Google IAP Management là `i18n-iso-countries` (~250 mã
-- ISO 3166-1 alpha-2) + 18 override thủ công, gói trong
-- `lib/google-iap-management/region-name.ts:63-69 regionNameFromCode()`.
-- Hàm đó fallback về CHÍNH MÃ IN HOA khi không tra được.
--
-- SQL không gọi được hàm TypeScript, nên query này lọc theo HÌNH DẠNG mã:
-- bất kỳ mã nào không phải đúng 2 chữ cái hoa CHẮC CHẮN không có trong ISO
-- 3166-1 alpha-2 ⇒ chắc chắn rơi vào fallback.
--
-- KỲ VỌNG: **0 dòng.** Parser chỉ nhận header khớp
--   /^\s*([A-Z]{2})\s*-\s*([A-Z]{3})\s*-\s*(.+?)\s*$/
--   (parsers/pricing-template-parser.ts:25) nên mã sai hình dạng không vào
--   nổi DB qua đường upload. > 0 dòng ⇒ có dòng được ghi bằng đường khác.
SELECT DISTINCT e.region_code, t.scope_type, t.scope_app_id
FROM google_iap_mgmt.pricing_template_entries e
JOIN google_iap_mgmt.pricing_templates t ON t.id = e.template_id
WHERE e.region_code !~ '^[A-Z]{2}$'
ORDER BY e.region_code;


-- ─── Q6b. TOÀN BỘ mã region đang có trong template (để đối chiếu tay) ──────
-- ⚠ Đây là danh sách Manager phải soi bằng mắt. SQL không biết
-- `i18n-iso-countries` có mã nào; chỉ có 2 mã cần chú ý ngay:
--   • `EU` — `regions.ts:22 COMMON_REGIONS` có "EU" nhưng ISO 3166-1 KHÔNG
--     có "EU" là mã nước ⇒ nếu xuất hiện ở đây, màn sẽ hiện chữ "EU" trần.
--   • `XK` / `XKX` (Kosovo) — mã user-assigned, i18n-iso-countries có thể
--     không có ⇒ cũng hiện mã trần.
-- KỲ VỌNG: theo 2 file CSV Manager gửi thì tập mã là
--   GLOBAL : US VN SG MY ID PH TH HK TW            (9)
--   APP    : + KH MM                                (11)
-- Bất kỳ mã nào NGOÀI tập đó là thay đổi so với file CSV — cần biết.
SELECT
  e.region_code,
  COUNT(DISTINCT e.template_id)                                   AS in_n_templates,
  COUNT(*)                                                        AS entry_count,
  STRING_AGG(DISTINCT e.currency, ' / ')                          AS currencies_used
FROM google_iap_mgmt.pricing_template_entries e
GROUP BY e.region_code
ORDER BY e.region_code;


-- ─── Q6c. Một region mang HAI currency khác nhau giữa các template ─────────
-- ⚠⚠ VIẾT LẠI 2026-08-30. Bản cũ ĐÚNG (có `HAVING COUNT(DISTINCT …) > 1`)
-- nhưng kết quả báo về là 11 dòng, mỗi dòng 1 currency — điều mà mệnh đề
-- HAVING đó KHÔNG THỂ sinh ra. Nghĩa là cái chạy thật là Q6b, không phải Q6c
-- (hai query cùng `GROUP BY e.region_code`, nhìn rất giống nhau; Supabase SQL
-- Editor chỉ hiện kết quả của statement cuối khi chạy nhiều statement).
--
-- Bản mới KHÔNG dùng HAVING làm bộ lọc kết quả nữa. Nó LUÔN trả về ĐÚNG MỘT
-- DÒNG mang một chữ PASS/FAIL, nên không thể nhầm với bảng 11 dòng của Q6b.
--
-- KỲ VỌNG: đúng 1 dòng, `ket_luan` = 'PASS'.
--   PASS ⇒ không region nào mang 2 currency ⇒ mệnh đề currency của `isDiff`
--          (template-matrix.ts:112) KHÔNG THỂ bật ⇒ lệch F2 chưa kích hoạt.
--   FAIL ⇒ F2 hiện hữu trên dữ liệu thật ⇒ chạy Q6c-detail bên dưới.
SELECT
  COUNT(*)                                        AS so_region_da_currency,
  CASE WHEN COUNT(*) = 0
       THEN 'PASS — khong region nao mang 2 currency; F2 chua the kich hoat'
       ELSE 'FAIL — F2 hien huu tren du lieu that; chay Q6c-detail'
  END                                             AS ket_luan
FROM (
  SELECT e.region_code
  FROM google_iap_mgmt.pricing_template_entries e
  GROUP BY e.region_code
  HAVING COUNT(DISTINCT e.currency) > 1
) x;


-- ─── Q6c-detail. Chỉ chạy khi Q6c = FAIL ───────────────────────────────────
SELECT e.region_code,
       COUNT(DISTINCT e.currency)             AS n_currencies,
       STRING_AGG(DISTINCT e.currency, ' / ') AS currencies
FROM google_iap_mgmt.pricing_template_entries e
GROUP BY e.region_code
HAVING COUNT(DISTINCT e.currency) > 1
ORDER BY e.region_code;


-- ─── Q6d. Mô phỏng TRỰC TIẾP mệnh đề currency của isDiff ───────────────────
-- Q6c là phép đo GIÁN TIẾP (bao trùm): region không bao giờ 2 currency ⇒ chắc
-- chắn không cặp (tier, region) nào lệch currency. Q6d đo TRỰC TIẾP đúng biểu
-- thức code đang chạy — join GLOBAL ↔ APP trên (identifier, region_code) rồi
-- so currency, y hệt template-matrix.ts:106-113.
--
-- KỲ VỌNG: **0 dòng.** > 0 ⇒ trên màn Per-App có ô hiện ★ mà file CSV cũ in ra
-- hai con số giống hệt nhau (vì không có cột `default_currency`) ⇒ chứng minh
-- lệch F2 bằng chính biểu thức của code, không phải bằng suy luận.
SELECT
  ga.package_name,
  a.identifier                         AS tier_identifier,
  a.region_code,
  g.currency                           AS default_currency,
  a.currency                           AS per_app_currency,
  g.price_micros                       AS default_price_micros,
  a.price_micros                       AS per_app_price_micros
FROM google_iap_mgmt.pricing_template_entries a
JOIN google_iap_mgmt.pricing_templates ta ON ta.id = a.template_id AND ta.scope_type = 'APP'
JOIN google_iap_mgmt.apps ga              ON ga.id = ta.scope_app_id
JOIN google_iap_mgmt.pricing_templates tg ON tg.scope_type = 'GLOBAL'
JOIN google_iap_mgmt.pricing_template_entries g
     ON g.template_id = tg.id
    AND g.identifier  = a.identifier
    AND g.region_code = a.region_code
WHERE g.currency <> a.currency
ORDER BY ga.package_name, a.identifier, a.region_code;


-- ═══ Q7. Giá có bị mất mát khi hiển thị không? (câu quyết định của G2) ═════
-- Google lưu giá là `price_micros TEXT` = số nguyên micro (1 đơn vị tiền =
-- 1 000 000 micro). Màn + CSV hiện tại đều gọi
--   microsToDecimal(price_micros, getCurrencyDecimals(currency))
-- và với currency 0 chữ số thập phân (VND, IDR, TWD, JPY, KRW, HUF …) nhánh
-- `displayDecimals === 0` trả về `whole.toString()` — **CẮT BỎ toàn bộ phần
-- micro dư, không làm tròn** (google/price-conversion.ts:122-124).
--
-- Query này tìm mọi dòng mà việc cắt đó LÀM MẤT SỐ: price_micros không chia
-- hết cho 1 000 000 trong khi currency là loại 0 chữ số thập phân.
--
-- KỲ VỌNG: **0 dòng.** Nếu 0 ⇒ mất mát là rủi ro lý thuyết, G2 vẫn nên ghi
-- giá trị nguyên bản nhưng không có dữ liệu nào đang sai. Nếu > 0 ⇒ file .xlsx
-- MỚI sẽ hiện số KHÁC file CSV cũ ở đúng những dòng này, và đó là ĐÚNG —
-- phải báo trước cho Manager để không bị hiểu là lỗi.
SELECT
  t.scope_type,
  t.scope_app_id,
  e.identifier        AS tier_identifier,
  e.region_code,
  e.currency,
  e.price_micros,
  (e.price_micros::NUMERIC / 1000000)             AS gia_that,
  FLOOR(e.price_micros::NUMERIC / 1000000)        AS gia_man_hinh_dang_hien,
  (e.price_micros::NUMERIC / 1000000)
    - FLOOR(e.price_micros::NUMERIC / 1000000)    AS phan_bi_cat
FROM google_iap_mgmt.pricing_template_entries e
JOIN google_iap_mgmt.pricing_templates t ON t.id = e.template_id
WHERE e.currency IN (
        'BIF','CLP','DJF','GNF','IDR','ISK','JPY','KMF','KRW','LAK','PYG',
        'RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF','HUF','TWD'
      )
  AND e.price_micros ~ '^\d+$'
  AND (e.price_micros::NUMERIC % 1000000) <> 0
ORDER BY t.scope_type, e.identifier, e.region_code;


-- ─── Q7b. price_micros có dòng nào KHÔNG phải số nguyên không? ─────────────
-- Cột là TEXT — không có ràng buộc nào ép nó là chữ số. `microsToDecimal`
-- THROW khi gặp chuỗi không phải `^\d+$`; `formatPriceForCsv`
-- (csv-export.ts:44) NUỐT lỗi đó và in ra chuỗi thô. Nghĩa là một dòng hỏng
-- sẽ hiện nguyên chuỗi rác trên màn thay vì báo lỗi.
--
-- KỲ VỌNG: **0 dòng.**
SELECT t.scope_type, e.identifier, e.region_code, e.currency, e.price_micros
FROM google_iap_mgmt.pricing_template_entries e
JOIN google_iap_mgmt.pricing_templates t ON t.id = e.template_id
WHERE e.price_micros !~ '^\d+$';


-- ═══ Q8. Lịch sử upload / xoá template ═════════════════════════════════════
-- ⚠ Cả upload LẪN delete đều ghi `action_type = 'PRICING_TEMPLATE_UPLOAD'`
-- (route [id]/route.ts:31 dùng lại đúng giá trị đó cho DELETE, phân biệt
-- bằng `payload->>'action' = 'delete'`). Đừng đọc nhầm "upload" cho tất cả.
--
-- KỲ VỌNG: cho biết ai đang thật sự dùng surface này và tần suất. Nếu chỉ
-- 1-2 người ⇒ cửa sổ vận hành của G1 dễ kiểm soát.
SELECT
  l.created_at,
  l.actor_email,
  COALESCE(l.payload->>'action', 'upload')  AS hanh_dong,
  l.payload->>'scope'                       AS scope,
  l.payload->>'app_id'                      AS app_id,
  l.payload->>'source_filename'             AS source_filename,
  l.payload->>'entry_count'                 AS entry_count,
  l.payload->>'tier_count'                  AS tier_count,
  l.payload->>'territory_count'             AS territory_count,
  l.target_id                               AS template_id
FROM google_iap_mgmt.actions_log l
WHERE l.action_type = 'PRICING_TEMPLATE_UPLOAD'
ORDER BY l.created_at DESC
LIMIT 100;


-- ─── Q8b. Bao nhiêu người khác nhau từng đụng vào template? ────────────────
-- Google KHÔNG gate admin cho upload/xoá Default (route.ts:21-24 chỉ kiểm
-- `session.user.email`) — khác Apple, nơi scope GLOBAL bị gate admin.
-- KỲ VỌNG: con số này cho biết mức độ rủi ro của việc đó trên thực tế.
SELECT
  l.actor_email,
  COUNT(*)                                                          AS n_actions,
  COUNT(*) FILTER (WHERE l.payload->>'action' = 'delete')            AS n_deletes,
  COUNT(*) FILTER (WHERE l.payload->>'scope' = 'GLOBAL')             AS n_global,
  MIN(l.created_at)                                                  AS first_action,
  MAX(l.created_at)                                                  AS last_action
FROM google_iap_mgmt.actions_log l
WHERE l.action_type = 'PRICING_TEMPLATE_UPLOAD'
GROUP BY l.actor_email
ORDER BY n_actions DESC;


-- ═══════════════════════════════════════════════════════════════════════════
-- HẾT. Tất cả read-only. Gửi lại kết quả kèm số thứ tự query.
-- ═══════════════════════════════════════════════════════════════════════════
