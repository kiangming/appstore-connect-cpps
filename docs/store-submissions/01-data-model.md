# Tech Design Deep-Dive — Data Model

**Scope:** Schema SQL đầy đủ, indexes, constraints, seed data, migration strategy
**Target:** Implementation-ready — developer có thể chạy trực tiếp

---

## 1. Conventions

| Aspect | Convention |
|---|---|
| Naming | `snake_case`, plural table names (`apps`, `tickets`, `email_messages`) |
| Primary key | `UUID` với `gen_random_uuid()` default. Exception: singleton tables dùng `INT` với CHECK `id=1` |
| Timestamps | `TIMESTAMPTZ` (với timezone). DB lưu UTC, client convert sang `Asia/Ho_Chi_Minh` |
| Enums | Dùng `TEXT` + `CHECK` constraint thay vì PostgreSQL ENUM type (dễ thêm value sau không cần ALTER TYPE migration) |
| Soft delete | Không dùng soft delete cho core tables. Dùng flag `active` hoặc terminal states |
| JSONB | Cho flexible schemas: `classification_result`, `type_payloads`, `metadata`, `settings` |
| Foreign keys | `ON DELETE CASCADE` cho child tables (vd `app_aliases → apps`), `ON DELETE SET NULL` cho audit references (vd `email_messages.ticket_id`) |

---

## 2. Schema SQL

Schema chia 3 domain + utilities. Toàn bộ chạy được như 1 migration file (thứ tự đã đúng dependency).

### 2.1. Utility — reusable trigger

```sql
-- Auto-update updated_at trên mọi UPDATE
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### 2.2. Config domain

#### users (whitelist)

```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  role            TEXT NOT NULL CHECK (role IN ('MANAGER', 'DEV', 'VIEWER')),
  display_name    TEXT,                                   -- populate từ Google profile lần đầu login
  avatar_url      TEXT,                                   -- từ Google profile
  google_sub      TEXT UNIQUE,                            -- Google subject ID, NULL cho đến khi login lần đầu
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_users_email ON users(lower(email));        -- case-insensitive lookup
CREATE INDEX idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL;

CREATE TRIGGER tg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Login flow check**: `SELECT * FROM users WHERE lower(email) = lower($1) AND status = 'active'`. Match → session với role; không match → reject.

#### platforms

```sql
CREATE TABLE platforms (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   TEXT NOT NULL UNIQUE,               -- 'apple', 'google', 'facebook', 'huawei'
  display_name          TEXT NOT NULL,                      -- 'Apple App Store'
  icon_name             TEXT,                               -- client-side icon lookup key
  console_url_template  TEXT,                               -- 'https://appstoreconnect.apple.com/apps/{platform_ref}'
  active                BOOLEAN NOT NULL DEFAULT true,
  sort_order            INT NOT NULL DEFAULT 100,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER tg_platforms_updated_at BEFORE UPDATE ON platforms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

#### senders

```sql
CREATE TABLE senders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id  UUID NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform_id, email)
);

-- Reverse lookup: email → platform (hot path trong Email Rule Engine)
CREATE INDEX idx_senders_email ON senders(lower(email)) WHERE active = true;
```

#### subject_patterns

```sql
CREATE TABLE subject_patterns (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id       UUID NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  outcome           TEXT NOT NULL CHECK (outcome IN ('APPROVED', 'REJECTED', 'IN_REVIEW')),
  regex             TEXT NOT NULL,                          -- đã validate RE2-compilable khi save
  priority          INT NOT NULL DEFAULT 100,               -- ASC: priority 1 match trước priority 100
  example_subject   TEXT,                                   -- cho "test rule" UI
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subject_patterns_platform ON subject_patterns(platform_id, priority)
  WHERE active = true;

CREATE TRIGGER tg_subject_patterns_updated_at BEFORE UPDATE ON subject_patterns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

#### types

```sql
CREATE TABLE types (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id             UUID NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,                    -- 'App', 'In-App Event', 'Custom Product Page'
  slug                    TEXT NOT NULL,                    -- 'app', 'iae', 'cpp'  (cho badge + URL)
  body_keyword            TEXT NOT NULL,                    -- substring detect trong body
  payload_extract_regex   TEXT,                             -- RE2-compilable, có named groups
  active                  BOOLEAN NOT NULL DEFAULT true,
  sort_order              INT NOT NULL DEFAULT 100,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(platform_id, slug)
);

CREATE INDEX idx_types_platform ON types(platform_id, sort_order) WHERE active = true;

CREATE TRIGGER tg_types_updated_at BEFORE UPDATE ON types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

#### submission_id_patterns

```sql
CREATE TABLE submission_id_patterns (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id  UUID NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  body_regex   TEXT NOT NULL,                               -- RE2, named group 'submission_id'
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_submission_id_patterns_platform ON submission_id_patterns(platform_id)
  WHERE active = true;
```

#### apps

```sql
CREATE TABLE apps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,                     -- URL-friendly, stable khi rename
  name            TEXT NOT NULL,                            -- canonical display (có thể thay đổi)
  display_name    TEXT,                                     -- optional override, fallback=name
  team_owner_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  tracking_since  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_apps_active ON apps(active) WHERE active = true;
CREATE INDEX idx_apps_name ON apps(lower(name));

CREATE TRIGGER tg_apps_updated_at BEFORE UPDATE ON apps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

#### app_aliases

```sql
CREATE TABLE app_aliases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  alias_text     TEXT,                                      -- exact match (case-insensitive)
  alias_regex    TEXT,                                      -- RE2 regex, alternative to alias_text
  source_type    TEXT NOT NULL CHECK (source_type IN (
                   'AUTO_CURRENT',     -- auto-added từ name hiện tại
                   'AUTO_HISTORICAL',  -- auto-added từ name cũ trước khi rename
                   'MANUAL',           -- user thêm text alias
                   'REGEX')),          -- user thêm regex
  previous_name  TEXT,                                      -- populate khi source_type='AUTO_HISTORICAL'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Exactly one of alias_text or alias_regex must be set
  CHECK ((alias_text IS NOT NULL) != (alias_regex IS NOT NULL)),

  -- AUTO_HISTORICAL must have previous_name
  CHECK (source_type != 'AUTO_HISTORICAL' OR previous_name IS NOT NULL),

  -- REGEX source must use alias_regex, not alias_text
  CHECK (source_type != 'REGEX' OR alias_regex IS NOT NULL)
);

-- Hot path: email subject lookup
CREATE INDEX idx_app_aliases_text ON app_aliases(lower(alias_text)) WHERE alias_text IS NOT NULL;
CREATE INDEX idx_app_aliases_app ON app_aliases(app_id);
```

**Ghi chú rename logic**: Khi rename app từ "Old" → "New":
```sql
BEGIN;
  -- Demote current auto alias
  UPDATE app_aliases
  SET source_type = 'AUTO_HISTORICAL',
      previous_name = (SELECT name FROM apps WHERE id = $app_id)
  WHERE app_id = $app_id AND source_type = 'AUTO_CURRENT';

  -- Update app name
  UPDATE apps SET name = $new_name WHERE id = $app_id;

  -- Insert new auto alias
  INSERT INTO app_aliases (app_id, alias_text, source_type)
  VALUES ($app_id, $new_name, 'AUTO_CURRENT');
COMMIT;
```

#### app_platform_bindings

```sql
CREATE TABLE app_platform_bindings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform_id    UUID NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  platform_ref   TEXT,                                       -- bundle_id / package_name / app_id
  console_url    TEXT,                                       -- override platforms.console_url_template nếu cần
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, platform_id)
);

CREATE INDEX idx_app_platform_bindings_app ON app_platform_bindings(app_id);

CREATE TRIGGER tg_app_platform_bindings_updated_at BEFORE UPDATE ON app_platform_bindings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**`platform_ref` nullable**: app có thể publish trên 1, 2, 3 hoặc cả 4 platform. Binding row chỉ tồn tại khi có liên kết; không tạo row rỗng.

#### settings (singleton)

```sql
CREATE TABLE settings (
  id                            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email_retention_days          INT NOT NULL DEFAULT 365,
  email_retention_enabled       BOOLEAN NOT NULL DEFAULT true,
  gmail_polling_enabled         BOOLEAN NOT NULL DEFAULT true,
  inbox_badge_realtime_enabled  BOOLEAN NOT NULL DEFAULT false,  -- Supabase Realtime subscription
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                    UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Ensure exactly 1 row
INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TRIGGER tg_settings_updated_at BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

#### gmail_credentials (singleton)

```sql
CREATE TABLE gmail_credentials (
  id                        INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email                     TEXT NOT NULL,                  -- shared mailbox email
  access_token_encrypted    TEXT NOT NULL,                  -- AES-256-GCM
  refresh_token_encrypted   TEXT NOT NULL,
  token_expires_at          TIMESTAMPTZ NOT NULL,
  scopes                    TEXT[] NOT NULL,                -- ['gmail.modify']
  connected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  connected_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  last_refreshed_at         TIMESTAMPTZ
);

-- Row chỉ được tạo khi Manager hoàn tất OAuth, không seed
```

#### gmail_sync_state (singleton)

```sql
CREATE TABLE gmail_sync_state (
  id                        INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_history_id           BIGINT,                         -- Gmail historyId
  last_synced_at            TIMESTAMPTZ,
  last_full_sync_at         TIMESTAMPTZ,                    -- lần fallback gần nhất
  emails_processed_total    BIGINT NOT NULL DEFAULT 0,
  consecutive_failures      INT NOT NULL DEFAULT 0,
  last_error                TEXT,
  last_error_at             TIMESTAMPTZ
);

INSERT INTO gmail_sync_state (id) VALUES (1) ON CONFLICT DO NOTHING;
```

### 2.3. Core domain

#### Ticket display_id sequence

```sql
CREATE SEQUENCE ticket_display_id_seq START 10000;

CREATE OR REPLACE FUNCTION generate_ticket_display_id()
RETURNS TEXT AS $$
BEGIN
  RETURN 'TICKET-' || nextval('ticket_display_id_seq')::TEXT;
END;
$$ LANGUAGE plpgsql;
```

#### email_messages

```sql
CREATE TABLE email_messages (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_msg_id             TEXT NOT NULL UNIQUE,              -- dedup key
  gmail_thread_id          TEXT,
  subject                  TEXT NOT NULL,
  sender_email             TEXT NOT NULL,
  sender_name              TEXT,
  received_at              TIMESTAMPTZ NOT NULL,              -- Gmail internalDate
  raw_body_text            TEXT,                              -- plain text, bị xóa sau retention
  ticket_id                UUID REFERENCES tickets(id) ON DELETE SET NULL,
  classification_status    TEXT NOT NULL CHECK (classification_status IN (
                             'PENDING',                       -- vừa fetch, chưa classify
                             'CLASSIFIED',                    -- classify xong, attached to ticket
                             'UNCLASSIFIED_APP',              -- không match app nào
                             'UNCLASSIFIED_TYPE',             -- match app nhưng không match type
                             'ERROR'                          -- parse/match error
                           )),
  classification_result    JSONB,                             -- {platform_id, app_id, type_id, outcome, payload, matched_rules:[]}
  processed_at             TIMESTAMPTZ,
  error_message            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_email_messages_ticket ON email_messages(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX idx_email_messages_received ON email_messages(received_at DESC);
CREATE INDEX idx_email_messages_status_pending ON email_messages(created_at)
  WHERE classification_status = 'PENDING';
-- Retention cleanup dùng idx này:
CREATE INDEX idx_email_messages_received_for_cleanup ON email_messages(received_at)
  WHERE raw_body_text IS NOT NULL;
```

**Note**: Forward reference `tickets(id)` — phải create `tickets` trước hoặc dùng `ALTER TABLE ADD CONSTRAINT` sau. Trong migration file thực tế, tạo `tickets` trước.

#### tickets

```sql
CREATE TABLE tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_id        TEXT NOT NULL UNIQUE DEFAULT generate_ticket_display_id(),
  app_id            UUID REFERENCES apps(id) ON DELETE RESTRICT,            -- NULL = Unclassified App
  platform_id       UUID NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
  type_id           UUID REFERENCES types(id) ON DELETE RESTRICT,           -- NULL = Unclassified Type
  state             TEXT NOT NULL CHECK (state IN (
                      'NEW', 'IN_REVIEW', 'REJECTED',      -- open states
                      'APPROVED', 'DONE', 'ARCHIVED'        -- terminal states
                    )),
  latest_outcome    TEXT CHECK (latest_outcome IN ('IN_REVIEW', 'REJECTED', 'APPROVED')),
  priority          TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH')),
  assigned_to       UUID REFERENCES users(id) ON DELETE SET NULL,
  type_payloads     JSONB NOT NULL DEFAULT '[]'::jsonb,                     -- [{payload: {...}, first_seen_at: ts}, ...]
  submission_ids    TEXT[] NOT NULL DEFAULT '{}',
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ,
  resolution_type   TEXT CHECK (resolution_type IN ('APPROVED', 'DONE', 'ARCHIVED')),
  due_date          DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Terminal state invariants
  CHECK (
    (state IN ('APPROVED', 'DONE', 'ARCHIVED')) = (closed_at IS NOT NULL)
  ),
  CHECK (
    (state IN ('APPROVED', 'DONE', 'ARCHIVED')) = (resolution_type IS NOT NULL)
  )
);

-- ⭐ CRITICAL: Grouping invariant — max 1 open ticket per (app, type, platform)
-- Partial unique index chỉ áp dụng cho open states
CREATE UNIQUE INDEX idx_tickets_open_unique
  ON tickets(COALESCE(app_id, '00000000-0000-0000-0000-000000000000'),
             COALESCE(type_id, '00000000-0000-0000-0000-000000000000'),
             platform_id)
  WHERE state IN ('NEW', 'IN_REVIEW', 'REJECTED');

-- Common query indexes
CREATE INDEX idx_tickets_state ON tickets(state);
CREATE INDEX idx_tickets_app ON tickets(app_id) WHERE app_id IS NOT NULL;
CREATE INDEX idx_tickets_type ON tickets(type_id) WHERE type_id IS NOT NULL;
CREATE INDEX idx_tickets_assigned ON tickets(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX idx_tickets_opened ON tickets(opened_at DESC);
CREATE INDEX idx_tickets_state_opened ON tickets(state, opened_at DESC);

-- For Inbox (NEW state, sorted recent)
CREATE INDEX idx_tickets_inbox ON tickets(opened_at DESC) WHERE state = 'NEW';

-- For Follow-Up (open excluding NEW)
CREATE INDEX idx_tickets_followup ON tickets(opened_at DESC)
  WHERE state IN ('IN_REVIEW', 'REJECTED');

CREATE TRIGGER tg_tickets_updated_at BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Bây giờ add FK từ email_messages.ticket_id đã defer ở trên:
ALTER TABLE email_messages
  ADD CONSTRAINT fk_email_messages_ticket
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL;
```

**Giải thích partial unique index**: PostgreSQL treat `NULL` trong unique index thành "không equal", nên `(NULL, NULL, platform_id)` không conflict với `(NULL, NULL, platform_id)` khác. Dùng `COALESCE` với sentinel UUID để force NULLs equal nhau → ticket Unclassified App + Unclassified Type cùng platform không thể có 2 open.

**Invariants đã DB-enforce**:
- ✅ Max 1 open ticket per key
- ✅ Terminal states có `closed_at` + `resolution_type`
- ✅ Open states không có `closed_at`

#### ticket_entries (event log)

```sql
CREATE TABLE ticket_entries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id          UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  entry_type         TEXT NOT NULL CHECK (entry_type IN (
                       'EMAIL',              -- email arrived
                       'COMMENT',            -- user comment (editable by author)
                       'REJECT_REASON',      -- paste từ ASC
                       'STATE_CHANGE',       -- auto hoặc manual
                       'PAYLOAD_ADDED',      -- payload mới trong đợt
                       'ASSIGNMENT',         -- assign/unassign
                       'PRIORITY_CHANGE'
                     )),
  author_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,    -- NULL = system
  content            TEXT,                                             -- comment body, reject reason, etc.
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,                -- structured: {from_state, to_state}, email snapshot, etc.
  email_message_id   UUID REFERENCES email_messages(id) ON DELETE SET NULL,
  attachment_refs    JSONB NOT NULL DEFAULT '[]'::jsonb,                -- [{path: 'tickets/uuid/abc.png', size, mime}]
  edited_at          TIMESTAMPTZ,                                       -- set khi COMMENT được edit (NULL nếu chưa edit)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Chỉ COMMENT entries được edit
  CHECK (edited_at IS NULL OR entry_type = 'COMMENT')
);

CREATE INDEX idx_ticket_entries_ticket_created ON ticket_entries(ticket_id, created_at DESC);
CREATE INDEX idx_ticket_entries_email ON ticket_entries(email_message_id)
  WHERE email_message_id IS NOT NULL;
```

**Critical design rule**: Khi insert `EMAIL` entry, **luôn copy snapshot** của email (subject, sender, body excerpt 500 chars) vào `metadata`:

```json
{
  "email_snapshot": {
    "subject": "Review of your Skyline Runners submission is complete.",
    "sender": "no-reply@apple.com",
    "received_at": "2026-04-18T08:42:00Z",
    "body_excerpt": "Your app has been reviewed and approved..."
  }
}
```

Lý do: khi email cũ bị cleanup sau retention, `ticket_entries.metadata.email_snapshot` vẫn còn → thread timeline complete mãi.

**Edit policy cho entries**:
- **Chỉ `COMMENT` editable**: author edit bất kỳ lúc nào (kể cả sau khi ticket closed). UPDATE `content`, SET `edited_at = NOW()`. Chỉ author mới edit được entry của mình (enforce ở API: `WHERE id = $1 AND author_user_id = $session AND entry_type = 'COMMENT'`).
- **Tất cả entry type khác immutable**: `EMAIL`, `REJECT_REASON`, `STATE_CHANGE`, `PAYLOAD_ADDED`, `ASSIGNMENT`, `PRIORITY_CHANGE`. Nếu REJECT_REASON paste sai → post COMMENT mới giải thích thay vì edit reject reason.
- **Không lưu version history** — giữ đơn giản cho MVP, chỉ track `edited_at`. UI hiện marker "edited · 5m ago" khi `edited_at IS NOT NULL`.

### 2.4. Audit domain

#### rule_versions

```sql
CREATE TABLE rule_versions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id       UUID NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  version_number    INT NOT NULL,                            -- v1, v2... per platform
  config_snapshot   JSONB NOT NULL,                          -- {senders:[...], subject_patterns:[...], types:[...]}
  saved_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  saved_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note              TEXT,                                    -- optional commit message
  UNIQUE(platform_id, version_number)
);

CREATE INDEX idx_rule_versions_platform ON rule_versions(platform_id, version_number DESC);
```

#### sync_logs

```sql
CREATE TABLE sync_logs (
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

CREATE INDEX idx_sync_logs_ran ON sync_logs(ran_at DESC);
```

#### cleanup_logs

```sql
CREATE TABLE cleanup_logs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cutoff_date            TIMESTAMPTZ NOT NULL,
  emails_deleted         INT NOT NULL DEFAULT 0,
  attachments_deleted    INT NOT NULL DEFAULT 0,
  trigger_type           TEXT NOT NULL CHECK (trigger_type IN ('AUTO', 'MANUAL')),
  triggered_by           UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_cleanup_logs_ran ON cleanup_logs(ran_at DESC);
```

---

## 3. Critical indexes — giải thích

| Index | Purpose | Note |
|---|---|---|
| `idx_tickets_open_unique` | Enforce invariant "max 1 open ticket per (app, type, platform)" | Dùng COALESCE sentinel để handle NULL |
| `idx_senders_email` | Email classify hot path — lookup sender → platform | Case-insensitive |
| `idx_app_aliases_text` | Email classify — match app_name → app_id | Case-insensitive, exclude regex rows |
| `idx_subject_patterns_platform` | Email classify — load patterns theo priority | Partial trên `active=true` |
| `idx_email_messages_status_pending` | Retry logic cho email chưa classify | Partial cho `PENDING` rows |
| `idx_tickets_inbox` / `idx_tickets_followup` | List view render nhanh | Partial indexes |
| `idx_ticket_entries_ticket_created` | Render thread timeline | Composite với sort |

---

## 4. Seed data (migration)

3 seed migration file chạy sau schema creation:

### 4.1. Seed platforms

```sql
-- File: 20260101000100_seed_platforms.sql
INSERT INTO platforms (key, display_name, icon_name, console_url_template, sort_order) VALUES
  ('apple',    'Apple App Store', 'apple',       'https://appstoreconnect.apple.com/apps/{platform_ref}', 10),
  ('google',   'Google Play',     'google-play', 'https://play.google.com/console/u/0/developers/app/{platform_ref}', 20),
  ('huawei',   'Huawei AppGallery', 'huawei',    'https://developer.huawei.com/consumer/en/console/app/{platform_ref}', 30),
  ('facebook', 'Facebook',        'facebook',    'https://developers.facebook.com/apps/{platform_ref}', 40);
```

### 4.2. Seed Apple rules (initial)

```sql
-- File: 20260101000200_seed_apple_rules.sql
DO $$
DECLARE apple_id UUID;
BEGIN
  SELECT id INTO apple_id FROM platforms WHERE key = 'apple';

  -- Sender
  INSERT INTO senders (platform_id, email, is_primary) VALUES
    (apple_id, 'no-reply@apple.com', true);

  -- Subject patterns
  INSERT INTO subject_patterns (platform_id, outcome, regex, priority, example_subject) VALUES
    (apple_id, 'APPROVED', 'Review of your (?<app_name>.+) submission is complete\.', 10,
     'Review of your Skyline Runners submission is complete.'),
    (apple_id, 'REJECTED', 'There''s an issue with your (?<app_name>.+) submission\.', 20,
     'There''s an issue with your Dragon Guild submission.'),
    (apple_id, 'IN_REVIEW', 'Your (?<app_name>.+) status has changed to (In Review|Waiting for Review)', 30,
     'Your Realm Defenders status has changed to Waiting for Review');

  -- Types
  INSERT INTO types (platform_id, name, slug, body_keyword, payload_extract_regex, sort_order) VALUES
    (apple_id, 'App',                 'app', 'App Version',
     'App Version\s*\n\s*(?<version>[\d.]+) for (?<os>\w+)', 10),
    (apple_id, 'In-App Event',        'iae', 'In-App Events',
     'In-App Events\s*\n\s*(?<event_name>.+?)\s+(?<event_id>\d+)', 20),
    (apple_id, 'Custom Product Page', 'cpp', 'Custom Product Pages',
     'Custom Product Pages\s*\n\s*(?<page_name>.+?)\s+(?<page_id>[a-f0-9-]{36})', 30);
END $$;
```

### 4.3. Seed initial Manager

```sql
-- File: 20260101000300_seed_initial_manager.sql
-- Đọc từ env var INITIAL_MANAGER_EMAIL thông qua Supabase migration runner
-- Hoặc chạy tay sau deploy lần đầu:
INSERT INTO users (email, role, display_name)
VALUES (current_setting('app.initial_manager_email'), 'MANAGER', 'Initial Manager')
ON CONFLICT (email) DO NOTHING;
```

Chạy migration: `SET app.initial_manager_email = 'manager@company.com'; \i 20260101000300_seed_initial_manager.sql`

---

## 5. RLS Strategy — MVP approach

**Decision**: MVP **defer RLS**, dùng API-level authorization. Lý do:

- Tất cả DB access đi qua Next.js API routes / Server Actions dùng **service role key** (bypass RLS)
- Client không trực tiếp query Supabase
- API middleware check `session.user.role` trước khi xử lý
- RLS chỉ là defense-in-depth — thêm value rõ ràng khi enable Supabase Realtime hoặc direct client queries (phase 2)

**Thay vào đó, ship với API layer strict**:

```ts
// middleware.ts
export async function requireRole(role: Role | Role[]) {
  const session = await auth();
  if (!session) throw new UnauthorizedError();
  const allowedRoles = Array.isArray(role) ? role : [role];
  if (!allowedRoles.includes(session.user.role)) {
    throw new ForbiddenError();
  }
  return session;
}

// api/settings/route.ts
export async function PATCH(req: Request) {
  const session = await requireRole('MANAGER');  // ← enforce ở API
  // ... use service role to update DB
}
```

**RLS policies chuẩn bị sẵn** (bật khi cần):

```sql
-- Enable RLS on all tables
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;

-- Everyone authenticated reads
CREATE POLICY "authenticated_read_tickets"
  ON tickets FOR SELECT
  TO authenticated
  USING (true);

-- Only MANAGER and DEV write
CREATE POLICY "managers_devs_write_tickets"
  ON tickets FOR INSERT
  TO authenticated
  WITH CHECK (auth.jwt() ->> 'role' IN ('MANAGER', 'DEV'));

-- Pattern tương tự cho tất cả tables
```

Chuyển sang RLS yêu cầu mint custom JWT trong NextAuth callback với claim `role` — documented trong phase 2 upgrade.

---

## 6. Migration Strategy

### 6.1. File layout

```
supabase/migrations/
├── 20260101000000_init_schema.sql          (toàn bộ CREATE TABLE + INDEX + TRIGGER)
├── 20260101000100_seed_platforms.sql
├── 20260101000200_seed_apple_rules.sql
└── 20260101000300_seed_initial_manager.sql
```

Timestamp prefix = `YYYYMMDDHHMMSS`. Supabase CLI tự detect và chạy theo thứ tự.

### 6.2. CI/CD flow

```yaml
# .github/workflows/deploy.yml (simplified)
on: push: { branches: [main] }
jobs:
  deploy:
    steps:
      - checkout
      - setup supabase CLI
      - run: supabase link --project-ref $SUPABASE_PROJECT
      - run: supabase db push    # ← apply migrations
      - deploy Railway: web service
```

### 6.3. Rollback policy

**Forward-only migrations** — không viết down migrations. Khi cần revert:
1. Viết 1 migration mới reverse changes
2. Deploy lại
3. Lý do: down migrations untested trong CI → nguy hiểm

**Staged deploy cho breaking schema changes**:
1. Deploy code tương thích với **cả old + new schema**
2. Apply migration (add columns, keep old)
3. Deploy code dùng new schema
4. Apply cleanup migration (drop old columns) sau khi verify stable

---

## 7. Data Flow Invariants

**Must-hold invariants**:

1. **Ticket uniqueness**: `∀ (app_id, type_id, platform_id)`, tồn tại tối đa 1 ticket với `state ∈ {NEW, IN_REVIEW, REJECTED}` — enforced by `idx_tickets_open_unique`
2. **Terminal state consistency**: `state ∈ {APPROVED, DONE, ARCHIVED}` ↔ `closed_at IS NOT NULL` ↔ `resolution_type IS NOT NULL` — enforced by CHECK
3. **Email dedup**: `gmail_msg_id` UNIQUE — cùng email chỉ được insert 1 lần dù cron race
4. **Append-only event log**: `ticket_entries` không UPDATE, chỉ INSERT — enforced by convention (nếu cần strict: add trigger reject UPDATE)
5. **Email snapshot preservation**: mọi `ticket_entries` type=`EMAIL` phải có `metadata.email_snapshot` — enforced by application code (test coverage)
6. **Alias exclusivity**: `alias_text XOR alias_regex` — enforced by CHECK

**Application-level invariants** (test cases cần có):

- Rename app → exactly 1 `AUTO_CURRENT` alias tồn tại, rest là `AUTO_HISTORICAL` / `MANUAL` / `REGEX`
- Terminal ticket → new email cùng key → **tạo ticket mới**, không reopen
- Classification failure → email có `classification_status = ERROR`, không attach ticket

---

## 8. ER Diagram

```
                 ┌──────────┐
                 │  users   │
                 └─────┬────┘
                       │ owns / creates / acts
        ┌──────────────┼──────────────────────┬──────────────────┐
        │              │                      │                  │
        ▼              ▼                      ▼                  ▼
   ┌────────┐   ┌──────────────┐    ┌────────────────┐   ┌───────────────┐
   │  apps  │   │   tickets    │◀───│ ticket_entries │   │   settings    │
   └───┬────┘   └──────┬───────┘    └────────┬───────┘   │  (singleton)  │
       │               │                     │            └───────────────┘
       │               │                     │ sources
       │               │                     ▼
       │               │              ┌────────────────┐
       │               │ contains     │ email_messages │◀──┐
       │               └──────────────┤                │   │
       │                              └────────┬───────┘   │
       │                                       │ classified│
       ▼                                       ▼            │
┌────────────────┐                      ┌───────────┐      │ sync
│  app_aliases   │                      │ platforms │◀─────┤
├────────────────┤                      └─────┬─────┘      │
│ app_platform_  │                            │            │
│   bindings     │◀───── linked ──────────────┤            │
├────────────────┤                            │ has        │
└────────────────┘                            ├────────────┤
                                              │            │
                                              ▼            ▼
                                  ┌─────────────────┐  ┌─────────────┐
                                  │  senders        │  │    types    │
                                  │  subject_       │  │             │
                                  │    patterns     │  └─────────────┘
                                  │  submission_id_ │
                                  │    patterns     │  ┌───────────────────┐
                                  └─────────────────┘  │gmail_credentials  │
                                                       │gmail_sync_state   │
                                                       │   (singletons)    │
                                                       └───────────────────┘

Audit tables (append-only):
   rule_versions      — snapshot rule config khi save
   sync_logs          — mỗi cron run
   cleanup_logs       — mỗi email cleanup
```

---

## 9. Schema statistics ước tính

Với assumption 200 submission/tháng, 50 apps, 2000 email/tháng:

| Table | Rows sau 1 năm | Size ước tính |
|---|---|---|
| users | ~10 | <1MB |
| platforms | 4 | <1MB |
| apps | ~50 | <1MB |
| app_aliases | ~200 (avg 4/app) | <1MB |
| tickets | ~2400 (200/month) | ~2MB |
| ticket_entries | ~12,000 (avg 5/ticket) | ~30MB (với email_snapshot metadata) |
| email_messages | ~24,000 (2k/month) | ~100-200MB (raw body), ~30MB sau cleanup |
| sync_logs | ~105,000 (12/hr × 24 × 365) | ~20MB |
| rule_versions | ~20-50 | <5MB |

**Total DB size** estimate: ~300MB sau 1 năm → fit comfortable trong Supabase Pro 8GB. Free tier (500MB) sẽ hit limit ~18 tháng tùy email volume.

**Recommendation**: Start Supabase Free tier. Monitor usage, upgrade Pro khi hit 80% quota (~400MB) — khoảng 15 tháng.

---

## 10. Resolved decisions (section-specific)

| # | Quyết định | Implementation |
|---|---|---|
| S1 | **Email body**: chỉ lưu `raw_body_text`, không lưu HTML | Schema đã reflect — chỉ có column `raw_body_text` |
| S2 | **Ticket delete**: chỉ qua state `ARCHIVED`, không hard delete | Không cần thêm gì — chỉ enforce ở API layer (không expose DELETE endpoint) |
| S3 | **Display ID format**: toàn cục tăng dần `TICKET-10000` | Dùng sequence `ticket_display_id_seq` |
| S4 | **Comment edit**: cho phép edit **bất cứ lúc nào**, chỉ author của comment (không phải user khác) được edit, lưu `edited_at` | Schema: thêm field `edited_at TIMESTAMPTZ` trong `ticket_entries`. Enforce ở API layer: chỉ `entry_type='COMMENT'` + `author_user_id = session.user.id` mới được UPDATE |
| S5 | **Full-text search**: defer sang phase 2 | Hiện dùng Postgres `ILIKE` hoặc `lower() LIKE` với index hiện có |

**Edit comment rules** (implementation notes):
- Chỉ `entry_type = 'COMMENT'` được edit. Các entry type khác (EMAIL, REJECT_REASON, STATE_CHANGE, ASSIGNMENT, PRIORITY_CHANGE) là **immutable** — treat as append-only event log
- Author check ở API: `WHERE id = $entry_id AND author_user_id = $session_user_id AND entry_type = 'COMMENT'`
- Audit: mỗi edit update `content` + `edited_at = NOW()`. Không lưu history chi tiết các lần edit (keep simple). UI hiện "(edited)" + timestamp bên cạnh comment khi `edited_at IS NOT NULL`

---

## Bước tiếp theo

Sau khi bạn review + confirm Data Model:
- **Section 2 deep-dive: Gmail Sync Pipeline** — code structure cho `/api/sync/gmail`, error handling, state transitions
- Sau đó: Email Rule Engine + Ticket Engine — business logic wiring
- Cuối cùng: API design + Frontend architecture

Phản hồi cần thiết: schema có gì sai/thiếu, hay đồng ý tất cả để ship migration?
