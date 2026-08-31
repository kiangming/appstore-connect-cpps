-- ═══════════════════════════════════════════════════════════════════════════
-- CENSUS — Google IAP Management · Export Item List (arc G-EXPORT)
-- Phục vụ 3 yêu cầu Manager:
--   R1 — chọn item + lọc theo trạng thái Active/Inactive
--   R2 — kiểm chứng danh sách 183 country có phải của Google không
--   R3 — header cột đổi từ mã ISO sang "Country name (country code)"
--
-- ⚠ ĐỌC TRƯỚC KHI CHẠY
--   • TOÀN BỘ query dưới đây là READ-ONLY. Không INSERT / UPDATE / DELETE /
--     ALTER / CREATE. Chạy nhiều lần, không đổi dữ liệu.
--   • Chạy trong Supabase SQL Editor. Copy kết quả gửi lại.
--   • Mỗi query có dòng "KỲ VỌNG" — đó là điều CODE nói phải đúng. Kết quả
--     LỆCH khỏi kỳ vọng là PHÁT HIỆN, không phải lỗi query.
--
-- ⚠ QUERY NÀY KHÔNG TRẢ LỜI ĐƯỢC "GOOGLE BÁN Ở ĐÂU".
--   Nó đọc dữ liệu MIRROR trong DB — tức tập region mà các sản phẩm hiện có
--   ĐANG có giá. Đó là tập CON của tập Google hỗ trợ (một region Google bán
--   nhưng chưa sản phẩm nào đặt giá sẽ không xuất hiện ở đây). Tập Google
--   THẬT chỉ đo được bằng 1 request tới `convertRegionPrices` — xem mục
--   "PHÉP ĐO M1" trong báo cáo census, cần Manager duyệt riêng.
--
-- Schema: mọi bảng nằm trong `google_iap_mgmt`. Không JOIN cross-schema
-- (CLAUDE.md invariant #9).
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ Q1. Tập region xuất hiện trong dữ liệu production — ĐẾM ════════════════
-- Đây là "tập thứ ba" trong phép so ba tập của census (183 catalog · tập
-- Google thật · tập trong dữ liệu thật).
--
-- KỲ VỌNG: KHÔNG CÓ kỳ vọng cứng. Code không ép con số nào ở đây —
--   `iap_prices.region_code` là TEXT tự do, ghi thẳng từ `regionCode` Google
--   trả về (onetime-product-adapter.ts:171-180). Con số này là DỮ LIỆU, và
--   nó là căn cứ để nói 183 đúng hay sai.
-- ⚠ Nếu con số này = 183 thì PHẢI nghi ngờ, không phải mừng: xác suất tập
--   region Google trùng khít một catalog dựng bằng i18n-iso-countries là rất
--   thấp. Khi đó chạy tiếp Q3 để xem có trùng THEO MÃ không, hay chỉ trùng số.
SELECT
  COUNT(DISTINCT region_code)                       AS distinct_regions,
  COUNT(*)                                          AS total_price_rows,
  COUNT(DISTINCT iap_id)                            AS iaps_with_any_price
FROM google_iap_mgmt.iap_prices;


-- ═══ Q2. Liệt kê từng region + số IAP đang có giá ở đó ══════════════════════
-- Dùng để mắt thường soi: có mã nào lạ (không phải alpha-2), có mã nào
-- Google dùng mà catalog 183 thiếu.
--
-- KỲ VỌNG: mọi `region_code` dài ĐÚNG 2 ký tự, IN HOA. Code khắp module khai
--   Google Play dùng ISO 3166-1 alpha-2 (regions.ts:14, region-name.ts:4-5,
--   xlsx-template-matrix-export.ts:46). Đây là chỗ DỮ LIỆU xác nhận lời khai
--   đó — R3 phụ thuộc vào nó (nếu là alpha-3 thì `regionNameFromCode` sai hết).
SELECT
  region_code,
  LENGTH(region_code)                               AS code_len,
  COUNT(DISTINCT iap_id)                            AS iap_count,
  COUNT(DISTINCT currency)                          AS distinct_currencies,
  STRING_AGG(DISTINCT currency, ' ' ORDER BY currency) AS currencies
FROM google_iap_mgmt.iap_prices
GROUP BY region_code
ORDER BY region_code;


-- ═══ Q2b. CHỐT CHẶN alpha-2: có mã nào KHÔNG phải 2 chữ in hoa không? ═══════
-- KỲ VỌNG: **0 dòng.** Một dòng trả về ở đây là bác bỏ giả định alpha-2, và
--   R3 phải thiết kế lại (KB §4.20 cấm tự viết phép chuyển alpha-2/alpha-3).
SELECT region_code, LENGTH(region_code) AS code_len, COUNT(*) AS rows
FROM google_iap_mgmt.iap_prices
WHERE region_code !~ '^[A-Z]{2}$'
GROUP BY region_code
ORDER BY region_code;


-- ═══ Q3. SO BA TẬP — catalog 183 vs dữ liệu thật ════════════════════════════
-- 183 mã dưới đây trích MÁY MÓC từ `lib/iap-management/territory-catalog.ts`
-- (grep -o 'code: "[A-Z]{2}"' | sort), KHÔNG chép tay.
--
-- KỲ VỌNG: KHÔNG CÓ kỳ vọng cứng — đây là phép đo.
-- Cách đọc kết quả:
--   • `only_in_catalog`  = mã catalog cho tick nhưng dữ liệu chưa từng thấy.
--     KHÔNG kết luận ngay là "Google không bán" — có thể chỉ là chưa app nào
--     đặt giá ở đó. Chỉ phép đo M1 mới phân biệt được hai ca này.
--   • `only_in_data`     = ⚠ mã Google ĐANG dùng mà catalog THIẾU. Đây là
--     phát hiện cứng: Manager KHÔNG THỂ tick những mã này trong dialog, tức
--     là chúng không bao giờ lọc được — cùng lớp lỗi với
--     `[EXPORT-catalog-missing-11]` bên Apple.
WITH catalog(code) AS (
  VALUES
  ('AD'),('AE'),('AF'),('AG'),('AL'),('AM'),('AO'),('AR'),('AT'),('AU'),('AZ'),('BA'),
  ('BB'),('BD'),('BE'),('BF'),('BG'),('BH'),('BI'),('BJ'),('BN'),('BO'),('BR'),('BS'),
  ('BT'),('BW'),('BZ'),('CA'),('CD'),('CG'),('CH'),('CI'),('CL'),('CM'),('CN'),('CO'),
  ('CR'),('CV'),('CY'),('CZ'),('DE'),('DJ'),('DK'),('DM'),('DO'),('DZ'),('EC'),('EE'),
  ('EG'),('ES'),('ET'),('FI'),('FJ'),('FM'),('FR'),('GA'),('GB'),('GD'),('GE'),('GH'),
  ('GM'),('GN'),('GQ'),('GR'),('GT'),('GW'),('GY'),('HK'),('HN'),('HR'),('HT'),('HU'),
  ('ID'),('IE'),('IL'),('IN'),('IQ'),('IS'),('IT'),('JM'),('JO'),('JP'),('KE'),('KG'),
  ('KH'),('KI'),('KM'),('KN'),('KR'),('KW'),('KZ'),('LA'),('LB'),('LC'),('LI'),('LK'),
  ('LR'),('LS'),('LT'),('LU'),('LV'),('MA'),('MC'),('MD'),('ME'),('MG'),('MH'),('MK'),
  ('ML'),('MM'),('MN'),('MO'),('MR'),('MT'),('MU'),('MV'),('MW'),('MX'),('MY'),('MZ'),
  ('NA'),('NE'),('NG'),('NI'),('NL'),('NO'),('NP'),('NR'),('NZ'),('OM'),('PA'),('PE'),
  ('PG'),('PH'),('PK'),('PL'),('PT'),('PW'),('PY'),('QA'),('RO'),('RS'),('RW'),('SA'),
  ('SB'),('SC'),('SE'),('SG'),('SI'),('SK'),('SL'),('SM'),('SN'),('SR'),('ST'),('SV'),
  ('SZ'),('TD'),('TG'),('TH'),('TJ'),('TL'),('TM'),('TN'),('TO'),('TR'),('TT'),('TV'),
  ('TW'),('TZ'),('UA'),('UG'),('US'),('UY'),('UZ'),('VC'),('VE'),('VN'),('VU'),('WS'),
  ('XK'),('ZA'),('ZM')
),
data AS (
  SELECT DISTINCT region_code AS code FROM google_iap_mgmt.iap_prices
)
SELECT
  (SELECT COUNT(*) FROM catalog)                                        AS catalog_count,
  (SELECT COUNT(*) FROM data)                                           AS data_count,
  (SELECT COUNT(*) FROM catalog c JOIN data d USING (code))             AS in_both,
  (SELECT STRING_AGG(code, ' ' ORDER BY code) FROM
     (SELECT code FROM catalog EXCEPT SELECT code FROM data) x)         AS only_in_catalog,
  (SELECT STRING_AGG(code, ' ' ORDER BY code) FROM
     (SELECT code FROM data EXCEPT SELECT code FROM catalog) y)         AS only_in_data;


-- ═══ Q4. R1 — trạng thái item trong mirror: có những giá trị nào? ═══════════
-- Manager cần chốt filter theo cái gì. Đây là dữ liệu để chốt.
--
-- KỲ VỌNG: CHỈ 'active' và 'inactive'. CHECK constraint ép đúng 2 giá trị
--   (20260520010000_google_iap_mgmt_init.sql:134-136). Một giá trị thứ ba ở
--   đây là bất khả — nếu thấy, CHECK đã bị sửa ngoài migration.
-- ⚠ ĐỌC KÈM CẢNH BÁO Ở BÁO CÁO (mục P2.2): 'active' của TOOL gộp HAI state
--   của Google (`ACTIVE` và `INACTIVE_PUBLISHED`) —
--   onetime-product-adapter.ts:117-122. Filter theo cột này KHÔNG phân biệt
--   được hai state đó.
SELECT
  status,
  COUNT(*)                                          AS iap_count,
  COUNT(*) FILTER (WHERE deleted_on_google_at IS NOT NULL) AS flagged_deleted,
  COUNT(*) FILTER (WHERE last_synced_at IS NULL)     AS never_synced
FROM google_iap_mgmt.iaps
GROUP BY status
ORDER BY status;


-- ═══ Q5. R1 — quy mô: mỗi app bao nhiêu item, phân bố trạng thái ════════════
-- Quyết định picker có cần search + windowing hay không. Bên Apple
-- `BulkItemPicker` phải có cả hai vì có app 500+ item.
--
-- KỲ VỌNG: KHÔNG CÓ kỳ vọng cứng — đây là phép đo quy mô.
-- Cách đọc: nếu max(live_items) ≤ ~60 thì danh sách phẳng như
--   `BulkStatusModal` đang dùng là đủ; lớn hơn thì cần search + "Show more".
SELECT
  a.package_name,
  COUNT(*)                                                          AS total_items,
  COUNT(*) FILTER (WHERE i.deleted_on_google_at IS NULL)            AS live_items,
  COUNT(*) FILTER (WHERE i.deleted_on_google_at IS NULL
                     AND i.status = 'active')                       AS live_active,
  COUNT(*) FILTER (WHERE i.deleted_on_google_at IS NULL
                     AND i.status = 'inactive')                     AS live_inactive,
  COUNT(*) FILTER (WHERE i.deleted_on_google_at IS NOT NULL)        AS flagged_deleted,
  MAX(i.last_synced_at)                                             AS newest_sync,
  MIN(i.last_synced_at)                                             AS oldest_sync
FROM google_iap_mgmt.iaps i
JOIN google_iap_mgmt.apps a ON a.id = i.app_id
GROUP BY a.package_name
ORDER BY total_items DESC;


-- ═══ Q6. Số region MỖI item có giá — độ rộng file export ═══════════════════
-- File export mở đúng `union(region có giá trên BẤT KỲ item nào)` cột, nên
-- phân bố này cho biết một item "gầy" bị kéo theo bao nhiêu cột rỗng.
--
-- KỲ VỌNG: KHÔNG CÓ kỳ vọng cứng.
-- ⚠ Nếu `regions_on_this_iap` chênh nhau nhiều giữa các item thì R1 (chọn
--   item) tự nó đã thu hẹp file rất nhiều — chọn ít item ⇒ union nhỏ đi ⇒
--   ít cột hơn. Đây là lập luận giá trị của R1, cần số thật mới nói được.
SELECT
  a.package_name,
  i.sku,
  i.status,
  COUNT(p.id)                                       AS regions_on_this_iap
FROM google_iap_mgmt.iaps i
JOIN google_iap_mgmt.apps a ON a.id = i.app_id
LEFT JOIN google_iap_mgmt.iap_prices p ON p.iap_id = i.id
WHERE i.deleted_on_google_at IS NULL
GROUP BY a.package_name, i.sku, i.status
ORDER BY regions_on_this_iap DESC, a.package_name, i.sku
LIMIT 50;


-- ═══ Q7. R3 — mã region nào KHÔNG phân giải được tên? ══════════════════════
-- `regionNameFromCode` (region-name.ts:63-69) rơi về chính mã khi
-- i18n-iso-countries không có entry. Ca đó phải rút gọn còn mã trần, KHÔNG
-- lặp "XX (XX)". Query này liệt kê ứng viên để đối chiếu.
--
-- KỲ VỌNG: SQL KHÔNG tự phân giải được tên (không có bảng ISO trong DB) —
--   query này chỉ TRẢ VỀ danh sách mã distinct. Việc đối chiếu với
--   i18n-iso-countries làm bằng test trong code (xem P3.2 trong báo cáo).
--   Mục đích ở đây: đưa Manager danh sách mã THẬT để test đếm được ca rút gọn.
SELECT STRING_AGG(DISTINCT region_code, ' ' ORDER BY region_code) AS all_region_codes
FROM google_iap_mgmt.iap_prices;
