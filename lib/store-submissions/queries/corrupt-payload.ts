/**
 * Count of `email_messages` rows whose `extracted_payload.app_name`
 * or `raw_body_text` carry control-byte residue from the pre-PR-14
 * QP decoder bug.
 *
 * Used by the Inbox page to render the MANAGER "Repair corrupt
 * payloads (N)" maintenance banner. Returns `0` when no rows match —
 * the banner auto-hides in that case, retiring the affordance once
 * the `backfillCorruptPayloadAction` has cleared the queue.
 *
 * Filter mirrors `backfillCorruptPayloadAction`'s candidate selection
 * exactly EXCEPT the Apple-sender filter is omitted: the count is a
 * page-load probe, not the per-row action gate. If a non-Apple
 * sender ever produces a control-byte payload (none configured today)
 * the count would be slightly inflated; the action skips the row and
 * captures the error, so the badge self-corrects on next page load.
 *
 * Performance: `head: true` requests no row data — Postgres returns
 * just the count. The control-byte regex runs over an indexed table
 * scan; production scale (thousands of rows) is well under the
 * inbox page's TTI budget.
 */

import { storeDb } from '../db';

const CORRUPT_REGEX = '[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F]';
const CORRUPT_OR_FILTER =
  `extracted_payload->>app_name.match.${CORRUPT_REGEX},` +
  `raw_body_text.match.${CORRUPT_REGEX}`;

export async function getCorruptPayloadCount(): Promise<number> {
  const { count, error } = await storeDb()
    .from('email_messages')
    .select('id', { count: 'exact', head: true })
    .or(CORRUPT_OR_FILTER)
    .not('extracted_payload', 'is', null)
    .not('classification_status', 'eq', 'DROPPED');

  if (error) {
    // Page render must not fail on a maintenance probe — degrade to
    // hidden banner. The action itself surfaces a real error if the
    // Manager clicks anyway.
    console.error('[getCorruptPayloadCount] query failed:', error);
    return 0;
  }
  return count ?? 0;
}
