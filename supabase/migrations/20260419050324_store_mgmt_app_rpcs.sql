-- ============================================================
-- Migration: Store Management — App Registry transactional RPCs
--
-- Three PL/pgSQL functions wrap multi-table mutations for the App Registry:
--   - create_app_tx       INSERT app + auto-create AUTO_CURRENT alias +
--                         optional platform bindings (all-or-nothing)
--   - rename_app_tx       Apply a pre-computed AliasChange[] plan
--                         (DEMOTE/INSERT/PROMOTE) against apps + app_aliases
--   - import_apps_csv_tx  Bulk CSV import with per-row status, idempotent by
--                         slug (skips existing unless update requested)
--
-- All three are SECURITY INVOKER. Callers (Server Actions) have already
-- guarded on MANAGER role before invocation.
--
-- Error contract: RAISE EXCEPTION with sqlerrm prefix the TypeScript layer
-- pattern-matches (e.g. 'NOT_FOUND:', 'INVALID_ARG:', 'SLUG_TAKEN:').
-- See app/(dashboard)/store-submissions/config/apps/actions.ts mapRpcError.
-- ============================================================

-- -----------------------------------------------------------------
-- create_app_tx
-- -----------------------------------------------------------------
-- Params:
--   p_slug                slug (UNIQUE) — caller resolves collisions before calling
--   p_name                canonical name; becomes the first AUTO_CURRENT alias
--   p_display_name        optional display override
--   p_team_owner_id       optional FK → store_mgmt.users.id
--   p_active              defaults to true
--   p_created_by          actor UUID (nullable)
--   p_platform_bindings   JSONB array of { platform_key, platform_ref?, console_url? }
--
-- Returns: the new app's UUID.
--
-- Raises:
--   SLUG_TAKEN        — slug already exists (23505 from apps_slug_key)
--   INVALID_ARG       — empty name / bad platform key / invalid binding shape
--   UNKNOWN_PLATFORM  — platform_key not present in store_mgmt.platforms
CREATE OR REPLACE FUNCTION store_mgmt.create_app_tx(
  p_slug              TEXT,
  p_name              TEXT,
  p_display_name      TEXT,
  p_team_owner_id     UUID,
  p_active            BOOLEAN,
  p_created_by        UUID,
  p_platform_bindings JSONB
) RETURNS UUID AS $$
DECLARE
  v_app_id      UUID;
  v_binding     JSONB;
  v_platform_id UUID;
  v_platform_key TEXT;
  v_trimmed_name TEXT;
BEGIN
  v_trimmed_name := btrim(COALESCE(p_name, ''));
  IF v_trimmed_name = '' THEN
    RAISE EXCEPTION 'INVALID_ARG: name cannot be empty';
  END IF;
  IF btrim(COALESCE(p_slug, '')) = '' THEN
    RAISE EXCEPTION 'INVALID_ARG: slug cannot be empty';
  END IF;

  BEGIN
    INSERT INTO store_mgmt.apps (
      slug, name, display_name, team_owner_id, active, created_by
    )
    VALUES (
      p_slug,
      v_trimmed_name,
      NULLIF(btrim(COALESCE(p_display_name, '')), ''),
      p_team_owner_id,
      COALESCE(p_active, true),
      p_created_by
    )
    RETURNING id INTO v_app_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'SLUG_TAKEN: slug "%" already exists', p_slug;
  END;

  -- Seed the first AUTO_CURRENT alias from the canonical name.
  INSERT INTO store_mgmt.app_aliases (app_id, alias_text, source_type)
  VALUES (v_app_id, v_trimmed_name, 'AUTO_CURRENT');

  -- Platform bindings are optional; empty / null array is accepted.
  IF p_platform_bindings IS NOT NULL AND jsonb_typeof(p_platform_bindings) = 'array' THEN
    FOR v_binding IN SELECT * FROM jsonb_array_elements(p_platform_bindings)
    LOOP
      v_platform_key := v_binding->>'platform_key';
      IF v_platform_key IS NULL OR btrim(v_platform_key) = '' THEN
        RAISE EXCEPTION 'INVALID_ARG: platform binding missing platform_key';
      END IF;

      SELECT id INTO v_platform_id
      FROM store_mgmt.platforms
      WHERE key = v_platform_key;

      IF v_platform_id IS NULL THEN
        RAISE EXCEPTION 'UNKNOWN_PLATFORM: "%" is not a registered platform', v_platform_key;
      END IF;

      INSERT INTO store_mgmt.app_platform_bindings (
        app_id, platform_id, platform_ref, console_url
      )
      VALUES (
        v_app_id,
        v_platform_id,
        NULLIF(btrim(COALESCE(v_binding->>'platform_ref', '')), ''),
        NULLIF(btrim(COALESCE(v_binding->>'console_url', '')), '')
      );
    END LOOP;
  END IF;

  RETURN v_app_id;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.create_app_tx IS
  'Transactional app creation: inserts apps row, seeds AUTO_CURRENT alias, and optional platform bindings. Raises SLUG_TAKEN / INVALID_ARG / UNKNOWN_PLATFORM.';

-- -----------------------------------------------------------------
-- rename_app_tx
-- -----------------------------------------------------------------
-- Params:
--   p_app_id   target app UUID
--   p_new_name canonical new name (trimmed, non-empty)
--   p_changes  JSONB array produced by deriveAliasChangesOnRename in TS. Each
--              element is one of:
--                { "kind": "DEMOTE",  "aliasId": "<uuid>", "previousName": "<text>" }
--                { "kind": "INSERT",  "aliasText": "<text>", "sourceType": "AUTO_CURRENT" }
--                { "kind": "PROMOTE", "aliasId": "<uuid>" }
--              Changes are applied in array order inside this function's
--              implicit transaction, so a failure on any row rolls back all
--              prior changes in this call.
--
-- Returns: the updated app's name.
--
-- Raises:
--   NOT_FOUND     — app row missing
--   INVALID_ARG   — empty new name or malformed change element
--   ALIAS_MISSING — DEMOTE/PROMOTE referenced alias id that does not belong
--                   to this app (defensive — protects against stale input)
CREATE OR REPLACE FUNCTION store_mgmt.rename_app_tx(
  p_app_id   UUID,
  p_new_name TEXT,
  p_changes  JSONB
) RETURNS TEXT AS $$
DECLARE
  v_change       JSONB;
  v_kind         TEXT;
  v_alias_id     UUID;
  v_updated_rows INT;
  v_trimmed_name TEXT;
  v_exists       BOOLEAN;
BEGIN
  v_trimmed_name := btrim(COALESCE(p_new_name, ''));
  IF v_trimmed_name = '' THEN
    RAISE EXCEPTION 'INVALID_ARG: new_name cannot be empty';
  END IF;

  -- Lock the target app row so concurrent renames serialize.
  SELECT TRUE INTO v_exists FROM store_mgmt.apps WHERE id = p_app_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: app % does not exist', p_app_id;
  END IF;

  UPDATE store_mgmt.apps SET name = v_trimmed_name WHERE id = p_app_id;

  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' THEN
    RETURN v_trimmed_name;
  END IF;

  FOR v_change IN SELECT * FROM jsonb_array_elements(p_changes)
  LOOP
    v_kind := v_change->>'kind';

    IF v_kind = 'DEMOTE' THEN
      v_alias_id := (v_change->>'aliasId')::UUID;
      UPDATE store_mgmt.app_aliases
      SET source_type   = 'AUTO_HISTORICAL',
          previous_name = v_change->>'previousName'
      WHERE id = v_alias_id AND app_id = p_app_id;
      GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
      IF v_updated_rows = 0 THEN
        RAISE EXCEPTION 'ALIAS_MISSING: alias % not found under app %', v_alias_id, p_app_id;
      END IF;

    ELSIF v_kind = 'PROMOTE' THEN
      v_alias_id := (v_change->>'aliasId')::UUID;
      UPDATE store_mgmt.app_aliases
      SET source_type   = 'AUTO_CURRENT',
          previous_name = NULL
      WHERE id = v_alias_id AND app_id = p_app_id;
      GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
      IF v_updated_rows = 0 THEN
        RAISE EXCEPTION 'ALIAS_MISSING: alias % not found under app %', v_alias_id, p_app_id;
      END IF;

    ELSIF v_kind = 'INSERT' THEN
      IF btrim(COALESCE(v_change->>'aliasText', '')) = '' THEN
        RAISE EXCEPTION 'INVALID_ARG: INSERT change missing aliasText';
      END IF;
      INSERT INTO store_mgmt.app_aliases (app_id, alias_text, source_type)
      VALUES (p_app_id, btrim(v_change->>'aliasText'), 'AUTO_CURRENT');

    ELSE
      RAISE EXCEPTION 'INVALID_ARG: unknown change kind %', v_kind;
    END IF;
  END LOOP;

  RETURN v_trimmed_name;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.rename_app_tx IS
  'Applies a pre-computed AliasChange[] plan atomically: updates apps.name then replays DEMOTE/INSERT/PROMOTE rows against app_aliases. Raises NOT_FOUND / INVALID_ARG / ALIAS_MISSING.';

-- -----------------------------------------------------------------
-- import_apps_csv_tx
-- -----------------------------------------------------------------
-- Params:
--   p_rows       JSONB array of rows pre-validated by csvRowSchema in TS.
--                Each row shape:
--                  {
--                    "rowNumber": <int>,     -- 1-indexed after header
--                    "slug":      "<text>",  -- TS resolves from name or provides
--                    "name":      "<text>",
--                    "display_name": "<text>|null",
--                    "aliases":   ["<text>", ...],
--                    "platform_bindings": [ { platform_key, platform_ref? }, ... ],
--                    "team_owner_id": "<uuid>|null",  -- resolved from email in TS
--                    "active":    <bool>
--                  }
--   p_imported_by actor UUID
--   p_strategy   'SKIP_EXISTING' (default) — existing slugs untouched and reported
--                'FAIL_ON_EXISTING' — raise if any slug already exists
--
-- Returns a JSONB report:
--   {
--     "created": [ { "rowNumber": N, "app_id": "<uuid>", "slug": "..." }, ... ],
--     "skipped": [ { "rowNumber": N, "slug": "...", "reason": "..." }, ... ],
--     "errors":  [ { "rowNumber": N, "slug": "...", "code": "...", "message": "..." } ]
--   }
--
-- Entire call runs in a single transaction. Any unexpected RAISE rolls back
-- all earlier inserts in the same invocation.
CREATE OR REPLACE FUNCTION store_mgmt.import_apps_csv_tx(
  p_rows        JSONB,
  p_imported_by UUID,
  p_strategy    TEXT DEFAULT 'SKIP_EXISTING'
) RETURNS JSONB AS $$
DECLARE
  v_row          JSONB;
  v_row_number   INT;
  v_slug         TEXT;
  v_name         TEXT;
  v_existing_id  UUID;
  v_new_id       UUID;
  v_bindings     JSONB;
  v_aliases      JSONB;
  v_alias_text   TEXT;
  v_created      JSONB := '[]'::JSONB;
  v_skipped      JSONB := '[]'::JSONB;
  v_errors       JSONB := '[]'::JSONB;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_ARG: p_rows must be a JSONB array';
  END IF;
  IF p_strategy NOT IN ('SKIP_EXISTING', 'FAIL_ON_EXISTING') THEN
    RAISE EXCEPTION 'INVALID_ARG: unknown strategy %', p_strategy;
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_row_number := COALESCE((v_row->>'rowNumber')::INT, 0);
    v_slug       := btrim(COALESCE(v_row->>'slug', ''));
    v_name       := btrim(COALESCE(v_row->>'name', ''));

    IF v_slug = '' OR v_name = '' THEN
      v_errors := v_errors || jsonb_build_object(
        'rowNumber', v_row_number,
        'slug', v_slug,
        'code', 'INVALID_ARG',
        'message', 'slug and name are required'
      );
      CONTINUE;
    END IF;

    SELECT id INTO v_existing_id
    FROM store_mgmt.apps
    WHERE slug = v_slug;

    IF v_existing_id IS NOT NULL THEN
      IF p_strategy = 'FAIL_ON_EXISTING' THEN
        RAISE EXCEPTION 'SLUG_TAKEN: slug "%" already exists (row %)', v_slug, v_row_number;
      END IF;
      v_skipped := v_skipped || jsonb_build_object(
        'rowNumber', v_row_number,
        'slug', v_slug,
        'reason', 'SLUG_EXISTS'
      );
      CONTINUE;
    END IF;

    v_bindings := COALESCE(v_row->'platform_bindings', '[]'::JSONB);
    v_aliases  := COALESCE(v_row->'aliases', '[]'::JSONB);

    BEGIN
      v_new_id := store_mgmt.create_app_tx(
        v_slug,
        v_name,
        v_row->>'display_name',
        NULLIF(v_row->>'team_owner_id', '')::UUID,
        COALESCE((v_row->>'active')::BOOLEAN, true),
        p_imported_by,
        v_bindings
      );

      -- Extra manual aliases (beyond the AUTO_CURRENT seeded by create_app_tx).
      IF jsonb_typeof(v_aliases) = 'array' THEN
        FOR v_alias_text IN SELECT jsonb_array_elements_text(v_aliases)
        LOOP
          v_alias_text := btrim(v_alias_text);
          IF v_alias_text = '' OR lower(v_alias_text) = lower(v_name) THEN
            CONTINUE;  -- skip empties and duplicates of the AUTO_CURRENT seed
          END IF;
          INSERT INTO store_mgmt.app_aliases (app_id, alias_text, source_type)
          VALUES (v_new_id, v_alias_text, 'MANUAL')
          ON CONFLICT DO NOTHING;
        END LOOP;
      END IF;

      v_created := v_created || jsonb_build_object(
        'rowNumber', v_row_number,
        'app_id', v_new_id,
        'slug', v_slug
      );
    EXCEPTION WHEN OTHERS THEN
      -- In SKIP_EXISTING we report the row and keep going; FAIL_ON_EXISTING
      -- would have already raised above for the slug-collision case.
      v_errors := v_errors || jsonb_build_object(
        'rowNumber', v_row_number,
        'slug', v_slug,
        'code', 'DB_ERROR',
        'message', SQLERRM
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'created', v_created,
    'skipped', v_skipped,
    'errors',  v_errors
  );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.import_apps_csv_tx IS
  'Bulk CSV import. Idempotent by slug (SKIP_EXISTING default). Returns per-row {created, skipped, errors}. Delegates app creation to create_app_tx so invariants stay consistent with single-app creation.';
