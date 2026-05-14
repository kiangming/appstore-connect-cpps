import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DuplicateForwardRefusedError,
  backfillOne,
} from './core';

const { mockMaybeSingle, mockEq, mockSelect, mockFrom } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockEq: vi.fn(),
  mockSelect: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

beforeEach(() => {
  mockFrom.mockReturnValue({ select: mockSelect });
  mockSelect.mockReturnValue({ eq: mockEq });
  mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.resetAllMocks();
});

const ACTOR = 'actor-uuid';
const EMAIL_ID = 'email-dup-uuid';
const ORIGINAL_ID = 'email-original-uuid';

const ctx = {
  // gmailClient.getMessage should never be reached on the refusal path.
  // Use a stub that fails loudly if it IS called — guards against
  // future regressions where the refusal check moves below the
  // expensive Gmail fetch.
  gmailClient: {
    rest: vi.fn(() => {
      throw new Error('Gmail client should not be called on refusal');
    }),
  } as unknown as Parameters<typeof backfillOne>[2]['gmailClient'],
  isAppleSender: () => true,
};

describe('backfillOne — DUPLICATE_FORWARD refusal (Q10 Option I)', () => {
  it('throws DuplicateForwardRefusedError when row is DUPLICATE_FORWARD', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: EMAIL_ID,
        gmail_msg_id: 'gmail-msg-1',
        sender_email: 'no-reply@email.apple.com',
        classification_status: 'DUPLICATE_FORWARD',
        duplicate_of_email_id: ORIGINAL_ID,
      },
      error: null,
    });

    await expect(backfillOne(EMAIL_ID, ACTOR, ctx)).rejects.toBeInstanceOf(
      DuplicateForwardRefusedError,
    );
  });

  it('refusal message points at original email id', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: EMAIL_ID,
        gmail_msg_id: 'gmail-msg-1',
        sender_email: 'x@apple.com',
        classification_status: 'DUPLICATE_FORWARD',
        duplicate_of_email_id: ORIGINAL_ID,
      },
      error: null,
    });

    try {
      await backfillOne(EMAIL_ID, ACTOR, ctx);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateForwardRefusedError);
      const dre = err as DuplicateForwardRefusedError;
      expect(dre.originalEmailId).toBe(ORIGINAL_ID);
      expect(dre.message).toContain(ORIGINAL_ID);
    }
  });

  it('refuses BEFORE Gmail fetch (avoids API quota burn on no-op)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: EMAIL_ID,
        gmail_msg_id: 'gmail-msg-1',
        sender_email: 'x@apple.com',
        classification_status: 'DUPLICATE_FORWARD',
        duplicate_of_email_id: ORIGINAL_ID,
      },
      error: null,
    });

    // gmailClient.rest above throws if invoked; if it IS reached the
    // test bombs with the loud "should not be called" error rather
    // than the expected DuplicateForwardRefusedError.
    await expect(backfillOne(EMAIL_ID, ACTOR, ctx)).rejects.toBeInstanceOf(
      DuplicateForwardRefusedError,
    );
  });
});
