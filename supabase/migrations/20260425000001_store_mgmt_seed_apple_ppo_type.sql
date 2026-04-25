-- PR-11.4 — Add Product Page Optimization type to Apple seed
--
-- Sample emails (e.g. Gunny Mobi 230426) currently classify
-- UNCLASSIFIED_TYPE because PPO type không seed trước PR-11.
-- HTML extractor (PR-11.1) detects PRODUCT_PAGE_OPTIMIZATION
-- → maps to 'ppo' slug → matches this seed (PR-11.4 type-matcher
-- Priority 1 path).
--
-- payload_extract_regex left NULL because the structured payload
-- now flows via extracted_payload (PR-11.2 column). Body keyword
-- "Product Page Optimization" preserves Priority 2 fallback for
-- non-Apple platforms or future legacy data.
--
-- Idempotent: ON CONFLICT (platform_id, slug) DO NOTHING.
-- Forward-only per CLAUDE.md invariant #7.

DO $$
DECLARE apple_id UUID;
BEGIN
  SELECT id INTO apple_id FROM store_mgmt.platforms WHERE key = 'apple';

  INSERT INTO store_mgmt.types (
    platform_id, name, slug, body_keyword, payload_extract_regex, sort_order
  ) VALUES
    (apple_id, 'Product Page Optimization', 'ppo',
     'Product Page Optimization', NULL, 40)
  ON CONFLICT (platform_id, slug) DO NOTHING;
END $$;
