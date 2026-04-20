import { describe, expect, it } from 'vitest';

import type { GmailStatus } from '@/app/(dashboard)/store-submissions/config/settings/actions';
import {
  GMAIL_ERROR_FALLBACK,
  GMAIL_ERROR_MESSAGES,
  classifyStatus,
  messageForReason,
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
