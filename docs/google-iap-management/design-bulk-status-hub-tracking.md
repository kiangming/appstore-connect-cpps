# Google IAP Bulk Activate / Bulk Deactivate — Hub Tracking (5th integration)

Investigation + design only. No code in this doc's scope — see §H for the
explicit hold-for-review gate.

Prior integrations, in ship order: (1) Apple IAP Bulk Import (`95d9413`),
(2) Google IAP Bulk Import (`1663a37`, race-hardened by `ce169a8`), (3) Apple
IAP Submit-batch (`867386a`, `docs/iap-management/design-iap-submit-hub-tracking.md`),
(4) CPP Bulk Import (`ccf45b2`, `docs/cpp-management/design-cpp-hub-tracking.md`).
This is the 5th: Google IAP Bulk Activate / Bulk Deactivate — the feature
built in Cycle 41 (`docs/iap-management/IAP-MANAGEMENT-KNOWLEDGE-BASE.md`
§10.10) and just hardened for the purchase-option-id 404 in commit
`1fb3f7e`.

Unlike (3) and (4), this integration reuses an **existing** hub-tracking
lib tree in the **same module** — `lib/google-iap-management/hub-tracking/*`,
shipped for (2). No prior design doc exists for (2) itself (it shipped
directly, no `docs/google-iap-management/design-*-hub-tracking.md`); this
doc is the first for the module, and doubles as the as-built reference for
(2)'s existing shape.

Meta-rules cited throughout (`docs/iap-management/IAP-MANAGEMENT-KNOWLEDGE-BASE.md`
§10.13.K): **P5** (status principle), **P6** (no-cache-cold-path), **P7**
(prefer a missed signal over a wrong one), **P8** (twin-structure
asymmetry), **P9** (design-first pays off exactly where a feature looks
like a proven pattern).

---

## 1. Investigation findings (evidence-backed)

### 1.1 End-to-end flow map — single round-trip, no mid-flight pause

- `components/google-iap-management/iap-list/BulkStatusModal.tsx:175-178`
  — `onPrimaryClick()`: `if (destructive) setConfirmOpen(true); else void submit();`
  Single entry point for both modes.
- `BulkStatusModal.tsx:125-173` — `submit()`: sets `submitting=true`,
  `POST`s to `/api/google-iap-management/apps/{packageName}/iaps/bulk-{activate,deactivate}`
  with `{ skus }`, awaits the JSON response, renders `results`/`overall`/`summary`.
  One `fetch`, one `await`, no second request.
- `app/api/google-iap-management/apps/[packageName]/iaps/bulk-deactivate/route.ts:75-93`
  (bulk-activate is byte-identical except the action verb, confirmed via
  `diff` — only lines 84/89-90 differ) — validates session/account/app/body,
  then `await executeBulkStatus({...})` inside a single `try/catch`, returns
  `NextResponse.json(result)`. **No `try/finally`, no mid-flight decision
  point exists today.**
- `lib/google-iap-management/orchestration/bulk-status.ts` `executeBulkStatus`
  (lines 90-262, current tree post-`1fb3f7e`): resolves flagged skus, then
  live purchase-options (added by `1fb3f7e`), then loops chunks
  sequentially, each chunk in its own `try/catch` (lines 197-218) —
  **no phase-based response, no `{phase:"conflict"}`/`{phase:"partial-fail"}`
  shape** (contrast submit-batch's reviewSubmissions v2 path, KB §10.10
  Q-BULK.6 confirms Google's chunked-sequential design was a deliberate
  pivot away from Apple's per-item concurrency machinery, but it is still
  **one function call, one HTTP round-trip** from the route's perspective).

**Confirmed: `executeBulkStatus` is a single client→server round-trip with
no mid-flight pause or second-decision point.** This justifies the
two-state guard (Manager decision 4) — there is no submit-batch-style
third "mid-flight partial-fail, ask the client" state to model.

### 1.2 Reconfirm dialog — deactivate only; activate has (almost) no cancel window

- `BulkStatusModal.tsx:97` — `const destructive = mode === "deactivate";`
- `BulkStatusModal.tsx:175-178` — only the destructive branch opens
  `confirmOpen`; activate's `onPrimaryClick` calls `submit()` directly,
  synchronously, in the same event-handler tick.
- `BulkStatusModal.tsx:244-245, 283-284` — the outer modal's X button and
  footer Close button are both `disabled={submitting}` — once `submit()`
  has set `submitting=true`, **the modal cannot be closed by the user**
  until the fetch settles. This is the actual "write committed" boundary,
  not `confirmOpen`.
- `BulkStatusModal.tsx:207` — the outer backdrop's `onClick={handleClose}`
  is **not** gated by `submitting` (unlike the two buttons). This is a
  pre-existing latent gap: a user CAN click the backdrop while
  `submitting=true`. It doesn't abort the in-flight `fetch` (React state
  update on an invisible-but-still-mounted component instance — `if
  (!open) return null` is a conditional render, not an unmount, since the
  parent only flips the `bulkMode` prop; see 1.3), so the write completes
  and the modal reopens closed with no visible result — but it means any
  cancel-guard MUST key off a permanent ref set the instant `submit()`
  begins, not off `submitting` or off "is the backdrop click reachable" —
  exactly the class of bug CPP's R2 and Bulk Import's `executeStartedRef`
  comment (`BulkImportWizard.tsx:184-192`) already document and guard
  against.
- `BulkStatusModal.tsx:310-363` — the confirm dialog's own "Cancel" button
  (line 348) and its backdrop (line 315) both call only
  `setConfirmOpen(false)` — they return to the **selection screen inside
  the same still-open modal**, they do **not** call the outer `handleClose`
  / `onClose()`. This is a real UI difference from Bulk Import's
  `handleExit` (which navigates away entirely) and from CPP's dialog-close
  (which also fully closes). A Manager can decline the reconfirm, then
  immediately re-select and re-click Deactivate, starting a **new**
  attempt (and, per decision 3, a new Hub run) without leaving the modal.

**Per-operation trigger + cancel window, stated separately as required:**

| | Activate | Deactivate |
|---|---|---|
| START trigger | `onPrimaryClick()` click (button click), non-destructive branch | Same `onPrimaryClick()` click, destructive branch (fires BEFORE `setConfirmOpen(true)`) |
| Cancel-eligible window | None in practice — `submit()` fires in the same synchronous tick as START; no dialog, no intervening user-actionable step. (The backdrop click during `submitting` is not a real cancel — see above.) | From `setConfirmOpen(true)` until `submit()` sets `submitting=true`: confirm-dialog Cancel button, confirm-dialog backdrop, outer-modal X/footer-Close/backdrop while the dialog is showing, `beforeunload` |
| Write-commit boundary | `submit()`'s `setSubmitting(true)` (line 131), effectively simultaneous with START | Same line, after the Confirm click |

### 1.3 Reusable Google hub-tracking assets — reusable AS-IS, but NOT fully generic yet

Enumerated from `lib/google-iap-management/hub-tracking/*` and the three
routes under `app/api/google-iap-management/hub-tracking/`:

| Asset | Reusable as-is? | Finding |
|---|---|---|
| `hub-tracking/config.ts` (`getHubTrackingGate`, `getActiveHubTrackingCredentials`, `getHubTrackingConfigPublic`, `saveHubTrackingConfig`) | **Yes, fully** | Reads the single shared `google_iap_mgmt.hub_tracking_config` row (`config.ts:26-53`) — workflow-level, not feature-level. No new migration, no new settings page (Manager decision 1). |
| `hub-tracking/hub-client.ts` (`hubStartRun`, `hubCloseRun`) | Functionally yes, **but hardcodes the log feature tag** | `hub-client.ts:72` — `const LOG_FEATURE = "google-iap-hub-tracking";` used at every `log(LOG_FEATURE, ...)` call inside both functions (lines 92-129, 141-171). This is the string that needs to become `"google-iap-bulk-activate"` / `"google-iap-bulk-deactivate"` per decision 2 — **it is currently a module constant, not a parameter.** |
| `hub-tracking/tracking.ts` (`startBulkImportTracking`, `finalizeHubTracking`) | **No — bulk-import-specific by name AND by hardcoded tag** | `tracking.ts:21` — same hardcoded `LOG_FEATURE = "google-iap-hub-tracking"`, used in every log call in both functions. The function names themselves (`startBulkImportTracking`) are also bulk-import-specific, though their bodies contain no bulk-import-only logic — they are pure pass-throughs to `getHubTrackingGate` + `hubStartRun`/`hubCloseRun`. |
| `hub-tracking/status-mapping.ts` (`computeGoogleBulkImportTerminalStatus`) | **Yes, drop-in, zero changes needed to the logic** | Signature `({total, succeeded, failed}) => {status, errorMessage?}` (lines 33-46) with `failed===0→SUCCESS / succeeded===0→FAILED / else→PARTIAL`. `BulkStatusOutcome` (`bulk-status.ts:64-74`) already carries exactly `total`/`succeeded`/`failed` fields, computed directly from the per-sku `results` array (`bulk-status.ts:221-222`) — the **same per-sku done/error set the modal renders** (see §1.6). Only the function's name is bulk-import-specific; the logic is generic already (mirrors the Apple-side finding in the KB: "generic despite the name", line ~2724). |
| `app/api/google-iap-management/hub-tracking/start/route.ts` | Endpoint path/auth reusable; **body needs one new optional field** | `start/route.ts:24-37` — `POST()` takes no body today, calls `startBulkImportTracking(session.user.email)` unconditionally. To honor decision 2 it needs to read an optional `feature` from the request body and thread it down. |
| `app/api/google-iap-management/hub-tracking/cancel/route.ts` | Same — reusable path, **body needs the same new field** | `cancel/route.ts:25-48` — parses `{run_id}` only, calls `finalizeHubTracking(runId, "CANCELLED")` with the module-hardcoded tag. Needs the same `feature` threading. |
| `app/api/google-iap-management/hub-tracking/config/route.ts` | **Yes, unchanged** | Feature-agnostic — the shared config row has no per-feature concept, matches decision 1. |

**Conclusion for investigation point 3: the existing lib + routes are
reusable in structure (same DB row, same REST client, same status-mapping
logic, same route paths) but NOT feature-tag-generic today** — the log
tag is a hardcoded module constant three layers deep
(`config.ts:27`, `hub-client.ts:72`, `tracking.ts:21`). Making it generic
is a small, mechanical, backward-compatible change (see §E) — not a
rewrite — but it is a real prerequisite, not "just new wiring on top."

### 1.4 Finalize placement — server-side, mirroring Bulk Import's execute route

- `app/api/google-iap-management/apps/[packageName]/bulk-import/execute/route.ts:96-234`
  — the **entire handler** is one `try {...} finally { await
  finalizeHubTracking(tracking.runId, tracking.status, tracking.errorMessage); }`.
  `tracking: HubTrackingState = { runId, status: "FAILED", errorMessage? }`
  is threaded by reference (lines 86-96); `status` defaults to `"FAILED"`
  and is only overwritten to the real terminal value right before the
  success `return` (lines 213-220); every early return sets
  `tracking.errorMessage` to its specific reason. **There is no standalone
  `/finalize` route for Bulk Import** — `/cancel` is the only other
  closer (explicit back-out + `beforeunload` beacon), confirmed by the
  route inventory in §1.3 (only `start`/`cancel`/`config` exist under
  `hub-tracking/`).
- §1.1 confirmed `executeBulkStatus` is single-round-trip, structurally
  identical in shape to `executeBulkImport` from the route's point of
  view (one async orchestrator call, one aggregate result, no
  conflict/partial-fail pause). Per **P9**, this similarity was verified
  directly against the actual code (not assumed from the surface
  resemblance) — see §1.1's citations.

**Recommendation: server-side finalize**, threading `hub_run_id` into the
`bulk-activate`/`bulk-deactivate` route bodies and wrapping each route's
existing `try/catch` in an outer `try/finally`, exactly mirroring the
Bulk Import execute route's `HubTrackingState` pattern. This is robust to
a client tab-close during the write (the single server call owns the
terminal close regardless of what the browser does after the request is
sent) and requires no new client-side terminal-status computation (CPP's
client-driven approach was necessary there only because CPP's upload loop
is itself client-orchestrated across many `PUT`s — not the case here).

### 1.5 Race check — bounded-cap threading, same shape as `ce169a8`, P7 applies unchanged

- Because run_id is **threaded into** the write call (not fire-and-forget
  like CPP's `/finalize`), an unresolved `/start` at confirm-time must
  never block or wrongly cancel — it must produce a **missed** track
  (route runs with `hub_run_id: null`, server-side `finalizeHubTracking`
  no-ops per `tracking.ts:77-80`), never a **wrong** one. This is
  `ce169a8`'s exact fix shape, reused, not re-derived: Bulk Import's
  `BulkImportWizard.tsx:414-427` races the stored start-promise against a
  hard 1s cap (`Promise.race([hubStartPromiseRef.current, capped])`) and
  proceeds with whatever it gets, `null` included.
- Per **P8**, timing must be re-validated against THIS surface's actual
  flow, not assumed to transfer: bulk-status's START fires at the same
  button click that (for deactivate) opens the confirm dialog, or (for
  activate) immediately calls `submit()` in the same tick. Both are
  **tighter** timing than Bulk Import's upload→preview-to-execute gap, but
  the mechanism doesn't care about the gap's size — the same
  race-against-a-cap pattern applies unchanged; it merely has less natural
  dwell time to work with for activate. No design change needed, just
  confirmation that the existing pattern already handles "arbitrarily
  short gap" as a degenerate case (the cap fires immediately if the
  promise hasn't resolved).
- The late-resolving-run_id continuation must ALSO be reused verbatim
  (`BulkImportWizard.tsx:357-371`): if the write already started
  (permanent ref true) by the time `/start` resolves, **drop the run_id
  silently** — do not adopt it into state, do not cancel it. It is a real,
  possibly-already-succeeding run; per P7, an orphaned-but-real run beats
  a wrongly-CANCELLED real one.

### 1.6 Per-sku → S/P/F reads the same set the modal renders; zero-eligible edge

- `bulk-status.ts:221-222` — `succeeded`/`failed` are computed by
  filtering the SAME `results: BulkStatusItemResult[]` array
  (`bulk-status.ts:178` onward) that the route returns verbatim as
  `BulkStatusOutcome.results`, and that `BulkStatusModal.tsx:488` renders
  row-by-row via `ResultList`. There is no second/derived count — the
  terminal computation and the modal's rendered rows are the literal same
  array.
- Zero-eligible edge: `executeBulkStatus` returns an early `NO_OP` (lines
  103-114) only when `skus.length === 0` at the route boundary (shouldn't
  occur in practice — the modal's primary button is `disabled={selected.size
  === 0}`, `BulkStatusModal.tsx:293`). If it occurs (e.g. a malformed
  direct API call), `NO_OP` maps to Hub `SUCCESS`, consistent with **P5**
  (nothing was attempted-and-failed) and with feeding
  `computeGoogleBulkImportTerminalStatus({total:0, succeeded:0, failed:0})`
  directly — `failed===0` → `SUCCESS`, no special-casing needed. All-flagged
  (every sku deleted-on-Google) and all-resolve-failed (every sku's live
  purchase-option GET fails, from `1fb3f7e`) both still produce
  `total>0, succeeded=0, failed=total` → `FAILED` via the existing
  `overall` computation, which is correct (something WAS attempted and did
  not succeed) — distinct from the true zero-eligible `NO_OP` case.

---

## 2. Design

### A. Finalize-placement recommendation

**Server-side**, inside each of `bulk-activate/route.ts` and
`bulk-deactivate/route.ts`, mirroring `bulk-import/execute/route.ts`'s
`HubTrackingState` + `try/finally` shape exactly (see §1.4). No
standalone `/finalize` route is introduced — `/cancel` remains the only
other closer, exactly as it is for Bulk Import.

### B. Status-mapping table

| Manager action | Tracking event |
|---|---|
| Click "Activate" / "Deactivate" button | **START** — `POST /hub-tracking/start` fired (feature tag per decision 2), promise stored, NOT awaited |
| Decline confirm dialog (Cancel button or its backdrop) — deactivate only | **CANCEL** — `POST /hub-tracking/cancel` with the run_id from THIS attempt, fire-and-forget |
| Close outer modal (X / footer Close / backdrop) while a run is pending and the write has not started | **CANCEL** — same as above |
| Tab close / navigation while a run is pending and the write has not started | **CANCEL** — `beforeunload` + `sendBeacon`, same endpoint |
| Write completes, `failed === 0` (all skus succeeded, including the `NO_OP`/zero-eligible edge) | **SUCCESS** |
| Write completes, `succeeded > 0 && failed > 0` | **PARTIAL** |
| Write completes, `succeeded === 0 && failed > 0` (or the route throws before `executeBulkStatus` returns) | **FAILED** |

Terminal status is computed from `computeGoogleBulkImportTerminalStatus({
total: result.total, succeeded: result.succeeded, failed: result.failed
})` (§1.6) — the **same per-sku outcome set** the modal already renders
(**P5**, the status principle: goal state = "did the Google write actually
succeed per sku," not "which button was clicked"). `{succeeded, failed,
total}` ride along in the finalize payload as `errorMessage`/log context
exactly as Bulk Import does today (no schema change to the Hub PATCH body
— it only accepts `status` + optional `error_message`, per
`docs/integrate-rest-vnggames-hub.md`).

**The multi-option under-deactivate `warning` (shipped in `1fb3f7e`,
`BulkStatusItemResult.warning`) is explicitly excluded from this
computation** — a `warning`-carrying row is still `ok: true` and
contributes to `succeeded`, not `failed`. Per Manager decision 6, folding
it in would make Hub tracking a stricter/different signal than what the
modal itself shows the Manager (which already treats it as a
non-blocking success). When full multi-option state batching ships, this
mapping does not need to change — "done" will already mean the real goal
state at that point, and tracking self-corrects for free.

### C. Guard: two-state, permanent-ref-gated

Two-state (SUCCESS/PARTIAL/FAILED vs. CANCEL), not three-state — §1.1
confirmed there is no mid-flight pause to model a third state around.

- `hubRunIdRef` (or equivalent state) — holds the run_id from the
  **current** attempt, reassigned on every new START (a Manager
  declining-then-retrying at the confirm dialog starts a genuinely new
  run per §1.2/decision 3 — the old run was already CANCELLED by the
  decline).
- `hubStartPromiseRef` — holds the in-flight `/start` promise for the
  race-cap threading in `submit()` (§1.5).
- `writeStartedRef` (permanent, `useRef(false)`, set to `true` as the
  very first statement inside `submit()`, never reset) — the single gate
  for cancel-eligibility. Mirrors `BulkImportWizard.tsx`'s
  `executeStartedRef` and CPP's R2 two-ref guard exactly, **for the
  reason found in §1.2**: `submitting` is not a safe gate on its own
  (backdrop click during `submitting` is reachable and unguarded by
  `disabled`), so the cancel-sending code must check `writeStartedRef`,
  not `submitting` or `confirmOpen`.
- All four cancel-trigger sites (confirm-dialog Cancel button,
  confirm-dialog backdrop, outer-modal `handleClose` — covering X/footer
  Close/outer backdrop — and the `beforeunload` handler) route through
  one `cancelPendingRun()` helper: no-ops if `writeStartedRef.current` is
  true OR no run_id is pending; otherwise fires `POST /hub-tracking/cancel`
  (fetch for the three UI paths, `sendBeacon` for `beforeunload`,
  matching Bulk Import's existing split) and clears the local run_id/promise
  refs so a stale reference can't leak into a subsequent attempt.
- Activate has no reconfirm dialog (§1.2) — `cancelPendingRun()` is wired
  the same way for symmetry (so a future UI change re-adding a
  confirmation, or the backdrop-during-submitting edge, is covered for
  free), but in practice it will rarely-to-never fire for activate given
  the near-zero window found in §1.2.

### D. R1 finalize-in-finally (load-bearing regardless of placement)

Both `bulk-activate/route.ts` and `bulk-deactivate/route.ts` wrap their
entire handler body in `try { ... } finally { await
finalizeHubTracking(tracking.runId, tracking.status,
tracking.errorMessage, feature); }`, with `tracking: HubTrackingState =
{ runId, status: "FAILED" }` defaulted exactly as
`bulk-import/execute/route.ts:86-96` does. Concretely:

- `tracking.runId` is parsed from the body as early as it's available
  (before pricingSource/rows-equivalent validation), so even a
  request-shape validation failure still closes a real pending run
  correctly (as FAILED, with the specific validation message) rather than
  leaving it RUNNING.
- If `executeBulkStatus` itself throws unexpectedly (not expected in
  practice — every chunk failure is caught internally per §1.1 — but the
  same defensive-backstop reasoning CPP's R1 documents applies), the
  `finally` still fires with `tracking.status` at its `"FAILED"` default,
  never left `RUNNING`. No unexpected-error `PARTIAL`-vs-`FAILED`
  disambiguation function is needed here (contrast CPP's
  `deriveTerminalStatusOnUnexpectedError`) because `executeBulkStatus`
  does not stream partial per-sku results back to the route
  incrementally — an unthrown exception means the route never even
  received a partial `results` array to derive a `succeeded>0` signal
  from, so `"FAILED"` is the only defensible default here, matching the
  existing Bulk Import default.

### E. Reuse map — exactly what's reused vs. newly wired

**Reused as-is, zero changes:**
- `google_iap_mgmt.hub_tracking_config` (DB row, migration, encryption) — decision 1.
- `getHubTrackingGate` / `getActiveHubTrackingCredentials` / Settings
  read-write path (`config.ts`) — no new settings page.
- `hubFetch`, `hubValidateCredentials`, the 3s `AbortController` hard
  timeout, `HUB_TIMEOUT_MS` (`hub-client.ts`).
- `computeGoogleBulkImportTerminalStatus` logic — called with a second,
  new call site (see below).
- `/hub-tracking/config` route — untouched.

**Minimal new wiring (mechanical, backward-compatible):**
1. Parameterize the log feature tag through the three currently-hardcoded
   layers (§1.3): `hub-client.ts`'s `hubStartRun`/`hubCloseRun`,
   `tracking.ts`'s start/finalize functions, each gain an optional
   `feature` parameter defaulting to the existing
   `"google-iap-hub-tracking"` string — so Bulk Import's existing calls
   (which don't pass it) are byte-identical in behavior and logs.
   `config.ts`'s gate-read logging can reasonably stay under the shared
   tag (it's about the singleton config row itself, not a specific run) —
   flagged as an explicit choice in §H, not silently decided.
2. `tracking.ts`'s two functions are either renamed to feature-agnostic
   names (`startHubTrackingRun`, keeping `finalizeHubTracking` as-is since
   it's already generically named) or kept as thin wrappers with new
   generic siblings — a naming call for implementation, not a design fork
   (both preserve identical behavior for the existing Bulk Import caller).
3. `/hub-tracking/start` and `/hub-tracking/cancel` routes each accept an
   optional `feature` field in their POST bodies, threaded straight
   through; absent `feature` defaults to today's behavior (Bulk Import
   keeps working unchanged with zero client-side changes required there).
4. Two new feature-tag string constants: `"google-iap-bulk-activate"`,
   `"google-iap-bulk-deactivate"` (decision 2), used only by the new
   client wiring below.
5. `bulk-activate/route.ts` / `bulk-deactivate/route.ts`: add
   `hub_run_id` (optional string) to the existing zod body schema,
   thread it through a `HubTrackingState` + `try/finally` exactly per §D,
   passing the operation's own feature tag to `finalizeHubTracking`.
6. `BulkStatusModal.tsx`: add `hubRunId`/`hubStartPromiseRef`/
   `writeStartedRef` state (§C), fire START at the top of
   `onPrimaryClick()` with the mode-appropriate feature tag, thread the
   raced run_id into `submit()`'s fetch body as `hub_run_id`, wire
   `cancelPendingRun()` into the confirm dialog's Cancel/backdrop, the
   outer `handleClose`, and a new `beforeunload` listener (none exists in
   this component today — it's net-new, unlike Bulk Import's wizard which
   already had one).
7. Rename `computeGoogleBulkImportTerminalStatus` → a feature-agnostic
   name (e.g. `computeGoogleBulkTerminalStatus`) and update the one
   existing Bulk Import call site — purely mechanical, logic untouched,
   already covered by existing tests.

**Explicitly NOT done:** no new migration, no new Settings page, no new
`lib/google-iap-management/hub-tracking/` files beyond the parameterization
in (1)-(2), no duplicate REST client.

### F. Cross-cutting

- Two feature tags per decision 2, threaded per §E(1)(3)(4) — distinct
  from Bulk Import's `"google-iap-hub-tracking"` in every log line this
  feature produces.
- `[hub-tracking]` log-line prefix preserved unchanged (only the `log()`
  feature-tag argument differs, per `hub-client.ts:69-72`'s own existing
  comment about how Apple/Google are already distinguished this same way).
  Token never logged — no change to that discipline.
- 3s `AbortController` hard timeout — reused from `hub-client.ts` as-is,
  no new timeout constant.
- Config reads: **no cache**, full stop, on every read — per **P6**; this
  feature performs at most 2 extra config reads per bulk action (one at
  START, one at finalize), nowhere near a hot path, so no cache is ever
  introduced.

### G. Twin-asymmetry note, applied in reverse

This is intra-module reuse (same `lib/google-iap-management/hub-tracking/`
tree), not inter-module copy like CPP borrowing Apple's pattern — so the
risk profile in **P8** is inverted: the *lib* is shared and doesn't need
re-validation, but the **lifecycle timing does**, because bulk-status's
UI shape differs from Bulk Import's on the exact axis P8 warns about:

- Bulk Import: START at upload→preview (a natural early step with real
  dwell time before execute); single write route; `beforeunload` guard
  already existed to build from.
- Bulk-status: START at button click (§1.2) — for activate, essentially
  simultaneous with the write; for deactivate, gated only by however long
  the confirm dialog is open; the dialog's own Cancel does **not** close
  the outer modal (§1.2), a UI shape Bulk Import has no equivalent of;
  `beforeunload` does not exist yet on this component and must be added
  net-new (§E(6)).

Re-validated against the actual `BulkStatusModal.tsx`/route/orchestrator
code in §1.1-1.6 above, not assumed from the Bulk Import precedent — per
**P9**, this is exactly the situation where surface similarity ("select N
→ click a bulk verb → track the run") could have hidden a timing mismatch
if the design had skipped straight to "same as Bulk Import."

### H. Open questions / risks for sign-off

1. **Config-read log tag** (§E(1)): should `config.ts`'s gate-read log
   lines also take the per-feature tag, or stay under the shared
   `"google-iap-hub-tracking"` tag since they're about the singleton
   config row rather than a specific run? Recommend: leave shared (lowest
   diff, and a config-read failure is a config problem regardless of
   which feature triggered the read) — flagging for explicit Manager
   confirmation rather than deciding silently.
2. **Rename scope** (§E(7)): renaming `computeGoogleBulkImportTerminalStatus`
   touches one already-shipped Bulk Import call site. Low risk (logic
   unchanged, existing tests cover it), but it's a change to previously
   "done" code — confirm this is acceptable to bundle into this PR rather
   than adding a same-logic sibling function instead (more duplication,
   zero risk to shipped code).
3. **Orphaned-run risk is inherited, not new**: per §1.5/P7 and
   `docs/integrate-rest-vnggames-hub.md` (no RUNNING-run TTL, confirmed —
   the four terminal statuses are only ever set by an explicit PATCH;
   nothing auto-expires a run), the same rare race Bulk Import already
   accepts (a `/start` that resolves after the write completed with
   `hub_run_id: null`, per §1.5's "missed, not wrong" drop) applies here
   too, and activate's near-zero cancel window (§1.2) makes the
   degenerate "everything happens instantly" case slightly more common in
   relative terms, though still bounded by the same 1s cap. Not a
   blocker — same accepted risk class as (2)/(4), documented rather than
   assumed away, per CPP's own R4 precedent.
4. **Multiple simultaneous bulk actions**: `IapListClient.tsx` mounts a
   single `BulkStatusModal` instance keyed on `bulkMode`
   (`bulkMode && (<BulkStatusModal mode={bulkMode} .../>)`, confirmed —
   the parent always transitions through `bulkMode=null` between modes,
   so component remount naturally resets all local run_id/ref state; no
   explicit reset logic is needed beyond what the existing mount/unmount
   already provides). No design gap here, noted for completeness since it
   was verified rather than assumed.

---

**HOLD for review before any implementation**, per the task's explicit
gate. This doc is docs-only; no `lib/`, `app/`, or `components/` files are
touched by it.
