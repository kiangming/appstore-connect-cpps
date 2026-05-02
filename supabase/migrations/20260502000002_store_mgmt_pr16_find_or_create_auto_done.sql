-- ============================================================
-- Migration: Store Management — PR-16a.2 auto-mark-done branch
--                                  trong find_or_create_ticket_tx
--
-- CREATE OR REPLACE find_or_create_ticket_tx (PR-9 ticket engine)
-- with the auto-DONE branch enabled by PR-16a.1
-- (subject_patterns.auto_done_eligible) and PR-16a.3 (TS classifier
-- propagating subject_pattern_id top-level into the classification
-- JSONB).
--
-- Trigger condition (Q5.D + Q6.A):
--   v_status = 'CLASSIFIED'
--   AND v_outcome = 'APPROVED'
--   AND p_classification->>'subject_pattern_id' resolves to a row
--       với auto_done_eligible = TRUE
--
-- Effect:
--   * CREATE path — ticket born directly trong DONE state với
--     closed_at = NOW(), resolution_type = 'DONE'.
--   * UPDATE path — open ticket (NEW/IN_REVIEW/REJECTED) flips to DONE.
--     Already-closed tickets (state=APPROVED/DONE/ARCHIVED) are not
--     re-touched (no double-transition).
--   * STATE_CHANGE entry written tracking the transition. Special
--     create-time entry (Decision 4): from = NULL, reason =
--     'auto_mark_done_initial'. Update-time entry: from = previous,
--     reason = 'auto_mark_done_post_reclassify' (any non-create
--     auto-DONE arrives via the reclassify path per Q6.B inheritance).
--
-- Audit trail trong ticket_entries.metadata (Decision 1+2):
--   actor              = 'system'
--   reason             = 'auto_mark_done_initial' | 'auto_mark_done_post_reclassify'
--   subject_pattern_id = uuid of the pattern that triggered (text)
--
-- Reclassify path (Q6.B free): reclassify_email_tx invokes this RPC,
-- so retroactive auto-DONE upon Manager reclassify-to-CLASSIFIED with
-- APPROVED outcome happens automatically. PR-15.5 stale-EMAIL filter
-- is read-time only (lib/store-submissions/queries/tickets.ts) and
-- unaffected.
--
-- Backward compat: when classification JSONB lacks subject_pattern_id
-- (old code paths or tests), v_subject_pattern_id resolves to NULL,
-- v_auto_done stays FALSE, behavior identical to pre-PR-16.
-- ============================================================

CREATE OR REPLACE FUNCTION store_mgmt.find_or_create_ticket_tx(
  p_classification    JSONB,
  p_email_message_id  UUID
) RETURNS JSONB AS $$
DECLARE
  -- Extracted from p_classification
  v_status              TEXT;
  v_platform_id         UUID;
  v_app_id              UUID;
  v_type_id             UUID;
  v_outcome             TEXT;
  v_submission_id       TEXT;
  v_type_payload        JSONB;
  v_subject_pattern_id  UUID;

  -- Email snapshot
  v_email_subject   TEXT;
  v_sender_email    TEXT;
  v_sender_name     TEXT;
  v_received_at     TIMESTAMPTZ;
  v_body_text       TEXT;
  v_email_snapshot  JSONB;

  -- Mutable state
  v_existing            store_mgmt.tickets%ROWTYPE;
  v_ticket              store_mgmt.tickets%ROWTYPE;
  v_previous_state      TEXT;
  v_new_state           TEXT;
  v_state_changed       BOOLEAN := FALSE;
  v_created             BOOLEAN := FALSE;
  v_payload_added       BOOLEAN := FALSE;
  v_new_payloads        JSONB;
  v_new_sub_ids         TEXT[];
  v_now                 TIMESTAMPTZ := NOW();

  -- PR-16 auto-DONE
  v_pattern_eligible    BOOLEAN;
  v_auto_done           BOOLEAN := FALSE;
  v_state_change_meta   JSONB;
BEGIN
  -- ---------------------------------------------------------------
  -- (a) Validate + extract classification fields
  -- ---------------------------------------------------------------
  v_status := p_classification->>'status';
  IF v_status IS NULL OR v_status NOT IN (
    'CLASSIFIED', 'UNCLASSIFIED_APP', 'UNCLASSIFIED_TYPE'
  ) THEN
    RAISE EXCEPTION 'INVALID_STATUS: classification.status must be ticketable (got %)',
      COALESCE(v_status, '<null>');
  END IF;

  BEGIN
    v_platform_id := (p_classification->>'platform_id')::UUID;
  EXCEPTION WHEN invalid_text_representation OR others THEN
    RAISE EXCEPTION 'INVALID_ARG: classification.platform_id must be UUID';
  END;
  IF v_platform_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARG: classification.platform_id required';
  END IF;

  IF p_classification ? 'app_id' AND (p_classification->>'app_id') IS NOT NULL THEN
    BEGIN
      v_app_id := (p_classification->>'app_id')::UUID;
    EXCEPTION WHEN invalid_text_representation OR others THEN
      RAISE EXCEPTION 'INVALID_ARG: classification.app_id must be UUID';
    END;
  END IF;

  IF v_status = 'CLASSIFIED' THEN
    BEGIN
      v_type_id := (p_classification->>'type_id')::UUID;
    EXCEPTION WHEN invalid_text_representation OR others THEN
      RAISE EXCEPTION 'INVALID_ARG: classification.type_id must be UUID for CLASSIFIED';
    END;
    IF v_type_id IS NULL THEN
      RAISE EXCEPTION 'INVALID_ARG: classification.type_id required for CLASSIFIED';
    END IF;
  END IF;

  v_outcome := p_classification->>'outcome';
  IF v_outcome IS NOT NULL AND v_outcome NOT IN ('IN_REVIEW', 'REJECTED', 'APPROVED') THEN
    RAISE EXCEPTION 'INVALID_OUTCOME: classification.outcome must be IN_REVIEW/REJECTED/APPROVED (got %)',
      v_outcome;
  END IF;

  IF v_status = 'CLASSIFIED' THEN
    v_submission_id := NULLIF(p_classification->>'submission_id', '');
    IF p_classification ? 'type_payload' THEN
      v_type_payload := p_classification->'type_payload';
      IF jsonb_typeof(v_type_payload) = 'null'
         OR v_type_payload = '{}'::jsonb THEN
        v_type_payload := NULL;
      END IF;
    END IF;
  END IF;

  -- PR-16: extract subject_pattern_id (defensive — missing/null keeps
  -- v_subject_pattern_id = NULL → v_auto_done stays FALSE → pre-PR-16
  -- behavior preserved.)
  BEGIN
    v_subject_pattern_id := NULLIF(p_classification->>'subject_pattern_id', '')::UUID;
  EXCEPTION WHEN invalid_text_representation OR others THEN
    v_subject_pattern_id := NULL;
  END;

  -- PR-16 (Q5.D + Q6.A): auto-DONE eligibility check.
  -- Only CLASSIFIED + APPROVED + Manager-flagged pattern triggers.
  IF v_status = 'CLASSIFIED'
     AND v_outcome = 'APPROVED'
     AND v_subject_pattern_id IS NOT NULL THEN
    SELECT auto_done_eligible
      INTO v_pattern_eligible
      FROM store_mgmt.subject_patterns
     WHERE id = v_subject_pattern_id;

    v_auto_done := COALESCE(v_pattern_eligible, FALSE);
  END IF;

  -- ---------------------------------------------------------------
  -- (b) Load email snapshot
  -- ---------------------------------------------------------------
  SELECT subject, sender_email, sender_name, received_at, raw_body_text
    INTO v_email_subject, v_sender_email, v_sender_name, v_received_at, v_body_text
    FROM store_mgmt.email_messages
    WHERE id = p_email_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: email_message % does not exist', p_email_message_id;
  END IF;

  v_email_snapshot := jsonb_build_object(
    'subject',     v_email_subject,
    'sender',      v_sender_email,
    'sender_name', v_sender_name,
    'received_at', to_char(v_received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'body_excerpt', LEFT(COALESCE(v_body_text, ''), 500)
  );

  -- ---------------------------------------------------------------
  -- (c) Find-or-create với race loop
  -- ---------------------------------------------------------------
  FOR i IN 1..3 LOOP
    SELECT *
      INTO v_existing
      FROM store_mgmt.tickets
      WHERE
        platform_id = v_platform_id
        AND (
          (v_app_id IS NULL AND app_id IS NULL)
          OR app_id = v_app_id
        )
        AND (
          (v_type_id IS NULL AND type_id IS NULL)
          OR type_id = v_type_id
        )
        AND state IN ('NEW', 'IN_REVIEW', 'REJECTED')
      FOR UPDATE;

    IF FOUND THEN
      v_ticket := v_existing;
      v_created := FALSE;
      EXIT;
    END IF;

    -- No open ticket; try to create. PR-16: when v_auto_done, born
    -- directly trong DONE state (skip Open queue) với terminal-state
    -- fields populated atomically per invariant #6.
    BEGIN
      INSERT INTO store_mgmt.tickets (
        app_id, platform_id, type_id, state,
        latest_outcome, type_payloads, submission_ids,
        priority, opened_at,
        closed_at, resolution_type
      ) VALUES (
        v_app_id, v_platform_id, v_type_id,
        CASE WHEN v_auto_done THEN 'DONE' ELSE 'NEW' END,
        v_outcome,
        CASE
          WHEN v_type_payload IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
            'payload', v_type_payload,
            'first_seen_at', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ))
          ELSE '[]'::jsonb
        END,
        CASE
          WHEN v_submission_id IS NOT NULL THEN ARRAY[v_submission_id]
          ELSE ARRAY[]::TEXT[]
        END,
        'NORMAL',
        v_now,
        CASE WHEN v_auto_done THEN v_now ELSE NULL END,
        CASE WHEN v_auto_done THEN 'DONE' ELSE NULL END
      )
      RETURNING * INTO v_ticket;

      v_created := TRUE;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      CONTINUE;
    END;
  END LOOP;

  IF v_ticket.id IS NULL THEN
    RAISE EXCEPTION 'CONCURRENT_RACE_UNEXPECTED: find-or-create did not converge in 3 iterations for (app=%, type=%, platform=%)',
      v_app_id, v_type_id, v_platform_id;
  END IF;

  -- ---------------------------------------------------------------
  -- (d) UPDATE path — derive state + mutate row
  -- ---------------------------------------------------------------
  IF v_created THEN
    v_previous_state := NULL;
    v_new_state := CASE WHEN v_auto_done THEN 'DONE' ELSE 'NEW' END;
    -- Decision 4 (PR-16): create-time auto-DONE warrants STATE_CHANGE
    -- entry for audit trail completeness even though there's no prior
    -- state. We surface it via the create-side guard below — keep
    -- v_state_changed FALSE here so the existing branch logic
    -- (skip on create) stays untouched.
    v_state_changed := FALSE;
  ELSE
    v_previous_state := v_existing.state;

    -- Spec §4.1 — deriveStateFromEmailOnOpenTicket
    IF v_existing.state = 'NEW' THEN
      v_new_state := 'NEW';
    ELSIF v_outcome IS NULL THEN
      v_new_state := v_existing.state;
    ELSE
      v_new_state := v_outcome;
    END IF;

    -- PR-16 (Q5.D + Q6.A + Q6.B): override to DONE when eligible.
    -- Guarded against double-DONE because we already require the row
    -- to be trong an open state (find-or-create LOOP only matches
    -- NEW/IN_REVIEW/REJECTED — closed tickets aren't selected).
    IF v_auto_done THEN
      v_new_state := 'DONE';
    END IF;

    v_state_changed := (v_new_state <> v_previous_state);

    -- Type payload novelty (§3.4)
    IF v_type_payload IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_existing.type_payloads) AS elem
        WHERE elem->'payload' = v_type_payload
      ) THEN
        v_payload_added := TRUE;
      END IF;
    END IF;

    v_new_payloads := v_existing.type_payloads;
    IF v_payload_added THEN
      v_new_payloads := v_new_payloads || jsonb_build_array(jsonb_build_object(
        'payload', v_type_payload,
        'first_seen_at', to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ));
    END IF;

    v_new_sub_ids := v_existing.submission_ids;
    IF v_submission_id IS NOT NULL AND NOT (v_submission_id = ANY(v_new_sub_ids)) THEN
      v_new_sub_ids := array_append(v_new_sub_ids, v_submission_id);
    END IF;

    -- Apply update. Three terminal-state branches; rest stays open.
    -- Invariant #6: terminal state ↔ closed_at IS NOT NULL ↔
    -- resolution_type IS NOT NULL.
    IF v_new_state = 'DONE' THEN
      UPDATE store_mgmt.tickets
        SET state = v_new_state,
            latest_outcome = v_outcome,
            type_payloads = v_new_payloads,
            submission_ids = v_new_sub_ids,
            closed_at = v_now,
            resolution_type = 'DONE',
            updated_at = v_now
      WHERE id = v_existing.id
      RETURNING * INTO v_ticket;
    ELSIF v_new_state = 'APPROVED' THEN
      UPDATE store_mgmt.tickets
        SET state = v_new_state,
            latest_outcome = v_outcome,
            type_payloads = v_new_payloads,
            submission_ids = v_new_sub_ids,
            closed_at = v_now,
            resolution_type = 'APPROVED',
            updated_at = v_now
      WHERE id = v_existing.id
      RETURNING * INTO v_ticket;
    ELSE
      UPDATE store_mgmt.tickets
        SET state = v_new_state,
            latest_outcome = v_outcome,
            type_payloads = v_new_payloads,
            submission_ids = v_new_sub_ids,
            updated_at = v_now
      WHERE id = v_existing.id
      RETURNING * INTO v_ticket;
    END IF;
  END IF;

  -- ---------------------------------------------------------------
  -- (e) Write event log entries
  -- ---------------------------------------------------------------

  -- EMAIL entry — idempotent via partial unique index (unchanged).
  INSERT INTO store_mgmt.ticket_entries (
    ticket_id, entry_type, author_user_id, email_message_id, metadata
  ) VALUES (
    v_ticket.id,
    'EMAIL',
    NULL,
    p_email_message_id,
    jsonb_build_object(
      'email_snapshot',         v_email_snapshot,
      'outcome',                v_outcome,
      'classification_status',  v_status
    )
  )
  ON CONFLICT (ticket_id, email_message_id) WHERE entry_type = 'EMAIL'
  DO NOTHING;

  -- STATE_CHANGE entry. PR-16 special-cases auto-DONE creates so the
  -- audit trail surfaces the transition (Decision 4 trong design notes).
  IF v_state_changed OR (v_created AND v_auto_done) THEN
    v_state_change_meta := jsonb_build_object(
      'from',              CASE WHEN v_created THEN NULL ELSE v_previous_state END,
      'to',                v_new_state,
      'trigger',           'email',
      'email_message_id',  p_email_message_id
    );

    IF v_auto_done THEN
      v_state_change_meta := v_state_change_meta || jsonb_build_object(
        'actor',              'system',
        'reason',             CASE WHEN v_created
                                THEN 'auto_mark_done_initial'
                                ELSE 'auto_mark_done_post_reclassify'
                              END,
        'subject_pattern_id', v_subject_pattern_id::TEXT
      );
    END IF;

    INSERT INTO store_mgmt.ticket_entries (
      ticket_id, entry_type, author_user_id, metadata
    ) VALUES (
      v_ticket.id,
      'STATE_CHANGE',
      NULL,
      v_state_change_meta
    );
  END IF;

  -- PAYLOAD_ADDED entry — only when novel type_payload was appended.
  IF v_payload_added THEN
    INSERT INTO store_mgmt.ticket_entries (
      ticket_id, entry_type, author_user_id, metadata
    ) VALUES (
      v_ticket.id,
      'PAYLOAD_ADDED',
      NULL,
      jsonb_build_object('payload', v_type_payload)
    );
  END IF;

  -- ---------------------------------------------------------------
  -- (f) Return shape matching FindOrCreateTicketOutput.
  -- For auto-DONE creates, we report previous_state=NULL +
  -- state_changed=TRUE so consumers (UI, telemetry) see the implicit
  -- transition. This is a small contract refinement; existing readers
  -- check `created` first and don't depend on state_changed=FALSE for
  -- creates.
  -- ---------------------------------------------------------------
  RETURN jsonb_build_object(
    'ticket_id',       v_ticket.id,
    'created',         v_created,
    'previous_state',  v_previous_state,
    'new_state',       v_ticket.state,
    'state_changed',   v_state_changed OR (v_created AND v_auto_done),
    'ticket',          to_jsonb(v_ticket)
  );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.find_or_create_ticket_tx(JSONB, UUID) IS
  'PR-9 ticket engine + PR-16 auto-mark-done branch. CLASSIFIED + APPROVED + subject_pattern.auto_done_eligible=TRUE → ticket lands trong DONE (skip Open queue). audit via ticket_entries.metadata {actor, reason, subject_pattern_id}.';

GRANT EXECUTE ON FUNCTION store_mgmt.find_or_create_ticket_tx(JSONB, UUID)
  TO service_role;

-- ============================================================
-- END — 20260502000002_store_mgmt_pr16_find_or_create_auto_done
-- ============================================================
