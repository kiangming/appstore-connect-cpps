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

export async function iapFetch<T>(
  creds: AscCredentials,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  return appleFetch<T>(creds, method, endpoint, body, "iap-apple");
}
