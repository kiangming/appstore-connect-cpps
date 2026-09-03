# Census + Design — Export list item picker: pagination + shift-click range (APPLE)

**Status:** 🛑 **CENSUS + DESIGN FOR REVIEW — NO PRODUCT CODE WRITTEN.**
Hold for Manager sign-off before any build prompt. This commit contains this
document and one HTML mockup, nothing else.

**Scope:** Apple IAP Management only — the item picker inside *Export list*.
**Explicitly NOT ported from Google.** The Google arc that just closed
(`496309d`, `docs/google-iap-management/design-export-item-list-optimize.md`)
solved a differently-shaped problem on a different component with a different
cost model; every place this design lands in the same shape as Google's, it is
because the Apple code was read and found to be the same, and that reading is
cited. Every place it differs, the difference is stated.

**Picks up:** `[SA-followup]` ([TODO.md:592](../../TODO.md)) — the standing
backlog item for exactly this window, which mandates that whatever replaces the
slice must keep *"Select all = all matching, never the rendered set"*.

---

## PART 0 — TL;DR

| | |
|---|---|
| **Both (1) pagination and (2) shift-click are FEASIBLE.** | The list is a plain `.map()` with no virtualisation, and row order is provably stable end-to-end (P1.8). Nothing blocks (2). |
| **Neither costs a single Apple request.** | Every option is pure client-side slicing over the `iaps` prop the page already holds ([ExportItemWizard.tsx:8-14](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L8-L14)). |
| **The pagination *math* already exists and is already shared.** | [`lib/iap-management/pagination/page-slice.ts`](../../lib/iap-management/pagination/page-slice.ts) — `computePageMeta`, used today by Apple's outer list, Google's list, Google's apps list and the territory catalog. No second implementation. |
| **⚠ The design that produced this picker REJECTED pagination, in writing, for the exact reason M7 flags.** | [design-set-availabilities-item-list.md:574-577](design-set-availabilities-item-list.md) — *"Pagination re-introduces the 'Select all = this page?' ambiguity."* The Manager's M7 concern is not caution; it is the live, documented objection. **This design must answer it by construction, not by copy.** See §3.1. |
| **⚠ The string the Manager quoted is GOOGLE's, not Apple's.** | Apple's window copy is different and promises something narrower. Read P1.2 before anything else — the two modules make **different promises** about hidden rows. |
| **The biggest structural risk is real and is named.** | Today the render window only ever *grows*, so a row once seen can never leave the screen. Pagination makes a ticked row able to go off-screen. That is a **new direction** of "đang thấy ≠ đang chọn". §3.1. |
| **⚠ One pre-existing defect found during census, OUT OF SCOPE, reported not fixed.** | After a successful export, re-opening *Export list* lands on **step 2** with the old selection still ticked. P1.3(e). |
| **Recommendation** | Ship **both**, in one arc, with **(A) re-shaped from a checkbox into a labelled button** so the two bulk controls stop looking alike. §3.1. |

---

# PART 1 — CENSUS

Every claim below is a file:line or a command result. Where something could not
be established, it says so.

## 1.1 — Which component, where the items come from, is there paging

| Question | Answer | Evidence |
|---|---|---|
| The picker component | [`components/iap-management/item-picker/BulkItemPicker.tsx`](../../components/iap-management/item-picker/BulkItemPicker.tsx) — 269 lines | `wc -l` |
| Its export caller | [`ExportItemWizard.tsx:453-515`](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L453-L515) | — |
| Where the wizard is mounted | [`IapListClient.tsx:1035-1051`](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L1035-L1051) | — |
| Items: prop or fetch? | **PROP, already loaded.** `iaps={iaps}` — server-rendered, zero fetch | [IapListClient.tsx:1037](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L1037) |
| Is that a hard rule or an accident? | **Hard rule, and it is the feature's primary acceptance criterion.** *"BOTH STEPS COST ZERO APPLE REQUESTS … Nothing here may ever grow a fetch."* | [ExportItemWizard.tsx:8-14](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L8-L14) |
| Pagination in the picker today | **NONE.** A monotone slice window | [BulkItemPicker.tsx:137-141](../../components/iap-management/item-picker/BulkItemPicker.tsx#L137-L141) |
| Window size | starts at `ROW_WINDOW_STEP = 60`, grows `+60` per click | [bulk-item-search.ts:34](../../lib/iap-management/apple/bulk-item-search.ts#L34); [ExportItemWizard.tsx:464](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L464) |

⚠ **The picker is SHARED — but not with Google.** `BulkItemPicker` has exactly
two consumers, both Apple:

- [`AvailabilitiesBulkModal.tsx:1081`](../../components/iap-management/AvailabilitiesBulkModal.tsx#L1081) — A′, the availability **WRITE** surface.
- [`ExportItemWizard.tsx:453`](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L453) — export, a **READ** surface.

Google deliberately has its own ([`IapSelectionList.tsx:14`](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L14) records the divergence).

⇒ **P8 (the Apple/Google shared dialog lock) does NOT apply to the picker.**
The P8-locked component is `ExportOptionsDialog`, which is *step 2* (countries)
and is untouched here ([ExportItemWizard.tsx:30-33](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L30-L33)).

⇒ **But an Apple-internal twin-surface lock DOES apply, and it is the sharper
one.** Any edit to `BulkItemPicker` lands on the availability bulk modal too —
a **write** path where a mis-scoped bulk control changes what sells in which
country. Export is recoverable (re-run, pay requests again); a wrong
availability write is not. **Every change proposed here must be evaluated on
A′ as well as on export.** See §3.2.

## 1.2 — ⚠ THE GATE QUESTION: does "Show more" bound DISPLAY or SELECTION?

**First, a correction that changes the question.** The string in the brief —
*"Show more — N more match and are still included in the export"* — is
**Google's**, at
[`IapSelectionList.tsx:204-207`](../../components/google-iap-management/iap-list/IapSelectionList.tsx#L204-L207).
Apple's copy is different, and promises something narrower
([BulkItemPicker.tsx:250-256](../../components/iap-management/item-picker/BulkItemPicker.tsx#L250-L256)):

```
Show 60 more (137 not shown)
Not shown is not excluded — Select all still takes all 197.
```

**Apple's answer: the window bounds DISPLAY only. An item that is hidden AND
unticked is NOT exported.**

The decision line, verbatim
([ExportItemWizard.tsx:316-319](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L316-L319)):

```ts
onExport={(territories) =>
  onExport({ selectedIds: [...selected], territories })
}
```

The payload **is** the `selected` Set. Pinned by a test whose name is the
answer — *"posts the ticked Apple ids, **not the rendered window and not the
whole app**"*
([IapListClient.export-wizard.test.tsx:388-408](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.export-wizard.test.tsx#L388-L408)).

So Apple's *"not shown is not excluded"* means one precise, narrow thing:
**"Select all" reaches rows the window is hiding** — `toggleAll` operates on
`facetSelectable` + the query and never on `windowed`
([ExportItemWizard.tsx:267-283](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L267-L283)).
It does **not** mean an unticked hidden row rides along.

### ⇒ Does moving to pages CHANGE the meaning of the selected set?

**No.** And this is the single most load-bearing census finding for
feasibility:

- The selection is already an explicit `Set` of Apple ids
  ([ExportItemWizard.tsx:139](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L139)),
  already fully independent of what is rendered.
- `slice(0, windowSize)` → `slice(startIndex, endIndex)` swaps one render bound
  for another render bound of the same class.
- The route contract does not change at all (P1.5).

**⚠ One thing DOES change, and it is the whole risk of this arc.** Today the
window is **monotone** — it only grows — so a row the Manager has once seen can
never leave the screen. With pages, **a ticked row can go off-screen by paging
away.** "Đang thấy ≠ đang chọn" gains a second direction. That is why M2's
two-tier counter is a requirement and not decoration, and why §2.7 proposes a
way to look at picks that are out of view.

## 1.3 — The current selection model

| | |
|---|---|
| **Type** | `useState<Set<string>>(new Set())` — a real Set of **Apple ids** ([ExportItemWizard.tsx:139](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L139)) |
| **Sentinel `"all"`?** | **NO.** ⇒ the brief's 1.3 warning does not apply to Apple. `toggleAll` writes the ids in immediately ([:267-283](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L267-L283)); un-ticking one item is a plain `Set.delete` ([:255-262](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L255-L262)). There is no mode to convert. |
| **(A)'s checked state** | **Derived, not stored**: `counts.matching > 0 && counts.selectedMatching === counts.matching`, with `indeterminate` when partial ([BulkItemPicker.tsx:145-147, 172-181](../../components/iap-management/item-picker/BulkItemPicker.tsx#L145-L181)) |
| **Reset** | `reset()` clears step + selected + query + windowSize + all 3 facets ([:285-293](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L285-L293)) |
| **Called from** | `handleCancel` **only** ([:295-298](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L295-L298)) → wired to ✕ ([:344](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L344)) and Cancel ([:542](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L542)) |
| **NOT reset on** | facet change · search change · `open` false→true |
| **Search change** | resets `windowSize` only, never the selection ([:459-462](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L459-L462)) |
| **Facet change** | resets **nothing** — `windowSize` survives a facet change (harmless today, because a window only grows) |

### (e) ⚠ PRE-EXISTING DEFECT — found in census, OUT OF SCOPE, reported not fixed

`ExportItemWizard` contains **zero `useEffect`** (`grep -c useEffect` → `0`),
so it has no reset-on-open. It is also **permanently mounted** — `open` is a
prop ([IapListClient.tsx:1036](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L1036)).
And `handleConfirmExport` only closes it
([IapListClient.tsx:422-428](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L422-L428)) —
it never calls `reset()`.

⇒ After a successful export, `step` is still `"countries"` (set at
[:550](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L550)),
so **clicking "Export list" again renders step 2 with the previous selection
still ticked**, skipping item selection entirely. No test covers reopen
(`grep -i reopen` on the wizard test file: no match).

This is not caused by, and does not block, this arc. It is listed as a Manager
question (Q6) because the fix is three lines and this arc will be editing the
adjacent state.

## 1.4 — Search / filter, and its interaction with selection

| | |
|---|---|
| **Search fields** | `productId` + `name`, case-insensitive substring ([bulk-item-search.ts:39-46](../../lib/iap-management/apple/bulk-item-search.ts#L39-L46)) |
| **Regex?** | Deliberately not — *"the query is user input, and this module must never become a place where a stray `(` throws"* ([:36-38](../../lib/iap-management/apple/bulk-item-search.ts#L36-L38)) |
| **Does typing lose the selection?** | **No.** Guaranteed, documented, and tested ([BulkItemPicker.tsx:115-117](../../components/iap-management/item-picker/BulkItemPicker.tsx#L115-L117); [bulk-item-search.ts:22-26](../../lib/iap-management/apple/bulk-item-search.ts#L22-L26); test at [export-wizard.test.tsx:409-431](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.export-wizard.test.tsx#L409-L431)) |
| **Is the divergence visible?** | Yes — `selectedHidden` is rendered, not just computed ([BulkItemPicker.tsx:201-210](../../components/iap-management/item-picker/BulkItemPicker.tsx#L201-L210)) |
| **Facets** | Type · Apple status (raw) · Availability, all pure predicates, no fetch ([ExportItemWizard.tsx:181-211](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L181-L211)) |
| **Facet-hidden picks counted?** | Yes, on its own axis: `selectedHiddenByFacets` ([:241-248](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L241-L248)), rendered [:437-451](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L437-L451) |

⇒ **M3 and M4 are ALREADY the shipped behaviour on Apple.** Search filters the
whole selectable set (not the window), and a pick survives clearing the search.
They need **confirming by test at the new page boundary**, not implementing.

## 1.5 — Route contract

`POST /api/iap-management/apps/[appId]/export`
([route.ts](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts))

| Input | Behaviour | Evidence |
|---|---|---|
| `selectedIds` absent / `null` | **export ALL** — enumerate via `listAllInAppPurchases`, all-or-nothing (a page failure throws rather than truncating) | [:27-31](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L27-L31), [:145](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L145) |
| `selectedIds: []` | **400.** Explicitly *not* widened to export-all — *"quietly widening it to the whole app would bill the operator ~3N Apple requests they did not ask for"* | [:46-50](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L46-L50), [:146-150](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L146-L150) |
| duplicate ids | de-duped: `new Set(selectedIds)` | [:155](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L155) |
| a dead / unknown id | **NO 409, and no validation against Apple's list.** It is sent, Apple answers 404, and it lands in the **failure sheet** as `APPLE_ERROR` | [:38-45](../../app/api/iap-management/apps/%5BappId%5D/export/route.ts#L38-L45) |

✅ **The Manager's recollection is confirmed still accurate**, and the reason is
recorded in the route: *"Enumerating and intersecting would look safer and is
the trap: an id the operator selected but that the intersection drops would
vanish silently … A visible failure beats an invisible omission."*

⇒ **Nothing in this arc touches the route.** The contract is `selectedIds:
string[]` and stays that.

## 1.6 — ⚠ REQUEST COST — the opposite argument from Google's

| | |
|---|---|
| **Per-item cost, as coded** | `REQUESTS_PER_ITEM = 3` ([ExportItemWizard.tsx:88-91](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L88-L91)) |
| **Confirmed at the fetch layer** | *"Each IAP costs ~2-3 Apple calls (IAP+localizations, price-schedule stage 1, price-schedule stage 2)"* ([export-fetch.ts:46-49](../../lib/iap-management/apple/export-fetch.ts#L46-L49)) |
| **Why the copy says "about"** | an item with no price schedule costs 2; rounding **up** is the safe direction ([:88-91](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L88-L91)) |
| **Concurrency** | 8 workers ([export-fetch.ts:49](../../lib/iap-management/apple/export-fetch.ts#L49)) |
| **Caution threshold** | 250 estimated requests — a caution, never a block ([:92-95](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L92-L95)) |

**⇒ At Apple, selecting fewer items SAVES REAL MONEY.** At Google it does not —
Google's export is *"a single list call"*
([TODO.md:673](../../TODO.md)). This inverts the design argument:

- **Google:** narrowing the picker is a *convenience*. Getting the scope wrong
  costs a re-download.
- **Apple:** narrowing the picker is *the point of the wizard*
  ([ExportItemWizard.tsx:8-14](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L8-L14)).
  A bulk control that over-selects by 100 items costs **~300 Apple requests**
  out of an hourly budget, and can push a run into the stop latch.

⚠ **This is exactly why M7 is a money question and not a taste question**, and
why no reasoning from the Google arc about bulk-select affordances transfers
here unexamined.

## 1.7 — The outer table's pagination: reusable, and already shared

[`IapListClient.tsx`](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx)

| | |
|---|---|
| Mechanism | **client-side slice.** No fetch on page flip |
| Page size | `PAGE_SIZE = 100`, a **constant — no selector** ([:47](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L47)) |
| State | `const [page, setPage] = useState(1)` ([:176](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L176)) |
| Math | `computePageMeta(filtered.length, page, PAGE_SIZE)` ([:262-264](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L262-L264)) |
| Slice | `filtered.slice(pageMeta.startIndex, pageMeta.endIndex)` ([:266-269](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L266-L269)) |
| Reset on filter change | `useEffect(() => setPage(1), [query, typeFilter, stateFilter])` ([:253-260](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L253-L260)) |
| Footer | **inline JSX**, not a component ([:948-999](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L948-L999)) — hidden when `totalPages <= 1` |

### ✅ The math is ALREADY a shared pure module — T1 shape, already achieved

[`lib/iap-management/pagination/page-slice.ts`](../../lib/iap-management/pagination/page-slice.ts):
`computePageMeta(total, requestedPage, pageSize) → { page, totalPages,
startIndex, endIndex, displayStart, displayEnd }`, with `requestedPage`
**clamped** to `[1, totalPages]` ([:36-37](../../lib/iap-management/pagination/page-slice.ts#L36-L37)) and
`total === 0` yielding a single empty page ([:11-12](../../lib/iap-management/pagination/page-slice.ts#L11-L12)).

Consumers today (`grep -rln "pagination/page-slice"`):

```
app/(dashboard)/iap-management/apps/[appId]/IapListClient.tsx   ← Apple list
components/google-iap-management/iap-list/IapListClient.tsx     ← Google list
components/google-iap-management/apps/AppsListClient.tsx        ← Google apps
lib/iap-management/territory-catalog.ts
```

⇒ **The picker imports the same function. There is no second implementation to
write and none to be tempted by.**

⚠ **What IS duplicated if nobody looks: the CONTROLS.** The footer is inline
JSX in one file. Adding a second inline copy inside the picker is the classic
twin-path: two Prev/Next bars, two disabled rules, two "Showing X–Y of Z"
wordings, drifting from the first fix. **§2.8 proposes extracting one
presentational `PageNav` and adopting it in the outer table in the same commit
— a SHARED choke point rather than two patches.**

### ⚠ And the precedent for scope: the outer table's "Select all" is CROSS-PAGE

`toggleAll` ([:323-335](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L323-L335))
operates on `selectableAppleIds`, which is derived from **`filtered`** — the
whole matching set, pre-pagination
([:288-298](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L288-L298)).

⇒ **There is no page-scoped select-all anywhere in the Apple module today.**
The module has exactly one bulk-select meaning — "all matching" — on both the
paginated outer table and the windowed picker. Mechanism **(B) is a genuinely
new control class for this module**, and the reason M7 matters.

*(For the avoidance of doubt: the comment at
[:772-775](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L772-L775)
that says "scoped to the CURRENT PAGE's rows" is about the availability
as-of line, not about selection.)*

## 1.8 — Feasibility of (2): render mechanism and order stability

### Render — plain `.map()`, no virtualisation

[BulkItemPicker.tsx:212-237](../../components/iap-management/item-picker/BulkItemPicker.tsx#L212-L237)
maps `windowed` into `<li>` elements. `grep -n "virtual\|react-window"
package.json` → **no match**. Corroborated by
[TODO.md:592](../../TODO.md), which describes the current state as *"a slice +
'Show more', not virtualisation"*.

⇒ Rows have real DOM indices and a stable array index. **Nothing blocks a range
selection.**

### Order — STABLE, and provably so at every hop

| Hop | Operation | Order effect |
|---|---|---|
| `buildExportItemRows` | `for (const iap of iaps) rows.push(...)`, then drafts appended — **no sort** | preserved ([export-item-rows.ts:130-155](../../lib/iap-management/apple/export-item-rows.ts#L130-L155)) |
| `partitionExportRows` | `for … if/else push` | preserved ([:194-211](../../lib/iap-management/apple/export-item-rows.ts#L194-L211)) |
| `facetSelectable` | `.filter()` | preserved ([ExportItemWizard.tsx:181-211](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L181-L211)) |
| `filterRowsByQuery` | `.filter()` | preserved ([bulk-item-search.ts:48-55](../../lib/iap-management/apple/bulk-item-search.ts#L48-L55)) |
| window / page | `.slice()` | preserved |
| the `iaps` prop | server-rendered; **no client sort control exists** (`grep -n "sortBy\|onSort"` on the list page → nothing but `Array.from(s).sort()` for the *filter dropdown options*) | stable |
| anything refetching mid-dialog? | No. `AvailabilityCell` resolution feeds `resolvedAvailability`, which changes **badges only** ([IapListClient.tsx:182-207](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L182-L207)) | stable |

⇒ **"A range" has a well-defined, stable meaning for the life of the dialog.
(2) is FEASIBLE.**

⚠ **The one honest caveat.** The order is *whatever Apple's list endpoint
returned* — not alphabetical, not chronological, not documented. So a range
means **"these adjacent rows as currently listed"**, and is not reproducible
across a `router.refresh()`. That is fine for the Manager's stated use
(they can see the rows are adjacent), but it means a range must never be
*persisted* or *described* as anything other than "what you selected".

## 1.9 — ⚠ THE PRIOR DECISION: pagination was rejected here, in writing

This is the finding that most affects the design, so it is quoted rather than
summarised.

**[design-set-availabilities-item-list.md:574-577](design-set-availabilities-item-list.md)** — §4.4, the
proposal that produced the current window:

> 2. **Windowed rendering** (~60 rows + overscan) rather than internal
>    pagination. Pagination re-introduces the "Select all = this page?"
>    ambiguity from option (B); a window does not, because the selection model
>    is already "all matching."

**[:448-462](design-set-availabilities-item-list.md)** — *"❌ Rejected: (B) paginate the pre-read"*, whose
second reason is the same ambiguity:

> Mode filtering "within the page" means **"Select all" selects only the
> current page.** A Manager who intends all 500 and sees "Select all" gets 50,
> with nothing saying so. That is the same class of defect as candidate 2:
> a control whose label overstates what it did.

…and which closes by **blessing pagination for exactly this arc's purpose**:

> **Pagination is the right answer to a different question.** Use it for the
> *render* problem (requirement 4, PART 4.4) — never as the API fix.

### Two things follow, and they pull in opposite directions

1. ✅ **Pagination-for-render is pre-blessed.** The rejection was of paginating
   the *pre-read* (an API-cost fix). Export performs **no pre-read at all**
   ([export-item-rows.ts:74-76](../../lib/iap-management/apple/export-item-rows.ts#L74-L76)), so
   the API objection cannot apply here. This arc is squarely the "different
   question" the doc points at.
2. ⚠ **The ambiguity objection DOES survive, verbatim.** It was an argument
   against *pagination*, not against *pre-reading*. M7 is that same objection
   arriving from the Manager. It cannot be answered with reassurance — it has
   to be answered by making the two scopes **structurally impossible to
   confuse**. §3.1.

---

# PART 2 — DESIGN

Everything in this part is a **proposal for the Manager to accept, change or
reject.** Nothing here is decided.

## 2.0 — What is reused, what is new

| | |
|---|---|
| **Reused verbatim, no flag, no fork** | `computePageMeta` ([page-slice.ts](../../lib/iap-management/pagination/page-slice.ts)) · `matchesQuery` · `filterRowsByQuery` · `selectionCounts` · `toggleAllForQuery` ([bulk-item-search.ts](../../lib/iap-management/apple/bulk-item-search.ts)) — all already surface-agnostic |
| **Extracted to a shared choke point (NEW file)** | `components/ui/iap/PageNav.tsx` — one Prev/Next/"Showing X–Y of Z" control, adopted by **both** the picker and the outer table (§2.8) |
| **New logic** | page + pageSize state · page-scoped toggle (B) · shift anchor + range (C) · the two-tier counter (M2) |
| **Untouched** | the export route · `ExportOptionsDialog` (P8) · `bulk-item-rows.ts` · `export-item-rows.ts` · `xlsx-export.ts` |

## 2.1 — The three (four) mechanisms, and how they are told apart

| | Mechanism | Scope | Affordance **as proposed** |
|---|---|---|---|
| **(A)** | Select all matching | **every** selectable row surviving facets + search, across all pages | ⚠ **CHANGED: a labelled text button in the toolbar** — `Select all 197 matching` / `Clear all 197` |
| **(B)** | Select all on this page | the rows in the **current page slice** | a tri-state **checkbox at the head of the tickbox column** — the one position that already means "this page" in every table people use |
| **(C)** | Shift-click range | the rows **between two clicks, within one page** | no control of its own; a hint line on first use |
| **(D)** | Search + (A) | *(already shipped)* | — |

**⚠ Why (A) stops being a checkbox.** M7 names the failure exactly: *"(A) và
(B) giống nhau về hình thức, khác nhau về PHẠM VI."* Two identical checkboxes
whose scopes differ by 10× is a mis-click that costs ~3 requests per wrongly
added item (P1.6). The fix is not a longer label on both — it is to **stop them
being the same kind of control**:

- Position carries the scope: checkbox-in-the-column-header = this page.
  Everything else lives in the toolbar with words.
- (A)'s semantics, arithmetic and `toggleAllForQuery` call are **unchanged** —
  only the affordance changes. Its label also states the count, so pressing it
  by accident is visible in the same glance.

**⚠ The cost of that change, stated.** (A) as a checkbox today carries an
`indeterminate` state that silently says *"some of the matching set is
selected"*
([BulkItemPicker.tsx:145-147](../../components/iap-management/item-picker/BulkItemPicker.tsx#L145-L147)).
A button cannot show that. ⇒ **the counter must carry it instead** — which is
what M2 already mandates. This is why M2 is load-bearing and not decoration.

**Answer to M7's blunt question — is three mechanisms on one screen too much?**
No, **provided they are three different KINDS of control.** Three checkboxes
would be. One checkbox + one labelled button + one keyboard modifier is the
same inventory Gmail ships, and none of the three is redundant:

| Case | (A) | (B) | (C) |
|---|---|---|---|
| "all the gem packs" (a search can express it) | ✅ the tool | overshoots/undershoots | slow |
| "these 30, they happen to be adjacent" | ✗ too broad | only if group == page | ✅ **2 actions** |
| "this whole page, I checked it" | ✗ too broad | ✅ 1 action | 2 actions |

⇒ **Recommend: keep all three, re-shape (A).** Manager decides (Q1).

## 2.2 — (B) with a partially-ticked page — brief §2.1

**Proposal:** tri-state, following the convention every table UI uses, with the
**label changing with the state** so the click is never ambiguous:

| Page state | Checkbox | Label | Click does |
|---|---|---|---|
| 0 of 20 ticked | empty | `Select all 20 on this page` | tick all 20 |
| 7 of 20 ticked | **indeterminate** | `Select all 20 on this page` | tick the remaining 13 — **never clears** |
| 20 of 20 ticked | checked | `Clear 20 on this page` | untick those 20 |

**Why partial → fill, not clear.** Two reasons, one conventional and one
Apple-specific:
- Convention (Gmail, GitHub, macOS Mail): a partial header checkbox fills.
- Apple-specific: from *partial*, the Manager's intent is overwhelmingly "add
  the rest". Interpreting an ambiguous click as *destructive* is what loses
  picks, and a lost pick is a row missing from the file with nothing on screen
  saying why — the silent-drop class.

**⚠ And the clear direction is still reachable in one click** (from the checked
state), which is what makes an over-selection cheap to undo. That matters for
(C) — see §2.6.

## 2.3 — (A) × (B) — brief §2.2

**This needs no design. It already works, and the census says why.**

There is **no `"all"` sentinel** (P1.3): (A) writes real ids into the Set.
So "select all matching, then untick one item on page 2" is a plain
`Set.delete`, and (A)'s own display state is **derived** —
`selectedMatching === matching`
([BulkItemPicker.tsx:145-147](../../components/iap-management/item-picker/BulkItemPicker.tsx#L145-L147)) —
so it becomes *partial* automatically, with no code to write.

⇒ **Proposal:** keep it that way, and **pin it with a test** so nobody
"optimises" the Set into a sentinel later. The brief's warning ("bỏ tick MỘT
item khi đang select-all phải chuyển sentinel thành danh sách thật — đó là chỗ
dễ mất lựa chọn nhất") is correct in general and **already structurally
prevented here**. That is worth a test, precisely because it is currently true
by accident of a good decision rather than by a guard.

With (A) re-shaped as a button (§2.1), its label reads `Clear all 197` only
when all 197 are selected; at 196 it reads `Select all 197 matching`, and the
counter shows `196 selected · 197 matching`.

## 2.4 — Page size changed mid-selection — brief §2.3

`selected` is untouched (it is ids, M1). What moves is the viewport.

**Proposal: anchor on the first row currently visible**, rather than keeping the
page number:

```
newPage = floor(oldStartIndex / newPageSize) + 1        // then let
                                                        // computePageMeta clamp
```

At 220 items, page 7 of 11 at size 20 (`startIndex = 120`) → size 50 →
`floor(120/50)+1 = 3` of 5. The Manager keeps looking at roughly the same rows.

**⚠ Alternative considered and rejected: reset to page 1** (mirroring the facet
reset at [IapListClient.tsx:253-260](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L253-L260)).
The facet reset is right because the *result set* changed. Here the result set
is **identical** and only the window changed, so throwing the Manager to the
top is a pure loss.

**⚠ Without the anchor, `computePageMeta`'s clamp is what you get instead**
([page-slice.ts:37](../../lib/iap-management/pagination/page-slice.ts#L37)): page 7 → totalPages 5 → clamped to 5. Not a crash, not
a lost selection — just a silent jump to the wrong end of the list. Worth
choosing deliberately.

**Pinned by test** (brief explicitly asks): change 20 → 50 mid-selection ⇒
`selected` byte-identical · `N on this page` recomputed · (B)'s tri-state
recomputed · page anchored.

**Page sizes:** 20 / 30 / 50 (M6). ⚠ Note this makes the picker the **first**
surface in the module with a page-size selector — the outer table's `PAGE_SIZE`
is a constant (P1.7). Q4 asks whether the outer table should get one too, or
deliberately not.

## 2.5 — Shift-click ACROSS a page boundary — brief §2.4

**Proposal: DO NOT support it, and SAY SO — never fail silently.**

**Why not:**
1. **It is the silent-drop class.** The rows between an anchor on page 1 and a
   target on page 2 are rows the Manager **never saw**. Selecting them is
   "đang chọn ≠ đang thấy" in its purest form.
2. **It costs money at Apple** (P1.6). An accidental 60-row cross-page range is
   ~180 requests.
3. **Familiar apps do not do it.** Finder / Explorer / Gmail ranges live inside
   one rendered list; Gmail drops the anchor when the page changes.
4. **There is already a better tool for a bigger group** — raise the page size
   to 50, or search + (A).

**Design:** **a page flip clears the shift anchor.** If the Manager
shift-clicks with no anchor on this page, the click behaves as an ordinary tick
**and** a one-line hint appears under the list:

> Shift-click selects a range **within one page**. For a bigger group, raise
> the page size or use *Select all matching*.

⚠ The hint is the point. The rejected alternative is to let the shift-click
silently degrade to a single tick — which is a control that quietly did less
than the Manager asked, i.e. the same defect class in miniature.

## 2.6 — Shift-click semantics — brief §2.5 + §2.6

### §2.5 — while searching: consistent with M5, **by construction**

The range is computed over the **currently rendered page slice**, and that
slice is already post-facet → post-search → post-page (P1.8). So:

```
range = pageRows.slice(min(i, j), max(i, j) + 1)
```

⇒ The invariant is *"the range is exactly the rows between the two clicks, as
displayed"*. There is no second definition to keep in sync, and no way for the
range to reach a row the search has hidden. ✅ **Confirmed.**

### §2.6 — "select the range" or "toggle the range"?

**Proposal: the range is SET to selected — additive, never toggling.**

```
for (const row of range) next.add(row.appleIapId)
```

**Reference behaviour, stated honestly rather than hand-waved:**

| Source | Shift-click on a list | Applicable? |
|---|---|---|
| macOS Finder / Windows Explorer | extends the range and **REPLACES** the whole selection | ❌ **disqualified by M1** (cumulative selection). These are selection-first lists, not checkbox lists. |
| **Gmail (checkbox list)** | **adds** the range; nothing outside the range is disturbed | ✅ **the closest analogue, and the model proposed** |
| GitHub file-tree / Jira issue lists | same as Gmail | ✅ corroborates |

**Why additive beats toggling.** Toggling makes the outcome depend on the prior
state of rows *in the middle*, which the Manager may never have looked at — so
the same gesture yields different results for reasons that are off-screen. On
Apple, an unpredictable **un**-tick is a row silently missing from the file.
Additive is idempotent: shift-click twice, same result.

**Consequences to accept, stated:**
- Shift-click on an already-ticked anchor still **adds** (no-op-ish, never
  clears).
- **⚠ You cannot undo a range with another shift-click.** That is a real
  ergonomic cost of the additive rule. The mitigation already exists in this
  design: (B)'s checked state is `Clear N on this page`, one click away (§2.2).
  Manager may prefer toggling for undo — Q3.
- **The anchor** = the last row whose checkbox was clicked **without** Shift, on
  the current page. Cleared by: page flip · page-size change · search change ·
  facet change. *(All four change what "between" means.)*
- One modifier only. **No Ctrl/Cmd variants.**

## 2.7 — M4's mandatory consequence: reviewing picks that are out of view

M4 makes this unavoidable: the counter can read `12 selected` while none of
those 12 is on screen. **Proposal, for the Manager to choose — not decided:**

**A "Selected only" view toggle in the toolbar** — `Showing: All | Selected (12)`.

- It is a **filter over the same selection set**: no new state beyond a boolean,
  no new arithmetic, reuses the same pagination and the same rows.
- It is the only option that answers *"show me my 12"* without inventing a
  panel, and it works at 12 or at 300.

**Alternatives considered, and why weaker:**

| Option | Why not |
|---|---|
| A chips/token strip of selected product ids | unreadable past ~10; pushes the list off screen at exactly the sizes that need it |
| A "review selection" step 1.5 in the wizard | a whole wizard step for what is really a filter |
| Tooltip on the counter | not scannable, not keyboard reachable, invisible on touch |

**⚠ One interaction it must get right.** With *Selected only* **on**, every
rendered row is already ticked, so (B) can only sensibly mean **clear**. Two
candidates: (i) (B) renders checked with the label `Clear 12 on this page`
(consistent with §2.2's state table, zero special-casing); or (ii) (B) is
**disabled** while the toggle is on. (i) is proposed for having no special case
— **Q5**.

## 2.8 — The controls: one `PageNav`, not two

**Proposal:** extract `components/ui/iap/PageNav.tsx` — a purely presentational
Prev / `Page X of Y` / Next plus a `Showing A–B of C` line, driven entirely by
a `PageMeta` — and **adopt it in the outer table in the same commit**
([IapListClient.tsx:948-999](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.tsx#L948-L999)).

**Why in the same commit, and not "later".** This is the P1 twin-path rule
applied *before* the second path exists. Adding pagination controls to the
picker while the outer table keeps its inline copy creates two disabled rules,
two "Showing" wordings and two hidden-when-single-page rules — which is
precisely how *"one behaviour, two implementations, drifting apart at the first
fix"* happens ([BulkItemPicker.tsx:7-11](../../components/iap-management/item-picker/BulkItemPicker.tsx#L7-L11)
records the same reasoning for this very picker). A shared choke point is
cheaper now than three patches later.

`components/ui/iap/` is the established home for this module's shared
presentational primitives (`DataTable`, `SectionShell`, `StatusDot`, …).

## 2.9 — Where the state lives

**⚠ Follow the existing ownership rule, do not change it.** `BulkItemPicker`
is explicitly **controlled, not owning** —
[BulkItemPicker.tsx:40-43](../../components/iap-management/item-picker/BulkItemPicker.tsx#L40-L43):
*"STATE IS CONTROLLED, NOT OWNED. `query` and `windowSize` come from the
caller."*

⇒ `page`, `pageSize`, `anchorIndex` and `viewMode` are **props + callbacks**,
owned by each caller, exactly like `query` and `windowSize`. Both callers keep
their own resets in their own `reset()`/`handleClose`, where they already are.

**⚠ Consequence for A′ (the write surface), and it is the main integration
risk.** Every new prop lands on `AvailabilitiesBulkModal` too
([:1081-1091](../../components/iap-management/AvailabilitiesBulkModal.tsx#L1081-L1091)).
Two ways forward — **Q2**:

| | Approach | Pros | Cons |
|---|---|---|---|
| **(i)** | **Both surfaces get pagination + range.** One picker, one behaviour. | no divergence; A′ has the same 200+ item problem; honours the P1 shared-choke-point rule | touches a **write** path where a mis-scoped bulk control changes what sells where — needs its own UAT, and A′ has 5 test files |
| **(ii)** | **Export only**; A′ keeps the window via a `paged?: boolean` prop. | blast radius stays on the read path | a flag on a shared component is the beginning of two behaviours in one file; A′'s Manager pain goes unaddressed |

**Recommend (i)**, because the P1 rule says a shared choke point beats two
patches and because A′ has the identical problem — **but (ii) is the
conservative call and the write path is the one that cannot be undone by
re-running.** Manager's decision, not mine.

## 2.10 — Acceptance: the assertions that can actually FAIL

Vacuous tests are the failure mode here — a test that passes both with and
without the feature. Each of these fails if its guarantee breaks:

1. **The payload is still the ticked set.** Tick 2 on page 1, page to 3, tick 1
   ⇒ POST body `selectedIds` has exactly those 3. *(Fails if paging touches
   selection.)*
2. **M1 across pages.** (B) on page 2 ⇒ page 1's picks intact.
3. **M2 divergence is on screen.** Tick 5 on page 1, page to 4 ⇒ counter reads
   `5 selected · 0 on this page`. *(⚠ The vacuity guard: it must read **0** on
   this page, not be absent.)*
4. **M3.** Search matches an item on page 4 of the unsearched list ⇒ it appears
   on page 1 of the searched list.
5. **M4.** Search → tick → clear search ⇒ still ticked, and the counter says so.
6. **M5.** (B) while searching ⇒ ticks the filtered page's rows only.
7. **(A) ≠ (B).** With 197 matching and page size 20: (B) ⇒ `selected.size === 20`;
   (A) ⇒ `197`. *(Fails on any scope confusion — the M7 money test.)*
8. **No sentinel.** (A), then untick one on page 2 ⇒ `selected.size === 196`
   and (A) reads partial. *(Fails if anyone converts the Set to a sentinel.)*
9. **Page-size anchor.** §2.4's arithmetic, and `selected` unchanged.
10. **Range is within-page only.** Anchor last row of page 1, page to 2,
    shift-click ⇒ **one** row added, and the hint renders. *(⚠ Fails if a
    cross-page range silently sweeps.)*
11. **Range is additive.** Range over rows where the middle is already ticked
    ⇒ nothing is un-ticked.
12. **Range respects the search.** Search, then range ⇒ only filtered rows.
13. **Still ZERO Apple requests.** ⚠ An **absence** assertion — the existing
    `fetchSpy` pattern
    ([export-wizard.test.tsx:158-192](../../app/(dashboard)/iap-management/apps/%5BappId%5D/IapListClient.export-wizard.test.tsx#L158-L192)) —
    extended to page flips, page-size changes and range clicks. *This is the
    one that fails when someone "helpfully" adds a fetch.*
14. **A′ is unchanged** (if Q2 = (ii)) or **A′ behaves identically** (if
    Q2 = (i)) — its 5 existing test files must stay green either way.

---

# PART 3 — FEASIBILITY + PROS / CONS

## 3.1 — ⚠ THE BIGGEST RISK, NAMED FIRST

**Pagination makes "ĐANG THẤY" ≠ "ĐANG CHỌN" in a NEW DIRECTION.**

Today the window is **monotone**. It only grows. A row the Manager has once
seen **cannot leave the screen**, so the only divergence possible is *"not yet
shown"* — and that one is already covered, twice, with visible counts
([BulkItemPicker.tsx:201-210](../../components/iap-management/item-picker/BulkItemPicker.tsx#L201-L210),
[ExportItemWizard.tsx:437-451](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L437-L451)).

With pages, **a ticked row can go off-screen by paging away.** Divergence
becomes bidirectional. This is the same error class the Google arc just spent
five chunks removing
(`[GOOGLE-export-intersection-silent-drop]`, [TODO.md:673](../../TODO.md)):
a control or a file that quietly omits what was asked for.

**Every mitigation in this design exists for this one risk:**

| Mitigation | § | Answers |
|---|---|---|
| M2 two-tier counter, always on screen, showing `0 on this page` explicitly | 2.10 #3 | "my picks left the screen" |
| (A) re-shaped into a labelled button — the two scopes are no longer the same kind of control | 2.1 | the M7 mis-click |
| (B)'s label changes with its state (`Select all 20 on this page` / `Clear 20…`) | 2.2 | "what will this click do" |
| Shift-click refuses to cross a page **and says so** | 2.5 | "it selected rows I never saw" |
| "Selected only" view | 2.7 | "show me what I actually picked" |
| Test #7 (197 vs 20) and #10 (cross-page) | 2.10 | regression |

⚠ **And the prior design's objection is not answered by any amount of copy**
(§1.9). It is answered only by (A) and (B) being **different kinds of control**.
If the Manager keeps (A) as a checkbox, this risk stays open and the mitigation
list above is one item short.

## 3.2 — Three directions, compared

Baseline for the action counts: an app of **220 items**, page size **50**,
current behaviour = window 60 + "Show more".

| | **(1) Pagination only** | **(2) Shift-click only** | **(3) BOTH** |
|---|---|---|---|
| **Code files changed** | `BulkItemPicker` · `ExportItemWizard` · `AvailabilitiesBulkModal` · `IapListClient` (adopt PageNav) · **+1 new** `PageNav` | `BulkItemPicker` · `ExportItemWizard` · `AvailabilitiesBulkModal` | union: **4 + 1 new** |
| | ~4 + 1 | ~3 | ~5 |
| **Touches a P8 shared (Apple/Google) component?** | **NO** — `BulkItemPicker` is Apple-only; `ExportOptionsDialog` untouched (P1.1) | **NO** | **NO** |
| **Touches an Apple-internal shared component?** | **YES** — `BulkItemPicker` also serves A′, the availability **write** path (P1.1, Q2) | **YES**, same | **YES**, same |
| **New state** | `page`, `pageSize` (+4 reset rules) | `anchorIndex` (+4 clear rules) | 3 (+ "page flip clears the anchor") |
| **Silent-drop risk** | ⚠ **HIGH if careless, LOW if designed.** Introduces the new divergence direction (§3.1). Risk is concentrated in **labelling** (A)/(B) | ✅ **LOW.** Cannot reach an unrendered row, so cannot select something unseen. Failure mode is over-selection **in view** — immediately visible | ⚠ (1)'s risk + one boundary case (§2.5), closed by refusing it loudly |
| **Apple request cost of the mechanism** | **0** | **0** | **0** |
| **Indirect request effect** | better *finding* ⇒ tighter picks ⇒ fewer requests at 3/item | better *picking* ⇒ same | both |
| **"30 ADJACENT items"** (the Manager's case) | ~**30 ticks** + ≤1 flip. (B) helps only if the group == a page | tick + shift-tick = **2**, but +2-3 "Show more" first to *reach* row 150-180 ⇒ **4-5** | ≤4 flips + tick + shift-tick = **≤6**, and **2** if already on the page — *and the Manager can SEE where they are* |
| **"30 SCATTERED items"** | ~30 ticks + ≤4 flips ≈ **34** | 30 ticks + 2-3 "Show more" ≈ **33** | ≈ **34** |
| **Solves "see the items in a 200+ app"** | ✅ **yes — this is its job** | ❌ no. Still "Show more" ×3 to reach row 180 | ✅ |
| **Solves "chọn một NHÓM without clicking each"** | ⚠ only when the group happens to equal a page | ✅ **yes, and criteria-agnostic** — the criterion is "these, here" | ✅ |
| **Test surface** | pagination + resets + (A)/(B) scope + anchor | anchor lifecycle + range + additive + search | all, + one interaction test |

### ⚠ The scattered case: an honest non-claim

**Neither (1) nor (2) reduces the click count for 30 scattered items.** ~30
ticks is ~30 ticks. What they improve is *finding* and *orientation*
(`Page 3 of 5` beats scrolling 220 rows). For genuinely scattered picks the
real lever is **search + facets + (A)**, which already ships. Any claim that
this arc speeds up the scattered case would be false, so the design does not
make it, and the UI must not imply it.

### 3.3 — Verdict, and what it rests on

**(3) BOTH — feasible, and the Manager's reasoning holds.** They solve two
different halves, and the census confirms both halves are real:

- **(1) is the "see it" half.** A 220-item app renders 60 rows and needs 3
  "Show more" clicks to reach row 180.
- **(2) is the "pick it" half**, and it is the one that answers the Manager's
  words *"chọn một NHÓM mà không phải click từng item"* under an **unfixed
  criterion** — which is exactly why search + select-all-matching cannot
  replace it.

⚠ **A refinement on the Manager's fallback.** The brief says: if (2) is
infeasible, do (1) first. **(2) is feasible** (P1.8) — no virtualisation,
provably stable order, ~3 files, and the *lower*-risk of the two. So if effort
ever has to be split, the ordering worth reconsidering is **(2) first**: it
delivers more of the stated need per unit of risk. Both in one arc remains the
recommendation; the two interact in exactly one line (a page flip clears the
anchor) and one test.

---

# PART 4 — MOCKUP

`docs/iap-management/design/export-picker-paging-mockup.html`

Apple design language, read from the shipped components rather than assumed:

| Token | Value | Source |
|---|---|---|
| Primary button | `#0c447c` (hover `#0d4f8f`) | [ExportItemWizard.tsx:553](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L553) |
| Link / accent / `accent-color` | `#0071E3` | [BulkItemPicker.tsx:248](../../components/iap-management/item-picker/BulkItemPicker.tsx#L248) |
| Surfaces, borders, text | slate scale (`#f8fafc` / `#e2e8f0` / `#334155` / `#64748b`) | existing mockup + components |
| Divergence / caution | amber (`#fffbeb` / `#fde68a` / `#92400e`) | [BulkItemPicker.tsx:204](../../components/iap-management/item-picker/BulkItemPicker.tsx#L204) |
| Emerald | **badge-only** (`Available`) — ⚠ never a primary surface. Google's palette leads with emerald; Apple's does not | [ExportItemWizard.tsx:585](../../components/iap-management/export-wizard/ExportItemWizard.tsx#L585) |

States rendered (all required by the brief): page 1 · a middle page · the last
page · a partially-ticked page (indeterminate) · **picks on another page (the
two counters diverging)** · search active · (A) fully selected · a shift-click
range mid-selection · plus the proposed **"Selected only"** review view (§2.7).

---

# PART 5 — WHAT THE MANAGER NEEDS TO DECIDE

Each has a recommendation and a reason. **None is decided.**

### Q1 — Re-shape (A) from a checkbox into a labelled button? *(§2.1)*
**Recommend: YES.** Đây là câu trả lời DUY NHẤT bằng cấu trúc cho M7. Hai
checkbox giống hệt nhau, khác phạm vi 10× ⇒ bấm nhầm tốn ~3 request/item
(P1.6). Đổi *hình thức* của (A) (giữ nguyên 100% semantics) làm phạm vi đọc
được từ **vị trí**, không phải từ trí nhớ. **Giá phải trả:** mất trạng thái
`indeterminate` của (A) ⇒ bộ đếm hai tầng (M2) trở thành bắt buộc.
*Nếu Manager giữ (A) là checkbox, rủi ro §3.1 vẫn mở.*

### Q2 — Does A′ (the availability WRITE modal) get the same treatment? *(§2.9)*
**Recommend: (i) YES, cả hai surface** — P1 nói một choke point dùng chung hơn
hai bản vá, và A′ có đúng vấn đề 200+ item. **⚠ Nhưng A′ là đường GHI**: bulk
control sai phạm vi ở đó đổi *hàng đang bán ở nước nào*, không undo được bằng
cách chạy lại. **(ii)** giới hạn ở export bằng `paged?: boolean` là lựa chọn
bảo thủ, đổi lấy một flag trên component dùng chung. **Manager chốt — đây là
quyết định về rủi ro, không phải về code.**

### Q3 — Shift-click: additive, or toggle? *(§2.6)*
**Recommend: ADDITIVE** (Gmail model; Finder/Explorer "replace" bị M1 loại
thẳng). Toggle làm kết quả phụ thuộc trạng thái các dòng **ở giữa** mà Manager
có thể chưa xem ⇒ un-tick không đoán được = dòng thiếu trong file.
**Giá phải trả:** không undo được dải bằng một shift-click nữa — bù bằng (B)
`Clear N on this page`, cách một click (§2.2).

### Q4 — Page size: picker only, or the outer table too? *(§2.4)*
**Recommend: picker only for now.** M6 chốt 20/30/50 cho picker. Bảng ngoài
đang `PAGE_SIZE = 100` cố định (P1.7) và chưa ai phàn nàn; thêm selector ở đó
là mở rộng scope không ai yêu cầu. ⚠ Ghi nhận: sau arc này hai surface sẽ
**không đối xứng** — có ý thức, không phải bỏ sót.

### Q5 — "Selected only" review view — ship it, and how does (B) behave there? *(§2.7)*
**Recommend: ship it** — M4 làm nó bắt buộc: bộ đếm có thể nói `12 selected`
mà không dòng nào trong 12 đó nằm trên màn. Nó là **filter trên cùng một tập
lựa chọn**, không thêm state nào ngoài một boolean.
Khi bật, (B) chỉ còn nghĩa "clear": **recommend (i)** — (B) hiện `checked` với
nhãn `Clear 12 on this page` (đúng bảng trạng thái §2.2, không special-case).
Phương án (ii) là disable (B).

### Q6 — Fix the reopen defect in this arc, or file it? *(P1.3(e))*
**Recommend: fix it here.** Sau khi export xong, mở lại *Export list* rơi thẳng
vào **step 2** với lựa chọn cũ còn nguyên — Manager không thấy màn chọn item.
Fix là gọi `reset()` trong `handleConfirmExport`, hoặc thêm reset-on-open; ~3
dòng + 1 test. Arc này sẽ sửa đúng vùng state đó. ⚠ Nếu Manager muốn arc sạch
một chủ đề, tách ra thành entry TODO riêng — nhưng **đừng để nó không được ghi
lại ở đâu.**

### Q7 — Page-size change: anchor the viewport, or reset to page 1? *(§2.4)*
**Recommend: ANCHOR** (`floor(oldStartIndex / newPageSize) + 1`). Đổi page size
**không** đổi tập kết quả, chỉ đổi cửa sổ — nên đẩy Manager về đầu danh sách là
mất mát không được bù. Nếu không chọn gì, hành vi mặc định là clamp của
`computePageMeta` ([page-slice.ts:37](../../lib/iap-management/pagination/page-slice.ts#L37)): nhảy về trang cuối, im lặng.

---

## Appendix — commands run for this census

```
git rev-list --left-right --count HEAD...origin/main   → 0 0   (clean boundary)
grep -rn "Show more" --include=*.tsx .                 → Apple copy ≠ Google copy
grep -rn "shiftKey" --include=*.tsx --include=*.ts .   → NO match (no precedent anywhere)
grep -n "virtual\|react-window" package.json           → NO match (no virtualisation)
grep -c useEffect ExportItemWizard.tsx                 → 0      (no reset-on-open)
grep -rln "pagination/page-slice"                      → 4 consumers (already shared)
grep -rn "BulkItemPicker" --include=*.tsx              → 2 consumers, both Apple
grep -n "sortBy\|onSort" IapListClient.tsx             → none   (order is stable)
grep -i "reopen" IapListClient.export-wizard.test.tsx  → NO match
```

**Nothing in this census was unreadable.** No item requires a Manager DB query —
every fact above is in the repository, and the two runtime unknowns that would
need data (Apple's real per-hour budget, and item counts per app in production)
are **not needed for this decision**: no option here changes request cost.
