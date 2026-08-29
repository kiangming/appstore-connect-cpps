-- ═══════════════════════════════════════════════════════════════════════════
-- PRE-CHECK — [ACCOUNT-default-template] V0 · V0b · V0c · V0d
-- Nhân bản template GLOBAL → template riêng cho từng ASC account.
--
-- ⚠ CHẠY BỘ NÀY TRƯỚC. Migration CHƯA ĐƯỢC VIẾT và sẽ không được viết cho
--    tới khi 4 query dưới đây có kết quả — 3 trong 4 quyết định nội dung
--    migration, 1 là cổng dừng/không dừng.
--
-- Tất cả READ-ONLY. Không INSERT / UPDATE / DELETE / ALTER.
-- Chạy trong Supabase SQL Editor, theo thứ tự V0 → V0b → V0c → V0d.
-- Mỗi query có dòng "KỲ VỌNG" — đối chiếu ngay, đừng để tới lúc apply.
--
-- Bốn câu hỏi, bốn câu trả lời:
--   V0  → U1 (N bằng bao nhiêu) + U2 (id hay name) + U4 (bảng hay env)
--   V0b → cột scope_account_id đã tồn tại chưa
--   V0c → TÊN THẬT của 2 CHECK + định nghĩa index GLOBAL (không được đoán)
--   V0d → entry/territory thật của GLOBAL (đối chiếu 1140 / 12)
-- Plan đầy đủ: docs/iap-management/plan-account-template-duplication.md
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- V0 — DANH SÁCH ACCOUNT.  ⚠ ĐÂY LÀ CỔNG DỪNG/KHÔNG DỪNG.
--
-- Trả lời cùng lúc 3 ẩn số:
--   U1 — N = số dòng is_active = true (sẽ nhân bản đúng ngần đó template)
--   U2 — cột `id` là giá trị migration ghi vào scope_account_id;
--        cột `name` chỉ để đối chiếu. 6 chuỗi đã dán trước đó nằm ở cột NÀO?
--   U4 — bảng có dữ liệu thật không, hay account đang đến từ env ASC_ACCOUNTS
--
-- ⚠ NẾU TRẢ VỀ 0 DÒNG → DỪNG TOÀN BỘ. Không apply gì cả.
--   Nghĩa là AccountSwitcher đang đọc account từ biến môi trường
--   (lib/asc-account-repository.ts:78-100 có HAI nhánh fallback về
--   getEnvAccounts()), và không câu SQL nào nhìn thấy chúng. Phương án
--   nhân bản phải thiết kế lại từ đầu — báo lại ngay, đừng chạy tiếp V0b.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  id,                 -- ⟵ GIÁ TRỊ MIGRATION SẼ DÙNG (scope_account_id)
  name,               -- ⟵ chỉ để đối chiếu bằng mắt
  is_active,
  created_at
FROM public.asc_accounts
ORDER BY is_active DESC, created_at, id;

-- KỲ VỌNG:
--   • ≥ 1 dòng. 0 dòng = DỪNG (xem trên).
--   • Số dòng is_active = true khớp số account nhìn thấy trong AccountSwitcher.
--   • 6 chuỗi đã dán (mpt, NCV, vng-corp, vng-sing, vnggames-vn,
--     vnggames-sing) xuất hiện ở CỘT NÀO — `id` hay `name`?
--     → nếu ở `id`: đúng như plan giả định, dán thẳng cột id vào migration.
--     → nếu ở `name`: PHẢI dán cột `id` tương ứng, KHÔNG phải mấy chuỗi đó.
--   • Có dòng is_active = false không? Chúng sẽ KHÔNG được nhân bản (§P2.3).

-- V0-summary — một dòng để đọc nhanh N.
SELECT
  COUNT(*)                                  AS tong_dong,
  COUNT(*) FILTER (WHERE is_active)         AS n_se_nhan_ban,
  COUNT(*) FILTER (WHERE NOT is_active)     AS bo_qua_vi_inactive
FROM public.asc_accounts;

-- KỲ VỌNG: n_se_nhan_ban = N. Con số này là N trong mọi phép so ở V1-V8.


-- ───────────────────────────────────────────────────────────────────────────
-- V0b — CỘT scope_account_id ĐÃ TỒN TẠI CHƯA.
--
-- Kiểm tra migration chưa từng chạy (một phần hay toàn phần). Nếu cột đã có
-- thì hoặc ai đó đã apply, hoặc một lần chạy trước đã đứt giữa chừng —
-- cả hai trường hợp đều phải dừng và đọc lại trạng thái trước khi làm tiếp.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  ordinal_position AS stt,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'iap_mgmt'
  AND table_name   = 'price_tier_templates'
ORDER BY ordinal_position;

-- KỲ VỌNG: đúng 6 dòng, theo thứ tự:
--   1 id              uuid                        NO   gen_random_uuid()
--   2 scope_type      text                        NO   (null)
--   3 scope_app_id    uuid                        YES  (null)
--   4 uploaded_at     timestamp with time zone    NO   now()
--   5 uploaded_by     text                        NO   (null)   ← NOT NULL, không default
--   6 source_filename text                        YES  (null)
--
--   ⚠ KHÔNG được có `scope_account_id`. Nếu thấy nó → DỪNG, migration đã
--     chạy (một phần?) rồi; chạy tiếp V0c/V0d rồi báo lại toàn bộ trạng thái.


-- ───────────────────────────────────────────────────────────────────────────
-- V0c — TÊN THẬT CỦA CONSTRAINT + ĐỊNH NGHĨA INDEX.
--
-- ⚠ Migration gốc (20260519000000, dòng 25 và 31-35) khai báo cả hai CHECK
--   mà KHÔNG đặt tên → Postgres tự sinh tên. Migration mới phải DROP đúng
--   tên đó. Repo đã vấp một lần ở chỗ này: 20260515010000 dòng 27-31 phải
--   DROP hai tên khác nhau kèm comment "resilience against Postgres
--   constraint-naming variations". Không đoán tên — đọc ở đây.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  conname                        AS ten_that,
  CASE contype WHEN 'c' THEN 'CHECK'
               WHEN 'p' THEN 'PRIMARY KEY'
               WHEN 'f' THEN 'FOREIGN KEY'
               WHEN 'u' THEN 'UNIQUE'
               ELSE contype::text END AS loai,
  pg_get_constraintdef(oid)      AS dinh_nghia
FROM pg_constraint
WHERE conrelid = 'iap_mgmt.price_tier_templates'::regclass
ORDER BY contype, conname;

-- KỲ VỌNG: 4 dòng —
--   • 1 PRIMARY KEY  (id)
--   • 1 FOREIGN KEY  (scope_app_id) → iap_mgmt.apps(id) ON DELETE CASCADE
--   • 2 CHECK, một cái chứa `scope_type = ANY (ARRAY['GLOBAL','APP'])`,
--       một cái chứa cả `scope_app_id IS NULL` / `IS NOT NULL`
--   → CHÉP LẠI 2 tên CHECK ở cột `ten_that`. Đó là tên đi vào
--     DROP CONSTRAINT của migration.

-- V0c-2 — index. Cần định nghĩa chính xác của partial unique index GLOBAL
-- (migration sẽ DROP nó) và của index APP (migration KHÔNG được đụng).
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'iap_mgmt'
  AND tablename  = 'price_tier_templates'
ORDER BY indexname;

-- KỲ VỌNG: 4 dòng —
--   • price_tier_templates_pkey                        (PK, tự sinh)
--   • idx_iap_mgmt_price_tier_templates_app_unique     UNIQUE … (scope_app_id)
--                                                      WHERE scope_type='APP'
--                                                      ⟵ GIỮ NGUYÊN
--   • idx_iap_mgmt_price_tier_templates_global_unique  UNIQUE … (scope_type)
--                                                      WHERE scope_type='GLOBAL'
--                                                      ⟵ migration sẽ DROP
--   • idx_iap_mgmt_price_tier_templates_uploaded       (uploaded_at DESC)
--   Tên khác kỳ vọng → dùng tên thật, đừng dùng tên trong plan.


-- ───────────────────────────────────────────────────────────────────────────
-- V0d — TEMPLATE GLOBAL: SỐ LIỆU THẬT (U3).
--
-- Đối chiếu với 1140 entry / 12 territory đã dán. Ba con số ở đây đi thẳng
-- vào: (a) phép nhân N × entry_count ở guard RAISE EXCEPTION, (b) verify
-- V4/V4b sau khi apply.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  t.id                              AS global_template_id,
  t.uploaded_at,
  t.uploaded_by,
  t.source_filename,
  COUNT(e.tier_id)                  AS entry_count,
  COUNT(DISTINCT e.tier_id)         AS tier_count,
  COUNT(DISTINCT e.territory_code)  AS territory_count,
  COUNT(*) FILTER (WHERE e.proceeds IS NULL) AS entry_khong_co_proceeds
FROM iap_mgmt.price_tier_templates t
LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'GLOBAL'
GROUP BY t.id, t.uploaded_at, t.uploaded_by, t.source_filename;

-- KỲ VỌNG:
--   • ĐÚNG 1 dòng (partial unique index ép tối đa 1 GLOBAL).
--     0 dòng = không có gì để nhân bản → DỪNG, báo lại.
--   • entry_count     = 1140   ← nếu khác, số đã dán không còn đúng
--   • territory_count = 12
--   • tier_count      = 95     (1140 ÷ 12 — kiểm tra ma trận có đầy không)
--   • uploaded_by / uploaded_at / source_filename: CHÉP LẠI. Đây là giá trị
--     "bản gốc" mà §3.4 quyết định KHÔNG copy sang bản sao — nhưng vẫn cần
--     ghi vào dòng actions_log dấu vết và vào phần mô tả migration.

-- V0d-2 — ma trận có đầy không, hay sparse.
-- Ảnh hưởng tới verify V4c (so nội dung từng ô sau khi apply).
SELECT
  e.territory_code,
  MIN(e.currency_code)      AS currency,
  COUNT(*)                  AS so_tier
FROM iap_mgmt.price_tier_template_entries e
JOIN iap_mgmt.price_tier_templates t
  ON t.id = e.template_id AND t.scope_type = 'GLOBAL'
GROUP BY e.territory_code
ORDER BY e.territory_code;

-- KỲ VỌNG: 12 dòng. Nếu MỌI dòng đều so_tier = 95 → ma trận đầy (95×12=1140).
--   Nếu so_tier khác nhau giữa các territory → template sparse; vẫn nhân bản
--   được y hệt (copy nguyên trạng), chỉ là verify V4c phải so theo từng ô
--   chứ không so bằng phép nhân.


-- ═══════════════════════════════════════════════════════════════════════════
-- BỔ SUNG — không quyết định gì, nhưng cần chụp TRƯỚC để verify SAU
-- ═══════════════════════════════════════════════════════════════════════════

-- V0e — 3 template APP hiện có. ⚠ LƯU KẾT QUẢ LẠI.
-- Verify V7 sau khi apply sẽ chạy ĐÚNG query này và so từng cột: migration
-- không được chạm vào chúng. Không có ảnh "trước" thì V7 không chứng minh
-- được gì.
SELECT
  t.id                AS template_id,
  a.apple_app_id,
  a.name              AS app_name,
  a.asc_account_id,
  t.uploaded_at,
  t.uploaded_by,
  t.source_filename,
  COUNT(e.tier_id)    AS entry_count
FROM iap_mgmt.price_tier_templates t
JOIN iap_mgmt.apps a ON a.id = t.scope_app_id
LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'APP'
GROUP BY t.id, a.apple_app_id, a.name, a.asc_account_id,
         t.uploaded_at, t.uploaded_by, t.source_filename
ORDER BY a.name;

-- KỲ VỌNG: 3 dòng (theo số đã dán). Chụp màn hình / copy ra file.


-- V0f — hai account có trùng issuer_id không.
-- Thuần thông tin, KHÔNG đổi kế hoạch. Runbook seed pool key §1 nêu: cùng
-- issuer_id = cùng một team Apple. Nếu có 2 dòng account trỏ cùng team thì
-- sau migration chúng vẫn có 2 template riêng (đúng, vì tool phân giải theo
-- account đang chọn chứ không theo team) — chỉ là để Manager không ngạc
-- nhiên khi thấy 2 tab template cho thứ mình coi là một team.
SELECT issuer_id, COUNT(*) AS so_account, string_agg(id, ', ' ORDER BY id) AS cac_account
FROM public.asc_accounts
WHERE is_active = true
GROUP BY issuer_id
HAVING COUNT(*) > 1;

-- KỲ VỌNG: 0 dòng = mỗi account một team riêng. Có dòng = bình thường, chỉ
--   cần biết trước.


-- ═══════════════════════════════════════════════════════════════════════════
-- SAU KHI CHẠY XONG — gửi lại 6 kết quả (V0, V0-summary, V0b, V0c, V0c-2,
-- V0d, V0d-2, V0e, V0f). Migration đầy đủ + V1-V8 sẽ được viết dựa trên
-- đúng những con số/tên đó, không dựa vào trí nhớ hay giả định.
-- CHƯA APPLY GÌ CẢ.
-- ═══════════════════════════════════════════════════════════════════════════
