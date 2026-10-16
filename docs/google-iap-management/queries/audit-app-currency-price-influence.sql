-- ============================================================
-- H4.5 — Currency của APP (apps.default_currency) có chi phối giá mà các lượt Bulk import
--   CŨ đã ghi lên Google không? (arc-google-missing-purchase-options, 2026-10-16) — CHỈ ĐỌC.
-- ⚠ CHỈ ĐỌC: chỉ có SELECT. Supabase SQL Editor. Chạy TỪNG khối "-- @@" một (mỗi khối độc lập;
--   Editor chỉ hiện kết quả câu cuối nếu chạy nhiều câu một lúc).
-- Chạy được TRƯỚC hoặc SAU migration C1/C2: không câu nào gọi tên cột mới; cột mới (nếu có)
--   đọc qua to_jsonb(a) — trước C2 cột app_currency_source_now ra NULL.
--
-- THỨ TỰ CHẠY: H4-1 → H4-2 → H4-3 → H4-4 → HV-1. LƯU: "Download CSV" của từng khối.
--
-- DANH SÁCH APP (`want`, lặp lại ở đầu MỌI khối — sửa giống nhau ở mọi khối):
--   7 app: codmvn, lineagewvn, cookierun.oven.smash.vn, gdo.projectx5, tamquoc.chienky,
--          gs2.omg, ananta.vn
--   + mục 8 (tuỳ chọn) ballisticherotwid — batch 54de7054 (2026-10-16 07:24:59 UTC); Manager
--     giữ hoặc xoá NGUYÊN dòng `,('ballisticherotwid')` ở mọi khối.
--   Tên ngắn khớp theo "chứa" (ILIKE '%tên%'). Nếu H4-1 cho ≥ 2 hàng cho một tên: thay tên đó
--   bằng '=' + tên package ĐẦY ĐỦ (vd '=com.vnggames.ananta.vn') ⇒ khớp ĐÚNG tên đó
--   (ghi tên đầy đủ không có '=' vẫn khớp cả 'com.vnggames.ananta.vnx').
--
-- RUNBOOK NÀY QUYẾT ĐỊNH ĐƯỢC GÌ — VÀ KHÔNG:
--   ĐƯỢC: theo từng BATCH — batch nào chắc chắn bị currency app chi phối (A, B), batch nào
--     CÓ THỂ (A?, B?), batch nào không (theo các trường audit đã ghi).
--   KHÔNG: theo từng SKU. Audit chỉ log một phần dòng (per_row_diagnostic, xem H4-3); dòng
--     cross-currency đã resolve và dòng Google Conversion không custom KHÔNG có trong đó.
--   KHÔNG BAO GIỜ được lưu ⇒ không SQL nào trả lời được:
--     - chữ trên header cột giá của file ("Price" chung hay "Price (XXX)");
--     - priceHeaderSource ('explicit' | 'inferred') của từng dòng;
--     - currency của app LÚC batch chạy (app_currency_now là HÔM NAY; giá trị lúc chạy chỉ lọt
--       vào câu lý do của dòng bị từ chối — cột app_currency_at_run_from_refusals ở H4-2).
--     ⇒ hỏi actor xin lại file (source_filename) để quyết các ca A? / B?.
--   rows_failed GỒM cả dòng Google ĐÃ nhận nhưng ghi mirror lỗi (cache_sync_failed,
--     bulk-import.ts:1191-1204) ⇒ rows_success = 0 KHÔNG có nghĩa là Google không bị ghi.
--
-- MỐC CODE (UTC; deploy ≈ push — XẤP XỈ, batch trong vài giờ quanh mốc ⇒ coi era là CHƯA BIẾT):
--   E0  < 2026-05-21 06:52:06  parser sửa "Price (USD)" → USD; chưa đọc currency app.   [giờ commit]
--   E1  < 2026-06-01 10:56:26  wizard gửi baseCurrency := currency APP cho MỌI dòng       [giờ commit]
--                              (18840e1 … a54f9fe) — currency của file bị bỏ qua
--                              (chỉ khi apps.default_currency KHÁC NULL lúc đó).
--   E2  < 2026-08-08 10:44:18  "Price" chung → currency app; "Price (XXX)" ≠ currency app →
--                              cross-currency (entry template BẰNG currency app làm neo cho
--                              convertRegionPrices) hoặc bị từ chối (Google Conversion).
--   E3  ≥ 2026-08-08 10:44:18  E2 + custom price dưới Google Conversion (entry custom bằng    [giờ PUSH]
--                              currency app, nếu có, làm neo) — 31a0f15 (commit 05:07:22).
--   Custom dưới TEMPLATE (entry bằng currency app là BẮT BUỘC, và là defaultPrice + neo):    [giờ PUSH]
--                              từ ecfd7b8, push lần đầu 2026-08-07 17:13:14.
--   ⚠ E3 và mốc custom-dưới-template là giờ push lên origin/main (theo reflog). E0/E1 là giờ
--     commit: reflog chỉ bắt đầu từ 2026-06-29 nên KHÔNG kiểm được giờ push của chúng.
-- ============================================================


-- @@ H4-1 — Tên ngắn → hàng app (kỳ vọng đúng 1 hàng mỗi tên)
WITH want(short) AS (VALUES ('codmvn'),('lineagewvn'),('cookierun.oven.smash.vn'),
                            ('gdo.projectx5'),('tamquoc.chienky'),('gs2.omg'),('ananta.vn')
                            ,('ballisticherotwid')   -- mục 8 (tuỳ chọn): xoá NGUYÊN dòng này nếu không cần
)
SELECT w.short, a.id AS app_id, a.package_name, a.default_currency AS app_currency_now,
  to_jsonb(a)->>'default_currency_source' AS app_currency_source_now,
  (SELECT MODE() WITHIN GROUP (ORDER BY i.default_currency)
     FROM google_iap_mgmt.iaps i WHERE i.app_id = a.id) AS mirror_dominant_currency,
  (SELECT COUNT(*) FROM google_iap_mgmt.import_batches b WHERE b.app_id = a.id) AS n_batches,
  (SELECT COUNT(*) FROM google_iap_mgmt.actions_log l
    WHERE l.action_type = 'BULK_IMPORT_BATCH' AND l.target_id = a.id) AS n_import_audits
FROM want w
LEFT JOIN google_iap_mgmt.apps a
  ON (CASE WHEN w.short LIKE '=%' THEN a.package_name = substr(w.short, 2)
           ELSE a.package_name ILIKE '%' || w.short || '%' END)
ORDER BY w.short, a.package_name;
-- KỲ VỌNG: đúng 1 hàng cho mỗi tên. app_id NULL ⇒ tên không khớp app nào (sửa chính tả).
--   ≥ 2 hàng cho một tên ⇒ chọn đúng app rồi thay tên đó bằng '=<package đầy đủ>' ở MỌI khối.
--   ballisticherotwid có thể ra 2 hàng nếu package nằm dưới 2 account (xem H2.3 S0a).
--   app_currency_source_now: NULL trước C2; 'guessed' / 'declared' sau C2 — đều là HÔM NAY.


-- @@ H4-2 — Mọi batch của các app đó, phân loại theo CÁCH currency app có thể đã tác động
WITH want(short) AS (VALUES ('codmvn'),('lineagewvn'),('cookierun.oven.smash.vn'),
                            ('gdo.projectx5'),('tamquoc.chienky'),('gs2.omg'),('ananta.vn')
                            ,('ballisticherotwid')   -- mục 8 (tuỳ chọn): xoá NGUYÊN dòng này nếu không cần
),
cand AS (SELECT DISTINCT a.id, a.package_name, a.default_currency
           FROM google_iap_mgmt.apps a JOIN want w
             ON (CASE WHEN w.short LIKE '=%' THEN a.package_name = substr(w.short, 2)
                      ELSE a.package_name ILIKE '%' || w.short || '%' END)),
b AS (
  SELECT b.id AS batch_id, c.package_name, c.default_currency AS app_currency_now,
    b.created_at, b.status, b.pricing_source, b.source_filename,
    b.rows_total, b.rows_success, b.rows_overwritten, b.rows_skipped, b.rows_failed,
    l.payload, l.actor_email,
    CASE WHEN b.created_at < TIMESTAMPTZ '2026-05-21 06:52:06+00' THEN 'E0'
         WHEN b.created_at < TIMESTAMPTZ '2026-06-01 10:56:26+00' THEN 'E1'
         WHEN b.created_at < TIMESTAMPTZ '2026-08-08 10:44:18+00' THEN 'E2'
         ELSE 'E3' END AS era
  FROM google_iap_mgmt.import_batches b
  JOIN cand c ON c.id = b.app_id
  LEFT JOIN LATERAL (
    SELECT l.payload, l.actor_email FROM google_iap_mgmt.actions_log l
     WHERE l.action_type = 'BULK_IMPORT_BATCH' AND l.payload->>'batch_id' = b.id::text
     ORDER BY l.created_at DESC LIMIT 1) l ON true
),
x AS (
  SELECT b.*,
    COALESCE((payload->>'cross_currency_resolved')::int, 0) AS xc_resolved,
    COALESCE((payload->>'cross_currency_refused')::int, 0)  AS xc_refused,
    payload->>'cross_currency_by_explicit_header'          AS xc_by_explicit_header,
    payload->>'cross_currency_by_value_fallback'           AS xc_by_value_fallback,
    COALESCE((payload->>'custom_priced_rows')::int, 0)      AS custom_rows,
    jsonb_array_length(COALESCE(payload->'per_row_diagnostic', '[]'::jsonb)) AS n_rows_logged,
    (SELECT string_agg(DISTINCT e->>'base_currency', ',')
       FROM jsonb_array_elements(COALESCE(payload->'per_row_diagnostic', '[]'::jsonb)) e
      WHERE COALESCE(e->>'price_provenance', 'template') <> 'custom') AS logged_base_currencies,
    (SELECT string_agg(DISTINCT e->>'kind', ',')
       FROM jsonb_array_elements(COALESCE(payload->'refused_rows', '[]'::jsonb)) e) AS refused_kinds,
    -- currency app LÚC CHẠY chỉ được viết vào câu lý do của dòng bị từ chối
    (SELECT string_agg(DISTINCT COALESCE(
               substring(e->>'reason' from 'App currency (?:is )?([A-Z]{3})'),
               substring(e->>'reason' from 'has no ([A-Z]{3}) entry'),
               substring(e->>'reason' from 'carry no ([A-Z]{3}) entry')), ',')
       FROM jsonb_array_elements(COALESCE(payload->'refused_rows', '[]'::jsonb)) e) AS app_currency_at_run_from_refusals
  FROM b
)
SELECT created_at, package_name, batch_id, actor_email, era, status, pricing_source, source_filename,
  rows_total, rows_success, rows_overwritten, rows_failed,
  xc_resolved, xc_refused, xc_by_explicit_header, xc_by_value_fallback, custom_rows,
  n_rows_logged, logged_base_currencies, refused_kinds, app_currency_at_run_from_refusals, app_currency_now,
  CASE
    WHEN payload IS NULL THEN 'NO AUDIT ROW — cannot classify (CHƯA BIẾT)'
    WHEN COALESCE(rows_success, 0) = 0 AND COALESCE(rows_failed, 0) > COALESCE((payload->>'rows_refused')::int, 0)
      THEN 'NOTHING RECORDED AS WRITTEN — but rows_failed includes cache-sync failures of rows Google DID accept (bulk-import.ts:1191-1204): CHƯA BIẾT'
    WHEN COALESCE(rows_success, 0) = 0 THEN 'NOTHING WRITTEN (app currency could only have REFUSED rows)'
    WHEN era = 'E0' THEN 'NOT INFLUENCED (app currency not read yet)'
    WHEN era = 'E1' THEN 'A — every written row was priced IN THE APP CURRENCY (file header ignored)'
    WHEN pricing_source <> 'google_default' AND custom_rows > 0 AND created_at >= TIMESTAMPTZ '2026-08-07 17:13:14+00'
      THEN 'B — ' || custom_rows || ' custom row(s) under a TEMPLATE: defaultPrice + conversion anchor = the APP-currency custom entry (mandatory, bulk-import.ts:456-485)'
      || CASE WHEN xc_resolved > 0 THEN ' + ' || xc_resolved || ' cross-currency row(s)' ELSE '' END
    WHEN xc_resolved > 0 THEN 'B — ' || xc_resolved || ' row(s): defaultPrice = tier entry in APP currency; regions outside the tier converted from it'
    WHEN pricing_source <> 'google_default' AND COALESCE(logged_base_currencies, 'USD') <> 'USD'
      THEN 'B? — tier lookup + conversion anchor in ' || logged_base_currencies || ' (= app currency IF the header was generic "Price"; header not recorded)'
    WHEN pricing_source = 'google_default' AND era = 'E3' AND custom_rows > 0
      THEN 'B? — custom rows under Google Conversion: anchor = custom entry in app currency IF one was set (not recorded)'
    WHEN pricing_source = 'google_default'
      THEN 'A? — Google Conversion: rows priced in the header currency; = app currency IF header was generic "Price" (not recorded)'
    ELSE 'NOT INFLUENCED by the recorded fields (template rows logged in USD)'
  END AS app_currency_influence
FROM x
ORDER BY created_at;
-- KỲ VỌNG — mỗi dòng là MỘT BATCH (không phải một SKU). Đọc cột app_currency_influence:
--   A  = currency của file bị thay bằng currency app (sai mỗi khi hai cái khác nhau). Lớp A (E1)
--        CHỈ đúng nếu apps.default_currency KHÁC NULL lúc batch chạy — giá trị lúc đó KHÔNG được
--        ghi lại (app_currency_now là hôm nay) ⇒ đọc A là "A nếu app đã có currency lúc đó".
--   B  = currency app chọn neo cho mọi vùng mà tier template không phủ (~164/~173 vùng với
--        template 9 vùng) — và quyết định dòng nào bị từ chối. Gồm dòng cross-currency đã resolve,
--        và dòng custom dưới TEMPLATE (entry custom bằng currency app là bắt buộc + là neo).
--        Ở B, counter đã chứng minh app CÓ currency lúc chạy.
--   B? / A? = CÓ THỂ; dữ kiện quyết định (header chung hay "Price (XXX)"; custom có entry bằng
--        currency app hay không) KHÔNG được lưu ⇒ hỏi actor xin file (source_filename).
--   'NOTHING RECORDED AS WRITTEN … CHƯA BIẾT' = rows_success 0 nhưng rows_failed > rows_refused:
--        phần chênh có thể là dòng Google ĐÃ nhận mà mirror ghi lỗi.
--   'NOTHING WRITTEN' = mọi dòng hỏng đều là dòng bị từ chối ⇒ Google không bị ghi.
--   'NO AUDIT ROW' = batch không có dòng BULK_IMPORT_BATCH (appendAction nuốt lỗi — KB §9 P2).
--   era XẤP XỈ (deploy ≈ push): E3 = giờ PUSH 2026-08-08 10:44:18 (KHÔNG phải giờ commit 05:07:22);
--        mốc custom-dưới-TEMPLATE = ecfd7b8 push lần đầu 2026-08-07 17:13:14; E0/E1 = giờ commit,
--        không kiểm được qua reflog (bắt đầu 2026-06-29). Batch sát mốc ⇒ era CHƯA BIẾT.
--   app_currency_at_run_from_refusals = nguồn DUY NHẤT cho currency app lúc chạy (chỉ có khi
--        batch có dòng bị từ chối).


-- @@ H4-3 — Các dòng audit CÓ log (per_row_diagnostic): currency của file vs currency app
WITH want(short) AS (VALUES ('codmvn'),('lineagewvn'),('cookierun.oven.smash.vn'),
                            ('gdo.projectx5'),('tamquoc.chienky'),('gs2.omg'),('ananta.vn')
                            ,('ballisticherotwid')   -- mục 8 (tuỳ chọn): xoá NGUYÊN dòng này nếu không cần
),
cand AS (SELECT DISTINCT a.id, a.package_name, a.default_currency
           FROM google_iap_mgmt.apps a JOIN want w
             ON (CASE WHEN w.short LIKE '=%' THEN a.package_name = substr(w.short, 2)
                      ELSE a.package_name ILIKE '%' || w.short || '%' END))
SELECT l.created_at, c.package_name, l.payload->>'batch_id' AS batch_id,
  l.payload->>'pricing_source' AS pricing_source,
  e->>'sku' AS sku, e->>'base_currency' AS base_currency, e->>'base_price_decimal' AS base_price,
  e->>'selection_path' AS selection_path, e->>'selected_tier' AS selected_tier,
  e->>'match_strategy' AS match_strategy, COALESCE(e->>'price_provenance', 'template') AS provenance,
  e->>'vn_price_decimal' AS vn_price_applied,
  (l.payload->>'template_id_resolved') AS template_id_then,
  EXISTS (SELECT 1 FROM google_iap_mgmt.pricing_templates t
           WHERE t.id::text = l.payload->>'template_id_resolved') AS template_still_exists,
  -- mirror HÔM NAY của SKU đó (⚠ mirror chỉ có MỘT purchase option — chỉ để tham khảo)
  (SELECT p.currency || ' ' || p.price_micros FROM google_iap_mgmt.iaps i
     JOIN google_iap_mgmt.iap_prices p ON p.iap_id = i.id AND p.region_code = 'US'
    WHERE i.app_id = c.id AND i.sku = e->>'sku') AS mirror_us_now,
  (SELECT COUNT(*) FROM google_iap_mgmt.iaps i
     JOIN google_iap_mgmt.iap_prices p ON p.iap_id = i.id
    WHERE i.app_id = c.id AND i.sku = e->>'sku') AS mirror_regions_now,
  CASE
    WHEN COALESCE(e->>'price_provenance', 'template') = 'custom_refused'
      THEN 'refused — not written'
    WHEN COALESCE(e->>'price_provenance', 'template') = 'custom'
         AND COALESCE(l.payload->>'pricing_source', '') <> 'google_default'
      THEN 'custom under a TEMPLATE — defaultPrice + conversion anchor = the APP-currency custom entry (mandatory)'
    WHEN COALESCE(e->>'price_provenance', 'template') = 'custom'
      THEN 'custom under Google Conversion — anchor = app-currency custom entry if one was set, else the file price (not logged)'
    WHEN COALESCE(e->>'price_provenance', 'template') = 'auto_bootstrap' AND e->>'base_currency' <> 'USD'
      THEN 'no tier matched — every region converted from (' || (e->>'base_currency') || ', price) — app currency IF header generic'
    WHEN COALESCE(e->>'price_provenance', 'template') = 'template' AND e->>'base_currency' <> 'USD'
      THEN 'tier looked up by (' || (e->>'base_currency') || ', price) and converted from it — app currency IF header generic'
    ELSE 'USD file price — tier/anchor from file'
  END AS reading
FROM google_iap_mgmt.actions_log l
JOIN cand c ON c.id = l.target_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.payload->'per_row_diagnostic', '[]'::jsonb)) e
WHERE l.action_type = 'BULK_IMPORT_BATCH'
ORDER BY l.created_at, sku;
-- KỲ VỌNG: một dòng cho mỗi dòng Excel mà audit CÓ log:
--   - dòng template: khớp tier ('template') hoặc không khớp tier ⇒ convert toàn bộ ('auto_bootstrap');
--   - dòng custom ('custom' / 'custom_refused') dưới MỌI nguồn — kể cả Google Conversion
--     (pricing_source = 'google_default'): dòng custom dưới Google Conversion CÓ xuất hiện ở đây.
--   Đọc cột reading: 'refused — not written' = dòng bị từ chối, Google không nhận dòng này.
--     Custom dưới TEMPLATE: neo CHÍNH LÀ entry custom bằng currency app (chắc chắn, không phải "nếu").
--     Custom dưới Google Conversion: neo = entry custom bằng currency app NẾU có, không thì giá
--     của file — không log là trường hợp nào.
--   KHÔNG có ở đây: dòng cross-currency đã resolve (vòng template `continue` trước bước log —
--     bulk-import.ts:833; chỉ có counter xc_resolved ở H4-2) và dòng Google Conversion KHÔNG custom.
--     ⇒ một batch không có dòng nào ở đây ≠ batch không ghi gì.
--   mirror_us_now / mirror_regions_now = mirror HÔM NAY, một purchase option (buyOption đầu tiên)
--     — không phải giá lúc batch chạy. template_still_exists = false ⇒ template lúc đó đã bị
--     xoá/thay (vd M2 bỏ GLOBAL) — không dựng lại được tier đã dùng.


-- @@ H4-4 — App có batch B (cross-currency): SKU mirror nào mang NGUYÊN một tier template, bao
--           nhiêu vùng của nó do CONVERT mà ra (phụ thuộc neo)
WITH want(short) AS (VALUES ('codmvn'),('lineagewvn'),('cookierun.oven.smash.vn'),
                            ('gdo.projectx5'),('tamquoc.chienky'),('gs2.omg'),('ananta.vn')
                            ,('ballisticherotwid')   -- mục 8 (tuỳ chọn): xoá NGUYÊN dòng này nếu không cần
),
cand AS (SELECT DISTINCT a.id, a.package_name, a.google_console_account_id
           FROM google_iap_mgmt.apps a JOIN want w
             ON (CASE WHEN w.short LIKE '=%' THEN a.package_name = substr(w.short, 2)
                      ELSE a.package_name ILIKE '%' || w.short || '%' END)),
b_src AS (SELECT DISTINCT l.target_id AS app_id, l.payload->>'pricing_source' AS src
            FROM google_iap_mgmt.actions_log l
           WHERE l.action_type = 'BULK_IMPORT_BATCH'
             AND COALESCE((l.payload->>'cross_currency_resolved')::int, 0) > 0),
tpl AS (  -- template theo ĐÚNG nguồn của batch B: app_template ⇒ template APP; default_template ⇒ template ACCOUNT
  SELECT c.id AS app_id, bs.src, t.id AS template_id
  FROM cand c JOIN b_src bs ON bs.app_id = c.id
  JOIN google_iap_mgmt.pricing_templates t
    ON (bs.src = 'app_template' AND t.scope_type = 'APP' AND t.scope_app_id = c.id)
    OR (bs.src = 'default_template' AND t.scope_type = 'ACCOUNT'
        AND (to_jsonb(t)->>'scope_account_id') = c.google_console_account_id::text)
),
sku_tier AS (
  SELECT c.package_name, tpl.src, i.id AS iap_id, i.sku, e.identifier AS tier,
    COUNT(*) AS tier_regions,
    COUNT(*) FILTER (WHERE p.currency = e.currency AND p.price_micros = e.price_micros) AS tier_regions_equal
  FROM cand c
  JOIN tpl ON tpl.app_id = c.id
  JOIN google_iap_mgmt.iaps i ON i.app_id = c.id AND i.deleted_on_google_at IS NULL
  JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = tpl.template_id
  LEFT JOIN google_iap_mgmt.iap_prices p ON p.iap_id = i.id AND p.region_code = e.region_code
  GROUP BY c.package_name, tpl.src, i.id, i.sku, e.identifier
)
SELECT s.package_name, s.src AS template_source, s.sku, s.tier, s.tier_regions,
  (SELECT COUNT(*) FROM google_iap_mgmt.iap_prices p WHERE p.iap_id = s.iap_id) AS mirror_regions,
  (SELECT COUNT(*) FROM google_iap_mgmt.iap_prices p WHERE p.iap_id = s.iap_id) - s.tier_regions AS converted_regions
FROM sku_tier s
WHERE s.tier_regions_equal = s.tier_regions
ORDER BY s.package_name, s.sku, s.tier;
-- KỲ VỌNG: mỗi SKU ở đây mang NGUYÊN VẸN mọi entry của `tier` trong template mà batch B đã dùng
--   (template_source). converted_regions vùng còn lại do convertRegionPrices — neo trên entry tier
--   BẰNG CURRENCY APP nếu dòng đi qua cross-currency, trên giá USD của file nếu không. Dòng nào đi
--   đường nào: KHÔNG được ghi lại. Một SKU có thể hiện 2 lần nếu app có batch B ở cả hai nguồn.
--   0 dòng ⇒ không app nào trong danh sách có batch B cross-currency, hoặc không SKU nào còn khớp
--   nguyên một tier. ⚠ Dùng template HÔM NAY và mirror HÔM NAY (một purchase option) — chỉ để
--   tham khảo, không chứng minh giá lúc batch chạy.


-- @@ HV-1 — SKU trong mirror (hiện tại) có giá trông như con số bị đọc SAI currency
WITH want(short) AS (VALUES ('codmvn'),('lineagewvn'),('cookierun.oven.smash.vn'),
                            ('gdo.projectx5'),('tamquoc.chienky'),('gs2.omg'),('ananta.vn')
                            ,('ballisticherotwid')   -- mục 8 (tuỳ chọn): xoá NGUYÊN dòng này nếu không cần
),
cand AS (SELECT DISTINCT a.id, a.package_name, a.default_currency
           FROM google_iap_mgmt.apps a JOIN want w
             ON (CASE WHEN w.short LIKE '=%' THEN a.package_name = substr(w.short, 2)
                      ELSE a.package_name ILIKE '%' || w.short || '%' END))
SELECT c.package_name, c.default_currency AS app_currency_now, i.sku, i.last_synced_at,
       p.region_code, p.currency, (p.price_micros::numeric / 1000000) AS price,
       CASE
         WHEN p.region_code = 'US' AND p.currency <> 'USD' THEN 'US region not in USD'
         WHEN p.region_code = 'US' AND p.price_micros::numeric < 200000 THEN 'US price < 0.20 USD'
         WHEN p.region_code = 'US' AND p.price_micros::numeric > 1000000000 THEN 'US price > 1000 USD'
         WHEN p.region_code = 'VN' AND p.currency = 'VND' AND p.price_micros::numeric < 5000000000 THEN 'VN price < 5,000 VND'
         WHEN p.region_code = 'TW' AND p.currency = 'TWD' AND p.price_micros::numeric < 10000000 THEN 'TW price < 10 TWD'
       END AS suspicion
FROM cand c
JOIN google_iap_mgmt.iaps i ON i.app_id = c.id AND i.deleted_on_google_at IS NULL
JOIN google_iap_mgmt.iap_prices p ON p.iap_id = i.id
WHERE (p.region_code = 'US' AND (p.currency <> 'USD' OR p.price_micros::numeric < 200000 OR p.price_micros::numeric > 1000000000))
   OR (p.region_code = 'VN' AND p.currency = 'VND' AND p.price_micros::numeric < 5000000000)
   OR (p.region_code = 'TW' AND p.currency = 'TWD' AND p.price_micros::numeric < 10000000)
ORDER BY c.package_name, i.sku, p.region_code;
-- KỲ VỌNG: lý tưởng 0 dòng. Mỗi dòng = một giá trong mirror HÔM NAY trông như con số bị đọc sai
--   currency (vd 0.99 USD đọc thành 0.99 VND ⇒ 'VN price < 5,000 VND'; 25000 VND đọc thành USD
--   ⇒ 'US price > 1000 USD'; vùng US không tính bằng USD). Ngưỡng là thô — kiểm SKU đó trên Play
--   Console trước khi kết luận. ⚠ Mirror = buyOption đầu tiên, trạng thái hôm nay; khối này KHÔNG
--   nói batch nào gây ra — đối chiếu last_synced_at với các batch ở H4-2.
