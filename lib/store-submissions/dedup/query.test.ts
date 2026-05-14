import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEDUP_WINDOW_MS, findFingerprintMatch } from './query';

const { mockMaybeSingle, mockLimit, mockOrder, mockLteRx, mockGteRx, mockEq2, mockEq1, mockSelect, mockFrom } =
  vi.hoisted(() => ({
    mockMaybeSingle: vi.fn(),
    mockLimit: vi.fn(),
    mockOrder: vi.fn(),
    mockLteRx: vi.fn(),
    mockGteRx: vi.fn(),
    mockEq2: vi.fn(),
    mockEq1: vi.fn(),
    mockSelect: vi.fn(),
    mockFrom: vi.fn(),
  }));

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

beforeEach(() => {
  mockFrom.mockReturnValue({ select: mockSelect });
  mockSelect.mockReturnValue({ eq: mockEq1 });
  mockEq1.mockReturnValue({ eq: mockEq2 });
  mockEq2.mockReturnValue({ gte: mockGteRx });
  mockGteRx.mockReturnValue({ lte: mockLteRx });
  mockLteRx.mockReturnValue({ order: mockOrder });
  mockOrder.mockReturnValue({ limit: mockLimit });
  mockLimit.mockReturnValue({ maybeSingle: mockMaybeSingle });
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('findFingerprintMatch', () => {
  const FINGERPRINT = 'apple|app-1|type-1|APPROVED|sub-id|1.0.0';
  const RECEIVED = new Date('2026-05-14T10:00:00Z');

  it('returns null when no match exists', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const result = await findFingerprintMatch(FINGERPRINT, RECEIVED);
    expect(result).toBeNull();
  });

  it('returns the matched row when one exists', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { id: 'original-1', received_at: '2026-05-14T09:58:30Z' },
      error: null,
    });
    const result = await findFingerprintMatch(FINGERPRINT, RECEIVED);
    expect(result).toEqual({
      id: 'original-1',
      received_at: '2026-05-14T09:58:30Z',
    });
  });

  it('queries with ±5min symmetric window around received_at', async () => {
    await findFingerprintMatch(FINGERPRINT, RECEIVED);
    const gteArg = mockGteRx.mock.calls[0][1] as string;
    const lteArg = mockLteRx.mock.calls[0][1] as string;
    const gteMs = new Date(gteArg).getTime();
    const lteMs = new Date(lteArg).getTime();
    expect(RECEIVED.getTime() - gteMs).toBe(DEDUP_WINDOW_MS);
    expect(lteMs - RECEIVED.getTime()).toBe(DEDUP_WINDOW_MS);
  });

  it('filters by fingerprint + CLASSIFIED status (excludes other duplicates)', async () => {
    await findFingerprintMatch(FINGERPRINT, RECEIVED);
    expect(mockEq1).toHaveBeenCalledWith('duplicate_fingerprint', FINGERPRINT);
    expect(mockEq2).toHaveBeenCalledWith('classification_status', 'CLASSIFIED');
  });

  it('orders by received_at ASC and limits to 1', async () => {
    await findFingerprintMatch(FINGERPRINT, RECEIVED);
    expect(mockOrder).toHaveBeenCalledWith('received_at', { ascending: true });
    expect(mockLimit).toHaveBeenCalledWith(1);
  });

  it('throws when the supabase call returns an error', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection refused' },
    });
    await expect(findFingerprintMatch(FINGERPRINT, RECEIVED)).rejects.toThrow(
      /Failed to look up fingerprint: connection refused/,
    );
  });
});

describe('DEDUP_WINDOW_MS', () => {
  it('is exactly 5 minutes in ms (Manager Q1 LOCKED)', () => {
    expect(DEDUP_WINDOW_MS).toBe(300_000);
  });
});
