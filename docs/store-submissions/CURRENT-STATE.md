# Store Management — Trạng thái hiện tại

> **Đọc đầu tiên** khi bắt đầu session mới về module Store Management. Ghi lại trạng thái production + PR đã ship + known limitations chưa resolve.
>
> Last updated: 2026-04-25 (PR-11 shipped — Apple HTML extractor + classifier upgrade + Manager reclassify feature)

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
| Apple HTML payload extractor (PR-11) | auto-runs in sync pipeline | `lib/store-submissions/gmail/html-extractor.ts` (uses `node-html-parser`) |
| Two-tier type matching — extracted_payload Priority 1, body keyword Priority 2 | classifier Step 4 | `lib/store-submissions/classifier/type-matcher.ts` |
| Manager reclassify (single email + bulk Unclassified) | Inbox detail panel + Unclassified banner | `app/(dashboard)/store-submissions/inbox/reclassify-actions.ts` + migration `20260425000002_...reclassify_rpc.sql` |

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

### 3-state `extracted_payload` semantic

| Value | Meaning | Producer |
|---|---|---|
| NULL | Extraction not attempted | Non-Apple platform; parse-error path; NO_SENDER_MATCH path |
| `{ accepted_items: [] }` | Attempted, no items found | Apple sender + email has no "Accepted items" section (rejection notice, marketing, status digest) |
| `{ accepted_items: [...] }` | Apple email with structured types | Apple sender + matched 1+ headings |

Reclassify uses this distinction: legacy rows + non-Apple stay NULL, Apple
rows always carry a non-null payload (even when empty). The bulk
reclassify can identify legacy vs new rows via `IS NULL` vs `IS NOT NULL`.

### Sentry tag taxonomy (extended)

| `component` | Subcontext |
|---|---|
| `html-extractor` | `gmail_msg_id: <Gmail message id>` (UNKNOWN heading variants) |
| `reclassify-actions` | `action: 'bulk-fetch' \| 'bulk-row'` + `emailMessageId` / `bucket` |

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
