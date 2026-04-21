-- Gmail sync concurrency + stats (PR-7 Chunk 7.3)
-- ============================================================================
--
-- Two additive columns land together because they serve the same PR:
--
-- 1. `gmail_sync_state.locked_at` — table-based lock for the sync
--    orchestrator. Session-scoped `pg_try_advisory_lock` is the natural
--    fit, but Supabase's PostgREST pool uses short-lived connections, so
--    a session lock doesn't survive across the 20+ DB calls of a single
--    sync run. We instead acquire via an atomic
--    `UPDATE ... WHERE locked_at IS NULL OR locked_at < NOW() - stale`,
--    which uses Postgres' per-row MVCC lock to serialize concurrent
--    acquisitions (only one UPDATE's WHERE predicate sees NULL and
--    succeeds; the other observes the new timestamp and affects 0 rows).
--    `locked_by` stores a caller tag for debugging stale locks.
--
-- 2. `sync_logs.emails_dropped` — DROPPED is a distinct classification
--    outcome (sender didn't match any platform) from UNCLASSIFIED_*
--    (sender matched, but app/type didn't). Conflating them into
--    `emails_unclassified` would hide a different kind of noise
--    (spam / newsletter traffic) in aggregate dashboards, so a separate
--    counter belongs in the log.

ALTER TABLE store_mgmt.gmail_sync_state
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by TEXT;

ALTER TABLE store_mgmt.sync_logs
  ADD COLUMN IF NOT EXISTS emails_dropped INT NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- Lock helpers (RPC)
-- ----------------------------------------------------------------------------
--
-- Both exposed as `SECURITY INVOKER` (default) RPCs because the caller
-- already goes through the service-role client in `lib/store-submissions/db.ts`.
-- No need for SECURITY DEFINER privilege escalation.
--
-- `try_acquire_sync_lock`:
--   Returns TRUE when this call claims the lock (row went from
--   null-or-stale → NOW). Returns FALSE when another concurrent call
--   already holds a fresh lock. Acquisition is atomic via the single
--   UPDATE statement's per-row MVCC lock — two concurrent calls
--   serialize on the row, and only the first sees the predicate true.
--
-- `release_sync_lock`:
--   Idempotent — NULLs the lock fields regardless of current state. A
--   double-release (race between `finally` in sync run + stale-lock
--   reclaimer in a subsequent run) is a no-op.

CREATE OR REPLACE FUNCTION store_mgmt.try_acquire_sync_lock(
  p_locked_by       TEXT,
  p_stale_after_ms  INTEGER DEFAULT 600000  -- 10 minutes
) RETURNS BOOLEAN AS $$
DECLARE
  v_stale_before TIMESTAMPTZ := NOW() - (p_stale_after_ms || ' milliseconds')::INTERVAL;
  v_rows         INTEGER;
BEGIN
  UPDATE store_mgmt.gmail_sync_state
    SET locked_at = NOW(),
        locked_by = p_locked_by
    WHERE id = 1
      AND (locked_at IS NULL OR locked_at < v_stale_before);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION store_mgmt.release_sync_lock()
RETURNS VOID AS $$
  UPDATE store_mgmt.gmail_sync_state
    SET locked_at = NULL,
        locked_by = NULL
    WHERE id = 1;
$$ LANGUAGE sql;
