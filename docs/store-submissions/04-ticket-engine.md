# Tech Design Deep-Dive — Ticket Engine

**Scope:** Component [C] — transactional find-or-create ticket, state machine execution, event log, user actions
**Prerequisite:** Data Model (01), Gmail Sync (02), Email Rule Engine (03)

---

> **Implementation Note (2026-04-23)**: Spec uses Prisma-flavored syntax (`db.$transaction`, `tx.$queryRaw`) for illustration. Actual implementation uses Supabase JS + a PL/pgSQL RPC `find_or_create_ticket_tx` shipping in PR-9. Semantic intent (transaction boundary, `FOR UPDATE` lock, partial unique index as race fallback) preserved; syntax adapted. When reading code examples below, treat them as pseudocode describing the intent — the RPC is the canonical implementation.

---

## 0. Implementation status (read first)

This document specifies the full Ticket Engine — email handling with `FOR UPDATE` locks, state machine, event log, user actions, app rename. **As of PR-8, most of it is not yet implemented.** What ships in each PR:

### PR-8 (shipped) — wire + stub engine

- `lib/store-submissions/tickets/wire.ts` — `associateEmailWithTicket(emailMessageId, classification)`
- `lib/store-submissions/tickets/engine-stub.ts` — `findOrCreateTicket(input)` returning ephemeral `randomUUID()`
- `lib/store-submissions/tickets/types.ts` — `FindOrCreateTicketInput`, `FindOrCreateTicketOutput`, `TicketableClassification`, `isTicketableClassification`
- `gmail/sync.ts` integration: post-INSERT wire call with defensive try/catch

**What the stub does not do:**
- No DB writes (no `tickets` row, no `ticket_entries` row)
- No dedup (every call returns a fresh UUID, even for the same grouping key)
- No state machine, no `FOR UPDATE` lock, no event log, no transaction boundary

**Why stub first:** decouples wire-path verification from engine-logic complexity. Isolates failure modes per PR (wire bugs in PR-8, engine bugs in PR-9). Unblocks PR-10 Inbox UI development against mock ticket data before the real engine ships.

### PR-9 (planned) — real engine

`engine-stub.ts` → `engine.ts` drop-in replacement, same `findOrCreateTicket` signature. Scope (tracked in `TODO.md` under `## PR-9`):

- §3.1 Transactional `handleClassifiedEmail` orchestration
- §3.2 `findOpenTicketForKey` with `FOR UPDATE` lock
- §3.3–3.4 Create + update flows, `submission_id` dedup + append
- §4.1 State derivation from email (`NEW → IN_REVIEW → REJECTED → APPROVED`)
- §6 `ticket_entries` append-only event log + EMAIL snapshot writes
- §5.2 Grouping-key conflict handling when unclassified → classified

### PR-10+ (later)

§7 user actions, §8 app rename, §9 full error hierarchy.

### Stability contract

The types exported from `tickets/types.ts` in PR-8 are the **interface boundary** with the wire layer and with any future caller (e.g. batch re-classification in PR-10). PR-9 may **extend** `FindOrCreateTicketOutput` with fields from §2.1 `TicketHandleResult` (`ticket` row, `previous_state`, `state_changed`), but must not rename or remove existing fields. Callers treat unknown new fields as optional.

Sections §1–§13 below describe the PR-9 target design. Until PR-9 lands, the "Ticket Engine" in code means the stub; read with that caveat.

---

## 1. Overview & responsibilities

Ticket Engine cầm 3 trách nhiệm:

1. **Email handling** — nhận `ClassificationResult` từ Email Rule Engine, tạo/update ticket theo grouping key + state machine
2. **User actions** — apply action từ UI (Archive, Follow Up, Done, Assign, Priority, Comment, Add Reject Reason)
3. **App rename** — atomic transaction chuyển auto alias current → historical

Tất cả operations là **strict transactional**. Bất kỳ fail (constraint violation, regex timeout, DB error) → rollback toàn bộ.

```
┌──────────────────────────────────────────────────────────┐
│                  Ticket Engine                            │
│                                                           │
│  Email flow:                                              │
│  ClassifiedResult → find-or-create (FOR UPDATE)           │
│                   → derive state                          │
│                   → update + insert entries               │
│                                                           │
│  User action flow:                                        │
│  UserCommand → load ticket                                │
│              → authorize (role check)                     │
│              → derive state                               │
│              → update + insert entry                      │
│                                                           │
│  App rename flow:                                         │
│  AppRename → demote AUTO_CURRENT alias                    │
│            → update app name                              │
│            → insert new AUTO_CURRENT alias                │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Contract

### 2.1. Email handling

```typescript
export async function handleClassifiedEmail(
  emailRow: EmailMessage,
  classification: ClassifiedResult | UnclassifiedAppResult | UnclassifiedTypeResult
): Promise<TicketHandleResult>

type TicketHandleResult = {
  ticket: Ticket;
  created: boolean;       // true nếu tạo mới, false nếu gom vào existing
  state_changed: boolean; // true nếu state transition
  previous_state: TicketState | null;
  new_state: TicketState;
};
```

### 2.2. User actions

```typescript
export async function executeUserAction(
  ticketId: UUID,
  action: UserAction,
  actor: SessionUser
): Promise<TicketHandleResult>

type UserAction =
  | { type: 'ARCHIVE' }
  | { type: 'FOLLOW_UP' }
  | { type: 'MARK_DONE' }
  | { type: 'UNARCHIVE' }                                    // chỉ trong 10s undo window
  | { type: 'ASSIGN'; user_id: UUID | null }                 // null = unassign
  | { type: 'SET_PRIORITY'; priority: 'LOW' | 'NORMAL' | 'HIGH' }
  | { type: 'SET_DUE_DATE'; due_date: Date | null }
  | { type: 'ADD_COMMENT'; content: string; attachments?: AttachmentRef[] }
  | { type: 'EDIT_COMMENT'; entry_id: UUID; content: string } // chỉ author được edit
  | { type: 'ADD_REJECT_REASON'; content: string; attachments?: AttachmentRef[] };
```

### 2.3. App rename

```typescript
export async function renameApp(
  appId: UUID,
  newName: string,
  actor: SessionUser
): Promise<{ app: App; aliases_affected: number }>
```

---

## 3. Email handling — transactional flow

### 3.1. Main function

```typescript
// lib/ticket-engine/handle-email.ts
export async function handleClassifiedEmail(
  emailRow: EmailMessage,
  classification: ClassifiedResult | UnclassifiedAppResult | UnclassifiedTypeResult
): Promise<TicketHandleResult> {

  return await db.$transaction(async (tx) => {
    // 1. Find existing open ticket với FOR UPDATE lock
    const existing = await findOpenTicketForKey(tx, {
      app_id: classification.status === 'CLASSIFIED' || classification.status === 'UNCLASSIFIED_TYPE'
        ? classification.app_id
        : null,
      type_id: classification.status === 'CLASSIFIED'
        ? classification.type_id
        : null,
      platform_id: classification.platform_id,
    });

    if (existing) {
      return await updateTicketWithEmail(tx, existing, emailRow, classification);
    } else {
      return await createTicketFromEmail(tx, emailRow, classification);
    }
  }, {
    isolationLevel: 'ReadCommitted',
    timeout: 10_000, // 10s max per email transaction
  });
}
```

### 3.2. Find existing open ticket (FOR UPDATE)

```typescript
async function findOpenTicketForKey(
  tx: Transaction,
  key: { app_id: UUID | null; type_id: UUID | null; platform_id: UUID }
): Promise<Ticket | null> {
  // Dùng raw SQL cho FOR UPDATE (Prisma doesn't natively expose)
  const rows = await tx.$queryRaw<Ticket[]>`
    SELECT * FROM tickets
    WHERE 
      ${key.app_id === null
        ? sql`app_id IS NULL`
        : sql`app_id = ${key.app_id}`}
      AND ${key.type_id === null
        ? sql`type_id IS NULL`
        : sql`type_id = ${key.type_id}`}
      AND platform_id = ${key.platform_id}
      AND state IN ('NEW', 'IN_REVIEW', 'REJECTED')
    ORDER BY opened_at DESC
    LIMIT 1
    FOR UPDATE;
  `;
  return rows[0] ?? null;
}
```

**FOR UPDATE semantics**: lock row trong transaction. Nếu 2 concurrent transaction cùng tìm ticket cho key đó:
- TX1 acquires lock, continues
- TX2 waits (blocking)
- TX1 commits, releases lock
- TX2 proceeds with updated snapshot (sees TX1's changes)

Kết hợp với partial unique index `idx_tickets_open_unique`, invariant được enforce ở 2 tầng: lock ngăn concurrent write race, unique index catch race đã slip qua (vd advisory lock fail).

### 3.3. Create new ticket

```typescript
async function createTicketFromEmail(
  tx: Transaction,
  emailRow: EmailMessage,
  classification: ClassificationResult
): Promise<TicketHandleResult> {

  const now = new Date();
  const isUnclassified = classification.status !== 'CLASSIFIED';

  // Build type_payloads array
  const initialPayloads = (classification.status === 'CLASSIFIED' && classification.type_payload)
    ? [{ payload: classification.type_payload, first_seen_at: now.toISOString() }]
    : [];

  // Build submission_ids
  const initialSubIds = (classification.status === 'CLASSIFIED' && classification.submission_id)
    ? [classification.submission_id]
    : [];

  const latestOutcome = 'outcome' in classification ? classification.outcome : null;

  const ticket = await tx.tickets.create({
    data: {
      app_id: 'app_id' in classification ? classification.app_id : null,
      type_id: classification.status === 'CLASSIFIED' ? classification.type_id : null,
      platform_id: classification.platform_id,
      state: 'NEW',
      latest_outcome: latestOutcome,
      type_payloads: initialPayloads,
      submission_ids: initialSubIds,
      priority: 'NORMAL',
      opened_at: now,
    },
  });

  // EMAIL entry với snapshot
  await tx.ticket_entries.create({
    data: {
      ticket_id: ticket.id,
      entry_type: 'EMAIL',
      author_user_id: null,
      email_message_id: emailRow.id,
      metadata: {
        email_snapshot: {
          subject: emailRow.subject,
          sender: emailRow.sender_email,
          sender_name: emailRow.sender_name,
          received_at: emailRow.received_at.toISOString(),
          body_excerpt: truncate(emailRow.raw_body_text ?? '', 500),
        },
        outcome: latestOutcome,
        classification_status: classification.status,
      },
    },
  });

  return {
    ticket,
    created: true,
    state_changed: false,
    previous_state: null,
    new_state: 'NEW',
  };
}
```

### 3.4. Update existing ticket

```typescript
async function updateTicketWithEmail(
  tx: Transaction,
  existing: Ticket,
  emailRow: EmailMessage,
  classification: ClassificationResult
): Promise<TicketHandleResult> {

  const now = new Date();
  const emailOutcome = 'outcome' in classification ? classification.outcome : null;

  // Derive new state
  const newState = deriveStateFromEmailOnOpenTicket(
    existing.state as OpenState,
    emailOutcome
  );
  const stateChanged = newState !== existing.state;

  // Append payload if distinct
  const newPayload = classification.status === 'CLASSIFIED' ? classification.type_payload : null;
  const payloadAdded = newPayload && !payloadExists(existing.type_payloads, newPayload);

  const newPayloads = payloadAdded
    ? [
        ...existing.type_payloads,
        { payload: newPayload, first_seen_at: now.toISOString() },
      ]
    : existing.type_payloads;

  // Append submission_id if distinct
  const newSubId = classification.status === 'CLASSIFIED' ? classification.submission_id : null;
  const subIdAdded = newSubId && !existing.submission_ids.includes(newSubId);
  const newSubIds = subIdAdded
    ? [...existing.submission_ids, newSubId]
    : existing.submission_ids;

  // Terminal state fields
  const terminalFields = newState === 'APPROVED'
    ? { closed_at: now, resolution_type: 'APPROVED' as const }
    : {};

  // Update ticket row
  const updated = await tx.tickets.update({
    where: { id: existing.id },
    data: {
      state: newState,
      latest_outcome: emailOutcome,
      type_payloads: newPayloads,
      submission_ids: newSubIds,
      ...terminalFields,
    },
  });

  // Insert EMAIL entry
  await tx.ticket_entries.create({
    data: {
      ticket_id: existing.id,
      entry_type: 'EMAIL',
      author_user_id: null,
      email_message_id: emailRow.id,
      metadata: {
        email_snapshot: {
          subject: emailRow.subject,
          sender: emailRow.sender_email,
          sender_name: emailRow.sender_name,
          received_at: emailRow.received_at.toISOString(),
          body_excerpt: truncate(emailRow.raw_body_text ?? '', 500),
        },
        outcome: emailOutcome,
      },
    },
  });

  // Insert PAYLOAD_ADDED entry if new payload
  if (payloadAdded) {
    await tx.ticket_entries.create({
      data: {
        ticket_id: existing.id,
        entry_type: 'PAYLOAD_ADDED',
        author_user_id: null,
        metadata: { payload: newPayload },
      },
    });
  }

  // Insert STATE_CHANGE entry if state transitioned
  if (stateChanged) {
    await tx.ticket_entries.create({
      data: {
        ticket_id: existing.id,
        entry_type: 'STATE_CHANGE',
        author_user_id: null,
        metadata: {
          from: existing.state,
          to: newState,
          trigger: 'email',
          email_message_id: emailRow.id,
        },
      },
    });
  }

  return {
    ticket: updated,
    created: false,
    state_changed: stateChanged,
    previous_state: existing.state,
    new_state: newState,
  };
}

function payloadExists(payloads: PayloadEntry[], candidate: Record<string, string>): boolean {
  return payloads.some(p => deepEqual(p.payload, candidate));
}
```

---

## 4. State derivation — pure functions

### 4.1. From email (automatic)

```typescript
// lib/ticket-engine/state-machine.ts
type OpenState = 'NEW' | 'IN_REVIEW' | 'REJECTED';
type TerminalState = 'APPROVED' | 'DONE' | 'ARCHIVED';
type TicketState = OpenState | TerminalState;
type Outcome = 'IN_REVIEW' | 'REJECTED' | 'APPROVED';

export function deriveStateFromEmailOnOpenTicket(
  currentState: OpenState,
  emailOutcome: Outcome | null
): TicketState {
  // NEW state does NOT auto-transition on email — stays NEW until user triages
  if (currentState === 'NEW') {
    return 'NEW';
  }

  // IN_REVIEW and REJECTED: follow email outcome
  if (emailOutcome === null) {
    // Email không có outcome (unusual, vd UNCLASSIFIED_TYPE) — giữ nguyên state
    return currentState;
  }

  switch (emailOutcome) {
    case 'IN_REVIEW': return 'IN_REVIEW';
    case 'REJECTED':  return 'REJECTED';
    case 'APPROVED':  return 'APPROVED';
  }
}
```

**Key behaviors encoded**:
- `NEW` không bao giờ auto-transition qua email (user triage trước)
- `REJECTED` → email IN_REVIEW → `IN_REVIEW` (resubmit case)
- Bất kỳ open state → email APPROVED → `APPROVED` terminal

### 4.2. From user action

```typescript
export function deriveStateFromUserAction(
  currentState: TicketState,
  action: UserAction,
  latestOutcome: Outcome | null
): TicketState {
  switch (action.type) {
    case 'ARCHIVE':
      if (currentState !== 'NEW') {
        throw new InvalidTransitionError(currentState, 'ARCHIVE', 'Can only archive NEW tickets');
      }
      return 'ARCHIVED';

    case 'FOLLOW_UP':
      if (currentState !== 'NEW') {
        throw new InvalidTransitionError(currentState, 'FOLLOW_UP', 'Can only follow-up NEW tickets');
      }
      if (latestOutcome === null) {
        // Fallback: không có outcome (unclassified case) — đi vào IN_REVIEW làm default
        return 'IN_REVIEW';
      }
      return latestOutcome; // IN_REVIEW | REJECTED | APPROVED

    case 'MARK_DONE':
      if (!isOpenState(currentState)) {
        throw new InvalidTransitionError(currentState, 'MARK_DONE', 'Can only mark done open tickets');
      }
      return 'DONE';

    case 'UNARCHIVE':
      if (currentState !== 'ARCHIVED') {
        throw new InvalidTransitionError(currentState, 'UNARCHIVE', 'Can only unarchive ARCHIVED');
      }
      return 'NEW';

    // Non-state-changing actions return current state
    case 'ASSIGN':
    case 'SET_PRIORITY':
    case 'SET_DUE_DATE':
    case 'ADD_COMMENT':
    case 'EDIT_COMMENT':
    case 'ADD_REJECT_REASON':
      return currentState;
  }
}

function isOpenState(state: TicketState): state is OpenState {
  return state === 'NEW' || state === 'IN_REVIEW' || state === 'REJECTED';
}
```

### 4.3. Test cases

```typescript
describe('deriveStateFromEmailOnOpenTicket', () => {
  test('NEW stays NEW on any email', () => {
    expect(derive('NEW', 'IN_REVIEW')).toBe('NEW');
    expect(derive('NEW', 'REJECTED')).toBe('NEW');
    expect(derive('NEW', 'APPROVED')).toBe('NEW');
  });

  test('IN_REVIEW cycles on new IN_REVIEW email', () => {
    expect(derive('IN_REVIEW', 'IN_REVIEW')).toBe('IN_REVIEW');
  });

  test('IN_REVIEW → REJECTED on reject email', () => {
    expect(derive('IN_REVIEW', 'REJECTED')).toBe('REJECTED');
  });

  test('REJECTED → IN_REVIEW on resubmit in-review email (critical!)', () => {
    expect(derive('REJECTED', 'IN_REVIEW')).toBe('IN_REVIEW');
  });

  test('All open → APPROVED terminal', () => {
    expect(derive('IN_REVIEW', 'APPROVED')).toBe('APPROVED');
    expect(derive('REJECTED', 'APPROVED')).toBe('APPROVED');
  });
});

describe('deriveStateFromUserAction', () => {
  test('NEW + Archive → ARCHIVED', () => {
    expect(deriveAction('NEW', { type: 'ARCHIVE' })).toBe('ARCHIVED');
  });

  test('NEW + Follow Up + latestOutcome=REJECTED → REJECTED', () => {
    expect(deriveAction('NEW', { type: 'FOLLOW_UP' }, 'REJECTED')).toBe('REJECTED');
  });

  test('NEW + Follow Up without latestOutcome → IN_REVIEW (fallback)', () => {
    expect(deriveAction('NEW', { type: 'FOLLOW_UP' }, null)).toBe('IN_REVIEW');
  });

  test('Cannot archive IN_REVIEW ticket', () => {
    expect(() => deriveAction('IN_REVIEW', { type: 'ARCHIVE' })).toThrow(InvalidTransitionError);
  });

  test('Cannot mark done terminal state', () => {
    expect(() => deriveAction('APPROVED', { type: 'MARK_DONE' })).toThrow(InvalidTransitionError);
  });
});
```

---

## 5. Grouping key & unclassified handling

### 5.1. Grouping key matrix

| Classification status | Grouping key | Ticket bucket |
|---|---|---|
| `CLASSIFIED` | `(app_id, type_id, platform_id)` | Normal ticket |
| `UNCLASSIFIED_TYPE` | `(app_id, NULL, platform_id)` | "Unclassified Type" bucket — 1 ticket per (app, platform) |
| `UNCLASSIFIED_APP` | `(NULL, NULL, platform_id)` | "Unclassified App" bucket — 1 ticket per platform |

**Consequence**: nhiều email `UNCLASSIFIED_APP` cùng platform (vd tất cả email Apple không match app nào) → gom vào **1 ticket duy nhất** của platform đó. UI hiện ticket này với thread chứa list tất cả email đó + cho phép user manually assign app.

**Partial unique index đã enforce** (Section 01, data model):

```sql
CREATE UNIQUE INDEX idx_tickets_open_unique
  ON tickets(COALESCE(app_id, '00000000-0000-0000-0000-000000000000'),
             COALESCE(type_id, '00000000-0000-0000-0000-000000000000'),
             platform_id)
  WHERE state IN ('NEW', 'IN_REVIEW', 'REJECTED');
```

Sentinel UUID khiến NULLs compare equal trong unique index — Unclassified tickets cùng bucket conflict đúng như mong muốn.

### 5.2. Manual assign — resolve unclassified

Khi user manually assign app/type cho ticket Unclassified, ticket đó "promoted" sang proper grouping key. Nếu key mới đã có ticket mở → **conflict** với unique index.

**Resolution**: merge vào ticket đích, move tất cả entries + email_messages, delete ticket unclassified cũ.

```typescript
export async function reclassifyTicket(
  ticketId: UUID,
  newKey: { app_id?: UUID; type_id?: UUID },
  actor: SessionUser
): Promise<{ merged_into?: UUID; reclassified_ticket?: UUID }> {

  return await db.$transaction(async (tx) => {
    const ticket = await tx.tickets.findUniqueOrThrow({ where: { id: ticketId } });

    const targetKey = {
      app_id: newKey.app_id ?? ticket.app_id,
      type_id: newKey.type_id ?? ticket.type_id,
      platform_id: ticket.platform_id,
    };

    // Check if ticket with target key already exists in open state
    const conflictTicket = await findOpenTicketForKey(tx, targetKey);

    if (conflictTicket && conflictTicket.id !== ticketId) {
      // MERGE: move entries + emails to conflictTicket, delete current
      await tx.ticket_entries.updateMany({
        where: { ticket_id: ticketId },
        data: { ticket_id: conflictTicket.id },
      });
      await tx.email_messages.updateMany({
        where: { ticket_id: ticketId },
        data: { ticket_id: conflictTicket.id },
      });

      // Merge type_payloads và submission_ids
      const merged = mergeArrays(conflictTicket.type_payloads, ticket.type_payloads);
      const mergedSubIds = Array.from(new Set([...conflictTicket.submission_ids, ...ticket.submission_ids]));
      await tx.tickets.update({
        where: { id: conflictTicket.id },
        data: {
          type_payloads: merged,
          submission_ids: mergedSubIds,
        },
      });

      // Audit entry trên ticket đích
      await tx.ticket_entries.create({
        data: {
          ticket_id: conflictTicket.id,
          entry_type: 'STATE_CHANGE',
          author_user_id: actor.id,
          metadata: {
            type: 'merge',
            merged_from_ticket: ticketId,
            merged_from_display_id: ticket.display_id,
          },
        },
      });

      // Delete old ticket
      await tx.tickets.delete({ where: { id: ticketId } });

      return { merged_into: conflictTicket.id };
    }

    // No conflict: update key directly
    await tx.tickets.update({
      where: { id: ticketId },
      data: {
        app_id: targetKey.app_id,
        type_id: targetKey.type_id,
      },
    });

    await tx.ticket_entries.create({
      data: {
        ticket_id: ticketId,
        entry_type: 'STATE_CHANGE',
        author_user_id: actor.id,
        metadata: {
          type: 'reclassify',
          from: { app_id: ticket.app_id, type_id: ticket.type_id },
          to: { app_id: targetKey.app_id, type_id: targetKey.type_id },
        },
      },
    });

    return { reclassified_ticket: ticketId };
  });
}
```

**UI warning**: trước khi execute, call `GET /api/tickets/{id}/reclassify-preview?app_id=X&type_id=Y` để check xem có conflict không. Nếu có, hiện warning "Sẽ merge với ticket TICKET-10245 đang active. Tiếp tục?" trước khi confirm.

### 5.3. Unclassified emails đến sau khi resolved

Edge case: user đã reclassify ticket Unclassified App sang Skyline. Email Unclassified App mới đến cùng platform.

- Flow: classify → UNCLASSIFIED_APP → find ticket với key (NULL, NULL, platform)
- Không tìm thấy (vì ticket cũ đã reclassify) → tạo ticket mới
- Correct behavior

---

## 6. Event log (ticket_entries) patterns

### 6.1. Entry types cheatsheet

| `entry_type` | `author_user_id` | `content` | `metadata` | `email_message_id` |
|---|---|---|---|---|
| `EMAIL` | NULL (system) | NULL | `{email_snapshot, outcome, classification_status}` | link to email_messages |
| `COMMENT` | user | comment body | `{}` | NULL |
| `REJECT_REASON` | user | pasted reject content | `{source: 'manual_paste'}` | NULL |
| `STATE_CHANGE` | user or NULL | NULL | `{from, to, trigger, email_message_id?, reason?}` | NULL |
| `PAYLOAD_ADDED` | NULL | NULL | `{payload}` | NULL |
| `ASSIGNMENT` | user (triggering) | NULL | `{assigned_to, previous_assignee}` | NULL |
| `PRIORITY_CHANGE` | user | NULL | `{from, to}` | NULL |

### 6.2. Invariants

- **Append-only** — không UPDATE entry (ngoại lệ: COMMENT edit → update `content` + set `edited_at`)
- **Email snapshot preservation** — EMAIL entry phải có `metadata.email_snapshot` (để thread còn đủ sau khi email_messages bị cleanup)
- **Author null = system** — ai đọc log hiểu ngay là auto event

### 6.3. Thread render query

```sql
-- Load ticket thread cho drawer UI
SELECT 
  te.*,
  u.display_name as author_name,
  u.avatar_url as author_avatar,
  em.subject as email_subject,
  em.raw_body_text as email_body
FROM ticket_entries te
LEFT JOIN users u ON u.id = te.author_user_id
LEFT JOIN email_messages em ON em.id = te.email_message_id
WHERE te.ticket_id = $1
ORDER BY te.created_at ASC;
```

Index `idx_ticket_entries_ticket_created(ticket_id, created_at DESC)` đã hỗ trợ query này (ORDER BY ASC vẫn dùng được index do PostgreSQL có thể scan ngược).

### 6.4. Edit comment flow

```typescript
async function editComment(
  entryId: UUID,
  newContent: string,
  actor: SessionUser
): Promise<TicketEntry> {
  return await db.$transaction(async (tx) => {
    const entry = await tx.ticket_entries.findUniqueOrThrow({ where: { id: entryId } });
    
    // Authorization: chỉ author + chỉ COMMENT type
    if (entry.entry_type !== 'COMMENT') {
      throw new ForbiddenError('Only COMMENT entries can be edited');
    }
    if (entry.author_user_id !== actor.id) {
      throw new ForbiddenError('Only comment author can edit');
    }

    return await tx.ticket_entries.update({
      where: { id: entryId },
      data: {
        content: newContent,
        edited_at: new Date(),
      },
    });
  });
}
```

---

## 7. User actions implementation

### 7.1. Main dispatcher

```typescript
// lib/ticket-engine/user-actions.ts
export async function executeUserAction(
  ticketId: UUID,
  action: UserAction,
  actor: SessionUser
): Promise<TicketHandleResult> {

  return await db.$transaction(async (tx) => {
    // Load ticket với FOR UPDATE
    const ticket = await loadTicketForUpdate(tx, ticketId);

    // Authorization
    assertCanPerformAction(ticket, action, actor);

    switch (action.type) {
      case 'ARCHIVE':
      case 'FOLLOW_UP':
      case 'MARK_DONE':
      case 'UNARCHIVE':
        return await handleStateTransition(tx, ticket, action, actor);

      case 'ASSIGN':
        return await handleAssign(tx, ticket, action.user_id, actor);

      case 'SET_PRIORITY':
        return await handleSetPriority(tx, ticket, action.priority, actor);

      case 'SET_DUE_DATE':
        return await handleSetDueDate(tx, ticket, action.due_date, actor);

      case 'ADD_COMMENT':
        return await handleAddComment(tx, ticket, action, actor);

      case 'ADD_REJECT_REASON':
        return await handleAddRejectReason(tx, ticket, action, actor);

      case 'EDIT_COMMENT':
        return await handleEditComment(tx, action.entry_id, action.content, actor);
    }
  });
}
```

### 7.2. Authorization matrix

```typescript
function assertCanPerformAction(
  ticket: Ticket,
  action: UserAction,
  actor: SessionUser
): void {
  // VIEWER: read-only
  if (actor.role === 'VIEWER') {
    throw new ForbiddenError('Viewer cannot modify tickets');
  }

  // MANAGER: full access
  if (actor.role === 'MANAGER') return;

  // DEV: most actions allowed, except reclassify & delete
  if (actor.role === 'DEV') {
    // DEV không được unarchive (undo archive là Manager only hoặc tự mình archive)
    if (action.type === 'UNARCHIVE' && ticket.created_by !== actor.id) {
      throw new ForbiddenError('Only original archiver or Manager can unarchive');
    }
    return;
  }

  throw new ForbiddenError(`Unknown role: ${actor.role}`);
}
```

Ma trận đơn giản cho team 2-5 người. Có thể làm granular hơn sau.

### 7.3. State transition handler

```typescript
async function handleStateTransition(
  tx: Transaction,
  ticket: Ticket,
  action: ArchiveAction | FollowUpAction | MarkDoneAction | UnarchiveAction,
  actor: SessionUser
): Promise<TicketHandleResult> {

  const newState = deriveStateFromUserAction(
    ticket.state,
    action,
    ticket.latest_outcome
  );

  const isTerminal = isTerminalState(newState);
  const now = new Date();

  const updated = await tx.tickets.update({
    where: { id: ticket.id },
    data: {
      state: newState,
      ...(isTerminal && {
        closed_at: now,
        resolution_type: newState as TerminalState,
      }),
      // Unarchive: clear closed_at
      ...(action.type === 'UNARCHIVE' && {
        closed_at: null,
        resolution_type: null,
      }),
    },
  });

  // STATE_CHANGE entry
  await tx.ticket_entries.create({
    data: {
      ticket_id: ticket.id,
      entry_type: 'STATE_CHANGE',
      author_user_id: actor.id,
      metadata: {
        from: ticket.state,
        to: newState,
        trigger: 'user_action',
        action_type: action.type,
      },
    },
  });

  return {
    ticket: updated,
    created: false,
    state_changed: true,
    previous_state: ticket.state,
    new_state: newState,
  };
}
```

### 7.4. Assign handler

```typescript
async function handleAssign(
  tx: Transaction,
  ticket: Ticket,
  newAssignee: UUID | null,
  actor: SessionUser
): Promise<TicketHandleResult> {

  // Validate assignee exists + active
  if (newAssignee) {
    const user = await tx.users.findUnique({ where: { id: newAssignee } });
    if (!user || user.status !== 'active') {
      throw new NotFoundError('Assignee not found or inactive');
    }
  }

  const previous = ticket.assigned_to;
  if (previous === newAssignee) {
    // No-op
    return unchangedResult(ticket);
  }

  const updated = await tx.tickets.update({
    where: { id: ticket.id },
    data: { assigned_to: newAssignee },
  });

  await tx.ticket_entries.create({
    data: {
      ticket_id: ticket.id,
      entry_type: 'ASSIGNMENT',
      author_user_id: actor.id,
      metadata: {
        assigned_to: newAssignee,
        previous_assignee: previous,
      },
    },
  });

  // TODO phase 2: notify newAssignee qua email/Slack

  return {
    ticket: updated,
    created: false,
    state_changed: false,
    previous_state: ticket.state,
    new_state: ticket.state,
  };
}
```

### 7.5. Add comment + reject reason

```typescript
async function handleAddComment(
  tx: Transaction,
  ticket: Ticket,
  action: AddCommentAction,
  actor: SessionUser
): Promise<TicketHandleResult> {
  await tx.ticket_entries.create({
    data: {
      ticket_id: ticket.id,
      entry_type: 'COMMENT',
      author_user_id: actor.id,
      content: action.content,
      attachment_refs: action.attachments ?? [],
    },
  });

  // Update updated_at của ticket để sort recent activity
  await tx.tickets.update({
    where: { id: ticket.id },
    data: { updated_at: new Date() },
  });

  return unchangedResult(ticket);
}

async function handleAddRejectReason(
  tx: Transaction,
  ticket: Ticket,
  action: AddRejectReasonAction,
  actor: SessionUser
): Promise<TicketHandleResult> {
  await tx.ticket_entries.create({
    data: {
      ticket_id: ticket.id,
      entry_type: 'REJECT_REASON',
      author_user_id: actor.id,
      content: action.content,
      attachment_refs: action.attachments ?? [],
      metadata: { source: 'manual_paste' },
    },
  });

  await tx.tickets.update({
    where: { id: ticket.id },
    data: { updated_at: new Date() },
  });

  return unchangedResult(ticket);
}
```

### 7.6. Archive undo (10s window)

Client-side UX: hiện toast "Undo" 10s sau Archive. Undo action hit endpoint `POST /api/tickets/{id}/unarchive`.

Server-side **không enforce 10s window** — trusts UI. Nếu Manager muốn unarchive ticket cũ (rare case), vẫn cho phép. DEV chỉ unarchive ticket mình archive.

```typescript
async function handleUnarchive(
  tx: Transaction,
  ticket: Ticket,
  actor: SessionUser
): Promise<TicketHandleResult> {
  if (ticket.state !== 'ARCHIVED') {
    throw new InvalidStateError('Ticket is not archived');
  }

  const updated = await tx.tickets.update({
    where: { id: ticket.id },
    data: {
      state: 'NEW',
      closed_at: null,
      resolution_type: null,
    },
  });

  await tx.ticket_entries.create({
    data: {
      ticket_id: ticket.id,
      entry_type: 'STATE_CHANGE',
      author_user_id: actor.id,
      metadata: {
        from: 'ARCHIVED',
        to: 'NEW',
        trigger: 'user_action',
        action_type: 'UNARCHIVE',
      },
    },
  });

  return { ticket: updated, created: false, state_changed: true,
    previous_state: 'ARCHIVED', new_state: 'NEW' };
}
```

---

## 8. App rename transaction

Bài toán: user rename app "Old" → "New". Transition aliases + app name atomically.

```typescript
// lib/ticket-engine/app-rename.ts
export async function renameApp(
  appId: UUID,
  newName: string,
  actor: SessionUser
): Promise<{ app: App; aliases_affected: number }> {

  return await db.$transaction(async (tx) => {
    const app = await tx.apps.findUniqueOrThrow({ where: { id: appId } });
    const oldName = app.name;

    if (oldName === newName) return { app, aliases_affected: 0 };

    // 1. Demote current AUTO_CURRENT alias to AUTO_HISTORICAL
    const { count } = await tx.app_aliases.updateMany({
      where: {
        app_id: appId,
        source_type: 'AUTO_CURRENT',
      },
      data: {
        source_type: 'AUTO_HISTORICAL',
        previous_name: oldName,
      },
    });

    // 2. Update app name
    await tx.apps.update({
      where: { id: appId },
      data: { name: newName },
    });

    // 3. Check if alias với tên mới đã tồn tại (user tự add manual trước đó)
    const existingAlias = await tx.app_aliases.findFirst({
      where: {
        app_id: appId,
        alias_text: newName,
      },
    });

    if (existingAlias) {
      // Promote existing manual/regex alias to AUTO_CURRENT
      await tx.app_aliases.update({
        where: { id: existingAlias.id },
        data: {
          source_type: 'AUTO_CURRENT',
          previous_name: null,
        },
      });
    } else {
      // Create new AUTO_CURRENT alias
      await tx.app_aliases.create({
        data: {
          app_id: appId,
          alias_text: newName,
          source_type: 'AUTO_CURRENT',
        },
      });
    }

    // 4. Invalidate classifier rules cache
    // (cache invalidation là side-effect ngoài transaction, gọi sau commit)
    
    return {
      app: await tx.apps.findUniqueOrThrow({ where: { id: appId } }),
      aliases_affected: count + 1,
    };
  }).then(result => {
    invalidateRulesCache();
    return result;
  });
}
```

**Edge case handled**: nếu user đã có manual alias "New Name" trước khi rename → promote alias đó thay vì tạo trùng.

**Email đến SAU rename nhưng subject vẫn dùng tên cũ**: cũng match được qua alias `AUTO_HISTORICAL`. Classification xuyên suốt. Khi user review Inbox, thấy email match đúng app — dù cách nhau vài ngày/tuần sau rename.

---

## 9. Error handling

### 9.1. Error hierarchy

```typescript
// lib/ticket-engine/errors.ts
export class TicketEngineError extends Error {}
export class InvalidTransitionError extends TicketEngineError {
  constructor(public from: string, public action: string, public reason?: string) {
    super(`Cannot transition ${from} via ${action}${reason ? `: ${reason}` : ''}`);
  }
}
export class ForbiddenError extends TicketEngineError {}
export class NotFoundError extends TicketEngineError {}
export class InvalidStateError extends TicketEngineError {}
export class ConcurrentModificationError extends TicketEngineError {}
```

### 9.2. Error mapping

| Error | HTTP status | Client handling |
|---|---|---|
| `InvalidTransitionError` | 409 Conflict | Show toast "This action is not allowed on current state" |
| `ForbiddenError` | 403 | Hide button hoặc show permission tooltip |
| `NotFoundError` | 404 | Toast "Ticket not found, may have been merged" |
| `InvalidStateError` | 409 | Toast + refresh ticket |
| `ConcurrentModificationError` | 409 | Auto-reload ticket + retry |
| DB constraint violation (unique) | 500 → log | Server error, alert via Sentry |

### 9.3. Constraint violation on unique index

Trường hợp race condition mà FOR UPDATE không catch (vd application bug không dùng transaction):

```typescript
try {
  await db.tickets.create({ ... });
} catch (err) {
  if (isPostgresError(err) && err.code === '23505' && err.constraint === 'idx_tickets_open_unique') {
    // Log + re-read + retry once
    Sentry.captureException(err, { tags: { component: 'ticket-engine', type: 'unique_violation' } });
    throw new ConcurrentModificationError('Ticket with this key already exists');
  }
  throw err;
}
```

---

## 10. Code structure

```
lib/
├── ticket-engine/
│   ├── index.ts                     main exports
│   ├── handle-email.ts              handleClassifiedEmail + create/update
│   ├── user-actions.ts              executeUserAction dispatcher
│   ├── state-machine.ts             pure derive functions
│   ├── app-rename.ts                renameApp transaction
│   ├── reclassify.ts                reclassifyTicket (merge logic)
│   ├── authorization.ts             assertCanPerformAction
│   ├── errors.ts                    error classes
│   └── types.ts                     UserAction, TicketHandleResult, etc.

app/
├── api/
│   └── tickets/
│       ├── route.ts                 GET list
│       ├── [id]/
│       │   ├── route.ts             GET detail, PATCH (inline update)
│       │   ├── archive/route.ts     POST
│       │   ├── follow-up/route.ts   POST
│       │   ├── done/route.ts        POST
│       │   ├── unarchive/route.ts   POST
│       │   ├── assign/route.ts      POST
│       │   ├── priority/route.ts    POST
│       │   ├── due-date/route.ts    POST
│       │   ├── comments/route.ts    POST (add), PATCH (edit)
│       │   ├── reject-reason/route.ts POST
│       │   └── reclassify/route.ts  POST + GET preview
│       └── bulk/
│           ├── archive/route.ts     bulk POST
│           └── follow-up/route.ts   bulk POST
│   └── apps/
│       └── [id]/rename/route.ts     POST rename (triggers app-rename transaction)
```

---

## 11. Testing strategy

### 11.1. Unit tests — state derivation

Comprehensive test coverage cho `state-machine.ts` (pure functions):

```typescript
describe('State machine — all transitions', () => {
  const allStates: TicketState[] = ['NEW', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'DONE', 'ARCHIVED'];
  const allOutcomes: (Outcome | null)[] = ['IN_REVIEW', 'REJECTED', 'APPROVED', null];
  
  // Test matrix: 6 states × 4 outcomes
  for (const state of openStates) {
    for (const outcome of allOutcomes) {
      test(`from ${state} + email ${outcome} → expected state`, () => {
        const result = deriveStateFromEmailOnOpenTicket(state as OpenState, outcome);
        // Verify against expected matrix
      });
    }
  }
});
```

### 11.2. Integration tests — transaction correctness

```typescript
describe('handleClassifiedEmail', () => {
  test('creates new ticket when no existing open ticket', async () => {
    const email = await insertEmail({ ... });
    const classification: ClassifiedResult = { ... };
    
    const result = await handleClassifiedEmail(email, classification);
    
    expect(result.created).toBe(true);
    expect(result.ticket.state).toBe('NEW');
    
    const entries = await db.ticket_entries.findMany({ where: { ticket_id: result.ticket.id }});
    expect(entries).toHaveLength(1); // 1 EMAIL entry
  });

  test('gom email vào ticket IN_REVIEW existing, state unchanged', async () => {
    const ticket = await createTestTicket({ state: 'IN_REVIEW' });
    const email = await insertEmail({ ... });
    
    const result = await handleClassifiedEmail(email, { status: 'CLASSIFIED', outcome: 'IN_REVIEW', ... });
    
    expect(result.created).toBe(false);
    expect(result.state_changed).toBe(false);
    expect(result.ticket.id).toBe(ticket.id);
  });

  test('REJECTED ticket + IN_REVIEW email → IN_REVIEW (resubmit)', async () => {
    const ticket = await createTestTicket({ state: 'REJECTED' });
    const result = await handleClassifiedEmail(
      await insertEmail({...}),
      { status: 'CLASSIFIED', outcome: 'IN_REVIEW', ... }
    );
    
    expect(result.state_changed).toBe(true);
    expect(result.new_state).toBe('IN_REVIEW');
    
    const stateChangeEntry = await findEntry({ ticket_id: ticket.id, entry_type: 'STATE_CHANGE' });
    expect(stateChangeEntry.metadata.from).toBe('REJECTED');
    expect(stateChangeEntry.metadata.to).toBe('IN_REVIEW');
  });

  test('ticket already APPROVED → new email creates NEW ticket', async () => {
    const oldTicket = await createTestTicket({ state: 'APPROVED' });
    const result = await handleClassifiedEmail(
      await insertEmail({...}),
      { status: 'CLASSIFIED', ... } // same key
    );
    
    expect(result.created).toBe(true);
    expect(result.ticket.id).not.toBe(oldTicket.id);
    expect(result.new_state).toBe('NEW');
  });

  test('new payload appends to type_payloads', async () => {
    const ticket = await createTestTicket({ 
      type_payloads: [{ payload: { version: '2.4.0', os: 'iOS' }, first_seen_at: '...' }]
    });
    await handleClassifiedEmail(
      await insertEmail({...}),
      { status: 'CLASSIFIED', type_payload: { version: '2.4.1', os: 'iOS' }, ... }
    );
    
    const updated = await db.tickets.findUnique({ where: { id: ticket.id }});
    expect(updated.type_payloads).toHaveLength(2);
  });

  test('duplicate payload does not append', async () => {
    // Same payload twice → should not duplicate
  });

  test('unclassified emails gom cùng bucket', async () => {
    const c1: UnclassifiedAppResult = { status: 'UNCLASSIFIED_APP', platform_id: applePlatformId, ... };
    const c2: UnclassifiedAppResult = { status: 'UNCLASSIFIED_APP', platform_id: applePlatformId, ... };
    
    const r1 = await handleClassifiedEmail(await insertEmail({...}), c1);
    const r2 = await handleClassifiedEmail(await insertEmail({...}), c2);
    
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.ticket.id).toBe(r1.ticket.id);
  });
});
```

### 11.3. Concurrency tests

```typescript
test('2 concurrent email handling with same key → only 1 ticket', async () => {
  const email1 = await insertEmail({ ... });
  const email2 = await insertEmail({ ... });
  
  const [r1, r2] = await Promise.all([
    handleClassifiedEmail(email1, classification),
    handleClassifiedEmail(email2, classification),
  ]);
  
  // One creates, other updates
  const tickets = await db.tickets.findMany({ where: { app_id, type_id, platform_id }});
  expect(tickets).toHaveLength(1);
  // 2 EMAIL entries trong ticket đó
  const entries = await db.ticket_entries.findMany({ where: { ticket_id: tickets[0].id }});
  expect(entries.filter(e => e.entry_type === 'EMAIL')).toHaveLength(2);
});
```

### 11.4. App rename tests

```typescript
describe('renameApp', () => {
  test('demotes AUTO_CURRENT → AUTO_HISTORICAL, creates new AUTO_CURRENT', async () => {
    const app = await createApp({ name: 'Skyline Racing' });
    // Auto alias created: 'Skyline Racing' với source_type=AUTO_CURRENT
    
    await renameApp(app.id, 'Skyline Runners', actor);
    
    const aliases = await db.app_aliases.findMany({ where: { app_id: app.id }});
    const current = aliases.find(a => a.source_type === 'AUTO_CURRENT');
    const historical = aliases.find(a => a.source_type === 'AUTO_HISTORICAL');
    
    expect(current?.alias_text).toBe('Skyline Runners');
    expect(historical?.alias_text).toBe('Skyline Racing');
    expect(historical?.previous_name).toBe('Skyline Racing');
  });

  test('promotes existing manual alias if matching new name', async () => {
    const app = await createApp({ name: 'Old Name' });
    await db.app_aliases.create({
      data: { app_id: app.id, alias_text: 'New Name', source_type: 'MANUAL' }
    });
    
    await renameApp(app.id, 'New Name', actor);
    
    const aliases = await db.app_aliases.findMany({ where: { app_id: app.id }});
    expect(aliases.filter(a => a.alias_text === 'New Name')).toHaveLength(1); // no duplicate
    const promoted = aliases.find(a => a.alias_text === 'New Name');
    expect(promoted?.source_type).toBe('AUTO_CURRENT');
  });
});
```

---

## 12. Open questions

1. **Bulk operations performance**: bulk Archive 50 tickets cùng lúc — nên 1 transaction lớn hay 50 transactions nhỏ? **Recommend**: 1 transaction (all-or-nothing), timeout 30s. Nếu lớn hơn: defer queue pattern.

2. **Ticket entry edit history**: hiện chỉ track `edited_at` timestamp, không lưu history. Nếu cần audit đầy đủ: thêm bảng `ticket_entry_history` (snapshot khi edit). **Recommend**: defer, MVP đủ với `edited_at`.

3. **Ticket merge audit**: khi merge 2 tickets qua reclassify, ticket cũ bị HARD DELETE. Audit trail preserved qua STATE_CHANGE entry của ticket đích (có `merged_from_ticket` UUID + `merged_from_display_id` để trace). Mất chi tiết ticket cũ nhưng giữ được reference. **Decision: hard delete** (đã confirm).

4. **Notification on state change / assign**: khi ticket chuyển REJECTED hoặc được assign, notify ai? (a) Email, (b) in-app badge, (c) Slack webhook. **Recommend**: defer notifications sang v1.1, MVP chỉ có in-app badge trên sidebar.

5. **Dev role granular permissions**: hiện DEV được full CRUD trừ unarchive của người khác. Có cần restrict thêm không? Vd DEV không được reclassify? **Recommend**: default full access, tighten khi có complaint.

6. **Idempotent user actions**: nếu user double-click "Archive" button → 2 request cùng lúc. Hiện không có request deduplication. **Recommend**: UI disable button sau click + retry-safe response.

---

## Kết luận

Ticket Engine là **transactional hub** của hệ thống:

- **1 transaction per operation** — email handling, user action, app rename đều atomic
- **FOR UPDATE locking** + **partial unique index** = 2 tầng enforce invariant "max 1 open ticket per key"
- **Pure state derivation functions** — tested độc lập, không mock DB
- **Event log append-only** với `email_snapshot` preservation → thread complete dù email raw cleanup sau 1 năm
- **Unclassified tickets** group theo (partial_key, platform) → user resolve batch-wise

**Next up**: Section 5 — API Design + Frontend Architecture. Route contracts, zod schemas, App Router structure, Server Components vs Client Components, TanStack Query patterns.
