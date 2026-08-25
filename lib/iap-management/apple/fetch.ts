/**
 * Apple App Store Connect — IAP-side fetch wrapper with rate-limit retry.
 *
 * Thin re-export over the shared primitive (`lib/shared/apple-fetch.ts`),
 * extracted during the reviewSubmissions v2 migration so CPP's `ascFetch`
 * gains the same 429 detection + backoff this module always had (Manager
 * Q-IAP.7). `iapFetch` keeps its original name/log-tag ("iap-apple") so
 * every existing call site and Railway log grep is unaffected.
 *
 * JWT reuse: `generateAscToken` from @/lib/asc-jwt — same Apple team
 * credential (Q-IAP.1 reuses asc_accounts as-is, no module-specific creds).
 *
 * Composition: `iapFetch` is retry-NAIVE (throws AppleRateLimitError on
 * 429). Callers wrap with `withRetry(() => iapFetch(...))` when retry is
 * wanted — usually true for IAP CRUD; usually false for the upload
 * presigned-PUT chunks (those are short-lived and Apple's CDN doesn't
 * return 429).
 */

import { appleFetch } from "@/lib/shared/apple-fetch";
import { iapKeyPool } from "@/lib/iap-management/key-pool/pool";
import type { AscCredentials } from "@/lib/asc-jwt";

export {
  AppleApiError,
  AppleRateLimitError,
  withRetry,
  parseRateLimit,
} from "@/lib/shared/apple-fetch";
export type {
  Sleeper,
  RetryAttemptInfo,
  RetryOptions,
  RateLimitInfo,
} from "@/lib/shared/apple-fetch";

/**
 * ⚠ THE KEY POOL IS OPTED INTO HERE, AND ONLY HERE.
 *
 * Every Apple call made by IAP Management routes through this function, so
 * one argument turns pooling on for the whole module. CPP's `ascFetch` calls
 * `appleFetch` without it and is unaffected — not by convention but because
 * it does not import `iapKeyPool` and has nothing to pass
 * (`[Q-RATELIMIT.pool-scope]`).
 *
 * ⚠ Passing the pool is not the same as using a pool key. `selectKey` falls
 * back to the account's own credentials whenever the account has no pool
 * keys, which is the normal state for an account nobody has seeded yet. An
 * account gains pooling by having keys registered, never by a code change
 * here.
 */
export async function iapFetch<T>(
  creds: AscCredentials,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  return appleFetch<T>(creds, method, endpoint, body, "iap-apple", {
    keyPool: iapKeyPool,
  });
}
