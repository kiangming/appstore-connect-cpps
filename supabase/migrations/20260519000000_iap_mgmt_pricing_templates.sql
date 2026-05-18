-- ============================================================
-- IAP.p1.a — Pricing Templates (Default + Per-App) + data migration
-- ============================================================
--
-- Manager directive (IAP.p1 Q-A..Q-K, May 2026): introduce 3-tier pricing
-- source model — Apple base / Default Template / App-specific Template.
-- Sparse templates permitted; missing entries fall back to Apple's
-- auto-equalization (Q-C verified positive).
--
-- Q-B Manager override: existing price_tier_territories data is migrated
-- to Default Template entries (NOT treated as a separate Apple base cache
-- as initial investigation suggested). price_tier_territories table is
-- KEPT as defensive backup until IAP.p2+ cleanup.
--
-- Replace-only semantics (Q-A): one Default Template + at most one
-- per-App Template, enforced by partial unique indexes. New upload
-- replaces entries via ON DELETE CASCADE from the header row.
--
-- Forward-only per CLAUDE.md invariant #7.
-- ============================================================

-- ── Header: one row per template upload ─────────────────────────────────
CREATE TABLE iap_mgmt.price_tier_templates (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type       TEXT         NOT NULL CHECK (scope_type IN ('GLOBAL', 'APP')),
  scope_app_id     UUID         REFERENCES iap_mgmt.apps(id) ON DELETE CASCADE,
  uploaded_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  uploaded_by      TEXT         NOT NULL,
  source_filename  TEXT,
  -- GLOBAL templates MUST have scope_app_id NULL; APP templates MUST have it set.
  CHECK (
    (scope_type = 'GLOBAL' AND scope_app_id IS NULL)
    OR
    (scope_type = 'APP' AND scope_app_id IS NOT NULL)
  )
);

-- Q-A replace-only: at most one Default Template (GLOBAL) and at most one
-- template per app (APP). Partial unique indexes are NULL-friendly so the
-- GLOBAL row's NULL scope_app_id doesn't collide with itself.
CREATE UNIQUE INDEX idx_iap_mgmt_price_tier_templates_global_unique
  ON iap_mgmt.price_tier_templates(scope_type)
  WHERE scope_type = 'GLOBAL';

CREATE UNIQUE INDEX idx_iap_mgmt_price_tier_templates_app_unique
  ON iap_mgmt.price_tier_templates(scope_app_id)
  WHERE scope_type = 'APP';

CREATE INDEX idx_iap_mgmt_price_tier_templates_uploaded
  ON iap_mgmt.price_tier_templates(uploaded_at DESC);

-- ── Entries: sparse (tier, territory) overrides per template ────────────
CREATE TABLE iap_mgmt.price_tier_template_entries (
  template_id     UUID            NOT NULL REFERENCES iap_mgmt.price_tier_templates(id) ON DELETE CASCADE,
  tier_id         TEXT            NOT NULL REFERENCES iap_mgmt.price_tiers(tier_id) ON DELETE CASCADE,
  territory_code  TEXT            NOT NULL,
  currency_code   TEXT            NOT NULL,
  customer_price  NUMERIC(18, 4)  NOT NULL,
  -- Proceeds nullable: Manager's sparse template only needs customer_price;
  -- proceeds is informational and may be omitted when sparse cell is filled.
  proceeds        NUMERIC(18, 4),
  PRIMARY KEY (template_id, tier_id, territory_code)
);

CREATE INDEX idx_iap_mgmt_price_tier_template_entries_lookup
  ON iap_mgmt.price_tier_template_entries(template_id, tier_id);

-- ── RLS ────────────────────────────────────────────────────────────────
-- Same convention as other iap_mgmt tables: RLS on, no policies → service_role
-- only. Module access enforced at Next.js layer.
ALTER TABLE iap_mgmt.price_tier_templates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE iap_mgmt.price_tier_template_entries  ENABLE ROW LEVEL SECURITY;

-- ── Q-B data migration: existing price_tier_territories → Default Template ─
-- If Manager has already uploaded a price-tiers template (price_tier_territories
-- has rows), promote that data into a Default Template so the new
-- orchestration model picks it up unchanged on first run. If the table is
-- empty (fresh install / pre-import), skip — Manager uploads first themselves.
DO $$
DECLARE
  v_template_id UUID;
  v_territory_rows INT;
BEGIN
  SELECT COUNT(*) INTO v_territory_rows FROM iap_mgmt.price_tier_territories;

  IF v_territory_rows > 0 THEN
    INSERT INTO iap_mgmt.price_tier_templates (scope_type, scope_app_id, uploaded_by, source_filename)
    VALUES ('GLOBAL', NULL, 'SYSTEM_MIGRATION', 'initial-migration-from-price_tier_territories')
    RETURNING id INTO v_template_id;

    INSERT INTO iap_mgmt.price_tier_template_entries
      (template_id, tier_id, territory_code, currency_code, customer_price, proceeds)
    SELECT v_template_id, tier_id, territory_code, currency_code, customer_price, proceeds
    FROM iap_mgmt.price_tier_territories;
  END IF;
END $$;
