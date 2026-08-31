-- ============================================================
-- [G1 · GOOGLE account-default-template] M-2 — PHẦN XOÁ.
-- ============================================================
--
-- ⚠ ĐỌC TRƯỚC KHI CHẠY — TRẠNG THÁI ĐƯỜNG LUI SAU M-2
--
--   Sau khi M-2 chạy xong, ĐƯỜNG LUI "rollback code" KHÔNG CÒN DÙNG ĐƯỢC.
--   Code trước G1b đọc `scope_type = 'GLOBAL'`, mà M-2 xoá đúng dòng đó và
--   bỏ luôn giá trị 'GLOBAL' khỏi CHECK. Deploy lại bản code cũ sau M-2 sẽ
--   thấy 0 template ở mọi đường đọc Default.
--
--   ĐƯỜNG LUI CÒN LẠI: phục hồi từ HAI BẢNG BACKUP bằng SQL
--     google_iap_mgmt.pricing_templates_backup_global
--     google_iap_mgmt.pricing_template_entries_backup_global
--   Chậm hơn rollback code, nhưng KHÔNG MẤT DỮ LIỆU — hai bảng đó giữ
--   nguyên bản GLOBAL chụp tại thời điểm M-1. Vì thế M-2 CỐ Ý KHÔNG dọn
--   chúng (xem TODO cuối file).
--
--   Rủi ro này Manager đã đọc và CHẤP NHẬN trước khi M-2 chạy.
--
-- ── HƯỚNG DẪN APPLY — 3 bước, KHÔNG có bước sửa file ─────────────────────
--
-- BƯỚC 1. Mở file:
--            supabase/migrations/20260901000000_google_iap_mgmt_account_templates_m2_drop_global.sql
--         (chính là file đang đọc — 257 dòng)
--
-- BƯỚC 2. Copy TOÀN BỘ 257 dòng. GIỮ NGUYÊN, KHÔNG xoá, KHÔNG sửa dòng nào.
--         Hai dòng mốc để đối chiếu đã copy đủ chưa:
--            • câu lệnh CHẠY ĐƯỢC đầu tiên của file  =  BEGIN;    (dòng 63)
--            • dòng CUỐI CÙNG của file               =  COMMIT;   (dòng 257)
--         Thiếu một trong hai ⇒ đã copy hụt, copy lại.
--         ⚠ Hai con số dòng ở trên đúng với phiên bản file này. Nếu file
--           được sửa về sau, hãy tin vào MÔ TẢ (câu lệnh chạy được đầu tiên
--           là BEGIN; / dòng cuối cùng là COMMIT;) chứ không phải con số.
--         Dán vào Supabase SQL Editor. Bấm Run MỘT lần.
--
-- BƯỚC 3. Chạy verify, mở file:
--            docs/google-iap-management/queries/verify-google-account-default-template.sql
--         Phần "CHẶNG M-2": chạy M2-V0 (gộp, MỘT dòng PASS/FAIL) trước.
--         M2-V0 = PASS ⇒ arc G1 đóng. FAIL ⇒ xem cột nào false rồi chạy
--         M2-V1…M2-V5 tương ứng.
--         ⚠ Supabase SQL Editor chỉ hiện kết quả của câu lệnh CUỐI trong
--           một script nhiều lệnh. Chạy TỪNG CÂU MỘT.
--
-- ⚠ KHI GUARD NỔ, MÀN HÌNH SẼ HIỆN GÌ: một lỗi đỏ dạng
--       ERROR: GUARD M-2: <mô tả>
--   Đó là THẤT BẠI AN TOÀN, không phải hỏng: transaction đã rollback,
--   database y hệt như trước khi bấm Run, dòng GLOBAL vẫn còn nguyên, không
--   có gì bị xoá. Đọc mô tả trong lỗi, báo lại, đừng chạy lại ngay.
--
-- ── GUARD QUAN TRỌNG NHẤT: GLOBAL PHẢI Y NGUYÊN NHƯ LÚC M-1 CHỤP ─────────
--
-- M-1 nhân bản 6 template ACCOUNT TỪ dòng GLOBAL tại thời điểm đó. Nếu
-- trong khoảng M-1 → M-2 có ai Replace/Remove Default Template bằng code
-- CŨ, thì dòng GLOBAL hiện tại KHÁC bản đã được nhân — và 6 bản sao đang
-- mang nội dung cũ mà không ai biết. M-2 so `id` VÀ số entry của dòng
-- GLOBAL với ảnh chụp trong bảng backup; lệch một trong hai ⇒ TỪ CHỐI CHẠY.
--
-- Đây là lý do M-2 phải chạy SAU khi code mới đã deploy: code mới không còn
-- ghi vào dòng GLOBAL nữa, nên từ lúc deploy, dòng đó đứng yên.
-- ============================================================

BEGIN;

-- ============================================================
-- BƯỚC 1 — GUARD ĐỐI CHIẾU + XOÁ DÒNG GLOBAL
-- ============================================================
DO $$
DECLARE
  v_live_id        UUID;
  v_live_entries   INT;
  v_snap_id        UUID;
  v_snap_entries   INT;
  v_snap_rows      INT;
  v_acct_expected  INT;
  v_acct_templates INT;
  v_app_before     INT;
  v_app_after      INT;
  v_acct_entries   INT;
  v_deleted        INT;
  v_bad            TEXT;
BEGIN
  -- ── Ảnh chụp M-1. Phải còn, nếu không thì không có gì để đối chiếu.
  SELECT COUNT(*) INTO v_snap_rows
    FROM google_iap_mgmt.pricing_templates_backup_global;
  SELECT COUNT(*) INTO v_snap_entries
    FROM google_iap_mgmt.pricing_template_entries_backup_global;

  IF v_snap_rows = 0 THEN
    RAISE EXCEPTION
      'GUARD M-2: bảng backup header RỖNG. Không có ảnh chụp M-1 để đối '
      'chiếu, nên không thể biết dòng GLOBAL hiện tại có còn là bản đã được '
      'nhân hay không. Dừng — báo lại.';
  END IF;

  SELECT id INTO v_snap_id
    FROM google_iap_mgmt.pricing_templates_backup_global LIMIT 1;

  -- ── Dòng GLOBAL đang sống.
  SELECT id INTO v_live_id
    FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'GLOBAL';

  -- ── IDEMPOTENCY: chạy lần hai.
  IF v_live_id IS NULL THEN
    SELECT COUNT(*) INTO v_acct_templates
      FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'ACCOUNT';
    RAISE NOTICE
      '[M2/1] BỎ QUA — không còn dòng GLOBAL nào (M-2 đã chạy trước đó). '
      'Đang có % template ACCOUNT.', v_acct_templates;
  ELSE
    SELECT COUNT(*) INTO v_live_entries
      FROM google_iap_mgmt.pricing_template_entries
     WHERE template_id = v_live_id;

    -- ⚠ GUARD ĐỐI CHIẾU. Hai vế: id VÀ số entry.
    IF v_live_id <> v_snap_id THEN
      RAISE EXCEPTION
        'GUARD M-2: dòng GLOBAL hiện tại có id % nhưng ảnh chụp M-1 ghi id '
        '%. Nghĩa là Default Template đã bị Replace sau khi M-1 chạy, và 6 '
        'bản sao ACCOUNT đang mang nội dung CŨ. M-2 TỪ CHỐI xoá. Dừng — báo '
        'lại để xử lý bằng tay.', v_live_id, v_snap_id;
    END IF;

    IF v_live_entries <> v_snap_entries THEN
      RAISE EXCEPTION
        'GUARD M-2: dòng GLOBAL còn đúng id nhưng số entry đã đổi (% hiện '
        'tại, % lúc M-1 chụp). Nội dung đã bị sửa sau M-1. M-2 TỪ CHỐI xoá. '
        'Dừng — báo lại.', v_live_entries, v_snap_entries;
    END IF;

    RAISE NOTICE '[M2/1] đối chiếu OK: GLOBAL % · % entry, khớp ảnh chụp M-1.',
      v_live_id, v_live_entries;

    -- ── XOÁ. Entry đi theo qua FK ON DELETE CASCADE.
    DELETE FROM google_iap_mgmt.pricing_templates WHERE id = v_live_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '[M2/1] đã xoá % dòng GLOBAL (+ % entry qua CASCADE).',
      v_deleted, v_live_entries;
  END IF;

  -- ════════════════════════════════════════════════════════════
  -- GUARD TRẠNG THÁI CUỐI
  -- ════════════════════════════════════════════════════════════
  IF EXISTS (SELECT 1 FROM google_iap_mgmt.pricing_templates
              WHERE scope_type = 'GLOBAL') THEN
    RAISE EXCEPTION 'GUARD M-2: vẫn còn dòng GLOBAL sau khi xoá.';
  END IF;

  -- Số template ACCOUNT phải bằng số account đang tồn tại. KHÔNG gõ 6.
  SELECT COUNT(*) INTO v_acct_expected
    FROM google_iap_mgmt.google_console_accounts;
  SELECT COUNT(*) INTO v_acct_templates
    FROM google_iap_mgmt.pricing_templates WHERE scope_type = 'ACCOUNT';
  IF v_acct_templates <> v_acct_expected THEN
    RAISE EXCEPTION
      'GUARD M-2: có % template ACCOUNT nhưng % account đang tồn tại.',
      v_acct_templates, v_acct_expected;
  END IF;

  -- Mỗi account đúng một template.
  SELECT string_agg(a.display_name, ' · ' ORDER BY a.display_name) INTO v_bad
    FROM google_iap_mgmt.google_console_accounts a
   WHERE NOT EXISTS (
     SELECT 1 FROM google_iap_mgmt.pricing_templates t
      WHERE t.scope_type = 'ACCOUNT' AND t.scope_account_id = a.id
   );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'GUARD M-2: account không có template: %', v_bad;
  END IF;

  -- Tổng entry của scope ACCOUNT = N account × số entry ảnh chụp.
  -- ⚠ KHÔNG gõ 5076: cả hai thừa số đều ĐỌC RA.
  SELECT COUNT(*) INTO v_acct_entries
    FROM google_iap_mgmt.pricing_template_entries e
    JOIN google_iap_mgmt.pricing_templates t ON t.id = e.template_id
   WHERE t.scope_type = 'ACCOUNT';
  IF v_acct_entries <> v_acct_expected * v_snap_entries THEN
    RAISE EXCEPTION
      'GUARD M-2: tổng entry ACCOUNT = %, kỳ vọng % account × % entry = %.',
      v_acct_entries, v_acct_expected, v_snap_entries,
      v_acct_expected * v_snap_entries;
  END IF;

  -- Hai bảng backup PHẢI CÒN NGUYÊN — chúng là đường lui duy nhất còn lại.
  IF v_snap_rows = 0 OR v_snap_entries = 0 THEN
    RAISE EXCEPTION 'GUARD M-2: bảng backup đã rỗng. Đường lui biến mất.';
  END IF;

  RAISE NOTICE '[M2/guard] OK — 0 GLOBAL · % ACCOUNT × % entry = % · backup '
    'còn % header / % entry.',
    v_acct_templates, v_snap_entries, v_acct_entries, v_snap_rows, v_snap_entries;
END $$;

-- ============================================================
-- BƯỚC 2 — THU HẸP CẢ HAI CHECK (bỏ 'GLOBAL')
-- ============================================================
-- ⚠ CÓ HAI CHECK, không phải một. M-1 đã đặt tên tường minh cho cả hai
--   (M-1 dòng 300 và 304), nên ở đây gọi thẳng tên — không phải tra
--   pg_constraint như M-1 đã phải làm với tên tự-sinh của migration init.
--
-- ⚠ Thu hẹp là thứ làm code CŨ gãy, và đó là lý do cả khối này nằm ở M-2
--   chứ không ở M-1.
ALTER TABLE google_iap_mgmt.pricing_templates
  DROP CONSTRAINT IF EXISTS pricing_templates_scope_type_check;
ALTER TABLE google_iap_mgmt.pricing_templates
  ADD CONSTRAINT pricing_templates_scope_type_check
  CHECK (scope_type IN ('APP', 'ACCOUNT'));

ALTER TABLE google_iap_mgmt.pricing_templates
  DROP CONSTRAINT IF EXISTS pricing_templates_scope_coherent_check;
ALTER TABLE google_iap_mgmt.pricing_templates
  ADD CONSTRAINT pricing_templates_scope_coherent_check CHECK (
       (scope_type = 'APP'     AND scope_app_id IS NOT NULL AND scope_account_id IS NULL)
    OR (scope_type = 'ACCOUNT' AND scope_app_id IS NULL     AND scope_account_id IS NOT NULL)
  );

-- ============================================================
-- BƯỚC 3 — DROP index chỉ phục vụ scope GLOBAL
-- ============================================================
-- Index này ép "tối đa 1 dòng GLOBAL". Không còn dòng GLOBAL nào và CHECK
-- cũng không cho phép giá trị đó nữa ⇒ index thành vô nghĩa.
-- (M-1 CỐ Ý không đụng nó: lúc đó GLOBAL còn sống và guard của M-1 dựa
--  vào đúng tính chất "tối đa 1 GLOBAL" mà nó ép.)
DROP INDEX IF EXISTS google_iap_mgmt.idx_google_iap_mgmt_pricing_templates_global_unique;

-- ============================================================
-- GUARD CUỐI — CHECK mới phải THẬT SỰ từ chối 'GLOBAL'
-- ============================================================
-- Không kiểm bằng cách đọc tên ràng buộc (tên còn đó không có nghĩa là nội
-- dung đã hẹp). Kiểm bằng cách THỬ GHI một dòng GLOBAL và đòi nó phải hỏng.
DO $$
DECLARE
  v_ok BOOLEAN := FALSE;
BEGIN
  BEGIN
    INSERT INTO google_iap_mgmt.pricing_templates
      (scope_type, scope_app_id, scope_account_id, uploaded_by)
    VALUES ('GLOBAL', NULL, NULL, 'M2_PROBE');
  EXCEPTION WHEN check_violation THEN
    v_ok := TRUE;
  END;

  IF NOT v_ok THEN
    RAISE EXCEPTION
      'GUARD M-2 cuối: CHECK vẫn CHO PHÉP ghi scope_type = ''GLOBAL''. '
      'Việc thu hẹp đã không có tác dụng. Dừng.';
  END IF;

  RAISE NOTICE '[M2/cuối] CHECK đã từ chối ''GLOBAL'' đúng như kỳ vọng.';
  RAISE NOTICE 'M-2 HOÀN TẤT. TIẾP: chạy M2-V0 trong '
    'docs/google-iap-management/queries/verify-google-account-default-template.sql';
  RAISE NOTICE 'TODO (F4): CHƯA dọn 2 bảng backup. Điều kiện là đã có ÍT '
    'NHẤT MỘT lần Replace/upload THẬT thành công sau deploy — U6/U6b bị '
    'hoãn nên điều kiện đó CHƯA thoả. Giữ backup cho tới khi thoả.';
END $$;

COMMIT;
