-- ═══════════════════════════════════════════════════════════════════════════
-- CENSUS — [GOOGLE-bulkimport-drop-gt] Is the team using GT Price / GT Currency?
-- Design: docs/google-iap-management/design-bulkimport-drop-gt-columns.md
--
-- Run in the Supabase SQL Editor, ONE block at a time (the Editor shows only the
-- last statement's result). Nothing here writes. Every block returns a TOTAL row
-- even on empty tables, so "0" can never be confused with "no data".
--
-- ⚠ RUN THIS BEFORE ANY GT-DROP CODE IS DEPLOYED. A-block reads the H4.4 audit
--   shape (per_row_pricing[].gt / gt_outcome, pricing_rule 'file-currency-only/v1');
--   rows written by a later code version would show as gt_shape_unexpected.
--
-- Measured (2026-10-20, census lane G4 + critic): the three statements were run
-- verbatim on Postgres 17.5 (PGlite) with the real google_iap_mgmt migrations,
-- loaded with the audit rows the REAL current code writes (template generator →
-- preview route → wizard payload builder → execute route → orchestrator →
-- appendAction; Google mocked and recorded), plus old-code (375b735) rows. Each
-- result equalled totals computed independently; two deliberately wrong SQL
-- variants failed the check.
--
-- HOW TO READ (in this order):
--   1) B first. Shape 1 = batches since H4.4 that recorded per-row pricing.
--      Shape 1 = 0 ⇒ A's zeros mean "no Google bulk import since H4.4", NOT
--      "nobody uses GT". Shape 3 must be 0. Shape 2 = batches that threw (GT
--      unknown). Shape 5 = an import_batches row with no audit row.
--   2) A. Cross-check: A TOTAL batches_recorded = B shape-1 n, and
--      rows_in_audit = B shape-1 per_row_pricing_entries.
--      - gt_kept_on_google > 0 ⇒ the team RELIES on GT: those products got their
--        store price for that country from the GT column. Removing GT changes
--        exactly these rows in future imports. (EXACT count.)
--      - rows_with_gt + gt_refused_in_file ⇒ rows where GT cells were filled —
--        a FLOOR, not a count: a row refused for a NON-GT reason (empty / 0 /
--        over-precise main price, no Product ID) never shows its GT (measured:
--        8 filled rows, 4 counted).
--   3) C. Before H4.4 the code recorded NO GT field (measured on 375b735) ⇒ the
--      GT count before 2026-10-19 is CHƯA BIẾT. C lists the imports that COULD
--      have used GT with their source FILE NAMES — the tool does not keep the
--      uploaded files, only the name, so the files must come from the uploaders.
--      gt_trace_* is a floor (VN only, refused Custom rows only, since 2026-08-07).
-- ═══════════════════════════════════════════════════════════════════════════


-- @@ BEGIN G4-B — is per-row pricing recorded at all? (run FIRST)
-- G4-B · Is per-row pricing recorded at all? — every Google BULK_IMPORT_BATCH audit row and every
-- import_batches row, classified by the shape of its audit payload. READ-ONLY. One statement.
-- The first row is the TOTAL; it is there even when both tables are empty (all 0).
-- Shapes (orchestration/bulk-import.ts at 64557c9 / 121f2b1):
--   1  per_row_pricing present       — success, nothing-to-push and Google-rejected paths (H4.4+)
--   2  closed_by = finally           — the batch threw before its own audit (H4.4+): NO per-row data, by design
--   3  pricing_rule, no per_row_pricing, not finally — must be 0 (a code path writing without per-row data)
--   4  no pricing_rule               — written by the code before H4.4 (no GT field exists in it)
--   5  import_batches row, no audit  — the audit insert never happened (pre-H4.4 throw, or a swallowed insert)
-- H4.4 reached origin/main at 2026-10-19 21:26:42 +07 (local reflog of the push); Railway deploy time unknown,
-- so a few shape-4 rows just after that instant are the old code still serving, not an error.
WITH a AS (
  SELECT l.id AS log_id,
         l.created_at,
         l.payload ->> 'batch_id' AS batch_id,
         CASE WHEN jsonb_typeof(l.payload -> 'per_row_pricing') = 'array'
              THEN jsonb_array_length(l.payload -> 'per_row_pricing') ELSE 0 END AS n_rows,
         CASE
           WHEN jsonb_typeof(l.payload -> 'per_row_pricing') = 'array' THEN '1 H4.4+: per_row_pricing present'
           WHEN l.payload ->> 'closed_by' = 'finally'                  THEN '2 H4.4+: closed_by=finally (no per-row data by design)'
           WHEN l.payload ? 'pricing_rule'                             THEN '3 H4.4+: pricing_rule but NO per_row_pricing (UNEXPECTED)'
           ELSE                                                             '4 pre-H4.4 shape (no pricing_rule) - GT not recorded'
         END AS shape
  FROM google_iap_mgmt.actions_log l
  WHERE l.action_type = 'BULK_IMPORT_BATCH'
),
j AS (
  SELECT COALESCE(a.shape, '5 import_batches row with NO audit row') AS shape,
         COALESCE(a.created_at, ib.created_at)                       AS at,
         a.log_id,
         ib.id                                                       AS ib_id,
         COALESCE(a.n_rows, 0)                                       AS n_rows
  FROM a
  FULL OUTER JOIN google_iap_mgmt.import_batches ib ON ib.id::text = a.batch_id
)
SELECT CASE WHEN GROUPING(shape) = 1 THEN '== TOTAL ==' ELSE shape END            AS shape,
       count(*)                                                                    AS n,
       count(*) FILTER (WHERE at <  TIMESTAMPTZ '2026-10-19 21:26:42+07')          AS before_h44_push,
       count(*) FILTER (WHERE at >= TIMESTAMPTZ '2026-10-19 21:26:42+07')          AS after_h44_push,
       count(*) FILTER (WHERE log_id IS NOT NULL)                                  AS audit_rows,
       count(*) FILTER (WHERE log_id IS NOT NULL AND ib_id IS NULL)                AS audit_without_import_batch,
       COALESCE(sum(n_rows), 0)                                                    AS per_row_pricing_entries,
       min(at)                                                                     AS first_at,
       max(at)                                                                     AS last_at
FROM j
GROUP BY GROUPING SETS ((shape), ())
ORDER BY GROUPING(shape) DESC, shape;
-- @@ END


-- @@ BEGIN G4-A — GT usage since H4.4, by app × actor
-- G4-A · Is the team using GT? — every Google bulk import that recorded per-row pricing (H4.4+), by app × actor.
-- READ-ONLY. One statement. The first row is the TOTAL; it is there even when nothing matches (all 0).
-- A row of the file "has a GT" when its per_row_pricing entry carries gt = {region, currency, price}
-- (orchestration/bulk-import.ts, perRowPricingByRow). gt_outcome says what the GT did:
--   kept               = the GT was the country's price in the request to Google
--   replaced_by_tier   = a pricing-template tier replaced it      replaced_by_custom = custom prices replaced it
--   not_sent           = the row was not sent (Skip, or refused)  none = no GT on the row
-- Rows refused IN THE FILE (never in per_row_pricing) are counted from refused_rows when their reason names GT.
WITH batch AS (
  SELECT l.created_at,
         l.actor_email,
         l.target_id,
         l.payload ->> 'package_name' AS package_name,
         l.payload -> 'per_row_pricing' AS prp,
         CASE WHEN jsonb_typeof(l.payload -> 'refused_rows') = 'array'
              THEN l.payload -> 'refused_rows' ELSE '[]'::jsonb END AS refused
  FROM google_iap_mgmt.actions_log l
  WHERE l.action_type = 'BULK_IMPORT_BATCH'
    AND jsonb_typeof(l.payload -> 'per_row_pricing') = 'array'
),
per_batch AS (
  SELECT b.created_at, b.actor_email, b.target_id, b.package_name, r.*, f.gt_refused_in_file
  FROM batch b
  CROSS JOIN LATERAL (
    SELECT count(*)                                                                           AS n_rows,
           count(*) FILTER (WHERE jsonb_typeof(e -> 'gt') = 'object')                          AS n_gt,
           count(*) FILTER (WHERE e ->> 'gt_outcome' = 'kept')                                 AS n_kept,
           count(*) FILTER (WHERE e ->> 'gt_outcome' = 'kept'
                              AND e ->> 'outcome' IN ('written', 'cache_sync_failed'))         AS n_kept_on_google,
           count(*) FILTER (WHERE e ->> 'gt_outcome' = 'kept'
                              AND e ->> 'outcome' NOT IN ('written', 'cache_sync_failed'))     AS n_kept_not_written,
           count(*) FILTER (WHERE e ->> 'gt_outcome' = 'replaced_by_tier')                     AS n_tier,
           count(*) FILTER (WHERE e ->> 'gt_outcome' = 'replaced_by_custom')                   AS n_custom,
           count(*) FILTER (WHERE e ->> 'gt_outcome' = 'not_sent')                             AS n_not_sent,
           count(*) FILTER (WHERE COALESCE(e ->> 'gt_outcome', '?') NOT IN
                                    ('none', 'kept', 'replaced_by_tier', 'replaced_by_custom', 'not_sent')
                              OR (jsonb_typeof(e -> 'gt') = 'object') <> (e ->> 'gt_outcome' <> 'none')) AS n_unexpected
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.prp) = 'array' THEN b.prp ELSE '[]'::jsonb END) e
  ) r
  CROSS JOIN LATERAL (
    SELECT count(*) AS gt_refused_in_file
    FROM jsonb_array_elements(b.refused) x
    WHERE x ->> 'kind' = 'refused_in_file'
      AND (x ->> 'reason' LIKE '%GT Price%' OR x ->> 'reason' LIKE '%GT Currency%')
  ) f
)
SELECT CASE WHEN GROUPING(package_name) = 1 THEN '== TOTAL ==' ELSE package_name END   AS package_name,
       CASE WHEN GROUPING(target_id) = 1 THEN NULL ELSE target_id::text END             AS app_id,
       CASE WHEN GROUPING(actor_email) = 1 THEN NULL ELSE actor_email END               AS actor_email,
       count(*)                                                                         AS batches_recorded,
       count(*) FILTER (WHERE n_gt + gt_refused_in_file > 0)                            AS batches_with_gt,
       COALESCE(sum(n_rows), 0)                                                         AS rows_in_audit,
       COALESCE(sum(n_gt), 0)                                                           AS rows_with_gt,
       COALESCE(sum(n_kept), 0)                                                         AS gt_kept,
       COALESCE(sum(n_kept_on_google), 0)                                               AS gt_kept_on_google,
       COALESCE(sum(n_kept_not_written), 0)                                             AS gt_kept_not_written,
       COALESCE(sum(n_tier), 0)                                                         AS gt_replaced_by_tier,
       COALESCE(sum(n_custom), 0)                                                       AS gt_replaced_by_custom,
       COALESCE(sum(n_not_sent), 0)                                                     AS gt_not_sent,
       COALESCE(sum(gt_refused_in_file), 0)                                             AS gt_refused_in_file,
       COALESCE(sum(n_unexpected), 0)                                                   AS gt_shape_unexpected,
       min(created_at)                                                                  AS first_batch_at,
       max(created_at)                                                                  AS latest_batch_at,
       max(created_at) FILTER (WHERE n_gt + gt_refused_in_file > 0)                     AS latest_gt_batch_at
FROM per_batch
GROUP BY GROUPING SETS ((package_name, target_id, actor_email), ())
ORDER BY GROUPING(package_name) DESC, COALESCE(sum(n_gt), 0) + COALESCE(sum(gt_refused_in_file), 0) DESC,
         package_name, actor_email;
-- @@ END


-- @@ BEGIN G4-C — before H4.4: what the data allows
-- G4-C · BEFORE H4.4 — what the data allows. READ-ONLY. One statement. First row = TOTAL (there even when empty).
-- ⚠ The code before H4.4 recorded NO GT field (measured on the real 375b735 orchestrator: a GT of VND 26000 was
--   sent to Google, and no field of its audit row carries it). So GT use before H4.4 CANNOT be counted from the DB.
--   This lists the imports that COULD have used GT — per app × actor × pricing source — with the source file
--   names, so the files themselves can be opened and their GT Price / GT Currency columns checked by hand.
-- The ONE partial trace (measured on 375b735): a row marked Custom whose custom set was REFUSED keeps the file's
--   overrides, and per_row_diagnostic records its VN price — so vn_price_decimal on a 'custom_refused' entry IS
--   the file's GT when the GT was VN (custom pricing exists since 2026-08-07). A GT for any other country, and
--   every GT on a row that was actually sent, left no trace. gt_trace_* is therefore a floor, never a count.
-- "pre-H4.4" = an audit row with no pricing_rule (every H4.4+ BULK_IMPORT_BATCH row has one).
WITH a AS (
  SELECT l.created_at,
         l.actor_email,
         l.target_id,
         l.payload ->> 'package_name'   AS package_name,
         l.payload ->> 'pricing_source' AS pricing_source,
         l.payload ->> 'batch_id'       AS batch_id,
         CASE WHEN jsonb_typeof(l.payload -> 'rows_total') = 'number'       THEN (l.payload ->> 'rows_total')::numeric       END AS rows_total,
         CASE WHEN jsonb_typeof(l.payload -> 'rows_created') = 'number'     THEN (l.payload ->> 'rows_created')::numeric     END AS rows_created,
         CASE WHEN jsonb_typeof(l.payload -> 'rows_overwritten') = 'number' THEN (l.payload ->> 'rows_overwritten')::numeric END AS rows_overwritten,
         (SELECT count(*)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.payload -> 'per_row_diagnostic') = 'array'
                                           THEN l.payload -> 'per_row_diagnostic' ELSE '[]'::jsonb END) d
           WHERE d ->> 'price_provenance' = 'custom_refused'
             AND d ->> 'vn_price_decimal' IS NOT NULL)                                                          AS gt_trace
  FROM google_iap_mgmt.actions_log l
  WHERE l.action_type = 'BULK_IMPORT_BATCH'
    AND NOT (l.payload ? 'pricing_rule')
)
SELECT CASE WHEN GROUPING(a.package_name) = 1 THEN '== TOTAL (pre-H4.4) ==' ELSE a.package_name END AS package_name,
       CASE WHEN GROUPING(a.target_id) = 1 THEN NULL ELSE a.target_id::text END                AS app_id,
       CASE WHEN GROUPING(a.actor_email) = 1 THEN NULL ELSE a.actor_email END                  AS actor_email,
       CASE WHEN GROUPING(a.pricing_source) = 1 THEN NULL ELSE a.pricing_source END            AS pricing_source,
       count(*)                                                                                AS batches,
       COALESCE(sum(a.rows_total), 0)                                                          AS rows_in_file,
       COALESCE(sum(a.rows_created), 0) + COALESCE(sum(a.rows_overwritten), 0)                 AS rows_written,
       'CHƯA BIẾT - not recorded before H4.4'                                                  AS gt_rows,
       COALESCE(sum(a.gt_trace), 0)                                                            AS gt_trace_vn_on_refused_custom_rows,
       min(a.created_at)                                                                       AS first_at,
       max(a.created_at)                                                                       AS last_at,
       string_agg(DISTINCT ib.source_filename, ' | ')                                          AS source_files
FROM a
LEFT JOIN google_iap_mgmt.import_batches ib ON ib.id::text = a.batch_id
GROUP BY GROUPING SETS ((a.package_name, a.target_id, a.actor_email, a.pricing_source), ())
ORDER BY GROUPING(a.package_name) DESC, max(a.created_at) DESC;
-- @@ END
