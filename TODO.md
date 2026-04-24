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
- [ ] [PR-7] Sentry wiring for the sync endpoint — `app/api/store-submissions/sync/gmail/route.ts`. `SENTRY_DSN` env is already allocated per `docs/store-submissions/06-deployment.md`; install `@sentry/nextjs`, initialize in `instrumentation.ts`, capture the 500-path error with `component: 'gmail-sync'` tag. Intentionally deferred because MVP doesn't ship with Sentry yet.
- [ ] [PR-7] Manual "Sync now" button in Settings page — trigger `POST /api/store-submissions/sync/gmail` via a Server Action, rate-limit 1/min per user. Emits `sync_method='MANUAL'` (value reserved in the `sync_logs` CHECK constraint, not yet produced by the cron path).

## PR-7 Post-Ship Polish (surfaced from 2026-04-21/22 production deployment)

- [x] [PR-polish] App Creator dialog UX — require ≥1 platform binding at creation OR auto-select all active platforms by default. Unbound app invisible to classifier (`loadAppsForPlatform` in `lib/store-submissions/queries/rules.ts` gates on `app_platform_bindings`). Silent miss harder to debug than form validation error. Ref: incident 2026-04-21/22 (Đấu Trường Chân Lý, Thiên Long Bát Bộ VNG, Top Eleven all needed manual `app_platform_bindings` INSERT to unblock classification). **Fixed 2026-04-23 — see PR-polish section below.**
- [ ] [ops] Migration deploy automation — investigate Supabase CLI + Railway auto-apply migrations on push. Manual "Path G" SQL-Editor workflow caused 2 production incidents during PR-7 deployment: sync lock migration (`20260420000000_store_mgmt_gmail_sync_lock.sql`, cron crashed with "try_acquire_sync_lock does not exist") + app RPCs migration (`20260419050324_store_mgmt_app_rpcs.sql`, App Registry UI broken with "create_app_tx does not exist"). Priority: raise from backlog.
- [ ] [PR-7 polish] MIME parser — investigate charset handling for Apple email bodies. Production observed encoding corruption pattern `Da:%u TrF0a;ng ChC"n LC"` suggesting an unsupported charset (possibly `x-mac-vietnamese` or an Apple-specific encoding). Subject decodes OK via RFC 2047; body decode fails. Extend `normalizeCharset` in `parser.ts` or add an `iconv-lite` fallback for rare charsets if the symptom shows real-world classification impact. Current 5-charset support: UTF-8, Latin-1, cp1252, us-ascii, UTF-16LE.
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
- [ ] [PR-9 polish] Surface `TicketEngineRaceError` + `TicketEngineNotFoundError` via Sentry (filter tag `component: 'ticket-engine'`). Blocked on `SENTRY_DSN` wiring (tracked under PR-7 polish).

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

## PR-10 — Inbox UI (next)

Scope preview (detailed in `docs/store-submissions/CURRENT-STATE.md` PR-10 section):

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
