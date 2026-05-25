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
 * Cycle 40 Phase A — parse Apple's `X-Rate-Limit` header so Railway logs
 * surface per-request budget consumption. Apple emits a semicolon-delimited
 * key/value list, e.g.:
 *
 *     X-Rate-Limit: user-hour-lim:3600;user-hour-rem:1450;
 *
 * Returns `{ limit, remaining }` when both fields parse cleanly, otherwise
 * null (defensive — Apple does not always emit the header, and the parser
 * must never throw out of a successful request just because of header
 * absence).
 *
 * Phase A intentionally observes only — no proactive throttling, no token
 * bucket. The empirical budget data this surface gathers in production
 * determines whether Phase B (token bucket + universal ascFetch refactor)
 * is justified.
 */
export interface RateLimitInfo {
  limit: number;
  remaining: number;
}

export function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const raw = headers.get("x-rate-limit");
  if (!raw) return null;
  let limit: number | null = null;
  let remaining: number | null = null;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep < 0) continue;
    const key = trimmed.slice(0, sep).trim().toLowerCase();
    const value = trimmed.slice(sep + 1).trim();
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    if (key === "user-hour-lim") limit = n;
    else if (key === "user-hour-rem") remaining = n;
  }
  if (limit === null || remaining === null) return null;
  return { limit, remaining };
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

  const startedAt = Date.now();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const durationMs = Date.now() - startedAt;

  await log(
    "iap-apple",
    `[${creds.keyId}] ${method} ${endpoint} → ${res.status}`,
  );

  // Cycle 40 Phase A — Apple ASC budget visibility. Emit a grep-friendly
  // `[asc-client]` tagged line only when Apple returned X-Rate-Limit so
  // Manager can audit budget consumption through Railway logs without
  // changing the read shape for endpoints that omit the header.
  const budget = parseRateLimit(res.headers);
  if (budget) {
    await log(
      "iap-apple",
      `[asc-client] ${method} ${endpoint} → ${res.status} budget=${budget.remaining}/${budget.limit} duration=${durationMs}ms`,
    );
  }

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
