-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — [ACCOUNT-default-template], hai chặng
--
--   M-1  supabase/migrations/20260828010000_iap_mgmt_account_templates_m1_additive.sql
--   M-2  supabase/migrations/20260828020000_iap_mgmt_account_templates_m2_drop_global.sql
--
-- THỨ TỰ:
--   1. apply M-1            → chạy M1-V0 (gộp) → M1-V2 (CỔNG) → M1-V1…V7
--                             → M1-V8 (smoke test tay trên code cũ)
--   2. DEPLOY CODE MỚI      → kiểm code chạy thật (tạo/sửa 1 IAP, xem giá)
--   3. apply M-2            → chạy M2-V1 … M2-V4
--
-- ⚠ Supabase SQL Editor chỉ hiện kết quả của câu lệnh CUỐI trong một script
--   nhiều lệnh. Vì vậy: chạy M1-V0 trước để có toàn cảnh trong một lần Run,
--   rồi chạy TỪNG query chi tiết MỘT LẦN MỘT khi cần xem lệch ở đâu.
--
-- Tất cả READ-ONLY (M2-V2b có INSERT nhưng nằm trong BEGIN…ROLLBACK).
-- Mỗi query có dòng "PASS khi:".
--
-- ⚠ KHÔNG hardcode N. Mọi phép so đọc từ:
--     public.asc_accounts                                 → N
--     iap_mgmt.price_tier_template_entries_backup_global  → số entry gốc
--
-- ⚠ M1-V2 LÀ CỔNG. Migration dùng cách B — 6 id nhúng tay, migration KHÔNG
--   tự đối chiếu được với public.asc_accounts (cái giá của việc không đọc
--   chéo schema). M1-V2 là chỗ DUY NHẤT phép đối chiếu đó xảy ra, và nó
--   phải pass TRƯỚC khi deploy code.
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  CHẶNG 1 — SAU KHI APPLY M-1, TRƯỚC KHI DEPLOY CODE                     ║
-- ║  Bất biến của chặng này: KHÔNG CÓ GÌ BỊ XOÁ. Code cũ phải chạy y nguyên.║
-- ╚═════════════════════════════════════════════════════════════════════════╝

-- ── M1-V0 — BẢNG KIỂM GỘP: MỘT query, MỘT dòng kết quả ────────────────────
--
-- ⚠ CHẠY QUERY NÀY TRƯỚC. Nó gộp toàn bộ M1-V1…V7 thành một dòng, mỗi kiểm
--   là một cột boolean, cộng ô kết luận `TAT_CA_PASS`.
--
-- Lý do tồn tại: Supabase SQL Editor chỉ hiện kết quả của câu lệnh CUỐI
-- trong một script nhiều lệnh. Dán 8 query rời rồi bấm Run một lần thì chỉ
-- thấy cái chót. Query này cho toàn cảnh trong một lần chạy.
--
-- • TAT_CA_PASS = true  → xong chặng 1, đi tiếp M1-V8 (smoke test tay).
-- • TAT_CA_PASS = false → xem cột nào false, rồi chạy query CHI TIẾT tương
--   ứng bên dưới (M1-V1…V7) để biết lệch ở đâu cụ thể.
--
-- (Khối này vốn nằm trong file dry-run; phương án C bỏ dry-run nhưng giữ
--  lại đúng phần này — nó là phần có giá trị của file đó.)
-- ───────────────────────────────────────────────────────────────────────────

WITH
n_acct AS (SELECT COUNT(*)::int AS c FROM public.asc_accounts WHERE is_active = true),
n_goc  AS (SELECT COUNT(*)::int AS c FROM iap_mgmt.price_tier_template_entries_backup_global),
n_tpl  AS (SELECT COUNT(*)::int AS c FROM iap_mgmt.price_tier_templates WHERE scope_type='ACCOUNT'),
n_glob AS (SELECT COUNT(*)::int AS c FROM iap_mgmt.price_tier_templates WHERE scope_type='GLOBAL'),
n_app  AS (SELECT COUNT(*)::int AS c FROM iap_mgmt.price_tier_templates WHERE scope_type='APP'),
n_ent  AS (
  SELECT COUNT(*)::int AS c
  FROM iap_mgmt.price_tier_template_entries e
  JOIN iap_mgmt.price_tier_templates t ON t.id = e.template_id
  WHERE t.scope_type = 'ACCOUNT'
),

-- M1-V2 (CỔNG): lệch giữa 6 id nhúng tay và public.asc_accounts, hai chiều.
v2 AS (
  SELECT COUNT(*)::int AS c FROM (
    SELECT a.id
    FROM public.asc_accounts a
    WHERE a.is_active = true
      AND NOT EXISTS (SELECT 1 FROM iap_mgmt.price_tier_templates t
                      WHERE t.scope_type='ACCOUNT' AND t.scope_account_id = a.id)
    UNION ALL
    SELECT t.scope_account_id
    FROM iap_mgmt.price_tier_templates t
    WHERE t.scope_type='ACCOUNT'
      AND NOT EXISTS (SELECT 1 FROM public.asc_accounts a WHERE a.id = t.scope_account_id)
  ) x
),

-- M1-V1b: template nhân bản có số entry KHÁC bản gốc (gồm cả ca 0 entry).
v1b AS (
  SELECT COUNT(*)::int AS c FROM (
    SELECT t.id
    FROM iap_mgmt.price_tier_templates t
    LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
    WHERE t.scope_type='ACCOUNT' AND t.origin_note IS NOT NULL
    GROUP BY t.id
    HAVING COUNT(e.tier_id) <> (SELECT c FROM n_goc)
  ) y
),

-- M1-V5: khác biệt NỘI DUNG từng ô so với ảnh chụp.
goc AS (
  SELECT tier_id, territory_code, currency_code, customer_price
  FROM iap_mgmt.price_tier_template_entries_backup_global
),
moi AS (
  SELECT t.scope_account_id, e.tier_id, e.territory_code, e.currency_code, e.customer_price
  FROM iap_mgmt.price_tier_templates t
  JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
  WHERE t.scope_type = 'ACCOUNT'
),
acct AS (SELECT DISTINCT scope_account_id FROM moi),
v5 AS (
  SELECT COUNT(*)::int AS c FROM (
    (SELECT m.* FROM moi m
     EXCEPT ALL
     SELECT a.scope_account_id, g.* FROM acct a CROSS JOIN goc g)
    UNION ALL
    (SELECT a.scope_account_id, g.* FROM acct a CROSS JOIN goc g
     EXCEPT ALL
     SELECT m.* FROM moi m)
  ) d
),

-- M1-V6: CHECK + index + cột mới.
chk AS (
  SELECT
    bool_or(conname='price_tier_templates_scope_type_check'
            AND pg_get_constraintdef(oid) LIKE '%ACCOUNT%')        AS type_co_account,
    bool_or(conname='price_tier_templates_scope_type_check'
            AND pg_get_constraintdef(oid) LIKE '%GLOBAL%')         AS type_van_con_global,
    bool_or(conname='price_tier_templates_scope_coherent_check'
            AND pg_get_constraintdef(oid) LIKE '%scope_account_id%') AS coherent_co_account
  FROM pg_constraint
  WHERE conrelid='iap_mgmt.price_tier_templates'::regclass AND contype='c'
),
idx AS (
  SELECT
    bool_or(indexname='idx_iap_mgmt_price_tier_templates_account_unique') AS co_index_account,
    bool_or(indexname='idx_iap_mgmt_price_tier_templates_global_unique')  AS con_index_global,
    bool_or(indexname='idx_iap_mgmt_price_tier_templates_app_unique')     AS con_index_app
  FROM pg_indexes
  WHERE schemaname='iap_mgmt' AND tablename='price_tier_templates'
),
cols AS (
  SELECT COUNT(*)::int AS c
  FROM information_schema.columns
  WHERE table_schema='iap_mgmt' AND table_name='price_tier_templates'
    AND column_name IN ('scope_account_id','origin_note')
),

-- M1-V7: 3 template APP không đụng (số lượng + tổng entry).
app_ent AS (
  SELECT COUNT(*)::int AS c
  FROM iap_mgmt.price_tier_template_entries e
  JOIN iap_mgmt.price_tier_templates t ON t.id = e.template_id
  WHERE t.scope_type = 'APP'
),
app_sys AS (
  SELECT COUNT(*)::int AS c
  FROM iap_mgmt.price_tier_templates
  WHERE scope_type='APP' AND uploaded_by='SYSTEM_MIGRATION'
)

SELECT
  -- ── các con số ─────────────────────────────────────────────────────────
  (SELECT c FROM n_acct)  AS n_account_active,
  (SELECT c FROM n_tpl)   AS n_template_account,
  (SELECT c FROM n_goc)   AS entry_ban_goc,
  (SELECT c FROM n_ent)   AS tong_entry_nhan_ban,
  (SELECT c FROM n_glob)  AS global_con_lai,
  (SELECT c FROM n_app)   AS so_template_app,
  (SELECT c FROM app_ent) AS tong_entry_app,

  -- ── các kiểm (mọi cột PASS phải = true) ────────────────────────────────
  ((SELECT c FROM n_tpl) = (SELECT c FROM n_acct))                    AS v1_du_template,
  ((SELECT c FROM v2) = 0)                                            AS v2_khop_asc_accounts,   -- ⚠ CỔNG
  ((SELECT c FROM n_glob) = 1)                                        AS v3_global_con_nguyen,
  ((SELECT c FROM n_ent) = (SELECT c FROM n_goc) * (SELECT c FROM n_acct))
                                                                      AS v4_tong_khop_phep_nhan,
  ((SELECT c FROM v1b) = 0)                                           AS v4b_moi_ban_du_entry,
  ((SELECT c FROM v5) = 0)                                            AS v5_noi_dung_giong_het,
  (SELECT type_co_account   FROM chk)                                 AS v6_check_co_account,
  (SELECT type_van_con_global FROM chk)                               AS v6_check_van_con_global,
  (SELECT coherent_co_account FROM chk)                               AS v6_coherent_co_account,
  (SELECT co_index_account  FROM idx)                                 AS v6_co_index_account,
  (SELECT con_index_global  FROM idx)                                 AS v6_con_index_global,
  (SELECT con_index_app     FROM idx)                                 AS v6_con_index_app,
  ((SELECT c FROM cols) = 2)                                          AS v6_du_2_cot_moi,
  ((SELECT c FROM app_sys) = 0)                                       AS v7_app_khong_bi_ghi_de,

  -- ── kết luận một ô ─────────────────────────────────────────────────────
  (     (SELECT c FROM n_tpl) = (SELECT c FROM n_acct)
    AND (SELECT c FROM v2)  = 0
    AND (SELECT c FROM n_glob) = 1
    AND (SELECT c FROM n_ent) = (SELECT c FROM n_goc) * (SELECT c FROM n_acct)
    AND (SELECT c FROM v1b) = 0
    AND (SELECT c FROM v5)  = 0
    AND (SELECT type_co_account     FROM chk)
    AND (SELECT type_van_con_global FROM chk)
    AND (SELECT coherent_co_account FROM chk)
    AND (SELECT co_index_account FROM idx)
    AND (SELECT con_index_global FROM idx)
    AND (SELECT con_index_app    FROM idx)
    AND (SELECT c FROM cols) = 2
    AND (SELECT c FROM app_sys) = 0
  )                                                                   AS TAT_CA_PASS;

-- ── ĐỌC KẾT QUẢ ────────────────────────────────────────────────────────────
-- TAT_CA_PASS = true  → M-1 đã chạy đúng. Đi tiếp M1-V8 (smoke test tay),
--                       rồi sang phần code.
-- TAT_CA_PASS = false → xem cột nào false:
--   v2_khop_asc_accounts   = false ⚠ CỔNG — 6 id nhúng tay lệch với
--                            public.asc_accounts. Chạy M1-V2 bản đầy đủ để
--                            xem lệch ai, rồi:
--                              1) DELETE FROM iap_mgmt.price_tier_templates
--                                  WHERE scope_type='ACCOUNT'
--                                    AND origin_note IS NOT NULL;
--                              2) sửa mảng v_accounts trong file M-1
--                                 (supabase/migrations/20260828010000_iap_mgmt_
--                                  account_templates_m1_additive.sql, khối
--                                  DECLARE ở BƯỚC 4);
--                              3) chạy lại file M-1.
--                            KHÔNG deploy code khi cột này còn false.
--   v3_global_con_nguyen   = false → M-1 đã xoá/làm mất dòng GLOBAL. Đây là
--                            việc của M-2, không phải M-1. Báo lại ngay.
--   v5_noi_dung_giong_het  = false → bản sao khác bản gốc về GIÁ, không chỉ
--                            số lượng. Chạy M1-V5 bản đầy đủ để xem ô nào.
--   v6_check_van_con_global= false → CHECK đã bị thu hẹp sớm ⇒ code cũ sẽ gãy
--                            khi ghi GLOBAL. Đây là dấu hiệu M-2 đã chạy nhầm.
--   v6_con_index_app       = false → đã đụng vào index của 3 template APP.
--   v7_app_khong_bi_ghi_de = false → có template APP mang uploaded_by
--                            'SYSTEM_MIGRATION' ⇒ M-1 đã ghi nhầm sang scope APP.
--
-- Guard bên trong M-1 vốn đã RAISE EXCEPTION ở phần lớn các ca trên (và khi
-- đó cả transaction tự rollback, không cần chạy tới đây). Bảng này bắt phần
-- còn lại — những thứ đúng về số lượng nhưng sai về nội dung/cấu trúc.


-- ── M1-V1 — đúng N template ACCOUNT, N đọc từ bảng account ──────────────────
SELECT
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_templates WHERE scope_type='ACCOUNT')
    AS n_template_account,
  (SELECT COUNT(*) FROM public.asc_accounts WHERE is_active = true)
    AS n_account_active,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_templates WHERE scope_type='ACCOUNT')
  = (SELECT COUNT(*) FROM public.asc_accounts WHERE is_active = true) AS pass;

-- PASS khi: pass = true.

-- M1-V1b — từng template: account, số entry, metadata §3.4.
SELECT
  t.scope_account_id,
  t.uploaded_by,
  t.uploaded_at,
  t.source_filename,
  (t.origin_note IS NOT NULL)      AS co_dau_vet_nhan_ban,
  COUNT(e.tier_id)                 AS entry_count,
  COUNT(DISTINCT e.tier_id)        AS tier_count,
  COUNT(DISTINCT e.territory_code) AS territory_count
FROM iap_mgmt.price_tier_templates t
LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'ACCOUNT'
GROUP BY t.scope_account_id, t.uploaded_by, t.uploaded_at, t.source_filename, t.origin_note
ORDER BY t.scope_account_id;

-- PASS khi: N dòng · uploaded_by='SYSTEM_MIGRATION' ở TẤT CẢ ·
--   co_dau_vet_nhan_ban = true ở tất cả · entry_count giống nhau và bằng
--   1140 · tier_count=95 · territory_count=12 ·
--   KHÔNG dòng nào entry_count=0  ← ca "header có, entry rỗng".


-- ── M1-V2 — ⚠ CỔNG. Đối chiếu 6 id nhúng tay với bảng account, CẢ HAI CHIỀU.
--    Soft-ref nên không FK nào làm việc này giúp.
SELECT 'account THẬT nhưng THIẾU template' AS van_de, a.id AS gia_tri, a.name
FROM public.asc_accounts a
WHERE a.is_active = true
  AND NOT EXISTS (SELECT 1 FROM iap_mgmt.price_tier_templates t
                  WHERE t.scope_type='ACCOUNT' AND t.scope_account_id = a.id)
UNION ALL
SELECT 'template trỏ tới account KHÔNG TỒN TẠI', t.scope_account_id, NULL
FROM iap_mgmt.price_tier_templates t
WHERE t.scope_type='ACCOUNT'
  AND NOT EXISTS (SELECT 1 FROM public.asc_accounts a WHERE a.id = t.scope_account_id)
UNION ALL
SELECT 'template thuộc account ĐÃ TẮT (is_active=false)', t.scope_account_id, a.name
FROM iap_mgmt.price_tier_templates t
JOIN public.asc_accounts a ON a.id = t.scope_account_id
WHERE t.scope_type='ACCOUNT' AND a.is_active = false;

-- PASS khi: 0 dòng.
--   loại 1 = danh sách nhúng thiếu account.
--   loại 2 = id gõ sai → template mồ côi, KHÔNG BAO GIỜ được đọc.
--   loại 3 = không sai, chỉ là account tắt sau khi apply.
-- ⚠ Bất kỳ dòng nào cũng CHẶN bước deploy. Sửa rồi verify lại.


-- ── M1-V3 — ⚠ GLOBAL PHẢI CÒN NGUYÊN. Đây là bất biến của cả chặng 1.
SELECT
  COUNT(*) FILTER (WHERE scope_type='GLOBAL')  AS global_con_lai,
  COUNT(*) FILTER (WHERE scope_type='ACCOUNT') AS so_account,
  COUNT(*) FILTER (WHERE scope_type='APP')     AS so_app,
  COUNT(*)                                     AS tong
FROM iap_mgmt.price_tier_templates;

-- PASS khi: global_con_lai = 1 · so_account = N · so_app = 3 (theo V0e) ·
--   tong = N + 4.
-- ⚠ global_con_lai KHÁC 1 là gãy production NGAY: code cũ đọc nhánh GLOBAL
--   bằng .maybeSingle() (templates.ts:103) — 0 dòng thì Default Template
--   biến mất khỏi UI, >1 dòng thì PGRST116 làm throw cả trang.

-- M1-V3b — nội dung dòng GLOBAL không đổi (so với V0d đã chụp).
SELECT t.id, t.uploaded_at, t.uploaded_by, t.source_filename,
       COUNT(e.tier_id) AS entry_count
FROM iap_mgmt.price_tier_templates t
LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'GLOBAL'
GROUP BY t.id, t.uploaded_at, t.uploaded_by, t.source_filename;

-- PASS khi: y hệt V0d — id 3cbdeaa2… · 1140 entry · uploaded_by/at không đổi.


-- ── M1-V4 — tổng entry khớp phép nhân, cả hai vế ĐỌC TỪ DỮ LIỆU ────────────
SELECT
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries e
     JOIN iap_mgmt.price_tier_templates t ON t.id=e.template_id
    WHERE t.scope_type='ACCOUNT')                                    AS tong_entry_moi,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries_backup_global)
                                                                     AS entry_goc,
  (SELECT COUNT(*) FROM public.asc_accounts WHERE is_active=true)    AS n,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries e
     JOIN iap_mgmt.price_tier_templates t ON t.id=e.template_id
    WHERE t.scope_type='ACCOUNT')
  = (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries_backup_global)
  * (SELECT COUNT(*) FROM public.asc_accounts WHERE is_active=true)  AS pass;

-- PASS khi: pass = true. Số hiện tại: 6 × 1140 = 6840.


-- ── M1-V5 — NỘI DUNG có thật sự giống bản gốc không (không chỉ đếm) ────────
--    So từng ô của MỖI template ACCOUNT với ảnh chụp — bắt thiếu, thừa, sai giá.
--    ⚠ Mỗi vế bọc ngoặc riêng: set operator kết hợp trái sang phải, không
--      bọc là ra kết quả khác hẳn.
WITH goc AS (
  SELECT tier_id, territory_code, currency_code, customer_price
  FROM iap_mgmt.price_tier_template_entries_backup_global
),
moi AS (
  SELECT t.scope_account_id, e.tier_id, e.territory_code, e.currency_code, e.customer_price
  FROM iap_mgmt.price_tier_templates t
  JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
  WHERE t.scope_type = 'ACCOUNT'
),
acct AS (SELECT DISTINCT scope_account_id FROM moi)
SELECT * FROM (
  (
    SELECT m.scope_account_id, m.tier_id, m.territory_code, m.currency_code,
           m.customer_price, 'THUA_o_ban_moi' AS van_de
    FROM moi m
    EXCEPT ALL
    SELECT a.scope_account_id, g.tier_id, g.territory_code, g.currency_code,
           g.customer_price, 'THUA_o_ban_moi'
    FROM acct a CROSS JOIN goc g
  )
  UNION ALL
  (
    SELECT a.scope_account_id, g.tier_id, g.territory_code, g.currency_code,
           g.customer_price, 'THIEU_o_ban_moi' AS van_de
    FROM acct a CROSS JOIN goc g
    EXCEPT ALL
    SELECT m.scope_account_id, m.tier_id, m.territory_code, m.currency_code,
           m.customer_price, 'THIEU_o_ban_moi'
    FROM moi m
  )
) diff
ORDER BY scope_account_id, tier_id, territory_code;

-- PASS khi: 0 dòng. Một ô SAI GIÁ hiện thành HAI dòng cùng (tier,territory)
--   — THỪA giá mới + THIẾU giá cũ; khác với thiếu/thừa thuần tuý (một dòng).


-- ── M1-V6 — CHECK đã nới, index đã thêm, KHÔNG CÁI NÀO BỊ GỠ ──────────────
SELECT conname, pg_get_constraintdef(oid) AS dinh_nghia
FROM pg_constraint
WHERE conrelid='iap_mgmt.price_tier_templates'::regclass AND contype='c'
ORDER BY conname;

-- PASS khi: 2 CHECK, và
--   scope_type_check      → chứa CẢ BA: 'GLOBAL', 'APP', 'ACCOUNT'
--                           (chặng 1 vẫn PHẢI còn 'GLOBAL')
--   scope_coherent_check  → có nhánh ACCOUNT (scope_app_id IS NULL AND
--                           scope_account_id IS NOT NULL), và VẪN còn nhánh
--                           GLOBAL.

SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname='iap_mgmt' AND tablename='price_tier_templates'
ORDER BY indexname;

-- PASS khi: 5 dòng —
--   price_tier_templates_pkey                        (nguyên)
--   idx_..._app_unique                               (nguyên)
--   idx_..._uploaded                                 (nguyên)
--   idx_..._global_unique                            ⚠ VẪN CÒN ở chặng 1
--   idx_..._account_unique                           ⚠ MỚI: UNIQUE
--     (scope_account_id) WHERE scope_type='ACCOUNT'

-- M1-V6b — hai cột mới có mặt, đúng kiểu.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='iap_mgmt' AND table_name='price_tier_templates'
  AND column_name IN ('scope_account_id','origin_note')
ORDER BY column_name;

-- PASS khi: 2 dòng, cả hai `text` / `YES` (nullable ở tầng cột — tính bắt
--   buộc do CHECK coherence đảm nhiệm, không phải NOT NULL).


-- ── M1-V7 — 3 template APP KHÔNG bị đụng ──────────────────────────────────
--    ⚠ ĐÚNG QUERY V0e đã chụp trước khi apply. So từng cột.
SELECT
  t.id AS template_id, a.apple_app_id, a.name AS app_name, a.asc_account_id,
  t.uploaded_at, t.uploaded_by, t.source_filename, COUNT(e.tier_id) AS entry_count
FROM iap_mgmt.price_tier_templates t
JOIN iap_mgmt.apps a ON a.id = t.scope_app_id
LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'APP'
GROUP BY t.id, a.apple_app_id, a.name, a.asc_account_id,
         t.uploaded_at, t.uploaded_by, t.source_filename
ORDER BY a.name;

-- PASS khi: 3 dòng, TỪNG CỘT y hệt V0e — nhất là uploaded_at, uploaded_by,
--   entry_count. Không dòng nào có uploaded_by='SYSTEM_MIGRATION'.


-- ── M1-V8 — SMOKE TEST TRÊN CODE CŨ (làm bằng tay, không phải SQL) ────────
-- Đây là điều mà việc tách hai migration mua được — hãy thật sự kiểm nó:
--   1. Mở Settings → Pricing Templates → tab Default Template.
--      KỲ VỌNG: hiện template GLOBAL như trước, 1140 entry, đúng ngày/người
--      upload cũ. KHÔNG lỗi, KHÔNG trang trắng.
--   2. Bấm "Open matrix view".            KỲ VỌNG: ma trận hiện bình thường.
--   3. Mở tab Per-App Templates.          KỲ VỌNG: đúng 3 dòng như trước.
--   4. Mở một App detail có template riêng. KỲ VỌNG: phần Pricing Template
--      hiện đúng như trước.
--   ⚠ ĐỪNG bấm Replace/Remove ở tab Default trong chặng này (xem cảnh báo
--     trong M-1: 6 bản sao chụp tại thời điểm M-1; thay bản gốc sau đó làm
--     chúng lệch, và M-2 sẽ TỪ CHỐI chạy).


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  CHẶNG 2 — SAU KHI DEPLOY CODE MỚI VÀ APPLY M-2                         ║
-- ╚═════════════════════════════════════════════════════════════════════════╝

-- ── M2-V1 — GLOBAL đã biến mất, phần còn lại nguyên vẹn ───────────────────
SELECT
  COUNT(*) FILTER (WHERE scope_type='GLOBAL')  AS global_con_lai,
  COUNT(*) FILTER (WHERE scope_type='ACCOUNT') AS so_account,
  COUNT(*) FILTER (WHERE scope_type='APP')     AS so_app,
  COUNT(*)                                     AS tong
FROM iap_mgmt.price_tier_templates;

-- PASS khi: global_con_lai = 0 · so_account = N · so_app = 3 · tong = N + 3.

-- M2-V1b — entry của các template ACCOUNT KHÔNG suy suyển sau khi xoá GLOBAL.
-- (Kiểm CASCADE chỉ dọn entry của đúng dòng GLOBAL.)
SELECT
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries e
     JOIN iap_mgmt.price_tier_templates t ON t.id=e.template_id
    WHERE t.scope_type='ACCOUNT')                                   AS tong_entry_account,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries_backup_global)
  * (SELECT COUNT(*) FROM public.asc_accounts WHERE is_active=true) AS ky_vong,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries)       AS tong_entry_toan_bang;

-- PASS khi: tong_entry_account = ky_vong (6840).
--   tong_entry_toan_bang = 6840 + tổng entry của 3 template APP.


-- ── M2-V2 — CHECK đã thu hẹp ──────────────────────────────────────────────
SELECT conname, pg_get_constraintdef(oid) AS dinh_nghia
FROM pg_constraint
WHERE conrelid='iap_mgmt.price_tier_templates'::regclass AND contype='c'
ORDER BY conname;

-- PASS khi: 2 CHECK, và
--   scope_type_check      → chứa 'APP' + 'ACCOUNT', KHÔNG còn 'GLOBAL'
--   scope_coherent_check  → còn ĐÚNG hai nhánh APP và ACCOUNT.

-- M2-V2b — thử vi phạm. Chạy TỪNG khối riêng (lệnh đầu lỗi là khối dừng).
-- PASS khi: cả ba INSERT đều BỊ TỪ CHỐI.
-- BEGIN;
--   -- (1) scope cũ đã bị cấm → lỗi price_tier_templates_scope_type_check
--   INSERT INTO iap_mgmt.price_tier_templates (scope_type, uploaded_by)
--   VALUES ('GLOBAL', 'verify-test');
-- ROLLBACK;
-- BEGIN;
--   -- (2) ACCOUNT thiếu scope_account_id → lỗi scope_coherent_check
--   INSERT INTO iap_mgmt.price_tier_templates (scope_type, uploaded_by)
--   VALUES ('ACCOUNT', 'verify-test');
-- ROLLBACK;
-- BEGIN;
--   -- (3) hai template cho CÙNG account → lỗi idx_..._account_unique
--   INSERT INTO iap_mgmt.price_tier_templates (scope_type, scope_account_id, uploaded_by)
--   SELECT 'ACCOUNT', t.scope_account_id, 'verify-test'
--   FROM iap_mgmt.price_tier_templates t WHERE t.scope_type='ACCOUNT' LIMIT 1;
-- ROLLBACK;


-- ── M2-V3 — index đã thay ─────────────────────────────────────────────────
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname='iap_mgmt' AND tablename='price_tier_templates'
ORDER BY indexname;

-- PASS khi: 4 dòng —
--   KHÔNG còn  idx_..._global_unique          ⚠ M-2 đã drop
--   CÓ         idx_..._account_unique
--   NGUYÊN     idx_..._app_unique · idx_..._uploaded · price_tier_templates_pkey


-- ── M2-V4 — APP không đụng · đường lui còn · audit có ghi ──────────────────
-- (a) 3 template APP — lại đúng query V0e/M1-V7.
SELECT
  t.id AS template_id, a.apple_app_id, a.name AS app_name, a.asc_account_id,
  t.uploaded_at, t.uploaded_by, t.source_filename, COUNT(e.tier_id) AS entry_count
FROM iap_mgmt.price_tier_templates t
JOIN iap_mgmt.apps a ON a.id = t.scope_app_id
LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'APP'
GROUP BY t.id, a.apple_app_id, a.name, a.asc_account_id,
         t.uploaded_at, t.uploaded_by, t.source_filename
ORDER BY a.name;

-- PASS khi: y hệt V0e và y hệt M1-V7.

-- (b) đường lui.
SELECT
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_templates_backup_global)        AS header_backup,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_template_entries_backup_global) AS entry_backup,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_territories)                    AS entry_bang_legacy;

-- PASS khi: header_backup = 1 · entry_backup = 1140.
--   entry_bang_legacy chỉ để biết: khác 1140 nghĩa là bảng legacy là ảnh
--   chụp của một lần import CŨ, không dùng làm đường lui được.

-- (c) audit: tác giả gốc còn sống sót sau khi dòng GLOBAL bị xoá.
SELECT
  l.created_at,
  l.payload ->> 'scope_account_id'          AS account,
  l.payload ->> 'source_global_template_id' AS global_goc,
  l.payload ->> 'source_uploaded_by'        AS ai_upload_ban_goc,
  l.payload ->> 'source_uploaded_at'        AS upload_luc_nao,
  l.payload ->> 'entry_count'               AS entry_count
FROM iap_mgmt.actions_log l
WHERE l.action_type = 'PRICE_TIER_IMPORT'
  AND l.payload ->> 'op' = 'duplicate_global_to_account'
ORDER BY l.payload ->> 'scope_account_id';

-- PASS khi: N dòng · ai_upload_ban_goc + upload_luc_nao KHÔNG rỗng.
--   ⚠ 0 dòng = INSERT audit bị CHECK action_type từ chối (bẫy KB §9 P2).
--     Không hỏng dữ liệu giá, nhưng mất dấu vết tác giả gốc VĨNH VIỄN
--     (dòng GLOBAL đã bị xoá). Báo lại ngay.


-- ═══════════════════════════════════════════════════════════════════════════
-- SAU KHI M2-V1…V4 PASS
--
-- • Dọn dẹp (KHÔNG làm ngay): hai bảng ..._backup_global nằm lại trong
--   schema. Chỉ xoá khi Manager xác nhận template ACCOUNT đã chạy đúng qua
--   ít nhất một lần submit thật. Ghi vào TODO kèm điều kiện đó.
--
-- • Đường lui, theo chặng:
--     sau M-1 (trước M-2): xoá 6 dòng ACCOUNT là xong, GLOBAL chưa mất —
--       DELETE FROM iap_mgmt.price_tier_templates
--        WHERE scope_type='ACCOUNT' AND origin_note IS NOT NULL;
--       (CASCADE dọn entry. origin_note IS NOT NULL để KHÔNG đụng template
--        mà Manager đã tự upload sau đó.)
--     sau M-2: dữ liệu không mất — nó nằm trong N bản sao ACCOUNT, cộng
--       bảng backup. Muốn dựng lại một dòng GLOBAL thì insert từ backup
--       (nhớ CHECK đã cấm 'GLOBAL' — phải nới lại trước).
-- ═══════════════════════════════════════════════════════════════════════════
