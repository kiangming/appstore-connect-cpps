-- ============================================================
-- Migration: IAP Management — RLS off + GRANT alignment with store_mgmt
-- Forward-only fix (CLAUDE.md invariant #7) — does NOT modify
-- 20260515000000_iap_mgmt_init.sql.
--
-- ROOT CAUSE (UAT MV29 surfaced):
--   IAP.c init enabled RLS on all 8 iap_mgmt tables WITHOUT creating
--   policies, AND did not GRANT privileges to service_role / authenticated.
--   Result: 500 Internal Server Error on every supabase-js query against
--   iap_mgmt.* — Settings page, IAP create, Bulk Step 3 tier inference
--   all blocked.
--
-- WORKING SIBLING PATTERN (store_mgmt init lines 405-417):
--   GRANT USAGE ON SCHEMA store_mgmt TO authenticated, service_role;
--   GRANT ALL ON ALL TABLES IN SCHEMA store_mgmt TO service_role;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA store_mgmt GRANT ALL ON TABLES
--     TO service_role;
--   (No ROW LEVEL SECURITY enabled. Access control at Next.js layer
--    via requireStoreAccess.)
--
-- IAP.c diverged: enabled RLS + skipped GRANT block. Best-guess origin
-- = the init was hand-written from a "RLS-on by default" mental model
-- (Supabase's auto-generated init for public.* tables ships with RLS
-- on + service_role grants implicit). For custom schemas, neither the
-- RLS-on default nor the implicit service_role grant applies — the
-- writer must explicitly DISABLE RLS (or write policies) AND grant.
--
-- RESOLUTION (Manager Q-IAP.8 lock — auth at Next.js layer):
--   1. Drop RLS on all 8 iap_mgmt tables.
--   2. Grant explicit privileges to service_role + authenticated.
--   3. Default privileges for future tables added under this schema.
--
-- Note: Manager's lock includes `anon` in schema USAGE (slight surface
-- broadening vs store_mgmt's `authenticated, service_role`-only).
-- Anon role only gets schema USAGE — no table grants — so anonymous
-- queries against iap_mgmt.* still return zero rows.
--
-- Pattern 10 reuse #19 cycle 29: working-sibling diff (store_mgmt vs
-- iap_mgmt) revealed the missing migration component cleanly. Adding
-- a "compare to working sibling schema" step to the migration-author
-- checklist post-this.
-- ============================================================

-- 1. Disable RLS on all 8 iap_mgmt tables (match store_mgmt pattern).
ALTER TABLE iap_mgmt.price_tiers              DISABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.price_tier_territories   DISABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.apps                     DISABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.iaps                     DISABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.iap_localizations        DISABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.iap_screenshots          DISABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.import_batches           DISABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.actions_log              DISABLE ROW LEVEL SECURITY;

-- 2. Grant schema USAGE.
GRANT USAGE ON SCHEMA iap_mgmt TO service_role, authenticated, anon;

-- 3. Service role full access (mirrors store_mgmt).
GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA iap_mgmt TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA iap_mgmt TO service_role;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA iap_mgmt TO service_role;

-- 4. Authenticated row-level CRUD (Manager Q-IAP lock; safer to widen
--    than narrow now since the Next.js auth layer enforces actual access).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA iap_mgmt
  TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA iap_mgmt TO authenticated;

-- 5. Default privileges for any future tables in iap_mgmt (Manager
--    safety net — next migration won't repeat the IAP.c blunder).
ALTER DEFAULT PRIVILEGES IN SCHEMA iap_mgmt
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA iap_mgmt
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA iap_mgmt
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO service_role, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA iap_mgmt
  GRANT EXECUTE ON FUNCTIONS TO service_role;
