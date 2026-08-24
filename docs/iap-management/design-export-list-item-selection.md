# Investigation + Design — Export list: item selection, filters, and stop-and-preserve

**Status:** 🔵 **DESIGN ONLY — no code written.** Gates measured against the
tree at `c87e1c1`, every claim carrying file:line.
**Scope:** Apple IAP Management, the **Export list** surface only. Google
module untouched (but see **G6** — one component is shared and must not
be modified). Hotfix-26 throttle untouched.
**Picks up:** Manager request — export cannot select items, has no filter,
and has no defence against Apple's rate limit.

**⚠ This is the same problem shape A′ solved eight commits ago**
(`3da8c40`, `4b16666`, arc `e3d4a9a..c87e1c1`): select first, read only what
was selected, stop on 429 and preserve the remainder. Most of the machinery
already exists. **PART 2.0** states exactly what is reused, what must be
extracted, and what is genuinely different — building a second mechanism for
this would be P1 twin-path.

---

## PART 0 — TL;DR

| Gate | Answer |
|---|---|
| **G1** — what does export cost? | **3 Apple requests per IAP** (detail + price-schedule stage 1 + stage 2), plus `ceil(N/200)` for the list. **N=100 → 301. N=500 → 1,503. N=1000 → 3,005.** No pagination, no filter, no cap — it always sweeps the whole app. |
| Does the §4.9 cap conflict matter? | **No.** At 250/h the hour is blown at **~83 items**; at 3,600/h at **~1,198**. Both say the same thing: an app of 500+ IAPs cannot be exported safely without selection. **The recommendation does not depend on resolving §4.9.** |
| Export vs. the modal | Export is **more** expensive per item (3 vs 2) and has *always* run unconditionally over the full catalogue — the exact shape A′ just removed from `set-territories`. |
| **G2** — cheaper source for the Available/Removed filter? | **A cheap source exists and it is NOT SOUND.** `include=inAppPurchaseAvailability` on the list endpoint is OAS-valid and would cost 0 extra requests — but it cannot classify, because "Remove from Sales" is a *present* availability resource with an *empty* territory list (KB §4.12), and the included resource carries no territory count. Classifying on presence would label every removed item **Available** — the inverse of the truth, on exactly the items the filter is for. |
| G2 recommendation | **Ship the free filters (Type + Apple Status + search, 0 requests) now. Do NOT put an availability filter in the picker.** Offer Available/Removed as an opt-in filter *after* selection, on the selected set only, with its cost on the button. Never absorb 2N silently. |
| G2 bonus (UNCERTAIN) | The same include would hand us `availabilityId` for free, cutting the availability read from **2 requests to 1** — for the lazy filter *and* for A′'s existing read phase. Needs one live probe. |
| **G3** — `export:69` double-wrap | **CONFIRMED REAL.** `withRetry(() => listAllInAppPurchases(...))` over a function that already retries every page. 4×4 = **16 attempts** single-page; up to **32** on a 5-page app, because the outer retry restarts pagination from page 1. ~17.5 s of stacked backoff. The codebase already names this defect in a comment — and names only the sync-states twin. |
| **G4** — partial file | **Trivially possible.** The workbook is built in memory *after* the fetch loop returns (`XLSX.write`, no streaming), and a second sheet is a 3-line addition to `book_new` + `book_append_sheet`. **The Manager's chosen shape is buildable exactly as specified** — no CSV compromise. |
| G4 defect found | A rate-limited price-schedule read **degrades to `priceSchedule: null` silently** and the row exports with blank prices — indistinguishable from "Apple has no schedule". Worse: a territory priced only on throttled rows **disappears from the column set entirely**. |
| **G5** — country selection cost | **Pure post-processing, free.** Territories only filter columns from already-fetched rows. Item-before-country ordering is correct for readability; it saves nothing and costs nothing. |
| **G6** — surface | One button, `requireIapSession` (any signed-in user, not admin). ⚠ **`ExportOptionsDialog` is SHARED with the Google module** — the item picker must NOT go inside it. **No test starts at `IapListClient` for export.** |

---

# PART 1 — GATES

## G1 — What export reads, exactly, per item

### The call chain, traced end to end

`POST /api/iap-management/apps/[appId]/export`
([route.ts:47-101](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L47-L101))

**Step 1 — the list.**
[`listAllInAppPurchases`](../../lib/iap-management/apple/client.ts#L60-L86) —
`GET /v1/apps/{id}/inAppPurchasesV2?limit=200`, following Apple's cursor.
**`ceil(N/200)` requests.** No state filter, no type filter, no cap — the
route says so itself ([:66-67](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L66-L67)):
*"applies no state filter — every IAP, every state, per Manager's ask."*

**Step 2 — per item**, fanned out at concurrency 8
([export-fetch.ts:38](../../lib/iap-management/apple/export-fetch.ts#L38)):

| # | Call | Endpoint | Retry? |
|---|---|---|---|
| 1 | `getIapDetailFromApple` → [`getInAppPurchase`](../../lib/iap-management/apple/client.ts#L119-L128) | `GET /v2/inAppPurchases/{id}?include=inAppPurchaseLocalizations,appStoreReviewScreenshot` | ⚠ **NO** — retry-naive |
| 2 | `getPriceScheduleForIap` **stage 1** ([price-schedules.ts:318-325](../../lib/iap-management/apple/price-schedules.ts#L318-L325)) | `GET /v2/inAppPurchases/{id}/iapPriceSchedule?include=baseTerritory,manualPrices&limit[manualPrices]=50` | yes (`withRetry`) |
| 3 | `getPriceScheduleForIap` **stage 2** ([:247-306](../../lib/iap-management/apple/price-schedules.ts#L247-L306)) | `GET /v1/inAppPurchasePriceSchedules/{sid}/manualPrices?include=inAppPurchasePricePoint,territory&limit=200` | yes, per page |

**Yes — export is one of the two known `getPriceScheduleForIap` callers**, and
it pays the full §4.1 2-stage workaround. Stage 2 is skipped only when Stage 1
reports zero manual-price refs
([:343-349](../../lib/iap-management/apple/price-schedules.ts#L343-L349));
since Apple stores the *base* price inside `manualPrices` (KB §4.15 / p2.l),
any priced IAP has at least one, so stage 2 runs. Apple's ~175 territories fit
in one `limit=200` page, so stage 2 is **1 page**, capped at
`MAX_STAGE2_PAGES = 20` ([:245](../../lib/iap-management/apple/price-schedules.ts#L245)).

**Localizations** come free — side-loaded on call #1's `?include=`.
**Availability is NOT read at all** today
([export-fetch.ts:88-98](../../lib/iap-management/apple/export-fetch.ts#L88-L98)
builds the row from productId / name / state / priceSchedule / localizations
only). That matters for **G2**: an availability filter would be *new* cost,
not a reuse of something already paid.

⇒ **3 requests per IAP** typical. **2** when the schedule 404s or has no
manual prices. Never 1.

### The numbers

**Total = `ceil(N/200) + 3N`.**

| N | list | per-item | **typical total** | worst (sustained 429 on pricing) |
|---|---|---|---|---|
| 100 | 1 | 300 | **301** | ~916 |
| 500 | 3 | 1,500 | **1,503** | ~4,524 |
| 1000 | 5 | 3,000 | **3,005** | ~9,032 |

Worst case is `1 + 4 + 4 = 9` per item (detail is not retried; stage 1 and
stage 2 each burn `withRetry`'s 4 attempts —
[apple-fetch.ts:23,109](../../lib/shared/apple-fetch.ts#L109)), plus the list
amplified by **G3**'s double-wrap.

### Verdict against both cap scenarios

Solving `3N + ceil(N/200) ≤ cap`:

| Cap (KB §4.9) | Export blows the hour at | N=500 | N=1000 |
|---|---|---|---|
| **250/h** (Hotfix 25) | **~83 items** | 6× over | 12× over |
| **3,600/h** (Hotfix 26) | **~1,198 items** | 42% of the hour | **83% of the hour** — a second export in the same hour fails |

**Both scenarios give the same verdict.** At N=500–1000 the unconditional
full-catalogue export is not viable, exactly as A′ concluded for the modal's
pre-read. **This design does not depend on §4.9 ever being resolved.**

### The asymmetry that matters for the design

The detail read (call #1) is **retry-naive**. A 429 there throws
`AppleRateLimitError` straight into `export-fetch.ts:100-109`, which records
it as an ordinary `failure` string and **the loop keeps going** — hammering an
already-throttled Apple for the remaining N-1 items. So today:

- "rate limited" and "Apple said no" arrive in the same `failures` array,
  distinguishable only by parsing a message string;
- a 429 on the detail read is **not** proof the budget is exhausted, because
  nothing retried — unlike everywhere else in this module, where
  `AppleRateLimitError` escaping means `withRetry` already burned its curve.

⇒ **Before any stop logic can be trusted, the detail read needs exactly one
`withRetry`** so "rate limited" means the same thing here it means in
`bulk-availability`. Exactly one — see **G3**.

---

## G2 — A cheaper source for the Available / Removed filter

The Manager delegated this. Every candidate was checked; none was assumed.

### (a) The list page's `AvailabilityCell` — **it IS the cost, not a source**

[`AvailabilityCell.tsx:83-86`](../../components/iap-management/AvailabilityCell.tsx#L83-L86)
fetches `/api/iap-management/iaps/{internalId}/availability`, whose route
([availability/route.ts:100](../../app/api/iap-management/iaps/%5BiapId%5D/availability/route.ts#L100))
calls `getAvailabilityForIap` —
**Step A** metadata (1 request) + **Step B** paginated territories (≥1)
= **2+ requests per item**
([availabilities.ts:230-275](../../lib/iap-management/apple/availabilities.ts#L230-L275)).

No cache exists at any layer: the route has none, and the cell fetches with
`cache: "no-store"` ([:85](../../components/iap-management/AvailabilityCell.tsx#L85)).
The IntersectionObserver + 3-slot client queue **spread** that cost across
scrolling; they do not reduce it. And the results live in each cell's local
`useState` ([:63](../../components/iap-management/AvailabilityCell.tsx#L63)),
unlifted — so there is nothing to read even if we wanted to.

⇒ **Not a source. Rejected.**

### (b) A local column on `iap_mgmt.iaps` — **does not exist**

Table definition:
[`20260515000000_iap_mgmt_init.sql:82-102`](../../supabase/migrations/20260515000000_iap_mgmt_init.sql#L82-L102)
— `apple_iap_id, app_id, product_id, reference_name, type, state,
base_territory, tier_id, family_sharable, review_note, synced_at, …`.
No availability column.

`grep -rn "availab" supabase/migrations/*iap_mgmt*.sql` returns **only
comments** in the two `actions_log` migrations
(`20260811000000`, `20260817000000`) — the availability arc widened an enum,
it added no state column. **SC5 §G2 re-verified, not assumed. Rejected.**

⚠ Per KB §4.15 discipline this was checked against migrations and code, not
against the KB's prose. Both phantom fields in this module
(`availableInAllTerritories`, `existsOnApple_validated`) were born from
trusting prose.

### (c) `sync-states` — **does not touch availability**

`grep -rn "availab" lib/iap-management/sync-states/
app/api/iap-management/apps/[appId]/iaps/sync-states/route.ts` → **0 hits.**
Rejected.

### (d) ⚠ An Apple list endpoint that returns availability inline — **EXISTS, and is NOT SOUND**

This is the finding, and it is a trap worth recording.

`GET /v1/apps/{id}/inAppPurchasesV2` **does** accept
`include=inAppPurchaseAvailability` — verified in the OAS include whitelist
(`docs/iap-management/openapi.oas.json`), alongside
`fields[inAppPurchaseAvailabilities]=availableInNewTerritories,availableTerritories`.
Side-loading it would cost **0 extra requests** — the export already pays
`ceil(N/200)` for that same list.

**It still cannot classify.** `classifyAvailability`
([availability-classify.ts:20-32](../../lib/iap-management/apple/availability-classify.ts#L20-L32))
needs `territoryCount > 0`. The include gives:

| What the include yields | Why it is not enough |
|---|---|
| presence / absence of the availability resource | ⚠ **Presence ≠ available.** KB §4.12: "Remove from Sales" is a POST of the *same* resource with an **empty** territory array ([availabilities.ts:179-192](../../lib/iap-management/apple/availabilities.ts#L179-L192)). Every item this module has ever removed **has** an availability resource with zero territories. |
| `availableInNewTerritories` | **Forward-looking only** — KB §4.13. Says nothing about the current set; A′'s own classifier explicitly refuses to use it ([availability-classify.ts:27-31](../../lib/iap-management/apple/availability-classify.ts#L27-L31)). |
| `availableTerritories` | A **relationship**. Resources in `included[]` carry only `links`, never `data` (CLAUDE.md JSON:API rule) — so no ids and no count. There is no `limit[availableTerritories]` on this operation (only `limit[inAppPurchaseLocalizations]`, `limit[images]`, `limit[offerCodes]`), and V2 caps that relationship at 50 anyway (Hotfix 22, [availabilities.ts:197-199](../../lib/iap-management/apple/availabilities.ts#L197-L199)). |

⇒ Classifying on presence would mark **every removed item "Available"** — the
exact inverse of the truth, on precisely the rows the filter exists to find.
**Rejected on correctness, not on cost.** Record it in the KB so the next
session does not rediscover the cheap half and ship it.

**🟡 The genuinely useful half (UNCERTAIN).** `data[]` resources *do* carry
`relationships.{rel}.data` (CLAUDE.md), so the include should hand us each
item's **`availabilityId` for free** — which is exactly what
`getAvailabilityForIap`'s Step A exists to fetch
([availabilities.ts:234-246](../../lib/iap-management/apple/availabilities.ts#L234-L246)).
Skipping Step A cuts the availability read from **2 requests to 1**, for the
lazy filter here *and* for A′'s existing read phase. **UNCERTAIN** — Apple
spec ≠ Apple behavior is this module's crystallized pattern (KB §4.1). One
live probe settles it (see U2).

### (e) `state` — free, but it is a different concept

The list already returns `attributes.state`, which the export already writes
as its **Status** column
([xlsx-export.ts:49-50](../../lib/iap-management/xlsx-export.ts#L49-L50)),
and the OAS enum includes `REMOVED_FROM_SALE` / `DEVELOPER_REMOVED_FROM_SALE`.
**0 extra requests.**

⚠ **But `state` is the review/lifecycle status, not territory reach.** Treating
them as one is the status-principle trap (KB §9 P5) — the module's own code
keeps them apart: `submit-batch/bucket.ts:178-180` reads
`REMOVED_FROM_SALE` as a *submission* blocker, while `AvailabilityCell`
derives "Remove from Sales" from territory count alone. An `APPROVED` IAP with
zero territories reads **Removed** in the tool and **APPROVED** in `state`.
Whether Apple flips `state` when the territory list empties is **UNCERTAIN**
(see U3).

### 🎯 G2 RECOMMENDATION

**Do not put an availability filter in the item picker.** Three parts:

1. **Ship the free filters now.** The picker gets **search** (productId + name)
   + **Type** + **Apple Status** — all served from `iaps` the page already
   holds, **0 Apple requests**. The Status control is labelled *Apple review
   status* and lists `REMOVED_FROM_SALE` / `DEVELOPER_REMOVED_FROM_SALE` among
   its values, **never** as "Available/Removed" — two concepts, two labels.
2. **Available / Removed becomes an opt-in filter on the SELECTED set only.**
   It appears *after* selection, reuses `runAvailabilityReadPhase` verbatim,
   and its control carries its own price:
   `Filter by availability — 40 items, ~40 more Apple requests`
   (`~80` if U2 comes back negative). Off by default, so the ordinary export
   path pays **zero** extra.
3. **Reject (d)** in code review and in the KB.

If the Manager wants availability filtering *before* selection anyway, the
cost is **+2N on top of the export's own 3N** and there is no way around it —
that number goes on screen, it does not get absorbed.

---

## G3 — `export:69` double-wrap: **CONFIRMED, and in scope**

### The shape

```
export/route.ts:68-70   await withRetry(() => listAllInAppPurchases(creds, appleAppId))
client.ts:70-72           await withRetry(() => iapFetch(... page ...))     ← already retries
```

[`withRetry`](../../lib/shared/apple-fetch.ts#L101-L132) loops
`attempt = 0 … backoff.length` with `DEFAULT_BACKOFF_MS = [500, 1000, 2000]`
([:23](../../lib/shared/apple-fetch.ts#L23)) ⇒ **4 attempts**, and re-throws
the last `AppleRateLimitError` — which the outer wrapper then treats as
retryable.

**4 × 4 = 16 attempts** for a single-page app.

**And it is worse than 16 on a multi-page app**, because the outer retry
restarts `listAllInAppPurchases` **from page 1** — every already-fetched page
is re-fetched. A 5-page app (N=1000) whose 429 lands on page 5:
`4 × (4 + 4) = 32` requests for a list that costs 5.

**Stacked backoff:** the inner curve burns `500+1000+2000 = 3.5 s` per outer
attempt, and the outer sleeps another `500/1000/2000` between them —
**≈17.5 s** before the call gives up.

### Corroboration from the codebase itself

`bulk-availability.ts:361-365` already carries the warning:

> *"⚠ EXACTLY ONE `withRetry`, over a retry-naive leaf. … Do not add a second
> wrapper here or inside the leaf — that is the `sync-states:91` ×
> `client.ts:70` double-wrap, which turns 4 attempts into 16 and ~10 s of
> stacked backoff on a single row."*

**Export is the sibling that comment did not sweep.** Grep of every call site:

| Site | Shape | Verdict |
|---|---|---|
| [`export/route.ts:68-70`](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L68-L70) | `withRetry(() => listAllInAppPurchases(…))` | ⚠ **double-wrap** |
| [`sync-states/route.ts:91`](../../app/api/iap-management/apps/%5BappId%5D/iaps/sync-states/route.ts#L91) | same | ⚠ **double-wrap (known twin)** |
| [`page.tsx:78`](<../../app/(dashboard)/iap-management/apps/[appId]/page.tsx#L78>) | bare `listAllInAppPurchases(…)` | ✅ correct — **and proof the wrapper is redundant, not load-bearing** |
| `bulk-import/execute/route.ts:160` | `withRetry(fn, {…})` over a retry-naive leaf | ✅ correct, not a twin |

### Fix

**Delete the outer wrapper at both sites, in one commit** (P1: the shared
choke point already exists *inside* `listAllInAppPurchases`; three separate
patches would be the anti-pattern). Under the design below the export site
disappears entirely — the route stops listing (PART 2.B) — but
**`sync-states:91` must still be fixed on its own**, and a regression test
must assert that a 429 on page 1 produces **4** `iapFetch` calls, not 16.

---

## G4 — Producing a partial file

### Mechanics — all favourable

| Question | Answer | Evidence |
|---|---|---|
| Built in memory or streamed? | **In memory**, in one shot, *after* the fetch loop returns | [route.ts:80-83](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L80-L83) |
| Can a stopped run still produce a file? | **Yes, with no rework** — nothing is written until `buildExportWorkbook(plan)` runs, so a truncated `sources` array is already a valid input | [route.ts:78-79](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L78-L79) |
| Format? | **`.xlsx`**, SheetJS `xlsx@0.18.5` | [route.ts:89-90](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L89-L90), [xlsx-export.ts:26-28](../../lib/iap-management/xlsx-export.ts#L26-L28) |
| Multiple sheets possible? | **Yes, natively.** The workbook is `book_new()` + one `book_append_sheet` | [xlsx-export.ts:231-232](../../lib/iap-management/xlsx-export.ts#L231-L232) |

⇒ **The Manager's chosen shape — a clean sheet plus a separate sheet listing
the misses with reasons — is buildable exactly as specified.** No CSV
compromise, no format change, no streaming rework. A second
`book_append_sheet(wb, errorsWs, "Not exported")` is a three-line addition.

Caveat: SheetJS CE writes merges and column widths but **no cell styling**
([xlsx-export.ts:25-27](../../lib/iap-management/xlsx-export.ts#L25-L27)) — the
error sheet gets no red fill. It gets an explicit **Reason** column instead,
which is better anyway.

### What already exists

Failures are **already collected**
([export-fetch.ts:112-117](../../lib/iap-management/apple/export-fetch.ts#L112-L117))
and **already counted** in `X-Export-Failed-Count`
([route.ts:93](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L93)),
surfacing as a toast warning
([IapListClient.tsx:353-355](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L353-L355>)).
**The data exists; only the sheet is missing, and the reasons are collapsed
into one string.**

### ⚠ Two defects this requirement surfaces

**1. The run cannot stop.** `withConcurrency`
([concurrency.ts:12-34](../../lib/iap-management/concurrency.ts#L12-L34)) has
no latch and no `NOT_ATTEMPTED` concept. Under a 429 cascade the pool keeps
dispatching all N items into a wall. There is no bucket that means "never
asked", so **nothing is safe to re-export blindly** today.

**2. A throttled price read degrades silently into wrong data.**
[export-fetch.ts:81-86](../../lib/iap-management/apple/export-fetch.ts#L81-L86)
catches *everything* and sets `priceSchedule = null`. Downstream,
[`toExportRow`](../../lib/iap-management/xlsx-export.ts#L90-L114) turns null
into `prices = {}` and `baseTerritory: null` — **blank cells, indistinguishable
from "Apple genuinely has no schedule"**, which is the meaning the type's own
docstring assigns to null
([xlsx-export.ts:51-53](../../lib/iap-management/xlsx-export.ts#L51-L53)).
Two causes, one representation — the same caption-lie shape as A′'s
candidate 2.

**Second-order, and worse:** the territory column set is built from
*successful* rows only
([xlsx-export.ts:136-137](../../lib/iap-management/xlsx-export.ts#L136-L137)).
A territory priced **only** on throttled rows **vanishes from the workbook
entirely** — no blank column, no marker, no trace. That is a silent wrong
value in an artifact the Manager acts on.

Both are **pre-existing**, both are made visible (not created) by this
requirement, and both must be fixed for "stop and still give me a good file"
to mean anything.

---

## G5 — Country selection is post-processing, and free

`buildExportPlan(sources, territories)`
([xlsx-export.ts:131-158](../../lib/iap-management/xlsx-export.ts#L131-L158)):
`allTerritories` is derived from the **already-fetched** rows
([:136-146](../../lib/iap-management/xlsx-export.ts#L136-L146)) and the
selection merely filters that list
([:148-152](../../lib/iap-management/xlsx-export.ts#L148-L152)). No territory
parameter reaches `fetchExportSources`
([route.ts:73-76](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L73-L76)).

The route's own docstring already states it
([:18-20](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L18-L20)):

> *"The selection only narrows which columns the workbook renders — it does
> NOT change the fetch; every IAP's full price schedule is still fetched
> regardless."*

⇒ **Confirmed: choosing countries costs nothing and changes nothing about the
fetch.** The Manager's requested step order (items → countries) is adopted
because it reads better — pick *what*, then pick *how wide* — **not** because
it saves requests. Stated plainly so nobody later "optimises" by reordering.

---

## G6 — Surface, RBAC, and what is pinned today

**Entry point.** One button, "Export list"
([IapListClient.tsx:461-474](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L461-L474>))
→ opens `ExportOptionsDialog`
([:839-843](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L839-L843>))
→ `handleConfirmExport`
([:320-370](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L320-L370>))
POSTs the route with a 10-minute `AbortController` ceiling
([:318](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L318>)).

**RBAC.** `requireIapSession()` only
([route.ts:52](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L52),
[auth.ts:43-49](../../lib/iap-management/auth.ts#L43-L49)) — **any signed-in
user**, not admin. Matches the module's Hotfix-10 posture
([auth.ts:51-57](../../lib/iap-management/auth.ts#L51-L57)). **No change
proposed.**

**⚠ `ExportOptionsDialog` is SHARED with the Google module.**
[`components/google-iap-management/iap-list/IapListClient.tsx:35,607`](../../components/google-iap-management/iap-list/IapListClient.tsx#L35)
imports the very same component, and its docstring states the intent
([ExportOptionsDialog.tsx:5-7](../../components/iap-management/ExportOptionsDialog.tsx#L5-L7)):
*"ONE component, imported by both modules' IapListClient — not duplicated per
platform."*

⇒ **The item-picker step must NOT go inside it.** This is **P8 (twin-structure
asymmetry)**: Apple needs a step Google does not, because Google's list fetch
returns complete pricing in one pass
([xlsx-export.ts:12-14](../../lib/iap-management/xlsx-export.ts#L12-L14)) while
Apple pays 3 requests per item. Same button, different economics, different
flow. The dialog stays a **territory** picker and stays untouched.

**Tests pinning today's behaviour.**

| File | Pins |
|---|---|
| `lib/iap-management/apple/export-fetch.test.ts` | isolation + degrade paths of the per-item fetch |
| `lib/iap-management/xlsx-export.test.ts` | plan/workbook shape (incl. a `REMOVED_FROM_SALE` status row at :215-220) |
| `components/iap-management/ExportOptionsDialog.test.tsx` | the territory dialog |

⚠ **No test starts at `IapListClient` and exercises export.** The only
list-level test in the module is
`IapListClient.territories-entry.test.tsx`, which exists *precisely because*
this arc kept missing that layer — its own docstring
([:3-13](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.territories-entry.test.tsx#L3-L13>)):
*"Every one of them started INSIDE the modal … none started from the IAP list,
so none noticed that nothing ever set that mode."*

⇒ **B8's lesson applies again.** The primary acceptance for this work must
start at `IapListClient`. See PART 2.I.

**Hub tracking.** The export route has no `startHubRun` / finalize, and
`AVAILABILITY_HUB_FEATURE` covers only the three availability modes
([AvailabilitiesBulkModal.tsx:222](../../components/iap-management/AvailabilitiesBulkModal.tsx#L222)).
Export is untracked. **Out of scope** — noted, not fixed. (If it is ever added,
read the parameterization gap first: the tag is a hardcoded constant, not a
parameter, on the Apple side.)

---

# PART 2 — DESIGN

## 2.0 — What is reused, what is extracted, what is genuinely different

**⚠ This is the most important table in the document.** Building a second
stop-and-preserve mechanism for the same problem is P1 twin-path.

| A′ machinery | Verdict |
|---|---|
| [`bulk-item-search.ts`](../../lib/iap-management/apple/bulk-item-search.ts) — `matchesQuery`, `filterRowsByQuery`, `selectionCounts`, `toggleAllForQuery`, `ROW_WINDOW_STEP` | ✅ **REUSE AS-IS. Zero changes.** Already pure, already keyed on `BulkItemRow`, and it already *is* requirement **F** — "Select all = all matching, never the rendered set" ([:6-20](../../lib/iap-management/apple/bulk-item-search.ts#L6-L20)). |
| [`bulk-item-rows.ts`](../../lib/iap-management/apple/bulk-item-rows.ts) — `buildBulkItemRows`, `partitionRows`, `SelectableRow`/`ExcludedRow` narrowing, `emptyCause` | ✅ **REUSE the builder**, ⚙ **extract the reason strings.** Export passes `eligibleAppleIds: null` — the escape hatch A′ already built, meaning *"the question was never asked"* ([:104-110](../../lib/iap-management/apple/bulk-item-rows.ts#L104-L110)). But its exclusion *wording* is availability-specific, and export's exclusion **set** is different (see **G**), so the reason table becomes per-surface. |
| `bulk-availability-view.ts` — `SUCCESS / FAILED / NOT_ATTEMPTED`, `partitionResults`, `resumableIds`, `isStoppedRun` | ✅ **REUSE the vocabulary + the partition helpers.** Not `ConfirmBuckets` / `baseTerritoryAdvisory` — those are availability-specific. |
| [`BulkResultsView.tsx`](../../components/iap-management/availabilities/BulkResultsView.tsx) | ✅ **REUSE** for the on-screen post-run summary — it already renders three separate sections and puts the remainder-loss warning **before** the close control. |
| The modal's item-list sub-tree (search box, sticky select-all bar, windowed rows + "Show more", excluded tail) | ⚙ **EXTRACT** to `components/iap-management/item-picker/BulkItemPicker.tsx`; both the modal and the export wizard render it. Do **not** import `AvailabilitiesBulkModal` — it is 1,877 lines and mode-coupled. |
| [`runAvailabilityReadPhase`](../../lib/iap-management/apple/availability-read-phase.ts) | ❌ **Do NOT reuse for the export fetch, and do NOT clone it.** It is **client-side** (injected `acquire`/`release` from the Hotfix-25 queue) and typed to `AvailabilityForIap`. ✅ It **is** reused, unchanged, for the *opt-in availability filter* (G2 part 2), which genuinely is a client-orchestrated read. |
| The server stop latch in [`bulk-availability.ts:330-400`](../../lib/iap-management/orchestrators/bulk-availability.ts#L330-L400) — `withConcurrency` + `stoppedByRateLimit` + `NOT_ATTEMPTED` return | 🎯 **THIS is export's real twin.** Server-side, same helper, same three states. ⚙ **Extract the latch + partition into a shared `runStoppablePool`**; `bulk-availability` and the export fetch both call it. One mechanism, two callers. |

### What is genuinely different (four things)

1. **Export produces an artifact.** A′ only mutated state, so its remainder
   lived on screen and was lost on close (its own decision 6). Export's
   remainder has a **second home — a sheet** — which is strictly better and
   removes the "closing loses it" warning.
2. **Export is one server round-trip, not N client fetches.** The stop is
   **server-side** and the three-state partition must ride back in the *file
   and the headers*, because the response body is the `.xlsx`. This follows
   **P12 (finalize-placement-by-orchestration-locus)**: server-route
   operation ⇒ server-side finalize.
3. **No confirm-diff step.** Nothing destructive to diff, so the wizard is
   **2 steps, not 3**. Do not import `SetTerritoriesConfirm`.
4. **Cost is 3/item, not 2**, and today's 429 lands on a **retry-naive** leaf
   (**G1**). So the stop trigger needs the `withRetry` fix first, or "stopped
   on rate limit" would fire on a single un-retried 429.

---

## 2.A — The wizard

```
[Export list] ──▶ STEP 1  Choose items      0 Apple requests
                    │      search + Type + Apple Status + Select all
                    │      (optional) Filter by availability ── ~1-2 req × selected
                    ▼
                  STEP 2  Choose countries   0 Apple requests
                    │      the EXISTING ExportOptionsDialog, unchanged
                    │      [Back] returns to step 1 with the selection intact
                    ▼
                  STEP 3  Export             3 × M Apple requests
                           stop-and-preserve, then the file
```

| Step | Apple cost | Why |
|---|---|---|
| 1 — items | **0** | `iaps` + `drafts` + `appleToInternal` are already props on the page ([page.tsx:78,110,112](<../../app/(dashboard)/iap-management/apps/[appId]/page.tsx#L78>)). Filters are pure client-side over data in hand. |
| 1 — optional availability filter | `~1-2 × selected` | **Only if the Manager opts in**, and the button says the number. |
| 2 — countries | **0** | **G5**. `TERRITORY_CATALOG` is a local module. |
| 3 — export | **`3 × M`** | **G1**, M = selected items. |

## 2.B — Applying the A′ model: the read is proportional to the ask

Under A′, opening the picker costs **zero** Apple reads and the fetch is scoped
to the selection. Two consequences:

**The route stops listing.** The client already holds the catalogue, so the
selection travels in the POST body:

```ts
interface ExportRequestBody {
  territories?: string[] | null;                       // unchanged (G5)
  items: Array<{ appleIapId: string; productId: string }>;   // NEW — required
}
```

- `productId` rides along purely as the **label** for the "Not exported"
  sheet — the route no longer has `iap.attributes.productId` to hand
  ([export-fetch.ts:104](../../lib/iap-management/apple/export-fetch.ts#L104)).
  It is the label the Manager already saw on screen; it is never sent to Apple
  and never transformed.
- `ceil(N/200)` requests disappear, **and G3's export-side double-wrap
  disappears by deletion rather than by patch.** (`sync-states:91` still needs
  its own fix — see G3.)
- Size is fine: 1,000 items × ~60 bytes ≈ 60 KB in a POST body — the
  URL-length trap (KB §10.13.E) that made this a POST in the first place is
  already avoided.
- **Trade, stated honestly:** the export now reflects the page's snapshot, not
  a fresh list. An item deleted on Apple in between 404s on its detail read and
  lands in the "Not exported" sheet with that reason — which is more useful
  than silently exporting a different set than the one the Manager ticked.

**The numbers:**

| Scenario | Today | Under this design |
|---|---|---|
| 20 of 1,000 | 3,005 | **60** |
| 100 of 1,000 | 3,005 | **300** |
| all 1,000 | 3,005 | **3,000** |

⚠ **A′'s honest limit carries over verbatim, and the UI must say it too:**
this does **not** make a full sweep cheap. Selecting all 1,000 items still
costs ~3,000 requests. What changes is that the cost becomes **proportional to
what the Manager asked for** instead of to the size of the catalogue. It
converts an unconditional cost into a chosen one. Do not describe it as an
optimisation.

## 2.C — Stop-and-preserve: three states, and the fourth thing export has

**Prerequisite (G1):** wrap the detail read in **exactly one** `withRetry`, so
an escaping `AppleRateLimitError` means the same thing it means in
`bulk-availability` — the curve is spent.

Then, the shared `runStoppablePool` (2.0) gives every item one of:

| Status | Meaning | Where it lands | Safe to re-export blindly? |
|---|---|---|---|
| **EXPORTED** | full row read | main sheet | n/a |
| **PARTIAL** | detail read OK, **price schedule not read** | main sheet **and** the error sheet | no — re-export to fill prices |
| **FAILED** | Apple was asked and refused | error sheet, with the **real** reason | ⚠ no — a human reads the reason first |
| **NOT_ATTEMPTED** | the pool had already stopped; **nothing was sent** | error sheet | ✅ **yes — the only bucket that is** |

**FAILED sub-reasons are kept apart** (the Manager's explicit ask, "lý do
thật" — never merged):

| Reason | Trigger |
|---|---|
| `RATE_LIMITED` | 429 after `withRetry` exhausted its curve |
| `APPLE_REJECTED` | non-429 4xx — 404 (gone from Apple), 403, 409 |
| `FETCH_FAILED` | 5xx, transport, parse |

⚠ **`NOT_ATTEMPTED` is read from an explicit status, never inferred from
`!ok`** — A′'s rule, verbatim
([AvailabilitiesBulkModal.tsx:133-139](../../components/iap-management/AvailabilitiesBulkModal.tsx#L133-L139)).
Inferring it would send Apple a request it just refused.

⚠ **`PARTIAL` is new, and it is the G4 defect being made honest.** Today a
throttled price read silently becomes blank cells. Under this design the row
still exports its non-price data **and** is named in the error sheet as
`PARTIAL — prices missing (rate limited)`, so a blank price cell stops being
ambiguous. The alternative — failing the whole row — throws away product id,
name, status and localizations that were fetched successfully, and is rejected.

⚠ **And the column-set defect (G4) must be fixed with it**: with any PARTIAL
or FAILED row present, the workbook cannot claim its territory columns are the
complete set. Either the column union is taken over *attempted* rows, or the
main sheet carries a header note naming the count. Recommend the header note —
it needs no extra data and cannot invent a column with no prices in it.

## 2.D — File output

**Sheet 1 — `Apple IAP Export`** (name unchanged,
[xlsx-export.ts:33](../../lib/iap-management/xlsx-export.ts#L33)). Successes,
plus PARTIAL rows. Layout unchanged. Only addition: a one-line note above the
header when anything was missed —
`⚠ 12 of 40 items were not fully exported — see the "Not exported" sheet.`

**Sheet 2 — `Not exported`.** Present **only when non-empty** (a permanently
empty sheet trains people to ignore it):

| Product ID | SKU Name | Outcome | Reason |
|---|---|---|---|
| `com.vng.gems.980` | Gems 980 | Failed | Apple rate-limited the read after retries were exhausted. |
| `com.vng.gems.1980` | Gems 1980 | Partial | Row exported, but prices could not be read (rate limited). |
| `com.vng.starter` | Starter Pack | Failed | Apple returned 404 — the item no longer exists on Apple. |
| `com.vng.vip.1` | VIP 1 | Not attempted | Export stopped before this item. **Safe to export again.** |

Never a bare count, never a merged reason, never a raw Apple body dump.

**Response headers** gain the partition so the toast can be truthful:

```
X-Export-Item-Count          (existing)
X-Export-Failed-Count        (existing)
X-Export-Partial-Count       NEW
X-Export-Not-Attempted-Count NEW
X-Export-Stopped             NEW — "rate_limit" when the pool latched
```

⚠ **A stopped run is not a failed run** (P5 / `BulkResultsView`'s own rule).
The toast must not paint a run red when 380 of 400 items exported cleanly.
Copy: *"Exported 380 of 400. Apple's rate limit stopped the run — 20 items were
not attempted and are listed in the file. Safe to export those again."*

**Re-export is a fresh file every time**, per the Manager's lock — no merge, no
append. Nothing in the design tries to be clever about that.

## 2.E — Scale, shown before the run

Sticky footer of step 1, updating live with the selection:

```
Export 40 items · about 120 Apple requests
```

Estimate = `3 × selected` (2 for items with no price schedule — the estimate
rounds up and says "about").

Above a conservative threshold the line grows a caution — **never a block**;
the Manager asked for stop-and-preserve, not prevention:

> ⚠ About 1,500 Apple requests. Large exports can reach Apple's hourly limit.
> If that happens the export stops, you still get the file with everything
> that succeeded, and the items it missed are listed inside it.

Use **250** as the threshold — the conservative of the two §4.9 figures. If U1
resolves to 3,600, raise it; the design does not otherwise depend on it.

## 2.F — Select all

`toggleAllForQuery` + `selectionCounts` deliver requirement **F** with **no new
logic**
([bulk-item-search.ts:104-126](../../lib/iap-management/apple/bulk-item-search.ts#L104-L126)):

```
☑ Select all (38 matching)      12 selected of 38 matching · 947 total
                                 + 3 selected items hidden by the current search
```

- "Select all" takes **every row matching the current search/filters**, not the
  rendered window — and un-ticking removes only the matches, so a narrowed
  search cannot silently wipe an off-screen selection
  ([:107-110](../../lib/iap-management/apple/bulk-item-search.ts#L107-L110)).
- The gap is **visible**: `selectedHidden` is rendered, not just computed.
- Below the window: *"Not shown is not excluded — Select all still takes all
  38."*

⚠ `[SA-followup]` still applies: the window is a slice + "Show more", not
virtualisation. Whatever replaces it must keep this invariant.

## 2.G — Items that cannot be exported — **verified, and NOT the same set as A′**

| Row | A′ (availability) | **Export** | Why |
|---|---|---|---|
| Local draft (`apple_iap_id IS NULL`) | excluded | ⚠ **excluded** | Export is defined as *live from Apple* ([route.ts:1-2](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L2)); there is nothing on Apple to read. Shown + disabled + reason. Exporting drafts from local data is a **scope expansion, not in this design.** |
| Apple row with **no local UUID** | excluded (`not_linked`) | ✅ **SELECTABLE — do not copy A′'s exclusion** | A′ needs the internal UUID because its route is keyed on it (`/api/iap-management/iaps/{internalId}/availability`). **The export route never touches the local DB** — it takes `appleIapId` and calls Apple only ([route.ts:60-76](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L60-L76); no `iapDb` import). |
| Read-errored / unread rows | excluded | n/a | Export performs no pre-read, so this bucket cannot exist at pick time. |

⚠ **The middle row is the P8 catch.** The same row is excluded on one surface
and perfectly fine on another, for a real structural reason. Copying A′'s
exclusion table wholesale would silently hide exportable items from the
Manager and be indistinguishable from a bug. **This is why the reason strings
get extracted per surface (2.0) rather than shared.**

⇒ Export's exclusion set is **local drafts only**. The draft hint also needs
its own wording — A′'s *"Create it on Apple first; availability only exists
there"* is availability-specific.

Draft rows still render, disabled, with an `[Edit item]` affordance, per the
Manager lock that hiding them makes people think items vanished
([bulk-item-rows.ts:95-97](../../lib/iap-management/apple/bulk-item-rows.ts#L95-L97)).

## 2.H — Mockup

See **PART 3** (ASCII) and
`docs/iap-management/design/export-item-selection-mockup.html`.

## 2.I — Acceptance: the assertions that can actually fail

⚠ **B8's lesson, third occurrence in this arc.** The primary acceptance is an
**absence**, and it must start at `IapListClient` — not inside the picker:

1. 🎯 **Opening the export wizard issues ZERO `fetch` calls.** The only test
   shape that fails if someone re-adds a pre-read.
2. 🎯 **The export POST body contains exactly the ticked items** — with a
   search applied, then cleared, then "Select all" clicked, asserting the body
   carries all matching items and not the rendered window.
3. **G3 regression:** a 429 on list page 1 produces **4** `iapFetch` calls, not
   16 (`sync-states`; export's site is deleted).
4. **Stop-and-preserve, proved by breaking it:** with 8 targets, 2 workers, and
   a 429 on item 3, assert the untouched items come back `NOT_ATTEMPTED` — and
   verify the test **fails** when the latch is removed. A pool whose worker
   count equals its target count passes trivially and proves nothing (**B5**).
5. **Three states are three sections**, in the file and on screen — merging
   `FAILED` into `NOT_ATTEMPTED` destroys the only safely-resumable bucket.
6. **A stopped run is not styled as a failed run.**
7. **`PARTIAL` rows appear in both sheets**, and a workbook with any
   partial/failed row carries the column-completeness note.

---

# PART 3 — MOCKUP (ASCII)

### Step 1 — Choose items (0 Apple requests)

```
┌─ Export list — choose items ─────────────────────────────────────────── ✕ ─┐
│ Pick the items to export. Nothing is read from Apple until you export.     │
├────────────────────────────────────────────────────────────────────────────┤
│  🔍 [ gem                    ]   Type [ All ▾ ]   Apple status [ All ▾ ]   │
│                                                                            │
│  ⓘ "Apple status" is the review state (Approved, Removed from sale, …),    │
│    not territory availability.        [ + Filter by availability… ]        │
├────────────────────────────────────────────────────────────────────────────┤
│  ☑ Select all (38 matching)        12 selected of 38 matching · 947 total  │  ← sticky
│                                    + 3 selected items hidden by the search │
├────────────────────────────────────────────────────────────────────────────┤
│  ☑  com.vng.gems.60        Gems 60          Consumable      Approved       │
│  ☑  com.vng.gems.300       Gems 300         Consumable      Approved       │
│  ☐  com.vng.gems.980       Gems 980         Consumable      Removed from…  │
│  ▨  com.vng.gems.1980      Gems 1980        Consumable      —              │
│         └ Local draft — not on Apple yet. Nothing to export.  [ Edit item ]│  ← disabled
│  ☐  com.vng.starter.pack   Starter Pack     Non-consumable   Approved      │
│  …                                                            (windowed)   │
│        Not shown is not excluded — Select all still takes all 38.          │
│                                        [ Show 60 more (26 hidden) ]        │
├────────────────────────────────────────────────────────────────────────────┤
│  Export 12 items · about 36 Apple requests                                 │  ← sticky
│                                   [ Cancel ]   [ Next — choose countries ] │
└────────────────────────────────────────────────────────────────────────────┘
```

**Optional availability filter — cost on the control, never absorbed:**

```
├────────────────────────────────────────────────────────────────────────────┤
│  Filter by availability                                                    │
│  ⚠ Not free. Reads current availability from Apple for the 12 items you    │
│    selected — about 12 extra requests. Everything else on this screen is   │
│    already in hand.                                                        │
│         ( ) Available    ( ) Removed from sales    (•) Don't filter        │
│                                              [ Read 12 items and filter ]  │
└────────────────────────────────────────────────────────────────────────────┘
```

**Large selection — caution, never a block:**

```
│  Export 947 items · about 2,841 Apple requests                             │
│  ⚠ Large exports can reach Apple's hourly limit. If that happens the       │
│    export stops, you still get the file with everything that succeeded,    │
│    and the items it missed are listed inside it.                           │
```

### Step 2 — Choose countries (0 Apple requests, existing dialog + Back)

```
┌─ Export options ─────────────────────────────────────────────────────── ✕ ─┐
│ Choose which countries & currencies to include.  (12 items selected)       │
│  … unchanged ExportOptionsDialog — shared with Google, not modified …      │
│                     [ ← Back to items ]  [ Cancel ]  [ Export 61 countries]│
└────────────────────────────────────────────────────────────────────────────┘
```

### Step 3 — Stopped on rate limit

```
┌─ Export stopped ─────────────────────────────────────────────────────── ✕ ─┐
│  ⚠ Apple's rate limit stopped the export after 380 of 400 items.           │
│                                                                            │
│  ▸ 374 items exported                                                      │
│  ▸ 6 items partially exported — prices missing (rate limited)              │
│  ▸ 2 items failed — Apple was asked and refused (reasons in the file)      │
│  ▸ 18 items not attempted — nothing was sent. Safe to export again.        │
│                                                                            │
│  The file has downloaded. Sheet "Not exported" lists all 26.               │
│                              [ Export the 18 not-attempted ]   [ Close ]   │
└────────────────────────────────────────────────────────────────────────────┘
```

⚠ The "Export the 18 not-attempted" button re-enters step 1 with **only those
18 pre-ticked** — safe precisely because `NOT_ATTEMPTED` means nothing was
sent. FAILED items are **not** pre-ticked; a human reads the reason first
(SC3's lock).

---

# PART 4 — OPEN QUESTIONS / UNCERTAIN

| # | Item | What settles it | Blocks? |
|---|---|---|---|
| **U1** | §4.9 still unresolved — 250 vs 3,600/h | `[asc-client] … budget=R/L` lines in Railway (the `user-hour-lim` value) | **No.** Both give the same verdict (G1). It only sets the warning threshold in 2.E. |
| **U2** | Does Apple actually populate `include=inAppPurchaseAvailability` on the list, and does `data[].relationships.inAppPurchaseAvailability.data.id` come through? | One live probe against a real app. **Spec ≠ behavior is this module's crystallized pattern (KB §4.1)** | **No.** Would cut the optional filter's cost from 2/item to 1/item — a refinement, not a dependency. |
| **U3** | Does Apple flip `state` to `*_REMOVED_FROM_SALE` when the territory list empties? | Remove one item from sales via the tool, re-read `state` | **No.** If yes, the **free** Status filter is already an availability proxy and the paid filter (G2 part 2) may never be needed. Worth probing before building it. |
| **U4** | Does the Manager want the paid Available/Removed filter at all, given Type + Apple Status + search are free? | Manager decision | ⚠ **Yes, for that sub-feature only.** Recommend shipping the free filters first and adding the paid one only if asked. |
| **U5** | Should "Select all" on a 1,000-item app be allowed, or capped? | Manager decision | **No.** Design allows it, warns, never blocks — consistent with 2.E. |
| **U6** | Actual N on the app the Manager exports | Manager | **No.** Sharpens 2.B's numbers only. |
| **U7** | Under `PARTIAL`, is a header note enough for column completeness, or should the column union be taken over attempted rows? | Manager preference | **No.** Recommend the header note (2.C) — it cannot invent an empty column. |

---

# PART 5 — WHAT THIS DOES **NOT** TOUCH

| Untouched | Why |
|---|---|
| **Google IAP Management** | Out of scope entirely. |
| **`ExportOptionsDialog`** | ⚠ **SHARED with Google** (G6). Stays a territory picker, unmodified. The item step is a separate component. |
| **Hotfix 26 throttle** (`bulk-import/execute`: concurrency 2 + `INTER_ROW_DELAY_MS = 1000`) | Different flow, deliberately calibrated. Not read, not written. |
| **Hotfix 25 client fetch queue** (`MAX_CONCURRENT = 3`) | Correct for the row cells. The optional availability filter draws slots from it, as A′ already does. |
| **The values Apple returns** | Passed through verbatim — no rounding, no currency conversion, no territory normalisation. |
| **RBAC** | `requireIapSession` unchanged (G6). |
| **Hub tracking** | Export is untracked today; adding it is a separate decision. |
| **`[SC4-debt]` open-reset/filterEpoch** | Explicitly excluded. Do not fold in. |
| **`[SA2-scoped-out]`** — modes 1-2 still pre-read the full list | Manager-scoped, not an oversight. Excluded. |
| **`[SA2-upstream]`** — silent `seedMissingIapStubs` failure | Excluded. ⚠ Note: it does **not** affect export, since export needs no internal UUID (2.G). |
| **`[SA-followup]`** — window is a slice, not virtualisation | Excluded; the invariant it protects is preserved (2.F). |

---

## Implementation order (for the cycle that follows — NOT this one)

Each step independently testable; the first three are correctness fixes worth
shipping ahead of the redesign.

1. **G3 — delete the outer `withRetry` at `sync-states:91`**, with the
   4-not-16 regression test. Standalone commit. (Export's site disappears in
   step 5.)
2. **G1 — wrap the export detail read in exactly one `withRetry`**, so
   "rate limited" means what it means everywhere else in this module.
3. **G4 — stop the silent price degrade**: distinguish "no schedule" from
   "could not read", and add the column-completeness note.
4. **Extract `runStoppablePool`** from `bulk-availability.ts:330-400`; convert
   that orchestrator to it *first* (proving parity), then use it for export.
5. **Route takes `items[]`**; drop `listAllInAppPurchases` from the export path.
6. **Extract `BulkItemPicker`** from the modal's item-list sub-tree; the modal
   renders it (proving parity) before the wizard does.
7. **Wire the wizard** — step 1 → step 2 → export, with the scale line.
8. **Second sheet + headers + the stopped-run summary view.**
9. **Optional availability filter** — only if U3 says `state` is not already a
   proxy, and only if the Manager asks (U4).

⚠ **Test at the layer this arc keeps missing.** At least one test must start at
`IapListClient`, open the wizard, and assert **zero** `fetch` calls
(PART 2.I.1). Every existing export test lives below that layer and none of
them can observe what opening the wizard costs.
