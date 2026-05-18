-- ============================================================
-- IAP.o.12 — Expand actions_log.action_type for update-on-Apple flow
-- ============================================================
--
-- Adds the 5 action_type values the IAP.o.12a update-orchestration writes
-- inside its per-stage audit rows. Pricing changes reuse SET_PRICE_SCHEDULE
-- (added in IAP.o.11d) since the pricing orchestrator's audit log convention
-- already covers tier changes; no new pricing action_type needed here.
--
-- Forward-only per CLAUDE.md invariant 7: replace the CHECK with the full
-- allowed-values list. Same approach as the IAP.o.11d migration so the two
-- evolutions compose without down-migration risk.
--
-- Added values (5):
--   UPDATE_ATTRIBUTES_ON_APPLE     — PATCH /v2/inAppPurchases attributes
--   UPDATE_LOCALIZATION_ON_APPLE   — PATCH /v1/inAppPurchaseLocalizations/{id}
--   ADD_LOCALIZATION_ON_APPLE      — POST /v1/inAppPurchaseLocalizations
--   DELETE_LOCALIZATION_ON_APPLE   — DELETE /v1/inAppPurchaseLocalizations/{id}
--   REPLACE_SCREENSHOT_ON_APPLE    — IAP.o.8a replace flow under update

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
    'REPLACE_SCREENSHOT_ON_APPLE'
  ));
