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
} from '@/lib/store-submissions/gmail/oauth';

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

function redirectWith(
  request: NextRequest,
  params: Record<string, string>,
): NextResponse {
  const url = new URL(SETTINGS_PATH, request.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

function fail(request: NextRequest, reason: FailureReason): NextResponse {
  return redirectWith(request, { gmail: 'error', reason });
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
    return fail(request, 'access_denied');
  }

  // 2. Missing required params
  if (!code || !state) {
    return fail(request, 'invalid_params');
  }

  // 3. CSRF: state must match the cookie we set before redirecting out
  if (!cookieState || cookieState !== state) {
    return fail(request, 'invalid_state');
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
      return fail(request, 'unauthorized');
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
      return fail(request, 'missing_refresh_token');
    }
    if (err instanceof InsufficientScopeError) {
      return fail(request, 'insufficient_scope');
    }
    return fail(request, 'exchange_failed');
  }

  // 6. Fetch the Gmail address for display + audit
  let gmailEmail: string;
  try {
    gmailEmail = await fetchGmailUserEmail(tokens.access_token);
  } catch (err) {
    console.error('[gmail-callback] Profile fetch failed:', err);
    return fail(request, 'profile_fetch_failed');
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
    return fail(request, 'save_failed');
  }

  return redirectWith(request, { gmail: 'connected' });
}
