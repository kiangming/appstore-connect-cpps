/**
 * Pure state-machine helpers for user-driven ticket transitions.
 *
 * Scope: the four state-changing user actions (ARCHIVE / FOLLOW_UP /
 * MARK_DONE / UNARCHIVE). Comments, reject reasons, assign, priority,
 * due-date don't transition state and never call through here — the
 * PR-10c.1.2 dispatcher routes them to their own handlers.
 *
 * Authority: `docs/store-submissions/04-ticket-engine.md` §4.2. Rules
 * are ported verbatim — including the (possibly surprising) constraint
 * that both ARCHIVE and FOLLOW_UP are legal only from NEW. If an open
 * ticket is already IN_REVIEW or REJECTED, the workflow is: ticket runs
 * through email-driven transitions until APPROVED, or Manager uses
 * MARK_DONE to close it manually. A second ARCHIVE/FOLLOW_UP chance is
 * not intended by the spec.
 *
 * Guarantees:
 *   - No DB access, no side effects. Safe in tests + client bundle.
 *   - `deriveStateFromUserAction` throws `InvalidTransitionError` on
 *     illegal transitions; callers (dispatcher, RPC, UI) treat it as
 *     a 400-class contract violation.
 *   - `isTerminalState` and `canTransition` are total — never throw.
 */

import type { TicketOutcome, TicketState } from '../schemas/ticket';

/**
 * The four state-changing user actions. Distinct from the broader
 * dispatcher `UserAction` union (spec §2.2) which also includes
 * ASSIGN / SET_PRIORITY / SET_DUE_DATE / ADD_COMMENT / EDIT_COMMENT /
 * ADD_REJECT_REASON — those don't transition state, so they don't belong
 * in the state machine.
 */
export type UserAction = 'ARCHIVE' | 'FOLLOW_UP' | 'MARK_DONE' | 'UNARCHIVE';

/**
 * Terminal states per invariant #6 (CLAUDE.md) — `state` ↔ `closed_at` ↔
 * `resolution_type` move together. Any transition landing here must set
 * `closed_at = NOW()` and `resolution_type = <new_state>` in the same
 * transaction (enforced by the RPCs in PR-10c.1.3 + the init-migration
 * CHECK constraint).
 */
const TERMINAL_STATES: ReadonlySet<TicketState> = new Set([
  'APPROVED',
  'DONE',
  'ARCHIVED',
]);

/**
 * "Open" = ticket still needs attention — NEW, IN_REVIEW, REJECTED.
 * Complement of {@link TERMINAL_STATES}. Kept as a set for parity with
 * the Inbox "Open" tab filter (`schemas/ticket.ts#openTicketStateSchema`).
 */
const OPEN_STATES: ReadonlySet<TicketState> = new Set([
  'NEW',
  'IN_REVIEW',
  'REJECTED',
]);

/**
 * Raised on an illegal user-action transition. Carries enough structured
 * detail that callers (Server Action → toast, RPC test → assertion) can
 * branch on `currentState` / `action` without parsing the message.
 */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly currentState: TicketState,
    public readonly action: UserAction,
    public readonly reason: string,
  ) {
    super(
      `Invalid transition: ${action} from state ${currentState}. ${reason}`,
    );
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Apply a user action to the current state. Returns the target state on
 * success; throws {@link InvalidTransitionError} on any guard violation.
 *
 * Rules per spec §4.2:
 *
 *   ARCHIVE      NEW only            → ARCHIVED
 *   FOLLOW_UP    NEW only            → latestOutcome ?? IN_REVIEW
 *   MARK_DONE    any open state      → DONE
 *   UNARCHIVE    ARCHIVED only       → NEW (intentional re-triage —
 *                                     ticket goes through full Manager
 *                                     review again, NOT back to the
 *                                     pre-archive state. See §4.2.)
 *
 * FOLLOW_UP + latestOutcome = APPROVED legally lands on APPROVED
 * (terminal). That is intentional: Manager saw Apple's approve email
 * out-of-band and is promoting the ticket manually. The dispatcher is
 * responsible for also setting `closed_at` + `resolution_type`.
 */
export function deriveStateFromUserAction(
  currentState: TicketState,
  action: UserAction,
  latestOutcome: TicketOutcome | null,
): TicketState {
  switch (action) {
    case 'ARCHIVE':
      if (currentState !== 'NEW') {
        throw new InvalidTransitionError(
          currentState,
          action,
          'Can only archive NEW tickets',
        );
      }
      return 'ARCHIVED';

    case 'FOLLOW_UP':
      if (currentState !== 'NEW') {
        throw new InvalidTransitionError(
          currentState,
          action,
          'Can only follow-up NEW tickets',
        );
      }
      // Null fallback: Unclassified tickets never carry an outcome — send
      // them to IN_REVIEW so they appear on the active board. Spec §4.2.
      return latestOutcome ?? 'IN_REVIEW';

    case 'MARK_DONE':
      if (!OPEN_STATES.has(currentState)) {
        throw new InvalidTransitionError(
          currentState,
          action,
          'Can only mark done open tickets (NEW / IN_REVIEW / REJECTED)',
        );
      }
      return 'DONE';

    case 'UNARCHIVE':
      if (currentState !== 'ARCHIVED') {
        throw new InvalidTransitionError(
          currentState,
          action,
          'Can only unarchive ARCHIVED tickets',
        );
      }
      return 'NEW';
  }
}

/**
 * True iff `state` closes the ticket per invariant #6. Callers use this
 * to decide whether to set `closed_at` + `resolution_type` on the same
 * UPDATE.
 */
export function isTerminalState(state: TicketState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Predicate form of {@link deriveStateFromUserAction}. Returns `true`
 * iff applying `action` to `from` would succeed without throwing.
 *
 * **Signature note**: the PR-10c plan originally proposed
 * `canTransition(from, to)`. Changed to `(from, action)` because the
 * UI consumer (TicketDetailPanel action footer — PR-10c.2) gates
 * buttons on "is this action legal from the current state?", not on
 * "can any action get us from X to Y?". A pure-graph `(from, to)`
 * variant can be added later without breaking callers if needed.
 *
 * `latestOutcome` is irrelevant to legality (FOLLOW_UP from NEW is
 * always allowed regardless of outcome; the outcome only picks the
 * target state), so it's not a parameter.
 */
export function canTransition(from: TicketState, action: UserAction): boolean {
  try {
    deriveStateFromUserAction(from, action, null);
    return true;
  } catch (err) {
    if (err instanceof InvalidTransitionError) return false;
    throw err;
  }
}
