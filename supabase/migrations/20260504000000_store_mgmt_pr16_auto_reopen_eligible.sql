-- ============================================================
-- Migration: Store Management — PR-16b.5 auto-reopen Manager opt-in
--
-- Adds `subject_patterns.auto_reopen_eligible` column gating the
-- auto-reopen branch of find_or_create_ticket_tx (PR-16b.3). Default
-- FALSE preserves the correct Apple workflow semantic ("build mới =
-- ticket mới" — REJECTED only arrives cho new builds, not as a
-- re-judgment of an already-approved build).
--
-- Manager domain insight (PR-16b post-deploy):
--   Apple's REJECTED workflow is per-build, not per-grouping-key.
--   PR-16b.3 auto-reopen-always merged distinct builds into one
--   ticket — semantically wrong. PR-16b.5 introduces opt-in flag;
--   the auto-reopen branch (find_or_create_ticket_tx stage b.5) is
--   gated by THIS column's value.
--
-- Mirrors PR-16a.1 auto_done_eligible pattern (migration
-- 20260502000000) — same Manager opt-in shape, same default-FALSE
-- back-compat strategy, same per-pattern granularity.
--
-- The auto-reopen branch's eligibility gate is added in migration
-- 20260504000002 (CREATE OR REPLACE find_or_create_ticket_tx).
-- This migration is forward-only schema; the RPC is updated
-- separately so the column exists trước RPC reads it.
--
-- Production state:
--   - If PR-16b.3 migration (20260503000001) was already applied,
--     auto-reopen fires on every REJECTED post-DONE — incorrect.
--     PR-16b.5 migration 20260504000002 fixes via the column gate.
--     No Manager has implicitly opted-in; default FALSE = effectively
--     disables auto-reopen across the board.
--   - If PR-16b.3 migration not applied, sequential application of
--     PR-16b.5's three migrations skips the auto-reopen-always
--     window entirely.
-- ============================================================

ALTER TABLE store_mgmt.subject_patterns
ADD COLUMN auto_reopen_eligible BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN store_mgmt.subject_patterns.auto_reopen_eligible IS
  'PR-16b.5: when TRUE, REJECTED emails matching pattern trigger auto-reopen '
  'of recent auto-DONE ticket cho same grouping key. Default FALSE preserves '
  '"build mới = ticket mới" Apple workflow semantic (REJECTED arrives only cho '
  'new builds, không re-judgment same build). Manager opt-in per pattern. '
  'Gated by find_or_create_ticket_tx stage (b.5) eligibility check (migration '
  '20260504000002). See docs/store-submissions/pr-16-auto-mark-done-design.md '
  '§3 Q2.D + Q3.B.';

-- ============================================================
-- END — 20260504000000_store_mgmt_pr16_auto_reopen_eligible
-- ============================================================
