/**
 * K1 — the Apple ASC key pool's storage layer. Reads only; nothing here
 * chooses a key (that is K2) or cools one down (K3).
 *
 * ⚠ SEPARATE FROM `lib/asc-account-repository.ts` ON PURPOSE. That module
 * owns `public.asc_accounts` — the ACCOUNT list, shared by CPP Manager and
 * Apple IAP Management and rendered in a picker both modules see. This one
 * owns `iap_mgmt.asc_account_keys`, an IAP-only table. Merging them would
 * put pool keys into CPP's account switcher, which is the whole reason the
 * keys got their own table (Q-RATELIMIT.pool-scope).
 */
import { iapDb } from "@/lib/iap-management/db";
import { decryptPrivateKey } from "@/lib/asc-crypto";
import type { AscCredentials } from "@/lib/asc-jwt";

/**
 * One usable pool key, already decrypted and shaped for signing.
 *
 * ⚠ `issuerId` is NOT stored per key and is not in this type. Every key of an
 * account belongs to the same Apple team, so the issuer comes from the
 * account the caller already holds. Storing it per key would create a second
 * copy that can disagree with the first — and a JWT signed with a mismatched
 * issuer/kid pair fails as a 401, which reads like a bad key rather than bad
 * data.
 */
export interface PoolKey {
  id: string;
  keyId: string;
  privateKey: string;
  cooldownUntil: Date | null;
}

interface KeyRow {
  id: string;
  account_id: string;
  key_id: string;
  private_key_enc: string;
  cooldown_until: string | null;
}

/**
 * Thrown when a stored key cannot be decrypted.
 *
 * ⚠ NAMED, AND IT CARRIES THE key_id RATHER THAN THE ERROR IT WRAPS. A
 * decrypt failure means either the row is corrupt or `ENCRYPTION_KEY` has
 * been rotated — both are operator problems needing a specific key
 * identified, not a stack trace. The underlying cipher error is attached as
 * `cause` but kept out of the message: its text varies by Node version and
 * says nothing beyond "unable to authenticate data".
 */
export class PoolKeyDecryptError extends Error {
  readonly accountId: string;
  readonly keyId: string;

  constructor(accountId: string, keyId: string, cause: unknown) {
    super(
      `Failed to decrypt pool key "${keyId}" for account "${accountId}". ` +
        `The row is corrupt, or ENCRYPTION_KEY no longer matches the one it ` +
        `was encrypted with.`,
    );
    this.name = "PoolKeyDecryptError";
    this.accountId = accountId;
    this.keyId = keyId;
    this.cause = cause;
  }
}

// ─── Cache ────────────────────────────────────────────────────────────────

/**
 * ⚠ 30 SECONDS, AND THE NUMBER IS A COOLDOWN DEADLINE, NOT A GUESS.
 *
 * `asc-account-repository.ts` caches accounts for 5 minutes, which is right
 * for data that only changes when an admin edits it. This table changes for
 * a different reason: K3 writes `cooldown_until` the moment a key exhausts
 * its budget, and on a multi-instance deploy the instance that learns it is
 * not the instance that has to act on it. So the TTL is the WORST-CASE
 * WINDOW in which another instance keeps handing out a key Apple is already
 * refusing.
 *
 * Five minutes of that would be ~5 minutes of avoidable 429s per instance —
 * precisely the failure the pool exists to prevent. 30s bounds it while
 * still collapsing a burst: an export at concurrency 8 issues hundreds of
 * requests inside one window and pays for one DB read, not hundreds.
 *
 * ⚠ Manager-Verify #3 (Railway instance count) is still open. On a single
 * instance this TTL is pure latency saving and could be far longer; the
 * value is chosen for the case that cannot yet be ruled out.
 */
const CACHE_TTL_MS = 30 * 1000;

interface CacheEntry {
  keys: PoolKey[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop cached keys — call after any write to the table (K3). */
export function invalidatePoolKeyCache(accountId?: string): void {
  if (accountId === undefined) cache.clear();
  else cache.delete(accountId);
}

// ─── Read ─────────────────────────────────────────────────────────────────

function rowToPoolKey(row: KeyRow): PoolKey {
  let privateKey: string;
  try {
    privateKey = decryptPrivateKey(row.private_key_enc);
  } catch (err) {
    throw new PoolKeyDecryptError(row.account_id, row.key_id, err);
  }
  return {
    id: row.id,
    keyId: row.key_id,
    privateKey,
    cooldownUntil: row.cooldown_until ? new Date(row.cooldown_until) : null,
  };
}

/**
 * Every enabled key for one account, decrypted.
 *
 * ⚠ AN EMPTY ARRAY IS A NORMAL ANSWER, NOT AN ERROR. Most accounts will have
 * no pool keys — the pool is opt-in per account and rolls out gradually — and
 * the caller's job is then to fall back to the account's own key from
 * `asc_accounts`. Throwing here would turn "this account isn't pooled yet"
 * into an outage, and would make enabling the pool for one account a risk to
 * every other one.
 *
 * ⚠ Cooldown is NOT filtered here. This returns what exists; deciding which
 * key is eligible right now belongs to the selector (K2/K3), and it needs to
 * see cooled-down keys to tell "the pool is empty" from "the pool is entirely
 * on cooldown" — two situations with different answers.
 */
export async function listPoolKeys(accountId: string): Promise<PoolKey[]> {
  const hit = cache.get(accountId);
  if (hit && Date.now() < hit.expiresAt) return hit.keys;

  const { data, error } = await iapDb()
    .from("asc_account_keys")
    .select("id, account_id, key_id, private_key_enc, cooldown_until")
    .eq("account_id", accountId)
    .eq("enabled", true)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(
      `Failed to load ASC pool keys for account "${accountId}": ${error.message}`,
    );
  }

  const keys = (data ?? []).map((r) => rowToPoolKey(r as KeyRow));
  cache.set(accountId, { keys, expiresAt: Date.now() + CACHE_TTL_MS });
  return keys;
}

/**
 * Shape a pool key as full credentials, borrowing everything team-scoped
 * from the account the caller already resolved.
 *
 * ⚠ `id` and `name` carry over unchanged so log lines and error messages
 * keep naming the ACCOUNT. Only `keyId` and `privateKey` differ — which is
 * exactly the difference the `key=` log field exists to show.
 */
export function poolKeyToCredentials(
  account: AscCredentials,
  key: PoolKey,
): AscCredentials {
  return {
    id: account.id,
    name: account.name,
    issuerId: account.issuerId,
    keyId: key.keyId,
    privateKey: key.privateKey,
  };
}

/** Test-only — the module-scoped cache leaks across specs otherwise. */
export function __resetPoolKeyCacheForTests(): void {
  cache.clear();
}

// ─── Write (K3) ───────────────────────────────────────────────────────────

/**
 * Persist a cooldown so sibling instances stop handing this key out.
 *
 * ⚠ THE ERROR IS INSPECTED, NOT DISCARDED — C2's batch-close lesson, applied
 * before it can bite again. That UPDATE was fire-and-forget, nothing in the
 * app SELECTs the table it wrote, and a rejected write therefore vanished
 * without trace. This table has the same property: only the pool reads it,
 * and only every 30 seconds. A silent failure here means every instance
 * keeps rotating onto a key Apple is refusing, and the logs say nothing.
 *
 * ⚠ AND IT NEVER THROWS. The caller is already handling a 429 and is about
 * to throw a rate-limit error of its own; turning a failed audit write into
 * a second, different failure would replace a diagnosable problem with a
 * confusing one. The in-memory cooldown (selector.ts) is set regardless, so
 * THIS process stays correct even when the write fails — only sibling
 * instances lose the signal, which is exactly what the log line says.
 */
export async function persistCooldown(
  accountId: string,
  keyId: string,
  until: Date,
): Promise<void> {
  // ⚠ THE WHOLE BODY IS GUARDED, NOT JUST THE QUERY RESULT.
  // `iapDb()` THROWS — synchronously — when Supabase env vars are missing,
  // so checking only the returned `{ error }` leaves a live escape route:
  // the throw would travel out of `markKeyRateLimited`, out of `appleFetch`'s
  // 429 branch, and REPLACE the `AppleRateLimitError` with a configuration
  // error. Every stop latch keys on `instanceof AppleRateLimitError`, so the
  // batch would stop being able to tell "Apple refused" from "we are
  // misconfigured", and would keep dispatching.
  //
  // This is the same class of defect the `selectKey` read path already had —
  // an enhancement quietly becoming a new way for the critical path to fail.
  // Found the same way, too: the test suite, running without env vars.
  let error: { message: string } | null = null;
  try {
    ({ error } = await iapDb()
      .from("asc_account_keys")
      .update({ cooldown_until: until.toISOString() })
      .eq("account_id", accountId)
      .eq("key_id", keyId));
  } catch (err) {
    error = { message: err instanceof Error ? err.message : String(err) };
  }

  if (error) {
    console.error(
      `[key-pool] FAILED to persist cooldown account=${accountId} key=${keyId} ` +
        `until=${until.toISOString()}: ${error.message} — this process still ` +
        `skips the key, but other instances will keep using it until it recovers.`,
    );
    return;
  }

  // The cached list carries `cooldownUntil`; leaving it stale would hide the
  // cooldown from this process for up to the TTL, which is the one thing the
  // in-memory marker is compensating for.
  invalidatePoolKeyCache(accountId);
}
