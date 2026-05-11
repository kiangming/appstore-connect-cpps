# Store Management — Trạng thái hiện tại

> **Đọc đầu tiên** khi bắt đầu session mới về module Store Management. Ghi lại trạng thái production + PR đã ship + known limitations chưa resolve.
>
> Last updated: 2026-05-04 (PR-17 fully closed — Inbox UI/UX optimizations + Ticket detail polish shipped 2026-05-03 / 2026-05-04 across 2 sub-PRs + 1 hotfix; previous: PR-16 auto-mark-done + auto-completed banner + auto-reopen Manager opt-in 2026-05-02 / 2026-05-03)

---

## Tóm tắt nhanh

Module quản lý submission app/game multi-platform qua auto-classify email từ shared Gmail mailbox.

- **Tech:** Next.js 14 App Router + TypeScript + Supabase schema `store_mgmt` + RE2 (re2-wasm) + Railway cron service
- **Deploy:** Railway services `web` (UI+API) + `cron-store` (Gmail sync, cleanup, health)
- **Người dùng:** Team nội bộ 2–5 người (PM + Dev)
- **Volume target:** ~200 submissions/tháng, ~2000 email/tháng

---

## PR timeline (shipped vs planned)

| PR | Scope | Status |
|---|---|---|
| PR-1 | Schema `store_mgmt` init (tables, indexes, partial unique) | ✅ shipped |
| PR-2 | Gmail OAuth + credentials storage (AES-256-GCM) | ✅ shipped |
| PR-3 | Gmail sync loop + parser + sync-state cursor | ✅ shipped |
| PR-4 | App Registry CRUD + aliases | ✅ shipped |
| PR-5 | Email rule engine — subject patterns + submission_id extraction (RE2) | ✅ shipped |
| PR-6 | Sender resolver (2-query pattern, no embedded select) | ✅ shipped |
| PR-7 | Cron advisory lock + retry/backoff + NO_SUBJECT_MATCH reclassified as DROPPED | ✅ shipped |
| PR-8 | Ticket engine **stub** + wire (sync → wire → stub findOrCreateTicket) | ✅ shipped (stub gap resolved in PR-9) |
| PR-9 | Ticket engine **real** (RPC find_or_create_ticket_tx, FOR UPDATE, state machine, ticket_entries writes, backfill) | ✅ shipped 2026-04-23 |
| PR-10a | Inbox list — filters, tabs, cursor pagination | ✅ shipped |
| PR-10b | Ticket detail panel (slide-over) — header, metadata, timeline (EMAIL/STATE_CHANGE/PAYLOAD_ADDED) | ✅ shipped |
| PR-10c | User actions — 7 RPCs + dispatcher + auth matrix + state-transition UI + comment/reject composer + COMMENT/REJECT_REASON timeline cards | ✅ shipped 2026-04-25 (migration apply pending Path G) |
| PR-10d | Polish + Observability — Sentry SDK init + 3 production captureException sites + 2 error boundaries + j/k/Enter keyboard navigation | ✅ shipped 2026-04-25 |
| PR-11 | HTML Parsing + Reclassify — Apple HTML extractor + classifier two-tier match + PPO type seed + extracted_payload JSONB + reclassify_email_tx RPC + Manager UI (per-email + bulk) + type guidance card | ✅ shipped 2026-04-25 (3 migrations apply pending Path G) |
| PR-12 | Apple rejection parser + Backfill button — `extractApple(html, subject?)` rejection branch + `outcome` audit flag + `items` rename + IAE optional count + `submission_id`/`app_name` parse + `reclassify-core` extraction + MANAGER Backfill button (test 1 row + bulk all) + Sentry `backfill-action` taxonomy | ✅ shipped 2026-04-27 (no migrations) |
| PR-13 | Outcome filter dimension separation — `outcomeFilterSchema` (enum ∪ `'none'`) + `listTickets` predicate + URL parser + 5-tab consolidation (drop Rejected, keep Approved standalone) + 5-chip outcome row (All/Approve/Reject/In review/No outcome) + empty-state copy refresh + 3-dimension docs. Resolves Issue 2 from PR-12 close ("Approve" tab empty while Outcome column shows "Approve") | ✅ shipped 2026-04-30 (no migrations) |
| PR-14 | UTF-8 body preview corruption fix — byte-level QP decoder (Buffer-walk, no `raw.toString('ascii')`) replaces the pre-fix string-keyed decoder that masked UTF-8 bytes with `& 0x7F` and false-positive-triggered QP decode on raw-UTF-8 bodies Apple mislabeled as `Content-Transfer-Encoding: QUOTED-PRINTABLE`. + 8 fixture variants (Vietnamese mislabel + Chinese / Japanese / emoji / mixed-encoding charset coverage) + `backfillCorruptPayloadAction` MANAGER cleanup + maintenance banner D2 + `backfill/core.ts` extraction. Resolves Issue 1 from PR-12 close (mojibake'd app names in 14 functional production rows across 4 distinct apps) | ✅ shipped 2026-05-01 (no migrations) |
| PR-15 | Slug generator non-ASCII support — `generateSlugFromName` hash fallback for CJK / emoji / pure-punctuation / 1-2 char Latin names (FNV-1a 32-bit, client-bundle-safe pure TS, `app-<8hex>` format) replaces the pre-fix `InvalidSlugError` throw that blocked Manager from registering apps surfaced by PR-14's UTF-8 repair (彈彈英雄, 創世紀戰M：阿修羅計畫, etc.). Threshold `SLUG_MIN_MEANINGFUL_LENGTH=3` also catches degenerate single-char slugs (創世紀戰M → "m"). `tryGenerateAsciiSlug` helper exposed so type-slug derivation in TypesTable preserves "" semantic instead of getting hash autocomplete. AppDialog adds slug override input field with auto-fill via `slugTouched` state + per-tick guard, contextual helper text (default / hash-fallback / error), `aria-invalid` + `aria-describedby` a11y, submit disabled on validation error. `slugSchema` extracted to `schemas/slug.ts` to avoid pulling `re2-wasm` into the client bundle. Mode-aware `validateFormState` skips slug check in edit mode (slug stable on rename). | ✅ shipped 2026-05-01 (no migrations) |
| PR-15.5 | Stale-EMAIL filter post-reclassify — Manager-reported confusion: same email visible in TICKET-10000 (UNCLASSIFIED_APP catch-all) AND new classified ticket after reclassify. Root cause: `reclassify_email_tx` deliberately leaves the original `EMAIL` ticket_entry on the old ticket as audit history per invariant #2 (ticket_entries append-only); the UI queried `ticket_entries` by `ticket_id` directly without joining `email_messages.ticket_id` (the source of truth for "where this email currently lives"). Fix: PostgREST embed `email_message:email_messages!email_message_id (ticket_id)` in `getTicketWithEntries` (detail panel) + `listTickets` firstEmail subquery, with read-time JS filter that hides EMAIL entries whose embedded current `ticket_id` doesn't match the rendering ticket. STATE_CHANGE `'reclassify_out'` audit annotations stay visible. No RPC change, no schema change, no backfill — filter applies retroactively to existing stale entries on next read. | ✅ shipped 2026-05-01 (no migrations) |
| PR-16a | Auto-mark-done foundation — Manager opt-in toggle (`subject_patterns.auto_done_eligible`) + `find_or_create_ticket_tx` auto-DONE branch (CLASSIFIED + APPROVED + eligible pattern → ticket lands directly trong DONE state, skip Open queue) + Q4.A/Q4.C audit metadata via `ticket_entries.metadata.{actor,reason,subject_pattern_id}` (NULL author_user_id + `metadata.actor='system'` reuses existing email-driven STATE_CHANGE convention) + Q5.D Manager-curated opt-in per pattern (default FALSE preserves pre-PR-16 behavior) + Settings UI toggle với UX guard disabled cho non-APPROVED outcomes + Path A unit tests (8). 5 design overrides during investigation: metadata.reason vs new column (no `ticket_state_changes` table exists), NULL+metadata.actor vs reserved UUID (FK + role enum cascade cost), `subject_pattern_id` top-level on `ClassifiedResult` (clean type-safe RPC access), STATE_CHANGE special case on auto-DONE create (audit completeness). Reclassify path Q6.B inheritance free (reclassify_email_tx invokes find_or_create_ticket_tx). | ✅ shipped 2026-05-02 (3 migrations) |
| PR-16a.5 | handleSave payload threading hotfix — Manager UAT Scenario 2 surfaced: tick Auto-DONE + Save → success toast → checkbox reverts unchecked. Root cause: 7-layer cascade pipeline missed Layer 9 (`EmailRulesClient.handleSave` intermediate payload builder between component state + Server Action). Zod `.default(false)` silently coerced missing field, RPC persisted false, `router.refresh()` reloaded false, checkbox appeared to revert. Fix: 1-line addition trong handleSave threading `auto_done_eligible: p.auto_done_eligible`. Inline comment notes future fields must add line here. N-layer cascade audit memory crystallized (Pattern 9 saved post-fix, applied successfully PR-16b.5). | ✅ shipped 2026-05-02 (no migrations) |
| PR-16b | Auto-completed banner + dedicated view + auto-reopen RPC — MANAGER-only `count_auto_completed_tickets()` + `list_auto_completed_tickets(p_days, p_limit)` RPCs với latest-STATE_CHANGE EXISTS subquery filtering tickets state=DONE + system-origin auto_mark_done + last 7 days. Inbox blue/info banner Q1.E (auto-hides at zero) + dedicated `/store-submissions/inbox/auto-completed` view với MANAGER soft redirect + friendly empty state. Auto-reopen pre-LOOP branch trong `find_or_create_ticket_tx` Q2.D + Q3.B: REJECTED email arrives auto-DONE'd ticket → state DONE → IN_REVIEW. PR-15.5 stale filter preserved (read-time only). Telemetry deferred PR-18+. Path A tests +7. | ✅ shipped 2026-05-03 (2 migrations) |
| PR-16b.5 | Auto-reopen Manager opt-in toggle — Manager domain insight surfaced post-deploy: Apple's REJECTED workflow is per-build (different submission_id), không cùng build APPROVED trước. "Build mới = ticket mới" semantic. PR-16b.3 auto-reopen-always violates domain reality. Path D Manager opt-in: `subject_patterns.auto_reopen_eligible` BOOLEAN DEFAULT FALSE column + RPCs threaded + Settings UI 7th column toggle với amber accent + ⚠️ warning tooltip + UX guard disabled cho non-REJECTED + `find_or_create_ticket_tx` auto-reopen branch gated by pattern eligibility (two-phase short-circuit: cheap gate check trước expensive EXISTS subquery). Default FALSE preserves correct semantic. Layer 9 cascade audit applied successfully (PR-16a.5 lesson reuse). Path A tests +5. | ✅ shipped 2026-05-03 (3 migrations) |
| PR-17.1 | Inbox UI/UX optimizations — 5 sub-chunks (date format util `lib/store-submissions/utils/format-date.ts` ABSOLUTE `dd/MM/yyyy HH:mm` cho list / RELATIVE cho detail; Last update column add — TicketListTable grid 7→8 cols; default sort flip `updated_at_desc` + sort-aware cursor keyset extension `DecodedCursor: { v, id, s }` với legacy `{opened_at, id}` graceful fallback; type filter scoped active platform với disabled state + tooltip hint when no platform; `buildSavePayload(draft)` helper extraction Pattern 9 defensive — pure mapper TS-typed, layer 12 omissions become compile errors instead of silent zod `.default(false)` coercion). Single commit cohesive Inbox UX bundle. Path A tests +16. Pattern 9 (cascade) + Pattern 10 (domain pivots) auto-applied. | ✅ shipped 2026-05-03 (no migrations) |
| PR-17.2 | Ticket detail polish — 2 sub-chunks (reverse entry order `getTicketWithEntries .order('created_at', { ascending: false })` Manager triage focus, index `(ticket_id, created_at DESC)` answers query directly zero perf cost; version list display `extractVersions` util pure helper sister-file pattern matching `format-date.ts` + inline `VersionsSection` trong `TicketDetailPanel` mockup-style chevron-separated chips với rose-accent latest + "← latest" suffix + silent omission khi empty + position between SubmissionIds + TypePayloads sections). Path A tests +6. | ✅ shipped 2026-05-04 (no migrations) |
| PR-17.2.5 | extractVersions nested data shape hotfix — Manager UAT MV6 surfaced via image evidence: VersionsSection omitted on a ticket type=app với version 4.4.0 (Apple, type_payloads has 1 entry). Root cause: helper read `p.version` (top-level) but production `tickets.type_payloads` exclusively wrapped `p.payload.version` (nested) per RPC INSERT shape since PR-9 (`jsonb_build_object('payload', v_type_payload, 'first_seen_at', ...)` trong migration `20260423000000`). RPC = sole writer, no legacy flat shape exists. Fix: read `p.payload.version` (strict nested only — defensive both-shapes = parsing noise). Test fixtures rewritten production-realistic + 3 defensive tests cho nested edge cases. Pattern 9 reuse #2 (test infrastructure trap exposed: fixture vs production drift) + Pattern 10 reuse #6 (Manager UAT image evidence + production data shape investigation). Path A tests +3. | ✅ shipped 2026-05-04 (no migrations) |

---

## Features đã hoàn thành ✅

| Capability | Entry point | Key files |
|---|---|---|
| Gmail sync loop (cron */5 min) | `POST /api/store-submissions/sync/gmail` | `lib/store-submissions/gmail/sync.ts` |
| Email parsing + MIME null-byte sanitize | — | `lib/store-submissions/gmail/parser.ts` |
| Email rule engine (subject regex + submission_id) | — | `lib/store-submissions/classifier/*` |
| Sender resolver (allowed senders per platform) | — | `lib/store-submissions/gmail/sender-resolver.ts` |
| Sync-state cursor + UNIQUE(gmail_msg_id) race handling | — | `lib/store-submissions/gmail/sync-state.ts` |
| Cron advisory lock (prevent overlap) | — | `lib/store-submissions/gmail/sync.ts` |
| Ticket wire (email_messages → ticket_id backfill) | — | `lib/store-submissions/tickets/wire.ts` |
| Ticket engine **real** (Supabase RPC, state machine, event log) | — | `lib/store-submissions/tickets/engine.ts` + migration `20260423000000_...rpc.sql` |
| Classification status mapping (CLAUDE.md invariant #8) | — | `lib/store-submissions/classifier/types.ts` |
| Inbox list + filters + cursor pagination | `/store-submissions/inbox` | `app/(dashboard)/store-submissions/inbox/page.tsx` + `components/store-submissions/inbox/InboxClient.tsx` |
| Ticket detail panel (slide-over) + timeline cards | `?ticket=<uuid>` query param | `components/store-submissions/inbox/TicketDetailPanel.tsx` + `TicketEntriesTimeline.tsx` |
| User actions (7 RPCs) — state transitions + comment + reject reason | `inbox/actions.ts` Server Actions | `lib/store-submissions/tickets/user-actions.ts` + migration `20260424000000_...user_actions_rpcs.sql` |
| Sentry observability (init + capture + boundaries) | auto-boots via `instrumentation.ts` | `instrumentation.ts` + `sentry.server.config.ts` + `sentry.edge.config.ts` + `instrumentation-client.ts` + `app/global-error.tsx` + `app/(dashboard)/store-submissions/inbox/error.tsx` |
| Keyboard navigation (j / k / Enter) | Inbox page | `components/store-submissions/inbox/InboxClient.tsx` (uses `react-hotkeys-hook` v5) |
| Apple HTML payload extractor — acceptance + rejection (PR-11/PR-12) | auto-runs in sync pipeline | `lib/store-submissions/gmail/html-extractor.ts` (uses `node-html-parser`) |
| Two-tier type matching — extracted_payload Priority 1, body keyword Priority 2 | classifier Step 4 | `lib/store-submissions/classifier/type-matcher.ts` |
| Manager reclassify (single email + bulk Unclassified) | Inbox detail panel + Unclassified banner | `app/(dashboard)/store-submissions/inbox/reclassify-actions.ts` + `lib/store-submissions/reclassify/core.ts` (PR-12.5 extraction) + migration `20260425000002_...reclassify_rpc.sql` |
| Manager backfill (Apple-only HTML re-extract + reclassify) | Inbox Unclassified banner — "Backfill 1 row (test)" + "Backfill all" | `app/(dashboard)/store-submissions/inbox/backfill-actions.ts` (re-fetches Gmail HTML for `extracted_payload IS NULL` rows, runs `extractApple`, persists, then `reclassifyOne`) |
| Manager corrupt-payload repair (Apple-only re-parse with byte-safe decoder + reclassify) | Inbox maintenance banner — "Repair corrupt payloads (N)" (auto-hides at N=0) | `app/(dashboard)/store-submissions/inbox/backfill-corrupt-actions.ts` + shared `lib/store-submissions/backfill/core.ts` + `lib/store-submissions/queries/corrupt-payload.ts` (count probe, MANAGER-only, head:true) |
| Slug generator non-ASCII support (CJK / emoji / pure-punctuation hash fallback + Manager override input) | Settings → Apps → Add app | `lib/store-submissions/apps/alias-logic.ts` (`tryGenerateAsciiSlug`, `generateSlugFromName`, FNV-1a 32-bit hash, `SLUG_MIN_MEANINGFUL_LENGTH=3`) + `lib/store-submissions/schemas/slug.ts` (slim re-export to avoid `re2-wasm` in client bundle) + `components/store-submissions/apps/AppDialog.tsx` (slug input + auto-fill + contextual hint + a11y) |
| Auto-mark-done Manager opt-in (per-pattern toggle, default FALSE) — APPROVED email matching eligible pattern → ticket born directly trong DONE state, skip Open queue (PR-16a) | Settings → Email rules → SubjectPatternsTable "Auto-DONE" column | migration `20260502000000_..._auto_mark_done.sql` (column add) + `20260502000001_..._rules_auto_done.sql` (rules RPCs threaded) + `20260502000002_..._find_or_create_auto_done.sql` (auto-DONE branch trong find_or_create_ticket_tx) + `components/store-submissions/email-rules/SubjectPatternsTable.tsx` (emerald accent toggle, disabled cho non-APPROVED) + `lib/store-submissions/classifier/types.ts` (`subject_pattern_id` top-level on ClassifiedResult) |
| Auto-completed visibility surface — MANAGER-only Inbox banner + dedicated `/auto-completed` view listing state=DONE tickets last 7 days với system-origin auto_mark_done STATE_CHANGE (PR-16b) | Inbox blue banner above tabs + `/store-submissions/inbox/auto-completed` route | migration `20260503000000_..._auto_completed_query.sql` (count + list RPCs với latest-STATE_CHANGE EXISTS subquery) + `lib/store-submissions/queries/auto-completed.ts` (graceful 0-on-error degrade) + `app/(dashboard)/store-submissions/inbox/auto-completed/page.tsx` (Server Component + MANAGER soft redirect) + `components/store-submissions/inbox/AutoCompletedListClient.tsx` (thin client wrapper around TicketListTable) |
| Auto-reopen Manager opt-in (per-pattern toggle, default FALSE preserves "build mới = ticket mới" Apple workflow semantic) — REJECTED email matching eligible pattern + auto-DONE'd ticket trong same grouping key → DONE → IN_REVIEW (PR-16b.5) | Settings → Email rules → SubjectPatternsTable "Auto-Reopen" 7th column | migration `20260504000000_..._auto_reopen_eligible.sql` (column add) + `20260504000001_..._rules_auto_reopen.sql` (rules RPCs threaded) + `20260504000002_..._find_or_create_eligibility.sql` (eligibility gate trong auto-reopen branch — two-phase short-circuit cho production cost) + `SubjectPatternsTable.tsx` (amber accent toggle với ⚠️ warning tooltip, disabled cho non-REJECTED) |
| Inbox date format ABSOLUTE `dd/MM/yyyy HH:mm` (list scanning context) + Last update column (TicketListTable grid 7→8 cols) — detail/timeline retains RELATIVE format ("5 min ago" + hover ISO) cho reading context (PR-17.1.a + 17.1.b) | Inbox list table | `lib/store-submissions/utils/format-date.ts` (NEW pure helper) + `components/store-submissions/inbox/TicketListTable.tsx` (column add) |
| Default sort `updated_at_desc` + sort-aware cursor keyset extension `DecodedCursor: { v, id, s }` — legacy `{ opened_at, id }` cursor URLs decode gracefully (assume `opened_at_desc`); sort discriminator mismatch throws `InvalidCursorError` (PR-17.1.c) | Inbox URL `?sort=` query param | `lib/store-submissions/queries/tickets.ts` (cursor encode/decode + next_cursor sort-aware column) + `lib/store-submissions/queries/search-params.ts` (default flip) |
| Type filter scoped active platform với disabled state + tooltip hint when no platform — atomic `type_id` clear on platform change (Pattern 9 defense-in-depth, invalid combo prevention) (PR-17.1.d) | Inbox FilterPill "Type" pill | `components/store-submissions/inbox/FilterPill.tsx` (new `disabled` + `disabledHint` props) + `components/store-submissions/inbox/InboxClient.tsx` (`setScalarFilter` reset list) |
| `buildSavePayload(draft)` helper — pure TS-typed mapper turns layer 12 omissions into compile errors instead of silent zod `.default(false)` coercion (Pattern 9 defensive crystallized from PR-16a.5 + PR-16b.5 hotfix lessons) (PR-17.1.e) | Settings → Email rules Save handler | `lib/store-submissions/email-rules/helpers.ts` (`buildSavePayload`) + `EmailRulesClient.tsx` (handleSave simplified to 3 lines) |
| Reverse entry order trong Ticket detail timeline (newest top — Manager triage mental model) — index `(ticket_id, created_at DESC)` answers query directly, zero perf cost (PR-17.2.a) | Ticket detail panel timeline | `lib/store-submissions/queries/tickets.ts` (`.order('created_at', { ascending: false })`) — `TicketEntriesTimeline` rendering index-agnostic |
| Version list display chevron-separated chips với rose-accent latest + "← latest" suffix + silent omission khi empty — strict nested data shape `p.payload.version` matches production RPC INSERT structure (PR-17.2.b + PR-17.2.5 hotfix) | Ticket detail panel "Versions (N)" section | `lib/store-submissions/utils/extract-versions.ts` (NEW pure helper, sister-file pattern) + `extract-versions.test.ts` (production-realistic fixtures + 3 defensive tests) + `components/store-submissions/inbox/TicketDetailPanel.tsx` (inline `VersionsSection` between SubmissionIds + TypePayloads) |

---

## PR-8 known limitation — `ticket_id = NULL` cho ticketable rows (RESOLVED 2026-04-23)

**Status**: RESOLVED by PR-9.6 backfill migration.

### Root cause (historical)

PR-8 stub (`engine-stub.ts`, now deleted) generated ephemeral UUIDs via `randomUUID()` nhưng **không INSERT vào `store_mgmt.tickets`**. FK constraint `email_messages.ticket_id REFERENCES store_mgmt.tickets(id)` rejected UPDATE. Wire caught error, logged `[tickets-wire] UPDATE email_messages.ticket_id failed`, và returned `null` (graceful degradation contract).

### Resolution

1. **PR-9.2** — `find_or_create_ticket_tx` RPC ships real INSERT into `store_mgmt.tickets` + `ticket_entries` in a single PL/pgSQL transaction. FK UPDATE now succeeds for all new emails post-deploy.
2. **PR-9.6** — One-shot backfill migration (`20260423100000_store_mgmt_backfill_ticket_id.sql`) iterates existing rows `WHERE ticket_id IS NULL AND classification_status IN (ticketable set)`, calls the RPC per row, and back-fills. Idempotent + resumable + per-row savepoint isolation.

### Verification (post-deploy)

Run the verification query in the PR-9.6 migration header comment:
```sql
SELECT classification_status, COUNT(*) - COUNT(ticket_id) AS without_ticket_id
FROM store_mgmt.email_messages
WHERE classification_status IN ('CLASSIFIED', 'UNCLASSIFIED_APP', 'UNCLASSIFIED_TYPE')
GROUP BY classification_status;
-- Expect: without_ticket_id = 0 for every row after backfill runs.
```

---

## PR-9 — Ticket Engine real implementation ✅ SHIPPED 2026-04-23

Commits `cd96140..3b7a637 + e7c08b3 + 718f62d` (7 atomic sub-chunks 9.1–9.7 + docs 9.8). Drop-in replacement for PR-8 stub — wire + sync unchanged; only engine internals + migration + tests.

### What shipped

- **RPC `store_mgmt.find_or_create_ticket_tx`** (PL/pgSQL, migration `20260423000000_...rpc.sql`): transactional find-or-create on grouping key `(app_id, type_id, platform_id)`; SELECT FOR UPDATE + partial unique index race fallback; full state machine per spec §4.1; EMAIL + STATE_CHANGE + PAYLOAD_ADDED event writes; atomic terminal-state transition (sets `closed_at` + `resolution_type` with `state`).
- **Partial unique index** `idx_store_mgmt_ticket_entries_email_idempotency` on `(ticket_id, email_message_id) WHERE entry_type='EMAIL'` — prevents duplicate EMAIL entries on sync retry.
- **Real `engine.ts`** replacing deleted `engine-stub.ts`. Same `findOrCreateTicket` signature. 4 typed error classes: `NotApplicableError`, `ValidationError`, `NotFoundError`, `RaceError`.
- **Extended `FindOrCreateTicketOutput`**: `previous_state`, `state_changed`, `ticket` (full row) — optional, backward compatible. Wire unchanged — reads only `ticketId`.
- **Backfill migration** (`20260423100000_...backfill_ticket_id.sql`) for PR-8-era NULL `ticket_id` rows.

### Sub-chunks shipped

| # | Scope | Commit |
|---|---|---|
| 9.1 | `FindOrCreateTicketOutput` + `TicketRow` types + spec banner + CURRENT-STATE.md | `cd96140` |
| 9.2 | `find_or_create_ticket_tx` RPC migration + idempotency partial index | `ae3ed3e` |
| 9.3 | Real `engine.ts` replacing stub + 15 engine tests (stub + stub tests deleted) | `4a30cca` |
| 9.4 | Wire regression tests (error-agnostic catch, minimal-interface contract) | `4edc479` |
| 9.5 | State transition matrix + terminal fall-through + novelty/idempotency tests (+17) | `3b7a637` |
| 9.6 | Backfill migration for PR-8-era NULL rows | `e7c08b3` |
| 9.7 | End-to-end pipeline integration tests (wire + engine real, only Supabase mocked) | `718f62d` |
| 9.8 | Docs finalization (CURRENT-STATE.md + 04-ticket-engine.md + 03-email-rule-engine.md + TODO.md) | this commit |

### Test coverage delta

Pre-PR-9: 719 tests → Post-PR-9: **785 tests** (+66 across 9.3/9.4/9.5/9.7).

### Interface stability

`FindOrCreateTicketInput` unchanged. `FindOrCreateTicketOutput` extended with optional fields — no caller impact:

```typescript
{
  ticketId: string;                    // PR-8 existing
  created: boolean;                    // PR-8 existing
  new_state: TicketState;              // PR-8 existing
  previous_state?: TicketState | null; // PR-9 added
  state_changed?: boolean;             // PR-9 added
  ticket?: TicketRow;                  // PR-9 added
}
```

Wire reads only `ticketId` → zero downstream impact. PR-10 Inbox UI is the first consumer of the extended fields.

### Deferred polish (post-ship)

- [ ] `stats.tickets_associated` counter in `SyncStats` + `sync_logs` (schema change — defer unless observability demands it; derivable via `SELECT count(*) FROM email_messages WHERE ticket_id IS NOT NULL`)
- [ ] Wire success log at DEBUG level (silent on success today; adds ~2880 log lines/day on 5-min cron — revisit only on real debugging need)
- [x] Audit `TicketEngineRaceError` + `TicketEngineNotFoundError` via Sentry — ✅ Resolved by PR-10d.1.2 (`085e422`); both errors are captured at the wire.ts swallowing boundary with `tags: { component: 'ticket-engine', phase: '...' }`.

---

## PR-10c — User actions ✅ SHIPPED 2026-04-25

Wires user-driven state transitions, comments, and reject-reason capture on top of the email-driven engine from PR-9. Authorization matrix (spec §7.2) implemented end-to-end: VIEWER read-only, DEV/MANAGER permissive, UNARCHIVE Manager-only.

### Shipped — 8 sub-chunks

| Sub-chunk | Commit | Scope |
|---|---|---|
| 10c.1.1 | `6dc8a6c` | `state-machine.ts` pure helpers (action → next state) +46 tests |
| 10c.1.2 | `ee27ef1` | `tickets/user-actions.ts` dispatcher + `tickets/auth.ts` per-action permission matrix +46 tests |
| 10c.1.3 | `1a58363` | Migration `20260424000000_store_mgmt_user_actions_rpcs.sql` — 7 RPCs |
| 10c.1.4 | `fc7c18c` | User-actions integration tests (RPC error mapping covered) +24 |
| 10c.2 | `b970517` | Inbox state-transition UI — 4 footer buttons + 10s Undo toast for ARCHIVE +20 |
| 10c.3.1 | `0819dbc` | `CommentForm` (always visible) + reject-reason composer (toggle-revealed) +10 |
| 10c.3.2 | `0257b83` | `CommentEntryCard` + `RejectReasonEntryCard` timeline renderers + `EditCommentForm` wired for own comments + trigger keyword fix (`'user' → 'user_action'`) + `currentUserId` threaded 4 layers |
| 10c.3.2.2 | `b833172` | RTL infra (`@vitejs/plugin-react`, `jsdom`, `jest-dom`, vitest setupFile) + 10 timeline component tests |

### Test coverage delta

Pre-PR-10c: 827 → Post-PR-10c: **983** (+156 across all sub-chunks).

### 7 production-ready user actions

| Action | RPC | Allowed roles | Notes |
|---|---|---|---|
| Archive | `archive_ticket_tx` | DEV / MANAGER | 10s Undo toast in UI |
| Follow up | `follow_up_ticket_tx` | DEV / MANAGER | NEW → IN_REVIEW |
| Mark done | `mark_done_ticket_tx` | DEV / MANAGER | terminal |
| Unarchive | `unarchive_ticket_tx` | MANAGER only | grouping-key conflict surfaces as `CONFLICT` |
| Add comment | `add_comment_tx` | DEV / MANAGER | always-visible composer |
| Edit comment | `edit_comment_tx` | author only (`COMMENT_FORBIDDEN` from RPC) | pencil affordance UI-gated, RPC authoritative |
| Add reject reason | `add_reject_reason_tx` | DEV / MANAGER | toggle-revealed composer; entries immutable |

### Critical fix shipped in 10c.3.2

Trigger keyword mismatch — RPC migration writes spec-canonical `metadata.trigger='user_action'` (§7.3) but the timeline renderer in PR-10b checked `=== 'user'`. Without this fix, every user-driven STATE_CHANGE entry would have fallen through to `UnknownEntryCard` post-deploy. Renderer now matches; regression locked by `TicketEntriesTimeline.test.tsx`.

### Foundation unblocked by 10c.3.2.2

RTL component-test infrastructure now wired (`@vitejs/plugin-react` plugin + `jsdom` + per-file `// @vitest-environment jsdom` opt-in + `afterEach(cleanup)` setup). Future component tests drop in without infra setup. Mocked `vi.mock` factories must avoid JSX (hoisted above imports) — return `null` or use `React.createElement` if rendering matters.

### Pending — Path G + manual QA

- [ ] Apply migration `20260424000000_store_mgmt_user_actions_rpcs.sql` to production via Supabase SQL Editor
- [ ] Manual QA scenarios:
  - 4 state-transition buttons (archive / follow-up / mark-done / unarchive) per role
  - 10s Undo toast cancels archive
  - Comment add + edit (own only — verify pencil hidden on others' comments)
  - Reject reason add (manual_paste flag set + chip rendered)
  - Timeline renders all 5 entry types correctly (EMAIL / STATE_CHANGE / PAYLOAD_ADDED / COMMENT / REJECT_REASON)
  - VIEWER hides actions footer + composer
  - DEV/MANAGER full functionality

### Deferred to post-PR-10 — Reclassify feature

§5.2 reclassify (re-run classifier on existing emails after App Registry / Email Rules updates) is out of scope for PR-10. Manager reviews UNCLASSIFIED_APP / UNCLASSIFIED_TYPE bucket tickets manually until the reclassify action ships. See TODO.md "Post-PR-10 — Reclassify feature (planned)" for design sketch.

---

## PR-10d — Polish + Observability ✅ SHIPPED 2026-04-25

PR-10 is fully complete. PR-10d closes the PR-7 + PR-9 deferred Sentry debt and adds power-user keyboard navigation to the Inbox.

### Shipped — 4 sub-chunks

| Sub-chunk | Commit | Scope |
|---|---|---|
| 10d.1.1 | `0fdaf92` | Sentry SDK init — `instrumentation.ts` + `sentry.server.config.ts` + `sentry.edge.config.ts` + `instrumentation-client.ts` (modern v10 pattern, replaces deprecated `sentry.client.config.ts`) + `withSentryConfig` wrap in `next.config.mjs` + `.env.example` additions |
| 10d.1.2 | `085e422` | `Sentry.captureException` in 3 production paths — gmail-sync 500 fallback, ticket-engine wire.ts (both catch sites), inbox-actions unmapped DB_ERROR. `Sentry.setUser` auto-binds via `guardDevOrManager`. |
| 10d.1.3 | `83dee62` | Route-level error boundary `inbox/error.tsx` + root-layout `app/global-error.tsx`. Resolves the SDK's `global-error.js` warning. |
| 10d.2 | `f73355d` | j/k row navigation + Enter to open via `react-hotkeys-hook` v5; `focusedIndex` state with `ticketsKey`-stable reset; desktop-only hint strip. |

### Tag taxonomy

| `component` | Subcontext |
|---|---|
| `gmail-sync` | `endpoint: 'cron-tick'` |
| `ticket-engine` | `phase: 'find-or-create' \| 'update-link'` |
| `inbox-actions` | `action: <UserActionRequest['type']>` |
| `inbox-error-boundary` | (no subcontext — route-level) |
| `global-error-boundary` | (no subcontext — root-layout) |

User context auto-binds via `guardDevOrManager` (`Sentry.setUser({ id, username: role })`) — id + role only, email omitted as PII. PII filter in `sentry.server.config.ts#beforeSend` redacts `body` / `email` / `content` keys so Apple/Google reviewer text never transits to Sentry.

### Capture scope discipline

- **DO capture:** 500 errors, race conditions, unmapped DB failures, swallowing-boundary catches in graceful-degradation paths
- **DON'T capture:** typed business errors (state guards, ownership checks, validation failures, authorization rejections) — flooding Sentry with normal flow drowns out real incidents

### Cumulative PR-10 metrics

- **25 commits total:** PR-10a (7) + PR-10b (5) + PR-10c (9) + PR-10d (4)
- **Tests:** 785 (pre-PR-10) → **983** (+198)
- **Bundle (`/store-submissions/inbox`):** 8.1 → 13.7 kB (+69%)
- **Production surface:** 7 user actions + 5 Sentry capture sites + 2 error boundaries + j/k/Enter navigation
- **Migrations applied production:** `20260423000000_...rpc.sql` (PR-9), `20260423100000_...backfill_ticket_id.sql` (PR-9.6), `20260424000000_...user_actions_rpcs.sql` (PR-10c.1.3)

### PR-10d-specific known limitations

- E2E (Playwright) **deferred post-MVP** — greenfield infra (browser runtime, NextAuth fixture, dev-server lifecycle in CI) doesn't fit the 0.5-day budget. ROI is low for 2-5 internal users with 983 unit tests + RTL on critical timeline + manual QA. Re-trigger when 3+ critical flows accumulate.
- Source map upload to Sentry guarded by `SENTRY_AUTH_TOKEN` — set in Railway CI to enable; local builds stay quiet without it.

---

## PR-11 — HTML Parsing + Reclassify ✅ SHIPPED 2026-04-25

Apple submission emails carry their type signal exclusively in the
HTML alternative (`text/plain` has only Submission ID + App Name). Pre-PR-11
the classifier always landed in `UNCLASSIFIED_TYPE` for Apple. PR-11 adds
a pure HTML extractor, threads the structured payload through the
classifier as Priority 1, ships a `Product Page Optimization` type seed,
and adds Manager-driven reclassify for the prod backlog of UNCLASSIFIED rows.

### Shipped — 6 sub-chunks (+ 1 docs chunk)

| Sub-chunk | Commit | Scope |
|---|---|---|
| 11.1 | `cb4480c` | `lib/store-submissions/gmail/html-extractor.ts` — pure `extractApple(html)` returning `{ accepted_items: AcceptedItem[] }`. 4 type variants + `UNKNOWN` fallback. 4 real `.eml` fixtures + 9 unit tests. `node-html-parser` ^7.1.0 added. |
| 11.2 | `e3385d9` | Migration `20260425000000_store_mgmt_email_extracted_payload.sql` — `email_messages.extracted_payload JSONB` + GIN index. |
| 11.3 | `50444d9` | `gmail/sync.ts` — Apple-gated `extractApple(parsed.bodyHtml)` after sender resolve; threads `extracted_payload` into `EmailInput` + `email_messages` INSERT. `Sentry.captureMessage` warning on UNKNOWN headings (`component: 'html-extractor'`). 3-state column semantic: NULL (non-Apple/error) vs empty array (Apple, no items) vs populated. +8 tests. |
| 11.4 | `994da90` | Two-tier `matchType(email, rules)`: Priority 1 reads `extracted_payload.accepted_items[0]` and looks up by slug (`mapExtractorTypeToSlug` for `app`/`iae`/`cpp`/`ppo`); Priority 2 falls back to legacy `body.includes(body_keyword)`. Migration `20260425000001_...seed_apple_ppo_type.sql` adds the missing PPO type. +12 tests. |
| 11.5 | `f00cac7` | Server Actions `reclassifyEmailMessageAction(emailMessageId)` + `reclassifyUnclassifiedAction(bucket)`, MANAGER-only. Migration `20260425000002_..._reclassify_rpc.sql` — `reclassify_email_tx` RPC: FOR UPDATE on email row, no-op short-circuit, detach + STATE_CHANGE 'reclassify_out' on old ticket, `find_or_create_ticket_tx` reuse for the attach side. +19 tests. |
| 11.6 | `130f35e` | UI surfaces — per-email `ReclassifyEmailButton` in `EmailEntryCard` (MANAGER + `email_message_id` non-null), `BulkReclassifyButton` in the existing Unclassified-tab banner, `AppleHtmlTypeGuidance` collapsible card on the Email Rules type editor. `window.confirm` + `useTransition` + sonner toasts. +5 tests. Inbox bundle 13.7 → 14.4 kB. |
| 11.7 | this commit | Docs finalization — CURRENT-STATE.md, 04-ticket-engine.md (§5.2 Shipped status), 03-email-rule-engine.md (new §3.5 HTML extractor), TODO.md (strike Reclassify feature, add deferred items). |

### Test coverage delta

Pre-PR-11: 983 → Post-PR-11: **1036** (+53 across 11.1, 11.3, 11.4, 11.5, 11.6).

### Architecture — TS classifier + SQL atomic swap

Reclassify deliberately splits across the language boundary:

- **TS Server Action** re-runs the classifier on the persisted email
  (sender resolve + rules load + `classify(input, rules)`) — preserves a
  single source of truth for the classifier (RE2 regex + fixture-tested,
  not duplicated in PL/pgSQL).
- **SQL RPC** does the atomic swap given the pre-computed classification:
  FOR UPDATE on the email row, write `classification_result` +
  `classification_status`, detach `ticket_id`, STATE_CHANGE entry on the
  old ticket, then `find_or_create_ticket_tx` for the attach side.
  No-change short-circuit happens under FOR UPDATE so concurrent sync
  writes can't slip past the comparison.

### 3-state `extracted_payload` semantic (PR-11 baseline)

| Value | Meaning | Producer |
|---|---|---|
| NULL | Extraction not attempted | Non-Apple platform; parse-error path; NO_SENDER_MATCH path; legacy rows pre-PR-11.3 |
| `{ outcome, items: [] }` | Attempted, no items found | Apple sender + neither "Accepted items" h2 nor "...resolve the issues..." anchor present (marketing mail, status digest, malformed template) |
| `{ outcome, items: [...] }` | Apple email with structured types | Apple sender + matched 1+ headings under acceptance OR rejection anchor |

Reclassify uses this distinction: legacy rows + non-Apple stay NULL, Apple
rows always carry a non-null payload (even when `items` is empty). The
bulk reclassify can identify legacy vs new rows via `IS NULL` vs `IS NOT NULL`.

**PR-12 shape rename**: field renamed `accepted_items` → `items` to cover
both acceptance + rejection branches; new sibling `outcome` field carries
`'ACCEPTED' | 'REJECTED' | null`. **Audit-only** — classifier does not
read it; `tickets.latest_outcome` continues to flow from `subject_patterns`
via the PR-9 `find_or_create_ticket_tx` RPC (single source of truth). See
[03-email-rule-engine.md §3.5](03-email-rule-engine.md) and
[type-matcher.ts:103-107](../../lib/store-submissions/classifier/type-matcher.ts).
The Postgres `COMMENT ON COLUMN` in migration
`20260425000000_store_mgmt_email_extracted_payload.sql:20` still reads
`accepted_items` — kept stale per the no-down-migrations rule; refreshed
the next time a forward migration touches the column.

### Sentry tag taxonomy (extended)

| `component` | Subcontext |
|---|---|
| `html-extractor` | `gmail_msg_id: <Gmail message id>` (UNKNOWN heading variants) |
| `reclassify-actions` | `action: 'bulk-fetch' \| 'bulk-row'` + `emailMessageId` / `bucket` |
| `backfill-action` (PR-12.5) | `stage: 'gmail-fetch' \| 'gmail-client' \| 'fetch-candidates' \| 'bulk-row' \| 'unmapped'` + `emailMessageId` + per-row breadcrumbs (`fetch-start` / `html-extracted` / `extract-result` / `reclassify-result`) |

### Cumulative PR-11 metrics

- **7 commits total:** 11.1–11.7
- **Tests:** 983 → **1036** (+53)
- **Bundle (`/store-submissions/inbox`):** 13.7 → 14.4 kB (+0.7 kB)
- **3 migrations pending Path G:** `20260425000000_..._email_extracted_payload.sql`, `20260425000001_..._seed_apple_ppo_type.sql`, `20260425000002_..._reclassify_rpc.sql`

### Risk flags acknowledged (deferred)

- **Real PL/pgSQL execution tests for `reclassify_email_tx`** — current 19 tests mock the RPC at the Server Action boundary. End-to-end against a migration-applied DB needs a Supabase local docker harness (also a PR-5 deferred item). Manual QA Path G validates production. Filed in TODO.md.
- **Multi-platform extractors** (Google / Huawei / Facebook) deferred to PR-12+. Need real `.eml` samples first; current `extractApple` is platform-coupled by name.
- **`UnifiedClassificationResult` typing cleanup** — Server Action's local `Record<string, unknown>` pragma matches sync.ts pragma (NO_RULES + NO_SENDER_MATCH live outside the classifier's `ErrorCode` union). Post-MVP unification across both files.
- **Auto-archive empty old tickets** — when reclassify moves the last email out of an Unclassified bucket, the old ticket may end up empty. Manual cleanup by Manager for now; an "archive empty buckets" sweep could ship later.

### Pending — Path G + manual QA

- [ ] Apply 3 migrations via Supabase SQL Editor in order
  1. `20260425000000_store_mgmt_email_extracted_payload.sql`
  2. `20260425000001_store_mgmt_seed_apple_ppo_type.sql`
  3. `20260425000002_store_mgmt_reclassify_rpc.sql`
- [ ] Manual QA scenarios:
  - Per-email Reclassify button visible only for MANAGER on EMAIL entries with `email_message_id`
  - Confirm dialog readable; toast renders correct level (success / info / warning / error)
  - Spinning RefreshCcw icon during `useTransition`
  - Bulk button on Unclassified tab → "Reclassified N/M (K errors)" toast
  - Apple HTML guidance card collapsible; renders 4 patterns + UNKNOWN note
  - UNCLASSIFIED_TYPE production rows reclassify into typed buckets after migrations apply (PPO seed catches Gunny Mobi 230426)
  - VIEWER never sees reclassify affordances
  - DEV blocked from reclassify (MANAGER-only, escalated from DEV+MANAGER for blast-radius reasons)

---

## PR-12 — Apple rejection parser + Backfill button ✅ SHIPPED 2026-04-27

PR-11 wire was untested in production: 0 Apple emails arrived between
2026-04-25 deploy and 2026-04-27. PR-12 closes the loop on two surfaced
issues:

1. **Apple rejection emails** (subject `"There's an issue with your X submission"`)
   classified as `UNCLASSIFIED_TYPE` because `extractApple` only walked
   `<h2>Accepted items</h2>` — rejection template has no h2 anchor.
   Empty `accepted_items` → classifier P1 falls through, P2 body keyword
   misses (Apple text/plain has no type token).
2. **14 legacy rows** pre-PR-11.3 deploy carry `extracted_payload IS NULL`
   and need a Manager-driven re-extract path. Reclassify alone (PR-11.5)
   doesn't help — those rows have no payload to consume yet.

### Shipped — 4 commits (down from 7-chunk plan via subsume discipline)

| Commit | Scope |
|---|---|
| `b1060e8` | **PR-12.1+12.2 bundle** — `extractApple(html, subject?)` rejection branch + `outcome` audit flag + `items` rename + IAE optional `(N)` count + `extractIdAndName` parses Submission ID + App Name from HTML body. 4 rejection `.eml` fixtures saved. Restructured `html-extractor.test.ts` (4 acceptance + 4 rejection + 4 outcome detection + 6 fallbacks). Sync wire threading + classifier audit comment subsumed into the bundle (12.3 + 12.4 absorbed). |
| `f4188db` | **PR-12.5** — `lib/store-submissions/reclassify/core.ts` extracted (~200 lines, plain async helpers); `reclassify-actions.ts` slimmed (-179/+13). New `app/(dashboard)/store-submissions/inbox/backfill-actions.ts` (~370 lines): `backfillSingleEmailAction(emailId)` + `backfillUnclassifiedAction({ limit? })`, MANAGER gate, Apple-sender SQL filter, Gmail re-fetch + extract + UPDATE + reclassify. `BackfillButtons` component in InboxClient (Test 1 row + Backfill all). Sentry `backfill-action` taxonomy with 4 per-row breadcrumbs. |
| `00419bc` | **PR-12.6** — 8 backfill action tests (single happy + bulk happy + bulk empty + VIEWER × 2 + per-row resilience + Apple-only filter × 2). `makeQueryBuilder` thenable Supabase chain helper. `vi.importActual` preserves `EmailNotFoundError` + `ReclassifyValidationError` instanceof checks. |
| this commit | **PR-12.7** — Docs finalization (CURRENT-STATE.md + 03-email-rule-engine.md §3.5 + 04-ticket-engine.md §0 + TODO.md). |

### Test coverage delta

Pre-PR-12: 1036 → Post-PR-12: **1053** (+17 cumulative across 12.1+12.2 bundle and 12.6).

### Detection priority chain (PR-12.1)

```
1. Subject contains "There's an issue with"   → outcome='REJECTED' + walk h3 from "...resolve the issues..." paragraph
2. <h2>Accepted items</h2> present            → outcome='ACCEPTED' + walk h3 from h2 (PR-11 path)
3. <p>...resolve the issues...</p> present    → outcome='REJECTED' (HTML fallback when subject missing/unrecognized)
4. else                                       → outcome=null + items=[]
```

Subject is authoritative when it carries the rejection marker — even if
the HTML anchor paragraph is missing/malformed, `outcome='REJECTED'` is
correct. `items=[]` in that case is the Sentry-visible signal that Apple
may have changed the rejection HTML template.

### Backfill button workflow (PR-12.5)

UI surface in the Inbox Unclassified-tab MANAGER banner:

```
┌─ MANAGER banner ────────────────────────────────────────────┐
│ Want to auto-classify these? Add rules, then re-run on...    │
│  ▶ Backfill 1 row (test)  | 🗄 Backfill all  | ↻ Reclassify all  | Manage rules → │
└──────────────────────────────────────────────────────────────┘
```

**"Backfill 1 row (test)"** — calls `backfillUnclassifiedAction({ limit: 1 })`.
Server picks the oldest UNCLASSIFIED Apple row with `extracted_payload IS NULL`,
re-fetches Gmail HTML, runs the extractor, persists, then reclassifies.
~200ms, no `window.confirm` (action is bounded). Toast reports per-row
counts; Manager verifies the row moved buckets correctly before the bulk run.

**"Backfill all"** — same pipeline, full bulk over all candidates.
`window.confirm` gate. Sequential (Q4: ~14 rows × ~200ms = ~3s, no rate
limit). Per-row failures captured + counted; batch continues.

**Two-step persistence** (UPDATE `extracted_payload` then `reclassify_email_tx`)
documented as bounded ~50ms gap; RPC's FOR UPDATE re-loads under lock so
concurrent sync runs can't observe a half-updated row.

### Design decisions baked in

| # | Decision | Rationale |
|---|---|---|
| Q1 Option A | `extracted_payload.outcome` is JSONB audit-only — classifier doesn't read it | `tickets.latest_outcome` already flows from `subject_patterns` via PR-9 RPC (single source of truth). Two sources of truth would cause divergence + Manager-edit surprises. |
| Q2 | Rich `AcceptedItem` preserved (typed `version`, `platform`, `count`, `name`, `uuid`, `version_code`) | Type-matcher builds payload Record from typed fields directly. Flatten to `{type, content}` would duplicate extractor logic + lose payload typing. |
| Q3 | IAE matcher relaxed to optional `(N)` count | Acceptance `<h3>In-App Events (5)</h3>` keeps `count: 5`; rejection `<h3>In-App Events </h3>` parses with `count: undefined`. Body description + numeric ID captured in `raw_body` for Manager debugging. |
| reclassifyOne extraction | Plain async helper module shared by reclassify + backfill Server Actions | `'use server'` files only export async functions — cross-file sharing must go through plain helpers. Single source of truth for the reclassify pipeline. |
| Test = bulk with limit:1 | UI's "Test 1 row" calls `backfillUnclassifiedAction({ limit: 1 })`, not a separate single-row endpoint | Inbox UI shows tickets, not raw emails — threading `email_message_id` through ticket rows just for the test affordance is over-engineering. Server picks oldest candidate. `backfillSingleEmailAction(emailId)` stays exported for future per-row affordances + tests. |
| Apple-only SQL filter | `.in('sender_email', appleEmails)` at SQL layer | Defense-in-depth — even if classifier rules drift, only Apple rows enter the candidate set. Empty Apple sender registry → early return with empty stats (no `.from()` call). |

### Production safety (still being verified)

- 0 Apple emails arrived post-2026-04-25 deploy → wire untested in
  production with real Apple data. PR-12 self-verifies via 8 fixtures
  (4 acceptance + 4 rejection) — fixture-tested, but not real-traffic
  tested.
- "Test 1 row" mode is the production-safety verification before bulk.
  Manager runs it first, confirms the result via Sentry breadcrumbs +
  inbox refresh, then triggers "Backfill all" with confidence.
- Optional parallel: forward 1 sample Apple email into the watched
  mailbox for an independent wire verification on real production
  traffic (orthogonal to PR-12 backfill flow).

### Pending — Path G + manual QA

- [ ] Push 4 PR-12 commits to `origin/main` → Railway auto-deploy (~3 min)
- [ ] Manual QA scenarios (recommended order):
  1. Click **"Backfill 1 row (test)"** — verify single row populated + reclassified
  2. Verify Sentry receives `component: 'backfill-action'` breadcrumbs (`fetch-start` → `html-extracted` → `extract-result` → `reclassify-result`)
  3. SQL verify outcome populated:
     ```sql
     SELECT id, classification_status,
            extracted_payload->>'outcome' AS outcome,
            jsonb_array_length(extracted_payload->'items') AS items_count
     FROM store_mgmt.email_messages
     WHERE extracted_payload IS NOT NULL
     ORDER BY received_at DESC LIMIT 5;
     ```
  4. Click **"Backfill all"** → confirm window dialog → wait ~3s → verify aggregate toast
  5. Final SQL verification:
     ```sql
     SELECT classification_status,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE extracted_payload IS NOT NULL) AS with_payload,
            COUNT(*) FILTER (WHERE extracted_payload IS NULL) AS null_payload
     FROM store_mgmt.email_messages
     WHERE sender_email LIKE '%apple.com'
     GROUP BY classification_status;
     -- Expect: null_payload = 0 for UNCLASSIFIED_* rows after backfill.
     ```
  6. VIEWER session cannot see Backfill buttons (banner gated on `role === 'MANAGER'`)

### Risk flags acknowledged (deferred to PR-13+)

- **Multi-platform backfill expansion** — `backfillUnclassifiedAction` is Apple-only by `appleEmails` SQL filter. Google Play / Huawei / Facebook need their own HTML extractors first (still PR-13+ deferred).
- **Sentry breadcrumb cap formalization** — current 4-stage × 14-row max = 56 breadcrumbs (well under Sentry's default 100 cap). Multi-platform expansion may push past — add explicit cap-at-first-N pattern when batch sizes grow.
- **Migration COMMENT refresh** — `20260425000000_store_mgmt_email_extracted_payload.sql:20` still mentions old `accepted_items` shape. Postgres metadata comment, not enforced. Refreshed on next forward migration touching the column.
- **0 Apple emails post-deploy** — wire still untested with real production traffic. Path G manual QA validates with backfill of 14 legacy rows; first new Apple email arrival will exercise the live path.

---

## PR-13 — Outcome filter dimension separation ✅ SHIPPED 2026-04-30

PR-12 backfill populated `tickets.latest_outcome` at production scale
for the first time, exposing a pre-existing UI dimension misalignment:
the Inbox "Approve" tab queried `state=APPROVED` (lifecycle) while the
Outcome column rendered `latest_outcome=APPROVED` (email-derived).
Tickets with `state=IN_REVIEW` + `latest_outcome=APPROVED` showed
"Approve" in the column but were filtered out of the "Approve" tab.
PR-13 surfaces the outcome dimension as a first-class chip refinement
within the lifecycle tabs — not a regression, an exposure.

### Shipped — 4 commits

| Commit | Scope |
|---|---|
| `d556fc6` | **PR-13.1** — Backend: `outcomeFilterSchema = z.union([ticketOutcomeSchema, z.literal('none')])` threaded into `ticketsQuerySchema` + `listTickets` predicate (`'none'` → `.is('latest_outcome', null)`, enum → `.eq('latest_outcome', value)`) + URL parser threading via `firstOf` + 8 tests (4 schema/parser + 4 query). |
| `346785a` | **PR-13.2** — UI: 5-tab consolidation (drop Rejected, keep Approved standalone) + outcome chip row (All/Approve/Reject/In review/No outcome) + visual hierarchy (tabs underline / chips pill rounded-full) + `aria-pressed` accessibility + chip-survives-tab-switch via `baseParams.scalarKeys` + chips hidden on Unclassified tab. |
| `41f0a84` | **PR-13.3** — Empty-state refresh: pure helper extraction (`lib/store-submissions/inbox/empty-message.ts`) + Hybrid Option C decision tree + `hasOtherFilters` vs `hasActiveFilters` split (different consumers, different semantics) + 5 tests. Net `InboxClient.tsx` -24 lines. |
| this commit | **PR-13.4** — Docs (CURRENT-STATE.md + 03-email-rule-engine.md + 04-ticket-engine.md + TODO.md). |

### Three-dimension model (independent axes)

| Dimension | Column | Driven by | UI surface |
|---|---|---|---|
| Lifecycle | `tickets.state` (NEW/IN_REVIEW/REJECTED/APPROVED/DONE/ARCHIVED) | Manager actions (`FOLLOW_UP`, `MARK_DONE`, `ARCHIVE`, `UNARCHIVE`) | State tabs |
| Outcome | `tickets.latest_outcome` (IN_REVIEW/REJECTED/APPROVED + nullable) | `subject_patterns` flow via PR-9 `find_or_create_ticket_tx` RPC (single source of truth, lines 355-376 of `20260423000000_..._ticket_engine_rpc.sql`) | Outcome chips + Outcome column badge |
| Triage | `email_messages.classification_status` (CLASSIFIED/UNCLASSIFIED_*/DROPPED/ERROR) | Classifier output (sender + subject + type) | Unclassified tab (via `app_id IS NULL OR type_id IS NULL` bucket) |

A single ticket can carry mixed-dimension values — `state=IN_REVIEW` +
`latest_outcome=APPROVED` is the exact combo PR-12 backfill made common
in production. Q1 Option A discipline (PR-12) keeps
`extracted_payload.outcome` as audit-only JSONB so the classifier
doesn't fork two outcome sources of truth.

### 5-tab structure (final)

| Tab | Predicate |
|---|---|
| Open (default) | `state IN ('NEW', 'IN_REVIEW', 'REJECTED')` |
| Approved | `state = 'APPROVED'` (FOLLOW_UP terminal — Manager promoted) |
| Done | `state = 'DONE'` (MARK_DONE terminal) |
| Archived | `state = 'ARCHIVED'` |
| Unclassified | `app_id IS NULL OR type_id IS NULL` |

The standalone "Rejected" tab was removed — it conflated
`state=REJECTED` (an open lifecycle state, included in Open) with
`latest_outcome=REJECTED` (email-derived). Rejected work is now
reachable via Open tab + Reject chip.

### 5-chip outcome refinement (within active tab)

| Chip | URL | Predicate |
|---|---|---|
| All (leftmost default) | (no `outcome` param) | no filter |
| Approve | `?outcome=APPROVED` | `latest_outcome = 'APPROVED'` |
| Reject | `?outcome=REJECTED` | `latest_outcome = 'REJECTED'` |
| In review | `?outcome=IN_REVIEW` | `latest_outcome = 'IN_REVIEW'` |
| No outcome | `?outcome=none` | `latest_outcome IS NULL` |

Chips hidden on Unclassified tab (no classified email yet, so chip
filter has no semantic content). Chip selection survives tab switches
via `baseParams.scalarKeys` — Manager workflow "show me Reject across
both Open and Done" preserved without re-clicking.

### Behavior changes (Manager UX improvement)

Empty-state copy for combined state × outcome filter:

| Combo (zero results) | Before | After |
|---|---|---|
| Open + Reject chip | "No tickets match the current filters." | "No open tickets with outcome 'Reject'. Try clearing the chip filter." |
| Approved + No outcome chip | "No tickets match the current filters." | "All approved tickets have an outcome assigned." |

### Test + bundle deltas

- Tests: 1053 (pre-PR-13) → **1067** (+14 cumulative across 13.1 +8 schema/parser/query, 13.3 +5 empty-message; 13.2 unchanged per UI-layer convention)
- Bundle (`/store-submissions/inbox`): 15.1 → **15.4 kB** (+0.3 kB across 4 commits)
- No migrations (application-layer only)

### Backward compat

- Existing `?state=APPROVED` bookmarks parse and filter identically
- Bookmarks without `outcome` resolve to "All" chip default (no URL change)
- Removed Rejected tab → old `?state=REJECTED` URLs still filter via the schema (state array-friendly), they just don't map to a visible tab anymore. Manager replacement workflow: Open tab + Reject chip.
- `clearAllFilters` semantics preserved (wipes everything including outcome)

### Pending — Path G + manual QA

- [ ] Push 4 PR-13 commits to `origin/main` → Railway auto-deploy (~3 min)
- [ ] Manual UAT scenarios:
  - 5 tabs visible; Rejected tab gone
  - Click chip "Approve" inside Open tab → tickets with `latest_outcome=APPROVED` surface (regardless of state value)
  - URL: `?state=NEW&outcome=APPROVED` works correctly; `?outcome=none` filters NULL branch
  - "All" chip default = no `outcome` param in URL (clean default)
  - Unclassified tab hides chip row entirely
  - Empty-state copy improvements visible (Open + Reject zero, Approved + None zero)
  - Backward compat: existing `?state=APPROVED` bookmark still works
  - Mobile: chips wrap (5 chips manageable)
  - Issue 2 verified resolved: `latest_outcome=APPROVED` tickets with `state=IN_REVIEW` reachable via Open tab + Approve chip

### Risk flags acknowledged (deferred)

- **Issue 1 (UTF-8 body preview)** — ✅ resolved by PR-14 (byte-level QP decoder + backfill action)
- **Multi-platform extractor expansion** — PR-18+ (Apple-only at present)
- **Per-row backfill affordance in EmailEntryCard** — PR-18+
- **Migration COMMENT refresh** + **Sentry breadcrumb cap** + **Vitest cold-start flake** + **Gmail OAuth token resilience** + **Spec §5.2 ticket-level merge** — all PR-18+ infra/cleanup

---

## PR-14 — Byte-level QP decoder + corrupt-payload backfill ✅ SHIPPED 2026-05-01

PR-12 production QA surfaced "Issue 1": Vietnamese app names rendered as
`Da:%u TrF0a;ng ChC"n LC` in the Inbox app-name column. Initial hypothesis
was a charset-decode gap (PR-7 polish line in TODO.md suggested
`x-mac-vietnamese` or similar) but multi-step diagnostic flipped the
hypothesis: the parser was the culprit, not Apple. Production hit 14
functional rows across 4 distinct apps before fix shipped:

| App | Garbled rendering |
|---|---|
| Đấu Trường Chân Lý (TFT VN) | `Da:%u TrF0a;ng ChC"n LC` |
| LMHT: Tốc Chiến (LoL Wild Rift VN) | `LMHT: Ta;c Chia:?n` |
| 彈彈英雄 (Chinese) | control-byte garbling |
| 創世紀戰M：阿修羅計畫 (Chinese) | control-byte garbling |

### Root cause — single-byte cascade

[`lib/store-submissions/gmail/parser.ts:386-395`](../../lib/store-submissions/gmail/parser.ts) (pre-fix):

```ts
const raw = Buffer.from(data, 'base64url');
if (transfer === 'quoted-printable') {
  const asAscii = raw.toString('ascii');                   // ← BUG
  if (/=[0-9A-Fa-f]{2}|=\r?\n/.test(asAscii)) {
    return decodeQuotedPrintable(asAscii, charset);
  }
}
return raw.toString(charset);
```

Node's `Buffer.toString('ascii')` masks each byte with `& 0x7F`
(deliberate — that's the documented behavior). Apple emits some templates
with `Content-Transfer-Encoding: QUOTED-PRINTABLE` headers but bodies
that are actually raw UTF-8 (no `=XX` escapes anywhere). For
"Đấu Trường Chân Lý" the raw bytes are correct UTF-8:

```
... 41 70 70 20 4e 61 6d 65 3a 20 c4 90 e1 ba a5 75 20 54 72 c6 b0 e1 bb 9d 6e 67 ...
                              ^^^^^Đ  ^^^^^^^^^ấ        ^^^^^ư  ^^^^^^^^^ờ
```

ASCII-mask each byte:

| UTF-8 byte | `& 0x7F` | Char |
|---|---|---|
| `0xC4` (Đ lead) | `0x44` | `D` |
| `0x90` (Đ tail) | `0x10` | DLE control |
| `0xE1` (ấ lead) | `0x61` | `a` |
| `0xBA` (ấ mid)  | `0x3A` | `:` |
| `0xA5` (ấ tail) | `0x25` | `%` |
| `0x75` (u)      | `0x75` | `u` |

Pattern: `D\u0010a:%u` — matches the production "Da:%u" exactly.
Worse: `0xBD` (tail byte of `ý`) masks to `0x3D` (`=`), which followed
by CRLF triggers the `/=\r?\n/` arm of the QP-detect regex. The decoder
runs on the ASCII-masked string, drops the spurious `=\r\n` as a "soft
break", and decodes any `=XX` masked-byte pairs as additional bytes —
cascading the corruption.

### Fix — Option I, byte-level decoder

Discarded alternatives:

- **Option II (skip QP entirely if any byte ≥ 0x80)** — would have left
  Apple's mixed HTML body broken. Apple ships HTML attributes with
  genuine QP escapes (`xmlns=3D"..."`) AND raw UTF-8 inline app names in
  the same body. Skipping QP wholesale would leave `=3D` literal in
  parsed output and break `extractApple`'s attribute reads.
- **Trust-the-header strict mode** — same problem; mislabel emails were
  the population we needed to repair, not skip.

[`decodeQuotedPrintable`](../../lib/store-submissions/gmail/parser.ts) is
now `(raw: Buffer, charset)` instead of `(input: string, charset)` and
walks bytes directly. ASCII byte `0x3D` (`=`) is the only escape
trigger; bytes ≥ `0x80` always pass through unchanged. Genuine QP
escapes still decode (`=XX` hex pair, `=\r\n` and `=\n` soft breaks).
Mislabeled UTF-8 bodies pass through verbatim. Mixed bodies do both
correctly in one pass.

### Sub-chunks shipped

| # | Commit | Scope |
|---|---|---|
| 14.1+14.2 | `d20c898` | Bundle: replaced synthetic real-QP fixture (`edgeAppleVietnameseQpRejection`, didn't reproduce the bug) with `edgeAppleMislabelUtf8` mirroring TICKET-10009's wire shape (multipart/alternative, both parts CTE: QUOTED-PRINTABLE, text/plain raw UTF-8, text/html mixed `=3D` + raw UTF-8). Decoder rewrite. 4-layer diagnostic block (Layer 1 RFC 2047 continuation-line bug `.skip()` deferred to PR-18+). +3 tests unskipped. |
| 14.3 | `66223da` | Charset coverage: 4 mislabel fixtures × 4 tests. Chinese (3-byte UTF-8), Japanese (mixed scripts + ASCII transitions), emoji (4-byte → UTF-16 surrogate pair, pinned `\uD83C\uDFAE`), mixed-encoding (`=C3=A9` + raw `0xC3 0xA9` decode identically to `é`). +4 tests. |
| 14.4 | `2ee80e8` | `backfillCorruptPayloadAction` MANAGER cleanup (Apple-only, control-byte regex filter via PostgREST `.or()`, sequential per-row, sentry tag `variant: 'corrupt-payload'`) + maintenance banner D2 (separate from Unclassified banner, amber/Wrench tone, auto-retires when count → 0) + `lib/store-submissions/backfill/core.ts` extraction (mirrors PR-12.5 reclassify/core.ts pattern; backfillOne now writes BOTH `raw_body_text` + `extracted_payload`, so NULL-payload backfill incidentally repairs any byte-mask corruption in the same row). +5 tests. |
| 14.5 | this commit | Docs (this milestone section + 02-gmail-sync.md MIME-decode subsection + TODO.md PR-14 close + Layer 1 deferral). Cleanup verification (diagnose-message route absent, no stale scripts, gauntlet clean). |

### Investigation discipline (4 hypothesis pivots earned by data)

1. **Initial hypothesis: parser body-decode broken** — diagnostic test
   on synthetic real-QP fixture (`=C6=A1` Vietnamese) PASSED on layers 2/3/4.
   Synthetic fixture didn't reproduce the bug.
2. **Pivot to RFC 2047 subject-decode bug (Layer 1)** — real but
   orthogonal to the production symptom. Subjects render correctly in
   prod. Parked PR-18+.
3. **Pivot to "Apple sends broken bodies"** — production data via SQL
   diagnostic confirmed BOTH `raw_body_text` and `extracted_payload->>'app_name'`
   garbled (HTML extractor consumes the same parser path).
4. **Pivot to "parser bug specific to TFT email"** — temporary diagnostic
   API route (`GET /api/store-submissions/diagnose-message?id=…`)
   revealed: Apple's wire bytes for TICKET-10009 are correct UTF-8;
   parser corrupts them via the ASCII-mask path. Synthetic fixture had
   used real QP encoding (with `=XX` escapes) — Apple's real emails ship
   the bytes as raw UTF-8 with the QP header lying. Mislabel was the
   missing fixture variant.

The diagnostic API route was deleted before any commit. The synthetic
fixture was reshaped from real-QP to mislabel-UTF-8 in PR-14.1+14.2 and
now reproduces the bug deterministically.

### Decision overrides (vs locked plan)

- **Banner placement: D2 over D1.** Locked plan was D1 (3rd button in
  the Unclassified-tab banner). Codebase grounding revealed corrupt rows
  are CLASSIFIED status — they appear in Open / Done tabs, not
  Unclassified. D1 would have hidden the action behind a tab where the
  rows don't appear. D2 ships a separate amber maintenance banner above
  the state tabs, visible on every tab when count > 0, auto-retiring at
  zero. Three icons for three Manager affordances: `Database`
  (NULL-payload backfill), `RefreshCcw` (reclassify), `Wrench` (corrupt
  repair) — preserves visual mental model.

- **PostgREST `.or()` regex over RPC migration.** Per the verify-then-
  fallback decision, candidate filter uses
  `.match.[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F]` directly via supabase-js
  `.or()` rather than pre-emptively shipping an RPC wrapper. Tests
  verify the filter string is built correctly; runtime validation
  happens during PR-14 manual QA. Fallback path (RPC function
  `store_mgmt.get_corrupt_payload_emails(p_apple_emails)` with the same
  WHERE clause) is documented inline in
  [`backfill-corrupt-actions.ts`](../../app/(dashboard)/store-submissions/inbox/backfill-corrupt-actions.ts)
  for hot-pivot if production rejects.

### Test + bundle deltas

- Tests: 1067 (pre-PR-14) → **1079** (+12 cumulative across 14.1+14.2 +3 +
  14.3 +4 + 14.4 +5; 14.5 docs unchanged)
- 1 deferred test (`it.skip()`) for Layer 1 RFC 2047 continuation-line
  bug — distinct decoder, distinct symptom, PR-18+ candidate
- Bundle (`/store-submissions/inbox`): minor increase from new banner
  subcomponent
- No migrations (parser fix is forward-only application code; no schema
  change)

### Forward-only fix + targeted backfill

- New emails post-deploy parse correctly via the byte-level decoder
- 14 existing functional rows fixed via the maintenance banner
  ("Repair corrupt payloads (N)") — MANAGER-driven, sequential per-row,
  ~3-5s for the full queue
- 189 DROPPED rows (control-byte residue but no Manager visibility) left
  alone per Decision 2 (functional impact only)
- Banner auto-retires when count reaches 0 — no future code change to
  remove it

### Open follow-ups

- [ ] **Layer 1 — RFC 2047 subject continuation-line whitespace** —
  `decodeRfc2047` runs the per-word decode before the `\?=\s+=\?`
  collapse pass; by the time the collapse runs the encoded-word markers
  are gone and orphan whitespace leaks (e.g. `Chơi Nga y Game` instead
  of `Chơi Ngay Game`). Real bug confirmed by Layer 1 diagnostic but
  separate decoder, separate symptom. Tracked as `it.skip()` placeholder
  in [`parser.test.ts`](../../lib/store-submissions/gmail/parser.test.ts)
  with a fix-pointer comment. Defer PR-18+.
- [ ] **PostgREST `.or()` regex runtime validation** — manual QA
  scenario per PR-14.5 plan; if rejected, hot-pivot to the RPC
  fallback documented in `backfill-corrupt-actions.ts`.

---

## PR-15 — Slug generator non-ASCII support ✅ SHIPPED 2026-05-01

PR-14's UTF-8 fix repaired 9+ production rows with garbled CJK app
names (彈彈英雄, 創世紀戰M：阿修羅計畫, etc.) so the Manager UI now
displays them correctly — but registering those apps in the App
Registry threw `InvalidSlugError: Cannot generate slug from "彈彈英雄":
no ASCII alphanumerics remain after normalization`. Slug generator
assumed Latin script + diacritic strip works for any language;
Vietnamese chars survive via NFD strip → ASCII (`đ/Đ` map manually),
but CJK chars produce empty normalized output. Manager blocked from
adding 12+ apps in the `UNCLASSIFIED_APP` bucket awaiting registry
add.

A hidden second bug surfaced during investigation: `創世紀戰M：阿修羅計畫`
did not throw — it generated slug `"m"` (single char from the lone
Latin "M" in the name). Passed `slugSchema` (min 1 char) but
semantically useless and collision-prone.

### Root cause

[`lib/store-submissions/apps/alias-logic.ts:generateSlugFromName`](../../lib/store-submissions/apps/alias-logic.ts)
(pre-fix):

```ts
const slug = deaccented
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  // ...trim + slice
if (slug === '') {
  throw new InvalidSlugError(name, 'no ASCII alphanumerics remain after normalization');
}
return slug;
```

The throw was the only failure mode for non-empty input; degenerate
short slugs (`"m"`, `"v"`) escaped through silently. CJK / emoji /
pure-punctuation names hit the throw and crashed `createAppAction`.

### Fix — Option E (hybrid)

Discarded alternatives:

- **Option A (romanization)**: pinyin-pro adds ~500KB+ to the bundle,
  Chinese-only, mappings ambiguous (彈 = tan / dan depending on
  context). Korean/Japanese would need separate libraries.
- **Option B (hash-only)**: would regress the readable Latin /
  Vietnamese slugs that already work for ~95% of apps.
- **Option C (Unicode slugs in DB)**: would require relaxing both the
  `slugSchema` regex and code paths that scan slugs textually
  (collision suffix `slug.like.${base}-%`, ticket-join `app_slug`
  display, etc.).
- **Option D (Manager always types slug)**: regresses the current
  one-click create flow for Latin-named apps; bulk CSV import has no
  Manager UI to type into.

[`generateSlugFromName`](../../lib/store-submissions/apps/alias-logic.ts)
now layers a deterministic hash fallback on top of the existing ASCII
normalizer:

```ts
export function generateSlugFromName(name: string): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new InvalidSlugError(name, 'input is empty or whitespace-only');
  }
  return tryGenerateAsciiSlug(name) ?? `app-${fnv1a32Hex(name)}`;
}
```

`tryGenerateAsciiSlug` returns `null` when the normalized output has
fewer than `SLUG_MIN_MEANINGFUL_LENGTH = 3` ASCII alphanumerics —
covering CJK, emoji, pure punctuation, lone combining marks, AND
1-2 char Latin abbreviations like `"VN"`. `fnv1a32Hex` is a pure-TS
FNV-1a 32-bit implementation chosen over Node `crypto.createHash`
deliberately: `alias-logic.ts` is imported by the AppDialog Client
Component for live slug preview, and a Node `crypto` import would
fail the Next.js client bundle (Webpack 5 doesn't auto-polyfill).
4B output space is more than sufficient for the ~200-app target
scope; the `apps.slug` UNIQUE constraint catches any collision and
the existing `suggestAvailableSlug` numeric-suffix loop resolves it.

### Sub-chunks shipped

| # | Commit | Scope |
|---|---|---|
| 15.1 | (no commit) | Investigation + design recommendation. Located slug generator + DB constraint + URL-route check (slug NOT in URLs — only DB UNIQUE column + display) + audit of all 4 call sites. Surface area justified Option E. |
| 15.2 | `e0e3922` | Hash fallback in `generateSlugFromName` + `tryGenerateAsciiSlug` helper extraction (returns `string \| null` for callers wanting `""` semantic instead of hash) + `safeSlugFromName` rewrite (TypesTable type-slug derive deliberately keeps `""` semantic — type slugs are short codes like `app`/`iae`/`ipa`, hash is meaningless there). +10 alias-logic tests + 2 helpers tests + 1 createAppAction integration test (replaced the obsolete "rejects on InvalidSlugError" test, which no longer reflects valid behavior). |
| 15.3 | `fb04521` | AppDialog slug override input field (create-mode only; edit-mode keeps "won't change on rename" helper) + `slugTouched` state with per-tick guard preventing useEffect → setForm infinite loop + contextual helper text (default / hash-fallback hint / red error) + `aria-invalid` + `aria-describedby` a11y + submit disabled on validation error. `slugSchema` extracted to standalone `lib/store-submissions/schemas/slug.ts` (only `zod` dep) so client bundle no longer pulls `re2-wasm` transitively via `validateAliasRegex` in `schemas/app.ts`; `app.ts` re-exports for unchanged server imports. Mode-aware `validateFormState(form, mode)` skips slug check in edit mode (slug is read-only on rename per UX contract). +7 app-dialog-logic tests. |
| 15.4 | this commit | Docs (this milestone section + features-table row + PR-timeline row + retag stale `PR-15+` deferral markers to `PR-16+` in CURRENT-STATE.md and TODO.md + new PR-15 entry in TODO.md). |

### Architecture decisions

- **FNV-1a 32-bit pure TS over Node `crypto.createHash` SHA-256.**
  `alias-logic.ts` is imported by `AppDialog.tsx` (Client Component)
  for the live slug preview. `import { createHash } from 'crypto'`
  fails the Next.js 14 client bundle — no auto-polyfill since
  Webpack 5. FNV-1a 32-bit gives 8 hex chars (matches the
  `app-<8 hex>` format), is purely synchronous (Web Crypto's
  `subtle.digest` is async, doesn't fit), pure-TS, and the 4B output
  space is more than enough for ~200 apps. Existing
  `suggestAvailableSlug` numeric-suffix loop handles any collision.

- **`tryGenerateAsciiSlug` helper extraction.** Two callers, two
  semantics: app-registry creation wants the hash fallback for
  unblocking; type-slug auto-derive in TypesTable wants `""` so the
  Manager types a meaningful short code (type slugs are `app`, `iae`,
  `ipa` — `app-3f8b2c1a` would be confusing). Same refactor pattern as
  PR-12.5 (`reclassify/core.ts`) and PR-14.4 (`backfill/core.ts`):
  shared core + diverging callers.

- **`slugSchema` module split.** Extracting to
  [`schemas/slug.ts`](../../lib/store-submissions/schemas/slug.ts)
  avoids pulling `re2-wasm` (transitive via `validateAliasRegex` used
  elsewhere in `schemas/app.ts`) into the client bundle when AppDialog
  validates the slug input. `schemas/app.ts` re-exports for unchanged
  server-side imports. Mirrors the `alias-logic.ts` ↔
  `alias-conflicts.ts` split that documented this exact trap in
  CLAUDE.md's lessons-learned section.

- **Mode-aware `validateFormState(form, mode)`.** Edit mode skips slug
  validation entirely — slug is read-only on rename per the existing
  "Current slug: X (won't change on rename)" UX contract. Even if the
  edit-mode FormState carried an invalid slug value (defensive), the
  Save button stays unblocked. Two consumers, two semantics.

- **Threshold `SLUG_MIN_MEANINGFUL_LENGTH = 3`.** Catches `"m"`-style
  degenerate single-char slugs and 1-2 char abbreviations (`"VN"`),
  while preserving 3-letter acronyms (`"TFT"`, `"VNG"`, `"LOL"`). 3 is
  the smallest round number that does both. Exported as a constant
  for future tuning visibility if Manager UAT signals the boundary
  feels wrong.

### Behavior matrix

| Input | Pre-PR-15 | Post-PR-15 |
|---|---|---|
| `Skyline Runners` | `skyline-runners` | unchanged |
| `Cá Sấu Đỏ` | `ca-sau-do` | unchanged |
| `TFT` | `tft` | unchanged (3-char threshold preserves) |
| `彈彈英雄` | **throws — Manager blocked** | `app-xxxxxxxx` ✓ |
| `創世紀戰M：阿修羅計畫` | `"m"` (degenerate, semantically useless) | `app-xxxxxxxx` ✓ (bonus fix) |
| `VN` | `vn` (2-char, allowed by old schema) | `app-xxxxxxxx` (below threshold, hash) |
| `🎮` | throws | `app-xxxxxxxx` |
| `!!!` / `???` | throws | `app-xxxxxxxx` |
| `""` / whitespace-only | throws | throws (unchanged — name is required) |

### Test + bundle deltas

- Tests: 1079 (pre-PR-15) → **1096** (+17 cumulative across 15.2 +13 +
  15.3 +7; one obsolete throw test deleted in 15.2 nets the count to
  +17 not +20).
- Bundle (`/store-submissions/config/apps`): +0.5 kB for the slug
  input field + `slugSchema` slim module. FNV-1a 32-bit adds zero
  bytes vs the SHA-256 alternative (no Node `crypto` polyfill needed).
- No migrations — PR-15 is application-layer only (slug generator
  logic + UI override + schema extract). No DB column change. All
  existing slugs remain unchanged; new apps post-deploy use the new
  logic.

### Backward compatibility

- All existing `apps.slug` rows untouched (no backfill, no
  regeneration, no DB migration).
- Latin / Vietnamese / French / Spanish / acronym auto-generation
  produces byte-identical slugs to pre-PR-15 behavior.
- `slugSchema` regex unchanged (`/^[a-z0-9]+(-[a-z0-9]+)*$/`); the
  `app-<8hex>` format passes the existing pattern, no relaxation
  needed.
- `createAppAction` already accepted optional `slug` parameter from
  PR-4; PR-15.3 just unhides the UI input. No Server Action signature
  change.

### Open follow-ups

- [ ] **Threshold tuning** — `SLUG_MIN_MEANINGFUL_LENGTH = 3`
  conservatively rejects 2-char abbreviations like `"VN"` even when
  the Manager would prefer them. If Manager UAT signals this feels
  wrong, the constant can be lowered to 2 (would re-admit `"vn"`,
  `"jp"`, etc.); the hash fallback would still catch CJK / emoji /
  pure-punctuation / single-char inputs. Wait for production signal
  before tuning.
- [ ] **CSV bulk-import slug override** —
  [`importAppsCsvAction`](../../app/(dashboard)/store-submissions/config/apps/actions.ts)
  derives slug from `name` only (no manual override path). With
  PR-15.2's hash fallback the action no longer fails on CJK names
  (previously would have produced `slugError` per row). If Managers
  want to pick readable slugs for bulk-imported CJK apps, add a
  `slug` column to the CSV template + parser. Defer until UAT
  surfaces the need.

---

## PR-15.5 — Stale-EMAIL filter post-reclassify ✅ SHIPPED 2026-05-01

Hotfix between PR-15 (slug generator) and PR-16 (auto-mark-done
design). Surfaced from production immediately after PR-15 unblocked
CJK app registration: Manager reclassified Play Together VNG email
out of TICKET-10000, but the email's original `EMAIL` ticket_entry
remained visible on TICKET-10000's detail panel + inbox card — the
same email rendered in two places.

### Root cause — intentional data divergence, missed UI filter

[`reclassify_email_tx`](../../supabase/migrations/20260425000002_store_mgmt_reclassify_rpc.sql)
explicitly preserves the old `EMAIL` ticket_entry as audit history
per CLAUDE.md invariant #2 (ticket_entries append-only, exception:
COMMENT.content):

```sql
-- (d) Detach: clear classification + ticket link on email_messages.
-- The ticket_id is set NULL up-front so find_or_create_ticket_tx
-- (called below for ticketable new statuses) sees a clean slate.
-- The previous ticket's EMAIL ticket_entries row is left in place
-- as audit history (event log is append-only, invariant #2).
```

The RPC then appends a `STATE_CHANGE 'reclassify_out'` annotation on
the old ticket, calls `find_or_create_ticket_tx` to attach the new
ticket (which inserts a fresh `EMAIL` entry there), and updates
`email_messages.ticket_id` to the new ticket. **Three writes; the
single-source-of-truth for "where does this email currently live" is
`email_messages.ticket_id`.**

The UI didn't honor that source of truth.
[`getTicketWithEntries`](../../lib/store-submissions/queries/tickets.ts)
and [`listTickets` firstEmail subquery](../../lib/store-submissions/queries/tickets.ts)
both queried `ticket_entries` by `ticket_id` only, so the stale
`EMAIL` row on TICKET-10000 surfaced as if it were still attached.

### Fix — UI-side filter using PostgREST embed

PostgREST embed `email_message:email_messages!email_message_id (ticket_id)`
pulls the email's current `ticket_id` alongside the entry data. JS
filter at read time hides `EMAIL` entries whose embedded current
`ticket_id` doesn't match the rendering ticket. Non-EMAIL entries
(STATE_CHANGE / COMMENT / PAYLOAD_ADDED) are unaffected — they're
tied to the ticket itself, not to a movable external attachment.

```ts
// getTicketWithEntries (detail panel timeline)
const visibleRawEntries = rawEntries.filter((e) => {
  if (e.entry_type !== 'EMAIL') return true;
  return (e.email_message?.ticket_id ?? null) === t.id;
});

// listTickets firstEmail subquery (inbox card preview)
for (const row of firstEmailsRes.data) {
  const currentTicketId = row.email_message?.ticket_id ?? null;
  if (currentTicketId !== row.ticket_id) continue; // skip stale BEFORE first-write-wins
  if (firstEmailByTicket.has(row.ticket_id)) continue;
  firstEmailByTicket.set(row.ticket_id, snap);
}
```

### Discarded alternatives

| Option | Why discarded |
|---|---|
| UPDATE/DELETE old EMAIL entry post-reclassify | Violates invariant #2; the RPC explicitly cites this in its own comment |
| New `superseded_by_ticket_id` column on ticket_entries | Schema change overkill; column UPDATE softens but doesn't escape the append-only intent |
| Visual marker on stale EMAIL entries (muted styling + "Reclassified to TICKET-X" banner) | Still shows duplicate content, just labeled — UX inferior to full hide |
| Auto-archive ticket on last-EMAIL-exit | Bigger scope (RPC + state machine); deferred PR-18+ as standalone follow-up |

### Test + bundle deltas

- Tests: 1096 (post-PR-15) → **1101** (+5: 3 detail-panel filter cases — current/stale/regression — plus 2 listTickets firstEmail filter cases)
- Bundle: zero — filter logic adds a few lines of JS, embed is a query string change
- No migration, no RPC change, no schema change, no backfill — filter operates at read time and applies retroactively to all existing stale entries

### Edge cases handled

- **DROPPED reclassify** (`email_messages.ticket_id = NULL`) → stale
  entry hidden on old ticket (NULL ≠ ticket id)
- **Reclassify back to original** (round-trip) → entry surfaces again
  on the original because `email_messages.ticket_id` matches it again
- **Reclassify chain A → B → C** → only C shows the entry; A and B
  both hide it
- **Email with no `email_message_id` at all** (defensive — shouldn't
  happen for EMAIL entries) → embed is null → filter hides it; no
  content to show anyway

### Open follow-ups (PR-18+)

- [ ] **Auto-archive ticket on last-EMAIL-exit** —
  [`reclassify_email_tx`](../../supabase/migrations/20260425000002_store_mgmt_reclassify_rpc.sql)
  could detect when the old ticket has zero current `EMAIL` entries
  remaining (post-reclassify) and atomically transition its `state`
  to `ARCHIVED` with `resolution_type='SYSTEM_RECLASSIFIED'`. Empty
  TICKET-10000 then disappears from the inbox listing instead of
  showing as a card with no email preview. RPC change required;
  state-machine semantics + backfill design discussion needed.
- [x] ~~**"Reclassified from TICKET-X" annotation on the destination ticket**~~
  — ✅ shipped PR-20 (commit `3470c28`): migration
  [`20260504000003_store_mgmt_reclassify_in_audit.sql`](../../supabase/migrations/20260504000003_store_mgmt_reclassify_in_audit.sql)
  adds a `STATE_CHANGE` entry with `metadata.type='reclassify_in'`
  and `from_ticket_id` on the destination ticket inside
  `reclassify_email_tx`. Renderer at
  [`TicketEntriesTimeline.tsx`](../../components/store-submissions/inbox/TicketEntriesTimeline.tsx)
  discriminates both directions and short-id-links the counterpart.
  Tests cover `reclassify_out`, `reclassify_in`, and legacy-null
  `to_ticket_id` fallback.
- [ ] **`entry_count` semantics review** — inbox card's `entry_count`
  counts ALL `ticket_entries` rows including STATE_CHANGE / COMMENT /
  PAYLOAD_ADDED. After this fix TICKET-10000 may show
  `entry_count: 5` (1 stale EMAIL + 4 STATE_CHANGE) but
  `first_email: null` — count and preview disagree. Either rename
  the count to "events" in the UI or filter it the same way EMAILs
  are filtered. Worth Manager UAT signal before deciding.

---

## PR-17 — Inbox UI/UX optimizations + Ticket detail polish ✅ SHIPPED 2026-05-03 / 2026-05-04

Manager workflow productivity wins. 2 sub-PRs + 1 hotfix shipped across
2 days. 3 commits cumulative, 0 migrations (UI + cursor + helper changes
only), 1121 → 1141 tests (+20 cumulative). Manager UAT MV1-MV6 verified
all-green, MV6 surfaced PR-17.2.5 hotfix via image evidence.

### Sub-PR breakdown

| Sub-PR | Commit | Scope |
|---|---|---|
| **PR-17.1** | `d1fc8f3` | Inbox UX optimizations (5 sub-chunks): date format util `lib/store-submissions/utils/format-date.ts` ABSOLUTE `dd/MM/yyyy HH:mm` cho list scanning + RELATIVE cho detail reading; Last update column (TicketListTable grid 7→8 cols); default sort flip `updated_at_desc` + sort-aware cursor keyset extension `DecodedCursor: { v, id, s }` với legacy `{opened_at, id}` graceful fallback; type filter scoped active platform với disabled state + tooltip hint when no platform + atomic `type_id` clear on platform change (Pattern 9 defense-in-depth); `buildSavePayload(draft)` helper extraction Pattern 9 defensive — pure mapper TS-typed, layer 12 omissions become compile errors instead of silent zod `.default(false)` coercion. Single commit cohesive bundle. Path A tests +16. |
| **PR-17.2** | `27ec2ce` | Ticket detail polish (2 sub-chunks): reverse entry order `getTicketWithEntries .order('created_at', { ascending: false })` Manager triage focus, index `(ticket_id, created_at DESC)` answers query directly zero perf cost; version list display `extractVersions` util pure helper sister-file pattern matching `format-date.ts` + inline `VersionsSection` trong `TicketDetailPanel` mockup-style chevron-separated chips với rose-accent latest + "← latest" suffix + silent omission khi empty + position between SubmissionIds + TypePayloads sections. Path A tests +6. |
| **PR-17.2.5** hotfix | `b9f8876` | extractVersions nested data shape — Manager UAT MV6 image evidence: VersionsSection omitted on a ticket type=app với version 4.4.0 (Apple, type_payloads has 1 entry). Root cause: helper read `p.version` (top-level) but production exclusively wrapped `p.payload.version` per RPC INSERT shape since PR-9. Fix: read `p.payload.version` (strict nested only — defensive both-shapes = parsing noise). Test fixtures rewritten production-realistic + 3 defensive tests cho nested edge cases. Path A tests +3. |

### Decisions locked (6)

1. **Date format scope**: list ABSOLUTE (`dd/MM/yyyy HH:mm`) / detail + timeline RELATIVE (`"5 min ago"` + hover ISO).
   *Reasoning*: scanning context = absolute precision (Manager triage needs exact recency); reading context = relative + hover affordance (timeline narrative flow).

2. **Type filter no-platform**: disabled + tooltip hint, atomic `type_id` clear on platform change.
   *Reasoning*: Pattern 9 defense-in-depth (UI guard + data-layer reset list); each type belongs to exactly one platform — stale `type_id` from prior platform would silently match zero rows.

3. **Legacy cursor URL**: graceful fallback assume `opened_at_desc`.
   *Reasoning*: backward URL safety, Manager bookmarks intact post-deploy. `{opened_at, id}` legacy shape decodes via `DecodedCursor: { v: opened_at, id, s: 'opened_at_desc' }`. Future PR-18+ cleanup remove fallback after deployment confirmation.

4. **Empty fallback override**: silent omission khi versions empty (post-deploy override of earlier "No versions tracked" placeholder consideration).
   *Reasoning*: secondary section position (between SubmissionIds + TypePayloads), TypePayloads section below exposes raw data nếu debugging, Manager-friendly không clutter.

5. **Helper extraction**: `extract-versions.ts` sister-file pattern matching `format-date.ts`.
   *Reasoning*: testable pure helper Path A coverage, matches PR-12.5 / PR-13.3 / PR-14.4 / PR-15.2 / PR-17.1.a precedent. Crystallizes Pattern 9 helper-extraction defensive architecture.

6. **Production nested data shape**: strict nested only (no legacy flat fallback).
   *Reasoning*: RPC = sole writer to `tickets.type_payloads` (verified migration `20260423000000`), exclusively wrapped `{ payload, first_seen_at }` since PR-9, defensive both-shapes = parsing noise. Decision earned by RPC-trace investigation, not hedged.

### Memory pattern reuse confirmations

**Pattern 9 — N-layer cascade audit (reuse #2, PR-17.2.5)**:

- Different bug class than PR-16a.5/PR-16b.5: not field-threading-omission but **test-infrastructure drift**.
- Helper `extractVersions` passed all unit tests (fixtures used flat `{ version }` shape), but production contract failed day 0 (stored shape exclusively wrapped `{ payload: { version } }` per RPC INSERT).
- Failure mode: engine test fixtures conflated với stored payload. Engine fixture is RPC *input*; stored shape is RPC *output* (RPC wraps với `payload` + `first_seen_at` keys).
- Fix discipline applied: traced data flow source-to-consumer (Sole writer = RPC INSERT trong migration `20260423000000`). No legacy fallback. Test fixtures rewritten production-realistic + 3 defensive tests.
- 13-point checklist evolution: add **Layer 0 — "trace data flow source-to-consumer; verify test fixture matches production storage shape, not just function input shape"**.
- Verified ROI cumulative: 2 hotfixes (PR-16a.5 + PR-17.2.5) crystallized checklist; first reuse PR-16b.5 = bug class avoided. Helper-extraction defensive pattern shipped PR-17.1.e (`buildSavePayload`).

**Pattern 10 — Domain assumption pivots (reuse #6, PR-17.2.5)**:

- Manager UAT image evidence drove investigation faster than text descriptions would have.
- Image showed VersionsSection omitted on a ticket Manager could see had version 4.4.0 trong TypePayloads — visual contradiction directly testable.
- Production data shape investigation override pattern: traced data flow to RPC INSERT (sole writer), confirmed no legacy flat shape exists, made strict-nested decision earned by data (not hedged với defensive both-shapes fallback).
- Cumulative 6 instances (PR-14, PR-15, PR-15.5, PR-16a, PR-16b.5, PR-17.2.5).
- Pattern proven through repeated cycles: Manager domain knowledge + image evidence + production data shape grounding > design hypothesis assumptions.

### Manager UAT verification matrix (MV1-MV6 all ✅)

| Scenario | Coverage | Status |
|---|---|---|
| **MV1** | Date format `dd/MM/yyyy HH:mm` trong inbox list | ✅ verified |
| **MV2** | Last update column functional + sort-aware | ✅ verified |
| **MV3** | Default sort `updated_at_desc` + cursor pagination intact (legacy URL fallback) | ✅ verified |
| **MV4** | Type filter scoped active platform với disabled state + tooltip + atomic clear | ✅ verified |
| **MV5** | Reverse entry order trong ticket detail (newest top — Manager triage) | ✅ verified |
| **MV6** | Version list display (1-version visible + multi-version chevron chips) | ✅ verified post-PR-17.2.5 |

### Production state post-PR-17

- All PR-17 features shipped + Manager UAT verified
- Inbox UX optimizations operational:
  * Date format `dd/MM/yyyy HH:mm` (list scanning context)
  * Last update column (8-col grid)
  * Default sort `updated_at_desc` với sort-aware cursor keyset extension
  * Type filter scoped active platform với disabled-state guard
  * `buildSavePayload` helper extracted (Pattern 9 defensive crystallized)
- Ticket detail polish operational:
  * Reverse entry order (newest top)
  * Version list display chevron-separated chips
  * Latest version rose accent + "← latest" suffix
  * Silent omission cho 0 versions (Apple proven, non-Apple graceful)
- Production data shape verified:
  * `tickets.type_payloads` exclusively nested wrapper `{ payload, first_seen_at }`
  * RPC = sole writer (migration `20260423000000`)
  * No legacy flat shape exists in DB
- Cron sync running clean
- 0 PR-17 migrations applied (UI + cursor + helper changes only)

### Stale tag retag note

PR-17+ → PR-18+ retag complete across `CURRENT-STATE.md` + `TODO.md` + `inbox-state-outcome-dimensions.md` (~40 sites total). Verify post-retag: `grep -rn "PR-17+" docs/ TODO.md` returns 0 results (PR-17 milestone section references = current-state, not backlog tag).

### PR-18+ candidates (refreshed)

| # | Item | Effort | Source |
|---|---|---|---|
| 1 | Layer 1 RFC 2047 subject continuation-line decode | ~2h | PR-14 deferral |
| 2 | Path C DB integration test infrastructure | ~3-4h | PR-16a.4 caveat + PR-17.2.5 reinforced |
| 3 | Multi-platform extractor expansion (Google) | ~2-3 days | PR-11/PR-12 |
| 4 | Auto-archive empty unclassified tickets | ~1h | PR-15.5 |
| 5 | Reclassify destination annotation `'reclassify_in'` | ~30min | PR-15.5 |
| 6 | `entry_count` semantics review | UAT-driven | PR-15.5 |
| 7 | Threshold tuning `SLUG_MIN_MEANINGFUL_LENGTH` | UAT-driven | PR-15 |
| 8 | CSV bulk-import slug override | UAT-driven | PR-15 |
| 9 | Q1.E + Q8 telemetry capture | data-dependent | PR-16 |
| 10 | Q2.B reopen affordance verification | ~30min | PR-16 |
| 11 | Migration COMMENT refresh | cosmetic | PR-12 |
| 12 | Sentry breadcrumb cap formalization | infra | PR-12 |
| 13 | Vitest cold-start flake investigation | infra | PR-12 |
| 14 | Gmail OAuth token resilience (service account) | infra | PR-12 |
| 15 | Per-row backfill affordance EmailEntryCard | ~30min | PR-12 |
| 16 | Spec §5.2 ticket-level merge | scope-dep | PR-11 |

Note: `buildSavePayload(draft)` helper extraction REMOVED from backlog — shipped PR-17.1.e.

---

## PR-16 — Auto-mark-done + auto-completed banner + auto-reopen Manager opt-in ✅ SHIPPED 2026-05-02 / 2026-05-03

Largest milestone yet: 4 sub-PRs + 1 hotfix shipped across 2 days.
8 commits cumulative, 8 migrations applied production sequential,
1116 → 1121 tests (+5 Path A; cumulative +20 from PR-15.5 baseline
1101). Manager UAT Phase 1 verified 2026-05-02 (PR-16a + PR-16a.5)
and 2026-05-03 (PR-16b.5). Phase 2-4 deferred chờ data accumulation
+ live Apple email + long-term telemetry.

### Sub-PR breakdown

| Sub-PR | Commits | Scope |
|---|---|---|
| **PR-16a** | `6ffe7b0` (foundation+UI), `c231594` (RPC auto-DONE), `cc8389d` (tests + caveat docs) | Auto-DONE foundation: Manager opt-in toggle (`auto_done_eligible`), `find_or_create_ticket_tx` auto-DONE branch, audit metadata via `ticket_entries.metadata.{actor,reason,subject_pattern_id}`, Settings UI emerald toggle với UX guard, 8 Path A tests |
| **PR-16a.5** | `2d5f171` | handleSave payload threading hotfix — Manager UAT Scenario 2 surfaced 7-layer cascade gap (Layer 9 intermediate payload). N-layer cascade audit memory crystallized post-fix |
| **PR-16b** | `6b820e9` (banner + view), `32c8cbe` (auto-reopen RPC + tests) | Auto-completed visibility surface: `count_auto_completed_tickets()` + `list_auto_completed_tickets()` RPCs, MANAGER-only Inbox blue/info banner Q1.E (auto-hides at zero), dedicated `/auto-completed` view với MANAGER soft redirect + friendly empty state, auto-reopen pre-LOOP branch trong find_or_create_ticket_tx Q2.D + Q3.B (DONE → IN_REVIEW on REJECTED), 7 Path A tests |
| **PR-16b.5** | `b455fa9` (foundation + UI), `3aa093b` (RPC eligibility + tests) | Auto-reopen Manager opt-in toggle — Manager domain insight surfaced post-deploy: Apple's REJECTED workflow per-build (different submission_id), không cùng build APPROVED trước. "Build mới = ticket mới" semantic. Path D opt-in flag (`auto_reopen_eligible` default FALSE) preserves correct semantic. RPC eligibility gate two-phase short-circuit (cheap gate trước expensive EXISTS). Layer 9 cascade audit applied successfully (PR-16a.5 lesson reuse). 5 Path A tests |

### Design decisions Q1-Q8 — final ship status

Reference [`pr-16-auto-mark-done-design.md`](./pr-16-auto-mark-done-design.md) cho full discussion.

| Q | Decision | Status |
|---|---|---|
| Q1 (Visibility) | Q1.E inbox banner | ✅ shipped PR-16b |
| Q2 (Override) | Q2.B manual reopen + Q2.D auto-reopen on REJECTED | ✅ shipped PR-16b (gated PR-16b.5 Manager opt-in) |
| Q3 (Post-DONE REJECTED) | Q3.B auto-reopen IN_REVIEW | ✅ shipped PR-16b (gated PR-16b.5) |
| Q4 (Audit) | Q4.A reserved system identity + Q4.C reason field | ✅ shipped PR-16a (overrides applied — see below) |
| Q5 (Confidence) | Q5.A subject patterns single source + Q5.D Manager opt-in per pattern | ✅ shipped PR-16a |
| Q6 (App registry timing) | Q6.A CLASSIFIED only + Q6.B retroactive on reclassify | ✅ shipped PR-16a (free inheritance via reclassify_email_tx) |
| Q7 (Notifications) | Q7.A banner only initially | ✅ shipped (telemetry deferred PR-18+ pending UAT) |
| Q8 (Approved tab fate) | Q8.D defer telemetry-informed | ⏸ PR-18+ candidate (1-2 months data) |

### Design overrides earned by codebase grounding + Manager domain insight

5 overrides applied during investigation + post-deploy:

1. **Q4.C reason field → `metadata.reason` JSONB instead of new column.** Original design proposed `ALTER TABLE ticket_state_changes ADD COLUMN reason`. Codebase grounding revealed `ticket_state_changes` table không exist; state changes tracked via `ticket_entries` với `entry_type='STATE_CHANGE'` + JSONB metadata. Existing convention (`reclassify_email_tx`, `find_or_create_ticket_tx`) puts structured fields trong metadata. Override: use `metadata.reason` directly — no schema change for this piece.

2. **Q4.A SYSTEM_USER_ID → NULL + `metadata.actor='system'`.** Original design proposed reserved UUID + INSERT system user row. FK constraint `author_user_id REFERENCES users(id)` + `users.role` CHECK (`MANAGER/DEV/VIEWER` only) would require 3 cascade changes. Existing `find_or_create_ticket_tx` already passes `author_user_id = NULL` cho email-driven STATE_CHANGE entries (encodes "system" via `metadata.trigger='email'`). Override: keep NULL, encode actor via `metadata.actor='system'` — pattern reuse, smaller surface.

3. **`subject_pattern_id` top-level on `ClassifiedResult`.** Original design left pattern_id buried trong `matched_rules[].details.pattern_id` JSONB. RPC needs it for `auto_done_eligible` lookup. Override: add `subject_pattern_id: string | null` field at top level — clean type-safe access, classifier change minimal.

4. **STATE_CHANGE entry on auto-DONE create (special case).** Existing pattern skips STATE_CHANGE on create. Auto-DONE creates need audit completeness — Manager opens auto-DONE ticket detail → expects to see "this ticket auto-DONEd at creation với reason X" trong timeline. Override: special-case `IF v_state_changed OR (v_created AND v_auto_done)` writes STATE_CHANGE entry với `from=NULL, to='DONE', reason='auto_mark_done_initial', actor='system'`.

5. **(POST-DEPLOY) Auto-reopen Manager opt-in toggle (PR-16b.5).** Manager domain insight surfaced after PR-16b.3 shipped: Apple's REJECTED workflow is per-build (different `submission_id`), không cùng build APPROVED trước. "Build mới = ticket mới" semantic. PR-16b.3 auto-reopen-always merged distinct builds into one ticket — semantically wrong. Override: Path D opt-in flag (`auto_reopen_eligible` default FALSE) preserves correct semantic. Code preserved cho future Apple workflow flexibility (toggle vs hard-coded).

### Schema changes summary

**3 column additions** (sequential migrations applied):

- `subject_patterns.auto_done_eligible BOOLEAN NOT NULL DEFAULT FALSE` — PR-16a.1 migration `20260502000000`
- `subject_patterns.auto_reopen_eligible BOOLEAN NOT NULL DEFAULT FALSE` — PR-16b.5.1 migration `20260504000000`
- `ticket_entries.metadata.{actor,reason,subject_pattern_id}` — JSONB convention, no schema change (Q4.C override)

**8 RPC migrations** applied production sequential:

| Order | Migration | Purpose |
|---|---|---|
| 1 | `20260502000000` | `subject_patterns.auto_done_eligible` column add |
| 2 | `20260502000001` | `build_rules_snapshot` + `save_rules_tx` + `rollback_rules_tx` thread `auto_done_eligible` |
| 3 | `20260502000002` | `find_or_create_ticket_tx` auto-DONE branch (PR-16a.2) |
| 4 | `20260503000000` | `count_auto_completed_tickets()` + `list_auto_completed_tickets()` RPCs |
| 5 | `20260503000001` | `find_or_create_ticket_tx` auto-reopen branch (PR-16b.3 — superseded by 8) |
| 6 | `20260504000000` | `subject_patterns.auto_reopen_eligible` column add |
| 7 | `20260504000001` | rules RPCs CREATE OR REPLACE thread `auto_reopen_eligible` |
| 8 | `20260504000002` | `find_or_create_ticket_tx` eligibility gate (supersedes 5; two-phase short-circuit) |

### Manager UAT verification matrix

**Phase 1 — Settings UI + persistence** (✅ verified 2026-05-02 / 05-03):

| Scenario | Coverage | Status |
|---|---|---|
| Scenario 1 (PR-16a) | Settings UI Auto-DONE toggle visible với emerald accent + UX guard | ✅ |
| Scenario 2 (PR-16a → 16a.5 hotfix) | Auto-DONE toggle persists save (post-hotfix) | ✅ |
| Scenario X (PR-16b.5) | Auto-Reopen toggle UI 7th column + amber accent + ⚠️ tooltip + UX guard | ✅ |
| Scenario Y (PR-16b.5) | Auto-Reopen toggle persists save (Layer 9 cascade audit verified) | ✅ |
| Scenario Z (PR-16b.5) | Default FALSE preserves "build mới = ticket mới" semantic | ✅ passive |

**Phase 2 — Banner + visibility** (⏸ data-dependent):

- Scenario A (banner visibility when count>0)
- Scenario B (empty state when count=0)
- Scenario D (manual reopen Q2.B UI inspection)
- Scenario E (role gates VIEWER/DEV redirect)

**Phase 3 — Real Apple email** (⏸ chờ live emails):

- Scenarios 3-6 (PR-16a live auto-DONE + audit trail + control + reclassify Q6.B)
- Scenario C (PR-16b auto-reopen real REJECTED post-DONE)
- Scenario W (PR-16b.5 auto-reopen với toggle ON — niche usage)

**Phase 4 — Long-term telemetry** (⏸ 1-2 months data):

- Q8 Approved tab fate decision (telemetry-informed)
- Q1.E + Q8 telemetry capture (PR-18+ candidate)
- Auto-DONE accuracy rate
- Auto-reopen Manager opt-in adoption rate

### Production state post-PR-16

- Cron sync running clean (gmail_msg_id UNIQUE idempotent)
- Auto-DONE foundation deployed + persistence verified post-hotfix
- Banner + dedicated `/auto-completed` view operational (visibility surface)
- Auto-reopen Manager opt-in functional với default FALSE preserves Apple workflow semantic
- 8 migrations applied sequential successfully
- All Phase 1 scenarios verified

### PR-18+ candidates from PR-16

- **Q1.E + Q8 telemetry capture** — banner click frequency, time-series, state=APPROVED count cho Q8 decision criteria
- **Path C DB integration test infrastructure** (~3-4h scope) — covers SQL behavior gaps trong Path A coverage (auto-DONE branch logic, eligibility gate, idempotency edge case)
- **Q2.B reopen affordance verification** — Manual QA Scenario D pending; if absent, add per-ticket reopen button to TicketDetailPanel
- ~~**`buildSavePayload(draft)` helper extraction**~~ — ✅ shipped PR-17.1.e (Pattern 9 defensive crystallized)

### Stale tag retag note

Superseded by PR-17c retag (PR-17+ → PR-18+) — see PR-17 milestone section above for the current authoritative retag note. Original PR-16c retag (PR-16+ → PR-17+) was rolled forward.

---

## Critical invariants (reference)

Đầy đủ trong `CLAUDE.md`. Highlights:

1. One open ticket per `(app_id, type_id, platform_id)` — enforced by partial unique index excluding terminal states
2. `ticket_entries` append-only (except COMMENT edit)
3. EMAIL entries must carry `metadata.email_snapshot` với subject/sender/received_at/body_excerpt (500 chars)
4. User-provided regex ONLY via `re2-wasm` (never V8)
5. Gmail tokens AES-256-GCM encrypted (`GMAIL_ENCRYPTION_KEY` — never rotate in prod)
6. Terminal state ↔ `closed_at IS NOT NULL` ↔ `resolution_type IS NOT NULL` (CHECK constraint)
7. Forward-only migrations
8. Classification → ticket mapping: DROPPED/ERROR = no ticket; CLASSIFIED + UNCLASSIFIED_APP + UNCLASSIFIED_TYPE = ticket
9. Schema isolation: all Store Management objects in `store_mgmt.*` schema

---

## Env vars (store-submissions specific)

```env
CRON_SECRET=              # X-Cron-Secret header matching
GMAIL_ENCRYPTION_KEY=     # openssl rand -hex 32 — NEVER rotate in prod
SENTRY_DSN=               # optional dev, required prod
INITIAL_MANAGER_EMAIL=    # first MANAGER role trong store_mgmt.users
```

---

## Known quirks (already hit)

1. **MIME parser null-byte sanitization** — Postgres INSERT rejects `\0` in TEXT columns. Parser strips null bytes before persist (PR-7 incident).
2. **NO_SUBJECT_MATCH reclassification** — Emails matching sender but no subject pattern are DROPPED (intentional ignore), not ERROR. Reclassified in migration `20260422000000_store_mgmt_reclassify_no_subject_match.sql` (PR-7).
3. **Sender resolver — 2 independent queries** — Single embedded-select query had ambiguity với multi-platform senders. Split into sender lookup + platform assignment (PR-6).
4. **Email Rule Engine — submission_id extraction** — Uses RE2 regex from `submission_id_patterns` table. V8 regex explicitly forbidden (ReDoS prevention).
5. **Cron advisory lock** — Single `runSync` instance per deploy. Postgres advisory lock key = hash of cron name. Prevents overlap on slow syncs.
6. **App Registry — platform binding required at create (fix 2026-04-23)** — App Creator dialog (`components/store-submissions/apps/AppDialog.tsx`) was filtering bindings by `platform_ref !== ''`; creating an app with all ref fields blank produced zero `app_platform_bindings` rows. Classifier's `loadAppsForPlatform` gates visibility on `(platform_id, app_id)` presence (not on `platform_ref`), so those apps stayed invisible to the pipeline and their emails classified as `UNCLASSIFIED_APP`. Fix: checkbox gate in the dialog + submit validation ≥1 platform. UI-only change — classifier, `create_app_tx` RPC, and schema were already correct. Audit badge `"No platforms"` on `/config/apps` list surfaces any historical unbound rows.

---

## Doc reading order (for new sessions)

1. This file — current state + PR timeline
2. `CLAUDE.md` (repo root) — invariants + conventions
3. `docs/store-submissions/00-business-analysis.md` — WHY
4. `docs/store-submissions/00-architecture-overview.md` — HOW high-level
5. `docs/store-submissions/01-data-model.md` — schema SQL
6. Deep-dive matching current work:
   - Gmail sync → `02-gmail-sync.md`
   - Classifier → `03-email-rule-engine.md`
   - Ticket engine → `04-ticket-engine.md` (see banner re: Prisma→Supabase adaptation)
   - API/UI → `05-api-frontend.md`
   - Deploy → `06-deployment.md`
