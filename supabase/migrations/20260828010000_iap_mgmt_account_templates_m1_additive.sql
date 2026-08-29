-- ============================================================
-- [ACCOUNT-default-template] M-1 — THUẦN CỘNG THÊM. Không xoá gì.
-- ============================================================
--
-- ── HƯỚNG DẪN APPLY — đọc đủ 4 bước, không có bước sửa file ──────────────
--
-- BƯỚC 1. Mở file:
--            supabase/migrations/20260828010000_iap_mgmt_account_templates_m1_additive.sql
--         (chính là file đang đọc — 497 dòng)
--
-- BƯỚC 2. Copy TOÀN BỘ 497 dòng. GIỮ NGUYÊN, KHÔNG xoá, KHÔNG sửa dòng nào.
--         Hai dòng mốc để đối chiếu đã copy đủ chưa:
--            • câu lệnh CHẠY ĐƯỢC đầu tiên của file  =  BEGIN;    (dòng 122)
--            • dòng CUỐI CÙNG của file               =  COMMIT;   (dòng 497)
--         Thiếu một trong hai ⇒ đã copy hụt, copy lại.
--         ⚠ Hai con số dòng ở trên đúng với phiên bản file này. Nếu file
--           được sửa về sau, hãy tin vào MÔ TẢ (câu lệnh chạy được đầu
--           tiên / dòng cuối cùng) chứ không phải con số.
--
-- BƯỚC 3. Dán vào Supabase SQL Editor. Bấm Run MỘT lần.
--
-- BƯỚC 4. Chạy verify, theo thứ tự, mở file:
--            docs/iap-management/queries/verify-account-template-duplication.sql
--         M1-V0 (bảng kiểm gộp, một dòng kết quả) → M1-V2 (CỔNG) → M1-V1…V7
--         → M1-V8 (smoke test bấm tay trên giao diện).
--
-- ⚠ KHÔNG có bước dry-run. Quyết định của Manager (phương án C), lý do:
--   M-1 tự dry-run chính nó — mọi guard bên trong là RAISE EXCEPTION, mà
--   một exception trong transaction làm CẢ transaction rollback, tức sai
--   thì KHÔNG GHI GÌ. Và rollback của M-1 rẻ bất thường vì M-1 KHÔNG XOÁ
--   gì: 1 DELETE + 2 DROP TABLE là về trạng thái cũ (xem ĐƯỜNG LUI dưới).
--
-- ⚠ KHI GUARD NỔ, MÀN HÌNH SẼ HIỆN GÌ: một lỗi đỏ dạng
--       ERROR: GUARD: <mô tả>   (hoặc ERROR: BACKUP RỖNG…, TRẠNG THÁI…)
--   Đó là THẤT BẠI AN TOÀN, không phải hỏng: transaction đã rollback,
--   database y như trước khi bấm Run, không dòng nào được ghi. Sửa nguyên
--   nhân rồi chạy lại cả file.
--   Ngược lại, chạy THÀNH CÔNG thì các dòng RAISE NOTICE (nếu SQL Editor
--   hiện notice) sẽ kết thúc bằng: 'M-1 HOÀN TẤT — … GLOBAL (còn nguyên).'
--   Nếu SQL Editor không hiện notice thì đừng lo — bằng chứng thật là
--   M1-V0 ở bước 4, không phải notice.
--
-- ── ĐƯỜNG LUI (nếu verify lệch) ──────────────────────────────────────────
--     DELETE FROM iap_mgmt.price_tier_templates
--      WHERE scope_type = 'ACCOUNT' AND origin_note IS NOT NULL;   -- CASCADE
--     DROP TABLE IF EXISTS iap_mgmt.price_tier_templates_backup_global;
--     DROP TABLE IF EXISTS iap_mgmt.price_tier_template_entries_backup_global;
--   Hai cột thêm mới (scope_account_id, origin_note) và CHECK đã nới có thể
--   để nguyên — chúng không ảnh hưởng code cũ (xem phần "M-1 an toàn với
--   code CŨ" bên dưới).
--
-- ── FILE LIÊN QUAN (đường dẫn đầy đủ, không viết tắt) ─────────────────────
--   M-2 (phần xoá, apply SAU khi code mới đã deploy):
--     supabase/migrations/20260828020000_iap_mgmt_account_templates_m2_drop_global.sql
--   Verify:
--     docs/iap-management/queries/verify-account-template-duplication.sql
--   Plan:
--     docs/iap-management/plan-account-template-duplication.md
--
-- ── VÌ SAO TÁCH LÀM HAI (X1) ──────────────────────────────────────────
-- Bản gộp trước đó làm 3 việc trong một transaction: (a) thêm cột + scope
-- ACCOUNT, (b) nhân bản 6 template, (c) XOÁ GLOBAL + thu hẹp CHECK.
-- CHỈ (c) mới làm code cũ gãy — nên (c) tách sang M-2, apply SAU khi code
-- mới đã deploy. Kết quả: **KHÔNG CÒN CỬA SỔ apply→deploy.**
--
-- M-1 an toàn với code CŨ. Đã grep 11 site chạm price_tier_templates,
-- KHÔNG site nào thiếu bộ lọc — 6 dòng ACCOUNT mới không lọt vào bất kỳ
-- query nào của code cũ:
--
--   templates.ts:101-103 + applyScopeFilter:90-93  .eq(scope_type,'GLOBAL')
--                                                    .is(scope_app_id,null)
--                                                  / .eq(scope_type,'APP')…
--   templates.ts:264-267  listAppsWithTemplates     .eq(scope_type,'APP')
--   templates.ts:520 / :615 / :628                  .eq(id, …)
--   template-matrix.ts:193-199 fetchTemplateId      .eq(scope_type, …)
--                                                    + .is/.eq(scope_app_id)
--   template-matrix.ts:258-260                      .eq(id, …)
--   per-app-matrix/[appId]/page.tsx:34-37           .eq(scope_type,'GLOBAL')
--   pricing-templates/[templateId]/route.ts:41-44   .eq(id, …)
--
--   ⇒ `.maybeSingle()` trên nhánh GLOBAL vẫn thấy ĐÚNG 1 dòng (M-1 không
--     đụng dòng GLOBAL). Không có PGRST116.
--   ⇒ Đường GHI của code cũ (replaceTemplate, templates.ts:530-536) không
--     set scope_account_id → NULL → thoả CHECK coherence mới ở cả hai
--     nhánh GLOBAL và APP. Manager vẫn Replace/Remove được như thường.
--
-- ⚠ NHƯNG: đừng Replace/Remove Default Template ở tab Settings trong
--   khoảng giữa M-1 và M-2. 6 bản sao được chụp tại thời điểm M-1; thay
--   bản gốc sau đó sẽ làm chúng lệch. M-2 có guard bắt đúng ca này (so
--   id + số entry của GLOBAL với bảng backup) và sẽ TỪ CHỐI chạy.
--
-- ── M-1 LÀM GÌ ────────────────────────────────────────────────────────
--   0. backup GLOBAL (header + entries) — ảnh chụp đúng thứ được nhân bản
--   1. ADD COLUMN scope_account_id + origin_note
--   2. MỞ RỘNG cả hai CHECK → ('GLOBAL','APP','ACCOUNT')
--   3. CREATE unique index theo account (replace-only cho scope mới)
--   4. INSERT 6 header ACCOUNT + 6×1140 entry, có guard
--   5. INSERT dòng audit mang dấu vết tác giả gốc
--   GLOBAL vẫn còn nguyên. Index global_unique vẫn còn nguyên.
--
-- ── SỐ LIỆU TIỀN ĐIỀU KIỆN (đọc thật từ V0-V0f) ───────────────────────
--   public.asc_accounts   6 dòng, tất cả is_active = true
--   GLOBAL template       3cbdeaa2… · 1140 entry · 95 tier · 12 territory
--   ma trận               ĐẦY (95 × 12 = 1140), 0 entry thiếu proceeds
--   template APP          3 (2 vng-corp, 1 vnggames-vn) — KHÔNG ĐỤNG
--   scope_account_id      CHƯA tồn tại · trùng issuer_id: không có
--
-- Forward-only (CLAUDE.md invariant #7).
--
-- ── CA HỎNG PHẢI CHỐNG: "header có, entry rỗng" ───────────────────────
-- Nếu đứt giữa bước 4a và 4b, N header ACCOUNT tồn tại với 0 entry.
-- getAccountTemplate() sẽ trả template KHÔNG NULL NHƯNG RỖNG →
-- pricing-orchestration.ts:431 lọc ra 0 entry → POST chỉ giá USA, log
-- "matched=0", đi tiếp. UI báo "đã có template", giá lại ra như APPLE.
-- IM LẶNG. Ba lớp chống: BEGIN/COMMIT · guard RAISE EXCEPTION ở bước 4 ·
-- verify M1-V5 sau khi apply.
--
-- ⚠ BEGIN/COMMIT tường minh là lần đầu trong repo (grep 'BEGIN;' →
--   0 hit). Cố ý: không phụ thuộc Supabase SQL Editor có tự bọc hay không.
-- ============================================================

BEGIN;

-- ============================================================
-- BƯỚC 0 — BACKUP
-- ============================================================
-- Với thiết kế 2-migration, đường lui CHÍNH sau M-1 là "xoá 6 dòng
-- ACCOUNT" (GLOBAL chưa mất — xem X3 trong plan). Bảng backup vẫn tạo ở
-- đây, và nó phục vụ hai việc KHÁC:
--   1. là mốc so nội dung cho verify M1-V5 (so từng ô bản sao với bản gốc);
--   2. là mốc để M-2 phát hiện "ai đó đã Replace Default giữa M-1 và M-2".
-- Chụp ở M-1 chứ không ở M-2 là cố ý: cần ảnh của ĐÚNG thứ đã được nhân
-- bản, không phải ảnh của thứ đang nằm đó lúc xoá.
CREATE TABLE IF NOT EXISTS iap_mgmt.price_tier_templates_backup_global AS
  SELECT * FROM iap_mgmt.price_tier_templates WHERE scope_type = 'GLOBAL';

CREATE TABLE IF NOT EXISTS iap_mgmt.price_tier_template_entries_backup_global AS
  SELECT e.*
  FROM iap_mgmt.price_tier_template_entries e
  JOIN iap_mgmt.price_tier_templates t
    ON t.id = e.template_id AND t.scope_type = 'GLOBAL';

COMMENT ON TABLE iap_mgmt.price_tier_templates_backup_global IS
  'Ảnh chụp template GLOBAL tại thời điểm M-1 [ACCOUNT-default-template] '
  '(20260828010000) — đúng bản đã được nhân bản. M-2 so với bảng này để '
  'phát hiện Default bị thay giữa hai lần apply. Chỉ xoá khi Manager xác '
  'nhận template ACCOUNT chạy đúng qua ít nhất một lần submit thật.';
COMMENT ON TABLE iap_mgmt.price_tier_template_entries_backup_global IS
  'Ảnh chụp 1140 entry của template GLOBAL tại M-1 (20260828010000).';

DO $$
DECLARE v_backup_entries INT;
BEGIN
  SELECT COUNT(*) INTO v_backup_entries
    FROM iap_mgmt.price_tier_template_entries_backup_global;
  IF v_backup_entries = 0 THEN
    IF EXISTS (SELECT 1 FROM iap_mgmt.price_tier_templates WHERE scope_type='GLOBAL') THEN
      RAISE EXCEPTION
        'BACKUP RỖNG nhưng GLOBAL vẫn còn — CREATE TABLE AS không copy được '
        'gì. Dừng, không đụng dữ liệu thật.';
    ELSE
      RAISE EXCEPTION
        'Không có GLOBAL để nhân bản VÀ backup rỗng. Trạng thái không xác '
        'định — chạy V0d rồi báo lại trước khi làm gì tiếp.';
    END IF;
  END IF;
  RAISE NOTICE '[M1/0] backup OK: % entry.', v_backup_entries;
END $$;

-- ============================================================
-- BƯỚC 1 — hai cột mới
-- ============================================================
-- ⚠ E3: HAI CỘT SCOPE, HAI KIỂU KHÁC NHAU — CỐ Ý, KHÔNG PHẢI SÓT FK.
--   scope_app_id     UUID + FK ON DELETE CASCADE → iap_mgmt.apps(id)
--                    (cùng schema nên FK được)
--   scope_account_id TEXT, SOFT-REF, KHÔNG FK — public.asc_accounts ở
--                    schema khác, CLAUDE.md invariant #9. Cùng khuôn với
--                    iap_mgmt.apps.asc_account_id (20260520000000:12-17)
--                    và iap_mgmt.asc_account_keys.account_id
--                    (20260825010000:15-26).
--   ⇒ Giá phải trả, nói thẳng: xoá account bên CPP KHÔNG cascade sang đây;
--     template mồ côi nằm lại. Hiện deleteAccount là SOFT delete
--     (is_active=false, asc-account-repository.ts:194) nên dòng account
--     không biến mất — nhưng account đã tắt thì không surface nào hiện
--     template của nó nữa.
ALTER TABLE iap_mgmt.price_tier_templates
  ADD COLUMN IF NOT EXISTS scope_account_id TEXT;

ALTER TABLE iap_mgmt.price_tier_templates
  ADD COLUMN IF NOT EXISTS origin_note TEXT;

COMMENT ON COLUMN iap_mgmt.price_tier_templates.scope_account_id IS
  'public.asc_accounts.id — SOFT REF, cố ý KHÔNG có FK (cross-schema, '
  'CLAUDE.md invariant #9). Bắt buộc NOT NULL khi scope_type=''ACCOUNT'', '
  'bắt buộc NULL với scope khác — ép bằng CHECK coherence, không phải bằng '
  'NOT NULL trên cột.';

COMMENT ON COLUMN iap_mgmt.price_tier_templates.origin_note IS
  'Dấu vết nguồn gốc dạng câu đọc được. NOT NULL = dòng do migration/hệ '
  'thống sinh, không phải Manager upload — guard của M-1 dùng đúng tính '
  'chất này để phân biệt bản nhân bản với template Manager tự upload sau. '
  'source_filename giữ nguyên tên file gốc (nó đang được render font-mono '
  'như tên file thật — AppPricingTemplateSection.tsx:165).';

-- ============================================================
-- BƯỚC 2 — MỞ RỘNG cả HAI CHECK (E1)
-- ============================================================
-- ⚠ E1: có HAI CHECK, không phải một. Tên đọc từ V0c (pg_constraint),
--   KHÔNG đoán — migration 20260519000000 khai báo cả hai KHÔNG ĐẶT TÊN:
--     price_tier_templates_scope_type_check
--     price_tier_templates_check
--   Sửa mỗi cái đầu thì INSERT scope_type='ACCOUNT' vẫn bị cái thứ hai
--   chặn (ACCOUNT không khớp nhánh nào của nó).
--
-- ⚠ BỌC TRONG ĐIỀU KIỆN — đây là hệ quả của việc tách 2 migration:
--   nếu M-2 đã chạy (đã thu hẹp CHECK, đã xoá GLOBAL) mà ai đó chạy lại
--   M-1, một lệnh ALTER vô điều kiện sẽ ÂM THẦM cho phép 'GLOBAL' trở lại.
--   Điều kiện dưới đây làm M-1 không thể lùi bước tiến của M-2.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM iap_mgmt.price_tier_templates WHERE scope_type='GLOBAL') THEN
    RAISE NOTICE
      '[M1/2] BỎ QUA nới CHECK — không còn dòng GLOBAL nào, nghĩa là M-2 đã '
      'chạy. Không nới lại (sẽ cho phép GLOBAL quay về).';
  ELSE
    ALTER TABLE iap_mgmt.price_tier_templates
      DROP CONSTRAINT IF EXISTS price_tier_templates_scope_type_check;
    ALTER TABLE iap_mgmt.price_tier_templates
      ADD CONSTRAINT price_tier_templates_scope_type_check
      CHECK (scope_type IN ('GLOBAL', 'APP', 'ACCOUNT'));

    -- DROP cả tên gốc (auto-sinh) lẫn tên mới → chạy lại không vỡ.
    ALTER TABLE iap_mgmt.price_tier_templates
      DROP CONSTRAINT IF EXISTS price_tier_templates_check;
    ALTER TABLE iap_mgmt.price_tier_templates
      DROP CONSTRAINT IF EXISTS price_tier_templates_scope_coherent_check;
    ALTER TABLE iap_mgmt.price_tier_templates
      ADD CONSTRAINT price_tier_templates_scope_coherent_check CHECK (
           (scope_type = 'GLOBAL'  AND scope_app_id IS NULL     AND scope_account_id IS NULL)
        OR (scope_type = 'APP'     AND scope_app_id IS NOT NULL AND scope_account_id IS NULL)
        OR (scope_type = 'ACCOUNT' AND scope_app_id IS NULL     AND scope_account_id IS NOT NULL)
      );
    RAISE NOTICE '[M1/2] đã nới CHECK → GLOBAL | APP | ACCOUNT.';
  END IF;
END $$;

-- ============================================================
-- BƯỚC 3 — unique index cho scope mới (replace-only)
-- ============================================================
-- Tạo TRƯỚC khi INSERT để nó bảo vệ chính lệnh INSERT đó.
-- Cùng khuôn với idx_..._app_unique (20260519000000:45-47).
-- Cố ý KHÔNG dùng UNIQUE(scope_type, scope_account_id): với dòng APP cặp
-- đó là ('APP', NULL), mà NULL khác NULL trong unique index — nó "chạy
-- được" nhờ ngữ nghĩa NULL chứ không nhờ ý định.
--
-- idx_..._global_unique GIỮ NGUYÊN ở M-1 (GLOBAL vẫn còn) → M-2 mới drop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_iap_mgmt_price_tier_templates_account_unique
  ON iap_mgmt.price_tier_templates(scope_account_id)
  WHERE scope_type = 'ACCOUNT';

-- ============================================================
-- BƯỚC 4 — nhân bản: 6 header + 6×1140 entry
-- ============================================================
DO $$
DECLARE
  -- ── CÁCH B: 6 id NHÚNG TƯỜNG MINH, dán từ output V0 (đã xác nhận 6 chuỗi
  --    Manager dùng CHÍNH LÀ cột asc_accounts.id). KHÔNG SELECT chéo schema.
  --    ⚠ M-1 KHÔNG tự đối chiếu được danh sách này với public.asc_accounts —
  --      đó là cái giá của cách B. Verify M1-V2 làm việc đó và là CỔNG BẮT
  --      BUỘC trước khi deploy code.
  v_accounts       TEXT[] := ARRAY[
                       'vng-corp',
                       'vng-sing',
                       'vnggames-vn',
                       'vnggames-sing',
                       'mpt',
                       'NCV'
                     ];
  -- PL/pgSQL khởi tạo biến theo THỨ TỰ khai báo nên v_n đọc được v_accounts.
  -- Cố ý không chép danh sách lần hai: hai bản sao là chỗ để sau này sửa một
  -- bên quên bên kia, và guard sẽ so với số sai.
  v_n              INT := array_length(v_accounts, 1);
  v_app_before     INT;
  v_app_after      INT;
  v_global_id      UUID;
  v_global_by      TEXT;
  v_global_at      TIMESTAMPTZ;
  v_global_file    TEXT;
  v_global_entries INT;
  v_headers_ins    INT;
  v_entries_ins    INT;
  v_acct_templates INT;
  v_total_entries  INT;
  v_bad            TEXT;
BEGIN
  -- Bất biến "không đụng template APP": so TRƯỚC/SAU, KHÔNG chốt hằng số 3.
  -- Manager có thể upload thêm một app-template giữa lúc duyệt file này và
  -- lúc apply; guard chốt số 3 sẽ từ chối apply vì một lý do hợp lệ.
  SELECT COUNT(*) INTO v_app_before
    FROM iap_mgmt.price_tier_templates WHERE scope_type = 'APP';

  -- Số entry gốc: đọc từ BẢNG BACKUP, không gõ hằng số.
  SELECT COUNT(*) INTO v_global_entries
    FROM iap_mgmt.price_tier_template_entries_backup_global;

  SELECT id, uploaded_by, uploaded_at, source_filename
    INTO v_global_id, v_global_by, v_global_at, v_global_file
    FROM iap_mgmt.price_tier_templates WHERE scope_type = 'GLOBAL';

  -- ── IDEMPOTENCY.
  --    ⚠ Ưu điểm THẬT của việc tách: M-1 KHÔNG phá nguồn copy của chính nó.
  --      Chạy lại M-1 khi chưa chạy M-2 ⇒ GLOBAL vẫn còn ⇒ chạy lại được
  --      ĐẦY ĐỦ, không chỉ "an toàn". Bản gộp trước đây không có tính chất
  --      này (xoá GLOBAL xong là mất nguồn).
  IF v_global_id IS NULL THEN
    SELECT COUNT(*) INTO v_acct_templates
      FROM iap_mgmt.price_tier_templates WHERE scope_type = 'ACCOUNT';
    IF v_acct_templates = v_n THEN
      RAISE NOTICE
        '[M1/4] BỎ QUA — M-2 đã chạy (không còn GLOBAL) và đã có % template '
        'ACCOUNT. Không có gì để làm.', v_acct_templates;
      RETURN;
    END IF;
    RAISE EXCEPTION
      'TRẠNG THÁI KHÔNG XÁC ĐỊNH: không có GLOBAL để nhân bản, và số template '
      'ACCOUNT là % (kỳ vọng % nếu đã chạy xong). Dừng — chạy M1-V1/V2 rồi '
      'báo lại.', v_acct_templates, v_n;
  END IF;

  RAISE NOTICE '[M1/4] nguồn: GLOBAL % · % entry · upload % bởi %',
    v_global_id, v_global_entries, v_global_at, v_global_by;

  -- ── 4a. Header ACCOUNT.
  --    NOT EXISTS: chạy lại không tạo trùng, và KHÔNG ghi đè template mà
  --    Manager đã tự upload cho account đó.
  --    uploaded_by = 'SYSTEM_MIGRATION' — tiền lệ 20260519000000:88.
  --      ⚠ Không phải chuyện thẩm mỹ: uploaded_by là ĐIỀU KIỆN RẼ NHÁNH cho
  --        modal "đang ghi đè template của người khác"
  --        (AppPricingTemplateSection.tsx:97-103, PerAppTemplateTab.tsx:154-157).
  --        Copy minhgv@ sang bản sao sẽ TẮT cảnh báo đó cho đúng người đó.
  --    source_filename: giữ nguyên bản gốc — đúng sự thật, 1140 ô đúng là từ
  --      file đó. Dấu vết nhân bản đi vào origin_note.
  INSERT INTO iap_mgmt.price_tier_templates
    (scope_type, scope_app_id, scope_account_id,
     uploaded_at, uploaded_by, source_filename, origin_note)
  SELECT
    'ACCOUNT', NULL, acct, NOW(), 'SYSTEM_MIGRATION', v_global_file,
    format(
      'Nhân bản từ template GLOBAL %s (upload %s bởi %s, %s entry) — '
      'migration M-1 20260828010000 [ACCOUNT-default-template]. '
      'Chưa ai cấu hình riêng cho account này.',
      v_global_id, v_global_at, v_global_by, v_global_entries)
  FROM unnest(v_accounts) AS acct
  WHERE NOT EXISTS (
    SELECT 1 FROM iap_mgmt.price_tier_templates t
    WHERE t.scope_type = 'ACCOUNT' AND t.scope_account_id = acct);
  GET DIAGNOSTICS v_headers_ins = ROW_COUNT;
  RAISE NOTICE '[M1/4a] header ACCOUNT tạo mới: %', v_headers_ins;

  -- ── 4b. Copy entry.
  --    ⚠ CÂU NGUY HIỂM NHẤT CỦA CẢ FILE. CROSS JOIN nhân mọi entry gốc với
  --      mọi header ACCOUNT; NOT EXISTS là thứ DUY NHẤT ngăn việc chèn thêm
  --      entry vào template mà Manager đã tự upload. Không được bỏ, không
  --      được đổi thành LEFT JOIN.
  INSERT INTO iap_mgmt.price_tier_template_entries
    (template_id, tier_id, territory_code, currency_code, customer_price, proceeds)
  SELECT t.id, e.tier_id, e.territory_code, e.currency_code, e.customer_price, e.proceeds
  FROM iap_mgmt.price_tier_templates t
  CROSS JOIN iap_mgmt.price_tier_template_entries e
  WHERE t.scope_type = 'ACCOUNT'
    AND e.template_id = v_global_id
    AND NOT EXISTS (
      SELECT 1 FROM iap_mgmt.price_tier_template_entries x
      WHERE x.template_id = t.id);
  GET DIAGNOSTICS v_entries_ins = ROW_COUNT;
  RAISE NOTICE '[M1/4b] entry copy: % (kỳ vọng % × % = %)',
    v_entries_ins, v_headers_ins, v_global_entries, v_headers_ins * v_global_entries;

  -- ── GUARD. "0 dòng" KHÔNG ĐƯỢC trông giống "thành công".
  --    Kiểm TRẠNG THÁI CUỐI chứ không chỉ delta: delta đúng mà trạng thái
  --    cuối sai (một lần chạy trước đứt giữa chừng) vẫn phải nổ.
  SELECT COUNT(*) INTO v_acct_templates
    FROM iap_mgmt.price_tier_templates WHERE scope_type = 'ACCOUNT';
  IF v_acct_templates <> v_n THEN
    RAISE EXCEPTION 'GUARD: có % template ACCOUNT, kỳ vọng %.',
      v_acct_templates, v_n;
  END IF;

  SELECT string_agg(acct, ', ') INTO v_bad
  FROM unnest(v_accounts) AS acct
  WHERE NOT EXISTS (
    SELECT 1 FROM iap_mgmt.price_tier_templates t
    WHERE t.scope_type = 'ACCOUNT' AND t.scope_account_id = acct);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'GUARD: account chưa có template sau INSERT: %', v_bad;
  END IF;

  -- Mỗi template DO MIGRATION TẠO (origin_note NOT NULL) phải có ĐÚNG số
  -- entry của bản gốc. Template Manager tự upload sau có origin_note NULL
  -- nên không bị ràng buộc. ⚠ Đây là lớp bắt trực tiếp ca "header có,
  -- entry rỗng".
  SELECT string_agg(format('%s(%s)', x.scope_account_id, x.cnt), ', ') INTO v_bad
  FROM (
    SELECT t.scope_account_id, COUNT(e.tier_id) AS cnt
    FROM iap_mgmt.price_tier_templates t
    LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
    WHERE t.scope_type = 'ACCOUNT' AND t.origin_note IS NOT NULL
    GROUP BY t.scope_account_id
    HAVING COUNT(e.tier_id) <> v_global_entries
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'GUARD: template ACCOUNT có số entry SAI (kỳ vọng % mỗi cái): %. Đây '
      'đúng là ca "header có, entry rỗng/thiếu" — rollback.',
      v_global_entries, v_bad;
  END IF;

  SELECT COUNT(*) INTO v_total_entries
  FROM iap_mgmt.price_tier_template_entries e
  JOIN iap_mgmt.price_tier_templates t
    ON t.id = e.template_id AND t.scope_type='ACCOUNT' AND t.origin_note IS NOT NULL;
  IF v_total_entries <> v_n * v_global_entries THEN
    RAISE EXCEPTION 'GUARD: tổng entry nhân bản = %, kỳ vọng % × % = %.',
      v_total_entries, v_n, v_global_entries, v_n * v_global_entries;
  END IF;

  -- GLOBAL phải CÒN NGUYÊN sau M-1. Đây là điểm khác biệt cốt lõi với bản
  -- gộp cũ, và là thứ làm code cũ tiếp tục chạy được.
  IF NOT EXISTS (SELECT 1 FROM iap_mgmt.price_tier_templates WHERE id = v_global_id) THEN
    RAISE EXCEPTION 'GUARD: template GLOBAL biến mất trong M-1. M-1 không '
      'được phép xoá gì — đó là việc của M-2.';
  END IF;

  SELECT COUNT(*) INTO v_app_after
    FROM iap_mgmt.price_tier_templates WHERE scope_type = 'APP';
  IF v_app_after <> v_app_before THEN
    RAISE EXCEPTION 'GUARD: số template APP đổi từ % thành %. M-1 KHÔNG '
      'được chạm vào chúng.', v_app_before, v_app_after;
  END IF;

  RAISE NOTICE '[M1/guard] OK — % ACCOUNT × % entry = % dòng · GLOBAL còn '
    'nguyên · APP giữ nguyên %.',
    v_n, v_global_entries, v_total_entries, v_app_after;

  -- ── 4c. Audit. Nơi DUY NHẤT tác giả gốc còn sống sót sau khi M-2 xoá
  --    dòng GLOBAL. 'PRICE_TIER_IMPORT' ĐÃ có trong CHECK
  --    (action-types.ts:66) ⇒ KHÔNG cần action_type mới ⇒ không chạm bẫy
  --    KB §9 P2 (CHECK silent-fail).
  INSERT INTO iap_mgmt.actions_log (actor, action_type, payload)
  SELECT
    'SYSTEM_MIGRATION', 'PRICE_TIER_IMPORT',
    jsonb_build_object(
      'op',                        'duplicate_global_to_account',
      'migration',                 '20260828010000 (M-1)',
      'scope',                     'ACCOUNT',
      'scope_account_id',          t.scope_account_id,
      'template_id',               t.id,
      'source_global_template_id', v_global_id,
      'source_uploaded_by',        v_global_by,
      'source_uploaded_at',        v_global_at,
      'source_filename',           v_global_file,
      'entry_count',               v_global_entries)
  FROM iap_mgmt.price_tier_templates t
  WHERE t.scope_type = 'ACCOUNT'
    AND t.origin_note IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM iap_mgmt.actions_log l
      WHERE l.action_type = 'PRICE_TIER_IMPORT'
        AND l.payload ->> 'op' = 'duplicate_global_to_account'
        AND l.payload ->> 'template_id' = t.id::text);
END $$;

-- ============================================================
-- BƯỚC 5 — chốt trạng thái cuối của M-1
-- ============================================================
DO $$
DECLARE v_global INT; v_acct INT; v_app INT;
BEGIN
  SELECT COUNT(*) FILTER (WHERE scope_type='GLOBAL'),
         COUNT(*) FILTER (WHERE scope_type='ACCOUNT'),
         COUNT(*) FILTER (WHERE scope_type='APP')
    INTO v_global, v_acct, v_app
  FROM iap_mgmt.price_tier_templates;

  IF v_global <> 1 THEN
    RAISE EXCEPTION 'GUARD cuối M-1: kỳ vọng ĐÚNG 1 template GLOBAL còn lại, '
      'thấy %. Code cũ đọc nhánh GLOBAL bằng .maybeSingle() — khác 1 là gãy.',
      v_global;
  END IF;

  RAISE NOTICE 'M-1 HOÀN TẤT — % ACCOUNT · % APP · % GLOBAL (còn nguyên).',
    v_acct, v_app, v_global;
  RAISE NOTICE 'TIẾP: chạy verify M1-V1…M1-V6, rồi DEPLOY CODE MỚI, rồi mới '
    'apply M-2 (20260828020000). KHÔNG apply M-2 trước khi code lên.';
END $$;

COMMIT;
