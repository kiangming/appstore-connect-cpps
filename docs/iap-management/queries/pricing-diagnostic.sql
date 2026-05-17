-- ─────────────────────────────────────────────────────────────────────────────
-- IAP.o.11b — Pricing path diagnostic queries.
--
-- When Manager reports "pricing failed" on a v5+ re-test, run these queries
-- in order against the iap_mgmt schema in Supabase. The orchestrator now
-- writes a SET_PRICE_SCHEDULE row at every outcome path (set / skipped-* /
-- failed-* — IAP.o.11a), so the audit log is the authoritative timeline of
-- what happened across Stage 1 (CREATE_ON_APPLE) and Stage 2 (SET_PRICE_
-- SCHEDULE) for a given window.
--
-- Hypothesis mapping (per IAP.o.11 investigation):
--   • Query 1 surfaces ALL pricing attempts last 24h with outcome breakdown.
--   • Query 2 dumps the full payload of failing rows for forensic detail.
--   • Query 3 finds CREATE_ON_APPLE rows missing a paired SET_PRICE_SCHEDULE
--     row → Stage 2 never invoked (H1 / H4 silent-path hypothesis).
--   • Query 4 cross-references local state vs Apple verdict so Manager can
--     spot IAPs that appear "priced locally" but the Apple side is still
--     MISSING_METADATA.
--
-- Run order: Q1 → Q2 → Q3 → Q4. Screenshots of all four = full diagnostic
-- bundle for Manager hand-off if the silent-fail recurs.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Query 1: pricing path execution last 24h, outcome breakdown ────────────
-- Surfaces: what outcomes pricing took, in what proportions. Healthy state is
-- ~100% outcome='set' on bulk + single-IAP. Any 'skipped-not-ready' rows mean
-- Apple propagation poll timed out. 'failed-*' counts pinpoint a regression.
SELECT
  payload ->> 'outcome'  AS outcome,
  payload ->> 'result'   AS result,
  COUNT(*)               AS count
FROM iap_mgmt.actions_log
WHERE action_type = 'SET_PRICE_SCHEDULE'
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1, 2
ORDER BY count DESC;


-- ─── Query 2: failing pricing rows with full error context ──────────────────
-- For every row that surfaced as ERROR in Query 1, dump the payload so the
-- exact failure reason (Apple HTTP status, error body excerpt, retry attempts,
-- poll attempts/total_ms) is visible. Sample_apple_prices is the diagnostic
-- gold when outcome='skipped-no-match' — shows what USD prices Apple actually
-- offered for the IAP, so Manager can confirm whether tier mapping is wrong.
SELECT
  created_at,
  actor,
  iap_id,
  batch_id,
  payload ->> 'apple_iap_id'         AS apple_iap_id,
  payload ->> 'product_id'           AS product_id,
  payload ->> 'tier_id'              AS tier_id,
  payload ->> 'usd_price'            AS usd_price,
  payload ->> 'outcome'              AS outcome,
  payload ->> 'attempts'             AS retry_attempts,
  payload ->> 'poll_attempts'        AS poll_attempts,
  payload ->> 'poll_total_ms'        AS poll_total_ms,
  payload ->> 'poll_reason'          AS poll_reason,
  payload ->> 'error'                AS error,
  payload -> 'sample_apple_prices'   AS sample_apple_prices
FROM iap_mgmt.actions_log
WHERE action_type = 'SET_PRICE_SCHEDULE'
  AND payload ->> 'result' = 'ERROR'
  AND created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC
LIMIT 100;


-- ─── Query 3: CREATE_ON_APPLE successes with NO paired SET_PRICE_SCHEDULE ───
-- Detects the H1/H4 silent-path failure mode: IAP was created but Stage 2
-- never reached the audit log. Healthy state: zero rows. Any rows here mean
-- the route handler exited between persisting apple_iap_id and invoking
-- applyPricingSchedule — investigate the orchestration code path for the
-- listed IAPs.
SELECT
  create_log.created_at,
  create_log.actor,
  create_log.payload ->> 'apple_iap_id'  AS apple_iap_id,
  create_log.payload ->> 'product_id'    AS product_id,
  create_log.payload ->> 'state'         AS apple_state
FROM iap_mgmt.actions_log AS create_log
WHERE create_log.action_type = 'CREATE_ON_APPLE'
  AND create_log.payload ->> 'apple_iap_id' IS NOT NULL
  AND create_log.created_at > NOW() - INTERVAL '24 hours'
  AND NOT EXISTS (
    SELECT 1
    FROM iap_mgmt.actions_log AS price_log
    WHERE price_log.action_type = 'SET_PRICE_SCHEDULE'
      AND price_log.payload ->> 'apple_iap_id'
          = create_log.payload ->> 'apple_iap_id'
  )
ORDER BY create_log.created_at DESC
LIMIT 50;


-- ─── Query 4: pricing success vs local IAP state cross-reference ────────────
-- Sanity check: for each pricing 'set' outcome in the last 24h, what is the
-- local iaps.state? If the row stays at MISSING_METADATA despite a 'set'
-- audit row, Apple rejected the schedule after we logged success (rare but
-- possible if the IAP was deleted in App Store Connect in between).
SELECT
  price_log.created_at,
  price_log.payload ->> 'apple_iap_id'  AS apple_iap_id,
  price_log.payload ->> 'tier_id'       AS tier_id,
  price_log.payload ->> 'usd_price'     AS usd_price,
  price_log.payload ->> 'schedule_id'   AS schedule_id,
  iaps.state                            AS local_state,
  iaps.product_id                       AS product_id
FROM iap_mgmt.actions_log AS price_log
LEFT JOIN iap_mgmt.iaps
  ON iaps.apple_iap_id = price_log.payload ->> 'apple_iap_id'
WHERE price_log.action_type = 'SET_PRICE_SCHEDULE'
  AND price_log.payload ->> 'outcome' = 'set'
  AND price_log.created_at > NOW() - INTERVAL '24 hours'
ORDER BY price_log.created_at DESC
LIMIT 100;


-- ─────────────────────────────────────────────────────────────────────────────
-- RUNBOOK — quick reference
-- ─────────────────────────────────────────────────────────────────────────────
--
-- When Manager reports "pricing failed":
--
--   1. Run Query 1. Note the outcome distribution.
--      • If outcome='set' rows exist → pricing path IS executing. Continue.
--      • If ZERO SET_PRICE_SCHEDULE rows → orchestrator never invoked.
--        Go straight to Query 3 + Railway log tail for '[pricing] start'.
--
--   2. Run Query 2. Pick the most recent ERROR row.
--      • outcome='skipped-no-match' → sample_apple_prices shows Apple's USD
--        offers; cross-reference with `usd_price` field. Mismatch means the
--        tier→USD mapping is stale; reseed price_tier_territories.
--      • outcome='skipped-no-usd-price' → tier not in local cache; check
--        iap_mgmt.price_tier_territories rows for the tier.
--      • outcome='skipped-not-ready' → Apple propagation slow; check
--        `poll_attempts` (should be ~10 for full timeout) and `poll_reason`.
--      • outcome='failed-lookup' → Apple's /v2/pricePoints returned an
--        error. Check `error` payload for Apple status + body.
--      • outcome='failed-set' → Apple's /v1/inAppPurchasePriceSchedules
--        rejected. `attempts` shows retry budget consumed (max 5 per
--        IAP.o.11a). `error` carries Apple's response body.
--      • outcome='failed-exception' → unexpected throw inside the
--        orchestrator. Cross-reference Railway logs for the stack trace
--        ('[pricing] UNEXPECTED EXCEPTION').
--
--   3. Run Query 3. ZERO rows = healthy. Any rows = Stage 2 never invoked
--      for those apple_iap_ids; orchestration code path between Stage 1
--      success and `applyPricingSchedule` call needs investigation.
--
--   4. Run Query 4. Look for outcome='set' rows where local_state stayed
--      MISSING_METADATA — indicates Apple-side rejection after our success
--      log (suggests the IAP was deleted in App Store Connect after our
--      schedule POST, or Apple rolled back the schedule for an unrelated
--      reason).
--
-- Railway log tail (run in Railway dashboard or via CLI):
--   grep '\[pricing\]\|\[poll-iap-ready\]\|\[set-price-schedule\]\|\[price-points\]\|\[create-on-apple\] Stage 2\|\[bulk-execute\] Stage 2' <railway-log-stream>
--
-- These prefixes cover every decision point in the IAP.o.11a-instrumented
-- pricing path. Each prefix appears in chronological order for a single
-- IAP creation, so a missing prefix in the log tail localizes the silent
-- exit point.
