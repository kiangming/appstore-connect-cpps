-- ============================================================
-- Migration: PR-Inbox.ForwardDedup — structural duplicate fix
--            for multi-account Apple email forwarding
--            (Pattern 10 reuse #19 cycle 28)
--
-- Background:
--   Manager added 2 admin Gmail forwarder accounts on 2026-05-06
--   (3 total: 1 direct + 2 forwarders). Each Apple submission
--   notification now arrives N times at the shared mailbox as
--   distinct gmail_msg_ids. UNIQUE(gmail_msg_id) doesn't catch
--   this — Gmail assigns separate ids to each forwarded copy.
--
--   find_or_create_ticket_tx's open-states predicate
--   (state IN 'NEW','IN_REVIEW','REJECTED') incidentally protects
--   REJECTED forwards: a second REJECTED forward finds the existing
--   open REJECTED ticket and updates it. But for APPROVED forwards,
--   once the first forward lands a ticket in APPROVED/DONE state,
--   subsequent forwards no longer find it via the open-states
--   predicate → create new tickets. Same pattern triggers on
--   IN_REVIEW once the ticket has been auto-DONE'd via subject
--   pattern eligibility (PR-16a).
--
-- Solution (Hybrid C, Manager LOCKED 2026-05-14):
--   Upstream fingerprint check at email_messages ingestion, ahead
--   of the wire/engine layer. Fingerprint =
--       (platform_id, app_id, type_id, outcome, ext_submission_id,
--        optional version).
--   ±5min symmetric window. Apple-only Phase 1. All outcomes
--   (defense-in-depth — Q2). RPC contract unchanged — gate skips
--   associateEmailWithTicket for DUPLICATE_FORWARD rows.
--
-- This migration:
--   1. Adds two columns: duplicate_fingerprint TEXT (computed key,
--      used for runtime index lookup + audit) and
--      duplicate_of_email_id UUID (back-reference to original row,
--      ON DELETE SET NULL so cleanup cron purging an original does
--      not cascade-delete duplicates).
--   2. Extends classification_status CHECK to include
--      'DUPLICATE_FORWARD' (new terminal status for forwarded
--      copies; never routed to ticket engine).
--   3. Backfills May 6+ historical Apple CLASSIFIED rows: group
--      by fingerprint, first-by-received_at wins as original, all
--      subsequent → DUPLICATE_FORWARD with duplicate_of_email_id
--      back-reference. ticket_id is NOT touched (Manager Q9
--      "annotate, no delete" — duplicate tickets remain visible
--      as historical audit; future cleanup pass is a separate
--      decision).
--   4. Creates the two indexes powering runtime gate + audit UI:
--      partial index on (duplicate_fingerprint, received_at) for
--      the ±5min window lookup, and partial index on
--      duplicate_of_email_id for the detail-panel back-reference
--      join.
--
-- See:
--   - lib/store-submissions/dedup/fingerprint.ts        (FD.d)
--   - lib/store-submissions/gmail/sync.ts dedup gate   (FD.e)
--   - app/(dashboard)/store-submissions/duplicate-forwards (FD.g)
--   - docs/store-submissions/04-ticket-engine.md
--   - CLAUDE.md invariants #1 (open-ticket uniqueness),
--     #7 (forward-only migrations), #8 (classification mapping)
--
-- Pre-May 6 timeline (Manager Q14 confirmation 2026-05-14):
--   Only 1 direct source feeding the mailbox → pre-May 6 ticket
--   pairs in Q-Dedup-5 are LEGITIMATE sequential submissions,
--   NOT structural duplicates. Backfill scope is strictly
--   `received_at >= 2026-05-06 00:00:00+07` to avoid corrupting
--   the historical record.
--
-- Forward-only per CLAUDE.md rule #7. Revert = a new migration
-- that drops the columns + CHECK + restores DUPLICATE_FORWARD
-- rows to their classification status before backfill (the
-- pre-backfill state is recoverable from `extracted_payload` +
-- `classification_result` since neither was mutated).
-- ============================================================

-- ============================================================
-- 1. Schema: add columns
-- ============================================================
-- duplicate_fingerprint stored on every Apple CLASSIFIED row
-- AND on every DUPLICATE_FORWARD row (so the audit UI can group
-- originals + their duplicates by fingerprint). NULL for non-
-- Apple, non-CLASSIFIED rows — those bypass the dedup gate
-- entirely at the application layer.
--
-- duplicate_of_email_id is the back-reference. NULL on the
-- original (rn=1 within fingerprint group) and on rows that
-- weren't deduplicated. ON DELETE SET NULL handles the future
-- case where the cleanup cron purges an original — the
-- duplicate row stays, just loses its reference (the
-- fingerprint string remains as audit signal).
ALTER TABLE store_mgmt.email_messages
  ADD COLUMN duplicate_fingerprint TEXT,
  ADD COLUMN duplicate_of_email_id UUID
    REFERENCES store_mgmt.email_messages(id) ON DELETE SET NULL;

-- ============================================================
-- 2. Schema: extend classification_status CHECK
-- ============================================================
-- The init migration named this CHECK implicitly. Look it up via
-- pg_constraint by its current clause shape, drop, recreate with
-- DUPLICATE_FORWARD added.
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
       AND cls.relname = 'email_messages'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE
           '%classification_status%PENDING%CLASSIFIED%DROPPED%ERROR%'
  LOOP
    EXECUTE format(
      'ALTER TABLE store_mgmt.email_messages DROP CONSTRAINT %I', r.conname
    );
  END LOOP;
END $$;

ALTER TABLE store_mgmt.email_messages
  ADD CONSTRAINT email_messages_classification_status_check CHECK (
    classification_status IN (
      'PENDING',
      'CLASSIFIED',
      'UNCLASSIFIED_APP',
      'UNCLASSIFIED_TYPE',
      'DROPPED',
      'ERROR',
      'DUPLICATE_FORWARD'
    )
  );

-- ============================================================
-- 3. Backfill: May 6+ historical Apple CLASSIFIED duplicates
-- ============================================================
-- Algorithm:
--   (a) Restrict to Apple CLASSIFIED rows received >= 2026-05-06
--       at Asia/Ho_Chi_Minh — Manager Q14 timeline anchor.
--   (b) For each row compute fingerprint =
--         platform_id | app_id | type_id | outcome |
--         ext_submission_id | version_or_empty.
--       The version slot is populated only when extracted_payload
--       carries an APP_VERSION item — matches the runtime
--       fingerprint module's optional-fallback semantics (Q3).
--   (c) PARTITION BY fingerprint, ORDER BY received_at ASC, id ASC.
--       rn=1 → original (keeps CLASSIFIED status). rn>1 →
--       mark classification_status='DUPLICATE_FORWARD',
--       set duplicate_of_email_id = first row's id in the group.
--   (d) Store fingerprint on EVERY row in the group (originals +
--       duplicates) so the runtime gate's ±5min window query
--       hits the index on the original.
--
-- ticket_id intentionally left intact for duplicates:
--   Historical duplicates were already attached to their (also
--   duplicate) tickets by the prior wire/engine flow. Detaching
--   here would break the duplicate tickets' EMAIL timelines.
--   The /duplicate-forwards UI surfaces the email-level view of
--   duplicates without depending on ticket detachment.
--
-- Idempotency: re-running this migration filters by
-- `classification_status = 'CLASSIFIED'`, so already-marked
-- DUPLICATE_FORWARD rows are excluded from the candidate set —
-- the rn=1 row of each group is unchanged on re-run, no flips.

WITH apple AS (
  SELECT id FROM store_mgmt.platforms WHERE key = 'apple'
),
candidates AS (
  SELECT
    em.id,
    em.received_at,
    em.classification_result->>'platform_id'  AS platform_id,
    em.classification_result->>'app_id'       AS app_id,
    em.classification_result->>'type_id'      AS type_id,
    em.classification_result->>'outcome'      AS outcome,
    em.extracted_payload->>'submission_id'    AS ext_submission_id,
    (
      SELECT item->>'version'
        FROM jsonb_array_elements(em.extracted_payload->'items') item
       WHERE item->>'type' = 'APP_VERSION'
       LIMIT 1
    ) AS version
  FROM store_mgmt.email_messages em
  WHERE em.received_at >= TIMESTAMPTZ '2026-05-06 00:00:00+07'
    AND em.classification_status = 'CLASSIFIED'
    AND em.classification_result->>'platform_id'
        = (SELECT id::text FROM apple)
    AND em.extracted_payload->>'submission_id' IS NOT NULL
),
fingerprinted AS (
  SELECT
    id,
    received_at,
    platform_id
      || '|' || COALESCE(app_id, '')
      || '|' || COALESCE(type_id, '')
      || '|' || COALESCE(outcome, '')
      || '|' || ext_submission_id
      || '|' || COALESCE(version, '') AS fingerprint
  FROM candidates
),
ranked AS (
  SELECT
    id,
    fingerprint,
    ROW_NUMBER() OVER (
      PARTITION BY fingerprint
      ORDER BY received_at ASC, id ASC
    ) AS rn,
    FIRST_VALUE(id) OVER (
      PARTITION BY fingerprint
      ORDER BY received_at ASC, id ASC
    ) AS original_id
  FROM fingerprinted
)
UPDATE store_mgmt.email_messages em
   SET duplicate_fingerprint = ranked.fingerprint,
       duplicate_of_email_id = CASE
         WHEN ranked.rn > 1 THEN ranked.original_id
         ELSE NULL
       END,
       classification_status = CASE
         WHEN ranked.rn > 1 THEN 'DUPLICATE_FORWARD'
         ELSE em.classification_status
       END
  FROM ranked
 WHERE em.id = ranked.id;

-- ============================================================
-- 4. Indexes (created post-backfill to avoid per-row index
--             maintenance during the bulk UPDATE)
-- ============================================================
-- Runtime gate lookup: given a freshly-inserted email's
-- fingerprint, find originals within ±5 min. Composite index
-- on (duplicate_fingerprint, received_at) supports both the
-- equality match and the range scan in a single index seek.
CREATE INDEX idx_store_mgmt_email_messages_fingerprint
  ON store_mgmt.email_messages (duplicate_fingerprint, received_at)
  WHERE duplicate_fingerprint IS NOT NULL;

-- Audit join: /duplicate-forwards detail panel resolves
-- duplicate → original via this column. Partial index keeps it
-- small (only the ~tail of rows that are actually duplicates).
CREATE INDEX idx_store_mgmt_email_messages_duplicate_of
  ON store_mgmt.email_messages (duplicate_of_email_id)
  WHERE duplicate_of_email_id IS NOT NULL;

-- ============================================================
-- 5. Documentation comments
-- ============================================================
COMMENT ON COLUMN store_mgmt.email_messages.duplicate_fingerprint IS
  'PR-Inbox.ForwardDedup. Composition: platform_id|app_id|type_id|outcome|ext_submission_id|version_or_empty. Populated on Apple CLASSIFIED rows + their DUPLICATE_FORWARD duplicates. NULL for non-Apple platforms and for rows missing ext_submission_id (dedup gate skipped — proceed normal flow).';

COMMENT ON COLUMN store_mgmt.email_messages.duplicate_of_email_id IS
  'PR-Inbox.ForwardDedup. References the original (first-by-received_at) row in the same fingerprint group. NULL when this row IS the original, or when not deduplicated. ON DELETE SET NULL — original purged by cleanup cron does not delete duplicates.';
