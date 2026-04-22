/**
 * Shared types for the Ticket Engine + wire (PR-8 stub, PR-9 real impl).
 *
 * The wire calls `findOrCreateTicket` immediately after `email_messages`
 * INSERT and back-fills `email_messages.ticket_id` with the returned ID.
 *
 * **Stability contract:** PR-8 ships a stub implementation
 * (`engine-stub.ts`) that returns ephemeral UUIDs without touching the
 * DB. PR-9 drops in the real engine (`engine.ts`) behind the SAME
 * `findOrCreateTicket` signature. The types defined here are the
 * interface boundary — **extending fields is allowed, removing/renaming
 * is a breaking change** for PR-9.
 *
 * See:
 *   - docs/store-submissions/04-ticket-engine.md §2.1 (handleClassifiedEmail)
 *   - docs/store-submissions/04-ticket-engine.md §5 (grouping key matrix)
 */

import type {
  ClassificationResult,
  ClassifiedResult,
  UnclassifiedAppResult,
  UnclassifiedTypeResult,
} from '../classifier/types';

/**
 * Classification shapes that MUST produce a ticket, per invariant #8
 * (CLAUDE.md). Excludes `DROPPED` + `ERROR` — those are terminal, no
 * ticket, no UI visibility.
 *
 * - `CLASSIFIED`     → `(app_id, type_id, platform_id)` grouping key
 * - `UNCLASSIFIED_APP` → `(NULL, NULL, platform_id)` bucket
 * - `UNCLASSIFIED_TYPE` → `(app_id, NULL, platform_id)` bucket
 *
 * Unclassified buckets give Managers visibility in the Inbox UI so they
 * can decide whether to add rules, merge, or ignore. Dropping them would
 * silently hide Manager work.
 */
export type TicketableClassification =
  | ClassifiedResult
  | UnclassifiedAppResult
  | UnclassifiedTypeResult;

/**
 * Type guard: `true` iff the classification should produce a ticket.
 *
 * Single source of truth shared by:
 *   - `gmail/sync.ts` (pre-gate — skip wire call entirely for non-ticketable)
 *   - `tickets/wire.ts` (defense-in-depth — re-check before engine call)
 *
 * Keeping the gate in one place guarantees sync + wire cannot drift on
 * which statuses get tickets. Invariant #8 (CLAUDE.md) specifies the
 * set; this function is the code-level embodiment.
 */
export function isTicketableClassification(
  c: ClassificationResult,
): c is TicketableClassification {
  return (
    c.status === 'CLASSIFIED' ||
    c.status === 'UNCLASSIFIED_APP' ||
    c.status === 'UNCLASSIFIED_TYPE'
  );
}

export interface FindOrCreateTicketInput {
  /** `store_mgmt.email_messages.id` of the row that just landed. */
  emailMessageId: string;
  /** Must be a ticketable status; engine throws on DROPPED/ERROR. */
  classification: TicketableClassification;
}

/**
 * Ticket engine output.
 *
 * PR-8 stub populates: `ticketId`, `created`, `new_state` only.
 * PR-9 extends with: `previous_state`, `state_changed`, full `ticket`
 * row — see spec §2.1 `TicketHandleResult`. Callers must treat those
 * future fields as optional until PR-9 lands.
 */
export interface FindOrCreateTicketOutput {
  ticketId: string;
  /** `true` if a new ticket row was created; `false` if gathered into existing open ticket. */
  created: boolean;
  /**
   * Post-operation state. Stub always reports `'NEW'`. PR-9 derives from
   * the state machine (§4.1).
   */
  new_state: TicketState;
}

/**
 * Ticket lifecycle states per `store_mgmt.tickets.state` CHECK
 * constraint (01-data-model.md). Duplicated here (instead of imported
 * from a DB-layer module) to keep the tickets module self-contained —
 * the classifier does the same for its `Outcome` type.
 */
export type TicketState =
  | 'NEW'
  | 'IN_REVIEW'
  | 'REJECTED'
  | 'APPROVED'
  | 'DONE'
  | 'ARCHIVED';

/**
 * Wire-level return.
 *
 * - `{ ticketId }` when the wire successfully associated the email.
 * - `null` when the classification is non-ticketable (DROPPED/ERROR)
 *   OR when the engine/UPDATE failed (wire swallows the error, logs
 *   it, and returns null — sync batch must not abort on wire failure).
 */
export type TicketAssociation = { ticketId: string } | null;
