-- ============================================================
-- Rà soát (2026-10-16, arc-google-missing-purchase-options) — CHỈ ĐỌC.
-- Không UPDATE/INSERT/DELETE. Supabase SQL Editor. Mỗi khối "-- @@" độc lập.
-- KHÔNG đụng cột mới apps.iaps_last_synced_at ⇒ chạy được cả trước migration C1.
--
-- PHẦN O — mọi lượt Bulk import Google đã OVERWRITE sản phẩm có sẵn.
--   Vì sao phải rà: đường Overwrite (code hiện tại, và cả trước 4fbcdd5) thay
--   NGUYÊN KHỐI cấu hình giá/vùng của purchase option đích — đo bằng mock trên
--   code thật (design-bulk-import-existence-overwrite-safety.md §1 E3):
--     (1) vùng không có trong (template ∪ convert) bị BỎ, vùng chưa từng bán bị THÊM;
--     (2) mọi vùng đặt AVAILABLE ⇒ vùng đã tắt bị mở bán lại;
--     (3) option đích luôn ACTIVATE ⇒ SKU inactive bị bật lại;
--     (4) listings bị thay bằng listings của file;
--     (5) taxAndComplianceSettings / offerTags / restrictedPaymentCountries cấp
--         sản phẩm nằm trong updateMask nhưng vắng trong body ⇒ CÓ THỂ bị xoá
--         (CHƯA BIẾT Google xử lý trường vắng mặt ra sao).
--   ⚠ Audit KHÔNG ghi SKU nào là overwrite, SKU nào là create (per_row_diagnostic
--     không có cột decision; chỉ có SKU cho dòng template/custom). Danh sách SKU
--     overwrite thật: Railway `method=monetization.onetimeproducts.get pkg=<pkg>`
--     (mỗi dòng overwrite một lần GET, từ 4fbcdd5) — nếu log còn giữ.
--
-- PHẦN G — app có currency/language do TOOL TỰ ĐOÁN.
--   Hiện KHÔNG app nào có giá trị do Manager khai (D9 chưa làm). Hai nguồn đoán:
--     (a) Refresh danh sách app, lần đầu: language = AppDetails.defaultLanguage
--         (giá trị thật của Play Console); currency = ĐOÁN từ language
--         (region-currency-map.ts, vd zh-TW → TWD).
--     (b) Refresh IAP (mỗi lần): GHI ĐÈ cả hai theo sản phẩm đầu tiên Google trả:
--         currency = currency vùng US (không có US ⇒ vùng đầu tiên); language =
--         listing đầu tiên, hoặc "en-US" BỊA khi không có listing.
--   ⇒ Không giá trị nào là "currency của app" theo Google (v3 không có khái niệm đó).
--   Nguồn (b) chỉ nhận ra được qua audit IAPS_LIST_SYNC — dùng ở đây để RÀ SOÁT,
--   không phải trạng thái logic.
-- ============================================================


-- @@ O1 — Mọi lượt bulk import đã overwrite ≥ 1 sản phẩm (theo audit thành công)
SELECT l.created_at,
  (l.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') AS created_at_vn,
  l.payload->>'package_name' AS package_name,
  l.actor_email,
  l.payload->>'batch_id' AS batch_id,
  l.payload->>'pricing_source' AS pricing_source,
  (l.payload->>'rows_total')::int AS rows_total,
  (l.payload->>'rows_created')::int AS rows_created,
  (l.payload->>'rows_overwritten')::int AS rows_overwritten,
  (l.payload->>'rows_failed')::int AS rows_failed,
  CASE WHEN l.created_at < TIMESTAMPTZ '2026-07-03 05:15:03+00'
       THEN 'PRE_RMW (mọi dòng gửi option "buy"; chỉ SP có đúng "buy" mới ghi được)'
       ELSE 'POST_RMW (GET live, gửi đủ option)' END AS code_era,
  (SELECT string_agg(DISTINCT e->>'sku', ', ')
     FROM jsonb_array_elements(COALESCE(l.payload->'per_row_diagnostic', '[]'::jsonb)) e) AS skus_in_batch_if_logged,
  b.status AS batch_status, b.source_filename
FROM google_iap_mgmt.actions_log l
LEFT JOIN google_iap_mgmt.import_batches b ON b.id::text = l.payload->>'batch_id'
WHERE l.action_type = 'BULK_IMPORT_BATCH'
  AND NOT (l.payload ? 'error')
  AND COALESCE((l.payload->>'rows_overwritten')::int, 0) > 0
ORDER BY l.created_at;
-- KỲ VỌNG: mỗi dòng = một lượt mà (1)–(5) đã áp lên rows_overwritten sản phẩm đang bán.
--   skus_in_batch_if_logged = SKU của cả lô (create + overwrite lẫn lộn), chỉ có khi
--   nguồn là template/custom; NULL với google_default.
--   0 dòng ⇒ chưa từng có Overwrite nào được ghi audit ⇒ vẫn chạy O2 (audit có thể bị nuốt).


-- @@ O2 — import_batches có rows_overwritten > 0 (bắt cả lượt mất dòng audit)
SELECT b.created_at, b.executed_at, a.package_name, b.app_id, b.status, b.pricing_source,
  b.source_filename, b.rows_total, b.rows_success, b.rows_overwritten, b.rows_skipped, b.rows_failed,
  EXISTS (SELECT 1 FROM google_iap_mgmt.actions_log l
          WHERE l.action_type = 'BULK_IMPORT_BATCH' AND l.payload->>'batch_id' = b.id::text) AS has_audit_row
FROM google_iap_mgmt.import_batches b
LEFT JOIN google_iap_mgmt.apps a ON a.id = b.app_id
WHERE COALESCE(b.rows_overwritten, 0) > 0
ORDER BY b.created_at;
-- KỲ VỌNG: khớp O1 từng batch. has_audit_row = false ⇒ lượt ghi thật nhưng audit bị
--   nuốt (actions-log.ts appendAction). app_id NULL ⇒ app row đã bị xoá — đối chiếu tên file.


-- @@ O3 — Tóm tắt theo app: cần rà app nào, bao nhiêu sản phẩm, lần cuối khi nào
SELECT l.payload->>'package_name' AS package_name,
  COUNT(*) AS overwrite_batches,
  SUM((l.payload->>'rows_overwritten')::int) AS products_overwritten_total,
  MIN(l.created_at) AS first_overwrite_at, MAX(l.created_at) AS last_overwrite_at,
  string_agg(DISTINCT l.payload->>'pricing_source', ', ') AS pricing_sources,
  string_agg(DISTINCT l.actor_email, ', ') AS actors
FROM google_iap_mgmt.actions_log l
WHERE l.action_type = 'BULK_IMPORT_BATCH'
  AND NOT (l.payload ? 'error')
  AND COALESCE((l.payload->>'rows_overwritten')::int, 0) > 0
GROUP BY 1
ORDER BY products_overwritten_total DESC;
-- Cách kiểm RẺ NHẤT cho từng app (CHỈ ĐỌC, không ghi gì):
--   1. Export app đó (đọc live từ Google, KHÔNG ghi DB) ⇒ với từng SKU đã overwrite, so:
--      số vùng đang bán vs số entry của tier template đã dùng (vùng THÊM/BỎ);
--      vùng nào đang AVAILABLE mà team từng chủ động tắt (MỞ LẠI);
--      SKU nào đang ACTIVE mà lẽ ra inactive (BẬT LẠI);
--      listings còn đủ locale không (THAY).
--   2. Play Console, 1–2 SKU mỗi app: lịch sử thay đổi quanh last_overwrite_at; mục
--      "payment restrictions" / thuế của sản phẩm còn như cũ không (trường (5)).
--   ⚠ Mirror (iaps / iap_prices) KHÔNG dùng để kiểm được: nó chỉ phản ánh MỘT option
--     (buyOption đầu tiên), không phải option bị ghi (legacyCompatible).


-- @@ G1 — Mọi app: currency/language hiện tại, NGUỒN đoán, và cờ rủi ro
WITH full_sync AS (
  SELECT l.target_id AS app_id, COUNT(*) AS n_full_iap_refresh, MAX(l.created_at) AS last_full_iap_refresh
  FROM google_iap_mgmt.actions_log l
  WHERE l.action_type = 'IAPS_LIST_SYNC'
    AND COALESCE(l.payload->>'scope', '') <> 'single-item-price-sync'
  GROUP BY l.target_id
),
mirror AS (
  SELECT i.app_id,
    COUNT(*) AS n_items,
    COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM google_iap_mgmt.iap_prices p
                                   WHERE p.iap_id = i.id AND p.region_code = 'US')) AS items_with_us_price,
    COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM google_iap_mgmt.iap_listings li
                                   WHERE li.iap_id = i.id AND li.locale = 'en-US')) AS items_with_en_us_listing,
    COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM google_iap_mgmt.iap_listings li
                                       WHERE li.iap_id = i.id)) AS items_without_listing,
    MODE() WITHIN GROUP (ORDER BY i.default_currency) AS dominant_item_currency
  FROM google_iap_mgmt.iaps i
  GROUP BY i.app_id
)
SELECT a.package_name, a.display_name, acc.display_name AS account_name,
  a.default_currency, a.default_language,
  COALESCE(fs.n_full_iap_refresh, 0) AS n_full_iap_refresh, fs.last_full_iap_refresh,
  COALESCE(m.n_items, 0) AS mirror_items, m.items_with_us_price, m.items_with_en_us_listing,
  m.items_without_listing, m.dominant_item_currency,
  CASE WHEN fs.app_id IS NULL
       THEN 'ĐOÁN (a): currency đoán từ language; language từ Play Console'
       ELSE 'ĐOÁN (b): cả hai theo sản phẩm đầu ở lần Refresh IAP cuối' END AS nguon,
  CONCAT_WS(' · ',
    CASE WHEN a.default_currency IS NULL THEN 'currency TRỐNG' END,
    CASE WHEN a.default_currency IS NOT NULL AND a.default_currency <> 'USD' THEN 'currency ≠ USD' END,
    CASE WHEN fs.app_id IS NOT NULL AND COALESCE(m.items_with_us_price, 0) = 0 AND COALESCE(m.n_items, 0) > 0
         THEN 'KHÔNG bán ở US ⇒ currency = vùng đầu tiên (ngẫu nhiên)' END,
    CASE WHEN fs.app_id IS NOT NULL AND a.default_currency = 'USD' AND a.default_language NOT LIKE 'en%'
         THEN 'USD do quy tắc "vùng US" trên app không-tiếng-Anh' END,
    CASE WHEN fs.app_id IS NOT NULL AND a.default_language = 'en-US' AND COALESCE(m.items_with_en_us_listing, 0) = 0
         THEN 'en-US có thể BỊA (không item nào có listing en-US)' END,
    CASE WHEN m.dominant_item_currency IS NOT NULL AND m.dominant_item_currency <> a.default_currency
         THEN 'currency app ≠ currency phổ biến của mirror' END
  ) AS co_rui_ro,
  CASE
    WHEN a.default_currency IS NULL THEN 'CAO'
    WHEN fs.app_id IS NULL AND a.default_currency <> 'USD' THEN 'CAO'   -- đoán từ ngôn ngữ
    WHEN fs.app_id IS NOT NULL AND COALESCE(m.items_with_us_price, 0) = 0 AND COALESCE(m.n_items, 0) > 0 THEN 'CAO'
    WHEN fs.app_id IS NOT NULL AND a.default_currency = 'USD' AND a.default_language NOT LIKE 'en%' THEN 'TRUNG BÌNH'
    ELSE 'THẤP (vẫn là đoán)'
  END AS muc_rui_ro
FROM google_iap_mgmt.apps a
JOIN google_iap_mgmt.google_console_accounts acc ON acc.id = a.google_console_account_id
LEFT JOIN full_sync fs ON fs.app_id = a.id
LEFT JOIN mirror m ON m.app_id = a.id
ORDER BY CASE
    WHEN a.default_currency IS NULL THEN 0
    WHEN fs.app_id IS NULL AND a.default_currency <> 'USD' THEN 0
    WHEN fs.app_id IS NOT NULL AND COALESCE(m.items_with_us_price, 0) = 0 AND COALESCE(m.n_items, 0) > 0 THEN 0
    WHEN fs.app_id IS NOT NULL AND a.default_currency = 'USD' AND a.default_language NOT LIKE 'en%' THEN 1
    ELSE 2 END,
  a.package_name;
-- Đọc: muc_rui_ro + co_rui_ro. Manager đối chiếu với currency app THẬT SỰ dùng (Manager
--   biết; Google v3 không trả). Ví dụ đã xác nhận: com.vnggames.ballisticherotwid dùng USD
--   — giá trị TWD lúc 03:21 là đoán sai (a), USD sau 03:25 là đúng NHỜ MAY (b).
--   ⚠ Một app "THẤP" vẫn là giá trị đoán; D9 sẽ cần Manager khai cho MỌI app.
--   (2026-10-19, H4: currency của app KHÔNG còn tham gia định giá bulk import — khai currency không
--    còn là bước cần trước bulk import; nó chỉ còn tác động ở form tạo/sửa đơn lẻ (giá điền sẵn) và
--    các fallback legacy đơn lẻ.)
