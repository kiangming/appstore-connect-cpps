-- ============================================================
-- Đọc BODY LỖI ĐẦY ĐỦ của lần chạy bulk import chienky TIẾP THEO
--
-- Dùng SAU KHI arc `arc-google403-error-observability` (O1-O3) đã deploy
-- lên Railway, và Manager đã chạy lại bulk import cho
-- `vng.games.tamquoc.chienky` ĐÚNG MỘT LẦN.
--
-- ⚠ CHỈ ĐỌC. Không UPDATE, không INSERT, không DELETE.
--
-- ⚠ CHẠY SAI THỜI ĐIỂM THÌ VÔ NGHĨA: các cột `error_status` /
--    `error_details` CHỈ tồn tại trong payload của những lần chạy SAU khi
--    code mới đã live. Hai lần hỏng ngày 2026-10-12 nằm trước đó nên
--    chúng chỉ có `error` — xem §3 để phân biệt "chưa deploy" với
--    "Google không trả trường đó".
-- ============================================================


-- ─── §1. TRUY VẤN CHÍNH — một dòng, lần chạy mới nhất ────────────────
SELECT
  l.created_at,
  l.actor_email,
  l.payload->>'package_name'      AS package_name,
  l.payload->>'batch_id'          AS batch_id,
  l.payload->>'rows_total'        AS rows_total,
  l.payload->>'rows_failed'       AS rows_failed,

  -- ── Lỗi của API MỚI (monetization.onetimeproducts.batchUpdate) ──
  -- Đây là lỗi Manager nhìn thấy trên màn hình.
  l.payload->>'error'             AS error_message,
  l.payload->>'error_status'      AS error_status,       -- ⭐ ĐỌC CỘT NÀY TRƯỚC
  l.payload->>'error_http_status' AS error_http_status,
  l.payload->'error_reasons'      AS error_reasons,
  jsonb_pretty(
    COALESCE(l.payload->'error_details', '[]'::jsonb)
  )                               AS error_details,      -- ⭐ RỒI ĐẾN CỘT NÀY
  l.payload->>'error_full'        AS error_full,

  -- ── Lỗi của API CŨ (inappproducts.batchUpdate) ──
  -- Trước O1 nửa này bị xoá sạch. Chỉ có mặt khi CẢ HAI đường đều hỏng.
  l.payload->>'error_both_paths_failed' AS both_paths_failed,
  l.payload->>'error_fallback'          AS fallback_message,
  l.payload->>'error_fallback_status'   AS fallback_status,
  l.payload->>'error_fallback_full'     AS fallback_full,

  -- ── Danh tính đã dùng (suy ra từ app, xem §4) ──
  acc.id                          AS account_id_used,
  acc.service_account_email       AS sa_email_used
FROM google_iap_mgmt.actions_log l
LEFT JOIN google_iap_mgmt.apps a
  ON a.id = l.target_id
LEFT JOIN google_iap_mgmt.google_console_accounts acc
  ON acc.id = a.google_console_account_id
WHERE l.action_type = 'BULK_IMPORT_BATCH'
  AND l.payload->>'package_name' = 'vng.games.tamquoc.chienky'
ORDER BY l.created_at DESC
LIMIT 1;


-- ============================================================
-- §2. KỲ VỌNG
-- ============================================================
--
-- ⭐ ĐÚNG 1 DÒNG, với `created_at` SAU thời điểm deploy, và:
--
--   • `error_status`  KHÔNG rỗng — ví dụ `PERMISSION_DENIED`
--   • `error_details` là một mảng JSON, KHÔNG phải `[]`
--   • `error_full`    dài hơn `error_message` (nó là cả body, không cắt)
--   • `sa_email_used` = pin-iap-tool-vnggvn@services-299407.iam.gserviceaccount.com
--
-- Nếu `created_at` TRƯỚC thời điểm deploy ⇒ Manager chưa chạy lại.
-- Đừng đọc tiếp, chạy lại bulk import một lần rồi chạy lại truy vấn này.


-- ============================================================
-- §3. CÁCH ĐỌC KẾT QUẢ
-- ============================================================
--
-- ⭐ ĐỌC `error_status` TRƯỚC, ĐỪNG ĐỌC `error_message` TRƯỚC.
--    `error_message` ("The caller does not have permission") GIỐNG NHAU ở
--    mọi nguyên nhân — nó chính là lý do sự cố này phải điều tra bằng suy
--    luận. `error_status` là enum, nó phân biệt được.
--
-- ── Theo `error_status` ──────────────────────────────────────────────
--
--   PERMISSION_DENIED
--     Google từ chối vì quyền. Đọc tiếp `error_details[].reason`:
--       • IAM_PERMISSION_DENIED          → thiếu quyền trên tài nguyên
--       • ACCESS_TOKEN_SCOPE_INSUFFICIENT → thiếu scope OAuth
--       • SERVICE_DISABLED                → API chưa bật ở project đó
--       • USER_PROJECT_DENIED             → sai project
--     `error_details[].metadata` thường nêu ĐÍCH DANH quyền hoặc service
--     còn thiếu. Đó là câu trả lời mà cả arc này sinh ra để lấy.
--
--   FAILED_PRECONDITION
--     Không phải chuyện quyền. Trạng thái app/tài nguyên chặn lệnh ghi —
--     tức ứng viên (3) "trạng thái riêng của app" trong kết luận điều tra.
--
--   NOT_FOUND
--     Service account không nhìn thấy app. Nghiêng về ứng viên (1)
--     "chienky thuộc developer account KHÁC".
--
--   INVALID_ARGUMENT
--     Lỗi body, không phải lỗi quyền. Cùng họ với
--     [GOOGLE-tinywar-missing-default].
--
-- ── Theo `both_paths_failed` ─────────────────────────────────────────
--
--   't'          → CẢ API mới lẫn API cũ đều hỏng. So `error_status` với
--                  `fallback_status`: KHÁC NHAU nghĩa là hai đường bị chặn
--                  vì hai lý do khác nhau, và câu chữ giống nhau chỉ là
--                  trùng hợp — đúng cái bẫy đã làm lượt điều tra đầu mất
--                  một vòng.
--   NULL/rỗng    → chỉ API mới hỏng, API cũ KHÔNG được thử hoặc đã chạy
--                  được.
--
-- ⚠ `error_status` RỖNG mà `created_at` SAU deploy
--    ⇒ Google KHÔNG trả `error.status` trong body lần đó. Lúc đó đọc
--      `error_full` — nó là body nguyên vẹn, chưa cắt.
--    ⇒ KHÔNG kết luận "code chưa deploy" chỉ vì cột này rỗng.
--
-- ⚠ Thấy `[REDACTED PRIVATE KEY]` trong `error_full` là ĐÚNG, không phải
--    lỗi. Google thỉnh thoảng dội ngược đuôi private key trong lỗi scope;
--    tool chủ động xoá trước khi lưu.


-- ============================================================
-- §4. PHỤ — vì sao `sa_email_used` ở §1 là danh tính THẬT đã ký
-- ============================================================
--
-- Không phải suy đoán, là cấu trúc:
--   orchestrator ghi  targetId = input.appId
--   route truyền      appId    = app.id
--   mà `app` lấy từ   getAppByPackage(accountId, packageName)
--   và credential lấy từ getEncryptedCredentials(CÙNG accountId đó)
-- ⇒ `apps.google_console_account_id` CHÍNH LÀ account đã ký JWT.
--
-- Từ lần chạy sau khi O3 deploy, log Railway cũng in thẳng danh tính,
-- không cần suy ra nữa:
--   [google-iap:publisher] method=… pkg=… acct=<uuid> sa=<email> …
--
--
-- ─── §5. Nếu cần xem CẢ LỊCH SỬ package này (bỏ LIMIT 1) ─────────────
-- Dùng khi muốn so lần chạy mới với hai lần hỏng ngày 2026-10-12.
--
-- SELECT
--   l.created_at,
--   l.payload->>'rows_failed'   AS rows_failed,
--   l.payload->>'error_status'  AS error_status,
--   l.payload->>'error'         AS error_message
-- FROM google_iap_mgmt.actions_log l
-- WHERE l.action_type = 'BULK_IMPORT_BATCH'
--   AND l.payload->>'package_name' = 'vng.games.tamquoc.chienky'
-- ORDER BY l.created_at DESC;
