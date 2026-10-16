-- ============================================================
-- Kiểm SAU KHI chạy 2 migration của arc arc-google-missing-purchase-options:
--   C1  20261016000000_google_iap_mgmt_apps_iaps_last_synced.sql
--   C2  20261016010000_google_iap_mgmt_apps_defaults_source.sql
-- Chạy C1 rồi C2 (theo tên file), rồi chạy file này. CHỈ ĐỌC.
-- ⛔ Push C1 + C2 chỉ khi MỌI dòng KỲ VỌNG dưới đây khớp.
--
-- ⚠ ROLLBACK (Railway về bản TRƯỚC C2) SAU KHI Manager đã Confirm/Declare:
--   code cũ (Hotfix 4) lại ghi đè currency/language lúc Refresh IAP, và DB
--   KHÔNG tự hạ provenance — giá trị đoán mới vẫn mang nhãn 'declared' (đo trên
--   PGlite: UPDATE chỉ đổi giá trị ⇒ source giữ nguyên). Trước khi deploy lại
--   C2, chạy (sau khi Manager duyệt):
--     UPDATE google_iap_mgmt.apps SET default_currency_source = 'guessed'
--      WHERE default_currency_source = 'declared';   -- và tương tự cho language
--   rồi Manager xác nhận lại từng app. (Trigger chặn ở DB = câu hỏi mở cho Manager.)
-- ============================================================


-- @@ V1.1 — C1: cột iaps_last_synced_at tồn tại
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'google_iap_mgmt' AND table_name = 'apps' AND column_name = 'iaps_last_synced_at';
-- KỲ VỌNG: đúng 1 dòng: iaps_last_synced_at | timestamp with time zone | YES


-- @@ V1.2 — C1: không backfill
SELECT count(*) AS total_apps, count(iaps_last_synced_at) AS stamped
FROM google_iap_mgmt.apps;
-- KỲ VỌNG: stamped = 0 — mọi app cần bấm "Refresh IAP list" 1 lần sau deploy.


-- @@ V2.1 — C2: hai cột provenance tồn tại
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'google_iap_mgmt' AND table_name = 'apps'
  AND column_name IN ('default_currency_source', 'default_language_source')
ORDER BY column_name;
-- KỲ VỌNG: đúng 2 dòng, cả hai: text | YES


-- @@ V2.2 — C2: mọi giá trị hiện có = 'guessed', KHÔNG có 'declared'
SELECT
  count(*)                                                     AS apps,
  count(*) FILTER (WHERE default_currency IS NOT NULL)         AS with_currency,
  count(*) FILTER (WHERE default_currency_source = 'guessed')  AS currency_guessed,
  count(*) FILTER (WHERE default_language IS NOT NULL)         AS with_language,
  count(*) FILTER (WHERE default_language_source = 'guessed')  AS language_guessed,
  count(*) FILTER (WHERE default_currency_source = 'declared'
                      OR default_language_source = 'declared') AS declared
FROM google_iap_mgmt.apps;
-- KỲ VỌNG: currency_guessed = with_currency · language_guessed = with_language · declared = 0


-- @@ V2.3 — C2: hai CHECK coherence có mặt và có "IS NOT NULL"
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = 'google_iap_mgmt.apps'::regclass
  AND conname IN ('apps_default_currency_source_check', 'apps_default_language_source_check')
ORDER BY conname;
-- KỲ VỌNG: đúng 2 dòng; mỗi `def` chứa "_source IS NOT NULL", cả 'declared' lẫn
--   'guessed' (Postgres hiển thị IN (...) thành `= ANY (ARRAY['declared'::text, 'guessed'::text])`),
--   và "btrim(" (giá trị rỗng/khoảng trắng không thể là 'declared').


-- @@ V2.4 — C2: CHECK của actions_log nhận APP_DEFAULTS_DECLARE
SELECT pg_get_constraintdef(oid) LIKE '%APP_DEFAULTS_DECLARE%' AS has_app_defaults_declare
FROM pg_constraint
WHERE conrelid = 'google_iap_mgmt.actions_log'::regclass
  AND conname = 'actions_log_action_type_check';
-- KỲ VỌNG: đúng 1 dòng: true


-- @@ V2.5 — C2: GIÁ TRỊ không đổi, chỉ thêm nguồn (kiểm 彈彈英雄)
SELECT package_name, default_currency, default_currency_source,
       default_language, default_language_source, iaps_last_synced_at
FROM google_iap_mgmt.apps
WHERE package_name = 'com.vnggames.ballisticherotwid';
-- KỲ VỌNG: currency/language Y NHƯ trước migration (theo Q0 hôm 16/10: USD / en-US),
--   cả hai source = 'guessed'. Sau deploy Manager bấm "Confirm USD" ⇒ currency 'declared';
--   language để nguyên 'guessed' cho tới khi Manager xác nhận (en-US hay zh-TW).
