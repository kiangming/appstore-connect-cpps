/**
 * Gmail credentials singleton CRUD for Store Management.
 *
 * `store_mgmt.gmail_credentials` is a singleton row (id = 1, CHECK constraint).
 * Stores encrypted OAuth tokens for the shared submissions mailbox.
 *
 * All reads/writes go through this module so:
 *   - Tokens are always encrypted at rest (AES-256-GCM).
 *   - Callers receive plaintext tokens and never touch ciphertext.
 *   - Expiry logic uses a single, documented buffer.
 *   - Refresh is single-flight (see `ensureFreshToken`).
 */

import { decryptToken, encryptToken } from '../crypto';
import { storeDb } from '../db';

import {
  GmailNotConnectedError,
  isInvalidGrantError,
  RefreshTokenInvalidError,
} from './errors';
import { bumpConsecutiveFailures, resetConsecutiveFailures } from './sync-state';

const SINGLETON_ID = 1;

/**
 * Expiry buffer: treat a token as "expired" if it will expire within this
 * window. 5 minutes > typical network round-trip + clock skew tolerance, so
 * callers get a fresh token before Google actually rejects the current one.
 */
export const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface GmailCredentials {
  email: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: Date;
  scopes: string[];
  connected_at: Date;
  connected_by: string | null;
  last_refreshed_at: Date | null;
}

export interface GmailCredentialsInput {
  email: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: Date;
  scopes: string[];
  connected_by: string | null;
}

/**
 * True when `expiresAt` is in the past OR within `TOKEN_EXPIRY_BUFFER_MS`.
 * Callers should refresh before using a "soon-to-expire" token to absorb
 * network delay and small clock skew.
 */
export function isTokenExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() - now.getTime() <= TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Read the singleton credentials row and decrypt tokens.
 * Returns `null` when Gmail is not connected (row missing).
 */
export async function getGmailCredentials(): Promise<GmailCredentials | null> {
  const { data, error } = await storeDb()
    .from('gmail_credentials')
    .select(
      'email, access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes, connected_at, connected_by, last_refreshed_at',
    )
    .eq('id', SINGLETON_ID)
    .maybeSingle();

  if (error) {
    console.error('[gmail-credentials] Failed to fetch:', error);
    throw new Error('Failed to read Gmail credentials.');
  }
  if (!data) return null;

  return {
    email: data.email,
    access_token: decryptToken(data.access_token_encrypted),
    refresh_token: decryptToken(data.refresh_token_encrypted),
    token_expires_at: new Date(data.token_expires_at),
    scopes: data.scopes ?? [],
    connected_at: new Date(data.connected_at),
    connected_by: data.connected_by ?? null,
    last_refreshed_at: data.last_refreshed_at
      ? new Date(data.last_refreshed_at)
      : null,
  };
}

/**
 * Upsert the singleton credentials row.
 *
 * Encrypts tokens before write. On initial connect, the row is inserted;
 * on reconnect or token refresh, it is updated in place. `connected_at`
 * is stamped each time (reconnect = new connection lineage).
 */
export async function saveGmailCredentials(
  input: GmailCredentialsInput,
): Promise<void> {
  const now = new Date().toISOString();
  const payload = {
    id: SINGLETON_ID,
    email: input.email,
    access_token_encrypted: encryptToken(input.access_token),
    refresh_token_encrypted: encryptToken(input.refresh_token),
    token_expires_at: input.token_expires_at.toISOString(),
    scopes: input.scopes,
    connected_at: now,
    connected_by: input.connected_by,
    last_refreshed_at: now,
  };

  const { error } = await storeDb()
    .from('gmail_credentials')
    .upsert(payload, { onConflict: 'id' });

  if (error) {
    console.error('[gmail-credentials] Failed to save:', error);
    throw new Error('Failed to save Gmail credentials.');
  }
}

/**
 * Delete the singleton credentials row. Idempotent — deleting a missing row
 * is not an error (Supabase returns success with zero rows affected).
 */
export async function deleteGmailCredentials(): Promise<void> {
  const { error } = await storeDb()
    .from('gmail_credentials')
    .delete()
    .eq('id', SINGLETON_ID);

  if (error) {
    console.error('[gmail-credentials] Failed to delete:', error);
    throw new Error('Failed to disconnect Gmail.');
  }
}

/**
 * Refresh-only update: writes new access_token + expiry + last_refreshed_at
 * without touching `connected_at` / `connected_by`. Keeping the "connection
 * lineage" (who originally connected, when) intact across token refreshes
 * matters for audit — only `saveGmailCredentials` re-stamps those fields
 * because it represents an explicit connect/reconnect.
 *
 * `refresh_token` is updated too because Google occasionally rotates it on
 * refresh. When `refresh_token` is unchanged we still rewrite it; the
 * encryption round-trip is cheap and the code stays straight-line.
 */
export async function saveRefreshedTokens(input: {
  access_token: string;
  refresh_token: string;
  token_expires_at: Date;
}): Promise<void> {
  const { error } = await storeDb()
    .from('gmail_credentials')
    .update({
      access_token_encrypted: encryptToken(input.access_token),
      refresh_token_encrypted: encryptToken(input.refresh_token),
      token_expires_at: input.token_expires_at.toISOString(),
      last_refreshed_at: new Date().toISOString(),
    })
    .eq('id', SINGLETON_ID);

  if (error) {
    console.error('[gmail-credentials] Failed to persist refreshed tokens:', error);
    throw new Error('Failed to persist refreshed Gmail tokens.');
  }
}

interface TokenRefreshResponse {
  access_token: string;
  expires_in: number; // seconds from now
  refresh_token?: string; // Google only returns this on rotation
  scope?: string;
  token_type: string;
}

/**
 * POST Google's token endpoint directly rather than going through the
 * `googleapis` OAuth2 client. The client's `refreshAccessToken()` is
 * deprecated in recent versions and its replacement (`getAccessToken()`)
 * loses the explicit `expiry_date` we need to persist. A direct
 * `fetch` keeps the code straight-line, returns a stable wire shape that
 * predates the SDK, and is trivial to mock in tests.
 *
 * The `invalid_grant` error response surfaces as a 400 with body
 * `{ error: 'invalid_grant', error_description: '...' }` — we re-throw
 * preserving that shape so `isInvalidGrantError()` classifies it
 * correctly upstream.
 */
async function refreshAccessTokenDirect(
  refreshToken: string,
): Promise<TokenRefreshResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET env vars.',
    );
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (!res.ok) {
    const err = new Error(
      `Gmail token refresh failed (${res.status}): ${data.error ?? 'unknown'}${
        data.error_description ? ` — ${data.error_description}` : ''
      }`,
    );
    // Preserve the GaxiosError-ish shape so `isInvalidGrantError` works.
    Object.assign(err, {
      status: res.status,
      response: { status: res.status, data },
    });
    throw err;
  }

  if (
    typeof data.access_token !== 'string' ||
    typeof data.expires_in !== 'number' ||
    typeof data.token_type !== 'string'
  ) {
    throw new Error(
      'Gmail token refresh succeeded but response is missing required fields.',
    );
  }

  return {
    access_token: data.access_token,
    expires_in: data.expires_in,
    refresh_token: data.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
  };
}

/**
 * Module-level single-flight promise. Concurrent `ensureFreshToken()`
 * callers during an expiry window all await this one in-flight refresh
 * instead of racing Google's token endpoint. Cleared in the `finally` so
 * the next expiry cycle starts clean.
 *
 * This complements the advisory lock the sync orchestrator acquires in
 * 7.3 (sync-level, DB-scoped) with a process-level guard — they defend
 * against different races:
 *   - Advisory lock: two cron ticks overlap (process A + process B).
 *   - Single-flight: two parallel callers inside the same process (tests,
 *     or a future multi-consumer scenario).
 */
let inFlightRefresh: Promise<GmailCredentials> | null = null;

/**
 * Return a credentials snapshot whose `access_token` is guaranteed fresh
 * (not expired, not inside the buffer). If the stored token is still
 * fresh, returns it unchanged. If it's expired, refreshes via Google's
 * token endpoint, persists the new token atomically (single-flight),
 * resets the failure counter, and returns the updated snapshot.
 *
 * Throws:
 *   - `GmailNotConnectedError` when no credentials row exists.
 *   - `RefreshTokenInvalidError` when Google responds `invalid_grant`.
 *     Sync-state `consecutive_failures` is bumped before throwing so the
 *     UI banner / Sentry alert fires on the first occurrence.
 *   - Any other thrown value from the refresh call (network, 5xx, etc.)
 *     propagates unchanged so the orchestrator can distinguish transient
 *     from terminal failures.
 */
export async function ensureFreshToken(
  now: Date = new Date(),
): Promise<GmailCredentials> {
  const creds = await getGmailCredentials();
  if (!creds) throw new GmailNotConnectedError();

  if (!isTokenExpired(creds.token_expires_at, now)) {
    return creds;
  }

  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = (async () => {
    try {
      return await performRefresh(creds);
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

async function performRefresh(old: GmailCredentials): Promise<GmailCredentials> {
  let tokens: TokenRefreshResponse;
  try {
    tokens = await refreshAccessTokenDirect(old.refresh_token);
  } catch (err) {
    if (isInvalidGrantError(err)) {
      // Bump the failure counter so the UI banner and Sentry alert
      // surface this immediately. We swallow secondary DB errors from
      // the bump itself — an `invalid_grant` is already the primary
      // failure, and masking it with "bump failed" would be misleading.
      try {
        await bumpConsecutiveFailures(
          err instanceof Error ? err.message : String(err),
        );
      } catch (bumpErr) {
        console.error(
          '[ensureFreshToken] Failed to bump consecutive_failures:',
          bumpErr,
        );
      }
      throw new RefreshTokenInvalidError(err);
    }
    throw err;
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  const nextRefreshToken = tokens.refresh_token ?? old.refresh_token;

  await saveRefreshedTokens({
    access_token: tokens.access_token,
    refresh_token: nextRefreshToken,
    token_expires_at: expiresAt,
  });

  // Best-effort reset. If the DB write fails we still return the new
  // token so the current sync run can proceed; the stale failure count
  // will be cleared on the next successful refresh.
  try {
    await resetConsecutiveFailures();
  } catch (resetErr) {
    console.error(
      '[ensureFreshToken] Failed to reset consecutive_failures:',
      resetErr,
    );
  }

  return {
    ...old,
    access_token: tokens.access_token,
    refresh_token: nextRefreshToken,
    token_expires_at: expiresAt,
    last_refreshed_at: new Date(),
  };
}

/**
 * Test-only: reset the module-level single-flight cache between test
 * cases. Not exported from `index.ts` — import directly in specs.
 */
export function __resetInFlightRefreshForTests(): void {
  inFlightRefresh = null;
}
