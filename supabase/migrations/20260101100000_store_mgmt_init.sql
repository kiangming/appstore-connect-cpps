-- ============================================================
-- Migration: Store Management module — init schema
-- Schema: store_mgmt (isolated from CPP Manager's public.*)
-- Source: docs/store-submissions/01-data-model.md
-- ============================================================

-- ============================================================
-- SCHEMA & UTILITIES
-- ============================================================

CREATE SCHEMA IF NOT EXISTS store_mgmt;

-- Auto-update updated_at trigger function
CREATE OR REPLACE FUNCTION store_mgmt.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- CONFIG DOMAIN
-- ============================================================

-- users (whitelist-based authentication per module)
CREATE TABLE store_mgmt.users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  role            TEXT NOT NULL CHECK (role IN ('MANAGER', 'DEV', 'VIEWER')),
  display_name    TEXT,
  avatar_url      TEXT,
  google_sub      TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES store_mgmt.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_store_mgmt_users_email ON store_mgmt.users(lower(email));
CREATE INDEX idx_store_mgmt_users_google_sub ON store_mgmt.users(google_sub) WHERE google_sub IS NOT NULL;

CREATE TRIGGER tg_store_mgmt_users_updated_at BEFORE UPDATE ON store_mgmt.users
  FOR EACH ROW EXECUTE FUNCTION store_mgmt.set_updated_at();

-- platforms
CREATE TABLE store_mgmt.platforms (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   TEXT NOT NULL UNIQUE,
  display_name          TEXT NOT NULL,
  icon_name             TEXT,
  console_url_template  TEXT,
  active                BOOLEAN NOT NULL DEFAULT true,
  sort_order            INT NOT NULL DEFAULT 100,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER tg_store_mgmt_platforms_updated_at BEFORE UPDATE ON store_mgmt.platforms
  FOR EACH ROW EXECUTE FUNCTION store_mgmt.set_updated_at();

-- senders
CREATE TABLE store_mgmt.senders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id  UUID NOT NULL REFERENCES store_mgmt.platforms(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform_id, email)
);

CREATE INDEX idx_store_mgmt_senders_email ON store_mgmt.senders(lower(email)) WHERE active = true;

-- subject_patterns
CREATE TABLE store_mgmt.subject_patterns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id       UUID NOT NULL REFERENCES store_mgmt.platforms(id) ON DELETE CASCADE,
  outcome           TEXT NOT NULL CHECK (outcome IN ('APPROVED', 'REJECTED', 'IN_REVIEW')),
  regex             TEXT NOT NULL,
  priority          INT NOT NULL DEFAULT 100,
  example_subject   TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_store_mgmt_subject_patterns_platform ON store_mgmt.subject_patterns(platform_id, priority)
  WHERE active = true;

CREATE TRIGGER tg_store_mgmt_subject_patterns_updated_at BEFORE UPDATE ON store_mgmt.subject_patterns
  FOR EACH ROW EXECUTE FUNCTION store_mgmt.set_updated_at();

-- types
CREATE TABLE store_mgmt.types (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id             UUID NOT NULL REFERENCES store_mgmt.platforms(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  slug                    TEXT NOT NULL,
  body_keyword            TEXT NOT NULL,
  payload_extract_regex   TEXT,
  active                  BOOLEAN NOT NULL DEFAULT true,
  sort_order              INT NOT NULL DEFAULT 100,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform_id, slug)
);

CREATE INDEX idx_store_mgmt_types_platform ON store_mgmt.types(platform_id, sort_order) WHERE active = true;

CREATE TRIGGER tg_store_mgmt_types_updated_at BEFORE UPDATE ON store_mgmt.types
  FOR EACH ROW EXECUTE FUNCTION store_mgmt.set_updated_at();

-- submission_id_patterns
CREATE TABLE store_mgmt.submission_id_patterns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id  UUID NOT NULL REFERENCES store_mgmt.platforms(id) ON DELETE CASCADE,
  body_regex   TEXT NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_store_mgmt_submission_id_patterns_platform ON store_mgmt.submission_id_patterns(platform_id)
  WHERE active = true;

-- apps (Store Management's own — NOT confused with CPP Manager's apps if any)
CREATE TABLE store_mgmt.apps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  display_name    TEXT,
  team_owner_id   UUID REFERENCES store_mgmt.users(id) ON DELETE SET NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  tracking_since  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES store_mgmt.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_store_mgmt_apps_active ON store_mgmt.apps(active) WHERE active = true;
CREATE INDEX idx_store_mgmt_apps_name ON store_mgmt.apps(lower(name));

CREATE TRIGGER tg_store_mgmt_apps_updated_at BEFORE UPDATE ON store_mgmt.apps
  FOR EACH ROW EXECUTE FUNCTION store_mgmt.set_updated_at();

-- app_aliases
CREATE TABLE store_mgmt.app_aliases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         UUID NOT NULL REFERENCES store_mgmt.apps(id) ON DELETE CASCADE,
  alias_text     TEXT,
  alias_regex    TEXT,
  source_type    TEXT NOT NULL CHECK (source_type IN (
                   'AUTO_CURRENT',
                   'AUTO_HISTORICAL',
                   'MANUAL',
                   'REGEX')),
  previous_name  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK ((alias_text IS NOT NULL) != (alias_regex IS NOT NULL)),
  CHECK (source_type != 'AUTO_HISTORICAL' OR previous_name IS NOT NULL),
  CHECK (source_type != 'REGEX' OR alias_regex IS NOT NULL)
);

CREATE INDEX idx_store_mgmt_app_aliases_text ON store_mgmt.app_aliases(lower(alias_text)) WHERE alias_text IS NOT NULL;
CREATE INDEX idx_store_mgmt_app_aliases_app ON store_mgmt.app_aliases(app_id);

-- app_platform_bindings
CREATE TABLE store_mgmt.app_platform_bindings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         UUID NOT NULL REFERENCES store_mgmt.apps(id) ON DELETE CASCADE,
  platform_id    UUID NOT NULL REFERENCES store_mgmt.platforms(id) ON DELETE CASCADE,
  platform_ref   TEXT,
  console_url    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, platform_id)
);

CREATE INDEX idx_store_mgmt_app_platform_bindings_app ON store_mgmt.app_platform_bindings(app_id);

CREATE TRIGGER tg_store_mgmt_app_platform_bindings_updated_at BEFORE UPDATE ON store_mgmt.app_platform_bindings
  FOR EACH ROW EXECUTE FUNCTION store_mgmt.set_updated_at();

-- settings (singleton)
CREATE TABLE store_mgmt.settings (
  id                            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email_retention_days          INT NOT NULL DEFAULT 365,
  email_retention_enabled       BOOLEAN NOT NULL DEFAULT true,
  gmail_polling_enabled         BOOLEAN NOT NULL DEFAULT true,
  inbox_badge_realtime_enabled  BOOLEAN NOT NULL DEFAULT false,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                    UUID REFERENCES store_mgmt.users(id) ON DELETE SET NULL
);

INSERT INTO store_mgmt.settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TRIGGER tg_store_mgmt_settings_updated_at BEFORE UPDATE ON store_mgmt.settings
  FOR EACH ROW EXECUTE FUNCTION store_mgmt.set_updated_at();

-- gmail_credentials (singleton)
CREATE TABLE store_mgmt.gmail_credentials (
  id                        INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email                     TEXT NOT NULL,
  access_token_encrypted    TEXT NOT NULL,
  refresh_token_encrypted   TEXT NOT NULL,
  token_expires_at          TIMESTAMPTZ NOT NULL,
  scopes                    TEXT[] NOT NULL,
  connected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  connected_by              UUID REFERENCES store_mgmt.users(id) ON DELETE SET NULL,
  last_refreshed_at         TIMESTAMPTZ
);

-- gmail_sync_state (singleton)
CREATE TABLE store_mgmt.gmail_sync_state (
  id                        INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_history_id           BIGINT,
  last_synced_at            TIMESTAMPTZ,
  last_full_sync_at         TIMESTAMPTZ,
  emails_processed_total    BIGINT NOT NULL DEFAULT 0,
  consecutive_failures      INT NOT NULL DEFAULT 0,
  last_error                TEXT,
  last_error_at             TIMESTAMPTZ
);

INSERT INTO store_mgmt.gmail_sync_state (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ============================================================
-- CORE DOMAIN
-- ============================================================

-- Ticket display_id sequence + generator
CREATE SEQUENCE store_mgmt.ticket_display_id_seq START 10000;

CREATE OR REPLACE FUNCTION store_mgmt.generate_ticket_display_id()
RETURNS TEXT AS $$
BEGIN
  RETURN 'TICKET-' || nextval('store_mgmt.ticket_display_id_seq')::TEXT;
END;
$$ LANGUAGE plpgsql;

-- tickets
CREATE TABLE store_mgmt.tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_id        TEXT NOT NULL UNIQUE DEFAULT store_mgmt.generate_ticket_display_id(),
  app_id            UUID REFERENCES store_mgmt.apps(id) ON DELETE RESTRICT,
  platform_id       UUID NOT NULL REFERENCES store_mgmt.platforms(id) ON DELETE RESTRICT,
  type_id           UUID REFERENCES store_mgmt.types(id) ON DELETE RESTRICT,
  state             TEXT NOT NULL CHECK (state IN (
                      'NEW', 'IN_REVIEW', 'REJECTED',
                      'APPROVED', 'DONE', 'ARCHIVED'
                    )),
  latest_outcome    TEXT CHECK (latest_outcome IN ('IN_REVIEW', 'REJECTED', 'APPROVED')),
  priority          TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH')),
  assigned_to       UUID REFERENCES store_mgmt.users(id) ON DELETE SET NULL,
  type_payloads     JSONB NOT NULL DEFAULT '[]'::jsonb,
  submission_ids    TEXT[] NOT NULL DEFAULT '{}',
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ,
  resolution_type   TEXT CHECK (resolution_type IN ('APPROVED', 'DONE', 'ARCHIVED')),
  due_date          DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (
    (state IN ('APPROVED', 'DONE', 'ARCHIVED')) = (closed_at IS NOT NULL)
  ),
  CHECK (
    (state IN ('APPROVED', 'DONE', 'ARCHIVED')) = (resolution_type IS NOT NULL)
  )
);

-- CRITICAL: Grouping invariant enforcement
CREATE UNIQUE INDEX idx_store_mgmt_tickets_open_unique
  ON store_mgmt.tickets(
    COALESCE(app_id, '00000000-0000-0000-0000-000000000000'),
    COALESCE(type_id, '00000000-0000-0000-0000-000000000000'),
    platform_id
  )
  WHERE state IN ('NEW', 'IN_REVIEW', 'REJECTED');

CREATE INDEX idx_store_mgmt_tickets_state ON store_mgmt.tickets(state);
CREATE INDEX idx_store_mgmt_tickets_app ON store_mgmt.tickets(app_id) WHERE app_id IS NOT NULL;
CREATE INDEX idx_store_mgmt_tickets_type ON store_mgmt.tickets(type_id) WHERE type_id IS NOT NULL;
CREATE INDEX idx_store_mgmt_tickets_assigned ON store_mgmt.tickets(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX idx_store_mgmt_tickets_opened ON store_mgmt.tickets(opened_at DESC);
CREATE INDEX idx_store_mgmt_tickets_state_opened ON store_mgmt.tickets(state, opened_at DESC);
CREATE INDEX idx_store_mgmt_tickets_inbox ON store_mgmt.tickets(opened_at DESC) WHERE state = 'NEW';
CREATE INDEX idx_store_mgmt_tickets_followup ON store_mgmt.tickets(opened_at DESC)
  WHERE state IN ('IN_REVIEW', 'REJECTED');

CREATE TRIGGER tg_store_mgmt_tickets_updated_at BEFORE UPDATE ON store_mgmt.tickets
  FOR EACH ROW EXECUTE FUNCTION store_mgmt.set_updated_at();

-- email_messages
CREATE TABLE store_mgmt.email_messages (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_msg_id             TEXT NOT NULL UNIQUE,
  gmail_thread_id          TEXT,
  subject                  TEXT NOT NULL,
  sender_email             TEXT NOT NULL,
  sender_name              TEXT,
  received_at              TIMESTAMPTZ NOT NULL,
  raw_body_text            TEXT,
  ticket_id                UUID REFERENCES store_mgmt.tickets(id) ON DELETE SET NULL,
  classification_status    TEXT NOT NULL CHECK (classification_status IN (
                             'PENDING',
                             'CLASSIFIED',
                             'UNCLASSIFIED_APP',
                             'UNCLASSIFIED_TYPE',
                             'DROPPED',
                             'ERROR'
                           )),
  classification_result    JSONB,
  processed_at             TIMESTAMPTZ,
  error_message            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_store_mgmt_email_messages_ticket ON store_mgmt.email_messages(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX idx_store_mgmt_email_messages_received ON store_mgmt.email_messages(received_at DESC);
CREATE INDEX idx_store_mgmt_email_messages_status_pending ON store_mgmt.email_messages(created_at)
  WHERE classification_status = 'PENDING';
CREATE INDEX idx_store_mgmt_email_messages_received_for_cleanup ON store_mgmt.email_messages(received_at)
  WHERE raw_body_text IS NOT NULL;

-- ticket_entries (event log, append-only)
CREATE TABLE store_mgmt.ticket_entries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id          UUID NOT NULL REFERENCES store_mgmt.tickets(id) ON DELETE CASCADE,
  entry_type         TEXT NOT NULL CHECK (entry_type IN (
                       'EMAIL',
                       'COMMENT',
                       'REJECT_REASON',
                       'STATE_CHANGE',
                       'PAYLOAD_ADDED',
                       'ASSIGNMENT',
                       'PRIORITY_CHANGE'
                     )),
  author_user_id     UUID REFERENCES store_mgmt.users(id) ON DELETE SET NULL,
  content            TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  email_message_id   UUID REFERENCES store_mgmt.email_messages(id) ON DELETE SET NULL,
  attachment_refs    JSONB NOT NULL DEFAULT '[]'::jsonb,
  edited_at          TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (edited_at IS NULL OR entry_type = 'COMMENT')
);

CREATE INDEX idx_store_mgmt_ticket_entries_ticket_created ON store_mgmt.ticket_entries(ticket_id, created_at DESC);
CREATE INDEX idx_store_mgmt_ticket_entries_email ON store_mgmt.ticket_entries(email_message_id)
  WHERE email_message_id IS NOT NULL;

-- ============================================================
-- AUDIT DOMAIN
-- ============================================================

CREATE TABLE store_mgmt.rule_versions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id       UUID NOT NULL REFERENCES store_mgmt.platforms(id) ON DELETE CASCADE,
  version_number    INT NOT NULL,
  config_snapshot   JSONB NOT NULL,
  saved_by          UUID REFERENCES store_mgmt.users(id) ON DELETE SET NULL,
  saved_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note              TEXT,
  UNIQUE(platform_id, version_number)
);

CREATE INDEX idx_store_mgmt_rule_versions_platform ON store_mgmt.rule_versions(platform_id, version_number DESC);

CREATE TABLE store_mgmt.sync_logs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms            INT,
  sync_method            TEXT NOT NULL CHECK (sync_method IN ('INCREMENTAL', 'FALLBACK', 'MANUAL')),
  emails_fetched         INT NOT NULL DEFAULT 0,
  emails_classified      INT NOT NULL DEFAULT 0,
  emails_unclassified    INT NOT NULL DEFAULT 0,
  emails_errored         INT NOT NULL DEFAULT 0,
  tickets_created        INT NOT NULL DEFAULT 0,
  tickets_updated        INT NOT NULL DEFAULT 0,
  error_message          TEXT
);

CREATE INDEX idx_store_mgmt_sync_logs_ran ON store_mgmt.sync_logs(ran_at DESC);

CREATE TABLE store_mgmt.cleanup_logs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cutoff_date            TIMESTAMPTZ NOT NULL,
  emails_deleted         INT NOT NULL DEFAULT 0,
  attachments_deleted    INT NOT NULL DEFAULT 0,
  trigger_type           TEXT NOT NULL CHECK (trigger_type IN ('AUTO', 'MANUAL')),
  triggered_by           UUID REFERENCES store_mgmt.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_store_mgmt_cleanup_logs_ran ON store_mgmt.cleanup_logs(ran_at DESC);

-- ============================================================
-- PERMISSIONS (Supabase service role bypasses; this is for safety)
-- ============================================================

-- Grant usage to authenticated + service_role
GRANT USAGE ON SCHEMA store_mgmt TO authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA store_mgmt TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA store_mgmt TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA store_mgmt TO service_role;

-- Future tables auto-granted to service_role
ALTER DEFAULT PRIVILEGES IN SCHEMA store_mgmt
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA store_mgmt
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA store_mgmt
  GRANT ALL ON FUNCTIONS TO service_role;

-- ============================================================
-- END OF STORE_MGMT INIT SCHEMA
-- ============================================================
