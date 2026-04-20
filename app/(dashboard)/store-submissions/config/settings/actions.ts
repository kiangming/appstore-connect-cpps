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

// -- Shared result shape (matches PR-4/PR-5 pattern) ------------------------

export type SettingsActionError = {
  code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_CONNECTED' | 'UNKNOWN';
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
