-- C3 — Bulk Import PARTIAL: rows written to Apple with a stage missing.
--
-- WHY A COLUMN AND NOT A NEW `status` VALUE — the same reasoning C2 wrote for
-- not_attempted_count, and it applies harder here.
-- `import_batches.status` carries a CHECK ('PENDING','IN_PROGRESS','COMPLETE',
-- 'FAILED'). Adding a value would mean DROP + ADD CONSTRAINT, and per KB §9 P2
-- a value outside a CHECK is rejected SILENTLY on write —
-- `lib/audit-constraints/` guards that class of bug for
-- `actions_log.action_type` only, and does not reach this column.
--
-- ⚠ AND THE STATUS IS FROZEN BY DECISION, NOT ONLY BY COST.
-- [Q-C3.tracking-frozen]: the Manager froze every tracking/batch-level status
-- for C3. A batch containing PARTIAL rows still reports exactly what it
-- reported before C3 existed. The COUNTER is the channel through which the new
-- truth travels; the status deliberately says nothing new. Do not "finish the
-- job" later by teaching `status` about PARTIAL — that is a decision to make
-- with the Manager, not a loose end.
--
-- So "the batch left rows half-built" is a query, not a state:
--     WHERE partial_count > 0
--
-- Distinct from all three neighbours, and every distinction is load-bearing:
--   created_count       — rows that reached the end of the pipeline. NOTE this
--                         INCLUDES partial rows: they did write to Apple.
--   skipped_count       — the Manager chose SKIP at conflict resolution.
--   failed_count        — the row errored; nothing usable exists on Apple.
--   not_attempted_count — Apple's 429 survived retry and the pool stopped
--                         dispatching; nothing was sent, safe to re-run.
--   partial_count       — the IAP EXISTS on Apple but a stage is missing.
--                         Neither a success to ignore nor a failure to retry
--                         wholesale: re-running needs the Manager's
--                         ConflictMode choice ([Q-C3.rerun-A]).

ALTER TABLE iap_mgmt.import_batches
  ADD COLUMN IF NOT EXISTS partial_count INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN iap_mgmt.import_batches.partial_count IS
  'Rows created/updated on Apple with at least one stage missing (C3). '
  'Counted apart from created_count''s completeness but INCLUDED in it: a '
  'partial row did write to Apple. partial_count > 0 means the batch left '
  'rows half-built. The batch STATUS is deliberately unchanged by this '
  '([Q-C3.tracking-frozen]) — this counter is the channel.';
