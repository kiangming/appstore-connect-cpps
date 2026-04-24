/**
 * User-action dispatcher — entry point from Server Actions into the
 * ticket engine's write-side.
 *
 * Responsibility split (matches PR-9 `engine.ts` pattern):
 *   - TypeScript (this file): role-matrix gate, RPC call, typed-error
 *     mapping of `PostgrestError.message` prefixes. Thin.
 *   - PL/pgSQL (PR-10c.1.3): `FOR UPDATE` lock, state derivation,
 *     tickets UPDATE, ticket_entries INSERT. Atomic.
 *
 * Deliberately mirrors `engine.ts` layout — same RPC-wrapper shape, same
 * error-prefix mapping convention. A future reader opening both files
 * should see the same structure.
 *
 * **This file does not yet compile against a running DB** — the RPCs it
 * calls (`archive_ticket_tx`, `follow_up_ticket_tx`, …) ship in
 * PR-10c.1.3. Unit tests (PR-10c.1.4) mock `storeDb().rpc`; integration
 * tests in that chunk exercise the real RPCs. The build compiles fine
 * because `storeDb().rpc(<name>)` resolves RPC names at request time,
 * not at build time.
 */

import type { PostgrestError } from '@supabase/supabase-js';

import { storeDb } from '../db';
import type { StoreRole } from '../auth';

import {
  assertCanPerformAction,
  type TicketUserAction,
} from './auth';
import type { TicketState } from '../schemas/ticket';

// -- Request / response shapes -------------------------------------------

/**
 * Discriminated union of the seven user actions PR-10c exposes.
 * Per-variant payloads are typed, so TS rejects calls like ADD_COMMENT
 * missing `content` at compile time — no runtime zod validation needed
 * inside the dispatcher (callers upstream validate user input; this
 * module assumes well-typed input and defends with the RPC layer).
 */
export type UserActionRequest =
  | { type: 'ARCHIVE' }
  | { type: 'FOLLOW_UP' }
  | { type: 'MARK_DONE' }
  | { type: 'UNARCHIVE' }
  | { type: 'ADD_COMMENT'; content: string }
  | { type: 'EDIT_COMMENT'; entryId: string; content: string }
  | { type: 'ADD_REJECT_REASON'; content: string };

export interface ExecuteUserActionInput {
  ticketId: string;
  actor: { id: string; role: StoreRole };
  request: UserActionRequest;
}

/**
 * Uniform return shape across all seven actions — mirrors the spec
 * §2.1 `TicketHandleResult` plus an `entryId` tying the result to the
 * specific `ticket_entries` row created/updated.
 *
 * For non-state-changing actions (comments, reject reasons):
 *   - `previousState === newState`
 *   - `stateChanged === false`
 * For EDIT_COMMENT:
 *   - `entryId` is the pre-existing comment's id (we edited, didn't insert)
 */
export interface ExecuteUserActionOutput {
  ticketId: string;
  previousState: TicketState;
  newState: TicketState;
  stateChanged: boolean;
  entryId: string;
}

// -- Error classes -------------------------------------------------------

/**
 * RPC rejected the transition because the ticket's current state
 * doesn't permit it — e.g. user clicks Archive on a ticket that just
 * moved out of NEW because a follow-up email arrived mid-click. Maps
 * from `INVALID_TRANSITION:` prefix.
 *
 * Distinct from `state-machine.ts#InvalidTransitionError`: that one is
 * raised by the pure function with structured `currentState`/`action`
 * fields when a caller invokes it with a bad pair. This one wraps the
 * RPC's message — we don't have structured context from the wire, only
 * the human-readable string from `RAISE EXCEPTION`. Splitting the
 * classes avoids fabricating fake fields and keeps each one honest
 * about its provenance.
 */
export class InvalidTransitionRpcError extends Error {
  constructor(message: string) {
    super(`[user-actions] invalid transition: ${message}`);
    this.name = 'InvalidTransitionRpcError';
  }
}

/**
 * RPC couldn't find the referenced `tickets` row (or, for EDIT_COMMENT,
 * the `ticket_entries` row). Maps from `NOT_FOUND:` prefix.
 */
export class TicketNotFoundError extends Error {
  constructor(message: string) {
    super(`[user-actions] not found: ${message}`);
    this.name = 'TicketNotFoundError';
  }
}

/**
 * EDIT_COMMENT failed ownership check — the actor is not the comment's
 * author. Maps from `COMMENT_FORBIDDEN:` prefix. Defense-in-depth vs.
 * the auth matrix, which only gates "can DEV/MANAGER ever edit?" — the
 * "must be author" rule can only be checked against DB state.
 */
export class CommentOwnershipError extends Error {
  constructor(message: string) {
    super(`[user-actions] forbidden: ${message}`);
    this.name = 'CommentOwnershipError';
  }
}

/**
 * Input shape rejected by the RPC — e.g. blank comment content, or
 * malformed UUID. Maps from `INVALID_ARG:` / `INVALID_STATUS:` prefixes.
 * Indicates a client-side validation gap; callers should surface as 400.
 */
export class UserActionValidationError extends Error {
  constructor(message: string) {
    super(`[user-actions] validation: ${message}`);
    this.name = 'UserActionValidationError';
  }
}

/**
 * RPC detected a concurrent write race — very rare; typically means
 * another transaction held `FOR UPDATE` longer than the RPC's retry
 * budget, or schema drift between the ticket predicate and an index.
 * Maps from `CONCURRENT_RACE_UNEXPECTED:` prefix.
 */
export class ConcurrentModificationError extends Error {
  constructor(message: string) {
    super(`[user-actions] race: ${message}`);
    this.name = 'ConcurrentModificationError';
  }
}

// -- RPC response shape (internal) ---------------------------------------

/**
 * Wire shape from every `*_tx` RPC in 10c.1.3. Kept identical across all
 * seven so the dispatcher body is fully uniform. Each RPC always emits a
 * `ticket_entries` row (STATE_CHANGE for transitions; COMMENT/REJECT_REASON
 * for those actions; the edited row itself for EDIT_COMMENT) so
 * `entry_id` is never null.
 */
interface RpcUserActionResult {
  ticket_id: string;
  previous_state: TicketState;
  new_state: TicketState;
  state_changed: boolean;
  entry_id: string;
}

// -- Public API ----------------------------------------------------------

/**
 * Role-check, dispatch to the appropriate RPC, map errors.
 *
 * Ordering matters: auth first (never issue an RPC for a forbidden
 * action), then dispatch. RPC-side re-validation is expected per
 * defense-in-depth — the TS gate prevents wasted round-trips + keeps
 * audit trails clean; the RPC gate prevents direct-DB bypass.
 */
export async function executeUserAction(
  input: ExecuteUserActionInput,
): Promise<ExecuteUserActionOutput> {
  const { ticketId, actor, request } = input;

  // Map request → matrix-action (TicketUserAction is the string form that
  // AUTH_MATRIX keys on; UserActionRequest.type is the same string).
  const matrixAction: TicketUserAction = request.type;
  assertCanPerformAction(actor.role, matrixAction);

  const db = storeDb();
  const { data, error } = await (async () => {
    switch (request.type) {
      case 'ARCHIVE':
        return db.rpc('archive_ticket_tx', {
          p_ticket_id: ticketId,
          p_actor_user_id: actor.id,
        });
      case 'FOLLOW_UP':
        return db.rpc('follow_up_ticket_tx', {
          p_ticket_id: ticketId,
          p_actor_user_id: actor.id,
        });
      case 'MARK_DONE':
        return db.rpc('mark_done_ticket_tx', {
          p_ticket_id: ticketId,
          p_actor_user_id: actor.id,
        });
      case 'UNARCHIVE':
        return db.rpc('unarchive_ticket_tx', {
          p_ticket_id: ticketId,
          p_actor_user_id: actor.id,
        });
      case 'ADD_COMMENT':
        return db.rpc('add_comment_tx', {
          p_ticket_id: ticketId,
          p_actor_user_id: actor.id,
          p_content: request.content,
        });
      case 'EDIT_COMMENT':
        // ticketId passed alongside entryId: RPC verifies the entry
        // belongs to the ticket (prevents URL-manipulation cross-ticket
        // edits). See PR-10c.1.3 migration header.
        return db.rpc('edit_comment_tx', {
          p_ticket_id: ticketId,
          p_entry_id: request.entryId,
          p_actor_user_id: actor.id,
          p_content: request.content,
        });
      case 'ADD_REJECT_REASON':
        return db.rpc('add_reject_reason_tx', {
          p_ticket_id: ticketId,
          p_actor_user_id: actor.id,
          p_content: request.content,
        });
    }
  })();

  if (error) {
    throw mapRpcError(error);
  }

  if (!data) {
    throw new Error(
      `[user-actions] RPC for ${request.type} returned no data`,
    );
  }

  const rpc = data as RpcUserActionResult;

  return {
    ticketId: rpc.ticket_id,
    previousState: rpc.previous_state,
    newState: rpc.new_state,
    stateChanged: rpc.state_changed,
    entryId: rpc.entry_id,
  };
}

/**
 * Prefix catalog mirrors `engine.ts#mapRpcError`. Kept here (duplicated)
 * rather than extracted to a shared helper — the prefix sets are
 * similar but not identical (`INVALID_TRANSITION` / `COMMENT_FORBIDDEN`
 * live here; `INVALID_OUTCOME` lives in engine). A shared helper would
 * need to thread error-class factories per caller, adding indirection
 * without reducing LOC meaningfully.
 */
function mapRpcError(error: PostgrestError): Error {
  const message = error.message ?? 'unknown RPC error';

  if (message.includes('INVALID_TRANSITION')) {
    return new InvalidTransitionRpcError(message);
  }
  if (message.includes('COMMENT_FORBIDDEN')) {
    return new CommentOwnershipError(message);
  }
  if (message.includes('NOT_FOUND')) {
    return new TicketNotFoundError(message);
  }
  if (
    message.includes('INVALID_ARG') ||
    message.includes('INVALID_STATUS')
  ) {
    return new UserActionValidationError(message);
  }
  if (message.includes('CONCURRENT_RACE_UNEXPECTED')) {
    return new ConcurrentModificationError(message);
  }
  return new Error(`[user-actions] RPC failed: ${message}`);
}
