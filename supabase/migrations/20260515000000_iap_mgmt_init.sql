-- ============================================================
-- Migration: IAP Management module — init schema
-- Schema: iap_mgmt (isolated from CPP Manager's public.* + Store Management's store_mgmt.*)
-- CLAUDE.md invariant #9: schema isolation, no cross-schema FKs.
--
-- Manager scope locks (Q-IAP.1..Q-IAP.8):
--   Q1: Consumable + Non-Consumable + Non-Renewing Sub only (no auto-renewable).
--   Q6: Save as Draft default (apple_iap_id NULL = local draft).
--   Q7: Price tiers replace-on-each-import (no history).
--   Q8: Reuse global admin/member RBAC (no iap_mgmt.users table).
--
-- Access: RLS enabled, no policies → service_role only. Module access
-- enforced at Next.js layer.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS iap_mgmt;

CREATE OR REPLACE FUNCTION iap_mgmt.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- PRICE TIER CACHE (Settings → global, shared by all apps)
-- ============================================================

-- Q7: replace-on-each-import. Free Tier = tier_id 0; paid tiers 1..95+.
-- Apple may add tiers; no upper-bound CHECK to avoid forward-migration churn.
CREATE TABLE iap_mgmt.price_tiers (
  tier_id      INT          PRIMARY KEY,
  tier_name    TEXT         NOT NULL,
  imported_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  imported_by  TEXT         NOT NULL,
  CHECK (tier_id >= 0)
);

-- Denormalized cache — one row per (tier, territory). ~175 × 96 ≈ 16,800 rows.
CREATE TABLE iap_mgmt.price_tier_territories (
  tier_id         INT             NOT NULL REFERENCES iap_mgmt.price_tiers(tier_id) ON DELETE CASCADE,
  territory_code  TEXT            NOT NULL,
  currency_code   TEXT            NOT NULL,
  customer_price  NUMERIC(18, 4)  NOT NULL,
  proceeds        NUMERIC(18, 4)  NOT NULL,
  PRIMARY KEY (tier_id, territory_code)
);

CREATE INDEX idx_iap_mgmt_price_tier_territories_territory
  ON iap_mgmt.price_tier_territories(territory_code);

-- ============================================================
-- APP REGISTRY (IAP-scoped, independent from Store Mgmt + CPP)
-- ============================================================

-- Linked to CPP-side Apple app via apple_app_id (soft key, no FK — schema isolation).
CREATE TABLE iap_mgmt.apps (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  apple_app_id  TEXT         NOT NULL UNIQUE,
  bundle_id     TEXT         NOT NULL,
  name          TEXT         NOT NULL,
  active        BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_iap_mgmt_apps_bundle ON iap_mgmt.apps(bundle_id) WHERE active = true;

CREATE TRIGGER tg_iap_mgmt_apps_updated_at BEFORE UPDATE ON iap_mgmt.apps
  FOR EACH ROW EXECUTE FUNCTION iap_mgmt.set_updated_at();

-- ============================================================
-- IAP RECORDS
-- ============================================================

-- Q6 Draft model: apple_iap_id NULL = local draft (not yet pushed to Apple).
--                 apple_iap_id NOT NULL = synced; state mirrors Apple's enum.
-- state column intentionally TEXT without CHECK — Apple expands the enum over
-- time (e.g. DEVELOPER_ACTION_NEEDED, PENDING_APPLE_RELEASE). Validation lives
-- in the app layer so a new Apple state doesn't require a schema migration.
CREATE TABLE iap_mgmt.iaps (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  apple_iap_id     TEXT         UNIQUE,
  app_id           UUID         NOT NULL REFERENCES iap_mgmt.apps(id) ON DELETE CASCADE,
  product_id       TEXT         NOT NULL,
  reference_name   TEXT         NOT NULL,
  type             TEXT         NOT NULL CHECK (type IN (
                                  'CONSUMABLE',
                                  'NON_CONSUMABLE',
                                  'NON_RENEWING_SUBSCRIPTION'
                                )),
  state            TEXT         NOT NULL DEFAULT 'MISSING_METADATA',
  base_territory   TEXT         NOT NULL DEFAULT 'USA',
  tier_id          INT          REFERENCES iap_mgmt.price_tiers(tier_id) ON DELETE SET NULL,
  family_sharable  BOOLEAN      NOT NULL DEFAULT false,
  review_note      TEXT,
  synced_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, product_id)
);

CREATE INDEX idx_iap_mgmt_iaps_app ON iap_mgmt.iaps(app_id);
CREATE INDEX idx_iap_mgmt_iaps_state ON iap_mgmt.iaps(state);
CREATE INDEX idx_iap_mgmt_iaps_draft ON iap_mgmt.iaps(app_id) WHERE apple_iap_id IS NULL;

CREATE TRIGGER tg_iap_mgmt_iaps_updated_at BEFORE UPDATE ON iap_mgmt.iaps
  FOR EACH ROW EXECUTE FUNCTION iap_mgmt.set_updated_at();

-- ============================================================
-- IAP LOCALIZATIONS
-- ============================================================

-- Manager directive "có cái nào import cái đó": empty Display Name /
-- Description cells skipped at parse time — only non-empty rows reach this table.
CREATE TABLE iap_mgmt.iap_localizations (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  iap_id        UUID         NOT NULL REFERENCES iap_mgmt.iaps(id) ON DELETE CASCADE,
  locale        TEXT         NOT NULL,
  display_name  TEXT         NOT NULL,
  description   TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (iap_id, locale)
);

CREATE INDEX idx_iap_mgmt_iap_localizations_iap ON iap_mgmt.iap_localizations(iap_id);

CREATE TRIGGER tg_iap_mgmt_iap_localizations_updated_at BEFORE UPDATE ON iap_mgmt.iap_localizations
  FOR EACH ROW EXECUTE FUNCTION iap_mgmt.set_updated_at();

-- ============================================================
-- IAP REVIEW SCREENSHOTS
-- ============================================================

-- Files don't live locally — uploaded to Apple's presigned URLs directly.
-- apple_id NULL = slot reserved but not yet uploaded (recovery affordance).
CREATE TABLE iap_mgmt.iap_screenshots (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  iap_id       UUID         NOT NULL REFERENCES iap_mgmt.iaps(id) ON DELETE CASCADE,
  apple_id     TEXT         UNIQUE,
  file_name    TEXT         NOT NULL,
  file_size    INT          NOT NULL,
  checksum     TEXT,
  uploaded_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_iap_mgmt_iap_screenshots_iap ON iap_mgmt.iap_screenshots(iap_id);

-- ============================================================
-- BULK IMPORT BATCHES (audit)
-- ============================================================

CREATE TABLE iap_mgmt.import_batches (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id             UUID         REFERENCES iap_mgmt.apps(id) ON DELETE SET NULL,
  imported_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  imported_by        TEXT         NOT NULL,
  template_version   TEXT,
  total_rows         INT          NOT NULL DEFAULT 0,
  created_count      INT          NOT NULL DEFAULT 0,
  overwritten_count  INT          NOT NULL DEFAULT 0,
  skipped_count      INT          NOT NULL DEFAULT 0,
  failed_count       INT          NOT NULL DEFAULT 0,
  status             TEXT         NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                                    'PENDING', 'IN_PROGRESS', 'COMPLETE', 'FAILED'
                                  )),
  notes              TEXT
);

CREATE INDEX idx_iap_mgmt_import_batches_app
  ON iap_mgmt.import_batches(app_id, imported_at DESC);

-- ============================================================
-- ACTIONS AUDIT LOG (append-only)
-- ============================================================

CREATE TABLE iap_mgmt.actions_log (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  iap_id       UUID         REFERENCES iap_mgmt.iaps(id) ON DELETE SET NULL,
  batch_id     UUID         REFERENCES iap_mgmt.import_batches(id) ON DELETE SET NULL,
  actor        TEXT         NOT NULL,
  action_type  TEXT         NOT NULL CHECK (action_type IN (
                             'CREATE_IAP',
                             'UPDATE_IAP',
                             'DELETE_IAP',
                             'UPLOAD_SCREENSHOT',
                             'SUBMIT_TO_APPLE',
                             'SYNC_FROM_APPLE',
                             'PRICE_TIER_IMPORT',
                             'BULK_IMPORT_BATCH'
                           )),
  payload      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_iap_mgmt_actions_log_iap
  ON iap_mgmt.actions_log(iap_id, created_at DESC) WHERE iap_id IS NOT NULL;
CREATE INDEX idx_iap_mgmt_actions_log_batch
  ON iap_mgmt.actions_log(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_iap_mgmt_actions_log_created
  ON iap_mgmt.actions_log(created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
-- All iap_mgmt tables: RLS enabled, no policies → service_role only.
-- Module access enforced at Next.js layer via global admin/member RBAC (Q-IAP.8).

ALTER TABLE iap_mgmt.price_tiers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.price_tier_territories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.apps                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.iaps                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.iap_localizations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.iap_screenshots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.import_batches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.actions_log              ENABLE ROW LEVEL SECURITY;
