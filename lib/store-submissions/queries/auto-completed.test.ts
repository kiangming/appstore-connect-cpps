/**
 * PR-16b.4 Path A unit tests for the auto-completed query module.
 *
 * SQL behavior of count_auto_completed_tickets() and
 * list_auto_completed_tickets() RPCs (latest STATE_CHANGE filter,
 * 7-day window, JOIN shape) is validated via Manual QA Scenarios A
 * + B post-deploy. These tests pin the TS layer's contract:
 * RPC argument threading, BIGINT-as-string driver edge,
 * graceful degrade on count error, and throw-on-error for list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAutoCompletedCount, listAutoCompleted } from './auto-completed';

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock('../db', () => ({
  storeDb: () => ({ rpc: mockRpc }),
}));

beforeEach(() => {
  mockRpc.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getAutoCompletedCount', () => {
  it('returns numeric count from RPC', async () => {
    mockRpc.mockResolvedValueOnce({ data: 5, error: null });

    const count = await getAutoCompletedCount();
    expect(count).toBe(5);
    expect(mockRpc).toHaveBeenCalledWith('count_auto_completed_tickets', {
      p_days: 7,
    });
  });

  it('parses BIGINT-as-string from PG driver edge', async () => {
    // Some supabase-js / PostgREST configurations surface BIGINT as
    // string. The query module coerces defensively.
    mockRpc.mockResolvedValueOnce({ data: '12', error: null });

    const count = await getAutoCompletedCount();
    expect(count).toBe(12);
  });

  it('returns 0 on RPC error (graceful degrade per PR-14.4 precedent)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'connection refused' },
    });

    const count = await getAutoCompletedCount();
    expect(count).toBe(0);
  });

  it('threads custom days override to RPC', async () => {
    mockRpc.mockResolvedValueOnce({ data: 0, error: null });

    await getAutoCompletedCount(30);
    expect(mockRpc).toHaveBeenCalledWith('count_auto_completed_tickets', {
      p_days: 30,
    });
  });
});

describe('listAutoCompleted', () => {
  it('returns rows from RPC and threads default days/limit', async () => {
    const rows = [
      { id: 'ticket-1', display_id: 'T-0001', state: 'DONE' },
      { id: 'ticket-2', display_id: 'T-0002', state: 'DONE' },
    ];
    mockRpc.mockResolvedValueOnce({ data: rows, error: null });

    const result = await listAutoCompleted();
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('ticket-1');
    expect(mockRpc).toHaveBeenCalledWith('list_auto_completed_tickets', {
      p_days: 7,
      p_limit: 100,
    });
  });

  it('throws on RPC error (vs count graceful degrade)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'permission denied' },
    });

    await expect(listAutoCompleted()).rejects.toThrow(
      /Failed to load auto-completed tickets/,
    );
  });
});
