# Design: VNGGames Hub Run Tracking for IAP Submit (submit-batch)

Status: **Investigation + design for review — NO CODE WRITTEN.** A build prompt follows approval.

Third Hub-tracking integration (after Apple Bulk Import and Google IAP Management). Mirrors the proven pattern, applying the fixes it took two rounds to discover, from day one. References the submit-batch implementation shipped in `6bb7023` (docs/iap-management/design-iap-v2-submission-migration.md).

---

## 0. Reference implementation — what Bulk Import actually does today

**Config** (`lib/iap-management/hub-tracking/config.ts`): `iap_mgmt.hub_tracking_config` singleton row (`workflow_id`, `token_enc`, `enabled`, `is_active`). `getActiveHubTrackingCredentials()` → `getHubTrackingGate()` → fresh DB read every call, **no cache** (a 5-minute in-memory cache caused two prior bugs — stale token-required errors and the `enabled` toggle appearing to "silently revert" across Railway's multi-instance rolling deploy; removed entirely per the module's own header comment).

**Lifecycle** (`hub-client.ts` + `tracking.ts`): `hubStartRun`/`hubCloseRun` (HTTP layer, `HUB_TIMEOUT_MS = 3000`, genuine `AbortController` abort — not a `Promise.race` that leaves the request running) → `startBulkImportTracking`/`finalizeHubTracking` (orchestration layer, both no-op when `!gate.credentials`, logged as `SKIP (no-op)`). `HubTerminalStatus = "SUCCESS" | "FAILED" | "CANCELLED" | "PARTIAL"` — exact strings the Hub API expects. `computeBulkImportTerminalStatus({total, succeeded, failed})` is a pure, already-generic function (not Bulk-Import-specific despite the name) — `failed===0` → SUCCESS, `succeeded===0` → FAILED, else PARTIAL.

**The guard — the crux of the one bug this feature has hit twice**: original guard was transient (`step < 4 && !executing`), which reopens after *any* settled request regardless of outcome — a subsequent tab-close/exit then fired a spurious `CANCELLED` that overwrote a real, already-recorded `SUCCESS`. Fixed (`4ba8e6f`, ported correctly by Google in `1663a37`) with a **permanent** `useRef(false)` — `executeStartedRef` — set to `true` the instant the mutating execute call is invoked and **never reset**. Every cancel/cleanup site (`beforeunload`+`sendBeacon`, explicit exit, a slow-start-response race) checks `!executeStartedRef.current` before firing cancel. Server-side, the execute route wraps its whole `POST` handler in one try/finally keyed off a `hub_run_id` parsed as early as possible from the request, defaulting `status` to `"FAILED"` and only overwriting it right before a legitimate exit — so the run is closed with the correct terminal status on *every* exit path (success, partial, early validation error, thrown exception) exactly once.

**Google's later divergence** (`ce169a8`): the guard-vs-race interaction recurred through a *different* mechanism — a fire-and-forget `start` call that hadn't resolved yet when execute fired, so the late-arriving `run_id` got auto-cancelled by the existing "don't adopt a late run into state" handler even though the real run was actively succeeding. Fixed with a bounded `Promise.race` (1s cap, well under the 3s Hub timeout) so the common case still threads `run_id` through, plus an explicit guard-reset (`executeStartedRef.current = false`) on "run another" since Google's wizard is reused in-place rather than unmounted between runs.

**This precedent matters directly for Submit**: both bugs came from the SAME root lesson — *once the server has begun (or fully owns) the real mutating work, the client must never independently decide the run is cancelled again.* Submit's design below is this lesson applied to a flow shaped very differently from a single-request wizard-confirm.

---

## 1. Where Submit's shape genuinely differs from Bulk Import

Bulk Import's execute is **one HTTP request**: click confirm → one `POST .../execute` → server does everything → responds with a terminal outcome → try/finally closes the run in that same request. There is no server-side decision point that requires a *second* client round-trip before the batch's outcome is known.

Submit-batch (v2 path) is **not** single-request-shaped. Per the reviewSubmissions migration, `runExecuteV2` can PAUSE and return a phase requiring a further human decision before real work continues or before the batch's true business outcome is settled:

```
POST execute:true
  → runStateGuard (read + mirror, no Apple mutation beyond state resync)
  → checkForConflict (READ-ONLY — zero Apple writes)
      → conflict?  → return {phase:"conflict"} ─────┐ (no items added yet)
      → clear      → executeSubmitV2 (WRITES: item-adds)
                        → all succeeded → confirmSubmitV2 (WRITES: submit PATCH) → {phase:"execute"} (terminal)
                        → some failed   → return {phase:"partial-fail"} ──────────┐ (items ALREADY added to Apple)
                                                                                   │
Client, on {phase:"conflict"}:                                                   │
  "Submit all N" → POST execute:true, confirmConflict:true → loops back into executeSubmitV2 above
  "Cancel"       → (no further Apple call — nothing was ever written)            │
                                                                                   │
Client, on {phase:"partial-fail"}:                                               │
  "Submit the ones that succeeded" → POST proceedPartial:{...} → confirmSubmitV2 (WRITES: submit PATCH)
  "Cancel — don't submit"          → POST rollback:{...} → rollbackOrLeaveSubmitV2 (maybe DELETE, or leaves it)
```

Legacy (v1) path has none of this — no shared-slot concept, no add-then-confirm two-step, each IAP's `POST /v1/inAppPurchaseSubmissions` either succeeds or fails independently within the single execute request. **Legacy always finalizes in the same request it starts in**, exactly like Bulk Import.

**Consequence for wrinkle 1 ("place tracking above the toggle, one wrapper agnostic to which path ran"): true for *computing* status, not true for *timing* the finalize call.** Both paths can share one `computeBatchTerminalStatus({total, succeeded, failed})` (reuse `computeBulkImportTerminalStatus` as-is — it's already generic) and one `HubTerminalStatus` value set — but **a single request-scoped try/finally, the way Bulk Import does it, does not fit the v2 conflict/partial-fail branches.** The run must stay open (`RUNNING` on the Hub) across up to three separate HTTP requests in the worst case (initial execute → confirmConflict execute → proceedPartial/rollback), and whichever one of them is the one that actually reaches a terminal outcome is the one responsible for finalizing. This is the load-bearing structural finding of this design — flagging it prominently as requested.

---

## 2. Where "start" and "execute-commit" actually sit (wrinkles 3 + 4)

**Start (Q4)**: fires at the **first** `POST execute:true` call — i.e. when the user presses "Submit N ready" on the preflight screen (`SubmitBatchModal.tsx:443`, `handleExecute`). This is later than Bulk Import's start point (Bulk Import starts at step 1→2, long before the user reaches confirm) — a real simplification: **while the user is only viewing preflight results, no Hub run exists yet, so closing the modal there needs no cancel call at all.**

**Execute-commit** is NOT one fixed point — it's whichever of these is reached first, and it determines when Apple side effects begin:

- **No-conflict case**: execute-commit happens *inside the same request* as start, immediately after `checkForConflict` returns clear. There is effectively **no cancel window** in this case (server doesn't pause for a human decision between start and the first Apple write) — the whole thing resolves in one round trip, same as Bulk Import's single-request shape.
- **Conflict case**: execute-commit is deferred to the **second** request — the `confirmConflict:true` re-POST fired by `handleConfirmConflict` (`SubmitBatchModal.tsx:263`). Between start and that second request, a real, legitimate cancel window exists: the conflict dialog is showing, zero Apple writes have happened (`checkForConflict` is read-only), and the "Cancel" button (`onClick={onClose}` today, `SubmitBatchModal.tsx:456`) is a **true** cancel — nothing needs to be undone on Apple's side.

**This is where the two-phase framing in the build prompt needs refinement, not just confirmation**: the *partial-fail* dialog is a **third** decision point the prompt's wrinkle 2 doesn't explicitly name, and it is NOT the same kind of cancel point as the conflict dialog. By the time `{phase:"partial-fail"}` is returned, `executeSubmitV2` has **already run** — real `POST /v1/reviewSubmissionItems` calls already happened on Apple's side for every eligible item. "Cancel — don't submit" here (`handleRollbackPartial`, `SubmitBatchModal.tsx:325`) does not mean "nothing happened" — it means "don't fire the final `submitted:true` PATCH," while some IAPs may already sit as unsubmitted items in a (possibly shared/reused) Apple reviewSubmission container.

So the guard is genuinely **three-state**, not two:

| State | Apple writes so far | Client cancel action | Correct Hub outcome |
|---|---|---|---|
| 1. Not started | none | (nothing to cancel — no run exists) | n/a |
| 2. Started, pre-commit (conflict dialog showing) | **zero** | Conflict dialog "Cancel" / modal close / beforeunload | **CANCEL** — accurate, nothing to undo |
| 3. Committed, pre-final-decision (partial-fail dialog showing) | item-adds attempted (some succeeded, some failed) | Partial-fail "Cancel — don't submit" | **NOT a clean CANCEL — see §3 open question** |
| 4. Resolved | terminal (submit PATCH fired or explicitly declined) | n/a — run already closed | SUCCESS / PARTIAL / FAIL |

State 3 is the one genuinely new complexity Submit introduces that neither Bulk Import nor the original wrinkle-2/3/4 framing fully anticipated, because Bulk Import has no "attempt work, then ask whether to keep it" two-step — its confirm button IS the attempt.

---

## 3. Open question requiring a decision (flagging per the brief's "flag anything that changes the approach")

**What Hub status should "Cancel — don't submit" at the partial-fail dialog report?**

Two defensible answers:

- **(a) FAIL** — the batch's Apple-review-reaching outcome is unambiguous: zero IAPs end up `WAITING_FOR_REVIEW` (confirm never fires; if the container was freshly created it gets deleted, if reused the added items just sit unsubmitted). From "did this run cause any IAP to reach Apple review," the answer is uniformly no — that's a FAIL by the same logic Bulk Import's `613a9c3` fix already established (status should reflect actual outcome, not a superficial label).
- **(b) CANCEL** — the user explicitly clicked a cancel-flavored button mid-flow, and treating any user-initiated "don't proceed" as CANCEL is simpler/more consistent with Q3's framing ("cancels at ANY dialog without proceeding to submit → CANCEL"), even though real Apple writes already happened.

**Recommendation: (a) FAIL**, with the item-add counts (e.g. "3/5 items added, submit was cancelled before confirming") carried in the Hub's `error_message` field so the distinction from a "hard" all-API-calls-failed FAIL is still visible to anyone reading the Hub dashboard. Reasoning: CANCEL should mean "nothing was attempted" (matching state 2 exactly, where it's unambiguous); reusing CANCEL for a state where Apple API calls demonstrably ran and produced a real, partial result would blur the one distinction (attempted-vs-not) the Hub's status field exists to capture. But this is a judgment call, not something the investigation can resolve unilaterally — **needs Manager sign-off** before the build.

A related, smaller question: if the write-phase fully succeeds at the add step but the **auto-confirm PATCH itself then fails** (the existing "confirm PATCH failed" branch in `runExecuteV2`, `route.ts` — also currently modeled as a `partial-fail`-shaped response even though every item "succeeded" at the add stage), the same logic applies: 0 items reached review, so FAIL is the correct Hub status regardless of the per-item `status: "SUCCESS"` labels those items carry in the API response (those labels describe add-success, not review-submission success — worth flagging as a latent modeling wrinkle, not a Hub-tracking-specific bug, but the Hub status computation must not naively read `item.status` as "did this reach review").

---

## 4. Design

### A. Config — REUSE confirmed, no new table/settings/migration

`getActiveHubTrackingCredentials()` / `getHubTrackingGate()` (`lib/iap-management/hub-tracking/config.ts`) reads `iap_mgmt.hub_tracking_config` generically — nothing about it is Bulk-Import-specific (no `feature` column, no scoping). Submit tracking calls the exact same reader, same `workflow_id`/token, same `enabled` flag. **Accepted consequence (Q1, confirmed)**: submit runs and import runs interleave on the same Hub workflow stream — not separable by run-source from the Hub UI alone. The only place they're distinguishable is Railway logs (via the distinct feature tag, §D) and the `actor`/`error_message` free-text fields if we choose to prefix them (e.g. `error_message: "[submit] 3/5 items added, ..."`) — worth doing cheaply since it costs nothing and helps debugging even though it doesn't create a separate Hub-side stream.

### B. Lifecycle

**Start**: fires inside the server's handling of the *first* `execute:true` POST (`runExecuteV2`/`runExecuteLegacy`), before `runStateGuard` — mirrors "start at the moment the user commits to attempting the real thing," analogous to Bulk Import's start-at-step-transition but here that moment is Submit's *only* commit gesture (there's no earlier "declare intent" step to hang it on, per Q4). `hub_run_id` is generated server-side and returned to the client in every response shape (`execute`, `conflict`, `partial-fail`) so the client can thread it through subsequent requests — same threading pattern as Bulk Import's `hub_run_id` FormData field, just needing to survive up to two additional hops instead of zero.

**Finalize timing — NOT one try/finally, per §1's structural finding**. Finalize happens in whichever of these server code paths is the one that reaches a real terminal outcome:

1. **Legacy path** (`runExecuteLegacy`): finalize in the same request, wrapping the whole function — identical shape to Bulk Import's try/finally.
2. **v2, no conflict, write-phase resolves in one hop** (`runExecuteV2`'s clear-conflict branch all the way through `confirmSubmitV2` or a fully-failed write): finalize in the same request.
3. **v2, conflict detected, first request returns `{phase:"conflict"}`**: do **NOT** finalize in this request — the run stays `RUNNING`. Two ways this resolves:
   - Client cancels → a dedicated call (reusing the existing `/api/iap-management/hub-tracking/cancel` endpoint, or a `cancel`-flagged submit-batch action — see §E) finalizes CANCEL. Zero Apple writes to account for.
   - Client confirms (`confirmConflict:true` re-POST) → this second request now runs the actual write phase and finalizes per outcome (falls into case 2 or 4, just one request later).
4. **v2, write-phase attempted, partial add-failure, first request returns `{phase:"partial-fail"}`**: do **NOT** finalize in this request either (per §3, the outcome isn't settled — though note it near-IS knowable already, see the recommendation below). Resolves via:
   - `proceedPartial` request → `confirmSubmitV2` fires → finalize SUCCESS or PARTIAL (per whether ALL added items get confirmed — always PARTIAL in practice, since reaching this phase implies at least one add failed) in that request.
   - `rollback` request → finalize per §3's decision (recommended: FAIL, with add-outcome counts in `error_message`).

Each of these four finalize sites needs the standard try/finally-with-early-parsed-run-id discipline Bulk Import uses (default to a safe terminal status, e.g. FAIL, overwritten just before a legitimate exit) so an unhandled exception in ANY of them still closes the run rather than leaving it stuck `RUNNING`.

**Cancel points to wire** (wrinkle 2, mapped against the current `SubmitBatchModal.tsx`):

| Cancel point | Current code | Guard state | Hub action |
|---|---|---|---|
| Modal backdrop click / X button before "Submit N ready" is pressed | `onClose` (`:361`, `:380`) | state 1 (not started) | none — no run exists |
| Conflict dialog "Cancel" | `onClick={onClose}` (`:456`) — **needs its own handler**, not the bare `onClose` it has today | state 2 | CANCEL |
| Modal backdrop/X close *while conflict dialog showing* | same `onClose` guard (`:361/:380` — currently unconditionally allows close while `stage.kind==="conflict"`) | state 2 | CANCEL (same as above — needs the same wiring, today it would just discard `hub_run_id` silently) |
| **Tab/browser close while conflict dialog showing** | **does not exist today** — `SubmitBatchModal.tsx` has no `beforeunload` handler at all, unlike `BulkImportWizard.tsx` | state 2 | needs a **new** `beforeunload`+`sendBeacon` handler, added specifically for this feature |
| Partial-fail dialog "Cancel — don't submit" | `handleRollbackPartial` (`:325`) | state 3 | resolves via the `rollback` request itself (§3), not a separate cancel call |
| Modal close / tab close while partial-fail dialog showing | none today | state 3 | per §3's recommendation, this becomes an **abandoned run** if the user never clicks either partial-fail button — flagged as an accepted edge case below, not solved by a cancel call (the guard for state 3 explicitly suppresses client-side cancel, mirroring "once real work started, client must not decide CANCEL" — the same core lesson as Bulk Import's fix) |

**Accepted edge case**: if the user abandons the tab while the partial-fail dialog is showing (state 3) without clicking either button, the Hub run has no natural closer — it stays `RUNNING` until/unless the Hub itself has a stale-run reaper (out of this app's control). This is the direct analog of Bulk Import's original bug in the *opposite* direction (there, cancel fired too eagerly after real success; here, the fix to not fire cancel too eagerly means a truly-abandoned mid-flight state can go unclosed). Given Submit's volumes are small (batches, not a high-frequency background job) and this requires the user to abandon a modal at the exact moment a partial add-failure occurred, recommend accepting this as a known limitation rather than adding complexity (e.g. a server-side timeout sweep) to close it — flag for Manager, don't over-engineer preemptively.

**The guard itself** — `executeCommittedRef` (name chosen to distinguish from Bulk Import's `executeStartedRef`, since "started" here means the *first* execute POST, which is not the same moment as "committed to a real Apple write" once a conflict dialog is involved):

- A `useRef(false)` in `SubmitBatchModal`, set `true` the instant the write phase is known to have begun — i.e., set inside `handleExecuteResult` whenever the response reveals writes happened: on `{phase:"execute"}` (no-conflict, already resolved) or `{phase:"partial-fail"}` (writes definitely happened), and separately inside `handleConfirmConflict` right when that request is fired (since that request IS the write-phase attempt, mirroring Bulk Import's "set the instant the mutating call is invoked" rule exactly).
- `handleExecute`'s own initial POST (the no-conflict-or-unknown-yet moment) does **not** set the ref — at that point we don't yet know whether writes will happen (could still come back as `{phase:"conflict"}`, zero writes). This is the one place Submit's guard-arming moment is provably *later* than "the request was sent," unlike Bulk Import where arming happens synchronously with the call. That's fine — it only matters for the conflict-window cancel-eligibility check, and the conflict dialog only ever appears when writes have NOT happened, so the guard being `false` there is correct.
- Every cancel site above checks `!executeCommittedRef.current` before firing a client-driven cancel call, exactly like Bulk Import's `!executeStartedRef.current` checks.

### C. Status mapping — same enum, shared computation, path-agnostic

`HubTerminalStatus` unchanged: `SUCCESS | FAILED | CANCELLED | PARTIAL`. Both legacy and v2 paths reduce their per-item results to `{total, succeeded, failed}` (v2: `SubmitV2ItemResult[]` mapped `SUCCESS`→succeeded, `ERROR`→failed; legacy: existing `ExecuteResultRow[]` mapped the same way) and feed the **same** `computeBulkImportTerminalStatus` (reuse as-is; a rename to something generic like `computeBatchTerminalStatus` is a nice-to-have for the build, not required). `SKIPPED_BY_STATE_GUARD` rows are excluded from both `succeeded`/`failed` counts, matching the precedent `613a9c3` already established for Bulk Import (an all-skipped batch must not read as FAILED) — flag for confirmation, since submit-batch's skip semantics (a race between preflight and execute) are a slightly different scenario than Bulk Import's, but the same principle (a defensively-blocked row isn't a "failure") applies.

| Path | Scenario | Aggregate | Hub status |
|---|---|---|---|
| Legacy | all succeed | succeeded=N, failed=0 | SUCCESS |
| Legacy | mixed | succeeded>0, failed>0 | PARTIAL |
| Legacy | all fail | succeeded=0, failed=N | FAIL |
| v2, no conflict | all item-adds + confirm succeed | succeeded=N, failed=0 | SUCCESS |
| v2, no conflict | some item-adds fail (`partial-fail` shown) → user proceeds | succeeded=M, failed=N-M | PARTIAL |
| v2, no conflict | some item-adds fail → user rolls back | — | FAIL (§3 recommendation) or CANCEL (§3 alternative — Manager decision) |
| v2, no conflict | all item-adds succeed, confirm PATCH fails | succeeded=0 (nothing reached review) | FAIL, `error_message` notes "N items added but submit PATCH failed" |
| v2, conflict shown | user confirms → resolves per the three rows above | (same as above, one hop later) | (same as above) |
| v2, conflict shown | user cancels | n/a — zero writes | CANCEL |
| any | modal closed / tab closed before first execute press | n/a — no run exists | (no Hub call — nothing to close) |

### D. Logging — submit-distinct feature tag

New `LOG_FEATURE` constant, e.g. `"iap-submit-hub-tracking"`, distinct from Bulk Import's `"iap-hub-tracking"` — same `[hub-tracking]` message-prefix convention so both are greppable together (`grep '\[hub-tracking\]'`) or separately (`grep 'iap-submit-hub-tracking'`), matching the existing dual-grep pattern already established between Apple (`iap-hub-tracking`) and Google (`google-iap-hub-tracking`). Same "never log the token" discipline carries over unchanged — nothing about Submit changes what's safe to log.

### E. Reuse inventory — what's as-is vs what needs submit-specific wiring

**Reuse as-is, zero changes**:
- `config.ts` — `getActiveHubTrackingCredentials()`/`getHubTrackingGate()`, no-cache reader.
- `hub-client.ts` — `hubStartRun`, `hubCloseRun`, the 3000ms real-abort timeout, the no-throw discriminated-result design.
- `computeBulkImportTerminalStatus` — generic already, just called with submit's own aggregate.
- The **existing** `/api/iap-management/hub-tracking/start` and `/api/iap-management/hub-tracking/cancel` routes — these are generic (they take a workflow-agnostic run concept), so Submit's client-side cancel calls (conflict-dialog Cancel, beforeunload during state 2) can hit the exact same `/cancel` endpoint Bulk Import uses. **Confirmed reusable, no new endpoint needed for start/cancel.**

**Needs submit-specific wiring** (new code, not new machinery):
- `startSubmitTracking`/`finalizeHubTracking`-equivalent orchestration calls into `submit-batch/route.ts` at the four finalize sites in §B (not one call site, unlike Bulk Import's one).
- The `hub_run_id` threading through `ConflictResponse`/`PartialFailResponse`/the `confirmConflict`/`proceedPartial`/`rollback` request bodies (new fields on existing shapes — additive, no breaking change to the schemas shipped in `6bb7023`).
- A **new** `executeCommittedRef` guard in `SubmitBatchModal.tsx` (three-state, not Bulk Import's two-state — §2) plus a **new** `beforeunload`/`sendBeacon` handler (this component currently has none).
- Wiring the conflict dialog's "Cancel" button to an actual cancel call (today it's a bare `onClose`, discarding `hub_run_id` with no Hub-side effect).
- The status-mapping decision from §3 (FAIL vs CANCEL for partial-fail rollback) — needs to be locked before build, since it changes which function gets called from `runRollback`.

---

## Summary of what needs Manager sign-off before a build prompt

1. **§3**: "Cancel — don't submit" at the partial-fail dialog → FAIL (recommended) or CANCEL?
2. **§B accepted edge case**: abandoning the tab mid-partial-fail-dialog leaves the run un-closed (`RUNNING` forever) — accept as a known limitation, or worth a mitigation (e.g., a bounded server-side sweep)? Recommend: accept.
3. **§C**: exclude `SKIPPED_BY_STATE_GUARD` rows from succeeded/failed counts (matching Bulk Import's `613a9c3` precedent) — confirm this applies the same way to submit-batch's skip semantics.

Everything else in this design is confirmed-reusable or a direct, low-risk extension of the existing pattern.
