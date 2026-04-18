-- ============================================================
-- Migration: Store Management seed platforms
-- ============================================================

INSERT INTO store_mgmt.platforms (key, display_name, icon_name, console_url_template, sort_order) VALUES
  ('apple',    'Apple App Store',    'apple',       'https://appstoreconnect.apple.com/apps/{platform_ref}', 10),
  ('google',   'Google Play',        'google-play', 'https://play.google.com/console/u/0/developers/app/{platform_ref}', 20),
  ('huawei',   'Huawei AppGallery',  'huawei',      'https://developer.huawei.com/consumer/en/console/app/{platform_ref}', 30),
  ('facebook', 'Facebook',           'facebook',    'https://developers.facebook.com/apps/{platform_ref}', 40)
ON CONFLICT (key) DO NOTHING;
