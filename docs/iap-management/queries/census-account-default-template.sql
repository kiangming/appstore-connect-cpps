-- ═══════════════════════════════════════════════════════════════════════════
-- CENSUS — [ACCOUNT-default-template] P0.5
-- Tách Default Price Template theo từng ASC account.
--
-- ⚠ ĐỌC TRƯỚC KHI CHẠY
--   • Tất cả query ở đây là READ-ONLY. Không có INSERT/UPDATE/DELETE.
--   • Chạy trong Supabase SQL Editor. Copy kết quả (hoặc screenshot) gửi lại.
--   • Con số của Q2 (bao nhiêu IAP đang dùng DEFAULT_TEMPLATE) là con số
--     QUYẾT ĐỊNH rủi ro migration — nếu = 0 thì cả 3 phương án đều rẻ;
--     nếu > 0 thì Phương án "bỏ hẳn GLOBAL" làm mất nguồn giá của đúng
--     những dòng đó.
--   • Q5 là điểm mù: app chưa có asc_account_id thì KHÔNG map được về
--     account nào — đây là dữ liệu phải backfill trước khi migrate.
--
-- Lưu ý về schema: `asc_accounts` nằm ở schema `public` (kho credential dùng
-- chung CPP + IAP), `apps`/`iaps`/`price_tier_templates` nằm ở `iap_mgmt`.
-- Các JOIN dưới đây là DIAGNOSTIC thủ công. Code KHÔNG được join cross-schema
-- (CLAUDE.md invariant #9) — code đọc account qua findAllAccounts().
-- ═══════════════════════════════════════════════════════════════════════════


-- ─── Q1. Có mấy template GLOBAL, bao nhiêu entry? ───────────────────────────
-- KỲ VỌNG: đúng 1 dòng (partial unique index ép tối đa 1 GLOBAL).
-- Nếu trả 0 dòng → chưa từng upload Default Template, migration risk = 0.
SELECT
  t.id                AS template_id,
  t.scope_type,
  t.scope_app_id,
  t.uploaded_at,
  t.uploaded_by,
  t.source_filename,
  COUNT(e.tier_id)                        AS entry_count,
  COUNT(DISTINCT e.tier_id)               AS tier_count,
  COUNT(DISTINCT e.territory_code)        AS territory_count
FROM iap_mgmt.price_tier_templates t
LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'GLOBAL'
GROUP BY t.id, t.scope_type, t.scope_app_id, t.uploaded_at, t.uploaded_by, t.source_filename;


-- ─── Q2. Bao nhiêu IAP đang pricing_source = DEFAULT_TEMPLATE? ──────────────
-- ⚠ ĐÂY LÀ CON SỐ QUYẾT ĐỊNH. Phân bố theo account + app.
-- account_id NULL = app chưa được gán ASC account (xem Q5).
SELECT
  COALESCE(a.asc_account_id, '(chưa gán account)') AS asc_account_id,
  acc.name                                          AS account_name,
  a.apple_app_id,
  a.name                                            AS app_name,
  COUNT(*)                                          AS iap_count,
  COUNT(*) FILTER (WHERE i.apple_iap_id IS NOT NULL) AS da_len_apple,
  COUNT(*) FILTER (WHERE i.apple_iap_id IS NULL)     AS con_la_draft
FROM iap_mgmt.iaps i
JOIN iap_mgmt.apps a  ON a.id = i.app_id
LEFT JOIN public.asc_accounts acc ON acc.id = a.asc_account_id
WHERE i.pricing_source = 'DEFAULT_TEMPLATE'
GROUP BY a.asc_account_id, acc.name, a.apple_app_id, a.name
ORDER BY iap_count DESC;

-- Q2b. Tổng thể phân bố pricing_source (mẫu số để đọc Q2).
-- NULL = IAP tạo trước IAP.p1.j (chưa có cột) → orchestrator coi như APPLE.
SELECT
  COALESCE(i.pricing_source, '(NULL — mặc định APPLE)') AS pricing_source,
  COUNT(*) AS iap_count
FROM iap_mgmt.iaps i
GROUP BY i.pricing_source
ORDER BY iap_count DESC;


-- ─── Q3. Bao nhiêu template APP đang tồn tại, thuộc account nào? ────────────
SELECT
  COALESCE(a.asc_account_id, '(chưa gán account)') AS asc_account_id,
  acc.name          AS account_name,
  a.apple_app_id,
  a.name            AS app_name,
  t.id              AS template_id,
  t.uploaded_at,
  t.uploaded_by,
  COUNT(e.tier_id)  AS entry_count
FROM iap_mgmt.price_tier_templates t
JOIN iap_mgmt.apps a  ON a.id = t.scope_app_id
LEFT JOIN public.asc_accounts acc ON acc.id = a.asc_account_id
LEFT JOIN iap_mgmt.price_tier_template_entries e ON e.template_id = t.id
WHERE t.scope_type = 'APP'
GROUP BY a.asc_account_id, acc.name, a.apple_app_id, a.name, t.id, t.uploaded_at, t.uploaded_by
ORDER BY asc_account_id, entry_count DESC;

-- Q3b. Gộp: mỗi account có mấy app-template.
SELECT
  COALESCE(a.asc_account_id, '(chưa gán account)') AS asc_account_id,
  acc.name AS account_name,
  COUNT(*) AS app_template_count
FROM iap_mgmt.price_tier_templates t
JOIN iap_mgmt.apps a ON a.id = t.scope_app_id
LEFT JOIN public.asc_accounts acc ON acc.id = a.asc_account_id
WHERE t.scope_type = 'APP'
GROUP BY a.asc_account_id, acc.name
ORDER BY app_template_count DESC;


-- ─── Q4. Danh sách account đang có trong tool (mẫu số của "N account") ──────
-- Đây là N trong phương án "migrate GLOBAL thành template của cả N account".
SELECT
  acc.id,
  acc.name,
  acc.is_active,
  COUNT(a.id) AS so_app_da_dang_ky_trong_iap_mgmt
FROM public.asc_accounts acc
LEFT JOIN iap_mgmt.apps a ON a.asc_account_id = acc.id
GROUP BY acc.id, acc.name, acc.is_active
ORDER BY acc.is_active DESC, acc.name;


-- ─── Q5. ĐIỂM MÙ — app chưa có asc_account_id ──────────────────────────────
-- Cột apps.asc_account_id là NULLABLE và chỉ được ghi từ IAP.p1.j trở đi
-- (ensureAppRegistered). App đăng ký trước đó = NULL → KHÔNG suy ra được
-- account. Mọi phương án account-scoped đều phải xử lý nhóm này.
SELECT
  a.id            AS internal_app_id,
  a.apple_app_id,
  a.name          AS app_name,
  a.bundle_id,
  a.created_at,
  (SELECT COUNT(*) FROM iap_mgmt.iaps i WHERE i.app_id = a.id) AS iap_count,
  (SELECT COUNT(*) FROM iap_mgmt.price_tier_templates t
     WHERE t.scope_type = 'APP' AND t.scope_app_id = a.id)     AS co_app_template
FROM iap_mgmt.apps a
WHERE a.asc_account_id IS NULL
ORDER BY iap_count DESC;

-- Q5b. Tỷ lệ: bao nhiêu app đã gán / chưa gán account.
SELECT
  CASE WHEN asc_account_id IS NULL THEN 'chưa gán' ELSE 'đã gán' END AS trang_thai,
  COUNT(*) AS app_count
FROM iap_mgmt.apps
GROUP BY 1;


-- ─── Q6. Cột thứ HAI cũng mang enum pricing_source (dễ bị bỏ sót) ──────────
-- iaps.custom_prices_baseline_pricing_source (migration 20260812000000) lưu
-- "nguồn giá lúc chốt baseline custom-prices". Cùng CHECK, cùng tập giá trị.
-- Nếu đổi ý nghĩa/tập giá trị của enum thì cột này đổi theo.
SELECT
  COALESCE(custom_prices_baseline_pricing_source, '(NULL — chưa có custom)') AS baseline_source,
  COUNT(*) AS iap_count
FROM iap_mgmt.iaps
GROUP BY 1
ORDER BY iap_count DESC;


-- ─── Q7. Lịch sử upload template (ai upload, khi nào, scope gì) ────────────
-- Đọc từ audit log. action_type = 'PRICE_TIER_IMPORT' dùng chung cho cả
-- upload lẫn delete (delete có payload.op = 'delete_template').
SELECT
  l.created_at,
  l.actor,
  l.payload ->> 'scope'          AS scope,
  l.payload ->> 'op'             AS op,
  l.payload ->> 'entry_count'    AS entry_count,
  l.payload ->> 'scope_app_id'   AS scope_app_id
FROM iap_mgmt.actions_log l
WHERE l.action_type = 'PRICE_TIER_IMPORT'
ORDER BY l.created_at DESC
LIMIT 50;
