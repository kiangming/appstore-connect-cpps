-- ============================================================
-- Migration: Store Management — Ticket Engine RPC (PR-9)
--
-- Ships the transactional find-or-create primitive that replaces the
-- PR-8 stub in `lib/store-submissions/tickets/engine-stub.ts`. TypeScript
-- caller (`lib/store-submissions/tickets/engine.ts` in PR-9.3) invokes
-- this RPC once per ticketable email; the RPC owns all ticket + event-log
-- writes for that email in a single PL/pgSQL transaction.
--
-- Scope (this migration):
--   1. Partial unique index on ticket_entries for EMAIL idempotency
--   2. find_or_create_ticket_tx(p_classification, p_email_message_id)
--
-- NOT in scope: user-action handlers (archive/follow-up/done/etc.), app
-- rename transaction, reclassify. Those remain spec §2.2/2.3/§5.2 items
-- for later PRs.
--
-- Canonical lock order (risk mitigation from PR-9 planning):
--   tickets row first (SELECT ... FOR UPDATE on grouping key), then
--   ticket_entries INSERTs. The partial unique index
--   `idx_store_mgmt_tickets_open_unique` (init migration line 275) is
--   the race fallback when two sessions both miss the FOR UPDATE and
--   both attempt INSERT; the loser catches unique_violation and
--   re-enters the find path.
--
-- Spec authority:
--   - 04-ticket-engine.md §3.1 (transactional flow)
--   - 04-ticket-engine.md §3.2 (FOR UPDATE)
--   - 04-ticket-engine.md §3.3-3.4 (create vs update)
--   - 04-ticket-engine.md §4.1 (state derivation from email)
--   - 04-ticket-engine.md §5.1 (grouping key matrix)
--   - CLAUDE.md invariant #1 (one open ticket per key)
--   - CLAUDE.md invariant #3 (email_snapshot required on EMAIL entries)
--   - CLAUDE.md invariant #6 (terminal-state ↔ closed_at ↔ resolution_type)
--
-- Deviation from spec §3.3: empty type_payload objects ({}) are NOT
-- appended to tickets.type_payloads. Rationale: CLASSIFIED emails whose
-- type has no payload_extract_regex yield `type_payload: {}`, which
-- would accumulate one empty entry per ticket at create and generate
-- no-op PAYLOAD_ADDED events. Skipping empties keeps the audit trail
-- signal-rich. Non-empty payloads append per spec shape
-- `{ payload, first_seen_at }`.
--
-- Error contract (RAISE EXCEPTION prefixes, matched by TypeScript caller):
--   INVALID_ARG        — malformed classification JSONB
--   NOT_FOUND          — email_message_id does not exist
--   INVALID_OUTCOME    — classification.outcome not in (IN_REVIEW, REJECTED, APPROVED)
--   INVALID_STATUS     — classification.status not in ticketable set
-- ============================================================

-- ---------------------------------------------------------------
-- 1. Idempotency partial unique index on ticket_entries
-- ---------------------------------------------------------------
-- Prevents duplicate EMAIL entries for the same (ticket, email) pair.
-- Matters when Gmail sync retries a batch after a partial failure — the
-- email_messages row is already inserted (idempotent via UNIQUE(gmail_msg_id))
-- but the wire may call find_or_create_ticket_tx a second time. Without
-- this index, we'd accumulate duplicate EMAIL events in the thread.
--
-- Partial predicate matches entry_type='EMAIL' only — COMMENT, STATE_CHANGE,
-- PAYLOAD_ADDED, etc. are not deduped (they can legitimately occur multiple
-- times for the same email, e.g. two STATE_CHANGEs across different runs).
--
-- INSERT ... ON CONFLICT uses this index implicitly when the row satisfies
-- the partial predicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_store_mgmt_ticket_entries_email_idempotency
  ON store_mgmt.ticket_entries (ticket_id, email_message_id)
  WHERE entry_type = 'EMAIL';

COMMENT ON INDEX store_mgmt.idx_store_mgmt_ticket_entries_email_idempotency IS
  'PR-9: prevents duplicate EMAIL ticket_entries rows when Gmail sync retries. See find_or_create_ticket_tx.';


-- ---------------------------------------------------------------
-- 2. find_or_create_ticket_tx
-- ---------------------------------------------------------------
-- Atomically:
--   a. Locks (or creates) the open ticket for the classification's
--      grouping key (§5.1).
--   b. Applies email-driven state transition per §4.1.
--   c. Appends novel type_payload and submission_id (§3.4).
--   d. Writes EMAIL + optional STATE_CHANGE + optional PAYLOAD_ADDED
--      event entries.
--   e. Returns JSONB matching FindOrCreateTicketOutput
--      (lib/store-submissions/tickets/types.ts).
--
-- Params:
--   p_classification    JSONB from email_messages.classification_result
--                       (expected status: CLASSIFIED | UNCLASSIFIED_APP
--                       | UNCLASSIFIED_TYPE). Full shape per
--                       classifier/types.ts *Result unions. Required fields
--                       read: status, platform_id, outcome.
--                       Conditional: app_id (absent → NULL for
--                       UNCLASSIFIED_APP), type_id (absent → NULL for
--                       UNCLASSIFIED_APP / UNCLASSIFIED_TYPE),
--                       submission_id, type_payload.
--   p_email_message_id  UUID of store_mgmt.email_messages row. RPC reads
--                       snapshot fields (subject, sender, received_at,
--                       raw_body_text) for the EMAIL entry metadata.
--
-- Returns JSONB:
--   { ticket_id, created, previous_state, new_state, state_changed,
--     ticket: { ...full row } }
CREATE OR REPLACE FUNCTION store_mgmt.find_or_create_ticket_tx(
  p_classification    JSONB,
  p_email_message_id  UUID
) RETURNS JSONB AS $$
DECLARE
  -- Extracted from p_classification
  v_status          TEXT;
  v_platform_id     UUID;
  v_app_id          UUID;
  v_type_id         UUID;
  v_outcome         TEXT;
  v_submission_id   TEXT;
  v_type_payload    JSONB;

  -- Email snapshot sourced from store_mgmt.email_messages
  v_email_subject   TEXT;
  v_sender_email    TEXT;
  v_sender_name     TEXT;
  v_received_at     TIMESTAMPTZ;
  v_body_text       TEXT;
  v_email_snapshot  JSONB;

  -- Mutable state during processing
  v_existing        store_mgmt.tickets%ROWTYPE;
  v_ticket          store_mgmt.tickets%ROWTYPE;
  v_previous_state  TEXT;
  v_new_state       TEXT;
  v_state_changed   BOOLEAN := FALSE;
  v_created         BOOLEAN := FALSE;
  v_payload_added   BOOLEAN := FALSE;
  v_new_payloads    JSONB;
  v_new_sub_ids     TEXT[];
  v_now             TIMESTAMPTZ := NOW();
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

  -- app_id: present only for CLASSIFIED + UNCLASSIFIED_TYPE
  IF p_classification ? 'app_id' AND (p_classification->>'app_id') IS NOT NULL THEN
    BEGIN
      v_app_id := (p_classification->>'app_id')::UUID;
    EXCEPTION WHEN invalid_text_representation OR others THEN
      RAISE EXCEPTION 'INVALID_ARG: classification.app_id must be UUID';
    END;
  END IF;

  -- type_id: present only for CLASSIFIED
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

  -- outcome: required on all ticketable statuses per classifier types.ts
  v_outcome := p_classification->>'outcome';
  IF v_outcome IS NOT NULL AND v_outcome NOT IN ('IN_REVIEW', 'REJECTED', 'APPROVED') THEN
    RAISE EXCEPTION 'INVALID_OUTCOME: classification.outcome must be IN_REVIEW/REJECTED/APPROVED (got %)',
      v_outcome;
  END IF;

  -- submission_id + type_payload only meaningful for CLASSIFIED
  IF v_status = 'CLASSIFIED' THEN
    v_submission_id := NULLIF(p_classification->>'submission_id', '');
    IF p_classification ? 'type_payload' THEN
      v_type_payload := p_classification->'type_payload';
      -- Spec §3.3 appends only objects; treat JSON null as absent.
      -- Deviation from spec §3.3: also treat empty object `{}` as absent
      -- so CLASSIFIED emails whose Type has no payload_extract_regex
      -- (or regex with no named groups) don't pollute type_payloads +
      -- generate no-op PAYLOAD_ADDED events. See header note.
      IF jsonb_typeof(v_type_payload) = 'null'
         OR v_type_payload = '{}'::jsonb THEN
        v_type_payload := NULL;
      END IF;
    END IF;
  END IF;

  -- ---------------------------------------------------------------
  -- (b) Load email snapshot for EMAIL entry metadata
  -- ---------------------------------------------------------------
  SELECT subject, sender_email, sender_name, received_at, raw_body_text
    INTO v_email_subject, v_sender_email, v_sender_name, v_received_at, v_body_text
    FROM store_mgmt.email_messages
    WHERE id = p_email_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: email_message % does not exist', p_email_message_id;
  END IF;

  -- Invariant #3 (CLAUDE.md): email_snapshot with subject/sender/received_at/body_excerpt (500 chars).
  v_email_snapshot := jsonb_build_object(
    'subject',     v_email_subject,
    'sender',      v_sender_email,
    'sender_name', v_sender_name,
    'received_at', to_char(v_received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'body_excerpt', LEFT(COALESCE(v_body_text, ''), 500)
  );

  -- ---------------------------------------------------------------
  -- (c) Find-or-create with race loop
  --
  -- Why a LOOP: concurrent sessions can both miss the SELECT (no row yet)
  -- and both attempt INSERT. The partial unique index guarantees exactly
  -- one wins; the loser catches unique_violation and re-enters the LOOP
  -- which this time finds the winner's row via SELECT FOR UPDATE.
  --
  -- Max iterations: 2 in practice (1 miss → 1 retry). Guard at 3 to
  -- surface a bug (e.g. predicate drift between SELECT and index).
  -- ---------------------------------------------------------------
  FOR i IN 1..3 LOOP
    -- Match the partial unique index predicate exactly so the planner
    -- uses it and so NULL-app_id / NULL-type_id buckets group correctly.
    -- (The index COALESCEs NULLs to a sentinel UUID; here we use explicit
    -- IS NULL checks which produce the same logical grouping.)
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

    -- No open ticket; try to create.
    BEGIN
      INSERT INTO store_mgmt.tickets (
        app_id, platform_id, type_id, state,
        latest_outcome, type_payloads, submission_ids,
        priority, opened_at
      ) VALUES (
        v_app_id, v_platform_id, v_type_id, 'NEW',
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
        v_now
      )
      RETURNING * INTO v_ticket;

      v_created := TRUE;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- Concurrent session won the INSERT race. Loop around; next SELECT
      -- FOR UPDATE will find (and lock) the winner's row.
      CONTINUE;
    END;
  END LOOP;

  IF v_ticket.id IS NULL THEN
    -- Exhausted retry budget — indicates unexpected constraint drift.
    RAISE EXCEPTION 'CONCURRENT_RACE_UNEXPECTED: find-or-create did not converge in 3 iterations for (app=%, type=%, platform=%)',
      v_app_id, v_type_id, v_platform_id;
  END IF;

  -- ---------------------------------------------------------------
  -- (d) If UPDATE path, derive state + mutate row
  --     (If CREATE path, v_created=TRUE and we skip to event logs.)
  -- ---------------------------------------------------------------
  IF v_created THEN
    v_previous_state := NULL;
    v_new_state := 'NEW';
    v_state_changed := FALSE;
  ELSE
    v_previous_state := v_existing.state;

    -- Spec §4.1 — deriveStateFromEmailOnOpenTicket:
    --   NEW             → always NEW (user triage required)
    --   outcome IS NULL → stay on current state
    --   IN_REVIEW/REJECTED + outcome → adopt outcome (IN_REVIEW/REJECTED/APPROVED)
    IF v_existing.state = 'NEW' THEN
      v_new_state := 'NEW';
    ELSIF v_outcome IS NULL THEN
      v_new_state := v_existing.state;
    ELSE
      v_new_state := v_outcome;
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

    -- Submission ID novelty (§3.4)
    v_new_sub_ids := v_existing.submission_ids;
    IF v_submission_id IS NOT NULL AND NOT (v_submission_id = ANY(v_new_sub_ids)) THEN
      v_new_sub_ids := array_append(v_new_sub_ids, v_submission_id);
    END IF;

    -- Apply update. Terminal transition (→ APPROVED) sets closed_at +
    -- resolution_type per invariant #6. NEW→DONE/ARCHIVED are user
    -- actions and never fire from email paths.
    --
    -- latest_outcome: unconditional overwrite per spec §3.4 line 327.
    -- Classifier types guarantee `outcome` non-null for ticketable
    -- statuses (CLASSIFIED/UNCLASSIFIED_APP/UNCLASSIFIED_TYPE all
    -- carry a non-null Outcome), so in practice this replaces the
    -- stored value with a fresh non-null outcome on every email. The
    -- "could overwrite non-null with null" edge is preserved verbatim
    -- for spec fidelity + future audit.
    IF v_new_state = 'APPROVED' THEN
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

  -- EMAIL entry — idempotent via partial unique index.
  -- The WHERE clause after the conflict target matches the partial index
  -- predicate and makes the planner use that index for the conflict check.
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

  -- STATE_CHANGE entry — only on actual transition, never on create.
  IF v_state_changed THEN
    INSERT INTO store_mgmt.ticket_entries (
      ticket_id, entry_type, author_user_id, metadata
    ) VALUES (
      v_ticket.id,
      'STATE_CHANGE',
      NULL,
      jsonb_build_object(
        'from',              v_previous_state,
        'to',                v_new_state,
        'trigger',           'email',
        'email_message_id',  p_email_message_id
      )
    );
  END IF;

  -- PAYLOAD_ADDED entry — only when a novel type_payload was appended.
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
  -- (f) Return shape matching FindOrCreateTicketOutput (types.ts)
  -- ---------------------------------------------------------------
  RETURN jsonb_build_object(
    'ticket_id',       v_ticket.id,
    'created',         v_created,
    'previous_state',  v_previous_state,
    'new_state',       v_new_state,
    'state_changed',   v_state_changed,
    'ticket',          to_jsonb(v_ticket)
  );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.find_or_create_ticket_tx(JSONB, UUID) IS
  'PR-9 ticket engine core. Transactional find-or-create for the (app,type,platform) grouping key with email-driven state derivation and event-log writes. See docs/store-submissions/04-ticket-engine.md §3.';

-- Explicit GRANT for clarity; ALTER DEFAULT PRIVILEGES in init migration
-- already covers service_role, but an explicit grant documents the call
-- contract at the site of definition.
GRANT EXECUTE ON FUNCTION store_mgmt.find_or_create_ticket_tx(JSONB, UUID)
  TO service_role;

-- ============================================================
-- END — 20260423000000_store_mgmt_ticket_engine_rpc
-- ============================================================
