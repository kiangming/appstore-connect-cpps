-- ============================================================
-- Migration: Store Management — PR-16a auto-mark-done foundation
--
-- Adds Manager opt-in flag per subject pattern. When TRUE, matching
-- emails với latest_outcome=APPROVED skip the Open queue and land
-- directly in DONE — see find_or_create_ticket_tx auto-DONE branch
-- (PR-16a.2 migration).
--
-- Default FALSE preserves pre-PR-16 behavior on every existing pattern;
-- Manager flips per-pattern via Settings → Email Rules UI after deploy.
--
-- Audit trail for auto-DONE actions lives in
-- ticket_entries.metadata JSONB (no new column):
--   metadata.actor   = 'system'
--   metadata.reason  = 'auto_mark_done_initial'
--                      | 'auto_mark_done_post_reclassify'
--                      | 'auto_reopen_rejected'   (PR-16b)
--                      | 'manager_reopen'         (PR-16b)
--   metadata.subject_pattern_id = uuid of the pattern that triggered
--
-- Design references:
--   docs/store-submissions/pr-16-auto-mark-done-design.md §3 Q4 + Q5
--
-- Schema-discrepancy note (recorded in PR-16a investigation):
--   The original design doc proposed `ALTER TABLE ticket_state_changes
--   ADD COLUMN reason`. That table does not exist — state changes are
--   tracked via ticket_entries with entry_type='STATE_CHANGE'. Reason
--   is therefore stored in the existing JSONB metadata column, matching
--   the convention already used by find_or_create_ticket_tx and
--   reclassify_email_tx.
-- ============================================================

ALTER TABLE store_mgmt.subject_patterns
ADD COLUMN auto_done_eligible BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN store_mgmt.subject_patterns.auto_done_eligible IS
  'PR-16: when TRUE, matching emails with latest_outcome=APPROVED trigger '
  'auto-mark-done in find_or_create_ticket_tx. Manager opt-in per pattern. '
  'Default FALSE preserves pre-PR-16 behavior. See '
  'docs/store-submissions/pr-16-auto-mark-done-design.md §3 Q5.';

-- ============================================================
-- END — 20260502000000_store_mgmt_pr16_auto_mark_done
-- ============================================================
