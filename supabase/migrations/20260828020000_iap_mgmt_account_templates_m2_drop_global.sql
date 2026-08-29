-- ============================================================
-- [ACCOUNT-default-template] M-2 — PHẦN XOÁ. Chỉ chạy SAU khi code mới đã live.
-- ============================================================
--
-- ⚠ CHƯA APPLY. Và KHÔNG apply cùng lúc với M-1.
--
-- ── THỨ TỰ BẮT BUỘC ───────────────────────────────────────────────────
--   1. apply M-1 (20260828010000)          ← thuần cộng thêm, 0 rủi ro
--   2. chạy verify M1-V1 … M1-V6           ← M1-V2 là CỔNG
--   3. DEPLOY CODE MỚI (đọc template theo account)
--   4. kiểm code mới chạy thật (tạo/sửa 1 IAP, xem giá ra đúng)
--   5. apply M-2  ← file này
--   6. chạy verify M2-V1 … M2-V4
--
-- ── ⚠ HẠN CHẾ VẬN HÀNH — TỪ M-1 TỚI LÚC DEPLOY CODE, KHÔNG PHẢI TỚI M-2 ─
-- **ĐỪNG Replace/Remove Default Template ở Settings → Pricing Templates
--   trong khoảng từ lúc apply M-1 tới lúc DEPLOY code mới (bước 3).**
--
-- ⚠ Cửa sổ này NGẮN HƠN so với bản viết đầu tiên (đã sửa sau phát hiện C4).
--   Lý do: sau khi C-C lên production, tab Default đọc/ghi dòng scope
--   ACCOUNT, và nút Remove xoá dòng ACCOUNT. Dòng GLOBAL trở nên KHÔNG THỂ
--   CHẠM TỚI từ UI — nên từ lúc deploy trở đi, Manager upload đè thoải mái
--   mà GUARD 3 dưới đây vẫn đúng.
--   Chỉ code CŨ (trước deploy) mới sửa được dòng GLOBAL, và đó là toàn bộ
--   khoảng thời gian cần kiêng.
--
-- Vì sao phải kiêng trong khoảng đó: N bản sao được chụp tại thời điểm M-1.
-- Code cũ thay bản gốc sau đó làm chúng mang nội dung CŨ, trong khi tab
-- Settings hiển thị nội dung MỚI — hai thứ khác nhau, không surface nào nói ra.
--
-- Nếu lỡ làm: **GUARD 3 ở BƯỚC 0 bên dưới sẽ TỪ CHỐI chạy M-2** (so id +
-- số entry của GLOBAL với ảnh chụp M-1). Không im lặng. Cách gỡ:
--     DELETE FROM iap_mgmt.price_tier_templates
--      WHERE scope_type='ACCOUNT' AND origin_note IS NOT NULL;
--     DROP TABLE iap_mgmt.price_tier_templates_backup_global;
--     DROP TABLE iap_mgmt.price_tier_template_entries_backup_global;
--   rồi chạy lại M-1 (nó sẽ chụp lại ảnh mới và nhân bản lại), verify, rồi
--   mới tới M-2.
--
-- Đây là hạn chế TẠM, chỉ tồn tại trong cửa sổ M-1→M-2. Sau M-2 thì mỗi
-- account có template riêng và Manager upload đè thoải mái.
--
-- ⚠ Apply M-2 TRƯỚC bước 3 sẽ làm gãy production: code cũ đọc scope
--   GLOBAL (templates.ts:90-93 applyScopeFilter), và file này xoá nó. Đó
--   chính là "cửa sổ apply→deploy" mà việc tách hai migration sinh ra để
--   loại bỏ — apply sai thứ tự là tự tạo lại nó.
--
-- ── M-2 LÀM GÌ ────────────────────────────────────────────────────────
--   0. GUARD: bản gốc còn khớp ảnh chụp M-1 không · N bản sao còn đủ không
--   1. DELETE template GLOBAL (CASCADE dọn 1140 entry của nó)
--   2. THU HẸP cả hai CHECK — bỏ 'GLOBAL'
--   3. DROP index global_unique
--
-- ── ĐƯỜNG LUI ─────────────────────────────────────────────────────────
-- Sau M-1 (trước M-2): xoá 6 dòng ACCOUNT là xong, GLOBAL chưa mất —
--   DELETE FROM iap_mgmt.price_tier_templates
--    WHERE scope_type='ACCOUNT' AND origin_note IS NOT NULL;   (CASCADE)
-- Sau M-2: bản gốc đã bị xoá, nhưng dữ liệu KHÔNG mất — nó sống trong N
--   bản sao ACCOUNT (mỗi bản là bản chép nguyên xi), CỘNG bảng backup
--   ..._backup_global do M-1 tạo. Bảng backup là thứ khôi phục được một
--   dòng GLOBAL nếu cần lùi hẳn.
--
-- Forward-only (CLAUDE.md invariant #7).
-- ============================================================

BEGIN;

-- ============================================================
-- BƯỚC 0 — GUARD TRƯỚC KHI XOÁ
-- ============================================================
DO $$
DECLARE
  v_global_id       UUID;
  v_global_entries  INT;
  v_backup_id       UUID;
  v_backup_entries  INT;
  v_acct_templates  INT;
  v_acct_empty      TEXT;
BEGIN
  SELECT id INTO v_global_id
    FROM iap_mgmt.price_tier_templates WHERE scope_type = 'GLOBAL';

  SELECT id INTO v_backup_id
    FROM iap_mgmt.price_tier_templates_backup_global LIMIT 1;
  SELECT COUNT(*) INTO v_backup_entries
    FROM iap_mgmt.price_tier_template_entries_backup_global;

  SELECT COUNT(*) INTO v_acct_templates
    FROM iap_mgmt.price_tier_templates WHERE scope_type = 'ACCOUNT';

  -- ── IDEMPOTENCY: chạy lại M-2.
  IF v_global_id IS NULL THEN
    IF v_acct_templates > 0 THEN
      RAISE NOTICE
        '[M2/0] BỎ QUA phần dữ liệu — không còn GLOBAL, đã có % template '
        'ACCOUNT. M-2 đã chạy trước đó. Các bước CHECK/index bên dưới là '
        'idempotent nên vẫn chạy và cho ra cùng trạng thái.', v_acct_templates;
      RETURN;
    END IF;
    RAISE EXCEPTION
      'TRẠNG THÁI KHÔNG XÁC ĐỊNH: không có GLOBAL và cũng KHÔNG có template '
      'ACCOUNT nào. Đừng chạy tiếp — khôi phục từ '
      'iap_mgmt.price_tier_templates_backup_global rồi báo lại.';
  END IF;

  -- ── GUARD 1: M-1 đã chạy chưa?
  IF v_acct_templates = 0 THEN
    RAISE EXCEPTION
      'M-1 CHƯA CHẠY (0 template ACCOUNT) nhưng M-2 đang định xoá GLOBAL. '
      'Đây là lệnh xoá nguồn giá duy nhất của toàn hệ thống — dừng.';
  END IF;

  -- ── GUARD 2: mọi bản sao phải có entry. Xoá bản gốc trong lúc bản sao
  --    rỗng chính là ca "header có, entry rỗng" ở dạng tệ nhất: không còn
  --    gì để copy lại từ dòng GLOBAL nữa.
  SELECT string_agg(x.scope_account_id, ', ') INTO v_acct_empty
  FROM (
    SELECT t.scope_account_id
    FROM iap_mgmt.price_tier_templates t
    LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
    WHERE t.scope_type = 'ACCOUNT'
    GROUP BY t.scope_account_id
    HAVING COUNT(e.tier_id) = 0
  ) x;
  IF v_acct_empty IS NOT NULL THEN
    RAISE EXCEPTION
      'GUARD: template ACCOUNT RỖNG (0 entry): %. Xoá GLOBAL lúc này sẽ để '
      'lại template rỗng — orchestrator sẽ POST chỉ giá USA và im lặng. '
      'Chạy lại M-1 trước.', v_acct_empty;
  END IF;

  -- ── GUARD 3: ⚠ AI ĐÓ ĐÃ THAY DEFAULT GIỮA M-1 VÀ M-2?
  --    Guard này chỉ tồn tại được nhờ việc tách hai migration: bảng backup
  --    là ảnh chụp của ĐÚNG bản đã được nhân bản ở M-1. Nếu bản GLOBAL đang
  --    nằm đây khác ảnh đó, nghĩa là Manager đã Replace/Remove Default ở tab
  --    Settings trong lúc chờ deploy — và N bản sao đang mang nội dung CŨ.
  SELECT COUNT(*) INTO v_global_entries
    FROM iap_mgmt.price_tier_template_entries WHERE template_id = v_global_id;

  IF v_backup_id IS NULL OR v_backup_entries = 0 THEN
    RAISE EXCEPTION
      'GUARD: bảng backup của M-1 rỗng/không có. Không xác minh được bản sao '
      'khớp bản gốc — dừng.';
  END IF;

  IF v_global_id <> v_backup_id THEN
    RAISE EXCEPTION
      'GUARD: template GLOBAL hiện tại (%) KHÁC bản đã nhân bản ở M-1 (%). '
      'Default Template đã bị thay giữa M-1 và M-2 ⇒ % bản sao đang mang nội '
      'dung CŨ. Dừng. Cách xử lý: xoá các bản sao (DELETE … WHERE '
      'scope_type=''ACCOUNT'' AND origin_note IS NOT NULL), xoá 2 bảng backup, '
      'rồi chạy lại M-1.', v_global_id, v_backup_id, v_acct_templates;
  END IF;

  IF v_global_entries <> v_backup_entries THEN
    RAISE EXCEPTION
      'GUARD: template GLOBAL có % entry, ảnh chụp M-1 có %. Nội dung đã đổi '
      'giữa hai lần apply — bản sao không còn khớp. Dừng.',
      v_global_entries, v_backup_entries;
  END IF;

  RAISE NOTICE
    '[M2/0] guard OK — GLOBAL % khớp ảnh chụp M-1 (% entry) · % template '
    'ACCOUNT đều có entry.', v_global_id, v_global_entries, v_acct_templates;

  -- ── BƯỚC 1 — XOÁ GLOBAL. CASCADE dọn entry của nó.
  DELETE FROM iap_mgmt.price_tier_templates WHERE scope_type = 'GLOBAL';
  RAISE NOTICE '[M2/1] đã xoá template GLOBAL (CASCADE dọn % entry).',
    v_global_entries;
END $$;

-- ============================================================
-- BƯỚC 2 — THU HẸP cả hai CHECK (bỏ 'GLOBAL')
-- ============================================================
-- ⚠ CHỈ AN TOÀN SAU BƯỚC 1. Postgres validate CHECK mới trên TOÀN BỘ dữ
--   liệu đang có tại lúc ADD CONSTRAINT ⇒ nếu bước 1 sót dù một dòng
--   GLOBAL, lệnh này THẤT BẠI và cả transaction rollback. Vừa là thay đổi,
--   vừa là chốt kiểm miễn phí. KHÔNG được đảo thứ tự.
--
-- Tên constraint lấy từ V0c (pg_constraint) + tên M-1 đặt lại — DROP cả ba
-- biến thể để chạy lại không vỡ.
ALTER TABLE iap_mgmt.price_tier_templates
  DROP CONSTRAINT IF EXISTS price_tier_templates_scope_type_check;
ALTER TABLE iap_mgmt.price_tier_templates
  ADD CONSTRAINT price_tier_templates_scope_type_check
  CHECK (scope_type IN ('APP', 'ACCOUNT'));

ALTER TABLE iap_mgmt.price_tier_templates
  DROP CONSTRAINT IF EXISTS price_tier_templates_check;
ALTER TABLE iap_mgmt.price_tier_templates
  DROP CONSTRAINT IF EXISTS price_tier_templates_scope_coherent_check;
ALTER TABLE iap_mgmt.price_tier_templates
  ADD CONSTRAINT price_tier_templates_scope_coherent_check CHECK (
       (scope_type = 'APP'     AND scope_app_id IS NOT NULL AND scope_account_id IS NULL)
    OR (scope_type = 'ACCOUNT' AND scope_app_id IS NULL     AND scope_account_id IS NOT NULL)
  );

-- ============================================================
-- BƯỚC 3 — DROP index global_unique
-- ============================================================
-- Sau bước 2, index này canh một giá trị mà CHECK vừa cấm ⇒ chỉ còn là rác
-- gây hiểu nhầm cho người đọc sau.
-- idx_..._account_unique đã được M-1 tạo. idx_..._app_unique và
-- idx_..._uploaded KHÔNG ĐỤNG.
DROP INDEX IF EXISTS iap_mgmt.idx_iap_mgmt_price_tier_templates_global_unique;

-- ============================================================
-- BƯỚC 4 — chốt trạng thái cuối
-- ============================================================
DO $$
DECLARE v_global INT; v_acct INT; v_app INT; v_backup INT;
BEGIN
  SELECT COUNT(*) FILTER (WHERE scope_type='GLOBAL'),
         COUNT(*) FILTER (WHERE scope_type='ACCOUNT'),
         COUNT(*) FILTER (WHERE scope_type='APP')
    INTO v_global, v_acct, v_app
  FROM iap_mgmt.price_tier_templates;

  SELECT COUNT(*) INTO v_backup
    FROM iap_mgmt.price_tier_template_entries_backup_global;

  IF v_global <> 0 THEN
    RAISE EXCEPTION 'GUARD cuối M-2: vẫn còn % template GLOBAL.', v_global;
  END IF;
  IF v_acct = 0 THEN
    RAISE EXCEPTION 'GUARD cuối M-2: 0 template ACCOUNT sau khi đã xoá GLOBAL '
      '— không còn nguồn giá nào. Khôi phục từ bảng backup ngay.';
  END IF;
  IF v_backup = 0 THEN
    RAISE EXCEPTION 'GUARD cuối M-2: bảng backup rỗng — đã xoá GLOBAL mà '
      'không còn đường lui. Rollback.';
  END IF;

  RAISE NOTICE 'M-2 HOÀN TẤT — % ACCOUNT · % APP · 0 GLOBAL · backup còn % '
    'entry.', v_acct, v_app, v_backup;
  RAISE NOTICE 'TIẾP: chạy verify M2-V1…M2-V4.';
END $$;

COMMIT;
