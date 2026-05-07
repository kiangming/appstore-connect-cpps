'use server';

import { randomBytes } from 'crypto';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getServerSession } from 'next-auth';

import { authOptions } from '@/lib/auth';
import {
  StoreForbiddenError,
  StoreUnauthorizedError,
  requireStoreAccess,
  requireStoreRole,
} from '@/lib/store-submissions/auth';
import {
  deleteGmailCredentials,
  getGmailCredentials,
} from '@/lib/store-submissions/gmail/credentials';
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
  generateAuthUrl,
  revokeTokens,
} from '@/lib/store-submissions/gmail/oauth';
import {
  GmailNotConnectedError,
  RefreshTokenInvalidError,
  SyncInProgressError,
  runBackfill,
} from '@/lib/store-submissions/gmail/sync';
import { getSyncState } from '@/lib/store-submissions/gmail/sync-state';

// -- Shared result shape (matches PR-4/PR-5 pattern) ------------------------

export type SettingsActionError = {
  code:
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_CONNECTED'
    | 'SYNC_IN_PROGRESS'
    | 'INVALID_INPUT'
    | 'UNKNOWN';
  message: string;
};

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: SettingsActionError };

const SETTINGS_PATH = '/store-submissions/config/settings';

// -- Guards -----------------------------------------------------------------

async function guardManager(): Promise<
  | { ok: true; user: Awaited<ReturnType<typeof requireStoreRole>> }
  | { ok: false; error: SettingsActionError }
> {
  const session = await getServerSession(authOptions);
  try {
    const user = await requireStoreRole(session?.user?.email, 'MANAGER');
    return { ok: true, user };
  } catch (err) {
    if (err instanceof StoreUnauthorizedError) {
      return { ok: false, error: { code: 'UNAUTHORIZED', message: err.message } };
    }
    if (err instanceof StoreForbiddenError) {
      return { ok: false, error: { code: 'FORBIDDEN', message: err.message } };
    }
    throw err;
  }
}

async function guardAnyStoreUser(): Promise<
  | { ok: true }
  | { ok: false; error: SettingsActionError }
> {
  const session = await getServerSession(authOptions);
  try {
    await requireStoreAccess(session?.user?.email);
    return { ok: true };
  } catch (err) {
    if (err instanceof StoreUnauthorizedError) {
      return { ok: false, error: { code: 'UNAUTHORIZED', message: err.message } };
    }
    if (err instanceof StoreForbiddenError) {
      return { ok: false, error: { code: 'FORBIDDEN', message: err.message } };
    }
    throw err;
  }
}

// -- Connect: generate Google consent URL + stamp CSRF cookie ---------------

/**
 * Returns the Google consent URL for the Manager to open. Before returning,
 * writes an httpOnly signed cookie with a random `state` value; the
 * callback route rejects any request whose `state` query param does not
 * match the cookie (CSRF).
 *
 * Cookie attributes:
 *   - httpOnly       → not readable by JS
 *   - sameSite=lax   → required so the Google → /callback redirect carries
 *                      the cookie (top-level nav is exempt from lax block)
 *   - secure         → on in production only (breaks on localhost HTTP)
 *   - maxAge=10min   → short window; Manager must finish Connect promptly
 *   - path=/         → cookie reaches the callback route
 */
export async function getGmailConnectUrlAction(): Promise<
  ActionResult<{ url: string }>
> {
  const guard = await guardManager();
  if (!guard.ok) return { ok: false, error: guard.error };

  const state = randomBytes(16).toString('hex');
  cookies().set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
  });

  return { ok: true, data: { url: generateAuthUrl(state) } };
}

// -- Disconnect: best-effort revoke, then DB delete -------------------------

/**
 * Best-effort Google revoke, then delete the singleton credentials row. A
 * failed revoke is logged but does not block the DB delete — the row is
 * the source of truth for "connected".
 */
export async function disconnectGmailAction(): Promise<ActionResult<undefined>> {
  const guard = await guardManager();
  if (!guard.ok) return { ok: false, error: guard.error };

  const existing = await getGmailCredentials();
  if (existing) {
    try {
      await revokeTokens(existing.refresh_token);
    } catch (err) {
      console.error('[gmail-settings] Revoke failed, continuing with delete:', err);
    }
  }
  await deleteGmailCredentials();
  revalidatePath(SETTINGS_PATH);
  return { ok: true, data: undefined };
}

// -- Status: 2-state connected / disconnected -------------------------------

export interface GmailStatus {
  connected: boolean;
  email?: string;
  connected_at?: string;
  last_refreshed_at?: string | null;
}

/**
 * Reports the current Gmail connection status.
 *
 * Available to any authenticated Store Management user (not MANAGER-only) —
 * rationale: DEV/VIEWER need to see whether sync is even possible.
 *
 * Deliberately 2-state. Per docs/store-submissions/02-gmail-sync.md §6, the
 * only user-facing Gmail state is Connected vs Disconnected. The `access_token`
 * expiry (~1 hour) is refreshed transparently by googleapis' `oauth2.on('tokens')`
 * handler (PR-7 sync). A refresh_token revoke surfaces via `consecutive_failures`
 * in PR-7 sync health, not via this endpoint.
 */
export async function getGmailStatusAction(): Promise<ActionResult<GmailStatus>> {
  const guard = await guardAnyStoreUser();
  if (!guard.ok) return { ok: false, error: guard.error };

  const creds = await getGmailCredentials();
  if (!creds) {
    return { ok: true, data: { connected: false } };
  }

  return {
    ok: true,
    data: {
      connected: true,
      email: creds.email,
      connected_at: creds.connected_at.toISOString(),
      last_refreshed_at: creds.last_refreshed_at
        ? creds.last_refreshed_at.toISOString()
        : null,
    },
  };
}

// -- Backfill (PR-23) -------------------------------------------------------

/**
 * Snapshot of the Gmail sync cursor + last successful full-scan timestamp,
 * surfaced to the Settings UI to decide whether to show the Backfill
 * affordance and what window the Manager would be recovering.
 */
export interface BackfillStatus {
  /**
   * `gmail_sync_state.last_full_sync_at`. The most recent FALLBACK or
   * BACKFILL run that drained without `stoppedEarly`. NULL on a
   * never-fully-synced mailbox.
   */
  last_full_sync_at: string | null;
  /** `gmail_sync_state.last_synced_at`. Most recent attempt of any mode. */
  last_synced_at: string | null;
  /** `gmail_sync_state.consecutive_failures`. Surfaces ongoing breakage. */
  consecutive_failures: number;
  /**
   * `gmail_sync_state.last_error`. Last failure message (truncated to
   * 1000 chars). PR-24 reads this for the smart-threshold banner — a
   * terminal error (`invalid_grant`) surfaces immediately even if the
   * counter is at 1, while transient errors wait for the >=3 threshold.
   */
  last_error: string | null;
  /**
   * Hint for the UI: when `last_full_sync_at` is older than this many
   * days, the affordance is highlighted as "recovery suggested". The
   * button itself is always visible to Managers.
   */
  recovery_threshold_days: number;
}

const BACKFILL_RECOVERY_THRESHOLD_DAYS = 2;

export async function getBackfillStatusAction(): Promise<
  ActionResult<BackfillStatus>
> {
  const guard = await guardAnyStoreUser();
  if (!guard.ok) return { ok: false, error: guard.error };

  const state = await getSyncState();
  return {
    ok: true,
    data: {
      last_full_sync_at: state.lastFullSyncAt
        ? state.lastFullSyncAt.toISOString()
        : null,
      last_synced_at: state.lastSyncedAt
        ? state.lastSyncedAt.toISOString()
        : null,
      consecutive_failures: state.consecutiveFailures,
      last_error: state.lastError,
      recovery_threshold_days: BACKFILL_RECOVERY_THRESHOLD_DAYS,
    },
  };
}

export interface BackfillSummary {
  complete: boolean;
  emails_fetched: number;
  emails_classified: number;
  emails_unclassified: number;
  emails_dropped: number;
  emails_errored: number;
  pages_fetched: number;
  recovery_since: string;
  duration_ms: number;
}

/**
 * Manager-triggered recovery for emails missed during an extended sync
 * outage. Anchors the date-bounded query at `last_full_sync_at - 1 day`
 * (or `last_synced_at - 1 day` when no full sync has ever completed).
 *
 * Runs synchronously in the Server Action — Manager waits up to ~30-60s
 * for completion. Per-call cap is `BACKFILL_MAX_PAGES * 100` ≈ 2000
 * emails; for windows beyond that, the response carries `complete=false`
 * and Manager re-triggers (dedup via UNIQUE(gmail_msg_id) absorbs the
 * already-processed rows on the second run).
 *
 * Does NOT touch `gmail_sync_state.last_history_id` /
 * `gmail_sync_state.last_synced_at` — those reflect cron sync progress
 * and must not be retroactively rewritten.
 */
export async function runBackfillAction(): Promise<
  ActionResult<BackfillSummary>
> {
  const guard = await guardManager();
  if (!guard.ok) return { ok: false, error: guard.error };

  // Anchor: last_full_sync_at if present, else last_synced_at, else
  // refuse — there's no defensible recovery window without one.
  const state = await getSyncState();
  const anchor = state.lastFullSyncAt ?? state.lastSyncedAt;
  if (!anchor) {
    return {
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'Cannot determine recovery window: no successful sync has ever completed. Run a manual sync first.',
      },
    };
  }

  // Subtract 1-day buffer for tz drift + same-day in-flight messages.
  // The orchestrator subtracts again inside fetchMessagesPaginated when
  // necessary; the explicit buffer here keeps the Manager-facing UI
  // honest about which window will be queried.
  const recoverySince = new Date(anchor);
  recoverySince.setUTCDate(recoverySince.getUTCDate() - 1);

  try {
    const result = await runBackfill({
      recoverySince,
      lockedBy: 'manager-backfill',
    });
    revalidatePath(SETTINGS_PATH);
    return {
      ok: true,
      data: {
        complete: result.complete,
        emails_fetched: result.stats.fetched,
        emails_classified: result.stats.classified,
        emails_unclassified: result.stats.unclassified,
        emails_dropped: result.stats.dropped,
        emails_errored: result.stats.errors,
        pages_fetched: result.pagesFetched,
        recovery_since: result.recoverySince.toISOString(),
        duration_ms: result.durationMs,
      },
    };
  } catch (err) {
    if (err instanceof SyncInProgressError) {
      return {
        ok: false,
        error: {
          code: 'SYNC_IN_PROGRESS',
          message: 'Cron sync is currently running. Try again in a minute.',
        },
      };
    }
    if (err instanceof GmailNotConnectedError) {
      return {
        ok: false,
        error: {
          code: 'NOT_CONNECTED',
          message: 'Gmail is not connected. Reconnect before running backfill.',
        },
      };
    }
    if (err instanceof RefreshTokenInvalidError) {
      return {
        ok: false,
        error: {
          code: 'NOT_CONNECTED',
          message: 'Gmail token expired. Reconnect Gmail before running backfill.',
        },
      };
    }
    console.error('[settings] runBackfillAction failed:', err);
    return {
      ok: false,
      error: {
        code: 'UNKNOWN',
        message: 'Backfill failed. Check server logs for details.',
      },
    };
  }
}
