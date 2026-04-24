/**
 * Per-action authorization matrix for ticket user actions.
 *
 * Scope: role × action gate. Ownership checks (EDIT_COMMENT must be
 * performed by the comment author) are **not** handled here — those
 * require DB state and live in the RPC layer (PR-10c.1.3) with a
 * defense-in-depth echo in the dispatcher. This module answers only
 * "can a {role} ever perform {action}?" — pure static data.
 *
 * Authority: spec §7.2 (`docs/store-submissions/04-ticket-engine.md`).
 * The MVP role split is permissive: VIEWER read-only, DEV + MANAGER
 * symmetric on everything PR-10c ships. Granular rules (e.g.
 * "only MANAGER can unarchive tickets they didn't archive") are
 * explicitly deferred post-MVP; see TODO.md.
 *
 * Distinct from:
 *   - `lib/store-submissions/auth.ts` — session/whitelist/role lookup
 *   - `lib/store-submissions/session-guard.ts` — Server-component guards
 *   This file is strictly the ticket-action matrix.
 */

import type { StoreRole } from '../auth';

/**
 * The seven user actions PR-10c exposes. Superset of the 4 state-changing
 * actions in `state-machine.ts#UserAction`, plus the 3 event-log-only
 * actions (comments + reject reason) that the dispatcher routes.
 *
 * Superset rather than union-with-state-machine's type so this module
 * stays self-contained for testing — `state-machine.ts` has no auth
 * concerns, auth has no state-transition concerns. They meet at the
 * dispatcher in `user-actions.ts`.
 */
export type TicketUserAction =
  | 'ARCHIVE'
  | 'FOLLOW_UP'
  | 'MARK_DONE'
  | 'UNARCHIVE'
  | 'ADD_COMMENT'
  | 'EDIT_COMMENT'
  | 'ADD_REJECT_REASON';

/**
 * Role × action matrix. Values are the roles for which `action` is
 * legal. Derived directly from spec §7.2 (`Role matrix — DEV permissive`).
 *
 * NOTE: `as const` + `readonly StoreRole[]` keep this fully immutable
 * — tests and callers can't accidentally mutate and alter policy.
 */
export const AUTH_MATRIX: Readonly<Record<TicketUserAction, readonly StoreRole[]>> = {
  ARCHIVE: ['DEV', 'MANAGER'],
  FOLLOW_UP: ['DEV', 'MANAGER'],
  MARK_DONE: ['DEV', 'MANAGER'],
  UNARCHIVE: ['DEV', 'MANAGER'],
  ADD_COMMENT: ['DEV', 'MANAGER'],
  EDIT_COMMENT: ['DEV', 'MANAGER'],
  ADD_REJECT_REASON: ['DEV', 'MANAGER'],
} as const;

/**
 * Thrown when `role` is not in `AUTH_MATRIX[action]`. Carries the pair
 * as structured fields so Server Action callers can surface a specific
 * toast without parsing the message ("VIEWER cannot archive tickets").
 *
 * Separate from `StoreForbiddenError` in `lib/store-submissions/auth.ts`
 * — that one guards whole-module access (whitelist + role-for-page);
 * this one guards specific ticket actions and is lower-level.
 */
export class UnauthorizedActionError extends Error {
  constructor(
    public readonly role: StoreRole,
    public readonly action: TicketUserAction,
  ) {
    super(`Role ${role} cannot perform ${action}`);
    this.name = 'UnauthorizedActionError';
  }
}

/**
 * Throw-form gate. Use in the dispatcher entry point so a forbidden
 * action never issues an RPC call (don't waste a round-trip to have
 * the RPC reject; also keeps the DB audit log cleaner).
 */
export function assertCanPerformAction(
  role: StoreRole,
  action: TicketUserAction,
): void {
  if (!AUTH_MATRIX[action].includes(role)) {
    throw new UnauthorizedActionError(role, action);
  }
}

/**
 * Predicate form — for UI button disable/hide (e.g.
 * TicketDetailPanel footer in PR-10c.2). Never throws.
 */
export function canPerformAction(
  role: StoreRole,
  action: TicketUserAction,
): boolean {
  return AUTH_MATRIX[action].includes(role);
}
