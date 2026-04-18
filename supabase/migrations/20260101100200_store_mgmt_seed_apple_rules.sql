-- ============================================================
-- Migration: Store Management seed Apple rules
-- Regex syntax: JS-style named groups (?<n>...) — RE2 compatible
-- ============================================================

DO $$
DECLARE apple_id UUID;
BEGIN
  SELECT id INTO apple_id FROM store_mgmt.platforms WHERE key = 'apple';

  -- Primary sender
  INSERT INTO store_mgmt.senders (platform_id, email, is_primary) VALUES
    (apple_id, 'no-reply@apple.com', true)
  ON CONFLICT (platform_id, email) DO NOTHING;

  -- Subject patterns
  INSERT INTO store_mgmt.subject_patterns (platform_id, outcome, regex, priority, example_subject) VALUES
    (apple_id, 'APPROVED', 'Review of your (?<app_name>.+) submission is complete\.', 10,
     'Review of your Skyline Runners submission is complete.'),
    (apple_id, 'REJECTED', 'There''s an issue with your (?<app_name>.+) submission\.', 20,
     'There''s an issue with your Dragon Guild submission.'),
    (apple_id, 'IN_REVIEW', 'Your (?<app_name>.+) status has changed to (In Review|Waiting for Review)', 30,
     'Your Realm Defenders status has changed to Waiting for Review');

  -- Types
  INSERT INTO store_mgmt.types (platform_id, name, slug, body_keyword, payload_extract_regex, sort_order) VALUES
    (apple_id, 'App',                 'app', 'App Version',
     'App Version\s*\n\s*(?<version>[\d.]+) for (?<os>\w+)', 10),
    (apple_id, 'In-App Event',        'iae', 'In-App Events',
     'In-App Events\s*\n\s*(?<event_name>.+?)\s+(?<event_id>\d+)', 20),
    (apple_id, 'Custom Product Page', 'cpp', 'Custom Product Pages',
     'Custom Product Pages\s*\n\s*(?<page_name>.+?)\s+(?<page_id>[a-f0-9-]{36})', 30);
END $$;
