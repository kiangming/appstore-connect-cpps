-- Migration: VNGGames Hub tracking config for CPP Management Bulk Import.
-- Schema: public (CPP Manager's existing schema, alongside asc_accounts —
-- CPP predates the per-module schema-isolation convention iap_mgmt /
-- google_iap_mgmt use, so this table is CPP-prefixed instead of living in a
-- dedicated schema, per docs/cpp-management/design-cpp-hub-tracking.md §2.E).
--
-- Singleton row (id = 'default'). Same shape as iap_mgmt.hub_tracking_config /
-- google_iap_mgmt.hub_tracking_config: token stored encrypted (AES-256-GCM
-- via lib/asc-crypto.ts — same helper asc_accounts.private_key_enc already
-- uses), RLS enabled with no policies (service_role only), is_active
-- soft-delete flag, created_by + timestamps audit columns.
--
-- `enabled` is distinct from `is_active`: `is_active` marks this row as the
-- current config row (soft-delete precedent from asc_accounts); `enabled`
-- is the user-facing on/off toggle in Settings that fully no-ops tracking
-- without discarding the stored workflow_id/token.

CREATE TABLE IF NOT EXISTS cpp_hub_tracking_config (
  id           TEXT        PRIMARY KEY DEFAULT 'default',
  workflow_id  TEXT        NOT NULL,
  token_enc    TEXT        NOT NULL,              -- AES-256-GCM encrypted, base64-packed
  enabled      BOOLEAN     NOT NULL DEFAULT true,  -- Settings toggle — off fully no-ops tracking
  is_active    BOOLEAN     NOT NULL DEFAULT true,  -- Soft delete flag
  created_by   TEXT,                               -- Email of admin who last saved config
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cpp_hub_tracking_config ENABLE ROW LEVEL SECURITY;
-- No policies created → only service_role can access.

-- Reuses the same trigger function asc_accounts already installed in this
-- schema (20260407000000_create_asc_accounts.sql) — no new function needed.
CREATE TRIGGER cpp_hub_tracking_config_updated_at
  BEFORE UPDATE ON cpp_hub_tracking_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
