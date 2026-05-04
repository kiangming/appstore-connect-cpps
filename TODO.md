# TODO — Tech Debt & Deferred Work

Format: `- [ ] [PR-X] description — file path — rationale`

## From PR-2 (Team page + guarded user mutations)

- [ ] [PR-2] Replace `zodResolver(schema) as any` cast in team forms — `app/(dashboard)/store-submissions/config/team/*` — temporary workaround for RHF v7 + Zod v4 typing mismatch; revisit when react-hook-form v8 stable ships.
- [ ] [PR-2] Replace `window.confirm()` disable-user flow with shadcn `AlertDialog` — team page disable/demote actions — native confirm is ugly + not themeable; defer to UI polish pass after MVP.
- [ ] [PR-2] `countActiveManagers()` helper currently unused — `lib/store-submissions/queries/*` — keep for future use cases (reports, audit checks). Add `@internal` JSDoc so it isn't flagged as dead code by future sweeps.

## From PR-4 (App Registry CRUD) — discovered during tsc/test runs

- [ ] [PR-4] `countOpenTicketsForApp` in `lib/store-submissions/queries/apps.ts` silently returns 0 when `store_mgmt.tickets` is absent (42P01) so PR-4 can land before PR-5 — revisit after PR-5 lands and drop the fallback so a missing tickets table surfaces as a real DB error.
- [ ] [PR-4] `listApps` search path runs 2 separate queries against `apps.name/slug` and `app_aliases.alias_text`, then unions client-side — acceptable for the expected row counts (~100 apps, ~400 aliases) but should move to a Postgres function once we have >1k apps.
- [ ] [PR-4] `exportAppsCsvAction` reads apps/aliases/bindings/platforms/users in parallel but doesn't stream — fine for current scale, consider a streaming `text/csv` response once row count grows.
- [ ] [PR-4] Upgrade filter pills to Radix `DropdownMenu` — `components/store-submissions/apps/AppsClient.tsx` — native `<select>` overlay is functional but visually inconsistent with the rest of the shadcn ecosystem. Do in the UI polish pass post-MVP.
- [ ] [PR-4] URL-sync row-expansion state in App Registry — `components/store-submissions/apps/AppsClient.tsx` — refresh currently resets expanded rows, minor UX loss. Pattern: encode expanded IDs in `?expanded=id1,id2` and hydrate on mount.
- [ ] [PR-4-hotfix] Generate Supabase `Database` types — `lib/store-submissions/db.ts` — currently `StoreMgmtClient = SupabaseClient<any, any, 'store_mgmt'>` because we don't have schema types. Run `supabase gen types typescript --local > types/supabase.ts` and replace the first `any` with `Database`. Re-run after every migration.
- [ ] [infra] Set up ESLint config — repo root — `next lint` currently drops into an interactive "How would you like to configure ESLint?" prompt because there is no `.eslintrc*` / `eslint.config.*` file. Add a minimal `eslint.config.mjs` (Next.js strict preset) so CI + local verify can run it non-interactively.

## From PR-5 (Email Rules config) — scope / design notes

- [ ] [PR-5] Action surface collapsed from planned "8 Server Actions (CRUD per rule type)" to 2 (`saveRulesAction` + `rollbackRulesAction`) — bulk-replace fits the Save-button UX and keeps version snapshots trivially correct. If a future UX wants inline per-rule edits without a Save button, reintroduce per-rule actions but route them through `save_rules_tx` with a delta to preserve versioning. Surfaced for review.
- [ ] [PR-5] `types` deletion semantics — `save_rules_tx` / `rollback_rules_tx` in `supabase/migrations/20260419071718_store_mgmt_rules_rpcs.sql` upsert-by-slug and soft-deactivate missing types because `tickets.type_id ON DELETE RESTRICT` forbids hard delete. As a side effect, slug renames via the UI produce a new row + deactivate the old one (tickets keep pointing to the inactive row, classifier ignores it). If a UX design ever wants "rename slug" as a true rename, add a separate RPC that updates `types.slug` in place while the ticket FK stays intact.
- [ ] [PR-5] RPC integration tests — `supabase/migrations/20260419071718_store_mgmt_rules_rpcs.sql` is covered by action-level mock tests that simulate sqlerrm strings. Full DB-level race tests (two concurrent `save_rules_tx` calls against a real Postgres asserting exactly one version row was appended) live in an integration suite we haven't stood up yet — file a follow-up once a local supabase/docker test harness exists.
- [ ] [PR-5] Email Rules editor needs an explicit "Discard changes" affordance — mockup only shows "Save changes" + version badge. Browser reload works but an in-UI button is better UX; cover during Chunk 3.
- [ ] [PR-5 polish] VersionHistoryDialog full diff view (2-column snapshots side-by-side) — currently shows per-section counts + note. Upgrade to a textual diff in the polish pass. `getRuleVersionAction` already returns counts only; for full diff it must return the complete config_snapshot (or a new `getRuleVersionSnapshotAction` that does).
- [ ] [PR-5 polish] Save note input — `saveRulesInputSchema` already accepts an optional `note`, but Chunk 3.3 Save button doesn't prompt for one. Add a small "Save with note" affordance (secondary action or dialog with textarea) so Managers can annotate significant rule changes. The infra is already there end-to-end.
- [ ] [PR-5 polish] Add Toaster region-announce + `describedBy` wiring to the VERSION_CONFLICT toast so screen readers surface the Reload action. Sonner's default Toast is `role=status` which may not announce reliably for actionable errors.
- [ ] [PR-5 polish] "Discard changes" button surfaced by the dirty-state invariant — stub only. Matches the pre-existing TODO above; concrete UI is post-MVP.

## From PR-6 (Gmail OAuth Connect flow)

- [ ] [PR-6] Concurrent refresh protection for Gmail tokens — `lib/store-submissions/gmail/credentials.ts`. Two sync runs hitting `ensureFreshToken()` simultaneously could both call Google's refresh endpoint and race to write the new token. Add a Postgres advisory lock or a single-flight in-memory mutex in PR-7 before the sync loop ships. Intentionally deferred from PR-6 because the connect flow is single-user.
- [ ] [PR-6] Replace `window.confirm()` for disconnect with shadcn `AlertDialog` — `components/store-submissions/settings/SettingsClient.tsx`. Matches the PR-2 TODO for the team page disable flow; handle in the same UI polish pass.
- [ ] [PR-6] Client-component render tests — SettingsClient / TeamTable / etc. are untested at the render level because vitest is configured with `environment: 'node'` and no `@testing-library/react`/jsdom. Pure logic (`components/store-submissions/settings/helpers.ts`, action files) is covered. When enough UI bugs accumulate to justify the infra, add jsdom + React Testing Library and backfill render/interaction tests.
- [ ] [PR-6] Settings page Other Sections are placeholders only — Email retention, Gmail polling toggle, Realtime inbox toggle. Wire these up once the corresponding server behaviors exist (retention cron ships in PR-7+, polling toggle requires a `module_settings` row).
- [ ] [PR-6] `revokeTokens` is best-effort — failure is logged but not surfaced to the user, so a Google outage at disconnect time silently leaves a valid refresh_token hanging at Google side. DB row is deleted regardless. Acceptable for MVP; if leakage becomes a concern, add a retry queue or expose the revoke failure in the disconnect toast.

## From PR-7 (Gmail Sync Pipeline)

- [ ] [PR-7 polish] Audit all test files: replace `vi.clearAllMocks()` with `vi.resetAllMocks()` in `beforeEach` to prevent `mockImplementationOnce` / `mockReturnValueOnce` queue leak between tests. Found during 7.3.1 `sync.test.ts` debug — the "stats aggregation" test failed because a previous test's queued parser impls stayed in the queue. `clearAllMocks` only wipes call history, not the Once queues. Scope: ~30 test files in the codebase.
- [ ] [PR-7 polish] Replace synthetic MIME fixtures in `lib/store-submissions/gmail/__fixtures__/index.ts` with real anonymized samples from the shared mailbox (1 each: Apple, Google Play, Huawei, FB). Strip sensitive fields, use fake app names. Synthetic fixtures are good enough to exercise the parser's shape handling; real samples improve rule calibration accuracy.
- [ ] [PR-7 polish] Add `pg_cron` job (or a daily cleanup endpoint) to delete `store_mgmt.sync_logs` older than 90 days. Currently unbounded growth — ~288 rows/day from the every-5-min cron = ~100K rows/year. Small per-row; housekeeping avoids surprise later.
- [x] [PR-7] Sentry wiring for the sync endpoint — `app/api/store-submissions/sync/gmail/route.ts`. ✅ Resolved by PR-10d.1.2 (commit `085e422`): `instrumentation.ts` + `sentry.server.config.ts` boot Sentry; the 500-path now calls `Sentry.captureException(err, { tags: { component: 'gmail-sync', endpoint: 'cron-tick' } })`.
- [ ] [PR-7] Manual "Sync now" button in Settings page — trigger `POST /api/store-submissions/sync/gmail` via a Server Action, rate-limit 1/min per user. Emits `sync_method='MANUAL'` (value reserved in the `sync_logs` CHECK constraint, not yet produced by the cron path).

## PR-7 Post-Ship Polish (surfaced from 2026-04-21/22 production deployment)

- [x] [PR-polish] App Creator dialog UX — require ≥1 platform binding at creation OR auto-select all active platforms by default. Unbound app invisible to classifier (`loadAppsForPlatform` in `lib/store-submissions/queries/rules.ts` gates on `app_platform_bindings`). Silent miss harder to debug than form validation error. Ref: incident 2026-04-21/22 (Đấu Trường Chân Lý, Thiên Long Bát Bộ VNG, Top Eleven all needed manual `app_platform_bindings` INSERT to unblock classification). **Fixed 2026-04-23 — see PR-polish section below.**
- [ ] [ops] Migration deploy automation — investigate Supabase CLI + Railway auto-apply migrations on push. Manual "Path G" SQL-Editor workflow caused 2 production incidents during PR-7 deployment: sync lock migration (`20260420000000_store_mgmt_gmail_sync_lock.sql`, cron crashed with "try_acquire_sync_lock does not exist") + app RPCs migration (`20260419050324_store_mgmt_app_rpcs.sql`, App Registry UI broken with "create_app_tx does not exist"). Priority: raise from backlog.
- [x] [PR-7 polish] MIME parser charset handling — ✅ resolved by PR-14 (2026-05-01). Production corruption pattern `Da:%u TrF0a;ng ChC"n LC"` was NOT a charset issue. Root cause: parser's `raw.toString('ascii')` step (line 386-395 pre-fix) masked every byte with `& 0x7F`, false-positive-triggering QP decode on raw-UTF-8 bodies Apple mislabeled as `Content-Transfer-Encoding: QUOTED-PRINTABLE`. Byte `0xC4` (Đ lead) → `0x44` (D); `0xBD` (ý tail) → `0x3D` (`=`) followed by CRLF triggered the soft-break decoder; cascading corruption. Fix: byte-level decoder in `decodeQuotedPrintable(raw: Buffer, charset)` — walks bytes directly, only literal ASCII `0x3D` triggers escape parsing, bytes ≥ `0x80` pass through. Same 5-charset support retained (UTF-8 default + Latin-1 / cp1252 / us-ascii / UTF-16LE).
- [ ] [PR-7 polish] Apple subject pattern migration seed drift — production UI was updated with a pattern that strips the `(iOS)` suffix: `^Review of your (?<app_name>.+?) (?:\(iOS\) )?submission is complete\.$`. Update `supabase/migrations/20260101100200_store_mgmt_seed_apple_rules.sql` to match so future dev environments don't regress. Original seed lacked `(iOS)` handling → extracted app names included the suffix → app lookup miss.
- [ ] [rules calibration] Apple type rules populate — currently Apple emails stop at `UNCLASSIFIED_TYPE` (Steps 1–3 pass; Step 4 type keyword miss). Manager task via the Email Rules UI: populate type keywords for APPROVED outcomes (sample keywords from real bodies: "eligible for distribution", "review completed", "App Store Review"), REJECTED, PENDING states. Not a code bug — ongoing operational calibration as new Apple email templates surface. PR-8 ticket engine will still route UNCLASSIFIED_TYPE rows into the Unclassified bucket when it lands; type calibration is a forward-rolling improvement.

## PR-8 — Email Rule Engine wiring ✅ COMPLETED (2026-04-22)

Thin wire layer bridging classifier output → ticket engine. Stub engine returns ephemeral UUIDs; PR-9 drops in real engine behind same signature.

**Shipped:**
- `lib/store-submissions/tickets/types.ts` — `TicketableClassification` union + `isTicketableClassification` type-guard (single source of truth for wire pre-gate + engine defense-in-depth).
- `lib/store-submissions/tickets/engine-stub.ts` — ephemeral `randomUUID()` stub, throws `TicketEngineNotApplicableError` on non-ticketable status.
- `lib/store-submissions/tickets/wire.ts` — `associateEmailWithTicket(emailMessageId, classification)`, graceful errors, `[tickets-wire]` ERROR log prefix.
- `lib/store-submissions/gmail/sync.ts` — `insertEmailMessageRow` signature change (`Promise<void>` → `Promise<{id} | null>` with `.select('id').single()`), wire integration post-INSERT, **defensive try/catch** preventing cursor-wedge bug.
- +25 tests (14 tickets module + 11 sync wire integration).

**Deferred polish (low priority):**

- [ ] [PR-8 polish] `stats.tickets_associated` counter in `SyncStats` + `sync_logs` payload. Would touch the `sync_logs` schema (new column) — migration + `insertSyncLog` signature update. Derivable post-hoc via `SELECT count(*) FROM email_messages WHERE ticket_id IS NOT NULL AND processed_at > ?`. Punt unless observability actually needs it.
- [ ] [PR-8 polish] Wire success log at DEBUG level (currently silent on success, ERROR on failure). Would give per-message trace for production debugging but add ~2880 log lines/day on the every-5-min cron. Revisit only if a real debugging incident demands it; current `[tickets-wire]` ERROR coverage + `ticket_id IS NOT NULL` SQL queries are sufficient.

## PR-9 — Ticket Engine implementation ✅ COMPLETED (2026-04-23)

Replaced the PR-8 stub with a real transactional find-or-create + state machine + event log. Adapted spec's Prisma-flavored `db.$transaction` syntax to a Supabase-native PL/pgSQL RPC. Wire + sync unchanged — drop-in interface.

**Shipped (7 atomic sub-chunks + docs):**

| Sub-chunk | Commit | Scope |
|---|---|---|
| 9.1 | `cd96140` | Extend `FindOrCreateTicketOutput` (+3 optional fields) + new `TicketRow` type + spec banner + `docs/store-submissions/CURRENT-STATE.md` (new doc) |
| 9.2 | `ae3ed3e` | Migration `20260423000000_store_mgmt_ticket_engine_rpc.sql` — RPC `find_or_create_ticket_tx(p_classification JSONB, p_email_message_id UUID) RETURNS JSONB` + partial unique index `idx_store_mgmt_ticket_entries_email_idempotency` |
| 9.3 | `4a30cca` | Real `engine.ts` replacing deleted `engine-stub.ts` + 4 typed error classes + 15 engine tests |
| 9.4 | `4edc479` | Wire regression tests — pin error-agnostic catch + minimal-interface contract |
| 9.5 | `3b7a637` | State transition matrix (9 rows + resubmit) + terminal fall-through + novelty + idempotency tests (+17) |
| 9.6 | `e7c08b3` | Backfill migration `20260423100000_store_mgmt_backfill_ticket_id.sql` for PR-8-era NULL rows |
| 9.7 | `718f62d` | End-to-end pipeline integration tests — real wire + real engine, only Supabase mocked (+13) |
| 9.8 | this commit | Docs finalization (CURRENT-STATE.md, 04-ticket-engine.md §0, 03-email-rule-engine.md §14, TODO.md) |

**Test count:** 719 (pre-PR-9) → **785** (post-PR-9) = **+66 tests**.

**Key design adaptations from spec:**

- Spec uses Prisma (`db.$transaction`, `tx.$queryRaw`); implementation uses Supabase JS + PL/pgSQL RPC — see `04-ticket-engine.md` banner.
- Race strategy: `SELECT ... FOR UPDATE` → on miss `INSERT` → catch `unique_violation` → loop (3-iter budget). Partial unique index `idx_tickets_open_unique` is the canonical race arbiter.
- EMAIL entry idempotency: DB-enforced via partial unique index + `ON CONFLICT DO NOTHING` (vs app-level guard) — prevents dup EMAIL entries on sync retry.
- Deviation from §3.3: empty `type_payload` `{}` normalized to NULL at RPC extraction so audit trail stays signal-rich. Documented in migration header.

**Deferred polish (post-ship, low priority):**

- [ ] [PR-9 polish] `stats.tickets_associated` counter in `SyncStats` + `sync_logs` payload. Schema change — migration + `insertSyncLog` signature update. Derivable via `SELECT count(*) FROM email_messages WHERE ticket_id IS NOT NULL AND processed_at > ?`. Punt unless observability demands it.
- [ ] [PR-9 polish] Wire success log at DEBUG level (silent on success today). Would add ~2880 log lines/day on 5-min cron — revisit only on real debugging need.
- [x] [PR-9 polish] Surface `TicketEngineRaceError` + `TicketEngineNotFoundError` via Sentry. ✅ Resolved by PR-10d.1.2 (commit `085e422`): both engine errors are captured at the wire.ts swallowing boundary with `tags: { component: 'ticket-engine', phase: 'find-or-create' | 'update-link' }` so the graceful-null contract still holds while ops gets alerted.

**Post-deploy verification queries** in `20260423100000_..._backfill_ticket_id.sql` header comments (pre-apply preview + post-apply `without_ticket_id = 0` assertion).

## PR-polish — App Creator platform binding fix ✅ COMPLETED (2026-04-23)

Fixed: Dialog silently dropped platforms without `platform_ref`. Now checkbox
gate + submit validation require ≥1 platform selected. Edit-mode binding diff
reworked to `hadBinding vs wantsBinding` semantic (decoupled from ref presence).

**Root cause.** `AppDialog.collectBindingsForCreate()` filtered by
`platform_ref.trim() !== ''` instead of user intent. Classifier gates on
`platform_id` via `loadAppsForPlatform` — `platform_ref` is not read in the
visibility check. Apps created with empty refs got zero binding rows and
became invisible to the classifier → UNCLASSIFIED_APP.

**Shipped (5 atomic sub-chunks):**

| Sub-chunk | Scope |
|---|---|
| S.1 | `AppDialog.tsx` — `enabled` flag per platform, checkbox UI, disabled inputs, filter by `enabled` (not by ref) |
| S.2 | Submit guard (≥1 platform) + edit-mode rewrite (DELETE / CREATE / UPDATE via `hadBinding` × `wantsBinding` matrix) |
| S.3 | Extracted `components/store-submissions/apps/app-dialog-logic.ts` (pure helpers) + 11 unit tests; `AppDialog.handleSubmit` rewrote 100 → 55 LOC dispatcher |
| S.4 | Docs — this entry + `CURRENT-STATE.md` known-quirk entry |
| S.5 | `AppsClient.tsx` — "No platforms" red audit badge on list rows with zero bindings (defensive UX for historical unbound rows) |

**Test count:** 785 → **796** (+11 pure unit tests covering validation, create payload, and edit action plan including the 3 critical binding scenarios: DELETE, UPDATE-clear-ref, CREATE-without-ref).

**Zero infrastructure changes.** No migration, no RPC change, no API contract change — classifier and `create_app_tx` already handled nullable `platform_ref`; only the dialog UX needed fixing.

### Manual QA items (post-ship verification)

- [ ] Create app with Apple checkbox checked + ref blank → success, binding row created with `platform_ref = NULL`
- [ ] Edit existing app, uncheck a platform → binding row DELETE'd
- [ ] Edit existing app, clear a filled ref (checkbox stays checked) → binding row UPDATE'd with `platform_ref = NULL`
- [ ] Create app with zero platforms checked → toast error `"Please select at least one platform"`, no action call
- [ ] Disabled-input styling: unchecking a platform grays its ref + console URL inputs and blocks typing
- [ ] `<label>` wrapping row: clicking anywhere on a platform row toggles the checkbox (a11y pattern)
- [ ] `/config/apps` list: any app with zero bindings shows a red "No platforms" badge next to its `0 / 4` platform count

## PR-10c — Ticket user actions ✅ COMPLETED (2026-04-25)

Wire user-driven state transitions + comment + reject-reason flows on top of the email-driven engine shipped in PR-9. Adds 7 PL/pgSQL `*_tx` RPCs (spec §7), a TypeScript dispatcher with `executeTicketAction(actor, ticketId, action)`, role-gated UI footer + composer in the inbox detail panel, and timeline cards for the new entry types. Builds on PR-10a (list) + PR-10b (detail panel shell).

**Shipped (8 atomic sub-chunks):**

| Sub-chunk | Commit | Scope |
|---|---|---|
| 10c.1.1 | `6dc8a6c` | `state-machine.ts` pure helpers (action → next state derivation) + 46 tests |
| 10c.1.2 | `ee27ef1` | `user-actions.ts` dispatcher + `tickets/auth.ts` per-action permission matrix + 46 tests |
| 10c.1.3 | `1a58363` | Migration `20260424000000_store_mgmt_user_actions_rpcs.sql` — 7 RPCs (archive / follow_up / mark_done / unarchive / add_comment / edit_comment / add_reject_reason) |
| 10c.1.4 | `fc7c18c` | User-actions integration tests (Supabase mocked, RPC error mapping covered) +24 |
| 10c.2 | `b970517` | Inbox state-transition actions UI — 4 footer buttons + 10s Undo toast for ARCHIVE +20 |
| 10c.3.1 | `0819dbc` | `CommentForm` (always visible) + reject-reason composer (toggle-revealed) +10 |
| 10c.3.2 | `0257b83` | `CommentEntryCard` + `RejectReasonEntryCard` timeline renderers + `EditCommentForm` wired for own comments + trigger keyword fix (`'user' → 'user_action'` per spec §7.3) + currentUserId threaded 4 layers |
| 10c.3.2.2 | `b833172` | RTL infra (`@vitejs/plugin-react`, `jsdom`, `jest-dom`, vitest setupFile) + 10 timeline component tests |

**Test count:** 827 (pre-PR-10c) → **983** (post-PR-10c) = **+156 tests**.

**7 user actions production-ready:** archive / follow_up / mark_done / unarchive / add_comment / edit_comment / add_reject_reason. Authorization matrix matches spec §7.2 (DEV/MANAGER permissive, VIEWER read-only, UNARCHIVE Manager-only).

**Critical fix:** trigger keyword mismatch between RPC migration (`metadata.trigger='user_action'`, spec-canonical) and the timeline renderer (`=== 'user'`) — would have surfaced post-deploy as STATE_CHANGE entries falling through to UnknownEntryCard. Caught + fixed in 10c.3.2 with regression test in 10c.3.2.2.

**Foundation unblocked by 10c.3.2.2:** RTL component-test infra now in place. Future timeline / form / detail-panel tests no longer need infra setup — drop in `// @vitest-environment jsdom` directive and write.

**Pending after this commit:**

- [ ] Path G — apply migration `20260424000000_store_mgmt_user_actions_rpcs.sql` via Supabase SQL Editor (production)
- [ ] Manual QA scenarios: 4 state buttons / 10s Undo / comment add+edit ownership / reject reason / timeline render of all 5 entry types / VIEWER hides actions / DEV-MANAGER full functionality

## PR-10d — Polish + Observability ✅ COMPLETED (2026-04-25)

Production observability + UX polish. Wires Sentry SDK end-to-end and adds keyboard navigation. Closes the PR-7 + PR-9 deferred Sentry debt.

**Shipped (4 sub-chunks):**

| Sub-chunk | Commit | Scope |
|---|---|---|
| 10d.1.1 | `0fdaf92` | Sentry init — `instrumentation.ts` + `sentry.server.config.ts` + `sentry.edge.config.ts` + `instrumentation-client.ts` (modern v10 pattern, replaces deprecated `sentry.client.config.ts`) + `withSentryConfig` wrap in `next.config.mjs` + `.env.example` additions |
| 10d.1.2 | `085e422` | `Sentry.captureException` in 3 production error paths — gmail-sync 500 fallback, ticket-engine wire.ts (both catch sites), inbox-actions unmapped DB_ERROR. `Sentry.setUser` auto-binds via `guardDevOrManager`. Resolves TODO.md PR-7 + PR-9 debt. |
| 10d.1.3 | `83dee62` | Route-level error boundary `app/(dashboard)/store-submissions/inbox/error.tsx` + root-layout fallback `app/global-error.tsx`. Resolves the SDK's `global-error.js` warning. |
| 10d.2 | `f73355d` | j/k row navigation + Enter to open via `react-hotkeys-hook` v5. `focusedIndex` state with `ticketsKey`-stable reset. Desktop-only hint strip. Bundle 11 → 13.7 kB. |

**Tag taxonomy established:**
- `component`: `gmail-sync` | `ticket-engine` | `inbox-actions` | `inbox-error-boundary` | `global-error-boundary`
- Subcontext: `phase` | `endpoint` | `action`
- User context auto-bound via `guardDevOrManager` (id + role; email omitted as PII)
- PII filter in `sentry.server.config.ts#beforeSend` redacts `body` / `email` / `content` keys (Apple/Google reviewer text never transits)

**Capture scope discipline:**
- DO capture: 500 errors, race conditions, unmapped DB failures, swallowing-boundary catches
- DON'T capture: typed business errors (state guards, ownership checks, validation) — would flood Sentry with normal flow

**Test count:** 983 unchanged (10d.2 logic too trivial to merit unit tests; E2E is the value-adding test type and was deferred per scope).

**Pending:** push 4 commits to `origin/main`.

## Post-PR-10 — Reclassify feature ✅ COMPLETED in PR-11 (2026-04-25)

Shipped in 7 sub-chunks. See `docs/store-submissions/CURRENT-STATE.md`
"PR-11 — HTML Parsing + Reclassify" section + commits
`cb4480c..130f35e + 11.7-docs`. Original use cases all addressed
(UNCLASSIFIED_APP → CLASSIFIED after App Registry add, UNCLASSIFIED_TYPE
→ CLASSIFIED after type seed, DROPPED via sender re-resolve).

**Architecture**: TS classifier + SQL atomic swap (RPC `reclassify_email_tx`)
— see PR-11.5 commit `f00cac7` rationale. Spec §5.2 ticket-level
reclassify (move all emails of a ticket via merge) remains future work,
tracked under "PR-11 deferred items" below.

## PR-11 — HTML Parsing + Reclassify ✅ COMPLETED (2026-04-25)

7 sub-chunks. See `docs/store-submissions/CURRENT-STATE.md` for full detail.

**Test count:** 983 (pre-PR-11) → **1036** (post-PR-11) = **+53 tests**.

**3 migrations pending Path G** (apply in order):

1. `20260425000000_store_mgmt_email_extracted_payload.sql` — add JSONB column + GIN index
2. `20260425000001_store_mgmt_seed_apple_ppo_type.sql` — PPO type seed
3. `20260425000002_store_mgmt_reclassify_rpc.sql` — `reclassify_email_tx` RPC

### Deferred from PR-11 (post-MVP)

- [ ] [PR-11 polish] **Real PL/pgSQL execution tests for `reclassify_email_tx`** — current 19 tests in `app/(dashboard)/store-submissions/inbox/reclassify-actions.test.ts` mock the RPC at the Server Action boundary. End-to-end against a migration-applied DB (with `find_or_create_ticket_tx` reuse paths exercised) requires the same Supabase local docker harness that PR-5's TODO line 25 requested. File together when the harness lands. Manual QA Path G validates production in the meantime.
- [ ] [PR-13+ polish] **Multi-platform HTML extractors** — `extractGoogle` / `extractHuawei` / `extractFacebook`. Need real `.eml` samples first. Current `lib/store-submissions/gmail/html-extractor.ts` is Apple-coupled by name. Shared `ExtractedPayload` shape is the contract. Activate when prod sees enough volume from those platforms to need structured extraction. **Backfill button (`backfill-actions.ts`) is also Apple-only by `appleEmails` SQL filter — multi-platform extractor + multi-platform backfill ship together when each platform's extractor lands.**
- [x] [PR-11 polish] **Rejected items HTML parser** — ✅ Resolved by PR-12.1+12.2 (commit `b1060e8`): `extractApple(html, subject?)` rejection branch + `outcome` audit flag + `items` rename + IAE optional count. 4 rejection `.eml` fixtures captured (App Version / IAE / CPP / PPO) + 8 new extractor tests.
- [ ] [PR-11 polish] **Auto-archive empty old tickets** — when reclassify moves the last email out of an Unclassified bucket, the old ticket may end up with zero emails. Currently left for Manager cleanup. Could ship a "sweep empty buckets" cron job or a "Empty bucket" badge on the inbox list. Decide based on real Manager workflow feedback.
- [ ] [PR-11 polish] **`UnifiedClassificationResult` typing cleanup** — `lib/store-submissions/gmail/sync.ts` and `app/(dashboard)/store-submissions/inbox/reclassify-actions.ts` both relax to `Record<string, unknown>` for the persisted classification because the classifier's `ErrorCode` union doesn't include sync-layer concerns (`NO_RULES`, `NO_SENDER_MATCH` from non-classifier paths). Unify into a `PersistedClassification` type that's a superset of `ClassificationResult`. Cosmetic.
- [ ] [PR-13+] **Spec §5.2 ticket-level reclassify (merge)** — move all emails of a ticket via Manager UI; if the new grouping key collides with an open ticket, MERGE entries + emails into the conflict ticket and delete the source. PR-11 ships email-level reclassify (the operational use case); ticket-level merge is the design described in `docs/store-submissions/04-ticket-engine.md` §5.2 lines 589-676.

## PR-12 — Apple rejection parser + Backfill button MANAGER ✅ COMPLETED (2026-04-27)

4 commits (down from 7-chunk plan via subsume discipline):

| Commit | Scope |
|---|---|
| `b1060e8` | **PR-12.1+12.2 bundle** — `extractApple(html, subject?)` rejection branch + `outcome` audit flag + `items` rename + IAE optional `(N)` count + `extractIdAndName` (Submission ID + App Name parse) + 4 rejection `.eml` fixtures + restructured `html-extractor.test.ts` (4+4+4+6 tests). Sync wire threading + classifier audit comment subsumed (12.3 + 12.4 absorbed). |
| `f4188db` | **PR-12.5** — `lib/store-submissions/reclassify/core.ts` extraction (~200 lines) + `backfill-actions.ts` (~370 lines) + `BackfillButtons` UI component. Sentry `backfill-action` taxonomy. |
| `00419bc` | **PR-12.6** — 8 backfill action tests (single happy + bulk happy + bulk empty + VIEWER × 2 + per-row resilience + Apple-only filter × 2). |
| this commit | **PR-12.7** — Docs finalization. |

**Test count:** 1036 (pre-PR-12) → **1053** (post-PR-12) = **+17 tests** (8 extractor + 8 backfill action + 1 IAE-no-parens, accounting for restructure).

**No migrations** — PR-12 is application-layer only. The shape rename
(`accepted_items` → `items`) reuses the existing JSONB column; the
Postgres `COMMENT ON COLUMN` in
`20260425000000_store_mgmt_email_extracted_payload.sql:20` is left
stale per the no-down-migrations rule and tracked under PR-13+ schema
cleanup below.

**Production state:** 14 legacy UNCLASSIFIED rows pre-PR-11.3 carry
`extracted_payload IS NULL`; 0 Apple emails arrived post-2026-04-25
deploy so the PR-11.3 wire was untested in production. PR-12 self-
verified via 8 fixtures (4 acceptance + 4 rejection); production
verification ships via the **Backfill 1 row (test)** button — run that
first, verify Sentry breadcrumbs, then **Backfill all** for the bulk.

### Deferred from PR-12 (post-ship, low priority)

- [ ] [PR-13+ schema cleanup] **Refresh `COMMENT ON COLUMN extracted_payload`** — `supabase/migrations/20260425000000_store_mgmt_email_extracted_payload.sql:20` still reads `Shape: { accepted_items: AcceptedItem[] }` after the PR-12 rename. Postgres metadata comment, not enforced. Refresh on the next forward migration that touches the column.
- [ ] [PR-13+ polish] **Sentry breadcrumb cap formalization for backfill** — current 4-stage × 14-row max = 56 breadcrumbs (well under Sentry default 100). Multi-platform expansion may push past — add explicit `cap-at-first-N + summary` pattern in `backfill-actions.ts` when batch sizes grow past ~20 candidates.
- [ ] [PR-13+ extraction] **Per-row backfill affordance in EmailEntryCard** — `backfillSingleEmailAction(emailId)` is exported and tested but currently unused by UI (the Manager Unclassified banner uses bulk-with-limit:1). When ticket detail panel needs a "re-extract this specific email" affordance (e.g. a Manager investigating a specific email's outcome), wire the per-email button via `entry.email_message_id`. Pattern matches the existing `ReclassifyEmailButton` in `TicketEntriesTimeline.tsx`.
- [ ] [PR-13+ test infra] **Vitest cold-start flake** — observed 1052/1053 once on first full suite run after `backfill-actions.test.ts` added (3 consecutive subsequent runs all 1053). Not specific to backfill tests; likely a vitest module loading race during cold start. If it recurs, investigate `vi.mock` hoisting timing or test file ordering.
- [ ] [PR-13+ polish] **Multi-platform backfill expansion** — `backfill-actions.ts` is Apple-only by `appleEmails` SQL filter. Ships together with multi-platform HTML extractors (see PR-13+ multi-platform note above).

## PR-13 — Outcome filter dimension separation ✅ COMPLETED (2026-04-30)

4 commits (single session, ~4h):

| Commit | Scope |
|---|---|
| `d556fc6` | **PR-13.1** — Backend: `outcomeFilterSchema` (enum ∪ `'none'` literal) threaded into `ticketsQuerySchema` + `listTickets` predicate (`'none'` → `.is('latest_outcome', null)`, enum → `.eq`) + URL parser via `firstOf` + 8 tests (4 schema/parser + 4 query). Backward compat verified — existing `?state=APPROVED` bookmarks parse and filter identically. |
| `346785a` | **PR-13.2** — UI tab consolidation + chip row: drop standalone Rejected tab (was conflated with outcome dimension, masked Issue 2) + 5-tab final (Open/Approved/Done/Archived/Unclassified) + 5-chip outcome row (All/Approve/Reject/In review/No outcome) + visual hierarchy (tabs underline / chips pill rounded-full) + `aria-pressed` + chip-survives-tab-switch via `baseParams.scalarKeys` + chips hidden on Unclassified tab. Bundle inbox 15.1 → 15.2 kB (+0.1 kB). |
| `41f0a84` | **PR-13.3** — Empty-state refresh: pure helper extraction (`lib/store-submissions/inbox/empty-message.ts`) + Hybrid Option C decision tree (5 branches: hasOtherFilters → generic; unclassified → triage; outcome='none' → "All {tab} have outcome assigned"; outcome=enum → "No {tab} with outcome '{label}'. Try clearing chip filter."; default → tab-specific) + `hasOtherFilters` vs `hasActiveFilters` split (different consumers, different semantics — empty-message branching vs Clear-button surface) + 5 tests. Net InboxClient -24 lines. |
| this commit | **PR-13.4** — Docs (CURRENT-STATE.md PR-13 milestone + 03-email-rule-engine.md 3-dimension paragraph + 04-ticket-engine.md PR-13 §0 subsection + this entry). |

**Test count:** 1053 (pre-PR-13) → **1067** (post-PR-13) = **+14 tests** cumulative.

**Bundle inbox:** 15.1 → **15.4 kB** (+0.3 kB across 4 commits, well under +0.5–1 kB target).

**No migrations** — PR-13 is application-layer only (read-side UI affordance + URL/query schema). Engine, RPC, and `latest_outcome` flow unchanged.

**Issue 2 resolved.** PR-12 backfill populated `tickets.latest_outcome` at production scale for the first time, exposing a pre-existing UI dimension misalignment: tickets with `state=IN_REVIEW` + `latest_outcome=APPROVED` showed "Approve" in the Outcome column but were filtered out of the "Approve" tab (which queried `state=APPROVED`). Not a regression — exposure surfaced by Q1 Option A discipline correctly populating the dimension. Fix surfaces outcome as first-class chip refinement WITHIN state tabs, with clear 3-dimension model documented (state / latest_outcome / classification_status).

### Risk flags bumped from PR-13 close

- [x] [PR-14] **Issue 1 — UTF-8 body preview** — ✅ resolved by PR-14 (2026-05-01). Surfaced from PR-12 close, scoped under PR-14 after PR-13 shipped. Hypothesis flipped multiple times during investigation (charset → Apple-side broken → parser bug); root cause was the `raw.toString('ascii')` byte-mask step in `decodeQuotedPrintable`. Fix shipped + 14 functional production rows backfilled via the maintenance banner.
- [ ] [PR-18+] **Per-row backfill affordance in EmailEntryCard** — see PR-12 deferred items (line 264). Same scope.
- [ ] [PR-18+] **Multi-platform extractor expansion** — see PR-11/PR-12 deferred items.
- [ ] [PR-18+] **Migration COMMENT refresh** + **Sentry breadcrumb cap formalization** + **Vitest cold-start flake** + **Gmail OAuth token resilience** — all infra cleanup deferred from PR-12.
- [ ] [PR-18+] **Spec §5.2 ticket-level merge** — see PR-11 deferred items (line 231).

## PR-14 — Byte-level QP decoder + corrupt-payload backfill ✅ COMPLETED (2026-05-01)

5 commits (single multi-step session, ~5h with investigation):

| Commit | Scope |
|---|---|
| `d20c898` | **PR-14.1+14.2 bundle** — Byte-level QP decoder rewrite. Replaced `decodeQuotedPrintable(input: string, charset)` with `(raw: Buffer, charset)` byte walker. `decodePartBody` no longer runs `raw.toString('ascii')` (the `& 0x7F` mask step that turned UTF-8 bytes `0xC4 0x90` into `D \u0010`, etc.). New synthetic fixture `edgeAppleMislabelUtf8` mirrors TICKET-10009 wire shape (multipart/alternative, both parts CTE: QUOTED-PRINTABLE, text/plain raw UTF-8, text/html mixed `=3D` + raw UTF-8). 4-layer diagnostic block (Layer 1 RFC 2047 continuation-line `.skip()`, Layers 2-4 unskipped). +3 tests. |
| `66223da` | **PR-14.3** — Charset coverage fixtures + tests. Chinese (`彈彈英雄`, 3-byte UTF-8), Japanese mixed scripts (`テスト『日本語アプリ』ゲーム`), emoji (`🎮 Crystal Quest 🐉`, 4-byte → UTF-16 surrogate pair pinned `\uD83C\uDFAE`), mixed-encoding (genuine `=C3=A9` QP escape + raw UTF-8 `0xC3 0xA9` decode identically to `é`). +4 tests. |
| `2ee80e8` | **PR-14.4** — `backfillCorruptPayloadAction` + maintenance banner D2. Apple-only re-fetch + re-parse + re-extract pipeline targeting rows whose `extracted_payload->>'app_name'` or `raw_body_text` carry control-byte residue. PostgREST `.or()` regex filter on `[\x01-\x08\x0B\x0C\x0E-\x1F]` (verify-then-fallback per Decision 3; RPC fallback documented inline). MANAGER-only Sentry tag `variant: 'corrupt-payload'`. New `lib/store-submissions/backfill/core.ts` extraction (mirrors PR-12.5 `reclassify/core.ts` precedent); `backfillOne` now writes BOTH `raw_body_text` + `extracted_payload`, so NULL-payload backfill incidentally repairs any byte-mask corruption in the same row. New `lib/store-submissions/queries/corrupt-payload.ts` count probe (MANAGER-only, head:true, gracefully degrades to 0). New `CorruptPayloadBanner` subcomponent rendering above state tabs (D2 override of locked Decision 4 D1 — corrupt rows are CLASSIFIED status, not Unclassified, so D1 would have hidden the action). +5 tests. |
| this commit | **PR-14.5** — Docs (CURRENT-STATE.md PR-14 milestone + 02-gmail-sync.md §4.3.1 MIME body decode subsection + this entry). Cleanup verification (diagnose-message diagnostic API route absent, no stale scripts). |

**Test count:** 1067 (pre-PR-14) → **1079** (post-PR-14) = **+12 tests** cumulative. 1 deferred `it.skip()` placeholder for Layer 1 RFC 2047 continuation-line bug.

**Bundle inbox:** minor increase from new `CorruptPayloadBanner` subcomponent + `Wrench` icon import.

**No migrations** — PR-14 is application-layer only (parser fix + new Server Action + UI banner + new query module). No schema change. Forward-only fix; new emails post-deploy parse correctly via the byte-level decoder.

**Production scope at fix time** — 14 functional rows (`extracted_payload IS NOT NULL`, `classification_status != 'DROPPED'`) across 4 distinct apps (Đấu Trường Chân Lý / TFT VN, LMHT: Tốc Chiến / LoL Wild Rift VN, 彈彈英雄, 創世紀戰M：阿修羅計畫). 189 additional rows hit the regex but were DROPPED — left alone per Decision 2 (functional impact only).

### Investigation discipline (4 hypothesis pivots earned by data)

1. **Synthetic real-QP fixture passed** — proved parser handles real QP correctly; bug had to be elsewhere.
2. **Layer 1 RFC 2047 continuation-line bug discovered** — real but orthogonal to production symptom (subjects render fine in prod). Parked PR-18+.
3. **Production SQL diagnostic confirmed BOTH `raw_body_text` and `extracted_payload` garbled** — same parser path; parser was the culprit.
4. **Diagnostic API route revealed Apple's wire bytes are correct UTF-8** — parser corrupts them via `raw.toString('ascii')` byte-mask. Synthetic fixture had used real QP encoding; real Apple emails ship raw UTF-8 with the QP header lying. Mislabel was the missing fixture variant.

The diagnostic API route (`GET /api/store-submissions/diagnose-message?id=…`) was deleted before any commit — investigation ephemeral, not shipped.

### Decision overrides (vs locked plan)

- **Banner placement: D2 over D1.** Locked plan was D1 (3rd button in Unclassified-tab banner). Codebase grounding revealed corrupt rows are CLASSIFIED status (Open/Done tabs), not Unclassified. D1 would have hidden the action behind a tab where the rows don't appear. D2 ships a separate amber maintenance banner above state tabs, visible on every tab when count > 0.
- **`.or()` regex over RPC migration (Decision 3 = verify-then-fallback).** Direct PostgREST `.or()` syntax shipped; RPC fallback documented inline for hot-pivot if production rejects.

### Open follow-ups (PR-18+)

- [ ] [PR-18+] **Layer 1 — RFC 2047 subject continuation-line whitespace** — `decodeRfc2047` in `parser.ts` runs the per-word decode before the `\?=\s+=\?` collapse pass; encoded-word markers are gone by the time the collapse runs and orphan whitespace leaks (e.g. `Chơi Nga y Game` instead of `Chơi Ngay Game`). Real bug confirmed by Layer 1 diagnostic but separate decoder, separate symptom from the production-reported PR-14 corruption. Tracked as `it.skip()` placeholder in `parser.test.ts` with fix-pointer comment.
- [ ] [PR-14 manual QA] **PostgREST `.or()` regex runtime validation** — verify the candidate filter and count probe work in production. Hot-pivot to the RPC fallback in `app/(dashboard)/store-submissions/inbox/backfill-corrupt-actions.ts` if rejected.
- [ ] [PR-18+] **Auto-mark-done APPROVED logic** + **duplicate ticket entries bug** — surfaced in earlier PR-12/13 close; not addressed in PR-14.

## PR-15 — Slug generator non-ASCII support ✅ COMPLETED (2026-05-01)

3 commits (single multi-step session, ~2.5h):

| Commit | Scope |
|---|---|
| `e0e3922` | **PR-15.2** — `generateSlugFromName` hash fallback (FNV-1a 32-bit pure TS, `app-<8hex>` format) for inputs with fewer than `SLUG_MIN_MEANINGFUL_LENGTH=3` ASCII alphanumerics. `tryGenerateAsciiSlug` exported helper returns `string \| null` so the type-slug auto-derive in `safeSlugFromName` (TypesTable) preserves `""` semantic instead of receiving an unhelpful hash. +10 alias-logic tests (CJK, single-`m` degenerate, TFT boundary, VN below-threshold, emoji, pure-punct, lone combining marks, determinism, distinctness, threshold const). +2 helpers tests locking the type-slug divergence. +1 createAppAction integration test (replaced the obsolete "rejects on InvalidSlugError" test). `Node crypto` deliberately avoided — `alias-logic.ts` is imported by AppDialog (Client Component); FNV-1a is client-bundle-safe, async Web Crypto would not fit the synchronous signature. |
| `fb04521` | **PR-15.3** — AppDialog slug override input field (create-mode only; edit-mode keeps "won't change on rename" helper text unchanged). `slugTouched` state + per-tick `setForm(p => p.slug === auto ? p : ...)` guard prevent useEffect → setForm infinite loop in React strict mode. Contextual helper text (default / hash-fallback hint with `tantanyingxiong` example / red error). `aria-invalid` + `aria-describedby` a11y. Submit disabled on validation error. `slugSchema` extracted to `lib/store-submissions/schemas/slug.ts` (only `zod` dep) so client bundle no longer pulls `re2-wasm` transitively via `validateAliasRegex` in `schemas/app.ts`; `app.ts` re-exports for unchanged server-side imports — same trap documented in CLAUDE.md's lessons-learned. Mode-aware `validateFormState(form, mode)` skips slug check in edit mode. +7 app-dialog-logic tests. |
| this commit | **PR-15.4** — Docs (CURRENT-STATE.md PR-15 milestone + features-table row + PR-timeline row + this entry). Retag stale `[PR-15+]` deferral markers → `[PR-16+]` across CURRENT-STATE.md and TODO.md. |

**Test count:** 1079 (pre-PR-15) → **1096** (post-PR-15) = **+17 tests** cumulative across 15.2 +13 + 15.3 +7, minus 1 obsolete throw test deleted in 15.2 (the "rejects on InvalidSlugError" path no longer fires for non-empty input).

**Bundle (`/store-submissions/config/apps`):** +0.5 kB for the slug input + slim `slugSchema` module. FNV-1a 32-bit adds zero bytes vs the SHA-256 alternative (no Node `crypto` polyfill needed).

**No migrations** — PR-15 is application-layer only. No DB column change. All existing slugs preserved unchanged; new apps post-deploy use the new logic.

**Production scope at fix time** — Manager blocked from registering 12+ apps in the `UNCLASSIFIED_APP` bucket whose UTF-8 names PR-14 had just repaired. Affected apps: 彈彈英雄, 創世紀戰M：阿修羅計畫, plus other Asian-language titles in the VNG portfolio.

### Hidden bug surfaced + bonus fix

`創世紀戰M：阿修羅計畫` did not throw — the lone Latin "M" survived
normalization and produced slug `"m"`. Passed `slugSchema` (min 1
char) but semantically useless and likely to collide. The
`SLUG_MIN_MEANINGFUL_LENGTH=3` threshold catches this case alongside
the empty-output cases the user originally reported.

### Architecture decisions

- **FNV-1a 32-bit pure TS over Node `crypto.createHash` SHA-256.** Required for client-bundle compat — `alias-logic.ts` is imported by `AppDialog.tsx` for live slug preview, and Next.js 14 doesn't auto-polyfill Node's `crypto`. 4B output space is plenty for ~200 apps; UNIQUE constraint catches collisions.
- **`tryGenerateAsciiSlug` helper extraction.** Two callers, two semantics: app-registry wants hash fallback to unblock CJK; type-slug auto-derive in TypesTable wants `""` so Manager picks meaningful short codes (`app`, `iae`, `ipa`). Same pattern as PR-12.5 (`reclassify/core.ts`) and PR-14.4 (`backfill/core.ts`).
- **`slugSchema` module split.** Avoids pulling `re2-wasm` into the client bundle when AppDialog validates slug input. Server-side imports unchanged via re-export. Mirrors the `alias-logic.ts` ↔ `alias-conflicts.ts` split documented in CLAUDE.md lessons-learned.
- **Mode-aware `validateFormState(form, mode)`.** Edit mode skips slug check (read-only on rename per existing UX contract). Save button stays unblocked even if edit-mode FormState defensively carries an invalid slug value.
- **Threshold = 3 ASCII alphanumerics.** Catches `"m"` degenerates and 2-char abbreviations while preserving 3-letter acronyms (`TFT`, `VNG`, `LOL`). Exported as constant for future tuning if Manager UAT signals.

### Open follow-ups (PR-18+)

- [ ] [PR-18+] **Threshold tuning** — `SLUG_MIN_MEANINGFUL_LENGTH=3` conservatively rejects 2-char abbreviations like `"VN"`. If Manager UAT signals this feels wrong, lower to 2; hash fallback still catches CJK / emoji / pure-punctuation. Wait for production signal before tuning.
- [ ] [PR-18+] **CSV bulk-import slug override** — `importAppsCsvAction` derives slug from `name` only (no manual override path). With PR-15.2's hash fallback the action no longer fails on CJK names. If Managers want readable slugs for bulk-imported CJK apps, add a `slug` column to the CSV template + parser. Defer until UAT surfaces the need.

## PR-15.5 — Stale-EMAIL filter post-reclassify ✅ COMPLETED (2026-05-01)

Hotfix between PR-15 (slug generator) and PR-16 (auto-mark-done design). 1 commit. Surfaced from production immediately after PR-15 unblocked CJK app registration: Manager reclassified Play Together VNG email out of TICKET-10000 (UNCLASSIFIED_APP catch-all), but the same email kept rendering in both TICKET-10000 and the new classified ticket.

**Root cause** — intentional data divergence missed by UI:
- `reclassify_email_tx` deliberately leaves the original EMAIL `ticket_entry` on the old ticket as audit history per CLAUDE.md invariant #2 (ticket_entries append-only). RPC explicitly cites this in its own comment.
- `email_messages.ticket_id` is the single source of truth for "where this email currently lives"; it gets correctly updated to the new ticket.
- UI queries (`getTicketWithEntries`, `listTickets` firstEmail subquery) read `ticket_entries` by `ticket_id` only — never joined `email_messages.ticket_id` to filter.
- Stale EMAIL entry surfaced on TICKET-10000 detail panel + as the inbox card's `first_email` preview, alongside the (correct) new EMAIL entry on the destination ticket.

**Fix** — Option A (UI filter at read time):
- PostgREST embed `email_message:email_messages!email_message_id (ticket_id)` pulls each EMAIL entry's current `ticket_id` alongside the entry data.
- JS filter: hide `EMAIL` entries whose embedded current `ticket_id` doesn't match the rendering ticket. STATE_CHANGE / COMMENT / PAYLOAD_ADDED entries unaffected.
- The STATE_CHANGE `'reclassify_out'` audit annotation on the old ticket stays visible — Manager can see what happened.

**Files**:
- `lib/store-submissions/queries/tickets.ts`:
  * `getTicketWithEntries`: PostgREST embed + `visibleRawEntries` filter (lines 605-612, 645-660)
  * `listTickets` firstEmail subquery: PostgREST embed (lines 425-435) + filter inside the first-write-wins map loop (lines 491-510). Filter applies BEFORE the map check so the next-oldest CURRENT EMAIL becomes the preview, not the next-oldest stale.
- `lib/store-submissions/queries/tickets.test.ts`:
  * +5 tests:
    - 3 detail-panel cases: stale hidden + STATE_CHANGE preserved; DROPPED reclassify (ticket_id=null) hidden; normal-case regression
    - 2 listTickets firstEmail cases: skip stale to pick next current; all-stale → first_email=null
  * Updated 2 pre-existing tests + the `makeHydrationMocks` helper signature to include `email_message: { ticket_id }` in fixtures (otherwise filter sees `undefined` and hides them too).

**Discarded alternatives**:
- UPDATE/DELETE old EMAIL entry — violates invariant #2 (append-only); RPC's own comment cites this.
- New `superseded_by_ticket_id` column on ticket_entries — schema-change overkill; column UPDATE softens but doesn't escape the append-only intent.
- Visual marker on stale entries — still shows duplicate content, just labeled.
- Auto-archive ticket on last-EMAIL-exit — bigger scope, deferred PR-18+ as standalone follow-up.

**No backfill, no migration, no RPC change.** Filter applies at read time and retroactively hides existing stale entries on next page load.

**Test count**: 1096 → **1101** (+5).
**Bundle**: zero (filter logic + query string change).

### Open follow-ups (PR-18+)

- [ ] [PR-18+] **Auto-archive ticket on last-EMAIL-exit** — `reclassify_email_tx` could detect when the old ticket has zero current EMAIL entries remaining post-reclassify and atomically transition `state` to `ARCHIVED` with `resolution_type='SYSTEM_RECLASSIFIED'`. Empty TICKET-10000 then disappears from inbox listing entirely instead of showing as a card with no preview. RPC change required; state-machine semantics + backfill discussion needed.
- [ ] [PR-18+] **"Reclassified from TICKET-X" annotation on destination ticket** — mirror of the `STATE_CHANGE 'reclassify_out'` audit entry. `find_or_create_ticket_tx` could detect reclassify-source via a parameter and label the new ticket's transition entry as `'reclassify_in'` with source ticket's display_id for full bidirectional audit visibility.
- [ ] [PR-18+] **`entry_count` semantics review** — inbox card's `entry_count` counts ALL `ticket_entries` rows. After PR-15.5 a ticket may show `entry_count: 5` while `first_email: null` (5 = 1 stale EMAIL + 4 STATE_CHANGE). Count and preview disagree visually. Either rename the count to "events" or apply the same stale-EMAIL filter to the count. Worth Manager UAT signal first.

## PR-17 — Inbox UI/UX optimizations + Ticket detail polish ✅ COMPLETED (2026-05-03 / 2026-05-04)

2 sub-PRs + 1 hotfix shipped across 2 days. 3 commits, 0 migrations (UI + cursor + helper changes only). Manager UAT MV1-MV6 verified all-green; MV6 surfaced PR-17.2.5 hotfix via image evidence.

| Commit | Sub-PR | Scope |
|---|---|---|
| `d1fc8f3` | **PR-17.1** | Inbox UX optimizations bundle (5 sub-chunks): date format util `format-date.ts` ABSOLUTE `dd/MM/yyyy HH:mm` (list scanning) + RELATIVE (detail reading); Last update column add (TicketListTable grid 7→8 cols); default sort flip `updated_at_desc` + sort-aware cursor keyset extension `DecodedCursor: { v, id, s }` với legacy `{opened_at, id}` graceful fallback; type filter scoped active platform với disabled state + tooltip hint when no platform + atomic `type_id` clear on platform change (Pattern 9 defense-in-depth); `buildSavePayload(draft)` helper extraction Pattern 9 defensive crystallized — pure mapper TS-typed, layer 12 omissions become compile errors. Path A tests +16. |
| `27ec2ce` | **PR-17.2** | Ticket detail polish (2 sub-chunks): reverse entry order `getTicketWithEntries .order('created_at', { ascending: false })` Manager triage focus, index `(ticket_id, created_at DESC)` answers query directly zero perf cost; version list display `extractVersions` util pure helper sister-file pattern + inline `VersionsSection` trong `TicketDetailPanel` mockup-style chevron-separated chips với rose-accent latest + "← latest" suffix + silent omission khi empty. Path A tests +6. |
| `b9f8876` | **PR-17.2.5** hotfix | extractVersions nested data shape — Manager UAT MV6 image evidence: VersionsSection omitted on a ticket type=app với version 4.4.0 (Apple, type_payloads has 1 entry). Root cause: helper read `p.version` (top-level) but production exclusively wrapped `p.payload.version` per RPC INSERT shape since PR-9 (`jsonb_build_object('payload', v_type_payload, 'first_seen_at', ...)` trong migration `20260423000000`). Fix: read `p.payload.version` (strict nested only). Test fixtures rewritten production-realistic + 3 defensive tests cho nested edge cases. Path A tests +3. |

**Test count:** 1121 (post-PR-16) → **1141** (post-PR-17) = **+20 tests** cumulative.

**Manager UAT verification (MV1-MV6 all ✅):**
- MV1 Date format `dd/MM/yyyy HH:mm` trong inbox list
- MV2 Last update column functional + sort-aware
- MV3 Default sort `updated_at_desc` + cursor pagination intact
- MV4 Type filter scoped active platform với disabled state + tooltip + atomic clear
- MV5 Reverse entry order trong ticket detail (newest top — Manager triage)
- MV6 Version list display (1-version visible + multi-version chevron chips) — verified post-PR-17.2.5

**Memory pattern reuse:**
- Pattern 9 N-layer cascade audit reuse #2 (PR-17.2.5) — test-infrastructure drift class; 13-point checklist evolution adds Layer 0 ("trace data flow source-to-consumer; verify test fixture matches production storage shape")
- Pattern 10 Domain assumption pivots reuse #6 (PR-17.2.5) — Manager UAT image evidence + production data shape investigation; cumulative 6 instances proven

Reference: [`docs/store-submissions/CURRENT-STATE.md`](docs/store-submissions/CURRENT-STATE.md) PR-17 milestone section cho comprehensive scope, 6 decisions locked, memory pattern reuse confirmations, UAT matrix, PR-18+ candidates.

### Open follow-ups (PR-18+)

(None specific to PR-17 — `buildSavePayload(draft)` helper extraction shipped PR-17.1.e; PR-18+ candidates list consolidated trong CURRENT-STATE.md PR-17 milestone section.)

## PR-16 — Auto-mark-done + auto-completed banner + auto-reopen Manager opt-in ✅ COMPLETED (2026-05-02 / 2026-05-03)

4 sub-PRs + 1 hotfix shipped across 2 days. 8 commits, 8 migrations applied production sequential.

| Commit | Sub-PR | Scope |
|---|---|---|
| `6ffe7b0` | **PR-16a.1+16a.3** | Auto-DONE foundation bundle — `subject_patterns.auto_done_eligible` column + `build_rules_snapshot` / `save_rules_tx` / `rollback_rules_tx` threaded + TS schema cascade (queries, schemas, helpers, actions) + Settings UI emerald toggle với UX guard disabled cho non-APPROVED outcome + 7 fixture sites updated. |
| `c231594` | **PR-16a.2** | `find_or_create_ticket_tx` auto-DONE branch — CLASSIFIED + APPROVED + eligible pattern → ticket born trong DONE state với `closed_at` + `resolution_type` set atomically. STATE_CHANGE entry với `metadata.{actor:'system', reason:'auto_mark_done_initial', subject_pattern_id}`. Reclassify Q6.B inheritance free. Idempotency caveat documented header. `ClassifiedResult.subject_pattern_id` propagation. |
| `cc8389d` | **PR-16a.4** | Path A unit tests (+8) — classifier subject_pattern_id propagation, engine auto-DONE response shape, schemas accept + back-compat (input + snapshot), helpers round-trip. Migration header idempotency caveat documentation. SQL behavior validated via Manual QA Scenario 3+. |
| `2d5f171` | **PR-16a.5 hotfix** | handleSave payload threading — Manager UAT Scenario 2 surfaced 7-layer cascade gap (Layer 9 `EmailRulesClient.handleSave` intermediate payload). Zod `.default(false)` silently coerced missing field. 1-line fix + N-layer cascade audit memory crystallized post-fix. |
| `6b820e9` | **PR-16b.1+16b.2** | Auto-completed banner + dedicated view — `count_auto_completed_tickets()` + `list_auto_completed_tickets()` RPCs với latest-STATE_CHANGE EXISTS subquery + `getAutoCompletedCount()` + `listAutoCompleted()` query module + Inbox blue/info banner Q1.E + dedicated `/auto-completed` view với MANAGER soft redirect + friendly empty state. |
| `32c8cbe` | **PR-16b.3+16b.4** | Auto-reopen RPC + Path A tests (+7) — pre-LOOP branch trong find_or_create_ticket_tx Q2.D + Q3.B (DONE → IN_REVIEW on REJECTED). Detection: latest STATE_CHANGE actor='system' + reason LIKE 'auto_mark_done%'. PR-15.5 stale filter preserved. SUPERSEDED by PR-16b.5.5 eligibility gate. |
| `b455fa9` | **PR-16b.5 Bundle A** | Auto-reopen Manager opt-in foundation — `subject_patterns.auto_reopen_eligible` BOOLEAN DEFAULT FALSE column + rules RPCs threaded với both fields + Settings UI 7th column toggle với amber accent + ⚠️ warning tooltip + UX guard disabled cho non-REJECTED + 13-point cascade audit applied successfully (Layer 9 explicit, no hotfix needed — first reuse of PR-16a.5 memory pattern). |
| `3aa093b` | **PR-16b.5 Bundle B** | RPC eligibility check + Path A tests (+5) — `find_or_create_ticket_tx` auto-reopen branch gated by `pattern.auto_reopen_eligible`. Two-phase short-circuit: cheap gate trước expensive EXISTS subquery. Default FALSE preserves "build mới = ticket mới" Apple workflow semantic. Schema validation tests + draft round-trip với shallow-merge defensive. |

**Test count:** 1101 (post-PR-15.5) → **1121** (post-PR-16) = **+20 tests** cumulative.

**Manager domain insight (PR-16b.5)**: Apple's REJECTED workflow is per-build (different `submission_id`), không cùng build APPROVED trước. PR-16b.3 auto-reopen-always violated this. Path D opt-in flag preserves correct semantic. Code preserved cho future Apple workflow flexibility.

**Manager UAT verification:**
- Phase 1 (Settings UI + persistence): ✅ verified Scenarios 1-2 + X-Y-Z
- Phase 2 (Banner + visibility): ⏸ data-dependent
- Phase 3 (Real Apple email): ⏸ chờ live emails (Scenarios 3-7, C, W)
- Phase 4 (Long-term telemetry): ⏸ 1-2 months data informs PR-18+ decisions

Reference: [`docs/store-submissions/CURRENT-STATE.md`](docs/store-submissions/CURRENT-STATE.md) PR-16 milestone section cho comprehensive scope, design decisions Q1-Q8 với 5 overrides, schema changes summary, UAT matrix, PR-18+ candidates.

### Open follow-ups (PR-18+)

- [ ] [PR-18+] **Q1.E + Q8 telemetry capture** — banner click frequency, time-series, state=APPROVED count cho Q8 Approved tab fate decision criteria. Manager UAT Phase 3-4 informs priority.
- [ ] [PR-18+] **Path C DB integration test infrastructure** (~3-4h scope) — covers SQL behavior gaps trong Path A coverage: auto-DONE branch logic, eligibility gate, idempotency edge case (defensive double-call test deferred from PR-16a.4 caveat). Reinforced by PR-17.2.5 hotfix (test-infrastructure trap exposed; Path A unit fixtures drifted from production storage shape).
- [x] ~~**`buildSavePayload(draft)` helper extraction**~~ — ✅ shipped PR-17.1.e (Pattern 9 defensive crystallized as canonical mapper).
- [ ] [PR-18+] **Q2.B reopen affordance** — Manual QA Scenario D pending; if absent từ TicketDetailPanel, add per-ticket reopen button cho DONE tickets (parity với mark_done_ticket_tx). May already exist trong existing UI.

## Post-PR-11 — TicketDetailContext + prop drilling cleanup (planned)

`currentUserId` and `userRole` are now threaded 4 layers (page → InboxClient → TicketDetailPanel → TicketEntriesTimeline → EmailEntryCard / CommentEntryCard). Acceptable for current scope but if PR-12+ adds 2+ more consumers (e.g. assignee chip, priority widget), promote to a React context provider on the panel root. Not urgent — both props are stable for the panel's lifetime.

## PR-10 — Inbox UI ✅ COMPLETE 2026-04-25 (shipped via PR-10a / PR-10b / PR-10c / PR-10d)

Original scope preview (detailed in `docs/store-submissions/CURRENT-STATE.md` PR-10 section):

- Ticket list page với filters (state, app, platform, assigned_to, priority, date range)
- State buckets: `NEW` / `IN_REVIEW` / `REJECTED` / terminal (`APPROVED` + `DONE` + `ARCHIVED`)
- Unclassified buckets as dedicated views + manager reclassify flow (spec §5.2 merge)
- Ticket detail modal với `ticket_entries` timeline (EMAIL snapshots + STATE_CHANGE + COMMENT + PAYLOAD_ADDED)
- User action primitives: archive / follow-up / mark-done / assign / priority / comment / reject-reason — each a separate `*_tx` RPC per spec §2.2
- First consumer of PR-9 extended `FindOrCreateTicketOutput` fields

Dependencies: PR-9 RPC is the sole write path for email-driven transitions. User-action RPCs are a separate, additive surface (spec §7) — PR-9 did not ship them.

## PR-10a Post-MVP (surfaced during Inbox UI implementation)

- [ ] [PR-10a] Sortable column headers in `TicketListTable` — `components/store-submissions/inbox/TicketListTable.tsx` — currently sort is FilterPill-only to avoid two UI surfaces for the same state. Revisit if usability feedback shows users expect header sort (click column → toggle direction).
- [ ] [PR-10a] Priority column in `TicketListTable` when `sort=priority_desc` is active — today only HIGH renders inline with display_id as a red badge; LOW/NORMAL are hidden to reduce visual noise. A dedicated column would help when the user explicitly sorts by priority.
- [ ] [PR-10a] Consolidate `PlatformIcon` — duplicated between `components/store-submissions/apps/AppsClient.tsx:54-74` and `components/store-submissions/inbox/TicketBadges.tsx`. Promote to `components/store-submissions/shared/PlatformIcon.tsx` on the 3rd usage per the codebase's "abstract on 3" rule.
- [ ] [PR-10a] Absolute-date fallback for very old ticket `opened_at` — `formatDistanceToNow` produces "about 2 months ago" style; for dates >30d an absolute format ("Apr 22") is more precise. Acceptable for MVP since triage tickets rarely linger that long.
- [ ] [PR-10a] Bulk actions (multi-select archive / mark-done) — deferred per scope trim. 200 tickets/month volume doesn't demand it yet. Revisit when user patterns show repetitive per-ticket actions.
- [ ] [PR-10a] Count badges on state tabs (NEW: 12, REJECTED: 3, ...) — deferred per scope trim. Requires `listTicketCounts()` aggregate query. Add when users request at-a-glance queue visibility.
- [ ] [PR-10a] Search by app name + email subject — MVP search is `display_id` ILIKE only. App-name search needs a two-pass subquery; subject search requires joining `email_messages`. Revisit when dataset grows or users complain.
- [ ] [PR-10a] `updated_at_desc` / `priority_desc` sort pagination — cursor keyset is keyed by `(opened_at, id)` and only honored for `opened_at_desc`; other sorts return `next_cursor: null`. Low priority since the useful pagination pattern is newest-first. If deep history browsing by updated/priority becomes needed, extend the cursor shape.
