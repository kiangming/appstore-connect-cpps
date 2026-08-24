# Session arc — Export list: hardening, then item selection

**Range:** `1f0e32d` → `afa3fc6` · **13 commits** · Aug 2026
**Net:** tests **3696 → 3853** (+157) · test files **272 → 281** (+9) · **0 migrations**

> ⚠ **Range note.** The arc was briefed as "13 commits, `915deff` → `afa3fc6`".
> Those two facts disagree: `915deff..afa3fc6` is **12**. The 13th is
> `1f0e32d` — *U3 settled by live measurement* — which belongs here on merit,
> not arithmetic: it is the measurement that closed U3/U4 and made the free
> Apple-status filter the design instead of a paid availability read. Counting
> from it gives 13. (The design commit `c7e24ff` sits one earlier again; from
> there the arc is 14.)

---

## The 13 commits

### Chunk 1 — make the existing export honest (`1f0e32d` → `ac6acd7`, +83 tests)

Nothing here changed what the export *does*. It changed what it is willing to
claim.

| # | Commit | What |
|---|---|---|
| 1 | `1f0e32d` | **U3 settled by live measurement.** `state` tracked real availability on **35/35** items across 6 apps and 4 ASC teams, zero counterexamples ⇒ the free Apple-status filter *is* the availability proxy. Killed the paid filter before it was built. |
| 2 | `915deff` | Removed **both** `listAllInAppPurchases` double-wraps; added exactly **one** `withRetry` to the export detail read. The outer wrapper turned 4 attempts into 16 and restarted enumeration from page 1, so a tail-page 429 on a 5-page app cost up to 32 requests for a 5-request list. |
| 3 | `9ff0c05` | Extracted **`runStoppablePool`**; migrated `bulk-availability` onto it first, to prove parity, before export used it. One latch, two callers. |
| 4 | `b171eeb` | Export **stop-and-preserve** + the failure sheet. Killed both G4 defects and fixed the meaning of the four count headers. |
| 5 | `a4d52e2` | **Stage-labelled 404s** (`NoPriceScheduleError`) and made a short price read say so (`INCOMPLETE_PRICES`). |
| 6 | `ac6acd7` | Sourced the `links.next` claim in both twins, and said why they differ. |

### Chunk 2 — item selection (`f7e1bdb` → `afa3fc6`, +74 tests)

| # | Commit | What | Mutations caught |
|---|---|---|---|
| 7 | `f7e1bdb` | **V0 correction.** The design called `runAvailabilityReadPhase` client-only. False — its only import is `import type`, every seam is injected. The real reason export can't use it is the *problem it solves* (pre-claim latch for a shared client queue vs. `runStoppablePool`'s claim-then-await). | — |
| 8 | `8004a0e` | 2a — the five export headers pinned as a **contract**, not a comment. Zero behaviour change. | 4 |
| 9 | `46c1059` | 2b — **`buildExportItemRows`**, a new module. Export's exclusion set is local drafts *only*; A′'s `not_linked` would hide exportable items. | 3 |
| 10 | `adb89f9` | 2c — **`BulkItemPicker`** extracted; the modal renders it, 53/53 modal tests unchanged. | 4 (one survived — see below) |
| 11 | `69919cf` | 2d — the **wizard shell**. Two steps, both zero-request. `ExportOptionsDialog` byte-untouched. | 4 |
| 12 | `70b1434` | 2e — route takes **`selectedIds`**. Every id attempted; none dropped. | 4 (+2 at pre-gate) |
| 13 | `afa3fc6` | 2f — the **result surface** and "X of M selected". | 6 |

---

## Numbers

| | Start (`1f0e32d`) | End (`afa3fc6`) | Δ |
|---|---|---|---|
| Tests | 3696 | 3853 | **+157** |
| Test files | 272 | 281 | **+9** |
| Migrations | — | — | **0** |
| Files touched (arc-wide) | | | 32 (+5,655 / −345) |

Baselines re-measured at `1f0e32d` in a detached worktree, not copied from an
earlier report. Final gate at `afa3fc6` from a clean tree: **281 files / 3853
tests**, typecheck clean, lint clean (one pre-existing warning on
`IapListClient.tsx`, unchanged), `npm run build` compiled successfully.

**Byte-untouched across the whole arc**, verified by blob/tree hash rather than
by assertion: `ExportOptionsDialog.tsx` (+ its test), `bulk-item-rows.ts`,
`bulk-item-search.ts`, and all four `google-iap-management` trees. Zero
pre-existing test files were edited anywhere in chunk 2 — every one of the six
new suites is an addition.

---

## Decisions the Manager locked

| # | Decision | Why it was not the other way |
|---|---|---|
| 1 | **Client list is authoritative when a selection is present** — the route does not enumerate, not even to validate | Enumerate-then-intersect looks safer and is the trap: an id the operator selected that the intersection drops vanishes with nothing saying why. A visible 404 in the failure sheet beats an invisible omission. |
| 2 | **`selectedIds: []` ⇒ HTTP 400**, never a silent export-all | Widening an empty selection to the whole app bills ~3N Apple requests nobody asked for. Only *absence* means "no selection was made". |
| 3 | **Blank `productId`/`name` on selected-id stubs is the honest value**, not a gap | Both are read *from* Apple. For an item whose read failed we genuinely do not know them; a client-supplied last-known id would read as fetched fact and be stale for exactly the items most likely to fail. The failure sheet's Apple IAP ID identifies the row, and that is also what a re-export takes. |
| 4 | **No paid availability filter** — the free Apple-status filter is the proxy | U3, 35/35, zero counterexamples. One residual risk keeps it open rather than closed (see UAT #1). |
| 5 | **Apple status renders RAW** (`DEVELOPER_REMOVED_FROM_SALE`), not "Removed", and not title-cased | Agreement measured is not agreement guaranteed. A friendly word presents Apple's status as *this tool's* availability verdict, so the day the two axes diverge the Manager sees nothing. Raw keeps the surprise visible. |
| 6 | **No cap on selection size** | The stop latch already *is* the budget mechanism. A second invented cap refuses work the latch handles correctly. |
| 7 | **Deviation accepted for v1: no "Export the N not-attempted" button** | PART 3's mockup shows one. It cannot be built honestly from what the wire carries — the remainder arrives as a *count*, and pre-ticking "only those N" needs their *ids*. Re-sending the whole selection instead would re-send the FAILED items, against SC3's lock. The remainder is not lost: it is named per item in the workbook. |

### One finding worth carrying forward

In 2c, a mutation **survived all 53 modal tests**: the excluded tail could stop
respecting the search and nothing went red. The behaviour was unpinned in the
modal, and the extraction had just moved it into a component the export wizard
also renders. Pinned at the shared layer rather than in either consumer
(`BulkItemPicker.test.tsx`). *An extraction is a good moment to discover what
the original was never testing.*

---

## Backlog — 7 named items this arc created or decided

| Tag | State | Registered in |
|---|---|---|
| `[EXPORT-availability-filter]` | **Decided: not built.** U3 made the free filter the proxy. Gated on UAT #1 to close as won't-build. | TODO.md |
| `[EXPORT-avail-read-halving]` | Open. Any availability read can drop 2 Apple requests → 1. ⚠ Benefits A′ and `[SA2-scoped-out]`, **not** export (which reads no availability). Do it there. | TODO.md |
| `[SYNC-orphan-rows]` | Open. Local mirror keeps rows Apple no longer has; found while probing U3. `vn.lw.gg.120/.121/.123` are cached `READY_TO_SUBMIT` but 404 on Apple. | TODO.md |
| `[UPDATE-stage1-404-redundant-price-push]` | Open. Now that `NoPriceScheduleError` exists a stage-1 404 could skip a redundant push — but only after confirming "no schedule" and "no custom prices" are the same claim there. | TODO.md |
| `[VITEST-coldstart-flake-recurrence]` | Open. Recurred twice during `a4d52e2`; proven pre-existing by reproducing at `b171eeb` with the tree stashed (1 in 8). Worker-startup contention, not a logic bug. | TODO.md |
| `[POOL-unify-availabilityReadPhase]` | **New (V0).** Unify the two three-state pools. Needs a pre-claim hook in `runStoppablePool`; real work, zero user-visible change, touches a shipped path. | ⚠ design doc PART 5 **only** |
| `[EXPORT-resume-not-attempted]` | **New (2f).** The re-export button. Blocked on the remainder's ids not being on the wire. | ⚠ `ExportResultSummary` docstring **only** |

> ⚠ **The last two are not grep-findable from TODO.md.** They live in a design
> doc and a component docstring respectively. A backlog item that only one
> surface knows about is a backlog item that will be missed — register both at
> the next kickoff.

**Explicitly untouched by this arc** (pre-existing, listed in design PART 5 so
they are not mistaken for oversights): `[SA2-scoped-out]`, `[SA2-upstream]`,
`[SA-followup]`, `[SC4-debt]`.

---

## UAT pending

Seven observations. Verdict column filled in after the Manager runs them —
none of them requires a staged environment or a throwaway write beyond what is
already part of normal use.

| # | Observation | Settles | Verdict |
|---|---|---|---|
| 1 | Click **Remove from Sales** in the tool, then **Refresh from Apple**. Does Status flip to `DEVELOPER_REMOVED_FROM_SALE`? | `[EXPORT-availability-filter]` — **Yes** ⇒ close as won't-build; **No** ⇒ the proxy has a blind spot on exactly the items the tool just touched, and it becomes real work | _pending_ |
| 2 | Open **Export list** on the largest real app. Does step 1 appear instantly, with no spinner and no delay? | The zero-request claim, live. A pre-read would be visible as lag before the list paints | _pending_ |
| 3 | Tick a subset, export, open the file. Does the main sheet contain **exactly** those items — no more, no fewer? | Decision 1 end-to-end | _pending_ |
| 4 | Export a selection that includes a known-dead id — `vn.lw.gg.120`, `.121` or `.123` are cached locally but 404 on Apple. Does it appear in the **Export Failures** sheet as FAILED / "Apple refused"? | Decisions 1 + 3, and gives `[SYNC-orphan-rows]` a live reproduction | _pending_ |
| 5 | Select enough items to pass ~250 estimated requests. Does the caution appear **without** disabling Continue? If Apple then throttles, do the stopped panel and the failure sheet both appear? | Decision 6 + stop-and-preserve on the export path | _pending_ |
| 6 | Export an app with at least one rate-limited or short price read. Is the ⚠ note row present at the top of the main sheet, and is that item listed **PARTIAL** (not FAILED) in the failure sheet? | `b171eeb` + `a4d52e2` — partial is in the file, not missing from it | _pending_ |
| 7 | Read the **Apple status** filter values. Are the raw tokens usable in practice, or does the Manager want labels? | Decision 5. ⚠ If labels are wanted, the answer is a *second* column, not a translation of this one — the raw value is what keeps a status/availability divergence visible | _pending_ |

---

## References

- Design: [`design-export-list-item-selection.md`](./design-export-list-item-selection.md) (PART 1.5 measurements, 2.A wizard, 2.E scale, 2.G exclusion set, PART 5 exclusions)
- Patterns crystallized: [`IAP-MANAGEMENT-KNOWLEDGE-BASE.md`](./IAP-MANAGEMENT-KNOWLEDGE-BASE.md) §10.13.K **P19–P23**
- Prior arc: `[SA*]` set-availabilities item list, closed `c87e1c1`
