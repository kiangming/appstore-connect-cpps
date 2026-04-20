/**
 * Google OAuth2 wrapper for Gmail connect flow (Store Management).
 *
 * Thin layer over `googleapis`:
 *   - Constructs the OAuth2 client from env vars.
 *   - Builds the consent-screen URL with the scopes we need.
 *   - Exchanges the authorization code for tokens.
 *   - Fetches the authenticated Gmail address (for display + the
 *     `store_mgmt.gmail_credentials.email` column).
 *   - Optional revoke on disconnect.
 *
 * The consuming Server Action (`getGmailConnectUrlAction`) writes the
 * CSRF `state` into an httpOnly cookie and then redirects the browser to
 * the URL this module returns. The callback route at
 * `/api/store-submissions/gmail/callback` consumes `exchangeCodeForTokens`.
 *
 * ⚠ The callback path must EXACTLY match one of the redirect URIs
 * registered in the Google Cloud Console OAuth Client. A mismatch surfaces
 * as `redirect_uri_mismatch` at exchange time — see `MissingRefreshTokenError`
 * for the related "refresh_token not returned" failure mode.
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const OAUTH_STATE_COOKIE = 'gmail_oauth_state';
export const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60; // 10 minutes

const CALLBACK_PATH = '/api/store-submissions/gmail/callback';

export interface ExchangedTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number; // ms since epoch
  scope: string; // space-separated
  token_type: string;
}

/**
 * Thrown when Google returns no refresh_token. Happens when the user has
 * previously granted consent and we did not force `prompt=consent`. Our
 * `generateAuthUrl` always sets `prompt=consent`, so this is a config /
 * Console-side problem — most often "refresh_token access is off for this
 * OAuth Client" or Google decided to cache the prior grant.
 *
 * Recovery for the Manager: revoke access at
 * https://myaccount.google.com/permissions and re-run Connect Gmail.
 */
export class MissingRefreshTokenError extends Error {
  constructor() {
    super(
      'Google did not return a refresh_token. ' +
        'Revoke access at https://myaccount.google.com/permissions and retry Connect Gmail.',
    );
    this.name = 'MissingRefreshTokenError';
  }
}

/**
 * Thrown when the granted scopes do not include `gmail.modify`. The user
 * may have unticked the Gmail permission on the consent screen. We abort
 * rather than silently save narrower credentials, since sync would then
 * fail mysteriously later.
 */
export class InsufficientScopeError extends Error {
  constructor(granted: string) {
    super(
      `OAuth grant missing required scope "${GMAIL_SCOPE}". Granted: "${granted}"`,
    );
    this.name = 'InsufficientScopeError';
  }
}

/**
 * Resolve the site base URL for constructing the OAuth redirect URI.
 *
 * Precedence:
 *   1. `NEXTAUTH_URL` (set in all envs — most reliable).
 *   2. `VERCEL_URL` (preview / prod deploys on Vercel).
 *   3. `RAILWAY_PUBLIC_DOMAIN` (Railway runtime).
 *   4. `http://localhost:3000` (dev fallback).
 *
 * Exported for test override.
 */
export function resolveBaseUrl(): string {
  const explicit = process.env.NEXTAUTH_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railway) return `https://${railway}`;
  return 'http://localhost:3000';
}

export function buildCallbackUrl(): string {
  return `${resolveBaseUrl()}${CALLBACK_PATH}`;
}

function requireOAuthEnv(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET env vars.',
    );
  }
  return { clientId, clientSecret };
}

export function getOAuthClient(): OAuth2Client {
  const { clientId, clientSecret } = requireOAuthEnv();
  return new google.auth.OAuth2(clientId, clientSecret, buildCallbackUrl());
}

/**
 * Build the Google consent URL.
 *
 *   - `access_type=offline`       → returns a refresh_token.
 *   - `prompt=consent`            → force re-consent so refresh_token is
 *                                    always issued (Google only issues it
 *                                    on first grant otherwise).
 *   - `include_granted_scopes`    → carry forward any pre-existing grants.
 *   - `state`                     → CSRF token, verified at the callback.
 */
export function generateAuthUrl(state: string): string {
  return getOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [GMAIL_SCOPE],
    state,
  });
}

/**
 * Exchange the one-time authorization code for tokens.
 *
 * Throws:
 *   - `MissingRefreshTokenError` if Google returns no refresh_token.
 *   - `InsufficientScopeError` if the granted scopes lack `gmail.modify`.
 *   - Generic `Error` (rethrown from googleapis) for redirect_uri_mismatch,
 *     invalid_grant (already-used code), etc. Caller should log and
 *     redirect with `?gmail=error&reason=exchange_failed`.
 */
export async function exchangeCodeForTokens(
  code: string,
): Promise<ExchangedTokens> {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) {
    throw new Error('Exchange succeeded but no access_token was returned.');
  }
  if (!tokens.refresh_token) {
    throw new MissingRefreshTokenError();
  }
  if (!tokens.expiry_date) {
    throw new Error('Exchange succeeded but no expiry_date was returned.');
  }
  const scope = tokens.scope ?? '';
  if (!scope.split(' ').includes(GMAIL_SCOPE)) {
    throw new InsufficientScopeError(scope);
  }

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    scope,
    token_type: tokens.token_type ?? 'Bearer',
  };
}

/**
 * Fetch the authenticated Gmail address via
 * `gmail.users.getProfile({ userId: 'me' })`.
 * Returns the `emailAddress` field. Caller passes a fresh access token.
 */
export async function fetchGmailUserEmail(accessToken: string): Promise<string> {
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const { data } = await gmail.users.getProfile({ userId: 'me' });
  const email = data.emailAddress;
  if (!email) {
    throw new Error('Gmail profile returned no emailAddress.');
  }
  return email;
}

/**
 * Best-effort revoke at Google. We don't let a revoke failure block the
 * DB delete — the DB row is the source of truth for "connected" state.
 */
export async function revokeTokens(refreshToken: string): Promise<void> {
  const client = getOAuthClient();
  await client.revokeToken(refreshToken);
}
