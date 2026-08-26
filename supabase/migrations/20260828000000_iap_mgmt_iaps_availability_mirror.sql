-- [EXPORT-availability-filter] C1 — the availability mirror.
--
-- WHY THIS EXISTS AT ALL.
-- Until now the tool read Apple availability constantly and kept none of it.
-- `AvailabilityCell` fetched 2 Apple requests per item, held the answer in a
-- per-cell `useState`, and threw it away on unmount. Census M2 found no cache
-- at any layer: no DB column, no lifted state, `cache: "no-store"` on the
-- fetch, no cache on the route. Cuộn hết một trang 100 item = 200 Apple
-- requests, every single time, for an answer we already had five minutes ago.
--
-- These three columns are where that answer now lands. They are what makes
-- [Q-EXPORT-avail.mirror] possible: the export wizard filters
-- Available/Removed/Unknown with ZERO Apple requests, reading these, and
-- labels the result honestly with `availability_synced_at`.
--
-- ⚠ NULL IS A THIRD STATE AND IT IS LOAD-BEARING.
-- `availability_synced_at IS NULL` means NOBODY HAS EVER ASKED APPLE about
-- this item. It is NOT "removed" and it is emphatically NOT "available". The
-- export wizard renders it as **Unknown** and a filter for Available must
-- never return it. This is the U3 bug class written into the schema: the
-- earlier `include=inAppPurchaseAvailability` idea would have marked every
-- removed item Available because Apple never omits the relationship (measured
-- 0/29 missing, design-export-list-item-selection.md PART 1.5). Anything that
-- silently upgrades unknown → available reproduces that defect through a new
-- door. Three states, always three.
--
-- ⚠ NO CHECK CONSTRAINT ON `availability_state`, DELIBERATELY.
-- Same reasoning as `iaps.last_import_status` (20260827000000): per KB §9 P2 a
-- value outside a CHECK is rejected by Postgres SILENTLY, and if the calling
-- code does not inspect `error` the write vanishes with no trace. This column
-- is written from a read-through path inside a GET route, where a failed write
-- must never break the read. A constraint that can silently discard the write
-- would cost more than it protects. The union is enforced at the TypeScript
-- boundary instead, at a small number of call sites, and every write here
-- checks its `error`.
--
-- ⚠ THIS IS A CACHE, NOT THE RECORD. Apple is the record.
-- `iap_mgmt.actions_log` remains the append-only history of every availability
-- mutation this tool made (AVAILABILITY_SET_ALL_TERRITORIES /
-- AVAILABILITY_SET_TERRITORIES / AVAILABILITY_REMOVE_FROM_SALES). These
-- columns hold ONLY the latest observed state, for one reason: the wizard and
-- the list column look items up by app on a page render, and this table is
-- already indexed for that. If these ever disagree with Apple, Apple wins —
-- which is exactly what `availability_synced_at` exists to let a human judge.
--
-- ⚠ STOP-AND-PRESERVE WRITES NOTHING FOR THE ITEMS IT DID NOT REACH.
-- The C4 Refresh path stops on rate-limit exhaustion and preserves its
-- remainder. Items it never reached keep their OLD `availability_synced_at` —
-- including NULL. Stamping "now" on an item nobody asked Apple about would
-- make the as-of label lie about precisely the data the label exists to date.

ALTER TABLE iap_mgmt.iaps
  ADD COLUMN IF NOT EXISTS availability_state           TEXT,
  ADD COLUMN IF NOT EXISTS availability_territory_count INT,
  ADD COLUMN IF NOT EXISTS availability_synced_at       TIMESTAMPTZ;

-- The wizard's and the list's read is always "every item of one app", which
-- `idx_iap_mgmt_iaps_app` already serves. This partial index serves the other
-- question the feature asks — "which items of this app have never been
-- synced?" — the Unknown count rendered next to the as-of label.
CREATE INDEX IF NOT EXISTS idx_iap_mgmt_iaps_availability_unsynced
  ON iap_mgmt.iaps(app_id)
  WHERE availability_synced_at IS NULL;

COMMENT ON COLUMN iap_mgmt.iaps.availability_state IS
  'CACHE of Apple''s availability verdict for this item, as of '
  'availability_synced_at: ''AVAILABLE'' (Apple has an availability resource '
  'with >=1 territory) or ''REMOVED'' (no resource, or a resource with zero '
  'territories). NULL = never read from Apple, which is UNKNOWN — a third '
  'state, never to be folded into AVAILABLE. Classification is '
  'lib/iap-management/apple/availability-classify.ts and nothing may '
  'reclassify independently of it. A failed or rate-limited read writes '
  'NOTHING here: an error is not a verdict.';

COMMENT ON COLUMN iap_mgmt.iaps.availability_territory_count IS
  'CACHE of how many Apple territories the item sold in at '
  'availability_synced_at. Kept alongside the verdict because 0 vs 42 vs 175 '
  'is the difference between removed, a deliberate subset, and the whole '
  'catalogue — and the two-value verdict cannot express the middle one. NULL '
  'under the same conditions as availability_state.';

COMMENT ON COLUMN iap_mgmt.iaps.availability_synced_at IS
  'When Apple was last successfully ASKED about this item''s availability. '
  'NULL = never. This is the timestamp behind the "as of last sync" label on '
  'the export wizard and the IAP list; the label shows the MINIMUM across the '
  'items on screen, never the maximum, because the honest answer to "how old '
  'is what I am looking at" is the oldest row in it. Only a real answer '
  'advances this — a rate-limited read, a failed read, and an item a stopped '
  'Refresh never reached all leave it exactly as it was.';
