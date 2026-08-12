-- ============================================================
-- Per-territory Custom Prices — SC1 persistence
-- Design: docs/iap-management/design-apple-custom-territory-prices.md §A.2
-- ============================================================
--
-- Lets the Manager override the price for ANY territory, including ones a
-- pricing template already covers. Three parts, all in this one migration:
--
--   1. iap_mgmt.iap_custom_prices        — the custom set, one row per territory
--   2. iap_mgmt.iaps + 3 baseline cols   — the stale fingerprint (G6)
--   3. actions_log CHECK widened by 3    — the new audit action types
--
-- ── 1. THE TABLE ───────────────────────────────────────────────────────────
--
-- ⚠ SHAPE: (territory_code, customer_price, currency_code) — deliberately the
-- SAME SHAPE as iap_mgmt.price_tier_template_entries, minus the two fields a
-- custom has no concept of (tier_id, proceeds). NUMERIC(18,4) is identical to
-- that table so a value survives both paths the same way.
--
-- ⚠ WE DO NOT STORE APPLE PRICE-POINT IDs, and must never start. Apple's
-- price-point id is per-IAP (`{s,t,p}` base64, see lib/iap-management/apple/
-- price-point-id.ts), so it cannot exist before the IAP does — and Create
-- reaches the pricing orchestrator only AFTER the Apple shell is POSTed.
-- Storing (territory, price) instead means the id is resolved server-side at
-- submit exactly as a template entry's is (pricing-orchestration.ts:319-324),
-- which is what makes the Create and Edit paths structurally identical
-- (design gate G2). A stored id would also go stale: Apple can withdraw a
-- price point between the Manager picking it and the submit.
--
-- ⚠ PRIMARY KEY (iap_id, territory_code) IS THE INVARIANT, not a convenience.
-- Apple's price-schedule POST is replace-all and its manualPrices array is
-- territory-ANONYMOUS (the territory lives only inside the opaque id), so two
-- rows for one territory would put two manualPrices for that territory in one
-- payload — an ambiguous request to a live store, not merely a wrong value
-- (design gate G1). The database refuses it; application code is not trusted
-- with it.
--
-- currency_code is DISPLAY METADATA ONLY and must never become a join key:
-- a territory's currency can change (the Google-side Bulgaria BGN→EUR trap),
-- and matching is on customer_price alone via findPricePointByUsdPrice.
--
-- ── 2. THE STALE FINGERPRINT ───────────────────────────────────────────────
--
-- Manager-locked decision 3: a base-price change marks customs STALE, it never
-- destroys them. Staleness is a COMPARISON (current fingerprint ≠ stored), not
-- a one-way boolean — so changing the base and changing it BACK clears
-- staleness with no user action and nothing to acknowledge.
--
-- Three explicit columns rather than one JSONB blob, so the Manager diagnostic
-- SQL convention (KB §8.1) can filter on them directly. All-NULL means "no
-- customs", matching an absent set; the coherence CHECK below makes a partial
-- fingerprint impossible.
--
-- base_territory is included even though it is hardcoded 'USA' today
-- (IapForm.tsx renders a disabled select; pricing-orchestration.ts:191 always
-- resolves 'USA'). It is exactly the field the promised "multi-base in a
-- follow-up" moves, and a fingerprint that omits it silently stops detecting
-- staleness the day that lands.
--
-- iap type is deliberately NOT part of the fingerprint: it is locked in edit
-- mode, and the "Apple's catalog may differ by IAP type" claim is explicitly
-- unproven (batch-price-point-catalog.ts:29-31).
--
-- ── 3. ACTION TYPES ────────────────────────────────────────────────────────
--
-- Widened here, in the SAME migration that introduces the writer, per P2. The
-- lib/audit-constraints guard would catch a miss at test time, but the point is
-- not to lean on the alarm.
--
-- Forward-only per CLAUDE.md invariant #7. Grants are inherited: 20260515020000
-- set ALTER DEFAULT PRIVILEGES IN SCHEMA iap_mgmt for service_role, so a new
-- table needs no explicit GRANT. RLS enabled with no policies → service_role
-- only, matching 20260519000000 / 20260715000000.
-- ============================================================

-- ── 1. Custom price set ────────────────────────────────────────────────────

CREATE TABLE iap_mgmt.iap_custom_prices (
  iap_id          UUID            NOT NULL REFERENCES iap_mgmt.iaps(id) ON DELETE CASCADE,
  territory_code  TEXT            NOT NULL,
  currency_code   TEXT            NOT NULL,
  customer_price  NUMERIC(18, 4)  NOT NULL,
  PRIMARY KEY (iap_id, territory_code)
);

-- No separate index on iap_id: it is the PK's leading column, so
-- "all customs for this IAP" already uses the PK index.

ALTER TABLE iap_mgmt.iap_custom_prices ENABLE ROW LEVEL SECURITY;

-- ── 2. Stale fingerprint on the IAP row ────────────────────────────────────

ALTER TABLE iap_mgmt.iaps
  ADD COLUMN IF NOT EXISTS custom_prices_baseline_tier_id        TEXT,
  ADD COLUMN IF NOT EXISTS custom_prices_baseline_pricing_source TEXT,
  ADD COLUMN IF NOT EXISTS custom_prices_baseline_base_territory TEXT;

-- Same value set as iaps.pricing_source (20260520000000_iap_mgmt_p1j_hotfix).
ALTER TABLE iap_mgmt.iaps
  ADD CONSTRAINT iaps_custom_prices_baseline_pricing_source_check
  CHECK (
    custom_prices_baseline_pricing_source IS NULL
    OR custom_prices_baseline_pricing_source IN ('APPLE', 'DEFAULT_TEMPLATE', 'APP_TEMPLATE')
  );

-- A fingerprint is all-or-nothing. A partial one would compare as "changed"
-- against every possible current baseline, i.e. permanently stale with no way
-- to resolve it — so the shape that cannot be reasoned about is refused.
ALTER TABLE iap_mgmt.iaps
  ADD CONSTRAINT iaps_custom_prices_baseline_coherent_check
  CHECK (
    (
      custom_prices_baseline_tier_id        IS NULL
      AND custom_prices_baseline_pricing_source IS NULL
      AND custom_prices_baseline_base_territory IS NULL
    )
    OR
    (
      custom_prices_baseline_tier_id        IS NOT NULL
      AND custom_prices_baseline_pricing_source IS NOT NULL
      AND custom_prices_baseline_base_territory IS NOT NULL
    )
  );

-- ── 3. actions_log action types ────────────────────────────────────────────
--
-- Added values (3):
--   CUSTOM_PRICES_SAVED      — the custom set was written (or replaced). The
--                              payload's `source` distinguishes a manual edit
--                              from the "import Apple's current manual prices"
--                              action, and carries the territory list, so a
--                              draft that holds customs for days still has a
--                              trace even though no Apple write has happened.
--   CUSTOM_PRICES_CLEARED    — the set was deleted. This is the one destructive
--                              action in the feature; the payload carries the
--                              removed values because it is the only recovery
--                              path.
--   CUSTOM_PRICES_REBASELINE — "Keep them (reviewed)" re-stamped the fingerprint
--                              without changing a single price. It changes what
--                              will ship to a live store while changing nothing
--                              visible, so without a row a later reader sees
--                              prices set against one tier attached to another
--                              with no explanation.
--
-- Full list = the 22 from 20260811000000 + these 3.

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
    'CUSTOM_PRICES_SAVED',
    'CUSTOM_PRICES_CLEARED',
    'CUSTOM_PRICES_REBASELINE'
  ));
