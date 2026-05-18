-- ============================================================
-- IAP.p1.j — Manager MV30 v9 hotfix schema additions
-- ============================================================
--
-- 1) iap_mgmt.iaps.pricing_source — Manager Q-J: Per-IAP explicit
--    selection MUST persist across Save Draft / reload. Previously held
--    only in client form state, so the page server re-derived the Q-D
--    most-specific default on reload and silently overrode the user's
--    APPLE choice. Capturing it on the IAP row fixes the round-trip.
--
-- 2) iap_mgmt.apps.asc_account_id — Manager directive: surface the ASC
--    account that owns each app on the "Apps with custom templates"
--    table. Soft reference (TEXT, no FK) since asc_accounts lives in
--    public schema and CLAUDE.md invariant #9 forbids cross-schema FKs.
--    ensureAppRegistered() captures the active ASC account at first
--    registration; pre-IAP.p1.j rows are NULL and surface as "—" until
--    Manager re-saves a draft / re-uploads a template under them.
--
-- Forward-only (CLAUDE.md invariant #7). Both columns nullable so the
-- migration is safe to apply against populated tables.
-- ============================================================

ALTER TABLE iap_mgmt.iaps
  ADD COLUMN IF NOT EXISTS pricing_source TEXT
    CHECK (pricing_source IS NULL OR pricing_source IN ('APPLE', 'DEFAULT_TEMPLATE', 'APP_TEMPLATE'));

ALTER TABLE iap_mgmt.apps
  ADD COLUMN IF NOT EXISTS asc_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_iap_mgmt_apps_asc_account
  ON iap_mgmt.apps(asc_account_id) WHERE asc_account_id IS NOT NULL;
