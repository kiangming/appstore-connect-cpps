-- ============================================================
-- Google IAP Management — ONE-TIME backfill of apps.iaps_last_synced_at
-- (C2.1(a), arc arc-google-missing-purchase-options, 2026-10-16).
--
-- WHY. 20261016000000 added the column with NO backfill, so after deploy EVERY
-- app would be blocked by the D0 gate until someone Refreshed its IAP list —
-- the Manager reversed that (2026-10-16): only apps that NEVER had a complete
-- IAP Refresh stay blocked. The audit log is read ONCE, here. It does not
-- become logic state: no code reads actions_log for the gate (D0 unchanged).
--
-- SOURCE, per app ROW (target_id = apps.id — never package_name: two accounts
-- may hold the same package, UNIQUE (account, package) in init): the LATEST
-- actions_log row with
--   action_type = 'IAPS_LIST_SYNC'
--   AND a FULL refresh — the payload has neither 'scope' nor 'sku'. The
--       single-SKU "Sync from Google" route (since d8dce63, 2026-06-29) ALSO
--       logs IAPS_LIST_SYNC with synced:1, failed:0 + scope + sku; counting it
--       would unblock an app whose mirror holds only what the tool created —
--       the incident shape.
--   AND synced / failed / total are JSON numbers with failed = 0, synced > 0,
--       total = synced (anything else never throws — it just does not qualify)
--   AND NOT degraded — flag_reconcile_skipped is not 'incoming_below_…':
--       the refresh's own reconciler judged that read a suspicious subset
--       (iaps.ts reconcileDeletedOnGoogle). Rows before de787f1 carry no flag
--       keys at all and cannot be judged — accepted.
--   AND payload.package_name = apps.package_name
--   AND created_at >= 2026-05-21 14:52:44 UTC — commit c7edca0. Before it the
--       IAP list was ONE unpaginated legacy inappproducts.list call
--       (55b8c0a publisher-client.ts:72-81); google-api-reference.md records
--       it returning "2 / 30 items visible" in production that day.
--       ⚠ This is the COMMIT time; the Railway deploy time is unknown (the
--       next hotfixes landed 22:18 / 22:55 +07 the same evening). A refresh
--       logged in the commit→deploy gap still qualifies — the dry-run (D1)
--       flags every pick within 3 h after the cutoff for review.
-- and the app's mirror holds at least one item not flagged deleted-on-Google
-- today. Value = that row's created_at (DB clock; the route stamps with the app
-- clock milliseconds later).
--
-- ⚠ DIFFERS FROM THE REFRESH ROUTE (decideMirrorStamp, bulk-import-mirror-gate.ts),
--   which stamps when no row failed AND Google's list is non-empty OR the mirror
--   is empty (C2.1a: an empty list over a populated mirror is NOT complete). Here
--   EVERY 0-product refresh is excluded (Manager's wording "synced > 0"), and the
--   degraded / era / package / non-empty guards are extra. Every app they exclude
--   stays NULL ⇒ one Refresh click after deploy. Reported to the Manager, not hidden.
-- ⚠ failed = 0 cannot prove a FULL list when the new API threw and the legacy
--   fallback answered (a subset is possible; nothing in the audit row says so —
--   only Railway logs: "[google-iap:publisher] list fallback pkg=…").
-- ⚠ A stamp means "complete at T". T may be months old; products created in
--   Play Console outside the tool since T are not in the mirror. The wizard
--   shows T next to a "Refresh IAP list" button.
--
-- Only rows still NULL are written ⇒ idempotent. Run it ONCE, right before the
-- deploy; between it and the deploy nobody Refreshes (the old code would write
-- an audit row but no stamp, and still overwrites the app's currency/language).
-- The dry-run that predicts exactly these rows: docs/google-iap-management/
-- queries/verify-c1-c2-migrations.sql §C2.1 (same classification CTE).
-- Forward-only per CLAUDE.md. Touches ONLY apps.iaps_last_synced_at (and, via
-- the existing trigger, apps.updated_at). No mirror table is touched.
-- ============================================================

WITH params AS (
  SELECT TIMESTAMPTZ '2026-05-21 14:52:44+00' AS min_created_at
),
log AS (
  -- Payload values are cast ONLY when jsonb_typeof = 'number' (CASE fixes the
  -- evaluation order): "0", null, true, a missing key ⇒ NULL, never an error.
  SELECT l.id, l.target_id, l.created_at, l.payload,
    (jsonb_typeof(l.payload) = 'object') AS is_obj,
    CASE WHEN jsonb_typeof(l.payload) = 'object'
         THEN (l.payload ? 'scope' OR l.payload ? 'sku') ELSE false END AS is_single,
    CASE WHEN jsonb_typeof(l.payload->'synced') = 'number' THEN (l.payload->>'synced')::numeric END AS synced_n,
    CASE WHEN jsonb_typeof(l.payload->'failed') = 'number' THEN (l.payload->>'failed')::numeric END AS failed_n,
    CASE WHEN jsonb_typeof(l.payload->'total')  = 'number' THEN (l.payload->>'total')::numeric  END AS total_n
  FROM google_iap_mgmt.actions_log l
  WHERE l.action_type = 'IAPS_LIST_SYNC'
),
classified AS (
  SELECT g.*, a.id AS app_id,
    CASE
      WHEN NOT g.is_obj THEN 'bad_payload'
      WHEN g.is_single THEN 'single_item'
      WHEN g.synced_n IS NULL OR g.failed_n IS NULL OR g.total_n IS NULL THEN 'bad_payload'
      WHEN g.failed_n > 0 THEN 'failed'
      WHEN g.failed_n < 0 OR g.synced_n < 0 OR g.total_n <> g.synced_n + g.failed_n THEN 'inconsistent'
      WHEN g.synced_n = 0 THEN 'zero_products'
      WHEN COALESCE(g.payload->>'flag_reconcile_skipped', '') LIKE 'incoming_below%' THEN 'degraded'
      WHEN g.payload->>'package_name' IS DISTINCT FROM a.package_name THEN 'package_mismatch'
      WHEN g.created_at < p.min_created_at THEN 'pre_cutoff'
      ELSE 'ok'
    END AS cls
  FROM log g
  JOIN google_iap_mgmt.apps a ON a.id = g.target_id
  CROSS JOIN params p
),
qualifying AS (
  SELECT c.app_id, MAX(c.created_at) AS synced_at
  FROM classified c
  WHERE c.cls = 'ok'
  GROUP BY c.app_id
)
UPDATE google_iap_mgmt.apps a
   SET iaps_last_synced_at = q.synced_at
  FROM qualifying q
 WHERE a.id = q.app_id
   AND a.iaps_last_synced_at IS NULL
   AND EXISTS (SELECT 1 FROM google_iap_mgmt.iaps i
                WHERE i.app_id = a.id AND i.deleted_on_google_at IS NULL);

-- C2's comments said "Bulk import accepts declared only" — false since this
-- chunk (provenance is no longer a bulk-import condition).
COMMENT ON COLUMN google_iap_mgmt.apps.default_currency_source IS
  'Provenance of default_currency: declared (Manager) | guessed (tool, pre-2026-10-16). '
  'Display / declare only - NOT a bulk-import condition (20261016020000). '
  'NULL iff default_currency IS NULL.';
COMMENT ON COLUMN google_iap_mgmt.apps.default_language_source IS
  'Provenance of default_language: declared (Manager) | guessed (tool, pre-2026-10-16). '
  'Display / declare only - NOT a bulk-import condition (20261016020000). '
  'NULL iff default_language IS NULL.';

COMMENT ON COLUMN google_iap_mgmt.apps.iaps_last_synced_at IS
  'Last COMPLETE IAP Refresh (full list fetched, 0 rows failed, and not an empty list over '
  'a populated mirror). NULL = the IAP list of this app row was never refreshed completely: '
  'bulk import is blocked (D0). Written by the IAP refresh route (decideMirrorStamp). '
  'Backfilled ONCE by 20261016020000 from IAPS_LIST_SYNC history (full refresh, synced>0, '
  'failed=0, total=synced, not degraded, created_at >= 2026-05-21 14:52:44 UTC, mirror '
  'non-empty); never re-derived.';
