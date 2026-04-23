-- ============================================================
-- Migration: Store Management — backfill PR-8-era NULL ticket_id rows
--
-- PR-8 shipped a stub ticket engine (engine-stub.ts) that generated
-- ephemeral UUIDs without inserting into store_mgmt.tickets. The wire's
-- UPDATE of email_messages.ticket_id failed the FK constraint; wire's
-- graceful-degradation contract caught the error and left ticket_id
-- NULL. As of PR-9 deploy the real engine (engine.ts + find_or_create_
-- ticket_tx RPC) writes ticket rows correctly — but rows processed
-- between PR-8 deploy (2026-04-22 ~10:30 UTC) and PR-9 deploy are
-- stranded with NULL ticket_id + populated classification_result.
--
-- This migration re-associates those rows by invoking the RPC once per
-- row. Must run AFTER the RPC migration (20260423000000_..._rpc.sql)
-- — timestamp ordering guarantees that.
--
-- Target rows:
--   email_messages.ticket_id IS NULL
--   AND classification_status IN ('CLASSIFIED', 'UNCLASSIFIED_APP',
--                                 'UNCLASSIFIED_TYPE')
--
-- Non-target (skipped by WHERE):
--   PENDING   — classifier hasn't run; wire will fire on next sync
--   DROPPED   — never produces a ticket (invariant #8)
--   ERROR     — never produces a ticket
--
-- Safety properties:
--   1. Idempotent. `WHERE ticket_id IS NULL` naturally restricts re-runs
--      to unprocessed rows. Applying this migration a second time (e.g.
--      after a fresh `supabase db reset`) is a no-op when all rows are
--      already associated.
--   2. Resumable. If the migration aborts partway (e.g. connection drop),
--      re-running picks up only the still-NULL rows.
--   3. Per-row error isolation. Each iteration's BEGIN..EXCEPTION creates
--      an implicit savepoint; a row-level failure (e.g. RPC raises
--      NOT_FOUND, CONCURRENT_RACE_UNEXPECTED) rolls back only that
--      savepoint. The outer DO-block transaction continues and commits
--      the successes.
--   4. EMAIL entry dedup. The RPC's ON CONFLICT DO NOTHING on the partial
--      unique index (ticket_entries_email_idempotency) means re-running
--      against a ticket that somehow got a prior EMAIL entry won't
--      double-insert.
--
-- Volume estimate (production at 2026-04-23): ~3 rows
-- (UNCLASSIFIED_APP rows post-PR-8 deploy without App Registry entries).
-- Execution time: < 1 second. If volume unexpectedly high, consider
-- splitting into per-row scripts with explicit transactions.
--
-- Pre-apply preview (OPTIONAL — run before applying this migration to
-- sanity-check the backfill set size):
--
--   SELECT COUNT(*) AS rows_to_backfill
--   FROM store_mgmt.email_messages
--   WHERE ticket_id IS NULL
--     AND classification_status IN (
--       'CLASSIFIED', 'UNCLASSIFIED_APP', 'UNCLASSIFIED_TYPE'
--     );
--   -- Expect: ~3 rows production (2026-04-23).
--   -- Flag if > 100 — investigate source (Gmail sync may have been
--   -- silently failing longer than expected, or a regression in wire).
--
-- Post-deploy verification (manual, via psql or Supabase SQL editor —
-- NOT part of the migration body):
--
--   -- All ticketable rows should have ticket_id populated
--   SELECT classification_status,
--          COUNT(*) AS total,
--          COUNT(ticket_id) AS with_ticket_id,
--          COUNT(*) - COUNT(ticket_id) AS without_ticket_id
--   FROM store_mgmt.email_messages
--   WHERE classification_status IN (
--     'CLASSIFIED', 'UNCLASSIFIED_APP', 'UNCLASSIFIED_TYPE'
--   )
--   GROUP BY classification_status;
--   -- Expect without_ticket_id = 0 for every row.
--
--   -- Spot-check the newly associated rows
--   SELECT em.id, em.classification_status, em.ticket_id, t.state
--   FROM store_mgmt.email_messages em
--   JOIN store_mgmt.tickets t ON t.id = em.ticket_id
--   WHERE em.received_at >= '2026-04-22'
--   ORDER BY em.received_at DESC
--   LIMIT 10;
-- ============================================================

DO $backfill$
DECLARE
  rec        RECORD;
  rpc_result JSONB;
  v_ok       INT := 0;
  v_fail     INT := 0;
BEGIN
  FOR rec IN
    SELECT id, classification_result
    FROM store_mgmt.email_messages
    WHERE ticket_id IS NULL
      AND classification_status IN (
        'CLASSIFIED', 'UNCLASSIFIED_APP', 'UNCLASSIFIED_TYPE'
      )
    ORDER BY received_at ASC  -- oldest first so lifecycle ordering holds
  LOOP
    BEGIN
      -- RPC performs atomic find-or-create + event-log writes.
      -- Return JSONB includes ticket_id which we use to back-fill.
      SELECT store_mgmt.find_or_create_ticket_tx(
               rec.classification_result,
               rec.id
             )
        INTO rpc_result;

      UPDATE store_mgmt.email_messages
         SET ticket_id = (rpc_result->>'ticket_id')::UUID
       WHERE id = rec.id;

      v_ok := v_ok + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Per-row savepoint rollback; outer transaction continues.
      -- Common causes: malformed classification_result (shouldn't occur
      -- — rows reached this migration only if classifier populated the
      -- column), RPC CONCURRENT_RACE_UNEXPECTED (indicates schema drift
      -- — would need follow-up investigation).
      v_fail := v_fail + 1;
      RAISE WARNING
        '[backfill-ticket-id] skipped email_message_id=%: % (SQLSTATE=%)',
        rec.id, SQLERRM, SQLSTATE;
    END;
  END LOOP;

  RAISE NOTICE
    '[backfill-ticket-id] complete: ok=%, fail=%',
    v_ok, v_fail;
END
$backfill$;

-- ============================================================
-- END — 20260423100000_store_mgmt_backfill_ticket_id
-- ============================================================
