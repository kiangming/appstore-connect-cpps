-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — [G1 · GOOGLE account-default-template]
--
--   M-1  supabase/migrations/20260831000000_google_iap_mgmt_account_templates_m1_additive.sql
--   M-2  CHƯA VIẾT (thuộc chunk G1f, apply SAU khi code mới đã deploy)
--
-- THỨ TỰ:
--   0. TRƯỚC khi apply M-1  → M1-V-PRE-A, M1-V-PRE-B
--   1. apply M-1            → M1-V0 (gộp, MỘT dòng) → M1-V1…M1-V8 khi cần
--   2. báo lại              → DEPLOY CODE MỚI
--   3. (sau) apply M-2      → M2-V… (viết ở G1f)
--
-- ⚠ CHẠY TỪNG CÂU MỘT. Supabase SQL Editor chỉ hiện kết quả của câu lệnh
--   CUỐI trong một script nhiều lệnh — dán cả file rồi bấm Run thì chỉ thấy
--   câu chót và mọi câu trên đó im lặng trôi qua.
--
-- ⚠ TẤT CẢ câu trong file này READ-ONLY. Không INSERT/UPDATE/DELETE/ALTER.
--   Chạy được nhiều lần, không đổi dữ liệu.
--
-- ⚠ KHÔNG HARDCODE. Mọi phép so đọc số từ:
--     google_iap_mgmt.google_console_accounts                  → N account
--     google_iap_mgmt.pricing_template_entries_backup_global   → số entry gốc
--   Lý do: census 2026-08-30 đo được 6 account · 846 entry · 3 template APP,
--   nhưng dữ liệu có thể đổi giữa lúc duyệt và lúc apply. Một verify chốt
--   hằng số sẽ báo FAIL vì một lý do hợp lệ.
--
-- ⚠ MỘT PHÉP ĐO TRẢ VỀ 0 DÒNG LÀ MỘT PHÁT HIỆN, KHÔNG PHẢI "không sao".
--   Mỗi câu dưới đây được viết để LUÔN trả ít nhất 1 dòng khi chạy đúng.
--   Thấy "0 rows" ⇒ dừng, báo lại.
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  BƯỚC 0 — CHẠY TRƯỚC KHI APPLY M-1                                      ║
-- ╚═════════════════════════════════════════════════════════════════════════╝

-- ── M1-V-PRE-A — 6 chuỗi display_name THẬT ────────────────────────────────
-- Việc cần làm: so từng chuỗi trong cột `display_name` dưới đây với khối
-- `v_expected` ở dòng 410 tới dòng 415 của file M-1
-- (supabase/migrations/20260831000000_google_iap_mgmt_account_templates_m1_additive.sql).
-- So ĐÚNG TỪNG KÝ TỰ, phân biệt hoa thường, để ý khoảng trắng thừa.
--
-- KỲ VỌNG: 6 dòng, và 6 chuỗi khớp y hệt khối v_expected:
--     MTP · NCV · VNG Corp · VNG Sing · VNGG Sing · VNGG VN
-- • Khớp đủ 6      ⇒ đi tiếp M1-V-PRE-B.
-- • Lệch dù 1 ký tự ⇒ DỪNG, gửi output câu này về. KHÔNG tự sửa file M-1.
--   (Guard trong M-1 cũng chặn ca này và rollback, nhưng phát hiện ở đây rẻ
--    hơn phát hiện lúc bấm Run.)
-- • Số dòng ≠ 6     ⇒ DỪNG, báo lại: có account được thêm/xoá sau census.
SELECT
  a.display_name,
  a.status,
  a.id                                        AS account_id,
  (SELECT COUNT(*) FROM google_iap_mgmt.apps ap
    WHERE ap.google_console_account_id = a.id) AS app_count
FROM google_iap_mgmt.google_console_accounts a
ORDER BY a.display_name;


-- ── M1-V-PRE-B — tên hai ràng buộc CHECK hiện có ──────────────────────────
-- Câu này chỉ để ĐỌC CHO BIẾT. M-1 KHÔNG gõ tên hai ràng buộc này vào file;
-- nó tự tra pg_constraint lúc chạy rồi DROP theo tên tra được (BƯỚC 2 của
-- M-1). Câu này tồn tại để Manager thấy trước M-1 sắp đụng vào cái gì.
--
-- KỲ VỌNG: 2 dòng. Một cái sinh từ CHECK cấp cột trên `scope_type`
--   (init 20260520010000:280), một cái sinh từ CHECK cấp bảng cho tính mạch
--   lạc GLOBAL/APP (init 20260520010000:285-289). Tên do Postgres tự sinh.
-- ⚠ 0 dòng ⇒ DỪNG, báo lại. 0 dòng nghĩa là phép tra không đọc được thứ nó
--   nói là đang đọc, và guard cùng tính chất trong M-1 sẽ nổ.
SELECT
  c.conname                      AS constraint_name,
  pg_get_constraintdef(c.oid)    AS definition
FROM pg_constraint c
JOIN pg_class     t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'google_iap_mgmt'
  AND t.relname = 'pricing_templates'
  AND c.contype = 'c'
ORDER BY c.conname;


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  BƯỚC 4 — SAU KHI APPLY M-1, TRƯỚC KHI DEPLOY CODE                      ║
-- ║  Bất biến của chặng này: KHÔNG CÓ GÌ BỊ XOÁ. Code cũ chạy y nguyên.     ║
-- ╚═════════════════════════════════════════════════════════════════════════╝

-- ── M1-V0 — BẢNG KIỂM GỘP: MỘT query, MỘT dòng kết quả ────────────────────
--
-- ⚠ CHẠY CÂU NÀY TRƯỚC. Nó gộp M1-V1…M1-V7 thành một dòng, mỗi phép kiểm là
--   một cột boolean, cộng ô kết luận `TAT_CA_PASS`.
--
-- • TAT_CA_PASS = true  ⇒ xong M-1. Chạy tiếp M1-V6 (đọc mắt thứ tự cột) và
--                          M1-V8 (smoke test tay), rồi báo lại để deploy.
-- • TAT_CA_PASS = false ⇒ xem cột nào false, chạy câu CHI TIẾT tương ứng
--                          (M1-V1…M1-V7) để biết lệch ở đâu.
-- ───────────────────────────────────────────────────────────────────────────
WITH
n_acct AS (SELECT COUNT(*)::int AS c FROM google_iap_mgmt.google_console_accounts),
n_goc  AS (SELECT COUNT(*)::int AS c FROM google_iap_mgmt.pricing_template_entries_backup_global),
n_glob AS (SELECT COUNT(*)::int AS c FROM google_iap_mgmt.pricing_templates WHERE scope_type='GLOBAL'),
n_acct_tpl AS (SELECT COUNT(*)::int AS c FROM google_iap_mgmt.pricing_templates WHERE scope_type='ACCOUNT'),
n_app  AS (SELECT COUNT(*)::int AS c FROM google_iap_mgmt.pricing_templates WHERE scope_type='APP'),
n_ent  AS (
  SELECT COUNT(*)::int AS c
    FROM google_iap_mgmt.pricing_template_entries e
    JOIN google_iap_mgmt.pricing_templates t ON t.id = e.template_id
   WHERE t.scope_type='ACCOUNT'
),
-- account thiếu template (kỳ vọng 0)
acct_thieu AS (
  SELECT COUNT(*)::int AS c
    FROM google_iap_mgmt.google_console_accounts a
   WHERE NOT EXISTS (SELECT 1 FROM google_iap_mgmt.pricing_templates t
                      WHERE t.scope_type='ACCOUNT' AND t.scope_account_id = a.id)
),
-- bản sao lệch số entry so với bản gốc (kỳ vọng 0)
tpl_lech AS (
  SELECT COUNT(*)::int AS c FROM (
    SELECT t.id
      FROM google_iap_mgmt.pricing_templates t
      LEFT JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
     WHERE t.scope_type='ACCOUNT'
     GROUP BY t.id
    HAVING COUNT(e.identifier) <> (SELECT c FROM n_goc)
  ) x
),
-- ô nào của bản sao khác nội dung ô tương ứng của GLOBAL (kỳ vọng 0)
noi_dung_lech AS (
  SELECT COUNT(*)::int AS c
    FROM google_iap_mgmt.pricing_template_entries e
    JOIN google_iap_mgmt.pricing_templates t ON t.id = e.template_id
    LEFT JOIN google_iap_mgmt.pricing_template_entries g
      ON g.template_id = (SELECT id FROM google_iap_mgmt.pricing_templates
                           WHERE scope_type='GLOBAL')
     AND g.identifier  = e.identifier
     AND g.region_code = e.region_code
   WHERE t.scope_type='ACCOUNT'
     AND (g.identifier IS NULL
          OR g.price_micros IS DISTINCT FROM e.price_micros
          OR g.currency     IS DISTINCT FROM e.currency)
),
-- entry còn sort_order NULL (kỳ vọng 0)
so_null AS (
  SELECT COUNT(*)::int AS c FROM google_iap_mgmt.pricing_template_entries
   WHERE sort_order IS NULL
),
-- bản sao thiếu dấu vết nguồn gốc (kỳ vọng 0)
thieu_origin AS (
  SELECT COUNT(*)::int AS c FROM google_iap_mgmt.pricing_templates
   WHERE scope_type='ACCOUNT' AND origin_note IS NULL
),
-- CHECK đã nới cho ACCOUNT chưa (kỳ vọng có)
check_noi AS (
  SELECT COUNT(*)::int AS c
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname='google_iap_mgmt' AND t.relname='pricing_templates'
     AND c.contype='c' AND pg_get_constraintdef(c.oid) ILIKE '%ACCOUNT%'
),
-- unique index cho scope ACCOUNT (kỳ vọng có)
idx_acct AS (
  SELECT COUNT(*)::int AS c FROM pg_indexes
   WHERE schemaname='google_iap_mgmt'
     AND indexname='idx_google_iap_mgmt_pricing_templates_account_unique'
)
SELECT
  (SELECT c FROM n_acct)                       AS so_account,
  (SELECT c FROM n_goc)                        AS entry_ban_goc,
  (SELECT c FROM n_glob)                       AS so_global,
  (SELECT c FROM n_acct_tpl)                   AS so_tpl_account,
  (SELECT c FROM n_app)                        AS so_tpl_app,
  (SELECT c FROM n_ent)                        AS tong_entry_account,
  ((SELECT c FROM n_glob) = 1)                                       AS v1_global_con_nguyen,
  ((SELECT c FROM n_acct_tpl) = (SELECT c FROM n_acct))              AS v2_du_moi_account,
  ((SELECT c FROM acct_thieu) = 0)                                   AS v2b_khong_account_nao_thieu,
  ((SELECT c FROM tpl_lech) = 0)                                     AS v3_moi_ban_du_entry,
  ((SELECT c FROM n_ent) = (SELECT c FROM n_acct) * (SELECT c FROM n_goc))
                                                                     AS v4_tong_entry_dung,
  ((SELECT c FROM noi_dung_lech) = 0)                                AS v5_noi_dung_trung_khop,
  ((SELECT c FROM so_null) = 0)                                      AS v6_sort_order_phu_kin,
  ((SELECT c FROM thieu_origin) = 0)                                 AS v7_co_dau_vet_nguon_goc,
  ((SELECT c FROM check_noi) > 0)                                    AS v7b_check_da_noi,
  ((SELECT c FROM idx_acct) = 1)                                     AS v7c_co_unique_index,
  CASE WHEN
        (SELECT c FROM n_glob) = 1
    AND (SELECT c FROM n_acct_tpl) = (SELECT c FROM n_acct)
    AND (SELECT c FROM acct_thieu) = 0
    AND (SELECT c FROM tpl_lech) = 0
    AND (SELECT c FROM n_ent) = (SELECT c FROM n_acct) * (SELECT c FROM n_goc)
    AND (SELECT c FROM noi_dung_lech) = 0
    AND (SELECT c FROM so_null) = 0
    AND (SELECT c FROM thieu_origin) = 0
    AND (SELECT c FROM check_noi) > 0
    AND (SELECT c FROM idx_acct) = 1
       THEN 'PASS — M-1 xong. Chay tiep M1-V6 va M1-V8, roi bao lai de deploy.'
       ELSE 'FAIL — xem cot nao false, chay cau chi tiet tuong ung ben duoi.'
  END AS TAT_CA_PASS;


-- ── M1-V1 — đếm template theo scope ───────────────────────────────────────
-- KỲ VỌNG: 3 dòng.
--   ACCOUNT = số dòng của google_console_accounts (census: 6)
--   APP     = y hệt trước khi apply (census: 3) — M-1 KHÔNG đụng template APP
--   GLOBAL  = 1 (M-1 KHÔNG xoá gì; việc xoá thuộc M-2)
SELECT scope_type, COUNT(*) AS so_template
FROM google_iap_mgmt.pricing_templates
GROUP BY scope_type
ORDER BY scope_type;


-- ── M1-V2 — từng account có đúng một template, và bao nhiêu entry ─────────
-- KỲ VỌNG: đúng 6 dòng, mỗi dòng `so_template = 1` và `so_entry` = số entry
-- của bản gốc (census: 846). Cột `nguon_goc` phải là 'ban sao (migration)'
-- cho cả 6 — nếu thấy 'nguoi that upload' nghĩa là ai đó đã Replace sau M-1.
SELECT
  a.display_name                                   AS account,
  COUNT(DISTINCT t.id)                             AS so_template,
  COUNT(e.identifier)                              AS so_entry,
  MAX(t.uploaded_by)                               AS uploaded_by,
  CASE WHEN MAX(t.origin_note) IS NOT NULL
       THEN 'ban sao (migration)' ELSE 'nguoi that upload' END AS nguon_goc
FROM google_iap_mgmt.google_console_accounts a
LEFT JOIN google_iap_mgmt.pricing_templates t
       ON t.scope_type = 'ACCOUNT' AND t.scope_account_id = a.id
LEFT JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
GROUP BY a.display_name
ORDER BY a.display_name;


-- ── M1-V3 — bản sao nào LỆCH số entry so với bản gốc ──────────────────────
-- KỲ VỌNG: **0 dòng.** Câu này chỉ liệt kê cái SAI.
-- ⚠ Đây là ngoại lệ của quy tắc "0 dòng là phát hiện": ở ĐÚNG câu này 0 dòng
--   là PASS. Ghi rõ ở đây để không phải đoán.
SELECT t.id AS template_id, a.display_name AS account,
       COUNT(e.identifier) AS so_entry,
       (SELECT COUNT(*) FROM google_iap_mgmt.pricing_template_entries_backup_global)
                           AS ky_vong
FROM google_iap_mgmt.pricing_templates t
JOIN google_iap_mgmt.google_console_accounts a ON a.id = t.scope_account_id
LEFT JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'ACCOUNT'
GROUP BY t.id, a.display_name
HAVING COUNT(e.identifier)
     <> (SELECT COUNT(*) FROM google_iap_mgmt.pricing_template_entries_backup_global);


-- ── M1-V4 — tổng số entry của scope ACCOUNT ───────────────────────────────
-- KỲ VỌNG: 1 dòng, `khop = true`.
-- census: 6 × 846 = 5076. Con số 5076 KHÔNG gõ tay ở đây — nó được tính.
SELECT
  (SELECT COUNT(*) FROM google_iap_mgmt.google_console_accounts)                    AS n_account,
  (SELECT COUNT(*) FROM google_iap_mgmt.pricing_template_entries_backup_global)     AS entry_moi_ban,
  (SELECT COUNT(*) FROM google_iap_mgmt.pricing_template_entries e
     JOIN google_iap_mgmt.pricing_templates t ON t.id = e.template_id
    WHERE t.scope_type='ACCOUNT')                                                   AS tong_thuc_te,
  (SELECT COUNT(*) FROM google_iap_mgmt.pricing_template_entries e
     JOIN google_iap_mgmt.pricing_templates t ON t.id = e.template_id
    WHERE t.scope_type='ACCOUNT')
  = (SELECT COUNT(*) FROM google_iap_mgmt.google_console_accounts)
  * (SELECT COUNT(*) FROM google_iap_mgmt.pricing_template_entries_backup_global)   AS khop;


-- ── M1-V5 — NỘI DUNG bản sao có đúng bằng bản gốc không ───────────────────
-- Đếm entry mới KHÔNG có ô tương ứng trong GLOBAL, hoặc có mà lệch giá /
-- lệch currency. Đây là phép kiểm nội dung thật, không phải đếm số dòng —
-- 846 dòng vẫn có thể sai giá.
-- KỲ VỌNG: **0 dòng.** (0 dòng ở câu này = PASS.)
SELECT a.display_name AS account, e.identifier, e.region_code,
       e.price_micros AS gia_ban_sao, g.price_micros AS gia_ban_goc,
       e.currency     AS cur_ban_sao, g.currency     AS cur_ban_goc
FROM google_iap_mgmt.pricing_template_entries e
JOIN google_iap_mgmt.pricing_templates t ON t.id = e.template_id
JOIN google_iap_mgmt.google_console_accounts a ON a.id = t.scope_account_id
LEFT JOIN google_iap_mgmt.pricing_template_entries g
       ON g.template_id = (SELECT id FROM google_iap_mgmt.pricing_templates
                            WHERE scope_type='GLOBAL')
      AND g.identifier  = e.identifier
      AND g.region_code = e.region_code
WHERE t.scope_type = 'ACCOUNT'
  AND (g.identifier IS NULL
       OR g.price_micros IS DISTINCT FROM e.price_micros
       OR g.currency     IS DISTINCT FROM e.currency)
LIMIT 50;


-- ── M1-V6 — THỨ TỰ CỘT tái dựng được có ĐÚNG không (đọc bằng mắt) ─────────
-- ⚠ Câu này KHÔNG tự kết luận được — nó cần mắt Manager. sort_order được tái
--   dựng từ thứ tự vật lý (ctid) của các dòng đang có, tức thứ tự cột trong
--   file .xlsx đã upload. Không có nguồn nào khác để đối chiếu tự động.
--
-- KỲ VỌNG: mỗi template một dòng. Với bản GLOBAL và cả 6 bản ACCOUNT, chuỗi
--   `thu_tu_cot` phải là:
--       US · VN · SG · MY · ID · PH · TH · HK · TW
--   (thứ tự này ghi ở lib/google-iap-management/xlsx-template-matrix-export.ts:34-36,
--    và là thứ tự màn hình đang hiện trước M-1 — Hotfix 24,
--    lib/google-iap-management/queries/template-matrix.ts:118-132.)
--
-- • Khớp        ⇒ PASS, thứ tự cột đã được ghim lại, VACUUM FULL không đảo được nữa.
-- • KHÔNG khớp  ⇒ DỪNG, gửi output về. Nghĩa là thứ tự vật lý đã bị xáo trước
--                 khi M-1 chạy, và cái ghim được không phải cái Manager đang đọc.
--                 KHÔNG tự sửa — sửa sai chỗ này là đổi thứ tự cột của cả 7 bản.
-- • 3 template APP có thể có thứ tự / số cột khác GLOBAL (chúng thưa ô,
--   census: 82 ô thưa). Đọc để biết, không dùng để kết luận PASS/FAIL.
SELECT
  t.scope_type,
  COALESCE(a.display_name, ap.package_name, '(global)')      AS thuoc_ve,
  COUNT(DISTINCT e.region_code)                              AS so_cot,
  (SELECT string_agg(x.region_code, ' · ' ORDER BY x.sort_order)
     FROM (SELECT DISTINCT e2.region_code, e2.sort_order
             FROM google_iap_mgmt.pricing_template_entries e2
            WHERE e2.template_id = t.id) x)                  AS thu_tu_cot
FROM google_iap_mgmt.pricing_templates t
LEFT JOIN google_iap_mgmt.google_console_accounts a ON a.id = t.scope_account_id
LEFT JOIN google_iap_mgmt.apps ap ON ap.id = t.scope_app_id
LEFT JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
GROUP BY t.id, t.scope_type, a.display_name, ap.package_name
ORDER BY t.scope_type, thuoc_ve;


-- ── M1-V7 — dấu vết nguồn gốc + ràng buộc mới ─────────────────────────────
-- KỲ VỌNG: 1 dòng, cả ba cột boolean = true.
--   `moi_ban_co_origin_note` — điều kiện rẽ nhánh của modal Replace ở G1c.
--     ⚠ Modal phải phân biệt bằng origin_note IS NOT NULL, KHÔNG so chuỗi
--       uploaded_by = 'SYSTEM_MIGRATION'.
--   `check_cho_phep_account`  — CHECK đã nới, INSERT scope ACCOUNT hợp lệ.
--   `co_unique_index_account` — mỗi account tối đa 1 template (replace-only).
SELECT
  (SELECT COUNT(*) FROM google_iap_mgmt.pricing_templates
    WHERE scope_type='ACCOUNT' AND origin_note IS NULL) = 0     AS moi_ban_co_origin_note,
  (SELECT COUNT(*) FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname='google_iap_mgmt' AND t.relname='pricing_templates'
      AND c.contype='c'
      AND pg_get_constraintdef(c.oid) ILIKE '%ACCOUNT%') > 0    AS check_cho_phep_account,
  (SELECT COUNT(*) FROM pg_indexes
    WHERE schemaname='google_iap_mgmt'
      AND indexname='idx_google_iap_mgmt_pricing_templates_account_unique') = 1
                                                                AS co_unique_index_account;


-- ── M1-V8 — SMOKE TEST BẤM TAY, trên CODE CŨ (chưa deploy) ────────────────
-- ⚠ Không phải SQL. Bất biến của chặng này là "code cũ chạy y nguyên", và
--   chỉ có bấm tay mới chứng minh được điều đó.
--
--   1. Mở màn Pricing Template (Default) → matrix phải hiện ĐỦ 94 hàng × 9
--      cột, thứ tự cột US VN SG MY ID PH TH HK TW như trước M-1.
--   2. Mở màn Per-App matrix của một app có template riêng (PASS SDK) →
--      vẫn hiện bình thường. (Đường này gọi findTemplateIdForScope('GLOBAL')
--      BÊN TRONG fetchPerAppMatrix — grep tầng page không thấy nó, nên phải
--      bấm thật.)
--   3. Bulk Import, bước chọn nguồn giá → radio "Default Template" vẫn bật
--      được và vẫn nạp đúng danh sách tier.
--   4. ⚠ ĐỪNG bấm Replace hay Remove Default Template. Xem cảnh báo cửa sổ
--      M-1 → deploy ở đầu file M-1.
--
-- Cả 4 mục OK ⇒ báo lại để deploy code mới (chunk G1b…G1e).


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  G1c/C4 — HỆ QUẢ CỦA VIỆC BỊT RÒ RỈ CROSS-ACCOUNT                       ║
-- ║  Chạy TRƯỚC khi deploy G1c, để biết màn nào sẽ bớt dòng.                ║
-- ╚═════════════════════════════════════════════════════════════════════════╝

-- ── G1c-V1 — template APP thuộc account nào ───────────────────────────────
-- Sau G1c, tab "Per-App Templates" ở màn
--   /google-iap-management/settings/pricing-templates
-- CHỈ còn hiện template của app thuộc ACCOUNT ĐANG ACTIVE. Trước G1c nó
-- hiện TẤT CẢ, bất kể account — trong khi ô chọn app ngay cạnh
-- (`listAppsForAccount`) thì đã lọc. Hai nửa cùng màn trả lời hai câu khác
-- nhau; G1c làm chúng nói cùng một câu.
--
-- ⚠ ĐÂY KHÔNG PHẢI MẤT DỮ LIỆU. Không dòng nào bị xoá — chúng chỉ thôi
--   hiện ở màn của account KHÔNG sở hữu chúng. Đổi account (chip account)
--   là thấy lại đầy đủ.
--
-- KỲ VỌNG: census 2026-08-30 đếm 3 template APP (PASS SDK · Play Together ·
-- Light and Night). Cột `so_template_app` cộng lại phải bằng 3.
-- Đọc cột `account`: mỗi Manager khi mở màn dưới account nào sẽ thấy đúng
-- số dòng ở cột `so_template_app` của account đó.
SELECT
  acc.display_name                       AS account,
  COUNT(t.id)                            AS so_template_app,
  STRING_AGG(ap.package_name, ' · ' ORDER BY ap.package_name) AS cac_app
FROM google_iap_mgmt.google_console_accounts acc
LEFT JOIN google_iap_mgmt.apps ap
       ON ap.google_console_account_id = acc.id
LEFT JOIN google_iap_mgmt.pricing_templates t
       ON t.scope_type = 'APP' AND t.scope_app_id = ap.id
GROUP BY acc.display_name
ORDER BY acc.display_name;


-- ── G1c-V2 — có template APP nào MỒ CÔI không? ────────────────────────────
-- Template APP trỏ tới một app không còn tồn tại. Những dòng này KHÔNG hiện
-- ở bất kỳ màn nào, cả trước lẫn sau G1c (code bỏ qua khi không ghép được
-- app) — nêu ra để không ai nhầm chúng với dòng "bị G1c giấu đi".
--
-- KỲ VỌNG: 0 dòng. Có dòng ⇒ báo lại, đó là rác cần dọn riêng, không thuộc G1c.
SELECT t.id AS template_id, t.scope_app_id, t.uploaded_at, t.uploaded_by
FROM google_iap_mgmt.pricing_templates t
LEFT JOIN google_iap_mgmt.apps ap ON ap.id = t.scope_app_id
WHERE t.scope_type = 'APP' AND ap.id IS NULL;


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║  CHẶNG M-2 — SAU KHI APPLY                                              ║
-- ║  supabase/migrations/20260901000000_google_iap_mgmt_account_templates_m2_drop_global.sql
-- ║  Bất biến của chặng này: GLOBAL đã biến mất, 6 bản ACCOUNT còn NGUYÊN.  ║
-- ╚═════════════════════════════════════════════════════════════════════════╝
--
-- ⚠ CHẠY TỪNG CÂU MỘT. Chạy M2-V0 trước.

-- ── M2-V0 — BẢNG KIỂM GỘP: MỘT query, MỘT dòng ────────────────────────────
-- • TAT_CA_PASS = PASS ⇒ arc G1 đóng.
-- • FAIL ⇒ xem cột nào false rồi chạy M2-V1…M2-V5 tương ứng.
WITH
n_acct  AS (SELECT COUNT(*)::int c FROM google_iap_mgmt.google_console_accounts),
n_snap  AS (SELECT COUNT(*)::int c FROM google_iap_mgmt.pricing_template_entries_backup_global),
n_snaph AS (SELECT COUNT(*)::int c FROM google_iap_mgmt.pricing_templates_backup_global),
n_glob  AS (SELECT COUNT(*)::int c FROM google_iap_mgmt.pricing_templates WHERE scope_type='GLOBAL'),
n_acct_tpl AS (SELECT COUNT(*)::int c FROM google_iap_mgmt.pricing_templates WHERE scope_type='ACCOUNT'),
n_app   AS (SELECT COUNT(*)::int c FROM google_iap_mgmt.pricing_templates WHERE scope_type='APP'),
n_ent   AS (SELECT COUNT(*)::int c FROM google_iap_mgmt.pricing_template_entries e
              JOIN google_iap_mgmt.pricing_templates t ON t.id=e.template_id
             WHERE t.scope_type='ACCOUNT'),
-- entry mồ côi: trỏ tới template không còn tồn tại (CASCADE phải dọn sạch)
n_orphan AS (SELECT COUNT(*)::int c FROM google_iap_mgmt.pricing_template_entries e
              WHERE NOT EXISTS (SELECT 1 FROM google_iap_mgmt.pricing_templates t
                                 WHERE t.id = e.template_id)),
-- CHECK còn nhắc 'GLOBAL' không (phải KHÔNG)
chk_global AS (SELECT COUNT(*)::int c FROM pg_constraint c
                 JOIN pg_class t ON t.oid=c.conrelid
                 JOIN pg_namespace n ON n.oid=t.relnamespace
                WHERE n.nspname='google_iap_mgmt' AND t.relname='pricing_templates'
                  AND c.contype='c' AND pg_get_constraintdef(c.oid) LIKE '%GLOBAL%'),
-- index global_unique đã drop chưa
idx_glob AS (SELECT COUNT(*)::int c FROM pg_indexes
              WHERE schemaname='google_iap_mgmt'
                AND indexname='idx_google_iap_mgmt_pricing_templates_global_unique'),
-- account nào thiếu template
acct_thieu AS (SELECT COUNT(*)::int c FROM google_iap_mgmt.google_console_accounts a
                WHERE NOT EXISTS (SELECT 1 FROM google_iap_mgmt.pricing_templates t
                                   WHERE t.scope_type='ACCOUNT' AND t.scope_account_id=a.id)),
-- entry còn sort_order NULL
so_null AS (SELECT COUNT(*)::int c FROM google_iap_mgmt.pricing_template_entries
             WHERE sort_order IS NULL)
SELECT
  (SELECT c FROM n_glob)                              AS so_global,
  (SELECT c FROM n_acct_tpl)                          AS so_tpl_account,
  (SELECT c FROM n_app)                               AS so_tpl_app,
  (SELECT c FROM n_ent)                               AS tong_entry_account,
  ((SELECT c FROM n_glob) = 0)                        AS v1_global_da_xoa,
  ((SELECT c FROM n_acct_tpl) = (SELECT c FROM n_acct)) AS v2_du_moi_account,
  ((SELECT c FROM acct_thieu) = 0)                    AS v2b_khong_account_nao_thieu,
  ((SELECT c FROM n_ent) = (SELECT c FROM n_acct) * (SELECT c FROM n_snap))
                                                      AS v3_tong_entry_dung,
  ((SELECT c FROM n_orphan) = 0)                      AS v4_khong_entry_mo_coi,
  ((SELECT c FROM chk_global) = 0)                    AS v5_check_da_bo_GLOBAL,
  ((SELECT c FROM idx_glob) = 0)                      AS v5b_da_drop_global_unique,
  ((SELECT c FROM n_snaph) > 0 AND (SELECT c FROM n_snap) > 0)
                                                      AS v6_backup_con_nguyen,
  ((SELECT c FROM so_null) = 0)                       AS v7_sort_order_phu_kin,
  CASE WHEN
        (SELECT c FROM n_glob) = 0
    AND (SELECT c FROM n_acct_tpl) = (SELECT c FROM n_acct)
    AND (SELECT c FROM acct_thieu) = 0
    AND (SELECT c FROM n_ent) = (SELECT c FROM n_acct) * (SELECT c FROM n_snap)
    AND (SELECT c FROM n_orphan) = 0
    AND (SELECT c FROM chk_global) = 0
    AND (SELECT c FROM idx_glob) = 0
    AND (SELECT c FROM n_snaph) > 0 AND (SELECT c FROM n_snap) > 0
    AND (SELECT c FROM so_null) = 0
       THEN 'PASS — M-2 xong, arc G1 dong. Van GIU 2 bang backup (dieu kien F4 chua thoa).'
       ELSE 'FAIL — xem cot nao false, chay cau chi tiet ben duoi.'
  END AS TAT_CA_PASS;


-- ── M2-V1 — đếm template theo scope ───────────────────────────────────────
-- KỲ VỌNG: 2 dòng. ACCOUNT = số account (census: 6) · APP = y hệt trước
-- M-2 (census: 3). KHÔNG còn dòng GLOBAL nào.
SELECT scope_type, COUNT(*) AS so_template
FROM google_iap_mgmt.pricing_templates
GROUP BY scope_type ORDER BY scope_type;


-- ── M2-V2 — CASCADE có dọn sạch entry của GLOBAL không ────────────────────
-- KỲ VỌNG: **0 dòng.** (0 dòng ở câu này = PASS.)
-- Entry trỏ tới một template không còn tồn tại nghĩa là FK CASCADE đã không
-- chạy — dữ liệu rác, và số đếm ở mọi màn sẽ sai.
SELECT e.template_id, COUNT(*) AS so_entry_mo_coi
FROM google_iap_mgmt.pricing_template_entries e
WHERE NOT EXISTS (
  SELECT 1 FROM google_iap_mgmt.pricing_templates t WHERE t.id = e.template_id
)
GROUP BY e.template_id;


-- ── M2-V3 — CHECK đã thu hẹp thật chưa ────────────────────────────────────
-- KỲ VỌNG: 2 dòng, và KHÔNG dòng nào chứa chữ GLOBAL trong `definition`.
SELECT c.conname AS constraint_name, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname='google_iap_mgmt' AND t.relname='pricing_templates' AND c.contype='c'
ORDER BY c.conname;


-- ── M2-V4 — THỬ GHI 'GLOBAL' và đòi nó HỎNG ───────────────────────────────
-- ⚠ Câu này CÓ INSERT nhưng nằm trong BEGIN…ROLLBACK nên KHÔNG ghi gì.
--   Đọc tên ràng buộc (M2-V3) chỉ chứng minh cái tên còn đó; câu này chứng
--   minh NỘI DUNG đã hẹp.
-- KỲ VỌNG: lệnh INSERT BÁO LỖI đỏ dạng
--   "new row for relation ... violates check constraint". ĐÓ LÀ PASS.
--   Nếu INSERT chạy LỌT (không lỗi) ⇒ FAIL, báo lại ngay.
BEGIN;
INSERT INTO google_iap_mgmt.pricing_templates
  (scope_type, scope_app_id, scope_account_id, uploaded_by)
VALUES ('GLOBAL', NULL, NULL, 'M2_V4_PROBE');
ROLLBACK;


-- ── M2-V5 — hai bảng backup CÒN NGUYÊN ────────────────────────────────────
-- ⚠ Sau M-2, đây là ĐƯỜNG LUI DUY NHẤT còn lại (rollback code không dùng
--   được nữa — code cũ đọc GLOBAL, mà GLOBAL đã bị xoá).
-- KỲ VỌNG: 1 dòng, `header` = 1 và `entries` = 846 (census).
--   Bằng 0 ⇒ DỪNG, báo lại: đường lui đã biến mất.
SELECT
  (SELECT COUNT(*) FROM google_iap_mgmt.pricing_templates_backup_global)        AS header,
  (SELECT COUNT(*) FROM google_iap_mgmt.pricing_template_entries_backup_global) AS entries;


-- ── M2-V6 — TODO còn treo (KHÔNG phải phép kiểm) ──────────────────────────
-- ⚠ CHƯA DỌN hai bảng backup, CÓ CHỦ Ý. Điều kiện dọn (F4): đã có ÍT NHẤT
--   MỘT lần Replace/upload THẬT thành công sau deploy — không phải chỉ xem
--   màn hình. U6/U6b của UAT bị hoãn nên điều kiện đó CHƯA thoả.
--   Khi thoả, câu dọn là:
--     DROP TABLE google_iap_mgmt.pricing_template_entries_backup_global;
--     DROP TABLE google_iap_mgmt.pricing_templates_backup_global;
--   Chạy hai câu đó chỉ sau khi Manager xác nhận đã Replace thật thành công.
