/**
 * K2 — which key signs the next request.
 *
 * ⚠ THIS MODULE IS CALLED PER REQUEST, NOT PER OPERATION, and that is the
 * whole design. `appleFetch` invokes it immediately before minting the JWT,
 * and `withRetry` re-invokes the entire `fn()` on every attempt — so a retry
 * naturally arrives here again and gets a different key. Rotation therefore
 * happens INSIDE the retry curve without `withRetry` knowing anything about
 * keys, without changing a single call-site signature, and without altering
 * what "an AppleRateLimitError escaped withRetry" means: it now means the
 * budget ran out on up to four DIFFERENT keys in a row, which is a stronger
 * claim than before, not a contradicting one. Every existing `shouldStop`
 * predicate and every latch docstring stays correct.
 *
 * Selecting once outside `appleFetch` would freeze the key for the whole
 * curve and forfeit all of that. `selector.test.ts` pins it.
 */
import {
  listPoolKeys,
  poolKeyToCredentials,
  type PoolKey,
} from "./repository";
import type { AscCredentials } from "@/lib/asc-jwt";

/**
 * ⚠ IN-MEMORY ONLY IN K2. K3 persists cooldowns to
 * `iap_mgmt.asc_account_keys.cooldown_until` so sibling instances see them;
 * until then a cooldown is known to the process that observed the 429 and to
 * nobody else. That is already enough for the thing K2 must guarantee — that
 * the NEXT RETRY ATTEMPT, which runs in this same process microseconds
 * later, does not pick the key Apple just refused.
 */
const cooldowns = new Map<string, number>();

/** Round-robin cursor per account. */
const cursors = new Map<string, number>();

/**
 * ⚠ ONE ROLLING HOUR, and the number is inherited rather than invented.
 * §4.9 measured Apple's window: `rem` is the limit minus everything spent in
 * the previous 60 minutes, so a key that has just exhausted its budget is
 * fully recovered an hour after the burst that drained it. Anything shorter
 * is a guess that puts a still-refusing key back into rotation.
 *
 * ⚠ Deliberately conservative. A key that spent only part of its budget
 * recovers sooner, so an hour can idle a key that was usable. With two or
 * more keys that costs nothing; with one it is identical to today's
 * behaviour (fall back to the account key). Tightening it needs the
 * per-endpoint budget data Apple does not give us — see §4.9 on
 * `x-rate-limit` being absent from the IAP endpoints.
 */
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

function cooldownKey(accountId: string, keyId: string): string {
  return `${accountId}::${keyId}`;
}

/**
 * Record that this key's budget is spent.
 *
 * ⚠ CALLED FROM `appleFetch`'s 429 BRANCH, BEFORE THE THROW. Marking after
 * the throw would be too late by exactly one attempt: `withRetry` catches,
 * sleeps, and calls straight back into selection, so an unmarked key is
 * still eligible and the retry re-picks the key Apple just refused. The
 * whole point of rotating is lost in the one situation it exists for.
 *
 * ⚠ Honours Apple's `Retry-After` when it sent one. ⚠ Whether Apple attaches
 * `Retry-After` to a 429 whose response carries no `x-rate-limit` is NOT yet
 * verified (KB §4.9 — the IAP endpoints omit the budget header entirely), so
 * the fallback is the load-bearing path and the header is an optimisation.
 */
export function markKeyRateLimited(
  accountId: string,
  keyId: string,
  retryAfterMs?: number | null,
): void {
  const ms = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_COOLDOWN_MS;
  cooldowns.set(cooldownKey(accountId, keyId), Date.now() + ms);
}

function isCoolingDown(accountId: string, key: PoolKey, now: number): boolean {
  const local = cooldowns.get(cooldownKey(accountId, key.keyId));
  if (local !== undefined && local > now) return true;
  // K1 stores this; K3 writes it. Reading it here already makes a cooldown
  // recorded by another instance effective as soon as the 30s repository
  // cache lapses.
  return key.cooldownUntil !== null && key.cooldownUntil.getTime() > now;
}

/**
 * Why no key was returned. ⚠ THE TWO REASONS ARE NOT THE SAME SITUATION and
 * the caller must be able to tell them apart:
 *
 *   "empty"     — this account has no pool keys. Completely normal: the pool
 *                 is opt-in per account and most accounts will never have
 *                 one. The account's own key is the right answer and nothing
 *                 is wrong.
 *   "exhausted" — the account HAS keys and every one of them is cooling
 *                 down. That is a real budget signal about this team, and it
 *                 is the state K3 turns into `ApplePoolExhaustedError`.
 *
 * Collapsing them would either make a normal un-pooled account look like an
 * outage, or make a genuinely exhausted team look normal — and the second is
 * how a batch quietly grinds against a refusing API.
 */
export type PoolMissReason = "empty" | "exhausted" | "error";

export interface KeySelection {
  /** The credentials to sign with. Never null — falls back to the account. */
  creds: AscCredentials;
  /** True when a pool key was used; false when the account's own key was. */
  fromPool: boolean;
  /** Set only when `fromPool` is false. */
  missReason?: PoolMissReason;
}

/**
 * Pick the credentials for one request.
 *
 * Falls back to the account's own key in BOTH miss cases. In K2 that is the
 * right answer for "empty" and a deliberate stopgap for "exhausted" — the
 * account key has its own separate budget, so trying it is strictly better
 * than failing, and K3 replaces the stopgap with an explicit error once the
 * pool can prove exhaustion durably rather than per-process.
 */
export async function selectKey(
  account: AscCredentials,
): Promise<KeySelection> {
  // ⚠ THE POOL MUST NEVER BE A NEW WAY FOR APPLE CALLS TO FAIL.
  //
  // Reading the pool means a database round-trip on a path that had none.
  // Letting that throw would mean a Supabase blip, a rotated ENCRYPTION_KEY
  // or one corrupt key row takes down EVERY Apple request in the module —
  // including the ones that would have worked fine on the account's own key,
  // exactly as they did before the pool existed. An optimisation that adds a
  // single point of failure to the thing it optimises is a bad trade at any
  // speed.
  //
  // So a broken pool degrades to the pre-pool behaviour and says so. The
  // operator gets a WARN naming the account; the Manager's import keeps
  // running. (Found by the test suite, not in review: wiring the pool into
  // `iapFetch` made every existing IAP test that touches Apple fail on a
  // missing SUPABASE_URL — the same fault a production outage would produce,
  // arriving early.)
  let keys;
  try {
    keys = await listPoolKeys(account.id);
  } catch (err) {
    console.warn(
      `[key-pool] account=${account.id} pool unreadable, using the account key: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return { creds: account, fromPool: false, missReason: "error" };
  }

  if (keys.length === 0) {
    return { creds: account, fromPool: false, missReason: "empty" };
  }

  const now = Date.now();
  const eligible = keys.filter((k) => !isCoolingDown(account.id, k, now));
  if (eligible.length === 0) {
    return { creds: account, fromPool: false, missReason: "exhausted" };
  }

  // ⚠ The cursor advances on every SELECTION, not on every success. A key
  // that errors for a non-rate-limit reason should not be handed the next
  // request too just because its turn "did not count".
  const next = (cursors.get(account.id) ?? 0) % eligible.length;
  cursors.set(account.id, next + 1);
  return { creds: poolKeyToCredentials(account, eligible[next]), fromPool: true };
}

/** Test-only — module-scoped state leaks across specs otherwise. */
export function __resetSelectorForTests(): void {
  cooldowns.clear();
  cursors.clear();
}
