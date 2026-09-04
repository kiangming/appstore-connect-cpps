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

/**
 * Thrown when every key in an account's pool is cooling down.
 *
 * ⚠ IT EXTENDS `AppleRateLimitError` SO THE SHIPPED LATCHES KEEP WORKING.
 * `export-fetch`, `bulk-availability`, `submit-batch` and `retry-counters`
 * all decide "stop dispatching" with `err instanceof AppleRateLimitError`.
 * A pool with nothing left to hand out cannot serve the next request either
 * way, so it must satisfy them. Not one predicate changes, and none of their
 * tests do either.
 *
 * ⚠⚠ THE ORIGINAL JUSTIFICATION FOR THIS INHERITANCE WAS **MEASURED FALSE ON
 * 2026-09-04**, AND THE SENTENCE HAS BEEN REMOVED RATHER THAN SOFTENED.
 * It read: *"A pool with nothing left to hand out is the same fact those
 * predicates exist to catch — **the budget is gone** — so it must satisfy
 * them."* The premise does not hold: in the incident the pool had nothing
 * left to hand out while Apple's budget was **full**. Two keys read
 * `rem=3599 lim=3600` at 15:31:31, 34m42s after the 429 at 14:56:49 —
 * inside Apple's rolling hour, so that is a real reading, not recovery. The
 * pool was empty because our own cooldown parked 7 keys in 394ms, not
 * because Apple had run out.
 *
 * ⇒ **"Pool empty" and "budget gone" are DIFFERENT FACTS.** The inheritance
 * survives on the narrower, still-true ground stated above — nothing can be
 * sent, so stopping is right — and NOT on the budget claim.
 *
 * ⚠ THIS DISTINCTION IS LOAD-BEARING, AND IT IS WHY THIS NOTE EXISTS RATHER
 * THAN A QUIET EDIT. Because the two facts were treated as one, 6 consumers
 * report a pool exhaustion as Apple rate-limiting us — including the export
 * workbook's failure sheet, where an operator read our own message believing
 * it was Apple's 429 body, and `retry-counters.ts` which adds 3 to
 * `rate429_count` with zero requests sent. Tracked as
 * `[POOL-exhaustion-reported-as-apple-429]`. **Do NOT "restore" the removed
 * sentence, and do NOT remove the inheritance** — the first is false, the
 * second silently un-latches four stop predicates.
 *
 * ⚠ AND `retryAfterMs` IS 0 ON PURPOSE. THIS IS THE FAST EXIT.
 * Because it IS an `AppleRateLimitError`, `withRetry` retries it. Each of
 * those attempts re-enters selection, finds the pool still cooling, and
 * throws again — correct, but with the default curve it would burn
 * 500 + 1000 + 2000 ms of sleeping to learn something already known.
 *
 * `withRetry` computes its delay as
 *     Math.min(err.retryAfterMs ?? backoff[attempt], CEILING)
 * and `??` only falls through for null/undefined — so a literal 0 wins and
 * every sleep becomes `sleep(0)`. The remaining attempts run back-to-back
 * and cost nothing: selection throws BEFORE any fetch, so no Apple request
 * is made on any of them.
 *
 * ⚠ Chosen over adding a field for `withRetry` to inspect because
 * `withRetry` is shared with CPP Manager and with every non-pooled IAP path.
 * Teaching it about key pools would put pool-shaped behaviour on flows that
 * have no pool. This uses a mechanism it already has.
 */
export class ApplePoolExhaustedError extends AppleRateLimitError {
  readonly accountId: string;

  constructor(accountId: string, method: string, endpoint: string) {
    super(
      method,
      endpoint,
      `All ASC pool keys for account "${accountId}" are cooling down.`,
      // ⚠ 0, not null. See the note above — this is the fast exit, not a
      // claim that Apple told us to retry immediately.
      0,
    );
    this.name = "ApplePoolExhaustedError";
    this.accountId = accountId;
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
 * An optional key pool, injected by the caller.
 *
 * ⚠ INJECTED RATHER THAN IMPORTED, AND RATHER THAN A BOOLEAN FLAG. The pool
 * belongs to Apple IAP Management; this file is shared with CPP Manager. A
 * `{ keyPool: true }` flag would mean `lib/shared` importing a feature
 * module — inverting the dependency direction — and would leave the flag
 * settable from anywhere, CPP included. Passing the pool as a value means
 * CPP cannot enable it even by accident: `ascFetch` does not import a pool,
 * so it has nothing to pass. `[Q-RATELIMIT.pool-scope]` is then enforced by
 * the type system rather than by remembering.
 */
export interface AppleKeyPool {
  /** Choose the credentials for ONE request. Must never reject for "no pool
   *  keys" — falling back to the given credentials is the correct answer. */
  select(account: AscCredentials): Promise<{
    creds: AscCredentials;
    fromPool: boolean;
    missReason?: string;
  }>;
  /**
   * Record that this key's budget is spent, so the next attempt skips it.
   *
   * ⚠ Awaited by `appleFetch` before it throws. The durable half of this
   * write is what lets a sibling instance see the cooldown, and C2's
   * batch-close lesson applies: a write whose error nobody inspects fails
   * silently. One DB round-trip on a path that is already sleeping for
   * hundreds of milliseconds is not a latency concern.
   */
  onRateLimited(
    accountId: string,
    keyId: string,
    retryAfterMs: number | null,
  ): Promise<void>;
}

export interface AppleFetchOptions {
  keyPool?: AppleKeyPool;
  /**
   * Observe this response's rate-limit budget. Called once, right where the
   * header is already parsed, with `null` when Apple did not send one.
   *
   * ⚠ WHY A CALLBACK AND NOT A CHANGED RETURN TYPE. `appleFetch` returns the
   * parsed body, and ~37 call sites depend on that. Widening the return to
   * `{ data, budget }` would touch every one of them to serve a single
   * caller — the pool-key Test button, which needs `rem/lim` on screen.
   *
   * ⚠ AND WHY NOT A SECOND FETCH PATH. `generateAscToken` is called in
   * exactly ONE place in this repo — the line below — and that invariant is
   * what let the key pool ship as a single change rather than as an audit of
   * every Apple caller. A route that minted its own JWT to read a header
   * would be the second place, permanently, and would bypass pooling,
   * logging and 429 handling. Additive callback; nothing else moves.
   *
   * ⚠ THROWING FROM HERE CANNOT BREAK THE REQUEST. The call is wrapped: an
   * observer that fails is an observer bug, not a reason to fail an Apple
   * call that already succeeded.
   */
  onRateLimitInfo?: (info: RateLimitInfo | null) => void;
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
  account: AscCredentials,
  method: string,
  endpoint: string,
  body?: unknown,
  logTag = "apple-fetch",
  opts?: AppleFetchOptions,
): Promise<T> {
  // ⚠ SELECTED HERE, PER INVOCATION — this placement is the entire design.
  // `withRetry` re-runs the whole `fn()` on every attempt, and `fn` calls
  // this function, so each retry lands on this line again and can be handed
  // a DIFFERENT key. Rotation therefore happens inside the retry curve with
  // no signature change at any of the ~37 call sites, and `withRetry` never
  // learns that keys exist.
  //
  // Hoisting this above `withRetry` — selecting once per operation — would
  // freeze the key for all four attempts and make retrying a spent key
  // pointless. `selector.test.ts` and `apple-fetch.test.ts` both pin it.
  const selection = opts?.keyPool
    ? await opts.keyPool.select(account)
    : { creds: account, fromPool: false };
  const creds = selection.creds;

  /**
   * [#6] WHICH KEY, AND WHETHER IT CAME FROM THE POOL — on every request.
   *
   * ⚠ THE SILENT CASE WAS THE DANGEROUS ONE. `selectKey` returns
   * `missReason:"empty"` with NO LOG AT ALL (selector.ts:198-200), which is
   * exactly the state "the Manager seeded a key but this account is not the
   * one it landed under". From the logs that was indistinguishable from a
   * working pool, and it is why the cooldown incident could not be diagnosed
   * from Railway alone.
   *
   * ⚠ APPENDED TO THE EXISTING PER-REQUEST LINE, NOT A NEW ONE. A separate
   * line would fire hundreds of times per export for no extra information —
   * the line below already runs once per request and already carries the key
   * id. Same convention as the `key=` field on the budget line (§4.9): new
   * field at the end, every existing grep keeps matching.
   *
   * ⚠ AND IT NAMES THE MISS REASON, not just yes/no. "no pool keys for this
   * account" and "the pool read failed" are different operator problems with
   * different fixes; collapsing them to `pool=no` would need a second
   * investigation to tell them apart.
   */
  const poolField = opts?.keyPool
    ? selection.fromPool
      ? "pool=key"
      : `pool=off(${selection.missReason ?? "unknown"})`
    : "pool=n/a";

  if (opts?.keyPool && !selection.fromPool && selection.missReason === "exhausted") {
    // ⚠ THROWN BEFORE ANY REQUEST IS SENT. K2 fell back to the account key
    // here and logged a warning, explicitly as a stopgap. Now that cooldowns
    // are durable, "every pool key is spent" is a fact worth acting on
    // rather than papering over: falling back would spend the account key's
    // own budget to keep a doomed batch moving, and the shipped stop latches
    // would never learn the run should stop.
    //
    // ⚠ "empty" does NOT come here. An account with no pool keys is normal —
    // the pool is opt-in — and still falls through to its own key silently.
    await log(
      logTag,
      `[key-pool] account=${account.id} ALL POOL KEYS COOLING DOWN — refusing ${method} ${endpoint} without sending it`,
      "WARN",
    );
    throw new ApplePoolExhaustedError(account.id, method, endpoint);
  }

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

  await log(
    logTag,
    `[${creds.keyId}] ${method} ${endpoint} → ${res.status} ${poolField}`,
  );

  const budget = parseRateLimit(res.headers);
  // ⚠ GUARDED, AND IT IS NOT DEFENSIVE HABIT. This is an OBSERVER on a path
  // that has already done the expensive, side-effecting thing: the request is
  // sent and Apple has answered. Letting a caller's callback throw here would
  // convert a successful Apple call into a failure — and on a retry-wrapped
  // path, into three more requests. The observer's failure is logged so it is
  // not silent, and then the request continues exactly as if no observer had
  // been passed.
  if (opts?.onRateLimitInfo) {
    try {
      opts.onRateLimitInfo(budget);
    } catch (err) {
      await log(
        logTag,
        `onRateLimitInfo observer threw (ignored): ${err instanceof Error ? err.message : String(err)}`,
        "WARN",
      );
    }
  }
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
    //
    // ⚠ [N2, 2026-09-04] `pool=` IS APPENDED HERE TOO, and the reason is a
    // real diagnostic seam rather than tidiness. `budget=` only exists on
    // endpoints that send `x-rate-limit`, and `pool=` used to live ONLY on the
    // per-request line above — so answering "which key, from the pool or not,
    // with how much budget left" meant JOINING TWO LOG LINES by endpoint and
    // timestamp. During the cooldown investigation a `/v1/territories` line
    // was read as evidence that the pool field was missing, when in fact the
    // pooled line was simply a different line. One line now answers all three.
    //
    // ⚠ Still appended at the END, after `key=`, for the same reason `key=`
    // was: the established audit grep is `[asc-client] … budget=`, and every
    // existing pattern keeps matching when new fields go on the tail.
    await log(
      logTag,
      `[asc-client] ${method} ${endpoint} → ${res.status} budget=${budget.remaining}/${budget.limit} duration=${durationMs}ms key=${creds.keyId} ${poolField}`,
    );
  }

  if (!res.ok) {
    const errBody = await res.text();
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers);
      // ⚠ MARKED BEFORE THE THROW, NOT AFTER. `withRetry` catches this error,
      // sleeps, and calls straight back into selection — so a key marked
      // after the throw is still eligible when the retry runs, and the retry
      // re-picks the key Apple just refused. Too late by exactly one attempt,
      // in the one situation rotation exists for.
      if (opts?.keyPool && selection.fromPool) {
        await opts.keyPool.onRateLimited(account.id, creds.keyId, retryAfterMs);
      }
      // ⚠ [#4] APPLE'S OWN WORDS ON THE 429, WHICH THIS LINE USED TO DROP.
      // The non-429 branch below has always logged `errBody` (:477-481); only
      // this branch left it out — and it is the branch where the body is the
      // whole diagnosis. Apple answers a 429 with a JSON `errors[]` carrying
      // `code` and `detail`, and without it "rate limited" cannot be told
      // apart from a per-second/concurrency refusal. That distinction is
      // exactly what the cooldown misattribution incident turned on: seven
      // keys were parked for an hour on a signal nobody had read.
      //
      // ⚠ `errBody` was ALREADY IN SCOPE (:425). Nothing new is read, no
      // extra request is made, and the response was consumed either way.
      //
      // ⚠ Truncated at 500. Enough for `errors[0].code` + `detail`; short
      // enough that a burst of 429s cannot flood Railway. The untruncated
      // body still reaches the export workbook's failure sheet via
      // `AppleApiError.message` (:37 → export-fetch.ts:162).
      await log(
        logTag,
        `[${creds.keyId}] ${method} ${endpoint} rate-limited (retry-after=${retryAfterMs}ms) ${poolField} body=${errBody.slice(0, 500)}`,
        "WARN",
      );
      // ⚠ K3.4's ONE-OFF HEADER DUMP HAS BEEN REMOVED — its event happened.
      // It printed the full header list on the first natural 429 so we could
      // learn, for free, whether Apple sends `Retry-After` on an endpoint that
      // omits `x-rate-limit`. It fired on 2026-09-04 and the answer is in
      // KB §4.9: BOTH headers absent on
      // `/v1/inAppPurchasePriceSchedules/{id}/automaticPrices`. The line said
      // "once it has appeared: record it in KB §4.9 and this line can go", so
      // it is gone rather than left printing an answer we already have.
      //
      // ⚠ WHAT REPLACED IT IS NOT NOTHING. The 429 line above now carries
      // Apple's `body=` (#4) and `pool=` (#6), which is strictly more than the
      // header dump gave and is useful on every 429, not just the first.
      // ⚠ THE BACKOFF SLEEP IS NOW ARGUABLY UNNECESSARY, AND STAYS ANYWAY.
      // `withRetry`'s curve was tuned for same-key recovery: wait, then ask
      // the SAME key again. With a pool the next attempt uses a DIFFERENT
      // key, which has its own budget, so the wait buys nothing for that
      // attempt. It is not removed, for two reasons. `withRetry` is shared
      // with CPP and with every non-pooled IAP path, where the sleep is still
      // load-bearing — a pool-shaped optimisation there would be a
      // regression. And an unpaced burst across N keys reaches Apple N times
      // faster, which is how you exhaust a whole pool instead of one key.
      // Slightly-too-slow is the safe error here. Do not "fix" this by
      // shortening the curve inside `withRetry`.
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
