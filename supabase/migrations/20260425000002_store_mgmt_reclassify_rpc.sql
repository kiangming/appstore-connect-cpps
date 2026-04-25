-- ============================================================
-- Migration: Store Management — Reclassify Email RPC (PR-11.5)
--
-- Atomically swap an `email_messages` row's classification + ticket
-- association after a Manager (or Manager-triggered bulk action) has
-- re-run the TS classifier on its persisted body + extracted_payload.
--
-- Why a dedicated RPC instead of inline UPDATEs from the Server Action:
--   1. Two writes (email_messages.classification_result + email_messages.
--      ticket_id) plus optional ticket_entries INSERT plus optional
--      `find_or_create_ticket_tx` invocation must complete atomically.
--      A crash mid-sequence would leave the email FK-pointing at a
--      different ticket than its classification implies.
--   2. `FOR UPDATE` lock on the email row serializes against concurrent
--      Gmail sync runs that might process a duplicate mid-reclassify.
--   3. PR-11.5 reuses `find_or_create_ticket_tx` (PR-9) for the
--      attach side — calling it from within the same transaction
--      preserves its own contract (partial unique index race fallback,
--      EMAIL entry idempotency).
--
-- Scope (this migration):
--   1. `reclassify_email_tx(email_id, new_classification, actor_id)`
--
-- NOT in scope: ticket-level reclassify per spec §5.2 (move all emails
-- of a ticket via Manager UI). That's a separate concern; PR-11.5
-- targets EMAIL-level reclassify (re-run classifier on a stored row,
-- swap its ticket if the new classification points elsewhere).
--
-- Lock order:
--   email_messages row (FOR UPDATE) → old ticket (FOR UPDATE if attached)
--   → find_or_create_ticket_tx internals (manage their own locks).
--
-- Spec authority:
--   - 04-ticket-engine.md §5.2 (reclassify semantics — adapted to email-level)
--   - 04-ticket-engine.md §3.1-3.2 (transactional flow, FOR UPDATE)
--   - CLAUDE.md invariant #1 (one open ticket per key — preserved via
--     find_or_create_ticket_tx)
--   - CLAUDE.md invariant #2 (event log append-only — STATE_CHANGE
--     entry on old ticket records the move, not destructive)
--
-- Error contract (RAISE EXCEPTION prefixes, matched by TypeScript caller):
--   NOT_FOUND     — email_message_id does not exist
--   INVALID_ARG   — malformed new_classification JSONB
--   (find_or_create_ticket_tx errors propagate verbatim)
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

  -- Defensive UUID parsing: classification_result can carry NULL/empty
  -- values for app_id/type_id depending on the classifier branch (e.g.
  -- UNCLASSIFIED_APP omits app_id). NULLIF + ::UUID returns NULL cleanly.
  BEGIN
    v_old_app_id  := NULLIF(v_old_classification->>'app_id', '')::UUID;
    v_old_type_id := NULLIF(v_old_classification->>'type_id', '')::UUID;
  EXCEPTION WHEN invalid_text_representation OR others THEN
    -- Stored shape is malformed (shouldn't happen — classifier writes it).
    -- Treat as null so reclassify can proceed instead of getting wedged.
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
  -- Status + grouping key all match → email already in correct bucket.
  -- Caller (Server Action) typically pre-checks this and skips the RPC,
  -- but the RPC re-checks under FOR UPDATE so concurrent sync writes
  -- can't race past the comparison.
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
  -- The ticket_id is set NULL up-front so find_or_create_ticket_tx
  -- (called below for ticketable new statuses) sees a clean slate.
  -- The previous ticket's EMAIL ticket_entries row is left in place
  -- as audit history (event log is append-only, invariant #2).
  -- ---------------------------------------------------------------
  UPDATE store_mgmt.email_messages
     SET classification_result = p_new_classification,
         classification_status = v_new_status,
         ticket_id             = NULL,
         processed_at          = v_now,
         error_message         = p_new_classification->>'error_message'
   WHERE id = p_email_message_id;

  -- ---------------------------------------------------------------
  -- (e) Audit on old ticket (if any): STATE_CHANGE 'reclassify_out'.
  -- Records the move with from→to status + actor. Visible in the old
  -- ticket's timeline so observers see why an email "left" the bucket.
  -- ---------------------------------------------------------------
  IF v_old_ticket_id IS NOT NULL THEN
    -- FOR UPDATE on old ticket prevents concurrent state machine writes
    -- from interleaving (e.g. a Manager archiving the bucket exactly as
    -- we reclassify out). Cheap lock — held only for the INSERT below.
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
        'type',         'reclassify_out',
        'from_status',  v_old_status,
        'to_status',    v_new_status,
        'from_app_id',  v_old_app_id,
        'from_type_id', v_old_type_id,
        'to_app_id',    v_new_app_id,
        'to_type_id',   v_new_type_id
      )
    );
  END IF;

  -- ---------------------------------------------------------------
  -- (f) Attach: if new classification is ticketable, find/create
  -- target ticket and re-link email_messages. Reuses the PR-9 RPC
  -- which handles grouping-key uniqueness, EMAIL entry idempotency,
  -- and state derivation per spec §3.
  --
  -- Non-ticketable (DROPPED/ERROR) → email stays detached.
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
  'PR-11.5 manual/bulk email reclassify. Atomic detach-from-old-ticket + re-classify + attach-to-new-ticket. Reuses find_or_create_ticket_tx for the attach side. See docs/store-submissions/04-ticket-engine.md §5.2 (adapted to email-level).';

GRANT EXECUTE ON FUNCTION store_mgmt.reclassify_email_tx(UUID, JSONB, UUID)
  TO service_role;

-- ============================================================
-- END — 20260425000002_store_mgmt_reclassify_rpc
-- ============================================================
