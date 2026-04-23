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
 * PR-8 stub populates: `ticketId`, `created`, `new_state` only — the
 * rest are `undefined`.
 *
 * PR-9 populates the full shape (`previous_state`, `state_changed`,
 * `ticket`) per spec §2.1 `TicketHandleResult`. These fields are
 * declared **optional** so PR-8-era callers (e.g. `wire.ts`, which
 * reads only `ticketId`) compile unchanged and PR-10 UI consumers can
 * progressively enhance once PR-9 ships.
 *
 * **Stability contract (reaffirmed):** extending fields — adding
 * optional properties — is safe. Removing or renaming `ticketId`,
 * `created`, `new_state` is a breaking change.
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
  /**
   * State immediately before this operation. `null` when `created === true`
   * (ticket did not exist). Undefined in PR-8 stub; populated in PR-9.
   */
  previous_state?: TicketState | null;
  /**
   * `true` iff `previous_state !== new_state`. Lets callers skip STATE_CHANGE
   * UI without recomputing. Undefined in PR-8 stub; populated in PR-9.
   */
  state_changed?: boolean;
  /**
   * Full ticket row post-write. Undefined in PR-8 stub; populated in PR-9
   * (returned directly from the `find_or_create_ticket_tx` RPC).
   */
  ticket?: TicketRow;
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
 * Shape of a `store_mgmt.tickets` row as returned by PR-9's
 * `find_or_create_ticket_tx` RPC. Mirrors the table columns 1:1
 * (see `supabase/migrations/20260101100000_store_mgmt_init.sql`
 * lines 244–272).
 *
 * ISO timestamp strings, not `Date`, because Supabase RPC marshals
 * timestamps as `TIMESTAMPTZ → string` over the wire.
 */
export interface TicketRow {
  id: string;
  display_id: string;
  app_id: string | null;
  platform_id: string;
  type_id: string | null;
  state: TicketState;
  latest_outcome: 'IN_REVIEW' | 'REJECTED' | 'APPROVED' | null;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  assigned_to: string | null;
  type_payloads: unknown[];
  submission_ids: string[];
  opened_at: string;
  closed_at: string | null;
  resolution_type: 'APPROVED' | 'DONE' | 'ARCHIVED' | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Wire-level return.
 *
 * - `{ ticketId }` when the wire successfully associated the email.
 * - `null` when the classification is non-ticketable (DROPPED/ERROR)
 *   OR when the engine/UPDATE failed (wire swallows the error, logs
 *   it, and returns null — sync batch must not abort on wire failure).
 */
export type TicketAssociation = { ticketId: string } | null;
