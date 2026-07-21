# Design: VNGGames Hub Run Tracking for "Set Availabilities" + "Remove from Sales"

Status: **Investigation + design for review — NO CODE WRITTEN.** Hold for
Manager sign-off before a build prompt.

6th + 7th Hub-tracking integrations, in ship order: (1) Apple IAP Bulk
Import (`95d9413`), (2) Google IAP Bulk Import (`1663a37`/`ce169a8`), (3)
Apple IAP Submit-batch (`867386a`), (4) CPP Bulk Import (`ccf45b2`), (5)
Google IAP Bulk Activate/Deactivate (`1fb3f7e`/`2e710d3`,
`docs/google-iap-management/design-bulk-status-hub-tracking.md`). This
doc covers (6) Apple "Set Availabilities" and (7) Apple "Remove from
Sales" — **same module** as (1)/(3), so this is intra-module reuse of
`lib/iap-management/hub-tracking/*`, the same relationship (5) has to
(2), not the inter-module relationship (4) has to (1).

Meta-rules cited (`docs/iap-management/IAP-MANAGEMENT-KNOWLEDGE-BASE.md`
§10.13.K): **P5** (status principle), **P6** (no-cache-cold-path), **P7**
(missed signal over a wrong one), **P8** (twin-structure asymmetry),
**P9** (design-first pays off where a feature looks like a proven
pattern), **P10** (finalize-in-finally + mutation-check), **P11**
(finalize-placement-by-orchestration-locus), **P12** (permanent-
committed-ref cancel guard).

**Stale-KB note confirmed**: the KB (commit `f81032c`) lists availability
editing as deferred/backlog. The code below proves that's stale — both
bulk operations are fully built (Cycle 39 Phase 2 Unit C) and shipped.
This doc supersedes that KB entry; the KB's §10.4/§10.10 deferred marker
should be corrected in a follow-up doc pass, not in this design.

---

## 1. Investigation findings (evidence-backed)

### 1.1 Both operations exist, share ONE component/route/orchestrator — not two flows

- **Item-list trigger**: `IapListClient.tsx:404` (`setBulkMode("set-all")`,
  button "Set Availabilities") and `IapListClient.tsx:413`
  (`setBulkMode("remove")`, button "Remove from Sales"). Single
  `bulkMode: BulkMode | null` state (`IapListClient.tsx:150`); the modal
  mounts conditionally, `{bulkMode !== null && (<AvailabilitiesBulkModal
  mode={bulkMode} .../>)}` (`IapListClient.tsx:803-810`) — **a true
  conditional mount/unmount**, not a Google-style always-mounted
  `open`-prop toggle. This matters for the cancel-guard design (§C).
- **One component, mode-parameterized**: `AvailabilitiesBulkModal.tsx`
  (`BulkMode = "set-all" | "remove"`, line 34). `onPrimaryClick()`
  (`:256-262`): `if (mode === "remove") setConfirmOpen(true); else void
  submit();` — exactly the Google `BulkStatusModal.onPrimaryClick` shape
  (destructive branch opens a dialog, non-destructive submits directly).
- **One API route, mode-parameterized**: `POST
  /api/iap-management/iaps/bulk-availability`
  (`app/api/iap-management/iaps/bulk-availability/route.ts`). Body `{
  iapIds: string[], action: "set-all" | "remove" }` (zod schema
  `route.ts:35-38`). Single `try/catch` around session + body parsing,
  then one unguarded `await executeBulkAvailability(...)` (`route.ts:78-83`)
  and a direct `NextResponse.json(outcome)` return — **no `try/finally`
  exists today.**
- **One orchestrator, mode-parameterized**: `executeBulkAvailability`
  (`lib/iap-management/orchestrators/bulk-availability.ts:137-270`) calls
  `setAvailabilityToAllTerritories` or `setAvailabilityRemoveFromSales`
  per row (`:186-189`) based on `action`, inside `withConcurrency`
  (concurrency 2) with a per-row `try/catch` (`:184-224`).
- **Real Apple endpoint (verified, not assumed)**:
  `lib/iap-management/apple/availabilities.ts:107-133` and `:152-177` —
  **both** "Set Availabilities" and "Remove from Sales" call the exact
  same Apple endpoint, `POST /v1/inAppPurchaseAvailabilities`, differing
  only in payload: `availableInNewTerritories: true` + the full territory
  list (`setAvailabilityToAllTerritories`) vs. `false` + an empty
  `availableTerritories.data: []` (`setAvailabilityRemoveFromSales`). The
  file's own header comment (`:135-151`) confirms Apple's API has no
  DELETE/PATCH on this resource — "remove" is a re-POST with an empty
  territory list, verified against `openapi.oas.json`. This is **not**
  `inAppPurchaseSubmissions` or any state-transition endpoint — it is the
  availability resource the KB's stale entry named, just now built.

**Conclusion: this is a single shared surface serving both operations,
structurally identical to Google Bulk Activate/Deactivate (5) — not two
independent flows needing separate wiring.** One tracking integration,
parameterized by two feature tags, covers both.

### 1.2 Orchestration locus — single client→server round-trip, no mid-flight pause (P11)

- `AvailabilitiesBulkModal.tsx:194-254` `submit()`: one `fetch` to
  `/api/iap-management/iaps/bulk-availability`, one `await`, renders
  `results` from the same response. No second request, no phase-based
  response shape (contrast submit-batch's `{phase:"conflict"}` — nothing
  like that exists here).
- The route (`route.ts:40-86`) makes exactly one call to
  `executeBulkAvailability` and returns its result directly. No
  conflict-check, no confirm-then-write two-step server-side.

**Per P11: single server-route operation → server-side finalize**,
mirroring Google bulk-status (5) exactly, not submit-batch's (3)
multi-request client-driven shape. Confirmed by reading the actual code,
not inferred from surface similarity (P9).

### 1.3 Reconfirm dialog — asymmetric, exactly like Google activate/deactivate

- `AvailabilitiesBulkModal.tsx:267`: `const destructive = mode ===
  "remove";`
- `:256-262`: only `mode === "remove"` opens `confirmOpen`; `"set-all"`
  calls `submit()` directly in the same synchronous tick.
- `:194-206`: `submit()`'s first statements (`setSubmitting(true)`,
  `setConfirmOpen(false)`) run synchronously before the first `await` (the
  `fetch` call) — for `"set-all"`, this means the write commits
  essentially simultaneously with the button click; there is no
  user-actionable step between START and commit.
- `:452-472`: the outer footer's primary button — X/footer buttons are
  `disabled={submitting}` (`:331`, `:447`) — but **the outer backdrop's
  `onClick={handleClose}` (`:290-294`) has no `submitting` guard at all**
  (it's a bare div `onClick`, not gated). This is the exact P12 trap
  already found once in Google bulk-status (`2e710d3`) and now confirmed
  as a **second, independent instance** in this component — the click is
  reachable regardless of `mode` or `submitting` state.
- `:478-527`: the confirm dialog's own Cancel button (`:512`) and its
  backdrop (`:483`) both call only `setConfirmOpen(false)` — they return
  to the **same still-open modal's selection screen**, not `onClose()`.
  Same UI shape as Google's confirm dialog (declining re-opens the
  selection list without leaving the modal — a Manager could immediately
  re-select and re-submit, which must start a **new** Hub run).
- **No `beforeunload` handler exists in this component today** (confirmed
  by grep — zero matches in `AvailabilitiesBulkModal.tsx`, contrast
  `BulkImportWizard.tsx:218` which already has one). Net-new for both
  operations.

**Per-operation trigger + cancel window, stated separately:**

| | Set Availabilities (`mode="set-all"`) | Remove from Sales (`mode="remove"`) |
|---|---|---|
| START trigger | `onPrimaryClick()` click → `submit()` called directly, same tick | Same `onPrimaryClick()` click → opens `confirmOpen` (`:257-258`) |
| Cancel-eligible window | None in practice — `submit()`'s sync prefix (incl. `setSubmitting(true)`) runs to completion before any subsequent click can be processed (single-threaded JS); the backdrop-click gap exists in theory but the write is already committed by the time it's reachable | From `confirmOpen=true` until the dialog's "Confirm" button (`:519`) invokes `submit()`: dialog Cancel (`:512`), dialog backdrop (`:483`), outer modal X/backdrop while dialog is showing (`:290-294`, `:330-336`, unguarded — see above), `beforeunload` (net-new) |
| Write-commit boundary | `submit()`'s `setSubmitting(true)` (`:206`), same tick as START | Same line, but only reached from the Confirm click (`:519`) |

This is the **same asymmetry** §1.2 of the Google bulk-status doc found
between activate/deactivate — re-verified against this component's actual
code, not assumed to transfer (P8/P9).

### 1.4 Per-item results — already the exact shape needed for PARTIAL (P5 gate)

- `BulkAvailabilityOutcome` (`bulk-availability.ts:121-135`): `{ total,
  succeeded, failed, results: BulkAvailabilityRowResult[], overall,
  summary, rate_limit_total }`. `succeeded`/`failed` (`:228-229`) are
  computed by filtering the SAME `results` array the route returns
  verbatim (`route.ts:85`) and the modal renders row-by-row via
  `ProgressList` (`AvailabilitiesBulkModal.tsx:633-666`). No second/derived
  count — confirmed same pattern as Google's §1.6 finding.
- Zero-eligible: the zod schema requires `iapIds.min(1)`
  (`route.ts:36`) — an empty selection is rejected as a 400 **before**
  `executeBulkAvailability` runs (the modal's primary button is also
  `disabled` when `selected.size === 0`, `:456-461`, so this shouldn't
  occur via the UI). `executeBulkAvailability` itself has a defensive
  `iapIds.length === 0` branch (`:142-153`) returning `overall: "NO_OP"`,
  `{total:0, succeeded:0, failed:0}` — feeds `computeBulkImportTerminalStatus`
  as `failed===0` → **SUCCESS**, matching locked decision 5 and the
  Bulk-Import/Google `NO_OP`→SUCCESS precedent exactly.
- Note the app's own `overall` enum (`SUCCESS | PARTIAL | FAILURE | NO_OP`,
  `:129`) is a **different, pre-existing** value set from
  `HubTerminalStatus` (`SUCCESS | FAILED | CANCELLED | PARTIAL`) — do not
  conflate `"FAILURE"` (app) with `"FAILED"` (Hub); the mapping function
  produces the Hub's own vocabulary independently from `{total, succeeded,
  failed}`, not by relabeling `overall`.

**Confirmed: the per-item done/error set already exists and is exactly
what the modal renders — the PARTIAL gate is satisfied with zero new
plumbing.**

### 1.5 Reuse map — the Apple hub-tracking lib is reusable, but **NOT feature-tag-parameterized today** (critical finding for Q6)

| Asset | Reusable as-is? | Finding |
|---|---|---|
| `hub-tracking/config.ts` | **Yes, fully** | Generic singleton-row reader, no feature concept — decision 1 confirmed compatible. |
| `hub-tracking/hub-client.ts` (`hubStartRun`, `hubCloseRun`) | Functionally yes, **hardcodes the tag** | `hub-client.ts:68` — `const LOG_FEATURE = "iap-hub-tracking";`, a module-level constant, not a parameter, used in every `log()` call in both functions. |
| `hub-tracking/tracking.ts` (`startBulkImportTracking`, `finalizeHubTracking`) | **Logic yes, tag no** | `tracking.ts:21` — same hardcoded `LOG_FEATURE = "iap-hub-tracking"`. Function bodies are pure pass-throughs (`getHubTrackingGate` + `hubStartRun`/`hubCloseRun`) — nothing Bulk-Import-specific in the logic itself, only the name and the tag. |
| `hub-tracking/status-mapping.ts` (`computeBulkImportTerminalStatus`) | **Yes, drop-in** | Already generic (`{total,succeeded,failed} → status`), confirmed by its own doc comment and by submit-batch's design doc (§0) reusing it verbatim. `BulkAvailabilityOutcome` already carries exactly these three fields. |
| `app/api/iap-management/hub-tracking/start/route.ts` | **Path reusable; signature needs to change** | `start/route.ts:20` — `export async function POST() {` **takes no `Request` parameter at all** (stronger than Google's finding, where the route at least received a body but ignored it). Calls `startBulkImportTracking(session.user.email)` unconditionally — no way to pass a feature/tag through today. |
| `app/api/iap-management/hub-tracking/cancel/route.ts` | **Path reusable; body ignores any extra field but doesn't reject it** | `cancel/route.ts:23-46` — parses `{run_id}` only from a leniently-parsed body; calls `finalizeHubTracking(runId, "CANCELLED")` with no tag argument. Adding an extra field to the body is additive/non-breaking already (unknown fields are silently ignored), but the handler must be changed to *read and use* it. |
| `app/api/iap-management/hub-tracking/config/route.ts` | **Yes, unchanged** | Feature-agnostic, matches decision 1. |

**This directly answers the brief's "is the tag already parameterized"
question: NO, not at the lib/route level.** Submit-batch's distinct
`"iap-submit-hub-tracking"` tag (`submit-tracking.ts:28`) was achieved by
a **different mechanism** than Google's later fix — not by parameterizing
`hub-client.ts`/`tracking.ts`, but by wrapping them in a **new sibling
module** (`submit-tracking.ts`) that logs its own ATTEMPT/OUTCOME lines
under the new tag *around* calls to the still-hardcoded-tag generic
functions (`submit-tracking.ts:49`, `:79`: `startBulkImportTracking(...)`
/ `finalizeHubTracking(...)` called directly, unmodified). The result is
**dual-tagged** logs for Submit (both `iap-submit-hub-tracking` and
`iap-hub-tracking` lines appear for the same run) — this works because
submit-batch's finalize call sites are all **server-side direct function
calls** inside `submit-batch/route.ts`, never through the `/start`/
`/cancel` HTTP routes (Submit's START also fires server-side, at the
first `execute:true` POST, per `design-iap-submit-hub-tracking.md` §2 —
it never goes through the client-facing `/hub-tracking/start` route at
all).

**Why this matters for Set Availabilities / Remove from Sales**: per
locked decision 3, START must fire **client-side** at the button click.
A client-side START has no choice but to go through the HTTP
`/hub-tracking/start` route (there's no server-side moment to hang it on
before the write request is even sent) — so the wrapper-module trick
submit-tracking.ts used (bypass the routes, call functions directly
server-side) is **not available** here. The route itself must learn to
carry a feature tag. This is the real, unavoidable prerequisite — not
"just new wiring on top" — mirroring Google's finding in its own §1.3
almost exactly, arrived at independently from Apple's own code shape.

### 1.6 Race check — same shape as Google/CPP, asymmetric dwell time confirmed

- Because `hub_run_id` must be **threaded into** the write call (not
  fire-and-forget), an unresolved `/start` at click-time must never block
  the write or wrongly cancel it — same `ce169a8`/Google-R4 shape.
- **Set Availabilities**: START and write-commit are the same tick
  (§1.3) — the bounded-cap race (`Promise.race([startPromise, ~1s
  cap])`) is load-bearing here, not a defensive nicety; in the common
  case the write will proceed with `hub_run_id: null` unless the Hub
  responds unusually fast. Per P7/Google-R4: if `/start` resolves *after*
  the write already proceeded untracked, best-effort **cancel** the late
  run rather than adopting it — reuse the exact continuation shape
  Google's `2e710d3` added (`capExpiredRef` equivalent), not the older
  "drop it silently" version, since that's the refinement Manager already
  approved once for this exact race shape.
- **Remove from Sales**: START fires at the first click (opens
  `confirmOpen`); real dwell time exists while the reconfirm dialog is
  showing, so `/start` will very likely have resolved by the time
  "Confirm" is clicked — same relative timing Google found for
  deactivate. No design change needed, just confirmation the pattern
  degrades gracefully to "arbitrarily short gap" (Set Availabilities) as
  well as "typical dialog dwell" (Remove from Sales).

---

## 2. Design

### A. Finalize-placement recommendation

**Server-side**, inside `app/api/iap-management/iaps/bulk-availability/route.ts`,
wrapping the existing body in a `try { ... } finally { await
finalizeAvailabilityHubTracking(tracking.runId, tracking.status,
tracking.errorMessage, tag) }` — mirroring
`bulk-activate`/`bulk-deactivate/route.ts`'s `HubTrackingState` shape from
Google's design (5) exactly. Grounded in §1.2: this is a single
client→server round-trip with no mid-flight pause, so there is no
structural reason to finalize client-side (P11) — the same conclusion
Google reached for bulk-status, reached independently here from Apple's
own code (P9). **No standalone `/finalize` route** — `/cancel` remains
the only other closer, same as every prior integration.

### B. Status-mapping table

| Event | Tracking action |
|---|---|
| Click "Set Availabilities" (button, `mode="set-all"`) | **START** — client fires `POST /hub-tracking/start` (tag `"iap-set-availabilities"`), promise raced against ~1s cap, NOT blocking the write |
| Click "Remove from Sales" (button, `mode="remove"`) — opens confirm dialog | **START** — same call, tag `"iap-remove-from-sales"`; write has NOT happened yet |
| Remove-from-Sales confirm dialog: Cancel button / its backdrop | **CANCEL** — `POST /hub-tracking/cancel` (tag threaded), zero Apple writes so far |
| Outer modal close (X / backdrop) while confirm dialog showing, write not yet committed | **CANCEL** — same call; must be gated on the permanent ref, not `submitting` (§C — the unguarded backdrop click is exactly the P12 trap) |
| Tab/browser close while confirm dialog showing, write not yet committed | **CANCEL** — new `beforeunload` + `sendBeacon`, same endpoint |
| Set Availabilities: any close attempt after button click | **No cancel window in practice** (§1.3) — the write has already committed by the time any subsequent user action could fire; wire the same `cancelPendingRun()` helper for structural symmetry (per Google's own precedent of wiring activate's cancel path even though it rarely fires), but it will be a near-permanent no-op |
| Write completes, `failed === 0` (incl. `NO_OP`/zero-eligible) | **SUCCESS** |
| Write completes, `succeeded > 0 && failed > 0` | **PARTIAL** |
| Write completes, `succeeded === 0 && failed > 0`, or the route throws before `executeBulkAvailability` returns, or the 400 body-validation early-return fires | **FAILED** |

Terminal status computed via `computeBulkImportTerminalStatus({total:
outcome.total, succeeded: outcome.succeeded, failed: outcome.failed})`
(§1.4/§1.5 — reused as-is, zero logic changes). `{succeeded, failed,
total}` ride along as `errorMessage`/log context, exactly as every prior
integration does — no Hub PATCH schema change (`docs/integrate-rest-vnggames-hub.md`
only accepts `status` + optional `error_message`).

The batch-level `rate_limit_total` (429 telemetry, `bulk-availability.ts:240-254`)
is **explicitly excluded** from the terminal-status computation — a
throttled-but-eventually-succeeded row is still `ok: true` and
contributes to `succeeded`, matching the precedent Google's design §B set
for the `warning` field (a non-blocking side-signal must not change what
"done" means to the Hub, mirroring P5).

### C. Guard: two-state, permanent-ref-gated, per-operation cancel window

**Two-state** (SUCCESS/PARTIAL/FAILED vs. CANCEL) — §1.2 confirmed no
mid-flight pause exists to model a third state around, for *either*
operation. This differs from submit-batch's three-state guard (that
three-state-ness came specifically from the v2 conflict/partial-fail
Apple-write-then-ask shape, which doesn't exist here).

- `writeStartedRef` (permanent `useRef(false)`, set to `true` as the very
  first statement inside `submit()` — same line as the existing
  `setSubmitting(true)`/`setConfirmOpen(false)` at
  `AvailabilitiesBulkModal.tsx:206-207` — never reset). This is the
  single gate every cancel-trigger site must check, **not** `submitting`
  and **not** `confirmOpen` — because §1.3 already found the outer
  backdrop's `onClick={handleClose}` (`:294`) is reachable regardless of
  either transient flag (P12, confirmed as a *second* real instance of
  this exact trap, independent of Google's).
- `hubRunIdRef` / `hubStartPromiseRef` — hold the current attempt's
  run_id / in-flight `/start` promise, threaded into `submit()`'s fetch
  body as a new `hub_run_id` field (additive to the existing `{iapIds,
  action}` body).
- **Component lifecycle wrinkle unique to this surface** (§1.1): the
  parent conditionally *mounts/unmounts* `AvailabilitiesBulkModal`
  (`bulkMode !== null && (...)`), unlike Google's `BulkStatusModal` which
  stays mounted and toggles an `open` prop. This means `handleClose`
  (`:169-175`) — called from the outer backdrop/X/footer-Close — must
  perform the cancel-eligibility check and fire the cancel POST
  **synchronously, inside `handleClose` itself, before `onClose()` is
  invoked** (which triggers the unmount). A `useEffect` cleanup-based
  approach would be strictly worse here (an unmount is not necessarily a
  user-cancel — `onComplete`'s `router.refresh()` path doesn't unmount,
  but a Manager navigating away entirely would) — the explicit
  `handleClose`/`beforeunload` sites already cover every real exit path,
  so no unmount-effect hook is needed, but note this explicitly since it
  is a real structural difference from Google's always-mounted
  `BulkStatusModal` (P8 — re-verify, don't assume the guard code ports
  byte-for-byte).
- All cancel-trigger sites (confirm-dialog Cancel, confirm-dialog
  backdrop, outer `handleClose` covering X/footer-Close/outer backdrop,
  `beforeunload`) route through one `cancelPendingRun()` helper: no-op if
  `writeStartedRef.current` is true or no run_id is pending; otherwise
  fires `POST /hub-tracking/cancel` (fetch for the three UI paths,
  `sendBeacon` for `beforeunload`) and clears local run_id/promise refs.
- Set Availabilities never has a reason to reach `cancelPendingRun()` in
  practice (§1.3's near-zero window) but is wired identically for
  symmetry, same reasoning Google's design applied to activate.

### D. R1 finalize-in-finally (load-bearing, mutation-check required)

`bulk-availability/route.ts` wraps its entire handler body in `try { ...
} finally { await finalizeAvailabilityHubTracking(tracking.runId,
tracking.status, tracking.errorMessage, tag) }`, with `tracking:
HubTrackingState = { runId, status: "FAILED" }` defaulted exactly as
Google's `bulk-activate`/`bulk-deactivate/route.ts` does:

- `tracking.runId` parsed from the body (new `hub_run_id` field) as early
  as possible — right after zod validation, before `getActiveAccount()`
  — so a credentials-fetch failure (`route.ts:63-76`, currently a bare
  early `return` with no tracking awareness) still closes a real pending
  run as FAILED with that specific reason, instead of leaving it
  `RUNNING`.
- The 400 zod-validation failure (`route.ts:52-61`) happens **before**
  `hub_run_id` can be parsed from a body that failed to parse — same
  accepted gap every prior integration has (an unparseable body carries
  no state to recover), not a regression.
- If `executeBulkAvailability` itself throws unexpectedly (not expected
  in practice — every row failure is caught internally per §1.1/§1.4 —
  same defensive-backstop reasoning as Google's design §D), the `finally`
  still fires with `tracking.status` at its `"FAILED"` default. No
  `PARTIAL`-vs-`FAILED` disambiguation function is needed (mirrors
  Google's finding: the orchestrator doesn't stream partial results back
  incrementally, so an unthrown-exception exit never had a `results`
  array to derive `succeeded>0` from — `"FAILED"` is the only defensible
  default).
- **No `route.test.ts` exists today for `bulk-availability`** (confirmed
  by listing the directory — only `route.ts` itself). The build must add
  one, and per **P10** the acceptance test for R1 is a genuine
  mutation-check: write a test that forces an unexpected throw inside
  `executeBulkAvailability` (or its caller), assert the Hub close still
  fires as FAILED, then deliberately delete the `finally` (or swap it for
  a bare `catch {}`) and confirm that SPECIFIC test now fails — not just
  that the happy-path test suite stays green.

### E. Reuse map — exactly what's reused vs. newly wired

**Reused as-is, zero changes:**
- `iap_mgmt.hub_tracking_config` (DB row, migration, encryption, Settings
  page) — decision 1, no new table.
- `getHubTrackingGate` / `getActiveHubTrackingCredentials` (`config.ts`).
- `hubFetch`, the 3s `AbortController` hard timeout, `HUB_TIMEOUT_MS`
  (`hub-client.ts`'s HTTP layer — only its `LOG_FEATURE` constant needs
  parameterizing, not its request/timeout mechanics).
- `computeBulkImportTerminalStatus` (`status-mapping.ts`) — called with a
  new call site, logic untouched.
- `/hub-tracking/config` route — untouched.

**Minimal new wiring, following Google's (not Submit's) precedent since
START must be client-triggered through the HTTP routes (§1.5):**

1. Parameterize the hardcoded tag through the two layers that actually
   have it (`hub-client.ts:68`, `tracking.ts:21`): both `hubStartRun`/
   `hubCloseRun` and `startBulkImportTracking`/`finalizeHubTracking` gain
   an optional `feature` parameter defaulting to today's
   `"iap-hub-tracking"` string, so Bulk Import's existing calls (which
   pass nothing) are byte-identical in behavior and logs — same
   backward-compatible shape Google's fix used.
2. `app/api/iap-management/hub-tracking/start/route.ts`: change
   `POST()` → `POST(req: Request)`, parse an optional `{ feature?:
   string }` body, thread it through. `app/.../cancel/route.ts`: read the
   same optional `feature` field already tolerated (unknown fields are
   currently silently ignored) and thread it into `finalizeHubTracking`.
   Absent `feature` on either route preserves today's Bulk Import
   behavior exactly (zero client-side changes required there).
3. Two new feature-tag constants: `"iap-set-availabilities"`,
   `"iap-remove-from-sales"` — used only by the new
   `AvailabilitiesBulkModal.tsx` wiring and the `bulk-availability`
   route's finalize call. (Submit-batch's separate `submit-tracking.ts`
   wrapper-module pattern is **not** reused here — it doesn't fit, since
   that pattern exists specifically to let a server-side-only start/
   finalize flow skip the HTTP routes entirely, which isn't this
   surface's shape per §1.5.)
4. `bulk-availability/route.ts`: add `hub_run_id` (optional string) to
   the zod body schema, wrap in `HubTrackingState` + `try/finally` per
   §D, passing the request's own tag (`"iap-set-availabilities"` or
   `"iap-remove-from-sales"`, derived from `body.action` server-side —
   **do not trust a client-sent tag string**, derive it from the already-
   validated `action` enum so a malformed/spoofed tag can't reach the Hub
   API).
5. `AvailabilitiesBulkModal.tsx`: add `writeStartedRef`/`hubRunIdRef`/
   `hubStartPromiseRef` state (§C); fire START at the top of
   `onPrimaryClick()` with the mode-appropriate tag; thread the raced
   run_id into `submit()`'s fetch body as `hub_run_id`; wire
   `cancelPendingRun()` into the confirm dialog's Cancel/backdrop and the
   outer `handleClose`; add a **new** `beforeunload`/`sendBeacon`
   handler (none exists today).

**Explicitly NOT done**: no new migration, no new Settings page, no
duplicate `lib/iap-management/hub-tracking/` tree, no submit-tracking.ts-
style sibling wrapper module (doesn't fit this surface's client-start
shape, see item 3 above), no new Hub PATCH schema fields.

### F. Cross-cutting

- Two feature tags (§E.3), threaded per §E.1-2/4-5 — distinct from Bulk
  Import's `"iap-hub-tracking"` and Submit's `"iap-submit-hub-tracking"`
  in every log line this feature produces.
- `[hub-tracking]` log-line prefix preserved unchanged; token never
  logged — no change to that discipline anywhere in this design.
- 3s `AbortController` hard timeout reused as-is from `hub-client.ts`.
- Config reads: **no cache**, every read hits the DB (P6) — this feature
  adds at most 2 extra reads per bulk action (START, finalize), nowhere
  near a hot path.

### G. Twin-asymmetry note

Two layers of asymmetry to keep distinct, both re-validated against the
actual code rather than assumed (P8/P9):

1. **Set Availabilities vs. Remove from Sales** (this doc's own twin
   pair): confirmed asymmetric exactly like Google activate/deactivate —
   one has a reconfirm dialog with real dwell time, the other commits in
   the same tick as the click (§1.3). The race-cap handling in §1.6 is
   load-bearing for Set Availabilities specifically, a near-non-issue for
   Remove from Sales — don't design one cancel-window size for both.
2. **This integration vs. its closest sibling** (Google bulk-status,
   integration 5): the *lib* relationship differs. Google's own
   `hub-tracking/*` was **already-parameterized-after-its-own-fix** by
   the time (5) shipped (Google's design doc §1.3 found the SAME
   hardcoded-tag gap Apple has now, fixed it as part of that build). Here,
   Apple's lib is still in the **pre-fix** state Google's was — this
   design proposes the equivalent fix for Apple's tree, arrived at
   independently from Apple's own code (§1.5), not copied from Google's
   already-fixed state. Also: this component's mount lifecycle
   (conditional mount/unmount, §C) differs structurally from
   `BulkStatusModal`'s always-mounted `open`-prop toggle — the cancel-site
   wiring must account for that difference, not port Google's ref
   pattern byte-for-byte.

### H. Open questions / risks for sign-off

1. **Route signature change**: `start/route.ts`'s `POST()` → `POST(req:
   Request)` is a real signature change to a shipped, working route
   (unlike Google's case, where the route already accepted a `Request`
   param it just ignored). Low risk — Bulk Import's existing caller sends
   no body today and will continue to work identically (an absent body
   parses to `{}`, `feature` optional) — but flagging since it's a
   broader-than-`cancel` edit to already-shipped code.
2. **Server-derives-tag-from-action, not client-sent** (§E.4): recommend
   deriving the Hub log tag from the validated `action` enum server-side
   rather than trusting a client-sent `feature` string for this specific
   route, even though the generic `/hub-tracking/start`/`cancel` routes do
   accept a client-sent `feature` (their input is just a log label, lower
   stakes; `bulk-availability`'s own finalize call is the one that should
   pin the tag to what it already knows objectively true). Flagging this
   asymmetry explicitly — it's a deliberate choice, not an oversight.
3. **Orphaned-run risk, inherited**: same accepted class as every prior
   integration (`docs/integrate-rest-vnggames-hub.md` confirms no
   RUNNING-run TTL) — a truly abandoned tab during Set Availabilities'
   near-zero cancel window, or a `/start` that resolves late and gets
   best-effort-cancelled per §1.6, are both bounded, documented risks, not
   blockers. Recommend accepting, consistent with (2)/(4)/(5)'s own
   precedent.
4. **`writeStartedRef` reset on modal reopen**: since the modal fully
   unmounts between uses (§1.1, true conditional mount unlike Google's
   toggle), a fresh `useRef(false)` is created on every mount for free —
   confirm no explicit reset logic is needed beyond what mount/unmount
   already provides (mirrors Google's own confirmed-no-gap finding for
   its single-instance-keyed-on-mode component, re-verified here against
   this component's different lifecycle rather than assumed identical).
5. **KB staleness correction**: recommend a small follow-up doc edit
   (out of this design's scope) updating
   `IAP-MANAGEMENT-KNOWLEDGE-BASE.md`'s deferred/backlog marker for
   availability editing, since §1.1 proves it shipped — flagging so it
   doesn't get re-investigated as "still deferred" next time.

---

## Summary of what needs Manager sign-off before a build prompt

1. **§H.1**: the `start/route.ts` signature change (`POST()` →
   `POST(req: Request)`) — acceptable to touch this shipped route, or
   prefer an additive-only alternative (e.g. a new
   `/hub-tracking/start-tagged` route) to avoid touching it at all?
   Recommend: change in place (mirrors Google's `cancel`/`start` edits
   exactly, lowest total surface area).
2. **§H.2**: server-derives-tag-from-`action` (not client-sent) for this
   route specifically, even though the generic routes accept a
   client-sent tag — confirm this asymmetry is acceptable.
3. **§H.5**: KB deferred-marker correction — bundle into this PR's docs
   commit, or a separate follow-up? Recommend: separate, small, so this
   design doc's own diff stays focused.

Everything else in this design is confirmed-reusable (§E) or a direct,
low-risk, evidence-grounded extension of the Google bulk-status (5)
pattern, re-verified against this module's own code rather than assumed
to transfer (P8/P9).

---

### Implementation findings (open questions resolved during the build)

Manager sign-off resolved the three §H open questions as follows — the
build matches this doc's own recommendation in all three cases (no
overrides this time, unlike Google's build):

1. **Route signature change** (§H.1) — resolved as recommended:
   `start/route.ts`'s `POST()` → `POST(req: Request)`, mirroring
   `cancel/route.ts`'s existing shape. Bulk Import's caller (`fetch(...,
   {method:"POST"})`, no body) is unaffected — confirmed by the
   regression proof below, not just assumed.
2. **Server-derives-tag-from-`action`** (§H.2) — resolved as
   recommended: `bulk-availability/route.ts` derives its own finalize
   tag from a `FEATURE_BY_ACTION` lookup keyed on the validated `action`
   enum, never from a client-sent field. The generic `/hub-tracking/
   start` and `/cancel` routes still accept a client-sent `feature`
   (used for the client-side START/CANCEL calls, which legitimately
   don't know anything more authoritative) — the asymmetry is
   intentional and unchanged from this doc's proposal.
3. **KB staleness correction** (§H.5) — deferred to a separate follow-up
   as recommended; not bundled into this commit.

**Orphaned-run risk** (§H.3) and **`writeStartedRef` reset on modal
reopen** (§H.4) — both confirmed accepted/no-gap exactly as this doc
anticipated; no code changes needed beyond what §E already specified.

Shipped: `hub-tracking/{hub-client,tracking}.ts` feature-tag
parameterization (backward-compatible — Bulk Import's tag/behavior
byte-for-byte unchanged, verified via its full existing test suite,
69/69 green, and submit-batch's separate wrapper module
`submit-tracking.ts` left completely untouched — zero diff — with its
own distinct-tag test suite, 25/25 green); `/hub-tracking/{start,cancel}`
routes accept an optional `feature` body field; `bulk-availability/
route.ts` wrapped in the `HubTrackingState` try/finally (R1,
mutation-tested: removing the `finally`'s `finalizeHubTracking` call
made the dedicated R1 test fail — `expected "vi.fn()" to be called 1
times, but got 0 times` — reverted and re-confirmed passing, `git diff`
on the route empty after revert); `AvailabilitiesBulkModal.tsx` client
wiring (START-on-click per mode, race-capped threading, two-ref cancel
guard via `writeStartedRef`, `beforeunload`, R3 multi-start hygiene, R4
best-effort late-cancel). New/updated tests: 6 lib feature-tag tests, 11
route tests (including the R1 mutation-check target), 9 modal wiring
tests (including a real-time ~1s race test). Full module + repo suite:
2977/2977 passing; typecheck/lint/build clean.

---

**Implemented, docs-only commit + code committed together** per Manager
sign-off; held for review before push. This doc now serves as the
as-built design record for the 6th+7th Hub-tracking integrations.
