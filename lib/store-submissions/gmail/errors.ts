/**
 * Error hierarchy for the Gmail sync pipeline.
 *
 * Each class carries an optional `cause` (the underlying thrown value from
 * googleapis / network / DB) and serializes cleanly via `toJSON()` so sync
 * logs + Sentry breadcrumbs don't lose the original context.
 *
 * Classification:
 *   - `RefreshTokenInvalidError` → terminal for the sync run; Manager must
 *     reconnect Gmail from Settings. Surfaces as a banner in the UI.
 *   - `GmailHistoryExpiredError` → recoverable; sync orchestrator falls
 *     back to `messages.list` full scan.
 *   - `GmailRateLimitError` → recoverable; retry wrapper backs off, or
 *     orchestrator returns partial stats and next tick resumes.
 *   - `GmailTokenExpiredError` → shouldn't surface if `ensureFreshToken`
 *     runs correctly, kept for defensive catch at the edge.
 *   - `EmailParseError` → per-message; orchestrator marks that message
 *     ERROR and continues the batch.
 */

/**
 * `cause` may be a GaxiosError, a plain Error, or any unknown thrown
 * value. Flatten it into something JSON-safe so the caller's structured
 * logger doesn't choke on circular refs or class instances.
 */
function serializeCause(cause: unknown): unknown {
  if (cause == null) return undefined;
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      // GaxiosError tacks response.status + response.data.error onto the
      // error object — preserve if present so we don't have to re-parse.
      ...(typeof (cause as { code?: unknown }).code !== 'undefined' && {
        code: (cause as { code?: unknown }).code,
      }),
      ...(typeof (cause as { status?: unknown }).status !== 'undefined' && {
        status: (cause as { status?: unknown }).status,
      }),
    };
  }
  if (typeof cause === 'object') {
    try {
      return JSON.parse(JSON.stringify(cause));
    } catch {
      return String(cause);
    }
  }
  return String(cause);
}

export class GmailSyncError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GmailSyncError';
    this.cause = cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      ...(this.cause !== undefined && { cause: serializeCause(this.cause) }),
    };
  }
}

/**
 * Gmail is not connected yet (no singleton row in `gmail_credentials`).
 * Sync should exit early with a clear log — not treated as a failure to
 * bump `consecutive_failures`, since nothing is broken, just unconfigured.
 */
export class GmailNotConnectedError extends GmailSyncError {
  constructor() {
    super(
      'Gmail is not connected. Connect the shared mailbox from Settings before running sync.',
    );
    this.name = 'GmailNotConnectedError';
  }
}

/**
 * Google returned `invalid_grant` (or equivalent) when refreshing the
 * access token — user revoked access at
 * https://myaccount.google.com/permissions, or the refresh token was
 * cycled server-side. Recovery: Manager must reconnect Gmail.
 *
 * The orchestrator bumps `gmail_sync_state.consecutive_failures` before
 * throwing so the UI banner + Sentry alert fire on the first occurrence.
 */
export class RefreshTokenInvalidError extends GmailSyncError {
  constructor(cause?: unknown) {
    super(
      'Gmail refresh token is invalid or revoked. Reconnect Gmail from Settings.',
      cause,
    );
    this.name = 'RefreshTokenInvalidError';
  }
}

/**
 * Thrown by the retry wrapper when Gmail returns 429 and all retries are
 * exhausted, or by the orchestrator when the daily quota is hit. Carries
 * a `retryAfterMs` hint derived from the `Retry-After` header when Google
 * sets one; otherwise `null` and caller uses its own backoff.
 */
export class GmailRateLimitError extends GmailSyncError {
  readonly retryAfterMs: number | null;

  constructor(retryAfterMs: number | null, cause?: unknown) {
    super(
      `Gmail API rate limit (429). ${
        retryAfterMs !== null
          ? `Retry after ${retryAfterMs}ms.`
          : 'Retry on next sync tick.'
      }`,
      cause,
    );
    this.name = 'GmailRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * `users.history.list` returned 404 — the stored `last_history_id` is
 * older than Gmail's 7-day retention window. Recoverable: orchestrator
 * falls back to `users.messages.list` with a label filter.
 */
export class GmailHistoryExpiredError extends GmailSyncError {
  constructor(cause?: unknown) {
    super(
      'Gmail historyId expired (404). Falling back to messages.list full scan.',
      cause,
    );
    this.name = 'GmailHistoryExpiredError';
  }
}

/**
 * Defensive: thrown when a Gmail API call returns 401 after
 * `ensureFreshToken` succeeded. Usually indicates a clock skew or a race
 * between token refresh and Gmail server propagation.
 */
export class GmailTokenExpiredError extends GmailSyncError {
  constructor(cause?: unknown) {
    super(
      'Gmail API returned 401 despite a freshly-refreshed token. Clock skew or token propagation race.',
      cause,
    );
    this.name = 'GmailTokenExpiredError';
  }
}

/**
 * Thrown by the MIME parser when a message payload cannot be decoded
 * (corrupt base64, missing required headers, etc). The orchestrator
 * catches this per-message and marks `email_messages.classification_status`
 * = 'ERROR', logs to `sync_logs.emails_errored`, and continues the batch.
 */
export class EmailParseError extends GmailSyncError {
  readonly gmailMsgId: string;

  constructor(gmailMsgId: string, reason: string, cause?: unknown) {
    super(`Failed to parse Gmail message ${gmailMsgId}: ${reason}`, cause);
    this.name = 'EmailParseError';
    this.gmailMsgId = gmailMsgId;
  }
}

/**
 * Raised when `runSync()` cannot acquire the sync lock because another
 * invocation is already in progress (and its lock is still fresh). The
 * cron endpoint maps this to HTTP 409. Not a persistent error — the next
 * cron tick retries naturally.
 */
export class SyncInProgressError extends GmailSyncError {
  constructor() {
    super('Another Gmail sync is already in progress.');
    this.name = 'SyncInProgressError';
  }
}

/**
 * Best-effort classification of an unknown thrown value as an `invalid_grant`
 * response from Google's OAuth token endpoint. Checks both the googleapis
 * GaxiosError shape (response.data.error) and plain string messages so
 * callers don't have to couple to googleapis types.
 */
export function isInvalidGrantError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const gax = err as {
    response?: { data?: { error?: string; error_description?: string } };
    message?: string;
  };

  if (gax.response?.data?.error === 'invalid_grant') return true;
  if (typeof gax.message === 'string' && /invalid_grant/i.test(gax.message)) {
    return true;
  }
  return false;
}

/**
 * Best-effort detection of Gmail's 404 "start history expired" response.
 * Gmail surfaces this as a `GaxiosError` with `code === 404`; we also
 * check message content for robustness across googleapis versions.
 */
export function isHistoryExpiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const gax = err as {
    code?: number | string;
    status?: number;
    response?: { status?: number; data?: { error?: { message?: string } } };
    message?: string;
  };
  const code = Number(gax.code ?? gax.status ?? gax.response?.status);
  if (code === 404) return true;
  if (
    typeof gax.message === 'string' &&
    /history.*(expired|not.?found)/i.test(gax.message)
  ) {
    return true;
  }
  return false;
}

/**
 * Best-effort detection of HTTP 429 / rate-limit-ish responses. Gmail
 * uses 429 for `userRateLimitExceeded` + `rateLimitExceeded`; 403 with a
 * specific reason is also possible, but rarer — keep this strict to 429
 * so we don't retry legit auth/permission failures.
 */
export function isRateLimitError(err: unknown): {
  rateLimited: boolean;
  retryAfterMs: number | null;
} {
  if (!err || typeof err !== 'object') {
    return { rateLimited: false, retryAfterMs: null };
  }
  const gax = err as {
    code?: number | string;
    status?: number;
    response?: {
      status?: number;
      headers?: Record<string, string | string[] | undefined>;
    };
  };
  const code = Number(gax.code ?? gax.status ?? gax.response?.status);
  if (code !== 429) return { rateLimited: false, retryAfterMs: null };

  const headerVal = gax.response?.headers?.['retry-after'];
  const retryAfter = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (typeof retryAfter === 'string' && retryAfter.length > 0) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) {
      return { rateLimited: true, retryAfterMs: Math.max(0, secs) * 1000 };
    }
  }
  return { rateLimited: true, retryAfterMs: null };
}
