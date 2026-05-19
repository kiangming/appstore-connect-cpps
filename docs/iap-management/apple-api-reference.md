# Apple App Store Connect API — IAP reference

The endpoint surface this module hits, pinned by integration tests in
`lib/iap-management/apple/api-schemas.integration.test.ts`. When Apple's
official docs change, update both this table and the integration tests.

Apple's IAP API mixes `/v1` and `/v2` paths intentionally — v2 is the modern
entry point for the resource itself, but child resources (localizations,
screenshots, price schedules, submissions) still use v1.

## Endpoint table

| Operation | Method | Endpoint | Notes |
|---|---|---|---|
| List IAPs (paginated) | GET | `/v1/apps/{appAppleId}/inAppPurchasesV2?limit=200` | Follow `links.next` for full enumeration (IAP.o.7a). |
| Get IAP (with relations) | GET | `/v2/inAppPurchases/{id}?include=inAppPurchaseLocalizations,appStoreReviewScreenshot` | Include both relations in one request. |
| Create IAP | POST | `/v2/inAppPurchases` | Body: `data.type=inAppPurchases`, relationship `app`. |
| Update IAP | PATCH | `/v2/inAppPurchases/{id}` | Partial update via `data.attributes`. IAP.o.12 PATCH-able attributes: `name`, `reviewNote`, `familySharable` only — all other attributes are immutable per OpenAPI. |
| Delete IAP | DELETE | `/v2/inAppPurchases/{id}` | No body. |
| List localizations | GET | `/v2/inAppPurchases/{id}/inAppPurchaseLocalizations?limit=200` | |
| Create localization | POST | `/v1/inAppPurchaseLocalizations` | Relationship: `inAppPurchaseV2` (NOT `inAppPurchase`). |
| Update localization | PATCH | `/v1/inAppPurchaseLocalizations/{id}` | IAP.o.12 PATCH-able attributes: `name`, `description` only. Locale itself is immutable — locale change = DELETE + POST. |
| Delete localization | DELETE | `/v1/inAppPurchaseLocalizations/{id}` | Bulk-import OVERWRITE path + IAP.o.12 update-on-Apple locale removal. |
| List price points | GET | `/v2/inAppPurchases/{id}/pricePoints?filter[territory]=USA&limit=1000` | Per-IAP scope — no /apps/{id}/pricePoints endpoint exists. IAP.o.11a bumped limit 200→1000 (OpenAPI spec max 8000). |
| Set price schedule | POST | `/v1/inAppPurchasePriceSchedules` | Replace-all semantic; relationships + included (see below). |
| Get price schedule Stage 1 (View Detail) | GET | `/v2/inAppPurchases/{id}/iapPriceSchedule?include=baseTerritory,manualPrices` | Relationship-traversal endpoint. Path segment is the **relationship name** (`iapPriceSchedule`), NOT the resource type — sending the type returns 404 (IAP.p2.i). Apple enforces a **strict include whitelist** — only `baseTerritory`, `manualPrices`, `automaticPrices` are accepted; nested includes like `manualPrices.inAppPurchasePricePoint.territory` return 400 `PARAMETER_ERROR.INVALID` (IAP.p2.j). Returns schedule id + baseTerritory + manualPrice ID stubs. 404 = no schedule yet. |
| Get price schedule Stage 2 (View Detail) | GET | `/v1/inAppPurchasePriceSchedules/{scheduleId}/manualPrices?include=inAppPurchasePricePoint,territory&limit=200` | Deep-traversal endpoint that side-loads `inAppPurchasePricePoint` + `territory` per manual price — the only path that allows these includes (per OpenAPI). Skipped when Stage 1 returns 0 manualPrices (Apple-equalized everything). Paginated via `links.next`; we follow up to `MAX_STAGE2_PAGES=20` with a URL parser that handles both absolute + relative cursors. Apple's default page size has been observed to be smaller than our requested `limit` (10-row default seen post-p2.j MV30 test). |
| Get price schedule Stage 3 (View Detail) | GET | `/v1/inAppPurchasePriceSchedules/{scheduleId}/automaticPrices?filter[territory]=<base>&include=inAppPurchasePricePoint,territory&limit=1` | Resolves the **base territory's actual price** — Apple stores the base in `automaticPrices`, NOT `manualPrices` (despite our POST shape sending the base AS a manualPrice; Apple unfolds it on storage). Without Stage 3 the View Detail had to fall back to `current[0]` which surfaced the wrong territory's price as the "base" (IAP.p2.k). Best-effort: a Stage 3 failure leaves `basePrice = null` and the section renders the territory name without a price. |
| Poll IAP ready (Stage 1→2 guard) | GET | `/v2/inAppPurchases/{id}` | IAP.o.11a — invoked between CREATE and pricing POST to confirm Apple has propagated the new IAP. Polls 200 ms × 10 max = 2 s budget. |
| Reserve screenshot | POST | `/v1/inAppPurchaseAppStoreReviewScreenshots` | Relationship: `inAppPurchaseV2`. Returns `uploadOperations[]`. |
| Confirm screenshot | PATCH | `/v1/inAppPurchaseAppStoreReviewScreenshots/{id}` | `uploaded: true` + `sourceFileChecksum` (MD5 hex). |
| Delete screenshot | DELETE | `/v1/inAppPurchaseAppStoreReviewScreenshots/{id}` | OVERWRITE replace path. |
| Submit for review | POST | `/v1/inAppPurchaseSubmissions` | Relationship: `inAppPurchaseV2`. No attributes. |

## Relationship names (v2 IAP)

The to-one relationships on a `/v2/inAppPurchases` resource that the Manager
workflow inspects:

| Relationship | Type | Notes |
|---|---|---|
| `app` | `apps` | Parent app on the IAP CREATE payload. |
| `inAppPurchaseLocalizations` | `inAppPurchaseLocalizations` (to-many) | Side-loaded via `?include=`. |
| `appStoreReviewScreenshot` | `inAppPurchaseAppStoreReviewScreenshots` (to-one) | **NOT** `reviewScreenshot` (community-source naming guess). |
| `iapPriceSchedule` | `inAppPurchasePriceSchedules` | **NOT** `inAppPurchasePriceSchedule` (the resource type). Apple uses the short relationship name in URL segments — same trap as `appStoreReviewScreenshot`. Read path: `GET /v2/inAppPurchases/{id}/iapPriceSchedule` (IAP.p2.a + p2.i path-name fix). |

## Pricing schedule POST shape

The most-mistaken-shape payload across the IAP.o.* arc. Apple's
`/v1/inAppPurchasePriceSchedules` POST is **replace-all** — no PATCH exists,
every POST replaces the entire current schedule for the IAP.

```json
{
  "data": {
    "type": "inAppPurchasePriceSchedules",
    "relationships": {
      "inAppPurchase": {
        "data": { "type": "inAppPurchases", "id": "<apple_iap_id>" }
      },
      "baseTerritory": {
        "data": { "type": "territories", "id": "USA" }
      },
      "manualPrices": {
        "data": [
          { "type": "inAppPurchasePrices", "id": "<local-ref-id>" }
        ]
      }
    }
  },
  "included": [
    {
      "type": "inAppPurchasePrices",
      "id": "<local-ref-id>",
      "attributes": { "startDate": null },
      "relationships": {
        "inAppPurchasePricePoint": {
          "data": {
            "type": "inAppPurchasePricePoints",
            "id": "<apple_price_point_id>"
          }
        },
        "inAppPurchaseV2": {
          "data": { "type": "inAppPurchases", "id": "<apple_iap_id>" }
        }
      }
    }
  ]
}
```

Critical pairing rules:
- `manualPrices.data[].id` MUST equal `included[].id` — Apple uses this to
  link the primary relationship to the side-loaded resource. Mis-pairing
  silently breaks the schedule POST with no informative error.
- `included[].relationships.inAppPurchasePricePoint.data.id` is the
  price-point id from `GET /v2/inAppPurchases/{id}/pricePoints`. Treat it
  as opaque (it's a base64 string of `{store, territory, priceTier}`).
- `included[].relationships.inAppPurchaseV2.data.id` — note this uses the
  **v2** relationship name inside `included`, while the top-level data block
  uses `inAppPurchase`. Apple's naming asymmetry is a known gotcha.
- `startDate: null` → effective immediately. Future-dated pricing is not
  exercised by the Manager workflow.

## Local tier → Apple price-point mapping

**IAP.o.10a:** Match by USA/USD `customerPrice` string, NOT `priceTier`.

Apple changed `priceTier` numbering from "1, 2, 3, …" to "10000, 10001, …"
silently in 2024 (developer forum thread 728081), with legacy IAPs still
returning the old numbering. The `priceTier` attribute is unsafe as a join
key — `customerPrice` is the only stable identifier.

Match strategy:

1. Resolve local `tier_id` → `customer_price` via `getTierUsdPrice(tier_id)`
   (reads `iap_mgmt.price_tier_territories` WHERE territory_code='USA').
2. Filter Apple's `pricePoints` where `attributes.customerPrice === priceUsd.toFixed(2)`
   (epsilon 0.001 in `findPricePointByUsdPrice` to defeat IEEE-754 noise).
3. Use the matched price point's id in the schedule POST.

`findPricePointByTier` (legacy) is kept in the codebase for fallback callers
but is documented as legacy in JSDoc — production code calls
`findPricePointByUsdPrice`.

## Known gotchas

1. **`v1` vs `v2` mixing** — resources are `/v2`, child collections still
   `/v1`. Always check this reference table before adding a new wrapper.
2. **`appStoreReviewScreenshot` singular relationship name** — the
   community references show `reviewScreenshot`, which silently 400s. The
   official Apple docs URL is the source of truth.
3. **`inAppPurchaseV2` inside `included` blocks** — the relationship name
   is `inAppPurchase` at the top level but `inAppPurchaseV2` inside
   `included` (and in localization create payloads). Apple's asymmetry.
4. **Price schedule POST = replace-all** — no PATCH. Every POST replaces
   the full schedule for the IAP. Idempotent re-application is safe.
5. **Price points are per-IAP, not per-app** — no `/v1/apps/{id}/pricePoints`
   endpoint exists. Each IAP CREATE triggers one extra price-point GET to
   resolve the tier id; this is the documented overhead, not a bug.
6. **`productId` is permanently claimed** — even deleted IAPs leave the
   productId reserved on Apple's side. UAT cycles MUST use a fresh
   namespace (`com.vng.test.iap.YYYYMMDD.vN.NNN`) to avoid 409 collisions
   against ghost IAPs.
7. **`priceTier` numbering UNSTABLE (IAP.o.10a)** — Apple changed integer
   tier numbering from "1, 2, 3, …" to "10000, 10001, …" silently in 2024
   (dev forum thread 728081). Legacy IAPs still on old numbering. NEVER
   match by `priceTier` — always match by `customerPrice` string.
8. **Apple's intermittent 500 UNEXPECTED_ERROR on `/v1/inAppPurchasePriceSchedules`**
   — known Apple bug per forum 728081. IAP.o.11a extended retry budget
   to 5 attempts (was 3) with backoff `500 → 1500 → 4000 → 10000 → 30000 ms`
   plus ±20% jitter to de-thunder concurrent bulk-import retries. 4xx
   errors (409, 422) propagate immediately since retry can't fix a
   payload mismatch.
9. **Stage 1 → Stage 2 propagation race** — IAP.o.11a inserted a poll
   (`pollIapReadyForPricing`, 200 ms × 10 max) between IAP CREATE and
   pricing POST so a freshly-created IAP doesn't race against Apple's
   service propagation. Poll-timeout falls through to `skipped-not-ready`
   outcome with a distinct audit log row.
10. **Pricing audit log written inside the orchestrator** — IAP.o.11a
    moved the `SET_PRICE_SCHEDULE` audit insert from each route into
    `applyPricingSchedule`. Wrapped in try/catch so audit-write failures
    surface to Railway console explicitly rather than silently dropping
    the trace. Every outcome (`set` / `skipped-*` / `failed-*`) writes
    exactly one row; failures carry `result='ERROR'` per Manager Q-F
    severity policy.
11. **`iapPriceSchedule` short relationship name in V2 URL segments
    (IAP.p2.i)** — the path segment for the GET read endpoint is the
    relationship NAME (`iapPriceSchedule`), NOT the resource type
    (`inAppPurchasePriceSchedule`). Apple's V2 IAP API uses the short
    relationship name in URL segments — same trap as IAP.o.9b's
    `appStoreReviewScreenshot` rename. Sending the wrong path returns
    404 even when the schedule exists; the View Detail page then renders
    "No pricing has been set on Apple yet." even when pricing IS set
    on Apple. Detected: Manager UAT post-p2.h ship. Path-shape pin lives
    in `api-schemas.integration.test.ts` to prevent recurrence.
12. **Apple V2 schedule endpoint enforces strict include whitelist —
    no nested traversal (IAP.p2.j)** — the OpenAPI for
    `/v2/inAppPurchases/{id}/iapPriceSchedule` lists `include` as
    `enum: [baseTerritory, manualPrices, automaticPrices]`. Apple's
    parser treats each `include` value as a single whitelist key, not
    as a JSON:API dotted-path. Sending
    `manualPrices.inAppPurchasePricePoint.territory` is rejected with
    `PARAMETER_ERROR.INVALID` / "'…' is not a valid relationship name".
    Same restriction applies to `/v1/inAppPurchasePriceSchedules/{id}`.
    The ONLY endpoint that side-loads `inAppPurchasePricePoint` +
    `territory` on a manual-price is
    `/v1/inAppPurchasePriceSchedules/{scheduleId}/manualPrices` — read
    path therefore requires the 2-stage fetch documented in the endpoint
    table above. Detected: Manager UAT post-p2.i ship. Both stage
    path-shape pins live in `api-schemas.integration.test.ts`.
13. **Price-point ≠ currency carrier — currency lives on Territory
    (IAP.p2.k FIX B)** — Apple's
    `fields[inAppPurchasePricePoints]` enum is
    `[customerPrice, proceeds, territory, equalizations]`. **`currency`
    is NOT a price-point attribute.** It lives on the `Territory`
    resource (`fields[territories]: [currency]`). Reading
    `pricePoint.attributes.currency` silently yields `undefined` for
    every row → no currency symbol in the View Detail rendering.
    Always look up the matching Territory in `included[]` and read
    `attributes.currency` from there.
14. **InAppPurchasePrice carries its OWN `territory` relationship —
    NOT the price-point's territory (IAP.p2.k FIX A)** — Apple's
    `fields[inAppPurchasePrices]` enum lists `territory` as a direct
    relationship on the price entry itself. Our Stage 2 / Stage 3
    `?include=inAppPurchasePricePoint,territory` side-loads BOTH of
    these via the `InAppPurchasePrice` resource. The `InAppPurchasePricePoint`'s
    own `territory` relationship is NOT side-loaded by this include
    chain — reading `pricePoint.relationships.territory.data.id` always
    returned `undefined`, surfacing as a blank country column in the
    View Detail table and a failed base-territory match in the section
    header. Always read territory from `priceRes.relationships.territory`.
15. **Apple stores the base price in `automaticPrices`, NOT
    `manualPrices` (IAP.p2.k Stage 3)** — even when our POST shape sends
    the base territory as part of `manualPrices`, Apple unfolds it
    server-side: the base lives in `automaticPrices`, the explicit
    overrides live in `manualPrices`. Reading the schedule's
    manualPrices alone never surfaces the base territory's price.
    Use the dedicated filter fetch documented in the Stage 3 endpoint
    row above.

## Test enforcement

- Unit tests per wrapper: `lib/iap-management/apple/*.test.ts`
- Integration schema pin: `lib/iap-management/apple/api-schemas.integration.test.ts`
- When Apple's docs change, expect the integration test to fail first; fix
  it together with the wrapper, then update this reference table in the
  same commit.

## Update-on-Apple flow (IAP.o.12)

The full editable surface Apple's public OpenAPI exposes for a synced IAP:

| Bucket | Endpoint | Patchable fields |
|---|---|---|
| IAP attributes | `PATCH /v2/inAppPurchases/{id}` | `name`, `reviewNote`, `familySharable` |
| Localization (per locale) | `PATCH /v1/inAppPurchaseLocalizations/{id}` | `name`, `description` |
| Locale add | `POST /v1/inAppPurchaseLocalizations` | full create payload |
| Locale remove | `DELETE /v1/inAppPurchaseLocalizations/{id}` | — |
| Screenshot | IAP.o.8a `replaceScreenshotOnApple` (GET + DELETE + 3-step upload). UI exposed at IAP.o.13a — drop a new file onto the edit form to stage a replace. | — |
| Pricing schedule | IAP.o.11d `applyPricingSchedule` → `POST /v1/inAppPurchasePriceSchedules` | replace-all; tier change ⇒ full schedule replace |

State-edit constraints (not enumerated in OpenAPI — observed behavior):
- `MISSING_METADATA`, `READY_TO_SUBMIT`, `REJECTED`, `READY_FOR_SALE` —
  PATCH accepted at the attribute level.
- `WAITING_FOR_REVIEW`, `IN_REVIEW` — PATCH typically rejected with 409 /
  422 `STATE_ERROR.*`. Tool surfaces a pre-warn banner via
  `isStateEditLikelyBlocked` but does NOT pre-block (Q-IAP.o.12.C).

Diff strategy (Q-IAP.o.12.B): per-field. `detectIapChanges` trims text
fields, collapses null vs empty, and emits nullable buckets so the
orchestrator skips stages with no change.

### Deferred to IAP.o.13+

`contentHosting` and `availableInAllTerritories` are NOT in the
`InAppPurchaseV2UpdateRequest` schema — Apple exposes them via dedicated
child endpoints (e.g. `/v1/inAppPurchaseAvailabilities`) which are not
yet wrapped. Manager surfaces these on demand in a future cycle.

## Pricing Template System (IAP.p1)

Manager scope (Q-IAP.p1.A..K, May 2026): three pricing sources usable on
every CREATE / OVERWRITE / UPDATE flow. The orchestrator preserves IAP.o.11d
APPLE-source behavior bit-for-bit (F8 nuance) and adds two template-backed
paths layered on top of the same `POST /v1/inAppPurchasePriceSchedules`.

### Sources

| Source | Behavior |
|---|---|
| `APPLE` | Single USA price-point in `manualPrices`. Apple auto-equalizes every other territory from the USA base. Existing IAP.o.11d behavior, no regression surface. |
| `DEFAULT_TEMPLATE` | Global template entries (one row in `iap_mgmt.price_tier_templates` with `scope_type='GLOBAL'`). Per-territory overrides re-POSTed on top of the USA base; missing territories fall through to Apple auto-equalization. |
| `APP_TEMPLATE` | Per-app template entries (`scope_type='APP'` + `scope_app_id`). Same shape, but only IAPs in this app use it; everything else falls back to DEFAULT (and ultimately Apple). |

Template format identical to the Manager-provided
`docs/iap-management/templates/price-tiers-template.xlsx` Tier × Territory
matrix — empty cells are skipped (Q-I sparse). Cell value = `customer_price`
in the territory's currency. A blank `customer_price` cell means
"no override for this (tier, territory) — defer to Apple equalization."

### Per-territory override payload

`setPriceSchedule` grew an optional `additionalPricePointIds` array
(IAP.p1.e). When non-empty, the POST payload's `manualPrices.data` and
`included[]` carry one entry per overridden territory plus the USA base.
Apple's lid syntax (`${price-1}`, `${price-2}`, …) per IAP.o.11d remains
required — refIds are generated as `\${price-${i+1}}`.

Apple's `automaticPrices` relationship implicitly covers every territory
NOT in `manualPrices` — no enumeration of all 175 territories is needed
(verified against `docs/iap-management/sample_flow_create_price.md`).

### Per-territory price-point lookup

Each (territory, customer_price) override pair maps to an opaque Apple
`price_point_id` only obtainable from
`GET /v2/inAppPurchases/{appleIapId}/pricePoints?filter[territory]=X`.
`createTerritoryPricePointsCache()` wraps this fetch per orchestration with
in-flight dedup so two tiers referencing the same territory only fetch once,
and exposes a `prime()` seam so the USA fetch done by the canonical
USD-matcher feeds the cache for free.

### Q-K fail-soft

If a template entry references a `customer_price` that has no matching
Apple catalog entry for that territory (rare: Manager template drifts from
Apple's actual catalog), the orchestrator:

1. Logs the miss to Railway console (`[pricing] no Apple catalog match`).
2. Continues with whatever overrides DID resolve — POST still happens.
3. Returns `kind: 'partial-template-fail'` with `missing_price_points` list
   populated, surfaced via `actions_log.payload.missing_price_points` for
   Manager diagnostic queries.

This matches Manager Q-K's "continue-on-fail semantics — Manager workflow
tolerant" directive. POST failures (5xx, 4xx) still hit the existing
`failed-set` / `failed-lookup` / `failed-exception` outcomes.

### Source selection UI

Selection lives in three surfaces:

| Surface | Component | Scope |
|---|---|---|
| Create / Edit form | `PricingSourceSelector` above tier picker | Per-IAP (Q-J explicit). Default = Q-D most-specific (`APP_TEMPLATE → DEFAULT_TEMPLATE → APPLE`). |
| Bulk Import wizard Step 3 | Same `PricingSourceSelector` | Per-batch (Q-E batch-level). Applies to every CREATE / OVERWRITE row. |
| Update on Apple modal | Source banner inside `UpdateChangesPreviewModal` | Per-update; pricing stage runs on source-only change when template-backed. |

Unavailable options gray out with a helper line pointing Manager to the
upload surface (Settings → Pricing Templates for Default; App detail page →
Pricing Template for per-app).

### Schema

Two new tables, replace-only via partial unique indexes (Q-A):

```sql
iap_mgmt.price_tier_templates
  (id, scope_type, scope_app_id, uploaded_at, uploaded_by, source_filename)
  -- UNIQUE WHERE scope_type='GLOBAL'  → at most one Default
  -- UNIQUE (scope_app_id) WHERE scope_type='APP' → at most one per app

iap_mgmt.price_tier_template_entries
  (template_id, tier_id, territory_code, currency_code, customer_price, proceeds)
  -- ON DELETE CASCADE wipes entries when template header is replaced
```

The legacy `iap_mgmt.price_tier_territories` table is retained as
defensive backup (Q-B). The init migration auto-promotes existing rows
into a `GLOBAL` Default Template so the Manager's pre-IAP.p1 grid keeps
working without re-upload.

## IAP View Detail — Apple data composition (IAP.p2)

The `/iap-management/apps/{appId}/iaps/{iapId}/view` route reads Apple
canonical state in a single composed call. `getIapViewData` (in
[lib/iap-management/queries/iap-detail.ts](../../lib/iap-management/queries/iap-detail.ts))
fans out two Apple fetches in parallel and assembles the page view-model:

```ts
const [iapRes, scheduleSettled] = await Promise.all([
  getInAppPurchase(creds, appleIapId),                        // /v2/inAppPurchases/{id}?include=…
  getPriceScheduleForIap(creds, appleIapId).then(ok, err),    // 2-stage; see Gotcha 12
]);
```

`getPriceScheduleForIap` internally does a 3-stage fetch (Stage 1 — V2
schedule + manualPrice ID stubs; Stage 2 — V1 manualPrices with
inAppPurchasePricePoint + territory side-loaded, paginated; Stage 3 — V1
automaticPrices filtered by base territory to resolve the base price)
then returns `{ schedule, basePrice }`. The consumer
(`unpackPriceSchedule`) walks both response shells and produces the
`PriceScheduleView` with separate `entries[]` (manual overrides) and
`basePrice` (base territory). See Gotchas 12 + 13 + 14 + 15 + the
endpoint table above for why the single-round-trip approach the original
p2.a shipped with doesn't work against Apple's actual API.

**View-model fields:**

```ts
interface PriceScheduleView {
  baseTerritory: string;                  // Apple's baseTerritory id ("USA")
  basePrice: PriceScheduleEntry | null;   // Stage 3 result; null on fetch fail
  entries: PriceScheduleEntry[];          // Stage 2 manualPrices, sorted
}
```

**Observability:** every stage logs `[get-schedule] stage<N> …` lines to
console — `stage1 schedule_id=… manualRel_count=N`, `stage2 page=N
got=N has_next=…`, `stage3 base_territory=… got=N`, plus warn lines for
Stage 2 cap-hits and Stage 3 failures. Manager UAT failures can be
traced through Railway logs without rerunning.

### Per-stage error boundaries

| Stage | Failure behavior |
|---|---|
| `getInAppPurchase` | Critical path. Throws propagate to the route's outer try/catch → friendly red card. |
| `getPriceScheduleForIap` 404 | `priceSchedule: null` + `priceScheduleError: null`. The Price Schedule section renders the empty placeholder ("Use Edit to set a price"). |
| `getPriceScheduleForIap` other | `priceSchedule: null` + `priceScheduleError: <message>`. The Price Schedule section renders an amber inline notice; **other sections still render**. |
| Section-level render throw | Caught by `SectionErrorBoundary`. Replaces the offending section with an amber notice + message; the rest of the page is unaffected. |

This three-layer boundary (route-level → composer-level → render-level)
matches the "instrumentation-first when a silent prod report lands" feedback
captured during IAP.o.11 — Manager sees what's wrong, not a blank page.

### View-model shape

```ts
interface IapViewData {
  iap: InAppPurchase;
  localizations: InAppPurchaseLocalization[];
  screenshot: InAppPurchaseAppStoreReviewScreenshot | null;
  priceSchedule: PriceScheduleView | null;       // 404 + parse-fail both null
  priceScheduleError: string | null;             // populated on non-404
}
```

`PriceScheduleView.entries` is sorted oldest-startDate first (null/now
bucket → territory ASC) so the UI can partition into "current" and
"upcoming" by a single `entry.startDate > now()` walk.

### Apple Connect deep link

The "View on Apple Connect" affordance in the action bar (Q-H lock — single
canonical deep link, no per-section links) targets:

```
https://appstoreconnect.apple.com/apps/{appAppleId}/inappPurchases/{iapAppleId}
```

`appAppleId` is the numeric Apple ID of the parent app (route param `appId`);
`iapAppleId` is the IAP's Apple opaque id from `iap.id`.

