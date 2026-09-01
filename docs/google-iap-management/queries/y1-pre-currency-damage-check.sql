-- ═══════════════════════════════════════════════════════════════════════════
-- Y1-PRE — ĐÃ CÓ THIỆT HẠI THẬT CHƯA?
-- Google IAP Management · cặp {region, currency} sai trên store
--
-- CÂU HỎI DUY NHẤT QUERY NÀY TRẢ LỜI:
--   `defaultCurrencyForRegion` điền sai currency cho 70/173 thị trường
--   (backlog `[GOOGLE-common-regions-usd-default]`). Giá trị đó ĐI TỚI lệnh
--   ghi Google. Vậy Google đã NHẬN lần nào chưa?
--
-- ⚠ VÌ SAO MIRROR TRẢ LỜI ĐƯỢC CÂU ĐÓ
--   `google_iap_mgmt.iap_prices.currency` KHÔNG phải thứ tool gửi đi — nó
--   được ghi từ RESPONSE của Google (`repository/iaps.ts:287-291`, qua
--   `syncIapFromGoogle`). Nên một cặp sai nằm trong bảng này nghĩa là
--   **Google đã chấp nhận và đang giữ nó**.
--   Ngược lại, nếu Google từ chối thì lệnh ghi hỏng, mirror không đổi, và
--   query này ra 0 dòng.
--
-- ⇒ CÁCH ĐỌC KẾT QUẢ (đây là điều Manager cần để quyết Y1):
--   Q2 = 0 dòng  ⇒ defect CHƯA gây hại lần nào. Nhiều khả năng Google từ
--                  chối cặp sai (khớp `regions-helper.ts:52-54`). Y1 vẫn nên
--                  chạy để biết chắc, nhưng KHÔNG gấp.
--   Q2 > 0 dòng  ⇒ ĐÃ CÓ GIÁ SAI TRÊN STORE. Y1 thành GẤP, và mỗi dòng trả
--                  về là một sản phẩm đang bán sai tiền tệ.
--
-- ⚠ ĐỌC TRƯỚC KHI CHẠY
--   • TOÀN BỘ READ-ONLY. Không INSERT/UPDATE/DELETE/ALTER/CREATE.
--   • Chạy trong Supabase SQL Editor. Copy kết quả gửi lại.
--   • Mỗi query có dòng KỲ VỌNG. Lệch khỏi kỳ vọng là PHÁT HIỆN.
--
-- ⚠ GIỚI HẠN ĐÃ BIẾT, ĐỌC KÈM Q4
--   Mirror chỉ đúng tới lần Refresh gần nhất. Một lệnh ghi sai vừa xảy ra mà
--   chưa Refresh sẽ KHÔNG hiện ở đây. Q4 đo độ cũ để Manager biết "0 dòng"
--   đáng tin tới đâu.
--
-- Nguồn 173 cặp: M1 = `monetization.convertRegionPrices`, regionsVersion
-- "2025/03", đã đối chiếu Play Console màn Pricing — khớp 100%, 0/173 lệch.
-- Schema: chỉ `google_iap_mgmt`, không JOIN cross-schema.
-- ═══════════════════════════════════════════════════════════════════════════

-- Bảng tham chiếu dùng lại cho Q1-Q3.
-- (Postgres không có CTE toàn cục; mỗi query lặp lại khối WITH này.)


-- ═══ Q1. TỔNG QUAN — bao nhiêu dòng giá, bao nhiêu dòng lệch ════════════════
-- KỲ VỌNG: `rows_total` khớp census Q1 trước đó (~308.933) và
--   `regions_not_sold` = 0 (mirror đến từ Google nên không thể chứa nước
--   Google không bán). `currency_mismatch` là con số cần biết.
WITH truth(region_code, currency) AS (VALUES
  ('AE','AED'), ('AG','USD'), ('AL','USD'), ('AM','USD'), ('AO','USD'),
  ('AR','USD'), ('AT','EUR'), ('AU','AUD'), ('AW','USD'), ('AZ','USD'),
  ('BA','USD'), ('BD','BDT'), ('BE','EUR'), ('BF','EUR'), ('BG','EUR'),
  ('BH','USD'), ('BJ','EUR'), ('BM','USD'), ('BO','BOB'), ('BR','BRL'),
  ('BS','USD'), ('BW','USD'), ('BY','USD'), ('BZ','USD'), ('CA','CAD'),
  ('CD','USD'), ('CF','EUR'), ('CG','USD'), ('CH','CHF'), ('CI','XOF'),
  ('CL','CLP'), ('CM','XAF'), ('CO','COP'), ('CR','CRC'), ('CV','USD'),
  ('CY','EUR'), ('CZ','CZK'), ('DE','EUR'), ('DJ','USD'), ('DK','DKK'),
  ('DM','USD'), ('DO','USD'), ('DZ','DZD'), ('EC','USD'), ('EE','EUR'),
  ('EG','EGP'), ('ER','USD'), ('ES','EUR'), ('FI','EUR'), ('FJ','USD'),
  ('FM','USD'), ('FR','EUR'), ('GA','EUR'), ('GB','GBP'), ('GD','USD'),
  ('GE','GEL'), ('GH','GHS'), ('GI','GBP'), ('GM','USD'), ('GN','USD'),
  ('GR','EUR'), ('GT','USD'), ('GW','EUR'), ('HK','HKD'), ('HN','USD'),
  ('HR','EUR'), ('HT','USD'), ('HU','HUF'), ('ID','IDR'), ('IE','EUR'),
  ('IL','ILS'), ('IN','INR'), ('IQ','IQD'), ('IS','EUR'), ('IT','EUR'),
  ('JM','USD'), ('JO','JOD'), ('JP','JPY'), ('KE','KES'), ('KG','USD'),
  ('KH','USD'), ('KM','USD'), ('KN','USD'), ('KR','KRW'), ('KW','USD'),
  ('KY','USD'), ('KZ','KZT'), ('LA','USD'), ('LB','USD'), ('LC','USD'),
  ('LI','CHF'), ('LK','LKR'), ('LR','USD'), ('LT','EUR'), ('LU','EUR'),
  ('LV','EUR'), ('LY','USD'), ('MA','MAD'), ('MC','EUR'), ('MD','USD'),
  ('MK','USD'), ('ML','EUR'), ('MM','MMK'), ('MN','MNT'), ('MO','MOP'),
  ('MT','EUR'), ('MU','USD'), ('MV','USD'), ('MX','MXN'), ('MY','MYR'),
  ('MZ','USD'), ('NA','USD'), ('NE','EUR'), ('NG','NGN'), ('NI','USD'),
  ('NL','EUR'), ('NO','NOK'), ('NP','USD'), ('NZ','NZD'), ('OM','USD'),
  ('PA','USD'), ('PE','PEN'), ('PG','USD'), ('PH','PHP'), ('PK','PKR'),
  ('PL','PLN'), ('PT','EUR'), ('PY','PYG'), ('QA','QAR'), ('RO','RON'),
  ('RS','RSD'), ('RU','RUB'), ('RW','USD'), ('SA','SAR'), ('SB','USD'),
  ('SC','USD'), ('SE','SEK'), ('SG','SGD'), ('SI','EUR'), ('SK','EUR'),
  ('SL','USD'), ('SM','EUR'), ('SN','XOF'), ('SO','USD'), ('SR','USD'),
  ('SV','USD'), ('TC','USD'), ('TD','USD'), ('TG','EUR'), ('TH','THB'),
  ('TJ','USD'), ('TM','USD'), ('TN','USD'), ('TO','USD'), ('TR','TRY'),
  ('TT','USD'), ('TW','TWD'), ('TZ','TZS'), ('UA','UAH'), ('UG','USD'),
  ('US','USD'), ('UY','USD'), ('UZ','USD'), ('VA','EUR'), ('VE','USD'),
  ('VG','USD'), ('VN','VND'), ('VU','USD'), ('WS','USD'), ('YE','USD'),
  ('ZA','ZAR'), ('ZM','USD'), ('ZW','USD')
)
SELECT
  COUNT(*)                                                        AS rows_total,
  COUNT(*) FILTER (WHERE t.region_code IS NULL)                   AS regions_not_sold,
  COUNT(*) FILTER (WHERE t.region_code IS NOT NULL
                     AND p.currency <> t.currency)                AS currency_mismatch,
  COUNT(DISTINCT p.iap_id) FILTER (WHERE t.region_code IS NOT NULL
                     AND p.currency <> t.currency)                AS iaps_affected
FROM google_iap_mgmt.iap_prices p
LEFT JOIN truth t ON t.region_code = p.region_code;


-- ═══ Q2. ⚠ CÂU CHẶN CỬA — liệt kê TỪNG dòng có currency sai ════════════════
-- KỲ VỌNG: **0 dòng.**
--   0 dòng  ⇒ chưa lần nào Google nhận một cặp sai ⇒ Y1 không gấp.
--   >0 dòng ⇒ mỗi dòng là một sản phẩm đang bán sai tiền tệ trên Google Play.
-- ⚠ ĐỪNG BỎ QUA CỘT `expected_currency` — nó cho biết đúng ra phải là gì,
--   nên kết quả này dùng thẳng được làm danh sách sửa.
WITH truth(region_code, currency) AS (VALUES
  ('AE','AED'), ('AG','USD'), ('AL','USD'), ('AM','USD'), ('AO','USD'),
  ('AR','USD'), ('AT','EUR'), ('AU','AUD'), ('AW','USD'), ('AZ','USD'),
  ('BA','USD'), ('BD','BDT'), ('BE','EUR'), ('BF','EUR'), ('BG','EUR'),
  ('BH','USD'), ('BJ','EUR'), ('BM','USD'), ('BO','BOB'), ('BR','BRL'),
  ('BS','USD'), ('BW','USD'), ('BY','USD'), ('BZ','USD'), ('CA','CAD'),
  ('CD','USD'), ('CF','EUR'), ('CG','USD'), ('CH','CHF'), ('CI','XOF'),
  ('CL','CLP'), ('CM','XAF'), ('CO','COP'), ('CR','CRC'), ('CV','USD'),
  ('CY','EUR'), ('CZ','CZK'), ('DE','EUR'), ('DJ','USD'), ('DK','DKK'),
  ('DM','USD'), ('DO','USD'), ('DZ','DZD'), ('EC','USD'), ('EE','EUR'),
  ('EG','EGP'), ('ER','USD'), ('ES','EUR'), ('FI','EUR'), ('FJ','USD'),
  ('FM','USD'), ('FR','EUR'), ('GA','EUR'), ('GB','GBP'), ('GD','USD'),
  ('GE','GEL'), ('GH','GHS'), ('GI','GBP'), ('GM','USD'), ('GN','USD'),
  ('GR','EUR'), ('GT','USD'), ('GW','EUR'), ('HK','HKD'), ('HN','USD'),
  ('HR','EUR'), ('HT','USD'), ('HU','HUF'), ('ID','IDR'), ('IE','EUR'),
  ('IL','ILS'), ('IN','INR'), ('IQ','IQD'), ('IS','EUR'), ('IT','EUR'),
  ('JM','USD'), ('JO','JOD'), ('JP','JPY'), ('KE','KES'), ('KG','USD'),
  ('KH','USD'), ('KM','USD'), ('KN','USD'), ('KR','KRW'), ('KW','USD'),
  ('KY','USD'), ('KZ','KZT'), ('LA','USD'), ('LB','USD'), ('LC','USD'),
  ('LI','CHF'), ('LK','LKR'), ('LR','USD'), ('LT','EUR'), ('LU','EUR'),
  ('LV','EUR'), ('LY','USD'), ('MA','MAD'), ('MC','EUR'), ('MD','USD'),
  ('MK','USD'), ('ML','EUR'), ('MM','MMK'), ('MN','MNT'), ('MO','MOP'),
  ('MT','EUR'), ('MU','USD'), ('MV','USD'), ('MX','MXN'), ('MY','MYR'),
  ('MZ','USD'), ('NA','USD'), ('NE','EUR'), ('NG','NGN'), ('NI','USD'),
  ('NL','EUR'), ('NO','NOK'), ('NP','USD'), ('NZ','NZD'), ('OM','USD'),
  ('PA','USD'), ('PE','PEN'), ('PG','USD'), ('PH','PHP'), ('PK','PKR'),
  ('PL','PLN'), ('PT','EUR'), ('PY','PYG'), ('QA','QAR'), ('RO','RON'),
  ('RS','RSD'), ('RU','RUB'), ('RW','USD'), ('SA','SAR'), ('SB','USD'),
  ('SC','USD'), ('SE','SEK'), ('SG','SGD'), ('SI','EUR'), ('SK','EUR'),
  ('SL','USD'), ('SM','EUR'), ('SN','XOF'), ('SO','USD'), ('SR','USD'),
  ('SV','USD'), ('TC','USD'), ('TD','USD'), ('TG','EUR'), ('TH','THB'),
  ('TJ','USD'), ('TM','USD'), ('TN','USD'), ('TO','USD'), ('TR','TRY'),
  ('TT','USD'), ('TW','TWD'), ('TZ','TZS'), ('UA','UAH'), ('UG','USD'),
  ('US','USD'), ('UY','USD'), ('UZ','USD'), ('VA','EUR'), ('VE','USD'),
  ('VG','USD'), ('VN','VND'), ('VU','USD'), ('WS','USD'), ('YE','USD'),
  ('ZA','ZAR'), ('ZM','USD'), ('ZW','USD')
)
SELECT
  a.package_name,
  i.sku,
  i.status,
  p.region_code,
  p.currency                                    AS currency_on_google,
  t.currency                                    AS expected_currency,
  p.price_micros,
  p.updated_at                                  AS price_row_updated_at,
  i.last_synced_at
FROM google_iap_mgmt.iap_prices p
JOIN truth t         ON t.region_code = p.region_code
JOIN google_iap_mgmt.iaps i ON i.id = p.iap_id
JOIN google_iap_mgmt.apps a ON a.id = i.app_id
WHERE p.currency <> t.currency
ORDER BY a.package_name, i.sku, p.region_code;


-- ═══ Q2b. Gộp theo cặp — nếu Q2 ra nhiều, đọc cái này trước ═════════════════
-- KỲ VỌNG: 0 dòng (hệ quả của Q2).
-- Nếu có dòng: cột `n_price_rows` cho biết lỗi lan rộng hay chỉ một vài SKU.
-- ⚠ Đặc biệt chú ý dòng có `currency_on_google = 'USD'` — đó đúng là dấu vân
--   tay của fallback `defaultCurrencyForRegion` (145/173 thị trường rơi về
--   USD). Một cặp sai KHÔNG phải USD thì đến từ nguyên nhân khác, và cần
--   điều tra riêng chứ đừng gộp vào cùng một kết luận.
WITH truth(region_code, currency) AS (VALUES
  ('AE','AED'), ('AG','USD'), ('AL','USD'), ('AM','USD'), ('AO','USD'),
  ('AR','USD'), ('AT','EUR'), ('AU','AUD'), ('AW','USD'), ('AZ','USD'),
  ('BA','USD'), ('BD','BDT'), ('BE','EUR'), ('BF','EUR'), ('BG','EUR'),
  ('BH','USD'), ('BJ','EUR'), ('BM','USD'), ('BO','BOB'), ('BR','BRL'),
  ('BS','USD'), ('BW','USD'), ('BY','USD'), ('BZ','USD'), ('CA','CAD'),
  ('CD','USD'), ('CF','EUR'), ('CG','USD'), ('CH','CHF'), ('CI','XOF'),
  ('CL','CLP'), ('CM','XAF'), ('CO','COP'), ('CR','CRC'), ('CV','USD'),
  ('CY','EUR'), ('CZ','CZK'), ('DE','EUR'), ('DJ','USD'), ('DK','DKK'),
  ('DM','USD'), ('DO','USD'), ('DZ','DZD'), ('EC','USD'), ('EE','EUR'),
  ('EG','EGP'), ('ER','USD'), ('ES','EUR'), ('FI','EUR'), ('FJ','USD'),
  ('FM','USD'), ('FR','EUR'), ('GA','EUR'), ('GB','GBP'), ('GD','USD'),
  ('GE','GEL'), ('GH','GHS'), ('GI','GBP'), ('GM','USD'), ('GN','USD'),
  ('GR','EUR'), ('GT','USD'), ('GW','EUR'), ('HK','HKD'), ('HN','USD'),
  ('HR','EUR'), ('HT','USD'), ('HU','HUF'), ('ID','IDR'), ('IE','EUR'),
  ('IL','ILS'), ('IN','INR'), ('IQ','IQD'), ('IS','EUR'), ('IT','EUR'),
  ('JM','USD'), ('JO','JOD'), ('JP','JPY'), ('KE','KES'), ('KG','USD'),
  ('KH','USD'), ('KM','USD'), ('KN','USD'), ('KR','KRW'), ('KW','USD'),
  ('KY','USD'), ('KZ','KZT'), ('LA','USD'), ('LB','USD'), ('LC','USD'),
  ('LI','CHF'), ('LK','LKR'), ('LR','USD'), ('LT','EUR'), ('LU','EUR'),
  ('LV','EUR'), ('LY','USD'), ('MA','MAD'), ('MC','EUR'), ('MD','USD'),
  ('MK','USD'), ('ML','EUR'), ('MM','MMK'), ('MN','MNT'), ('MO','MOP'),
  ('MT','EUR'), ('MU','USD'), ('MV','USD'), ('MX','MXN'), ('MY','MYR'),
  ('MZ','USD'), ('NA','USD'), ('NE','EUR'), ('NG','NGN'), ('NI','USD'),
  ('NL','EUR'), ('NO','NOK'), ('NP','USD'), ('NZ','NZD'), ('OM','USD'),
  ('PA','USD'), ('PE','PEN'), ('PG','USD'), ('PH','PHP'), ('PK','PKR'),
  ('PL','PLN'), ('PT','EUR'), ('PY','PYG'), ('QA','QAR'), ('RO','RON'),
  ('RS','RSD'), ('RU','RUB'), ('RW','USD'), ('SA','SAR'), ('SB','USD'),
  ('SC','USD'), ('SE','SEK'), ('SG','SGD'), ('SI','EUR'), ('SK','EUR'),
  ('SL','USD'), ('SM','EUR'), ('SN','XOF'), ('SO','USD'), ('SR','USD'),
  ('SV','USD'), ('TC','USD'), ('TD','USD'), ('TG','EUR'), ('TH','THB'),
  ('TJ','USD'), ('TM','USD'), ('TN','USD'), ('TO','USD'), ('TR','TRY'),
  ('TT','USD'), ('TW','TWD'), ('TZ','TZS'), ('UA','UAH'), ('UG','USD'),
  ('US','USD'), ('UY','USD'), ('UZ','USD'), ('VA','EUR'), ('VE','USD'),
  ('VG','USD'), ('VN','VND'), ('VU','USD'), ('WS','USD'), ('YE','USD'),
  ('ZA','ZAR'), ('ZM','USD'), ('ZW','USD')
)
SELECT
  p.region_code,
  p.currency                                    AS currency_on_google,
  t.currency                                    AS expected_currency,
  (p.currency = 'USD')                          AS matches_usd_fallback_fingerprint,
  COUNT(*)                                      AS n_price_rows,
  COUNT(DISTINCT p.iap_id)                      AS n_iaps
FROM google_iap_mgmt.iap_prices p
JOIN truth t ON t.region_code = p.region_code
WHERE p.currency <> t.currency
GROUP BY p.region_code, p.currency, t.currency
ORDER BY n_price_rows DESC;


-- ═══ Q3. Mã region trong mirror mà KHÔNG nằm trong 173 ══════════════════════
-- KỲ VỌNG: **0 dòng.** Mirror ghi từ response của Google, nên không thể chứa
--   nước Google không bán. Một dòng ở đây nghĩa là một trong hai:
--     (a) tập 173 của M1 đã cũ (Google đổi danh sách — kiểm regionsVersion), hoặc
--     (b) mirror còn dữ liệu từ trước khi Google ngừng bán ở đó.
--   Cả hai đều đáng biết trước khi X4 ghim snapshot 173.
WITH truth(region_code, currency) AS (VALUES
  ('AE','AED'), ('AG','USD'), ('AL','USD'), ('AM','USD'), ('AO','USD'),
  ('AR','USD'), ('AT','EUR'), ('AU','AUD'), ('AW','USD'), ('AZ','USD'),
  ('BA','USD'), ('BD','BDT'), ('BE','EUR'), ('BF','EUR'), ('BG','EUR'),
  ('BH','USD'), ('BJ','EUR'), ('BM','USD'), ('BO','BOB'), ('BR','BRL'),
  ('BS','USD'), ('BW','USD'), ('BY','USD'), ('BZ','USD'), ('CA','CAD'),
  ('CD','USD'), ('CF','EUR'), ('CG','USD'), ('CH','CHF'), ('CI','XOF'),
  ('CL','CLP'), ('CM','XAF'), ('CO','COP'), ('CR','CRC'), ('CV','USD'),
  ('CY','EUR'), ('CZ','CZK'), ('DE','EUR'), ('DJ','USD'), ('DK','DKK'),
  ('DM','USD'), ('DO','USD'), ('DZ','DZD'), ('EC','USD'), ('EE','EUR'),
  ('EG','EGP'), ('ER','USD'), ('ES','EUR'), ('FI','EUR'), ('FJ','USD'),
  ('FM','USD'), ('FR','EUR'), ('GA','EUR'), ('GB','GBP'), ('GD','USD'),
  ('GE','GEL'), ('GH','GHS'), ('GI','GBP'), ('GM','USD'), ('GN','USD'),
  ('GR','EUR'), ('GT','USD'), ('GW','EUR'), ('HK','HKD'), ('HN','USD'),
  ('HR','EUR'), ('HT','USD'), ('HU','HUF'), ('ID','IDR'), ('IE','EUR'),
  ('IL','ILS'), ('IN','INR'), ('IQ','IQD'), ('IS','EUR'), ('IT','EUR'),
  ('JM','USD'), ('JO','JOD'), ('JP','JPY'), ('KE','KES'), ('KG','USD'),
  ('KH','USD'), ('KM','USD'), ('KN','USD'), ('KR','KRW'), ('KW','USD'),
  ('KY','USD'), ('KZ','KZT'), ('LA','USD'), ('LB','USD'), ('LC','USD'),
  ('LI','CHF'), ('LK','LKR'), ('LR','USD'), ('LT','EUR'), ('LU','EUR'),
  ('LV','EUR'), ('LY','USD'), ('MA','MAD'), ('MC','EUR'), ('MD','USD'),
  ('MK','USD'), ('ML','EUR'), ('MM','MMK'), ('MN','MNT'), ('MO','MOP'),
  ('MT','EUR'), ('MU','USD'), ('MV','USD'), ('MX','MXN'), ('MY','MYR'),
  ('MZ','USD'), ('NA','USD'), ('NE','EUR'), ('NG','NGN'), ('NI','USD'),
  ('NL','EUR'), ('NO','NOK'), ('NP','USD'), ('NZ','NZD'), ('OM','USD'),
  ('PA','USD'), ('PE','PEN'), ('PG','USD'), ('PH','PHP'), ('PK','PKR'),
  ('PL','PLN'), ('PT','EUR'), ('PY','PYG'), ('QA','QAR'), ('RO','RON'),
  ('RS','RSD'), ('RU','RUB'), ('RW','USD'), ('SA','SAR'), ('SB','USD'),
  ('SC','USD'), ('SE','SEK'), ('SG','SGD'), ('SI','EUR'), ('SK','EUR'),
  ('SL','USD'), ('SM','EUR'), ('SN','XOF'), ('SO','USD'), ('SR','USD'),
  ('SV','USD'), ('TC','USD'), ('TD','USD'), ('TG','EUR'), ('TH','THB'),
  ('TJ','USD'), ('TM','USD'), ('TN','USD'), ('TO','USD'), ('TR','TRY'),
  ('TT','USD'), ('TW','TWD'), ('TZ','TZS'), ('UA','UAH'), ('UG','USD'),
  ('US','USD'), ('UY','USD'), ('UZ','USD'), ('VA','EUR'), ('VE','USD'),
  ('VG','USD'), ('VN','VND'), ('VU','USD'), ('WS','USD'), ('YE','USD'),
  ('ZA','ZAR'), ('ZM','USD'), ('ZW','USD')
)
SELECT
  p.region_code,
  COUNT(*)                  AS n_price_rows,
  COUNT(DISTINCT p.iap_id)  AS n_iaps,
  MIN(p.created_at)         AS first_seen,
  MAX(p.updated_at)         AS last_updated
FROM google_iap_mgmt.iap_prices p
LEFT JOIN truth t ON t.region_code = p.region_code
WHERE t.region_code IS NULL
GROUP BY p.region_code
ORDER BY n_price_rows DESC;


-- ═══ Q4. ĐỘ CŨ CỦA MIRROR — "0 dòng" đáng tin tới đâu ══════════════════════
-- KỲ VỌNG: không có kỳ vọng cứng — đây là phép đo độ tin cậy của Q2.
-- Cách đọc: nếu `oldest_sync` cách đây nhiều ngày, thì "Q2 = 0 dòng" mới chỉ
--   chứng minh "không có cặp sai TÍNH TỚI lần Refresh đó", không phải "chưa
--   bao giờ có". Bấm Refresh trên các app rồi chạy lại Q2 sẽ chặt hơn.
SELECT
  COUNT(*)                                    AS iaps_total,
  COUNT(*) FILTER (WHERE last_synced_at IS NULL) AS never_synced,
  MIN(last_synced_at)                         AS oldest_sync,
  MAX(last_synced_at)                         AS newest_sync,
  NOW() - MIN(last_synced_at)                 AS oldest_sync_age
FROM google_iap_mgmt.iaps
WHERE deleted_on_google_at IS NULL;


-- ═══ Q5. Dấu vết trong audit log — có lần ghi nào ĐỔI currency không? ═══════
-- ⚠ ĐỌC GIỚI HẠN TRƯỚC KHI TIN KẾT QUẢ:
--   · `IAP_UPDATE` ghi `payload->'prices'` là một DIFF (`orchestration/
--     update-iap.ts:310-330`) — có thể thấy currency đổi.
--   · `IAP_CREATE` thì KHÔNG: payload chỉ có `region_overrides` là một SỐ ĐẾM
--     (`orchestration/create-iap.ts:184-196`), không có currency từng region.
--   ⇒ Query này KHÔNG phủ được đường Create. Q2 (mirror) mới là phép đo đầy
--     đủ; đây chỉ là bằng chứng bổ sung cho đường Update.
-- KỲ VỌNG: không có kỳ vọng cứng. Dòng trả về là ứng viên để đọc tay.
SELECT
  created_at,
  actor_email,
  payload->>'package_name'  AS package_name,
  payload->>'sku'           AS sku,
  payload->'prices'         AS prices_diff
FROM google_iap_mgmt.actions_log
WHERE action_type = 'IAP_UPDATE'
  AND payload->'prices' IS NOT NULL
  AND payload::text ILIKE '%currency%'
ORDER BY created_at DESC
LIMIT 50;
