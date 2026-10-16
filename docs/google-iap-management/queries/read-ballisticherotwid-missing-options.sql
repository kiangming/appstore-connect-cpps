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


-- ============================================================
-- PHẦN 2 (2026-10-16, sau khi Manager chạy Q0-Q11): AN TOÀN GIÁ + D8
-- ⚠ CHỈ ĐỌC. Tra cứu lý do ở BACKLOG [GOOGLE-ballisticherotwid-missing-legacy-default].
-- ============================================================


-- @@ P-Q1 — Trạng thái live theo mirror: mỗi SKU bán ở bao nhiêu vùng, giá TW/US
-- ⚠ Mirror chỉ phản ánh MỘT purchase option (buyOption ĐẦU TIÊN — onetime-product-adapter.ts:108-115),
--   KHÔNG phải cả legacy lẫn default. Overwrite sẽ ghi vào option legacyCompatible (:313-323).
SELECT i.sku, i.status, i.default_currency, i.default_price_micros,
  count(p.id) AS n_regions,
  max(CASE WHEN p.region_code = 'TW' THEN p.currency || ' ' || p.price_micros END) AS tw,
  max(CASE WHEN p.region_code = 'US' THEN p.currency || ' ' || p.price_micros END) AS us
FROM google_iap_mgmt.iaps i
JOIN google_iap_mgmt.apps a ON a.id = i.app_id
LEFT JOIN google_iap_mgmt.iap_prices p ON p.iap_id = i.id
WHERE a.package_name = 'com.vnggames.ballisticherotwid'
GROUP BY i.sku, i.status, i.default_currency, i.default_price_micros
ORDER BY i.sku;
-- KỲ VỌNG: "174 price rows" là TỔNG (≈ 6 vùng/SKU) hay MỖI SKU. Nếu ≈ 6 vùng/SKU ⇒ Overwrite sẽ MỞ BÁN
--   thêm ~167 vùng (đã đo bằng mock). status ≠ active ⇒ Overwrite sẽ BẬT LẠI SKU đó.

-- @@ E-Q1 — Hàng app hiện tại + updated_at
SELECT a.id AS app_id, a.google_console_account_id AS account_id,
  a.default_currency, a.default_language,
  a.last_synced_at AS apps_list_last_synced_at,
  a.updated_at, a.created_at,
  (a.updated_at - a.last_synced_at) AS updated_minus_list_synced
FROM google_iap_mgmt.apps a
WHERE a.package_name = 'com.vnggames.ballisticherotwid';
-- KỲ VỌNG: updated_at ≈ 03:58 ≈ apps_list_last_synced_at (|chênh| vài trăm ms).
--   Lần Refresh app lúc 03:58 đã UPSERT hàng ⇒ dấu vết lần ghi 03:25:10 bị xoá.
--   updated_at > 03:58 rõ rệt ⇒ CÓ lần ghi khác sau 03:58 ⇒ báo lại, chưa giải thích được.


-- @@ E-Q2 — Dòng thời gian mọi sự kiện có thể GHI hoặc ĐỌC defaults (hôm nay)
WITH app AS (
  SELECT id, google_console_account_id AS account_id
  FROM google_iap_mgmt.apps WHERE package_name = 'com.vnggames.ballisticherotwid'
)
SELECT l.created_at, l.action_type, l.actor_email,
  COALESCE(l.payload->>'scope', CASE WHEN l.action_type = 'IAPS_LIST_SYNC' THEN 'full-list-refresh' END) AS scope,
  l.payload->>'total'            AS list_total,          -- IAPS_LIST_SYNC
  l.payload->>'batch_id'         AS batch_id,            -- BULK_IMPORT_BATCH
  l.payload->>'pricing_source'   AS pricing_source,
  l.payload->>'cross_currency_resolved'           AS xc_resolved,
  l.payload->>'cross_currency_by_explicit_header' AS xc_explicit_header,
  l.payload->>'cross_currency_refused'            AS xc_refused,
  l.payload->>'apps_count'       AS apps_count,          -- APPS_SYNC
  l.payload->>'details_ok'       AS details_ok,
  l.payload->>'details_failed'   AS details_failed
FROM google_iap_mgmt.actions_log l, app
WHERE l.created_at >= TIMESTAMPTZ '2026-10-16 00:00:00+00'
  AND (
       (l.target_id = app.id AND l.action_type IN ('IAPS_LIST_SYNC','BULK_IMPORT_BATCH','IAP_CREATE','IAP_UPDATE'))
    OR (l.target_id = app.account_id AND l.action_type = 'APPS_SYNC')
  )
ORDER BY l.created_at;
-- KỲ VỌNG (thứ tự): BULK_IMPORT_BATCH (~03:21:5x) → IAPS_LIST_SYNC full-list (03:25:10)
--   → APPS_SYNC (03:58). Chỉ IAPS_LIST_SYNC full-list mới đổi được currency đang
--   khác NULL (iaps.ts:759-769). APPS_SYNC KHÔNG đổi được currency đã có
--   (refresh/route.ts:101-104 bỏ qua; :108-110 giữ currency cũ).
--   ⚠ details_ok của APPS_SYNC đếm CẢ app bị bỏ qua (route.ts:101-103) — không
--     phân biệt "đã đọc AppDetails" với "bỏ qua".
--   Có thêm IAPS_LIST_SYNC full-list khác (ngoài 03:25:10) ⇒ báo lại.


-- @@ E-Q3 — Batch a14c2e4d: lúc EXECUTE (03:21:51) app currency có khác USD không?
SELECT b.id AS batch_id, b.created_at, b.executed_at, b.pricing_source, b.status,
  b.rows_total, b.rows_success, b.rows_failed, b.rows_skipped,
  l.payload->>'cross_currency_resolved'           AS xc_resolved,
  l.payload->>'cross_currency_by_explicit_header' AS xc_explicit_header,   -- chỉ có ở nhánh catch
  l.payload->>'cross_currency_by_value_fallback'  AS xc_value_fallback,
  l.payload->>'cross_currency_refused'            AS xc_refused,
  l.payload->>'rows_refused'                      AS rows_refused,
  jsonb_path_query_array(l.payload, '$.refused_rows[*].reason') AS refused_reasons,
  jsonb_array_length(COALESCE(l.payload->'per_row_diagnostic','[]'::jsonb)) AS diag_rows,
  l.payload->>'error' AS error
FROM google_iap_mgmt.import_batches b
LEFT JOIN google_iap_mgmt.actions_log l
  ON l.action_type = 'BULK_IMPORT_BATCH' AND l.payload->>'batch_id' = b.id::text
WHERE b.id::text LIKE 'a14c2e4d%';
-- KỲ VỌNG: pricing_source ∈ (default_template, app_template) VÀ
--   (xc_explicit_header = 28 HOẶC xc_resolved = 28) ⇒ lúc execute app currency ≠ USD
--   (file có header "Price (USD)"; trigger chỉ bắn khi app currency ≠ USD —
--   cross-currency.ts:97-101). Tên đồng tiền (TWD) KHÔNG nằm trong audit; chỉ có ở
--   Railway: "[google-iap:bulk-import:cross-currency] resolved sku=… → TWD/33000000".
--   xc_* = 0 với 28 dòng "Price (USD)" ⇒ execute thấy USD/NULL ⇒ mâu thuẫn với banner ⇒ báo lại.
--   refused_reasons chứa "App currency is XXX" ⇒ XXX là currency lúc execute.
--   pricing_source = google_default ⇒ với TWD cả 28 dòng phải bị REFUSE, không thể ra
--   "FAILED 28/28 Missing: legacy, default" ⇒ báo lại.


-- @@ E-Q4 — Mirror: default_currency từng item có đúng là "giá vùng US" không?
WITH app AS (SELECT id FROM google_iap_mgmt.apps WHERE package_name = 'com.vnggames.ballisticherotwid')
SELECT i.default_currency,
  COUNT(*) AS iaps,
  COUNT(*) FILTER (WHERE p_us.iap_id IS NOT NULL) AS has_us_price,
  COUNT(*) FILTER (WHERE p_us.iap_id IS NOT NULL AND p_us.price_micros = i.default_price_micros
                     AND p_us.currency = i.default_currency) AS default_equals_us_price,
  MIN(i.created_at) AS first_mirrored_at, MAX(i.last_synced_at) AS last_item_synced_at
FROM google_iap_mgmt.iaps i
JOIN app ON app.id = i.app_id
LEFT JOIN google_iap_mgmt.iap_prices p_us ON p_us.iap_id = i.id AND p_us.region_code = 'US'
GROUP BY i.default_currency;
-- KỲ VỌNG: 1 dòng USD, iaps = has_us_price = default_equals_us_price = 28 ⇒ "default"
--   chính là giá vùng US do adapter chọn (onetime-product-adapter.ts:124-133), KHÔNG
--   phải đồng tiền mặc định Google trả. Dòng currency ≠ USD ⇒ item đó không có vùng US.


-- @@ E-Q5 — Listings: en-US đến từ đâu?
WITH app AS (SELECT id FROM google_iap_mgmt.apps WHERE package_name = 'com.vnggames.ballisticherotwid')
SELECT l.locale, COUNT(DISTINCT l.iap_id) AS iaps_with_locale
FROM google_iap_mgmt.iap_listings l
JOIN google_iap_mgmt.iaps i ON i.id = l.iap_id
JOIN app ON app.id = i.app_id
GROUP BY l.locale ORDER BY 2 DESC;
-- KỲ VỌNG: KHÔNG item nào có 'en-US' ⇒ en-US là fallback của adapter (sản phẩm đầu
--   tiên không có listing — onetime-product-adapter.ts:152-153) ⇒ giá trị bịa.
--   Có 'en-US' ⇒ nhiều khả năng listing ĐẦU TIÊN của sản phẩm đầu danh sách là en-US;
--   thứ tự listing/sản phẩm Google trả KHÔNG được lưu ⇒ CHƯA BIẾT chắc.


-- @@ E-Q6 — Cùng cơ chế ở app khác? (đọc toàn bộ apps)
SELECT a.package_name, a.default_currency, a.default_language, a.updated_at,
  s.last_full_list_sync,
  CASE
    WHEN s.last_full_list_sync IS NULL THEN 'chưa từng refresh IAP ⇒ currency = đoán từ ngôn ngữ'
    WHEN a.default_currency = 'USD' AND a.default_language NOT LIKE 'en%' THEN 'nghi lật: currency từ vùng US, language từ listing/AppDetails'
    ELSE ''
  END AS note
FROM google_iap_mgmt.apps a
LEFT JOIN LATERAL (
  SELECT MAX(l.created_at) AS last_full_list_sync
  FROM google_iap_mgmt.actions_log l
  WHERE l.action_type = 'IAPS_LIST_SYNC' AND l.target_id = a.id
    AND COALESCE(l.payload->>'scope', 'full') <> 'single-item-price-sync'
) s ON TRUE
ORDER BY (s.last_full_list_sync IS NULL), a.default_currency, a.package_name;
-- Đọc: cột note. App có refresh IAP mà currency ≠ USD ⇒ sản phẩm đầu danh sách không có vùng US.


-- ============================================================
-- D8 — Ba lần "Product must list all of its existing purchase options.
--      Missing: …" có CÙNG cơ chế không?
--   playtogether        2026-07-03  "Missing: legacy-base"
--   tankarena.tinywar   2026-09-21  "Missing: default"  (×2)
--   ballisticherotwid   2026-10-16  "Missing: legacy, default"
--
-- ⚠ CHỈ ĐỌC. Không UPDATE/INSERT/DELETE. Supabase SQL Editor.
-- Mỗi khối "-- @@" là MỘT truy vấn độc lập. Giờ hiển thị cả UTC lẫn +07.
--
-- Mốc code (đo từ reflog origin/main của máy dev — giờ PUSH, không phải giờ
-- Railway deploy xong):
--   4fbcdd5 (RMW cho dòng OVERWRITE)  push 2026-07-03 12:15:03 +07 = 05:15:03 UTC
--   1fb3f7e (Hotfix 30, activate/edit) push 2026-07-21 11:48:25 +07 = 04:48:25 UTC
--   TRƯỚC 4fbcdd5: MỌI dòng (create lẫn overwrite) gửi đúng 1 option "buy",
--     allowMissing:true ⇒ SKU nào đã có trên Google đều hỏng, bất kể preview
--     xếp NEW hay EXISTING.
--   SAU 4fbcdd5: dòng OVERWRITE GET live + gửi đủ option; chỉ dòng CREATE còn
--     gửi "buy" ⇒ "Missing" chỉ xảy ra khi preview xếp NEW cho SKU đã có.
--
-- Schema: supabase/migrations/20260520010000_google_iap_mgmt_init.sql
--   (apps, iaps, import_batches, actions_log, google_console_accounts),
--   20260521000000_google_iap_mgmt_app_defaults.sql (apps.default_currency/_language),
--   20260702120000_google_iap_mgmt_deleted_on_google.sql (iaps.deleted_on_google_at,
--   CHECK action_type thêm IAP_ACKNOWLEDGE_REMOVE/BULK_ACTIVATE/BULK_DEACTIVATE).
--
-- Package playtogether: chỉ có ỨNG VIÊN `com.vng.playtogether` trong MOCKUP
-- (docs/google-iap-management/design/deleted-on-google-flagging-mockup.html:106-107),
-- không phải dữ liệu production ⇒ vẫn lọc ILIKE '%playtogether%'. Q0 liệt kê
-- tên thật; nếu ra nhiều package, đọc cột package_name ở Q2.
-- ⚠ Đoán trước (từ KB §10.13.F:2861-2864, commit de787f1/db79b2e — chưa đo):
--   mirror của playtogether ĐÃ ĐẦY (≈293 live + 109 orphan) trước 07-03 ⇒ kỳ vọng
--   Q2 ra PRE_RMW_OVERWRITE, KHÔNG phải MIRROR_EMPTY_CREATE.
-- ⚠ Payload lỗi của tinywar (09-21) có TRƯỚC O1-O3 (2b140b0, push 2026-10-12) ⇒
--   KHÔNG có error_status/error_details/fallback — "NULL" ở đó KHÔNG phải khác cơ chế.
-- ============================================================


-- @@ D8-Q0 — App row hiện tại của 3 package + tiền tệ mặc định app vs mirror (câu 3)
SELECT a.package_name, a.id AS app_id, a.google_console_account_id AS account_id,
  acc.service_account_email AS sa_email, acc.created_at AS account_created_at,
  a.created_at AS app_row_created_at,
  a.default_currency AS app_default_currency_now,
  a.default_language AS app_default_language_now,
  a.last_synced_at AS apps_list_last_synced_at,
  m.iaps_total, m.first_mirrored_at, m.last_item_synced_at,
  m.dominant_mirror_currency, m.mirror_currency_mix,
  m.iaps_with_us_price_row,
  ls.last_full_list_sync_at, ls.last_full_list_total,
  CASE
    WHEN m.iaps_total = 0 THEN 'MIRROR_EMPTY'
    WHEN ls.last_full_list_sync_at IS NULL THEN 'NO_FULL_LIST_SYNC_EVER (mirror chỉ từ import/tạo lẻ)'
    WHEN a.default_currency = 'USD' AND m.dominant_mirror_currency = 'USD'
         AND m.iaps_with_us_price_row = m.iaps_total
      THEN 'USD_KHOP_QUY_TAC_US_FIRST (USD có thể chỉ là hệ quả của adapter, không phải currency thật của app)'
    WHEN a.default_currency IS DISTINCT FROM m.dominant_mirror_currency
      THEN 'APP_KHAC_MIRROR'
    ELSE 'APP_KHOP_MIRROR'
  END AS currency_reading
FROM google_iap_mgmt.apps a
JOIN google_iap_mgmt.google_console_accounts acc ON acc.id = a.google_console_account_id
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS iaps_total,
    MIN(i.created_at) AS first_mirrored_at,
    MAX(i.last_synced_at) AS last_item_synced_at,
    (SELECT i2.default_currency FROM google_iap_mgmt.iaps i2 WHERE i2.app_id = a.id
       GROUP BY i2.default_currency ORDER BY COUNT(*) DESC, i2.default_currency LIMIT 1) AS dominant_mirror_currency,
    (SELECT string_agg(x.c || '×' || x.n, ', ' ORDER BY x.n DESC, x.c)
       FROM (SELECT COALESCE(i3.default_currency, 'NULL') AS c, COUNT(*) AS n
             FROM google_iap_mgmt.iaps i3 WHERE i3.app_id = a.id GROUP BY 1) x) AS mirror_currency_mix,
    COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM google_iap_mgmt.iap_prices p
                                   WHERE p.iap_id = i.id AND p.region_code = 'US')) AS iaps_with_us_price_row
  FROM google_iap_mgmt.iaps i WHERE i.app_id = a.id
) m ON true
LEFT JOIN LATERAL (
  SELECT l.created_at AS last_full_list_sync_at, (l.payload->>'total')::int AS last_full_list_total
  FROM google_iap_mgmt.actions_log l
  WHERE l.action_type = 'IAPS_LIST_SYNC' AND l.payload->>'scope' IS NULL
    AND (l.target_id = a.id OR l.payload->>'package_name' = a.package_name)
  ORDER BY l.created_at DESC LIMIT 1
) ls ON true
WHERE a.package_name ILIKE ANY (ARRAY['%playtogether%', '%tankarena.tinywar%', '%ballisticherotwid%'])
ORDER BY a.package_name, a.created_at;
-- KỲ VỌNG: ballisticherotwid: USD / en-US, dominant USD, currency_reading = USD_KHOP_QUY_TAC_US_FIRST
--   (khớp Q0 của Manager). Cùng kết quả ở tinywar/playtogether ⇒ cùng kiểu "refresh lật
--   currency về USD" (adapter đọc API mới lấy giá vùng US làm defaultPrice —
--   onetime-product-adapter.ts:124-133, :177-182; ghi vào app ở iaps.ts:758-776).
--   app_default_currency_now ≠ USD và mirror ≠ rỗng ⇒ app đó KHÔNG bị lật (vd. không bán ở US,
--   hoặc chưa từng full-list sync) ⇒ ghi rõ, đừng gộp.
--   ⚠ Không có bảng lịch sử cho apps.default_currency ⇒ giá trị TẠI thời điểm import: CHƯA BIẾT.


-- @@ D8-Q1 — Dòng thời gian từng package: import, refresh, tạo/sửa lẻ, gỡ, account, mốc mirror
WITH pk AS (
  SELECT DISTINCT a.package_name FROM google_iap_mgmt.apps a
  WHERE a.package_name ILIKE ANY (ARRAY['%playtogether%', '%tankarena.tinywar%', '%ballisticherotwid%'])
  UNION
  SELECT DISTINCT l.payload->>'package_name' FROM google_iap_mgmt.actions_log l
  WHERE l.payload->>'package_name' ILIKE ANY (ARRAY['%playtogether%', '%tankarena.tinywar%', '%ballisticherotwid%'])
),
app_rows AS (
  SELECT a.*, acc.service_account_email AS sa_email, acc.created_at AS account_created_at
  FROM google_iap_mgmt.apps a
  JOIN google_iap_mgmt.google_console_accounts acc ON acc.id = a.google_console_account_id
  WHERE a.package_name IN (SELECT package_name FROM pk)
),
ev AS (
  -- Audit theo package (BULK_IMPORT_BATCH, IAPS_LIST_SYNC, IAP_CREATE/UPDATE, ACK_REMOVE, BULK_*)
  SELECT COALESCE(l.payload->>'package_name', ar.package_name) AS package_name, l.created_at AS t,
    l.action_type ||
      CASE WHEN l.action_type = 'IAPS_LIST_SYNC' THEN ' [' || COALESCE(l.payload->>'scope', 'full-list') || ']'
           WHEN l.action_type = 'BULK_IMPORT_BATCH' AND l.payload ? 'error' THEN ' [FAILED]'
           WHEN l.action_type = 'BULK_IMPORT_BATCH' THEN ' [OK]'
           ELSE '' END AS event,
    l.actor_email,
    CASE l.action_type
      WHEN 'BULK_IMPORT_BATCH' THEN
        'batch=' || COALESCE(l.payload->>'batch_id', '?') ||
        ' src=' || COALESCE(l.payload->>'pricing_source', '?') ||
        ' total=' || COALESCE(l.payload->>'rows_total', '?') ||
        ' created=' || COALESCE(l.payload->>'rows_created', '-') ||
        ' overwritten=' || COALESCE(l.payload->>'rows_overwritten', '-') ||
        ' failed=' || COALESCE(l.payload->>'rows_failed', '?') ||
        COALESCE(' status=' || (l.payload->>'error_status'), '') ||
        COALESCE(' err="' || LEFT(l.payload->>'error', 110) || '"', '')
      WHEN 'IAPS_LIST_SYNC' THEN
        'total=' || COALESCE(l.payload->>'total', '-') || ' synced=' || COALESCE(l.payload->>'synced', '?') ||
        ' failed=' || COALESCE(l.payload->>'failed', '?') || COALESCE(' sku=' || (l.payload->>'sku'), '') ||
        COALESCE(' flag_skip=' || (l.payload->>'flag_reconcile_skipped'), '')
      WHEN 'IAP_ACKNOWLEDGE_REMOVE' THEN 'removed=' || COALESCE(l.payload->>'removed_skus', '?')
      ELSE COALESCE('sku=' || (l.payload->>'sku'), LEFT(l.payload::text, 120))
    END AS detail
  FROM google_iap_mgmt.actions_log l
  LEFT JOIN app_rows ar ON ar.id = l.target_id
  WHERE l.action_type <> 'APPS_SYNC'
    AND (l.payload->>'package_name' IN (SELECT package_name FROM pk) OR l.target_id IN (SELECT id FROM app_rows))
  UNION ALL
  -- APPS_SYNC của account đang chứa app (target_id = account id) — refresh DANH SÁCH APP
  SELECT ar.package_name, l.created_at, 'APPS_SYNC (account)', l.actor_email,
    'apps=' || COALESCE(l.payload->>'apps_count', '?') || ' details_ok=' || COALESCE(l.payload->>'details_ok', '?')
  FROM google_iap_mgmt.actions_log l JOIN app_rows ar ON ar.google_console_account_id = l.target_id
  WHERE l.action_type = 'APPS_SYNC'
  UNION ALL
  -- Account tạo / xoá, khớp theo service account email (account bị xoá ⇒ id cũ không còn)
  SELECT ar.package_name, l.created_at, l.action_type, l.actor_email,
    'account=' || COALESCE(l.payload->>'display_name', '?') || ' target=' || COALESCE(l.target_id::text, '?')
  FROM google_iap_mgmt.actions_log l
  JOIN (SELECT DISTINCT package_name, sa_email FROM app_rows) ar ON ar.sa_email = l.payload->>'service_account_email'
  WHERE l.action_type IN ('ACCOUNT_CREATE', 'ACCOUNT_DELETE')
  UNION ALL
  -- import_batches (kể cả lần chết TRƯỚC khi ghi audit)
  SELECT ar.package_name, b.created_at, 'BATCH_ROW ' || b.status, NULL,
    'batch=' || b.id || ' src=' || COALESCE(b.pricing_source, '?') || ' total=' || b.rows_total ||
    ' success=' || b.rows_success || ' overwritten=' || b.rows_overwritten || ' failed=' || b.rows_failed ||
    ' file=' || COALESCE(b.source_filename, '?')
  FROM google_iap_mgmt.import_batches b JOIN app_rows ar ON ar.id = b.app_id
  UNION ALL
  -- Mốc dữ liệu (không phải audit)
  SELECT package_name, created_at, '~ app row created', NULL, 'app_id=' || id FROM app_rows
  UNION ALL
  SELECT package_name, account_created_at, '~ account row created (hiện tại)', NULL, 'sa=' || sa_email FROM app_rows
  UNION ALL
  SELECT ar.package_name, MIN(i.created_at), '~ first_mirrored_at (MIN iaps.created_at)', NULL,
    'rows_now=' || COUNT(*) FROM google_iap_mgmt.iaps i JOIN app_rows ar ON ar.id = i.app_id GROUP BY ar.package_name
  UNION ALL
  SELECT pk.package_name, x.t, x.e, NULL, x.d FROM pk CROSS JOIN (VALUES
    ('2026-07-03 05:15:03+00'::timestamptz, '~ CODE 4fbcdd5 pushed (RMW overwrite)', 'Railway deploy xong SAU mốc này vài phút — giờ chính xác CHƯA BIẾT'),
    ('2026-07-21 04:48:25+00'::timestamptz, '~ CODE 1fb3f7e pushed (Hotfix 30)', 'activate/deactivate/edit — không đổi bulk import')
  ) AS x(t, e, d)
)
SELECT package_name, t AS at_utc, to_char(t AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') || ' +07' AS at_plus07, event, actor_email, detail
FROM ev
WHERE package_name IS NOT NULL
ORDER BY package_name, t, event;
-- KỲ VỌNG: đọc theo từng package, tìm dòng BULK_IMPORT_BATCH [FAILED] rồi nhìn NGƯỢC lên:
--   có "IAPS_LIST_SYNC [full-list]" / "~ first_mirrored_at" / BULK_IMPORT_BATCH [OK] nào trước nó không.
--   ballisticherotwid (đã biết): FAILED 03:21:51 → first_mirrored 03:25:01 → full-list 03:25:10 total=28.


-- @@ D8-Q2 — Mỗi lần hỏng "Missing": mirror có bao nhiêu SKU TRƯỚC lần chạy + refresh gần nhất + phán định
WITH f AS (
  SELECT l.id, l.created_at AS failed_at, l.payload->>'package_name' AS package_name, l.target_id,
    l.payload->>'batch_id' AS batch_id, l.payload->>'pricing_source' AS pricing_source,
    (l.payload->>'rows_total')::int AS rows_total, (l.payload->>'rows_failed')::int AS rows_failed,
    l.payload->>'error' AS error, l.payload->>'error_status' AS error_status,
    COALESCE(b.created_at,
             l.created_at - make_interval(secs => COALESCE((l.payload->>'duration_ms')::numeric, 0) / 1000.0)
    ) AS run_started_at,
    b.created_at IS NOT NULL AS run_start_from_batch_row
  FROM google_iap_mgmt.actions_log l
  LEFT JOIN google_iap_mgmt.import_batches b ON b.id::text = l.payload->>'batch_id'
  WHERE l.action_type = 'BULK_IMPORT_BATCH'
    AND l.payload->>'error' ILIKE '%must list all of its existing purchase options%'
    AND l.payload->>'package_name' ILIKE ANY (ARRAY['%playtogether%', '%tankarena.tinywar%', '%ballisticherotwid%'])
),
x AS (
  SELECT f.*,
    -- Mirror (mọi app row của package, mọi account) có bao nhiêu SKU TRƯỚC lần chạy
    (SELECT COUNT(*) FROM google_iap_mgmt.iaps i JOIN google_iap_mgmt.apps a ON a.id = i.app_id
      WHERE a.package_name = f.package_name AND i.created_at < f.run_started_at) AS mirror_skus_before_run,
    (SELECT COUNT(*) FROM google_iap_mgmt.iaps i JOIN google_iap_mgmt.apps a ON a.id = i.app_id
      WHERE a.package_name = f.package_name) AS mirror_skus_now,
    (SELECT MIN(i.created_at) FROM google_iap_mgmt.iaps i JOIN google_iap_mgmt.apps a ON a.id = i.app_id
      WHERE a.package_name = f.package_name) AS first_mirrored_at,
    -- Refresh TOÀN danh sách thành công gần nhất trước lần chạy
    (SELECT MAX(l2.created_at) FROM google_iap_mgmt.actions_log l2
      WHERE l2.action_type = 'IAPS_LIST_SYNC' AND l2.payload->>'scope' IS NULL
        AND l2.payload->>'package_name' = f.package_name AND l2.created_at < f.run_started_at) AS last_full_list_sync_before,
    (SELECT COUNT(*) FROM google_iap_mgmt.actions_log l2
      WHERE l2.action_type = 'IAPS_LIST_SYNC' AND l2.payload->>'scope' IS NOT NULL
        AND l2.payload->>'package_name' = f.package_name AND l2.created_at < f.run_started_at) AS single_item_syncs_before,
    -- Import thành công có đẩy SKU lên Google trước lần chạy (cũng ghi mirror)
    (SELECT COUNT(*) FROM google_iap_mgmt.actions_log l3
      WHERE l3.action_type = 'BULK_IMPORT_BATCH' AND NOT (l3.payload ? 'error')
        AND l3.payload->>'package_name' = f.package_name AND l3.created_at < f.run_started_at
        AND COALESCE((l3.payload->>'rows_created')::int, 0) + COALESCE((l3.payload->>'rows_overwritten')::int, 0) > 0
    ) AS ok_imports_before,
    -- Mirror có thể bị ĐẾM THIẾU: hàng bị gỡ / account bị xoá SAU lần chạy (iaps CASCADE)
    (SELECT COUNT(*) FROM google_iap_mgmt.actions_log l4
      WHERE l4.created_at > f.run_started_at AND l4.action_type = 'IAP_ACKNOWLEDGE_REMOVE'
        AND l4.payload->>'package_name' = f.package_name) AS ack_removes_after_run,
    (SELECT COUNT(*) FROM google_iap_mgmt.actions_log l4
      WHERE l4.created_at > f.run_started_at AND l4.action_type = 'ACCOUNT_DELETE') AS account_deletes_after_run_any_account,
    -- Lần thành công KẾ TIẾP của cùng package, và có refresh nào xen giữa không
    nx.next_ok_at, nx.next_ok_created, nx.next_ok_overwritten,
    (SELECT COUNT(*) FROM google_iap_mgmt.actions_log l5
      WHERE l5.action_type = 'IAPS_LIST_SYNC' AND l5.payload->>'scope' IS NULL
        AND l5.payload->>'package_name' = f.package_name
        AND l5.created_at > f.failed_at AND l5.created_at < COALESCE(nx.next_ok_at, 'infinity'::timestamptz)
    ) AS full_list_syncs_between_fail_and_next_ok
  FROM f
  LEFT JOIN LATERAL (
    SELECT l6.created_at AS next_ok_at, (l6.payload->>'rows_created')::int AS next_ok_created,
      (l6.payload->>'rows_overwritten')::int AS next_ok_overwritten
    FROM google_iap_mgmt.actions_log l6
    WHERE l6.action_type = 'BULK_IMPORT_BATCH' AND NOT (l6.payload ? 'error')
      AND l6.payload->>'package_name' = f.package_name AND l6.created_at > f.failed_at
      AND COALESCE((l6.payload->>'rows_created')::int, 0) + COALESCE((l6.payload->>'rows_overwritten')::int, 0) > 0
    ORDER BY l6.created_at LIMIT 1
  ) nx ON true
)
SELECT package_name,
  failed_at AS failed_at_utc, to_char(failed_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') || ' +07' AS failed_at_plus07,
  run_started_at, run_start_from_batch_row, batch_id, pricing_source, rows_total, rows_failed,
  LEFT(error, 120) AS error_head, error_status,
  CASE
    WHEN failed_at < '2026-07-03 05:15:03+00' THEN 'PRE_RMW (trước push 4fbcdd5)'
    WHEN failed_at < '2026-07-03 05:45:03+00' THEN 'DEPLOY_WINDOW (≤30 phút sau push — code nào chạy: CHƯA BIẾT)'
    ELSE 'POST_RMW'
  END AS code_era,
  'mirror had ' || mirror_skus_before_run || ' SKUs before this run' AS mirror_before,
  COALESCE('last full IAPS_LIST_SYNC before: ' || last_full_list_sync_before::text, 'last full IAPS_LIST_SYNC before: none')
    AS last_list_sync_before,
  single_item_syncs_before, ok_imports_before, mirror_skus_now, first_mirrored_at,
  ack_removes_after_run, account_deletes_after_run_any_account, next_ok_at, next_ok_created, next_ok_overwritten,
  full_list_syncs_between_fail_and_next_ok,
  CASE
    WHEN failed_at >= '2026-07-03 05:45:03+00' AND mirror_skus_before_run = 0 AND last_full_list_sync_before IS NULL
      THEN 'MIRROR_EMPTY_CREATE — chưa từng refresh, preview xếp NEW toàn bộ (cơ chế ballisticherotwid)'
    WHEN failed_at >= '2026-07-03 05:45:03+00' AND mirror_skus_before_run = 0
      THEN 'MIRROR_EMPTY_DESPITE_REFRESH — có refresh mà mirror vẫn rỗng (list Google trả rỗng? xem Q1 total=)'
    WHEN failed_at >= '2026-07-03 05:45:03+00'
      THEN 'POST_RMW_MIRROR_PARTIAL — mirror có ' || mirror_skus_before_run || ' SKU: ít nhất 1 SKU của file VẮNG mirror (hoặc >1000 dòng, H5) — Railway: có onetimeproducts.get trước lỗi không'
    WHEN failed_at < '2026-07-03 05:15:03+00' AND mirror_skus_before_run > 0
      THEN 'PRE_RMW_OVERWRITE khả dĩ — mirror có SKU ⇒ preview xếp EXISTING; code cũ gửi "buy" cho mọi dòng'
    WHEN failed_at < '2026-07-03 05:15:03+00'
      THEN 'PRE_RMW + MIRROR_EMPTY — cả hai cơ chế cùng có mặt; code cũ hỏng bất kể NEW/EXISTING'
    ELSE 'DEPLOY_WINDOW — xem Railway log quanh giờ này'
  END AS verdict
FROM x
ORDER BY failed_at;
-- KỲ VỌNG:
--   • Cơ chế "mirror rỗng ⇒ Create" (ballisticherotwid đã đo): code_era=POST_RMW,
--     "mirror had 0 SKUs before this run", "last full IAPS_LIST_SYNC before: none",
--     ok_imports_before=0, verdict=MIRROR_EMPTY_CREATE.
--   • Cơ chế "overwrite trên code CŨ" (mô tả của KB §10.13.G cho ca legacy-base): code_era=PRE_RMW,
--     mirror_before > 0 (lý tưởng ≥ rows_total), có full-list sync trước đó, và thường có
--     next_ok_at cùng ngày SAU 05:15 UTC với next_ok_overwritten > 0 và
--     full_list_syncs_between_fail_and_next_ok = 0 (mirror không đổi giữa hai lần ⇒ lần hỏng
--     cũng đã xếp EXISTING cho đúng các SKU đó).
--   • tinywar: hai dòng (09-21). Nếu verdict = MIRROR_EMPTY_CREATE ⇒ cùng cơ chế ballisticherotwid.
--     Nếu POST_RMW_MIRROR_PARTIAL ⇒ KHÁC — cần Railway (onetimeproducts.get pkg=…tinywar).
--   ⚠ mirror_before đếm hàng CÒN TỒN TẠI hôm nay. ack_removes_after_run > 0, hoặc
--     account_deletes_after_run_any_account > 0 mà Q1 cho thấy account của package bị xoá/thêm lại
--     (app_row_created_at SAU lần hỏng) ⇒ có thể đếm thiếu — khi đó đừng kết luận "0".
--   ⚠ Payload hỏng không ghi số dòng create/overwrite; mirror_before là proxy cho quyết định
--     của preview, không phải bản ghi quyết định.
