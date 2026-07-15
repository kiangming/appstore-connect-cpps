-- Migration: VNGGames Hub tracking config for Apple IAP Management Bulk Import.
-- Schema: iap_mgmt (IAP-bulk-import-only — not shared with CPP Manager's
-- public.* asc_accounts, per CLAUDE.md invariant #9 schema isolation).
--
-- Singleton row (id = 'default'). Mirrors public.asc_accounts: token stored
-- encrypted (AES-256-GCM via lib/asc-crypto.ts), RLS enabled with no
-- policies (service_role only), is_active soft-delete flag, created_by +
-- timestamps audit columns.
--
-- `enabled` is distinct from `is_active`: `is_active` marks this row as the
-- current config row (soft-delete precedent from asc_accounts); `enabled`
-- is the user-facing on/off toggle in Settings that fully no-ops tracking
-- without discarding the stored workflow_id/token.

CREATE TABLE IF NOT EXISTS iap_mgmt.hub_tracking_config (
  id           TEXT        PRIMARY KEY DEFAULT 'default',
  workflow_id  TEXT        NOT NULL,
  token_enc    TEXT        NOT NULL,              -- AES-256-GCM encrypted, base64-packed
  enabled      BOOLEAN     NOT NULL DEFAULT true,  -- Settings toggle — off fully no-ops tracking
  is_active    BOOLEAN     NOT NULL DEFAULT true,  -- Soft delete flag
  created_by   TEXT,                               -- Email of admin who last saved config
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE iap_mgmt.hub_tracking_config ENABLE ROW LEVEL SECURITY;
-- No policies created → only service_role can access.

CREATE TRIGGER tg_iap_mgmt_hub_tracking_config_updated_at
  BEFORE UPDATE ON iap_mgmt.hub_tracking_config
  FOR EACH ROW EXECUTE FUNCTION iap_mgmt.set_updated_at();
