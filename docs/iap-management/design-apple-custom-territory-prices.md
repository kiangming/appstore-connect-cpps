# Apple IAP — per-territory Custom Prices (Create + Edit)

**Module**: Apple IAP Management (`lib/iap-management/`, schema `iap_mgmt`) — **NOT** Google IAP.
**Status**: ✅ **IMPLEMENTED** (Aug 2026) — SC1 `c8dcbef` persistence + pure model ·
SC2 `90560fc` dialog + picker + import-existing · SC3 `74b9739` orchestration merge +
both silent gates + submit blocking. Migrations `20260811000000` (P2 fix) and
`20260812000000` (this feature) applied by the Manager.
As-built corrections in **§6** — the original design text above them is kept verbatim.
**Mockup**: `docs/iap-management/design/apple-custom-territory-prices-mockup.html`
**Date**: 2026-08-11

---

## 0. Goal + Manager-locked decisions

Let the Manager override the price for ANY territory — including territories a pricing
template already covers — by picking from the price points Apple actually supports for
that territory. Edited territories show the new value in an adjacent column and are
highlighted amber. After save, the form's Pricing section lists which territories carry a
custom price. On submit, the existing pricing mechanism runs, with custom values winning
over template values for the territories they cover.

| # | Locked decision |
|---|---|
| 1 | Scope covers BOTH the Edit IAP form and the Create IAP form. |
| | ↳ **AS-BUILT wording (Manager, Aug 2026)**: custom prices are available **once a draft exists**, which is a precondition of every create — `canCreate = mode === "edit" && !syncedToApple`, so *Create on Apple* only ever runs from the Edit page. The New form shows *"Save as draft first"*. This adds no step the create flow did not already require, and keeps the write path to one route. See §6.5. |
| 2 | Custom overrides template entries for the territories it covers; territories without a custom keep template/auto behaviour exactly as today. |
| 3 | **Base-price change → STALE, not reset.** Customs are never auto-destroyed. They are marked stale and **submit is blocked** until the Manager resolves it. |

> ⚠ **This is not a port of the Google custom-prices feature.** Apple's model differs at
> the root: price points are **opaque IDs** selected from a per-territory list (never
> free-typed decimals), Apple **auto-equalises** across ~175 territories from a single base,
> and pricing is a **replace-all schedule POST** with no PATCH. The Google cycle's *lessons*
> are applied throughout (§4); its *implementation* is not reused.

---

## 1. GATES

Reported first, before any design. Each gate could have changed the feature's shape; two
of them did.

### G1 ⚠ THE CLOBBER CHECK — verdict: **(c) nowhere to live**, plus a worse-than-Google failure mode if threaded naively, plus **two silent gates on the Edit path**

**The trace, form → Apple.**

| Step | File:line | What it carries |
|---|---|---|
| Form → payload | [IapForm.tsx:168-186](../../components/iap-management/iap-form/IapForm.tsx#L168-L186) `saveBody()` | `reference_name, product_id, type, tier_id, localizations, screenshot_filename, review_note, family_sharable, pricing_source, availability_target` |
| Form-state type | [validation.ts:37-60](../../lib/iap-management/validation.ts#L37-L60) `IapFormState` | same 10 fields — **no per-territory field of any kind** |
| Create route | [create-on-apple/route.ts:107-128](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts#L107-L128) | parses `form` JSON verbatim |
| Create → base USD | [create-on-apple/route.ts:262-273](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts#L262-L273) | `getTierUsdPrice(form.tier_id)` |
| Create → orchestrator | [create-on-apple/route.ts:300-313](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts#L300-L313) | `applyPricingSchedule({ creds, appleIapId, localTierId, usdPrice, source, precheck, audit })` |
| Edit route | [update-on-apple/route.ts:217-250](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/update-on-apple/route.ts#L217-L250) | `updateIapOnApple({ …, newUsdPrice, source, currentTierId })` |
| Edit → pricing stage | [update-orchestration.ts:519-562](../../lib/iap-management/apple/update-orchestration.ts#L519-L562) `runPricingStage` | forwards to the same `applyPricingSchedule` |
| Orchestrator args | [pricing-orchestration.ts:103-131](../../lib/iap-management/apple/pricing-orchestration.ts#L103-L131) `ApplyPricingArgs` | **no custom-prices field exists** |
| Template resolution | [pricing-orchestration.ts:259-340](../../lib/iap-management/apple/pricing-orchestration.ts#L259-L340) | builds `additionalPricePointIds` **exclusively** from template entries |
| Wire | [price-schedules.ts:112-148](../../lib/iap-management/apple/price-schedules.ts#L112-L148) | `allPricePointIds = [base, ...additional]`, one lid each, ONE replace-all POST |

**(a) survive / (b) overwritten / (c) nowhere to live → (c).** There is no field on
`IapFormState`, none on `ApplyPricingArgs`, and no per-territory concept anywhere between
them. The Google clobber (`bulk-import.ts:672-676`, a template loop overwriting per-row
overrides) has no direct analogue here because there is nothing to overwrite yet.

**The Apple-specific hazard is different and worse.** `additionalPricePointIds` is a
**territory-anonymous flat array** ([pricing-orchestration.ts:260](../../lib/iap-management/apple/pricing-orchestration.ts#L260),
[price-schedules.ts:40](../../lib/iap-management/apple/price-schedules.ts#L40)). The territory
exists only *inside* each opaque ID — `{s: iapId, t: territory, p: tier}`, base64
([price-point-id.ts:29-33](../../lib/iap-management/apple/price-point-id.ts#L29-L33)) — and
nothing in the pipeline dedupes by territory. If a custom set were appended to the array
the naive way, a territory covered by BOTH a template entry and a custom would produce
**two `manualPrices` entries for the same territory** at `startDate: null`, each with its
own lid ([price-schedules.ts:116-147](../../lib/iap-management/apple/price-schedules.ts#L116-L147)).
Apple's behaviour for that payload is **UNVERIFIED** — plausibly a `422 ENTITY_ERROR`, plausibly
an undefined last-wins. Either way the tool would be shipping an ambiguous pricing payload to
a live store. Google's clobber replaced a value silently; this would corrupt the request shape.

**The exact merge/guard point where custom must win.** Inside `runPricingFlow`, replacing the
direct pushes at [pricing-orchestration.ts:260](../../lib/iap-management/apple/pricing-orchestration.ts#L260)
and [:324](../../lib/iap-management/apple/pricing-orchestration.ts#L324):

```
resolve base point                            (unchanged, lines 203-257)
overridesByTerritory = new Map<territory, {pricePointId, provenance, customerPrice}>()
  ├─ if source.kind !== "APPLE": template loop writes  provenance:"template"   (lines 263-339)
  └─ ALWAYS: custom loop writes                        provenance:"custom"
     └─────── unconditional Map.set  ◀── THE GUARD POINT. Custom wins here, by construction.
additionalPricePointIds = [...overridesByTerritory.values()].map(v => v.pricePointId)
```

Two properties make this the right shape rather than an ordering convention: the Map key
*is* the uniqueness invariant Apple's payload needs (one manualPrice per territory), and
"custom wins" becomes a single unconditional `set` after the template loop instead of a
condition that a future reader can invert. The custom loop must sit **outside** the
`if (source.kind !== "APPLE")` block at [:263](../../lib/iap-management/apple/pricing-orchestration.ts#L263)
— customs apply under all three sources (§2.A, rule CP-2).

**Two additional gates that would silently drop a customs-only edit** — neither is a
clobber, both are "the feature does not exist for the user":

1. [diff-detector.ts:226-234](../../lib/iap-management/apple/diff-detector.ts#L226-L234) `isEmptyDiff`
   has exactly 5 clauses (`attributes / localizations / screenshot / tier / availability`).
   A customs-only change satisfies all 5 → `isEmptyDiff` is `true` →
   [update-on-apple/route.ts:198-211](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/update-on-apple/route.ts#L198-L211)
   returns `NO_CHANGES` before any stage runs, and
   [IapForm.tsx:349-352](../../components/iap-management/iap-form/IapForm.tsx#L349-L352)
   never even opens the confirm modal ("No changes detected — nothing to push to Apple").
2. [update-orchestration.ts:527-531](../../lib/iap-management/apple/update-orchestration.ts#L527-L531)
   `shouldRun = diff.tier_changed !== null || effectiveSource.kind !== "APPLE"`. A
   customs-only change with `pricing_source === "APPLE"` skips Stage 4 entirely.

Both need a `custom_prices_changed` clause. Design §2.A.4 covers the threading; §2.J lists
this as the highest-likelihood implementation miss.

**Also load-bearing for §2.E**: the template loop excludes the base territory
([pricing-orchestration.ts:277](../../lib/iap-management/apple/pricing-orchestration.ts#L277)
`e.territory_code !== baseTerritory`), and the base has exactly one slot in the wire payload
(`applePricePointId`, [price-schedules.ts:32](../../lib/iap-management/apple/price-schedules.ts#L32)).
The pipeline is structurally incapable of accepting a base-territory override.

---

### G2 ⚠ PRICE POINTS AT CREATE TIME — verdict: **FEASIBLE**, via a shape change (store prices, not IDs) + a donor IAP for the picker list

**Spec location**: `docs/iap-management/openapi.oas.json` (App Store Connect API **v4.3.1**)
and `docs/openapi.oas.v20260717.json` (**v4.4.1**). Both were enumerated; the price-point
surface is identical in the two except for one added subscription path.

**Every `pricePoints` / `PricePoints` path in the spec:**

| Path | Verb | Required path param | Filters | limit max |
|---|---|---|---|---|
| `/v2/inAppPurchases/{id}/pricePoints` | GET | **an IAP id** | `filter[territory]` (array) | 8000 |
| `/v2/inAppPurchases/{id}/relationships/pricePoints` | GET | an IAP id | `filter[territory]` | 8000 |
| `/v1/inAppPurchasePricePoints/{id}/equalizations` | GET | **a price-point id** | `filter[territory]`, `filter[inAppPurchaseV2]` | 8000 |
| `/v1/inAppPurchasePricePoints/{id}/relationships/equalizations` | GET | a price-point id | same | 8000 |
| `/v1/apps/{id}/appPricePoints` | GET | an app id | `filter[territory]` | 200 |
| `/v1/apps/{id}/relationships/appPricePoints` | GET | an app id | `filter[territory]` | 200 |
| `/v3/appPricePoints/{id}` (+`/equalizations`, +`/relationships/equalizations`) | GET | an app-price-point id | `filter[territory]` | 8000 |
| `/v1/subscriptions/{id}/pricePoints`, `/v1/subscriptionPricePoints/{id}` (+equalizations, +`adjustedEqualizations` in v4.4.1) | GET | a subscription / sub-price-point id | — | 8000 |

**Findings:**

- **There is NO non-IAP-scoped `inAppPurchasePricePoints` LIST endpoint.** Every read of the
  IAP price catalog requires either an existing IAP id or an existing price-point id. This
  confirms the code's standing claim at
  [price-points.ts:3-5](../../lib/iap-management/apple/price-points.ts#L3-L5) ("Apple scopes
  price points per-IAP — there is no per-app endpoint that lists the full price catalog").
- `/v1/apps/{id}/appPricePoints` is **a different resource type** (`appPricePoints` — the
  price of a *paid app*, not an IAP). `inAppPurchasePriceSchedules` requires
  `inAppPurchasePricePoints`-typed IDs
  ([price-schedules.ts:137-141](../../lib/iap-management/apple/price-schedules.ts#L137-L141)),
  so app price points cannot be substituted even if the underlying tier ladder matches.
- `/v1/inAppPurchasePricePoints/{id}/equalizations` is a genuinely useful endpoint we do not
  currently use: given ONE price point, it returns the equalised point in other territories
  (with `filter[territory]` narrowing). It still needs a price-point id, so it does not
  unblock a not-yet-created IAP by itself — but it is the cheapest way to answer "what will
  Apple auto-equalise territory X to, for this base tier?", which is the dialog's
  `provenance: auto` column. Flagged as an optimisation, not a v1 dependency (§2.J-4).

**Can price points be borrowed from another existing IAP? YES — and this is already proven in
production, not a hypothesis.**
[price-point-id.ts:1-27](../../lib/iap-management/apple/price-point-id.ts#L1-L27) and
[batch-price-point-catalog.ts:1-32](../../lib/iap-management/apple/batch-price-point-catalog.ts#L1-L32)
establish that the `(territory, customerPrice) → priceTier` mapping is **Apple's global
catalog, identical across every IAP**; only `s` (the IAP id) differs in the opaque ID, and the
ID is a deterministic `base64_standard_UNPADDED(JSON({s,t,p}))` verified byte-for-byte against
real Apple captures (`docs/iap-management/sample_flow_create_price.md`), with a round-trip
guard that disables derivation if Apple ever changes the encoding
([batch-price-point-catalog.ts:113-124](../../lib/iap-management/apple/batch-price-point-catalog.ts#L113-L124)).
Cycle 43 §10.13.I is the LANDMARK entry. So the **list of prices Apple offers in territory X
is app-independent and IAP-independent**; only the IDs are per-IAP.

**Can the local `iap_mgmt.price_tier_territories` cache populate the picker offline?**
Partially — and it is the **wrong source of truth for "what Apple supports"**:

- It is populated by a **Manager-uploaded CSV**, not from Apple:
  [price-tiers.ts:295-421](../../lib/iap-management/queries/price-tiers.ts#L295-L421)
  `replacePriceTiers(parsed: PriceTiersParseResult, …)`.
- It was superseded as the pricing source of truth by the template tables in IAP.p1.a:
  [templates.ts:11-13](../../lib/iap-management/queries/templates.ts#L11-L13) ("retained as
  defensive backup (Q-B) but is no longer the source of truth for pricing decisions"), with
  its rows migrated into the Default Template
  (`supabase/migrations/20260519000000_iap_mgmt_pricing_templates.sql:74-94`).
- Shape: `(tier_id, territory_code, currency_code, customer_price, proceeds)`, PK
  `(tier_id, territory_code)`, ~16,800 rows
  (`supabase/migrations/20260515000000_iap_mgmt_init.sql:41-51`). The distinct
  `customer_price` values for a territory therefore number **~96 (one per uploaded tier)**,
  against **~600 real Apple price points per territory**
  ([price-points.ts:46-48](../../lib/iap-management/apple/price-points.ts#L46-L48)).
- Worse: an entry can name a price Apple has **no point for at all** — that is precisely the
  existing `missing_price_points` / `partial-template-fail` outcome
  ([pricing-orchestration.ts:326-334](../../lib/iap-management/apple/pricing-orchestration.ts#L326-L334)).
  A picker built on this table can therefore offer prices Apple will reject.

It is still **actively read** on the Apple pricing path (`getTierUsdPrice` at
[price-tiers.ts:125-141](../../lib/iap-management/queries/price-tiers.ts#L125-L141), called by
both single-IAP routes), so Q-B retention is confirmed — but "still read" is not "authoritative
for Apple's catalog".

**VERDICT — custom-at-CREATE is feasible. The unlock is a shape decision, not an endpoint.**

> **Store customs as `(territory_code, customer_price, currency_code)` — the same shape as a
> template entry (`FlatTemplateEntry`) — NEVER as price-point IDs.**

Price-point IDs are then resolved server-side at submit time, inside the orchestrator,
**exactly as template entries are resolved today**
([pricing-orchestration.ts:319-324](../../lib/iap-management/apple/pricing-orchestration.ts#L319-L324)).
This makes Create and Edit structurally identical, because the orchestrator always runs
*after* the Apple IAP shell exists: `POST /v2/inAppPurchases` →
[create-on-apple/route.ts:200-225](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts#L200-L225)
→ `applyPricingSchedule` at [:300](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts#L300).
The "no `apple_iap_id` at Create" problem never touches the write path.

What Create *does* need is the picker's **option list** — the customerPrice values Apple offers
in territory X. Sources, in preference order:

1. **A donor IAP in the same app** — any `iap_mgmt.iaps` row with `apple_iap_id IS NOT NULL`
   and the same `app_id` (prefer the same `type`, see §2.J-2), read via the existing
   `listPricePointsForIap(creds, donorId, territory)`. Authoritative, live, and correct
   because the catalog is global. Cost: one donor, no derivation needed (we want *prices*,
   not IDs).
2. **A donor IAP in any other app on the same ASC account** — same argument, one extra query.
   Uses `iap_mgmt.iaps` joined to `iap_mgmt.apps.asc_account_id`.
3. **No donor at all** (the very first IAP of a brand-new app on a fresh account): **do not
   silently fall back to `price_tier_territories`.** Disable the Custom prices affordance with
   an explicit reason — *"Custom prices need Apple's price list, which this tool reads through
   an existing IAP. Create this IAP first, then edit it to add custom prices."* An honest
   dead-end beats a picker populated from a Manager CSV that Apple may reject. Flagged for
   Manager confirmation (§2.J-1).
4. **Edit mode** always has its own `apple_iap_id` → path 1 collapses to "use this IAP".

---

### G3 FETCH COST + BATCHING — verdict: **lazy-per-territory, ~1 request per edited territory. The eager 175-territory fetch is not needed at all.**

- **Does `filter[territory]` accept MULTIPLE territories?** **The contract says yes.** Both
  spec versions declare it `{"type": "array", "items": {"type": "string"}}` with
  `"style": "form", "explode": false` — i.e. comma-separated repeated values in one query
  parameter. Current code sends exactly one
  ([price-points.ts:50](../../lib/iap-management/apple/price-points.ts#L50)).
  **UNCERTAIN in practice**: no live capture in this repo exercises the multi-value form, and
  KB §4.1 / §4.6 are two standing proofs that "Apple API specification ≠ Apple API behavior".
  **What would settle it**: one GET of
  `/v2/inAppPurchases/{knownId}/pricePoints?filter[territory]=USA,VNM,JPN&include=territory&limit=8000`
  and counting distinct `included` territories — 3 means supported, 1 (or a 400) means not.
  The design does **not depend on the answer** (see below).
- **Page size / total count**: `limit` max **8000** (spec), Apple's USA catalog **~600** points
  ([price-points.ts:46-48](../../lib/iap-management/apple/price-points.ts#L46-L48)). Current
  code requests `limit=1000` and still follows `links.next`
  ([price-points.ts:49-66](../../lib/iap-management/apple/price-points.ts#L49-L66)) — so a
  single-territory read is **one request, one page** in practice, with pagination already
  handled for the tail case.
- **Realistic cost, eager vs lazy:**

  | Strategy | Requests | Payload | Verdict |
  |---|---|---|---|
  | Eager, all ~175 territories, one at a time (today's shape) | ~175 | ~105,000 point objects | Dialog-open latency measured in tens of seconds; a meaningful slice of Apple's ~3,600/hr budget (KB §4.9) for one dialog open. **No.** |
  | Eager, batched via `filter[territory]` at ~13 territories/page | **~14** | same ~105,000 objects | Request count is fine; the *payload* is not — tens of MB to the browser for data the Manager will use ~5 rows of. And it depends on the UNCERTAIN multi-value support. **No.** |
  | **Lazy, per territory, on picker open** | **1 per edited territory** (~600 options) | ~600 objects | Manager edits a handful of territories, not 175. Typical dialog session: **< 10 requests**. **Yes.** |

  The eager fetch is unnecessary because the dialog's **175-row baseline** (the "Current
  price" + provenance column) does **not** come from price points at all: template values come
  from the DB (`price_tier_template_entries`), existing manual prices come from the live
  schedule read (G4), and `auto` rows are labelled as auto rather than valued. Only a row the
  Manager actually opens needs Apple's list.
- **Is `territory-price-points-cache.ts` reusable?** **No — orchestration-lifetime only, by
  design.** [territory-price-points-cache.ts:5-15](../../lib/iap-management/apple/territory-price-points-cache.ts#L5-L15)
  states it is per-IAP per-orchestration and that "No sharing across IAPs is possible"
  (written before the Cycle 44 derivation discovery, but the lifetime claim stands: it is
  constructed inside `runPricingFlow` at
  [pricing-orchestration.ts:218](../../lib/iap-management/apple/pricing-orchestration.ts#L218)
  and holds `creds`). `batch-price-point-catalog.ts` is closer (cross-IAP, keyed by
  `iapType::territory`) but is likewise constructed per batch and exists to amortise a
  *write* orchestration.
  **Reuse the function, not the cache**: a thin new route
  `GET /api/iap-management/apps/[appId]/iaps/[iapId]/price-points?territory=VNM` that calls
  the existing `listPricePointsForIap` and returns `{customerPrice, currency}[]`. Cache in the
  **dialog's own React state** for the dialog's lifetime. Per KB **P6**, do NOT add a
  server-side in-memory cache on this cold path — a stale multi-instance cache is worse than
  no cache. (Note the existing `getAllTerritoryIds` 
  [availabilities.ts:76-95](../../lib/iap-management/apple/availabilities.ts#L76-L95) *does*
  hold a module-level TTL cache; that is a pre-P6 surface and is not a precedent to extend.)

---

### G4 READING THE CURRENT PRICE SET (Edit path) — verdict: **the correct full-set read already exists and is truncation-safe; the Edit page does not call it. Needs a new lazy fetch, but zero new Apple plumbing.**

- **The full-set read**: [price-schedules.ts:308-375](../../lib/iap-management/apple/price-schedules.ts#L308-L375)
  `getPriceScheduleForIap` — Stage 1 `GET /v2/inAppPurchases/{id}/iapPriceSchedule?include=baseTerritory,manualPrices&limit[manualPrices]=50`
  (treated as advisory only), Stage 2 `GET /v1/inAppPurchasePriceSchedules/{id}/manualPrices?include=inAppPurchasePricePoint,territory&limit=200`
  with `links.next` pagination capped at `MAX_STAGE2_PAGES = 20`
  ([:247-306](../../lib/iap-management/apple/price-schedules.ts#L247-L306)) and a loud warn when
  `collected < meta.paging.total`. Unpacked by
  [iap-detail.ts:211-273](../../lib/iap-management/queries/iap-detail.ts#L211-L273)
  `unpackPriceSchedule` → `{ baseTerritory, basePrice, entries[{ priceId, startDate, endDate, territory, customerPrice, currency }] }`.
- **KB §4.1 (V2 `?include` truncates relationship enumeration at 10 IDs) is already mitigated
  inside that function** — [price-schedules.ts:200-217](../../lib/iap-management/apple/price-schedules.ts#L200-L217)
  and [iap-detail.ts:224-233](../../lib/iap-management/queries/iap-detail.ts#L224-L233) both
  document walking Stage 2's prices directly instead of Stage 1's `manualPrices.data`. **Do not
  re-derive this**; call `getPriceScheduleForIap` and inherit the fix.
- **Which call does the current edit/view path use?**

  | Surface | Calls `getPriceScheduleForIap`? |
  |---|---|
  | View Detail page (`iaps/[iapId]/view`) | YES — via [iap-detail.ts:317](../../lib/iap-management/queries/iap-detail.ts#L317) |
  | Export (`apps/[appId]/export`) | YES — via [export-fetch.ts:82](../../lib/iap-management/apple/export-fetch.ts#L82) |
  | **Edit form page** (`iaps/[iapId]`) | **NO** — [iaps/[iapId]/page.tsx:32-130](../../app/(dashboard)/iap-management/apps/[appId]/iaps/[iapId]/page.tsx#L32-L130) loads `getIapWithRelations`, `listTiers`, `getAvailabilityForIap` + `getAllTerritoryIds`, `getTemplateSummary` ×2 — no price-schedule read at all. |

- ⇒ **This dialog's Edit-mode baseline needs a new fetch.** Recommendation: put it behind the
  **dialog open**, not the page render. `iaps/[iapId]/page.tsx` is already `force-dynamic` with
  three sequential Apple round-trips; adding a 2-stage paginated schedule read to every Edit
  page load would tax every visit for a dialog most visits never open. New route:
  `GET /api/iap-management/apps/[appId]/iaps/[iapId]/price-schedule` → `unpackPriceSchedule`
  output, called on first dialog open.
- **One trap to encode**: `unpackPriceSchedule` returns FUTURE-dated entries too
  (`startDate !== null` — that is what feeds the view's `UpcomingChangesTable`). The dialog
  must filter to `startDate === null` or it will read a scheduled future change as the current
  price.

---

### G5 THE THREE TERRITORY STATES — verdict: distinguishable, but two of the three are weaker claims than they look. The dialog must show **provenance**, and two provenances need a qualifier.

At submit time, exactly one of these decides a territory's price:

| # | State | How it is distinguished, in code | Strength of the claim |
|---|---|---|---|
| 1 | **TEMPLATE** | A row in `price_tier_template_entries` with `tier_id = form.tier_id` AND `territory_code != baseTerritory`, in the scope named by `pricing_source` — [pricing-orchestration.ts:263-278](../../lib/iap-management/apple/pricing-orchestration.ts#L263-L278) + [templates.ts:148-195](../../lib/iap-management/queries/templates.ts#L148-L195). Apple templates are already a **sparse** Tier × Territory matrix ([pricing-orchestration.ts:15-20](../../lib/iap-management/apple/pricing-orchestration.ts#L15-L20)). | ⚠ **A claim, not a guarantee.** If the template's `customer_price` has no Apple point, the entry lands in `missing_price_points` ([:326-334](../../lib/iap-management/apple/pricing-orchestration.ts#L326-L334)) and the territory silently falls back to AUTO with a `partial-template-fail` outcome. Label such values **"template (unverified)"** until matched against Apple's live list. |
| 2 | **AUTO (Apple equalisation)** | The default: any territory in neither (1) nor `additionalPricePointIds`. Apple derives it from the base point — [price-schedules.ts:29-31](../../lib/iap-management/apple/price-schedules.ts#L29-L31), [pricing-orchestration.ts:16-17](../../lib/iap-management/apple/pricing-orchestration.ts#L16-L17). | Reliable, but **the tool does not know the value**. Nothing in the repo computes Apple's equalisation. Render as `— auto —`, not as a number. (`/v1/inAppPurchasePricePoints/{id}/equalizations` could supply real values — §2.J-4.) |
| 3 | **EXISTING MANUAL** (Edit only) | An entry from `unpackPriceSchedule` with `startDate === null` and `territory !== baseTerritory`. | ⚠ **Doubly weak.** (a) It is what a *previous* submit wrote, so it may itself have originated from a template or a custom — Apple does not record which. (b) **It is wiped by the next submit**: the POST is replace-all ([price-schedules.ts:2-8](../../lib/iap-management/apple/price-schedules.ts#L2-L8)), so any live manual price not re-sent reverts to AUTO. |

**(3b) is the single most important thing the dialog must communicate.** It is already
today's behaviour — an Edit that changes only the tier already silently drops every live
manual price Apple Connect shows — and it is why a bare number per row is not enough. A row
reading `¥1,200` with no provenance would let a Manager assume it will persist. The dialog
labels it *"on Apple now · will revert to auto unless you set a custom"*.

---

### G6 BASELINE FINGERPRINT COMPONENTS — verdict: fingerprint is `{ tier_id, pricing_source, base_territory }`. **`pricing_source` does NOT move the base price on the two surfaces this feature touches** — only bulk does that.

| Input | Where it lives in form state | Moves the **base** price point? | Moves **non-base** territories? |
|---|---|---|---|
| `tier_id` | [IapForm.tsx:577-596](../../components/iap-management/iap-form/IapForm.tsx#L577-L596) → `IapFormState.tier_id` ([validation.ts:41](../../lib/iap-management/validation.ts#L41)) | **YES** — `getTierUsdPrice(tier_id)` at [create-on-apple/route.ts:265](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts#L265) and [update-on-apple/route.ts:225](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/update-on-apple/route.ts#L225) | **YES** — the template loop filters entries by `e.tier_id === args.localTierId` ([pricing-orchestration.ts:276](../../lib/iap-management/apple/pricing-orchestration.ts#L276)) |
| `pricing_source` | [IapForm.tsx:548-555](../../components/iap-management/iap-form/IapForm.tsx#L548-L555) → `IapFormState.pricing_source` ([validation.ts:55](../../lib/iap-management/validation.ts#L55)), persisted in `iap_mgmt.iaps.pricing_source` (`20260520000000_iap_mgmt_p1j_hotfix.sql:24-25`) | **NO, on these two surfaces.** Both single-IAP routes call `getTierUsdPrice` ([price-tiers.ts:125-141](../../lib/iap-management/queries/price-tiers.ts#L125-L141)), which reads the legacy `price_tier_territories` USA/USD row **regardless of source**. Only bulk-import resolves the base per source, via `listUsdTiersForSource` ([execute/route.ts:413](../../app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts#L413), [templates.ts:225-255](../../lib/iap-management/queries/templates.ts#L225-L255)). The Cycle 43 §10.13.H alignment landed on bulk only — a live twin-path gap (KB **P1**), out of scope here but load-bearing for this answer. | **YES** — it selects which template's entries are read at all ([pricing-orchestration.ts:263-267](../../lib/iap-management/apple/pricing-orchestration.ts#L263-L267)); `APPLE` reads none. |
| **base territory** | **Not a form input.** [IapForm.tsx:562-568](../../components/iap-management/iap-form/IapForm.tsx#L562-L568) renders a *disabled* `<select value="USA">` with the note "USA / USD only in v1 — multi-base in a follow-up". `IapFormState` has no field. `iap_mgmt.iaps.base_territory TEXT NOT NULL DEFAULT 'USA'` exists (`20260515000000_iap_mgmt_init.sql:94`) but **no pricing path reads it** — neither route passes `baseTerritory`, so [pricing-orchestration.ts:191](../../lib/iap-management/apple/pricing-orchestration.ts#L191) resolves `"USA"` on every call. | n/a (constant today) | n/a |
| `type` | [IapForm.tsx:483-501](../../components/iap-management/iap-form/IapForm.tsx#L483-L501); **locked in edit mode** ([IapForm.tsx:420](../../components/iap-management/iap-form/IapForm.tsx#L420)) | No | *Possibly* — `batch-price-point-catalog.ts` keys its cache by `iapType` because "We cannot prove the catalogs are identical across types" ([:29-31](../../lib/iap-management/apple/batch-price-point-catalog.ts#L29-L31)). Unproven either way. |

**Fingerprint = `{ tier_id, pricing_source, base_territory }`.**

`base_territory` is included **even though it is a constant today**, because it is exactly the
field the promised "multi-base in a follow-up" moves — a fingerprint that omits it silently
stops detecting staleness the day that lands. `type` is deliberately **excluded** in v1: it is
locked on both surfaces this feature touches, and the catalog-varies-by-type claim is
explicitly unproven (§2.J-2).

---

## 2. DESIGN

Scoped-lock discipline: every rule below carries the scope it was decided in, in the rule
itself. KB **P1**'s companion instance (a Google rule enforced outside the scope it was
correct in) is the reason.

### A. Where the custom set lives, and how it reaches the orchestrator

**A.1 — Data model.** One shape, three homes, no "empty means two things".

```ts
// lib/iap-management/validation.ts — added to IapFormState
interface CustomPriceEntry {
  territory_code: string;   // Apple alpha-3: "VNM", "JPN"
  customer_price: number;   // picked from Apple's list; NEVER free-typed
  currency_code: string;    // DISPLAY metadata only — never a join key (see I.2)
}
interface CustomPriceBaseline {          // the G6 fingerprint
  tier_id: string;
  pricing_source: PricingSourceKind;
  base_territory: string;                // "USA" today; see G6
}
// IapFormState gains:
custom_prices?: CustomPriceEntry[];              // absent or [] === no customs. ONE meaning.
custom_prices_baseline?: CustomPriceBaseline | null;
```

`CustomPriceEntry` is deliberately isomorphic to `FlatTemplateEntry`
(`tier_id, territory_code, currency_code, customer_price, proceeds` minus the two fields a
custom has no concept of) so the orchestrator's resolution loop is the same code shape for
both.

**A.2 — Persistence** (required, not optional — see A.3):

```sql
-- new forward-only migration
CREATE TABLE iap_mgmt.iap_custom_prices (
  iap_id          UUID            NOT NULL REFERENCES iap_mgmt.iaps(id) ON DELETE CASCADE,
  territory_code  TEXT            NOT NULL,
  currency_code   TEXT            NOT NULL,
  customer_price  NUMERIC(18,4)   NOT NULL,
  PRIMARY KEY (iap_id, territory_code)          -- ◀ the one-per-territory invariant, in the DB
);
ALTER TABLE iap_mgmt.iaps
  ADD COLUMN custom_prices_baseline_tier_id        TEXT,
  ADD COLUMN custom_prices_baseline_pricing_source TEXT,
  ADD COLUMN custom_prices_baseline_base_territory TEXT;
```

Rationale for a table over a JSONB column: the PK **is** the "one manualPrice per territory"
invariant from G1, enforced by the database rather than by the merge code; `NUMERIC(18,4)`
matches `price_tier_template_entries` exactly so the same value survives both paths
identically; and it stays greppable for the Manager diagnostic SQL convention (KB §8.1).
Row count is bounded at ~175 per IAP. Three explicit fingerprint columns rather than one
JSONB blob, for the same diagnostic-SQL reason — and NULL across all three means "no customs",
matching `custom_prices` absent.

**A.3 — Why persistence is mandatory (a Create-flow structural fact, not a nice-to-have).**
`canCreate = mode === "edit" && !syncedToApple`
([IapForm.tsx:421](../../components/iap-management/iap-form/IapForm.tsx#L421)). There is no
"Create on Apple" button on the New form: New → **Save as Draft** → `POST /apps/{appId}/iaps`
→ `router.push` to the Edit page ([IapForm.tsx:191-210](../../components/iap-management/iap-form/IapForm.tsx#L191-L210))
→ *then* Create on Apple. **Every** create-on-apple therefore runs from the Edit page, and any
custom set entered on the New form must survive a full server round-trip and page navigation.
Client-only state would lose it silently.

**A.4 — The threading list (N-layer cascade audit).** A new field crossing this many layers has
a known canonical miss site: the page-level intermediate payload between component state and
the server call. Here there are **two**, and the second one is a divergent twin.

| # | Layer | File:line |
|---|---|---|
| 1 | `IapFormState` + `CustomPriceEntry` types | [validation.ts:37-60](../../lib/iap-management/validation.ts#L37-L60) |
| 2 | `emptyIapForm()` create default | `lib/iap-management/validation.ts` |
| 3 | Edit page `initial` construction | [iaps/[iapId]/page.tsx:91-108](../../app/(dashboard)/iap-management/apps/[appId]/iaps/[iapId]/page.tsx#L91-L108) |
| 4 | `IapForm` state + dialog wiring + Pricing-section summary | [IapForm.tsx:95-98, 542-628](../../components/iap-management/iap-form/IapForm.tsx#L542-L628) |
| 5 | **`saveBody()`** — feeds Save-Draft(create), Create-on-Apple, Update-on-Apple | [IapForm.tsx:168-186](../../components/iap-management/iap-form/IapForm.tsx#L168-L186) |
| 6 | ⚠ **`handleSaveDraft` edit-branch inline body** — builds its OWN payload and does **not** call `saveBody()` | [IapForm.tsx:212-222](../../components/iap-management/iap-form/IapForm.tsx#L212-L222) |
| 7 | `POST /apps/[appId]/iaps` — zod `FormSchema` | [iaps/route.ts:17-37](../../app/api/iap-management/apps/[appId]/iaps/route.ts#L17-L37) |
| 8 | `PATCH /iaps/[iapId]` — zod `PatchSchema` | [iaps/[iapId]/route.ts:17-38](../../app/api/iap-management/iaps/[iapId]/route.ts#L17-L38) |
| 9 | `createDraftIap` / `updateIap` / `getIapWithRelations` | `lib/iap-management/queries/iaps.ts` |
| 10 | `create-on-apple` → `ApplyPricingArgs` | [create-on-apple/route.ts:300-313](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts#L300-L313) |
| 11 | `update-on-apple` → `updateIapOnApple` → `runPricingStage` → `ApplyPricingArgs` | [update-on-apple/route.ts:236-250](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/update-on-apple/route.ts#L236-L250), [update-orchestration.ts:519-562](../../lib/iap-management/apple/update-orchestration.ts#L519-L562) |
| 12 | ⚠ `detectIapChanges` + **`isEmptyDiff`** (G1 gate 1) | [diff-detector.ts:226-234](../../lib/iap-management/apple/diff-detector.ts#L226-L234) |
| 13 | ⚠ `runPricingStage` **`shouldRun`** (G1 gate 2) | [update-orchestration.ts:527-531](../../lib/iap-management/apple/update-orchestration.ts#L527-L531) |
| 14 | `UpdateChangesPreviewModal` — customs must appear in the confirm diff | `components/iap-management/iap-form/UpdateChangesPreviewModal.tsx` |
| 15 | **`pricing-orchestration.ts` merge point** (G1) | [pricing-orchestration.ts:259-340](../../lib/iap-management/apple/pricing-orchestration.ts#L259-L340) |

Do **not** rely on zod `.default([])` to paper over a missed layer — a defaulted empty array
turns "layer 6 forgot to send it" into "the Manager's customs vanished on Save Draft", with no
error anywhere. Make `custom_prices` **optional-but-not-defaulted** in the schemas and have the
route distinguish `undefined` (field absent → leave DB untouched) from `[]` (explicit clear-all).

**A.5 — Rules, with scope written in.**

> **CP-1 — Custom wins per territory.** For any territory with a custom entry, the custom's
> price point is the one that reaches `manualPrices`; a template entry for the same territory
> is discarded. Territories with no custom are unchanged from today.
> **SCOPE**: the single-IAP Create + Edit forms (`IapForm`), base territory USA, all three
> pricing sources. **NOT bulk import** — the bulk path resolves its base via
> `listUsdTiersForSource` and its points via `BatchPricePointCatalog`; both differ, so
> re-derive rather than generalise if bulk ever gains customs.

> **CP-2 — Customs apply under ALL THREE sources, including `APPLE`.** Under `APPLE` they are
> the only entries in `additionalPricePointIds`. **SCOPE**: as CP-1. Rationale: locked decision
> 2 says territories *without* a custom keep template/auto behaviour — which presumes customs
> are independent of whether a template exists. This is the direct inverse of the Google
> feature, where custom was initially template-only and had to be re-scoped a cycle later
> (KB **P1** companion instance); designing it in from day one avoids that cycle. Structural
> consequence: the custom resolution loop sits **outside** `if (source.kind !== "APPLE")`.

> **CP-3 — Customs require a base tier.** With `tier_id === null` the dialog cannot be opened
> and the affordance states why. **SCOPE**: as CP-1. Rationale (LAYER-GAP): the server already
> bails silently — `skipped-no-tier` at
> [pricing-orchestration.ts:180-183](../../lib/iap-management/apple/pricing-orchestration.ts#L180-L183)
> and the `!tierId` return at
> [update-orchestration.ts:532-539](../../lib/iap-management/apple/update-orchestration.ts#L532-L539).
> Without the client rule, a Manager could build a 40-territory custom set that is discarded
> without a single visible message. The two rules are the same rule stated on both layers;
> they stay in sync because the dialog's gate cites those two line numbers in a comment.

### B. Dialog design

**Mockup**: [`design/apple-custom-territory-prices-mockup.html`](design/apple-custom-territory-prices-mockup.html) — 7 states, static HTML, Tailwind CDN.

Entry point: a **Custom prices** block inside the existing Pricing section
([IapForm.tsx:542-628](../../components/iap-management/iap-form/IapForm.tsx#L542-L628)), below
Base Territory / Price Tier — so the base price is read *above* the thing that overrides it.

**Header** — IAP name · base tier + USD base price · pricing source · `Base: United States (USD)`.
**Toolbar** — search box (matches territory name, alpha-3 code, and currency code) · continent
pills reusing the 5-bucket map from
[territory-continent.ts](../../lib/iap-management/apple/territory-continent.ts) (the same
filter language as the Cycle 38 matrix view, KB §10.7) · a `Only customised (N)` toggle ·
live changed-count.

**Row anatomy** (one per Apple territory, ~175):

| Column | Content | Source |
|---|---|---|
| Territory | `Vietnam` + `VNM` mono | `territoryName()` ([territory-name.ts](../../components/iap-management/view-detail/territory-name.ts)) over `getAllTerritoryIds` ([availabilities.ts:76-95](../../lib/iap-management/apple/availabilities.ts#L76-L95)) |
| Currency | `VND` | `include=territory&fields[territories]=currency` on the price-point read; `price_tier_template_entries.currency_code` as the offline fallback |
| Current price | value **+ provenance pill** | G5. `template` / `template (unverified)` / `on Apple now` / `— auto —` |
| Custom price | **`<select>` of Apple's supported points for this territory** — never a text input. Placeholder row: `— use <provenance> —`. Options render as `₫25,000` with the raw `customerPrice` as the value. | lazy `GET …/price-points?territory=VNM` (G3) |
| New price | the edited value, right-aligned, in the adjacent column | derived |
| — | `Revert` (×), shown only on customised rows | — |

**Highlighting**: a row with a custom is amber (`bg-amber-50`, left border `border-amber-400`),
matching the module's existing amber-for-attention convention
([IapForm.tsx:429](../../components/iap-management/iap-form/IapForm.tsx#L429)). The base
territory row is grey and read-only (§E). Rows whose stored custom is no longer in Apple's list
carry an amber `no longer offered` pill (§I.3).

**Footer**: `N of ~175 territories customised` · `Clear all custom prices` (§C) · `Cancel` ·
`Save custom prices`.

**Performance**: ~175 rows is well inside what the module already renders un-virtualised
(the Cycle 38 matrix table renders ~96 × ~175 cells). No virtualisation in v1.

### C. Revertibility (hard requirement)

Three exits, and **no state the Manager cannot leave**:

1. **One territory** — the `Revert` × on the row, or picking the `— use <provenance> —`
   placeholder. Both **delete the key** from the working map. They do not write a null, a
   zero, or an empty string.
2. **All territories** — `Clear all custom prices` in the dialog footer, and a second copy on
   the form's Pricing-section summary so the Manager can escape without opening the dialog.
   Confirms once (`Clear N custom prices? Territories revert to template/auto.`), then sends
   `custom_prices: []` — the one and only meaning of the empty array.
3. **The whole editing session** — `Cancel` discards the draft map wholesale.

**Dead-affordance guard** (Google's three dead affordances all traced to one root: empty/absent
carrying two meanings — "not set yet" vs "deliberately cleared → inherit"):

- **The data model has no empty state.** A territory is a key in the map or it is absent.
  There is no `customer_price: null` and no `""`. `price_tier_template_entries` already has a
  nullable `proceeds`; `iap_custom_prices.customer_price` is `NOT NULL` on purpose.
- **Presentation state is a separate object from the data model.** The open dialog holds
  `draft: Map<territory, CustomPriceEntry>`; `custom_prices` is only written on Save. A
  `<select>` sitting on its placeholder is presentation ("this row has no custom"), never data.
- **The placeholder names the fallback.** `— use template ₫24,000 —` / `— use auto —`, not a
  blank option. The Manager never has to infer what "empty" means, because it is spelled out
  per row.

### D. ⚠ STALE MODEL (locked decision 3)

**D.1 — Definition.** `stale = fingerprint(currentForm) ≠ storedBaseline`, compared field by
field over `{tier_id, pricing_source, base_territory}` (G6). A **comparison, not a boolean**,
so changing the base and changing it **back** clears staleness with no user action — a boolean
would force a meaningless acknowledgement of a no-op.

**D.2 — Nothing is ever destroyed.** No code path deletes `iap_custom_prices` rows on a
baseline change. The only deletions are the Manager's explicit §C exits.

**D.3 — What the Manager sees, step by step:**

| Step | Manager action | What appears |
|---|---|---|
| 1 | Sets customs for 6 territories, saves | Pricing summary: `6 territories carry a custom price` + list + `View / edit`. Fingerprint stored as `{TIER_10, APP_TEMPLATE, USA}`. |
| 2 | Changes Price Tier `TIER_10 → TIER_15` | **Amber banner** at the top of the Pricing section: *"6 custom prices were set against Tier 10 ($9.99) · Default from App-specific template. The base is now Tier 15 ($14.99). Review them before pushing to Apple."* + two buttons. Summary count badge turns amber: `6 custom · stale`. Every custom row in the dialog is amber with a `stale` pill and shows both the old and new baseline for its territory. |
| 3a | Clicks **Clear all custom prices** | All 6 deleted; banner gone; `CUSTOM_PRICES_CLEARED` audit row. Fingerprint columns → NULL. |
| 3b | Clicks **Keep them (reviewed)** | Values untouched; fingerprint **re-stamped** to `{TIER_15, APP_TEMPLATE, USA}`; banner gone; submit unblocked; `CUSTOM_PRICES_REBASELINE` audit row (§H). |
| 3c | Changes the tier **back** to `TIER_10` | Banner disappears on its own. Nothing to click, nothing logged — the fingerprint matches again. This is the whole reason for a comparison. |
| 4 | After 3b, changes the tier again | Stale fires again. The acknowledgement did not make the IAP permanently "reviewed"; it re-baselined once. |

**D.4 — Submit is BLOCKED while stale customs exist.** Structural, not advisory: a banner can
be scrolled past, a disabled button cannot. Concretely:

- **Client** — `Create on Apple` and `Update on Apple` are `disabled` while
  `staleCustomCount > 0`, with the reason in the `title` and a new red item in
  `SubmitChecklist` ([SubmitChecklist.tsx](../../components/iap-management/iap-form/SubmitChecklist.tsx)).
  Save as Draft stays **enabled** — a Manager mid-review must be able to persist without
  resolving.
- **Server** — both write routes recompute the fingerprint from the submitted form against
  the stored baseline and return **422** with the two resolutions named, before any Apple call.
  Not a duplicated rule, the *same* rule: one exported pure function
  `isCustomBaselineStale(form, storedBaseline)` used by client and server. (LAYER-GAP: a
  client-only block is bypassable by a stale tab; a server-only block is a dead end with no
  way forward from the UI. Both, from one function.)

**D.5 — The acknowledgement must not outlive its baseline.** "Keep them (reviewed)" writes
**only** the three fingerprint columns. There is no `reviewed: true` flag anywhere — that is
exactly the boolean D.1 rules out, and it would let a later baseline change go unnoticed. If
the Manager clicks Keep and then changes the tier again without saving, the in-form fingerprint
has already advanced, so the new change re-triggers stale (correct). If they reload without
saving, the DB fingerprint is still the original, so stale re-appears — a **missed
acknowledgement, not a missed staleness**, which is the safe direction (KB **P7**: prefer a
missed signal over a wrong one).

### E. Base-territory edge case — **recommendation: the base row is READ-ONLY in the dialog**

If the base territory is USA and the Manager sets a custom for USA, that *is* the base price —
a self-contradiction. Resolve it by making the base row read-only, with an inline note
*"This is the base price — set it in Price Tier above"* and a focus-scroll link to the Price
Tier field.

Why read-only rather than "editing it edits the base price":

1. **The write path structurally cannot carry it.** The base has exactly one slot
   (`applePricePointId`, [price-schedules.ts:32](../../lib/iap-management/apple/price-schedules.ts#L32)),
   and the template loop already excludes the base territory
   ([pricing-orchestration.ts:277](../../lib/iap-management/apple/pricing-orchestration.ts#L277)).
   Routing a dialog edit into the base would mean a second write channel into `tier_id`.
2. **The base must remain a *tier*, not a price.** `tier_id` is what
   `iap_mgmt.iaps.tier_id` persists, what `getTierUsdPrice` resolves, and what the `tier`
   checklist item validates. A free-picked USA price point has no `tier_id`, so it would need a
   price → tier reverse lookup that can legitimately fail (Apple offers ~600 points per
   territory against ~96 uploaded tiers) — turning a click in a price dialog into an
   unpredictable failure of an unrelated required field.
3. **It would create a confusing loop.** Editing the base re-fingerprints, which marks every
   *other* row in the currently-open dialog stale — the dialog would invalidate its own
   contents mid-session.

Read-only is one rule with no failure mode. The Price Tier select remains the single way to
move the base, and moving it triggers §D exactly as designed.

### F. Form summary after save

In the Pricing section, under Price Tier:

```
Custom territory prices            [ Edit custom prices ]
6 territories carry a custom price
Vietnam ₫25,000 · Japan ¥1,200 · Brazil R$24,90 · India ₹899  + 2 more
                                   Clear all custom prices
```

- **Count + inline list of the first 4 + `+ N more`.** Never a bare count: "Custom must NEVER
  be opaque". The full set is one click away and shows actual values.
- **`Edit custom prices` re-opens the dialog with real values pre-filled** from
  `custom_prices` — the same values, not a fresh baseline.
- **Stale state is visible here too**: the count badge turns amber and reads `6 custom · stale`,
  with the resolution buttons in the banner directly above.
- Zero-state: `No custom prices — Apple's template/auto pricing applies to every territory.`
  + `Set custom prices`. Under CP-3 with `tier_id === null` the button is disabled with the
  reason inline.

### G. Submit path

**G.1 — How customs become `manualPrices`** (the G1 merge, in the one place both entry points
already share):

```
applyPricingSchedule(args + customPrices: readonly CustomPriceEntry[])
  ├─ skipped-no-tier / no-usd-price guards                    unchanged
  ├─ base point ← findPricePointByUsdPrice(basePoints, usdPrice)   unchanged
  ├─ overridesByTerritory = new Map()
  │   ├─ if source !== APPLE → template loop → set(territory, {id, "template"})
  │   └─ for each customPrices entry, territory !== baseTerritory:
  │        points ← catalog/​perItemCache.get(territory)         SAME fetch path as template
  │        match  ← findPricePointByUsdPrice(points, entry.customer_price)   SAME matcher
  │        match ? set(territory, {id, "custom"})   ◀── CUSTOM WINS, unconditional
  │              : missing.push({source:"custom", territory, customer_price})
  └─ setPriceSchedule({ applePricePointId, additionalPricePointIds: [...map.values()] })
```

Reusing `findPricePointByUsdPrice` and the existing per-territory fetch is not incidental — it
is what keeps the client's "pick from Apple's list" and the server's "find a match" the same
rule (§I.5), and it is why no second pricing path is created.

**G.2 — Territories WITHOUT a custom: unchanged from today.** Template entry if the resolved
template has one for this tier; otherwise Apple auto-equalisation from the base. Byte-identical
behaviour to the current code for any IAP with no customs — which is every existing IAP.

**G.3 — Create-flow ordering** (customs applied **in** the schedule POST, never as a later call):

```
New form  → Save as Draft → POST /apps/{id}/iaps         customs persisted with the draft
          → (redirect)   → Edit page                     customs re-hydrated from DB
Create on Apple:
  1. POST /v2/inAppPurchases                     shell   create-on-apple/route.ts:200-215
  2. persist apple_iap_id                                :219-225
  3. POST localizations (per locale)                     :232-250
  4. getTierUsdPrice(tier_id)                            :262-273
  5. pollIapReadyForPricing                              :277
  6. applyPricingSchedule({…, customPrices})     ◀ ONE replace-all POST: base + template + customs
  7. screenshot 3-step (optional)                        :328-352
  8. availability → all territories                      :364-376
  9. GET state, mirror to DB                             :390-407
```

**G.4 — Edit-flow ordering**: unchanged 5-stage pipeline (KB §4.4); Stage 4 gains the customs
argument, and its `shouldRun` gains `|| diff.custom_prices_changed !== null` (G1 gate 2). Stage
4 still POSTs once. A customs-only Update runs Stage 4 alone, which is correct — and requires
`isEmptyDiff` to learn about customs first (G1 gate 1), or the route never reaches the
orchestrator.

**G.5 — Bulk import is explicitly OUT of scope.** A bulk-imported IAP has no customs, so
`custom_prices` is absent and every bulk path behaves exactly as today. Editing such an IAP
later can add customs normally. If bulk ever gains customs, re-derive per CP-1 — the bulk path
differs in both base resolution and point resolution.

### H. Provenance + audit

**What exists today.** `applyPricingSchedule` owns one `SET_PRICE_SCHEDULE` row per pricing
run, written inside its own try/catch so an INSERT failure cannot silently lose the trace
([pricing-orchestration.ts:411-488](../../lib/iap-management/apple/pricing-orchestration.ts#L411-L488)),
carrying `source`, `outcome`, `result` severity, `price_point_id`, `schedule_id`, `attempts`,
`overridden_territory_count`, `missing_price_points`. The update path adds a per-stage row each
(`UPDATE_ATTRIBUTES_ON_APPLE`, … — migration `20260518000000`).

**Extend the existing payload — no new action type for the pricing run.** Added to the same
`SET_PRICE_SCHEDULE` row:

```jsonc
{
  "custom_territory_count": 6,
  "custom_overrode_template_count": 4,        // customs that displaced a template entry
  "custom_baseline": { "tier_id": "TIER_15", "pricing_source": "APP_TEMPLATE", "base_territory": "USA" },
  "resolution_by_territory": { "custom": 6, "template": 41, "auto_fallback": 128 },
  "custom_territories": [
    { "territory_code": "VNM", "customer_price": 25000, "currency_code": "VND", "resolved": true },
    { "territory_code": "TUR", "customer_price": 199.99, "currency_code": "TRY", "resolved": false }
  ]
}
```

That is enough for a future reader to reconstruct **why a territory got its price**: the
resolution counts say which mechanism won, `custom_territories[].resolved` says whether a
custom actually reached Apple, and `missing_price_points` (extended with a
`source: "custom" | "template"` discriminator) says which ones fell back to auto.

**Two NEW action types are required**, because both are deliberate human decisions that
otherwise leave no trace at all:

| Type | Payload | Why |
|---|---|---|
| `CUSTOM_PRICES_REBASELINE` | `{old_baseline, new_baseline, kept_territory_count, territories[]}` | "Keep them (reviewed)" changes what will ship to a live store while changing no visible value. Without a row, a later reader sees prices set against one tier attached to another with no explanation. |
| `CUSTOM_PRICES_CLEARED` | `{cleared_territory_count, territories[{territory_code, customer_price, currency_code}]}` | Clear-all is the one destructive action in the feature. Logging the values is the only recovery path. |

⚠ **This needs a forward-only migration extending `actions_log_action_type_check`** — and per
KB **P2** ("new action types are silently ignored when the CHECK doesn't include them; the
insert errors and the write is swallowed"), that migration should also close a **live existing
gap** discovered while tracing this: the latest `iap_mgmt` CHECK is
`20260518000000_iap_mgmt_actions_log_update_on_apple.sql:25-46`, and it does **not** contain
`AVAILABILITY_SET_ALL_TERRITORIES` or `AVAILABILITY_REMOVE_FROM_SALES`, both of which are
emitted today ([create-on-apple/route.ts:377-386](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts#L377-L386),
[update-orchestration.ts:577-596](../../lib/iap-management/apple/update-orchestration.ts#L577-L596)).
Those audit rows are being silently rejected right now. This is the same class the Google
module closed for `BULK_ACTIVATE`/`BULK_DEACTIVATE` in `20260702120000` — the fix pattern is to
widen the set while the constraint is already being edited. **Verify the CHECK before shipping,
per P2.**

### I. Validation — what CAN still go wrong

Price points come from Apple's own list, so per-territory *validity at pick time* is inherent.
Five things still can, and each needs a named surface:

**I.1 — Stale cached list.** The picker's options came from a donor IAP or a fetch minutes ago;
Apple has since withdrawn that point. Surfaces via the existing mechanism: the territory lands
in `missing_price_points` → outcome `partial-template-fail` → severity `ERROR` in the audit row
([pricing-orchestration.ts:396-398](../../lib/iap-management/apple/pricing-orchestration.ts#L396-L398))
→ the amber "partial match" badge (Cycle 43 §10.13.J-1). **Required change**: `MissingPricePoint`
gains `source: "custom" | "template"` and the toast/badge names *which territories* lost their
custom, not just a count. Today `MissingPricePoint` carries `tier_id`
([pricing-orchestration.ts:62-66](../../lib/iap-management/apple/pricing-orchestration.ts#L62-L66)),
which a custom has no concept of — so the field becomes nullable alongside the discriminator.

**I.2 — A territory Apple no longer supports.** The per-territory GET 404s or returns an empty
list; the existing catch pushes to `missing`
([pricing-orchestration.ts:302-318](../../lib/iap-management/apple/pricing-orchestration.ts#L302-L318)).
Same surface as I.1. **The related trap, transposed from Google**: a territory's *currency* can
change (Bulgaria BGN → EUR, Jan 2026 — the `regionsVersion` cross-version trap). Apple's
analogue is a stored `currency_code` going stale on a custom entry. ⇒ **`currency_code` is
DISPLAY METADATA ONLY and must never be a join key.** Matching is on `customer_price` alone,
exactly as `findPricePointByUsdPrice` already does
([price-points.ts:101-115](../../lib/iap-management/apple/price-points.ts#L101-L115)). A row
whose stored currency disagrees with Apple's current currency for that territory renders an
amber `currency changed` pill and re-prompts; it does not block.

**I.3 — A price point withdrawn between picking and submitting.** For templates this window is
one orchestration; for customs it is **hours or days**, because customs persist in the DB
across sessions. This is the one genuinely new validation surface. ⇒ **Re-validate on dialog
open**: for every territory that already has a custom, fetch that territory's current list and
mark any stored price no longer present with an amber `no longer offered by Apple` pill plus a
"pick a replacement" affordance. Cost is bounded by the number of customised territories
(typically < 10), so this is affordable at every open.

**I.4 — Float / precision.** `findPricePointByUsdPrice` compares with
`Math.abs(candidate - usdPrice) < 0.001`
([price-points.ts:110](../../lib/iap-management/apple/price-points.ts#L110)), calibrated for
2-decimal USD. Non-USD territories include 0-decimal (JPY, VND, KRW, IDR) and 3-decimal (BHD,
KWD, OMR, TND, JOD) currencies. The matcher is **already exercised on non-USD today** via
template overrides ([pricing-orchestration.ts:319-322](../../lib/iap-management/apple/pricing-orchestration.ts#L319-L322)),
so no change is needed — but the epsilon must **not** be widened "to be safe": 0.001 is
narrower than the smallest representable step of a 3-decimal currency, so widening it could
match the wrong point. Storing `NUMERIC(18,4)` (identical to
`price_tier_template_entries.customer_price`) keeps the pick → store → match round trip lossless
for every currency Apple uses.

**I.5 — LAYER-GAP: how the client rule and the server rule stay in sync.**
Client rule: *"the Manager may only choose a price present in the list Apple returned for this
territory."* Server rule: *"`findPricePointByUsdPrice` must find a match in the list Apple
returns for this territory."* They are the same rule over data fetched at two different times.
They stay in sync **by construction**, on two conditions, both of which are design constraints
rather than conventions:

1. The dialog's option list is served by a route that calls the **same**
   `listPricePointsForIap` the orchestrator uses. Never a DB table, never a second fetcher.
2. The server **never hard-rejects** a custom for being off-list — it fail-softs to auto with a
   loud audit row, matching today's template semantics. A hard reject would block an entire
   submit over a price Apple withdrew after the pick, i.e. punish the Manager for Apple's
   timing.

"The server accepts it" ≠ "the user can create it": the picker cannot offer an invalid price
(1), and the server cannot be blocked by one (2).

### J. Open questions / risks

1. **[Manager decision] No-donor Create.** For the very first IAP of a brand-new app with no
   synced IAP anywhere on the account, G2 leaves three options: (a) disable Custom prices with
   the reason stated (recommended), (b) populate the picker from the local
   `price_tier_territories` snapshot with a clear "unverified" label, (c) require Create on
   Apple first, then edit. (a) and (c) are the same behaviour described two ways. Recommend
   (a)/(c). How often does this actually occur in the Manager's workflow?
2. **[Unverified] Does Apple's price-point catalog differ by IAP type?**
   `batch-price-point-catalog.ts:29-31` says "We cannot prove the catalogs are identical across
   types" and keys its cache defensively. Consequences here: the donor IAP should prefer the
   same `type` as the IAP being created, and `type` is excluded from the fingerprint (G6). If
   the catalogs *are* identical, the donor constraint relaxes. Settle with one GET per type on
   the same territory and a set-compare of `customerPrice` values.
3. **[Unverified] Multi-value `filter[territory]`.** Spec says supported (G3); no live capture
   proves it. The design does not depend on it, but it would make a future "show real auto
   prices for all 175" feature cheap.
4. **[Opportunity] `/v1/inAppPurchasePricePoints/{id}/equalizations` could turn `— auto —` into
   a real number** — given the base point, Apple returns its equalised siblings, with
   `filter[territory]`. That would make the dialog's Current-price column complete for all
   three provenances. Deliberately out of v1 scope (it is a new endpoint, needing the §10.3
   new-endpoint checklist), but it is the natural follow-up and would materially improve the
   dialog.
5. **[Risk] `partial-template-fail` currently maps to severity `ERROR`
   ([pricing-orchestration.ts:396-398](../../lib/iap-management/apple/pricing-orchestration.ts#L396-L398))
   and the Create toast escalates pricing failures to a hard error
   ([IapForm.tsx:321-331](../../components/iap-management/iap-form/IapForm.tsx#L321-L331)).**
   Customs make partial outcomes more common (a custom is a Manager-typed intent, not a
   validated template row). Decide deliberately whether one unresolvable custom out of six
   should read as a red "pricing failed" or an amber "5 of 6 customs applied". Recommend amber
   with the territory named — but this is a status-semantics call (KB **P5**: the status must
   reflect the real outcome), so it should be locked, not defaulted.
6. **[Bigger than it looks] The replace-all semantic is now user-visible.** Today a Manager
   editing only the tier silently loses every manual price Apple Connect shows
   ([price-schedules.ts:2-8](../../lib/iap-management/apple/price-schedules.ts#L2-L8)). This
   feature puts that fact on screen (G5 state 3), which is an improvement — and also the first
   time the tool invites the Manager to *rely* on per-territory prices persisting. Expect a
   follow-up request: "import the current Apple manual prices as customs in one click." That is
   a clean, small feature on top of G4's read (`unpackPriceSchedule` entries with
   `startDate === null` map 1:1 onto `CustomPriceEntry`), and worth scoping in the same cycle
   if the Manager wants it.
7. **[Scope hygiene] `pricing_source` does not move the base price on these two surfaces but
   does on bulk (G6).** That twin-path gap (Cycle 43 §10.13.H applied to bulk only) is *not*
   fixed here — deliberately, to keep this feature's diff honest. But it means the stale banner's
   copy must not claim the source change moved the base price. Copy: *"the pricing source
   changed, so the template overrides behind these customs may differ"* — accurate for both
   surfaces.
8. **[Deferred] Scheduled pricing.** Apple supports future-dated `startDate`; the tool only
   ever writes `startDate: null` ([price-schedules.ts:6-8](../../lib/iap-management/apple/price-schedules.ts#L6-L8)).
   Customs inherit that limitation. The dialog must filter the baseline read to
   `startDate === null` (G4) so a future scheduled change is never mistaken for the current price.

---

## 3. MUTATION-CHECK — the one behaviour to prove by breaking it

Per KB **P10**, "the function exists" is not the acceptance test. The single behaviour that
must be proven by deliberate mutation is **the G1 territory-keyed merge**:

> **Given a custom AND a template entry for the SAME territory, exactly ONE price point for
> that territory reaches `setPriceSchedule`, and it is the custom's.**

Procedure:

1. Write the test: source `APP_TEMPLATE` with a `VNM` entry at `₫24,000`, plus a custom `VNM`
   at `₫25,000`. Assert `setPriceSchedule` received `additionalPricePointIds` containing
   **exactly one** ID whose decoded `{t}` is `VNM`
   ([price-point-id.ts:40-62](../../lib/iap-management/apple/price-point-id.ts#L40-L62) makes
   this directly assertable), and that its `{p}` is the tier of `₫25,000`.
2. **Break it**: revert the `Map` to the two independent
   `additionalPricePointIds.push(...)` calls (the shape at
   [pricing-orchestration.ts:260](../../lib/iap-management/apple/pricing-orchestration.ts#L260)
   / [:324](../../lib/iap-management/apple/pricing-orchestration.ts#L324) today).
3. **Confirm the test FAILS** — and fails specifically with **two** `VNM` entries, not with an
   unrelated error. A test that still passes with the Map removed is a fake test: it happened
   to pass because the fixture had no overlapping territory.
4. Revert, confirm green.

Secondary mutation-checks worth the same treatment (cheap, and each guards a G1 gate):
delete the `custom_prices_changed` clause from `isEmptyDiff` and confirm the customs-only
Update test fails with `NO_CHANGES`; delete it from `runPricingStage`'s `shouldRun` and confirm
the customs-only-under-`APPLE` test fails with zero `applyPricingSchedule` calls.

---

## 4. Lessons applied from the Google cycle (not rediscovered)

| Lesson | Where it is applied here |
|---|---|
| **LAYER-GAP** — "the server accepts it" ≠ "the user can create it" | §I.5 (one `listPricePointsForIap` for both layers; server never hard-rejects), §D.4 (one `isCustomBaselineStale` for client block + server 422), CP-3 (server's silent `skipped-no-tier` paired with a client gate that cites its line numbers) |
| **DEAD AFFORDANCE** — empty/absent carrying two meanings | §C: the data model has no empty state (key present or absent, `NOT NULL` price); presentation `draft` map kept separate from `custom_prices`; every placeholder names its fallback value |
| **SCOPED LOCK** — a locked decision carries the scope it was made in | CP-1/CP-2/CP-3 each state their scope inline and name what to re-derive for bulk; §J-7 keeps the bulk twin-path gap explicitly out |
| **MUTATION-CHECK** is the acceptance bar | §3 — the G1 merge, with the failure mode named ("two VNM entries", not "a test fails") |
| **P1 twin-path / shared choke point** | The merge lives in the ONE function both entry points already share (`applyPricingSchedule`), not patched into `create-on-apple` and `update-orchestration` separately. §A.4 rows 5+6 name the divergent client twin (`saveBody()` vs the edit-branch inline body). |
| **P2 `actions_log` CHECK** | §H — new types require a migration, and the same migration closes the live `AVAILABILITY_*` gap found while tracing |
| **P3 surface divergence, don't reconcile** | §G5/§I.3 — a custom Apple no longer supports is shown to the Manager with a replacement affordance, never silently dropped or auto-corrected |
| **P5 the status principle** | §J-5 — "5 of 6 customs applied" must not read as a flat failure, and must not read as success either |
| **P6 no cache on a cold path** | §G3 — no server-side price-point cache for the dialog; dialog-lifetime React state only |
| **P7 prefer a missed signal over a wrong one** | §D.5 — an unsaved acknowledgement is lost on reload (stale re-appears) rather than persisted optimistically |
| **P9 design-first exactly where it looks like a proven pattern** | This whole document: the feature *looks* like Google's custom prices, and G1/G2 found two shape-changing differences (territory-anonymous array; IDs unavailable at Create) that a port would have hit in code |

---

## 5. Files this touches (for the implementation pass — not written in this pass)

| Kind | Path |
|---|---|
| NEW migration | `supabase/migrations/…_iap_mgmt_custom_prices.sql` — `iap_custom_prices` table, 3 fingerprint columns on `iaps`, widened `actions_log_action_type_check` (+ the two `AVAILABILITY_*` types) |
| NEW component | `components/iap-management/iap-form/CustomPricesDialog.tsx` |
| NEW component | `components/iap-management/iap-form/CustomPricesSummary.tsx` (Pricing-section block + stale banner) |
| NEW lib | `lib/iap-management/apple/custom-price-baseline.ts` — `fingerprintOf`, `isCustomBaselineStale` (pure, shared client+server) |
| NEW route | `GET …/iaps/[iapId]/price-points?territory=XXX` — thin wrapper over `listPricePointsForIap` |
| NEW route | `GET …/iaps/[iapId]/price-schedule` — `getPriceScheduleForIap` + `unpackPriceSchedule` |
| EDIT | `lib/iap-management/validation.ts` · `lib/iap-management/apple/pricing-orchestration.ts` (**the merge**) · `apple/update-orchestration.ts` (`shouldRun`) · `apple/diff-detector.ts` (`isEmptyDiff` + diff shape) · `queries/iaps.ts` |
| EDIT | `components/iap-management/iap-form/IapForm.tsx` (both payload sites) · `SubmitChecklist.tsx` · `UpdateChangesPreviewModal.tsx` |
| EDIT | `app/api/iap-management/apps/[appId]/iaps/route.ts` · `iaps/[iapId]/route.ts` · `…/create-on-apple/route.ts` · `…/update-on-apple/route.ts` · `app/(dashboard)/…/iaps/[iapId]/page.tsx` |
| DOCS (later) | KB §10 new cycle entry · `operational-guide.md` workflow · `docs/user-docs/` |


---

## 6. AS-BUILT NOTES (Aug 2026)

Written after the fact. Everything above is the signed-off design text, kept verbatim;
these are the places the build diverged from it, or where it under-specified something the
implementation had to decide. Each note says what shipped and why.

### 6.1 §I.1's `source` discriminator was a CONTRACT change, not additive

§I.1 asked `MissingPricePoint` to gain a `source` field. In practice that is not additive:
`pricing-orchestration.test.ts` pinned the exact shape of `missing_price_points`, so adding
`source` + `reason` (and making `tier_id` nullable — a custom has no tier) broke that
assertion. Updated deliberately, with a comment naming SC3 as the reason. Worth flagging as
a pattern: "add a field to a result type" is a contract change wherever a test asserts the
whole object with `toEqual`.

### 6.2 The design never defined how `custom_prices_changed` is computed

§G.4 said `shouldRun` gains `|| diff.custom_prices_changed !== null` and A.4 listed
`isEmptyDiff`, but customs are not part of `IapFormState` — so there was **no defined
source** for that diff bucket.

Resolved with a pure `customPricesDivergeFromApple(stored set vs the G4 effective-now read)`
in `diff-detector.ts`, threaded in by the caller. It answers the honest question — *does
Apple need this push?* — and needs no new column and no new form field.

It counts **both** directions, and the second one is easy to miss:

- a custom Apple does not have, or has at a different price ⇒ push needed;
- **a manual price on Apple with NO custom behind it** ⇒ the Manager cleared that custom,
  and the replace-all push is what reverts the territory. Without this direction
  *"clear all"* would be a **no-op on Apple while the UI reported success**.

Cost: one extra 2-stage schedule read on Update, and only for IAPs that actually have
customs. On failure the check assumes a push IS needed (the POST is idempotent, so
re-sending is harmless; skipping a needed push would silently lose the customs).

### 6.3 The design MISSED the client half of gate 1

A.4 listed `diff-detector` once. In practice `isEmptyDiff` is called on **both** sides, and
`handleUpdateOnAppleClick`'s copy is the one the Manager hits first — so the server-side fix
alone still showed *"No changes detected — nothing to push to Apple"* and never opened the
confirm modal.

Both halves shipped. The client cannot know Apple's live prices, so it uses the signal it
does have (did the Manager touch customs in this session, via `customPricesTouched`); the
server stays authoritative and may still answer `NO_CHANGES`. This is the LAYER-GAP lesson
recurring inside a design that already cited LAYER-GAP — see KB §9 for the generalised form.

### 6.4 SC2 — provenance precedence, and what a draft can know

§B listed the provenance pills but not what wins when a territory has both a live manual
price and a template entry. As built: **`existing-manual` > `template` > `auto`**. A live
Apple price is what the store charges *today*; a template is only what the next push *would*
send.

Also unstated: `existing-manual` is only knowable for **synced** IAPs. The baseline route
reads the schedule only when `apple_iap_id` exists, so a local draft shows template/auto
rows only — and therefore has no J-6 import banner.

### 6.5 Locked decision 1's wording

See the annotation under the decision table. Recorded here too because the design's §A.3
argued the opposite (that customs entered on the New form must survive a round-trip, via
payload threading). The Manager chose the simpler arrangement; §A.3's reasoning is still
correct about *why* persistence is mandatory, just not about which form needs the affordance.

### 6.6 SC1 — `replaceCustomPrices` write ordering is load-bearing

§A.2 gave the schema but not the write sequence. As built: **delete → insert → stamp**, and
the order is chosen for crash-safety, not style:

| Crash point | Resulting state | How it reads |
|---|---|---|
| after delete | zero customs, OLD fingerprint | visibly empty — Manager re-enters |
| after insert, before stamp | new set, OLD fingerprint | **STALE** — submit blocked, Manager reviews |
| (stamp first — rejected) | stale prices, FRESH fingerprint | reads as clean, and would **SHIP** |

Not transactional (supabase-js exposes none — the same constraint `replaceTemplate` and
`replacePriceTiers` live with), so every intermediate state has to be safe by inspection.

### 6.7 J-5 as built — a new outcome kind, not a flag

§J-5 (Manager: red, not amber) shipped as a distinct outcome kind
**`partial-custom-fail`** (severity `ERROR`) that **outranks** `partial-template-fail`, so a
failed custom can never be flattened into the amber template-partial the Manager has learned
to read as "expected", nor reported as `set`. A discriminator rather than an array the UI
must inspect.

Templates keep their documented silent auto fallback (§G5 `template · unverified`); customs
deliberately do **not** inherit it. `MissingPricePoint` carries
`source: "template" | "custom"` and `reason: "no-apple-price-point" | "territory-fetch-failed"`,
and both write paths surface the failed territories by name.

### 6.8 What the design got right and is worth reusing

- **G1's merge point was exactly right**, including the reason (territory-anonymous array ⇒
  a corrupted request shape, not a wrong value). The mutation-check failed with two `VNM`
  entries, as predicted.
- **G2's shape decision** (store `(territory, price)`, resolve ids server-side) made Create
  and Edit structurally identical, as claimed — the create path needed no special casing.
- **G3's "the baseline table needs no price points"** held: one request on dialog open, and
  a per-territory fetch only on picker open.
- **G4's warning about `startDate === null`** was load-bearing and would have been a real
  bug: without it J-6 would import tomorrow's scheduled price as today's custom.
- **§D's comparison-not-boolean** insistence paid for itself — the "change the base back"
  behaviour falls out for free and needed no extra state.
