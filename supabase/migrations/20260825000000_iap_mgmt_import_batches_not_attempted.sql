-- C2 — Bulk Import stop latch: rows the batch never dispatched.
--
-- WHY A COLUMN AND NOT A NEW `status` VALUE.
-- `import_batches.status` carries a CHECK constraint
-- ('PENDING','IN_PROGRESS','COMPLETE','FAILED'). Adding 'STOPPED' would mean
-- DROP + ADD CONSTRAINT, and — per KB §9 P2 — a value outside a CHECK is
-- rejected SILENTLY on write. `lib/audit-constraints/` guards exactly this
-- class of bug, but only for `actions_log.action_type`; it does not reach
-- this column. An additive, defaulted column sidesteps the enum entirely,
-- leaves the other two writers of this table (price-tiers import,
-- pricing-templates import) untouched, and carries the row COUNT rather than
-- a single "it stopped" bit.
--
-- "The batch stopped early" is then a query, not a state:
--     WHERE not_attempted_count > 0
--
-- Distinct from `skipped_count`, and the distinction is load-bearing:
--   skipped_count       — the Manager chose SKIP at conflict resolution.
--   not_attempted_count — Apple's rate limit survived retry and the pool
--                         stopped dispatching. Nothing was sent for these
--                         rows, so they are the ones safe to re-run.

ALTER TABLE iap_mgmt.import_batches
  ADD COLUMN IF NOT EXISTS not_attempted_count INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN iap_mgmt.import_batches.not_attempted_count IS
  'Rows the batch never dispatched because an Apple 429 survived retry. '
  'Distinct from skipped_count (Manager chose SKIP at conflict resolution). '
  'not_attempted_count > 0 means the batch stopped early.';
