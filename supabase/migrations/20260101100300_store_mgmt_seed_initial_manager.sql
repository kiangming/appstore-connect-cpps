-- ============================================================
-- Migration: Store Management — seed initial MANAGER user
--
-- USAGE:
-- Before running, set session variable:
--   SET app.initial_manager_email = 'manager@yourcompany.com';
--
-- Or in CI:
--   psql $DATABASE_URL \
--     -v initial_manager_email="'manager@yourcompany.com'" \
--     -f 20260101100300_store_mgmt_seed_initial_manager.sql
--
-- Safe to re-run: idempotent via ON CONFLICT DO NOTHING.
-- ============================================================

DO $$
DECLARE
  manager_email TEXT;
BEGIN
  BEGIN
    manager_email := current_setting('app.initial_manager_email');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'app.initial_manager_email not set, skipping initial manager seed';
    RETURN;
  END;

  IF manager_email IS NULL OR manager_email = '' THEN
    RAISE NOTICE 'Empty manager email, skipping';
    RETURN;
  END IF;

  INSERT INTO store_mgmt.users (email, role, display_name, status)
  VALUES (manager_email, 'MANAGER', 'Initial Manager', 'active')
  ON CONFLICT (email) DO NOTHING;

  RAISE NOTICE 'Initial store_mgmt manager seeded: %', manager_email;
END $$;
