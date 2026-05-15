-- ============================================================
-- Migration: IAP Management — convert tier_id from INT to TEXT
-- Reason: Manager follow-up answer (C) to IAP.e finding — include
-- Alternate Tiers (5 numeric "Alt 1..5" + 2 letter "Alt A, B") which
-- cannot be represented by INT primary key.
--
-- Encoding (regex-enforced via CHECK):
--   FREE          — Free Tier
--   TIER_<digits> — standard paid tier (e.g. "TIER_1", "TIER_87")
--   ALT_<alnum>   — alternate tier (e.g. "ALT_1", "ALT_5", "ALT_A", "ALT_B")
--
-- Forward-only migration (CLAUDE.md invariant #7) — does not edit the
-- init migration shipped at 20260515000000_iap_mgmt_init.sql.
--
-- Safe: tables are empty (just-shipped schema), so USING cast trivially
-- coerces values that don't exist yet. The parser (lib/iap-management/
-- parsers/price-tiers.ts) emits the new format from initial import.
-- ============================================================

-- Drop FK constraints that depend on price_tiers.tier_id INT.
-- IF EXISTS for resilience against Postgres constraint-naming variations.
ALTER TABLE iap_mgmt.iaps
  DROP CONSTRAINT IF EXISTS iaps_tier_id_fkey;
ALTER TABLE iap_mgmt.price_tier_territories
  DROP CONSTRAINT IF EXISTS price_tier_territories_tier_id_fkey;

-- Drop the numeric CHECK constraint (was `CHECK (tier_id >= 0)`).
ALTER TABLE iap_mgmt.price_tiers
  DROP CONSTRAINT IF EXISTS price_tiers_tier_id_check;
ALTER TABLE iap_mgmt.price_tiers
  DROP CONSTRAINT IF EXISTS price_tiers_check;

-- Alter column types from INT to TEXT.
-- USING tier_id::TEXT works for empty tables; if rows existed, the cast
-- would produce digit strings ("0", "1") which do NOT match the new
-- regex CHECK — relying on schema being empty here.
ALTER TABLE iap_mgmt.price_tiers
  ALTER COLUMN tier_id TYPE TEXT USING tier_id::TEXT;
ALTER TABLE iap_mgmt.price_tier_territories
  ALTER COLUMN tier_id TYPE TEXT USING tier_id::TEXT;
ALTER TABLE iap_mgmt.iaps
  ALTER COLUMN tier_id TYPE TEXT USING tier_id::TEXT;

-- New format CHECK on price_tiers.tier_id.
ALTER TABLE iap_mgmt.price_tiers
  ADD CONSTRAINT price_tiers_tier_id_format_check
  CHECK (tier_id ~ '^(FREE|TIER_[0-9]+|ALT_[0-9A-Z]+)$');

-- Re-add FK constraints with same ON DELETE semantics as init migration.
ALTER TABLE iap_mgmt.price_tier_territories
  ADD CONSTRAINT price_tier_territories_tier_id_fkey
  FOREIGN KEY (tier_id) REFERENCES iap_mgmt.price_tiers(tier_id)
  ON DELETE CASCADE;

ALTER TABLE iap_mgmt.iaps
  ADD CONSTRAINT iaps_tier_id_fkey
  FOREIGN KEY (tier_id) REFERENCES iap_mgmt.price_tiers(tier_id)
  ON DELETE SET NULL;
