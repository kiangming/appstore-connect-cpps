/**
 * CRUD for the `store_mgmt.gmail_sync_state` singleton row and the
 * append-only `store_mgmt.sync_logs` table.
 *
 * Extended in PR-7 Chunk 7.3 beyond the failure-counter helpers used by
 * `ensureFreshToken()`:
 *   - `tryAcquireLock` / `releaseLock` — table-based concurrency guard
 *     (RPCs in migration 20260420000000; see that file's header for why
 *     we don't use `pg_try_advisory_lock` under Supabase's pooler).
 *   - `getSyncState` — read the full row so the orchestrator can choose
 *     INCREMENTAL vs FALLBACK mode.
 *   - `advanceSyncState` — on a clean batch, update `last_history_id`
 *     (and `last_full_sync_at` on fallback) plus processing counters.
 *   - `recordSyncFailure` — on a dirty batch, stamp last_synced_at +
 *     last_error without advancing the history cursor.
 *   - `insertSyncLog` — append-only audit row, one per orchestrator
 *     invocation (success or failure).
 *
 * The row is seeded by the initial migration with `id = 1`, so every
 * helper here UPDATEs (not upserts) and treats 0 rows affected as a bug,
 * not a degraded success.
 */

import { storeDb } from '../db';

const SINGLETON_ID = 1;

/** Default stale-lock threshold passed to the `try_acquire_sync_lock` RPC. */
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Increment `consecutive_failures` by 1 and stamp `last_error` /
 * `last_error_at` with the given message. Used by `ensureFreshToken()`
 * when Google rejects the refresh token with `invalid_grant`.
 *
 * The message is truncated to 1000 chars so a verbose googleapis error
 * never fills the column — the orchestrator logs the full error
 * structurally elsewhere.
 */
export async function bumpConsecutiveFailures(errorMessage: string): Promise<void> {
  const truncated =
    errorMessage.length > 1000 ? `${errorMessage.slice(0, 997)}...` : errorMessage;

  // Supabase doesn't support `col = col + 1` in a plain UPDATE without a
  // RPC; use the RPC-less pattern of read-then-write. The race this opens
  // (two concurrent bumps stomp each other and land at N+1 instead of
  // N+2) is acceptable: we guard the whole sync run with a Postgres
  // advisory lock in 7.3, so in practice only one caller bumps at a time.
  const { data, error: readErr } = await storeDb()
    .from('gmail_sync_state')
    .select('consecutive_failures')
    .eq('id', SINGLETON_ID)
    .maybeSingle();

  if (readErr) {
    console.error('[gmail-sync-state] read failed on bump:', readErr);
    throw new Error('Failed to read gmail_sync_state.');
  }
  if (!data) {
    throw new Error('gmail_sync_state singleton row missing (migration issue).');
  }

  const next = (data.consecutive_failures ?? 0) + 1;

  const { error: writeErr } = await storeDb()
    .from('gmail_sync_state')
    .update({
      consecutive_failures: next,
      last_error: truncated,
      last_error_at: new Date().toISOString(),
    })
    .eq('id', SINGLETON_ID);

  if (writeErr) {
    console.error('[gmail-sync-state] write failed on bump:', writeErr);
    throw new Error('Failed to update gmail_sync_state.');
  }
}

/**
 * Reset `consecutive_failures` to 0 and clear `last_error` / `last_error_at`.
 * Called after a successful token refresh so stale errors don't linger in
 * the UI banner after a Manager reconnects Gmail.
 */
export async function resetConsecutiveFailures(): Promise<void> {
  const { error } = await storeDb()
    .from('gmail_sync_state')
    .update({
      consecutive_failures: 0,
      last_error: null,
      last_error_at: null,
    })
    .eq('id', SINGLETON_ID);

  if (error) {
    console.error('[gmail-sync-state] reset failed:', error);
    throw new Error('Failed to reset gmail_sync_state failure counter.');
  }
}

/* ============================================================================
 * Lock helpers (PR-7 Chunk 7.3)
 * ========================================================================== */

/**
 * Try to acquire the sync lock. Returns `true` on success, `false` when
 * another sync is already in progress (and the lock hasn't gone stale).
 *
 * Implemented via the `try_acquire_sync_lock` RPC so the UPDATE +
 * predicate check happen atomically on the DB side. See the migration
 * for why we use a table row instead of `pg_try_advisory_lock`.
 */
export async function tryAcquireSyncLock(options?: {
  lockedBy?: string;
  staleAfterMs?: number;
}): Promise<boolean> {
  const { data, error } = await storeDb().rpc('try_acquire_sync_lock', {
    p_locked_by: options?.lockedBy ?? 'gmail-sync',
    p_stale_after_ms: options?.staleAfterMs ?? DEFAULT_LOCK_STALE_MS,
  });

  if (error) {
    console.error('[gmail-sync-state] Failed to acquire sync lock:', error);
    throw new Error('Failed to acquire sync lock.');
  }
  return data === true;
}

/**
 * Idempotent release — always NULLs the lock fields. Safe to call from
 * a `finally` block even when acquisition failed upstream.
 */
export async function releaseSyncLock(): Promise<void> {
  const { error } = await storeDb().rpc('release_sync_lock');
  if (error) {
    // Don't throw — a failed release is recoverable via the stale-lock
    // reclaimer in the next acquire call. Log loudly so ops sees it.
    console.error('[gmail-sync-state] Failed to release sync lock:', error);
  }
}

/* ============================================================================
 * State accessors
 * ========================================================================== */

export interface SyncState {
  lastHistoryId: string | null;
  lastSyncedAt: Date | null;
  lastFullSyncAt: Date | null;
  emailsProcessedTotal: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: Date | null;
  lockedAt: Date | null;
  lockedBy: string | null;
}

/**
 * Read the full singleton row. The orchestrator uses
 * `lastHistoryId` to decide sync mode (null → FALLBACK) and
 * `consecutiveFailures` to trigger the Sentry alert / UI banner.
 */
export async function getSyncState(): Promise<SyncState> {
  const { data, error } = await storeDb()
    .from('gmail_sync_state')
    .select(
      'last_history_id, last_synced_at, last_full_sync_at, emails_processed_total, consecutive_failures, last_error, last_error_at, locked_at, locked_by',
    )
    .eq('id', SINGLETON_ID)
    .maybeSingle();

  if (error) {
    console.error('[gmail-sync-state] Failed to read state:', error);
    throw new Error('Failed to read gmail_sync_state.');
  }
  if (!data) {
    throw new Error('gmail_sync_state singleton row missing (migration issue).');
  }

  return {
    // `last_history_id` is a BIGINT in Postgres; supabase-js returns it
    // as a string OR a number depending on version — normalize to string.
    lastHistoryId:
      data.last_history_id === null || data.last_history_id === undefined
        ? null
        : String(data.last_history_id),
    lastSyncedAt: data.last_synced_at ? new Date(data.last_synced_at) : null,
    lastFullSyncAt: data.last_full_sync_at
      ? new Date(data.last_full_sync_at)
      : null,
    emailsProcessedTotal: Number(data.emails_processed_total ?? 0),
    consecutiveFailures: Number(data.consecutive_failures ?? 0),
    lastError: data.last_error ?? null,
    lastErrorAt: data.last_error_at ? new Date(data.last_error_at) : null,
    lockedAt: data.locked_at ? new Date(data.locked_at) : null,
    lockedBy: data.locked_by ?? null,
  };
}

/**
 * Successful-batch update. Advances `last_history_id` to the Gmail
 * historyId observed at the end of the batch, stamps `last_synced_at`,
 * bumps `emails_processed_total`, and (when mode is FALLBACK) stamps
 * `last_full_sync_at` too.
 *
 * Critical: if the batch had ANY errors, the caller must use
 * `recordSyncFailure` instead — advancing the cursor while errored
 * messages didn't persist would drop those messages permanently.
 */
export async function advanceSyncState(input: {
  mode: 'INCREMENTAL' | 'FALLBACK';
  newHistoryId: string | null;
  processedCount: number;
}): Promise<void> {
  const now = new Date();
  const currentState = await getSyncState();

  const patch: Record<string, unknown> = {
    last_synced_at: now.toISOString(),
    emails_processed_total:
      currentState.emailsProcessedTotal + input.processedCount,
  };

  if (input.newHistoryId !== null) {
    patch.last_history_id = input.newHistoryId;
  }
  if (input.mode === 'FALLBACK') {
    patch.last_full_sync_at = now.toISOString();
  }

  const { error } = await storeDb()
    .from('gmail_sync_state')
    .update(patch)
    .eq('id', SINGLETON_ID);

  if (error) {
    console.error('[gmail-sync-state] advance failed:', error);
    throw new Error('Failed to advance gmail_sync_state.');
  }
}

/**
 * Error path: stamp `last_synced_at` so monitoring knows we ran, but do
 * NOT advance `last_history_id`. Bumps `consecutive_failures` and
 * records the error message so the UI banner surfaces it.
 */
export async function recordSyncFailure(errorMessage: string): Promise<void> {
  // Reuse the same read-then-write pattern as `bumpConsecutiveFailures`
  // to increment atomically. The advisory lock at the orchestrator level
  // serializes concurrent writers in practice.
  const current = await getSyncState();
  const truncated =
    errorMessage.length > 1000 ? `${errorMessage.slice(0, 997)}...` : errorMessage;

  const { error } = await storeDb()
    .from('gmail_sync_state')
    .update({
      last_synced_at: new Date().toISOString(),
      consecutive_failures: current.consecutiveFailures + 1,
      last_error: truncated,
      last_error_at: new Date().toISOString(),
    })
    .eq('id', SINGLETON_ID);

  if (error) {
    console.error('[gmail-sync-state] recordSyncFailure failed:', error);
    throw new Error('Failed to record sync failure.');
  }
}

/* ============================================================================
 * sync_logs (append-only)
 * ========================================================================== */

export interface SyncLogInput {
  syncMethod: 'INCREMENTAL' | 'FALLBACK' | 'MANUAL';
  durationMs: number;
  emailsFetched: number;
  emailsClassified: number;
  emailsUnclassified: number;
  emailsDropped: number;
  emailsErrored: number;
  /** Populated in PR-8 when the ticket engine wires in. Zero for PR-7. */
  ticketsCreated?: number;
  /** Populated in PR-8. Zero for PR-7. */
  ticketsUpdated?: number;
  errorMessage?: string | null;
}

/**
 * Append a row to `sync_logs`. Called exactly once per orchestrator
 * invocation — including failures — so the table is a complete audit
 * trail.
 *
 * Never UPDATEs an existing row; the table has no ON CONFLICT clause
 * because each run should be a new log entry.
 */
export async function insertSyncLog(input: SyncLogInput): Promise<void> {
  const { error } = await storeDb()
    .from('sync_logs')
    .insert({
      sync_method: input.syncMethod,
      duration_ms: input.durationMs,
      emails_fetched: input.emailsFetched,
      emails_classified: input.emailsClassified,
      emails_unclassified: input.emailsUnclassified,
      emails_dropped: input.emailsDropped,
      emails_errored: input.emailsErrored,
      tickets_created: input.ticketsCreated ?? 0,
      tickets_updated: input.ticketsUpdated ?? 0,
      error_message: input.errorMessage ?? null,
    });

  if (error) {
    // Audit log failure shouldn't mask a sync success — log and swallow.
    console.error('[gmail-sync-state] insertSyncLog failed:', error);
  }
}

/**
 * Count `sync_logs` rows with `ran_at` in the last `sinceMs` milliseconds.
 * Used by the healthcheck endpoint to surface "are the cron runs still
 * happening" without exposing raw row contents.
 *
 * Returns 0 on DB error — healthcheck should degrade gracefully rather
 * than fail the whole response on a transient DB hiccup.
 */
export async function countRecentSyncLogs(sinceMs: number): Promise<number> {
  const since = new Date(Date.now() - sinceMs).toISOString();
  const { count, error } = await storeDb()
    .from('sync_logs')
    .select('id', { count: 'exact', head: true })
    .gte('ran_at', since);

  if (error) {
    console.error('[gmail-sync-state] countRecentSyncLogs failed:', error);
    return 0;
  }
  return count ?? 0;
}
