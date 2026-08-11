-- ============================================================
-- P2 FIX — actions_log.action_type CHECK missing the AVAILABILITY_* values
-- ============================================================
--
-- LIVE DATA LOSS. Cycle 37 Phase 1 + Cycle 39 Phase 1 + Cycle 40 Phase A
-- shipped the IAP availability write paths, which emit two action_type
-- values that were NEVER added to the CHECK constraint. Every one of those
-- audit inserts has been rejected by Postgres since those features shipped:
--
--   AVAILABILITY_SET_ALL_TERRITORIES
--     app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts:380
--     app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts:850
--     lib/iap-management/apple/update-orchestration.ts:577-590   (Stage 5)
--     lib/iap-management/orchestrators/bulk-availability.ts:164  (bulk)
--
--   AVAILABILITY_REMOVE_FROM_SALES
--     lib/iap-management/apple/update-orchestration.ts:577-580   (Stage 5)
--     lib/iap-management/orchestrators/bulk-availability.ts:164  (bulk)
--
-- Why it was silent: both writers log the INSERT error to the Railway
-- console but deliberately never throw (the audit write must not fail a
-- real Apple mutation). So the Apple-side write succeeded, the operator saw
-- success, and the audit row simply never existed.
--
-- This is meta-rule P2 (KB §10.13.K) recurring after being documented:
-- "New action_type values are silently ignored when the DB CHECK constraint
-- doesn't include them." The rule existed and was still missed, so this
-- migration ships alongside a STRUCTURAL guard that fails at test time —
-- lib/iap-management/action-types.ts + action-types.test.ts.
--
-- SCOPE: this migration does nothing but widen the CHECK. It is deliberately
-- NOT bundled with the per-territory custom-prices feature migration —
-- coupling a live production fix to unstarted feature work would delay the
-- fix until the feature ships.
--
-- Audit performed while writing this (full comparison in the cycle report):
--   emitted in code, distinct .............. 20
--   present in latest CHECK (20260518000000) 20
--   emitted but MISSING from CHECK .......... 2  ← fixed here
--   in CHECK but never emitted .............. 2  (UPLOAD_SCREENSHOT,
--                                                SYNC_FROM_APPLE — historical
--                                                rows may exist; retained)
--
-- Forward-only per CLAUDE.md invariant 7: drop + recreate the CHECK with the
-- full allowed-values list, same approach as 20260517000000 / 20260518000000
-- so the three evolutions compose without down-migration risk.
--
-- Added values (2):
--   AVAILABILITY_SET_ALL_TERRITORIES — POST /v1/inAppPurchaseAvailabilities
--                                      with the full territory list
--   AVAILABILITY_REMOVE_FROM_SALES   — the same POST with an empty territory
--                                      list (KB §4.12: Apple exposes ONE
--                                      write endpoint; "Remove from Sales"
--                                      is a re-POST with no territories)
-- ============================================================

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
    'SYNC_STATE_FROM_APPLE',
    'UPDATE_ATTRIBUTES_ON_APPLE',
    'UPDATE_LOCALIZATION_ON_APPLE',
    'ADD_LOCALIZATION_ON_APPLE',
    'DELETE_LOCALIZATION_ON_APPLE',
    'REPLACE_SCREENSHOT_ON_APPLE',
    'AVAILABILITY_SET_ALL_TERRITORIES',
    'AVAILABILITY_REMOVE_FROM_SALES'
  ));
