-- PR-23 — Sync correctness + backfill diagnostic fields
--
-- Surfaces three production data-integrity bugs discovered after the
-- April 22 → May 6 OAuth blackout (consecutive_failures=215, last_full_sync_at
-- 14 days stale):
--
--   Bug A — INCREMENTAL: orchestrator called listHistory once and ignored
--           nextPageToken; pages 2+ silently skipped, cursor advanced to
--           response.historyId leaving a permanent gap.
--   Bug B — FALLBACK: listMessages('in:inbox') with maxResults=50 returned
--           only the 50 newest; cursor stamped to "now" → older messages
--           in the failure window lost.
--   Bug C — slice(0, maxBatch): IDs 51-100 of a single-page response
--           discarded before processing; cursor still advanced past them.
--
-- This migration unblocks the diagnostic fields; the orchestrator code in
-- the same PR consumes them. Existing rows get NULL for `recovery_since`
-- and the column defaults for `pages_fetched` / `stopped_early`, so old
-- rows remain readable without a backfill.
--
-- Forward-only per project rule (no down migrations).

-- 1. Extend sync_method to allow 'BACKFILL' (Manager-triggered recovery
--    from extended failure windows). Keeps 'MANUAL' reserved for future
--    use; not currently emitted by code.
ALTER TABLE store_mgmt.sync_logs
  DROP CONSTRAINT IF EXISTS sync_logs_sync_method_check;

ALTER TABLE store_mgmt.sync_logs
  ADD CONSTRAINT sync_logs_sync_method_check
  CHECK (sync_method IN ('INCREMENTAL', 'FALLBACK', 'MANUAL', 'BACKFILL'));

-- 2. Diagnostic columns. Defaults chosen so SQL aggregations don't need
--    NULL-coalesce: a row with `pages_fetched=0` was written before this
--    migration applied and is harmless to count.
ALTER TABLE store_mgmt.sync_logs
  ADD COLUMN IF NOT EXISTS pages_fetched   INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stopped_early   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recovery_since  TIMESTAMPTZ;

-- Read-only diagnostic index for the Manager's "BACKFILL audit" SQL —
-- partial index keeps it cheap; without WHERE it would carry every row.
CREATE INDEX IF NOT EXISTS idx_store_mgmt_sync_logs_backfill
  ON store_mgmt.sync_logs(ran_at DESC)
  WHERE sync_method = 'BACKFILL';
