-- ============================================================
-- Migration: google_iap_mgmt.apps — default_currency + default_language
--
-- Hotfix 4 (2026-05-21): Google enforces app-level configured default
-- currency on every IAP insert / patch. Previously the form sent USD
-- blindly; apps configured for VND (or any other currency) rejected
-- with "Expecting currency VND for default price but found USD instead".
--
-- Population strategy:
--   1. Apps refresh (Reporting apps.search → per-app edits.details.get):
--      writes default_language from AppDetails. Currency derived from
--      a language → currency fallback map (best-effort).
--   2. IAPs refresh (inappproducts.list): the first cached IAP carries
--      the app's true defaultPrice.currency + defaultLanguage. Repository
--      opportunistically overwrites the apps row with ground truth.
--
-- Both columns are NULLable — apps fetched before this migration runs
-- continue to render; the form falls back to USD/en-US until the next
-- refresh populates them.
--
-- Forward-only per CLAUDE.md invariant #7.
-- ============================================================

ALTER TABLE google_iap_mgmt.apps
  ADD COLUMN IF NOT EXISTS default_currency TEXT,
  ADD COLUMN IF NOT EXISTS default_language TEXT;

COMMENT ON COLUMN google_iap_mgmt.apps.default_currency IS
  'App''s configured default currency on Google Play Console (e.g. VND, USD). '
  'Used as the defaultPrice.currency when creating / updating IAPs. '
  'Derived from existing IAPs (ground truth) or from a language → currency '
  'fallback map (apps with no IAPs yet).';

COMMENT ON COLUMN google_iap_mgmt.apps.default_language IS
  'App''s configured default language (BCP-47, e.g. en-US, vi). Used as the '
  'pre-selected locale in the Create IAP form and as the required locale '
  'in bulk imports. Fetched via edits.details.get from Android Publisher.';
