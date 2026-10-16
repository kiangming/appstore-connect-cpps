-- ============================================================
-- H2.3 — Lưu bản chụp mirror của com.vnggames.ballisticherotwid (彈彈英雄)
--   SAU lượt Overwrite 54de7054 (2026-10-16 ≈07:25 UTC). CHỈ ĐỌC.
-- ⚠ CHỈ ĐỌC. Không câu nào ghi DB, không câu nào đổi schema. Chạy TỪNG khối @@ một
--   trong Supabase SQL Editor (Editor chỉ hiện kết quả của câu cuối nếu chạy nhiều câu một lúc).
--
-- THỨ TỰ CHẠY: S0a → S0b → S0c → S1 → S2 → S3 → S4, TẤT CẢ TRƯỚC KHI chạy migration
--   20261016010000 (C2) — tối thiểu phải có S0a và S4 trước C2. Lý do: C2 cập nhật mọi
--   hàng apps có currency/language (gán *_source = 'guessed') ⇒ trigger set_updated_at ghi
--   đè apps.updated_at bằng giờ chạy migration, mất dấu "hàng app ghi lần cuối lúc nào".
--   Backfill 20261016020000 (nếu được deploy) cũng ghi vào apps ⇒ cùng hệ quả.
--   C1 (20261016000000) chỉ thêm cột, không ghi hàng nào.
-- ⚠ Chạy được trên schema prod HIỆN TẠI (chưa có C1/C2) lẫn sau khi C1/C2 chạy: không câu
--   nào gọi tên cột iaps_last_synced_at / *_source; cột mới (nếu có) hiện qua to_jsonb(...).
--
-- LƯU GÌ: kết quả S0a, S0b, S0c, S1 (Download CSV từng khối); S2 + S3 (Download CSV — có thể
--   vượt giới hạn hiển thị của Editor); ô JSON của S4 → ballisticherotwid-mirror-<giờ UTC>.json.
--
-- BẢN CHỤP NÀY LÀ GÌ — nói thẳng:
--   Theo code, lúc ≈07:25 batch 54de7054 đã XOÁ rồi CHÈN LẠI listings + prices của từng SKU
--   (bulk-import.ts:1183-1199 → syncIapFromGoogle, iaps.ts:242-300). Bản mirror lúc 03:25
--   KHÔNG còn trong DB. File này lưu trạng thái SAU Overwrite + dấu vết của batch (hàng batch,
--   actions_log, timestamp từng hàng) — nó KHÔNG phục hồi được cấu hình trước Overwrite.
--   Cấu hình trước Overwrite chỉ có thể còn NGOÀI DB:
--     (1) Supabase backup / PITR — chỉ khôi phục RA một project/DB riêng để đọc; TUYỆT ĐỐI
--         không khôi phục đè lên DB đang chạy (mất mọi thứ ghi sau mốc khôi phục).
--     (2) File Export xlsx của app này đã tải trong khoảng 03:25–07:24 UTC (Export đọc live
--         từ Google ⇒ là cấu hình Google lúc đó).
--     (3) Railway logs 2026-10-16 07:24–07:27 UTC — lưu mọi dòng chứa:
--           'batch upsert fallback'     (onetimeproducts.batchUpdate lỗi ⇒ ghi bằng API cũ
--                                        method=inappproducts.batchUpdate)
--           'batch state apply failed'  (lệnh đặt state/ACTIVATE thất bại)
--           'cache_sync_failed'         (Google đã nhận nhưng mirror không ghi được)
--           'final_body sku='           (giá VN trong body gửi Google; chỉ có khi nguồn là template)
--           method=monetization.onetimeproducts.get
--           method=monetization.onetimeproducts.batchUpdate
--           method=monetization.onetimeproducts.purchaseOptions.batchUpdateStates
--         — các dòng method=… lọc theo pkg=com.vnggames.ballisticherotwid.
--
-- Mọi thời điểm in ra là CHUỖI giờ UTC 'YYYY-MM-DD HH24:MI:SS.MS' (to_char(… AT TIME ZONE 'UTC')),
--   không phụ thuộc múi giờ của phiên SQL Editor.
--
-- Cửa sổ "batch 54de7054" = [import_batches.created_at − 5 s ; executed_at + 2 phút].
--   created_at do DB đặt lúc tạo batch (DEFAULT NOW(), init.sql:225); executed_at do
--   code đặt SAU vòng ghi mirror (bulk-import.ts:1202-1212). Mọi hàng mirror mà batch
--   ghi đều rơi vào cửa sổ này. −5 s / +2 phút là biên cho lệch đồng hồ app↔DB
--   (last_synced_at là đồng hồ app; updated_at/created_at là đồng hồ DB).
-- ============================================================


-- @@ S0a — Hàng app mang package này (MỌI account) — ghi lại app_id + account
SELECT a.id                                   AS app_id,
       a.google_console_account_id            AS account_id,
       c.display_name                         AS account_name,
       c.status                               AS account_status,
       a.display_name                         AS app_name,
       (SELECT count(*) FROM google_iap_mgmt.iaps i WHERE i.app_id = a.id) AS n_iaps,
       a.default_currency,
       a.default_language,
       to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')    AS created_at_utc,
       to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')    AS updated_at_utc,
       to_char(a.last_synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')    AS apps_list_synced_at_utc,
       to_jsonb(a)                            AS all_columns
FROM google_iap_mgmt.apps a
LEFT JOIN google_iap_mgmt.google_console_accounts c ON c.id = a.google_console_account_id
WHERE a.package_name = 'com.vnggames.ballisticherotwid'
ORDER BY a.created_at;
-- KỲ VỌNG: 1 hàng, n_iaps = 28. >1 hàng ⇒ package có dưới nhiều account; mọi khối
--   dưới đây đều in account_name — so theo account mà wizard đã dùng lúc 07:24.
--   updated_at_utc = lần cuối hàng app bị ghi (Refresh IAP ghi currency/language, Refresh
--   danh sách app…). Nếu nó trùng giờ chạy migration C2 ⇒ khối này chạy SAU C2, dấu vết đã mất.


-- @@ S0b — Các batch import hôm nay của app này (+ batch 54de7054 dù app_id đã bị SET NULL)
SELECT b.id, b.app_id, b.status, b.pricing_source, b.source_filename,
       b.rows_total, b.rows_success, b.rows_overwritten, b.rows_skipped, b.rows_failed,
       to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS created_at_utc,
       to_char(b.executed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS executed_at_utc
FROM google_iap_mgmt.import_batches b
WHERE b.id::text LIKE '54de7054%'
   OR (b.created_at >= TIMESTAMPTZ '2026-10-16 00:00:00+00'
       AND b.app_id IN (SELECT id FROM google_iap_mgmt.apps
                        WHERE package_name = 'com.vnggames.ballisticherotwid'))
ORDER BY b.created_at;
-- KỲ VỌNG: a14c2e4d… 03:21:51 FAILED; 54de7054… created ≈ 07:24:59, COMPLETE,
--   rows_success = 28, rows_overwritten = 28, rows_failed = 0.
--   rows_success = 28 ⇒ syncIapFromGoogle đã chạy KHÔNG lỗi cho cả 28 SKU
--   (bulk-import.ts:1190-1192 chỉ cộng đếm SAU khi sync xong).


-- @@ S0c — Dòng thời gian actions_log hôm nay chạm app này (ai/cái gì đã ghi mirror)
SELECT to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')   AS at_utc,
       l.action_type,
       l.actor_email,
       l.payload->>'scope'               AS scope,          -- 'single-item-price-sync' = nút Sync from Google
       l.payload->>'sku'                 AS sku,
       l.payload->>'batch_id'            AS batch_id,
       l.payload->>'total'               AS list_total,
       l.payload->>'synced'              AS synced,
       l.payload->>'failed'              AS failed,
       l.payload->>'rows_overwritten'    AS rows_overwritten,
       l.payload->>'rows_created'        AS rows_created,
       l.payload->>'rows_failed'         AS rows_failed,
       l.payload->>'flagged'             AS flagged
FROM google_iap_mgmt.actions_log l
WHERE l.created_at >= TIMESTAMPTZ '2026-10-16 00:00:00+00'
  AND (   l.target_id IN (SELECT id FROM google_iap_mgmt.apps
                          WHERE package_name = 'com.vnggames.ballisticherotwid')
       OR l.payload->>'package_name' = 'com.vnggames.ballisticherotwid'
       OR l.action_type = 'ACCOUNT_DELETE')
ORDER BY l.created_at;
-- KỲ VỌNG: BULK_IMPORT_BATCH ≈03:21:5x (failed) → IAPS_LIST_SYNC 03:25:10 total=28 →
--   BULK_IMPORT_BATCH ≈07:25 batch_id=54de7054… rows_overwritten=28 → KHÔNG GÌ KHÁC.
--   Có IAPS_LIST_SYNC / IAP_UPDATE / IAP_CREATE / BULK_ACTIVATE / BULK_DEACTIVATE /
--   IAP_ACKNOWLEDGE_REMOVE / ACCOUNT_DELETE (mọi account, hôm nay) ở bất kỳ thời điểm nào
--   khác ⇒ mirror bị ghi thêm lần nữa (trước hoặc sau batch) — báo lại.
--   ⚠ Vắng dòng ≠ chắc chắn không có lần ghi (appendAction nuốt lỗi ghi audit — KB §9 P2);
--   bằng chứng chính là timestamp ở S1-S3.


-- @@ S1 — MỖI SKU MỘT DÒNG: trạng thái + đếm + MỌI cột thời gian + phán quyết "bản nào"
WITH app AS (
  SELECT a.id, c.display_name AS account_name
  FROM google_iap_mgmt.apps a
  LEFT JOIN google_iap_mgmt.google_console_accounts c ON c.id = a.google_console_account_id
  WHERE a.package_name = 'com.vnggames.ballisticherotwid'
), win AS (
  SELECT min(b.created_at) - interval '5 seconds'                         AS w_start,
         max(coalesce(b.executed_at, b.created_at)) + interval '2 minutes' AS w_end,
         min(b.app_id::text)                                               AS batch_app_id
  FROM google_iap_mgmt.import_batches b
  WHERE b.id::text LIKE '54de7054%'
), p AS (
  SELECT iap_id, count(*) AS n, min(created_at) AS c_min, max(created_at) AS c_max,
         max(updated_at) AS u_max
  FROM google_iap_mgmt.iap_prices GROUP BY iap_id
), l AS (
  SELECT iap_id, count(*) AS n, string_agg(locale, ',' ORDER BY locale) AS locales,
         min(created_at) AS c_min, max(created_at) AS c_max, max(updated_at) AS u_max
  FROM google_iap_mgmt.iap_listings GROUP BY iap_id
), s AS (
  SELECT app.account_name, i.*,
         coalesce(p.n, 0) AS n_price_regions, p.c_min AS p_c_min, p.c_max AS p_c_max, p.u_max AS p_u_max,
         coalesce(l.n, 0) AS n_listings, l.locales, l.c_min AS l_c_min, l.c_max AS l_c_max, l.u_max AS l_u_max,
         win.w_start, win.w_end, win.batch_app_id,
         greatest(i.updated_at, p.u_max, l.u_max) AS last_write
  FROM google_iap_mgmt.iaps i
  JOIN app ON app.id = i.app_id
  CROSS JOIN win
  LEFT JOIN p ON p.iap_id = i.id
  LEFT JOIN l ON l.iap_id = i.id
)
SELECT account_name, sku, status, purchase_type, to_char(deleted_on_google_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS deleted_on_google_at_utc,
       default_currency, default_price_micros,
       n_price_regions, n_listings, locales,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS iap_created_utc,
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS iap_updated_utc,
       to_char(last_synced_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS iap_last_synced_utc,
       to_char(p_c_min AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS prices_created_min_utc,
       to_char(p_c_max AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS prices_created_max_utc,
       to_char(p_u_max AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS prices_updated_max_utc,
       to_char(l_c_min AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS listings_created_min_utc,
       to_char(l_c_max AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS listings_created_max_utc,
       to_char(l_u_max AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS listings_updated_max_utc,
       CASE
         WHEN w_start IS NULL THEN 'batch 54de7054 KHÔNG tìm thấy — xem S0b'
         WHEN batch_app_id IS NOT NULL AND app_id::text <> batch_app_id
              THEN 'hàng app KHÁC (account khác) — batch 54de7054 không ghi vào đây'
         WHEN last_write <  w_start THEN 'TRƯỚC batch 54de7054 — xem iap_updated_utc / created_utc'
         WHEN last_write >  w_end   THEN 'BỊ GHI LẠI SAU batch — tìm ai ở S0c'
         WHEN coalesce(least(p_c_min, l_c_min), updated_at) >= w_start AND updated_at >= w_start
              THEN 'GHI LẠI BỞI batch 54de7054 (bản sau Overwrite)'
         ELSE 'LẪN LỘN — báo lại'
       END AS verdict
FROM s
ORDER BY account_name, sku;
-- KỲ VỌNG (theo code đã đo, nếu không ai bấm gì sau 07:25):
--   28 dòng (1 account). verdict = 'GHI LẠI BỞI batch 54de7054 (bản sau Overwrite)' cho CẢ 28:
--   iap_created_utc ≈ 03:25:01 (giữ từ lần Refresh — upsert không đụng created_at),
--   iap_updated_utc + iap_last_synced_utc + MỌI prices_*/listings_* ∈ cửa sổ batch (~07:25)
--   — vì syncIapFromGoogle XOÁ HẾT rồi CHÈN LẠI listings + prices (iaps.ts:242-300).
--   n_listings = locale trong file Excel (+ en-US nếu file thiếu — bulk-import.ts:221-226).
--
--   ⚠ MIRROR GIỮ PURCHASE OPTION NÀO — đọc trước khi so giá/status:
--     status, default_currency, default_price_micros và mọi dòng giá (S2) là của purchase
--     option có buyOption ĐẦU TIÊN trong phản hồi Google (onetime-product-adapter.ts:108-115);
--     còn Overwrite ghi vào option legacyCompatible (onetime-product-adapter.ts:313-323).
--     Hai cái chỉ là một khi option legacy đứng đầu. Phân biệt bằng Σ n_price_regions (28 SKU):
--       Σ ≈ 174 (≈ 6 vùng/SKU — con số lúc 03:25) ⇒ giá/status đang lưu là của option mà
--         Overwrite KHÔNG đụng: giá có thể y hệt 03:25, và …0.99 có thể vẫn đọc 'inactive'
--         dù option 'legacy' đã được ACTIVATE. Không suy ra "Overwrite không ghi gì" từ đây.
--       Σ ≈ 28 × (số vùng bootstrap/template) ⇒ đúng là option đích; giá 03:25 đã mất khỏi DB.
--         Khi đó …0.99 = 'active' (Overwrite ACTIVATE option đích — bulk-import.ts:260,
--         publisher-client.ts:1176-1233); 'inactive' chỉ khi lệnh state thất bại
--         ('batch state apply failed' trong Railway log).
--     Listings thì LUÔN là bản mới (cấp sản phẩm, không theo option; updateMask có 'listings'
--     ⇒ trên Google cũng đã bị thay).
--
--   verdict 'TRƯỚC batch 54de7054 — xem iap_updated_utc / created_utc' ⇒ batch KHÔNG ghi lại SKU
--     này (bị bỏ qua / thất bại / không có trong file) — trái với COMPLETE 28/28 ⇒ báo lại.
--     Nhãn này bắt MỌI lần ghi trước cửa sổ batch, không riêng bản 03:25. Đọc iap_updated_utc
--     (kèm prices_updated_max_utc, listings_updated_max_utc):
--       ≈ 03:25:0x (khớp IAPS_LIST_SYNC 03:25:10 ở S0c) ⇒ còn đúng bản 03:25 — lưu S2/S3/S4 NGAY;
--       muộn hơn 03:25 (vd 05:00) ⇒ có lần ghi khác trước batch (Sync from Google, Bulk
--         activate…) — tìm ở S0c; bản đang lưu là của lần ghi đó, KHÔNG phải 03:25.
--   'BỊ GHI LẠI SAU batch' ⇒ tìm ai ở S0c. 'LẪN LỘN' ⇒ một phần hàng con (listing/giá) không
--     thuộc batch (vd bước xoá listings/giá cũ lỗi mà code không kiểm) — báo lại.


-- @@ S2 — CHI TIẾT: một dòng cho mỗi SKU × vùng
--   ⚠ Mirror KHÔNG có cột availability / state theo vùng / purchase option id.
--     Một vùng có mặt ở đây = Google trả về một regional config CÓ giá cho purchase option
--     đầu tiên có buyOption (onetime-product-adapter.ts:108-115, :170-176) — kể cả vùng
--     không còn bán. Không suy ra "đang bán ở vùng X" từ bảng này.
WITH app AS (
  SELECT a.id, c.display_name AS account_name
  FROM google_iap_mgmt.apps a
  LEFT JOIN google_iap_mgmt.google_console_accounts c ON c.id = a.google_console_account_id
  WHERE a.package_name = 'com.vnggames.ballisticherotwid'
), win AS (
  SELECT min(b.created_at) - interval '5 seconds'                         AS w_start,
         max(coalesce(b.executed_at, b.created_at)) + interval '2 minutes' AS w_end,
         min(b.app_id::text)                                               AS batch_app_id
  FROM google_iap_mgmt.import_batches b
  WHERE b.id::text LIKE '54de7054%'
)
SELECT app.account_name, i.sku, i.status AS iap_status,
       p.region_code, p.currency, p.price_micros,
       (p.price_micros::numeric / 1000000) AS price_decimal,
       p.id AS price_row_id,
       to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS created_utc,
       to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS updated_utc,
       CASE WHEN win.w_start IS NULL THEN '?'
            WHEN win.batch_app_id IS NOT NULL AND i.app_id::text <> win.batch_app_id THEN 'app khác'
            WHEN p.updated_at < win.w_start THEN 'TRƯỚC batch'
            WHEN p.updated_at <= win.w_end  THEN 'batch 54de7054'
            ELSE 'SAU batch' END AS era
FROM google_iap_mgmt.iap_prices p
JOIN google_iap_mgmt.iaps i ON i.id = p.iap_id
JOIN app ON app.id = i.app_id
CROSS JOIN win
ORDER BY app.account_name, i.sku, p.region_code;
-- KỲ VỌNG: số dòng = tổng n_price_regions của S1. era = 'batch 54de7054' cho mọi dòng.
--   era 'TRƯỚC batch' = dòng giá ghi trước cửa sổ batch — đọc updated_utc: ≈ 03:25 ⇒ bản 03:25;
--   muộn hơn ⇒ một lần ghi khác trước batch (tìm ở S0c), không phải bản 03:25.
--   Giá ở đây là của option đầu tiên — xem khối "MIRROR GIỮ PURCHASE OPTION NÀO" ở S1.
--   ⚠ Supabase SQL Editor có thể giới hạn số dòng hiển thị — đối chiếu số dòng với S1;
--   thiếu thì tải CSV hoặc dùng S4 (một ô JSON).


-- @@ S3 — CHI TIẾT: một dòng cho mỗi SKU × locale
WITH app AS (
  SELECT a.id, c.display_name AS account_name
  FROM google_iap_mgmt.apps a
  LEFT JOIN google_iap_mgmt.google_console_accounts c ON c.id = a.google_console_account_id
  WHERE a.package_name = 'com.vnggames.ballisticherotwid'
), win AS (
  SELECT min(b.created_at) - interval '5 seconds'                         AS w_start,
         max(coalesce(b.executed_at, b.created_at)) + interval '2 minutes' AS w_end,
         min(b.app_id::text)                                               AS batch_app_id
  FROM google_iap_mgmt.import_batches b
  WHERE b.id::text LIKE '54de7054%'
)
SELECT app.account_name, i.sku, l.locale, l.title, l.description,
       length(l.description) AS description_len,
       l.id AS listing_row_id,
       to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS created_utc,
       to_char(l.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS updated_utc,
       CASE WHEN win.w_start IS NULL THEN '?'
            WHEN win.batch_app_id IS NOT NULL AND i.app_id::text <> win.batch_app_id THEN 'app khác'
            WHEN l.updated_at < win.w_start THEN 'TRƯỚC batch'
            WHEN l.updated_at <= win.w_end  THEN 'batch 54de7054'
            ELSE 'SAU batch' END AS era
FROM google_iap_mgmt.iap_listings l
JOIN google_iap_mgmt.iaps i ON i.id = l.iap_id
JOIN app ON app.id = i.app_id
CROSS JOIN win
ORDER BY app.account_name, i.sku, l.locale;
-- KỲ VỌNG: số dòng = tổng n_listings của S1; era = 'batch 54de7054' mọi dòng; locale = các
--   locale của file Excel 07:24 (+ en-US mang bản sao title/description của locale đầu tiên
--   nếu file không có en-US — bulk-import.ts:223-225). Bản 3 listing/SKU lúc 03:25 KHÔNG còn.
--   era 'TRƯỚC batch' = listing ghi trước cửa sổ batch — đọc updated_utc: ≈ 03:25 ⇒ bản 03:25
--   còn sót; muộn hơn ⇒ một lần ghi khác trước batch (tìm ở S0c).


-- @@ S4 — MỘT DÒNG MỘT Ô: toàn bộ (apps + batch + actions_log hôm nay + iaps kèm listings/prices)
--   Bấm vào ô kết quả → copy, lưu thành ballisticherotwid-mirror-<giờ chạy UTC>.json.
SELECT jsonb_build_object(
  'generated_at_utc', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'package_name', 'com.vnggames.ballisticherotwid',
  'note', 'Read-only copy of google_iap_mgmt mirror. Mirror holds ONE purchase option per product '
          '(first buyOption), no availability/state per region, no tax/purchase-limit/offer tags.',
  'apps', (SELECT coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object('account_display_name', c.display_name)
                                      ORDER BY a.created_at), '[]'::jsonb)
           FROM google_iap_mgmt.apps a
           LEFT JOIN google_iap_mgmt.google_console_accounts c ON c.id = a.google_console_account_id
           WHERE a.package_name = 'com.vnggames.ballisticherotwid'),
  'import_batches_today', (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.created_at), '[]'::jsonb)
           FROM google_iap_mgmt.import_batches b
           WHERE b.id::text LIKE '54de7054%'
              OR (b.created_at >= TIMESTAMPTZ '2026-10-16 00:00:00+00'
                  AND b.app_id IN (SELECT id FROM google_iap_mgmt.apps
                                   WHERE package_name = 'com.vnggames.ballisticherotwid'))),
  'actions_log_today', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.created_at), '[]'::jsonb)
           FROM google_iap_mgmt.actions_log l
           WHERE l.created_at >= TIMESTAMPTZ '2026-10-16 00:00:00+00'
             AND (   l.target_id IN (SELECT id FROM google_iap_mgmt.apps
                                     WHERE package_name = 'com.vnggames.ballisticherotwid')
                  OR l.payload->>'package_name' = 'com.vnggames.ballisticherotwid'
                  OR l.action_type = 'ACCOUNT_DELETE')),
  'counts', (SELECT jsonb_build_object(
               'iaps', count(DISTINCT i.id),
               'listings', (SELECT count(*) FROM google_iap_mgmt.iap_listings x
                            WHERE x.iap_id IN (SELECT i2.id FROM google_iap_mgmt.iaps i2
                                               JOIN google_iap_mgmt.apps a2 ON a2.id = i2.app_id
                                               WHERE a2.package_name = 'com.vnggames.ballisticherotwid')),
               'prices', (SELECT count(*) FROM google_iap_mgmt.iap_prices x
                          WHERE x.iap_id IN (SELECT i2.id FROM google_iap_mgmt.iaps i2
                                             JOIN google_iap_mgmt.apps a2 ON a2.id = i2.app_id
                                             WHERE a2.package_name = 'com.vnggames.ballisticherotwid')))
             FROM google_iap_mgmt.iaps i
             JOIN google_iap_mgmt.apps a ON a.id = i.app_id
             WHERE a.package_name = 'com.vnggames.ballisticherotwid'),
  'iaps', (SELECT coalesce(jsonb_agg(
             to_jsonb(i) || jsonb_build_object(
               'listings', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.locale), '[]'::jsonb)
                            FROM google_iap_mgmt.iap_listings l WHERE l.iap_id = i.id),
               'prices',   (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.region_code), '[]'::jsonb)
                            FROM google_iap_mgmt.iap_prices p WHERE p.iap_id = i.id))
             ORDER BY i.app_id, i.sku), '[]'::jsonb)
           FROM google_iap_mgmt.iaps i
           JOIN google_iap_mgmt.apps a ON a.id = i.app_id
           WHERE a.package_name = 'com.vnggames.ballisticherotwid')
) AS snapshot;
-- KỲ VỌNG: đúng 1 dòng. snapshot->'counts' = {iaps: tổng n_iaps của S0a (28 nếu chỉ 1 hàng app),
--   listings: = số dòng S3, prices: = số dòng S2}; số phần tử của 'actions_log_today' = số dòng
--   S0c (cùng bộ lọc, gồm cả ACCOUNT_DELETE). Đo trên PGlite: ≈4.400–4.600 dòng giá ⇒ ô ≈ 1,1 MB
--   (≈ 250 byte/dòng giá). Nếu ô bị cắt khi copy, dùng "Download CSV" rồi lấy cột snapshot;
--   đối chiếu counts trong file đã lưu với S1 trước khi coi là đủ.
