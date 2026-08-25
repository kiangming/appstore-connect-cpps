-- C3 C-3 [Q-C3.conflict-read-B] — the conflict screen needs to know HOW a
-- product came to exist, not just THAT it exists.
--
-- Step 3 today asks one question — "is this product_id already on Apple?" —
-- and both answers look identical: a product finished cleanly and a product
-- left half-built by a rate-limited batch present as the same conflict row.
-- The Manager picks a ConflictMode blind to the difference. These two columns
-- are what let the row say which it is.
--
-- ⚠ THESE COLUMNS ARE A READ CACHE, NOT THE RECORD.
-- `iap_mgmt.actions_log` remains the full, append-only source of truth: every
-- bulk-import row writes a BULK_IMPORT_CREATE entry whose `payload` carries
-- the complete per-stage map plus the summary sentence, and the history of
-- every run. These two columns hold ONLY the most recent run's verdict, for
-- one reason: the conflict screen loads on a page render and must look the
-- answer up by (app_id, product_id), which is already UNIQUE and indexed on
-- this table. Reading it from actions_log would mean filtering on a JSONB
-- path with no supporting index — a sequential scan of an append-only table
-- that grows with every row of every batch, on every page load.
--
-- Consequences of that choice, stated so nobody mistakes the cache for the
-- record:
--   * Older runs are NOT here. Query actions_log for history.
--   * A row overwritten by a later batch shows only the later verdict.
--   * If these ever disagree with actions_log, actions_log wins.
--
-- ⚠ NULL MEANS "NEVER CAME THROUGH BULK IMPORT", and that is a third state,
-- distinct from both verdicts. Products created in the single-IAP form,
-- synced down from Apple, or predating this migration all read NULL. The
-- conflict screen must treat NULL as "no information", never as SUCCESS —
-- silently upgrading unknown to fine is how a half-built row would slip
-- through the exact screen this exists to inform.
--
-- No CHECK on last_import_status deliberately: per KB §9 P2 a value outside a
-- CHECK is rejected SILENTLY on write, and this column is written on a path
-- whose upsert failure is only logged (see persistResult). A constraint that
-- can silently discard the write would cost more than it protects, and the
-- writer is a single call site with a typed union at the boundary.

ALTER TABLE iap_mgmt.iaps
  ADD COLUMN IF NOT EXISTS last_import_status  TEXT,
  ADD COLUMN IF NOT EXISTS last_import_summary TEXT;

COMMENT ON COLUMN iap_mgmt.iaps.last_import_status IS
  'READ CACHE of the most recent bulk-import verdict for this product: '
  '''SUCCESS'' or ''PARTIAL''. NULL = this product never came through bulk '
  'import (single-IAP form, Apple sync, or predates C3) — treat NULL as NO '
  'INFORMATION, never as SUCCESS. Rows that ERRORed or were never attempted '
  'are deliberately NOT written here: nothing reached Apple, so there is no '
  'verdict to cache. iap_mgmt.actions_log (BULK_IMPORT_CREATE) is the full '
  'record and wins on any disagreement.';

COMMENT ON COLUMN iap_mgmt.iaps.last_import_summary IS
  'READ CACHE of the human sentence built from that run''s per-stage map, '
  'e.g. ''Created on Apple · 12/39 locales · missing screenshot''. Rendered '
  'on the Step 3 conflict row so the Manager can tell "exists because it '
  'finished" from "exists because a batch stopped part-way". NULL under the '
  'same conditions as last_import_status. The full per-stage map lives in '
  'iap_mgmt.actions_log payload.stages.';
