import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCorruptPayloadCount } from './corrupt-payload';

const { mockNotIs, mockNotIn, mockOr, mockSelect, mockFrom } = vi.hoisted(
  () => ({
    mockNotIs: vi.fn(),
    mockNotIn: vi.fn(),
    mockOr: vi.fn(),
    mockSelect: vi.fn(),
    mockFrom: vi.fn(),
  }),
);

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

beforeEach(() => {
  // Chain: from('email_messages').select(..., { count, head }).or(...).not(extracted_payload IS NOT NULL).not(classification_status NOT IN ...)
  mockFrom.mockReturnValue({ select: mockSelect });
  mockSelect.mockReturnValue({ or: mockOr });
  mockOr.mockReturnValue({ not: mockNotIs });
  mockNotIs.mockReturnValue({ not: mockNotIn });
  // Terminal: simulate "0 corrupt rows" success
  mockNotIn.mockResolvedValue({ count: 0, error: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('getCorruptPayloadCount — PR-Inbox.ForwardDedup exclusion', () => {
  it('excludes both DROPPED and DUPLICATE_FORWARD from the candidate set', async () => {
    await getCorruptPayloadCount();

    // The first `.not(...)` is `extracted_payload IS NOT NULL` —
    // verify by argument shape.
    expect(mockNotIs).toHaveBeenCalledWith(
      'extracted_payload',
      'is',
      null,
    );

    // The second `.not(...)` is the NOT IN filter for status —
    // FD.f finding: must list BOTH DROPPED and DUPLICATE_FORWARD.
    const [col, op, valueArg] = mockNotIn.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(col).toBe('classification_status');
    expect(op).toBe('in');
    expect(valueArg).toContain('DROPPED');
    expect(valueArg).toContain('DUPLICATE_FORWARD');
  });

  it('returns the count from the supabase response', async () => {
    mockNotIn.mockResolvedValueOnce({ count: 7, error: null });
    expect(await getCorruptPayloadCount()).toBe(7);
  });

  it('degrades to 0 on error (banner must not break Inbox page render)', async () => {
    mockNotIn.mockResolvedValueOnce({
      count: null,
      error: { message: 'oops' },
    });
    expect(await getCorruptPayloadCount()).toBe(0);
  });
});
