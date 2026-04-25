'use server';

/**
 * Server Actions for Inbox state-transition user actions.
 *
 * Thin adapter between the `TicketActionsBar` client component and the
 * ticket engine dispatcher (`lib/store-submissions/tickets/user-actions.ts`,
 * PR-10c.1.2). Responsibilities:
 *
 *   1. Session guard via `requireStoreRole(['DEV', 'MANAGER'])` — VIEWER
 *      can never drive these flows even if the UI button leaks through.
 *   2. Dispatch to `executeUserAction` with a typed `UserActionRequest`.
 *   3. Translate typed dispatcher errors (InvalidTransitionRpcError,
 *      TicketNotFoundError, etc.) into a uniform `ActionResult` that
 *      the client renders as a toast.
 *   4. `revalidatePath('/store-submissions/inbox')` so the list + open
 *      detail panel re-fetch server-side with fresh state.
 *
 * Not in this file:
 *   - Comments / reject reasons (PR-10c.3.1)
 *   - UI invocation / toast rendering (TicketActionsBar)
 *
 * Pattern matches `config/apps/actions.ts` — same `ActionResult` shape,
 * same guard-wrapper idiom, same `mapRpcError`-style error translation.
 * Each of the four exported actions is a 1-liner routing to a shared
 * `executeTicketAction` helper to avoid duplicating guard + error code
 * across four call sites.
 */

import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';

import { authOptions } from '@/lib/auth';
import {
  requireStoreRole,
  StoreForbiddenError,
  StoreUnauthorizedError,
  type StoreUser,
} from '@/lib/store-submissions/auth';
import { UnauthorizedActionError } from '@/lib/store-submissions/tickets/auth';
import type { TicketState } from '@/lib/store-submissions/schemas/ticket';
import {
  CommentOwnershipError,
  ConcurrentModificationError,
  executeUserAction,
  InvalidTransitionRpcError,
  TicketNotFoundError,
  UserActionValidationError,
  type UserActionRequest,
} from '@/lib/store-submissions/tickets/user-actions';

// -- Types ----------------------------------------------------------------

/**
 * Shared shape across all Store Management Server Actions. Matches
 * `config/apps/actions.ts` discriminated union so InboxClient can
 * consume results with the same `ok`-check pattern used elsewhere.
 *
 * Code catalog specific to ticket transitions:
 *   - `UNAUTHORIZED` / `FORBIDDEN`: session or role guard failed
 *   - `NOT_FOUND`: ticket row doesn't exist (e.g. deleted concurrently)
 *   - `INVALID_TRANSITION`: state guard rejected (e.g. Archive on
 *     IN_REVIEW) — human-readable message carries the reason
 *   - `CONFLICT`: UNARCHIVE would violate the grouping-key unique index
 *     (surfaced as INVALID_TRANSITION by the RPC but distinct here so
 *     the toast can say "resolve conflicting open ticket first")
 *   - `VALIDATION`: malformed request (empty content, bad UUIDs — these
 *     actions don't take content, so mostly a defensive branch)
 *   - `RACE`: concurrent modification detected
 *   - `DB_ERROR`: generic fallback
 */
export type ActionError = {
  code:
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'VALIDATION'
    | 'NOT_FOUND'
    | 'INVALID_TRANSITION'
    | 'CONFLICT'
    | 'RACE'
    | 'DB_ERROR';
  message: string;
};

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError };

/**
 * Payload returned to the client on success. `previousState` lets the
 * toast render "Ticket moved to <state>" copy without re-reading the
 * ticket. `entryId` is the STATE_CHANGE entry id — currently unused by
 * the UI, kept for parity with the dispatcher's return shape and for
 * any future "jump to entry" navigation.
 */
export type TicketTransitionResult = {
  ticketId: string;
  previousState: TicketState;
  newState: TicketState;
  entryId: string;
};

// -- Guard + dispatch helper ---------------------------------------------

async function guardDevOrManager(): Promise<
  { user: StoreUser } | { error: ActionError }
> {
  const session = await getServerSession(authOptions);
  try {
    const user = await requireStoreRole(session?.user?.email, [
      'DEV',
      'MANAGER',
    ]);
    return { user };
  } catch (err) {
    if (err instanceof StoreUnauthorizedError) {
      return { error: { code: 'UNAUTHORIZED', message: err.message } };
    }
    if (err instanceof StoreForbiddenError) {
      return { error: { code: 'FORBIDDEN', message: err.message } };
    }
    throw err;
  }
}

/**
 * Convert a dispatcher-thrown typed error into an `ActionError`. Keeps
 * the mapping in one place so each per-action wrapper stays a 1-liner.
 * The UNARCHIVE grouping-key conflict comes through as an
 * `InvalidTransitionRpcError` whose message contains the phrase
 * "another open ticket already exists" (locked by integration test in
 * PR-10c.1.4); we detect and escalate to a `CONFLICT` code so the UI
 * can render a distinct toast.
 */
function mapDispatcherError(err: unknown): ActionError {
  if (err instanceof UnauthorizedActionError) {
    // Defense-in-depth: guardDevOrManager already rejected VIEWER, so
    // the dispatcher's own role check should never fire for our callers.
    // If it does, surface as FORBIDDEN so the UI matches the pattern.
    return { code: 'FORBIDDEN', message: err.message };
  }
  if (err instanceof TicketNotFoundError) {
    return {
      code: 'NOT_FOUND',
      message:
        'This ticket no longer exists — the list may be stale. Refresh and try again.',
    };
  }
  if (err instanceof InvalidTransitionRpcError) {
    if (err.message.includes('another open ticket already exists')) {
      return {
        code: 'CONFLICT',
        message:
          'Another open ticket already exists for this app/type/platform. Archive or resolve that ticket first.',
      };
    }
    // Strip the "[user-actions] invalid transition: INVALID_TRANSITION: "
    // prefix so the toast message is human-readable.
    const m = err.message.match(/INVALID_TRANSITION:\s*(.+)$/);
    return {
      code: 'INVALID_TRANSITION',
      message: m ? m[1]! : err.message,
    };
  }
  if (err instanceof UserActionValidationError) {
    return { code: 'VALIDATION', message: err.message };
  }
  if (err instanceof ConcurrentModificationError) {
    return {
      code: 'RACE',
      message:
        'Ticket was modified concurrently. Refresh and try again.',
    };
  }
  if (err instanceof CommentOwnershipError) {
    // Not reachable from state transitions (only edit_comment can raise
    // it) but kept here so the mapping is total — a future refactor that
    // routes comment actions through this helper won't drop it on the
    // floor.
    return { code: 'FORBIDDEN', message: err.message };
  }
  console.error('[inbox-actions] unmapped dispatcher error:', err);
  return {
    code: 'DB_ERROR',
    message:
      'Unexpected error while applying the action. Please try again.',
  };
}

/**
 * Single code path for all four state-transition actions. Each public
 * wrapper just supplies the `UserActionRequest`.
 */
async function executeTicketAction(
  ticketId: string,
  request: UserActionRequest,
): Promise<ActionResult<TicketTransitionResult>> {
  if (!ticketId || typeof ticketId !== 'string') {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: 'ticketId is required' },
    };
  }

  const guard = await guardDevOrManager();
  if ('error' in guard) return { ok: false, error: guard.error };

  try {
    const result = await executeUserAction({
      ticketId,
      actor: { id: guard.user.id, role: guard.user.role },
      request,
    });

    revalidatePath('/store-submissions/inbox');

    return {
      ok: true,
      data: {
        ticketId: result.ticketId,
        previousState: result.previousState,
        newState: result.newState,
        entryId: result.entryId,
      },
    };
  } catch (err) {
    return { ok: false, error: mapDispatcherError(err) };
  }
}

// -- Public Server Actions -----------------------------------------------

export async function archiveTicketAction(
  ticketId: string,
): Promise<ActionResult<TicketTransitionResult>> {
  return executeTicketAction(ticketId, { type: 'ARCHIVE' });
}

export async function followUpTicketAction(
  ticketId: string,
): Promise<ActionResult<TicketTransitionResult>> {
  return executeTicketAction(ticketId, { type: 'FOLLOW_UP' });
}

export async function markDoneTicketAction(
  ticketId: string,
): Promise<ActionResult<TicketTransitionResult>> {
  return executeTicketAction(ticketId, { type: 'MARK_DONE' });
}

export async function unarchiveTicketAction(
  ticketId: string,
): Promise<ActionResult<TicketTransitionResult>> {
  return executeTicketAction(ticketId, { type: 'UNARCHIVE' });
}
