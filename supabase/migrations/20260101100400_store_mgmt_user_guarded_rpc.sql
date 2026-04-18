-- ============================================================
-- Migration: Store Management — guarded user mutation RPC
-- Enforces invariant "≥1 active MANAGER" atomically via FOR UPDATE locks.
-- Called from Server Actions in app/(dashboard)/store-submissions/config/team/
-- ============================================================

CREATE OR REPLACE FUNCTION store_mgmt.update_user_guarded(
  p_id            UUID,
  p_role          TEXT DEFAULT NULL,
  p_status        TEXT DEFAULT NULL,
  p_display_name  TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
  v_current               store_mgmt.users;
  v_new_role              TEXT;
  v_new_status            TEXT;
  v_other_active_managers INT;
  v_will_be_active_manager BOOLEAN;
BEGIN
  -- Lock the target row first (avoids deadlock with manager-set lock below).
  SELECT * INTO v_current
  FROM store_mgmt.users
  WHERE id = p_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: user % does not exist', p_id;
  END IF;

  v_new_role   := COALESCE(p_role, v_current.role);
  v_new_status := COALESCE(p_status, v_current.status);
  v_will_be_active_manager := (v_new_role = 'MANAGER' AND v_new_status = 'active');

  -- Lock every OTHER active manager row to serialize concurrent demotions.
  -- Without this lock two managers could demote each other in parallel and
  -- both succeed, leaving zero active managers.
  SELECT COUNT(*) INTO v_other_active_managers
  FROM store_mgmt.users
  WHERE id <> p_id
    AND role = 'MANAGER'
    AND status = 'active'
  FOR UPDATE;

  -- Invariant: system must retain ≥1 active MANAGER after this mutation.
  IF NOT v_will_be_active_manager AND v_other_active_managers = 0 THEN
    RAISE EXCEPTION 'LAST_MANAGER: cannot demote or disable the last active MANAGER';
  END IF;

  UPDATE store_mgmt.users
  SET
    role         = COALESCE(p_role,         role),
    status       = COALESCE(p_status,       status),
    display_name = COALESCE(p_display_name, display_name)
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.update_user_guarded IS
  'Guarded mutation for store_mgmt.users. Enforces >=1 active MANAGER invariant via FOR UPDATE lock + pre-check. Raises LAST_MANAGER or NOT_FOUND on violation.';
