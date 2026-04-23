/**
 * Ticket Engine — real implementation (PR-9).
 *
 * Drop-in replacement for the PR-8 `engine-stub.ts`. Exports the same
 * `findOrCreateTicket` signature; `wire.ts` imports from here unchanged.
 *
 * Heavy lifting lives in the PL/pgSQL RPC
 * `store_mgmt.find_or_create_ticket_tx` (migration
 * `20260423000000_store_mgmt_ticket_engine_rpc.sql`). This module:
 *
 *   1. Gates (defense-in-depth) on ticketable statuses — wire already
 *      filters, but we re-check so an internal caller bug surfaces as
 *      `TicketEngineNotApplicableError` rather than a silent DB error.
 *   2. Delegates to the RPC with the full classification JSONB + email id.
 *   3. Maps RPC error prefixes (`INVALID_STATUS:`, `NOT_FOUND:`, etc.)
 *      to typed errors for upstream handling.
 *
 * Current caller: `wire.ts` reads `result.ticketId` only. `previous_state`,
 * `state_changed`, `ticket` are populated for PR-10 UI consumers.
 */

import type { PostgrestError } from '@supabase/supabase-js';

import { storeDb } from '../db';

import type {
  FindOrCreateTicketInput,
  FindOrCreateTicketOutput,
  TicketRow,
  TicketState,
} from './types';

// -- Error classes -------------------------------------------------------

/**
 * Thrown (defense-in-depth) when `findOrCreateTicket` is invoked with a
 * non-ticketable classification status (DROPPED / ERROR). Wire pre-gates
 * via `isTicketableClassification`, but any future caller could bypass.
 * Re-checking here surfaces the bug loudly instead of reaching the RPC
 * and getting rejected with `INVALID_STATUS`.
 */
export class TicketEngineNotApplicableError extends Error {
  constructor(status: string) {
    super(
      `findOrCreateTicket called with non-ticketable classification status: ${status}`,
    );
    this.name = 'TicketEngineNotApplicableError';
  }
}

/**
 * RPC rejected the input shape: `INVALID_STATUS` / `INVALID_ARG` /
 * `INVALID_OUTCOME`. Indicates a contract violation — classifier
 * produced an unexpected shape, or the wire drifted out of sync with
 * the RPC signature.
 */
export class TicketEngineValidationError extends Error {
  constructor(message: string) {
    super(`[ticket-engine] validation: ${message}`);
    this.name = 'TicketEngineValidationError';
  }
}

/**
 * `email_message_id` does not exist in `store_mgmt.email_messages`.
 * Should be impossible in the wire call path (wire runs immediately
 * after the email row INSERT), but possible during the PR-9.6 backfill
 * if a row was deleted mid-run by the cleanup cron.
 */
export class TicketEngineNotFoundError extends Error {
  constructor(message: string) {
    super(`[ticket-engine] not found: ${message}`);
    this.name = 'TicketEngineNotFoundError';
  }
}

/**
 * Find-or-create loop exhausted its 3-iteration budget inside the RPC.
 * Indicates schema drift between the `SELECT ... FOR UPDATE` predicate
 * and the partial unique index on `store_mgmt.tickets`. Surface loudly —
 * do not silently retry. Wire catches and leaves `ticket_id` NULL;
 * next backfill pass retries.
 */
export class TicketEngineRaceError extends Error {
  constructor(message: string) {
    super(`[ticket-engine] race: ${message}`);
    this.name = 'TicketEngineRaceError';
  }
}

// -- RPC response shape (internal) ---------------------------------------

/**
 * Exact JSONB shape returned by `find_or_create_ticket_tx`. Mirrors the
 * migration's final `RETURN jsonb_build_object(...)` call. Only
 * `ticket_id` is renamed to camelCase (`ticketId`) in the public output;
 * everything else passes through.
 */
interface RpcFindOrCreateResult {
  ticket_id: string;
  created: boolean;
  previous_state: TicketState | null;
  new_state: TicketState;
  state_changed: boolean;
  ticket: TicketRow;
}

// -- Public API ----------------------------------------------------------

export async function findOrCreateTicket(
  input: FindOrCreateTicketInput,
): Promise<FindOrCreateTicketOutput> {
  const { classification, emailMessageId } = input;

  if (
    classification.status !== 'CLASSIFIED' &&
    classification.status !== 'UNCLASSIFIED_APP' &&
    classification.status !== 'UNCLASSIFIED_TYPE'
  ) {
    throw new TicketEngineNotApplicableError(
      (classification as { status: string }).status,
    );
  }

  const { data, error } = await storeDb().rpc('find_or_create_ticket_tx', {
    p_classification: classification,
    p_email_message_id: emailMessageId,
  });

  if (error) {
    throw mapRpcError(error);
  }

  if (!data) {
    throw new Error(
      '[ticket-engine] find_or_create_ticket_tx returned no data',
    );
  }

  const rpc = data as RpcFindOrCreateResult;

  return {
    ticketId: rpc.ticket_id,
    created: rpc.created,
    new_state: rpc.new_state,
    previous_state: rpc.previous_state,
    state_changed: rpc.state_changed,
    ticket: rpc.ticket,
  };
}

/**
 * Map `PostgrestError.message` prefixes to typed errors. Prefix catalog
 * defined in the migration header (error contract section).
 */
function mapRpcError(error: PostgrestError): Error {
  const message = error.message ?? 'unknown RPC error';

  if (
    message.includes('INVALID_STATUS') ||
    message.includes('INVALID_ARG') ||
    message.includes('INVALID_OUTCOME')
  ) {
    return new TicketEngineValidationError(message);
  }
  if (message.includes('NOT_FOUND')) {
    return new TicketEngineNotFoundError(message);
  }
  if (message.includes('CONCURRENT_RACE_UNEXPECTED')) {
    return new TicketEngineRaceError(message);
  }
  return new Error(`[ticket-engine] RPC failed: ${message}`);
}
