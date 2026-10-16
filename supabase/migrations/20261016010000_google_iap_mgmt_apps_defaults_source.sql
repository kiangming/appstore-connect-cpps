-- ============================================================
-- Google IAP Management — WHO set an app's currency / language (D9, arc
-- arc-google-missing-purchase-options, 2026-10-16).
--
-- WHY. apps.default_currency / default_language drive bulk-import pricing
-- (cross-currency resolution, refusal of Google Default, the generic "Price"
-- header). Until now the TOOL wrote them by guessing:
--   (a) apps-list refresh: currency guessed from the Play Console language
--       (zh-TW → TWD);
--   (b) IAP refresh: BOTH overwritten from the first product Google returned
--       (currency of its US region, language of its first listing or a
--       fabricated "en-US").
-- Google's v3 model has no app-wide currency at all. Incident: 彈彈英雄 held
-- TWD (guess a) at 03:21, USD (guess b) after 03:25 — USD is right only by luck.
--
-- From now on the values are DECLARED by the Manager; no code path writes them
-- automatically (refresh routes stopped writing — same arc, chunk C2).
--
-- <field>_source:
--   NULL       ⇔ value IS NULL (never set)
--   'guessed'  — value written by the tool before this migration. Shown with a
--                one-click "Confirm" in the UI. Bulk import REFUSES it.
--   'declared' — the Manager declared or confirmed it. The only state bulk
--                import accepts.
--
-- ⚠ EVERY EXISTING VALUE BECOMES 'guessed'. NOTHING is backfilled as
--   'declared' — that would make every app look declared, and the "not declared
--   ⇒ block import" guard would never fire (a guard over a state that cannot
--   exist — KB §29.4). Per field, so a currency can be confirmed while the
--   language is still pending (Manager, 2026-10-16: 彈彈英雄's language waits).
-- ⚠ Values are NOT changed. Only their provenance is recorded.
--
-- Also: actions_log CHECK gains APP_DEFAULTS_DECLARE (the declare action's
-- audit row). Without it the insert would be rejected — silently, since
-- appendAction only logs (KB §9 P2). Full list re-stated from
-- 20260702120000_google_iap_mgmt_deleted_on_google.sql + the new value.
--
-- Forward-only per CLAUDE.md.
-- ============================================================

ALTER TABLE google_iap_mgmt.apps
  ADD COLUMN IF NOT EXISTS default_currency_source TEXT,
  ADD COLUMN IF NOT EXISTS default_language_source TEXT;

-- Provenance of every value that exists today: the tool guessed it.
UPDATE google_iap_mgmt.apps
   SET default_currency_source = 'guessed'
 WHERE default_currency IS NOT NULL
   AND default_currency_source IS NULL;

UPDATE google_iap_mgmt.apps
   SET default_language_source = 'guessed'
 WHERE default_language IS NOT NULL
   AND default_language_source IS NULL;

ALTER TABLE google_iap_mgmt.apps
  DROP CONSTRAINT IF EXISTS apps_default_currency_source_check,
  DROP CONSTRAINT IF EXISTS apps_default_language_source_check;

-- Allowed values AND coherence in one CHECK per field: a source without a value,
-- a value without a source, and a 'declared' blank value are all rejected.
-- ⚠ The explicit `_source IS NOT NULL` is load-bearing: `NULL IN (...)` is NULL,
--   and a CHECK whose expression is NULL PASSES — without it, a value written
--   with no provenance would be accepted (measured on PGlite before this fix).
-- ⚠ A blank value ('' — some rows hold one today) may stay 'guessed' (it blocks
--   import either way); it can never be 'declared'.
ALTER TABLE google_iap_mgmt.apps
  ADD CONSTRAINT apps_default_currency_source_check CHECK (
    (default_currency IS NULL AND default_currency_source IS NULL)
    OR (default_currency IS NOT NULL AND default_currency_source IS NOT NULL
        AND default_currency_source IN ('declared', 'guessed')
        AND (default_currency_source <> 'declared' OR btrim(default_currency) <> ''))
  ),
  ADD CONSTRAINT apps_default_language_source_check CHECK (
    (default_language IS NULL AND default_language_source IS NULL)
    OR (default_language IS NOT NULL AND default_language_source IS NOT NULL
        AND default_language_source IN ('declared', 'guessed')
        AND (default_language_source <> 'declared' OR btrim(default_language) <> ''))
  );

COMMENT ON COLUMN google_iap_mgmt.apps.default_currency_source IS
  'Provenance of default_currency: declared (Manager) | guessed (tool, pre-2026-10-16). '
  'Bulk import accepts declared only. NULL iff default_currency IS NULL.';
COMMENT ON COLUMN google_iap_mgmt.apps.default_language_source IS
  'Provenance of default_language: declared (Manager) | guessed (tool, pre-2026-10-16). '
  'Bulk import accepts declared only. NULL iff default_language IS NULL.';

-- ------------------------------------------------------------
-- actions_log.action_type CHECK — additive: APP_DEFAULTS_DECLARE.
-- ------------------------------------------------------------
ALTER TABLE google_iap_mgmt.actions_log
  DROP CONSTRAINT IF EXISTS actions_log_action_type_check;

ALTER TABLE google_iap_mgmt.actions_log
  ADD CONSTRAINT actions_log_action_type_check CHECK (action_type IN (
    'ACCOUNT_CREATE',
    'ACCOUNT_VERIFY',
    'ACCOUNT_DELETE',
    'APPS_SYNC',
    'IAPS_LIST_SYNC',
    'IAP_CREATE',
    'IAP_UPDATE',
    'IAP_DELETE',
    'IAP_ACKNOWLEDGE_REMOVE',
    'BULK_IMPORT_BATCH',
    'BULK_ACTIVATE',
    'BULK_DEACTIVATE',
    'PRICING_TEMPLATE_UPLOAD',
    'APP_DEFAULTS_DECLARE'
  ));
