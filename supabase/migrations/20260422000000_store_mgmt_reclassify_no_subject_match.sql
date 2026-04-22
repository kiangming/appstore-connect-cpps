-- Reclassify NO_SUBJECT_MATCH ERROR rows as DROPPED / SUBJECT_NOT_TRACKED
-- ============================================================================
--
-- Semantic correction: configured subject patterns are a whitelist of
-- event types Managers explicitly track per platform. Apple (and other
-- stores) routinely send unrelated mail from the same senders ("Status
-- Update", "Ready for Distribution", "IAP Approved", weekly digests).
-- Prior to 2026-04-22 the classifier flagged these as ERROR / NO_SUBJECT_MATCH,
-- which bumped `sync_logs.emails_errored`, blocked cursor advance via
-- `stats.errors > 0`, and ticked `gmail_sync_state.consecutive_failures`
-- on every sync batch that contained one — pure operational noise, never
-- a real failure.
--
-- Post-fix: sender match + no subject pattern match = DROPPED /
-- SUBJECT_NOT_TRACKED. ERROR is reserved for true processing failures
-- (REGEX_TIMEOUT, PARSE_ERROR, NO_RULES).
--
-- This migration backfills ~19 historical rows (count as of 2026-04-22).
-- The WHERE clause filters on the source error_code, so the migration is
-- idempotent and re-run safe.
--
-- Forward-only per invariant #7 (CLAUDE.md). No down migration.
-- ============================================================================

SET search_path = store_mgmt, public;

UPDATE store_mgmt.email_messages
SET
  classification_status = 'DROPPED',
  classification_result = (
    (classification_result - 'error_code' - 'error_message')
    || jsonb_build_object(
         'status', 'DROPPED',
         'reason', 'SUBJECT_NOT_TRACKED'
       )
  ),
  error_message = NULL
WHERE classification_status = 'ERROR'
  AND classification_result ->> 'error_code' = 'NO_SUBJECT_MATCH';
