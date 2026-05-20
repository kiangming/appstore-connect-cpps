-- ============================================================
-- Migration: Google IAP Management module — init schema
-- Schema: google_iap_mgmt
--   Isolated from CPP Manager (public.*), Store Management (store_mgmt.*),
--   and Apple IAP Management (iap_mgmt.*). CLAUDE.md invariant #9.
--
-- Cycle 35 Phase 3 Session 1 — g1.a (Manager Q-GIAP locks A..J):
--   Q-GIAP.A: In-app products only v1 (subscriptions deferred to v2).
--   Q-GIAP.B: Service account JSON → encrypted DB blob (AES-256-GCM).
--   Q-GIAP.C: Reporting API apps:search (GET, cursor pagination).
--   Q-GIAP.D: Excel template parser deferred — schema accepts identifier TEXT
--             so SKU-mode AND tier-mode entries both round-trip.
--   Q-GIAP.E: batchUpdate single-call execution; per-row overwrite/skip carried
--             in import_batches counters only (no per-row decision table in v1).
--   Q-GIAP.F: Decimal Manager input → tool converts to micros (string). Stored
--             as TEXT to match Google's serialization (priceMicros is string).
--   Q-GIAP.G: Multi-region pricing v1 — iap_prices sparse per-region overrides.
--   Q-GIAP.H: Route-based context resolver — no schema-level enforcement; the
--             /google-iap-management/* layout selects google_console_accounts.
--   Q-GIAP.I: Create active default — iaps.status defaults to 'active'.
--   Q-GIAP.J: Multi-locale full v1 — iap_listings keyed (iap_id, locale).
--
-- RLS DECISION — bake the fix in, don't repeat the IAP.c blunder:
--   IAP.c (iap_mgmt init, May 2026) shipped RLS-on + no policies + no GRANTs,
--   causing 500s on every supabase-js query until 20260515020000 patched it.
--   This init follows the working store_mgmt pattern from the start:
--   RLS DISABLED on all tables, explicit GRANTs to service_role + authenticated,
--   DEFAULT PRIVILEGES so future tables under google_iap_mgmt inherit grants.
--   Module-level access enforcement lives at the Next.js layer (route guards
--   + Google Console account context resolver per Q-GIAP.H).
--
-- Forward-only per CLAUDE.md invariant #7.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS google_iap_mgmt;

CREATE OR REPLACE FUNCTION google_iap_mgmt.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 1. google_console_accounts
--    Encrypted service account credential vault. One row per uploaded
--    .json file. Verify action tests BOTH scopes (androidpublisher AND
--    playdeveloperreporting) before flipping status → 'verified'.
-- ============================================================
CREATE TABLE google_iap_mgmt.google_console_accounts (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name            TEXT         NOT NULL,
  service_account_email   TEXT         NOT NULL,
  -- AES-256-GCM ciphertext of the full service-account JSON. Encryption
  -- handled at the app layer via GOOGLE_CREDENTIALS_ENCRYPTION_KEY (NEVER
  -- rotate in production; rotate-equivalent = re-upload all credentials).
  encrypted_credentials   TEXT         NOT NULL,
  -- 'pending' = uploaded but Verify not run yet
  -- 'verified' = both API scopes return 200 OK
  -- 'invalid' = last Verify failed (auth error or scope missing)
  status                  TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN (
                                         'pending', 'verified', 'invalid'
                                       )),
  verified_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Multiple .json files might share the same service account email (rotation),
  -- so no UNIQUE on email. Display name is the human handle.
  UNIQUE (display_name)
);

CREATE INDEX idx_google_iap_mgmt_console_accounts_status
  ON google_iap_mgmt.google_console_accounts(status);

CREATE TRIGGER tg_google_iap_mgmt_console_accounts_updated_at
  BEFORE UPDATE ON google_iap_mgmt.google_console_accounts
  FOR EACH ROW EXECUTE FUNCTION google_iap_mgmt.set_updated_at();

-- ============================================================
-- 2. apps (Google Play apps cache)
--    Populated via Reporting API /v1beta1/apps:search.
--    package_name is Google's stable identifier (e.g. com.example.game).
--    UNIQUE on (account, package) — a single service account scopes the
--    set of accessible apps; cross-account collisions ok.
-- ============================================================
CREATE TABLE google_iap_mgmt.apps (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  google_console_account_id   UUID         NOT NULL REFERENCES
                                             google_iap_mgmt.google_console_accounts(id)
                                             ON DELETE CASCADE,
  package_name                TEXT         NOT NULL,
  display_name                TEXT,
  last_synced_at              TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (google_console_account_id, package_name)
);

CREATE INDEX idx_google_iap_mgmt_apps_account
  ON google_iap_mgmt.apps(google_console_account_id);
CREATE INDEX idx_google_iap_mgmt_apps_package
  ON google_iap_mgmt.apps(package_name);

CREATE TRIGGER tg_google_iap_mgmt_apps_updated_at
  BEFORE UPDATE ON google_iap_mgmt.apps
  FOR EACH ROW EXECUTE FUNCTION google_iap_mgmt.set_updated_at();

-- ============================================================
-- 3. iaps (In-app products cache)
--    Q-GIAP.A: v1 only managed products. Google's API enum is `managedUser`
--    vs `subscription`; we expose finer 'managed' / 'consumable' to the
--    Manager UI (consumable behaviour is client-acknowledgment-driven; the
--    API doesn't enforce it). 'subscription' reserved for v2 — CHECK
--    intentionally permissive to allow expansion without migration.
--
--    status: Google In-App Product Status enum — 'active' or 'inactive'.
--    Defaults to 'active' per Q-GIAP.I.
--
--    Q-GIAP.F: default_price_micros stored as TEXT (Google's wire format).
--    Manager input is decimal; conversion happens in the app layer.
-- ============================================================
CREATE TABLE google_iap_mgmt.iaps (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                   UUID         NOT NULL REFERENCES
                                          google_iap_mgmt.apps(id) ON DELETE CASCADE,
  sku                      TEXT         NOT NULL,
  -- 'managed'      = non-consumable managed product
  -- 'consumable'   = consumable managed product (client-acknowledged)
  -- 'subscription' = reserved Phase 2 (Q-GIAP.A excludes for v1, schema permits)
  purchase_type            TEXT         NOT NULL CHECK (purchase_type IN (
                                          'managed', 'consumable', 'subscription'
                                        )),
  status                   TEXT         NOT NULL DEFAULT 'active' CHECK (status IN (
                                          'active', 'inactive'
                                        )),
  default_currency         TEXT,
  default_price_micros     TEXT,
  last_synced_at           TIMESTAMPTZ,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, sku)
);

CREATE INDEX idx_google_iap_mgmt_iaps_app
  ON google_iap_mgmt.iaps(app_id);
CREATE INDEX idx_google_iap_mgmt_iaps_status
  ON google_iap_mgmt.iaps(status);

CREATE TRIGGER tg_google_iap_mgmt_iaps_updated_at
  BEFORE UPDATE ON google_iap_mgmt.iaps
  FOR EACH ROW EXECUTE FUNCTION google_iap_mgmt.set_updated_at();

-- ============================================================
-- 4. iap_listings (per-locale Title + Description)
--    Q-GIAP.J multi-locale full v1. Default locale convention en-US,
--    enforced by app layer (NOT NULL columns; "có cái nào import cái đó"
--    pattern from iap_mgmt — empty cells skipped at parse time).
-- ============================================================
CREATE TABLE google_iap_mgmt.iap_listings (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  iap_id       UUID         NOT NULL REFERENCES google_iap_mgmt.iaps(id) ON DELETE CASCADE,
  locale       TEXT         NOT NULL,
  title        TEXT         NOT NULL,
  description  TEXT         NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (iap_id, locale)
);

CREATE INDEX idx_google_iap_mgmt_iap_listings_iap
  ON google_iap_mgmt.iap_listings(iap_id);

CREATE TRIGGER tg_google_iap_mgmt_iap_listings_updated_at
  BEFORE UPDATE ON google_iap_mgmt.iap_listings
  FOR EACH ROW EXECUTE FUNCTION google_iap_mgmt.set_updated_at();

-- ============================================================
-- 5. iap_prices (per-region overrides)
--    Q-GIAP.G multi-region v1 — sparse permitted (missing regions fall
--    back to Google's auto-equalization from default_price_micros).
--    Q-GIAP.F: price_micros TEXT (Google serializes as string in JSON).
-- ============================================================
CREATE TABLE google_iap_mgmt.iap_prices (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  iap_id        UUID         NOT NULL REFERENCES google_iap_mgmt.iaps(id) ON DELETE CASCADE,
  region_code   TEXT         NOT NULL,
  currency      TEXT         NOT NULL,
  price_micros  TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (iap_id, region_code)
);

CREATE INDEX idx_google_iap_mgmt_iap_prices_iap
  ON google_iap_mgmt.iap_prices(iap_id);

CREATE TRIGGER tg_google_iap_mgmt_iap_prices_updated_at
  BEFORE UPDATE ON google_iap_mgmt.iap_prices
  FOR EACH ROW EXECUTE FUNCTION google_iap_mgmt.set_updated_at();

-- ============================================================
-- 6. import_batches (Bulk Import audit)
--    Q-GIAP.E: batchUpdate runs single-call; counters here record the
--    per-row outcomes for Manager visibility. No per-row entry table —
--    the Manager's wizard preview already shows row-level decisions.
-- ============================================================
CREATE TABLE google_iap_mgmt.import_batches (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id              UUID         REFERENCES google_iap_mgmt.apps(id) ON DELETE SET NULL,
  source_filename     TEXT,
  -- 'google_default' | 'default_template' | 'app_template'
  pricing_source      TEXT         CHECK (pricing_source IN (
                                     'google_default', 'default_template', 'app_template'
                                   )),
  rows_total          INT          NOT NULL DEFAULT 0,
  rows_success        INT          NOT NULL DEFAULT 0,
  rows_overwritten    INT          NOT NULL DEFAULT 0,
  rows_skipped        INT          NOT NULL DEFAULT 0,
  rows_failed         INT          NOT NULL DEFAULT 0,
  status              TEXT         NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                                     'PENDING', 'IN_PROGRESS', 'COMPLETE', 'FAILED'
                                   )),
  executed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_google_iap_mgmt_import_batches_app
  ON google_iap_mgmt.import_batches(app_id, created_at DESC);

-- ============================================================
-- 7. actions_log (audit trail)
--    APPEND-ONLY invariant: no UPDATE, no DELETE (enforced at app layer
--    + reviewed in code review; we don't add a trigger because admin-level
--    backfills occasionally need direct DML).
--
--    action_type CHECK list is a starting set; expansion follows the
--    iap_mgmt pattern of adding values via forward migration (see
--    20260517000000_iap_mgmt_actions_log_action_type_expand.sql).
-- ============================================================
CREATE TABLE google_iap_mgmt.actions_log (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type  TEXT         NOT NULL CHECK (action_type IN (
                              'ACCOUNT_CREATE',
                              'ACCOUNT_VERIFY',
                              'ACCOUNT_DELETE',
                              'APPS_SYNC',
                              'IAPS_LIST_SYNC',
                              'IAP_CREATE',
                              'IAP_UPDATE',
                              'IAP_DELETE',
                              'BULK_IMPORT_BATCH',
                              'PRICING_TEMPLATE_UPLOAD'
                            )),
  actor_email  TEXT,
  -- target_id is the UUID of whichever row this action mutated
  -- (account, app, iap, batch, template). Polymorphic by convention;
  -- no FK so cascades don't break the audit trail.
  target_id    UUID,
  payload      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_google_iap_mgmt_actions_log_target
  ON google_iap_mgmt.actions_log(target_id, created_at DESC) WHERE target_id IS NOT NULL;
CREATE INDEX idx_google_iap_mgmt_actions_log_type
  ON google_iap_mgmt.actions_log(action_type, created_at DESC);
CREATE INDEX idx_google_iap_mgmt_actions_log_created
  ON google_iap_mgmt.actions_log(created_at DESC);

-- ============================================================
-- 8. pricing_templates (header)
--    Q-GIAP.D: format pending Manager delivery. Schema models GLOBAL
--    (Default Template) + APP (per-app override) scopes, matching the
--    iap_mgmt p1.a pattern. Partial unique indexes enforce replace-only
--    semantics (at most one GLOBAL row + at most one row per APP).
-- ============================================================
CREATE TABLE google_iap_mgmt.pricing_templates (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type       TEXT         NOT NULL CHECK (scope_type IN ('GLOBAL', 'APP')),
  scope_app_id     UUID         REFERENCES google_iap_mgmt.apps(id) ON DELETE CASCADE,
  uploaded_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  uploaded_by      TEXT         NOT NULL,
  source_filename  TEXT,
  CHECK (
    (scope_type = 'GLOBAL' AND scope_app_id IS NULL)
    OR
    (scope_type = 'APP' AND scope_app_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_google_iap_mgmt_pricing_templates_global_unique
  ON google_iap_mgmt.pricing_templates(scope_type)
  WHERE scope_type = 'GLOBAL';

CREATE UNIQUE INDEX idx_google_iap_mgmt_pricing_templates_app_unique
  ON google_iap_mgmt.pricing_templates(scope_app_id)
  WHERE scope_type = 'APP';

CREATE INDEX idx_google_iap_mgmt_pricing_templates_uploaded
  ON google_iap_mgmt.pricing_templates(uploaded_at DESC);

-- ============================================================
-- 9. pricing_template_entries (sparse rows)
--    identifier carries either SKU (when template is SKU-keyed) or a
--    tier identifier (if Manager's template format uses tier rows).
--    Q-GIAP.D defers format lock-in; schema is identifier-agnostic.
-- ============================================================
CREATE TABLE google_iap_mgmt.pricing_template_entries (
  template_id   UUID         NOT NULL REFERENCES google_iap_mgmt.pricing_templates(id)
                               ON DELETE CASCADE,
  identifier    TEXT         NOT NULL,
  region_code   TEXT         NOT NULL,
  currency      TEXT         NOT NULL,
  price_micros  TEXT         NOT NULL,
  PRIMARY KEY (template_id, identifier, region_code)
);

CREATE INDEX idx_google_iap_mgmt_pricing_template_entries_lookup
  ON google_iap_mgmt.pricing_template_entries(template_id, identifier);

-- ============================================================
-- ACCESS CONTROL — store_mgmt-aligned pattern (RLS disabled + GRANTs)
-- ============================================================
-- See "RLS DECISION" preamble. All access enforcement happens at the
-- Next.js layer via route-based context resolver (Q-GIAP.H).

-- Schema USAGE.
GRANT USAGE ON SCHEMA google_iap_mgmt TO service_role, authenticated, anon;

-- Service role full access.
GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA google_iap_mgmt TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA google_iap_mgmt TO service_role;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA google_iap_mgmt TO service_role;

-- Authenticated CRUD.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA google_iap_mgmt
  TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA google_iap_mgmt TO authenticated;

-- Default privileges for future tables.
ALTER DEFAULT PRIVILEGES IN SCHEMA google_iap_mgmt
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA google_iap_mgmt
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA google_iap_mgmt
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO service_role, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA google_iap_mgmt
  GRANT EXECUTE ON FUNCTIONS TO service_role;
