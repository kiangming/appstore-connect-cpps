-- ============================================================
-- Kiểm migration của arc arc-google-missing-purchase-options — CHỈ ĐỌC.
--   C1    20261016000000_google_iap_mgmt_apps_iaps_last_synced.sql
--   C2    20261016010000_google_iap_mgmt_apps_defaults_source.sql
--   C2.1  20261016020000_google_iap_mgmt_apps_iaps_last_synced_backfill.sql
--
-- THỨ TỰ (mỗi bước xong mới sang bước sau):
--   0. TRƯỚC MỌI MIGRATION: chạy queries/snapshot-ballisticherotwid-after-overwrite.sql
--      và lưu kết quả (C2 làm nhảy apps.updated_at).
--   1. Migration C1.            2. Migration C2.
--   3. File này: V1.1 → V2.5.   Mọi KỲ VỌNG phải khớp.
--   4. File này: D0, D1, D2 (dry-run C2.1). Đọc kỹ mọi dòng D1 có vs_*_rule
--      = 'KHÁC…' hoặc review_flag khác NULL — báo lại trước khi chạy bước 5.
--   5. Migration C2.1.          6. File này: V3.1 → V3.5.
--   7. Báo agent ⇒ agent push C1 + C2 + C2.1 một lượt (git push origin HEAD:main).
--      Bước 5 chạy càng sát lúc push càng tốt.
--   8. Sau khi Railway deploy xong: chạy V3.1 + V3.3. V3.3 có dòng ⇒ báo lại;
--      cách xử lý: bấm Refresh app đó (trên code MỚI). KHÔNG chạy lại migration —
--      backfill chỉ chạy một lần.
-- ⛔ Từ bước 1 tới khi deploy xong: KHÔNG AI bấm Refresh (trang app, "Refresh IAP
--    list", "Sync from Google"). Code đang chạy (bản cũ) vẫn ghi đè currency/
--    language của app khi Refresh, và Refresh trên code cũ không ghi stamp.
-- ⛔ Push chỉ khi MỌI dòng KỲ VỌNG khớp.
--
-- ⚠ ROLLBACK (Railway về bản TRƯỚC C2) SAU KHI Manager đã Confirm/Declare:
--   code cũ (Hotfix 4) lại ghi đè currency/language lúc Refresh IAP, và DB
--   KHÔNG tự hạ provenance — giá trị đoán mới vẫn mang nhãn 'declared' (đo trên
--   PGlite: UPDATE chỉ đổi giá trị ⇒ source giữ nguyên). Trước khi deploy lại
--   C2, chạy (sau khi Manager duyệt):
--     UPDATE google_iap_mgmt.apps SET default_currency_source = 'guessed'
--      WHERE default_currency_source = 'declared';   -- và tương tự cho language
--   rồi Manager xác nhận lại từng app. (Manager 2026-10-16: không làm trigger.)
-- ============================================================


-- @@ V1.1 — C1: cột iaps_last_synced_at tồn tại
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'google_iap_mgmt' AND table_name = 'apps' AND column_name = 'iaps_last_synced_at';
-- KỲ VỌNG: đúng 1 dòng: iaps_last_synced_at | timestamp with time zone | YES


-- @@ V1.2 — C1: không backfill
SELECT count(*) AS total_apps, count(iaps_last_synced_at) AS stamped
FROM google_iap_mgmt.apps;
-- KỲ VỌNG: stamped = 0 — đúng khi chạy TRƯỚC migration C2.1 (backfill). Sau C2.1
--   xem V3.1.


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


-- ============================================================
-- C2.1 — DRY-RUN (bước 4, TRƯỚC migration C2.1). Cần cột của C1.
-- Khối `params` / `log` / `classified` bên dưới CHÉP NGUYÊN VĂN từ migration
-- 20261016020000 (test app-defaults.structural.test.ts block B ghim điều này):
-- dry-run và lệnh ghi không thể lệch nhau.
-- ============================================================


-- @@ D0 — actions_log có bị mất lịch sử không? (gợi ý, KHÔNG phải bằng chứng)
SELECT l.action_type, COUNT(*) AS n, MIN(l.created_at) AS first_at, MAX(l.created_at) AS last_at
FROM google_iap_mgmt.actions_log l
GROUP BY l.action_type
ORDER BY first_at;
-- KỲ VỌNG: IAPS_LIST_SYNC first_at quanh 2026-05-20/21 (lúc module ra mắt). Chỉ là
--   gợi ý: câu này chỉ thấy mất ở ĐẦU lịch sử, không thấy mất ở giữa; DML tay trên
--   actions_log là được phép theo thiết kế (init.sql:233-235) ⇒ CHƯA BIẾT.


-- @@ D1 — DRY-RUN: mỗi app ROW (account × package) đúng 1 dòng
WITH params AS (
  SELECT TIMESTAMPTZ '2026-05-21 14:52:44+00' AS min_created_at
),
log AS (
  -- Payload values are cast ONLY when jsonb_typeof = 'number' (CASE fixes the
  -- evaluation order): "0", null, true, a missing key ⇒ NULL, never an error.
  SELECT l.id, l.target_id, l.created_at, l.payload,
    (jsonb_typeof(l.payload) = 'object') AS is_obj,
    CASE WHEN jsonb_typeof(l.payload) = 'object'
         THEN (l.payload ? 'scope' OR l.payload ? 'sku') ELSE false END AS is_single,
    CASE WHEN jsonb_typeof(l.payload->'synced') = 'number' THEN (l.payload->>'synced')::numeric END AS synced_n,
    CASE WHEN jsonb_typeof(l.payload->'failed') = 'number' THEN (l.payload->>'failed')::numeric END AS failed_n,
    CASE WHEN jsonb_typeof(l.payload->'total')  = 'number' THEN (l.payload->>'total')::numeric  END AS total_n
  FROM google_iap_mgmt.actions_log l
  WHERE l.action_type = 'IAPS_LIST_SYNC'
),
classified AS (
  SELECT g.*, a.id AS app_id,
    CASE
      WHEN NOT g.is_obj THEN 'bad_payload'
      WHEN g.is_single THEN 'single_item'
      WHEN g.synced_n IS NULL OR g.failed_n IS NULL OR g.total_n IS NULL THEN 'bad_payload'
      WHEN g.failed_n > 0 THEN 'failed'
      WHEN g.failed_n < 0 OR g.synced_n < 0 OR g.total_n <> g.synced_n + g.failed_n THEN 'inconsistent'
      WHEN g.synced_n = 0 THEN 'zero_products'
      WHEN COALESCE(g.payload->>'flag_reconcile_skipped', '') LIKE 'incoming_below%' THEN 'degraded'
      WHEN g.payload->>'package_name' IS DISTINCT FROM a.package_name THEN 'package_mismatch'
      WHEN g.created_at < p.min_created_at THEN 'pre_cutoff'
      ELSE 'ok'
    END AS cls
  FROM log g
  JOIN google_iap_mgmt.apps a ON a.id = g.target_id
  CROSS JOIN params p
)
, flags AS (
  -- Chỉ để SO SÁNH, không quyết định gì: câu chữ "synced>0 & failed=0" và điều
  -- kiện route hôm nay (failed=0) sẽ chọn dòng nào.
  SELECT c.*,
    COALESCE(c.synced_n > 0 AND c.failed_n = 0, false) AS literal_ok,
    COALESCE(c.is_obj AND NOT c.is_single AND c.failed_n = 0, false) AS route_ok
  FROM classified c
)
, per_app AS (
  SELECT f.app_id,
    MAX(f.created_at) FILTER (WHERE f.cls = 'ok')          AS latest_ok_at,
    MAX(f.created_at) FILTER (WHERE f.literal_ok)          AS latest_literal_at,
    MAX(f.created_at) FILTER (WHERE f.route_ok)            AS latest_route_at,
    MAX(f.created_at) FILTER (WHERE f.cls = 'single_item') AS latest_single_at,
    COUNT(*) FILTER (WHERE f.cls <> 'single_item')         AS n_full,
    COUNT(*) FILTER (WHERE f.cls = 'failed')               AS n_failed,
    COUNT(*) FILTER (WHERE f.cls = 'zero_products')        AS n_zero,
    COUNT(*) FILTER (WHERE f.cls = 'degraded')             AS n_degraded,
    COUNT(*) FILTER (WHERE f.cls = 'bad_payload')          AS n_bad,
    COUNT(*) FILTER (WHERE f.cls = 'inconsistent')         AS n_inconsistent,
    COUNT(*) FILTER (WHERE f.cls = 'package_mismatch')     AS n_pkg_mismatch,
    COUNT(*) FILTER (WHERE f.cls = 'pre_cutoff')           AS n_pre_cutoff
  FROM flags f
  GROUP BY f.app_id
),
latest_full AS (
  SELECT DISTINCT ON (f.app_id) f.app_id, f.created_at, f.cls,
    f.payload->>'synced' AS synced_raw, f.payload->>'failed' AS failed_raw,
    f.payload->>'total' AS total_raw, f.payload->>'flag_reconcile_skipped' AS flag_skip
  FROM flags f
  WHERE f.cls <> 'single_item'
  ORDER BY f.app_id, f.created_at DESC, f.id DESC
),
picked AS (
  SELECT DISTINCT ON (f.app_id) f.app_id, f.total_n AS total_at_pick
  FROM flags f
  WHERE f.cls = 'ok'
  ORDER BY f.app_id, f.created_at DESC, f.id DESC
),
mirror AS (
  SELECT i.app_id,
    COUNT(*) FILTER (WHERE i.deleted_on_google_at IS NULL) AS n_live,
    COUNT(*) FILTER (WHERE i.deleted_on_google_at IS NOT NULL) AS n_flagged
  FROM google_iap_mgmt.iaps i
  GROUP BY i.app_id
)
SELECT
  a.package_name,
  acc.display_name                         AS account_name,
  a.id                                     AS app_id,
  CASE WHEN a.iaps_last_synced_at IS NULL AND pa.latest_ok_at IS NOT NULL
             AND COALESCE(m.n_live, 0) > 0 THEN 'yes' ELSE 'no' END AS will_backfill,
  CASE WHEN a.iaps_last_synced_at IS NULL AND COALESCE(m.n_live, 0) > 0
       THEN pa.latest_ok_at END            AS will_set_to,
  CASE
    WHEN a.iaps_last_synced_at IS NOT NULL THEN 'KHÔNG đụng: đã có stamp'
    WHEN pa.latest_ok_at IS NOT NULL AND COALESCE(m.n_live, 0) = 0
      THEN 'KHÔNG: có Refresh đạt nhưng mirror hiện không còn item nào (bất thường — xem tay)'
    WHEN pa.latest_ok_at IS NOT NULL THEN 'CÓ: Refresh đầy đủ gần nhất (synced>0, failed=0, total=synced)'
    WHEN pa.app_id IS NULL THEN 'KHÔNG: chưa có lần Refresh nào tới được bước audit'
    WHEN pa.n_full = 0 THEN 'KHÔNG: chỉ có sync giá 1 SKU — chưa từng Refresh cả danh sách'
    ELSE 'KHÔNG: không có lần Refresh đạt — ' || CONCAT_WS(', ',
      CASE WHEN pa.n_failed > 0       THEN pa.n_failed       || '× failed>0' END,
      CASE WHEN pa.n_zero > 0         THEN pa.n_zero         || '× 0 sản phẩm (synced=0, failed=0)' END,
      CASE WHEN pa.n_degraded > 0     THEN pa.n_degraded     || '× đọc suy giảm (incoming_below…)' END,
      CASE WHEN pa.n_bad > 0          THEN pa.n_bad          || '× payload thiếu key / không phải số' END,
      CASE WHEN pa.n_inconsistent > 0 THEN pa.n_inconsistent || '× số đếm lệch (total≠synced+failed / âm)' END,
      CASE WHEN pa.n_pkg_mismatch > 0 THEN pa.n_pkg_mismatch || '× package_name trong payload ≠ app' END,
      CASE WHEN pa.n_pre_cutoff > 0   THEN pa.n_pre_cutoff   || '× đạt nhưng TRƯỚC mốc c7edca0 (legacy 1 trang)' END)
  END                                      AS reason,
  CASE
    WHEN a.iaps_last_synced_at IS NULL AND pa.latest_ok_at IS NOT NULL
         AND pk.total_at_pick < 0.5 * COALESCE(m.n_live, 0)
      THEN 'XEM TAY: lần Refresh được chọn chỉ thấy ' || pk.total_at_pick
           || ' item, mirror hiện có ' || m.n_live || ' item chưa bị đánh dấu xoá'
    WHEN a.iaps_last_synced_at IS NULL AND pa.latest_ok_at IS NOT NULL
         AND pa.latest_ok_at < TIMESTAMPTZ '2026-05-21 14:52:44+00' + interval '3 hours'
      THEN 'XEM TAY: lần Refresh được chọn nằm trong 3 giờ sau mốc c7edca0 (mốc là giờ COMMIT; '
           || 'giờ deploy chưa biết — có thể vẫn là code legacy 1 trang)'
  END                                      AS review_flag,
  a.iaps_last_synced_at                    AS stamp_now,
  pa.latest_ok_at,
  lf.created_at                            AS latest_full_refresh_at,
  lf.cls                                   AS latest_full_refresh_class,
  lf.synced_raw, lf.failed_raw, lf.total_raw, lf.flag_skip AS latest_flag_skip,
  pa.latest_single_at,
  CASE
    WHEN a.iaps_last_synced_at IS NOT NULL THEN 'n/a (đã stamp)'
    WHEN pa.latest_literal_at IS NOT DISTINCT FROM pa.latest_ok_at THEN 'same'
    ELSE 'KHÁC: câu chữ "synced>0 & failed=0" sẽ đặt ' || COALESCE(pa.latest_literal_at::text, 'NULL')
  END                                      AS vs_literal_rule,
  CASE
    WHEN a.iaps_last_synced_at IS NOT NULL THEN 'n/a (đã stamp)'
    WHEN pa.latest_route_at IS NOT DISTINCT FROM pa.latest_ok_at THEN 'same'
    ELSE 'KHÁC: điều kiện route (failed=0) sẽ đặt ' || COALESCE(pa.latest_route_at::text, 'NULL')
  END                                      AS vs_route_rule,
  COALESCE(m.n_live, 0)                    AS mirror_items_live,
  COALESCE(m.n_flagged, 0)                 AS mirror_items_flagged,
  pk.total_at_pick,
  CASE WHEN pa.latest_ok_at IS NOT NULL
       THEN date_part('day', now() - pa.latest_ok_at)::int END AS stamp_age_days
FROM google_iap_mgmt.apps a
JOIN google_iap_mgmt.google_console_accounts acc ON acc.id = a.google_console_account_id
LEFT JOIN per_app pa ON pa.app_id = a.id
LEFT JOIN latest_full lf ON lf.app_id = a.id
LEFT JOIN picked pk ON pk.app_id = a.id
LEFT JOIN mirror m ON m.app_id = a.id
ORDER BY will_backfill DESC, a.package_name, acc.display_name;
-- KỲ VỌNG: đúng 1 dòng cho MỖI hàng google_iap_mgmt.apps; stamp_now NULL ở mọi dòng
--   (code mới chưa deploy). Số dòng will_backfill='yes' = số hàng migration C2.1 sẽ ghi.
--   com.vnggames.ballisticherotwid: 'yes', will_set_to ≈ 2026-10-16 03:25:10 UTC — NẾU
--   payload lượt đó là synced=28, failed=0, total=28 (⇒ sau deploy app này KHÔNG bị chặn).
--   Mọi dòng 'no' nêu lý do. ĐỌC KỸ và báo lại: các dòng vs_literal_rule/vs_route_rule
--   = 'KHÁC…' (nơi luật backfill khác câu chữ của Manager hoặc khác route), và mọi
--   review_flag ≠ NULL (lần Refresh được chọn thấy ít item bất thường).
--   'chưa có lần Refresh nào tới được bước audit' = không có dòng audit — gồm cả Refresh
--   từng bị lỗi (lỗi thì không ghi audit), không có nghĩa là chưa ai bấm.


-- @@ D2 — dòng IAPS_LIST_SYNC trỏ tới app id KHÔNG còn tồn tại (account xoá → CASCADE)
WITH orphan AS (
  SELECT l.target_id, l.payload->>'package_name' AS package_name, COUNT(*) AS n_rows,
         MAX(l.created_at) AS last_at
  FROM google_iap_mgmt.actions_log l
  LEFT JOIN google_iap_mgmt.apps a ON a.id = l.target_id
  WHERE l.action_type = 'IAPS_LIST_SYNC' AND l.target_id IS NOT NULL AND a.id IS NULL
  GROUP BY l.target_id, l.payload->>'package_name'
)
SELECT o.target_id, o.package_name AS package_name_in_payload, o.n_rows, o.last_at,
  (SELECT string_agg(acc.display_name || ' / ' || a2.id::text
                       || ' / stamp=' || COALESCE(a2.iaps_last_synced_at::text, 'NULL'), '; ')
     FROM google_iap_mgmt.apps a2
     JOIN google_iap_mgmt.google_console_accounts acc ON acc.id = a2.google_console_account_id
    WHERE a2.package_name = o.package_name) AS same_package_rows_now
FROM orphan o
ORDER BY o.last_at DESC;
-- KỲ VỌNG: có thể 0 dòng. Mỗi dòng là một app id cũ — KHÔNG bao giờ được dùng để
--   backfill; nếu same_package_rows_now nêu một hàng hiện tại thì hàng đó cần tự Refresh.


-- @@ D2b — dòng IAPS_LIST_SYNC không có target (code luôn ghi app.id)
SELECT COUNT(*) AS rows_with_null_target, MIN(created_at) AS first_at, MAX(created_at) AS last_at
FROM google_iap_mgmt.actions_log
WHERE action_type = 'IAPS_LIST_SYNC' AND target_id IS NULL;
-- KỲ VỌNG: rows_with_null_target = 0. > 0 ⇒ có dòng audit không do code ghi — báo lại
--   (các dòng này không bao giờ được backfill dùng: join theo target_id).


-- ============================================================
-- C2.1 — KIỂM SAU migration 20261016020000 (bước 6, và lại sau deploy — bước 8)
-- ============================================================


-- @@ V3.1 — số app đã có stamp
SELECT COUNT(*) AS total_apps, COUNT(iaps_last_synced_at) AS stamped,
       COUNT(*) - COUNT(iaps_last_synced_at) AS still_null
FROM google_iap_mgmt.apps;
-- KỲ VỌNG: stamped = số dòng 'yes' của D1 (bước 6). Chạy lại migration ⇒ không đổi.


-- @@ V3.2 — mỗi stamp giải thích được bằng ĐÚNG MỘT nguồn
WITH params AS (
  SELECT TIMESTAMPTZ '2026-05-21 14:52:44+00' AS min_created_at
),
log AS (
  -- Payload values are cast ONLY when jsonb_typeof = 'number' (CASE fixes the
  -- evaluation order): "0", null, true, a missing key ⇒ NULL, never an error.
  SELECT l.id, l.target_id, l.created_at, l.payload,
    (jsonb_typeof(l.payload) = 'object') AS is_obj,
    CASE WHEN jsonb_typeof(l.payload) = 'object'
         THEN (l.payload ? 'scope' OR l.payload ? 'sku') ELSE false END AS is_single,
    CASE WHEN jsonb_typeof(l.payload->'synced') = 'number' THEN (l.payload->>'synced')::numeric END AS synced_n,
    CASE WHEN jsonb_typeof(l.payload->'failed') = 'number' THEN (l.payload->>'failed')::numeric END AS failed_n,
    CASE WHEN jsonb_typeof(l.payload->'total')  = 'number' THEN (l.payload->>'total')::numeric  END AS total_n
  FROM google_iap_mgmt.actions_log l
  WHERE l.action_type = 'IAPS_LIST_SYNC'
),
classified AS (
  SELECT g.*, a.id AS app_id,
    CASE
      WHEN NOT g.is_obj THEN 'bad_payload'
      WHEN g.is_single THEN 'single_item'
      WHEN g.synced_n IS NULL OR g.failed_n IS NULL OR g.total_n IS NULL THEN 'bad_payload'
      WHEN g.failed_n > 0 THEN 'failed'
      WHEN g.failed_n < 0 OR g.synced_n < 0 OR g.total_n <> g.synced_n + g.failed_n THEN 'inconsistent'
      WHEN g.synced_n = 0 THEN 'zero_products'
      WHEN COALESCE(g.payload->>'flag_reconcile_skipped', '') LIKE 'incoming_below%' THEN 'degraded'
      WHEN g.payload->>'package_name' IS DISTINCT FROM a.package_name THEN 'package_mismatch'
      WHEN g.created_at < p.min_created_at THEN 'pre_cutoff'
      ELSE 'ok'
    END AS cls
  FROM log g
  JOIN google_iap_mgmt.apps a ON a.id = g.target_id
  CROSS JOIN params p
)
SELECT a.package_name, acc.display_name AS account_name, a.iaps_last_synced_at,
  CASE
    WHEN EXISTS (SELECT 1 FROM classified c
                  WHERE c.app_id = a.id AND c.cls = 'ok'
                    AND c.created_at = a.iaps_last_synced_at) THEN 'backfill (= created_at của 1 Refresh đạt)'
    WHEN EXISTS (SELECT 1 FROM classified c
                  WHERE c.app_id = a.id AND c.is_obj AND NOT c.is_single AND c.failed_n = 0
                    AND a.iaps_last_synced_at BETWEEN c.created_at - interval '1 minute'
                                                  AND c.created_at + interval '1 minute')
      THEN 'route (Refresh sau deploy, failed=0)'
    ELSE 'KHÔNG GIẢI THÍCH ĐƯỢC'
  END AS stamp_source
FROM google_iap_mgmt.apps a
JOIN google_iap_mgmt.google_console_accounts acc ON acc.id = a.google_console_account_id
WHERE a.iaps_last_synced_at IS NOT NULL
ORDER BY stamp_source DESC, a.package_name;
-- KỲ VỌNG (bước 6): mọi dòng 'backfill …'. Sau deploy có thêm 'route …'.
--   'KHÔNG GIẢI THÍCH ĐƯỢC' sau deploy: trước khi nghĩ tới DML tay, tìm trong log Railway
--   '[google-iap:audit] append_failed type=IAPS_LIST_SYNC' — audit bị nuốt lỗi thì stamp
--   có mà dòng log không có.


-- @@ V3.3 — app có Refresh đạt mà vẫn NULL
WITH params AS (
  SELECT TIMESTAMPTZ '2026-05-21 14:52:44+00' AS min_created_at
),
log AS (
  -- Payload values are cast ONLY when jsonb_typeof = 'number' (CASE fixes the
  -- evaluation order): "0", null, true, a missing key ⇒ NULL, never an error.
  SELECT l.id, l.target_id, l.created_at, l.payload,
    (jsonb_typeof(l.payload) = 'object') AS is_obj,
    CASE WHEN jsonb_typeof(l.payload) = 'object'
         THEN (l.payload ? 'scope' OR l.payload ? 'sku') ELSE false END AS is_single,
    CASE WHEN jsonb_typeof(l.payload->'synced') = 'number' THEN (l.payload->>'synced')::numeric END AS synced_n,
    CASE WHEN jsonb_typeof(l.payload->'failed') = 'number' THEN (l.payload->>'failed')::numeric END AS failed_n,
    CASE WHEN jsonb_typeof(l.payload->'total')  = 'number' THEN (l.payload->>'total')::numeric  END AS total_n
  FROM google_iap_mgmt.actions_log l
  WHERE l.action_type = 'IAPS_LIST_SYNC'
),
classified AS (
  SELECT g.*, a.id AS app_id,
    CASE
      WHEN NOT g.is_obj THEN 'bad_payload'
      WHEN g.is_single THEN 'single_item'
      WHEN g.synced_n IS NULL OR g.failed_n IS NULL OR g.total_n IS NULL THEN 'bad_payload'
      WHEN g.failed_n > 0 THEN 'failed'
      WHEN g.failed_n < 0 OR g.synced_n < 0 OR g.total_n <> g.synced_n + g.failed_n THEN 'inconsistent'
      WHEN g.synced_n = 0 THEN 'zero_products'
      WHEN COALESCE(g.payload->>'flag_reconcile_skipped', '') LIKE 'incoming_below%' THEN 'degraded'
      WHEN g.payload->>'package_name' IS DISTINCT FROM a.package_name THEN 'package_mismatch'
      WHEN g.created_at < p.min_created_at THEN 'pre_cutoff'
      ELSE 'ok'
    END AS cls
  FROM log g
  JOIN google_iap_mgmt.apps a ON a.id = g.target_id
  CROSS JOIN params p
)
SELECT a.package_name, acc.display_name AS account_name, MAX(c.created_at) AS qualifying_at
FROM google_iap_mgmt.apps a
JOIN google_iap_mgmt.google_console_accounts acc ON acc.id = a.google_console_account_id
JOIN classified c ON c.app_id = a.id AND c.cls = 'ok'
WHERE a.iaps_last_synced_at IS NULL
  AND EXISTS (SELECT 1 FROM google_iap_mgmt.iaps i
               WHERE i.app_id = a.id AND i.deleted_on_google_at IS NULL)
GROUP BY a.package_name, acc.display_name;
-- KỲ VỌNG: 0 dòng. Có dòng sau bước 6 ⇒ báo lại. Có dòng ở bước 8 ⇒ (a) một Refresh trên
--   code cũ lọt vào khoảng giữa migration và deploy, hoặc (b) một Refresh trên code mới mà
--   ghi stamp lỗi 500 sau khi đã ghi audit. Cả hai: bấm Refresh app đó trên code mới.
--   KHÔNG chạy lại migration — backfill chỉ chạy một lần.


-- @@ V3.4 — 彈彈英雄
SELECT a.package_name, acc.display_name AS account_name, a.iaps_last_synced_at
FROM google_iap_mgmt.apps a
JOIN google_iap_mgmt.google_console_accounts acc ON acc.id = a.google_console_account_id
WHERE a.package_name = 'com.vnggames.ballisticherotwid';
-- KỲ VỌNG: iaps_last_synced_at ≈ 2026-10-16 03:25:10 UTC (như will_set_to của D1) ⇒
--   bulk import của app này KHÔNG bị chặn sau deploy. Mirror của nó là trạng thái SAU
--   lượt Overwrite 07:24 (xem snapshot-ballisticherotwid-after-overwrite.sql).


-- @@ V3.5 — comment cột đã cập nhật
SELECT att.attname, col_description('google_iap_mgmt.apps'::regclass, att.attnum) AS comment
FROM pg_attribute att
WHERE att.attrelid = 'google_iap_mgmt.apps'::regclass
  AND att.attname IN ('iaps_last_synced_at', 'default_currency_source', 'default_language_source')
ORDER BY att.attname;
-- KỲ VỌNG: 3 dòng. iaps_last_synced_at chứa 'Backfilled ONCE by 20261016020000'; hai cột
--   *_source chứa 'NOT a bulk-import condition'.
