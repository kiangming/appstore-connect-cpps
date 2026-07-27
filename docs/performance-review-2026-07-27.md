# Full Codebase Performance / Dead-Code / Architecture Review — 2026-07-27

**Scope:** all four modules (CPP Manager, Apple IAP Management, Google IAP Management, Store
Management) + shared libs. **Mode:** report only — no code was modified.
**Method:** static trace of the request/render paths on the Manager-named slow surfaces (depth) +
breadth scan of the rest, cross-checked against `supabase/migrations/*` and the deployment config.
Every finding carries a `file:line` anchor, a **counted** cost, and an **ACTUAL** (measurable
server/query/network cost) vs **PERCEIVED** (blocking render, no loading state) label.

> Reviewer's honesty note on confidence: this is a *static* review. It proves **structure** (how
> many round-trips, whether serial or parallel, which predicates lack an index). It does **not**
> prove **magnitude** — that depends on one number I cannot see statically: the Railway↔Supabase
> round-trip time (RTT). The whole diagnosis hinges on it, so it is the first item on the
> Manager-Verify list. Where a finding's severity flips on that number, I say so.

---

## The anchor symptom, restated

Manager reports: *perceived wait on nearly every click, every module; worst on IAP bulk-import and
Store Management (app list, reports); the first click after idle is NOT slower than later ones.*

That last fact is decisive and I take it at face value:

- **Cold start is ruled out.** A Railway container spin-up would make the *first* post-idle click
  visibly worse. "Every click the same" means a **fixed per-request cost paid on every
  navigation**, not a one-time warm-up. I did not spend effort on cold start.
- **There is no single middleware bottleneck.** I looked: **there is no `middleware.ts` anywhere in
  the repo.** Auth is enforced per-page / per-layout, not in a global edge middleware. So the
  "every click" cost is not one shared choke point — it is the *sum of what each destination page's
  server render does before it can paint*.

The fixed per-click cost decomposes into three multiplicative parts:

1. **`force-dynamic` everywhere** — 34 page/layout segments opt out of the Next.js Full Route Cache
   (2 of them are module-level layouts that force the *entire* IAP and Store modules dynamic:
   [store-submissions/layout.tsx:10](app/(dashboard)/store-submissions/layout.tsx#L10),
   [iap-management/layout.tsx:6](app/(dashboard)/iap-management/layout.tsx#L6)). Every navigation is
   a fresh server render — no page is ever served from cache. (This is largely unavoidable for
   authed dashboards that read `cookies()`; it is an *amplifier*, not the root cause.)
2. **N sequential Supabase round-trips per page**, each paying the Railway↔Supabase RTT. **N is the
   lever.** The Manager-named pages pay the *highest* N because of redundant, un-deduped queries
   (Tier-1 findings T1-1, T1-2). This is why "app list / reports" specifically feel worst.
3. **Live external Apple/Google API calls inside server render** on the CPP/IAP surfaces (Tier-1
   T1-4, T1-7), which pay Apple's RTT on top.

**`getServerSession` is NOT part of the cost.** NextAuth is configured `session: { strategy:
"jwt" }` with **no database adapter** ([lib/auth.ts:35](lib/auth.ts#L35)), so session resolution
decodes the signed cookie in-process — zero DB hits, even though it is called 119× across the
codebase. Good. Likewise the ASC-account read is served from a 5-minute in-memory cache
([asc-account-repository.ts:21-32](lib/asc-account-repository.ts#L21-L32)), so `getActiveAccount()`
is usually free after the first request. The per-click DB cost is therefore **not** auth-session or
account resolution — it is the *module whitelist / platform-id / data queries* enumerated below.

---

# TIER 1 — Proven latency causes (ranked by estimated impact)

Impact ranking weighs **how universal** the cost is (every module vs one surface) × **how reducible
it is safely** (a redundant round-trip that can be deduped with request-scoped `cache()` beats an
inherent external-API cost that can't be removed).

---

## T1-1 — Store Management pays the whitelist lookup TWICE + a blocking telemetry WRITE on every navigation  ★ highest-value, lowest-risk

**Classification: ACTUAL.** **Surfaces:** every Store Management page (inbox, app list, reports,
config, follow-up) — i.e. exactly the "Store Management feels slow everywhere" report.

Every Store navigation walks this chain **before** the page's real data loads:

| # | Call | Evidence | Cost |
|---|------|----------|------|
| 1 | Layout resolves the store user | [store-submissions/layout.tsx:22](app/(dashboard)/store-submissions/layout.tsx#L22) `getStoreUser(...)` | 1 DB round-trip |
| 2 | Layout badge query | [layout.tsx:31](app/(dashboard)/store-submissions/layout.tsx#L31) `getDuplicateForwardCount()` | 1 DB round-trip |
| 3 | Page re-resolves the **same** store user | [session-guard.ts:47](lib/store-submissions/session-guard.ts#L47) inside `requireStoreSession` | 1 DB round-trip **(duplicate of #1)** |
| 4 | Page writes login telemetry, **awaited** | [session-guard.ts:52](lib/store-submissions/session-guard.ts#L52) `syncStoreProfile(...)` | 1 DB **WRITE**, blocks render |

- The whitelist lookup runs **twice per navigation** (#1 and #3) — the layout can't hand its result
  to the page in the App Router, and neither memoizes, so it is two identical
  `SELECT ... FROM users WHERE email ILIKE $1 AND status='active'` round-trips.
- #4 `syncStoreProfile` is a `last_login_at`/profile **UPDATE** that is `await`ed on the critical
  render path ([session-guard.ts:52](lib/store-submissions/session-guard.ts#L52)). Its own comment
  says telemetry "must never break login" — but it *does* delay every page.
- The lookup uses `.ilike('email', normalized)`
  ([auth.ts:36](lib/store-submissions/auth.ts#L36)) which **cannot use** the `lower(email)`
  functional index (Postgres only uses that index for `.eq`, i.e. `lower(email)=$1`) → sequential
  scan. Irrelevant at 2-5 users in absolute terms, but it means the round-trip can't be
  index-served either.

**Counted cost:** 3 sequential `store_mgmt` round-trips (2 duplicate reads + 1 blocking write) on
**every** Store navigation, on top of the page's own queries — before first paint.

**Fix shape:** (a) wrap `getStoreUser` in React `cache()` so the layout+page share one lookup
per render; (b) make `syncStoreProfile` fire-and-forget (drop the `await`, or move it out of the
hot path); (c) switch `.ilike` → `.eq('email', normalized)` to hit the functional index.
**Effort:** S (a few lines). **Risk:** low — behavior-preserving; the existing
`auth.test.ts` / guard tests cover the whitelist path.
**Meta-rule (P6):** React `cache()` here is **request-scoped memoization** (dedupe within one render
pass) → **SAFE, does NOT violate P6**. It is not a cross-request/module cache of mutable state.
Explicitly *not* recommending a cross-request user cache (that would violate P6 / the 9ed7845
staleness bug — disabling a user must take effect immediately, which
[session-guard.ts:5-6](lib/store-submissions/session-guard.ts#L5-L6) documents as intentional).

---

## T1-2 — Reports resolves the Apple platform-id 6× per load (and per filter change)  ★ highest-value, lowest-risk

**Classification: ACTUAL.** **Surface:** Store Management → Reports → Apple (a Manager-named surface).

[reports/apple/page.tsx:140-145](app/(dashboard)/store-submissions/reports/apple/page.tsx#L140-L145)
resolves the Apple platform id once, then fires 5 aggregation fetchers in a `Promise.all`
([:147-155](app/(dashboard)/store-submissions/reports/apple/page.tsx#L147-L155)) — **each of which
resolves the same platform id again internally**:

- [reports.ts:844](lib/store-submissions/queries/reports.ts#L844) `getAppleReportsKpis`
- [reports.ts:918](lib/store-submissions/queries/reports.ts#L918) `getAppleTrendByDay`
- [reports.ts:965](lib/store-submissions/queries/reports.ts#L965) `getAppleByAppTable`
- [reports.ts:1033](lib/store-submissions/queries/reports.ts#L1033) `getAppleRecentRejected`
- [reports.ts:1113](lib/store-submissions/queries/reports.ts#L1113) `getAppleRejectReasonBreakdown`

That is **6 identical `SELECT id FROM platforms WHERE key='apple'` round-trips** per reports load —
and again on **every** date-range or type-filter change (the filter uses `router.push` inside
`startTransition`, [ReportsFilters.tsx:33](components/store-submissions/reports/ReportsFilters.tsx#L33),
re-running the whole server render). The page's own comment
([:136-139](app/(dashboard)/store-submissions/reports/apple/page.tsx#L136-L139)) flags this as
"premature optimization avoided per PR-22 lock" — so it is a *known, accepted* redundancy, ripe to
lift now that it's a named slow surface.

**Counted cost:** 6 → 1 platform lookups (5 redundant round-trips removed) per reports load and per
filter change. The 5 aggregation queries themselves are already parallel (good).

**Fix shape:** wrap `getApplePlatformId` in React `cache()`.
**Effort:** S (one wrapper). **Risk:** none — pure dedup. **Meta-rule:** request-scoped `cache()` =
**SAFE per P6**.

---

## T1-3 — IAP bulk-import re-reads the ENTIRE pricing template from Postgres on every row (template sources only)

**Classification: ACTUAL.** **Surface:** Apple IAP bulk-import (the #1 Manager complaint) — but
**only** when the pricing source is `DEFAULT_TEMPLATE` or `APP_TEMPLATE` (not `APPLE`).

The execute route already amortizes Apple price-point fetches across the batch via the Cycle-44
`BatchPricePointCatalog`
([execute/route.ts:503](app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts#L503)). But
the **DB** template load is *not* amortized: `applyPricingSchedule` → `runPricingFlow` calls
`getDefaultTemplate()` / `getAppTemplate()` **once per row**
([pricing-orchestration.ts:264-267](lib/iap-management/apple/pricing-orchestration.ts#L264-L267)),
and each of those does `fetchTemplateHeader` (1 DB) + `fetchEntries` (1 count query +
`ceil(total/1000)` page queries) ([templates.ts:110-140,148-153](lib/iap-management/queries/templates.ts#L110-L153)).

**Counted cost:** for a 16,800-entry template that is **~19 DB round-trips PER ROW**
(1 header + 1 count + 17 pages). A 50-row import on a large template =
**~950 redundant DB round-trips** re-reading the identical template. Scales as
`(import rows) × (template size / 1000)`.

Crucially, this is **NOT** part of the deliberate anti-429 throttle (see the note under T-note-A) —
it is pure Supabase reads, unrelated to Apple's rate limit. Fixing it does not touch the
Hotfix-26 tradeoff.

**Fix shape:** hoist the template load once per batch in the execute route (exactly as the
price-point catalog already does) and thread it into `applyPricingSchedule`, mirroring the
`catalog` argument that's already plumbed. **Effort:** M (thread one more argument through the
pricing orchestrator). **Risk:** medium — touches the shipped pricing path; guarded by
`execute/route.test.ts` + `templates.test.ts` + `pricing-orchestration` tests. **Confidence:** high
(verified the call site and the paginated fetch first-hand). **Impact depends on RTT** — at a
co-located <2 ms RTT this is ~2 s of extra DB time on a 50-row template import; at a cross-region
~80 ms RTT it is **~75 s** of pure serial DB waiting folded into the batch.

---

## T1-4 — CPP sub-nav fires an uncached live Apple `getApp` on every app entry (minor)

**Classification: ACTUAL.** **Surface:** CPP Manager — entering or switching an app under
`/apps/[appId]/*`. **Severity: minor** (see the correction note — this is smaller than a first pass
suggested).

> **Correction (cross-checked against the dead-code import-graph resolution).** An initial
> naive-grep sweep reported this cost as firing **twice** — from both
> `components/layout/SidebarNav.tsx:22` *and* `components/layout/AppSubNav.tsx:23`. That was a
> **false positive**: `SidebarNav.tsx` has **zero importers** — it is a pre-session-16 leftover,
> superseded by the live `components/layout/AppSidebar.tsx` (which does **not** fetch `getApp`), so
> its fetch code never executes. `SidebarNav.tsx` is therefore **dead code** (moved to Tier-2 bucket
> (a)), not a live cost. The real cost fires **once**.

The one live chrome fetch: [AppSubNav.tsx:23](components/layout/AppSubNav.tsx#L23)
`fetch(/api/asc/apps/${appId})` on mount (keyed on `[appId]`), rendered on every non-hub CPP route by
[DashboardContent.tsx:14](app/(dashboard)/DashboardContent.tsx#L14). That route does a **live Apple**
call every time: [api/asc/apps/[appId]/route.ts:11-12](app/api/asc/apps/[appId]/route.ts#L11-L12)
`getActiveAccount()` + `getApp(creds, appId)`.

**Counted cost:** **1 uncached live Apple round-trip** per CPP app entry/switch, purely to render the
app name/icon in the sub-nav — redundant with the app data the destination page already fetches
(T1-7). It fires on `appId` *change*, not on every sub-navigation within an app (the effect dep is
`[appId]` and the component stays mounted across soft nav), so it is **not** an "every click" cost —
hence *minor*.

**Fix shape:** have the sub-nav reuse the app name the page already loaded (pass it down / shared
context) instead of a second client fetch. **Effort:** S. **Risk:** low. **Meta-rule:** a
*client-side* shared value is request-scoped — **SAFE per P6**. Do **not** "fix" this with a
module-level server cache of Apple app metadata (that would be the P6 trap).

**Lesson (methodology):** this is why the dead-code pass used full import-graph resolution rather
than symbol grep — a grep that matches a `fetch(...)` line proves the code *exists*, not that it
*runs*. Treat any "component X does Y" finding as unconfirmed until X is proven to be rendered.

---

## T1-5 — Inbox runs an unindexable full-table regex scan on `email_messages` for MANAGER role, on every load

**Classification: ACTUAL.** **Surface:** Store Management Inbox — **specifically for the Manager**
(the person who filed the report).

The Inbox fetches 7 things in one `Promise.all`
([inbox/page.tsx:88-108](app/(dashboard)/store-submissions/inbox/page.tsx#L88-L108)) — good
parallelism — but for `storeUser.role === 'MANAGER'` it appends `getCorruptPayloadCount()`
([:103](app/(dashboard)/store-submissions/inbox/page.tsx#L103)). That query
([corrupt-payload.ts:39-44](lib/store-submissions/queries/corrupt-payload.ts#L39-L44)):

```
.or("extracted_payload->>app_name.match.<ctrl-byte regex>, raw_body_text.match.<ctrl-byte regex>")
.not('extracted_payload','is',null)
.not('classification_status','in','("DROPPED","DUPLICATE_FORWARD")')
```

has **no time bound** and uses `~` regex matching on a JSONB field and `raw_body_text` — it **cannot
use** any existing index (not `idx_received` — no `received_at` bound; not the `extracted_payload`
GIN index — GIN doesn't serve `->>` regex; no btree applies). Result: **a full sequential scan +
per-row regex over the unbounded `email_messages` table on every Manager Inbox load.** Because it
sits in the `Promise.all`, it sets the *tail* latency — as the table grows (~2,000 emails/month,
retained ~365 days ≈ 24k rows/yr), it becomes the slowest query in the batch and dominates the
Manager's Inbox wait.

The function's own doc comment claims *"The control-byte regex runs over an indexed table scan …
well under the inbox page's TTI budget"* ([corrupt-payload.ts:18-21](lib/store-submissions/queries/corrupt-payload.ts#L18-L21))
— that statement is **factually wrong**; there is no index that can serve it.

**Fix shape:** this is a one-off migration-repair probe (pre-PR-14 decoder bug). Options in order of
preference: (1) bound it with a `received_at >= now()-interval` window so `idx_received` drives it;
(2) precompute a boolean `has_corrupt_payload` column at write time and count that (index-served);
(3) gate the banner behind an explicit "Check for corrupt payloads" button instead of running it on
every load; (4) retire it once the backfill queue is empirically drained. **Effort:** S–M.
**Risk:** low (maintenance banner only — degrades to hidden on error already). **Impact grows over
time** — cheap today, a scan-per-load later.

---

## T1-6 — Missing indexes on the two unbounded tables' report predicates

**Classification: ACTUAL.** **Surfaces:** Reports (reject-reason breakdown + recent-rejected).

Cross-referencing every query predicate against `supabase/migrations/*`, the append-only /
unbounded tables have these uncovered hot predicates:

- **`store_mgmt.ticket_entries` — no index for `entry_type` + `created_at`.** Two report fetchers
  scan it by `entry_type='REJECT_REASON'` and range/sort on `created_at`:
  [reports.ts:1036-1044](lib/store-submissions/queries/reports.ts#L1036-L1044) (`getAppleRecentRejected`)
  and [reports.ts:1130-1141](lib/store-submissions/queries/reports.ts#L1130-L1141)
  (`getAppleRejectReasonBreakdown`). The only `ticket_entries` indexes lead with `ticket_id` or
  `email_message_id`, so neither can serve a global `entry_type=` filter or `created_at` sort →
  full scan + sort. **Table is append-only / unbounded.** Column set that needs an index:
  `(entry_type, created_at)` (or a partial `WHERE entry_type='REJECT_REASON'`).
- **`store_mgmt.tickets` — `platform_id` and `latest_outcome` unindexed (MEDIUM).**
  [reports.ts:864-869](lib/store-submissions/queries/reports.ts#L864-L869) filters
  `platform_id` + `latest_outcome='APPROVED'` + `opened_at` range; `platform_id` only appears as the
  3rd column of `idx_tickets_open_unique` (unusable alone) and `latest_outcome` has **no** index.
  Table is moderate (~200/month), so this is lower priority than the `ticket_entries` gap.

**Already covered (do NOT add — would be wasted migrations):** `email_messages.received_at` (the
730-day range concern — **is** indexed by `idx_..._received`, and every reports email query bounds on
it); `email_messages.ticket_id` (indexed); the `tickets` partial-unique open index; all IAP /
Google-IAP read paths (scoped by `app_id`/`iap_id`/`template_id`, each indexed);
`classification_result->>'outcome'` (extracted in JS, never a SQL predicate). The tiny-table `.ilike`
gaps (`users`, `apps`, `app_aliases`) are cosmetic at current row counts.

**Fix shape:** one forward-only migration adding `(entry_type, created_at)` on `ticket_entries`
(and optionally `platform_id`, `latest_outcome` on `tickets`). **Effort:** S.
**Risk:** low (additive index; forward-only per invariant #7). **Impact depends on `ticket_entries`
row count** — small today, grows.

---

## T1-7 — ~30 of 36 non-trivial routes block fully on server awaits (no `loading.tsx`, no Suspense), several on live Apple calls

**Classification: PERCEIVED** (with an ACTUAL substrate on the Apple-backed ones). **Surfaces:**
most of CPP + IAP + all of Google-IAP + Store config/reports.

Streaming/skeleton coverage exists for only **6** routes: `store-submissions/inbox` +
`inbox/auto-completed` (via [inbox/loading.tsx](app/(dashboard)/store-submissions/inbox/loading.tsx)),
`config/team` (own loading.tsx), and the three that use an internal `<Suspense>` —
[apps/page.tsx:57](app/(dashboard)/apps/page.tsx#L57),
[iap-management/apps/page.tsx:59](app/(dashboard)/iap-management/apps/page.tsx#L59),
[iap-management/apps/[appId]/page.tsx:163](app/(dashboard)/iap-management/apps/[appId]/page.tsx#L163).
There are only **2 `loading.tsx` files** in the whole app.

Every other async page blanks the content area until all its awaits resolve. The worst offenders
(block on a *live external* call with no fallback):

- **IAP bulk-import page** — blocks on a paginated live Apple `listAllInAppPurchases` + `getApp` + 5
  template queries with **no** `loading.tsx` and **no** Suspense
  ([bulk-import/page.tsx](app/(dashboard)/iap-management/apps/[appId]/bulk-import/page.tsx)) — unlike
  its sibling IAP *list* page which is Suspense-wrapped. This is the entry to the #1-complained
  surface: the user clicks "Bulk Import" and stares at a blank area during Apple's round-trip.
- **CPP CPP-detail** — [cpps/[cppId]/page.tsx:18-28](app/(dashboard)/apps/[appId]/cpps/[cppId]/page.tsx#L18-L28)
  does **two sequential** live Apple calls (`getCpp` then `getCppVersionLocalizations`) before paint.
- **CPP CPP-list**, **IAP iap-edit/view/new** (5-8 awaits incl. live `getApp`), **Reports/apple**,
  **config/apps** — all block fully.

**Fix shape:** add a `loading.tsx` skeleton per heavy segment (or wrap the data component in
`<Suspense>` as the three good examples already do). This is a **PERCEIVED** fix — it does not make
anything faster, it makes the wait *feel* instant by painting chrome + skeleton immediately. Cheap
and high-satisfaction. **Effort:** S per route (copy the existing skeleton pattern).
**Risk:** none. Distinguish clearly from the ACTUAL fixes: adding `loading.tsx` to the bulk-import
page does **not** reduce Apple latency (T1-3/T-note-A), it just stops the blank screen.

---

## T1-8 — `recharts` shipped statically into the Reports client bundle

**Classification: ACTUAL** (bundle download + parse on the client). **Surface:** Reports/apple.

[TrendChart.tsx:3-9](components/store-submissions/reports/TrendChart.tsx#L3-L9) statically imports
`recharts` (v3.x, a large charting lib) in a `'use client'` component, so the full library lands in
the `reports/apple` route's initial JS bundle. It is the **only** heavy lib that reaches the browser
— `xlsx` is either server-only (export routes / server libs) or **dynamically** imported on the
client (`const XLSX = await import("xlsx")` in
[parsers/iap-items.ts:167](lib/iap-management/parsers/iap-items.ts#L167),
[parsers/price-tiers.ts:133](lib/iap-management/parsers/price-tiers.ts#L133),
[lib/parseMetadataXlsx.ts:43](lib/parseMetadataXlsx.ts#L43)) — verified good, so the bulk-import
wizard does **not** ship xlsx up front.

**Fix shape:** `const TrendChart = dynamic(() => import(...), { ssr: false })`, or lazy-load the
chart below the KPI cards. **Effort:** S. **Risk:** low. **Impact:** parse/download cost on one
Manager route; modest, listed last in Tier 1.

---

## T-note-A — Why most of the bulk-import wall-clock is NOT a bug (read before "fixing" bulk import)

The Manager's #1 complaint is bulk-import slowness, so it's important to be precise about what is
and isn't reducible. The Apple bulk-import is a **single synchronous server route** that loops over
every row doing real Apple work; there is no progress endpoint
([execute/route.ts:31](app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts#L31) —
*"no polling endpoint in v1"*). Per CREATE row it makes ~`8 + L` Apple calls + up to ~20 poll GETs
(create → localizations loop → price-schedule → screenshot 3-step → availability → submit-eligibility
poll → submit), all sequential within the row.

**But the dominant wall-clock is deliberate, Manager-locked throttling to survive Apple's ~1 req/sec
rate limit (Hotfix 26):**
- `CONCURRENCY_LIMIT = 2` ([execute/route.ts:107](app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts#L107), dropped from 5 after 429 cascades), and
- `INTER_ROW_DELAY_MS = 1000` ([:116](app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts#L116), a mandatory 1 s sleep after each row).

The route's own header states the tradeoff: *"~4-5 min for 50 items vs ~1 min before, in exchange
for surviving Apple's documented 1 req/sec average per token."* **Raising concurrency or removing
the delay would reintroduce the Hotfix-26 429-cascade bug — do not recommend it.** The genuinely
reducible bulk-import costs are the two that are *unrelated* to Apple's rate limit: **T1-3** (the
per-row template DB N+1) and the **PERCEIVED** side — there is no streaming progress, so the user
watches a bare "Importing…" spinner for minutes. A progress/SSE surface (or chunked batches with
per-chunk feedback) would address the *perception* without touching the anti-429 throttle. Both the
per-territory Apple price-point fetch (Cycle-44 catalog) and the lazy per-row availability fetch
(Hotfix 25) are already-implemented amortizations — not defects.

---

# TIER 2 — Dead / redundant code (three buckets)

> Bucket (a) was produced by **full import-graph resolution** (resolving `@/` absolute, relative,
> and `index.ts` barrel imports), not symbol grep — a naive path-grep falsely flags ~90 live core
> files (they're imported relatively) and, conversely, misses that a file containing live-looking
> code is never rendered (this is exactly what happened with `SidebarNav.tsx` — see T1-4's
> correction). Each dead *symbol* below was confirmed by repo-wide `\bname\b` grep returning only its
> definition line. Where I could not prove zero references I say "UNCERTAIN."

### (b) DELIBERATELY RETAINED — do NOT recommend deleting

| Item | Evidence | Why retained |
|---|---|---|
| Legacy `POST /v1/inAppPurchaseSubmissions` submit path | [client.ts:401-415](lib/iap-management/apple/client.ts#L401-L415); gated by [submit-v2-toggle.ts:53,71](lib/iap-management/submit-v2-toggle.ts#L53-L71); branched in [submit-batch/route.ts:15-18](app/api/iap-management/apps/[appId]/iaps/submit-batch/route.ts#L15-L18) | The V2 path is an **opt-in allowlist** (`IAP_SUBMIT_V2_APPS`); legacy "stays live everywhere" as the rollback default ([submit-v2-toggle.ts:12](lib/iap-management/submit-v2-toggle.ts#L12), [submit-v2.ts:9](lib/iap-management/apple/submit-v2.ts#L9)). Rollback safety. |
| `iap_mgmt.price_tier_territories` | Read by [templates.ts:228-231](lib/iap-management/queries/templates.ts#L228-L231) (`listUsdTiers`), used across [territory-catalog.ts](lib/iap-management/territory-catalog.ts), [parsers/iap-items.ts](lib/iap-management/parsers/iap-items.ts), bulk-import execute + page | **Actively read** on the `APPLE` pricing source path *and* retained as the Q-B defensive backup for the legacy USA/USD cache. Not dead. |
| submit-batch server-side hub-tracking tag wrapper | (per KB "coexisting mechanism") — the distinct `LOG_FEATURE` tag comes from a server-side wrapper | Coexisting mechanism kept intentionally so the client- and server-orchestrated tracking tags don't collide. |
| `components/cpp/BulkImportDialog.tsx` (874 lines) **and** `components/cpp/CppBulkImportDialog.tsx` (1558 lines) | `BulkImportDialog` imported by [LocalizationManager.tsx:16,1317](components/cpp/LocalizationManager.tsx#L16); `CppBulkImportDialog` imported by [CppList.tsx:9,753,1035](components/cpp/CppList.tsx#L9) | **Both are LIVE and serve different features** — `BulkImportDialog` = bulk *asset* upload into one CPP; `CppBulkImportDialog` = bulk *creation* of many CPPs. Same-ish name, different jobs (a surface-divergence, not a duplicate). Neither is dead. |

### (a) GENUINELY DEAD / stale — safe to *consider* removing

**Orphan files (zero importers, proven via full import-graph resolution + confirmed first-hand by grep):**

| Path | Lines | Why dead |
|---|---|---|
| [components/layout/SidebarNav.tsx](components/layout/SidebarNav.tsx) | 107 | Pre-session-16 sidebar, superseded by the live `AppSidebar.tsx`; **zero references** (verified). This is the file whose phantom `getApp` fetch produced T1-4's original "twice" false positive. |
| [components/layout/UserFooter.tsx](components/layout/UserFooter.tsx) | 50 | Pre-session-16 user footer, superseded by the TopNav AccountSwitcher; zero references (verified). |
| [components/upload/AssetUploader.tsx](components/upload/AssetUploader.tsx) | 206 | CPP Phase-1 "Asset Uploader" scaffold — never wired into any route (roadmap item still unchecked); uploads go through the bulk-import dialogs. Zero references. |
| [lib/utils.ts](lib/utils.ts) | 7 | shadcn `cn()` scaffolding; **zero** `@/lib/utils` imports repo-wide (verified). |
| [components/ui/shared/index.ts](components/ui/shared/index.ts) | 7 | Unused barrel re-exporting `ExpandableErrorCell` (the component is imported directly; nobody imports the barrel). |
| `CLAUDE.old.md` | ~ | Tracked in git; superseded by `CLAUDE.md`. Stale doc. |

**Dead exported functions inside otherwise-live files** (definition-only; repo-wide grep returns only
the defining line). Some resemble API-client completeness or reserved-for-wiring scaffolding — confirm
none is earmarked for an imminent feature before deleting:

- [lib/asc-client.ts](lib/asc-client.ts) — `createCppVersion`, `createCppLocalization`, `getAppStoreVersions`
- [lib/asc-accounts.ts](lib/asc-accounts.ts) — `getDefaultAscAccount`, `getAscAccountsPublic`
- [lib/store-submissions/auth.ts](lib/store-submissions/auth.ts) — `mapAuthErrorToResponse`, `touchLastLogin` (only `syncStoreProfile` is used by the guard — cross-ref T1-1)
- [lib/iap-management/queries/iaps.ts](lib/iap-management/queries/iaps.ts) — `logSubmitAttempt`
- [lib/iap-management/queries/price-tiers.ts](lib/iap-management/queries/price-tiers.ts) — `getImportSummary`, `listTiersWithTerritories`
- Google-IAP: `clearActiveAccountId` (active-account.ts), `deleteInAppProduct` (publisher-client.ts), `findTemplateTierByUsdMicros` (queries/templates.ts), `upsertAppFromSync` (repository/apps.ts), `getDecryptedCredentials` (repository/google-accounts.ts)

> NOT dead, just over-exported (do NOT remove): `invalidateAccountCache`
> ([asc-account-repository.ts:34](lib/asc-account-repository.ts#L34)) is called internally 4×; and
> ~40 symbols used only within their own file (`GmailSyncError`, `SCREENSHOT_LIMITS`, `AVATAR_COLORS`,
> `GMAIL_SCOPE`, `REGIONS_VERSION`, composed zod sub-schemas, component `*Props` types). These are
> over-export hygiene, not dead code.

### (c) TEST-ONLY — referenced only by `*.test.ts`

- **Test-only file:** [lib/store-submissions/apps/alias-conflicts.ts](lib/store-submissions/apps/alias-conflicts.ts)
  (87 lines) — `detectAliasConflicts` / `AliasConflict` imported only by its own `.test.ts`.
  Production alias handling lives in `alias-logic.ts`. **UNCERTAIN** — confirm whether it was
  superseded (drop candidate) or is a helper that lost its caller.
- **Genuinely test-only convenience wrappers in a live file:** `parseAllowlist` and
  `isV2SubmitEnabled` in [lib/iap-management/submit-v2-toggle.ts](lib/iap-management/submit-v2-toggle.ts)
  — production only calls `v2ToggleDecision`; these two are exercised solely by unit tests.
- **Intentional testability seams (KEEP, not dead):** the `reports.ts` aggregators (`aggregateKpis`
  / `bucketTrendByDay` / `groupByApp` / `dedupBurstByTicket`, exported *"so unit tests can exercise
  them"* per [reports.ts:44-49](lib/store-submissions/queries/reports.ts#L44-L49)), the `__…ForTests`
  reset/inspect helpers (queue, jwt-cache, re2-cache, territory-cache), pure encoders
  (`encodePricePointId`/`decodePricePointId`, `chunkArray`), and the `gmail/__fixtures__/` set.

### Non-source repo clutter (not "dead code", noted for hygiene)

- `dist/` — **221 MB** of local release packages. **Already gitignored** (`.gitignore` has `/dist`;
  0 tracked files) — so it does not bloat the repo/history, it just inflates the working tree. Safe
  to clear locally; no `.gitignore` change needed. *(An earlier note in this report claimed it was
  not gitignored — corrected: my first `grep -E "^dist"` missed the leading `/dist` form.)*
- `coverage/` — 200 KB, **already gitignored** (`/coverage`), 0 tracked. No action needed.
- Tracked small reference material (leave): `mockups/` (144 KB, 1 file), `templates/` (4 KB, 1 CSV),
  `.store-mgmt-patches/` (16 KB, 4 `.md`).

---

# TIER 3 — Architectural debt that does NOT cause latency (explicitly lower priority)

These are correctness/maintainability observations, **not** performance issues. Listed so they're
not confused with Tier 1. None should jump the queue ahead of a Tier-1 fix.

- **`getApp()` (apps.ts) fetches ALL apps then filters in JS for a single-app lookup**
  ([queries/apps.ts:274](lib/store-submissions/queries/apps.ts#L274) — `listApps({}).then(all =>
  all.filter(r => r.id === id))`). It re-runs the full multi-join list query to return one row.
  Currently cheap (few hundred apps) and *not* on a named hot path, so Tier 3 — but it's an
  O(all-apps) pattern for an O(1) need. Would matter if the registry grows.
- **Two `Supabase` client-construction patterns.** IAP / Google-IAP / Store cache a module-singleton
  client ([iap-management/db.ts:24-47](lib/iap-management/db.ts#L24-L47),
  [store-submissions/db.ts:41-63](lib/store-submissions/db.ts#L41-L63)); CPP's
  `createServerSupabaseClient()` makes a fresh client per call
  ([lib/supabase.ts:10-23](lib/supabase.ts#L10-L23)). Client construction is cheap (fetch-based, no
  pool), so this is *not* a latency issue — just an inconsistency worth aligning.
- **`priority_desc` ticket sort is lexicographically wrong** and self-documents a TODO
  ([tickets.ts:273-285](lib/store-submissions/queries/tickets.ts#L273-L285)). Correctness/UX, not
  latency.
- **Layout→page data can't be shared in the App Router**, which is the structural reason T1-1's
  duplicate `getStoreUser` exists. Request-scoped `cache()` is the idiomatic remedy; a broader
  refactor (a per-request context) is Tier 3.
- **Repeated Supabase join-flattening boilerplate** (object-or-array normalization) duplicated across
  `getAppleByAppTable` / `getAppleRecentRejected` / `getAppleRejectReasonBreakdown`
  ([reports.ts:1001-1015, 1069-1084, 1183-1205](lib/store-submissions/queries/reports.ts#L1001-L1015)).
  A shared helper would cut ~60 lines. Maintainability only.

---

# MANAGER-VERIFY LIST — facts only a human with dashboard access can confirm

These are the numbers this static review **cannot** see, ordered by how much they change the
diagnosis.

1. **Railway region ⇄ Supabase region co-location (THE pivotal unknown).**
   Check the Railway service region and the Supabase project region. If they are **not** in the same
   region/continent, every DB round-trip pays 50-150 ms cross-region RTT — and since the slow pages
   make **many sequential** round-trips (T1-1 = 3+, T1-2 = 6, T1-3 = ~19/row), the RTT is multiplied.
   *This single fact decides whether the fix is "dedupe queries" (T1-1/T1-2/T1-3, if RTT is high) or
   "co-locate the regions" (one infra change that shrinks every round-trip at once).* The deployment
   guide only says *"choose the nearest region"* ([deployment-guide.md:97](docs/deployment-guide.md#L97))
   — verify it was actually done for **both** services. **Do this first.**
2. **Supabase plan + whether the connection uses the pooler vs direct.** Free/small plans and a
   cold/undersized pooler add latency to every query. Confirm the plan tier and that the app uses the
   pooled connection string.
3. **Railway plan + instance count.** If >1 web instance is running, note that the in-memory ASC
   account cache ([asc-account-repository.ts](lib/asc-account-repository.ts#L21-L32)) is per-instance
   (relevant to correctness/P6, not latency) — but more importantly confirm the plan isn't
   CPU-throttling the SSR renders.
4. **Row counts on the unbounded tables:** `store_mgmt.email_messages`, `store_mgmt.ticket_entries`,
   `iap_mgmt.actions_log`. These decide the *current* severity of T1-5 (corrupt-payload full scan)
   and T1-6 (missing `ticket_entries` index). If `email_messages` is already tens of thousands of
   rows, T1-5 moves up the ranking.
5. **Largest pricing template entry count** (`iap_mgmt.price_tier_template_entries`). This sets the
   multiplier on T1-3 (~entries/1000 DB round-trips per row). If the largest template is ~16,800
   rows as the code comments suggest, T1-3 is significant on template-source imports.

---

# RECOMMENDED SEQUENCE (highest impact / lowest risk first)

**Step 0 — MEASURE FIRST (before any code change).** The evidence is structurally conclusive but
magnitude-blind. Two cheap moves settle it:
   - Answer Manager-Verify #1 (region co-location). If the regions are split, that is likely the
     single biggest lever and reframes everything below.
   - Mine the instrumentation that already exists: `lib/shared/apple-fetch.ts:239` logs
     `duration=…ms` for **every** Apple call in Railway logs
     ([apple-fetch.ts:239](lib/shared/apple-fetch.ts#L239)); hub-client, gmail-sync and the IAP polls
     also log elapsed ms. Read a few Railway request traces: if Apple `duration=` values are small
     but pages still feel slow, the cost is DB/RTT (→ T1-1/T1-2/T1-6 + region); if Apple durations
     are large, it's external-API latency (→ T1-7 perceived fixes + accept the rest). **Add one
     temporary timing log around the Supabase query waves** in `session-guard`/`reports`/the inbox
     `Promise.all` (there is currently *no* DB-side timing) to get the DB number directly.

**Then, in order:**

1. **T1-1 + T1-2 — request-scoped `cache()` dedup** (`getStoreUser`, `getApplePlatformId`) + make
   `syncStoreProfile` fire-and-forget. *Highest value × lowest risk:* removes 5 round-trips/reports
   load and 2/Store navigation, on the exact pages the Manager named, with behavior-preserving,
   P6-safe changes. Half a day.
2. **T1-6 — add the `(entry_type, created_at)` index on `ticket_entries`** (forward-only migration).
   Trivial, additive, protects the reports surface as data grows.
3. **T1-5 — bound / retire the corrupt-payload probe** (add a `received_at` window or gate it behind
   a button). Removes a growing full-scan from every Manager Inbox load.
4. **T1-7 — add `loading.tsx` skeletons** to the bulk-import page, CPP cpp-detail, IAP edit/view/new,
   reports/apple, config/apps (copy the existing skeleton pattern). Pure PERCEIVED win; makes the
   #1-complained surface *feel* instant even though the underlying work is unchanged.
5. **T1-3 — hoist the bulk-import template load once per batch.** The one real bulk-import ACTUAL
   fix; medium effort, guarded by existing tests. Do this after Step 0 confirms template-source
   imports are common and RTT makes it material.
6. **T1-4 — dedupe the CPP chrome double `getApp`;  T1-8 — `dynamic()` the recharts import.** Small,
   independent polish.

**Explicitly do NOT do:** raise bulk-import concurrency / drop the inter-row delay (reintroduces the
Hotfix-26 429 cascade); add any cross-request/module cache of config or the store-user whitelist
(P6 / 9ed7845 staleness); add indexes to `email_messages.received_at` or the tiny config tables
(already covered / cosmetic).

---

# CONFIDENCE + GAPS

**High confidence (verified first-hand, structural):** no middleware; JWT sessions do no DB; the
5-min ASC-account cache; T1-1 duplicate `getStoreUser` + blocking `syncStoreProfile`; T1-2 6×
platform-id; T1-3 per-row template DB N+1 (read the call site + paginated fetch); T1-4 corrected to a **single**
live `getApp` (AppSubNav only; SidebarNav proven dead via import-graph — the initial "twice" was a
naive-grep false positive); T1-5 unindexable corrupt-payload probe + its wrong self-comment; T1-6 index inventory vs
predicates; the bulk-import concurrency=2 / 1 s-delay throttle; the two bulk-import dialogs both live;
xlsx dynamic-imported; recharts static; no `cache()`/`unstable_cache` anywhere in the codebase.

**Cannot determine statically (needs runtime data):**
- **Absolute latency of any single round-trip** → the Railway↔Supabase RTT (Manager-Verify #1). This
  is the one number that converts every "N round-trips" count into milliseconds. Everything in the
  ranking is robust to its value *except* the relative ordering of T1-3 vs T1-7, which flips on it.
- **Current table row counts** (Manager-Verify #4/#5) → set the *present-day* severity of T1-3/T1-5/T1-6
  (all of which grow with data). Statically I can only say "unbounded and unindexed," not "N ms today."
- **Whether Apple/Google API latency or DB latency dominates a given page** → settled by reading the
  existing `duration=…ms` Apple logs + adding the temporary DB timing in Step 0.
- **The exhaustive genuinely-dead-symbol set** → a `knip`/`ts-prune` run would complete Tier-2 bucket
  (a); the targeted trace here confirmed only the high-signal items.

The static evidence is strong enough to act on Steps 0-2 immediately; Steps 3-6 should be confirmed
against the Step-0 runtime read so effort lands where the milliseconds actually are.
