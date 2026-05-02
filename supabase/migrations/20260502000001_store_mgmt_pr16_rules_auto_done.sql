-- ============================================================
-- Migration: Store Management — PR-16a save/rollback rules thread
--                                  the new auto_done_eligible field
--
-- CREATE OR REPLACE three functions from
-- 20260419071718_store_mgmt_rules_rpcs to read + write the new
-- subject_patterns.auto_done_eligible column added by
-- 20260502000000_store_mgmt_pr16_auto_mark_done.
--
-- Three call sites updated:
--   1. build_rules_snapshot — emits auto_done_eligible in snapshot JSONB
--   2. save_rules_tx — reads auto_done_eligible from p_subject_patterns
--      payload, threads to INSERT
--   3. rollback_rules_tx — reads auto_done_eligible from snapshot JSONB,
--      threads to INSERT (default FALSE for legacy snapshots that predate
--      PR-16)
--
-- Backward compatibility:
--   - Pre-PR-16 snapshots (config_snapshot.subject_patterns rows lacking
--     auto_done_eligible) replay with FALSE via COALESCE — no surprise
--     auto-DONE after rollback to historical version.
--   - Pre-PR-16 save_rules_tx callers (none post-deploy because the TS
--     layer ships in the same PR-16a bundle) also receive FALSE via the
--     same COALESCE.
--
-- Forward-only migration: this is the canonical save/rollback for PR-16+.
-- Earlier 20260419 file kept untouched as historical record.
-- ============================================================

-- -----------------------------------------------------------------
-- build_rules_snapshot — include auto_done_eligible in subject pattern object
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
    'active', active,
    'auto_done_eligible', auto_done_eligible
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
  'PR-16: builds schema_version=1 snapshot. subject_patterns rows now include auto_done_eligible (additive; legacy snapshots without the field replay as FALSE on rollback).';

-- -----------------------------------------------------------------
-- save_rules_tx — read auto_done_eligible from p_subject_patterns payload
-- -----------------------------------------------------------------
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

  -- Insert subject patterns (PR-16: + auto_done_eligible)
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_subject_patterns) LOOP
    INSERT INTO store_mgmt.subject_patterns (
      platform_id, outcome, regex, priority, example_subject, active,
      auto_done_eligible
    )
    VALUES (
      p_platform_id,
      v_row->>'outcome',
      v_row->>'regex',
      COALESCE((v_row->>'priority')::INT, 100),
      NULLIF(btrim(COALESCE(v_row->>'example_subject', '')), ''),
      COALESCE((v_row->>'active')::BOOLEAN, true),
      COALESCE((v_row->>'auto_done_eligible')::BOOLEAN, false)
    );
  END LOOP;

  -- Types upsert-by-slug (unchanged)
  UPDATE store_mgmt.types
  SET active = false
  WHERE platform_id = p_platform_id
    AND slug NOT IN (
      SELECT btrim(t->>'slug')
      FROM jsonb_array_elements(p_types) AS t
      WHERE (t->>'slug') IS NOT NULL
    );

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

  -- Insert submission_id_patterns (unchanged)
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
  'PR-16: thread auto_done_eligible from p_subject_patterns payload into the column added by 20260502000000.';

-- -----------------------------------------------------------------
-- rollback_rules_tx — read auto_done_eligible from snapshot, default FALSE
-- -----------------------------------------------------------------
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

  -- PR-16: + auto_done_eligible. Pre-PR-16 snapshots lack the field;
  -- COALESCE to FALSE preserves opt-out default on rollback.
  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(v_snapshot->'subject_patterns', '[]'::JSONB)) LOOP
    INSERT INTO store_mgmt.subject_patterns (
      platform_id, outcome, regex, priority, example_subject, active,
      auto_done_eligible
    )
    VALUES (
      p_platform_id,
      v_row->>'outcome',
      v_row->>'regex',
      COALESCE((v_row->>'priority')::INT, 100),
      v_row->>'example_subject',
      COALESCE((v_row->>'active')::BOOLEAN, true),
      COALESCE((v_row->>'auto_done_eligible')::BOOLEAN, false)
    );
  END LOOP;

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
  'PR-16: replay auto_done_eligible from snapshot. Pre-PR-16 snapshots default FALSE (opt-out preserved).';

-- ============================================================
-- END — 20260502000001_store_mgmt_pr16_rules_auto_done
-- ============================================================
