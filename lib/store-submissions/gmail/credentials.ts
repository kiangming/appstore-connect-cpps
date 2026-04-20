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
 *
 * Token refresh (auto-refresh on expiry) is NOT handled here — see PR-7
 * Gmail Sync, which wraps the googleapis OAuth2 client and persists
 * refreshed tokens via `saveGmailCredentials`.
 */

import { decryptToken, encryptToken } from '../crypto';
import { storeDb } from '../db';

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
