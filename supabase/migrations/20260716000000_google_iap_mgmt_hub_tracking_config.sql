-- Migration: VNGGames Hub tracking config for Google IAP Management Bulk Import.
-- Schema: google_iap_mgmt (SEPARATE from Apple IAP Management's iap_mgmt.
-- hub_tracking_config — its own workflow_id/token/enabled, per schema
-- isolation; Google tracks to its own Hub workflow, distinct from Apple's).
--
-- Byte-for-byte the same shape as iap_mgmt.hub_tracking_config
-- (20260715000000_iap_mgmt_hub_tracking_config.sql): singleton row
-- (id = 'default'), token encrypted (AES-256-GCM via lib/asc-crypto.ts),
-- RLS enabled with no policies (service_role only), is_active soft-delete
-- flag, created_by + timestamps audit columns, `enabled` Settings toggle
-- distinct from `is_active`. Reuses the already-existing
-- google_iap_mgmt.set_updated_at() trigger function (defined in
-- 20260520010000_google_iap_mgmt_init.sql) — no new trigger function
-- needed.

CREATE TABLE IF NOT EXISTS google_iap_mgmt.hub_tracking_config (
  id           TEXT        PRIMARY KEY DEFAULT 'default',
  workflow_id  TEXT        NOT NULL,
  token_enc    TEXT        NOT NULL,              -- AES-256-GCM encrypted, base64-packed
  enabled      BOOLEAN     NOT NULL DEFAULT true,  -- Settings toggle — off fully no-ops tracking
  is_active    BOOLEAN     NOT NULL DEFAULT true,  -- Soft delete flag
  created_by   TEXT,                               -- Email of admin who last saved config
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE google_iap_mgmt.hub_tracking_config ENABLE ROW LEVEL SECURITY;
-- No policies created → only service_role can access.

CREATE TRIGGER tg_google_iap_mgmt_hub_tracking_config_updated_at
  BEFORE UPDATE ON google_iap_mgmt.hub_tracking_config
  FOR EACH ROW EXECUTE FUNCTION google_iap_mgmt.set_updated_at();
