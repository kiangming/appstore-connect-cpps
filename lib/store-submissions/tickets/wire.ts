/**
 * Wire: `email_messages` ↔ tickets (PR-8).
 *
 * Called by `gmail/sync.ts` immediately after an `email_messages` row
 * is inserted. Responsible for:
 *
 *   1. Gating on ticketable statuses (CLASSIFIED, UNCLASSIFIED_APP,
 *      UNCLASSIFIED_TYPE). DROPPED + ERROR short-circuit with `null`.
 *   2. Delegating to the ticket engine (stub in PR-8, real in PR-9).
 *   3. Back-filling `email_messages.ticket_id` via UPDATE.
 *
 * **Graceful degradation.** A wire failure MUST NOT abort the sync
 * batch. The email row is already persisted at this point; losing the
 * ticket association just means a Manager sees a disconnected email
 * row in the Inbox, which is recoverable (PR-9 ticket engine can
 * back-fill later when a follow-up email for the same key arrives).
 * So: every failure path logs `[tickets-wire]` at ERROR level and
 * returns `null`. Never rethrow.
 *
 * See:
 *   - docs/store-submissions/03-email-rule-engine.md §7 (ticket wiring)
 *   - docs/store-submissions/04-ticket-engine.md §2.1
 *   - CLAUDE.md invariant #8 (classification-status → ticket mapping)
 */

import type { ClassificationResult } from '../classifier/types';
import { storeDb } from '../db';

import { findOrCreateTicket } from './engine-stub';
import { isTicketableClassification } from './types';
import type { TicketAssociation } from './types';

/**
 * Associate a freshly-inserted `email_messages` row with a ticket.
 *
 * @param emailMessageId  `store_mgmt.email_messages.id` (UUID)
 * @param classification  Full classifier output for the email
 * @returns `{ ticketId }` on success, `null` otherwise (non-ticketable
 *          status OR wire failure — check logs for the latter).
 */
export async function associateEmailWithTicket(
  emailMessageId: string,
  classification: ClassificationResult,
): Promise<TicketAssociation> {
  if (!isTicketableClassification(classification)) {
    return null;
  }

  let ticketId: string;
  try {
    const result = await findOrCreateTicket({
      emailMessageId,
      classification,
    });
    ticketId = result.ticketId;
  } catch (err) {
    console.error(
      '[tickets-wire] findOrCreateTicket failed — leaving email_messages.ticket_id NULL',
      { emailMessageId, status: classification.status, error: err },
    );
    return null;
  }

  const { error } = await storeDb()
    .from('email_messages')
    .update({ ticket_id: ticketId })
    .eq('id', emailMessageId);

  if (error) {
    console.error(
      '[tickets-wire] UPDATE email_messages.ticket_id failed — ticket exists but link lost',
      { emailMessageId, ticketId, error },
    );
    return null;
  }

  return { ticketId };
}
