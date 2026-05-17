-- ============================================================
-- IAP.o.11d — Expand actions_log.action_type CHECK constraint
-- ============================================================
--
-- The IAP.o.6 → IAP.o.11 hotfix run introduced 7 new action_types in code
-- without updating the database constraint, so every audit-log INSERT for
-- those types was failing silently. The previous route-handler-side INSERTs
-- did not check `error` on the response; IAP.o.11a's audit-log relocation
-- into the orchestrator + error-checking surfaced the constraint violation
-- in Railway logs, which traces the Manager-reported "no log or error"
-- symptom directly to hypothesis H4 (audit-write fails silently).
--
-- Forward-only per CLAUDE.md invariant 7: replace the CHECK with the full
-- allowed-values list rather than dropping then re-creating.
--
-- Allowed values after this migration (15 total):
--   pre-existing (8):
--     CREATE_IAP, UPDATE_IAP, DELETE_IAP, UPLOAD_SCREENSHOT,
--     SUBMIT_TO_APPLE, SYNC_FROM_APPLE, PRICE_TIER_IMPORT,
--     BULK_IMPORT_BATCH
--   added IAP.o.11d (7):
--     CREATE_ON_APPLE          — single-IAP /create-on-apple route
--     SET_PRICE_SCHEDULE       — pricing orchestrator (IAP.o.11a)
--     BULK_IMPORT_CREATE       — bulk-import per-row CREATE result
--     BULK_IMPORT_OVERWRITE_SCREENSHOT — bulk-import OVERWRITE screenshot
--     BULK_IMPORT_SUBMIT       — bulk-import per-row SUBMIT result
--     SUBMIT_APPLE_REVIEW      — list-page multi-select Submit Selected
--     SYNC_STATE_FROM_APPLE    — sync-states bulk refresh

ALTER TABLE iap_mgmt.actions_log
  DROP CONSTRAINT IF EXISTS actions_log_action_type_check;

ALTER TABLE iap_mgmt.actions_log
  ADD CONSTRAINT actions_log_action_type_check CHECK (action_type IN (
    'CREATE_IAP',
    'UPDATE_IAP',
    'DELETE_IAP',
    'UPLOAD_SCREENSHOT',
    'SUBMIT_TO_APPLE',
    'SYNC_FROM_APPLE',
    'PRICE_TIER_IMPORT',
    'BULK_IMPORT_BATCH',
    'CREATE_ON_APPLE',
    'SET_PRICE_SCHEDULE',
    'BULK_IMPORT_CREATE',
    'BULK_IMPORT_OVERWRITE_SCREENSHOT',
    'BULK_IMPORT_SUBMIT',
    'SUBMIT_APPLE_REVIEW',
    'SYNC_STATE_FROM_APPLE'
  ));
