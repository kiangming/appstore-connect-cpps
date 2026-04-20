/**
 * Pure helpers for SettingsClient. Extracted here so they can be unit-tested
 * without standing up jsdom / @testing-library (the rest of the project is
 * a node-env vitest suite — see vitest.config.ts).
 */

import type { GmailStatus } from '@/app/(dashboard)/store-submissions/config/settings/actions';

export type GmailStatusKind = 'disconnected' | 'healthy' | 'expiring' | 'expired';

/** Show the amber "Expiring" pill once fewer than 7 days remain. */
export const EXPIRY_WARNING_DAYS = 7;

/**
 * Map a raw status row to one of four UI states. Precedence:
 *   disconnected > expired > expiring > healthy.
 * `expired` is authoritative over `expiry_days` because a server-side
 * timestamp comparison (status.expired) trumps client-computed day math.
 */
export function classifyStatus(status: GmailStatus): GmailStatusKind {
  if (!status.connected) return 'disconnected';
  if (status.expired) return 'expired';
  if (
    typeof status.expiry_days === 'number' &&
    status.expiry_days <= EXPIRY_WARNING_DAYS
  ) {
    return 'expiring';
  }
  return 'healthy';
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
