/**
 * Apple App Store Connect — shared fetch wrapper with rate-limit retry.
 *
 * Extracted during the IAP reviewSubmissions v2 migration. Previously this
 * logic existed twice: `lib/iap-management/apple/fetch.ts` (429 detection +
 * backoff) and `lib/asc-client.ts`'s private `ascFetch` (CPP-side, no 429
 * protection at all). Both modules now funnel through `appleFetch` here —
 * CPP gains 429 detection + budget logging for free; IAP's `iapFetch` and
 * `withRetry` become thin re-exports so existing call sites/tests are
 * unaffected.
 *
 * Composition: `appleFetch` is retry-NAIVE (throws AppleRateLimitError on
 * 429). Callers wrap with `withRetry(() => appleFetch(...))` when retry is
 * wanted.
 */

import { generateAscToken, type AscCredentials } from "@/lib/asc-jwt";
import { log } from "@/lib/logger";

const ASC_BASE_URL = "https://api.appstoreconnect.apple.com";

/** Ordered delays (ms) between retry attempts. Length determines maxRetries. */
const DEFAULT_BACKOFF_MS = [500, 1000, 2000] as const;

/** Cap delay at 10s — bulk operation progress UI takes over otherwise. */
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
  /** Invoked once per 429 that triggers a backoff sleep. Use for per-call
   *  telemetry: count 429s, accumulate backoff_total_ms, surface in
   *  audit-log rows / progress UI. Not called when the call succeeds on the
   *  first attempt or fails with a non-rate-limit error. */
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
 * Parse Apple's `X-Rate-Limit` header so Railway logs surface per-request
 * budget consumption. Apple emits a semicolon-delimited key/value list, e.g.:
 *
 *     X-Rate-Limit: user-hour-lim:3600;user-hour-rem:1450;
 *
 * Returns `{ limit, remaining }` when both fields parse cleanly, otherwise
 * null (defensive — Apple does not always emit the header, and the parser
 * must never throw out of a successful request just because of header
 * absence).
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
    // ⚠ NOT `Number(value)`. `Number("")` is **0**, not NaN, so an empty
    // component (`user-hour-rem:;`) used to parse as `remaining: 0` —
    // "budget exhausted" — when the truth is "unreadable". Those are two
    // different facts and only one of them is a reason to stop working.
    // Today the cost is one wrong log line; the moment anything reads
    // `remaining` to decide whether to keep going, it is the difference
    // between a job that pauses for cause and a job frozen for none.
    //
    // A digits-only match rejects every shape that cannot be a reading —
    // "" and " " (empty), "abc" (NaN), "-5" (negative budget is not a
    // thing), "1e3" / "0x10" (finite but not what Apple sends) — so a
    // non-reading stays a non-reading instead of becoming a number.
    if (!/^\d+$/.test(value)) continue;
    const n = Number(value);
    if (key === "user-hour-lim") limit = n;
    else if (key === "user-hour-rem") remaining = n;
  }
  if (limit === null || remaining === null) return null;
  return { limit, remaining };
}

/**
 * Thin fetch wrapper for Apple ASC API, shared by both CPP (`ascFetch`) and
 * IAP (`iapFetch`) call sites. Signs a fresh JWT, sets Authorization +
 * Content-Type, parses errors into typed exceptions, and returns parsed
 * JSON (or `undefined` for 204).
 *
 * NOT retry-wrapped — compose with `withRetry` at the call site.
 *
 * `logTag` groups Railway log lines per caller (`"asc-client"` for CPP,
 * `"iap-apple"` for IAP, etc.) — but the budget line always carries the
 * literal `[asc-client]` marker regardless of tag, preserving the existing
 * grep-friendly convention used to audit Apple rate-limit budget consumption
 * across every Apple API surface in this app.
 */
export async function appleFetch<T>(
  creds: AscCredentials,
  method: string,
  endpoint: string,
  body?: unknown,
  logTag = "apple-fetch",
): Promise<T> {
  const token = await generateAscToken(creds);
  // Accept either a path (`/v1/apps?...`) or a full URL (Apple's
  // `links.next` carries the full origin for some list endpoints).
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${ASC_BASE_URL}${endpoint}`;

  if (body) {
    await log(
      logTag,
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

  await log(logTag, `[${creds.keyId}] ${method} ${endpoint} → ${res.status}`);

  const budget = parseRateLimit(res.headers);
  if (budget) {
    // ⚠ `key=` IS APPENDED, NOT INSERTED. The established audit grep is
    // `[asc-client] … budget=` — adding a trailing k=v field keeps every
    // existing pattern matching, while putting the key id in the middle
    // would break anyone anchoring on `[asc-client] GET`. New field at the
    // end, existing fields untouched, same order.
    //
    // ⚠ Not truncated. `key_id` is documented non-secret in the
    // `asc_accounts` migration, the sibling log lines below already print it
    // in full as `[${creds.keyId}]`, and a 10-char ASC key id abbreviated to
    // a prefix stops being an identifier — which is the entire point of
    // logging it. Attribution per key is unusable if two keys share a prefix.
    await log(
      logTag,
      `[asc-client] ${method} ${endpoint} → ${res.status} budget=${budget.remaining}/${budget.limit} duration=${durationMs}ms key=${creds.keyId}`,
    );
  }

  if (!res.ok) {
    const errBody = await res.text();
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers);
      await log(
        logTag,
        `[${creds.keyId}] ${method} ${endpoint} rate-limited (retry-after=${retryAfterMs}ms)`,
        "WARN",
      );
      throw new AppleRateLimitError(method, endpoint, errBody, retryAfterMs);
    }
    await log(
      logTag,
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
