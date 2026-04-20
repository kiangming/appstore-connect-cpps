import { describe, expect, it } from 'vitest';

import type { GmailStatus } from '@/app/(dashboard)/store-submissions/config/settings/actions';
import {
  EXPIRY_WARNING_DAYS,
  GMAIL_ERROR_FALLBACK,
  GMAIL_ERROR_MESSAGES,
  classifyStatus,
  messageForReason,
} from './helpers';

// ---------------------------------------------------------------------------
// classifyStatus
// ---------------------------------------------------------------------------

const HEALTHY: GmailStatus = {
  connected: true,
  email: 'shared@studio.com',
  connected_at: '2026-04-01T00:00:00Z',
  expires_at: '2026-05-01T00:00:00Z',
  expiry_days: 30,
  expired: false,
  last_refreshed_at: null,
};

describe('classifyStatus', () => {
  it('returns disconnected when not connected', () => {
    expect(classifyStatus({ connected: false })).toBe('disconnected');
  });

  it('returns expired when server flag is true, even if expiry_days>0', () => {
    // Defensive: server-side truth beats client-side day math.
    expect(
      classifyStatus({
        ...HEALTHY,
        expired: true,
        expiry_days: 5, // stale snapshot
      }),
    ).toBe('expired');
  });

  it('returns expiring when 0 < expiry_days ≤ EXPIRY_WARNING_DAYS', () => {
    expect(classifyStatus({ ...HEALTHY, expiry_days: EXPIRY_WARNING_DAYS })).toBe(
      'expiring',
    );
    expect(classifyStatus({ ...HEALTHY, expiry_days: 1 })).toBe('expiring');
    expect(classifyStatus({ ...HEALTHY, expiry_days: 0 })).toBe('expiring');
  });

  it('returns expiring for negative expiry_days that are not yet flagged expired', () => {
    // Should not actually happen (server should set expired=true), but we
    // still want to render a warning rather than "healthy".
    expect(
      classifyStatus({ ...HEALTHY, expiry_days: -1, expired: false }),
    ).toBe('expiring');
  });

  it('returns healthy when expiry_days > EXPIRY_WARNING_DAYS', () => {
    expect(
      classifyStatus({ ...HEALTHY, expiry_days: EXPIRY_WARNING_DAYS + 1 }),
    ).toBe('healthy');
    expect(classifyStatus({ ...HEALTHY, expiry_days: 365 })).toBe('healthy');
  });

  it('returns healthy when expiry_days missing (server forgot to compute)', () => {
    expect(
      classifyStatus({
        connected: true,
        email: 'x@y.com',
        expired: false,
      } as GmailStatus),
    ).toBe('healthy');
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
      // sanity: message is non-empty + ends with a period
      expect(messageForReason(r)).toMatch(/\.$/);
      expect(messageForReason(r).length).toBeGreaterThan(5);
    }
  });
});
