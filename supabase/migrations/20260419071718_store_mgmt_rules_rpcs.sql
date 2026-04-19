-- ============================================================
-- Migration: Store Management — Email Rules transactional RPCs
--
-- Two PL/pgSQL functions wrap bulk rule mutations for the Email Rules
-- config screen:
--   - save_rules_tx      Replace all 4 rule sets (senders, subject_patterns,
--                        types, submission_id_patterns) for one platform +
--                        append a rule_versions snapshot. Optimistic lock
--                        via p_expected_version_number.
--   - rollback_rules_tx  Restore the rule set from a previous version's
--                        config_snapshot and append a new version row (never
--                        overwrites history).
--
-- Both functions are SECURITY INVOKER — callers (Server Actions) guard on
-- MANAGER role before invoking.
--
-- Concurrency model: `SELECT ... FOR UPDATE` on the platforms row serializes
-- concurrent saves of the same platform. Combined with the existing
-- UNIQUE(platform_id, version_number) constraint on rule_versions (kept as
-- belt-and-suspenders against direct SQL edits bypassing the RPC) this
-- guarantees version numbers are monotonic and gap-free per platform.
--
-- Error contract: RAISE EXCEPTION with sqlerrm prefix the TypeScript layer
-- pattern-matches. See
--   app/(dashboard)/store-submissions/config/email-rules/actions.ts
-- for mapRpcError + parseVersionConflict.
--   - NOT_FOUND:  platform/version missing
--   - INVALID_ARG: malformed JSONB input
--   - VERSION_CONFLICT: expected v<N|none>, actual v<N|none>
-- ============================================================

-- -----------------------------------------------------------------
-- Internal helper — build a config_snapshot JSONB from current rule
-- rows for a platform. Called at the end of save/rollback to capture
-- exactly what was persisted, with the generated UUIDs.
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION store_mgmt.build_rules_snapshot(p_platform_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_senders JSONB;
  v_subject JSONB;
  v_types   JSONB;
  v_sub_id  JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id,
    'email', email,
    'is_primary', is_primary,
    'active', active
  ) ORDER BY email), '[]'::JSONB)
  INTO v_senders
  FROM store_mgmt.senders
  WHERE platform_id = p_platform_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id,
    'outcome', outcome,
    'regex', regex,
    'priority', priority,
    'example_subject', example_subject,
    'active', active
  ) ORDER BY priority, id), '[]'::JSONB)
  INTO v_subject
  FROM store_mgmt.subject_patterns
  WHERE platform_id = p_platform_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id,
    'name', name,
    'slug', slug,
    'body_keyword', body_keyword,
    'payload_extract_regex', payload_extract_regex,
    'sort_order', sort_order,
    'active', active
  ) ORDER BY sort_order, slug), '[]'::JSONB)
  INTO v_types
  FROM store_mgmt.types
  WHERE platform_id = p_platform_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id,
    'body_regex', body_regex,
    'active', active
  ) ORDER BY id), '[]'::JSONB)
  INTO v_sub_id
  FROM store_mgmt.submission_id_patterns
  WHERE platform_id = p_platform_id;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'senders', v_senders,
    'subject_patterns', v_subject,
    'types', v_types,
    'submission_id_patterns', v_sub_id
  );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.build_rules_snapshot IS
  'Builds a schema_version=1 JSONB snapshot of the current rule set for a platform. Used by save_rules_tx and rollback_rules_tx.';

-- -----------------------------------------------------------------
-- save_rules_tx
-- -----------------------------------------------------------------
-- Params:
--   p_platform_id              platform UUID
--   p_expected_version_number  optimistic-lock guard. NULL = caller expects
--                              no prior save. INT = caller expects current
--                              MAX(version_number) to equal this value.
--                              Mismatch → VERSION_CONFLICT.
--   p_senders                  JSONB array of { email, is_primary, active }
--   p_subject_patterns         JSONB array of { outcome, regex, priority,
--                                                example_subject, active }
--   p_types                    JSONB array of { name, slug, body_keyword,
--                                                payload_extract_regex, sort_order, active }
--   p_submission_id_patterns   JSONB array of { body_regex, active }
--   p_saved_by                 actor UUID (nullable)
--   p_note                     optional human-readable commit note
--
-- Returns: the new version_number (INT).
--
-- Raises:
--   NOT_FOUND          — platform row missing
--   INVALID_ARG        — malformed input JSONB
--   VERSION_CONFLICT   — expected vs actual version mismatch
CREATE OR REPLACE FUNCTION store_mgmt.save_rules_tx(
  p_platform_id             UUID,
  p_expected_version_number INT,
  p_senders                 JSONB,
  p_subject_patterns        JSONB,
  p_types                   JSONB,
  p_submission_id_patterns  JSONB,
  p_saved_by                UUID,
  p_note                    TEXT
) RETURNS INT AS $$
DECLARE
  v_platform_exists  BOOLEAN;
  v_current_version  INT;
  v_new_version      INT;
  v_expected_label   TEXT;
  v_actual_label     TEXT;
  v_row              JSONB;
  v_snapshot         JSONB;
BEGIN
  -- Serialize concurrent saves against the same platform.
  SELECT TRUE INTO v_platform_exists
  FROM store_mgmt.platforms
  WHERE id = p_platform_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: platform % does not exist', p_platform_id;
  END IF;

  IF jsonb_typeof(p_senders) <> 'array'
     OR jsonb_typeof(p_subject_patterns) <> 'array'
     OR jsonb_typeof(p_types) <> 'array'
     OR jsonb_typeof(p_submission_id_patterns) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_ARG: all rule inputs must be JSONB arrays';
  END IF;

  -- Optimistic-lock check. NULL expected means "no prior save"; caller
  -- should only pass NULL when they believe the platform has never been
  -- saved to. Any prior version with a non-NULL expected = conflict.
  SELECT MAX(version_number) INTO v_current_version
  FROM store_mgmt.rule_versions
  WHERE platform_id = p_platform_id;

  IF v_current_version IS DISTINCT FROM p_expected_version_number THEN
    v_expected_label := COALESCE(p_expected_version_number::TEXT, 'none');
    v_actual_label   := COALESCE(v_current_version::TEXT, 'none');
    RAISE EXCEPTION 'VERSION_CONFLICT: expected v%, actual v%',
      v_expected_label, v_actual_label;
  END IF;

  v_new_version := COALESCE(v_current_version, 0) + 1;

  -- senders / subject_patterns / submission_id_patterns have no inbound FKs
  -- → safe to DELETE+INSERT. `types` has tickets.type_id ON DELETE RESTRICT,
  -- so we upsert-by-slug (soft-deactivate missing) instead (see below).
  DELETE FROM store_mgmt.senders                WHERE platform_id = p_platform_id;
  DELETE FROM store_mgmt.subject_patterns       WHERE platform_id = p_platform_id;
  DELETE FROM store_mgmt.submission_id_patterns WHERE platform_id = p_platform_id;

  -- Insert senders
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_senders) LOOP
    INSERT INTO store_mgmt.senders (platform_id, email, is_primary, active)
    VALUES (
      p_platform_id,
      lower(btrim(v_row->>'email')),
      COALESCE((v_row->>'is_primary')::BOOLEAN, false),
      COALESCE((v_row->>'active')::BOOLEAN, true)
    );
  END LOOP;

  -- Insert subject patterns
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_subject_patterns) LOOP
    INSERT INTO store_mgmt.subject_patterns (
      platform_id, outcome, regex, priority, example_subject, active
    )
    VALUES (
      p_platform_id,
      v_row->>'outcome',
      v_row->>'regex',
      COALESCE((v_row->>'priority')::INT, 100),
      NULLIF(btrim(COALESCE(v_row->>'example_subject', '')), ''),
      COALESCE((v_row->>'active')::BOOLEAN, true)
    );
  END LOOP;

  -- Types upsert-by-slug. Step 1: soft-deactivate types not in the payload;
  -- hard DELETE would fail against tickets.type_id ON DELETE RESTRICT.
  UPDATE store_mgmt.types
  SET active = false
  WHERE platform_id = p_platform_id
    AND slug NOT IN (
      SELECT btrim(t->>'slug')
      FROM jsonb_array_elements(p_types) AS t
      WHERE (t->>'slug') IS NOT NULL
    );

  -- Step 2: insert-or-update each incoming type by natural key. Preserves
  -- the type UUID when the slug already exists so existing tickets keep
  -- pointing to the same type record.
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_types) LOOP
    INSERT INTO store_mgmt.types (
      platform_id, name, slug, body_keyword,
      payload_extract_regex, sort_order, active
    )
    VALUES (
      p_platform_id,
      btrim(v_row->>'name'),
      btrim(v_row->>'slug'),
      v_row->>'body_keyword',
      NULLIF(v_row->>'payload_extract_regex', ''),
      COALESCE((v_row->>'sort_order')::INT, 100),
      COALESCE((v_row->>'active')::BOOLEAN, true)
    )
    ON CONFLICT (platform_id, slug) DO UPDATE SET
      name                  = EXCLUDED.name,
      body_keyword          = EXCLUDED.body_keyword,
      payload_extract_regex = EXCLUDED.payload_extract_regex,
      sort_order            = EXCLUDED.sort_order,
      active                = EXCLUDED.active;
  END LOOP;

  -- Insert submission_id_patterns
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_submission_id_patterns) LOOP
    INSERT INTO store_mgmt.submission_id_patterns (
      platform_id, body_regex, active
    )
    VALUES (
      p_platform_id,
      v_row->>'body_regex',
      COALESCE((v_row->>'active')::BOOLEAN, true)
    );
  END LOOP;

  -- Build snapshot of just-written state and commit version row.
  v_snapshot := store_mgmt.build_rules_snapshot(p_platform_id);

  INSERT INTO store_mgmt.rule_versions (
    platform_id, version_number, config_snapshot, saved_by, note
  )
  VALUES (
    p_platform_id, v_new_version, v_snapshot, p_saved_by,
    NULLIF(btrim(COALESCE(p_note, '')), '')
  );

  RETURN v_new_version;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.save_rules_tx IS
  'Atomically replace all rule sets for a platform and append a rule_versions snapshot. Optimistic lock via p_expected_version_number; FOR UPDATE on platforms row serializes concurrent calls. Raises NOT_FOUND / INVALID_ARG / VERSION_CONFLICT.';

-- -----------------------------------------------------------------
-- rollback_rules_tx
-- -----------------------------------------------------------------
-- Restore the rule set to a previous snapshot and append a new version row.
-- NOT protected by optimistic-lock — rollback is always a new commit from
-- the user's current viewpoint, and we serialize via the same FOR UPDATE
-- on platforms so no concurrent save can interleave.
--
-- Params:
--   p_platform_id     platform UUID
--   p_target_version  version_number to restore
--   p_saved_by        actor UUID
--   p_note            optional human-readable note (default: auto-generated)
--
-- Returns: the new version_number.
--
-- Raises:
--   NOT_FOUND — platform missing or target version missing
--   INVALID_ARG — malformed snapshot JSONB (defensive)
CREATE OR REPLACE FUNCTION store_mgmt.rollback_rules_tx(
  p_platform_id    UUID,
  p_target_version INT,
  p_saved_by       UUID,
  p_note           TEXT
) RETURNS INT AS $$
DECLARE
  v_platform_exists  BOOLEAN;
  v_snapshot         JSONB;
  v_current_version  INT;
  v_new_version      INT;
  v_final_note       TEXT;
  v_row              JSONB;
BEGIN
  SELECT TRUE INTO v_platform_exists
  FROM store_mgmt.platforms
  WHERE id = p_platform_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: platform % does not exist', p_platform_id;
  END IF;

  SELECT config_snapshot INTO v_snapshot
  FROM store_mgmt.rule_versions
  WHERE platform_id = p_platform_id AND version_number = p_target_version;

  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: version % not found for platform %',
      p_target_version, p_platform_id;
  END IF;

  IF jsonb_typeof(v_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_ARG: snapshot for v% is not a JSONB object', p_target_version;
  END IF;

  SELECT MAX(version_number) INTO v_current_version
  FROM store_mgmt.rule_versions
  WHERE platform_id = p_platform_id;

  v_new_version := COALESCE(v_current_version, 0) + 1;

  -- Replay snapshot into live tables. Same FK-aware strategy as save_rules_tx:
  -- DELETE+INSERT for tables with no inbound FKs, upsert-by-slug for types.
  DELETE FROM store_mgmt.senders                WHERE platform_id = p_platform_id;
  DELETE FROM store_mgmt.subject_patterns       WHERE platform_id = p_platform_id;
  DELETE FROM store_mgmt.submission_id_patterns WHERE platform_id = p_platform_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(v_snapshot->'senders', '[]'::JSONB)) LOOP
    INSERT INTO store_mgmt.senders (platform_id, email, is_primary, active)
    VALUES (
      p_platform_id,
      v_row->>'email',
      COALESCE((v_row->>'is_primary')::BOOLEAN, false),
      COALESCE((v_row->>'active')::BOOLEAN, true)
    );
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(v_snapshot->'subject_patterns', '[]'::JSONB)) LOOP
    INSERT INTO store_mgmt.subject_patterns (
      platform_id, outcome, regex, priority, example_subject, active
    )
    VALUES (
      p_platform_id,
      v_row->>'outcome',
      v_row->>'regex',
      COALESCE((v_row->>'priority')::INT, 100),
      v_row->>'example_subject',
      COALESCE((v_row->>'active')::BOOLEAN, true)
    );
  END LOOP;

  -- Soft-deactivate types not in the snapshot; then upsert each snapshot row.
  UPDATE store_mgmt.types
  SET active = false
  WHERE platform_id = p_platform_id
    AND slug NOT IN (
      SELECT t->>'slug'
      FROM jsonb_array_elements(COALESCE(v_snapshot->'types', '[]'::JSONB)) AS t
      WHERE (t->>'slug') IS NOT NULL
    );

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(v_snapshot->'types', '[]'::JSONB)) LOOP
    INSERT INTO store_mgmt.types (
      platform_id, name, slug, body_keyword,
      payload_extract_regex, sort_order, active
    )
    VALUES (
      p_platform_id,
      v_row->>'name',
      v_row->>'slug',
      v_row->>'body_keyword',
      v_row->>'payload_extract_regex',
      COALESCE((v_row->>'sort_order')::INT, 100),
      COALESCE((v_row->>'active')::BOOLEAN, true)
    )
    ON CONFLICT (platform_id, slug) DO UPDATE SET
      name                  = EXCLUDED.name,
      body_keyword          = EXCLUDED.body_keyword,
      payload_extract_regex = EXCLUDED.payload_extract_regex,
      sort_order            = EXCLUDED.sort_order,
      active                = EXCLUDED.active;
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(v_snapshot->'submission_id_patterns', '[]'::JSONB)) LOOP
    INSERT INTO store_mgmt.submission_id_patterns (
      platform_id, body_regex, active
    )
    VALUES (
      p_platform_id,
      v_row->>'body_regex',
      COALESCE((v_row->>'active')::BOOLEAN, true)
    );
  END LOOP;

  -- Preserve the original snapshot verbatim in the new version row. Rebuilding
  -- from just-inserted rows would produce a functionally-equivalent but
  -- structurally-divergent snapshot (new UUIDs) — we want byte-exact history
  -- so a future rollback to this new version replays what v<target> had.
  v_final_note := COALESCE(
    NULLIF(btrim(COALESCE(p_note, '')), ''),
    format('Rolled back to v%s', p_target_version)
  );

  INSERT INTO store_mgmt.rule_versions (
    platform_id, version_number, config_snapshot, saved_by, note
  )
  VALUES (
    p_platform_id, v_new_version, v_snapshot, p_saved_by, v_final_note
  );

  RETURN v_new_version;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.rollback_rules_tx IS
  'Replay a rule_versions snapshot into the live tables and append a new version row (never overwrites history). Serialized via FOR UPDATE on platforms. Raises NOT_FOUND / INVALID_ARG.';
