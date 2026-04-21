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
 * Load all active senders across every platform in a single query.
 *
 * Ordering is not guaranteed; the resolver does exact-match lookup so
 * order doesn't matter. If a sender is duplicated across platforms
 * (schema allows: UNIQUE is `(platform_id, email)`, not `email` alone),
 * the last one scanned wins — in practice platforms own distinct
 * domains, so this is not a real collision risk.
 */
export async function loadActiveSenders(): Promise<ActiveSender[]> {
  const { data, error } = await storeDb()
    .from('senders')
    .select('email, platform_id, platforms!inner(key)')
    .eq('active', true);

  if (error) {
    console.error('[sender-resolver] Failed to load senders:', error);
    throw new Error('Failed to load active senders.');
  }
  if (!data) return [];

  const rows: ActiveSender[] = [];
  for (const row of data) {
    if (!row.email || !row.platform_id) continue;
    // `platforms!inner` shape: supabase-js returns either a single
    // object or an array depending on the join semantics; handle both.
    const raw = (row as { platforms?: unknown }).platforms;
    const platform = Array.isArray(raw) ? raw[0] : raw;
    const key = (platform as { key?: string } | undefined)?.key;
    if (!key) continue;
    rows.push({
      email: String(row.email).trim().toLowerCase(),
      platformId: String(row.platform_id),
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
