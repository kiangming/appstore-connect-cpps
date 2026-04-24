-- ============================================================
-- Migration: Store Management — User Action RPCs (PR-10c.1.3)
--
-- Ships the 7 PL/pgSQL functions invoked by the TypeScript dispatcher
-- `lib/store-submissions/tickets/user-actions.ts` (PR-10c.1.2). Each RPC
-- is atomic: state + event-log writes happen in a single transaction,
-- serialized with PR-9's `find_or_create_ticket_tx` via `FOR UPDATE` on
-- the `tickets` row.
--
-- Functions shipped:
--   1. archive_ticket_tx      (ARCHIVE action)
--   2. follow_up_ticket_tx    (FOLLOW_UP action)
--   3. mark_done_ticket_tx    (MARK_DONE action)
--   4. unarchive_ticket_tx    (UNARCHIVE action)
--   5. add_comment_tx         (ADD_COMMENT action)
--   6. edit_comment_tx        (EDIT_COMMENT action)
--   7. add_reject_reason_tx   (ADD_REJECT_REASON action)
--
-- Spec authority:
--   - 04-ticket-engine.md §4.2 (deriveStateFromUserAction rules)
--   - 04-ticket-engine.md §7.1-7.6 (dispatcher design + archive undo)
--   - 01-data-model.md (ticket_entries CHECK edited_at IS NULL OR
--     entry_type='COMMENT')
--   - CLAUDE.md invariant #2 (event log append-only except COMMENT edit)
--   - CLAUDE.md invariant #6 (terminal-state ↔ closed_at ↔
--     resolution_type move together)
--
-- Parity with state-machine.ts (PR-10c.1.1):
--   Every guard in SQL matches the TypeScript pure function. If the two
--   drift, the UI gating (canTransition) will allow actions that the
--   RPC rejects — bad UX. Tests in PR-10c.1.4 assert both layers
--   accept/reject the same pairs.
--
-- Concurrency: all 4 state-transition RPCs take `SELECT ... FOR UPDATE`
-- on the tickets row. This serializes with:
--   (a) `find_or_create_ticket_tx` — incoming Gmail email mid-archive
--       can't corrupt the transition.
--   (b) Other user-action RPCs — double-click Archive won't double-insert
--       STATE_CHANGE entries.
-- Comment/reject-reason RPCs skip `FOR UPDATE` on tickets — they don't
-- mutate ticket state. They DO bump `tickets.updated_at` with a plain
-- UPDATE so the Inbox "recent activity" sort reflects the new entry.
--
-- STATE_CHANGE metadata.trigger = 'user_action':
--   Spec §7.3 mandates this exact string. The current timeline renderer
--   checks `trigger === 'user'` (TicketEntriesTimeline.tsx:261) — that's
--   a bug fixed in PR-10c.3.2. Do not change the value here to mask the
--   renderer bug; the value is spec-canonical.
--
-- Error prefixes (matched by TypeScript `mapRpcError` in user-actions.ts):
--   INVALID_TRANSITION          — state guard failed
--   NOT_FOUND                   — ticket or entry does not exist
--   INVALID_ARG                 — malformed UUID, empty content, wrong
--                                 entry_type for edit, ticket/entry
--                                 mismatch
--   INVALID_STATUS              — unused here; reserved for future
--                                 parity with engine.ts
--   COMMENT_FORBIDDEN           — EDIT_COMMENT by non-author
--   CONCURRENT_RACE_UNEXPECTED  — reserved; these RPCs don't loop-retry
--                                 like find_or_create, so this prefix is
--                                 unused for now. Kept in the TS mapping
--                                 for future schema-drift detection.
-- ============================================================


-- ============================================================
-- 1. archive_ticket_tx
-- ============================================================
-- Transitions a NEW ticket to ARCHIVED. Per spec §4.2: NEW only — any
-- other current state raises INVALID_TRANSITION so the UI's disabled-
-- button gate (canTransition) and the RPC agree. A "skip-to-archive"
-- from a ticket that already went IN_REVIEW/REJECTED is intentionally
-- not supported; Manager would use MARK_DONE instead.
--
-- Terminal fields (invariant #6): sets closed_at + resolution_type in
-- the same UPDATE to satisfy the tickets_state_closed_at check.
CREATE OR REPLACE FUNCTION store_mgmt.archive_ticket_tx(
  p_ticket_id      UUID,
  p_actor_user_id  UUID
) RETURNS JSONB AS $$
DECLARE
  v_ticket          store_mgmt.tickets%ROWTYPE;
  v_previous_state  TEXT;
  v_new_state       TEXT := 'ARCHIVED';
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

  -- Parity with state-machine.ts: ARCHIVE legal only from NEW.
  IF v_previous_state <> 'NEW' THEN
    RAISE EXCEPTION
      'INVALID_TRANSITION: cannot archive ticket in state % (NEW only)',
      v_previous_state;
  END IF;

  UPDATE store_mgmt.tickets
    SET state           = v_new_state,
        closed_at       = v_now,
        resolution_type = 'ARCHIVED',
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

COMMENT ON FUNCTION store_mgmt.archive_ticket_tx(UUID, UUID) IS
  'PR-10c user action: NEW → ARCHIVED. Spec §4.2. FOR UPDATE serializes with find_or_create_ticket_tx.';

GRANT EXECUTE ON FUNCTION store_mgmt.archive_ticket_tx(UUID, UUID) TO service_role;


-- ============================================================
-- 2. follow_up_ticket_tx
-- ============================================================
-- Transitions NEW → (latest_outcome ?? IN_REVIEW). Per spec §4.2:
--   - Current state must be NEW
--   - If the ticket carries a latest_outcome (set by prior emails), use
--     it as the target state — Manager is acknowledging the already-seen
--     outcome and promoting the ticket to that state for tracking.
--   - If latest_outcome is NULL (no email ever set one — typical for
--     Unclassified buckets), fall back to IN_REVIEW so the ticket shows
--     up on the "active" board.
--
-- Edge: latest_outcome = 'APPROVED' lands on APPROVED terminal. That's
-- intentional (§4.2): Manager saw Apple's approve email out-of-band and
-- is closing the ticket manually. Terminal fields set atomically.
CREATE OR REPLACE FUNCTION store_mgmt.follow_up_ticket_tx(
  p_ticket_id      UUID,
  p_actor_user_id  UUID
) RETURNS JSONB AS $$
DECLARE
  v_ticket          store_mgmt.tickets%ROWTYPE;
  v_previous_state  TEXT;
  v_new_state       TEXT;
  v_is_terminal     BOOLEAN;
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
  v_is_terminal := v_new_state = 'APPROVED';

  IF v_is_terminal THEN
    UPDATE store_mgmt.tickets
      SET state           = v_new_state,
          closed_at       = v_now,
          resolution_type = 'APPROVED',
          updated_at      = v_now
      WHERE id = p_ticket_id;
  ELSE
    UPDATE store_mgmt.tickets
      SET state      = v_new_state,
          updated_at = v_now
      WHERE id = p_ticket_id;
  END IF;

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
  'PR-10c user action: NEW → latest_outcome ?? IN_REVIEW. Spec §4.2.';

GRANT EXECUTE ON FUNCTION store_mgmt.follow_up_ticket_tx(UUID, UUID) TO service_role;


-- ============================================================
-- 3. mark_done_ticket_tx
-- ============================================================
-- Transitions any open state (NEW/IN_REVIEW/REJECTED) → DONE. Per spec
-- §4.2. Manager-style "close without formal outcome" escape hatch.
-- Terminal fields set atomically.
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

  IF v_previous_state NOT IN ('NEW', 'IN_REVIEW', 'REJECTED') THEN
    RAISE EXCEPTION
      'INVALID_TRANSITION: cannot mark done ticket in state % (open states only)',
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
  'PR-10c user action: open state → DONE. Spec §4.2.';

GRANT EXECUTE ON FUNCTION store_mgmt.mark_done_ticket_tx(UUID, UUID) TO service_role;


-- ============================================================
-- 4. unarchive_ticket_tx
-- ============================================================
-- ARCHIVED → NEW (intentional re-triage). Per spec §4.2: the ticket is
-- returned to NEW even if it accumulated emails before archive. Manager
-- is expected to re-review from scratch. Clears closed_at +
-- resolution_type to satisfy invariant #6.
--
-- Note: the partial unique index `idx_store_mgmt_tickets_open_unique`
-- on (app_id, type_id, platform_id) WHERE state IN (open) means
-- unarchiving can fail with unique_violation if another ticket with
-- the same grouping key is currently open. We surface that as
-- INVALID_TRANSITION — user should archive/merge the conflicting ticket
-- first. Not retried; caller decides.
CREATE OR REPLACE FUNCTION store_mgmt.unarchive_ticket_tx(
  p_ticket_id      UUID,
  p_actor_user_id  UUID
) RETURNS JSONB AS $$
DECLARE
  v_ticket          store_mgmt.tickets%ROWTYPE;
  v_previous_state  TEXT;
  v_new_state       TEXT := 'NEW';
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

  IF v_previous_state <> 'ARCHIVED' THEN
    RAISE EXCEPTION
      'INVALID_TRANSITION: cannot unarchive ticket in state % (ARCHIVED only)',
      v_previous_state;
  END IF;

  BEGIN
    UPDATE store_mgmt.tickets
      SET state           = v_new_state,
          closed_at       = NULL,
          resolution_type = NULL,
          updated_at      = v_now
      WHERE id = p_ticket_id;
  EXCEPTION WHEN unique_violation THEN
    -- Another open ticket already exists for this grouping key.
    -- Surface as INVALID_TRANSITION so the caller can tell the user
    -- to resolve (archive/merge) the conflicting ticket first.
    RAISE EXCEPTION
      'INVALID_TRANSITION: cannot unarchive — another open ticket already exists for this app/type/platform key';
  END;

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

COMMENT ON FUNCTION store_mgmt.unarchive_ticket_tx(UUID, UUID) IS
  'PR-10c user action: ARCHIVED → NEW (re-triage). Spec §4.2.';

GRANT EXECUTE ON FUNCTION store_mgmt.unarchive_ticket_tx(UUID, UUID) TO service_role;


-- ============================================================
-- 5. add_comment_tx
-- ============================================================
-- Appends a COMMENT entry. No state change; no FOR UPDATE on tickets
-- (comments don't race with state transitions). Bumps tickets.updated_at
-- so the Inbox "recent activity" sort reflects the new entry.
--
-- Content validation: trim + non-empty. Empty or whitespace-only
-- comments are rejected with INVALID_ARG — the caller UI should catch
-- this before issuing the RPC, but we defend anyway.
CREATE OR REPLACE FUNCTION store_mgmt.add_comment_tx(
  p_ticket_id      UUID,
  p_actor_user_id  UUID,
  p_content        TEXT
) RETURNS JSONB AS $$
DECLARE
  v_ticket          store_mgmt.tickets%ROWTYPE;
  v_content         TEXT;
  v_entry_id        UUID;
  v_now             TIMESTAMPTZ := NOW();
BEGIN
  v_content := BTRIM(COALESCE(p_content, ''));
  IF v_content = '' THEN
    RAISE EXCEPTION 'INVALID_ARG: comment content must be non-empty';
  END IF;

  SELECT * INTO v_ticket
    FROM store_mgmt.tickets
    WHERE id = p_ticket_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: ticket % does not exist', p_ticket_id;
  END IF;

  INSERT INTO store_mgmt.ticket_entries (
    ticket_id, entry_type, author_user_id, content, metadata, created_at
  ) VALUES (
    p_ticket_id,
    'COMMENT',
    p_actor_user_id,
    v_content,
    '{}'::jsonb,
    v_now
  )
  RETURNING id INTO v_entry_id;

  -- Bump tickets.updated_at so recent-activity sort picks this up.
  -- No FOR UPDATE: a racing bump just produces near-identical timestamps,
  -- no correctness concern.
  UPDATE store_mgmt.tickets
    SET updated_at = v_now
    WHERE id = p_ticket_id;

  RETURN jsonb_build_object(
    'ticket_id',      p_ticket_id,
    'previous_state', v_ticket.state,
    'new_state',      v_ticket.state,
    'state_changed',  FALSE,
    'entry_id',       v_entry_id
  );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.add_comment_tx(UUID, UUID, TEXT) IS
  'PR-10c user action: append COMMENT entry, bump updated_at.';

GRANT EXECUTE ON FUNCTION store_mgmt.add_comment_tx(UUID, UUID, TEXT) TO service_role;


-- ============================================================
-- 6. edit_comment_tx
-- ============================================================
-- The odd-one-out: only user action that UPDATEs ticket_entries (vs.
-- INSERTs). Per invariant #2 (CLAUDE.md) + init-migration CHECK
-- (edited_at IS NULL OR entry_type='COMMENT'), this is the ONLY allowed
-- mutation on the append-only event log.
--
-- Guards (in order):
--   a. Entry exists (NOT_FOUND)
--   b. Entry belongs to p_ticket_id (INVALID_ARG — prevents
--      URL-manipulation cross-ticket edits; see PR-10c.1.2 DESIGN-3)
--   c. Entry is a COMMENT (INVALID_ARG — enforces the CHECK constraint
--      at app layer with a clear error)
--   d. Actor is the original author (COMMENT_FORBIDDEN — ownership
--      defense-in-depth vs. the auth matrix)
--   e. New content trimmed non-empty (INVALID_ARG)
--
-- FOR UPDATE on ticket_entries row: prevents two concurrent edits
-- (unlikely but cheap to defend).
CREATE OR REPLACE FUNCTION store_mgmt.edit_comment_tx(
  p_ticket_id      UUID,
  p_entry_id       UUID,
  p_actor_user_id  UUID,
  p_content        TEXT
) RETURNS JSONB AS $$
DECLARE
  v_entry           store_mgmt.ticket_entries%ROWTYPE;
  v_ticket_state    TEXT;
  v_content         TEXT;
  v_now             TIMESTAMPTZ := NOW();
BEGIN
  v_content := BTRIM(COALESCE(p_content, ''));
  IF v_content = '' THEN
    RAISE EXCEPTION 'INVALID_ARG: comment content must be non-empty';
  END IF;

  SELECT * INTO v_entry
    FROM store_mgmt.ticket_entries
    WHERE id = p_entry_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: ticket entry % does not exist', p_entry_id;
  END IF;

  IF v_entry.ticket_id <> p_ticket_id THEN
    RAISE EXCEPTION
      'INVALID_ARG: entry % does not belong to ticket %',
      p_entry_id, p_ticket_id;
  END IF;

  IF v_entry.entry_type <> 'COMMENT' THEN
    RAISE EXCEPTION
      'INVALID_ARG: entry % has type % (only COMMENT entries can be edited)',
      p_entry_id, v_entry.entry_type;
  END IF;

  IF v_entry.author_user_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'COMMENT_FORBIDDEN: only the original author can edit this comment';
  END IF;

  UPDATE store_mgmt.ticket_entries
    SET content   = v_content,
        edited_at = v_now
    WHERE id = p_entry_id;

  -- Read the ticket state (no lock — just metadata for the return value).
  SELECT state INTO v_ticket_state
    FROM store_mgmt.tickets
    WHERE id = p_ticket_id;

  -- Bump updated_at so recent-activity sort picks up the edit.
  UPDATE store_mgmt.tickets
    SET updated_at = v_now
    WHERE id = p_ticket_id;

  RETURN jsonb_build_object(
    'ticket_id',      p_ticket_id,
    'previous_state', v_ticket_state,
    'new_state',      v_ticket_state,
    'state_changed',  FALSE,
    'entry_id',       p_entry_id
  );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.edit_comment_tx(UUID, UUID, UUID, TEXT) IS
  'PR-10c user action: UPDATE comment content + set edited_at. Invariant #2 exception. Author-only.';

GRANT EXECUTE ON FUNCTION store_mgmt.edit_comment_tx(UUID, UUID, UUID, TEXT) TO service_role;


-- ============================================================
-- 7. add_reject_reason_tx
-- ============================================================
-- Appends a REJECT_REASON entry. No state change (state tracking is
-- separate — tickets reach REJECTED via email-driven transition or
-- follow-up; this action just captures the pasted reject text).
--
-- Per spec §7.5 + §12: metadata = {source: 'manual_paste'}. This flag
-- is opaque to the UI today but reserved for post-MVP LLM
-- categorization (docs/06-deployment.md:987).
CREATE OR REPLACE FUNCTION store_mgmt.add_reject_reason_tx(
  p_ticket_id      UUID,
  p_actor_user_id  UUID,
  p_content        TEXT
) RETURNS JSONB AS $$
DECLARE
  v_ticket          store_mgmt.tickets%ROWTYPE;
  v_content         TEXT;
  v_entry_id        UUID;
  v_now             TIMESTAMPTZ := NOW();
BEGIN
  v_content := BTRIM(COALESCE(p_content, ''));
  IF v_content = '' THEN
    RAISE EXCEPTION 'INVALID_ARG: reject reason content must be non-empty';
  END IF;

  SELECT * INTO v_ticket
    FROM store_mgmt.tickets
    WHERE id = p_ticket_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: ticket % does not exist', p_ticket_id;
  END IF;

  INSERT INTO store_mgmt.ticket_entries (
    ticket_id, entry_type, author_user_id, content, metadata, created_at
  ) VALUES (
    p_ticket_id,
    'REJECT_REASON',
    p_actor_user_id,
    v_content,
    jsonb_build_object('source', 'manual_paste'),
    v_now
  )
  RETURNING id INTO v_entry_id;

  UPDATE store_mgmt.tickets
    SET updated_at = v_now
    WHERE id = p_ticket_id;

  RETURN jsonb_build_object(
    'ticket_id',      p_ticket_id,
    'previous_state', v_ticket.state,
    'new_state',      v_ticket.state,
    'state_changed',  FALSE,
    'entry_id',       v_entry_id
  );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

COMMENT ON FUNCTION store_mgmt.add_reject_reason_tx(UUID, UUID, TEXT) IS
  'PR-10c user action: append REJECT_REASON entry with metadata.source=manual_paste.';

GRANT EXECUTE ON FUNCTION store_mgmt.add_reject_reason_tx(UUID, UUID, TEXT) TO service_role;


-- ============================================================
-- END — 20260424000000_store_mgmt_user_actions_rpcs
-- ============================================================
