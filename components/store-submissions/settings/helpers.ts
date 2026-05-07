/**
 * Pure helpers for SettingsClient. Extracted here so they can be unit-tested
 * without standing up jsdom / @testing-library (the rest of the project is
 * a node-env vitest suite — see vitest.config.ts).
 */

import type {
  BackfillStatus,
  GmailStatus,
} from '@/app/(dashboard)/store-submissions/config/settings/actions';

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

/* ============================================================================
 * Token resilience banner (PR-24)
 * ========================================================================== */

/**
 * Recognizes errors that mean "Manager must reconnect Gmail" — distinct
 * from transient failures (5xx, rate-limit, parse glitches) that bump the
 * same `consecutive_failures` counter but resolve on their own.
 *
 * Matches both the googleapis OAuth response (`invalid_grant`) and our
 * own thrown class name (`RefreshTokenInvalidError`) since the counter is
 * stamped from `err.message` which can carry either form.
 */
export const TERMINAL_ERROR_PATTERN = /invalid_grant|RefreshTokenInvalid/i;

/**
 * Smart threshold (PR-24 decision C.3): the banner surfaces immediately
 * when the last error is terminal (token revoked / expired refresh token),
 * but waits for `consecutive_failures >= 3` on transient errors so a
 * single 5xx blip doesn't undermine the banner's credibility.
 *
 * Returns false when:
 *   - counter is 0 (no failures at all)
 *   - counter is 1-2 AND lastError is null OR non-terminal
 */
export function shouldShowBanner(status: BackfillStatus): boolean {
  if (status.consecutive_failures === 0) return false;

  const isTerminal =
    status.last_error !== null &&
    TERMINAL_ERROR_PATTERN.test(status.last_error);

  return isTerminal || status.consecutive_failures >= 3;
}

/**
 * Truncate a string to `maxLen` chars with a trailing ellipsis. Used to
 * keep `last_error` readable in the banner without overflowing the UI.
 */
export function truncateError(message: string, maxLen: number): string {
  if (message.length <= maxLen) return message;
  return `${message.slice(0, maxLen - 1)}…`;
}
