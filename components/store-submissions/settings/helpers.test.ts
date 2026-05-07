import { describe, expect, it } from 'vitest';

import type {
  BackfillStatus,
  GmailStatus,
} from '@/app/(dashboard)/store-submissions/config/settings/actions';
import {
  GMAIL_ERROR_FALLBACK,
  GMAIL_ERROR_MESSAGES,
  classifyStatus,
  messageForReason,
  shouldShowBanner,
  truncateError,
} from './helpers';

// ---------------------------------------------------------------------------
// classifyStatus
// ---------------------------------------------------------------------------

describe('classifyStatus', () => {
  it('returns disconnected when not connected', () => {
    expect(classifyStatus({ connected: false })).toBe('disconnected');
  });

  it('returns connected when credentials row exists', () => {
    const connected: GmailStatus = {
      connected: true,
      email: 'shared@studio.com',
      connected_at: '2026-04-01T00:00:00Z',
      last_refreshed_at: null,
    };
    expect(classifyStatus(connected)).toBe('connected');
  });

  it('ignores absent optional fields (email / connected_at)', () => {
    // Defensive: even if the action surfaces only `connected: true`, we still
    // classify as connected. Prevents a disconnected fallback on partial data.
    expect(classifyStatus({ connected: true } as GmailStatus)).toBe('connected');
  });
});

// ---------------------------------------------------------------------------
// messageForReason
// ---------------------------------------------------------------------------

describe('messageForReason', () => {
  it('returns fallback for null / undefined / empty', () => {
    expect(messageForReason(null)).toBe(GMAIL_ERROR_FALLBACK);
    expect(messageForReason(undefined)).toBe(GMAIL_ERROR_FALLBACK);
    expect(messageForReason('')).toBe(GMAIL_ERROR_FALLBACK);
  });

  it('returns fallback for unknown reason (future-proofing)', () => {
    expect(messageForReason('newfangled_reason')).toBe(GMAIL_ERROR_FALLBACK);
  });

  it('maps each documented FailureReason to a user-friendly message', () => {
    const reasons = [
      'access_denied',
      'invalid_params',
      'invalid_state',
      'unauthorized',
      'exchange_failed',
      'missing_refresh_token',
      'insufficient_scope',
      'profile_fetch_failed',
      'save_failed',
    ];
    for (const r of reasons) {
      expect(GMAIL_ERROR_MESSAGES[r]).toBeDefined();
      expect(messageForReason(r)).toBe(GMAIL_ERROR_MESSAGES[r]);
      expect(messageForReason(r)).toMatch(/\.$/);
      expect(messageForReason(r).length).toBeGreaterThan(5);
    }
  });
});

// ---------------------------------------------------------------------------
// shouldShowBanner — PR-24 smart-threshold (decision C.3)
// ---------------------------------------------------------------------------

function mkBackfillStatus(
  overrides: Partial<BackfillStatus> = {},
): BackfillStatus {
  return {
    last_full_sync_at: null,
    last_synced_at: null,
    consecutive_failures: 0,
    last_error: null,
    recovery_threshold_days: 2,
    ...overrides,
  };
}

describe('shouldShowBanner', () => {
  it('hides banner when counter is 0 (no failures)', () => {
    expect(shouldShowBanner(mkBackfillStatus())).toBe(false);
  });

  it('hides banner on transient single failure (counter=1, non-terminal error)', () => {
    expect(
      shouldShowBanner(
        mkBackfillStatus({
          consecutive_failures: 1,
          last_error: '500 internal server error',
        }),
      ),
    ).toBe(false);
  });

  it('hides banner when counter=1 and last_error is null (transient assumed)', () => {
    expect(
      shouldShowBanner(
        mkBackfillStatus({ consecutive_failures: 1, last_error: null }),
      ),
    ).toBe(false);
  });

  it('hides banner when counter=2 and error is non-terminal (still under threshold)', () => {
    expect(
      shouldShowBanner(
        mkBackfillStatus({
          consecutive_failures: 2,
          last_error: 'Network timeout',
        }),
      ),
    ).toBe(false);
  });

  it('shows banner immediately on terminal invalid_grant (counter=1)', () => {
    expect(
      shouldShowBanner(
        mkBackfillStatus({
          consecutive_failures: 1,
          last_error: 'invalid_grant: Token has been expired or revoked.',
        }),
      ),
    ).toBe(true);
  });

  it('shows banner immediately on RefreshTokenInvalidError (counter=1)', () => {
    expect(
      shouldShowBanner(
        mkBackfillStatus({
          consecutive_failures: 1,
          last_error: 'RefreshTokenInvalidError: Reconnect Gmail from Settings.',
        }),
      ),
    ).toBe(true);
  });

  it('shows banner on transient accumulation when counter >= 3', () => {
    expect(
      shouldShowBanner(
        mkBackfillStatus({
          consecutive_failures: 3,
          last_error: '503 service unavailable',
        }),
      ),
    ).toBe(true);
  });

  it('shows banner when counter >= 3 even with last_error null', () => {
    expect(
      shouldShowBanner(
        mkBackfillStatus({ consecutive_failures: 5, last_error: null }),
      ),
    ).toBe(true);
  });

  it('matches terminal pattern case-insensitively', () => {
    expect(
      shouldShowBanner(
        mkBackfillStatus({
          consecutive_failures: 1,
          last_error: 'INVALID_GRANT failure',
        }),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// truncateError
// ---------------------------------------------------------------------------

describe('truncateError', () => {
  it('returns the input unchanged when shorter than maxLen', () => {
    expect(truncateError('short', 100)).toBe('short');
  });

  it('returns the input unchanged when length === maxLen', () => {
    expect(truncateError('exactlyten', 10)).toBe('exactlyten');
  });

  it('truncates with ellipsis when length > maxLen', () => {
    const result = truncateError('x'.repeat(200), 50);
    expect(result.length).toBe(50);
    expect(result.endsWith('…')).toBe(true);
    expect(result.slice(0, 49)).toBe('x'.repeat(49));
  });
});
