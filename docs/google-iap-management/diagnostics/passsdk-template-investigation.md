# PASS SDK Per-App Pricing Template — Database Diagnostic

**Context.** Hotfix 17 shipped tighter `scope="APP"` query guards + a
pre-flight `templateExists` probe + a new `template_no_match_rows`
audit counter. Manager re-tested Bulk Import on the PASS SDK Google
Play app with the Per-App template selected; symptom persisted —
VN=25,000 VND received on Google instead of the Per-App template's
27,000 VND.

This file is a diagnostic suite Manager can copy-paste into Supabase
SQL Editor to determine whether the gap is:

- **A.** Per-App template missing entirely for this app (workflow
  issue — Manager forgot to upload).
- **B.** Per-App template present but contains no entries matching
  the Excel row's `(currency, price_micros)` (template-coverage gap
  — Manager's template tiers don't cover the Excel rows' base
  prices).
- **C.** Per-App template present AND entries match but Bulk Import
  resolved to GLOBAL anyway (scope-wiring bug Hotfix 17 missed —
  next hotfix needed).

**Schema note.** This is the **Google IAP** module — all tables live
in the `google_iap_mgmt` schema. (The Apple IAP equivalent lives in
`iap_mgmt`; do not confuse the two.) Google IAP apps key on
`package_name` (e.g. `com.vng.passsdk`), not Apple's `bundle_id`.

## How to run

1. Open Supabase → SQL Editor.
2. Run **Query 1** first, note the PASS SDK app's `id` (UUID) — the
   subsequent queries reference apps by `package_name` ILIKE pattern
   so they don't need the UUID inline, but knowing it helps if you
   want to spot-check joins manually.
3. Run Queries 2–5 to map the template state.
4. Run Query 6 to read the most recent BULK_IMPORT_BATCH audit
   entries — those carry the per-strategy counters introduced in
   Hotfix 15 → 17.
5. Run Query 7 for integrity sanity checks.
6. Paste the results back into the conversation; the **Interpretation
   matrix** at the bottom of this file maps result combinations to
   the diagnosed scenario (A / B / C above).

---

## Query 1 — PASS SDK app row

```sql
SELECT
  id,
  google_console_account_id,
  package_name,
  display_name,
  default_currency,
  default_language,
  last_synced_at,
  created_at
FROM google_iap_mgmt.apps
WHERE package_name ILIKE '%passsdk%'
ORDER BY created_at DESC;
```

**Expected.** One or more rows. Note the `id` UUID and the
`default_currency` (likely `VND` for the PASS SDK app — Hotfix 16's
generic-header inference uses this field).

**If zero rows:** the Google IAP module has never cached this app.
Either Manager hasn't done a Refresh on the apps list, or the
`package_name` filter doesn't match (try a broader ILIKE).

---

## Query 2 — All templates relevant to PASS SDK

Lists the GLOBAL (Default) template plus any APP-scoped (Per-App)
template whose `scope_app_id` points at a PASS SDK app row.

```sql
SELECT
  t.id                 AS template_id,
  t.scope_type,
  t.scope_app_id,
  a.package_name       AS app_package,
  a.display_name       AS app_name,
  t.uploaded_at,
  t.uploaded_by,
  t.source_filename,
  COUNT(e.identifier)  AS entry_count
FROM google_iap_mgmt.pricing_templates t
LEFT JOIN google_iap_mgmt.apps a
       ON t.scope_app_id = a.id
LEFT JOIN google_iap_mgmt.pricing_template_entries e
       ON e.template_id = t.id
WHERE t.scope_type = 'GLOBAL'
   OR (t.scope_type = 'APP' AND a.package_name ILIKE '%passsdk%')
GROUP BY t.id, t.scope_type, t.scope_app_id,
         a.package_name, a.display_name,
         t.uploaded_at, t.uploaded_by, t.source_filename
ORDER BY t.scope_type DESC, t.uploaded_at DESC;
```

**Possible outcomes:**

| Rows | Diagnosis |
|---|---|
| Both `GLOBAL` and `APP` for PASS SDK | Templates present; problem is matching or wiring → run Queries 3–5. |
| `GLOBAL` only | Per-App template was never uploaded. **Scenario A.** Hotfix 17 pre-flight should now throw an actionable error — if Manager's symptom predates Hotfix 17 deploy, that explains the silent fallback. |
| `APP` only | No Default template; Bulk Import with "default_template" would now throw. Per-App test should still resolve via the APP row. |
| Zero rows | No templates at all. Both pricingSource options will throw at the Hotfix 17 pre-flight. |

`entry_count = 0` for a template row means the header exists but no
entries were inserted (parser may have rejected the file) — that
template effectively does nothing.

---

## Query 3 — Default Template (GLOBAL) entries for VN / VND

```sql
SELECT
  e.identifier         AS tier,
  e.region_code,
  e.currency,
  e.price_micros,
  ROUND(e.price_micros::numeric / 1000000.0, 4) AS price_decimal
FROM google_iap_mgmt.pricing_templates t
JOIN google_iap_mgmt.pricing_template_entries e
       ON e.template_id = t.id
WHERE t.scope_type = 'GLOBAL'
  AND (e.currency = 'VND' OR e.region_code = 'VN')
ORDER BY e.identifier, e.region_code;
```

**Expected.** Rows showing the GLOBAL template's VND/VN coverage. The
`tier` (identifier) column tells you what Tier names live in the
template (e.g. `Tier 1`, `Tier 2`).

**Manager's stated test data:** Default VN = 25,000 VND →
`price_micros` should read `25000000000` (decimal `25000`).

---

## Query 4 — Per-App Template entries for PASS SDK, VN / VND

```sql
SELECT
  a.package_name,
  e.identifier         AS tier,
  e.region_code,
  e.currency,
  e.price_micros,
  ROUND(e.price_micros::numeric / 1000000.0, 4) AS price_decimal
FROM google_iap_mgmt.pricing_templates t
JOIN google_iap_mgmt.apps a
       ON t.scope_app_id = a.id
JOIN google_iap_mgmt.pricing_template_entries e
       ON e.template_id = t.id
WHERE t.scope_type = 'APP'
  AND a.package_name ILIKE '%passsdk%'
  AND (e.currency = 'VND' OR e.region_code = 'VN')
ORDER BY e.identifier, e.region_code;
```

**Manager's stated test data:** Per-App VN = 27,000 VND →
`price_micros` should read `27000000000` (decimal `27000`).

**If zero rows:** either no Per-App template for PASS SDK
(**Scenario A**), or the template exists but has no VND/VN row
(**Scenario B partial** — coverage gap on the VN region specifically).

---

## Query 5 — Side-by-side Default vs Per-App tier-by-tier on VN

Cross-checks whether the Per-App template's tiers correspond to the
Default template's tiers and where the prices differ. This is the
canonical "did Manager's edits land" view.

```sql
WITH default_vn AS (
  SELECT e.identifier AS tier, e.price_micros
  FROM google_iap_mgmt.pricing_templates t
  JOIN google_iap_mgmt.pricing_template_entries e
         ON e.template_id = t.id
  WHERE t.scope_type = 'GLOBAL'
    AND e.region_code = 'VN'
    AND e.currency = 'VND'
),
perapp_vn AS (
  SELECT e.identifier AS tier, e.price_micros
  FROM google_iap_mgmt.pricing_templates t
  JOIN google_iap_mgmt.apps a
         ON t.scope_app_id = a.id
  JOIN google_iap_mgmt.pricing_template_entries e
         ON e.template_id = t.id
  WHERE t.scope_type = 'APP'
    AND a.package_name ILIKE '%passsdk%'
    AND e.region_code = 'VN'
    AND e.currency = 'VND'
)
SELECT
  COALESCE(d.tier, p.tier) AS tier,
  ROUND(d.price_micros::numeric / 1000000.0, 4) AS default_vnd,
  ROUND(p.price_micros::numeric / 1000000.0, 4) AS perapp_vnd,
  CASE
    WHEN d.price_micros IS NULL THEN 'perapp_only'
    WHEN p.price_micros IS NULL THEN 'default_only'
    WHEN d.price_micros = p.price_micros THEN 'identical'
    ELSE 'differs'
  END AS comparison
FROM default_vn d
FULL OUTER JOIN perapp_vn p ON d.tier = p.tier
ORDER BY tier;
```

**Read the `comparison` column:**

- `differs` → Per-App actually overrides Default. This is the
  Manager's stated scenario (Default 25,000 vs Per-App 27,000).
- `identical` → Per-App matches Default; no Manager-visible
  difference for that tier. Bulk Import would produce the same value
  either way, but the audit log's `template_matched_by_*` counter
  should still increment.
- `default_only` → Per-App has no entry for this tier. **Scenario B
  partial** — if Manager's Excel row matches THIS tier's USD price,
  it'll fall through to auto-bootstrap.
- `perapp_only` → Per-App adds a tier the Default doesn't have. Same
  caveat — only matters if Manager's Excel hits that tier's USD price.

---

## Query 6 — Recent BULK_IMPORT_BATCH audit entries

Reads the per-strategy counters that Hotfix 15 / 16 / 17 introduced.
This is the strongest signal for what actually happened during
Manager's most recent Bulk Import run.

```sql
SELECT
  al.id,
  al.created_at,
  al.actor_email,
  al.payload->>'package_name'                            AS app_package,
  al.payload->>'pricing_source'                          AS pricing_source,
  al.payload->>'rows_total'                              AS rows_total,
  al.payload->>'rows_created'                            AS rows_created,
  al.payload->>'rows_overwritten'                        AS rows_overwritten,
  al.payload->>'rows_skipped'                            AS rows_skipped,
  al.payload->>'rows_failed'                             AS rows_failed,
  al.payload->>'template_matched_rows'                   AS matched_rows,
  al.payload->>'template_matched_by_sku'                 AS matched_by_sku,
  al.payload->>'template_matched_by_currency_price'      AS matched_by_currency_price,
  al.payload->>'template_no_match_rows'                  AS no_match_rows,
  al.payload->>'duration_ms'                             AS duration_ms,
  al.payload->>'batch_id'                                AS batch_id
FROM google_iap_mgmt.actions_log al
WHERE al.action_type = 'BULK_IMPORT_BATCH'
  AND (
        al.payload->>'package_name' ILIKE '%passsdk%'
     OR al.payload->>'pricing_source' IN ('app_template', 'default_template')
  )
ORDER BY al.created_at DESC
LIMIT 20;
```

**Counter interpretation:**

- `matched_by_sku > 0` → some rows matched the template via the
  documented SKU = identifier path (Manager's template indexes by
  SKU).
- `matched_by_currency_price > 0` → rows matched via the Hotfix 16
  USD/currency-tier inference (Manager's template indexes by tier
  name and rows' `(currency, price_micros)` found a matching tier).
- `no_match_rows > 0` (Hotfix 17) → rows for which both strategies
  returned nothing; those rows fall through to Hotfix 14 auto-
  bootstrap via `convertRegionPrices`. **This is the most likely
  explanation for Manager's "25,000 VND" symptom** — the
  auto-bootstrapped value happened to be close to the Default
  template's number, NOT a literal Default fallback.
- `matched_rows + no_match_rows + rows_skipped` should equal
  `rows_total` minus pre-template filtering. If they don't, there's
  a counter-update gap to investigate.

**Old audit entries (pre-Hotfix 17)** won't have the
`template_no_match_rows` field at all — its absence in older rows is
normal and signals "this run happened before Hotfix 17 deploy."

---

## Query 7 — Integrity checks

Detect orphan templates (FK violation) and duplicate scope rows
(REPLACE-ONLY invariant violation). Both should return zero rows on
a healthy database.

```sql
-- 7a. Orphaned APP-scoped templates pointing at non-existent apps.
SELECT
  t.id,
  t.scope_type,
  t.scope_app_id,
  t.uploaded_at,
  t.uploaded_by
FROM google_iap_mgmt.pricing_templates t
WHERE t.scope_type = 'APP'
  AND NOT EXISTS (
    SELECT 1
    FROM google_iap_mgmt.apps a
    WHERE a.id = t.scope_app_id
  );

-- 7b. Multiple templates sharing the same (scope_type, scope_app_id).
--     The schema's partial unique indexes prevent this — empty result
--     is the only healthy outcome.
SELECT
  scope_type,
  scope_app_id,
  COUNT(*) AS template_count
FROM google_iap_mgmt.pricing_templates
GROUP BY scope_type, scope_app_id
HAVING COUNT(*) > 1;
```

**Expected.** Zero rows from both. Non-empty result on 7a indicates
a CASCADE failure; on 7b indicates the partial unique indexes were
dropped — both would warrant their own incident hotfix.

---

## Interpretation matrix

After running Queries 1–7, map the results to one of the four
scenarios below. The "next action" column drives whether the next
hotfix is needed, whether the gap is workflow, or whether to escalate.

| Q2 finding | Q4 finding | Q5 outcome | Q6 `no_match_rows` for the run | Diagnosis | Next action |
|---|---|---|---|---|---|
| GLOBAL only | (n/a) | n/a | (Hotfix 17 would throw) | **Scenario A** — Per-App template never uploaded. | Manager uploads Per-App template in Settings → Pricing Tiers. No code change. |
| Both | Zero rows | `default_only` everywhere | `> 0` | **Scenario B partial** — Per-App template uploaded but doesn't cover VN/VND. | Manager re-uploads with VN entries OR accepts auto-bootstrap. Optionally surface a Per-App-coverage warning in the wizard preview. |
| Both | Rows present, `27000000000` | `differs` | `> 0` (rows still didn't match) | Per-App VN entry exists but the row's `(currency, price_micros)` doesn't match any tier's. **Scenario B precision/lookup gap** — likely Excel row's USD/local price doesn't equal any tier's USD/local entry exactly. | Hotfix 18: surface per-row which tiers were tried + the Excel value, so Manager can adjust the template's tier prices or the Excel base price. |
| Both | Rows present, `27000000000` | `differs` | `0` AND `matched_by_*` populated | Per-App was selected and matched, audit confirms. If the resulting Google IAP STILL shows VN=25,000 → **Scenario C** (scope-wiring bug or the matched tier's entries were wrong). Re-run Query 5 — maybe Per-App template was uploaded but Tier 1's VN price was set to 25,000 there too. | Pull the matched tier identifier from Q6 (correlate by `batch_id`) and inspect that tier's entries — query: `SELECT * FROM google_iap_mgmt.pricing_template_entries WHERE template_id = '<id from Q2>' AND identifier = '<tier from Q6>'`. |
| 7a or 7b non-empty | — | — | — | **Integrity violation** — schema invariant breach. | Escalate to incident; do not run more imports until cleaned. |

## What to send back

Paste in the conversation:

1. **Query 1** row(s) — `package_name`, `default_currency`, `id`.
2. **Query 2** rows — full list, with `entry_count` per row.
3. **Query 5** full output (the comparison column is the most
   informative single signal).
4. **Query 6** top 1–3 rows for the Bulk Import runs that produced
   the wrong result (note the timestamp; pick the run Manager
   observed VN=25,000 on).
5. **Query 7a + 7b** — just whether they returned zero rows or not.

Queries 3, 4 are optional unless Query 5 surfaces an unexpected
shape (then they give the per-tier per-region detail).
