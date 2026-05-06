/**
 * Gmail sync orchestrator (PR-7 Chunk 7.3.1).
 *
 * **Responsibility:** fetch new messages from Gmail, parse them, route
 * to the classifier, and persist everything to `store_mgmt.email_messages`.
 * That's it — `ticket_id` stays NULL. Wiring `email_messages` → tickets
 * is PR-8 (ticket engine) and PR-9 (thread grouping).
 *
 * **Option A sync** (decision confirmed in the PR-7 kickoff): we persist
 * classification results at this layer and defer the ticket-engine wire
 * to a later PR. Downstream readers (Inbox UI in PR-10+) will see rows
 * with `classification_status = CLASSIFIED / DROPPED / UNCLASSIFIED_* /
 * ERROR` and no attached ticket. Once PR-8 lands, the ticket engine
 * consumes `email_messages.classification_status = 'CLASSIFIED'` rows
 * and back-fills `ticket_id`.
 *
 * **Concurrency.** Two runs must never race on the same batch. Options
 * considered:
 *   - `pg_try_advisory_lock` (session-scoped): broken under Supabase's
 *     PostgREST connection pool — the lock doesn't persist across the
 *     ~20 separate DB calls of one sync run.
 *   - Row lock on `gmail_sync_state` row 1 via atomic UPDATE with a
 *     staleness predicate: works under pooling, acquired + released via
 *     RPCs in migration 20260420000000. CHOSEN.
 *
 * **Failure handling per spec §6.**
 *   - `SyncInProgressError`    — lock busy → endpoint returns 409.
 *   - `GmailNotConnectedError` — no credentials row → endpoint 412.
 *   - `RefreshTokenInvalidError` — `ensureFreshToken` already bumped the
 *     counter + stamped `last_error`; we rethrow. Endpoint returns 401.
 *   - `GmailHistoryExpiredError` — caught here + switched to FALLBACK.
 *     Invisible to the endpoint (success path).
 *   - `GmailRateLimitError` — caught PER-API-CALL by the client wrapper;
 *     if retries exhaust, the sync run aborts, the error is recorded,
 *     endpoint returns 500. Next tick retries.
 *   - `EmailParseError` (per message) — caught in `processMessage`,
 *     marked `classification_status = ERROR` in `email_messages`, batch
 *     continues.
 *   - Unknown error — `recordSyncFailure` bumps counter, rethrow.
 *
 * **Cursor advancement.** `last_history_id` only advances when the
 * batch completed with zero per-message errors. Any error → leave
 * cursor + next tick re-fetches. Dedup via
 * `UNIQUE(gmail_msg_id)` means re-fetched already-persisted rows are
 * skipped (see `emailAlreadyPersisted`). Apps must not rely on the UI
 * showing "no errors ever surface" — the sync_logs table is the audit
 * trail.
 */

import * as Sentry from '@sentry/nextjs';

import { classify } from '../classifier';
import type {
  ClassificationResult,
  EmailInput,
  RulesSnapshot,
} from '../classifier/types';
import { storeDb } from '../db';
import { getRulesSnapshotForPlatform } from '../queries/rules';
import { isTicketableClassification } from '../tickets/types';
import { associateEmailWithTicket } from '../tickets/wire';

import {
  createGmailClient,
  getCurrentHistoryId,
  getMessage,
  listHistory,
  listMessages,
  type GmailClient,
} from './client';
import {
  EmailParseError,
  GmailHistoryExpiredError,
  GmailNotConnectedError,
  RefreshTokenInvalidError,
  SyncInProgressError,
} from './errors';
import { extractApple, type ExtractedPayload } from './html-extractor';
import { parseGmailMessage, type ParsedEmail } from './parser';
import {
  createSenderResolver,
  loadActiveSenders,
  type PlatformResolution,
} from './sender-resolver';
import {
  advanceSyncState,
  getSyncState,
  insertSyncLog,
  recordSyncFailure,
  releaseSyncLock,
  tryAcquireSyncLock,
} from './sync-state';

/** Bumped when the classifier pipeline (PR-5) changes in a way that
 * invalidates old `classification_result` shapes. Stored on every new
 * row so future analytics queries can distinguish legacy rows from
 * current without a migration. */
export const CLASSIFIER_VERSION = '1.0';

const DEFAULT_MAX_BATCH = 50;
/** Hard ceiling — `spec §3` caps paginated `listHistory` at 200. */
const HARD_CAP_MAX_BATCH = 200;
/** Gmail fallback query filter: inbox only, no drafts/spam/trash. */
const FALLBACK_QUERY = 'in:inbox';

/**
 * Per-tick page cap for `listHistory` / `listMessages` pagination
 * (PR-23 Bug A + Bug B). At 100 IDs per page, 10 pages = 1000 IDs upper
 * bound — enough to drain a typical day's submissions traffic in one
 * tick while keeping a 5-min cron budget achievable. Backfill uses a
 * higher cap (see `BACKFILL_MAX_PAGES`).
 */
const SYNC_MAX_PAGES = 10;

/**
 * Backfill page cap. Sized so a 14-day failure window (~1200 emails at
 * ~89/day Apple traffic) can drain in one Manager-triggered click. If
 * exceeded, the action returns `{complete: false}` and the Manager
 * triggers again — dedup absorbs already-persisted rows.
 */
const BACKFILL_MAX_PAGES = 20;

/**
 * Date buffer subtracted from `last_synced_at` when constructing the
 * recovery `after:` query. Gmail's date-only `after:` is timezone-aware
 * and rounds toward the *start* of the day in the mailbox's tz, so a
 * 1-day buffer covers tz drift + same-day in-flight messages.
 */
const RECOVERY_BUFFER_DAYS = 1;

/* ============================================================================
 * Public types
 * ========================================================================== */

export type SyncMode = 'INCREMENTAL' | 'FALLBACK' | 'BACKFILL';

export interface SyncStats {
  /** Total messages attempted in this batch (including DROPPED + ERROR). */
  fetched: number;
  /** classification_status === 'CLASSIFIED'. */
  classified: number;
  /** classification_status IN ('UNCLASSIFIED_APP', 'UNCLASSIFIED_TYPE'). */
  unclassified: number;
  /** classification_status === 'DROPPED'. */
  dropped: number;
  /** classification_status === 'ERROR' or parse/classifier failure. */
  errors: number;
}

export interface SyncResult {
  success: boolean;
  mode: SyncMode;
  durationMs: number;
  stats: SyncStats;
  nextHistoryId: string | null;
  /** PR-23: number of pages walked across listHistory / listMessages. */
  pagesFetched: number;
  /**
   * PR-23: true when pagination broke out due to per-tick cap (`maxBatch`
   * or `SYNC_MAX_PAGES`) rather than draining `nextPageToken`. When true
   * AND mode is INCREMENTAL, the orchestrator preserves `last_history_id`
   * so the next tick re-fetches the remaining pages (dedup absorbs).
   * When mode is FALLBACK, cursor still advances to "now" by design —
   * full multi-page recovery requires a Manager-triggered BACKFILL.
   */
  stoppedEarly: boolean;
  /**
   * PR-23: anchor date used for the `after:YYYY/MM/DD` query in
   * recovery FALLBACK / BACKFILL. NULL for first-run FALLBACK and
   * INCREMENTAL.
   */
  recoverySince: Date | null;
}

export interface RunSyncOptions {
  /** Per-run message cap. Default 50, hard max 200. */
  maxBatch?: number;
  /** Identifier stamped on the lock row for debugging stale locks. */
  lockedBy?: string;
  /**
   * Test/internal injection hook. When supplied, skips
   * `createGmailClient()` (which would need real Google creds). Unit
   * tests pass a mocked Gmail client here.
   */
  gmailClient?: GmailClient;
}

export interface RunBackfillOptions {
  /**
   * Anchor date for `after:` query. Required — the Server Action
   * derives this from `gmail_sync_state.last_full_sync_at` (with a
   * 1-day buffer) so callers don't depend on sync-state in tests.
   */
  recoverySince: Date;
  /** Identifier stamped on the lock row for debugging stale locks. */
  lockedBy?: string;
  /** Test/internal injection hook (mirrors `RunSyncOptions.gmailClient`). */
  gmailClient?: GmailClient;
}

export interface BackfillResult {
  success: boolean;
  /** True iff pagination drained `nextPageToken` within `BACKFILL_MAX_PAGES`. */
  complete: boolean;
  durationMs: number;
  stats: SyncStats;
  pagesFetched: number;
  recoverySince: Date;
}

/* ============================================================================
 * Orchestrator
 * ========================================================================== */

export async function runSync(options: RunSyncOptions = {}): Promise<SyncResult> {
  const startMs = Date.now();
  const maxBatch = clampBatchSize(options.maxBatch);

  const acquired = await tryAcquireSyncLock({ lockedBy: options.lockedBy });
  if (!acquired) {
    throw new SyncInProgressError();
  }

  const stats: SyncStats = {
    fetched: 0,
    classified: 0,
    unclassified: 0,
    dropped: 0,
    errors: 0,
  };
  let mode: SyncMode = 'INCREMENTAL';
  let nextHistoryId: string | null = null;
  let pagesFetched = 0;
  let stoppedEarly = false;
  let recoverySince: Date | null = null;
  let outerError: Error | undefined;

  try {
    const gmailClient =
      options.gmailClient ?? (await createGmailClient());
    const state = await getSyncState();
    const senders = await loadActiveSenders();
    const resolvePlatform = createSenderResolver(senders);
    const rulesCache = new Map<string, RulesSnapshot | null>();

    const decided = await decideSyncMode(
      gmailClient,
      state.lastHistoryId,
      state.lastSyncedAt,
      maxBatch,
    );
    mode = decided.mode;
    nextHistoryId = decided.nextHistoryId;
    pagesFetched = decided.pagesFetched;
    stoppedEarly = decided.stoppedEarly;
    recoverySince = decided.recoverySince;

    // PR-23 Bug C fix: process all returned IDs, no slice. The pagination
    // loop in `decideSyncMode` already bounds `messageIds.length` to
    // ~`maxBatch + page_size` (~maxBatch + 100); processing the whole
    // set keeps surplus IDs from being silently discarded.
    for (const msgId of decided.messageIds) {
      try {
        await processMessage(msgId, {
          gmailClient,
          resolvePlatform,
          rulesCache,
          stats,
        });
      } catch (err) {
        // Per-message HARD error — distinct from the classifier/parse
        // errors that `processMessage` catches internally and persists
        // as ERROR rows. This path triggers on things like `getMessage`
        // network failures, `emailAlreadyPersisted` DB hiccups, or any
        // other exception where we don't yet have enough context (no
        // parsed email, maybe no gmail_msg_id) to construct a
        // meaningful `email_messages` row.
        //
        // Semantic contract (see docs/store-submissions/02-gmail-sync.md §6.3):
        // this path bumps `stats.errors` WITHOUT writing an
        // `email_messages` row. Consequences:
        //   - `sync_logs.emails_errored` > `SELECT count(*) WHERE
        //     classification_status='ERROR'` is EXPECTED for transient
        //     failures.
        //   - The cursor doesn't advance (any stats.errors > 0 blocks
        //     `advanceSyncState`), so the next tick re-fetches the same
        //     Gmail message. Dedup via UNIQUE(gmail_msg_id) prevents
        //     double-processing once the transient condition clears.
        //   - No audit row means no inspect-able trace of the failure
        //     in the Inbox UI; debugging relies on the app log
        //     (captured via console.error below).
        //
        // Parse errors, classifier ERROR results, and NO_RULES ARE
        // persisted inside `processMessage` — don't conflate.
        console.error(`[sync] Unhandled failure processing ${msgId}:`, err);
        stats.errors++;
      }
    }

    stats.fetched = decided.messageIds.length;

    if (stats.errors === 0) {
      // PR-23 Bug A fix: when INCREMENTAL pagination stopped early
      // (per-tick cap hit while `nextPageToken` still set), preserve
      // `last_history_id` so the next tick re-fetches the remaining
      // pages. UNIQUE(gmail_msg_id) absorbs the redundancy.
      //
      // FALLBACK semantics intentionally differ: we always advance to
      // "now" because the prior `last_history_id` is already expired
      // (Gmail 404s on it). Multi-page recovery in FALLBACK requires
      // an explicit Manager-triggered BACKFILL — see `runBackfill`.
      const advanceCursor = mode === 'FALLBACK' || !stoppedEarly;
      await advanceSyncState({
        mode: mode === 'BACKFILL' ? 'FALLBACK' : mode,
        newHistoryId: advanceCursor ? nextHistoryId : null,
        processedCount: stats.fetched,
      });
    } else {
      // At least one message failed. Stamp last_synced_at + bump
      // counter, but leave last_history_id so the next tick retries.
      await recordSyncFailure(
        `Batch completed with ${stats.errors} per-message error(s).`,
      );
    }

    return {
      success: stats.errors === 0,
      mode,
      durationMs: Date.now() - startMs,
      stats,
      nextHistoryId,
      pagesFetched,
      stoppedEarly,
      recoverySince,
    };
  } catch (err) {
    outerError = err instanceof Error ? err : new Error(String(err));

    // RefreshTokenInvalidError already bumped the counter inside
    // `ensureFreshToken`; skip to avoid double-bumping. SyncInProgress
    // never reaches here (thrown before try).
    if (!(err instanceof RefreshTokenInvalidError)) {
      try {
        await recordSyncFailure(outerError.message);
      } catch (recordErr) {
        console.error('[sync] recordSyncFailure failed in catch:', recordErr);
      }
    }
    throw err;
  } finally {
    // Audit log + lock release ALWAYS run — even on rethrow — so:
    //   1. sync_logs has a row for every attempted invocation.
    //   2. the lock is released even when the batch crashed mid-way.
    try {
      await insertSyncLog({
        syncMethod: mode,
        durationMs: Date.now() - startMs,
        emailsFetched: stats.fetched,
        emailsClassified: stats.classified,
        emailsUnclassified: stats.unclassified,
        emailsDropped: stats.dropped,
        emailsErrored: stats.errors,
        errorMessage: outerError ? outerError.message : null,
        pagesFetched,
        stoppedEarly,
        recoverySince,
      });
    } catch (logErr) {
      console.error('[sync] insertSyncLog failed in finally:', logErr);
    }
    await releaseSyncLock();
  }
}

/* ============================================================================
 * Backfill orchestrator (PR-23)
 *
 * Manager-triggered recovery for emails missed during an extended sync
 * outage (e.g. April 22 → May 6 OAuth blackout). Distinct from cron
 * `runSync` in three ways:
 *
 *   1. Anchored by date (`recoverySince`) instead of `last_history_id`,
 *      so it works even when Gmail's 7-day history retention has expired.
 *   2. Does NOT touch `gmail_sync_state.last_history_id` /
 *      `last_synced_at` — those reflect cron sync progress and must not
 *      be retroactively rewritten by a recovery scan. Cron and backfill
 *      operate on disjoint cursor namespaces.
 *   3. Higher per-call page cap (`BACKFILL_MAX_PAGES = 20` ≈ 2000 emails)
 *      so a 14-day window typically completes in one Manager click.
 *      When `complete=false`, Manager re-triggers; dedup absorbs the
 *      already-persisted rows.
 *
 * Shares the same advisory lock as `runSync` to serialize against cron
 * ticks (avoids two parallel `processMessage` runs hammering Gmail with
 * duplicate `getMessage` calls — UNIQUE(gmail_msg_id) handles correctness
 * but the wasted Gmail quota would be expensive on a 1000+ row run).
 * ========================================================================== */

export async function runBackfill(
  options: RunBackfillOptions,
): Promise<BackfillResult> {
  const startMs = Date.now();
  const recoverySince = options.recoverySince;

  const acquired = await tryAcquireSyncLock({
    lockedBy: options.lockedBy ?? 'backfill',
  });
  if (!acquired) {
    throw new SyncInProgressError();
  }

  const stats: SyncStats = {
    fetched: 0,
    classified: 0,
    unclassified: 0,
    dropped: 0,
    errors: 0,
  };
  let pagesFetched = 0;
  let stoppedEarly = false;
  let outerError: Error | undefined;

  try {
    const gmailClient =
      options.gmailClient ?? (await createGmailClient());
    const senders = await loadActiveSenders();
    const resolvePlatform = createSenderResolver(senders);
    const rulesCache = new Map<string, RulesSnapshot | null>();

    const fetched = await fetchMessagesPaginated(gmailClient, {
      query: `in:inbox after:${formatGmailDate(recoverySince)}`,
      perPage: 100,
      // Use HARD_CAP_MAX_BATCH so a single backfill click can drain up to
      // BACKFILL_MAX_PAGES * 100 IDs (= 2000) before "stopping early".
      // Loop break is governed by maxPages, not maxBatch, here — we want
      // to drain every event in the recovery window we can reach.
      maxBatch: BACKFILL_MAX_PAGES * 100,
      maxPages: BACKFILL_MAX_PAGES,
    });
    pagesFetched = fetched.pagesFetched;
    stoppedEarly = fetched.stoppedEarly;

    for (const msgId of fetched.messageIds) {
      try {
        await processMessage(msgId, {
          gmailClient,
          resolvePlatform,
          rulesCache,
          stats,
        });
      } catch (err) {
        console.error(`[backfill] Unhandled failure processing ${msgId}:`, err);
        stats.errors++;
      }
    }

    stats.fetched = fetched.messageIds.length;

    return {
      success: stats.errors === 0,
      complete: !stoppedEarly,
      durationMs: Date.now() - startMs,
      stats,
      pagesFetched,
      recoverySince,
    };
  } catch (err) {
    outerError = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    try {
      await insertSyncLog({
        syncMethod: 'BACKFILL',
        durationMs: Date.now() - startMs,
        emailsFetched: stats.fetched,
        emailsClassified: stats.classified,
        emailsUnclassified: stats.unclassified,
        emailsDropped: stats.dropped,
        emailsErrored: stats.errors,
        errorMessage: outerError ? outerError.message : null,
        pagesFetched,
        stoppedEarly,
        recoverySince,
      });
    } catch (logErr) {
      console.error('[backfill] insertSyncLog failed in finally:', logErr);
    }
    await releaseSyncLock();
  }
}

/* ============================================================================
 * Sync mode decision (INCREMENTAL vs FALLBACK)
 *
 * PR-23: both modes paginate (`pageToken` looped) up to `SYNC_MAX_PAGES`
 * pages or until `maxBatch` IDs accumulate. Conservative cursor strategy
 * for INCREMENTAL — when stopped early, preserve the inbound cursor so
 * the next tick re-fetches remaining pages. FALLBACK still advances to
 * "now"; multi-page recovery in FALLBACK requires `runBackfill`.
 * ========================================================================== */

interface SyncModeDecision {
  mode: SyncMode;
  messageIds: string[];
  nextHistoryId: string | null;
  pagesFetched: number;
  stoppedEarly: boolean;
  recoverySince: Date | null;
}

async function decideSyncMode(
  client: GmailClient,
  lastHistoryId: string | null,
  lastSyncedAt: Date | null,
  maxBatch: number,
): Promise<SyncModeDecision> {
  if (!lastHistoryId) {
    // First-run or after reconnect: no cursor yet → fallback. No
    // recovery date — this is a clean start, the 50-newest cap is fine.
    return runFallback(client, maxBatch, null);
  }

  try {
    const fetched = await fetchHistoryPaginated(client, {
      startHistoryId: lastHistoryId,
      perPage: 100,
      maxBatch,
      maxPages: SYNC_MAX_PAGES,
    });
    return {
      mode: 'INCREMENTAL',
      messageIds: fetched.messageIds,
      // When we stopped early, preserve `lastHistoryId` — the actual
      // cursor write is gated on `!stoppedEarly` upstream, but we
      // still pass the inbound cursor through for clarity.
      nextHistoryId: fetched.stoppedEarly
        ? lastHistoryId
        : fetched.nextHistoryId ?? lastHistoryId,
      pagesFetched: fetched.pagesFetched,
      stoppedEarly: fetched.stoppedEarly,
      recoverySince: null,
    };
  } catch (err) {
    if (err instanceof GmailHistoryExpiredError) {
      // historyId > 7 days stale → Gmail 404s. Recover with a
      // date-bounded fallback anchored at last_synced_at minus a 1-day
      // buffer (covers tz drift + same-day in-flight messages). When
      // last_synced_at is null (rare — no sync ever succeeded), fall
      // through to first-run-style fallback.
      const recoverySince = lastSyncedAt
        ? subtractDays(lastSyncedAt, RECOVERY_BUFFER_DAYS)
        : null;
      return runFallback(client, maxBatch, recoverySince);
    }
    throw err;
  }
}

async function runFallback(
  client: GmailClient,
  maxBatch: number,
  recoverySince: Date | null,
): Promise<SyncModeDecision> {
  const query = recoverySince
    ? `${FALLBACK_QUERY} after:${formatGmailDate(recoverySince)}`
    : FALLBACK_QUERY;

  const fetched = await fetchMessagesPaginated(client, {
    query,
    perPage: 100,
    maxBatch,
    maxPages: SYNC_MAX_PAGES,
  });
  const historyId = await getCurrentHistoryId(client);
  return {
    mode: 'FALLBACK',
    messageIds: fetched.messageIds,
    nextHistoryId: historyId,
    pagesFetched: fetched.pagesFetched,
    stoppedEarly: fetched.stoppedEarly,
    recoverySince,
  };
}

/* ============================================================================
 * Pagination helpers
 *
 * Two thin loops over `listHistory` / `listMessages` that share a stop
 * condition (per-tick cap + safety cap on pages walked). Extracted so the
 * cron sync (`runSync`) and the manual backfill (`runBackfill`) use the
 * same exhaustion logic. Per-page size is fixed at 100 — Gmail's max
 * `maxResults` for both endpoints is 500, but 100 matches the orchestrator's
 * pre-PR-23 implicit cap and keeps single-page response sizes bounded.
 * ========================================================================== */

interface PaginatedFetch {
  messageIds: string[];
  /** Mailbox historyId from the last successful listHistory call. */
  nextHistoryId: string | null;
  pagesFetched: number;
  /** True iff we stopped due to per-tick cap with `nextPageToken` still set. */
  stoppedEarly: boolean;
}

async function fetchHistoryPaginated(
  client: GmailClient,
  params: {
    startHistoryId: string;
    perPage: number;
    maxBatch: number;
    maxPages: number;
  },
): Promise<PaginatedFetch> {
  const allIds: string[] = [];
  let pageToken: string | undefined;
  let nextHistoryId: string | null = null;
  let pages = 0;
  let stoppedEarly = false;

  do {
    const delta = await listHistory(client, {
      startHistoryId: params.startHistoryId,
      pageToken,
      maxResults: params.perPage,
    });
    allIds.push(...delta.messageIds);
    nextHistoryId = delta.nextHistoryId ?? nextHistoryId;
    pageToken = delta.nextPageToken ?? undefined;
    pages++;

    if (allIds.length >= params.maxBatch) {
      stoppedEarly = !!pageToken;
      break;
    }
  } while (pageToken && pages < params.maxPages);

  // Loop exited naturally (pageToken null) but we hit page cap with
  // pageToken still set — that's also "stopped early".
  if (!stoppedEarly && pages >= params.maxPages && pageToken) {
    stoppedEarly = true;
  }

  return { messageIds: allIds, nextHistoryId, pagesFetched: pages, stoppedEarly };
}

async function fetchMessagesPaginated(
  client: GmailClient,
  params: {
    query: string;
    perPage: number;
    maxBatch: number;
    maxPages: number;
  },
): Promise<Pick<PaginatedFetch, 'messageIds' | 'pagesFetched' | 'stoppedEarly'>> {
  const allIds: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let stoppedEarly = false;

  do {
    const result = await listMessages(client, {
      query: params.query,
      pageToken,
      maxResults: params.perPage,
    });
    allIds.push(...result.messageIds);
    pageToken = result.nextPageToken ?? undefined;
    pages++;

    if (allIds.length >= params.maxBatch) {
      stoppedEarly = !!pageToken;
      break;
    }
  } while (pageToken && pages < params.maxPages);

  if (!stoppedEarly && pages >= params.maxPages && pageToken) {
    stoppedEarly = true;
  }

  return { messageIds: allIds, pagesFetched: pages, stoppedEarly };
}

/**
 * Format a Date as Gmail's `after:` query token (`YYYY/MM/DD`).
 *
 * Gmail interprets the date in the mailbox's timezone, rounding toward
 * the start of the day. We use UTC components for determinism — the
 * caller is expected to have already subtracted a 1-day buffer
 * (`RECOVERY_BUFFER_DAYS`) to absorb tz drift.
 */
function formatGmailDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

function subtractDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() - days);
  return out;
}

/* ============================================================================
 * Per-message processing
 * ========================================================================== */

interface ProcessContext {
  gmailClient: GmailClient;
  resolvePlatform: (email: string) => PlatformResolution | null;
  rulesCache: Map<string, RulesSnapshot | null>;
  stats: SyncStats;
}

async function processMessage(
  msgId: string,
  ctx: ProcessContext,
): Promise<void> {
  // 1. Dedup — one UNIQUE(gmail_msg_id) constraint would catch
  //    double-INSERTs, but checking up front saves a round-trip to Gmail
  //    for messages we already have.
  if (await emailAlreadyPersisted(msgId)) {
    return;
  }

  // 2. Fetch + parse. Parse errors persist ERROR row + continue batch.
  const raw = await getMessage(ctx.gmailClient, msgId);

  let parsed: ParsedEmail;
  try {
    parsed = parseGmailMessage(raw);
  } catch (err) {
    if (err instanceof EmailParseError) {
      await insertEmailMessageRow({
        gmailMsgId: msgId,
        gmailThreadId: raw.threadId ?? null,
        subject: '(unparseable)',
        senderEmail: 'unknown@parse.error',
        senderName: null,
        receivedAt: new Date(),
        bodyText: null,
        classificationStatus: 'ERROR',
        classificationResult: {
          status: 'ERROR',
          classifier_version: CLASSIFIER_VERSION,
          error_code: 'PARSE_ERROR',
          error_message: err.message,
        },
        errorMessage: err.message,
      });
      ctx.stats.errors++;
      return;
    }
    throw err;
  }

  // 3. Resolve sender → platform. No match = DROPPED, no classifier call.
  const platformRes = ctx.resolvePlatform(parsed.fromEmail);
  if (!platformRes) {
    await insertEmailMessageRow({
      gmailMsgId: parsed.messageId,
      gmailThreadId: parsed.threadId,
      subject: parsed.subject,
      senderEmail: parsed.fromEmail,
      senderName: parsed.fromName ?? null,
      receivedAt: parsed.receivedAt,
      bodyText: parsed.body,
      classificationStatus: 'DROPPED',
      classificationResult: {
        status: 'DROPPED',
        classifier_version: CLASSIFIER_VERSION,
        reason: 'NO_SENDER_MATCH',
      },
    });
    ctx.stats.dropped++;
    return;
  }

  // 3b. Apple HTML extractor (PR-11 + PR-12). Apple text/plain bodies
  //     carry only "Submission ID + App Name" — the type signal lives
  //     in the HTML alternative. Extract here so both the classifier
  //     (PR-11.4) and the persisted row receive the structured payload.
  //
  //     PR-12 threads `parsed.subject` so the extractor can detect the
  //     rejection template ("There's an issue with your X submission")
  //     vs the acceptance template ("Review of your X submission is
  //     complete"). Items extraction switches branches accordingly.
  //
  //     Gating on platformKey === 'apple': non-Apple platforms keep
  //     `extracted_payload` NULL (signal: extraction not attempted),
  //     distinct from `{ outcome: null, items: [] }` (signal: Apple
  //     email with no recognizable section, e.g. marketing mail). PR-
  //     11.5 reclassify uses this distinction.
  const extractedPayload: ExtractedPayload | null =
    platformRes.platformKey === 'apple'
      ? extractApple(parsed.bodyHtml, parsed.subject)
      : null;
  if (extractedPayload) {
    alertOnUnknownExtractedTypes(extractedPayload, parsed.messageId);
  }

  // 4. Load rules (memoized per run). If platform has no rules
  //    configured yet, mark ERROR — a sender in the senders table with
  //    no rules is a config gap that Managers must address.
  const rules = await getRulesCached(platformRes.platformId, ctx.rulesCache);
  if (!rules) {
    const message = `No rules configured for platform ${platformRes.platformKey}`;
    await insertEmailMessageRow({
      gmailMsgId: parsed.messageId,
      gmailThreadId: parsed.threadId,
      subject: parsed.subject,
      senderEmail: parsed.fromEmail,
      senderName: parsed.fromName ?? null,
      receivedAt: parsed.receivedAt,
      bodyText: parsed.body,
      classificationStatus: 'ERROR',
      classificationResult: {
        status: 'ERROR',
        classifier_version: CLASSIFIER_VERSION,
        error_code: 'NO_RULES',
        error_message: message,
        platform_id: platformRes.platformId,
        platform_key: platformRes.platformKey,
      },
      errorMessage: message,
      extractedPayload,
    });
    ctx.stats.errors++;
    return;
  }

  // 5. Classify — pure, deterministic, no I/O.
  const classInput: EmailInput = {
    sender: parsed.fromEmail,
    subject: parsed.subject,
    body: parsed.body,
    extracted_payload: extractedPayload,
  };
  const classification = classify(classInput, rules);

  // 6. Persist with classifier_version stamped onto the JSONB.
  const errorMsg = extractErrorMessage(classification);
  const inserted = await insertEmailMessageRow({
    gmailMsgId: parsed.messageId,
    gmailThreadId: parsed.threadId,
    subject: parsed.subject,
    senderEmail: parsed.fromEmail,
    senderName: parsed.fromName ?? null,
    receivedAt: parsed.receivedAt,
    bodyText: parsed.body,
    classificationStatus: classification.status,
    classificationResult: {
      ...classification,
      classifier_version: CLASSIFIER_VERSION,
    },
    errorMessage: errorMsg,
    extractedPayload,
  });

  incrementStatsFor(classification.status, ctx.stats);

  // 7. Ticket wire (PR-8). Only ticketable statuses reach the engine;
  //    DROPPED (SUBJECT_NOT_TRACKED) + ERROR (REGEX_TIMEOUT, PARSE_ERROR)
  //    short-circuit via `isTicketableClassification`. `inserted === null`
  //    means the INSERT hit a UNIQUE(gmail_msg_id) race — the winning
  //    run's wire call handles association; we bail to avoid double-wire.
  //
  //    Wire is GRACEFUL by contract: it swallows engine/UPDATE errors
  //    and returns null. We still wrap with try/catch here as
  //    defense-in-depth — if wire ever throws (future regression,
  //    unexpected exception), we MUST NOT let it cascade to the outer
  //    batch loop. Why: the email row is already persisted + stats
  //    already incremented; propagating the throw would bump
  //    `stats.errors`, block cursor advance, and wedge us in a retry
  //    loop where dedup skips the row forever (ticket_id permanently
  //    NULL). Swallowing preserves cursor progress; the orphan is
  //    recoverable via Manager re-association (PR-9+).
  if (inserted && isTicketableClassification(classification)) {
    try {
      await associateEmailWithTicket(inserted.id, classification);
    } catch (wireErr) {
      console.error(
        '[sync] associateEmailWithTicket threw — wire contract violation',
        { emailId: inserted.id, error: wireErr },
      );
    }
  }
}

function incrementStatsFor(
  status: ClassificationResult['status'],
  stats: SyncStats,
): void {
  switch (status) {
    case 'CLASSIFIED':
      stats.classified++;
      return;
    case 'UNCLASSIFIED_APP':
    case 'UNCLASSIFIED_TYPE':
      stats.unclassified++;
      return;
    case 'DROPPED':
      stats.dropped++;
      return;
    case 'ERROR':
      stats.errors++;
      return;
  }
}

function extractErrorMessage(result: ClassificationResult): string | null {
  if (result.status === 'ERROR') return result.error_message ?? null;
  return null;
}

async function getRulesCached(
  platformId: string,
  cache: Map<string, RulesSnapshot | null>,
): Promise<RulesSnapshot | null> {
  if (cache.has(platformId)) {
    return cache.get(platformId) ?? null;
  }
  const snap = await getRulesSnapshotForPlatform(platformId);
  cache.set(platformId, snap);
  return snap;
}

/* ============================================================================
 * email_messages persistence
 * ========================================================================== */

interface EmailMessageRow {
  gmailMsgId: string;
  gmailThreadId: string | null;
  subject: string;
  senderEmail: string;
  senderName: string | null;
  receivedAt: Date;
  /** The body text to persist. NULL → column stays NULL. */
  bodyText: string | null;
  classificationStatus:
    | 'CLASSIFIED'
    | 'UNCLASSIFIED_APP'
    | 'UNCLASSIFIED_TYPE'
    | 'DROPPED'
    | 'ERROR'
    | 'PENDING';
  /** Full classifier output + classifier_version stamp. */
  classificationResult: Record<string, unknown>;
  errorMessage?: string | null;
  /**
   * PR-11. Apple HTML extractor output. NULL on three paths:
   *   - parse-error path (no parsed email, no HTML to extract)
   *   - NO_SENDER_MATCH path (no platform resolution, extractor not run)
   *   - non-Apple platform (extractor is Apple-only until PR-12+)
   * Apple emails always persist a non-null payload, even when
   * `accepted_items` is empty (signals "extraction attempted, no items").
   */
  extractedPayload?: ExtractedPayload | null;
}

async function emailAlreadyPersisted(gmailMsgId: string): Promise<boolean> {
  const { data, error } = await storeDb()
    .from('email_messages')
    .select('id')
    .eq('gmail_msg_id', gmailMsgId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[sync] dedup check failed:', error);
    throw new Error(`Failed to check email_messages: ${error.message}`);
  }
  return !!data;
}

/**
 * Insert an `email_messages` row and return its generated `id`.
 *
 * Returns `null` on benign UNIQUE(gmail_msg_id) collisions (dedup race
 * with a parallel run). Callers use the returned id to wire the row to
 * a ticket (see `associateEmailWithTicket`); `null` signals "another
 * run will handle wiring — bail without error."
 *
 * Throws for all other INSERT failures (DB unreachable, CHECK violation,
 * etc.) — those propagate to the batch's per-message error handler.
 */
async function insertEmailMessageRow(
  row: EmailMessageRow,
): Promise<{ id: string } | null> {
  const { data, error } = await storeDb()
    .from('email_messages')
    .insert({
      gmail_msg_id: row.gmailMsgId,
      gmail_thread_id: row.gmailThreadId,
      subject: row.subject,
      sender_email: row.senderEmail,
      sender_name: row.senderName,
      received_at: row.receivedAt.toISOString(),
      raw_body_text: row.bodyText,
      classification_status: row.classificationStatus,
      classification_result: row.classificationResult,
      processed_at: new Date().toISOString(),
      error_message: row.errorMessage ?? null,
      extracted_payload: row.extractedPayload ?? null,
      // ticket_id left NULL at INSERT — the PR-8 ticket wire back-fills
      // it via UPDATE for ticketable statuses (CLASSIFIED + UNCLASSIFIED_*).
      ticket_id: null,
    })
    .select('id')
    .single();

  if (error) {
    // Race via UNIQUE(gmail_msg_id): another run just inserted the same
    // id. That's fine — treat as benign dedup collision, don't throw.
    if (isUniqueViolation(error)) {
      return null;
    }
    console.error('[sync] insertEmailMessageRow failed:', error);
    throw new Error(`Failed to insert email_messages: ${error.message}`);
  }
  return data;
}

function isUniqueViolation(err: { code?: string; message?: string }): boolean {
  if (err.code === '23505') return true; // Postgres unique_violation SQLSTATE
  if (typeof err.message === 'string' && /duplicate key|unique constraint/i.test(err.message)) {
    return true;
  }
  return false;
}

/* ============================================================================
 * Helpers
 * ========================================================================== */

function clampBatchSize(requested: number | undefined): number {
  if (!requested || requested < 1) return DEFAULT_MAX_BATCH;
  return Math.min(requested, HARD_CAP_MAX_BATCH);
}

/**
 * Surface unrecognized Apple heading variations to Sentry as a warning.
 *
 * Empty `items` is NOT an alert — it just means the email had no items
 * section we recognize (marketing mail, system digests, or a malformed
 * rejection where the anchor paragraph is missing). UNKNOWN means we
 * found an `<h3>` under one of the anchors that none of the 4 type
 * patterns matched. Apple may have introduced a new type variant or
 * template — flag it so we can extend `html-extractor.ts` before the
 * bucket fills with UNCLASSIFIED rows.
 *
 * Sentry has no DSN in test/dev envs and is a no-op there; production
 * captures the warning under `component: 'html-extractor'`.
 */
function alertOnUnknownExtractedTypes(
  payload: ExtractedPayload,
  gmailMsgId: string,
): void {
  const unknown = payload.items.filter((it) => it.type === 'UNKNOWN');
  if (unknown.length === 0) return;
  Sentry.captureMessage(
    `Unknown Apple heading variation(s): ${unknown
      .map((i) => i.raw_heading.trim())
      .join(', ')}`,
    {
      level: 'warning',
      tags: { component: 'html-extractor', gmail_msg_id: gmailMsgId },
      extra: {
        unknown_items: unknown.map((i) => ({
          heading: i.raw_heading,
          body: i.raw_body,
        })),
      },
    },
  );
}

// Re-export error classes commonly caught by the endpoint (7.3.2) for
// convenience — saves an import from './errors' when the only reason is
// HTTP status mapping.
export {
  GmailNotConnectedError,
  RefreshTokenInvalidError,
  SyncInProgressError,
};
