-- ============================================================
-- Google IAP Management — soft-delete flagging for items absent from Google.
--
-- Items deleted/renamed on the Play Console accumulate in the tool's cache
-- (an app can show e.g. 293 live on Google + 109 orphans = 402 in the DB).
-- Rather than hard-deleting on sync (a degraded fetch could wipe the live
-- catalog), the sync FLAGS absent items. They stay visible, sorted to the
-- bottom, and are removed only by explicit Manager action.
--
-- deleted_on_google_at:
--   NULL  → present on Google (normal item).
--   set   → flagged; records WHEN the item was first detected missing
--           (drives the "detected missing Jul 2" label). The reconcile
--           preserves the ORIGINAL detection date and clears the flag if
--           the item reappears in a later sync (self-correcting un-delete).
--
-- UNIQUE(app_id, sku) is retained (unchanged).
-- Forward-only per CLAUDE.md invariant.
-- ============================================================

ALTER TABLE google_iap_mgmt.iaps
  ADD COLUMN IF NOT EXISTS deleted_on_google_at TIMESTAMPTZ;

COMMENT ON COLUMN google_iap_mgmt.iaps.deleted_on_google_at IS
  'NULL = present on Google. Set = flagged deleted-on-Google (soft-delete); '
  'value is the first-detected-missing timestamp, preserved across syncs and '
  'cleared if the SKU reappears in Google''s response.';

-- Partial index: list/count of flagged items is per-app and filters on the
-- flag being set — a partial index keeps that cheap without bloating the
-- common (flag IS NULL) path.
CREATE INDEX IF NOT EXISTS idx_google_iap_mgmt_iaps_flagged
  ON google_iap_mgmt.iaps(app_id)
  WHERE deleted_on_google_at IS NOT NULL;

-- ------------------------------------------------------------
-- actions_log.action_type CHECK — additive expansion.
--   • IAP_ACKNOWLEDGE_REMOVE: new — Manager acknowledges + removes a
--     flagged (deleted-on-Google) item from the cache.
--   • BULK_ACTIVATE / BULK_DEACTIVATE: these are already emitted by the
--     app (Cycle 41 bulk-status) but were never added to the CHECK, so
--     those audit inserts silently violated the constraint. Closing that
--     latent gap here while the constraint is being edited.
-- Forward-only: drop + recreate the CHECK with the widened value set.
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
    'PRICING_TEMPLATE_UPLOAD'
  ));
