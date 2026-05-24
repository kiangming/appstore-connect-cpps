/**
 * Apple App Store Connect — IAP-side fetch wrapper with rate-limit retry.
 *
 * Separate from lib/asc-client.ts (CPP-side) because Manager Q-IAP.7 requires
 * 429 detection + Retry-After honoring + exponential backoff for IAP bulk
 * operations (200+ items can saturate Apple's rate limit per community
 * reports). CPP-side ascFetch doesn't have this — its call patterns are
 * sequential and user-paced.
 *
 * JWT reuse: imports `generateAscToken` from @/lib/asc-jwt — same Apple team
 * credential (Q-IAP.1 reuses asc_accounts as-is, no module-specific creds).
 *
 * Composition: `iapFetch` is retry-NAIVE (throws AppleRateLimitError on 429).
 * Callers wrap with `withRetry(() => iapFetch(...))` when retry is wanted —
 * usually true for IAP CRUD; usually false for the upload presigned-PUT chunks
 * (those are short-lived and Apple's CDN doesn't return 429).
 */

import { generateAscToken, type AscCredentials } from "@/lib/asc-jwt";
import { log } from "@/lib/logger";

const ASC_BASE_URL = "https://api.appstoreconnect.apple.com";

/** Ordered delays (ms) between retry attempts. Length determines maxRetries. */
const DEFAULT_BACKOFF_MS = [500, 1000, 2000] as const;

/** Cap delay at 10s — bulk import progress UI takes over otherwise. */
const RETRY_DELAY_CEILING_MS = 10_000;

// ─── Errors ──────────────────────────────────────────────────────────────────

export class AppleApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly method: string;
  readonly body: string;

  constructor(status: number, method: string, endpoint: string, body: string) {
    super(`Apple ASC API error ${status} on ${method} ${endpoint}: ${body}`);
    this.name = "AppleApiError";
    this.status = status;
    this.method = method;
    this.endpoint = endpoint;
    this.body = body;
  }
}

/**
 * Thrown when Apple returns 429. Carries the parsed `retry-after` header so
 * `withRetry` can sleep exactly that long instead of falling back to its
 * default backoff curve.
 */
export class AppleRateLimitError extends AppleApiError {
  readonly retryAfterMs: number | null;

  constructor(
    method: string,
    endpoint: string,
    body: string,
    retryAfterMs: number | null,
  ) {
    super(429, method, endpoint, body);
    this.name = "AppleRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

// ─── Retry wrapper ───────────────────────────────────────────────────────────

export type Sleeper = (ms: number) => Promise<void>;

const defaultSleep: Sleeper = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryAttemptInfo {
  /** 0-indexed attempt number that just failed and is about to sleep. */
  attempt: number;
  /** Computed sleep duration (ms), already capped at RETRY_DELAY_CEILING_MS. */
  delayMs: number;
  /** Retry-After header value Apple sent (ms), or null when absent. */
  retryAfterMs: number | null;
}

export interface RetryOptions {
  /** Backoff delays (ms) between attempts. Default: 500 → 1000 → 2000. */
  backoffMs?: readonly number[];
  /** Injected sleeper for tests — vi.fn() that resolves immediately. */
  sleep?: Sleeper;
  /** Hotfix 26 — invoked once per 429 that triggers a backoff sleep.
   *  Use for per-call telemetry: count 429s, accumulate backoff_total_ms,
   *  surface in audit-log rows / progress UI. Not called when the call
   *  succeeds on the first attempt or fails with a non-rate-limit error. */
  onRetry?: (info: RetryAttemptInfo) => void;
}

/**
 * Retry an async ASC call on 429 only. All other errors (including non-429
 * AppleApiError) propagate unchanged on the first throw.
 *
 * After exhausting retries on 429, re-throws the last `AppleRateLimitError`
 * carrying the most recent Retry-After hint.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;
  const onRetry = options.onRetry;

  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof AppleRateLimitError)) {
        throw err;
      }
      if (attempt === backoff.length) {
        throw err;
      }
      const delay = Math.min(
        err.retryAfterMs ?? backoff[attempt],
        RETRY_DELAY_CEILING_MS,
      );
      if (onRetry) {
        onRetry({ attempt, delayMs: delay, retryAfterMs: err.retryAfterMs });
      }
      await sleep(delay);
    }
  }

  // Unreachable — loop either returns or throws on every path.
  throw new Error("withRetry exhausted without return — should be unreachable.");
}

// ─── Fetch helper ────────────────────────────────────────────────────────────

/**
 * Parse `Retry-After`. Apple typically sets seconds (integer); HTTP-date is
 * also valid per RFC 9110. Returns ms, or null if header missing/malformed.
 */
function parseRetryAfter(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(retryAfter);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

/**
 * Thin fetch wrapper for Apple ASC API. Signs a fresh JWT, sets
 * Authorization + Content-Type, parses errors into typed exceptions, and
 * returns parsed JSON (or `undefined` for 204).
 *
 * NOT retry-wrapped — compose with `withRetry` at the call site.
 */
export async function iapFetch<T>(
  creds: AscCredentials,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const token = await generateAscToken(creds);
  const url = `${ASC_BASE_URL}${endpoint}`;

  if (body) {
    await log(
      "iap-apple",
      `[${creds.keyId}] ${method} ${endpoint} body: ${JSON.stringify(body)}`,
    );
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  await log(
    "iap-apple",
    `[${creds.keyId}] ${method} ${endpoint} → ${res.status}`,
  );

  if (!res.ok) {
    const errBody = await res.text();
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers);
      await log(
        "iap-apple",
        `[${creds.keyId}] ${method} ${endpoint} rate-limited (retry-after=${retryAfterMs}ms)`,
        "WARN",
      );
      throw new AppleRateLimitError(method, endpoint, errBody, retryAfterMs);
    }
    await log(
      "iap-apple",
      `[${creds.keyId}] ${method} ${endpoint} ERROR ${res.status}: ${errBody}`,
      "ERROR",
    );
    throw new AppleApiError(res.status, method, endpoint, errBody);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}
