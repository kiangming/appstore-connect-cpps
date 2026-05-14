/**
 * Forward-dedup runtime lookup (PR-Inbox.ForwardDedup, FD.e helper).
 *
 * Given a freshly-classified email's `duplicate_fingerprint` and
 * `received_at`, look up whether a CLASSIFIED original exists within
 * the ±5min symmetric window. Caller (sync.ts dedup gate) routes the
 * email to either:
 *   - normal flow (no match → store fingerprint, proceed to wire)
 *   - DUPLICATE_FORWARD bucket (match → mark row as duplicate, skip wire)
 *
 * **Why this lives in its own module.** The pure fingerprint composer
 * (`./fingerprint.ts`) is heavily unit-tested with synthetic inputs;
 * keeping the DB lookup separate preserves that purity and avoids
 * dragging Supabase mocks into 20-case composition tests.
 *
 * **Concurrency.** Gmail sync already serializes per-message via the
 * sync-state advisory lock + sequential `processMessage` loop. Two
 * forwards of the same Apple submission can't be classified
 * simultaneously — by the time forward B reaches this lookup,
 * forward A's row is already committed. No transaction / FOR UPDATE
 * needed. (The legacy `UNIQUE(gmail_msg_id)` race protection still
 * applies orthogonally to this gate.)
 *
 * **Window.** ±5min symmetric, Manager-locked (Q1, 2026-05-14). The
 * symmetric range covers the "forward arrives before direct" case
 * where the auto-forwarding Gmail rule beats the direct recipient's
 * mail server. Production scale shows forward delivery spread
 * <2 min in practice, so 5 min is conservative.
 */

import { storeDb } from '../db';

/** ±5min symmetric (Manager Q1 LOCKED). */
export const DEDUP_WINDOW_MS = 5 * 60 * 1000;

export interface FingerprintMatch {
  id: string;
  received_at: string;
}

/**
 * Find the earliest existing CLASSIFIED original for a given
 * fingerprint within ±5min of `receivedAt`. Returns `null` when no
 * match exists (caller treats current email as the new original).
 *
 * Filters by `classification_status = 'CLASSIFIED'` so that:
 *   - Already-marked DUPLICATE_FORWARD rows don't qualify as
 *     candidate originals (avoids chained-dedup mis-attribution
 *     where a forward gets pointed at another forward).
 *   - DROPPED / ERROR / UNCLASSIFIED rows don't qualify (those
 *     don't carry fingerprints by design — fingerprint module
 *     returns null for them).
 *
 * Orders by `received_at ASC` then `LIMIT 1` so that, in the
 * pathological case of two near-simultaneous originals (e.g.
 * different ext_submission_ids hashing to the same fingerprint —
 * astronomically unlikely with Apple UUIDs), we attach to the
 * earliest. Defense-in-depth only.
 *
 * Throws on DB error. The caller (sync.ts gate) wraps in
 * try/catch and falls through to normal flow on failure — better
 * to risk a duplicate ticket than to swallow the email.
 */
export async function findFingerprintMatch(
  fingerprint: string,
  receivedAt: Date,
): Promise<FingerprintMatch | null> {
  const windowStart = new Date(
    receivedAt.getTime() - DEDUP_WINDOW_MS,
  ).toISOString();
  const windowEnd = new Date(
    receivedAt.getTime() + DEDUP_WINDOW_MS,
  ).toISOString();

  const { data, error } = await storeDb()
    .from('email_messages')
    .select('id, received_at')
    .eq('duplicate_fingerprint', fingerprint)
    .eq('classification_status', 'CLASSIFIED')
    .gte('received_at', windowStart)
    .lte('received_at', windowEnd)
    .order('received_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[dedup] fingerprint lookup failed:', error);
    throw new Error(`Failed to look up fingerprint: ${error.message}`);
  }
  return data as FingerprintMatch | null;
}
