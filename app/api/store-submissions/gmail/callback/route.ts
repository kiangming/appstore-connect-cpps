/**
 * GET /api/store-submissions/gmail/callback
 *
 * Google OAuth redirect target for the Gmail connect flow. Handles:
 *   - User denial at consent screen (?error=access_denied).
 *   - CSRF validation: state query param must match the httpOnly
 *     `gmail_oauth_state` cookie set by getGmailConnectUrlAction.
 *   - Code exchange → token save (encrypted) → emailAddress lookup.
 *
 * On any failure, redirects back to the Settings page with
 * `?gmail=error&reason=<code>` so the UI can render a toast. Success
 * redirects with `?gmail=connected`. The state cookie is always cleared
 * to prevent replay.
 *
 * MANAGER role is still required at the callback: a VIEWER/DEV who
 * somehow obtained a consent URL cannot complete the connect.
 */

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';

import { authOptions } from '@/lib/auth';
import {
  StoreForbiddenError,
  StoreUnauthorizedError,
  requireStoreRole,
} from '@/lib/store-submissions/auth';
import { saveGmailCredentials } from '@/lib/store-submissions/gmail/credentials';
import {
  InsufficientScopeError,
  MissingRefreshTokenError,
  OAUTH_STATE_COOKIE,
  exchangeCodeForTokens,
  fetchGmailUserEmail,
  resolveBaseUrl,
} from '@/lib/store-submissions/gmail/oauth';
import { resetConsecutiveFailures } from '@/lib/store-submissions/gmail/sync-state';

const SETTINGS_PATH = '/store-submissions/config/settings';

type FailureReason =
  | 'access_denied'
  | 'invalid_params'
  | 'invalid_state'
  | 'unauthorized'
  | 'exchange_failed'
  | 'missing_refresh_token'
  | 'insufficient_scope'
  | 'profile_fetch_failed'
  | 'save_failed';

/**
 * Build the post-OAuth redirect using the env-based base URL helper —
 * the SAME helper that constructs the OAuth `redirect_uri` sent to
 * Google in `buildCallbackUrl()`. This keeps both sides of the OAuth
 * dance symmetric: if env (`NEXTAUTH_URL` / `RAILWAY_PUBLIC_DOMAIN` /
 * `VERCEL_URL`) is set correctly for the inbound URI, it's also correct
 * for the outbound redirect.
 *
 * **Why not `request.url`** (PR-12.8 hotfix): behind Railway's edge
 * proxy, `request.url` is reconstructed from the inbound `Host` header
 * which can reflect the internal Next.js port (e.g. `localhost:8080`)
 * rather than the external Railway domain. Symptom: post-callback
 * `Location: https://localhost:8080/...` browser cannot follow.
 * `resolveBaseUrl()` reads explicit env vars and is immune to proxy
 * header drift.
 */
function redirectWith(params: Record<string, string>): NextResponse {
  const url = new URL(SETTINGS_PATH, resolveBaseUrl());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

function fail(reason: FailureReason): NextResponse {
  return redirectWith({ gmail: 'error', reason });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const googleError = url.searchParams.get('error');

  // Always clear the state cookie — one-time use, even on failure.
  const jar = cookies();
  const cookieState = jar.get(OAUTH_STATE_COOKIE)?.value ?? null;
  jar.delete(OAUTH_STATE_COOKIE);

  // 1. User denied consent (Google sends ?error=access_denied)
  if (googleError) {
    return fail('access_denied');
  }

  // 2. Missing required params
  if (!code || !state) {
    return fail('invalid_params');
  }

  // 3. CSRF: state must match the cookie we set before redirecting out
  if (!cookieState || cookieState !== state) {
    return fail('invalid_state');
  }

  // 4. Auth: user still needs MANAGER when the callback lands
  const session = await getServerSession(authOptions);
  let user;
  try {
    user = await requireStoreRole(session?.user?.email, 'MANAGER');
  } catch (err) {
    if (
      err instanceof StoreUnauthorizedError ||
      err instanceof StoreForbiddenError
    ) {
      return fail('unauthorized');
    }
    throw err;
  }

  // 5. Exchange code for tokens (one-time code — Google rejects replays)
  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code);
  } catch (err) {
    console.error('[gmail-callback] Exchange failed:', err);
    if (err instanceof MissingRefreshTokenError) {
      return fail('missing_refresh_token');
    }
    if (err instanceof InsufficientScopeError) {
      return fail('insufficient_scope');
    }
    return fail('exchange_failed');
  }

  // 6. Fetch the Gmail address for display + audit
  let gmailEmail: string;
  try {
    gmailEmail = await fetchGmailUserEmail(tokens.access_token);
  } catch (err) {
    console.error('[gmail-callback] Profile fetch failed:', err);
    return fail('profile_fetch_failed');
  }

  // 7. Persist encrypted credentials
  try {
    await saveGmailCredentials({
      email: gmailEmail,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: new Date(tokens.expiry_date),
      scopes: tokens.scope.split(' ').filter(Boolean),
      connected_by: user.id,
    });
  } catch (err) {
    console.error('[gmail-callback] Save failed:', err);
    return fail('save_failed');
  }

  // 8. Clear the failure counter so the resilience banner (PR-24)
  //    disappears immediately on reconnect. Without this, the counter
  //    would only reset on the next *refresh-required* sync — up to
  //    1 hour later, since the freshly-saved access_token has ~3600s
  //    of life and skips `performRefresh` until it expires.
  //
  //    Best-effort: a reset failure is logged but does NOT undo the
  //    successful credential save. The next refresh path will reset
  //    the counter anyway.
  try {
    await resetConsecutiveFailures();
  } catch (err) {
    console.error('[gmail-callback] Failure-counter reset failed:', err);
  }

  return redirectWith({ gmail: 'connected' });
}
