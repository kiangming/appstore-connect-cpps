# Design — Apple IAP per-territory availability (3 surfaces)

**Status:** ✅ **IMPLEMENTED** — arc `19051e8..6f206f8` (SC1-SC7), pushed
2026-08-17. Docs pass `6d138f1`+. **The design text below is preserved verbatim
as signed off**; as-built divergences are recorded in the appendix at the end of
this file, in the same style as the Q6 note. Where design and appendix disagree,
**the appendix is what shipped.**
**Scope:** Apple IAP Management only. Google module untouched.
**Picks up:** KB §10.4 backlog `IAP.p2+` — "`availableInAllTerritories` edit —
separate Apple endpoints (e.g. `/v1/inAppPurchaseAvailabilities`); not in
`InAppPurchaseV2UpdateRequest`" ([KB:970](IAP-MANAGEMENT-KNOWLEDGE-BASE.md)).
The *binary* half (ALL / NONE) shipped in Cycle 39. This design covers the
remaining half: **an arbitrary subset**.

**Manager-locked decisions carried into this design**

| # | Decision |
|---|---|
| 1 | REPLACE, not add. Every targeted item ends with exactly the chosen set. A warning names the items whose availability actually changes; a confirm dialog is required before running. |
| 2 | Surface C (individual Edit) defaults to the item's CURRENT territories. Surfaces A and B default to ALL. |
| 3 | On rate limit, after automatic retry is exhausted: STOP immediately, preserve the unprocessed remainder for manual retry. |

---

## PART 1 — GATES

### G1 ⚠ REQUEST SHAPE — **VERDICT: FEASIBLE. One request per IAP carries the full territory list.**

**Specs read.** Two are present and I read both:

| File | `info.version` | Used |
|---|---|---|
| `docs/iap-management/openapi.oas.json` | 4.3.1 | cross-check |
| `docs/openapi.oas.v20260717.json` | 4.4.1 | **primary** (newer) |

**Drift on this surface: NONE.** `InAppPurchaseAvailabilityCreateRequest` and
`InAppPurchaseAvailability` are byte-identical between 4.3.1 and 4.4.1
(compared as canonicalised JSON). The 4.4.1 spec adds
`/v1/subscriptionPlanAvailabilities` (a *subscription* resource, with both
PATCH and a relationships-PATCH) — **that is not our resource** and its
existence must not be read as "IAP availability has a PATCH too." It does not.

**Every endpoint involved.**

| Method | Path | Role |
|---|---|---|
| POST | `/v1/inAppPurchaseAvailabilities` | **the only write.** Full replace. |
| GET | `/v1/inAppPurchaseAvailabilities/{id}` | read one availability (metadata) |
| GET | `/v1/inAppPurchaseAvailabilities/{id}/availableTerritories` | **full territory list**, `limit` max **200** |
| GET | `/v2/inAppPurchases/{id}/inAppPurchaseAvailability` | IAP → its availability resource |
| GET | `/v1/territories` | the ~175-entry catalogue, `limit` max 200 |

There is **no PATCH and no DELETE** anywhere on `inAppPurchaseAvailabilities`
— confirmed by enumerating the operations on both paths in both spec files.
Already a documented LANDMARK: [KB §4.12:476-501](IAP-MANAGEMENT-KNOWLEDGE-BASE.md).

**Body shape — one IAP, full list, one request:**

```jsonc
POST /v1/inAppPurchaseAvailabilities
{ "data": {
    "type": "inAppPurchaseAvailabilities",
    "attributes":    { "availableInNewTerritories": true },   // REQUIRED
    "relationships": {
      "inAppPurchase":        { "data": { "type": "inAppPurchases", "id": "…" } },
      "availableTerritories": { "data": [ {"type":"territories","id":"USA"}, … ] }
} } }
```

`attributes`, `relationships`, `type` all required; within relationships both
`inAppPurchase` and `availableTerritories` required; `availableInNewTerritories`
required. No `minItems` on the territory array — which is exactly why
`setAvailabilityRemoveFromSales` can send `[]`
([availabilities.ts:152-177](../../lib/iap-management/apple/availabilities.ts#L152-L177)).

⇒ **N items = N requests.** NOT 175 × N. The catastrophic branch is ruled out.
The whole design proceeds on the cheap shape.

**Replace vs incremental — replace, structurally.** There is no diff endpoint,
no add/remove relationship operation (`/relationships/availableTerritories`
exposes **GET only** for IAPs). `availableTerritories.data` is a required,
complete array on a create-only resource. Apple's semantics are
create-or-supersede: the newest POST is the availability. The Manager's
"replace" choice is not just supported — **it is the only thing the API can
do.** The tool already relies on this twice
([availabilities.ts:103-105](../../lib/iap-management/apple/availabilities.ts#L103-L105),
[:136-151](../../lib/iap-management/apple/availabilities.ts#L136-L151)).

**⚠ G1-CORRECTION — the field named in the backlog does not exist.**
`availableInAllTerritories` appears **zero times** in either spec (grep count 0
in 4.3.1 and 4.4.1). The real attribute is **`availableInNewTerritories`** —
a *forward-looking* boolean ("auto-include markets Apple launches later"), not
a "currently everywhere" boolean. The codebase already knows this
([availabilities.ts:5-18](../../lib/iap-management/apple/availabilities.ts#L5-L18),
[KB:1008](IAP-MANAGEMENT-KNOWLEDGE-BASE.md)) — but the KB *backlog row* at
[KB:970](IAP-MANAGEMENT-KNOWLEDGE-BASE.md) still names the phantom field. That
row should be corrected when this ships, or the next reader re-derives it.

**How "All" differs from "all 175 individually ticked" — it doesn't, in the
territory list. It differs in the boolean.** The request carries the same 175
IDs either way. The distinguishing bit is `availableInNewTerritories`:

| Manager intent | `availableInNewTerritories` | `availableTerritories.data` |
|---|---|---|
| All countries or regions | `true` | all ~175 |
| Exactly these 175, frozen | `false` | all ~175 |
| A subset | `false` (recommended) | the chosen N |
| Remove from Sales | `false` | `[]` |

This is a **real, user-visible distinction** and the picker must expose it
(design §B). Today the tool hard-codes `true` for ALL
([:120](../../lib/iap-management/apple/availabilities.ts#L120)) and `false`
for NONE ([:164](../../lib/iap-management/apple/availabilities.ts#L164)); with
subsets the flag stops being derivable from the selection and becomes its own
input.

---

### G2 ⚠ READING CURRENT STATE — **the read path exists; on 2 of 3 surfaces the cost is ALREADY PAID.**

**Part 1 — the V1 sub-resource, already shipped.** KB §4.1's 10-ID truncation
trap ([KB:221-229](IAP-MANAGEMENT-KNOWLEDGE-BASE.md)) did bite this exact
feature, and it is already fixed. Hotfix 22 replaced the V2
`?include=availableTerritories` path (which additionally 400s outright:
`the maximum allowable limit is '50'`) with the canonical two-step:

- Step A — `GET /v2/inAppPurchases/{id}/inAppPurchaseAvailability` → availability id + `availableInNewTerritories`
- Step B — `GET /v1/inAppPurchaseAvailabilities/{availabilityId}/availableTerritories?limit=200`, cursor-paginated via `links.next`

[availabilities.ts:179-260](../../lib/iap-management/apple/availabilities.ts#L179-L260).
The spec confirms the asymmetry: `limit[availableTerritories]` on both V2/V1
*include* paths is capped at **50**; the standalone sub-resource `limit` is
capped at **200**. **The tool has the call it needs. Nothing new to build.**

One caveat to carry into implementation: Step B's `while (cursor)` loop lives
*inside* whatever `withRetry` wraps the whole function, so a 429 on page 2
restarts page 1. At ~175 territories / 200 per page this is a single page in
practice — a non-issue today, a latent one if Apple's inventory passes 200.

**Part 2 — COST for decision 1's warning.**

*Reads per item:* **2 Apple calls** (Step A + Step B). Not 1.

*Can they be batched?* **No.** Neither `/v1/inAppPurchaseAvailabilities` nor
the V2 relationship accepts a `filter[...]` over multiple IAP ids — the spec
lists no `filter` parameter on any of them. There is no multi-IAP availability
read. The cost is strictly linear.

*Can local data substitute?* **No — availability is not stored locally.**
Grepping every migration for an availability column on `iap_mgmt.iaps` returns
nothing; the only territory-shaped columns are the legacy
`iap_mgmt.price_tier_territories` table
([20260515000000:41](../../supabase/migrations/20260515000000_iap_mgmt_init.sql#L41))
and `custom_prices_baseline_base_territory`
([20260812000000:96](../../supabase/migrations/20260812000000_iap_mgmt_custom_prices.sql#L96)).
Neither is availability. `sync-states` syncs *state*, not availability. **There
is no cache to go stale, because there is no cache** — which is the P6-friendly
outcome (no cache on a cold path beats a stale multi-instance one).

*So what does the warning actually cost?* **On two of three surfaces, nothing
new** — the read is already happening for other reasons:

| Surface | Current state read today? | Where |
|---|---|---|
| **A** Set Availabilities | ✅ **yes, already** — on modal open, every visible IAP's availability is fetched through the per-IAP route via the shared client queue (concurrency 3) | [AvailabilitiesBulkModal.tsx:6-12](../../components/iap-management/AvailabilitiesBulkModal.tsx#L6-L12), [client-fetch-queue.ts:25](../../lib/iap-management/client-fetch-queue.ts#L25), [route](../../app/api/iap-management/iaps/[iapId]/availability/route.ts) |
| **B** Bulk Import | ➖ **N/A** — the items don't exist on Apple yet. There is no prior availability to change. | [execute/route.ts:824-856](../../app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts#L824-L856) |
| **C** Individual Edit | ✅ **yes, already** — the Edit page server component fetches it to pre-fill the radio | [page.tsx:64-67](../../app/(dashboard)/iap-management/apps/[appId]/iaps/[iapId]/page.tsx#L64-L67) |

⇒ **Prefer the existing reads. Add none.** The warning is computed from data
the surfaces already hold. Surface A's modal has an explicit fetch-progress UI
for it already (`fetchProgress {done,total}`,
[:107](../../components/iap-management/AvailabilitiesBulkModal.tsx#L107)) —
the Manager already waits for this today and tolerates it by design
("opening this modal is an explicit bulk action, not a passive page render").

*Staleness.* The read is live-per-open, so the window is "modal open → submit"
— seconds to minutes, single-actor. It is **not** zero: another Manager, or
Apple Connect web, can change availability in that window. What the warning can
promise is stated honestly in §C below.

*What the warning genuinely cannot cover:* rows where the read **failed**
(`error: "rate_limited" | "fetch_failed"`) or where the IAP isn't synced
(`not_synced`). Those must be shown as *unknown*, never silently folded into
"no change."

---

### G3 RATE LIMITS + THROTTLE

**Apple's documented limit — UNCERTAIN, and the KB says so.** The KB carries
two irreconcilable figures and refuses to pick:

| Source | Claim | Verdict (measured 2026-08-25) |
|---|---|---|
| Hotfix 25 | 250 req/hour | ❌ **disproven** |
| Hotfix 26 | ~1 req/sec/token (≈3,600/hour) | ✅ **confirmed — `user-hour-lim` = 3,600** (KB §4.9) |

[KB §4.9:395-415](IAP-MANAGEMENT-KNOWLEDGE-BASE.md) + footnote
[KB:1289-1297](IAP-MANAGEMENT-KNOWLEDGE-BASE.md). Resolution is **empirical**:
`X-Rate-Limit: user-hour-lim:…;user-hour-rem:…` is now logged per request
([apple-fetch.ts:149-160](../../lib/shared/apple-fetch.ts#L149-L160)) as
`[asc-client] … budget=R/L`. **This design does not resolve the conflict and
must not assume either figure.** It assumes only: the budget is finite, 429s
happen in normal bulk use, and the existing throttle is calibrated.

**Existing machinery, as wired.**

| Piece | Where | Behaviour |
|---|---|---|
| `iapFetch` | [fetch.ts:36](../../lib/iap-management/apple/fetch.ts#L36) | **retry-NAIVE** — throws `AppleRateLimitError` on 429 |
| `withRetry` | [apple-fetch.ts:101-135](../../lib/shared/apple-fetch.ts#L101-L135) | backoff `[500, 1000, 2000]` ms = **3 retries / 4 attempts**, honours `Retry-After`, ceiling 10 s |
| retry-after / rate-limit parsers | [apple-fetch.ts:137-165](../../lib/shared/apple-fetch.ts#L137-L165) | parse `Retry-After` + `X-Rate-Limit` for logs |
| `withConcurrency` | [concurrency.ts](../../lib/iap-management/concurrency.ts) | server-side bounded fan-out |
| client-fetch-queue | [client-fetch-queue.ts:25](../../lib/iap-management/client-fetch-queue.ts#L25) | **client-side** cap, `MAX_CONCURRENT = 3` |
| **Hotfix-26 throttle** | [execute/route.ts:100-116](../../app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts#L100-L116) | concurrency **5→2** + `INTER_ROW_DELAY_MS = 1000` |
| bulk-availability | [bulk-availability.ts:51](../../lib/iap-management/orchestrators/bulk-availability.ts#L51) | `DEFAULT_CONCURRENCY = 2`, **no inter-row delay** |

**⚠ The Hotfix-26 throttle is DELIBERATE and this design does not touch it.**
Concurrency stays 2; the 1 s/row delay stays 1 s/row. Surface B's new territory
step adds **zero** Apple calls per row — the availability POST it already makes
simply carries a different territory array.

**Composition rule (do not repeat the double-wrap).** `iapFetch` is
retry-naive *by design* so exactly one `withRetry` sits at the orchestration
boundary. Two known violations to not imitate:

- **`sync-states:91`** — `withRetry(() => listAllInAppPurchases(...))`, but
  `listAllInAppPurchases` already wraps **each page** in `withRetry`
  internally ([client.ts:70-71](../../lib/iap-management/apple/client.ts#L70-L71),
  documented at [client.ts:52-54](../../lib/iap-management/apple/client.ts#L52-L54)).
  Nested ⇒ up to 4×4 = 16 attempts and ~10 s of stacked backoff on one page.
- **`export-fetch:69`** — `fetchExportSources`
  ([export-fetch.ts:65](../../lib/iap-management/apple/export-fetch.ts#L65))
  fans out at `EXPORT_FETCH_CONCURRENCY` over injected `deps` that retry
  internally; the function itself contains **no** `withRetry` (grep: zero
  hits), so the wrap lives at whatever call site supplies `deps`. Flagged as
  existing backlog, **not** in scope here.

*The correct pattern already exists and should be copied verbatim:* the
per-IAP availability route composes retry-naive `getAvailabilityForIap` with
exactly one `withRetry`
([route.ts:16-21](../../app/api/iap-management/iaps/[iapId]/availability/route.ts)),
and `bulk-availability` wraps each row once via `trackedWithRetry`
([bulk-availability.ts:188-191](../../lib/iap-management/orchestrators/bulk-availability.ts#L188-L191)).
**One wrap, at the orchestrator, over a naive leaf.**

**Decision 3 — "stop and preserve the remainder."** Today's orchestrator does
the opposite: a row that exhausts retries is caught, audited `ERROR`, and the
loop **continues** to the next row
([bulk-availability.ts:208-224](../../lib/iap-management/orchestrators/bulk-availability.ts#L208-L224)).
Manager's decision changes this for **rate-limit exhaustion specifically** —
and only that. Representation is specified in design §D.

---

### G4 ⚠ REUSE THE TERRITORY PICKER — **partial reuse; one extraction required.**

The ~175-territory dialog shipped by the custom-territory-prices cycle is
[CustomPricesDialog.tsx](../../components/iap-management/iap-form/CustomPricesDialog.tsx)
(787 lines). It is **not** a reusable picker — the territory UI is inlined into
a price-editing dialog. Verdict per piece:

| Piece | Where | Verdict |
|---|---|---|
| Continent grouping + chips | [territory-continent.ts:81-98](../../lib/iap-management/apple/territory-continent.ts#L81-L98) — `APPLE_CONTINENTS`, `getContinentForTerritory` | ✅ **reuse as-is.** Standalone, 99 lines, no price coupling. |
| Country display name | [territory-name.ts:40](../../components/iap-management/view-detail/territory-name.ts#L40) — `territoryName(code)` | ✅ **reuse as-is.** 44 lines, pure. |
| Search box + continent chip row + sticky-header scroll table + live count chip | [CustomPricesDialog.tsx:493-545](../../components/iap-management/iap-form/CustomPricesDialog.tsx#L493-L545) | ⚠ **EXTRACT.** Visually and behaviourally identical need; currently inline JSX. This is the P1 twin-path risk the gate names. |
| `matchesBaselineQuery` | [baseline.ts:231](../../lib/iap-management/custom-prices/baseline.ts#L231) | ⚠ typed to `BaselineRow` (price-shaped). Generalise the *predicate* (name / code / currency), leave the row type behind. |
| Per-territory price-point fetch, provenance labels, stale/import banners, base-territory read-only row | CustomPricesDialog throughout | ❌ **price-only. Do not carry over.** |

**What genuinely differs.** Prices are a per-territory **value** (fetched
lazily per row, three-state option loading, revert-to-none semantics).
Availability is a per-territory **boolean** — no fetch per row, no per-row
async, no provenance. So the extracted shell must own *chrome only* (search,
continent filter, scroll frame, count, select-all/clear-all) and leave the
right-hand cell to the caller.

**Proposed extraction** (names indicative, not prescriptive):
`components/iap-management/territory/TerritoryPickerShell.tsx` — takes the
territory list, query/continent state, and renders a header + toolbar + scroll
body with a caller-supplied row renderer. CustomPricesDialog adopts it in the
same commit *or* the extraction is deferred and this feature files a P1 debt
row — but the two must not silently diverge, because on the Edit form they sit
**adjacent** (Custom Prices button and Territories button in the same
`IapForm`). Recommendation: **extract, adopt both, one commit.**

---

### G5 ACTION TYPE NAMING — **recommend (a): a new action type, migration + registry in the SAME commit.**

`AVAILABILITY_SET_ALL_TERRITORIES` is one of the two values repaired in the P2
audit — migration
[20260811000000:82-83](../../supabase/migrations/20260811000000_iap_mgmt_actions_log_availability.sql#L82-L83),
allow-list [action-types.ts:58+](../../lib/iap-management/action-types.ts#L58),
registry [registry.ts:89-90](../../lib/audit-constraints/registry.ts#L89-L90).
It is emitted from three sites:
[create-on-apple:436](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts#L436),
[execute:850](../../app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts#L850),
[update-orchestration:601](../../lib/iap-management/apple/update-orchestration.ts#L601),
[bulk-availability:167](../../lib/iap-management/orchestrators/bulk-availability.ts#L167).

Once a subset is possible, the name asserts something false about the row.
That is exactly **the status principle** (P5): a tracking value must reflect
the real outcome, not the button clicked.

| Option | Assessment |
|---|---|
| (a) **New type** `AVAILABILITY_SET_TERRITORIES` | Rows self-describe. Historical `…SET_ALL…` rows keep meaning "all" and stay true forever. **Cost: a forward-only migration + `IAP_ACTION_TYPES` + `registry.ts` — all three in ONE commit** (P2, non-negotiable; the parity test in `action-types.test.ts` enforces migration↔constant, and the source-scan enforces literal↔constant). |
| (b) Keep the name, put territories in the payload | Zero migration. But every future reader must know that `SET_ALL_TERRITORIES` sometimes means "12 territories" — the misnomer becomes permanent, and the KB gains another "two-concept naming, do NOT confuse" row. |

**Recommendation: (a).** Keep `AVAILABILITY_SET_ALL_TERRITORIES` emitted **only**
when the chosen set is genuinely all-plus-`availableInNewTerritories:true` (so
`create-on-apple` and bulk-import defaults keep emitting it unchanged, and old
rows stay honest); emit `AVAILABILITY_SET_TERRITORIES` for every explicit set.
`AVAILABILITY_REMOVE_FROM_SALES` stays as-is for the empty set.

**Reconstructability (required either way).** The payload must let a reader
rebuild the exact set without calling Apple:

```jsonc
{ "apple_iap_id": "…", "result": "SUCCESS", "source": "bulk|edit|bulk-import",
  "target": "SUBSET",
  "territories": ["USA","VNM", …],          // the FULL list actually sent
  "territory_count": 12,
  "available_in_new_territories": false,
  "previous_territory_count": 175,          // from the pre-read, when known
  "previous_known": true,                   // false ⇒ pre-read failed/absent
  "apple_availability_id": "…",
  "rate_limit": { … } }
```

Store the **sent** list, not a diff — the sent list is what Apple applied, and
per the never-transform rule it is recorded verbatim. `previous_known: false`
must be honest when the pre-read failed rather than defaulting to 175.

---

### G6 INTERACTION WITH CUSTOM PRICES — **UNCERTAIN on rejection; one CONCRETE risk found.**

**What the spec says: nothing.** `InAppPurchasePriceScheduleCreateRequest`
requires `inAppPurchase`, `manualPrices`, `baseTerritory` and references
territories only through those. It has **no** availability relationship, and
`inAppPurchaseAvailabilities` has no price relationship. The two resources do
not reference each other anywhere in 4.4.1.

⇒ **Does Apple reject / ignore / silently accept a custom price for an
excluded territory? UNCERTAIN — the spec is silent.** I will not guess.
**What would settle it:** one staging IAP; set availability to a 2-territory
subset; POST a price schedule carrying a manual price for a third, excluded
territory; read back `…/manualPrices`. Three distinguishable outcomes: 4xx
(reject) / 201 with the row absent on read-back (ignore) / 201 with the row
present (accept-and-park). Railway logs are ground truth (KB §4.1's crystallised
pattern: *Apple API specification ≠ Apple API behavior*).

**Does the pricing POST care about availability? Not per the schema — but
there is a concrete, provable coupling: `baseTerritory`.** The tool defaults it
to **`"USA"`**
([price-schedules.ts:105](../../lib/iap-management/apple/price-schedules.ts#L105),
[pricing-orchestration.ts:256](../../lib/iap-management/apple/pricing-orchestration.ts#L256)),
and `baseTerritory` is **required** by the schedule create request. A Manager
who picks a subset **excluding USA** produces an IAP priced from a territory it
is not sold in. Whether Apple errors is UNCERTAIN; that the configuration is
incoherent is not. Design §G carries this as an open question, and §B carries a
non-blocking advisory in the picker (advisory, because the pricing surface is
not part of this feature's write path and a structural block here would be a
guess dressed as a guard).

---

### G7 SURFACE INVENTORY

| # | Surface | Entry point | Emitter today | Shared? |
|---|---|---|---|---|
| **A** | Set Availabilities (bulk, from the IAP list) | [AvailabilitiesBulkModal.tsx](../../components/iap-management/AvailabilitiesBulkModal.tsx) → `POST /api/iap-management/iaps/bulk-availability` → [route.ts](../../app/api/iap-management/iaps/bulk-availability/route.ts) | [bulk-availability.ts:164-191](../../lib/iap-management/orchestrators/bulk-availability.ts#L164-L191) | orchestrator is A-only; **leaf calls shared** |
| **B** | Bulk Import (create many) | [BulkImportWizard.tsx](../../app/(dashboard)/iap-management/apps/[appId]/bulk-import/BulkImportWizard.tsx) — 4 steps, `type Step = 1\|2\|3\|4` at [:73](../../app/(dashboard)/iap-management/apps/[appId]/bulk-import/BulkImportWizard.tsx#L73) | [execute/route.ts:824-856](../../app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts#L824-L856) — step 4.5 of the per-row pipeline | separate route; **leaf calls shared** |
| **B′** | Single Create on Apple | [create-on-apple/route.ts:410-441](../../app/api/iap-management/apps/[appId]/iaps/[iapId]/create-on-apple/route.ts#L410-L441) — step 11.5 | same | **not in the 3 surfaces**, but the 4th emitter — see below |
| **C** | Individual Create/Edit | [AvailabilitiesSection.tsx](../../components/iap-management/iap-form/AvailabilitiesSection.tsx) (2 radios) → diff → [update-orchestration.ts:592-640](../../lib/iap-management/apple/update-orchestration.ts#L592-L640) Stage 5 | same | shares the diff/stage pipeline |

**The single shared choke point — and the reason this is one change, not four:**
all four emitters bottom out in exactly two functions,
`setAvailabilityToAllTerritories` /
`setAvailabilityRemoveFromSales`
([availabilities.ts:107](../../lib/iap-management/apple/availabilities.ts#L107),
[:152](../../lib/iap-management/apple/availabilities.ts#L152)), which differ
only in the two fields G1 tabulates. **Prefer a SHARED choke point over three
separate patches** (P1): introduce one `setAvailabilityTerritories(creds, id,
{territoryIds, availableInNewTerritories})` and express the existing two as
thin callers. Then B′ inherits correct behaviour for free instead of becoming
the fourth path someone forgets.

**⚠ Twin-structure asymmetry (P8) — surfaces are NOT symmetric.** Two extra
surfaces read this state and must be checked when the shape changes:
- [AvailabilityCell.tsx](../../components/iap-management/AvailabilityCell.tsx) — the list column, renders "one of six terminal states"; a subset must not fall through to a wrong bucket.
- [IapAvailabilitiesSection.tsx:60-103](../../components/iap-management/view-detail/IapAvailabilitiesSection.tsx#L60-L103) + [availability-classify.ts](../../lib/iap-management/apple/availability-classify.ts) — the View Detail classifier, which already has a "subset" notion.

---

## PART 2 — DESIGN

### A. State + data flow

**Shared core (new, one place).**

```
lib/iap-management/apple/availabilities.ts
  setAvailabilityTerritories(creds, appleIapId, {
    territoryIds: readonly string[],
    availableInNewTerritories: boolean,
  })                                        ← the ONLY POST
  setAvailabilityToAllTerritories(…)        ← thin caller: (allIds, true)
  setAvailabilityRemoveFromSales(…)         ← thin caller: ([], false)

lib/iap-management/apple/territory-selection.ts   (new, pure)
  type TerritorySelection = {
    territoryIds: readonly string[];
    availableInNewTerritories: boolean;
  }
  ALL_SELECTION(allIds)  ·  isAllSelection(sel, allIds)
  classify(sel): "ALL" | "SUBSET" | "NONE"
  diffAgainst(current: AvailabilityForIap | null, next): {
    willChange: boolean; added: string[]; removed: string[];
  }
```

Pure module ⇒ the warning maths (§C), the picker's live count, and the audit
payload all read from one implementation, and it is unit-testable without Apple.

**⚠ LAYER-GAP — the rule that must agree on both sides.** The client's notion
of "this selection is valid / this item will change" and the server's must be
the same function, not two. Concretely: the client renders the change-list from
`diffAgainst`; the server re-derives the same thing from its own pre-read
before writing. If they disagree, the feature does not exist for the user. Both
import `territory-selection.ts`. The **server** decides what is written; the
client only decides what is *shown*.

**Per surface.**

| | A — Set Availabilities | B — Bulk Import | C — Individual Edit |
|---|---|---|---|
| Default | **ALL** (decision 2) | **ALL** (decision 2) | **item's current set** (decision 2) |
| Selection scope | one set → every selected item | one set → every row, no per-row variation | this item |
| Where held | modal state, alongside existing `states`/`selected` | wizard state, new **Step 3** | `IapForm` state, `form.availability_selection` |
| Pre-read | already fetched on open (G2) | none — items don't exist yet | already fetched by the page server component (G2) |
| Write | `bulk-availability` orchestrator, one POST/item | existing per-row step 4.5, one POST/row | Stage 5 of `update-orchestration` |

**Surface B — the new step.** Wizard becomes `type Step = 1|2|3|4|5`:
1 Excel → 2 Screenshots → **3 Territories (new)** → 4 Preview → 5 Result. Placed
*before* Preview so the preview can state the territory count per row, and so
the confirm gate (§C) sits where every other batch-wide decision already sits.
Default ALL means a Manager who ignores the step gets exactly today's behaviour
— **the step must be skippable-by-default, never a new blocker on an existing
flow.**

**Surface C — the radio pair becomes three.** `AvailabilityTarget = "ALL" |
"NONE"` ([validation.ts:35](../../lib/iap-management/validation.ts#L35)) gains
a third arm carrying the set. The existing 2-radio component
([AvailabilitiesSection.tsx:51-75](../../components/iap-management/iap-form/AvailabilitiesSection.tsx#L51-L75))
grows a third option — *Selected countries or regions* — with a **Choose
territories** button and an "N of 175 selected" summary line, mirroring how
`CustomPricesSummary` sits under the pricing section. The diff-detector's
`availability_changed` ([diff-detector.ts:237-251](../../lib/iap-management/apple/diff-detector.ts#L237-L251))
compares selections, not just targets — two subsets with the same size are not
equal.

> ⚠ **N-layer cascade.** The selection threads: picker → section → `IapForm` →
> page-level payload → server action → diff-detector → orchestrator stage →
> leaf. Per the recorded incident pattern, **the page-level intermediate
> payload is the canonical missed site**, and a zod `.default()` on the new
> field will mask the omission silently. Do not give it a `.default()`.

### B. Territory picker + mockup

**Mockup:** [`design/apple-per-territory-availability-mockup.html`](design/apple-per-territory-availability-mockup.html)
— the picker, the three surface framings, and the confirm dialog.

Required behaviours:

1. **Search** over country name, ISO code (`territoryName` + raw id).
2. **Continent chips** — `ALL` + `APPLE_CONTINENTS`, reused verbatim from `territory-continent.ts`.
3. **Select all / Clear all apply to the CURRENT FILTER, not the catalogue.** Labelled with the number they will affect (`Select all 42 shown`) so it can never read as a global action. This is the single most dangerous control in the dialog.
4. **Live count** — `N of 175 selected` chip, always visible, updating on every toggle.
5. **Pre-selection (surface C)** — opens with the item's current territories ticked; a *Reset to current* control restores it.
6. **The "All" distinction is explicit (G1).** A segmented control at the top: `All countries or regions` / `Selected countries or regions`. Choosing *All* ticks all 175 **and** sets `availableInNewTerritories: true`, with the sub-line *"Includes any new market Apple launches later."* Manually ticking all 175 leaves the flag `false` and the UI says so: **"175 of 175 selected — new Apple markets will NOT be added automatically."** Two states that send different bodies must never render identically.
7. **Advisory only (G6):** if the selection excludes `USA`, a non-blocking note — *"Prices are calculated from USA, which this selection excludes. Check the price schedule."* Advisory, not a block: G6 is UNCERTAIN and a structural guard would encode a guess.

### C. The replace warning (decision 1)

**Identifying what changes.** For each targeted item, `diffAgainst(current,
next)`; an item is *affected* iff `willChange`. Three buckets, and all three
are shown:

| Bucket | Shown as |
|---|---|
| **Will change** | listed by product id + name, with `175 → 12` and `+2 / −165` |
| **Already matches** | collapsed count — *"8 items already have exactly this set (no call will be made)"* |
| **Unknown** | listed explicitly — read failed / rate-limited / not synced |

**⚠ The unknown bucket is the honest part.** The pre-read can fail (§G2), and
those items **will still be written** — the tool cannot know whether that is a
change. They are named individually, never folded into a count.

**Confirm dialog content** (destructive → ask BEFORE, never toast after):
- Headline: **"Replace availability on N items?"**
- The verb, unhedged: *"Each item's availability will be **replaced** with the 12 territories you chose. Territories not in your selection will be removed."*
- The three buckets above, the change list **scrollable and complete** — not "and 40 more".
- `Cancel` (default focus) / `Replace availability on N items`.
- **Skip-when-nothing-to-do:** if *will change* = 0 and *unknown* = 0, no write is offered at all.

**What the warning can and cannot promise** — stated in the dialog itself, not
only in this doc: *"Based on each item's availability as read a moment ago.
If someone changed it on App Store Connect since, this list may be out of
date."* The pre-read is live-per-open and un-cached (§G2), so the window is
seconds-to-minutes — real, small, and not worth a second read.

**Surface B has no warning** — nothing exists to replace. The confirm gate
there states the set and the row count only.

### D. Rate-limit stop-and-resume (decision 3)

**Stop condition — narrow, and only this.** Stop iff a row's write fails with
retries exhausted on 429 (`AppleRateLimitError` escaping `withRetry` after
`[500,1000,2000]`). **Any other failure keeps today's fail-soft behaviour**:
audit `ERROR`, continue. Rationale: a state-guard rejection or a bad territory
on item 3 says nothing about item 4; a 429 says the budget is gone and every
subsequent call will burn it further. Conflating the two would turn one bad row
into an aborted batch.

The moment the stop fires, the orchestrator ceases dispatch, drains in-flight
work, and returns a **new terminal outcome**: `overall: "STOPPED_RATE_LIMITED"`
alongside today's `SUCCESS | PARTIAL | FAILURE | NO_OP`
([bulk-availability.ts:228-236](../../lib/iap-management/orchestrators/bulk-availability.ts#L228-L236)).

**What the user sees.** The existing per-row progress view, plus a banner:

> **Stopped — App Store Connect rate limit.**
> 34 of 120 items were updated. 1 item failed. **85 items were not attempted.**
> Wait a few minutes, then **Retry remaining 85**.

**What is preserved.** In client state (the modal is already open and owns the
run): the exact `TerritorySelection` and the ordered list of un-attempted
internal IAP ids. **Deliberately not persisted server-side** — a DB "pending
remainder" table is a new stateful surface with its own staleness and
cross-instance problems for a modal-lifetime concern. The trade is stated
plainly in the UI: *closing this dialog discards the remainder.* If Manager
later wants durability, that is a follow-on with its own design.

**How retry resumes only the remainder.** *Retry remaining 85* re-POSTs to the
same route with `iapIds` = the un-attempted list and the identical selection.
Successful rows are **never** in that list, so they are not re-written — which
matters here beyond wasted calls: a re-POST is a full replace, so re-running a
success is a real Apple write, not a no-op. The `previous_*` fields in the
retry's audit payload come from the **original** pre-read, marked
`previous_known` accordingly; the retry does not re-read.

Hub tracking: the retry is a **new run** (R3 multi-start hygiene, as
[the modal already does](../../components/iap-management/AvailabilitiesBulkModal.tsx#L40-L44)).
The stopped run finalizes with its own terminal status — *not* `FAILED`, since
34 items really did succeed. `computeBulkImportTerminalStatus` needs a mapping
for `STOPPED_RATE_LIMITED`; **the status must reflect the real outcome, not the
button clicked** (P5).

**Per-item AND per-case error display (Manager's explicit ask).** Every failed
row names the item and the reason. No generic summary line replaces it:

| Case | Row text |
|---|---|
| Not synced | `com.x.gem100 — Not on Apple yet. Run Create on Apple first.` |
| Rate limited (this row) | `com.x.gem200 — App Store Connect rate limit, retries exhausted.` |
| Apple rejected a territory | `com.x.gem300 — Apple rejected territory "XYZ" (422).` |
| State forbids | `com.x.gem400 — In Review; App Store Connect refused the change.` |
| Not attempted | `com.x.gem500 — Not attempted (stopped at rate limit).` |
| Unknown prior state | `com.x.gem600 — Updated. Previous availability was unknown.` |

### E. Audit / provenance

Per G5: new `AVAILABILITY_SET_TERRITORIES`, with the migration +
`IAP_ACTION_TYPES` + `lib/audit-constraints/registry.ts` entry **in the same
commit** — no exceptions (P2; the constraint failure is silent by construction,
[action-types.ts:6-18](../../lib/iap-management/action-types.ts#L6-L18)).
`AVAILABILITY_SET_ALL_TERRITORIES` stays, emitted only for genuine
all + `availableInNewTerritories:true`; `AVAILABILITY_REMOVE_FROM_SALES` stays
for the empty set. Payload per G5 — the full sent list, verbatim.

One audit row per item per surface, as today. Surface B keeps writing its row
inside the per-row pipeline; the batch row (`BULK_IMPORT_BATCH`) additionally
records the batch-wide selection once.

### F. Failure modes

| Mode | Behaviour |
|---|---|
| **Partial batch** | Today's fail-soft: per-row audit, batch reports `PARTIAL`. Unchanged, except the rate-limit case (§D). |
| **A territory Apple rejects** | Apple returns 400/422 for the whole POST — availability is all-or-nothing per item, so the item is unchanged and reported with Apple's message verbatim (never transformed). If it recurs, the fix is catalogue refresh, not client-side filtering: `getAllTerritoryIds` caches for 1 h ([availabilities.ts:73-90](../../lib/iap-management/apple/availabilities.ts#L73-L90)) and a Manager holding a picker open across a catalogue change can submit a stale id. |
| **State forbids the change** | **Mirror `state-edit-blocked.ts`, do not invent.** [state-edit-blocked.ts:1-29](../../lib/iap-management/apple/state-edit-blocked.ts#L1-L29) is deliberately a **pre-warn banner, not a pre-block** — `WAITING_FOR_REVIEW` / `IN_REVIEW` are flagged, the button stays enabled, Apple is the source of truth because local state can lag. Same shape here: flag those rows in the confirm dialog, do not filter them out. |
| **Empty selection** | Semantically identical to Remove from Sales. Do not silently reroute — the confirm dialog says so explicitly and requires the same acknowledgement. |
| **Pre-read failed** | Item is written; its row reports *"Previous availability was unknown."* Never presented as "no change". |
| **Catalogue < selection** | If a selected id is absent from a refreshed `/v1/territories`, surface it before submit rather than letting Apple 422 the batch. |

### G. Open questions / risks

1. **G6 — custom price in an excluded territory: UNCERTAIN.** Spec is silent. Settled by the staging experiment in §G6. Until then the picker warns and does not block.
2. **`baseTerritory` defaults to USA** ([price-schedules.ts:105](../../lib/iap-management/apple/price-schedules.ts#L105)) — a USA-excluding selection is incoherent even if Apple accepts it. Should the base territory follow the selection? **Manager decision**, out of this feature's write path.
3. ~~**Rate-limit figure unresolved**~~ ✅ **RESOLVED 2026-08-25 — `user-hour-lim` = 3,600** (KB §4.9 carries the method). This design deliberately assumed neither figure, so nothing here changes. The contingency written here — *"if telemetry lands on 250, surface A's pre-read (2 calls/item) becomes the dominant consumer"* — **does not fire**: at 3,600 a 500-item pre-read (~1,000 calls) is 28% of the hour, heavy but not fatal. The pre-read was hardened anyway by the A′ read phase, on scoping grounds rather than budget ones.
4. **Surface A's mode filter stops making sense.** The modal today shows only currently-removed items in `set-all` mode and only currently-available in `remove` mode ([AvailabilitiesBulkModal.tsx:14-17](../../components/iap-management/AvailabilitiesBulkModal.tsx#L14-L17)). With arbitrary targets every item is a candidate. Proposal: keep the two existing one-click modes as presets, and add a third "Choose territories" mode with **no** pre-filter. Needs Manager confirmation.
5. **Remainder is client-held, not durable** (§D) — a browser close loses it. Stated in the UI. Durable queueing is a follow-on if Manager wants it.
6. **`AvailabilityCell`'s six terminal states** ([AvailabilityCell.tsx:15](../../components/iap-management/AvailabilityCell.tsx#L15)) — confirm a subset renders as a distinct state and does not fall into an "Available"/"Removed" bucket that misreports it (P8 twin-structure check).
7. **KB backlog row [KB:970](IAP-MANAGEMENT-KNOWLEDGE-BASE.md) names a non-existent field** (`availableInAllTerritories`). Correct it when this ships.
8. **G4 extraction timing.** Recommendation is extract-and-adopt-both in one commit; if deferred, file the P1 debt explicitly — the two pickers sit adjacent on the Edit form.

---

## Implementation notes (for the commit that follows this design)

- **P17 — mutation-check must land on the right call site.** The acceptance test for the new leaf proves it by *breaking* the intended call and watching the test fail, not merely by watching it pass. The shared `setAvailabilityTerritories` has four callers (A, B, B′, C); a test that passes with the leaf stubbed proves nothing about any of them.
- **Never transform Apple's values.** Territory ids and error bodies are recorded and displayed verbatim.
- **One `withRetry`, at the orchestrator, over a retry-naive leaf** (§G3). Do not nest.
- **Do not touch** `INTER_ROW_DELAY_MS` or the concurrency-2 setting in bulk-import.


---

## APPENDIX — AS BUILT (added at arc close, design text above unchanged)

Same convention as the Q6 note: the design is left as signed off; this appendix
records what actually shipped and why it differs.

### A1. Surface coverage — one of three is not reachable

| Surface | Design | As built |
|---|---|---|
| **C** Edit item | picker, default = current | ✅ shipped, reachable. Renders only for `mode === "edit" && syncedToApple` — the **create form has no availability control at all**, since a draft has no Apple resource to edit. §PART 2 said "Create/Edit"; only Edit exists. |
| **B** Bulk Import | picker step, default ALL | ✅ shipped, reachable as step 4 of 5. |
| **A** Set Availabilities modal | picker as a third mode | ✅ shipped, reachable since the D1 fix. Shipped *unreachable* at arc close — the modal, route, orchestrator and ~60 tests all supported `set-territories` while nothing set that mode. Wiring it also required fixing five header strings that were binary ternaries and would have labelled the picker "Remove from Sales". |

### A2. SC6p1 — the design's own §G5 groundwork was unreachable over HTTP

SC2 shipped the selection-driven orchestrator and SC3 the stop-and-resume on top
of it. Both were complete and **neither could be invoked from any client**: the
route's zod schema still read `z.enum(["set-all","remove"])` and rejected the
third action at the boundary. It survived two chunks because every test below the
route called `executeBulkAvailability` directly, so no test crossed the schema.
The design did not call for a route-level test; it should have.

### A3. SC6p1 — stopped runs closed the hub as SUCCESS

§D specified `STOPPED_RATE_LIMITED` as a distinct outcome, which shipped. What
the design did not trace was the **hub terminal status**: that mapping buckets by
`failed`, and a rate-limit stop typically ends `failed === 0` with a large
NOT_ATTEMPTED remainder — mapping to SUCCESS. Now forced to PARTIAL with the
unattempted count in the reason. Lesson: specifying a new outcome value obliges
tracing every consumer that buckets outcomes.

### A4. SC7 — the "one catalogue read per batch" claim was cache-dependent

§G3 assumed the per-row availability write was "a single POST". True for the
POST, but the row called `setAvailabilityToAllTerritories`, which resolves the
catalogue internally — so `getAllTerritoryIds` was *invoked per row* and stayed
one Apple request only because the 1 h module cache absorbed the repeats. A cold
process mid-run or a batch crossing the hour would have produced N reads. Now
resolved once before the row loop and threaded down, matching the existing
`pricePointCatalog` pattern.

### A5. Surface B skips the §G6 base-territory advisory

§B behaviour 7 specified the advisory on every picker. Surface B **omits it**:
Bulk Import rows are **pre-create**, so no `base_territory` exists yet anywhere
in the execute route or bulk-import lib. Per the no-invented-defaults rule, an
item with no recorded base is skipped rather than warned against a guessed
"USA". Surfaces A and C carry it.

### A6. Surface A's advisory wording diverges from C's

§G6 gave one copy for all surfaces. As built, surface A says *"This action
changes availability only — it does not touch prices"* because surface A runs no
pricing stage, whereas C points at the price schedule. Same underlying fact,
different true statement per surface.

### A7. The model had to change shape, not just gain a field

§PART 2 A assumed the existing form field could carry the selection. It could
not: `AvailabilityTarget` was `"ALL" | "NONE"`, and a two-valued enum cannot
express a subset — keeping it would have forced Stage 5 to record an action type
derived from the UI mode, the exact status-principle violation §G5 exists to
prevent. Replaced with a `TerritorySelection` throughout, with
`availability_previous_known` as a separate field so a failed read is never
conflated with a genuine Removed-from-Sale.

### A8. Still open at arc close (both fixed in the follow-up cycle)

- ~~Surface A entry point (A1).~~ **Fixed.** The lesson kept: a
  build-it-then-wire-it sequence needs the wiring tracked as its own
  deliverable, and needs one test that starts *outside* the component being
  built. Every SC6 test began inside the modal or below it, so none could see
  that nothing opened it.
- ~~`set-all` / `remove` render `NOT_ATTEMPTED` as "Failed".~~ **Fixed** by
  teaching `ProgressList` the third state rather than routing those modes
  through `BulkResultsView` (whose retry re-posts a `TerritorySelection` these
  modes do not have). Lesson kept: **adding a state to a shared producer
  obliges an audit of every consumer** — SC3 added the state, SC6p2 updated one
  of the two consumers, and the older one kept mislabelling for two chunks.
- No HTTP e2e reaches the execute route's row loop (multipart + full create
  pipeline). Chain held from both ends around
  `resolveBatchAvailabilitySelection` — a declared limitation, not an oversight.
