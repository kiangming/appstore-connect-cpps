-- ═══════════════════════════════════════════════════════════════════════════
-- AUDIT — Google IAP Management · pricing-template entries vs. the H4 price rules
-- Chạy TRƯỚC khi push H4.0–H4.4 (Manager, Supabase SQL Editor). H4.4, 2026-10-19.
--
-- ⚠ ĐỌC TRƯỚC KHI CHẠY
--   • ⚠ CHẠY TỪNG CÂU MỘT (bôi đen một query → Run). Supabase SQL Editor chỉ hiện
--     kết quả của câu CUỐI: dán cả file rồi bấm Run thì chỉ thấy Q4 và các câu trên
--     trôi qua im lặng. (Q4 — câu chặn push — được đặt CUỐI để nếu lỡ chạy cả file,
--     kết quả hiện ra vẫn là câu quan trọng nhất.)
--   • TOÀN BỘ là READ-ONLY: chỉ WITH / SELECT. Không INSERT / UPDATE / DELETE /
--     ALTER / CREATE. Chạy bao nhiêu lần cũng được. (Test structural ghim điều này.)
--   • Mỗi query có dòng "KỲ VỌNG" và "CÁCH ĐỌC". Kết quả lệch kỳ vọng là PHÁT HIỆN,
--     không phải lỗi query. Copy kết quả từng câu gửi lại.
--   • Chưa chạy thử được trên Postgres trước khi giao (máy dev không có Postgres).
--     Câu chỉ đọc: nếu có lỗi cú pháp, câu đó chỉ dừng, không đổi gì.
--
-- ⚠ VÌ SAO CÓ FILE NÀY. Từ H4.3, lúc push, các entry của tier ĐƯỢC DÙNG cho một dòng
--   import được kiểm bằng storedRegionPriceOf (orchestration/file-price.ts):
--     • giá 0                                     ⇒ dòng bị TỪ CHỐI (tier_price_invalid)
--     • sai độ chính xác theo currency (TWD 30.5) ⇒ dòng bị TỪ CHỐI (tier_price_invalid)
--     • price_micros không phải số nguyên ≥ 0     ⇒ dòng bị TỪ CHỐI (tier_price_invalid)
--   TRƯỚC H4: entry 0 được GỬI lên Google; entry sai độ chính xác làm CẢ batch lỗi
--   500 và import_batches kẹt IN_PROGRESS.
--   Hai loại H4 KHÔNG kiểm (vẫn gửi) — Q2 liệt kê để biết:
--     • currency Google Play không bán (ngoài 61 currency của snapshot 173 vùng),
--       vd AR ghi ARS (Google tính AR bằng USD, và ARS không phải currency Play bán);
--     • cặp vùng/currency lệch cách Google tính tiền vùng đó (vd VN ghi USD), hoặc
--       vùng Google không bán.
--   Google có từ chối các entry đó không: CHƯA ĐO — nếu có, có thể hỏng cả lượt gọi.
--
-- ⚠ HAI BẢNG NHÚNG — SINH TỪ CODE, KHÔNG GÕ TAY:
--   decimals(currency, d) = CURRENCY_DECIMALS_OVERRIDES (google/currency-precision.ts);
--     currency không có trong bảng = 2 chữ số thập phân (như code).
--   billed(region_code, currency) = PLAY_REGIONS (google/play-regions.snapshot.ts,
--     173 vùng, regionsVersion 2025/03, đo 2026-09-01).
--   Test lib/google-iap-management/template-entries-audit.structural.test.ts so hai
--   bảng này với code, và ghim phần còn lại của file — lệch là ĐỎ.
--
-- Schema: chỉ google_iap_mgmt (CLAUDE.md invariant #9); chỉ đọc bảng sống
-- pricing_templates / pricing_template_entries (không đọc các bảng *_backup_global).
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ Q1. Tổng quan: mỗi loại entry có vấn đề có bao nhiêu, ở bao nhiêu tier / template ═
-- KỲ VỌNG: KHÔNG có dòng nào có h4_effect = 'REFUSES the row'. (Chỉ loại nào có ít
--   nhất 1 entry mới hiện; không có dòng nào cả = mọi template sạch.) Dòng
--   'not checked by H4 — still sent' có thể có (parser template không kiểm cặp
--   vùng/currency) — không chặn push, xem Q2.
-- CÁCH ĐỌC: có dòng 'REFUSES the row' ⇒ chạy Q3 + Q4 TRƯỚC khi push; cột tiers = số
--   tier có thể làm dòng import bị từ chối.
WITH decimals(currency, d) AS (VALUES
    ('BIF', 0), ('CLP', 0), ('DJF', 0), ('GNF', 0), ('IDR', 0), ('ISK', 0),
    ('JPY', 0), ('KMF', 0), ('KRW', 0), ('LAK', 0), ('PYG', 0), ('RWF', 0),
    ('UGX', 0), ('UYI', 0), ('VND', 0), ('VUV', 0), ('XAF', 0), ('XOF', 0),
    ('XPF', 0), ('HUF', 0), ('TWD', 0), ('BHD', 3), ('IQD', 3), ('JOD', 3),
    ('KWD', 3), ('LYD', 3), ('OMR', 3), ('TND', 3), ('CLF', 4), ('UYW', 4)
),
billed(region_code, currency) AS (VALUES
    ('AE', 'AED'), ('AG', 'USD'), ('AL', 'USD'), ('AM', 'USD'), ('AO', 'USD'), ('AR', 'USD'),
    ('AT', 'EUR'), ('AU', 'AUD'), ('AW', 'USD'), ('AZ', 'USD'), ('BA', 'USD'), ('BD', 'BDT'),
    ('BE', 'EUR'), ('BF', 'EUR'), ('BG', 'EUR'), ('BH', 'USD'), ('BJ', 'EUR'), ('BM', 'USD'),
    ('BO', 'BOB'), ('BR', 'BRL'), ('BS', 'USD'), ('BW', 'USD'), ('BY', 'USD'), ('BZ', 'USD'),
    ('CA', 'CAD'), ('CD', 'USD'), ('CF', 'EUR'), ('CG', 'USD'), ('CH', 'CHF'), ('CI', 'XOF'),
    ('CL', 'CLP'), ('CM', 'XAF'), ('CO', 'COP'), ('CR', 'CRC'), ('CV', 'USD'), ('CY', 'EUR'),
    ('CZ', 'CZK'), ('DE', 'EUR'), ('DJ', 'USD'), ('DK', 'DKK'), ('DM', 'USD'), ('DO', 'USD'),
    ('DZ', 'DZD'), ('EC', 'USD'), ('EE', 'EUR'), ('EG', 'EGP'), ('ER', 'USD'), ('ES', 'EUR'),
    ('FI', 'EUR'), ('FJ', 'USD'), ('FM', 'USD'), ('FR', 'EUR'), ('GA', 'EUR'), ('GB', 'GBP'),
    ('GD', 'USD'), ('GE', 'GEL'), ('GH', 'GHS'), ('GI', 'GBP'), ('GM', 'USD'), ('GN', 'USD'),
    ('GR', 'EUR'), ('GT', 'USD'), ('GW', 'EUR'), ('HK', 'HKD'), ('HN', 'USD'), ('HR', 'EUR'),
    ('HT', 'USD'), ('HU', 'HUF'), ('ID', 'IDR'), ('IE', 'EUR'), ('IL', 'ILS'), ('IN', 'INR'),
    ('IQ', 'IQD'), ('IS', 'EUR'), ('IT', 'EUR'), ('JM', 'USD'), ('JO', 'JOD'), ('JP', 'JPY'),
    ('KE', 'KES'), ('KG', 'USD'), ('KH', 'USD'), ('KM', 'USD'), ('KN', 'USD'), ('KR', 'KRW'),
    ('KW', 'USD'), ('KY', 'USD'), ('KZ', 'KZT'), ('LA', 'USD'), ('LB', 'USD'), ('LC', 'USD'),
    ('LI', 'CHF'), ('LK', 'LKR'), ('LR', 'USD'), ('LT', 'EUR'), ('LU', 'EUR'), ('LV', 'EUR'),
    ('LY', 'USD'), ('MA', 'MAD'), ('MC', 'EUR'), ('MD', 'USD'), ('MK', 'USD'), ('ML', 'EUR'),
    ('MM', 'MMK'), ('MN', 'MNT'), ('MO', 'MOP'), ('MT', 'EUR'), ('MU', 'USD'), ('MV', 'USD'),
    ('MX', 'MXN'), ('MY', 'MYR'), ('MZ', 'USD'), ('NA', 'USD'), ('NE', 'EUR'), ('NG', 'NGN'),
    ('NI', 'USD'), ('NL', 'EUR'), ('NO', 'NOK'), ('NP', 'USD'), ('NZ', 'NZD'), ('OM', 'USD'),
    ('PA', 'USD'), ('PE', 'PEN'), ('PG', 'USD'), ('PH', 'PHP'), ('PK', 'PKR'), ('PL', 'PLN'),
    ('PT', 'EUR'), ('PY', 'PYG'), ('QA', 'QAR'), ('RO', 'RON'), ('RS', 'RSD'), ('RU', 'RUB'),
    ('RW', 'USD'), ('SA', 'SAR'), ('SB', 'USD'), ('SC', 'USD'), ('SE', 'SEK'), ('SG', 'SGD'),
    ('SI', 'EUR'), ('SK', 'EUR'), ('SL', 'USD'), ('SM', 'EUR'), ('SN', 'XOF'), ('SO', 'USD'),
    ('SR', 'USD'), ('SV', 'USD'), ('TC', 'USD'), ('TD', 'USD'), ('TG', 'EUR'), ('TH', 'THB'),
    ('TJ', 'USD'), ('TM', 'USD'), ('TN', 'USD'), ('TO', 'USD'), ('TR', 'TRY'), ('TT', 'USD'),
    ('TW', 'TWD'), ('TZ', 'TZS'), ('UA', 'UAH'), ('UG', 'USD'), ('US', 'USD'), ('UY', 'USD'),
    ('UZ', 'USD'), ('VA', 'EUR'), ('VE', 'USD'), ('VG', 'USD'), ('VN', 'VND'), ('VU', 'USD'),
    ('WS', 'USD'), ('YE', 'USD'), ('ZA', 'ZAR'), ('ZM', 'USD'), ('ZW', 'USD')
),
entries AS (
  SELECT
    t.id AS template_id, t.scope_type, t.scope_app_id, t.scope_account_id, t.uploaded_at,
    e.identifier, e.region_code, e.currency, e.price_micros,
    COALESCE(d.d, 2) AS decimals
  FROM google_iap_mgmt.pricing_templates t
  JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
  LEFT JOIN decimals d ON d.currency = upper(trim(e.currency))
),
classified AS (
  SELECT
    en.*,
    CASE
      WHEN en.price_micros !~ '^[0-9]+$' THEN 'not_a_number'
      WHEN en.price_micros::numeric = 0 THEN 'zero'
      WHEN mod(en.price_micros::numeric, power(10, 6 - en.decimals)::numeric) <> 0 THEN 'precision'
    END AS refused_by_h4,
    CASE
      WHEN upper(trim(en.currency)) NOT IN (SELECT currency FROM billed) THEN 'not_billed'
      WHEN NOT EXISTS (
        SELECT 1 FROM billed b
        WHERE b.region_code = upper(trim(en.region_code)) AND b.currency = upper(trim(en.currency))
      ) THEN 'pair_mismatch'
    END AS informational
  FROM entries en
)
SELECT defect, h4_effect, COUNT(*) AS entries,
       COUNT(DISTINCT (template_id, identifier)) AS tiers,
       COUNT(DISTINCT template_id) AS templates
FROM (
  SELECT refused_by_h4 AS defect, 'REFUSES the row' AS h4_effect, template_id, identifier
    FROM classified WHERE refused_by_h4 IS NOT NULL
  UNION ALL
  SELECT informational, 'not checked by H4 — still sent', template_id, identifier
    FROM classified WHERE informational IS NOT NULL
) x
GROUP BY defect, h4_effect
ORDER BY h4_effect, defect;


-- ═══ Q2. Chỉ để biết: entry lệch catalog Play mà H4 KHÔNG kiểm (vẫn gửi) ════════
-- KỲ VỌNG: có thể ≠ 0 (parser template không kiểm cặp vùng/currency).
-- CÁCH ĐỌC: H4 không kiểm các entry này. Vì H4 đổi CÁCH một dòng khớp tier (theo
--   currency + giá của FILE, không theo currency của app), một entry như vậy có thể
--   được gửi ở một dòng trước đây không chạm tới nó. Google có từ chối không: CHƯA
--   ĐO — nếu có, có thể hỏng cả lượt gọi của batch đó. apps_using = app sẽ dùng tier
--   này. Không chặn push; việc sửa là BACKLOG [GOOGLE-template-upload-price-check].
WITH billed(region_code, currency) AS (VALUES
    ('AE', 'AED'), ('AG', 'USD'), ('AL', 'USD'), ('AM', 'USD'), ('AO', 'USD'), ('AR', 'USD'),
    ('AT', 'EUR'), ('AU', 'AUD'), ('AW', 'USD'), ('AZ', 'USD'), ('BA', 'USD'), ('BD', 'BDT'),
    ('BE', 'EUR'), ('BF', 'EUR'), ('BG', 'EUR'), ('BH', 'USD'), ('BJ', 'EUR'), ('BM', 'USD'),
    ('BO', 'BOB'), ('BR', 'BRL'), ('BS', 'USD'), ('BW', 'USD'), ('BY', 'USD'), ('BZ', 'USD'),
    ('CA', 'CAD'), ('CD', 'USD'), ('CF', 'EUR'), ('CG', 'USD'), ('CH', 'CHF'), ('CI', 'XOF'),
    ('CL', 'CLP'), ('CM', 'XAF'), ('CO', 'COP'), ('CR', 'CRC'), ('CV', 'USD'), ('CY', 'EUR'),
    ('CZ', 'CZK'), ('DE', 'EUR'), ('DJ', 'USD'), ('DK', 'DKK'), ('DM', 'USD'), ('DO', 'USD'),
    ('DZ', 'DZD'), ('EC', 'USD'), ('EE', 'EUR'), ('EG', 'EGP'), ('ER', 'USD'), ('ES', 'EUR'),
    ('FI', 'EUR'), ('FJ', 'USD'), ('FM', 'USD'), ('FR', 'EUR'), ('GA', 'EUR'), ('GB', 'GBP'),
    ('GD', 'USD'), ('GE', 'GEL'), ('GH', 'GHS'), ('GI', 'GBP'), ('GM', 'USD'), ('GN', 'USD'),
    ('GR', 'EUR'), ('GT', 'USD'), ('GW', 'EUR'), ('HK', 'HKD'), ('HN', 'USD'), ('HR', 'EUR'),
    ('HT', 'USD'), ('HU', 'HUF'), ('ID', 'IDR'), ('IE', 'EUR'), ('IL', 'ILS'), ('IN', 'INR'),
    ('IQ', 'IQD'), ('IS', 'EUR'), ('IT', 'EUR'), ('JM', 'USD'), ('JO', 'JOD'), ('JP', 'JPY'),
    ('KE', 'KES'), ('KG', 'USD'), ('KH', 'USD'), ('KM', 'USD'), ('KN', 'USD'), ('KR', 'KRW'),
    ('KW', 'USD'), ('KY', 'USD'), ('KZ', 'KZT'), ('LA', 'USD'), ('LB', 'USD'), ('LC', 'USD'),
    ('LI', 'CHF'), ('LK', 'LKR'), ('LR', 'USD'), ('LT', 'EUR'), ('LU', 'EUR'), ('LV', 'EUR'),
    ('LY', 'USD'), ('MA', 'MAD'), ('MC', 'EUR'), ('MD', 'USD'), ('MK', 'USD'), ('ML', 'EUR'),
    ('MM', 'MMK'), ('MN', 'MNT'), ('MO', 'MOP'), ('MT', 'EUR'), ('MU', 'USD'), ('MV', 'USD'),
    ('MX', 'MXN'), ('MY', 'MYR'), ('MZ', 'USD'), ('NA', 'USD'), ('NE', 'EUR'), ('NG', 'NGN'),
    ('NI', 'USD'), ('NL', 'EUR'), ('NO', 'NOK'), ('NP', 'USD'), ('NZ', 'NZD'), ('OM', 'USD'),
    ('PA', 'USD'), ('PE', 'PEN'), ('PG', 'USD'), ('PH', 'PHP'), ('PK', 'PKR'), ('PL', 'PLN'),
    ('PT', 'EUR'), ('PY', 'PYG'), ('QA', 'QAR'), ('RO', 'RON'), ('RS', 'RSD'), ('RU', 'RUB'),
    ('RW', 'USD'), ('SA', 'SAR'), ('SB', 'USD'), ('SC', 'USD'), ('SE', 'SEK'), ('SG', 'SGD'),
    ('SI', 'EUR'), ('SK', 'EUR'), ('SL', 'USD'), ('SM', 'EUR'), ('SN', 'XOF'), ('SO', 'USD'),
    ('SR', 'USD'), ('SV', 'USD'), ('TC', 'USD'), ('TD', 'USD'), ('TG', 'EUR'), ('TH', 'THB'),
    ('TJ', 'USD'), ('TM', 'USD'), ('TN', 'USD'), ('TO', 'USD'), ('TR', 'TRY'), ('TT', 'USD'),
    ('TW', 'TWD'), ('TZ', 'TZS'), ('UA', 'UAH'), ('UG', 'USD'), ('US', 'USD'), ('UY', 'USD'),
    ('UZ', 'USD'), ('VA', 'EUR'), ('VE', 'USD'), ('VG', 'USD'), ('VN', 'VND'), ('VU', 'USD'),
    ('WS', 'USD'), ('YE', 'USD'), ('ZA', 'ZAR'), ('ZM', 'USD'), ('ZW', 'USD')
),
template_apps AS (
  -- Which apps a template applies to: ACCOUNT ⇒ every app of that account
  -- (when the import picks "Default Template"); APP ⇒ that app ("App Template").
  SELECT t.id AS template_id, a.id AS app_id, a.package_name
  FROM google_iap_mgmt.pricing_templates t
  JOIN google_iap_mgmt.apps a
    ON (t.scope_type = 'APP' AND a.id = t.scope_app_id)
    OR (t.scope_type = 'ACCOUNT' AND a.google_console_account_id = t.scope_account_id)
)
SELECT
  t.scope_type,
  t.id AS template_id,
  e.identifier AS tier,
  e.region_code,
  e.currency,
  (SELECT b.currency FROM billed b WHERE b.region_code = upper(trim(e.region_code))) AS google_bills_in,
  CASE
    WHEN upper(trim(e.currency)) NOT IN (SELECT currency FROM billed) THEN 'not_billed'
    ELSE 'pair_mismatch'
  END AS informational,
  (SELECT string_agg(DISTINCT ta.package_name, ', ')
     FROM template_apps ta WHERE ta.template_id = t.id) AS apps_using
FROM google_iap_mgmt.pricing_templates t
JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
WHERE NOT EXISTS (
  SELECT 1 FROM billed b
  WHERE b.region_code = upper(trim(e.region_code)) AND b.currency = upper(trim(e.currency))
)
ORDER BY t.scope_type, e.identifier, e.region_code;


-- ═══ Q3. Dòng import NÀO có thể bị từ chối — mỗi tier hỏng, cách một dòng dùng nó ══
-- KỲ VỌNG: 0 dòng (đi cùng Q4 = 0).
-- CÁCH ĐỌC: một dòng bị từ chối khi tier ĐƯỢC DÙNG cho nó là tier hỏng:
--   (a) Product ID = tên tier — tier mang tên SKU luôn thắng, không xét giá;
--   (b) không có tier mang tên SKU, và giá + currency của file bằng ĐÚNG một giá của
--       tier. Nếu giá file khớp NHIỀU tier, dòng chỉ bị từ chối khi tier ĐƯỢC CHỌN ở
--       preview là tier hỏng (mặc định: tier không có tiền tố "Alternate").
--   • skus_named_like_tier: SKU ĐÃ CÓ trên app dùng template này mà trùng tên tier —
--     import lại các SKU này ⇒ bị từ chối (đường (a)).
--   • matching_prices: các giá (vùng currency số) của tier mà một dòng file HỢP LỆ có
--     thể khớp — đã bỏ các giá 0 / sai độ chính xác / currency Play không bán, vì một
--     dòng file ghi giá đó đã bị từ chối ngay ở preview.
--   • apps_using: app áp template này.
--   Q3 có thể dự báo DƯ (tier hỏng mà không dòng nào chọn), không bao giờ dự báo THIẾU.
WITH decimals(currency, d) AS (VALUES
    ('BIF', 0), ('CLP', 0), ('DJF', 0), ('GNF', 0), ('IDR', 0), ('ISK', 0),
    ('JPY', 0), ('KMF', 0), ('KRW', 0), ('LAK', 0), ('PYG', 0), ('RWF', 0),
    ('UGX', 0), ('UYI', 0), ('VND', 0), ('VUV', 0), ('XAF', 0), ('XOF', 0),
    ('XPF', 0), ('HUF', 0), ('TWD', 0), ('BHD', 3), ('IQD', 3), ('JOD', 3),
    ('KWD', 3), ('LYD', 3), ('OMR', 3), ('TND', 3), ('CLF', 4), ('UYW', 4)
),
billed(region_code, currency) AS (VALUES
    ('AE', 'AED'), ('AG', 'USD'), ('AL', 'USD'), ('AM', 'USD'), ('AO', 'USD'), ('AR', 'USD'),
    ('AT', 'EUR'), ('AU', 'AUD'), ('AW', 'USD'), ('AZ', 'USD'), ('BA', 'USD'), ('BD', 'BDT'),
    ('BE', 'EUR'), ('BF', 'EUR'), ('BG', 'EUR'), ('BH', 'USD'), ('BJ', 'EUR'), ('BM', 'USD'),
    ('BO', 'BOB'), ('BR', 'BRL'), ('BS', 'USD'), ('BW', 'USD'), ('BY', 'USD'), ('BZ', 'USD'),
    ('CA', 'CAD'), ('CD', 'USD'), ('CF', 'EUR'), ('CG', 'USD'), ('CH', 'CHF'), ('CI', 'XOF'),
    ('CL', 'CLP'), ('CM', 'XAF'), ('CO', 'COP'), ('CR', 'CRC'), ('CV', 'USD'), ('CY', 'EUR'),
    ('CZ', 'CZK'), ('DE', 'EUR'), ('DJ', 'USD'), ('DK', 'DKK'), ('DM', 'USD'), ('DO', 'USD'),
    ('DZ', 'DZD'), ('EC', 'USD'), ('EE', 'EUR'), ('EG', 'EGP'), ('ER', 'USD'), ('ES', 'EUR'),
    ('FI', 'EUR'), ('FJ', 'USD'), ('FM', 'USD'), ('FR', 'EUR'), ('GA', 'EUR'), ('GB', 'GBP'),
    ('GD', 'USD'), ('GE', 'GEL'), ('GH', 'GHS'), ('GI', 'GBP'), ('GM', 'USD'), ('GN', 'USD'),
    ('GR', 'EUR'), ('GT', 'USD'), ('GW', 'EUR'), ('HK', 'HKD'), ('HN', 'USD'), ('HR', 'EUR'),
    ('HT', 'USD'), ('HU', 'HUF'), ('ID', 'IDR'), ('IE', 'EUR'), ('IL', 'ILS'), ('IN', 'INR'),
    ('IQ', 'IQD'), ('IS', 'EUR'), ('IT', 'EUR'), ('JM', 'USD'), ('JO', 'JOD'), ('JP', 'JPY'),
    ('KE', 'KES'), ('KG', 'USD'), ('KH', 'USD'), ('KM', 'USD'), ('KN', 'USD'), ('KR', 'KRW'),
    ('KW', 'USD'), ('KY', 'USD'), ('KZ', 'KZT'), ('LA', 'USD'), ('LB', 'USD'), ('LC', 'USD'),
    ('LI', 'CHF'), ('LK', 'LKR'), ('LR', 'USD'), ('LT', 'EUR'), ('LU', 'EUR'), ('LV', 'EUR'),
    ('LY', 'USD'), ('MA', 'MAD'), ('MC', 'EUR'), ('MD', 'USD'), ('MK', 'USD'), ('ML', 'EUR'),
    ('MM', 'MMK'), ('MN', 'MNT'), ('MO', 'MOP'), ('MT', 'EUR'), ('MU', 'USD'), ('MV', 'USD'),
    ('MX', 'MXN'), ('MY', 'MYR'), ('MZ', 'USD'), ('NA', 'USD'), ('NE', 'EUR'), ('NG', 'NGN'),
    ('NI', 'USD'), ('NL', 'EUR'), ('NO', 'NOK'), ('NP', 'USD'), ('NZ', 'NZD'), ('OM', 'USD'),
    ('PA', 'USD'), ('PE', 'PEN'), ('PG', 'USD'), ('PH', 'PHP'), ('PK', 'PKR'), ('PL', 'PLN'),
    ('PT', 'EUR'), ('PY', 'PYG'), ('QA', 'QAR'), ('RO', 'RON'), ('RS', 'RSD'), ('RU', 'RUB'),
    ('RW', 'USD'), ('SA', 'SAR'), ('SB', 'USD'), ('SC', 'USD'), ('SE', 'SEK'), ('SG', 'SGD'),
    ('SI', 'EUR'), ('SK', 'EUR'), ('SL', 'USD'), ('SM', 'EUR'), ('SN', 'XOF'), ('SO', 'USD'),
    ('SR', 'USD'), ('SV', 'USD'), ('TC', 'USD'), ('TD', 'USD'), ('TG', 'EUR'), ('TH', 'THB'),
    ('TJ', 'USD'), ('TM', 'USD'), ('TN', 'USD'), ('TO', 'USD'), ('TR', 'TRY'), ('TT', 'USD'),
    ('TW', 'TWD'), ('TZ', 'TZS'), ('UA', 'UAH'), ('UG', 'USD'), ('US', 'USD'), ('UY', 'USD'),
    ('UZ', 'USD'), ('VA', 'EUR'), ('VE', 'USD'), ('VG', 'USD'), ('VN', 'VND'), ('VU', 'USD'),
    ('WS', 'USD'), ('YE', 'USD'), ('ZA', 'ZAR'), ('ZM', 'USD'), ('ZW', 'USD')
),
entries AS (
  SELECT
    t.id AS template_id, t.scope_type, t.scope_app_id, t.scope_account_id, t.uploaded_at,
    e.identifier, e.region_code, e.currency, e.price_micros,
    COALESCE(d.d, 2) AS decimals
  FROM google_iap_mgmt.pricing_templates t
  JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
  LEFT JOIN decimals d ON d.currency = upper(trim(e.currency))
),
bad_tiers AS (
  SELECT DISTINCT template_id, scope_type, identifier
  FROM entries en
  -- CASE, not OR: Postgres does not promise to evaluate OR left to right, and
  -- a non-numeric price_micros must never reach the ::numeric cast.
  WHERE CASE
          WHEN en.price_micros !~ '^[0-9]+$' THEN true
          WHEN en.price_micros::numeric = 0 THEN true
          ELSE mod(en.price_micros::numeric, power(10, 6 - en.decimals)::numeric) <> 0
        END
),
template_apps AS (
  -- Which apps a template applies to: ACCOUNT ⇒ every app of that account
  -- (when the import picks "Default Template"); APP ⇒ that app ("App Template").
  SELECT t.id AS template_id, a.id AS app_id, a.package_name
  FROM google_iap_mgmt.pricing_templates t
  JOIN google_iap_mgmt.apps a
    ON (t.scope_type = 'APP' AND a.id = t.scope_app_id)
    OR (t.scope_type = 'ACCOUNT' AND a.google_console_account_id = t.scope_account_id)
)
SELECT
  bt.scope_type,
  bt.template_id,
  bt.identifier AS tier,
  (SELECT string_agg(DISTINCT ta.package_name, ', ')
     FROM template_apps ta WHERE ta.template_id = bt.template_id) AS apps_using,
  (SELECT string_agg(DISTINCT ta.package_name || ':' || i.sku, ', ')
     FROM template_apps ta
     JOIN google_iap_mgmt.iaps i ON i.app_id = ta.app_id AND i.sku = bt.identifier AND i.deleted_on_google_at IS NULL
     WHERE ta.template_id = bt.template_id) AS skus_named_like_tier,
  (SELECT string_agg(
            e.region_code || ' ' || e.currency || ' ' || (e.price_micros::numeric / 1000000)::text,
            ', ' ORDER BY e.region_code)
     FROM entries e
     WHERE e.template_id = bt.template_id AND e.identifier = bt.identifier
       AND upper(trim(e.currency)) IN (SELECT currency FROM billed)
       AND CASE
             WHEN e.price_micros !~ '^[0-9]+$' THEN false
             WHEN e.price_micros::numeric = 0 THEN false
             ELSE mod(e.price_micros::numeric, power(10, 6 - e.decimals)::numeric) = 0
           END) AS matching_prices
FROM bad_tiers bt
ORDER BY bt.scope_type, bt.identifier;


-- ═══ Q4. CÂU CHẶN PUSH — các entry H4 sẽ TỪ CHỐI, từng entry, với template và chủ ══
-- KỲ VỌNG: 0 dòng. ≠ 0 ⇒ gửi kết quả lại TRƯỚC khi push.
-- CÁCH ĐỌC: mỗi dòng = một giá của một tier không gửi được. Sau H4, dòng import nào
--   DÙNG tier này (Q3) bị từ chối với lý do 'pricing-template tier "<tier>" holds a
--   price that cannot be sent — <vùng> <currency>: …'. Sửa tier trong
--   Settings → Pricing Templates (tải lại template). owner = account (template
--   ACCOUNT, "Default Template") hoặc package (template APP). price_decimal = giá
--   đang lưu, đọc như người (micros / 1 000 000).
WITH decimals(currency, d) AS (VALUES
    ('BIF', 0), ('CLP', 0), ('DJF', 0), ('GNF', 0), ('IDR', 0), ('ISK', 0),
    ('JPY', 0), ('KMF', 0), ('KRW', 0), ('LAK', 0), ('PYG', 0), ('RWF', 0),
    ('UGX', 0), ('UYI', 0), ('VND', 0), ('VUV', 0), ('XAF', 0), ('XOF', 0),
    ('XPF', 0), ('HUF', 0), ('TWD', 0), ('BHD', 3), ('IQD', 3), ('JOD', 3),
    ('KWD', 3), ('LYD', 3), ('OMR', 3), ('TND', 3), ('CLF', 4), ('UYW', 4)
),
entries AS (
  SELECT
    t.id AS template_id, t.scope_type, t.scope_app_id, t.scope_account_id, t.uploaded_at,
    e.identifier, e.region_code, e.currency, e.price_micros,
    COALESCE(d.d, 2) AS decimals
  FROM google_iap_mgmt.pricing_templates t
  JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
  LEFT JOIN decimals d ON d.currency = upper(trim(e.currency))
),
refusing AS (
  SELECT en.*,
    CASE
      WHEN en.price_micros !~ '^[0-9]+$' THEN 'not_a_number'
      WHEN en.price_micros::numeric = 0 THEN 'zero'
      WHEN mod(en.price_micros::numeric, power(10, 6 - en.decimals)::numeric) <> 0 THEN 'precision'
    END AS defect
  FROM entries en
)
SELECT
  r.scope_type,
  COALESCE(acc.display_name, app.package_name) AS owner,
  r.template_id,
  r.uploaded_at,
  r.identifier AS tier,
  r.region_code,
  r.currency,
  r.price_micros,
  CASE WHEN r.price_micros ~ '^[0-9]+$' THEN (r.price_micros::numeric / 1000000)::text END AS price_decimal,
  r.decimals AS currency_decimals,
  r.defect
FROM refusing r
LEFT JOIN google_iap_mgmt.google_console_accounts acc ON acc.id = r.scope_account_id
LEFT JOIN google_iap_mgmt.apps app ON app.id = r.scope_app_id
WHERE r.defect IS NOT NULL
ORDER BY owner, r.identifier, r.region_code;
