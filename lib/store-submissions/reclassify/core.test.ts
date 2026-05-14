import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DuplicateForwardRefusedError,
  reclassifyOne,
} from './core';

const { mockMaybeSingle, mockEq, mockSelect, mockFrom, mockRpc } = vi.hoisted(
  () => ({
    mockMaybeSingle: vi.fn(),
    mockEq: vi.fn(),
    mockSelect: vi.fn(),
    mockFrom: vi.fn(),
    mockRpc: vi.fn(),
  }),
);

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom, rpc: mockRpc }),
}));

// Mock heavyweight dependencies so the test focuses on the dedup
// refuse branch — sender-resolver / classifier / rules-fetch are
// orthogonal to FD.f's Q10 refusal logic.
vi.mock('../gmail/sender-resolver', () => ({
  loadActiveSenders: vi.fn().mockResolvedValue([]),
  createSenderResolver: vi.fn(() => () => null),
}));
vi.mock('../queries/rules', () => ({
  getRulesSnapshotForPlatform: vi.fn().mockResolvedValue(null),
}));
vi.mock('../classifier', () => ({
  classify: vi.fn(),
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

describe('reclassifyOne — DUPLICATE_FORWARD refusal (Q10 Option I)', () => {
  it('throws DuplicateForwardRefusedError when row is DUPLICATE_FORWARD', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: EMAIL_ID,
        sender_email: 'no-reply@email.apple.com',
        subject: 'Forwarded copy',
        raw_body_text: 'body',
        extracted_payload: null,
        classification_result: { status: 'CLASSIFIED' },
        ticket_id: null,
        classification_status: 'DUPLICATE_FORWARD',
        duplicate_of_email_id: ORIGINAL_ID,
      },
      error: null,
    });

    await expect(reclassifyOne(EMAIL_ID, ACTOR)).rejects.toBeInstanceOf(
      DuplicateForwardRefusedError,
    );
  });

  it('refusal message points Manager at the original email id', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: EMAIL_ID,
        sender_email: 'x@apple.com',
        subject: 's',
        raw_body_text: null,
        extracted_payload: null,
        classification_result: null,
        ticket_id: null,
        classification_status: 'DUPLICATE_FORWARD',
        duplicate_of_email_id: ORIGINAL_ID,
      },
      error: null,
    });

    try {
      await reclassifyOne(EMAIL_ID, ACTOR);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateForwardRefusedError);
      const dre = err as DuplicateForwardRefusedError;
      expect(dre.originalEmailId).toBe(ORIGINAL_ID);
      expect(dre.message).toContain(ORIGINAL_ID);
      expect(dre.message).toContain(EMAIL_ID);
    }
  });

  it('refusal gracefully handles null duplicate_of_email_id (purged original)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: EMAIL_ID,
        sender_email: 'x@apple.com',
        subject: 's',
        raw_body_text: null,
        extracted_payload: null,
        classification_result: null,
        ticket_id: null,
        classification_status: 'DUPLICATE_FORWARD',
        duplicate_of_email_id: null,
      },
      error: null,
    });

    try {
      await reclassifyOne(EMAIL_ID, ACTOR);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateForwardRefusedError);
      const dre = err as DuplicateForwardRefusedError;
      expect(dre.originalEmailId).toBeNull();
      expect(dre.message).toContain('no longer available');
    }
  });

  it('refuses BEFORE any RPC call (avoids server roundtrip)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        id: EMAIL_ID,
        sender_email: 'x@apple.com',
        subject: 's',
        raw_body_text: null,
        extracted_payload: null,
        classification_result: null,
        ticket_id: null,
        classification_status: 'DUPLICATE_FORWARD',
        duplicate_of_email_id: ORIGINAL_ID,
      },
      error: null,
    });

    await expect(reclassifyOne(EMAIL_ID, ACTOR)).rejects.toBeInstanceOf(
      DuplicateForwardRefusedError,
    );

    expect(mockRpc).not.toHaveBeenCalled();
  });
});
