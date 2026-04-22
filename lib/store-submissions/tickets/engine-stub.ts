/**
 * Ticket engine — STUB implementation (PR-8).
 *
 * Returns an ephemeral UUID without touching the database. The stub
 * exists so the sync → wire → engine call path can be wired end-to-end
 * in PR-8, with PR-9 later swapping in the real `engine.ts` (find open
 * ticket with FOR UPDATE, dedup submission_id, write ticket_entries,
 * derive state transitions — see docs/store-submissions/04-ticket-engine.md).
 *
 * **Do not persist anything here.** The stub is intentionally amnesic:
 * two calls for the same (app, type, platform) produce different
 * ticketIds. Real dedup is PR-9's job; tests that need determinism mock
 * `crypto.randomUUID`.
 *
 * **Defense-in-depth guard.** Wire gates on ticketable status before
 * calling us, but we re-check here so a future caller mistake surfaces
 * as a thrown error instead of silently producing a ticket for a
 * DROPPED/ERROR email.
 */

import { randomUUID } from 'node:crypto';

import type {
  FindOrCreateTicketInput,
  FindOrCreateTicketOutput,
} from './types';

export class TicketEngineNotApplicableError extends Error {
  constructor(status: string) {
    super(
      `findOrCreateTicket called with non-ticketable classification status: ${status}`,
    );
    this.name = 'TicketEngineNotApplicableError';
  }
}

/**
 * PR-8 stub. PR-9 replaces this implementation while preserving
 * signature + return shape (fields may be added, never removed).
 */
export async function findOrCreateTicket(
  input: FindOrCreateTicketInput,
): Promise<FindOrCreateTicketOutput> {
  const { classification } = input;

  if (
    classification.status !== 'CLASSIFIED' &&
    classification.status !== 'UNCLASSIFIED_APP' &&
    classification.status !== 'UNCLASSIFIED_TYPE'
  ) {
    throw new TicketEngineNotApplicableError(
      (classification as { status: string }).status,
    );
  }

  return {
    ticketId: randomUUID(),
    created: true,
    new_state: 'NEW',
  };
}
