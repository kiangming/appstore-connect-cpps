/**
 * Pure helpers for SettingsClient. Extracted here so they can be unit-tested
 * without standing up jsdom / @testing-library (the rest of the project is
 * a node-env vitest suite — see vitest.config.ts).
 */

import type { GmailStatus } from '@/app/(dashboard)/store-submissions/config/settings/actions';

/**
 * The UI surfaces Gmail connectivity as a 2-state model:
 *   - `disconnected`: no credentials row OR refresh_token revoked at Google.
 *   - `connected`: row exists; access_token refresh is handled transparently
 *     by PR-7 sync via the googleapis `oauth2.on('tokens')` event.
 *
 * Per docs/store-submissions/02-gmail-sync.md §6, access_token expiry is an
 * internal mechanism, not a user-facing state — so no "expiring" or
 * "expired" variants here. A refresh_token revoke surfaces via PR-7 sync's
 * `consecutive_failures` counter, not via this component.
 */
export type GmailStatusKind = 'disconnected' | 'connected';

export function classifyStatus(status: GmailStatus): GmailStatusKind {
  return status.connected ? 'connected' : 'disconnected';
}

/**
 * Toast messages for the query-param handler. Keys mirror the
 * `FailureReason` union in the Gmail callback route.
 */
export const GMAIL_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Gmail connection cancelled.',
  invalid_params: 'Google did not return the expected parameters. Try again.',
  invalid_state: 'Security check failed. Please try again.',
  unauthorized: 'Permission denied — only Managers can connect Gmail.',
  exchange_failed:
    'Failed to exchange code with Google. Check redirect URI in Google Cloud Console.',
  missing_refresh_token:
    'Google did not return a refresh token. Revoke access at myaccount.google.com/permissions and retry.',
  insufficient_scope:
    'Missing Gmail permissions. Re-run Connect and tick all requested scopes.',
  profile_fetch_failed: 'Failed to fetch Gmail profile. Check scope permissions.',
  save_failed: 'Failed to save credentials. Retry, or check server logs.',
};

export const GMAIL_ERROR_FALLBACK = 'Gmail connection failed.';

export function messageForReason(reason: string | null | undefined): string {
  if (!reason) return GMAIL_ERROR_FALLBACK;
  return GMAIL_ERROR_MESSAGES[reason] ?? GMAIL_ERROR_FALLBACK;
}
