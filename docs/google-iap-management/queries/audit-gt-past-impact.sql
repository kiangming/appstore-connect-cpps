-- ═══════════════════════════════════════════════════════════════════════════
-- AUDIT — [GOOGLE-bulkimport-drop-gt] bước A: GT có thể đã thành giá thật trên Google
-- ở những SKU nào, và giá vùng GT (mặc định VN) hiện đang là gì trong MIRROR.
-- Design: docs/google-iap-management/design-bulkimport-drop-gt-columns.md §A.
--
-- READ-ONLY, MỘT câu SELECT. Không gọi Google, không Refresh. Chạy trong Supabase SQL Editor.
-- Đổi tham số ở CTE params: vùng GT (mặc định 'VN'), độ nới cửa sổ, lọc batch_id.
--
-- Xét MỌI import trước H4.4 (64557c9 lên origin/main 2026-10-19 21:26:42 +07). Mỗi dòng
-- section 1 = một SKU mà GT CÓ THỂ đã được gửi:
--   • batch google_default: SKU mà mirror cho thấy batch đó đã ghi (cửa sổ thời gian quanh
--     batch), trừ dòng custom / dòng bị từ chối (theo audit). Gồm cả batch KHÔNG có audit
--     (trước H4.4 bước đóng batch không nằm trong finally — tiến trình chết sau khi đã ghi
--     lên Google để lại đúng dấu vết IN_PROGRESS-không-audit);
--   • batch template có audit: dòng per_row_diagnostic match_strategy='none'
--     (price_provenance thiếu hoặc 'auto_bootstrap') = KHÔNG tier nào khớp ⇒ giá quy đổi;
--   • batch template KHÔNG có audit: mọi SKU trong cửa sổ, loại dòng = CHƯA BIẾT.
-- section 2 = MỘT dòng cho MỖI batch trước H4.4 (mọi nguồn giá) — dùng để xác nhận danh
--   sách batch google_default đã đủ chưa. section 3 = TOTAL (luôn có, kể cả 0 dòng).
--
-- ĐÃ ĐO (2026-10-21, làn A4 + rà sót): chạy trên PGlite 0.4.6 với migration Google thật;
-- lịch sử dựng bằng CODE CŨ thật (4fbcdd5, 2b140b0, M-1/M-2 thật) rồi route Refresh /
-- Sync thật của code hiện tại; Google giả. Ra đúng bảng kỳ vọng viết trước; 2 biến thể SQL
-- sai (bắt SKU theo last_synced_at / updated_at) bị bắt.
--
-- CÁCH ĐỌC
-- • Giờ in theo timezone của phiên SQL (Supabase thường là UTC — cộng 7 giờ cho giờ VN).
-- • mirror_state (cột giá vùng GT của SKU):
--     A = batch ghi, chưa ai đọc lại từ Google ⇒ đúng giá Google trả lúc import;
--     B = batch ghi, Refresh đọc lại sau đó ⇒ giá Google LÚC REFRESH — có thể đã khác giá
--         batch ghi (sửa trên Console trước lần Refresh đó);
--     C = ghi lại SAU batch (Sync from Google / sửa đơn lẻ / Refresh trước 2026-07-02) ⇒ giá
--         của batch không còn trong mirror;
--     D / N / X = batch không ghi giá này / mirror không có vùng GT / SKU không có trong mirror.
-- • Nhận diện giá GIỐNG GT: mirror_gt_region_price trùng con số team đã gõ trong file (cần
--   file: source_filename + actor_email); gt_per_usd lệch xa tỷ giá quy đổi; khác tier_vn_today.
-- • n_unaccounted > 0 (section 2/3): batch ghi nhiều dòng hơn số SKU mirror còn gọi tên được.
-- • Muốn chắc giá HIỆN TẠI trên Google (chỉ đọc): Export list của app (1 lần gọi / app), hoặc
--   convert_today_url (giá quy đổi HÔM NAY, 1 lần gọi / mức giá gốc). ⚠ KHÔNG bấm "Refresh" ở
--   danh sách IAP hay "Sync from Google" ở trang item — hai nút đó GHI mirror.
-- KHÔNG chứng minh được: giá trị GT đã gõ (không được lưu trước H4.4, tool không lưu file);
--   GT bằng/sát giá quy đổi; sửa trên Console sau lần ghi cuối của mirror; SKU trạng thái C.
-- ═══════════════════════════════════════════════════════════════════════════
WITH params AS (
  SELECT TIMESTAMPTZ '2026-10-19 14:26:42+00' AS h44_pushed,   -- 64557c9 lên origin/main 21:26:42 +07
         'VN'::text                          AS gt_region,
         INTERVAL '2 minutes'                AS slack,          -- executed_at là đồng hồ app
         NULL::uuid[]                        AS only_batches    -- vd ARRAY['…'::uuid]
),
b AS (
  SELECT ib.id AS batch_id, ib.app_id, ib.pricing_source, ib.source_filename, ib.status,
         ib.rows_success, ib.created_at AS batch_at, ib.executed_at,
         al.actor_email, al.created_at AS audit_at,
         CASE WHEN jsonb_typeof(al.payload) = 'object' THEN al.payload END AS payload
    FROM google_iap_mgmt.import_batches ib
   CROSS JOIN params p
    LEFT JOIN LATERAL (
         SELECT l.actor_email, l.created_at, l.payload
           FROM google_iap_mgmt.actions_log l
          WHERE l.action_type = 'BULK_IMPORT_BATCH'
            AND jsonb_typeof(l.payload) = 'object'
            AND l.payload->>'batch_id' = ib.id::text
          ORDER BY l.created_at DESC LIMIT 1) al ON true
   WHERE ib.created_at < p.h44_pushed
     AND (p.only_batches IS NULL OR ib.id = ANY (p.only_batches))
),
bw AS (
  SELECT b.*, a.package_name, a.google_console_account_id AS account_id,
         a.iaps_last_synced_at AS app_last_complete_refresh,
         b.batch_at AS w_from,
         GREATEST(b.batch_at, COALESCE(b.executed_at, b.batch_at), COALESCE(b.audit_at, b.batch_at)) + p.slack AS w_to
    FROM b CROSS JOIN params p
    LEFT JOIN google_iap_mgmt.apps a ON a.id = b.app_id
),
diag AS (
  SELECT bw.batch_id, d->>'sku' AS sku, d->>'base_currency' AS base_currency,
         d->>'base_price_decimal' AS base_price_decimal, d->>'match_strategy' AS ms,
         d->>'price_provenance' AS prov
    FROM bw
   CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(bw.payload->'per_row_diagnostic') = 'array'
              THEN bw.payload->'per_row_diagnostic' ELSE '[]'::jsonb END) d
   WHERE jsonb_typeof(d) = 'object'
),
refused AS (
  SELECT bw.batch_id, r->>'sku' AS sku
    FROM bw
   CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(bw.payload->'refused_rows') = 'array'
              THEN bw.payload->'refused_rows' ELSE '[]'::jsonb END) r
   WHERE jsonb_typeof(r) = 'object'
),
ball AS (   -- MỌI import (không lọc) — để biết một batch SAU có ghi lại SKU không
  SELECT ib.id AS batch_id, ib.app_id, ib.created_at AS batch_at, ib.created_at AS w_from,
         GREATEST(ib.created_at, COALESCE(ib.executed_at, ib.created_at),
                  COALESCE((SELECT max(l.created_at) FROM google_iap_mgmt.actions_log l
                             WHERE l.action_type = 'BULK_IMPORT_BATCH'
                               AND jsonb_typeof(l.payload) = 'object'
                               AND l.payload->>'batch_id' = ib.id::text), ib.created_at)) + p.slack AS w_to
    FROM google_iap_mgmt.import_batches ib CROSS JOIN params p
),
win_all AS (   -- SKU mà mirror cho thấy được batch ghi (cache sync = xoá + chèn lại giá/listing)
  SELECT ba.batch_id, ba.app_id, ba.batch_at, i.id AS iap_id, i.sku
    FROM ball ba JOIN google_iap_mgmt.iaps i ON i.app_id = ba.app_id
   WHERE i.created_at BETWEEN ba.w_from AND ba.w_to
      OR i.last_synced_at BETWEEN ba.w_from AND ba.w_to
      OR EXISTS (SELECT 1 FROM google_iap_mgmt.iap_prices x
                  WHERE x.iap_id = i.id AND x.created_at BETWEEN ba.w_from AND ba.w_to)
      OR EXISTS (SELECT 1 FROM google_iap_mgmt.iap_listings x
                  WHERE x.iap_id = i.id AND x.created_at BETWEEN ba.w_from AND ba.w_to)
),
in_window AS (
  SELECT w.batch_id, w.iap_id, w.sku FROM win_all w WHERE w.batch_id IN (SELECT batch_id FROM bw)
),
listed AS (
  -- (1) google_default: SKU trong cửa sổ, trừ custom / refused
  SELECT w.batch_id, w.sku, 'google_default — SKU tìm thấy trong cửa sổ mirror'::text AS row_basis,
         NULL::text AS file_cur, NULL::text AS file_price
    FROM in_window w JOIN bw ON bw.batch_id = w.batch_id
   WHERE bw.pricing_source = 'google_default'
     AND NOT EXISTS (SELECT 1 FROM diag d WHERE d.batch_id = w.batch_id AND d.sku = w.sku
                        AND d.prov IN ('custom', 'custom_refused'))
     AND NOT EXISTS (SELECT 1 FROM refused r WHERE r.batch_id = w.batch_id AND r.sku = w.sku)
  UNION
  -- (2) template có audit: dòng không khớp tier (auto-bootstrap)
  SELECT d.batch_id, d.sku, 'template — KHÔNG tier nào khớp (audit per_row_diagnostic)',
         d.base_currency, d.base_price_decimal
    FROM diag d JOIN bw ON bw.batch_id = d.batch_id
   WHERE bw.pricing_source IN ('default_template', 'app_template')
     AND d.ms = 'none' AND COALESCE(d.prov, 'auto_bootstrap') = 'auto_bootstrap'
  UNION
  -- (3) template KHÔNG có audit: không biết dòng nào khớp tier
  SELECT w.batch_id, w.sku, 'template, batch KHÔNG có audit — loại dòng CHƯA BIẾT', NULL, NULL
    FROM in_window w JOIN bw ON bw.batch_id = w.batch_id
   WHERE bw.pricing_source IN ('default_template', 'app_template') AND bw.payload IS NULL
),
det AS (
  SELECT bw.batch_at, bw.package_name, bw.pricing_source, bw.source_filename, bw.actor_email,
         bw.batch_id, l.sku, l.row_basis, bw.w_from, bw.w_to, bw.account_id, bw.app_id,
         bw.app_last_complete_refresh,
         CASE WHEN l.file_price IS NOT NULL THEN l.file_cur || ' ' || l.file_price END AS file_base,
         i.id AS iap_id, i.deleted_on_google_at, i.last_synced_at AS iap_last_synced_at,
         us.currency AS us_cur, us.price_micros AS us_micros,
         i.default_currency, i.default_price_micros,
         g.currency AS g_cur, g.price_micros AS g_micros, g.created_at AS g_created, g.updated_at AS g_updated,
         -- giá dùng để tra tier / quy đổi: giá file (audit) nếu có, không thì giá US trong mirror
         COALESCE(l.file_cur, us.currency, i.default_currency) AS base_cur,
         COALESCE(CASE WHEN l.file_price ~ '^[0-9]+(\.[0-9]+)?$'
                       THEN (round(l.file_price::numeric * 1000000))::bigint::text END,
                  us.price_micros, i.default_price_micros) AS base_micros
    FROM listed l
    JOIN bw ON bw.batch_id = l.batch_id
   CROSS JOIN params p
    LEFT JOIN google_iap_mgmt.iaps i ON i.app_id = bw.app_id AND i.sku = l.sku
    LEFT JOIN google_iap_mgmt.iap_prices us ON us.iap_id = i.id AND us.region_code = 'US'
    LEFT JOIN google_iap_mgmt.iap_prices g  ON g.iap_id  = i.id AND g.region_code = p.gt_region
),
det2 AS (
  SELECT det.*,
    CASE
      WHEN det.iap_id IS NULL THEN 'X: SKU không có trong mirror'
      WHEN det.g_micros IS NULL THEN 'N: mirror không có giá ở vùng GT'
      WHEN det.g_created BETWEEN det.w_from AND det.w_to AND det.g_updated <= det.w_to
        THEN 'A: batch ghi, CHƯA đọc lại từ Google lần nào — = giá Google trả lúc import'
      WHEN det.g_created BETWEEN det.w_from AND det.w_to
        THEN 'B: batch ghi, Refresh đọc lại sau đó — = giá Google LÚC REFRESH (gt_price_row_last_written_at), có thể đã khác giá batch ghi (vd sửa trên Console trước lần Refresh đó)'
      WHEN det.g_created > det.w_to
        THEN 'C: ghi lại SAU batch (Sync from Google / sửa đơn lẻ / Refresh trước 2026-07-02) — giá của batch đã bị thay trong mirror'
      ELSE 'D: batch KHÔNG ghi giá này (dòng lỗi/không đẩy?)'
    END AS mirror_state,
    (SELECT string_agg(DISTINCT t.scope_type || ':' || e.identifier || ' = ' || vn.currency || ' ' ||
                       trim_scale(vn.price_micros::numeric / 1000000) ||
                       CASE WHEN t.uploaded_at > det.batch_at THEN ' (template upload SAU batch)' ELSE '' END,
                       ' | ')
       FROM google_iap_mgmt.pricing_templates t
       JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
       JOIN google_iap_mgmt.pricing_template_entries vn
         ON vn.template_id = t.id AND vn.identifier = e.identifier
        AND vn.region_code = (SELECT gt_region FROM params)
      WHERE ((t.scope_type = 'ACCOUNT' AND t.scope_account_id = det.account_id)
          OR (t.scope_type = 'APP' AND t.scope_app_id = det.app_id)
          OR t.scope_type = 'GLOBAL')
        AND (e.identifier = det.sku
             OR (e.currency = det.base_cur AND e.price_micros = det.base_micros))) AS tier_vn_today
    FROM det
),
detail AS (
  SELECT '1-detail'::text AS section, d.batch_at, d.package_name, d.pricing_source, d.source_filename,
         d.actor_email, d.batch_id, d.sku, d.row_basis, d.file_base,
         CASE WHEN d.us_micros IS NOT NULL THEN d.us_cur || ' ' || trim_scale(d.us_micros::numeric / 1000000)
              WHEN d.default_price_micros IS NOT NULL THEN d.default_currency || ' ' || trim_scale(d.default_price_micros::numeric / 1000000) || ' (default)'
         END AS mirror_base,
         (SELECT gt_region FROM params) AS gt_region,
         CASE WHEN d.g_micros IS NOT NULL THEN d.g_cur || ' ' || trim_scale(d.g_micros::numeric / 1000000) END AS mirror_gt_region_price,
         d.g_created AS gt_price_row_written_at, d.g_updated AS gt_price_row_last_written_at,
         d.mirror_state,
         EXISTS (SELECT 1 FROM win_all w2
                  WHERE w2.app_id = d.app_id AND w2.sku = d.sku AND w2.batch_at > d.batch_at) AS later_batch_wrote_sku,
         CASE WHEN d.us_cur = 'USD' AND d.us_micros::numeric > 0 AND d.g_micros IS NOT NULL
              THEN round(d.g_micros::numeric / d.us_micros::numeric) END AS gt_per_usd,
         d.tier_vn_today,
         CASE WHEN d.base_micros IS NOT NULL AND d.package_name IS NOT NULL
              THEN '/api/google-iap-management/regions/catalog?packageName=' || d.package_name ||
                   '&basePriceMicros=' || d.base_micros || '&baseCurrency=' || d.base_cur END AS convert_today_url,
         d.deleted_on_google_at, d.app_last_complete_refresh,
         NULL::int AS batch_rows_success, NULL::int AS n_listed, NULL::int AS n_a, NULL::int AS n_b,
         NULL::int AS n_c, NULL::int AS n_d_n_x, NULL::int AS n_unaccounted
    FROM det2 d
),
per_batch AS (
  SELECT '2-batch'::text AS section, bw.batch_at, bw.package_name, bw.pricing_source, bw.source_filename,
         bw.actor_email, bw.batch_id, NULL::text AS sku,
         CASE WHEN bw.payload IS NULL THEN 'batch KHÔNG có audit' ELSE 'batch có audit' END
           || ' · loại ' || (SELECT count(*) FROM in_window w JOIN diag dg ON dg.batch_id = w.batch_id AND dg.sku = w.sku
                               WHERE w.batch_id = bw.batch_id AND dg.prov IN ('custom', 'custom_refused'))::text
           || ' SKU custom' AS row_basis,
         NULL::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::text,
         NULL::boolean, NULL::numeric, NULL::text, NULL::text, NULL::timestamptz, bw.app_last_complete_refresh,
         bw.rows_success AS batch_rows_success,
         count(d.sku)::int AS n_listed,
         count(*) FILTER (WHERE d.mirror_state LIKE 'A:%')::int AS n_a,
         count(*) FILTER (WHERE d.mirror_state LIKE 'B:%')::int AS n_b,
         count(*) FILTER (WHERE d.mirror_state LIKE 'C:%')::int AS n_c,
         count(*) FILTER (WHERE d.mirror_state ~ '^(D|N|X):')::int AS n_d_n_x,
         CASE WHEN bw.pricing_source = 'google_default' OR bw.payload IS NULL
              THEN GREATEST(bw.rows_success - count(d.sku)
                            - (SELECT count(*) FROM in_window w JOIN diag dg ON dg.batch_id = w.batch_id AND dg.sku = w.sku
                                WHERE w.batch_id = bw.batch_id AND dg.prov IN ('custom', 'custom_refused')), 0)::int
         END AS n_unaccounted
    FROM bw LEFT JOIN det2 d ON d.batch_id = bw.batch_id
   GROUP BY bw.batch_id, bw.batch_at, bw.package_name, bw.pricing_source, bw.source_filename,
            bw.actor_email, bw.payload, bw.rows_success, bw.app_last_complete_refresh
),
total AS (
  SELECT '3-TOTAL'::text, NULL::timestamptz, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid,
         NULL::text,
         (SELECT count(*) FROM bw)::text || ' batch trước H4.4 được xét · '
           || (SELECT count(DISTINCT (app_id, sku)) FROM det2)::text || ' SKU khác nhau (app+sku) được liệt kê',
         NULL::text, NULL::text,
         NULL::text, NULL::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::boolean, NULL::numeric, NULL::text,
         NULL::text, NULL::timestamptz, NULL::timestamptz,
         (SELECT COALESCE(sum(rows_success), 0) FROM bw)::int,
         (SELECT count(*) FROM det2)::int,
         (SELECT count(*) FROM det2 WHERE mirror_state LIKE 'A:%')::int,
         (SELECT count(*) FROM det2 WHERE mirror_state LIKE 'B:%')::int,
         (SELECT count(*) FROM det2 WHERE mirror_state LIKE 'C:%')::int,
         (SELECT count(*) FROM det2 WHERE mirror_state ~ '^(D|N|X):')::int,
         (SELECT COALESCE(sum(n_unaccounted), 0) FROM per_batch)::int
)
SELECT * FROM detail
UNION ALL SELECT * FROM per_batch
UNION ALL SELECT * FROM total
ORDER BY section, batch_at, package_name, sku;
