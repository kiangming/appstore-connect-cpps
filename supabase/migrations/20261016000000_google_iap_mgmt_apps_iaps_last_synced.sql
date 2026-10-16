-- ============================================================
-- Google IAP Management — apps.iaps_last_synced_at (D0, arc
-- arc-google-missing-purchase-options, 2026-10-16).
--
-- WHY. Bulk-import preview decides NEW vs EXISTING from the IAP mirror
-- (google_iap_mgmt.iaps) only. For com.vnggames.ballisticherotwid the
-- mirror had NEVER been filled (no IAP Refresh since the app row was
-- created 2026-05-21), so 28 SKUs that already existed on Google were
-- previewed as NEW → sent as CREATE → Google: "Product must list all of
-- its existing purchase options". "Never read" was treated as "read and
-- found empty".
--
-- iaps_last_synced_at:
--   NULL → the IAP list of this app row has NEVER been refreshed from Google
--          completely ⇒ the mirror must NOT be trusted as "no item exists";
--          bulk-import preview and execute refuse until a Refresh succeeds.
--   set  → time of the last IAP Refresh that fetched the FULL list AND wrote
--          every product into the mirror with 0 failures. Written only by
--          app/api/google-iap-management/apps/[packageName]/iaps/refresh.
--          Never written by single-item price sync, bulk import or create.
--
-- ⚠ NO BACKFILL, on purpose (Manager, 2026-10-16: "audit log là audit" —
--   actions_log is not logic state). Every app must be Refreshed once after
--   this deploy before its next bulk import. That is the fail-safe direction:
--   the cost is one click; the alternative is trusting an audit row whose
--   insert may have been swallowed (actions-log.ts appendAction).
--
-- Additive, nullable, no default. Forward-only per CLAUDE.md.
-- ============================================================

ALTER TABLE google_iap_mgmt.apps
  ADD COLUMN IF NOT EXISTS iaps_last_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN google_iap_mgmt.apps.iaps_last_synced_at IS
  'Last COMPLETE IAP Refresh (full list fetched, 0 rows failed). NULL = IAP '
  'list never refreshed for this app row: bulk import is blocked (D0). '
  'Written only by the IAP refresh route. Not backfilled.';
