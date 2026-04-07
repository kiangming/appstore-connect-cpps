-- Migration: ASC Accounts table
-- Stores App Store Connect API credentials with encrypted private keys.
-- Access: service_role only (RLS enabled, no policies → anon/authenticated blocked).

CREATE TABLE IF NOT EXISTS asc_accounts (
  id               TEXT        PRIMARY KEY,           -- e.g. "vng", "vngsing"
  name             TEXT        NOT NULL,              -- Display name, e.g. "VNG Corp"
  key_id           TEXT        NOT NULL,              -- ASC Key ID (not secret)
  issuer_id        TEXT        NOT NULL,              -- ASC Issuer ID (not secret)
  private_key_enc  TEXT        NOT NULL,              -- AES-256-GCM encrypted, base64-packed
  is_active        BOOLEAN     NOT NULL DEFAULT true, -- Soft delete flag
  created_by       TEXT,                              -- Email of admin who created
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Block all access except service_role (which bypasses RLS)
ALTER TABLE asc_accounts ENABLE ROW LEVEL SECURITY;
-- No policies created → only service_role can access

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER asc_accounts_updated_at
  BEFORE UPDATE ON asc_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Index for active accounts query (the hot path)
CREATE INDEX IF NOT EXISTS asc_accounts_active_idx
  ON asc_accounts (is_active, created_at);
