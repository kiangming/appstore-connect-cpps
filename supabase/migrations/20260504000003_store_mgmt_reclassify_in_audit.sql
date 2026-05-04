-- ============================================================
-- Migration: Store Management — Reclassify destination audit (PR-20)
--
-- Adds audit symmetry to `reclassify_email_tx`: the destination
-- ticket now receives a `STATE_CHANGE` entry with
-- `metadata.type = 'reclassify_in'` mirroring the existing
-- `reclassify_out` on the source ticket. Manager opening either
-- side of a reclassify event now sees the move in the timeline.
--
-- Two changes from 20260425000002 (PR-11.5):
--
--   1. Reorder: the `reclassify_out` INSERT moves to AFTER the
--      attach side (`find_or_create_ticket_tx`) resolves
--      `v_new_ticket_id`, so the audit row can carry
--      `to_ticket_id` in its metadata. Atomicity is preserved —
--      everything still runs inside the single PL/pgSQL function
--      transaction; the source-ticket FOR UPDATE lock window is
--      held a few statements longer but releases on RPC return.
--
--   2. Add: a `reclassify_in` STATE_CHANGE INSERT on the
--      destination ticket. Gated on
--          v_new_is_ticketable
--       AND v_new_ticket_id IS NOT NULL
--       AND v_new_ticket_id IS DISTINCT FROM v_old_ticket_id
--      so DROPPED/ERROR destinations and self-attach (no
--      ticket boundary crossed) skip cleanly.
--
-- Backward compat: existing `reclassify_out` rows from PR-11.5
-- and PR-12.5 lack `to_ticket_id` in metadata. The timeline
-- renderer (PR-20 client change) handles that shape gracefully
-- ("destination: pending" placeholder, no crash).
--
-- Forward-only per CLAUDE.md invariant #7. CREATE OR REPLACE
-- FUNCTION supersedes the prior body; no schema columns change,
-- no enum additions (STATE_CHANGE entry_type continues to host
-- both variants — `metadata.type` discriminates).
--
-- Spec authority unchanged from 20260425000002:
--   - 04-ticket-engine.md §5.2 (reclassify semantics)
--   - 04-ticket-engine.md §3.1-3.2 (transactional flow)
--   - CLAUDE.md invariants #1, #2, #7
-- ============================================================

CREATE OR REPLACE FUNCTION store_mgmt.reclassify_email_tx(
  p_email_message_id   UUID,
  p_new_classification JSONB,
  p_actor_id           UUID
) RETURNS JSONB AS $$
DECLARE
  v_email                  store_mgmt.email_messages%ROWTYPE;
  v_old_classification     JSONB;
  v_old_status             TEXT;
  v_new_status             TEXT;
  v_old_app_id             UUID;
  v_old_type_id            UUID;
  v_new_app_id             UUID;
  v_new_type_id            UUID;
  v_old_ticket_id          UUID;
  v_new_ticket_id          UUID;
  v_changed                BOOLEAN;
  v_subresult              JSONB;
  v_new_is_ticketable      BOOLEAN;
  v_now                    TIMESTAMPTZ := NOW();
BEGIN
  -- ---------------------------------------------------------------
  -- (a) Lock email row + capture old state
  -- ---------------------------------------------------------------
  SELECT * INTO v_email
    FROM store_mgmt.email_messages
   WHERE id = p_email_message_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: email_message % does not exist', p_email_message_id;
  END IF;

  v_old_classification := COALESCE(v_email.classification_result, '{}'::jsonb);
  v_old_status         := v_old_classification->>'status';
  v_old_ticket_id      := v_email.ticket_id;

  BEGIN
    v_old_app_id  := NULLIF(v_old_classification->>'app_id', '')::UUID;
    v_old_type_id := NULLIF(v_old_classification->>'type_id', '')::UUID;
  EXCEPTION WHEN invalid_text_representation OR others THEN
    v_old_app_id  := NULL;
    v_old_type_id := NULL;
  END;

  -- ---------------------------------------------------------------
  -- (b) Validate new_classification structure
  -- ---------------------------------------------------------------
  v_new_status := p_new_classification->>'status';
  IF v_new_status IS NULL OR v_new_status NOT IN (
    'CLASSIFIED', 'UNCLASSIFIED_APP', 'UNCLASSIFIED_TYPE', 'DROPPED', 'ERROR'
  ) THEN
    RAISE EXCEPTION 'INVALID_ARG: new_classification.status must be one of CLASSIFIED/UNCLASSIFIED_APP/UNCLASSIFIED_TYPE/DROPPED/ERROR (got %)',
      COALESCE(v_new_status, '<null>');
  END IF;

  BEGIN
    v_new_app_id  := NULLIF(p_new_classification->>'app_id', '')::UUID;
    v_new_type_id := NULLIF(p_new_classification->>'type_id', '')::UUID;
  EXCEPTION WHEN invalid_text_representation OR others THEN
    RAISE EXCEPTION 'INVALID_ARG: new_classification.app_id/type_id must be UUID or absent';
  END;

  v_new_is_ticketable := v_new_status IN (
    'CLASSIFIED', 'UNCLASSIFIED_APP', 'UNCLASSIFIED_TYPE'
  );

  -- ---------------------------------------------------------------
  -- (c) No-op short-circuit
  -- ---------------------------------------------------------------
  v_changed := (v_old_status IS DISTINCT FROM v_new_status)
            OR (v_old_app_id IS DISTINCT FROM v_new_app_id)
            OR (v_old_type_id IS DISTINCT FROM v_new_type_id);

  IF NOT v_changed THEN
    RETURN jsonb_build_object(
      'changed',             FALSE,
      'previous_status',     v_old_status,
      'new_status',          v_new_status,
      'previous_ticket_id',  v_old_ticket_id,
      'new_ticket_id',       v_old_ticket_id
    );
  END IF;

  -- ---------------------------------------------------------------
  -- (d) Detach: clear classification + ticket link on email_messages.
  -- ---------------------------------------------------------------
  UPDATE store_mgmt.email_messages
     SET classification_result = p_new_classification,
         classification_status = v_new_status,
         ticket_id             = NULL,
         processed_at          = v_now,
         error_message         = p_new_classification->>'error_message'
   WHERE id = p_email_message_id;

  -- ---------------------------------------------------------------
  -- (e) Attach: if new classification is ticketable, find/create
  -- target ticket and re-link email_messages. v_new_ticket_id is
  -- resolved here so the audit INSERTs below can carry it.
  -- ---------------------------------------------------------------
  IF v_new_is_ticketable THEN
    SELECT store_mgmt.find_or_create_ticket_tx(
      p_new_classification,
      p_email_message_id
    ) INTO v_subresult;

    v_new_ticket_id := (v_subresult->>'ticket_id')::UUID;

    UPDATE store_mgmt.email_messages
       SET ticket_id = v_new_ticket_id
     WHERE id = p_email_message_id;
  END IF;

  -- ---------------------------------------------------------------
  -- (f) Audit on old ticket (if any): STATE_CHANGE 'reclassify_out'.
  -- Now carries `to_ticket_id` because (e) ran first.
  -- ---------------------------------------------------------------
  IF v_old_ticket_id IS NOT NULL THEN
    PERFORM 1
      FROM store_mgmt.tickets
     WHERE id = v_old_ticket_id
     FOR UPDATE;

    INSERT INTO store_mgmt.ticket_entries (
      ticket_id, entry_type, author_user_id, email_message_id, metadata
    ) VALUES (
      v_old_ticket_id,
      'STATE_CHANGE',
      p_actor_id,
      p_email_message_id,
      jsonb_build_object(
        'type',          'reclassify_out',
        'from_status',   v_old_status,
        'to_status',     v_new_status,
        'from_app_id',   v_old_app_id,
        'from_type_id',  v_old_type_id,
        'to_app_id',     v_new_app_id,
        'to_type_id',    v_new_type_id,
        'to_ticket_id',  v_new_ticket_id
      )
    );
  END IF;

  -- ---------------------------------------------------------------
  -- (g) Audit on new ticket: STATE_CHANGE 'reclassify_in'.
  -- Skipped when destination is non-ticketable (DROPPED/ERROR), or
  -- when the destination ticket equals the source (no boundary
  -- crossed — the source-side `reclassify_out` already records the
  -- classification change).
  -- ---------------------------------------------------------------
  IF v_new_is_ticketable
     AND v_new_ticket_id IS NOT NULL
     AND v_new_ticket_id IS DISTINCT FROM v_old_ticket_id
  THEN
    PERFORM 1
      FROM store_mgmt.tickets
     WHERE id = v_new_ticket_id
     FOR UPDATE;

    INSERT INTO store_mgmt.ticket_entries (
      ticket_id, entry_type, author_user_id, email_message_id, metadata
    ) VALUES (
      v_new_ticket_id,
      'STATE_CHANGE',
      p_actor_id,
      p_email_message_id,
      jsonb_build_object(
        'type',           'reclassify_in',
        'from_status',    v_old_status,
        'to_status',      v_new_status,
        'from_app_id',    v_old_app_id,
        'from_type_id',   v_old_type_id,
        'to_app_id',      v_new_app_id,
        'to_type_id',     v_new_type_id,
        'from_ticket_id', v_old_ticket_id
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'changed',             TRUE,
    'previous_status',     v_old_status,
    'new_status',          v_new_status,
    'previous_ticket_id',  v_old_ticket_id,
    'new_ticket_id',       v_new_ticket_id
  );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.reclassify_email_tx(UUID, JSONB, UUID) IS
  'PR-20 reclassify with audit symmetry. Atomic detach-from-old-ticket + re-classify + attach-to-new-ticket, with STATE_CHANGE reclassify_out on source AND reclassify_in on destination. Reuses find_or_create_ticket_tx for the attach side. See docs/store-submissions/04-ticket-engine.md §5.2.';

GRANT EXECUTE ON FUNCTION store_mgmt.reclassify_email_tx(UUID, JSONB, UUID)
  TO service_role;

-- ============================================================
-- END — 20260504000003_store_mgmt_reclassify_in_audit
-- ============================================================
