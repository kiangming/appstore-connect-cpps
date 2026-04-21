/**
 * Map a parsed email's `From` address to a Store Management platform.
 *
 * Surface split intentionally:
 *   - `loadActiveSenders()` is the single I/O call — one cheap query
 *     against `store_mgmt.senders` (~10–20 active rows total across
 *     Apple / Google / Huawei / Facebook). Called once per sync run.
 *   - `createSenderResolver()` is a PURE factory returning a sync
 *     lookup function. The orchestrator wraps each message's From in
 *     this resolver; the memoization is implicit because the same
 *     sender list is scanned in-memory.
 *
 * Why not one combined `resolvePlatformForSender(email)` that hides the
 * query? Because the orchestrator resolves senders for up to 50
 * messages per run, and doing 50 DB round-trips — even case-insensitive
 * eq lookups — is a waste when the sender table fits in a single query.
 * See spec §Q1 enhancement: resolve once, reuse for every message.
 *
 * Case handling matches the classifier's sender-matcher (`sender-matcher.ts`):
 * both sides trimmed + lowercased before comparison. `senders.email` is
 * seeded lowercase, but we normalize defensively so a future human edit
 * that uppercases one doesn't silently break matches.
 */

import type { PlatformKey } from '../classifier/types';
import { storeDb } from '../db';

export interface ActiveSender {
  /** Normalized (trimmed + lowercased) sender email. */
  email: string;
  platformId: string;
  platformKey: PlatformKey;
}

export interface PlatformResolution {
  platformId: string;
  platformKey: PlatformKey;
}

/**
 * Load all active senders across every platform.
 *
 * **Implementation: 2 independent queries + JS merge, NOT an embedded
 * select.**
 *
 * History: the original implementation used
 * `.select('email, platform_id, platforms!inner(key)')`. In production
 * with the supabase-js client scoped via `.schema('store_mgmt')` (see
 * `lib/store-submissions/db.ts`), that embedded-select returned a row
 * shape where `platforms` was not expanded as expected. The defensive
 * `if (!key) continue;` branch then silently dropped EVERY active
 * sender, producing an empty resolver Map — every incoming email
 * classified `DROPPED` with `reason=NO_SENDER_MATCH`, including correctly
 * configured Apple senders. The DB-side JOIN was fine (verified by hand
 * via SQL Editor); only the JS-side PostgREST embedding failed.
 *
 * The fix avoids the embedded select entirely: fetch senders + platforms
 * as two parallel queries (each table has <50 rows in practice) and join
 * in memory via a `Map<platformId, key>`. This:
 *   - Decouples us from PostgREST embed shape changes across supabase-js
 *     versions and across the schema-override client option.
 *   - Applies `active = true` explicitly on BOTH tables (the original
 *     query only filtered senders).
 *   - Keeps the resolver surface + O(1) lookup unchanged downstream.
 *
 * Ordering is not guaranteed; the resolver does exact-match lookup so
 * order doesn't matter. If a sender is duplicated across platforms
 * (schema allows: UNIQUE is `(platform_id, email)`, not `email` alone),
 * the last one scanned wins — in practice platforms own distinct
 * domains, so this is not a real collision risk.
 */
export async function loadActiveSenders(): Promise<ActiveSender[]> {
  const db = storeDb();
  const [sendersRes, platformsRes] = await Promise.all([
    db.from('senders').select('email, platform_id').eq('active', true),
    db.from('platforms').select('id, key').eq('active', true),
  ]);

  if (sendersRes.error) {
    console.error('[sender-resolver] Failed to load senders:', sendersRes.error);
    throw new Error('Failed to load active senders.');
  }
  if (platformsRes.error) {
    console.error(
      '[sender-resolver] Failed to load platforms:',
      platformsRes.error,
    );
    throw new Error('Failed to load active senders.');
  }

  // Build platformId → key lookup. Inactive platforms are already
  // filtered out by the query, so any sender whose platform is missing
  // here is either inactive or an FK orphan — skipped either way.
  const platformKeyById = new Map<string, string>();
  for (const p of platformsRes.data ?? []) {
    if (p.id && p.key) platformKeyById.set(String(p.id), String(p.key));
  }

  const rows: ActiveSender[] = [];
  for (const s of sendersRes.data ?? []) {
    if (!s.email || !s.platform_id) continue;
    const key = platformKeyById.get(String(s.platform_id));
    if (!key) continue; // platform inactive OR FK orphan
    rows.push({
      email: String(s.email).trim().toLowerCase(),
      platformId: String(s.platform_id),
      platformKey: key as PlatformKey,
    });
  }
  return rows;
}

/**
 * Build an in-memory exact-match resolver. Input is the full active
 * sender list; output is a function that takes a raw `From` email and
 * returns the platform it belongs to, or null when no sender matches.
 *
 * Pure — the returned function closes over an immutable Map and does
 * no I/O. Safe to call thousands of times per sync run.
 */
export function createSenderResolver(
  senders: readonly ActiveSender[],
): (rawEmail: string) => PlatformResolution | null {
  const byEmail = new Map<string, PlatformResolution>();
  for (const s of senders) {
    byEmail.set(s.email, {
      platformId: s.platformId,
      platformKey: s.platformKey,
    });
  }

  return (rawEmail: string): PlatformResolution | null => {
    const needle = rawEmail.trim().toLowerCase();
    if (!needle) return null;
    return byEmail.get(needle) ?? null;
  };
}
