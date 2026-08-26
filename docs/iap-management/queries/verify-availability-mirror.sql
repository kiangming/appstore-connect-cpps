-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — [EXPORT-availability-filter] C1
-- Migration: supabase/migrations/20260828000000_iap_mgmt_iaps_availability_mirror.sql
--
-- Run these in the Supabase SQL Editor AFTER applying the migration.
-- Every query states its own PASS condition. Nothing here writes.
--
-- ⚠ The push gate is V1–V4. V5–V6 are the "did the code actually populate it"
--   checks — they are expected to return zeros BEFORE the feature ships and
--   are the ones to re-run after C2/C3/C4 land.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── V1. The three columns exist, with the right types and no NOT NULL. ─────
-- PASS: exactly 3 rows.
--       availability_state           | text        | YES
--       availability_territory_count | integer     | YES
--       availability_synced_at       | timestamp with time zone | YES
-- ⚠ is_nullable MUST be YES on all three. A NOT NULL here would make the
--   third state (never-synced) unrepresentable, which is the whole point.
SELECT column_name,
       data_type,
       is_nullable,
       column_default
FROM information_schema.columns
WHERE table_schema = 'iap_mgmt'
  AND table_name   = 'iaps'
  AND column_name IN (
        'availability_state',
        'availability_territory_count',
        'availability_synced_at'
      )
ORDER BY column_name;


-- ── V2. NO CHECK constraint was created on availability_state. ─────────────
-- PASS: 0 rows.
-- ⚠ This is a positive requirement, not an omission. Per KB §9 P2 a value
--   outside a CHECK is rejected SILENTLY, and this column is written from a
--   path whose write failure must not break the read it rides on.
SELECT con.conname,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class     rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'iap_mgmt'
  AND rel.relname = 'iaps'
  AND con.contype = 'c'
  AND pg_get_constraintdef(con.oid) ILIKE '%availability%';


-- ── V3. The unsynced-count index exists and is partial. ────────────────────
-- PASS: 1 row, and indexdef ends with `WHERE (availability_synced_at IS NULL)`.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'iap_mgmt'
  AND tablename  = 'iaps'
  AND indexname  = 'idx_iap_mgmt_iaps_availability_unsynced';


-- ── V4. Existing rows were not disturbed. ──────────────────────────────────
-- PASS: ALL THREE null-counts equal total_rows. That is the whole check, and
--       it is self-contained on purpose.
--
-- ⚠ DO NOT COMPARE total_rows AGAINST A REMEMBERED NUMBER. An earlier draft of
--   this file suggested "~6,954 (at census time)" and that caused a false
--   alarm on the very first run: live was 7,072, and the 118-row difference
--   looked like rows going missing from V7. It was not — the table had simply
--   grown since the census probe of 2026-08-25 (verified: rows created before
--   that date total exactly 6,954; the 118 newer ones are a stub-seed batch,
--   with 0 drafts, 0 orphans and 0 NULL app_id in the table). A hardcoded
--   expectation in a verify file goes stale the moment anyone uses the tool,
--   and a stale expectation reads as a defect.
-- ⚠ Every pre-existing row must read NULL = "never synced". A migration that
--   backfilled a default would have invented an availability verdict for
--   6,954 items nobody asked Apple about — the exact silent-upgrade this
--   feature exists to prevent.
SELECT COUNT(*)                                                  AS total_rows,
       COUNT(*) FILTER (WHERE availability_state           IS NULL) AS null_state,
       COUNT(*) FILTER (WHERE availability_territory_count IS NULL) AS null_count,
       COUNT(*) FILTER (WHERE availability_synced_at       IS NULL) AS null_synced_at
FROM iap_mgmt.iaps;


-- ═══ AFTER C2 / C3 / C4 SHIP — re-run these ════════════════════════════════

-- ── V5. Mirror population, and the shape of what landed. ───────────────────
-- Before the feature ships: one row, `(NULL, ...)` with count = total. Fine.
-- After: expect AVAILABLE and REMOVED rows to appear.
-- ⚠ FAIL if `availability_state` ever holds anything other than 'AVAILABLE',
--   'REMOVED', or NULL — that means a write bypassed the typed boundary (and,
--   per V2, no CHECK will have stopped it).
-- ⚠ FAIL if any row has availability_state NOT NULL while availability_synced_at
--   IS NULL, or vice versa. The two are written together, always.
SELECT COALESCE(availability_state, '(never synced)') AS state,
       COUNT(*)                                       AS rows,
       MIN(availability_territory_count)              AS min_territories,
       MAX(availability_territory_count)              AS max_territories,
       MIN(availability_synced_at)                    AS oldest_sync,
       MAX(availability_synced_at)                    AS newest_sync
FROM iap_mgmt.iaps
GROUP BY 1
ORDER BY 1;


-- ── V5b. The paired-write invariant, stated as a query. ────────────────────
-- PASS: 0 rows, always. A verdict without a timestamp cannot be dated, and a
--       timestamp without a verdict claims we asked and learned nothing.
SELECT id, product_id, availability_state, availability_synced_at
FROM iap_mgmt.iaps
WHERE (availability_state IS NULL) <> (availability_synced_at IS NULL)
LIMIT 50;


-- ── V5c. The verdict agrees with the count it was derived from. ────────────
-- PASS: 0 rows.
-- 'AVAILABLE' ⟺ territory_count > 0; 'REMOVED' ⟺ territory_count = 0.
-- A disagreement means something classified availability WITHOUT going
-- through availability-classify.ts.
SELECT id, product_id, availability_state, availability_territory_count
FROM iap_mgmt.iaps
WHERE availability_state IS NOT NULL
  AND (
        (availability_state = 'AVAILABLE' AND COALESCE(availability_territory_count, 0) <= 0)
     OR (availability_state = 'REMOVED'   AND COALESCE(availability_territory_count, 0) >  0)
      )
LIMIT 50;


-- ── V6. THE M3 WRITE-SIDE CHECK — the half that was hanging since U3. ──────
-- Census M3: `bulk-availability` wrote actions_log and NOTHING else, so a
-- Remove from Sales in the tool left both the State column and the
-- Availabilities column stale. C3 closes that. This query proves it did.
--
-- PASS after C3: every item with a recent AVAILABILITY_REMOVE_FROM_SALES audit
--       row has availability_state = 'REMOVED' and an availability_synced_at
--       at or after that audit row's created_at.
-- ⚠ Rows here with mirror_state = 'AVAILABLE' or NULL are mutation (e) live in
--   production — the tool removed the item on Apple and did not record it.
SELECT a.iap_id,
       i.product_id,
       a.action_type,
       a.created_at                  AS audited_at,
       i.availability_state          AS mirror_state,
       i.availability_synced_at      AS mirror_synced_at,
       (i.availability_synced_at >= a.created_at) AS mirror_is_fresh
FROM iap_mgmt.actions_log a
JOIN iap_mgmt.iaps i ON i.id = a.iap_id
WHERE a.action_type IN (
        'AVAILABILITY_REMOVE_FROM_SALES',
        'AVAILABILITY_SET_ALL_TERRITORIES',
        'AVAILABILITY_SET_TERRITORIES'
      )
ORDER BY a.created_at DESC
LIMIT 50;


-- ── V7. Per-app readiness — what the wizard's as-of label will say. ────────
-- Not a pass/fail; this is the number the Manager will see on screen, ahead of
-- seeing it. `oldest_sync` IS the as-of label (min, never max) and `unknown`
-- is the count rendered beside it.
--
-- ⚠ GROUPED BY ap.id, NOT ap.name. Three app names in this workspace are
--   currently held by two rows each — Lineage2M, Lineage W and Metal Slug:
--   Awakening — because the same title is registered under different ASC
--   accounts. Grouping by name silently merged those pairs into one line
--   (41 apps rendering as 38 rows), which is exactly the wrong shape for a
--   per-app readiness check: the Manager refreshes ONE app, and needs that
--   app's row to move.
--
-- ⚠ THE SUM OF `items` HERE EQUALS V4's total_rows. If it does not, that is a
--   real finding — but check the row count of this result first, because a
--   result summed from only the visible page will always look short.
SELECT ap.id                                                             AS app_id,
       ap.name                                                           AS app,
       COUNT(*)                                                          AS items,
       COUNT(*) FILTER (WHERE i.availability_synced_at IS NULL)           AS unknown,
       COUNT(*) FILTER (WHERE i.availability_state = 'AVAILABLE')         AS available,
       COUNT(*) FILTER (WHERE i.availability_state = 'REMOVED')           AS removed,
       MIN(i.availability_synced_at)                                      AS oldest_sync,
       MAX(i.availability_synced_at)                                      AS newest_sync
FROM iap_mgmt.iaps i
JOIN iap_mgmt.apps ap ON ap.id = i.app_id
WHERE i.apple_iap_id IS NOT NULL
GROUP BY ap.id, ap.name
ORDER BY unknown DESC, items DESC;


-- ── V8. The reconciliation, so nobody has to hand-sum V7 again. ────────────
-- PASS: `gap` = 0. Proves V7 accounts for every Apple-synced row.
-- (Local drafts, if any ever exist, are `total_rows - apple_synced` and are
--  correctly outside V7 — they have no Apple availability to read.)
SELECT (SELECT COUNT(*) FROM iap_mgmt.iaps)                                AS total_rows,
       (SELECT COUNT(*) FROM iap_mgmt.iaps WHERE apple_iap_id IS NOT NULL) AS apple_synced,
       (SELECT COUNT(*) FROM iap_mgmt.iaps WHERE apple_iap_id IS NULL)     AS local_drafts,
       (SELECT COUNT(*) FROM iap_mgmt.iaps i
          JOIN iap_mgmt.apps ap ON ap.id = i.app_id
         WHERE i.apple_iap_id IS NOT NULL)                                 AS v7_covers,
       (SELECT COUNT(*) FROM iap_mgmt.iaps WHERE apple_iap_id IS NOT NULL)
     - (SELECT COUNT(*) FROM iap_mgmt.iaps i
          JOIN iap_mgmt.apps ap ON ap.id = i.app_id
         WHERE i.apple_iap_id IS NOT NULL)                                 AS gap;
