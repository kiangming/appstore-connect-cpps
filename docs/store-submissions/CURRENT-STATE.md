# Store Management — Trạng thái hiện tại

> **Đọc đầu tiên** khi bắt đầu session mới về module Store Management. Ghi lại trạng thái production + PR đã ship + known limitations chưa resolve.
>
> Last updated: 2026-04-23 (PR-9 shipped)

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
| PR-10 | Inbox UI + ticket detail view | ⏳ next |

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
- [ ] Audit `TicketEngineRaceError` + `TicketEngineNotFoundError` via Sentry once `SENTRY_DSN` is wired (PR-7 polish item — separate track)

---

## PR-10 — Inbox UI (next)

### Scope preview

- Ticket list page với filters (state, app, platform, assigned_to, priority, date range)
- Primary state buckets: `NEW` / `IN_REVIEW` / `REJECTED` / terminal (`APPROVED` + `DONE` + `ARCHIVED`)
- Unclassified buckets as dedicated views (manager action: reclassify → merge into proper grouping key, spec §5.2)
- Ticket detail modal với `ticket_entries` timeline (EMAIL snapshots + STATE_CHANGE + COMMENT + PAYLOAD_ADDED)
- User action primitives (separate from PR-9 scope): archive / follow-up / mark-done / assign / priority / comment / reject-reason — each routes through a user-action RPC (deferred from 04-ticket-engine.md §2.2 until PR-10 ships UI)
- First consumer of PR-9 extended output fields (`previous_state`, `state_changed`, full `ticket` row)

### Blockers / dependencies

- PR-9 RPC is the sole write path for email-driven transitions — PR-10 user-action handlers are a separate RPC surface (PL/pgSQL functions for `archive_ticket_tx`, `follow_up_ticket_tx`, etc. per spec §2.2)
- Requires ticket_entries render query (spec §6.3) — server action or API route
- Requires authorization matrix (spec §7.2) — manager vs member vs observer gates

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
