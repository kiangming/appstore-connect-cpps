# Google Bulk Import — Pricing-source relabel + per-item Custom prices

**STATUS: IMPLEMENTED (August 2026).** Phase 1 (relabel/reorder) shipped
in `af75202`; Phase 2+3 (per-item custom prices) in `12e1100` (SC1
RegionPriceCell) → `f19391a` (SC2 model + routes) → `a122968` (SC3 dialog
+ wizard state) → `ecfd7b8` (SC4 execute contract + orchestrator).
All six §2.H questions answered — see §3 for the recorded answers and §4
for the as-built notes, **including two places where this document turned
out to be wrong.**

Scope: **Google IAP Management bulk import only**
(`components/google-iap-management/bulk-import/*`,
`lib/google-iap-management/orchestration/bulk-import.ts`,
`app/api/google-iap-management/apps/[packageName]/bulk-import/*`).
Apple's pricing path (price points, opaque tier IDs, ~175 auto-equalised
territories) is deliberately untouched — its model is genuinely different
and forcing symmetry would be wrong.

Mockup: `docs/google-iap-management/design/bulk-import-custom-prices-mockup.html`

Meta-rules from `docs/iap-management/IAP-MANAGEMENT-KNOWLEDGE-BASE.md`
§10.13.K applied throughout:
**P1** (twin-path: grep every sibling before touching one),
**P2** (`actions_log` CHECK — checked, see §1.7, no new action_type),
**P5** (the status principle: report what actually happened),
**P7** (prefer a missed signal over a wrong one),
**P9** (design-first exactly where the feature looks like a proven pattern).

---

## 1. Investigation findings

Ordered as requested: reuse anchor → execute feasibility → baseline
availability → everything else.

### 1.1 THE REUSE ANCHOR — the detail-view per-country price editor

**Component:** `components/google-iap-management/iap-form/UnifiedPricingTable.tsx`
(420 lines), rendered by `IapForm.tsx:793-802` in **edit mode only**
(`{isEdit && <UnifiedPricingTable … />}`). Create mode uses a different,
older block (`IapForm.tsx:706-780`) — a collapsible list of
`region / price / currency` triplets. **These two are already divergent**
(see the currency finding in §1.5), so the module already carries a
mild two-editor problem; the design below reduces it rather than adding
a third.

**Props / state shape** (`UnifiedPricingTable.tsx:46-56`):

```ts
packageName, sku, regionOverrides: RegionOverrideRow[], baseCurrency,
basePriceDecimal, fieldErrors: Record<string,string>,
onUpdateOverride(index, Partial<RegionOverrideRow>),
onRemoveOverride(index), onAddOverrideForRegion(region, currency)
```

`RegionOverrideRow = { region, currency, priceDecimal }`
(`lib/google-iap-management/form-state.ts:15-19`) — **exactly the same
shape** as the bulk-import row's `regionOverrides`
(`parsers/excel-parser.ts:103-107` `ParsedRegionOverride`). That shape
match is the single most reusable thing in this investigation.

**How it lists countries:** it does **not** list all countries. Rows are
derived from the union of (a) the item's existing overrides and (b) the
live Google prices fetched from
`/api/google-iap-management/apps/{pkg}/iaps/{sku}/live-prices`
(`UnifiedPricingTable.tsx:94-113`), merged by the pure model
`buildUnifiedPricingRows` (`lib/google-iap-management/unified-pricing.ts:65-146`)
and split into visible / collapsed by `partitionPricingRows`
(`unified-pricing.ts:170-185`). The all-countries picker lives elsewhere:
`getAllRegions()` (`lib/google-iap-management/region-name.ts:84-94`),
used by the create-mode block at `IapForm.tsx:734` and `:771`.

**Currency handling:** see §1.5 — display-only in this component.

**What validation it performs: NONE.** The component only *renders*
errors handed to it: `fieldErrors[`override_${index}`]`
(`UnifiedPricingTable.tsx:256-258`, `:405`). The actual validation lives
in the **form**, not the editor: `IapForm.validate()` loops overrides at
`IapForm.tsx:298-304` calling the local `validateDecimal()`
(`IapForm.tsx:56-71`), which delegates to
`validateDecimalForCurrency(input, currency)`
(`lib/google-iap-management/google/currency-precision.ts:92-114`) and
then `decimalToMicros(input)` (`google/price-conversion.ts:53-78`).

> **Consequence for reuse:** dropping `UnifiedPricingTable` into a dialog
> would inherit **zero** validation. Identical validation is guaranteed by
> reusing the *module* (`currency-precision.ts` + `price-conversion.ts`),
> not by reusing the *component*. §2.A builds on that.

**Reusable as-is vs needs extraction:**

| Asset | Verdict |
|---|---|
| `validateDecimalForCurrency`, `getCurrencyDecimals`, `inputStepForCurrency` (`currency-precision.ts:74-125`) | **As-is.** Pure, unit-tested (`currency-precision.test.ts`). |
| `decimalToMicros(dec, currency)` (`price-conversion.ts:53-78`) | **As-is.** Throws on precision violation — the server-side backstop. |
| `regionNameFromCode` / `getAllRegions` (`region-name.ts:84-94`) | **As-is** (with the caveat in §1.5 — ~250 ISO codes, not Google's ~170). |
| Editable price cell (`UnifiedPricingTable.tsx:359-406`) | **Extract** to a shared `<RegionPriceCell>`; both surfaces then render the same input, currency chip, error styling. |
| `buildUnifiedPricingRows` / `partitionPricingRows` (`unified-pricing.ts`) | **Not reusable.** Its row set and its collapse rule are both *defined by the live-Google column*, which does not exist for a not-yet-created SKU. A sibling pure model is needed (§2.A). |
| The panel shell — live column, Sync-from-Google, divergence summary (`UnifiedPricingTable.tsx:154-217`, `:407-413`) | **Not reusable.** Per-SKU live fetch × 100 rows is a non-starter, and "live" is meaningless for `create` rows. |

### 1.2 EXECUTE PAYLOAD SHAPE — feasibility crux

**A per-row price channel already exists, and it is already clobbered.**

1. Wire payload — the wizard sends `regionOverrides` per row today:
   `BulkImportWizard.tsx:498` inside the `rows.map(...)` body at `:481-518`.
2. Route accepts it: `execute/route.ts:56` (type) and `:161-165`
   (trim + forward into `BulkImportRow`).
3. Orchestrator turns it into the Google `prices` map:
   `orchestration/bulk-import.ts:186-194` in `buildProduct`.
4. **The clobber:** when the batch source is a template, the
   template-resolution loop **overwrites the array wholesale** —
   `bulk-import.ts:672-676`:
   ```ts
   row.regionOverrides = entries.map((e) => ({ region: e.regionCode, … }));
   ```
   So under `default_template` / `app_template`, anything the client put
   in `regionOverrides` is silently discarded. Custom prices shipped
   through that field alone would be **silently replaced by the template
   price** — precisely the failure mode the brief forbids.

   There is already a precedent for the correct fix: the cross-currency
   pre-pass marks rows and the same loop skips them at
   `bulk-import.ts:555` (`if (row.crossCurrencyRefusal || row.resolvedDefaultPrice) continue;`).

5. `defaultPrice` is **not** derived from `regionOverrides` — it comes
   from `row.baseCurrency` / `row.basePriceDecimal`, unless the
   cross-currency pre-pass stamped `resolvedDefaultPrice`
   (`bulk-import.ts:203-213`). A custom row therefore needs an explicit
   answer for `defaultPrice` (§2.E).

6. **Regions bootstrap fills the gaps.** For every pushable row the
   orchestrator calls `convertRegionPrices` and merges *only regions the
   row does not already carry* (`bulk-import.ts:797-827` then `:839-846`
   `if (!existing[auto.region])`). So a country left blank in the custom
   dialog does **not** stay unpriced — it gets Google's auto-converted
   price. That must be surfaced, not left implicit (§2.D).

7. **Per-item bodies already carry distinct price sets — confirmed.**
   `upsertInputs` is built per row (`bulk-import.ts:833-875`), each with
   its own `body.prices` and its own `regionsVersion`, then passed as an
   array to `batchUpsertInAppProducts`
   (`google/publisher-client.ts:898-901`, contract documented at
   `:876-897`: order-preserved, index *i* in ↔ index *i* out).
   Nothing in the batch path assumes a shared price set.

8. **100-row cap interacts sanely.** The cap is enforced on
   `pushableRows` *after* skips and refusals (`bulk-import.ts:720-725`),
   and it is a count of rows, not of price entries. A custom row carries
   ~170 price entries instead of ~30, which grows the request body, not
   the row count. Body-size risk is noted in §2.H (Risk R3) — 100 rows ×
   ~170 entries is a plausible multi-MB JSON; it needs a smoke test, not
   a design change.

**Verdict: feasible, with one required contract change** — an explicit
per-row custom-price channel that the template loop must skip. Reusing
the existing `regionOverrides` field alone is **not** acceptable: it is
indistinguishable from the file's GT-Price override
(`excel-parser.ts:442-460`, which yields at most one entry) and carries
no provenance, so the audit log could never answer "why did this item get
this price".

### 1.3 TEMPLATE-PRICE BASELINE AT PREVIEW — partially available, needs one new read

The preview API resolves *which tier* each row matches but **not the
tier's full price set**. `TierCandidate`
(`lib/google-iap-management/queries/templates.ts:600-607`) carries only:

```ts
{ identifier, templateId, regionCount, vnCurrency, vnPriceMicros, vnPriceDecimal }
```

— i.e. the region **count** and the **VN entry only** (deliberate: the
Hotfix-19 dropdown label format, `PreviewTable.tsx:19-27`). The full
per-region rows are read server-side only, at push time, by
`lookupTemplateEntriesForIdentifier` (`queries/templates.ts:299-350`),
called from `bulk-import.ts:574-578` / `:619-623` / `:646-650`.

So: **the dialog has a resolved tier identifier but no per-country
baseline.** Three ways to close the gap, recommendation in §2.A:

- (a) new `GET …/pricing-templates/tiers/{identifier}/entries?scope=&appId=`
  — a thin route over the existing query. Lazy, one call per dialog open.
- (b) fatten the preview response with every candidate's full entry set —
  rejected: 100 rows × ~170 entries inlined into the preview payload,
  paid on every upload whether or not anybody opens the dialog.
- (c) no baseline; dialog opens empty — rejected, the brief requires
  pre-population and an empty dialog invites 170 hand-typed prices.

Note the cross-currency path already resolves the app-currency entry at
preview time (`preview/route.ts:261-282`), proving the read is cheap
enough to do per row when it is actually needed.

**Rows with zero candidates have no baseline at all.** Under a template
source a row can still match nothing (`tierCandidates: []`,
rendered "Auto-converted from USD", `PreviewTable.tsx:136-139`); at push
it falls through to the `convertRegionPrices` bootstrap. For those rows
the only possible baseline is Google's conversion — a live call. §2.B
handles this as an explicit empty-baseline state rather than pretending.

### 1.4 VALIDATION RULES — precision only; no min/max, no "nice price"

- **Per-currency decimals:** `CURRENCY_DECIMALS`
  (`currency-precision.ts:24-63`) — ISO 4217 exponents with two
  deliberate Google-Play divergences noted in-file: `HUF: 0` (`:45`) and
  `TWD: 0` (`:46`). Zero-decimal set includes VND, JPY, KRW, IDR, CLP…;
  three-decimal set BHD/IQD/JOD/KWD/LYD/OMR/TND; `CLF`/`UYW` at 4.
  Unknown → 2 (`:67`, `:74-81`).
- **Enforcement points:** `validateDecimalForCurrency` (`:92-114`,
  returns a message or null) for the UI, and `decimalToMicros(dec, cur)`
  (`price-conversion.ts:53-78`, **throws**) on every write path.
- **Per-country min/max: not implemented anywhere.** Stated explicitly in
  the module header, `currency-precision.ts:16-18`: *"it does NOT enforce
  minimum prices (those are per-developer-payouts-country and change;
  Google still does that check server-side)"*. Confirmed by grep — no
  min/max table exists in `lib/google-iap-management/`.
- **Rounding / "nice price": not implemented.** Google's own
  nice-pricing lives inside `convertRegionPrices`
  (`google/regions-helper.ts:76-101`); hand-typed prices bypass it. This
  is *allowed* by Google (arbitrary valid amounts are accepted) but it
  means a custom price can look "ugly" in-store. UI note, not a block.
- **Does the detail-view editor enforce them?** No — §1.1. The form does.
- **Bulk import's existing pre-flight:** `computePrecisionViolations`
  (`BulkImportWizard.tsx:1068-1089`) validates each row's *base* price
  against its own column currency and hard-gates Push
  (`:544-548`, `:859-879`). It does **not** look at `regionOverrides` at
  all. Custom prices need their own gate wired into the same
  `canContinueFromPreview` expression.

> Template-derived prices are trusted because they were validated at
> template-upload time; hand-typed custom prices have no such history, so
> the **same** precision check must run — client-side to gate Push, and
> again server-side because client state is untrusted (§2.E).

### 1.5 CURRENCY SEMANTICS — derived from country; display-only in the anchor

The code answers the Manager's ambiguous "giá - currency" clearly:

- **Detail view (the anchor): display-only.** The currency renders as a
  `<span>` chip, not an input — `UnifiedPricingTable.tsx:367-369`. Only
  `priceDecimal` is editable (`:370-380`). Promoting an inheriting row
  seeds the currency from Google's live value:
  `onAddOverrideForRegion(row.region_code, row.live?.currency ?? "USD")`
  (`:396-399` → `IapForm.tsx:266-278`).
- **Create-mode legacy block: editable** — a free-text 3-char input
  (`IapForm.tsx:752-753`). This is the older surface and the divergence
  noted in §1.1; changing the region there re-derives the currency
  (`IapForm.tsx:248-253` via `defaultCurrencyForRegion`).
- **Google's model:** each country has one fixed billing currency. The
  canonical source is Google itself — `convertRegionPrices` returns
  `{regionCode → {price: {currencyCode, units, nanos}}}`, unpacked at
  `google/regions-helper.ts:84-97`. Second-best source: the pricing
  template's own `currency` column per `(identifier, region_code)`
  (`queries/templates.ts:340-350`).
- **What we have locally is insufficient on its own:**
  `defaultCurrencyForRegion` (`lib/google-iap-management/regions.ts:56-58`)
  covers only the 30 curated `COMMON_REGIONS` (`regions.ts:19-50`) and
  returns `"USD"` for everything else; `getAllRegions()`
  (`region-name.ts:84-94`) returns ~250 ISO countries with **no**
  currency and includes markets Google does not sell in.

**Decision (code-backed): currency is DERIVED and NOT user-editable in the
custom dialog.** §2.B pins the derivation order.

### 1.6 EXISTING PER-ROW TIER DROPDOWN — where "Custom…" slots in

- State: `tierSelections: Record<number, string>` keyed by **`rowNumber`**
  (`BulkImportWizard.tsx:163-165`), seeded on every preview response
  (`:363-371`), mutated by `setRowTierSelection` (`:416-426`), passed down
  to `PreviewTable` (`:888-893`) and rendered as the Tier column
  (`PreviewTable.tsx:135-182`).
- Gate: `tierStatus` (`BulkImportWizard.tsx:301-325`) counts ambiguous /
  pending / changed / atDefault and blocks Push while `pending > 0`
  (`:544-548`).
- Wire-out: `chosenTierIdentifier` + `defaultTierIdentifier` +
  `tierCandidateCount` per row (`:514-517`).
- Render rule: 0 candidates → italic text, 1 → read-only identifier,
  >1 → `<select>` (`PreviewTable.tsx:136-181`).

**Two traps for "Custom…" as a dropdown entry:**

1. `tierSelections` is keyed by `rowNumber` and **fully reseeded on every
   preview** (`:372-374`). The Manager-locked requirement "Custom survives
   a template change" cannot be met by that map — changing the template
   forces Step 1 → Step 2 → re-upload (the source is sent *with the file*,
   `:336`), which replaces `previewRows` and `tierSelections` wholesale.
   **Custom state must live in a separate map keyed by SKU**, untouched by
   the preview reset (§2.D).
2. The value space is currently "tier identifiers". A literal
   `value="__custom__"` sentinel would leak into `chosenTierIdentifier`
   and hit `lookupTemplateEntriesForIdentifier`, which throws when a tier
   has no entries (`bulk-import.ts:579-585`). Custom must therefore be a
   **separate row attribute**, with the dropdown entry acting only as the
   *trigger* — it must never become the row's selected tier value.
   The 0/1-candidate rows have no `<select>` at all today, so a Custom
   affordance must exist outside the dropdown too (§2.B).

### 1.7 AUDIT / RESULT SURFACES — batch-level today

- **`import_batches` row**, inserted up front (`bulk-import.ts:277-294`)
  with `pricing_source` = the **batch** source; updated with counters at
  `:905-915` / `:918-926`. Schema:
  `supabase/migrations/20260520010000_google_iap_mgmt_init.sql:208-226`.
  **No UI reads this table** (grep: only the Apple module has readers) —
  it is SQL/diagnostics-only.
- **`actions_log`** `BULK_IMPORT_BATCH` payload (`bulk-import.ts:951-1008`):
  batch counters, `pricing_source`, template diagnostics, and
  `per_row_diagnostic[]` (`:505-519`) with
  `{row_index, sku, base_currency, base_price_decimal, candidate_count,
  default_tier_offered, selected_tier, selection_path, match_strategy,
  entries_count, vn_currency, vn_price_decimal}` — **this is the existing
  per-item provenance record and the natural place to add custom
  provenance.** Note `per_row_diagnostic` is only populated inside the
  `pricingSource !== "google_default"` branch (`:521`).
- **P2 check:** `action_type` `'BULK_IMPORT_BATCH'` is already in the
  CHECK constraint
  (`supabase/migrations/20260702120000_google_iap_mgmt_deleted_on_google.sql:50-60`).
  Reusing it ⇒ **no migration, no CHECK change**. `payload` is JSONB and
  unconstrained.
- **Result screen** (`BulkImportWizard.tsx:960-1049`): 5 stat tiles
  (Created / Overwritten / Skipped / Failed / Refused) + a refused-rows
  list (`:992-1011`). It never mentions the pricing source.
- **Hub tracking terminal status:**
  `computeGoogleBulkImportTerminalStatus` (`hub-tracking/status-mapping.ts:33-45`)
  is driven by `failed` only; refusals fold into "skipped"
  (`execute/route.ts:210-220`, rationale at `status-mapping.ts:18-21`).
  **This is a P5 hazard for custom rows** — see §2.E.

### 1.8 PART 1 — the relabel/reorder, and the trap

**There is no string "Google Template" anywhere in the codebase.** Grep
across `*.ts|*.tsx|*.md|*.html|*.sql` (excluding `node_modules`/`.next`)
returns nothing case-insensitively for `Google Template` /
`googleTemplate` in a pricing-source context. The option the Manager means
is the one currently titled **"Google default"**, value `google_default` —
the first card in `PricingSourceSelector.tsx:95-101`. (`GOOGLE_TEMPLATE_FILENAME`
in `parsers/template-spec.ts:55` is the *Excel download* filename, an
unrelated concept — do not touch it.)

**Is it persisted? YES — three places:**

| Where | Evidence |
|---|---|
| **DB column with a CHECK constraint** | `import_batches.pricing_source TEXT CHECK (pricing_source IN ('google_default','default_template','app_template'))` — `20260520010000_google_iap_mgmt_init.sql:213-215`; written at `bulk-import.ts:283` |
| **`actions_log` payload** | `pricing_source: input.pricingSource` — `bulk-import.ts:752`, `:934`, `:958` |
| **Wire value** | execute body `pricingSource` (`execute/route.ts:46`, validated against `VALID_PRICING_SOURCES` `:72-76`); preview form field (`BulkImportWizard.tsx:336`, validated `preview/route.ts:41-46`); single-IAP save body (`lib/google-iap-management/iap-save-body.ts:25`, `:64-66`) |

⇒ **Change the LABEL ONLY. The stored value remains the string
`google_default`** — in the DB column, in the CHECK constraint, in every
historical `actions_log` payload, and on the wire. Renaming it would
invalidate every historical row and force a migration for what is purely
a wording change.

**The reorder is render-order only.** The three `<SourceCard>` JSX blocks
(`PricingSourceSelector.tsx:95-123`) are the render order; nothing else is
order-sensitive:
- `PricingSource` union (`PricingSourceSelector.tsx:6`, `bulk-import.ts:79`) — a TS union, order is cosmetic.
- `VALID_PRICING_SOURCES` arrays (`execute/route.ts:72-76`, `preview/route.ts:42-46`) — consumed via `.includes()`.
- The CHECK constraint's `IN (…)` list — set membership.
- The snap-back effect (`PricingSourceSelector.tsx:72-79`) and the radio group `name="pricing-source"` (`:177`) are position-independent.

**Surfaces carrying the label (P1 sweep — all of them):**

| # | Surface | Location |
|---|---|---|
| 1 | Card title `"Google default"` | `PricingSourceSelector.tsx:98` |
| 2 | Card description ("Base price + sparse manual region overrides + Google's auto-equalisation") | `PricingSourceSelector.tsx:99` |
| 3 | Wizard Step-1 helper copy | `BulkImportWizard.tsx:621-626` |
| 4 | Operator-facing **error message** embedding the raw enum: `…change the pricing source to "google_default"` | `bulk-import.ts:536-538` |
| 5 | Op-guide §6 Step 1 | `docs/google-iap-management/operational-guide.md:140` |
| 6 | Op-guide §4 (single IAP) | `operational-guide.md:99` |
| 7 | Op-guide §7 precedence line | `operational-guide.md:263` |
| 8 | API reference resolution order, item 3 | `docs/google-iap-management/google-api-reference.md:212` |
| 9 | User-docs wizard table | `docs/user-docs/index.html:3652` |
| 10 | User-docs step description | `docs/user-docs/index.html:3685` |

**⚠ Shared-component trap (P1/P8).** `PricingSourceSelector` is **not**
bulk-import-only — `IapForm.tsx:18-21` imports the same component for the
single-IAP Create/Edit form (`hideTierPicker` is the only difference,
`PricingSourceSelector.tsx:17-19`). A rename/reorder there lands on **both**
surfaces. Recommendation: **accept that and apply it to both** — one option
must not have two names in one module. Parameterising labels/order per
caller would be strictly worse (that is how surfaces drift). Flagged for
sign-off, §2.H Q1.

**⚠ Terminology neighbour, deliberately out of scope.** The Pricing
Templates settings page has a **"Google Default Reference"** tab
(`components/google-iap-management/pricing-templates/GoogleDefaultReferenceTab.tsx`),
whose body also glosses the three modes with the label "Google default:"
(`:31-35`). It is a *different* concept (a read-only benchmark matrix).
After the rename the two names drift apart. Recommendation: update the
in-body gloss at `GoogleDefaultReferenceTab.tsx:31-35` (it is describing
the pricing-source mode, so it must follow the rename) but **leave the tab
name "Google Default Reference" alone**. §2.H Q2.

---

## 2. Design

### A. Reuse plan for the price editor

**Principle: one editor cell, one validation module, two containers.**

**Shared (new, extracted once — used by BOTH the detail view and the dialog):**

- `components/google-iap-management/pricing/RegionPriceCell.tsx` —
  lifted verbatim from `UnifiedPricingTable.tsx:359-406`: currency chip +
  decimal input + error styling + `aria-label`. Props:
  `{ regionCode, currency, priceDecimal, error?, onChange(priceDecimal),
  onClear?, disabled? }`. `UnifiedPricingTable` is refactored to render it,
  so a change to the cell lands on both surfaces by construction.
- `lib/google-iap-management/custom-prices.ts` (pure, sibling to
  `unified-pricing.ts`, same testing discipline):
  - `buildCustomPriceRows({ countries, templateEntries, custom })` →
    `Array<{ regionCode, countryName, currency, templateDecimal | null,
    customDecimal | null, state: "template" | "custom" | "inherit" }>`
  - `validateCustomPrices(rows)` → `Array<{ regionCode, error }>`, which
    **calls `validateDecimalForCurrency` — the same module the form uses**
    (`currency-precision.ts:92-114`). No second rule set, no copy.
  - `diffFromTemplate(rows)` → changed-count, for the dialog footer and
    the row badge.

**Reused as-is:** `validateDecimalForCurrency`, `getCurrencyDecimals`,
`inputStepForCurrency` (`currency-precision.ts`), `decimalToMicros`
(`price-conversion.ts`), `regionNameFromCode` / `getAllRegions`
(`region-name.ts`), `getContinentForRegion` / `CONTINENTS`
(`region-continent.ts:92-106`) for the filter pills.

**New, and justified:** the dialog container. `UnifiedPricingTable`'s shell
is a live-vs-tool comparison for one existing SKU — per-SKU live fetch,
Sync-from-Google, and a collapse rule defined by "matches live"
(`unified-pricing.ts:176-183`). None of that exists for a bulk row that may
not be on Google yet. Reusing the shell would mean threading synthesized
index-based handlers and disabling three of its four features — more
coupling, not less.

**Baseline read (resolves §1.3): option (a).** New route
`GET /api/google-iap-management/pricing-templates/tier-entries?scope=GLOBAL|APP&appId=&identifier=`
→ `{ entries: Array<{ regionCode, currency, priceMicros, priceDecimal }> }`,
a thin wrapper over `lookupTemplateEntriesForIdentifier`
(`queries/templates.ts:299-350`) with the same session guard as
`pricing-templates/availability/route.ts:22-25`. Called lazily on dialog
open, cached per `(scope, appId, identifier)` in wizard state.

**Country list + currency derivation order** (fixes §1.5's gap):
1. If the row has a template baseline → the template's own
   `(region_code, currency)` pairs (authoritative for those countries).
2. Union with Google's catalog for countries the template omits. The
   canonical source is `convertRegionPrices`
   (`regions-helper.ts:76-101`), which returns exactly Google's supported
   regions **with each region's billing currency**.
3. Never `getAllRegions()` alone — it is ~250 ISO codes with no currency
   and includes non-Google markets.

Recommendation: expose (2) as
`GET …/google-iap-management/regions/catalog?packageName=` — one
`convertRegionPrices` call for a nominal base price, response cached for
the wizard session, returning `{ regionCode, currency }[]` (~170 entries).
This also gives rows with **no** template baseline an "empty but complete"
country list (§1.3), and it is the same call the push path already makes
per row. **P6 note:** no cross-process cache — request-scoped only; a
stale currency map is worse than one extra call.

### B. Dialog design (mockup: `design/bulk-import-custom-prices-mockup.html`)

Trigger, per row, in the Preview table:
- rows with **>1 candidate** → the existing `<select>` gains a final
  `Custom…` entry, visually separated;
- rows with **0 or 1 candidate** (no `<select>` today,
  `PreviewTable.tsx:136-143`) → a small `Custom…` text button beside the
  tier text. Both open the same dialog.

Dialog anatomy:

- **Header** — `SKU · productId`, and the baseline provenance stated
  plainly: *"Pre-filled from Default Template tier `tier_099` (168
  countries)"*, or *"No template match — every country starts blank and
  will use Google's conversion unless you set it"*.
- **Toolbar** — search (country name, ISO code, currency), continent
  filter pills (`region-continent.ts`), and a `Changed only (N)` toggle.
- **Table** — `Country (code) · Currency (derived, chip) · Price
  (editable) · Template (reference) · Δ`. The `Template` column is the
  same read-only-reference idea as the detail view's "live on Google"
  column, so the two surfaces stay conceptually parallel. `Δ` shows
  `+12%` / `−5%` vs template, or `—`.
- **Row state** — a cleared price renders as `inherits — Google conversion`
  (explicit, never silent — this is the §1.2.6 bootstrap made visible).
- **Footer** — `N of 170 countries customised · M unchanged · K blank
  (Google conversion)`, inline validation errors, then
  `Reset all to template` · `Cancel` · `Save custom prices`.
  Save is **disabled** while any error exists (same discipline as the
  Push gate, `BulkImportWizard.tsx:544-548`).

**Row indicator + re-open (Custom must never be opaque).** A custom row in
the Preview table shows a `Custom` chip in the Tier cell with the count —
`Custom · 168 countries` — plus `View / edit` (re-opens the dialog with the
saved values) and `Reset` (§C). The Base-price cell keeps showing the file
value and gains a `→ custom` marker, mirroring the existing
`cross_currency_resolved` arrow treatment (`PreviewTable.tsx:109-117`).

### C. Revertibility (requirement)

Three equivalent exits, all clearing the same state:
1. **`Reset all to template` inside the dialog** — clears every custom
   entry and closes; the row returns to its tier.
2. **`Reset` link on the Preview row** — one click, no dialog, with an
   undo toast (`sonner` is already wired, `IapForm.tsx:5`).
3. **Re-selecting a tier in the row's dropdown** (ambiguous rows only) —
   choosing any real tier drops Custom for that row.

Reverting restores the row's tier selection from `defaultTierSelection`
(`BulkImportWizard.tsx:363-371`), i.e. exactly the state before Custom.

### D. State model + edge cases

**Where it lives** (this is the load-bearing decision, from §1.6):

```ts
// BulkImportWizard state — a SIBLING of previewRows/tierSelections,
// deliberately NOT keyed by rowNumber and NOT reset by handleUploadAndPreview.
const [customPrices, setCustomPrices] =
  useState<Record<string /* sku */, CustomPriceSet>>({});

interface CustomPriceSet {
  entries: Array<{ region: string; currency: string; priceDecimal: string }>;
  /** Provenance for audit + the dialog header. */
  baseline: { kind: "template"; scope: "GLOBAL"|"APP"; identifier: string } | { kind: "none" };
  editedAt: string; // ISO, for the audit payload
}
```

Keyed by **SKU**, because SKU is the only identity stable across a
re-preview (`rowNumber` is file-position; `tierSelections` proves the
reset problem, `BulkImportWizard.tsx:372-374`).

**Edge cases:**

| Case | Behaviour | Rationale |
|---|---|---|
| Step 3 → Step 1 → change template → re-preview | **Custom survives** (Manager-locked). Custom prices are absolute; the template change simply no longer applies to that row. The dialog header then reads *"Custom — no longer tied to a template"* and the `Template` reference column shows the **new** template's values so the Manager can compare and reset if they want. | Locked decision, plus §1.6 trap 1. |
| Step 3 → Step 2 → upload a **different file** | **Drop customs whose SKU is absent from the new file; keep customs whose SKU is still present** — and show a one-line notice: *"3 custom price sets kept (SKU matched), 2 dropped (SKU not in the new file)."* | **Recommended, flagged for sign-off (§2.H Q3).** Silent-drop-all loses real work; silent-keep-all is invisible. Naming both counts satisfies P5. |
| Switch source to **Google Conversion** | **Keep but deactivate.** Customs are retained in state, every Custom chip greys to `Custom (inactive — not applied under Google Conversion)`, and they are **not** sent in the execute payload. Switching back to a template source reactivates them. | **Recommended, flagged (§2.H Q4).** Clearing on a toggle is destructive and un-undoable; keeping-and-applying would violate the locked "not for Google Conversion" rule. Inactive-but-visible is the only option that is neither lossy nor lying. |
| Page refresh | **Customs are lost.** All wizard state is client-side (`useState`, no persistence — same as `previewRows` and `tierSelections`). | Accepted, but must be *known*: add a `beforeunload` guard when `Object.keys(customPrices).length > 0` and no execute has started, reusing the listener already registered at `BulkImportWizard.tsx:199-214`. Cheap, and it converts a silent loss into a browser prompt. |
| SKU set to **Skip** | Custom retained but not sent (skip rows never reach Google, `bulk-import.ts:296`). Chip greys out. | Consistent with the Google-Conversion case. |
| Tier edited in Settings between preview and push | Unchanged for custom rows — they no longer read the template. (Non-custom rows keep today's hard-fail, `bulk-import.ts:579-585`.) | Custom is absolute by definition. |

### E. Execute contract

**Wire (additive, per row) — `BulkImportWizard.tsx:481-518` gains:**

```ts
customPrices: customPrices[r.sku] && sourceIsTemplate && r.decision !== "skip"
  ? {
      entries: [{ region, currency, priceDecimal }, …],   // omit blanks
      baselineTier: customPrices[r.sku].baseline.kind === "template"
        ? customPrices[r.sku].baseline.identifier : null,
    }
  : null,
```

**Route (`execute/route.ts`)** — extend `ExecuteBody.rows[]` (`:51-69`),
and in the per-row loop (`:145-190`):
1. reject `customPrices` when `pricingSource === "google_default"`
   (400 — the client should never send it; a silent ignore would be a
   quiet lie);
2. reject a non-array / empty `entries`;
3. **re-validate every entry server-side** — `region` non-empty,
   `currency` non-empty, and `validateDecimalForCurrency(priceDecimal,
   currency) === null`. Client state is untrusted; this is the same
   module the dialog uses, so the rules cannot diverge.
   A malformed entry does **not** 400 the whole batch — it marks the row
   refused (below), so one bad row never blocks 99 good ones.

**Orchestrator (`bulk-import.ts`)**:

1. `BulkImportRow` gains
   `customPrices?: { entries: ParsedRegionOverride[]; baselineTier: string | null } | null`.
2. **New pre-pass, before the template loop** — for each actionable row
   with `customPrices`:
   - validate every entry (`decimalToMicros(dec, cur)` in try/catch —
     the throwing backstop, `price-conversion.ts:53-78`);
   - resolve `defaultPrice`: the custom entry whose `currency` equals
     `appDefaultCurrency`, preferring the app's home region;
   - on success stamp `row.regionOverrides = customPrices.entries` and
     `row.resolvedDefaultPrice = { currency, priceMicros }` — reusing the
     field the cross-currency path already established
     (`bulk-import.ts:203-213`), so `buildProduct` needs **no change**;
   - on failure stamp a refusal (below).
3. **Template loop must skip custom rows** — extend the existing guard at
   `bulk-import.ts:555`:
   ```ts
   if (row.crossCurrencyRefusal || row.resolvedDefaultPrice || row.customPrices) continue;
   ```
   This is the single line that prevents the §1.2.4 clobber.
4. Interaction with cross-currency: **Custom wins.** If a row is both
   cross-currency-triggered and custom, the custom pre-pass runs first and
   the cross-currency pre-pass skips it (custom prices are absolute and
   already denominated per country — there is nothing to convert).
5. Bootstrap unchanged (`:797-827`) — the anchor is `resolvedDefaultPrice`,
   which the custom pre-pass has set; blank countries get Google's
   conversion, as surfaced in the dialog (§2.B).

**Failure reporting — never a silent fallback (the hard requirement).**
Reuse the per-row fail-soft channel (`refusedRows`, `bulk-import.ts:460-467`)
with new kinds:

| Kind | Trigger | Message |
|---|---|---|
| `custom_invalid_price` | any entry fails precision/parse | `Row N (SKU): custom price "1.99" is invalid for JPY — JPY only accepts whole numbers. Row not sent.` |
| `custom_no_app_currency_entry` | no entry matches the app's default currency | `Row N (SKU): custom prices carry no <CUR> entry, which Google requires for defaultPrice. Row not sent.` |
| `custom_source_mismatch` | `customPrices` present with `google_default` | rejected at the route (400) — should be unreachable from the wizard |

A custom row that cannot be applied is **excluded from the batch** and
listed on the result screen. It **never** falls through to the template
price. `crossCurrencyRefusal`'s existing plumbing gives this for free:
refused rows are filtered out of `pushableRows` (`:459`) and surfaced in
`BulkImportResult.refusedRows` (`:154-159`) → the result screen's
Refused tile and list (`BulkImportWizard.tsx:986-1011`).

**P5 correction required.** Today refusals fold into "skipped" for the Hub
terminal status (`status-mapping.ts:18-21`, `execute/route.ts:210-220`), so
a batch with a refused custom row still closes **SUCCESS**. A
cross-currency refusal is arguably a soft skip; a **custom refusal is a
Manager instruction that did not happen**, and reporting SUCCESS would be
the status principle violated. Recommendation: count custom refusals into
`failed` for the terminal-status computation only (leaving the
cross-currency semantics untouched), i.e. pass
`failed: result.rowsFailed + customRefusedCount`. Flagged, §2.H Q5.

### F. Provenance

**Per item** — extend `perRowDiagnostic` (`bulk-import.ts:505-519`; note it
is only built inside the non-`google_default` branch at `:521`, which is
exactly where custom applies):

```ts
price_provenance: "custom" | "template" | "cross_currency_resolved" | "auto_bootstrap",
custom_entry_count: number | null,     // entries actually sent
custom_baseline_tier: string | null,   // tier the dialog pre-filled from, or null
custom_blank_regions: number | null,   // countries left to Google conversion
custom_edited_at: string | null,
```

**Per batch** — add to the `BULK_IMPORT_BATCH` payload (`:951-1008`):
`custom_priced_rows`, `custom_refused_rows`, and
`refused_rows[]` entries carrying the new `kind` values (already carried,
`:154-159`).

**No schema change, no migration.** `pricing_source` on `import_batches`
stays the batch-level source (`google_default` unchanged, §1.8);
`actions_log.payload` is JSONB; `action_type` `'BULK_IMPORT_BATCH'` is
already whitelisted (P2 verified, §1.7).

**Result screen** — add a `Custom` stat tile (6 tiles) plus, when
`custom_refused_rows > 0`, the refused list already renders the reason
per SKU (`BulkImportWizard.tsx:992-1011`).

### G. Docs impact (list only — not written in this pass)

| Doc | Change |
|---|---|
| `docs/google-iap-management/operational-guide.md` §6 Step 1 (`:140`) | Rename + reorder the three sources |
| …§6 Step 3 (`:212-235`) | New subsection: Custom prices — open, edit, save, revert; what "blank = Google conversion" means |
| …§6 Step 4 (`:236-252`) | New Custom tile + custom-refusal reasons |
| …§4 (`:99`), §7 (`:263`) | Rename only |
| `docs/google-iap-management/google-api-reference.md` §9 (`:203-217`) | Resolution order gains rule 0: *an item marked Custom uses its custom prices and ignores the template* |
| `docs/user-docs/index.html` (`:3652`, `:3685`) | Rename + reorder + the Custom flow (Cycle-42 user-docs process) |
| `docs/iap-management/IAP-MANAGEMENT-KNOWLEDGE-BASE.md` §10.13.K | If the shared-cell extraction lands, it is a clean **P1** instance (shared choke point over two patches) — worth one line |
| This doc | Flip to IMPLEMENTED + as-built notes at close |

### H. Open questions / risks

**Sign-off gates (Manager):**

- **Q1 — shared selector.** The rename + reorder land on the single-IAP
  Create/Edit form too (`IapForm.tsx:18-21` shares
  `PricingSourceSelector`). Recommend: **yes, apply to both.**
- **Q2 — "Google Default Reference" tab.** Recommend: update the mode
  gloss inside it (`GoogleDefaultReferenceTab.tsx:31-35`), keep the tab
  name. Confirm the Manager is comfortable with the two names differing.
- **Q3 — different file uploaded at Step 2.** Recommend: keep customs
  whose SKU is still present, drop the rest, name both counts.
- **Q4 — switch to Google Conversion.** Recommend: keep-but-inactive
  (greyed chip, not sent), reactivate on switching back.
- **Q5 — terminal status for custom refusals.** Recommend: count them as
  `failed` for the Hub status only (P5). Cross-currency semantics
  unchanged.
- **Q6 — is `defaultPrice` allowed to differ from the custom entry for the
  app's home country?** The design derives it from the app-currency entry.
  Confirm no case exists where the Manager wants the store default to
  differ from the home-country custom price.

**Risks:**

- **R1 — bigger than it looks (the honest headline).** Part 1 is ~10 label
  sites. Part 2 touches: wizard state, PreviewTable, a new dialog, a new
  shared cell (which refactors the *detail view*), 1–2 new API routes, the
  execute body contract, the route validator, the orchestrator pre-pass +
  the skip guard, the audit payload, and the result screen. Treat it as a
  full cycle, not a hotfix. **P9 applies:** this looks like the Hotfix-19
  tier dropdown and is not — §1.6 trap 1 (rowNumber-keyed reset) alone
  breaks the naive implementation.
- **R2 — the clobber line is the whole feature.** If `bulk-import.ts:555`
  is not extended, custom rows silently ship template prices to a live
  store. Acceptance must be a test that **breaks** the guard and watches
  the assertion fail (the P10 mutation-check discipline), not merely a
  green test.
- **R3 — payload size.** 100 rows × ~170 price entries ≈ multi-MB request
  bodies on both `/execute` and Google's `batchUpdate`. Needs a smoke test
  at the 100-row cap (`bulk-import.ts:720-725`) before release; may force a
  practical sub-cap for custom-heavy batches.
- **R4 — no min/max validation exists** (§1.4). Hand-typed prices below a
  country's floor are rejected by Google at push, surfacing as an opaque
  batch-level failure (Google returns no structured per-row errors —
  `bulk-import.ts:33-35`). Mitigation: nothing clever; document it, and
  keep the refusal messages specific.
- **R5 — currency catalog freshness.** The derived currency map comes from
  `convertRegionPrices`, whose catalog moves (the BG → EUR incident,
  `regions-helper.ts:43-62`, Hotfix 9). A dialog opened before a catalog
  change and pushed after could carry a stale currency for a country.
  Mitigation: fetch the catalog per wizard session, never cache
  cross-process (**P6**), and let the server's own precision check refuse
  the row rather than guessing.
- **R6 — two editors already exist** (unified table vs create-mode block,
  §1.1/§1.5, differing on whether currency is editable). Extracting
  `RegionPriceCell` for the dialog is the moment to converge them; if the
  extraction is skipped for speed, the module ends up with three.

---

## 3. Addendum — R3 payload-size de-risk (investigation, August 2026)

Run before Phase 3 UI work, on the principle that if the full-entry-set
payload didn't fit, the design had to change *before* the dialog was
built. **Verdict up front: it fits, with ~3× headroom, and the
Google-side body does not grow at all.** No sub-cap is warranted.

Sign-off status recorded here for the record: all six §2.H questions
answered — **Q1** both surfaces · **Q2** gloss updated, tab name kept ·
**Q3** keep SKU-matched customs, drop the rest, name both counts *and*
the SKUs · **Q4** keep-but-inactive · **Q5** custom refusals count as
`failed` for Hub terminal status · **Q6** no exception — `defaultPrice`
always derives from the app-currency entry.

### 3.1 Measured sizes (B1)

Method: model the execute body exactly as `BulkImportWizard.tsx:481-518`
serializes it, add the proposed `customPrices` block, measure
`Buffer.byteLength(JSON.stringify(…), "utf8")`. Entries are realistic
Google shapes (mixed 0/2/3-decimal currencies, titles ~31 chars,
descriptions ~86 chars against the 55/200 caps).

**Per-row cost**

| Row shape | Bytes |
|---|---|
| 1 locale, no custom | 501 B |
| 8 locales, no custom | 1,642 B |
| 1 locale + 170 custom entries | 10,044 B |
| 8 locales + 170 custom entries | 11,185 B |
| **`customPrices` block alone** | **~9,543 B/row** (~56 B/entry) |

**Full execute body at the 100-row cap**

| Custom rows | 1 locale/row | 8 locales/row |
|---|---|---|
| 0 | 49 KB | 160 KB |
| 10 | 142 KB | 254 KB |
| 25 | 282 KB | 393 KB |
| 50 | 515 KB | 626 KB |
| **100** | **981 KB (0.96 MB)** | **1,092 KB (1.07 MB)** |

Absolute worst realistic case — 100 rows, all custom, all 82 locales
filled: **2.22 MB**. (Unrealistic in practice: it needs a 100-row file
with every locale column populated *and* every row hand-customised.)

Growth is linear at ~9.5 KB per custom row, so the body crosses 1 MB at
roughly **95–100 custom rows** with 1 locale, and ~90 with 8 locales.

### 3.2 The actual limits in this stack (B2)

| Layer | Limit | Citation |
|---|---|---|
| **Next.js App Router Route Handler** | **None.** No body-size check exists in the app-route module — `grep -rn "sizeLimit\|bodySizeLimit\|contentLength" node_modules/next/dist/server/future/route-modules/app-route/*.js` returns nothing. `await req.json()` streams the whole body. | installed `next@14.2.x` |
| Next.js **Server Actions** | `"1 MB"` default | `node_modules/next/dist/server/app-render/action-handler.js:422` and `:493` — `(serverActions?.bodySizeLimit) ?? "1 MB"`. **Does not apply**: execute is a Route Handler with no `'use server'` directive. |
| Next.js **Pages Router** `/pages/api` | `"1mb"` default | `node_modules/next/dist/server/api-utils/node/api-resolver.js:264`. Does not apply — no Pages Router API routes involved. |
| **This repo's config** | None set | `next.config.mjs` has no `serverActions.bodySizeLimit` and no body config of any kind; **there is no `middleware.ts`** in the repo, so no proxy/body-parser layer either. The only size cap in the module is `MAX_BYTES = 5 MB` on the *preview* multipart upload (`preview/route.ts:51`, `:94`) — a different endpoint, unaffected. |
| **Railway inbound** | **No request-body-size limit documented.** Documented instead: **32 KB combined header size**, request bodies must finish uploading within **5 minutes**, requests closed after 5 min inactivity / **15 min** max. | [Railway — Specs & Limits](https://docs.railway.com/networking/public-networking/specs-and-limits) (public docs, not dashboard-only) |
| **Google `monetization.onetimeproducts.batchUpdate`** | **100 elements** ("A list of update requests of up to 100 elements. All requests must update different one-time products."). **No byte-size limit documented.** | [Google Play Developer API — onetimeproducts.batchUpdate](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.onetimeproducts/batchUpdate) |

### 3.3 The decisive finding: the Google-side body already ships full size (B3)

`bulk-import.ts:797-827` runs `convertRegionPrices` for **every pushable
row unconditionally** — not only template rows — and `:839-846` merges
the result into each product's `prices` map for any region the row
doesn't already carry. Every row therefore already leaves for Google
with the full ~170-region set **today, in production, with zero custom
rows**.

Measured, modelling the `batchUpdate` request with 100 products ×
~170 `regionalPricingAndAvailabilityConfigs` (the shape
`onetime-product-adapter.ts:227-259` builds):

| Google-side request | Size |
|---|---|
| 100 products, 1 locale | **1.80 MB** |
| 100 products, 8 locales | **1.91 MB** |

**Per-item custom prices change which numbers are in that body, not how
big it is.** The Google-side payload delta for Phase 3 is *zero*. And
1.8–1.9 MB is not a hypothesis — it is what the production path has been
sending on every 100-row batch since Hotfix 14 Phase 3, successfully.

**Verdict (B3): the full-set approach fits at the 100-row cap.**
Client→server peaks at ~1.07 MB realistic / 2.22 MB pathological against
no enforced limit at any layer; Google-side does not grow. Nothing breaks
at 100 custom rows, and there is no count at which it breaks on size
grounds before the 100-row cap stops it first.

### 3.4 Recommendation (B4): no sub-cap — but two guardrails

A sub-cap would be inventing a restriction the stack doesn't impose, so
**do not add one.** Keep the full-set semantics and the existing 100-row
cap. Two things do deserve attention, neither of which is byte size:

1. **The Server-Action landmine (the one real size risk).** At 100 custom
   rows the body is 0.96–1.07 MB — sitting *exactly* on the 1 MB default
   that Next.js applies to **Server Actions**. Today that limit doesn't
   apply because execute is a Route Handler. If anyone later converts it
   (the module's user-initiated mutations elsewhere *are* Server Actions,
   per the workspace convention), custom-heavy batches would start
   failing at ~95 rows with an opaque error. **Phase 3 should leave a
   comment at the execute route saying the endpoint must stay a Route
   Handler, and why.** Cheap insurance against a plausible refactor.
2. **The scaling ceiling is time, not bytes.** Railway closes a request
   after 5 minutes of inactivity (15 min hard max), and execute does
   100 ÷ `REGIONS_BOOTSTRAP_CONCURRENCY` (5) = **20 sequential waves** of
   `convertRegionPrices` before the batch call
   (`bulk-import.ts:77`, `:797-827`). That is the property worth
   smoke-testing at the cap — and it is a **pre-existing** characteristic,
   not something Phase 3 introduces.

   *Related optimisation, flagged as a trap rather than a suggestion:* a
   custom row that covers all ~170 countries makes its bootstrap merge a
   no-op, so skipping the `convertRegionPrices` call for fully-covered
   custom rows looks like free latency. **Do not do it naively** — that
   call is also the only source of `regionsVersion`, which the patch must
   pin (Hotfix 9, `regions-helper.ts:43-62`; the BG → EUR incident).
   Skipping it would reintroduce exactly that bug.

Explicitly rejected, per the brief and on its own merits: switching to a
diff-against-template payload. It would re-couple custom prices to the
template and reopen the clobber risk (`bulk-import.ts:672-676`) this
design exists to close. Full-set is semantically correct and, per §3.3,
costs nothing on the wire that isn't already being paid.

### 3.5 Response / result payload (B5): no symmetric problem

| Payload | Size at 100 rows |
|---|---|
| HTTP response to the wizard (`BulkImportResult` + a few refused rows) | **717 B** — it is aggregate counters plus refusals only (`bulk-import.ts:1010-1020`), no per-row echo |
| `per_row_diagnostic` entry, with the §2.F custom fields added | 480 B |
| `actions_log` payload for 100 rows | **~47 KB** |

47 KB into a `JSONB` column (`20260520010000_google_iap_mgmt_init.sql:260`,
`payload JSONB NOT NULL DEFAULT '{}'`) is unremarkable — Postgres's field
ceiling is ~1 GB. Note `per_row_diagnostic` is only populated for template
sources (`bulk-import.ts:521`), which is precisely where custom rows live,
so the added fields land where they're needed and cost nothing on
Google-Conversion batches.


---

## 4. As-built notes (August 2026)

Everything in §2 shipped as designed except the two items below. Both are
recorded because the doc, as written, would mislead the next reader.

### 4.1 ⚠ CORRECTION — "the one line that is the whole feature" was wrong

§2.E and §2.H R2 stated that the guard at `bulk-import.ts:555` is the
single point of protection, and mandated a mutation-check on it.

Running that mutation-check is what disproved it. **Deleting
`|| row.customPrices` left the anchor test green.** The reason: the
custom pre-pass stamps `row.resolvedDefaultPrice` (as §2.E itself
instructs), and *that* clause — already in the guard for the
cross-currency path — is what skips an applied custom row. Had the
mutation-check been skipped because the test was green, the cycle would
have shipped believing a clause was load-bearing when it wasn't, and the
real protection would have been untested.

Two protections exist and both are now pinned separately:

| Protection | Covers | Pinned by | Mutation that breaks it |
|---|---|---|---|
| `row.resolvedDefaultPrice` stamp in the custom pre-pass | the SUCCESS path | the anchor test (custom prices reach the payload unchanged) | remove the stamp → anchor fails with template prices in the body |
| `\|\| row.customPrices` in the template-loop guard | the REFUSED path | the provenance test | remove the clause → a refused custom row acquires a second diagnostic claiming provenance `"template"` |

The clause still earns its place: a refused row has no
`resolvedDefaultPrice`, so without it the row gets `regionOverrides`
overwritten with template entries and is audit-logged as template-priced
— and a future refactor that stops excluding refused rows would start
shipping those prices. Keying off the INTENT as well as the outcome is
the durable form. The guard's comment now says this rather than
repeating the claim above.

**Generalisable lesson (P10, sharpened):** a mutation-check is not
ceremony to confirm a test you already believe. It is the only thing that
tells you *which* line your test is actually pinning — and here the
answer was "not the one the design named".

### 4.2 Defects found during implementation, not present in the design

- **The dialog's advertised pre-fill was absent.** The header promised
  "Pre-filled from tier X" while every country rendered as
  `inherits — Google conversion`, because nothing seeded the editable
  values. Now: first open seeds from the template; RE-open seeds from the
  saved set (a country the Manager deliberately cleared must stay clear —
  consulting the template on re-open would silently resurrect it).
- **A dead Save button.** The app-currency reason (§2.B) was gated behind
  clicking Save, but Save is *disabled* when that check fails — so the
  button did nothing and said nothing. Both blocking reasons now render
  as soon as they apply. This is the same opaque-state failure the
  feature exists to prevent, reintroduced in its own UI.
- **`per_row_diagnostic` was missing from the nothing-to-push audit
  payload** — the branch a fully-refused batch takes, i.e. exactly where
  per-item provenance is most needed. Added.
- **`rowsFailed + customRefusedRows` is `NaN`** for a result object
  lacking the new field, and `NaN === 0` is false, so every clean batch
  would have closed FAILED. Caught by two pre-existing tests; guarded
  with `?? 0`.

### 4.3 Confirmed as designed

R3 (payload size) played out as §3 predicted: no sub-cap was needed. The
regions bootstrap is untouched, with a comment at the call site recording
why skipping it for a fully-covered custom row must not be "optimised"
away (it is the only source of `regionsVersion` — Hotfix 9, BG → EUR).
The `use server` posture test from `af75202` remains green.
