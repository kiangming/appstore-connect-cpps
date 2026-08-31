-- ============================================================
-- [G1 · GOOGLE account-default-template] M-1 — THUẦN CỘNG THÊM. Không xoá gì.
-- ============================================================
--
-- ── HƯỚNG DẪN APPLY — 4 bước, KHÔNG có bước sửa file ─────────────────────
--
-- BƯỚC 0 (BẮT BUỘC, chạy TRƯỚC). Mở file:
--            docs/google-iap-management/queries/verify-google-account-default-template.sql
--         Chạy M1-V-PRE-A rồi M1-V-PRE-B (hai câu riêng, mỗi lần Run một câu).
--         • M1-V-PRE-A in ra 6 dòng `display_name` THẬT của
--           google_iap_mgmt.google_console_accounts. So từng chuỗi một với
--           khối `v_expected` ở dòng 410 tới dòng 415 của CHÍNH FILE ĐANG ĐỌC.
--           Khớp đủ 6 chuỗi (đúng từng ký tự, phân biệt hoa thường) ⇒ đi tiếp.
--           LỆCH dù chỉ một ký tự ⇒ DỪNG, gửi output của M1-V-PRE-A về, KHÔNG
--           tự sửa file. Guard trong M-1 sẽ chặn và rollback, nhưng phát hiện
--           ở BƯỚC 0 rẻ hơn phát hiện lúc bấm Run.
--         • M1-V-PRE-B in ra tên hai ràng buộc CHECK đang có trên bảng
--           google_iap_mgmt.pricing_templates. Câu này chỉ để ĐỌC CHO BIẾT —
--           M-1 KHÔNG gõ tên hai ràng buộc đó, nó tự tra trong pg_constraint
--           lúc chạy (xem BƯỚC 2 của phần thân). M1-V-PRE-B trả về 0 dòng ⇒
--           DỪNG, báo lại: 0 dòng nghĩa là phép đo không đọc được thứ nó nói
--           là đang đọc.
--
-- BƯỚC 1. Mở file:
--            supabase/migrations/20260831000000_google_iap_mgmt_account_templates_m1_additive.sql
--         (chính là file đang đọc — 646 dòng)
--
-- BƯỚC 2. Copy TOÀN BỘ 646 dòng. GIỮ NGUYÊN, KHÔNG xoá, KHÔNG sửa dòng nào.
--         Hai dòng mốc để đối chiếu đã copy đủ chưa:
--            • câu lệnh CHẠY ĐƯỢC đầu tiên của file  =  BEGIN;    (dòng 151)
--            • dòng CUỐI CÙNG của file               =  COMMIT;   (dòng 646)
--         Thiếu một trong hai ⇒ đã copy hụt, copy lại.
--         ⚠ Hai con số dòng ở trên đúng với phiên bản file này. Nếu file
--           được sửa về sau, hãy tin vào MÔ TẢ (câu lệnh chạy được đầu tiên
--           là BEGIN; / dòng cuối cùng là COMMIT;) chứ không phải con số.
--
-- BƯỚC 3. Dán vào Supabase SQL Editor. Bấm Run MỘT lần.
--
-- BƯỚC 4. Chạy verify, mở file:
--            docs/google-iap-management/queries/verify-google-account-default-template.sql
--         M1-V0 (bảng kiểm gộp, MỘT dòng PASS/FAIL) trước.
--         M1-V0 = true  ⇒ xong M-1, báo lại để deploy code.
--         M1-V0 = false ⇒ xem cột nào false rồi chạy M1-V1…M1-V8 tương ứng.
--         ⚠ Supabase SQL Editor chỉ hiện kết quả của câu lệnh CUỐI trong một
--           script nhiều lệnh. Chạy TỪNG CÂU MỘT, đừng dán cả file rồi Run.
--
-- ⚠ KHÔNG có bước dry-run. M-1 tự dry-run chính nó: mọi guard bên trong là
--   RAISE EXCEPTION, mà một exception trong transaction làm CẢ transaction
--   rollback — sai thì KHÔNG GHI GÌ.
--
-- ⚠ KHI GUARD NỔ, MÀN HÌNH SẼ HIỆN GÌ: một lỗi đỏ dạng
--       ERROR: GUARD: <mô tả>        (hoặc ERROR: BACKUP RỖNG… / TRẠNG THÁI…)
--   Đó là THẤT BẠI AN TOÀN, không phải hỏng: transaction đã rollback,
--   database y hệt như trước khi bấm Run, không dòng nào được ghi. Đọc mô tả
--   trong lỗi, sửa nguyên nhân, rồi chạy lại CẢ file.
--   Chạy THÀNH CÔNG thì dòng RAISE NOTICE cuối cùng là:
--       'M-1 HOÀN TẤT — … ACCOUNT · … APP · 1 GLOBAL (còn nguyên).'
--   Nếu SQL Editor không hiện notice thì đừng lo — bằng chứng thật là M1-V0
--   ở BƯỚC 4, không phải notice.
--
-- ── ĐƯỜNG LUI (nếu verify lệch) ──────────────────────────────────────────
--     DELETE FROM google_iap_mgmt.pricing_templates
--      WHERE scope_type = 'ACCOUNT' AND origin_note IS NOT NULL;   -- CASCADE
--     UPDATE google_iap_mgmt.pricing_template_entries SET sort_order = NULL;
--     DROP TABLE IF EXISTS google_iap_mgmt.pricing_templates_backup_global;
--     DROP TABLE IF EXISTS google_iap_mgmt.pricing_template_entries_backup_global;
--   Ba cột thêm mới (scope_account_id, origin_note, sort_order) và CHECK đã
--   nới có thể để nguyên — chúng không ảnh hưởng code cũ (xem phần "M-1 an
--   toàn với code CŨ" bên dưới).
--
-- ── FILE LIÊN QUAN (đường dẫn đầy đủ, không viết tắt) ─────────────────────
--   Verify (BƯỚC 0 và BƯỚC 4):
--     docs/google-iap-management/queries/verify-google-account-default-template.sql
--   Census đã chạy (nguồn của mọi con số trong file này):
--     docs/google-iap-management/queries/census-google-pricing-templates.sql
--   M-2 (phần XOÁ GLOBAL, apply SAU khi code mới đã deploy): CHƯA VIẾT, thuộc
--     chunk G1f.
--
-- ── VÌ SAO TÁCH LÀM HAI (M-1 / M-2) ──────────────────────────────────────
-- M-1 chỉ CỘNG: thêm cột, nới CHECK, nhân bản. Code CŨ chạy y nguyên sau M-1.
-- Việc XOÁ GLOBAL + thu hẹp CHECK mới là thứ làm code cũ gãy, nên nó nằm ở
-- M-2, apply SAU khi code mới đã deploy. Kết quả: KHÔNG CÓ cửa sổ chết giữa
-- apply và deploy.
--
-- ── M-1 AN TOÀN VỚI CODE CŨ — bằng chứng grep, không phải niềm tin ────────
-- Đã grep 15 câu chạm google_iap_mgmt.pricing_templates trong code sản phẩm:
-- 15/15 đều có `.eq("scope_type", …)` hoặc lọc theo `.eq("id", …)`. KHÔNG
-- câu nào thiếu bộ lọc ⇒ 6 dòng ACCOUNT mới KHÔNG lọt vào bất kỳ query nào
-- của code cũ. Các site đại diện:
--
--   templates.ts:60      fetchOverviewForTemplate      .eq(template_id, …)
--   templates.ts:216-220 replaceTemplate DELETE        .eq(scope_type,…)
--                                                       + .is/.eq(scope_app_id)
--   templates.ts:229-234 replaceTemplate INSERT header  (xem dưới)
--   templates.ts:245-252 replaceTemplate INSERT entries (xem dưới)
--   templates.ts:439-445 findTemplateTierByCurrencyMicros .eq(scope_type,…)
--   templates.ts:529-549 templateExists                 .eq(scope_type,…)
--   templates.ts:557-566 listTemplateTiers              .eq(scope_type,…)
--   templates.ts:676-681 listTierCandidates             .eq(scope_type,…)
--   template-matrix.ts:170-186 findTemplateIdForScope   .eq(scope_type,…)
--                                                       + .is/.eq(scope_app_id)
--   template-matrix.ts:161-164 fetchEntriesForTemplate  .eq(template_id,…)
--
--   ⇒ `.maybeSingle()` trên nhánh GLOBAL vẫn thấy ĐÚNG 1 dòng (M-1 không đụng
--     dòng GLOBAL). Không có PGRST116.
--   ⇒ ĐƯỜNG GHI của code cũ vẫn hợp lệ sau khi nới CHECK:
--       • templates.ts:229-234 INSERT header KHÔNG set scope_account_id và
--         KHÔNG set origin_note → cả hai = NULL → thoả nhánh GLOBAL và nhánh
--         APP của CHECK mới. Manager vẫn Replace/Remove được như thường.
--       • templates.ts:245-252 INSERT entries KHÔNG set sort_order →
--         NULL. Đó là lý do sort_order phải NULLABLE ở M-1 (xem BƯỚC 1).
--
-- ⚠ NHƯNG: ĐỪNG Replace/Remove Default Template trong khoảng M-1 → deploy.
--   6 bản sao được chụp tại đúng thời điểm M-1. Thay bản gốc sau đó sẽ làm 6
--   bản sao mang nội dung CŨ, và guard của M-2 (so id + số entry của GLOBAL
--   với bảng backup) sẽ TỪ CHỐI chạy. Thêm một lý do thứ hai: code cũ ghi
--   entries KHÔNG có sort_order (templates.ts:245-252), nên một lần Replace
--   trong cửa sổ này để lại một template có sort_order NULL toàn bộ.
--
-- ── VÌ SAO NHÚNG TƯỜNG MINH 6 ACCOUNT — và vì sao Ở GOOGLE KHÁC APPLE ─────
-- ⚠ Đây KHÔNG phải chỗ port 1:1 từ Apple. Lý do nhúng ở hai bên KHÁC NHAU.
--
--   • APPLE: bảng account là `public.asc_accounts` — KHÁC SCHEMA với
--     `iap_mgmt`. CLAUDE.md invariant #9 cấm query cross-schema, nên migration
--     Apple KHÔNG ĐƯỢC PHÉP đọc bảng account. Danh sách 6 id nhúng tay ở đó là
--     NGUỒN DỮ LIỆU duy nhất, và migration KHÔNG tự đối chiếu được — Apple
--     phải đẩy phép đối chiếu ra một verify riêng (M1-V2) làm CỔNG bắt buộc.
--
--   • GOOGLE: bảng account là `google_iap_mgmt.google_console_accounts` —
--     CÙNG SCHEMA với `pricing_templates`. Không có invariant nào bị chạm.
--     Migration ĐỌC THẲNG bảng đó để lấy id thật. Vậy nên ở đây danh sách
--     nhúng KHÔNG phải nguồn dữ liệu, nó là BẢN KÊ ĐỂ ĐỐI CHIẾU:
--       – tự-mô-tả: đọc file là biết migration này nhắm đúng 6 account nào,
--         không phải "tất cả những gì bảng đang có" (một dòng rác trong bảng
--         sẽ lặng lẽ được nhân bản thêm một template);
--       – kiểm được: phép đối chiếu chạy NGAY TRONG transaction (BƯỚC 4),
--         lệch là RAISE EXCEPTION và rollback. Cái mà Apple phải hoãn sang
--         một verify ngoài migration thì ở Google nằm trong chính migration.
--     Đổi lại: id thật lấy từ bảng, KHÔNG chép tay UUID nào.
--
-- ── NGUỒN CỦA MỌI CON SỐ (census đã chạy 2026-08-30) ─────────────────────
--   6 account · 1 template GLOBAL (846 entry = 94 tier × 9 region, ma trận
--   ĐẦY, upload 2026-05-21 bởi minhgv@) · 3 template APP.
--   ⚠ Con số 3 (APP) KHÔNG được chốt cứng ở đâu trong file này: guard chụp
--     số APP TRƯỚC rồi so SAU. Manager có thể upload thêm một app-template
--     giữa lúc duyệt file và lúc apply; một guard chốt "3" sẽ từ chối apply
--     vì một lý do hoàn toàn hợp lệ.
--   ⚠ Con số 846 cũng KHÔNG gõ tay: đọc từ bảng backup ở BƯỚC 0.
-- ============================================================

BEGIN;

-- ============================================================
-- BƯỚC 0 — BACKUP dòng GLOBAL (header + entries)
-- ============================================================
-- IF NOT EXISTS: chạy lại M-1 KHÔNG ghi đè backup. Backup phải giữ bản
-- GỐC của lần chạy đầu — đó là thứ M-2 sẽ đối chiếu để phát hiện "GLOBAL
-- đã bị Replace giữa chừng".
CREATE TABLE IF NOT EXISTS google_iap_mgmt.pricing_templates_backup_global AS
  SELECT * FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'GLOBAL';

CREATE TABLE IF NOT EXISTS google_iap_mgmt.pricing_template_entries_backup_global AS
  SELECT e.* FROM google_iap_mgmt.pricing_template_entries e
   WHERE e.template_id IN (
     SELECT id FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'GLOBAL'
   );

DO $$
DECLARE
  v_has_global    BOOLEAN;
  v_backup_hdr    INT;
  v_backup_entries INT;
BEGIN
  SELECT EXISTS (SELECT 1 FROM google_iap_mgmt.pricing_templates
                  WHERE scope_type = 'GLOBAL') INTO v_has_global;
  SELECT COUNT(*) INTO v_backup_hdr
    FROM google_iap_mgmt.pricing_templates_backup_global;
  SELECT COUNT(*) INTO v_backup_entries
    FROM google_iap_mgmt.pricing_template_entries_backup_global;

  -- Một phép đo trả về RỖNG phải KÊU, không im.
  IF v_has_global AND v_backup_hdr = 0 THEN
    RAISE EXCEPTION
      'BACKUP RỖNG: bảng pricing_templates CÓ dòng GLOBAL nhưng bảng backup '
      'header lại 0 dòng. Backup đã không đọc được thứ nó nói là đang đọc. '
      'Dừng — báo lại trước khi làm gì tiếp.';
  END IF;
  IF v_has_global AND v_backup_entries = 0 THEN
    RAISE EXCEPTION
      'BACKUP RỖNG: có dòng GLOBAL nhưng backup entries 0 dòng. Kỳ vọng 846 '
      '(94 tier × 9 region, census 2026-08-30). Dừng — báo lại.';
  END IF;

  RAISE NOTICE '[M1/0] backup: % header · % entry.', v_backup_hdr, v_backup_entries;
END $$;

-- ============================================================
-- BƯỚC 1 — BA CỘT MỚI. Tất cả NULLABLE.
-- ============================================================
-- ⚠ NULLABLE là điều kiện để code CŨ còn ghi được: cả ba đường INSERT của
--   replaceTemplate (templates.ts:229-234 header, templates.ts:245-252
--   entries) đều KHÔNG set ba cột này. Một cột NOT NULL ở đây làm Replace
--   của Manager gãy ngay trong cửa sổ M-1 → deploy.
ALTER TABLE google_iap_mgmt.pricing_templates
  ADD COLUMN IF NOT EXISTS scope_account_id UUID
    REFERENCES google_iap_mgmt.google_console_accounts(id) ON DELETE CASCADE;

ALTER TABLE google_iap_mgmt.pricing_templates
  ADD COLUMN IF NOT EXISTS origin_note TEXT;

ALTER TABLE google_iap_mgmt.pricing_template_entries
  ADD COLUMN IF NOT EXISTS sort_order INT;

CREATE INDEX IF NOT EXISTS idx_google_iap_mgmt_pricing_templates_account
  ON google_iap_mgmt.pricing_templates(scope_account_id);

COMMENT ON COLUMN google_iap_mgmt.pricing_templates.scope_account_id IS
  'Account sở hữu Default Template này, khi scope_type = ''ACCOUNT''. FK '
  'CASCADE tới google_console_accounts(id) — xoá account là xoá template '
  'của nó. NULL ở dòng GLOBAL và dòng APP; tính mạch lạc do CHECK '
  'pricing_templates_scope_coherent_check giữ, KHÔNG phải NOT NULL trên cột.';

COMMENT ON COLUMN google_iap_mgmt.pricing_templates.origin_note IS
  'Dấu vết nguồn gốc dạng câu đọc được. NOT NULL = dòng do migration sinh '
  '(bản nhân bản), không phải Manager upload. Đây là ĐIỀU KIỆN RẼ NHÁNH của '
  'modal xác nhận Replace ở chunk G1c: origin_note IS NOT NULL → biến thể '
  'xanh "chưa ai cấu hình riêng cho account này"; IS NULL → biến thể đỏ "sẽ '
  'ghi đè việc của <email>". ⚠ KHÔNG phân biệt hai biến thể bằng cách so '
  'chuỗi uploaded_by = ''SYSTEM_MIGRATION'' — uploaded_by là dữ liệu người '
  'dùng nhập được, origin_note thì không.';

COMMENT ON COLUMN google_iap_mgmt.pricing_template_entries.sort_order IS
  'Thứ tự CỘT (region) trong file .xlsx Manager upload, 1-based. Mọi entry '
  'cùng (template_id, region_code) mang cùng một giá trị. Lý do tồn tại: '
  'trước G1, thứ tự cột của ma trận dựa vào thứ tự dòng Postgres trả về khi '
  'SELECT KHÔNG có ORDER BY (template-matrix.ts:161-164 + comment Hotfix 24 '
  'ở template-matrix.ts:118-132) — hành vi KHÔNG cam kết, một VACUUM FULL là '
  'đủ để đảo cột. Thứ tự HÀNG (tier) không cần cột này: nó do compareTiers '
  'quyết trong code (template-matrix.ts:116). NULLABLE ở M-1 vì code cũ '
  '(templates.ts:245-252) chưa ghi cột này; chunk G1d làm parser ghi và mọi '
  'đường đọc ORDER BY theo nó.';

-- ============================================================
-- BƯỚC 2 — NỚI CHECK. Tên ràng buộc TRA TẠI CHỖ, KHÔNG GÕ TAY.
-- ============================================================
-- ⚠ Có HAI CHECK trên bảng này, không phải một (init 20260520010000:280 khai
--   báo CHECK cấp cột trên scope_type, và :285-289 khai báo CHECK cấp bảng
--   cho tính mạch lạc). Cả hai đều KHÔNG ĐẶT TÊN ⇒ tên là do Postgres tự
--   sinh. Sửa mỗi cái đầu thì INSERT scope_type='ACCOUNT' vẫn bị cái thứ hai
--   chặn (ACCOUNT không khớp nhánh nào của nó).
--
-- ⚠ KHÔNG gõ tên tự-sinh vào file này. Khối dưới TRA tên trong pg_constraint
--   theo tính chất "là CHECK, trên đúng bảng này, và định nghĩa có nhắc
--   scope_type", rồi DROP theo tên tra được. Nếu tra ra 0 cái mà bảng vẫn
--   còn dòng GLOBAL ⇒ phép đo không đọc được thứ nó nói là đang đọc ⇒ KÊU.
--
-- ⚠ BỌC TRONG ĐIỀU KIỆN — hệ quả của việc tách hai migration: nếu M-2 đã
--   chạy (đã thu hẹp CHECK, đã xoá GLOBAL) mà ai đó chạy lại M-1, một lệnh
--   ALTER vô điều kiện sẽ ÂM THẦM cho phép 'GLOBAL' quay lại hợp lệ. Điều
--   kiện dưới đây làm M-1 không thể lùi bước tiến của M-2.
DO $$
DECLARE
  v_con    RECORD;
  v_found  INT := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM google_iap_mgmt.pricing_templates
                  WHERE scope_type = 'GLOBAL') THEN
    RAISE NOTICE
      '[M1/2] BỎ QUA nới CHECK — không còn dòng GLOBAL nào, nghĩa là M-2 đã '
      'chạy. Không nới lại (sẽ cho phép GLOBAL quay về).';
    RETURN;
  END IF;

  FOR v_con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class     t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'google_iap_mgmt'
       AND t.relname = 'pricing_templates'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%scope_type%'
  LOOP
    EXECUTE format(
      'ALTER TABLE google_iap_mgmt.pricing_templates DROP CONSTRAINT %I',
      v_con.conname);
    RAISE NOTICE '[M1/2] đã DROP CHECK cũ: %', v_con.conname;
    v_found := v_found + 1;
  END LOOP;

  IF v_found = 0 THEN
    RAISE EXCEPTION
      'GUARD: tra pg_constraint ra 0 ràng buộc CHECK nhắc scope_type trên '
      'google_iap_mgmt.pricing_templates, trong khi bảng VẪN còn dòng GLOBAL. '
      'Kỳ vọng 2 (init 20260520010000:280 và :285-289). Phép tra không đọc '
      'được thứ nó nói là đang đọc — dừng, báo lại.';
  END IF;

  ALTER TABLE google_iap_mgmt.pricing_templates
    ADD CONSTRAINT pricing_templates_scope_type_check
    CHECK (scope_type IN ('GLOBAL', 'APP', 'ACCOUNT'));

  ALTER TABLE google_iap_mgmt.pricing_templates
    ADD CONSTRAINT pricing_templates_scope_coherent_check CHECK (
         (scope_type = 'GLOBAL'  AND scope_app_id IS NULL     AND scope_account_id IS NULL)
      OR (scope_type = 'APP'     AND scope_app_id IS NOT NULL AND scope_account_id IS NULL)
      OR (scope_type = 'ACCOUNT' AND scope_app_id IS NULL     AND scope_account_id IS NOT NULL)
    );

  RAISE NOTICE '[M1/2] đã nới CHECK → GLOBAL | APP | ACCOUNT (DROP % cái cũ).',
    v_found;
END $$;

-- ============================================================
-- BƯỚC 3 — unique index cho scope ACCOUNT (replace-only)
-- ============================================================
-- Tạo TRƯỚC khi INSERT để nó bảo vệ chính lệnh INSERT ở BƯỚC 4.
-- Cùng khuôn với idx_..._app_unique (init 20260520010000:296-298).
-- Cố ý KHÔNG dùng UNIQUE(scope_type, scope_account_id): với dòng APP cặp đó
-- là ('APP', NULL), mà NULL khác NULL trong unique index — nó "chạy được"
-- nhờ ngữ nghĩa NULL chứ không nhờ ý định.
--
-- ⚠ SAI LỆCH SO VỚI ĐỀ BÀI, khai báo thẳng: đề bài ghi "idx_..._global_unique
--   (phải nới)". ĐO LẠI thì KHÔNG phải nới, và M-1 KHÔNG đụng vào nó.
--   Bằng chứng, init 20260520010000:292-294:
--       CREATE UNIQUE INDEX idx_google_iap_mgmt_pricing_templates_global_unique
--         ON google_iap_mgmt.pricing_templates(scope_type)
--         WHERE scope_type = 'GLOBAL';
--   Đây là partial index: nó chỉ CHỨA những dòng thoả `scope_type='GLOBAL'`.
--   6 dòng ACCOUNT không thoả vị từ ⇒ không vào index ⇒ không thể đụng ràng
--   buộc duy nhất của nó. Nới nó ra sẽ là nới một ràng buộc đang đúng, và
--   làm mất tính chất "tối đa 1 GLOBAL" mà M-1 dựa vào để guard.
--   Index đó bị DROP ở M-2, cùng lúc GLOBAL biến mất — không phải ở M-1.
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_iap_mgmt_pricing_templates_account_unique
  ON google_iap_mgmt.pricing_templates(scope_account_id)
  WHERE scope_type = 'ACCOUNT';

-- ============================================================
-- BƯỚC 4 — BACKFILL sort_order cho MỌI template đang có
-- ============================================================
-- ⚠ Chạy TRƯỚC bước nhân bản: 6 bản sao chép luôn sort_order từ bản gốc,
--   không phải backfill lần hai.
--
-- ⚠ BACKFILL CHO CẢ 3 TEMPLATE APP, không riêng GLOBAL. Bỏ sót chúng thì sau
--   G1d (mọi đường đọc ORDER BY sort_order) màn Per-App matrix đọc phải toàn
--   NULL và mất thứ tự cột.
--
-- ⚠ NGUỒN THỨ TỰ LÀ ctid, KHÔNG PHẢI ALPHABET. ctid = thứ tự vật lý, và với
--   template replace-only thì đó chính là thứ tự INSERT = thứ tự cột trong
--   file .xlsx Manager upload. Đây đúng là thứ tự màn hình ĐANG hiện hôm nay
--   (template-matrix.ts:118-132, Hotfix 24). Alphabet hoá ở đây sẽ ÂM THẦM
--   đổi thứ tự cột Manager đang dùng để đọc — đúng thứ Hotfix 24 đã sửa.
--   Kỳ vọng cho bản GLOBAL: US VN SG MY ID PH TH HK TW
--   (xlsx-template-matrix-export.ts:34-36). M1-V6 in ra để đối chiếu mắt.
--
-- ⚠ CHỈ ĐỘNG VÀO TEMPLATE CÒN NULL. Bản thân lệnh UPDATE này viết lại dòng
--   nên ĐỔI ctid của chúng; chạy lại backfill trên dòng đã có sort_order sẽ
--   tính ra một thứ tự KHÁC. Bộ lọc dưới làm lần chạy thứ hai thành no-op.
DO $$
DECLARE
  v_targets INT;
  v_rows    INT;
BEGIN
  SELECT COUNT(DISTINCT template_id) INTO v_targets
    FROM google_iap_mgmt.pricing_template_entries WHERE sort_order IS NULL;

  IF v_targets = 0 THEN
    RAISE NOTICE '[M1/3] BỎ QUA backfill sort_order — không template nào còn NULL.';
    RETURN;
  END IF;

  WITH numbered AS (
    SELECT template_id, region_code,
           ROW_NUMBER() OVER (PARTITION BY template_id ORDER BY ctid) AS rn
      FROM google_iap_mgmt.pricing_template_entries
     WHERE template_id IN (
       SELECT DISTINCT template_id FROM google_iap_mgmt.pricing_template_entries
        WHERE sort_order IS NULL
     )
  ),
  first_seen AS (
    SELECT template_id, region_code, MIN(rn) AS first_rn
      FROM numbered GROUP BY template_id, region_code
  ),
  region_order AS (
    SELECT template_id, region_code,
           ROW_NUMBER() OVER (PARTITION BY template_id ORDER BY first_rn) AS ord
      FROM first_seen
  )
  UPDATE google_iap_mgmt.pricing_template_entries e
     SET sort_order = r.ord
    FROM region_order r
   WHERE e.template_id = r.template_id
     AND e.region_code = r.region_code;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE '[M1/3] backfill sort_order: % template · % dòng.', v_targets, v_rows;
END $$;

-- ============================================================
-- BƯỚC 5 — NHÂN BẢN: 1 GLOBAL → 6 ACCOUNT (header + entries)
-- ============================================================
DO $$
DECLARE
  -- ⚠ BẢN KÊ ĐỂ ĐỐI CHIẾU, KHÔNG phải nguồn dữ liệu. Id thật đọc từ bảng
  --   google_console_accounts (cùng schema — xem phần lý do ở đầu file).
  --   6 chuỗi dưới đây chép từ output census 2026-08-30. Manager đã so lại
  --   ở BƯỚC 0 (M1-V-PRE-A) trước khi bấm Run.
  v_expected   TEXT[] := ARRAY[
                   'MTP',
                   'NCV',
                   'VNG Corp',
                   'VNG Sing',
                   'VNGG Sing',
                   'VNGG VN'
                 ];
  -- Cố ý không chép danh sách lần hai: hai bản sao là chỗ để sau này sửa một
  -- bên quên bên kia, và guard sẽ so với số sai.
  v_n              INT := array_length(v_expected, 1);
  v_missing        TEXT;
  v_extra          TEXT;
  v_live_n         INT;
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
  -- ── Bất biến "không đụng template APP": chụp TRƯỚC, so SAU. KHÔNG chốt 3.
  SELECT COUNT(*) INTO v_app_before
    FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'APP';

  -- ── Số entry gốc: đọc từ BẢNG BACKUP, không gõ hằng số 846.
  SELECT COUNT(*) INTO v_global_entries
    FROM google_iap_mgmt.pricing_template_entries_backup_global;

  SELECT id, uploaded_by, uploaded_at, source_filename
    INTO v_global_id, v_global_by, v_global_at, v_global_file
    FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'GLOBAL';

  -- ── IDEMPOTENCY. M-1 KHÔNG phá nguồn copy của chính nó (nó không xoá
  --    GLOBAL), nên chạy lại khi chưa chạy M-2 là chạy lại ĐẦY ĐỦ được.
  IF v_global_id IS NULL THEN
    SELECT COUNT(*) INTO v_acct_templates
      FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'ACCOUNT';
    IF v_acct_templates = v_n THEN
      RAISE NOTICE
        '[M1/4] BỎ QUA — M-2 đã chạy (không còn GLOBAL) và đã có % template '
        'ACCOUNT. Không có gì để làm.', v_acct_templates;
      RETURN;
    END IF;
    RAISE EXCEPTION
      'TRẠNG THÁI KHÔNG XÁC ĐỊNH: không có dòng GLOBAL để nhân bản, và số '
      'template ACCOUNT là % (kỳ vọng % nếu đã chạy xong). Dừng — chạy M1-V1 '
      'rồi báo lại.', v_acct_templates, v_n;
  END IF;

  -- ── ĐỐI CHIẾU BẢN KÊ ↔ BẢNG THẬT. Đây là phép kiểm mà Apple KHÔNG làm
  --    được trong migration (khác schema); ở Google nó chạy trong chính
  --    transaction này, lệch là rollback.
  SELECT COUNT(*) INTO v_live_n FROM google_iap_mgmt.google_console_accounts;

  SELECT COALESCE(string_agg(x, ' · ' ORDER BY x), '') INTO v_missing FROM (
    SELECT unnest(v_expected)
    EXCEPT
    SELECT display_name FROM google_iap_mgmt.google_console_accounts
  ) s(x);

  SELECT COALESCE(string_agg(x, ' · ' ORDER BY x), '') INTO v_extra FROM (
    SELECT display_name FROM google_iap_mgmt.google_console_accounts
    EXCEPT
    SELECT unnest(v_expected)
  ) s(x);

  IF v_missing <> '' OR v_extra <> '' THEN
    RAISE EXCEPTION
      'GUARD: bản kê 6 account trong M-1 KHÔNG khớp bảng google_console_'
      'accounts. Có trong bản kê nhưng KHÔNG có trong bảng: [%]. Có trong '
      'bảng nhưng KHÔNG có trong bản kê: [%]. Bảng đang có % dòng, bản kê % '
      'dòng. KHÔNG tự sửa file — gửi output M1-V-PRE-A về để sửa bản kê.',
      COALESCE(NULLIF(v_missing, ''), '(không có)'),
      COALESCE(NULLIF(v_extra,   ''), '(không có)'),
      v_live_n, v_n;
  END IF;

  RAISE NOTICE '[M1/4] nguồn: GLOBAL % · % entry · upload % bởi %',
    v_global_id, v_global_entries, v_global_at, v_global_by;

  -- ── 5a. Header ACCOUNT.
  --    NOT EXISTS: chạy lại không tạo trùng, và KHÔNG ghi đè template mà
  --    Manager đã tự upload cho account đó.
  --    uploaded_by = 'SYSTEM_MIGRATION' — tiền lệ init 20260520010000.
  --    uploaded_at = GIỮ NGUYÊN mốc của bản gốc, không dùng NOW(): nội dung
  --      846 ô này được upload ngày đó, và màn Settings hiển thị uploaded_at
  --      như "template này có từ bao giờ". NOW() sẽ nói dối về tuổi nội dung.
  --      Sự kiện "do migration sinh" đã nằm ở origin_note.
  INSERT INTO google_iap_mgmt.pricing_templates
    (scope_type, scope_app_id, scope_account_id, uploaded_at, uploaded_by,
     source_filename, origin_note)
  SELECT 'ACCOUNT', NULL, a.id, v_global_at, 'SYSTEM_MIGRATION',
         v_global_file,
         'Bản sao tự động (G1/M-1) từ Default Template dùng chung trước đây — '
         || 'GLOBAL ' || v_global_id::text
         || ', upload ' || to_char(v_global_at, 'YYYY-MM-DD')
         || ' bởi ' || v_global_by
         || '. Chưa ai cấu hình riêng cho account này.'
    FROM google_iap_mgmt.google_console_accounts a
   WHERE NOT EXISTS (
     SELECT 1 FROM google_iap_mgmt.pricing_templates t
      WHERE t.scope_type = 'ACCOUNT' AND t.scope_account_id = a.id
   );
  GET DIAGNOSTICS v_headers_ins = ROW_COUNT;
  RAISE NOTICE '[M1/4a] header ACCOUNT tạo mới: %', v_headers_ins;

  -- ── 5b. Entries.
  --    Chỉ đổ vào bản sao CÒN RỖNG và CÓ origin_note ⇒ không bao giờ đổ đè
  --    lên một template ACCOUNT do Manager tự upload.
  INSERT INTO google_iap_mgmt.pricing_template_entries
    (template_id, identifier, region_code, currency, price_micros, sort_order)
  SELECT t.id, e.identifier, e.region_code, e.currency, e.price_micros,
         e.sort_order
    FROM google_iap_mgmt.pricing_templates t
    JOIN google_iap_mgmt.pricing_template_entries e
      ON e.template_id = v_global_id
   WHERE t.scope_type = 'ACCOUNT'
     AND t.origin_note IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM google_iap_mgmt.pricing_template_entries x
        WHERE x.template_id = t.id
     );
  GET DIAGNOSTICS v_entries_ins = ROW_COUNT;
  RAISE NOTICE '[M1/4b] entry copy: % (kỳ vọng % × % = %)',
    v_entries_ins, v_headers_ins, v_global_entries,
    v_headers_ins * v_global_entries;

  -- ════════════════════════════════════════════════════════════
  -- GUARD — kiểm TRẠNG THÁI CUỐI, không chỉ delta
  -- ════════════════════════════════════════════════════════════
  SELECT COUNT(*) INTO v_acct_templates
    FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'ACCOUNT';
  IF v_acct_templates <> v_n THEN
    RAISE EXCEPTION 'GUARD: có % template ACCOUNT, kỳ vọng %.',
      v_acct_templates, v_n;
  END IF;

  -- Mỗi account phải có ĐÚNG một template. (Unique index ở BƯỚC 3 đã chặn
  -- ">1"; câu này bắt nốt vế "=0".)
  SELECT string_agg(a.display_name, ' · ' ORDER BY a.display_name) INTO v_bad
    FROM google_iap_mgmt.google_console_accounts a
   WHERE NOT EXISTS (
     SELECT 1 FROM google_iap_mgmt.pricing_templates t
      WHERE t.scope_type = 'ACCOUNT' AND t.scope_account_id = a.id
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'GUARD: account chưa có template sau INSERT: %', v_bad;
  END IF;

  -- Mỗi bản sao phải đủ số entry của bản gốc.
  SELECT string_agg(x.txt, ' · ') INTO v_bad FROM (
    SELECT t.id::text || '=' || COUNT(e.identifier)::text AS txt
      FROM google_iap_mgmt.pricing_templates t
      LEFT JOIN google_iap_mgmt.pricing_template_entries e ON e.template_id = t.id
     WHERE t.scope_type = 'ACCOUNT'
     GROUP BY t.id
    HAVING COUNT(e.identifier) <> v_global_entries
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      'GUARD: template ACCOUNT có số entry khác bản gốc (%). Lệch: %',
      v_global_entries, v_bad;
  END IF;

  -- Tổng entry của scope ACCOUNT.
  SELECT COUNT(*) INTO v_total_entries
    FROM google_iap_mgmt.pricing_template_entries e
    JOIN google_iap_mgmt.pricing_templates t ON t.id = e.template_id
   WHERE t.scope_type = 'ACCOUNT';
  IF v_total_entries <> v_n * v_global_entries THEN
    RAISE EXCEPTION 'GUARD: tổng entry nhân bản = %, kỳ vọng % × % = %.',
      v_total_entries, v_n, v_global_entries, v_n * v_global_entries;
  END IF;

  -- GLOBAL còn nguyên (M-1 không xoá gì).
  IF NOT EXISTS (SELECT 1 FROM google_iap_mgmt.pricing_templates
                  WHERE scope_type = 'GLOBAL') THEN
    RAISE EXCEPTION 'GUARD: template GLOBAL biến mất trong M-1. M-1 KHÔNG '
      'được xoá gì — việc xoá thuộc M-2.';
  END IF;

  -- Số template APP không đổi.
  SELECT COUNT(*) INTO v_app_after
    FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'APP';
  IF v_app_after <> v_app_before THEN
    RAISE EXCEPTION 'GUARD: số template APP đổi từ % thành %. M-1 KHÔNG được '
      'đụng vào template APP.', v_app_before, v_app_after;
  END IF;

  -- sort_order phủ kín: không entry nào còn NULL.
  SELECT COUNT(*)::text INTO v_bad
    FROM google_iap_mgmt.pricing_template_entries WHERE sort_order IS NULL;
  IF v_bad <> '0' THEN
    RAISE EXCEPTION 'GUARD: còn % entry có sort_order NULL. Kỳ vọng 0 — G1d '
      'sẽ ORDER BY cột này và NULL sẽ làm mất thứ tự cột.', v_bad;
  END IF;

  RAISE NOTICE '[M1/guard] OK — % ACCOUNT × % entry = % dòng · GLOBAL còn '
    'nguyên · APP giữ % dòng · sort_order phủ kín.',
    v_n, v_global_entries, v_total_entries, v_app_after;
END $$;

-- ============================================================
-- GUARD CUỐI — trạng thái cuối, độc lập với khối trên
-- ============================================================
DO $$
DECLARE
  v_global INT;
  v_acct   INT;
  v_app    INT;
BEGIN
  SELECT COUNT(*) INTO v_global
    FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'GLOBAL';
  SELECT COUNT(*) INTO v_acct
    FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'ACCOUNT';
  SELECT COUNT(*) INTO v_app
    FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'APP';

  IF v_global <> 1 THEN
    RAISE EXCEPTION 'GUARD cuối M-1: kỳ vọng ĐÚNG 1 template GLOBAL còn lại, '
      'đang có %.', v_global;
  END IF;

  RAISE NOTICE 'M-1 HOÀN TẤT — % ACCOUNT · % APP · % GLOBAL (còn nguyên).',
    v_acct, v_app, v_global;
  RAISE NOTICE 'TIẾP: chạy verify M1-V0 trong '
    'docs/google-iap-management/queries/verify-google-account-default-template.sql, '
    'rồi báo lại để deploy code mới. ĐỪNG Replace Default Template trước khi deploy.';
END $$;

COMMIT;
