-- ============================================================
-- Migration: PR-Inbox.X — APPROVED becomes intermediate Manager
--            workflow state (Pattern 10 reuse #17)
--
-- Manager UAT MV17 Issue 4 fix. Two-concept naming collision
-- crystallized:
--   state=APPROVED       = Manager workflow action (intermediate)
--   latest_outcome=APPROVED = Apple email signal (verdict)
--
-- Pre-PR-Inbox.X reality:
--   state IN ('APPROVED', 'DONE', 'ARCHIVED') was treated as
--   terminal (closed_at NOT NULL, resolution_type NOT NULL — old
--   CLAUDE.md invariant #6). state=APPROVED rows had no path back
--   to DONE — Manager workflow blocked.
--
-- Post-PR-Inbox.X reality:
--   state='APPROVED' is intermediate Manager workflow state with
--   closed_at OPTIONAL. Manager clicks "Mark Done" to transition
--   APPROVED → DONE. Only DONE/ARCHIVED remain strictly terminal.
--
-- Backward compat:
--   Reports surface (latest_outcome predicate) unaffected — Pattern
--   10 two-surface separation strict (PR-21 origin).
--   Avg review time predicate preserved (latest_outcome='APPROVED'
--   AND closed_at IS NOT NULL) — intermediate APPROVED tickets
--   correctly excluded from end-to-end completion duration.
--   find_or_create auto-DONE path (PR-16a) unchanged — when
--   subject_patterns.auto_done_eligible=TRUE, ticket goes NEW→DONE
--   skipping APPROVED (forward fix preserved).
--
-- Legacy backfill (Q-Issue4-1 production diagnostic 2026-05-09):
--   2 stuck APPROVED tickets predate the auto_done_eligible flip:
--     - TICKET-10001 (Roblox VN)
--     - TICKET-10012 (Chơi Ngay Game Vui Vẻ VNG)
--   Both have closed_at + resolution_type='APPROVED' set under old
--   invariant. Backfilled to state='DONE' here (preserve closed_at,
--   set resolution_type='DONE') — Manager already moved on; closed
--   in April. Forward fix (auto_done_eligible=TRUE on Apple APPROVED
--   pattern) prevents new stuck tickets.
--
-- 3 RPCs updated via CREATE OR REPLACE to drop closed_at writes on
-- APPROVED branches:
--   1. follow_up_ticket_tx — collapses v_is_terminal branch (was
--      atomic-set closed_at when landing APPROVED; now stays open)
--   2. mark_done_ticket_tx — accepts APPROVED in source state guard
--   3. find_or_create_ticket_tx — APPROVED branch merged with ELSE
--      (no closed_at write)
--
-- Forward-only per CLAUDE.md rule #7. Revert = new migration that
-- re-tightens CHECK + restores closed_at writes on APPROVED.
-- ============================================================

-- ============================================================
-- 1. Schema: drop OLD CHECK constraints first (so backfill UPDATE
--           doesn't violate them, and so new CHECK can be added
--           after backfill clears the legacy violators)
-- ============================================================
-- The init migration named these CHECK constraints implicitly.
-- We query pg_constraint to find them by their CHECK clause shape.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
     WHERE nsp.nspname = 'store_mgmt'
       AND cls.relname = 'tickets'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE
           '%state IN (''APPROVED'', ''DONE'', ''ARCHIVED'')%'
  LOOP
    EXECUTE format(
      'ALTER TABLE store_mgmt.tickets DROP CONSTRAINT %I', r.conname
    );
  END LOOP;
END $$;

-- ============================================================
-- 2. Backfill: 2 stuck-APPROVED legacy tickets → DONE
-- ============================================================
-- Order matters: must run BEFORE the new CHECK is added, since the
-- existing 2 stuck rows have state='APPROVED' AND closed_at IS NOT
-- NULL — that's compatible with the OLD CHECK but VIOLATES the NEW
-- CHECK we're about to add.
--
-- CTE captures the row IDs from the UPDATE so the audit trail
-- INSERT can scope precisely without time-window heuristics.
WITH backfilled AS (
  UPDATE store_mgmt.tickets
     SET state           = 'DONE',
         resolution_type = 'DONE',
         updated_at      = NOW()
   WHERE state = 'APPROVED'
     AND closed_at IS NOT NULL
   RETURNING id
)
INSERT INTO store_mgmt.ticket_entries (
  ticket_id, entry_type, author_user_id, metadata
)
SELECT
  b.id,
  'STATE_CHANGE',
  NULL,
  jsonb_build_object(
    'from',    'APPROVED',
    'to',      'DONE',
    'trigger', 'system_migration',
    'actor',   'system',
    'reason',  'pr_inbox_x_approved_intermediate_backfill',
    'note',    'Legacy stuck-APPROVED tickets backfilled to DONE post-Path-B invariant relaxation'
  )
  FROM backfilled b;

-- ============================================================
-- 3. Schema: add NEW CHECK constraints (only DONE/ARCHIVED terminal)
-- ============================================================
-- APPROVED is now intermediate Manager workflow state with closed_at
-- always NULL — landing on APPROVED via FOLLOW_UP / find_or_create
-- no longer sets closed_at. (Section 4 below updates those RPCs.)
ALTER TABLE store_mgmt.tickets
  ADD CONSTRAINT tickets_terminal_state_closed_at_check CHECK (
    (state IN ('DONE', 'ARCHIVED')) = (closed_at IS NOT NULL)
  );

ALTER TABLE store_mgmt.tickets
  ADD CONSTRAINT tickets_terminal_state_resolution_type_check CHECK (
    (state IN ('DONE', 'ARCHIVED')) = (resolution_type IS NOT NULL)
  );

-- ============================================================
-- 3. RPC: follow_up_ticket_tx — drop closed_at writes on APPROVED
-- ============================================================
-- Spec §4.2 unchanged: NEW → (latest_outcome ?? IN_REVIEW). Path B
-- delta: when latest_outcome='APPROVED', the target state is still
-- APPROVED but closed_at + resolution_type are NO LONGER set —
-- ticket lands intermediate, awaiting Manager Mark Done.
CREATE OR REPLACE FUNCTION store_mgmt.follow_up_ticket_tx(
  p_ticket_id      UUID,
  p_actor_user_id  UUID
) RETURNS JSONB AS $$
DECLARE
  v_ticket          store_mgmt.tickets%ROWTYPE;
  v_previous_state  TEXT;
  v_new_state       TEXT;
  v_entry_id        UUID;
  v_now             TIMESTAMPTZ := NOW();
BEGIN
  SELECT * INTO v_ticket
    FROM store_mgmt.tickets
    WHERE id = p_ticket_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: ticket % does not exist', p_ticket_id;
  END IF;

  v_previous_state := v_ticket.state;

  IF v_previous_state <> 'NEW' THEN
    RAISE EXCEPTION
      'INVALID_TRANSITION: cannot follow-up ticket in state % (NEW only)',
      v_previous_state;
  END IF;

  -- Spec §4.2: latestOutcome ?? IN_REVIEW.
  v_new_state := COALESCE(v_ticket.latest_outcome, 'IN_REVIEW');

  -- PR-Inbox.X: APPROVED is no longer terminal — single UPDATE branch
  -- handles all v_new_state values without setting closed_at /
  -- resolution_type. (DONE landing impossible from FOLLOW_UP per
  -- spec §4.2.)
  UPDATE store_mgmt.tickets
    SET state      = v_new_state,
        updated_at = v_now
    WHERE id = p_ticket_id;

  INSERT INTO store_mgmt.ticket_entries (
    ticket_id, entry_type, author_user_id, metadata, created_at
  ) VALUES (
    p_ticket_id,
    'STATE_CHANGE',
    p_actor_user_id,
    jsonb_build_object(
      'from',    v_previous_state,
      'to',      v_new_state,
      'trigger', 'user_action'
    ),
    v_now
  )
  RETURNING id INTO v_entry_id;

  RETURN jsonb_build_object(
    'ticket_id',      p_ticket_id,
    'previous_state', v_previous_state,
    'new_state',      v_new_state,
    'state_changed',  TRUE,
    'entry_id',       v_entry_id
  );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.follow_up_ticket_tx(UUID, UUID) IS
  'PR-10c user action: NEW → latest_outcome ?? IN_REVIEW. PR-Inbox.X: APPROVED landing no longer sets closed_at (intermediate Manager workflow state).';

-- ============================================================
-- 4. RPC: mark_done_ticket_tx — accept APPROVED in source guard
-- ============================================================
CREATE OR REPLACE FUNCTION store_mgmt.mark_done_ticket_tx(
  p_ticket_id      UUID,
  p_actor_user_id  UUID
) RETURNS JSONB AS $$
DECLARE
  v_ticket          store_mgmt.tickets%ROWTYPE;
  v_previous_state  TEXT;
  v_new_state       TEXT := 'DONE';
  v_entry_id        UUID;
  v_now             TIMESTAMPTZ := NOW();
BEGIN
  SELECT * INTO v_ticket
    FROM store_mgmt.tickets
    WHERE id = p_ticket_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: ticket % does not exist', p_ticket_id;
  END IF;

  v_previous_state := v_ticket.state;

  -- PR-Inbox.X: APPROVED added to legal source states. APPROVED is
  -- now intermediate Manager workflow; Mark Done closes it.
  IF v_previous_state NOT IN ('NEW', 'IN_REVIEW', 'REJECTED', 'APPROVED') THEN
    RAISE EXCEPTION
      'INVALID_TRANSITION: cannot mark done ticket in state % (open or APPROVED states only)',
      v_previous_state;
  END IF;

  UPDATE store_mgmt.tickets
    SET state           = v_new_state,
        closed_at       = v_now,
        resolution_type = 'DONE',
        updated_at      = v_now
    WHERE id = p_ticket_id;

  INSERT INTO store_mgmt.ticket_entries (
    ticket_id, entry_type, author_user_id, metadata, created_at
  ) VALUES (
    p_ticket_id,
    'STATE_CHANGE',
    p_actor_user_id,
    jsonb_build_object(
      'from',    v_previous_state,
      'to',      v_new_state,
      'trigger', 'user_action'
    ),
    v_now
  )
  RETURNING id INTO v_entry_id;

  RETURN jsonb_build_object(
    'ticket_id',      p_ticket_id,
    'previous_state', v_previous_state,
    'new_state',      v_new_state,
    'state_changed',  TRUE,
    'entry_id',       v_entry_id
  );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.mark_done_ticket_tx(UUID, UUID) IS
  'PR-10c user action: open or APPROVED state → DONE. PR-Inbox.X: APPROVED added to source states (was open-only).';

-- ============================================================
-- 5. RPC: find_or_create_ticket_tx — drop closed_at on APPROVED
--                                    (merges into ELSE branch)
-- ============================================================
-- Full body re-CREATE-OR-REPLACE'd from PR-16b.5 eligibility
-- baseline (20260504000002). Single semantic delta: the
-- `ELSIF v_new_state = 'APPROVED'` branch in the UPDATE path drops
-- its closed_at + resolution_type writes (merges into ELSE branch).
-- All other stages — auto-DONE branch (PR-16a.2), auto-reopen
-- branch (PR-16b + PR-16b.5 eligibility gate), email snapshot,
-- find/create LOOP, event log, return — preserved verbatim.
--
-- Idempotency carries forward identically. Auto-reopen still flips
-- DONE → IN_REVIEW (closed_at NULL). Auto-DONE still lands NEW →
-- DONE (closed_at set). The only behavior change is that an Apple
-- APPROVED outcome on an existing non-NEW ticket where auto-DONE
-- is NOT eligible (Manager opt-in OFF) now lands on intermediate
-- APPROVED instead of terminal APPROVED — Manager later marks
-- Done explicitly.
CREATE OR REPLACE FUNCTION store_mgmt.find_or_create_ticket_tx(
  p_classification    JSONB,
  p_email_message_id  UUID
) RETURNS JSONB AS $$
DECLARE
  v_status              TEXT;
  v_platform_id         UUID;
  v_app_id              UUID;
  v_type_id             UUID;
  v_outcome             TEXT;
  v_submission_id       TEXT;
  v_type_payload        JSONB;
  v_subject_pattern_id  UUID;

  v_email_subject   TEXT;
  v_sender_email    TEXT;
  v_sender_name     TEXT;
  v_received_at     TIMESTAMPTZ;
  v_body_text       TEXT;
  v_email_snapshot  JSONB;

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

  v_pattern_eligible    BOOLEAN;
  v_auto_done           BOOLEAN := FALSE;
  v_state_change_meta   JSONB;

  v_auto_reopen_target           UUID;
  v_auto_reopen_pattern_eligible BOOLEAN;
BEGIN
  -- (a) Validate + extract
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

  -- PR-16a auto-DONE eligibility check (preserved verbatim).
  IF v_status = 'CLASSIFIED'
     AND v_outcome = 'APPROVED'
     AND v_subject_pattern_id IS NOT NULL THEN
    SELECT auto_done_eligible
      INTO v_pattern_eligible
      FROM store_mgmt.subject_patterns
     WHERE id = v_subject_pattern_id;

    v_auto_done := COALESCE(v_pattern_eligible, FALSE);
  END IF;

  -- (b) Email snapshot (preserved verbatim).
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

  -- (b.5) PR-16b auto-reopen with PR-16b.5 eligibility gate (preserved).
  IF v_status = 'CLASSIFIED'
     AND v_outcome = 'REJECTED'
     AND v_subject_pattern_id IS NOT NULL THEN

    SELECT auto_reopen_eligible
      INTO v_auto_reopen_pattern_eligible
      FROM store_mgmt.subject_patterns
     WHERE id = v_subject_pattern_id;

    IF COALESCE(v_auto_reopen_pattern_eligible, FALSE) THEN
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
  END IF;

  -- (c) Find-or-create LOOP (preserved verbatim).
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

  -- (d) UPDATE path — derive state + mutate row
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

    -- PR-Inbox.X delta: APPROVED branch merged into ELSE — no
    -- closed_at + resolution_type write when landing on APPROVED
    -- (intermediate Manager workflow). Only DONE remains terminal-
    -- writing in the email-driven path.
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
    ELSE
      -- Covers NEW, IN_REVIEW, REJECTED, APPROVED — none are
      -- terminal post-PR-Inbox.X.
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

  -- (e) Event log (preserved verbatim).
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

  -- (f) Return shape.
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
  'PR-9 ticket engine + PR-16a auto-mark-done + PR-16b auto-reopen + PR-16b.5 eligibility gate + PR-Inbox.X APPROVED-as-intermediate. APPROVED state no longer sets closed_at — Manager Mark Done closes explicitly.';

-- ============================================================
-- END — 20260509000000_store_mgmt_pr_inbox_x_approved_intermediate
-- ============================================================
