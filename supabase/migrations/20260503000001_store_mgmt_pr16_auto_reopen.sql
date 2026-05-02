-- ============================================================
-- Migration: Store Management — PR-16b.3 auto-reopen branch
--                                  trong find_or_create_ticket_tx
--
-- CREATE OR REPLACE find_or_create_ticket_tx (PR-16a.2 baseline)
-- adding the auto-reopen pre-LOOP branch (Q2.D + Q3.B): when a
-- REJECTED email arrives for an app+type+platform whose latest
-- ticket was auto-DONE'd (system-origin auto_mark_done STATE_CHANGE),
-- reopen that ticket trong state=IN_REVIEW instead of creating a
-- duplicate fresh ticket.
--
-- Trigger condition (Q2.D):
--   v_status = 'CLASSIFIED'
--   AND v_outcome = 'REJECTED'
--   AND a state='DONE' ticket exists trong same grouping key whose
--       latest STATE_CHANGE metadata has actor='system'
--       AND reason LIKE 'auto_mark_done%'
--
-- Effect:
--   * UPDATE the matched DONE ticket: state='IN_REVIEW',
--     latest_outcome='REJECTED', closed_at=NULL, resolution_type=NULL.
--     Invariant #6 holds (terminal-state ↔ closed_at IS NOT NULL).
--   * Write EMAIL entry idempotently (ON CONFLICT no-op cho cron retry).
--   * Write STATE_CHANGE entry: from='DONE', to='IN_REVIEW',
--     actor='system', reason='auto_reopen_rejected'.
--   * RETURN early skipping the standard find/insert LOOP.
--
-- Detection mechanism (latest STATE_CHANGE = system auto_mark_done):
--   - Distinguishes auto-DONE'd tickets từ Manager-marked-DONE
--     (Manager actions write actor=manager_uuid).
--   - Excludes auto-DONE tickets that Manager has since manually
--     re-touched (the Manager's STATE_CHANGE becomes the latest →
--     auto-reopen check fails → falls through to standard LOOP →
--     creates fresh ticket trong open state).
--   - Uses idx_store_mgmt_ticket_entries_ticket_created (ticket_id,
--     created_at DESC) cho O(log N) per-ticket subquery.
--
-- Reclassify path (Q6.B style inheritance): reclassify_email_tx
-- invokes find_or_create_ticket_tx, so the auto-reopen branch fires
-- automatically khi Manager reclassifies an email and the new
-- classification produces REJECTED outcome cho a grouping key whose
-- latest ticket was auto-DONE'd. No reclassify RPC change needed.
--
-- Idempotency caveat (carries forward từ PR-16a.2 header):
--   Auto-reopen UPDATE flips DONE → IN_REVIEW. The reopened ticket is
--   now trong open state, covered by idx_store_mgmt_tickets_open_unique.
--   A second findOrCreateTicket call cho the same email_message_id
--   would match the standard LOOP (now finds the IN_REVIEW ticket).
--   EMAIL entry idempotency via ON CONFLICT prevents duplicate event
--   log rows. Net: auto-reopen path is idempotent under retry.
--
-- Backward compat: when no DONE ticket matches (or match exists but
-- latest STATE_CHANGE is not system auto_mark_done), v_auto_reopen_target
-- stays NULL and behavior reverts to PR-16a.2 baseline.
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

  -- PR-16b auto-reopen
  v_auto_reopen_target  UUID;
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

  BEGIN
    v_subject_pattern_id := NULLIF(p_classification->>'subject_pattern_id', '')::UUID;
  EXCEPTION WHEN invalid_text_representation OR others THEN
    v_subject_pattern_id := NULL;
  END;

  -- PR-16a (Q5.D + Q6.A): auto-DONE eligibility check.
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
  -- (b.5) PR-16b auto-reopen pre-LOOP branch (Q2.D + Q3.B)
  -- ---------------------------------------------------------------
  -- Runs only on REJECTED outcome cho ticketable status. UNCLASSIFIED
  -- statuses don't qualify because Q5.D + Q6.A guarantee auto-DONE
  -- only fires on CLASSIFIED rows — looking cho an auto-DONE'd
  -- UNCLASSIFIED ticket would never match.
  IF v_status = 'CLASSIFIED' AND v_outcome = 'REJECTED' THEN
    SELECT t.id
      INTO v_auto_reopen_target
      FROM store_mgmt.tickets t
     WHERE t.platform_id = v_platform_id
       AND t.app_id = v_app_id
       AND t.type_id = v_type_id
       AND t.state = 'DONE'
       AND EXISTS (
         SELECT 1 FROM (
           SELECT e.metadata
             FROM store_mgmt.ticket_entries e
            WHERE e.ticket_id = t.id
              AND e.entry_type = 'STATE_CHANGE'
            ORDER BY e.created_at DESC
            LIMIT 1
         ) latest
         WHERE latest.metadata->>'actor' = 'system'
           AND latest.metadata->>'reason' LIKE 'auto_mark_done%'
       )
     ORDER BY t.closed_at DESC
     LIMIT 1
     FOR UPDATE;

    IF v_auto_reopen_target IS NOT NULL THEN
      UPDATE store_mgmt.tickets
         SET state           = 'IN_REVIEW',
             latest_outcome  = 'REJECTED',
             closed_at       = NULL,
             resolution_type = NULL,
             updated_at      = v_now
       WHERE id = v_auto_reopen_target
       RETURNING * INTO v_ticket;

      -- EMAIL entry idempotent via partial unique index.
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

      -- STATE_CHANGE entry với system actor + reopen reason.
      INSERT INTO store_mgmt.ticket_entries (
        ticket_id, entry_type, author_user_id, metadata
      ) VALUES (
        v_ticket.id,
        'STATE_CHANGE',
        NULL,
        jsonb_build_object(
          'from',              'DONE',
          'to',                'IN_REVIEW',
          'trigger',           'email',
          'email_message_id',  p_email_message_id,
          'actor',             'system',
          'reason',            'auto_reopen_rejected'
        )
      );

      -- Skip standard LOOP — return reopened ticket.
      RETURN jsonb_build_object(
        'ticket_id',       v_ticket.id,
        'created',         FALSE,
        'previous_state',  'DONE',
        'new_state',       'IN_REVIEW',
        'state_changed',   TRUE,
        'ticket',          to_jsonb(v_ticket)
      );
    END IF;
  END IF;

  -- ---------------------------------------------------------------
  -- (c) Find-or-create với race loop (PR-9 baseline preserved)
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
    v_state_changed := FALSE;
  ELSE
    v_previous_state := v_existing.state;

    IF v_existing.state = 'NEW' THEN
      v_new_state := 'NEW';
    ELSIF v_outcome IS NULL THEN
      v_new_state := v_existing.state;
    ELSE
      v_new_state := v_outcome;
    END IF;

    IF v_auto_done THEN
      v_new_state := 'DONE';
    END IF;

    v_state_changed := (v_new_state <> v_previous_state);

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
  'PR-9 ticket engine + PR-16a auto-mark-done + PR-16b auto-reopen branches. CLASSIFIED + APPROVED + auto_done_eligible → DONE. CLASSIFIED + REJECTED + auto-DONE origin DONE ticket → IN_REVIEW (Q2.D auto-reopen). Audit via ticket_entries.metadata {actor, reason, subject_pattern_id}.';

GRANT EXECUTE ON FUNCTION store_mgmt.find_or_create_ticket_tx(JSONB, UUID)
  TO service_role;

-- ============================================================
-- END — 20260503000001_store_mgmt_pr16_auto_reopen
-- ============================================================
