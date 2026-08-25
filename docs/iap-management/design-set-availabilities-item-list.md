# Investigation + Design — Set Availabilities: measured rate-limit cost + item-list redesign

**Status:** ✅ **IMPLEMENTED** — SA1-SA3, `20aa35e..4b16666`, 2026-08-18, not
pushed. **The investigation and design text below is preserved as written**;
what actually shipped, and where it diverges, is in the as-built appendix at
the end. Where design and appendix disagree, **the appendix is what shipped.**
**Scope:** Apple IAP Management, **surface A only** (the bulk Availabilities
modal). Google module untouched. Bulk Import (surface B) and Edit (surface C)
untouched.
**Picks up:** UAT report — "open Set Availabilities → it scans the whole list
and then shows only the items with no availabilities; the items that ARE
available are filtered out, so there is nothing to pick territories for."

Everything below is measured against the code at `e3d4a9a`, with file:line.
Where a number could not be established from the repo it is marked
**UNCERTAIN** with what would settle it.

---

## PART 0 — TL;DR

| Question | Answer |
|---|---|
| **H1** — does mode 3 fall into set-all's filter branch? | **NO.** `filterEligible` has a real, dedicated `set-territories` branch. This is *not* a D1-shaped bug. |
| Then what did the Manager see? | Two candidates, both real, neither is a mode-3 filter defect: **(1)** they clicked **Set Availabilities** (mode `set-all`), whose designed copy is verbatim the reported symptom; **(2)** the on-open pre-read 429'd and every throttled item was **silently dropped** by the read-error guard, in *any* mode. |
| **H2** — modal-open cost | **2 Apple requests per item**, ×N, unconditional, before Manager picks anything. Not batchable, not cached, ×4 more under 429 retry. |
| N = 500 / N = 1000 | **~1,000 / ~2,000** requests typical; **4,000 / 8,000** worst case. |
| ~~Verdict at 250/h cap~~ ⚠ **OBSOLETE** — 250/h disproven 2026-08-25 (`user-hour-lim` = **3,600**, KB §4.9). Kept because the design was written to hold at *either* figure. | ~~Blown at **~125 items**. N=500 is 4× over, N=1000 is 8× over.~~ |
| Verdict at 3,600/h cap | N=500 survives **one** open (28% of budget); N=1000 is **56%** in one open and fails on the second, or on the first 429 cascade (222%). |
| **Does the cap conflict change the answer?** | **No.** Both scenarios say the same thing at N=500–1000: the pre-read is not viable. **The recommendation does not depend on resolving KB §4.9.** |
| New bug or pre-existing? | **PRE-EXISTING.** Hotfix 25 vintage. `set-territories` added **zero** per-item reads. The Manager's request only made an old cost visible. |
| Cheaper source? | **None exists today.** No local availability column, no batch read, no per-IAP cache. Verified, not assumed. |
| **Recommendation** | **(A′) — drop the on-open pre-read; read state for the SELECTED items at the confirm step.** Selecting 20 of 1000 costs 40 reads instead of 2,000. |
| What that costs | Locked **decision 5** changes in *letter* (the availability filter moves from open-time to confirm-time) but is preserved in *intent*. Locked **decision 1** is preserved and gets **more** accurate. |

---

## PART 1 — H1 VERDICT: **FALSE.** Mode 3 has its own filter branch.

### The evidence

`filterEligible` is at
[AvailabilitiesBulkModal.tsx:1085-1118](../../components/iap-management/AvailabilitiesBulkModal.tsx#L1085-L1118)
(not :724-750 — the file moved under D1/D2). The mode dispatch is three
independent guards, not a binary ternary:

```ts
if (mode === "set-all"  && bucket !== "removed")   continue;   // :1102
if (mode === "remove"   && bucket !== "available") continue;   // :1103
// set-territories: NO bucket restriction — explicit, with a 6-line comment
// citing Manager decision 5 as the reason not to add one.            :1104-1109
```

So mode 3 does **not** inherit set-all's `bucket !== "removed"` test. There is
no else-branch to fall into. **H1 is refuted.**

This is worth stating plainly because the hypothesis was well-formed: D1
(`6795583`) *did* find exactly that shape five lines away — `title`, `subtitle`,
`filterCopy`, `emptyTitle`, `emptySub` were binary ternaries and mode 3 *did*
inherit "Remove from Sales" copy from them. D1 converted those five to a
`switch` ([:689-727](../../components/iap-management/AvailabilitiesBulkModal.tsx#L689-L727)).
`filterEligible` was written correctly from the start (SC6p1, `c17da92`) and
D1 did not need to touch it. **The twin-path instinct was right; this
particular twin was already clean.**

### So what did the Manager actually hit?

Two candidates. I cannot pick between them from the repo alone.

#### Candidate 1 — they clicked the wrong button, because for most of the arc it was the only button (LIKELY)

The reported symptom — *"shows only the items with no availabilities"* — is
**verbatim the designed behaviour of mode `set-all`**:

> `Showing {n} items currently in Remove from Sales. Items already Available
> are filtered out.`
> — [:701](../../components/iap-management/AvailabilitiesBulkModal.tsx#L701)

Three buttons now sit in the toolbar
([IapListClient.tsx:403-440](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L403-L440>)):
**Set Availabilities** → `set-all`, **Choose territories** → `set-territories`,
**Remove from Sales** → `remove`. The Manager's phrasing ("bấm Set
Availabilities") names the first one. Its filter is correct for its purpose and
is doing exactly what decision 5 locked.

⚠ **And "Choose territories" did not exist until `6795583` (D1), committed
2026-08-17 22:25.** SC6 shipped the modal, route, orchestrator and ~60 tests
for `set-territories` with **nothing setting that mode** — recorded in the
design's own as-built appendix
([design-apple-per-territory-availability.md:627-634](design-apple-per-territory-availability.md)).
If the UAT build predates that deploy, the *only* availabilities button the
Manager could reach was mode `set-all`, and the report is not a bug at all —
it is the feature having been unreachable.

**UNCERTAIN.** To settle: (i) which of the three toolbar buttons the Manager
clicked, and (ii) the deployed commit SHA at UAT time (was `6795583` live?).

#### Candidate 2 — the pre-read 429'd and the list silently emptied (REAL, and mode-independent)

This one is a genuine defect and it is invisible by construction.

`filterEligible` drops a row on **three** conditions before any mode logic runs:

| Guard | Line | Drops when |
|---|---|---|
| `if (!appleToInternal[iap.id]) continue;` | [:1094](../../components/iap-management/AvailabilitiesBulkModal.tsx#L1094) | the Apple item has no local UUID (stub seeding failed) |
| `if (errors.has(iap.id)) continue;` | [:1095](../../components/iap-management/AvailabilitiesBulkModal.tsx#L1095) | **the availability read failed — including `rate_limited`** |
| `if (!states.has(iap.id)) continue;` | [:1100](../../components/iap-management/AvailabilitiesBulkModal.tsx#L1100) | defensive partial-fetch guard |

The modal writes `rate_limited` into `errors`
([:315-319](../../components/iap-management/AvailabilitiesBulkModal.tsx#L315-L319)),
so **every item Apple throttled disappears from the list** — in all three
modes — while the copy above the list keeps claiming the items were filtered
out *by availability*. At N=500 under either cap scenario (PART 2), most items
throttle, so the list collapses to a handful or to the empty state, and the
empty state says:

> "All items are currently Available. Nothing to enable — every IAP in this
> app already sells in all territories."
> — [:702-704](../../components/iap-management/AvailabilitiesBulkModal.tsx#L702-L704)

…which is a **false statement of cause**. This is the status principle (KB §9
P5) applied to a filter caption: the copy reports the button's intent, not the
real outcome. The third silent-drop path (`appleToInternal` empty because
`seedMissingIapStubs` failed inside a silent `catch {}` at
[page.tsx:106+:122](<../../app/(dashboard)/iap-management/apps/[appId]/page.tsx#L106-L124>))
produces the same wrong caption from a completely different cause.

**Regardless of which candidate produced the UAT report, candidate 2 is a bug
that must be fixed.** It is the reason a Manager cannot tell "nothing to do"
apart from "I could not read anything."

### Minimum fix if H1 had been true — and why it would not have been enough

Moot (H1 is false), but the question deserves the direct answer the brief
asked for: **even if `filterEligible` had had the binary-ternary defect, fixing
it would not have met the Manager's request.** Mode 3 would still:

1. pre-read all N items on open (PART 2 — the actual blocker),
2. silently drop every read-errored item (candidate 2),
3. never show local drafts at all (they are not passed to the modal — PART 4.3).

**PART 3 is required either way.**

---

## PART 2 — H2: MEASURED COST

### (a) Does the pre-read cover the whole list, or only visible/selected items?

**The whole filtered list. Not the page. Not the selection.**

- The modal receives `iaps={filtered}` —
  [IapListClient.tsx:827](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L827>),
  with the comment at :821-823 stating it deliberately: *"Operates on the full
  filtered table set (not paginated)."*
- `filtered` is search + type + state filtered, **pre-pagination**
  ([:163-179](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L163-L179>)).
  The table renders `paginated` (`PAGE_SIZE = 100`,
  [:40](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L40>));
  the modal gets the un-paginated set.
- The pre-read effect maps over every one of them —
  [:282-347](../../components/iap-management/AvailabilitiesBulkModal.tsx#L282-L347):
  `const targets = iaps.map(...).filter(has internalId)`. No slice, no cap, no
  selection input. **Selection happens after the read, and cannot reduce it.**

So for an app with 1,000 IAPs and no search filter, opening the modal reads
1,000 items before the Manager has clicked anything.

### (b) Exact Apple requests per item

`getAvailabilityForIap`
([availabilities.ts:230-273](../../lib/iap-management/apple/availabilities.ts#L230-L273)):

| Step | Request | Count |
|---|---|---|
| A | `GET /v2/inAppPurchases/{id}/inAppPurchaseAvailability` | 1, always |
| A → 404 | returns `null` early ([:243](../../lib/iap-management/apple/availabilities.ts#L243)) | **total 1** |
| B | `GET /v1/inAppPurchaseAvailabilities/{availId}/availableTerritories?limit=200` | 1 per page; ~175 territories ⇒ **1 page** |

⇒ **1 request** for an item Apple has no availability resource for, **2** for
every item that has one. SC5 §G2's "2 Apple calls" is **confirmed** as the
normal case.

**⚠ The retry multiplier is the number §G2 did not carry.** The route wraps the
*whole* function in `withRetry`
([route.ts:100](<../../app/api/iap-management/iaps/[iapId]/availability/route.ts#L100>)),
whose backoff is `[500, 1000, 2000]` ⇒ **4 attempts**
([apple-fetch.ts:101-131](../../lib/shared/apple-fetch.ts#L101-L131)). A 429 on
Step B **restarts Step A** (the design already flagged this at §G2 as "a
non-issue today" — it is not a non-issue at N=500). **Worst case per item =
4 × 2 = 8 requests.**

**Batchable? NO.** Neither `/v1/inAppPurchaseAvailabilities` nor the V2
relationship accepts a `filter[]` over multiple IAP ids; there is no multi-IAP
availability read in the OAS. Verified in the arc
(design §G2) and unchanged. Cost is strictly linear.

**Cached? NO.** The route is called with `cache: "no-store"`
([:311](../../components/iap-management/AvailabilitiesBulkModal.tsx#L311))
and there is no server-side memo for per-IAP availability. The only memo in
this file is the **territory catalogue**
([availabilities.ts:80-93](../../lib/iap-management/apple/availabilities.ts#L80-L93),
1 h TTL) — a different resource.

⚠ **The row cells and the modal duplicate each other.** `AvailabilityCell`
([AvailabilityCell.tsx:71-107](../../components/iap-management/AvailabilityCell.tsx#L71-L107))
hits the same route for every visible row via IntersectionObserver. Opening the
modal **re-reads every item the cells already read**, because nothing is
shared. On a scrolled page of 100 rows that is ~200 requests paid twice.

### (c) Other Apple calls involved

**On modal open:**

| Call | Count | Where |
|---|---|---|
| Per-item availability | **N × (1–2)**, ×4 under retry | :282-347 |
| Territory catalogue (**mode 3 only**) | **0 or 1** — memoised 1 h per process | [:362-395](../../components/iap-management/AvailabilitiesBulkModal.tsx#L362-L395) → [route](../../app/api/iap-management/territories/route.ts) → [availabilities.ts:81-93](../../lib/iap-management/apple/availabilities.ts#L81-L93) |
| Anything else | **0** — no list re-read, no state sync | — |

⇒ **Total modal-open ≈ N × 2. The territory catalogue is noise (≤1, usually 0).
`set-territories` adds essentially nothing.**

**Already spent on the page render, in the same hourly window:**

| Call | Count |
|---|---|
| `getApp` | 1 |
| `listAllInAppPurchases` — `?limit=200`, follows `links.next` ([client.ts:60-77](../../lib/iap-management/apple/client.ts#L60-L77)) | `ceil(N/200)` = 3 @ N=500, 5 @ N=1000 |
| `AvailabilityCell` per visible row (≤ `PAGE_SIZE` 100) | up to **200** if the Manager scrolls the page |

### (d) N = 500 and N = 1000, against **both** cap scenarios

**Modal-open requests:**

| N | Floor (all 404) | **Typical (2/item)** | 429 ceiling (×4) |
|---|---|---|---|
| 500 | 500 | **1,000** | 4,000 |
| 1000 | 1,000 | **2,000** | 8,000 |

Add per page visit: ~204 (N=500) / ~206 (N=1000) if the Manager scrolled a full
page before opening the modal.

**Scenario 1 — cap = 250/hour (Hotfix 25's figure).** ⚠ **This scenario is
now known not to exist** — measured 2026-08-25, `user-hour-lim` = **3,600**
(KB §4.9). The table is kept, struck through, because the design's conclusion
was explicitly built to hold under *both* scenarios and the surviving one
(Scenario 2) is what governs. Do not carry these numbers into new work.

| N | Typical cost | % of budget | Breaks at item # |
|---|---|---|---|
| ~~500~~ | ~~1,000~~ | ~~**400%**~~ | ~~~125~~ |
| ~~1000~~ | ~~2,000~~ | ~~**800%**~~ | ~~~125~~ |

*(Everything from here to "Scenario 2" describes the disproven 250/h world.)*

~~The modal exhausts the hour's entire budget at **~125 items** and cannot finish
either list. Counting the page-load overhead the effective headroom is **~23
items**.~~ Beyond that every remaining item returns `rate_limited`, lands in
`errors`, and is **silently dropped from the list** (PART 1, candidate 2).
**Under this cap the reported symptom is fully explained by the pre-read
alone.**

**Scenario 2 — cap = 3,600/hour (Hotfix 26's figure).** ✅ **This is the real
cap** — measured 2026-08-25 (KB §4.9). Everything below governs.

| N | Typical cost | % of budget | Verdict |
|---|---|---|---|
| 500 | 1,000 | **28%** | one open survives; **3 opens/hour exhausts it** |
| 1000 | 2,000 | **56%** | one open survives; **a second open in the same hour blows it** |
| 1000 | 8,000 (429 ceiling) | **222%** | a single open cannot complete |

A Manager doing normal work — open the modal, change their mind about the
search filter, reopen — hits the wall on the second or third open. And once
the budget runs low, `withRetry` spends **3 extra requests per item** on
backoff, so exhaustion accelerates itself. The "typical" column is the
optimistic one.

**⚠ Burst rate, separately from volume.** The client queue caps *parallelism*
at 3 ([client-fetch-queue.ts:25](../../lib/iap-management/client-fetch-queue.ts#L25)),
not volume. 1,000 requests at concurrency 3 and ~250 ms each complete in ~83
seconds — a sustained **~12 req/s**. Against the **measured** ~1 req/s figure
(3,600/h, confirmed 2026-08-25) that is **12× the sustainable rate**. (The
~170× figure previously quoted here came from the 250/h scenario, since
disproven — the real multiple is 12×, and it is still the point.)
The queue's own comment says what it was sized for: *"the client fires whenever
IntersectionObserver detects visibility, which can spike on fast scrolls of
long lists"* ([:8-16](../../lib/iap-management/client-fetch-queue.ts#L8-L16)).
**It was designed to smooth a 100-row scroll, never to pace a 1,000-item
sweep.** Concurrency 3 does not make this safe and lowering it would not
either — it would only make the modal slower while spending the same budget.

> **⇒ CONCLUSION.** At N=500–1000 the on-open pre-read is not viable.
> ✅ **§4.9 has since been resolved: the cap is 3,600/h** (measured
> 2026-08-25). Under that figure the pre-read survives the first open and
> fails on the second, or on the first 429 cascade — which is the branch that
> governs. The now-disproven 250/h branch would have failed outright.
> **The design did not need the cap resolved, and the resolution did not
> change its verdict** — exactly as claimed here. The cap only ever changed
> *how bad*, never *whether*.

### (e) NEW bug, or PRE-EXISTING and newly exposed? — **PRE-EXISTING**

**Pre-existing. Hotfix 25 vintage. The territories feature added zero per-item
reads.**

- The pre-read loop was introduced by **Hotfix 25**'s Strategy A→D pivot, for
  the two original modes — the modal's own header says so
  ([:6-12](../../components/iap-management/AvailabilitiesBulkModal.tsx#L6-L12)).
- The modal has **always** received the full un-paginated `filtered` set
  ([IapListClient.tsx:827](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L827>)).
- `set-territories` added **one** new fetch and it is not per-item: the
  territory catalogue, 0–1 requests, memoised 1 h. `filterEligible`'s mode-3
  branch adds no read at all — its comment says explicitly that decision 5 was
  kept *precisely to avoid adding one* ([:1104-1109](../../components/iap-management/AvailabilitiesBulkModal.tsx#L1104-L1109)).

**What the arc got wrong is subtler and worth recording.** Design §G2 concluded
*"on 2 of 3 surfaces the cost is ALREADY PAID… ⇒ Prefer the existing reads. Add
none."* That claim is **true** — and it silently converted *"no new cost"* into
*"affordable cost"* without ever measuring the existing one. The existing read
had only been exercised on small catalogues. Requirement "show all items" did
not create the cost; it removed the last reason not to look at it.

> **Meta-rule candidate for KB §9 (P19):** *inheriting an existing cost is not
> the same as validating it.* When a design's gate concludes "the read already
> happens, so this is free," it must state the N at which that read was
> observed, and re-check the cost at the new feature's N. §G2 named the
> mechanism and the per-item price and still did not multiply by N.

### (f) Is there a cheaper source? — **NO. Verified, not assumed.**

| Candidate | Verdict | Evidence |
|---|---|---|
| Local availability column on `iap_mgmt.iaps` | **Does not exist** | Table def [20260515000000:82-102](../../supabase/migrations/20260515000000_iap_mgmt_init.sql#L82-L102): `id, apple_iap_id, app_id, product_id, reference_name, type, state, base_territory, tier_id, family_sharable, review_note, synced_at, created_at, updated_at`. Every later `ALTER TABLE iap_mgmt.iaps` adds only `pricing_source` ([20260520000000:24](../../supabase/migrations/20260520000000_iap_mgmt_p1j_hotfix.sql#L24)) and three `custom_prices_baseline_*` columns ([20260812000000:94-96](../../supabase/migrations/20260812000000_iap_mgmt_custom_prices.sql#L94-L96)). **None is availability.** |
| `sync-states` | **Syncs `state`, not availability** | unchanged since SC5's finding |
| Any per-IAP cache | **None** | route is `no-store`; no server memo; modal and row cells duplicate each other |
| Batch/filter read | **Not offered by Apple** | no `filter[]` on either endpoint |
| Territory catalogue cache | **Exists**, but is a different resource | [availabilities.ts:80-93](../../lib/iap-management/apple/availabilities.ts#L80-L93) |
| `20260817000000_iap_mgmt_actions_log_set_territories.sql` | **Audit log, not state** | records what a run *sent*, per-run; not a queryable current-state mirror |

**SC5's conclusion holds unchanged after the arc.** A local mirror column
*could* be built — see PART 3, option (C) — but it is not available today and
I am not recommending it (P6: no cache on a cold path beats a stale
multi-instance cache).

---

## PART 3 — RECOMMENDATION

### ✅ Recommended: **(A′) — no pre-read. Read the SELECTED items at the confirm step.**

This is option (A) from the brief, with the read moved rather than deleted, so
decision 1's warning survives.

**Five phases, with their Apple cost:**

| Phase | Apple requests |
|---|---|
| 0 — modal opens; full list renders immediately | **0** (modes 1–2) · **0–1** (mode 3 catalogue, usually cached) |
| 1 — Manager searches / filters / selects | **0** |
| 2 — Manager clicks the action → **read phase over the SELECTED items only**, progress UI, concurrency 3, `withRetry`, **stop on rate-limit exhaustion** | **2 × K** |
| 3 — confirm dialog: `willChange` / `alreadyMatches` / `unknownExcluded` + base-territory advisory | **0** |
| 4 — write | 1 POST per selected item (unchanged) |

**The number that matters:** selecting 20 items out of 1,000 costs **40 reads**
instead of **2,000**. The cost becomes proportional to the Manager's intent
instead of to the catalogue's size.

**Honest limit:** if the Manager selects all 1,000, phase 2 costs 2,000 reads —
the same as today. **A′ does not make a full-catalogue sweep cheap; it makes it
*chosen*.** That is the right shape: the Manager pays for what they asked for,
sees a progress bar for exactly that set, and phase 2 inherits decision 3's
stop-and-preserve so the budget is never burned discovering the same 429 five
hundred times.

**Why phase 2 must extend decision 3 (stop and preserve) to the READ:** today
decision 3 governs the write loop only
([bulk-availability.ts:33-47](../../lib/iap-management/orchestrators/bulk-availability.ts#L33-L47)).
Under A′ the read is the first place a 429 cascade can start. On exhaustion:
stop reading, keep what was read, and tell the Manager **"read stopped after X
of K — Apple throttled. Continue with the X we read, or retry the rest."**
Never silently drop — that is candidate 2's bug, and moving the read must not
move the bug with it.

### Effect on the two locked decisions — stated plainly

#### ⚠ Decision 5 — *"surface A KEEPS the existing availability mode filter."* → **changes in letter, preserved in intent.**

The filter moves from **open-time** to **confirm-time**. Concretely:

| | Today | Under A′ |
|---|---|---|
| `set-all` | list shows only currently-Removed items | list shows all items; already-Available ones land in the confirm dialog's **"already matches — no change"** bucket |
| `remove` | list shows only currently-Available items | list shows all items; already-Removed ones land in **"already matches"** |
| `set-territories` | no filter (already) | no filter (unchanged) |

**Why this trade is right:**

1. **Decision 5's purpose is preserved.** The Manager still never writes a
   no-op unknowingly, and still never acts blind on an item whose state could
   not be read. The guarantee is delivered by the confirm dialog instead of by
   the list — and the confirm dialog is where the Manager is actually deciding.
2. **Decision 5 currently costs 2N requests to enforce, and the enforcement
   silently fails at scale.** Under either cap scenario at N=500, the filter
   does not merely get expensive — it produces a *wrong* list (throttled items
   dropped) with a *wrong* caption. **A filter that lies is worse than no
   filter.**
3. **Mode 3 loses nothing.** It has no bucket filter today, by decision 5's own
   reasoning ([:1104-1109](../../components/iap-management/AvailabilitiesBulkModal.tsx#L1104-L1109)).
   Decision 5 constrains modes 1 and 2; mode 3 was never inside it.
4. **The machinery already exists.** `buildConfirmBuckets` +
   `diffSelection` already compute exactly `willChange` / `alreadyMatches` /
   `unknownExcluded`
   ([bulk-availability-view.ts:137-169](../../lib/iap-management/apple/bulk-availability-view.ts#L137-L169)).
   Modes 1 and 2 need the same buckets computed from a preset selection, not
   new logic.

**This is the one locked decision this design asks to change. It needs
Manager sign-off before implementation.** If the Manager wants decision 5
untouched in letter, take fallback **(B′)** below and accept its cost.

#### ✅ Decision 1 — *"a warning names the items whose availability actually changes"* → **preserved, and improved.**

Confirmed still correct under A′, and better than today on both axes:

- **Coverage** — the warning is computed over exactly the set about to be
  written (`selectedEligible` → `buildConfirmBuckets`). Reading only the
  selection does not narrow the warning; the warning was never about unselected
  items.
- **Freshness** — today the read happens at modal-open and the write can be
  minutes later (design §G2 admits the window: *"modal open → submit — seconds
  to minutes"*). Under A′ the read happens **seconds before** the write, in the
  same click. **The staleness window shrinks.**
- **Honesty** — items whose read failed still surface as `unknownExcluded`
  ([:163](../../lib/iap-management/apple/bulk-availability-view.ts#L163)),
  named rather than hidden — which is what §G2 demanded and what candidate 2
  currently violates.

**One deliberate non-change:** the write still POSTs **every selected item**,
including `alreadyMatches` ([:545-549](../../components/iap-management/AvailabilitiesBulkModal.tsx#L545-L549)).
It is tempting to skip the no-ops and save K−|willChange| POSTs. **Do not.**
Decision 1 is REPLACE semantics — *"every targeted item ends with exactly the
chosen set."* Skipping on the basis of a read that could be seconds stale would
let a drifted item silently keep the wrong territories. **Pay the POST; keep
the guarantee.**

### ❌ Rejected: (B) paginate the pre-read

**As a rate-limit fix, this does not work, and it adds a silent-under-selection
trap.**

- Pre-reading 50 per page × 2 = 100 requests **per page flip**. A Manager
  browsing 10 pages of a 500-item catalogue pays the same ~1,000 requests,
  just spread out — and pays them *again* on every re-visit, since nothing is
  cached.
- Mode filtering "within the page" means **"Select all" selects only the
  current page.** A Manager who intends all 500 and sees "Select all" gets 50,
  with nothing saying so. That is the same class of defect as candidate 2:
  a control whose label overstates what it did.

**Pagination is the right answer to a different question.** Use it for the
*render* problem (requirement 4, PART 4.4) — never as the API fix.

### ❌ Rejected as primary: (C) local availability mirror column

Would make the read free, and is the only option that makes a full 1,000-item
sweep cheap. Rejected for now:

- It is a **cache on a cold path across replicas** — P6 says no cache beats a
  stale multi-instance cache, and availability is writable from Apple Connect
  web, which this tool would never see.
- Backfilling it costs the same 2N reads once, plus a write-through on all four
  emitters (`availabilities.ts:104-118` names them) plus a reconciliation job.
- It re-introduces the exact staleness that decision 1's warning exists to
  avoid.

**Keep on the backlog** as `IAP.p3+` if the Manager ever asks for an
availability *column* that renders instantly on the list page — that is the use
case a mirror actually serves. It is not the fix for this modal.

---

## PART 4 — THE NEW ITEM LIST

### 4.1 — Requirement 1: show ALL items, no availability filter ✅

Falls out of A′ for free: **with no pre-read there is no state to filter on.**
The modal's list becomes the table's `filtered` set verbatim.

Copy must change with it — today's caption claims a filter that no longer runs:

| Mode | New caption |
|---|---|
| `set-all` | `Showing {n} items. Items already available everywhere are skipped at the confirm step, not hidden here.` |
| `remove` | `Showing {n} items. Items already removed from sales are skipped at the confirm step, not hidden here.` |
| `set-territories` | `Showing {n} items. Pick the ones to change, then choose territories.` |

⚠ **No caption may claim a reason the code did not apply.** That is the rule
candidate 2 broke.

### 4.2 — Requirement 2: select all / select a subset ✅

**"Select all" must mean every item matching the current in-modal search, not
just the rendered window.** With windowed rendering (4.4) the two diverge, and
the divergence must never be silent.

- Header: `Select all (N matching)` where N is the full match count.
- Counter: `K selected of N matching · M total in this app`.
- Selection is a `Set<appleIapId>` that **persists across search changes** —
  typing a new query must not silently drop items already ticked. Show
  `K selected (J not shown by this search)` when they diverge.

### 4.3 — Requirement 3: DRAFT items shown but DISABLED, with a visible reason ✅

**How "not synced" is determined — cited:**

> **`apple_iap_id IS NULL`.** That is the definition, used in three places:
> - `listDraftIaps` — [queries/iaps.ts:325-335](../../lib/iap-management/queries/iaps.ts#L325-L335), `.is("apple_iap_id", null)`
> - the partial index — [20260515000000:106](../../supabase/migrations/20260515000000_iap_mgmt_init.sql#L106), `WHERE apple_iap_id IS NULL`
> - the availability route's 409 — [route.ts:86-89](<../../app/api/iap-management/iaps/[iapId]/availability/route.ts#L86-L89>), `error: "not_synced"`
>
> ⚠ **`existsOnApple_validated` does not exist — CONFIRMED, and it is phantom
> field #2 in this module.** Repo-wide, case-insensitive: **0 hits** outside
> `docs/`. No migration defines it; no code reads or writes it; even its enum
> values (`NEVER_SYNCED`) appear nowhere. The KB described it as a tri-state
> column on `iap_mgmt.iaps` in three places; all three are now corrected and
> the finding is recorded as **KB §4.15**, alongside §4.13's
> `availableInAllTerritories`. Apple's marker is `apple_iap_id IS NULL`.

**⚠ The blocker: drafts are not passed to the modal at all.**
[page.tsx:110](<../../app/(dashboard)/iap-management/apps/[appId]/page.tsx#L110>)
loads `drafts` separately from `iaps`; `IapListClient` renders them in their own
amber "Local Drafts" section
([:510-561](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L510-L561>))
and passes only `iaps={filtered}` to the modal
([:827](<../../app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx#L827>)).
**Today a draft is not "filtered out" of the modal — it was never in it.**

⇒ Implementation must thread `drafts={drafts}` into the modal as a new prop and
merge them into one list with a per-row `disabledReason`.

**Two disabled classes, two different reasons — do not collapse them:**

| Class | Test | Row reason (visible) | Fix affordance |
|---|---|---|---|
| **Local draft** | in `drafts` (`apple_iap_id IS NULL`) | `Local draft — not on Apple yet` | link to the item's Edit page |
| **Not linked locally** | Apple item with no `appleToInternal[id]` — [:1094](../../components/iap-management/AvailabilitiesBulkModal.tsx#L1094) | `Not linked locally — run Refresh from Apple` | point at the toolbar's Refresh button |

The second class is dropped **invisibly** today, and it has a plausible cause:
`seedMissingIapStubs` runs inside a silent `catch {}`
([page.tsx:106+:122](<../../app/(dashboard)/iap-management/apps/[appId]/page.tsx#L106-L124>)),
so a seeding failure empties `appleToInternal` and the modal shows **zero
items** while blaming availability. **Showing the row with its real reason is
the fix; hiding it is the bug.**

Disabled rows: checkbox `disabled`, row at ~60% opacity, reason chip on the
right, **excluded from "Select all"** and from the N-matching count used by the
selection counter — but **still rendered and still counted in "M total"**, so
the Manager can see nothing vanished.

### 4.4 — Requirement 4: rendering 500–1000 rows

Today the modal renders **every** eligible row in one `<ul>` with no windowing
([:883-905](../../components/iap-management/AvailabilitiesBulkModal.tsx#L883-L905)),
inside a `w-[560px] max-h-[80vh]` shell — and in mode 3 the ~175-territory
picker sits above it in the same scroll container. At 1,000 rows that is ~1,000
controlled checkbox inputs re-rendering on every tick.

**Proposal — independent of the API fix:**

1. **In-modal search** on productId + reference name (debounced), plus the
   type/state chips the table already offers. This is the primary tool: a
   Manager working on "all the gem packs" filters to 40 rows and never scrolls.
2. **Windowed rendering** (~60 rows + overscan) rather than internal
   pagination. Pagination re-introduces the "Select all = this page?" ambiguity
   from option (B); a window does not, because the selection model is already
   "all matching."
3. **Widen the modal** to `max-w-[820px]` and give the mode-3 territory picker
   its own collapsed summary row (`Territories: 42 of 175 selected · Edit`)
   so the picker and the item list stop competing for one 80vh scroll.
4. **Sticky header + sticky footer** so `Select all`, the counter, and the
   action button never scroll out of reach in a 1,000-row list.

### 4.5 — Mockup

```
┌─ Choose territories ─────────────────────────────────────────────────── ✕ ─┐
│ Pick exactly where the selected items sell. Every item receives the same   │
│ set.                                                                       │
├────────────────────────────────────────────────────────────────────────────┤
│  Territories:  42 of 175 selected  ·  + future markets: OFF     [ Edit ▾ ] │  ← collapsed
├────────────────────────────────────────────────────────────────────────────┤
│  🔍 [ gem                             ]   Type [ All ▾ ]  State [ All ▾ ]  │
│                                                                            │
│  Showing 38 items. Pick the ones to change, then choose territories.        │
├────────────────────────────────────────────────────────────────────────────┤
│  ☑ Select all (38 matching)          12 selected of 38 matching · 947 total │  ← sticky
├────────────────────────────────────────────────────────────────────────────┤
│  ☑  com.vng.gems.60          Gems 60              Consumable               │
│  ☑  com.vng.gems.300         Gems 300             Consumable               │
│  ☐  com.vng.gems.980         Gems 980             Consumable               │
│  ▨  com.vng.gems.1980        Gems 1980            Consumable               │
│         └ Local draft — not on Apple yet                    [ Edit item ]  │  ← disabled
│  ▨  com.vng.gems.6480        Gems 6480            Consumable               │
│         └ Not linked locally — run Refresh from Apple                      │  ← disabled
│  ☐  com.vng.starter.pack     Starter Pack         Non-consumable           │
│  …                                                            (windowed)   │
├────────────────────────────────────────────────────────────────────────────┤
│  ⓘ Current availability is read for the 12 selected items when you        │  ← sticky
│    continue — not for all 947.                                             │
│                              [ Cancel ]   [ Continue — read 12 items ]     │
└────────────────────────────────────────────────────────────────────────────┘

   ↓ "Continue" — PHASE 2, the only place Apple is read

┌─ Reading current availability ───────────────────────────────────────── ✕ ─┐
│  ⟳  9 / 12  (75%)  ·  concurrency 3                                        │
│  ████████████████████░░░░░░░                                               │
│  Reading only the items you selected. 935 unselected items are not read.   │
└────────────────────────────────────────────────────────────────────────────┘

   ↓ reads complete (or stop on rate limit)

┌─ Confirm — replace availability for 12 items ────────────────────────── ✕ ─┐
│                                                                            │
│  ⚠ This REPLACES each item's territories with the 42 you chose.            │
│                                                                            │
│  ▸ 9 items will change                                                     │
│      com.vng.gems.60      175 → 42   (−133)                                │
│      com.vng.gems.300     175 → 42   (−133)                                │
│      com.vng.starter.pack   0 → 42   (+42)                                 │
│      … 6 more                                                              │
│                                                                            │
│  ▸ 2 items already match — no change will be written to their territories, │
│    but the replace is still sent so the result is exact.                   │
│                                                                            │
│  ▸ 1 item could not be read — EXCLUDED, nothing will be sent               │
│      com.vng.gems.980   ·  Apple rate-limited the read       [ Retry ]     │
│                                                                            │
│  ⓘ 3 of these items price from a base territory outside your selection     │
│    (VNM: 2, JPN: 1). This action changes availability only — it does not   │
│    touch prices.                                                           │
│                                                                            │
│                          [ Back ]   [ Set territories for 11 items ]       │
└────────────────────────────────────────────────────────────────────────────┘
```

**Rate-limit stop during phase 2 (decision 3, extended to the read):**

```
┌─ Reading stopped ────────────────────────────────────────────────────── ✕ ─┐
│  ⚠ Apple throttled the read after 7 of 12 items.                           │
│    Nothing has been written. 5 items were not read.                        │
│    [ Continue with the 7 we read ]   [ Retry the remaining 5 ]  [ Cancel ] │
└────────────────────────────────────────────────────────────────────────────┘
```

### 4.6 — Modes 1 and 2 keep their identity

Requirement 5 is honoured: **three modes stay three modes.**

| | `set-all` | `remove` | `set-territories` |
|---|---|---|---|
| Meaning | available in ALL territories + future markets | removed from sales everywhere | exactly this set |
| Territory picker | none | none | yes |
| Selection sent | `allTerritoriesSelection(catalogue)` | `noTerritoriesSelection()` | Manager's picker |
| Destructive chrome | no | **yes** — red, reconfirm | no |
| List filter | **moves to confirm** | **moves to confirm** | none (unchanged) |

The only shared change is *when* the availability read happens. Nothing merges.

---

## PART 5 — WHAT THIS DOES **NOT** TOUCH

Stated explicitly because the brief asked:

| Untouched | Why |
|---|---|
| **Hotfix 25 client fetch queue** (`MAX_CONCURRENT = 3`) | still correct for the row cells' scroll-spike case, which is what it was built for. A′ removes the caller that misused it; the queue itself is fine. |
| **Hotfix 26 throttle** (`bulk-import/execute`: concurrency 2 + `INTER_ROW_DELAY_MS = 1000`) | different module, different flow, deliberately calibrated. Not read, not written by this design. |
| **`bulk-availability` orchestrator** (`DEFAULT_CONCURRENCY = 2`) | the **write** path is not the problem. Unchanged. |
| **The single write path** (`setAvailabilityTerritories`, [availabilities.ts:126-152](../../lib/iap-management/apple/availabilities.ts#L126-L152)) | unchanged. Still the only emitter. |
| **Territory ids** | passed through verbatim — no sort, no case change, no normalisation. Apple's values go back to Apple unchanged. |
| **Google IAP Management** | out of scope entirely. |
| **Surfaces B and C** | Bulk Import and Edit are unaffected. Only surface A's modal changes. |

---

## PART 6 — UNCERTAIN / needs Manager or telemetry to close

| # | Open item | What would settle it |
|---|---|---|
| U1 | Which of the three toolbar buttons the Manager clicked during UAT, and whether `6795583` (the "Choose territories" entry point) was deployed at that moment | Manager confirms the button label + the deployed SHA. Decides whether the report is candidate 1 (not a bug) or candidate 2 (a bug). **Candidate 2 must be fixed either way.** |
| ~~U2~~ | ✅ **SETTLED 2026-08-25 — `user-hour-lim` = 3,600** (KB §4.9, measured live). As stated, this design did not depend on it. The question it *did* decide is now answered: a full-catalogue selection under A′ (~2,000 reads at N=1000) is **slow, not impossible** — 56% of one rolling hour. |
| U3 | Whether the UAT run left `rate_limited` traces | Railway logs at the UAT timestamp: `[iap-apple] … → 429` and the route returning `error: "rate_limited"`. Their presence proves candidate 2 fired. |
| U4 | Actual N for the app the Manager tested | changes nothing in the design; sharpens the numbers in PART 2(d). |
| U5 | Manager sign-off on the **decision 5** change (PART 3) | required before implementation. Fallback if declined: **(B′)** — keep the open-time pre-read + filter, but hard-cap it (e.g. 100 items) and, above the cap, degrade to A′ behaviour **with an explicit banner saying the filter was skipped and why**. Costs the Manager a split behaviour and still cannot filter a large catalogue — which is why it is the fallback and not the recommendation. |

---

## Implementation notes (for the cycle that follows this design — NOT this one)

Ordered by dependency. Each is independently testable.

1. **Fix candidate 2 first, on its own.** Read-errored and unlinked items must
   be *shown with a reason*, never dropped, and no caption may claim a filter
   that did not run. This is a correctness fix and is worth shipping ahead of
   the redesign.
2. Thread `drafts` into the modal; build the merged list model with
   `disabledReason` (PART 4.3).
3. Remove the on-open pre-read effect
   ([:282-347](../../components/iap-management/AvailabilitiesBulkModal.tsx#L282-L347));
   move it behind the action button as phase 2, scoped to `selected`.
4. Extend decision 3's stop-and-preserve to the read phase.
5. Compute confirm buckets for **all three** modes (modes 1–2 get a preset
   `TerritorySelection`; `buildConfirmBuckets` already does the rest).
6. In-modal search + windowed list + widened shell (PART 4.4).

**⚠ Test at the layer the arc kept missing.** SC6's entry point was invisible
because every test started *inside* the modal (as-built appendix A8). The
equivalent trap here: a test that renders the modal with a pre-populated
`states` Map will never observe that the pre-read is gone. **At least one test
must start at `IapListClient`, open the modal, and assert that opening it
issues ZERO calls to `/api/iap-management/iaps/*/availability`** — asserting an
*absence* of requests, which is the only assertion that can fail if someone
re-adds the pre-read later.


---

## APPENDIX — AS BUILT (SA1-SA3)

Same convention as the per-territory-availability design: the body above is left
as investigated and signed off; this records what shipped and why it differs.

### B1. H1's two candidates resolved — candidate 1, confirmed by UAT

The Manager re-ran UAT after D1 deployed: **"Choose Territories" works
correctly** — the list shows every item, unfiltered. The reported symptom came
from clicking the older **Set Availabilities** button (mode `set-all`), whose
filter is correct for its purpose. `filterEligible` was never defective and was
**not modified by this arc — not one line**.

⚠ **Candidate 2 was fixed anyway, and it was a real bug.** It is independent of
which button was clicked: read-errored / unlinked / unfetched rows were dropped
silently in ALL THREE modes while the caption blamed availability. It survived
UAT only because nobody had yet opened the modal on an app large enough to
throttle. Confirming candidate 1 did not make candidate 2 go away.

### B2. Scope narrowed by the Manager: A′ applies to `set-territories` only

The design proposed moving decision 5's filter to confirm-time for **all three**
modes. The Manager declined that for `set-all` / `remove` — those keep their
open-time pre-read and their filter. Consequence, recorded honestly rather than
buried: **those two modes still carry the full rate-limit exposure PART 2
measured** (~1,000 reads at N=500). Logged as `[SA2-scoped-out]`; the machinery
to close it is already built and reachable, so it is wiring plus copy.

⇒ In practice **decision 5 did not change at all.** It constrains modes 1 and 2,
which are untouched; mode 3 never had a bucket filter. The "changes in letter"
trade the design asked the Manager to weigh turned out not to be needed.

### B3. Decision 1 held, and the write set had to narrow

Preserved as designed, with one thing the design did not spell out: under A′ the
selection is made **before** the read, so a selected item can turn out
unreadable. The write set is therefore `selectedEligible` (selected MINUS
read-errored), not `selected`. Items in `alreadyMatches` are still sent —
REPLACE semantics beat saving a POST on a read that could be seconds stale.

### B4. A defect the design did not predict — the row badge lied under A′

Each row rendered `destructive ? "Available" : "Removed"`. That was only ever
true because the two all-or-nothing modes had already filtered the list BY that
value. With the pre-read gone, the same expression stamps **"Removed" on every
row with nothing read** — a state claim about data the modal does not have.
Renders `—` in `set-territories` now. **Lesson: removing an input invalidates
every expression that silently depended on it.** Grep for readers of the state
you just stopped fetching; a binary ternary is where they hide.

### B5. Decision 3's read-side stop needed a worker pool, not the shared queue

The design said "read the selection with the shared client queue". That alone
cannot preserve a remainder: if every target is dispatched and the Hotfix-25
queue throttles them, **every target has already been claimed** and "not yet
started" is the empty set. The read phase therefore owns its own **worker
count** while still drawing each SLOT from the shared queue — bounded fan-out
for correctness, shared budget for rate limiting. A test with only 3 targets and
3 workers passes trivially and proves nothing, so the stop tests use 8.

### B6. Phantom field #2 (KB §4.15)

`existsOnApple_validated` — named in the KB as a tri-state column on
`iap_mgmt.iaps` — **has never existed**: 0 hits in migrations, 0 in code, and
its enum values (`NEVER_SYNCED`) appear nowhere either. Second instance in this
module after §4.13's `availableInAllTerritories`, which makes it a pattern.
Corrected at all four sites. Real marker: `apple_iap_id IS NULL`.

### B7. The sixth D1 binary ternary (SA2a)

`HUB_FEATURE` in the modal was `mode === "set-all" ? … : "iap-remove-from-sales"`,
so `set-territories` opened its tracked run under one identity and the write
route closed it under another. It sat **eleven lines above** the five strings D1
converted, same file, same shape, and survived because it is the only member of
the family that is not user-visible. **Lesson for P1: when you sweep a file for
a defect shape, the invisible instances are the ones that survive the sweep.
Grep the shape, not the symptom.**

### B8. The primary acceptance is an ABSENCE

"Opening the modal issues NO `/availability` request." Every SC6 test rendered
the modal with state already in hand, so none could observe what opening it
cost. Only an assertion that a request was **not** made fails when someone
re-adds the pre-read. Same family as A8's lesson from the previous arc — the
bug lives at a layer no existing test started from.

### B9. Still open

See `TODO.md`: `[SA2-scoped-out]` (modes 1-2 still pre-read the full list),
`[SA2-upstream]` (`seedMissingIapStubs` fails silently on the page — the modal
now names the symptom, the page still hides the cause), `[SA-followup]` (the
window is a slice, not virtualisation).
