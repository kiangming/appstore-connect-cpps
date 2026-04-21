/**
 * Gmail API client wrapper for the sync pipeline.
 *
 * Factors out three concerns from the sync orchestrator (7.3):
 *   1. **Client creation** — `createGmailClient()` calls
 *      `ensureFreshToken()` and hands back a `googleapis` Gmail client
 *      with a fresh bearer token.
 *   2. **Retry on 429** — `withRetry()` wraps each API call with
 *      exponential backoff (three retries, 500→1000→2000ms +
 *      `Retry-After` header honored when present).
 *   3. **Thin typed wrappers** — `listHistory` / `listMessages` /
 *      `getMessage` translate the verbose Gmail response shape into the
 *      smaller shape the orchestrator actually uses.
 *
 * No persistence, no logging — pass-through to the Gmail SDK with
 * narrower contracts. All Gmail-specific error translation (404 → history
 * expired, 429 → rate limit) funnels through `./errors`.
 *
 * No `oauth2.on('tokens')` listener is registered here. Token refresh is
 * proactive via `ensureFreshToken()` (called inside `createGmailClient`).
 * Dual-persistence (listener + manual) was deliberately rejected — see
 * PR-7 design notes.
 */

import { google, type gmail_v1 } from 'googleapis';

import { ensureFreshToken } from './credentials';
import {
  GmailHistoryExpiredError,
  GmailRateLimitError,
  isHistoryExpiredError,
  isRateLimitError,
} from './errors';
import { getOAuthClient } from './oauth';

export type GmailClient = gmail_v1.Gmail;

/** Ordered delays (ms) between retry attempts. Length determines maxRetries. */
const DEFAULT_BACKOFF_MS = [500, 1000, 2000] as const;

/**
 * Build a Gmail API client authorized with a fresh access_token.
 *
 * `ensureFreshToken()` guarantees the returned credentials are not inside
 * the 5-min expiry buffer, so the orchestrator doesn't need to worry
 * about mid-request refresh. A long sync batch (≥5 min wall time) would
 * need per-call re-checks; current maxBatch=50 × O(100ms) per `get` keeps
 * us well under that budget.
 */
export async function createGmailClient(): Promise<GmailClient> {
  const creds = await ensureFreshToken();
  const oauth2 = getOAuthClient();
  oauth2.setCredentials({
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
    expiry_date: creds.token_expires_at.getTime(),
    scope: creds.scopes.join(' '),
    token_type: 'Bearer',
  });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

/**
 * Inject `sleep` via DI so tests can skip real wall time. Production
 * callers pass `setTimeout`-based sleep; tests pass a vi.fn().
 */
export type Sleeper = (ms: number) => Promise<void>;

const defaultSleep: Sleeper = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RetryOptions {
  /** Backoff delays between attempts. Default: 500→1000→2000ms. */
  backoffMs?: readonly number[];
  /** Injected sleeper; for tests. */
  sleep?: Sleeper;
}

/**
 * Retry an async Gmail call on 429 only. Other errors propagate
 * unchanged. 404 on history.list is translated to
 * `GmailHistoryExpiredError` here so callers can `instanceof` check
 * without reimplementing the detection.
 *
 * After exhausting retries on 429, throws `GmailRateLimitError` carrying
 * the last `Retry-After` hint (if any). The orchestrator surfaces this as
 * a partial batch result and the next cron tick resumes.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // 404 on history.list is not retryable — translate and throw so
      // the orchestrator switches to fallback mode.
      if (isHistoryExpiredError(err)) {
        throw new GmailHistoryExpiredError(err);
      }

      const { rateLimited, retryAfterMs } = isRateLimitError(err);
      if (!rateLimited) {
        throw err;
      }

      if (attempt === backoff.length) {
        throw new GmailRateLimitError(retryAfterMs, err);
      }

      // Honor Retry-After when Google sets it, otherwise fall back to
      // the configured backoff curve. Capping at a reasonable ceiling
      // prevents a 1h Retry-After from blocking the entire sync tick.
      const delay = Math.min(
        retryAfterMs ?? backoff[attempt],
        10_000, // 10s ceiling — next cron tick takes over otherwise
      );
      await sleep(delay);
    }
  }

  // Unreachable — the loop either returns or throws. TS can't see that.
  throw new Error('withRetry exhausted without return — should be unreachable.');
}

/**
 * Narrowed shape returned by `listHistory`. We drop the full `history[]`
 * array and expose just the set of added message IDs plus pagination
 * cursors — the orchestrator doesn't care about the messagesDeleted /
 * labelAdded subtypes yet.
 */
export interface HistoryDelta {
  messageIds: string[];
  nextHistoryId: string | null;
  nextPageToken: string | null;
}

export async function listHistory(
  client: GmailClient,
  params: {
    startHistoryId: string;
    pageToken?: string;
    maxResults?: number;
  },
  retryOptions?: RetryOptions,
): Promise<HistoryDelta> {
  const res = await withRetry(
    () =>
      client.users.history.list({
        userId: 'me',
        startHistoryId: params.startHistoryId,
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
        maxResults: params.maxResults ?? 100,
        pageToken: params.pageToken,
      }),
    retryOptions,
  );

  const messageIds = new Set<string>();
  for (const h of res.data.history ?? []) {
    for (const added of h.messagesAdded ?? []) {
      const id = added.message?.id;
      if (id) messageIds.add(id);
    }
  }

  return {
    messageIds: [...messageIds],
    nextHistoryId: res.data.historyId ?? null,
    nextPageToken: res.data.nextPageToken ?? null,
  };
}

/**
 * Narrowed shape for `listMessages`. Same pattern — we drop Gmail's
 * nested message stubs and return just IDs + cursor.
 */
export interface MessagesListResult {
  messageIds: string[];
  nextPageToken: string | null;
  resultSizeEstimate: number;
}

export async function listMessages(
  client: GmailClient,
  params: {
    query: string;
    pageToken?: string;
    maxResults?: number;
  },
  retryOptions?: RetryOptions,
): Promise<MessagesListResult> {
  const res = await withRetry(
    () =>
      client.users.messages.list({
        userId: 'me',
        q: params.query,
        maxResults: params.maxResults ?? 50,
        pageToken: params.pageToken,
      }),
    retryOptions,
  );

  return {
    messageIds: (res.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string'),
    nextPageToken: res.data.nextPageToken ?? null,
    resultSizeEstimate: res.data.resultSizeEstimate ?? 0,
  };
}

export async function getMessage(
  client: GmailClient,
  messageId: string,
  retryOptions?: RetryOptions,
): Promise<gmail_v1.Schema$Message> {
  const res = await withRetry(
    () =>
      client.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      }),
    retryOptions,
  );
  return res.data;
}

/**
 * Retrieve the current historyId for the authenticated mailbox. Used by
 * the fallback flow to seed `gmail_sync_state.last_history_id` after a
 * full-scan catch-up, so the next tick can go back to incremental.
 */
export async function getCurrentHistoryId(
  client: GmailClient,
  retryOptions?: RetryOptions,
): Promise<string | null> {
  const res = await withRetry(
    () => client.users.getProfile({ userId: 'me' }),
    retryOptions,
  );
  return res.data.historyId ?? null;
}
