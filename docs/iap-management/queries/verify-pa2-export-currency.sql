-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFY — [TEMPLATE-xlsx-reimport] PA2, push gate (Manager 2026-10-20)
--
-- Will "Export for editing" refuse (409) any template on prod? It refuses a
-- territory whose stored currency is not the ONE Apple bills there:
--   MIXED     — the territory holds 2+ currencies in one template;
--   NOT_APPLE — one currency, but not Apple's for that territory;
--   NOT_SOLD  — the code is not one of Apple's 175 territories.
-- (app/api/iap-management/pricing-templates/matrix-export/route.ts, editExport.)
--
-- Run in the Supabase SQL Editor, ONE block at a time (the Editor shows only
-- the last statement's result). Nothing here writes. Each block states its
-- own PASS condition.
--
-- ⚠ The 175-row table below is GENERATED from
--   lib/iap-management/apple/apple-territories.snapshot.ts — the same table
--   the export and the import check against. Never edit it by hand: the test
--   verify-pa2-export-currency.sql.test.ts fails when it drifts from the
--   snapshot, and also checks that V2 lists exactly what the export refuses.
--
-- Runs: 2026-10-20 (before PA2.3) — 175 / 14 templates / 28 707 entries / 0 rows.
-- ═══════════════════════════════════════════════════════════════════════════


-- @@ BEGIN V2-a — is this the right data?
-- PASS: snap_rows = 175, templates ≥ 1, entries > 0
--       (last run: 14 templates / 28 707 entries — a big change must be
--        explainable by uploads since then).
-- ⚠ entries = 0 means the query reads NO data (wrong project, or a role that
--   row-level security hides the rows from) — then V2 below proves nothing.
WITH snap(territory_code, apple_currency) AS (VALUES
    ('AFG','USD'),('AGO','USD'),('AIA','USD'),('ALB','USD'),('ARE','AED'),('ARG','USD'),('ARM','USD'),('ATG','USD'),('AUS','AUD'),('AUT','EUR'),
    ('AZE','USD'),('BEL','EUR'),('BEN','USD'),('BFA','USD'),('BGR','EUR'),('BHR','USD'),('BHS','USD'),('BIH','EUR'),('BLR','USD'),('BLZ','USD'),
    ('BMU','USD'),('BOL','USD'),('BRA','BRL'),('BRB','USD'),('BRN','USD'),('BTN','USD'),('BWA','USD'),('CAN','CAD'),('CHE','CHF'),('CHL','CLP'),
    ('CHN','CNY'),('CIV','USD'),('CMR','USD'),('COD','USD'),('COG','USD'),('COL','COP'),('CPV','USD'),('CRI','USD'),('CYM','USD'),('CYP','EUR'),
    ('CZE','CZK'),('DEU','EUR'),('DMA','USD'),('DNK','DKK'),('DOM','USD'),('DZA','USD'),('ECU','USD'),('EGY','EGP'),('ESP','EUR'),('EST','EUR'),
    ('FIN','EUR'),('FJI','USD'),('FRA','EUR'),('FSM','USD'),('GAB','USD'),('GBR','GBP'),('GEO','USD'),('GHA','USD'),('GMB','USD'),('GNB','USD'),
    ('GRC','EUR'),('GRD','USD'),('GTM','USD'),('GUY','USD'),('HKG','HKD'),('HND','USD'),('HRV','EUR'),('HUN','HUF'),('IDN','IDR'),('IND','INR'),
    ('IRL','EUR'),('IRQ','USD'),('ISL','USD'),('ISR','ILS'),('ITA','EUR'),('JAM','USD'),('JOR','USD'),('JPN','JPY'),('KAZ','KZT'),('KEN','USD'),
    ('KGZ','USD'),('KHM','USD'),('KNA','USD'),('KOR','KRW'),('KWT','USD'),('LAO','USD'),('LBN','USD'),('LBR','USD'),('LBY','USD'),('LCA','USD'),
    ('LKA','USD'),('LTU','EUR'),('LUX','EUR'),('LVA','EUR'),('MAC','USD'),('MAR','USD'),('MDA','USD'),('MDG','USD'),('MDV','USD'),('MEX','MXN'),
    ('MKD','USD'),('MLI','USD'),('MLT','EUR'),('MMR','USD'),('MNE','EUR'),('MNG','USD'),('MOZ','USD'),('MRT','USD'),('MSR','USD'),('MUS','USD'),
    ('MWI','USD'),('MYS','MYR'),('NAM','USD'),('NER','USD'),('NGA','NGN'),('NIC','USD'),('NLD','EUR'),('NOR','NOK'),('NPL','USD'),('NRU','USD'),
    ('NZL','NZD'),('OMN','USD'),('PAK','PKR'),('PAN','USD'),('PER','PEN'),('PHL','PHP'),('PLW','USD'),('PNG','USD'),('POL','PLN'),('PRT','EUR'),
    ('PRY','USD'),('QAT','QAR'),('ROU','RON'),('RUS','RUB'),('RWA','USD'),('SAU','SAR'),('SEN','USD'),('SGP','SGD'),('SLB','USD'),('SLE','USD'),
    ('SLV','USD'),('SRB','EUR'),('STP','USD'),('SUR','USD'),('SVK','EUR'),('SVN','EUR'),('SWE','SEK'),('SWZ','USD'),('SYC','USD'),('TCA','USD'),
    ('TCD','USD'),('THA','THB'),('TJK','USD'),('TKM','USD'),('TON','USD'),('TTO','USD'),('TUN','USD'),('TUR','TRY'),('TWN','TWD'),('TZA','TZS'),
    ('UGA','USD'),('UKR','USD'),('URY','USD'),('USA','USD'),('UZB','USD'),('VCT','USD'),('VEN','USD'),('VGB','USD'),('VNM','VND'),('VUT','USD'),
    ('XKS','EUR'),('YEM','USD'),('ZAF','ZAR'),('ZMB','USD'),('ZWE','USD')
)
SELECT (SELECT count(*) FROM snap)                                AS snap_rows,
       (SELECT count(*) FROM iap_mgmt.price_tier_templates)        AS templates,
       (SELECT count(*) FROM iap_mgmt.price_tier_template_entries) AS entries;
-- @@ END


-- @@ BEGIN V2 — every (template, territory) the edit export would refuse
-- PASS: exactly ONE row, the TOTAL row, reading
--       "TOTAL: 0 problem rows · <templates> templates · <entries> entries scanned"
--       with the same counts as V2-a.
-- ANY other row = that territory of that template gets a 409 on
-- "Export for editing" ⇒ STOP, send the rows.
--   problem          MIXED / NOT_APPLE / NOT_SOLD (see the header)
--   scope_type       ACCOUNT = a Default template (scope_account_id = the ASC
--                    account) · APP = a Per-App template (app_bundle_id)
--   stored_currencies every currency stored for that territory in that template
--   apple_currency   the one Apple bills there (NULL = Apple does not sell there)
--   entries          how many cells (tiers) are affected
-- ⚠ ACCOUNT rows: check that scope_account_id is still in the top-bar account
--   switcher. A deactivated account's Default is shown on no screen, so nobody
--   can export it — report the row anyway; the Manager decides.
WITH snap(territory_code, apple_currency) AS (VALUES
    ('AFG','USD'),('AGO','USD'),('AIA','USD'),('ALB','USD'),('ARE','AED'),('ARG','USD'),('ARM','USD'),('ATG','USD'),('AUS','AUD'),('AUT','EUR'),
    ('AZE','USD'),('BEL','EUR'),('BEN','USD'),('BFA','USD'),('BGR','EUR'),('BHR','USD'),('BHS','USD'),('BIH','EUR'),('BLR','USD'),('BLZ','USD'),
    ('BMU','USD'),('BOL','USD'),('BRA','BRL'),('BRB','USD'),('BRN','USD'),('BTN','USD'),('BWA','USD'),('CAN','CAD'),('CHE','CHF'),('CHL','CLP'),
    ('CHN','CNY'),('CIV','USD'),('CMR','USD'),('COD','USD'),('COG','USD'),('COL','COP'),('CPV','USD'),('CRI','USD'),('CYM','USD'),('CYP','EUR'),
    ('CZE','CZK'),('DEU','EUR'),('DMA','USD'),('DNK','DKK'),('DOM','USD'),('DZA','USD'),('ECU','USD'),('EGY','EGP'),('ESP','EUR'),('EST','EUR'),
    ('FIN','EUR'),('FJI','USD'),('FRA','EUR'),('FSM','USD'),('GAB','USD'),('GBR','GBP'),('GEO','USD'),('GHA','USD'),('GMB','USD'),('GNB','USD'),
    ('GRC','EUR'),('GRD','USD'),('GTM','USD'),('GUY','USD'),('HKG','HKD'),('HND','USD'),('HRV','EUR'),('HUN','HUF'),('IDN','IDR'),('IND','INR'),
    ('IRL','EUR'),('IRQ','USD'),('ISL','USD'),('ISR','ILS'),('ITA','EUR'),('JAM','USD'),('JOR','USD'),('JPN','JPY'),('KAZ','KZT'),('KEN','USD'),
    ('KGZ','USD'),('KHM','USD'),('KNA','USD'),('KOR','KRW'),('KWT','USD'),('LAO','USD'),('LBN','USD'),('LBR','USD'),('LBY','USD'),('LCA','USD'),
    ('LKA','USD'),('LTU','EUR'),('LUX','EUR'),('LVA','EUR'),('MAC','USD'),('MAR','USD'),('MDA','USD'),('MDG','USD'),('MDV','USD'),('MEX','MXN'),
    ('MKD','USD'),('MLI','USD'),('MLT','EUR'),('MMR','USD'),('MNE','EUR'),('MNG','USD'),('MOZ','USD'),('MRT','USD'),('MSR','USD'),('MUS','USD'),
    ('MWI','USD'),('MYS','MYR'),('NAM','USD'),('NER','USD'),('NGA','NGN'),('NIC','USD'),('NLD','EUR'),('NOR','NOK'),('NPL','USD'),('NRU','USD'),
    ('NZL','NZD'),('OMN','USD'),('PAK','PKR'),('PAN','USD'),('PER','PEN'),('PHL','PHP'),('PLW','USD'),('PNG','USD'),('POL','PLN'),('PRT','EUR'),
    ('PRY','USD'),('QAT','QAR'),('ROU','RON'),('RUS','RUB'),('RWA','USD'),('SAU','SAR'),('SEN','USD'),('SGP','SGD'),('SLB','USD'),('SLE','USD'),
    ('SLV','USD'),('SRB','EUR'),('STP','USD'),('SUR','USD'),('SVK','EUR'),('SVN','EUR'),('SWE','SEK'),('SWZ','USD'),('SYC','USD'),('TCA','USD'),
    ('TCD','USD'),('THA','THB'),('TJK','USD'),('TKM','USD'),('TON','USD'),('TTO','USD'),('TUN','USD'),('TUR','TRY'),('TWN','TWD'),('TZA','TZS'),
    ('UGA','USD'),('UKR','USD'),('URY','USD'),('USA','USD'),('UZB','USD'),('VCT','USD'),('VEN','USD'),('VGB','USD'),('VNM','VND'),('VUT','USD'),
    ('XKS','EUR'),('YEM','USD'),('ZAF','ZAR'),('ZMB','USD'),('ZWE','USD')
),
per_territory AS (
  SELECT e.template_id, e.territory_code,
         array_agg(DISTINCT e.currency_code ORDER BY e.currency_code) AS stored_currencies,
         count(*) AS entries
    FROM iap_mgmt.price_tier_template_entries e
   GROUP BY e.template_id, e.territory_code
),
problems AS (
  -- Same order as the export: a territory with 2+ currencies is MIXED first,
  -- whether or not Apple sells there.
  SELECT CASE WHEN cardinality(p.stored_currencies) > 1 THEN 'MIXED'
              WHEN s.apple_currency IS NULL             THEN 'NOT_SOLD'
              ELSE 'NOT_APPLE' END                      AS problem,
         t.scope_type, t.scope_account_id, a.bundle_id  AS app_bundle_id,
         p.territory_code, p.stored_currencies, s.apple_currency, p.entries,
         t.id                                           AS template_id
    FROM per_territory p
    JOIN iap_mgmt.price_tier_templates t ON t.id = p.template_id
    LEFT JOIN iap_mgmt.apps a ON a.id = t.scope_app_id
    LEFT JOIN snap s ON s.territory_code = p.territory_code
   WHERE s.apple_currency IS NULL
      OR cardinality(p.stored_currencies) > 1
      OR p.stored_currencies[1] IS DISTINCT FROM s.apple_currency
)
SELECT problem, scope_type, scope_account_id, app_bundle_id, territory_code,
       stored_currencies, apple_currency, entries, template_id
  FROM (
    SELECT 1 AS sec, problems.* FROM problems
    UNION ALL
    SELECT 2, 'TOTAL: ' || (SELECT count(*) FROM problems) || ' problem rows · '
              || (SELECT count(*) FROM iap_mgmt.price_tier_templates) || ' templates · '
              || (SELECT count(*) FROM iap_mgmt.price_tier_template_entries) || ' entries scanned',
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  ) x
 ORDER BY sec, scope_type, scope_account_id, app_bundle_id, territory_code;
-- @@ END
