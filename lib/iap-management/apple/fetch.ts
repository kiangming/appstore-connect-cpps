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
 * One argument turns pooling on for every call that comes through THIS
 * function. CPP's `ascFetch` calls `appleFetch` without it — not by convention
 * but because it does not import `iapKeyPool` and has nothing to pass
 * (`[Q-RATELIMIT.pool-scope]`).
 *
 * ─── ⚠⚠ CORRECTION 2026-09-04 — THIS COMMENT USED TO CLAIM SOMETHING FALSE ──
 *
 * It said: *"**Every** Apple call made by IAP Management routes through this
 * function, so one argument turns pooling on for the whole module."* **That is
 * WRONG, and it is the most load-bearing wrong sentence in the pool design** —
 * anyone who believed it would conclude the pool protects the whole module, and
 * would reason about rate limits on a model that does not match production.
 *
 * ⚠ **ELEVEN IAP-MANAGEMENT ENTRY POINTS BYPASS THIS FUNCTION ENTIRELY.** They
 * import `@/lib/asc-client`, whose `ascFetch` (asc-client.ts:57-64) passes NO
 * pool, so they sign with the ACCOUNT's own key from `public.asc_accounts` —
 * not with a pool key. Measured by
 * `grep -rn 'from "@/lib/asc-client"' app/api/iap-management app/(dashboard)/iap-management lib/iap-management`:
 *
 *     app/(dashboard)/iap-management/apps/[appId]/page.tsx:2,81   ← the IAP
 *                                            LIST PAGE, on every single load
 *     app/(dashboard)/iap-management/apps/[appId]/iaps/[iapId]/page.tsx:10,42
 *     app/(dashboard)/iap-management/apps/[appId]/iaps/[iapId]/view/page.tsx:7,48
 *     app/(dashboard)/iap-management/apps/[appId]/iaps/new/page.tsx:7,29
 *     app/(dashboard)/iap-management/apps/[appId]/bulk-import/page.tsx:2,53
 *     app/(dashboard)/iap-management/apps/page.tsx:2                (getApps)
 *     app/api/iap-management/apps/[appId]/iaps/route.ts:7,77
 *     app/api/iap-management/apps/[appId]/iaps/sync-states/route.ts:39,117
 *     app/api/iap-management/apps/[appId]/bulk-import/execute/route.ts:40,400
 *     app/api/iap-management/pricing-templates/route.ts:14,148
 *     app/api/iap-management/asc-apps/route.ts:7                    (getApps)
 *
 * ⚠ AND THE TWO PATHS ARE NOT ISOLATED BY STRUCTURE — they meet at the
 * fallback. `selectKey` returns the ACCOUNT's credentials whenever the pool is
 * `empty` (selector.ts:198-200) or unreadable (`error`, :190-196). An account
 * with no pool keys — the normal state, since the pool is opt-in — runs the
 * WHOLE export on the same account key those eleven entry points are spending.
 *
 * ⚠ AND THE POOL CANNOT SEE THAT SPEND. `selectKey` reads only
 * `iap_mgmt.asc_account_keys` (repository.ts:141-146); nothing anywhere reads
 * how much of the account key's own 3,600/hour is left. Budgets are per-key
 * (D1, measured — KB §4.9), so the account key has its own budget and the pool
 * is blind to it.
 *
 * ⇒ The honest statement: **pooling covers the calls that go through
 * `iapFetch`, which is most of the IAP Apple traffic but NOT all of it.**
 * Tracked as `[ASC-CLIENT-outside-pool]`. Before reasoning about any future
 * 429, check which of the two paths the failing call was on — the `pool=`
 * field on the per-request log line answers it.
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
