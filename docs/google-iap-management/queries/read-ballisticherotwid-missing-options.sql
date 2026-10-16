-- ============================================================
-- Vì sao bulk import của com.vnggames.ballisticherotwid (彈彈英雄) báo
-- NEW 28 / EXISTING 0, rồi Google trả:
--   "Product must list all of its existing purchase options.
--    Missing: legacy, default — legacy fallback also failed
--    (PERMISSION_DENIED) Please migrate to the new publishing API."
--
-- ⚠ CHỈ ĐỌC. Không UPDATE, không INSERT, không DELETE.
-- Chạy trong Supabase SQL Editor. Mỗi khối "-- @@" là MỘT truy vấn độc lập.
-- Đổi package ở một chỗ mỗi truy vấn nếu cần.
--
-- Bối cảnh (census 2026-10-16, nhánh arc-google-missing-purchase-options):
--   • Preview tính NEW/EXISTING CHỈ từ mirror DB google_iap_mgmt.iaps
--     (preview/route.ts:6, :128) — không hỏi Google.
--   • Execute tin `decision` client gửi; NEW ⇒ "create" ⇒ body chỉ có
--     option "buy", allowMissing:true, KHÔNG GET (publisher-client.ts:1155;
--     onetime-product-adapter.ts:388-398).
--   ⇒ Câu hỏi các truy vấn dưới trả lời: VÌ SAO mirror không có các SKU này.
--
-- Giả thuyết (ký hiệu dùng trong KỲ VỌNG):
--   H1  một lần chạy TRƯỚC của tool đã tạo vài SKU, rồi mirror mất chúng
--   H2  sản phẩm tạo NGOÀI tool (Play Console / client khác)
--   H3a mirror chưa từng được Refresh (Refresh chỉ bấm tay, trang app detail)
--   H3b Refresh chạy nhưng list của Google trả rỗng / thiếu
--   H3c mirror nằm dưới app row của ACCOUNT KHÁC
--   H3d Refresh có bấm nhưng hỏng (hỏng thì KHÔNG ghi audit, chỉ có log Railway)
--   H3e mirror CÓ SKU nhưng preview đọc DB lỗi và nuốt lỗi (.catch(() => []))
--   H2b Refresh báo 200 nhưng ghi mirror hỏng ("Synced 0 of 28 IAPs (28 failed)")
--   H5  mirror > 1000 dòng — listIapsForApp không phân trang
--   H7  account bị xoá rồi thêm lại ⇒ CASCADE xoá mirror, app row id mới
--
-- Đã chạy thử trên DDL thật của các migration google_iap_mgmt (PGlite,
-- dữ liệu giả lập H1/H2): 0 lỗi SQL. Giá trị thật: chỉ có trên production.
-- ============================================================


-- @@ Q0 — Mọi app row của package này, trên MỌI account (H3c, H7)
SELECT a.id AS app_id, a.google_console_account_id AS account_id, acc.display_name AS account_name,
  acc.service_account_email AS sa_email, acc.status AS account_status,
  acc.created_at AS account_created_at, a.display_name,
  a.default_currency, a.default_language, a.last_synced_at AS apps_list_last_synced_at,
  a.created_at AS app_row_created_at
FROM google_iap_mgmt.apps a
JOIN google_iap_mgmt.google_console_accounts acc ON acc.id = a.google_console_account_id
WHERE a.package_name = 'com.vnggames.ballisticherotwid'
ORDER BY a.created_at;
-- KỲ VỌNG: đúng 1 dòng (khác ⇒ H3c). app_row_created_at hoặc account_created_at
--   SAU lần bulk import thành công đầu tiên (Q4) ⇒ H7.
--   ⚠ default_currency='TWD', default_language='zh-TW' KHÔNG chứng minh từng Refresh
--   IAP: refresh danh sách app tự suy TWD từ zh-TW (region-currency-map.ts:35).
--   last_synced_at là của refresh DANH SÁCH APP, không phải mirror IAP.


-- @@ Q1 — Đếm mirror theo từng app row (H3a, H5)
SELECT a.id AS app_id, a.google_console_account_id AS account_id,
  COUNT(i.id) AS iaps_total,
  COUNT(i.id) FILTER (WHERE i.deleted_on_google_at IS NULL) AS present_on_google,
  COUNT(i.id) FILTER (WHERE i.deleted_on_google_at IS NOT NULL) AS flagged_missing,
  COUNT(i.id) FILTER (WHERE i.sku LIKE 'com.vnggames.ballisticherotwid.%') AS sku_with_pkg_prefix,
  MIN(i.created_at) AS first_mirrored_at, MAX(i.last_synced_at) AS last_item_synced_at
FROM google_iap_mgmt.apps a
LEFT JOIN google_iap_mgmt.iaps i ON i.app_id = a.id
WHERE a.package_name = 'com.vnggames.ballisticherotwid'
GROUP BY a.id, a.google_console_account_id;
-- KỲ VỌNG: iaps_total = 0 ⇒ H3a/H3b/H2b/H7 (xem Q8 để tách).
--   iaps_total > 1000 ⇒ H5 khả dĩ. iaps_total > 0 và có SKU trong file ⇒ Q2 + H3e.


-- @@ Q2 — Mọi SKU tool từng cache cho package này
SELECT i.app_id, i.sku, i.status, i.purchase_type, i.default_currency, i.default_price_micros,
  i.created_at AS first_mirrored_at, i.last_synced_at, i.deleted_on_google_at,
  (SELECT COUNT(*) FROM google_iap_mgmt.iap_listings li WHERE li.iap_id = i.id) AS listing_rows,
  (SELECT COUNT(*) FROM google_iap_mgmt.iap_prices   pr WHERE pr.iap_id = i.id) AS price_rows
FROM google_iap_mgmt.iaps i
JOIN google_iap_mgmt.apps a ON a.id = i.app_id
WHERE a.package_name = 'com.vnggames.ballisticherotwid'
ORDER BY i.sku;
-- KỲ VỌNG: có SKU nằm trong file import, dưới ĐÚNG app_id của Q0, first_mirrored_at
--   TRƯỚC lần preview ⇒ preview đã đọc lỗi và nuốt lỗi (H3e) — không để lại log nào.
--   (Dòng deleted_on_google_at IS NOT NULL vẫn được preview tính là EXISTING.)


-- @@ Q3 — Toàn bộ dòng thời gian audit của package (lọc theo package_name, chịu được H7)
SELECT l.created_at, l.action_type, l.actor_email, l.target_id,
  l.payload->>'batch_id' AS batch_id, l.payload->>'pricing_source' AS pricing_source,
  l.payload->>'rows_total' AS rows_total,
  l.payload->>'rows_created' AS rows_created,          -- chỉ payload thành công
  l.payload->>'rows_overwritten' AS rows_overwritten,  -- chỉ payload thành công
  l.payload->>'rows_skipped' AS rows_skipped, l.payload->>'rows_failed' AS rows_failed,
  l.payload->>'rows_refused' AS rows_refused,
  l.payload->>'error_status' AS error_status, l.payload->>'error_fallback_status' AS fallback_status,
  l.payload->>'error_both_paths_failed' AS both_paths_failed,
  LEFT(l.payload->>'error', 160) AS error_head,
  l.payload->>'sku' AS single_sku,              -- IAP_CREATE / IAP_UPDATE / đồng bộ giá 1 SKU
  l.payload->>'scope' AS sync_scope,
  l.payload->>'total' AS list_total,            -- IAPS_LIST_SYNC: số sản phẩm Google trả về
  l.payload->>'synced' AS list_synced, l.payload->>'failed' AS list_failed,
  l.payload->>'flag_reconcile_skipped' AS flag_skip,
  l.payload->'flagged_skus' AS flagged_skus,    -- IAPS_LIST_SYNC
  l.payload->'removed_skus' AS ack_removed_skus -- IAP_ACKNOWLEDGE_REMOVE
FROM google_iap_mgmt.actions_log l
WHERE l.payload->>'package_name' = 'com.vnggames.ballisticherotwid'
   OR l.target_id IN (SELECT id FROM google_iap_mgmt.apps WHERE package_name = 'com.vnggames.ballisticherotwid')
ORDER BY l.created_at;
-- KỲ VỌNG: ack_removed_skus chứa SKU của file ⇒ H1 (mirror bị xoá sau khi flagged);
--   khi đó một IAPS_LIST_SYNC trước đó phải có flagged_skus chứa chúng = list của Google
--   đã BỎ SÓT các SKU mà batchUpdate nói là có ⇒ mâu thuẫn list/ghi, leo thang.


-- @@ Q4 — Mọi lần bulk import của package, phân loại kết quả
SELECT l.created_at, l.actor_email, l.payload->>'batch_id' AS batch_id,
  CASE WHEN l.payload ? 'error' THEN 'GOOGLE_CALL_FAILED'
       WHEN COALESCE((l.payload->>'rows_created')::int,0) + COALESCE((l.payload->>'rows_overwritten')::int,0) > 0
         THEN 'WROTE_TO_GOOGLE'
       WHEN COALESCE((l.payload->>'rows_failed')::int,0) > 0
         THEN 'GOOGLE_ACCEPTED_MIRROR_FAILED_OR_PARTIAL'   -- Google nhận, ghi mirror hỏng ⇒ ứng viên H1
       ELSE 'NOTHING_PUSHED' END AS run_outcome,
  l.payload->>'pricing_source' AS pricing_source,
  (l.payload->>'rows_total')::int AS rows_total, (l.payload->>'rows_created')::int AS rows_created,
  (l.payload->>'rows_overwritten')::int AS rows_overwritten, (l.payload->>'rows_skipped')::int AS rows_skipped,
  (l.payload->>'rows_failed')::int AS rows_failed, (l.payload->>'rows_refused')::int AS rows_refused,
  l.payload->>'error' AS error_message, l.payload->>'error_status' AS error_status,
  l.payload->>'error_http_status' AS error_http_status, l.payload->>'error_both_paths_failed' AS both_paths_failed,
  l.payload->>'error_fallback' AS fallback_message, l.payload->>'error_fallback_status' AS fallback_status,
  l.payload->>'error_fallback_http_status' AS fallback_http_status,
  b.status AS batch_status, b.source_filename, b.rows_success AS batch_rows_success,
  b.rows_failed AS batch_rows_failed, b.executed_at
FROM google_iap_mgmt.actions_log l
LEFT JOIN google_iap_mgmt.import_batches b ON b.id::text = l.payload->>'batch_id'
WHERE l.action_type = 'BULK_IMPORT_BATCH'
  AND l.payload->>'package_name' = 'com.vnggames.ballisticherotwid'
ORDER BY l.created_at;
-- KỲ VỌNG (mọi giả thuyết): dòng mới nhất = GOOGLE_CALL_FAILED, error_status=FAILED_PRECONDITION,
--   fallback_status=PERMISSION_DENIED, both_paths_failed=true, rows_failed=28, batch_status=FAILED.
--   Có dòng WROTE_TO_GOOGLE hoặc GOOGLE_ACCEPTED_MIRROR_FAILED_OR_PARTIAL TRƯỚC đó ⇒ H1.
--   ⚠ Payload hỏng KHÔNG ghi số dòng create/overwrite; "NEW 28 toàn Create" chỉ xác nhận
--   được bằng Railway: không có dòng method=monetization.onetimeproducts.get pkg=… (Q-Railway B9).


-- @@ Q5 — import_batches của package, kể cả lần chạy KHÔNG có dòng audit
SELECT b.id AS batch_id, b.app_id, a.package_name, b.created_at, b.executed_at, b.status, b.pricing_source,
  b.source_filename, b.rows_total, b.rows_success, b.rows_overwritten, b.rows_skipped, b.rows_failed,
  EXISTS (SELECT 1 FROM google_iap_mgmt.actions_log l
          WHERE l.action_type = 'BULK_IMPORT_BATCH' AND l.payload->>'batch_id' = b.id::text) AS has_audit_row
FROM google_iap_mgmt.import_batches b
LEFT JOIN google_iap_mgmt.apps a ON a.id = b.app_id
WHERE a.package_name = 'com.vnggames.ballisticherotwid'
   OR b.app_id IS NULL      -- app row đã bị xoá (H7): ON DELETE SET NULL, không còn package để lọc
ORDER BY b.created_at;
-- KỲ VỌNG: has_audit_row=false + IN_PROGRESS ⇒ lần chạy chết TRƯỚC khi gọi Google.
--   has_audit_row=false + COMPLETE ⇒ thành công bị ẩn (ghi audit hỏng) ⇒ tính cho H1.
--   Dòng app_id IS NULL: không gán được package — chỉ đối chiếu theo thời gian / tên file.


-- @@ Q6 — Body lỗi ĐẦY ĐỦ của lần hỏng MỚI NHẤT (trường O1-O3)
-- ⭐ error_details / error_full là chỗ DUY NHẤT có thể nêu productId hay request index mà
--    Google phản đối. Màn hình và response HTTP của execute KHÔNG mang chúng (với lỗi
--    hai-đường, route chỉ chuyển tiếp câu ghép + nửa fallback).
SELECT l.created_at, l.actor_email, l.payload->>'batch_id' AS batch_id,
  l.payload->>'rows_total' AS rows_total, l.payload->>'rows_failed' AS rows_failed,
  l.payload->>'error' AS error_message, l.payload->>'error_status' AS error_status,
  l.payload->>'error_http_status' AS error_http_status, l.payload->'error_reasons' AS error_reasons,
  jsonb_pretty(COALESCE(l.payload->'error_details','[]'::jsonb)) AS error_details,
  l.payload->>'error_full' AS error_full,
  l.payload->>'error_both_paths_failed' AS both_paths_failed,
  l.payload->>'error_fallback' AS fallback_message, l.payload->>'error_fallback_status' AS fallback_status,
  l.payload->>'error_fallback_http_status' AS fallback_http_status,
  l.payload->'error_fallback_reasons' AS fallback_reasons,
  jsonb_pretty(COALESCE(l.payload->'error_fallback_details','[]'::jsonb)) AS fallback_details,
  l.payload->>'error_fallback_full' AS fallback_full,
  acc.id AS account_id_used, acc.service_account_email AS sa_email_used
FROM google_iap_mgmt.actions_log l
LEFT JOIN google_iap_mgmt.apps a ON a.id = l.target_id
LEFT JOIN google_iap_mgmt.google_console_accounts acc ON acc.id = a.google_console_account_id
WHERE l.action_type = 'BULK_IMPORT_BATCH'
  AND l.payload->>'package_name' = 'com.vnggames.ballisticherotwid'
  AND l.payload ? 'error'
ORDER BY l.created_at DESC
LIMIT 1;
-- KỲ VỌNG: error='Product must list all of its existing purchase options. Missing: legacy, default',
--   error_status='FAILED_PRECONDITION', fallback_status='PERMISSION_DENIED'.
--   error_http_status / fallback_http_status: CHƯA BIẾT (chưa đo).
--   Không có dòng nào ⇒ ghi audit hỏng ⇒ grep Railway "[google-iap:audit] append_failed type=BULK_IMPORT_BATCH".


-- @@ Q7 — TOOL có đẩy SKU nào của package lên Google TRƯỚC lần "Missing" đầu tiên không? (H1)
WITH first_missing AS (
  SELECT MIN(l.created_at) AS t FROM google_iap_mgmt.actions_log l
  WHERE l.action_type = 'BULK_IMPORT_BATCH'
    AND l.payload->>'package_name' = 'com.vnggames.ballisticherotwid'
    AND l.payload->>'error' ILIKE '%must list all of its existing purchase options%'
)
SELECT * FROM (
  SELECT 'bulk_import_google_call_returned'::text AS evidence, l.created_at, l.actor_email,
    l.payload->>'batch_id' AS ref,
    COALESCE(l.payload->>'rows_created','0') || ' created / ' || COALESCE(l.payload->>'rows_overwritten','0')
      || ' overwritten / ' || COALESCE(l.payload->>'rows_failed','0') || ' failed-after-Google-returned' AS detail,
    (SELECT string_agg(e->>'sku', ', ' ORDER BY (e->>'row_index')::int)
       FROM jsonb_array_elements(COALESCE(l.payload->'per_row_diagnostic','[]'::jsonb)) e) AS skus_if_logged
  FROM google_iap_mgmt.actions_log l, first_missing fm
  WHERE l.action_type = 'BULK_IMPORT_BATCH'
    AND l.payload->>'package_name' = 'com.vnggames.ballisticherotwid'
    AND NOT (l.payload ? 'error')
    AND COALESCE((l.payload->>'rows_created')::int,0) + COALESCE((l.payload->>'rows_overwritten')::int,0)
      + COALESCE((l.payload->>'rows_failed')::int,0) > 0
    AND (fm.t IS NULL OR l.created_at < fm.t)
  UNION ALL
  SELECT 'single_item_create', l.created_at, l.actor_email, l.payload->>'sku', 'IAP_CREATE', l.payload->>'sku'
  FROM google_iap_mgmt.actions_log l, first_missing fm
  WHERE l.action_type = 'IAP_CREATE'
    AND l.payload->>'package_name' = 'com.vnggames.ballisticherotwid'
    AND (fm.t IS NULL OR l.created_at < fm.t)
  UNION ALL
  SELECT 'mirror_row_existed', i.created_at, NULL, i.sku, 'iaps row first written', i.sku
  FROM google_iap_mgmt.iaps i
  JOIN google_iap_mgmt.apps a ON a.id = i.app_id
  CROSS JOIN first_missing fm
  WHERE a.package_name = 'com.vnggames.ballisticherotwid'
    AND (fm.t IS NULL OR i.created_at < fm.t)
) ev
ORDER BY ev.created_at;
-- KỲ VỌNG: H1 ⇒ ≥ 1 dòng. H2 ⇒ 0 dòng.
--   skus_if_logged chỉ có khi lần chạy đó dùng template hoặc custom price.
--   ⚠ Tạo lẻ mà ghi mirror hỏng thì KHÔNG có IAP_CREATE (create-iap.ts:176-197) — xem Railway.
--   ⚠ Tool tạo qua API mới luôn dùng option "buy"; sản phẩm mang {legacy, default} không khớp
--   nguồn nào tool biết ⇒ H1 đi kèm "Missing: legacy, default" là điều lạ ⇒ xác nhận trên Console.


-- @@ Q8 — Lịch sử Refresh IAP (chỉ lần THÀNH CÔNG mới có dòng)
SELECT l.created_at, l.actor_email, l.target_id AS app_id,
  COALESCE(l.payload->>'scope','full-list-refresh') AS scope, l.payload->>'sku' AS single_sku,
  (l.payload->>'total')::int AS google_returned, (l.payload->>'synced')::int AS synced,
  (l.payload->>'failed')::int AS failed, l.payload->>'flagged' AS flagged, l.payload->>'unflagged' AS unflagged,
  l.payload->'flagged_skus' AS flagged_skus,
  l.payload->>'flag_reconcile_skipped' AS flag_skip, l.payload->>'duration_ms' AS duration_ms
FROM google_iap_mgmt.actions_log l
WHERE l.action_type = 'IAPS_LIST_SYNC'
  AND l.payload->>'package_name' = 'com.vnggames.ballisticherotwid'
ORDER BY l.created_at;
-- KỲ VỌNG: 0 dòng ⇒ H3a (chưa từng Refresh thành công) hoặc H3d (có bấm nhưng hỏng — chỉ
--   Railway phân biệt được: "BOTH PATHS FAILED op=list pkg=com.vnggames.ballisticherotwid").
--   google_returned = 0 (flag_skip='empty_response') ⇒ H3b: list của Google trả RỖNG trong khi
--   batchUpdate nói sản phẩm có ⇒ mâu thuẫn thật, leo thang (list rỗng KHÔNG kích hoạt fallback).
--   failed = google_returned > 0 ⇒ H2b.


-- @@ Q9 — Account bị xoá / thêm lại? (H7)
SELECT l.created_at, l.action_type, l.actor_email, l.target_id, l.payload
FROM google_iap_mgmt.actions_log l
WHERE l.action_type IN ('ACCOUNT_CREATE', 'ACCOUNT_DELETE')
ORDER BY l.created_at;
-- KỲ VỌNG: một ACCOUNT_DELETE rồi ACCOUNT_CREATE cho cùng service account, SAU lần import
--   thành công của Q4/Q7 và TRƯỚC preview NEW 28 ⇒ H7.


-- @@ Q10 — Cùng họ lỗi trên MỌI package (tinywar "Missing: default" 2026-09-21, và lần này)
SELECT l.created_at, l.payload->>'package_name' AS package_name, l.actor_email,
  l.payload->>'rows_total' AS rows_total, l.payload->>'rows_failed' AS rows_failed,
  l.payload->>'error' AS error_message, l.payload->>'error_status' AS error_status,
  l.payload->'error_details' AS error_details
FROM google_iap_mgmt.actions_log l
WHERE l.action_type = 'BULK_IMPORT_BATCH'
  AND l.payload->>'error' ILIKE '%must list all of its existing purchase options%'
ORDER BY l.created_at;
-- KỲ VỌNG: tinywar + ballisticherotwid. Nếu sau mỗi lần hỏng có một lần thành công của cùng
--   package (đối chiếu Q4 đổi package) ⇒ đã có người vượt qua bằng tay (Refresh + Overwrite?).


-- @@ Q11 — Hub tracking có bật không (nguồn dòng thời gian thứ ba, không phụ thuộc Railway)
SELECT enabled, is_active, workflow_id, updated_at
FROM google_iap_mgmt.hub_tracking_config;
-- KỲ VỌNG: enabled=true ⇒ lịch sử run trên VNGGames Hub giữ nguyên câu lỗi ghép + người chạy
--   (không có package — khớp theo thời gian).
