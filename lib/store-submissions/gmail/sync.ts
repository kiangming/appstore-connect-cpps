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

/* ============================================================================
 * Public types
 * ========================================================================== */

export type SyncMode = 'INCREMENTAL' | 'FALLBACK';

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
  let outerError: Error | undefined;

  try {
    const gmailClient =
      options.gmailClient ?? (await createGmailClient());
    const state = await getSyncState();
    const senders = await loadActiveSenders();
    const resolvePlatform = createSenderResolver(senders);
    const rulesCache = new Map<string, RulesSnapshot | null>();

    const decided = await decideSyncMode(gmailClient, state.lastHistoryId, maxBatch);
    mode = decided.mode;
    nextHistoryId = decided.nextHistoryId;

    // Cap batch to maxBatch — surplus IDs are left for the next tick
    // (dedup via UNIQUE(gmail_msg_id) protects against double-processing
    // if we advance the cursor but bounce back later).
    const batch = decided.messageIds.slice(0, maxBatch);

    for (const msgId of batch) {
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

    stats.fetched = batch.length;

    if (stats.errors === 0) {
      await advanceSyncState({
        mode,
        newHistoryId: nextHistoryId,
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
      });
    } catch (logErr) {
      console.error('[sync] insertSyncLog failed in finally:', logErr);
    }
    await releaseSyncLock();
  }
}

/* ============================================================================
 * Sync mode decision (INCREMENTAL vs FALLBACK)
 * ========================================================================== */

interface SyncModeDecision {
  mode: SyncMode;
  messageIds: string[];
  nextHistoryId: string | null;
}

async function decideSyncMode(
  client: GmailClient,
  lastHistoryId: string | null,
  maxBatch: number,
): Promise<SyncModeDecision> {
  if (!lastHistoryId) {
    // First-run or after reconnect: no cursor yet → fallback.
    return runFallback(client, maxBatch);
  }

  try {
    const delta = await listHistory(client, {
      startHistoryId: lastHistoryId,
      maxResults: 100,
    });
    return {
      mode: 'INCREMENTAL',
      messageIds: delta.messageIds,
      nextHistoryId: delta.nextHistoryId ?? lastHistoryId,
    };
  } catch (err) {
    if (err instanceof GmailHistoryExpiredError) {
      // historyId > 7 days stale → Gmail 404s. Fall back, get a fresh
      // historyId from the profile endpoint so the NEXT tick returns
      // to incremental mode.
      return runFallback(client, maxBatch);
    }
    throw err;
  }
}

async function runFallback(
  client: GmailClient,
  maxBatch: number,
): Promise<SyncModeDecision> {
  const result = await listMessages(client, {
    query: FALLBACK_QUERY,
    maxResults: maxBatch,
  });
  const historyId = await getCurrentHistoryId(client);
  return {
    mode: 'FALLBACK',
    messageIds: result.messageIds,
    nextHistoryId: historyId,
  };
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

  // 3b. Apple HTML extractor (PR-11). Apple text/plain bodies carry only
  //     "Submission ID + App Name" — the type signal lives in the HTML
  //     alternative. Extract here so both the classifier (PR-11.4) and
  //     the persisted row receive the structured payload.
  //
  //     Gating on platformKey === 'apple': non-Apple platforms keep
  //     `extracted_payload` NULL (signal: extraction not attempted),
  //     distinct from `{ accepted_items: [] }` (signal: Apple email with
  //     no Accepted items section, e.g. a rejection or marketing mail).
  //     PR-11.5 reclassify uses this distinction.
  const extractedPayload: ExtractedPayload | null =
    platformRes.platformKey === 'apple'
      ? extractApple(parsed.bodyHtml)
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
 * Empty `accepted_items` is NOT an alert — it just means the email had
 * no Accepted items section (rejection notices, marketing, system
 * digests). UNKNOWN means we found an `<h3>` under "Accepted items" that
 * none of the 4 patterns matched. Apple may have introduced a new type
 * variant or template — flag it so we can extend `html-extractor.ts`
 * before the bucket fills with UNCLASSIFIED rows.
 *
 * Sentry has no DSN in test/dev envs and is a no-op there; production
 * captures the warning under `component: 'html-extractor'`.
 */
function alertOnUnknownExtractedTypes(
  payload: ExtractedPayload,
  gmailMsgId: string,
): void {
  const unknown = payload.accepted_items.filter((it) => it.type === 'UNKNOWN');
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
