-- ============================================================================
-- Per-territory availability — widen actions_log.action_type
-- ============================================================================
--
-- ⚠ MANUAL APPLICATION REQUIRED (Path G). The Manager applies this via the
--   Supabase SQL Editor. THE FEATURE CANNOT RUN UNTIL IT IS APPLIED:
--   `AVAILABILITY_SET_TERRITORIES` would violate the CHECK, and both audit
--   writers deliberately swallow the error so a real Apple write would
--   succeed with no audit row and no visible failure (meta-rule P2's
--   silent failure mode — see lib/iap-management/action-types.ts:6-18).
--
-- WHY A NEW VALUE RATHER THAN REUSING THE OLD ONE
--
--   `AVAILABILITY_SET_ALL_TERRITORIES` was accurate while the tool could
--   only express "all" or "none". Once an arbitrary subset is possible the
--   name asserts something false about a row recording 12 territories —
--   the status principle (P5): a tracking value must reflect the real
--   outcome, never the button that was clicked.
--
--   Both values are retained and both are emitted:
--
--     AVAILABILITY_SET_ALL_TERRITORIES  — the genuine "All countries or
--       regions" case ONLY: the full catalogue plus
--       availableInNewTerritories = true. Historical rows therefore keep
--       meaning exactly what they meant when written, forever.
--
--     AVAILABILITY_SET_TERRITORIES      — NEW. Any explicit set, including
--       "every territory ticked by hand" (same ids, flag false — a
--       different Apple request; see KB §4.13).
--
--     AVAILABILITY_REMOVE_FROM_SALES    — unchanged, the empty set.
--
-- PAYLOAD CONTRACT (so a reader can reconstruct the set without Apple)
--   territories                  full list SENT, verbatim — not a diff
--   territory_count              its length
--   available_in_new_territories the flag actually sent
--   previous_territory_count     from the pre-read, when there was one
--   previous_known               false when the pre-read failed/was absent;
--                                never defaulted to a plausible number
--
-- FORWARD-ONLY (CLAUDE.md invariant #7). Reverting means a new migration
-- that re-creates the constraint without the value — which will fail if
-- any row already carries it, and that failure is correct.
--
-- Postgres validates a re-created CHECK against existing rows, so every
-- previously-allowed value is repeated below. Dropping one that historical
-- rows carry would make this ALTER fail.
-- ============================================================================

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
    'AVAILABILITY_REMOVE_FROM_SALES',
    'AVAILABILITY_SET_TERRITORIES',
    'CUSTOM_PRICES_SAVED',
    'CUSTOM_PRICES_CLEARED',
    'CUSTOM_PRICES_REBASELINE'
  ));
