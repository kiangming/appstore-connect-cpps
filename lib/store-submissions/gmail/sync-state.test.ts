import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const {
  mockMaybeSingle,
  mockEq,
  mockSelect,
  mockUpdate,
  mockUpdateEq,
  mockInsert,
  mockRpc,
  mockFrom,
} = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockEq: vi.fn(),
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateEq: vi.fn(),
  mockInsert: vi.fn(),
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom, rpc: mockRpc }),
}));

beforeEach(() => {
  const chain = {
    select: mockSelect,
    eq: mockEq,
    maybeSingle: mockMaybeSingle,
    update: mockUpdate,
    insert: mockInsert,
  };
  mockFrom.mockReturnValue(chain);
  mockSelect.mockReturnValue(chain);
  mockEq.mockReturnValue(chain);
  mockUpdate.mockReturnValue({ eq: mockUpdateEq });
  mockUpdateEq.mockResolvedValue({ error: null });
  mockInsert.mockResolvedValue({ error: null });
  mockRpc.mockResolvedValue({ data: true, error: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('bumpConsecutiveFailures', () => {
  it('reads current count, writes N+1 with truncated message + timestamp', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { consecutive_failures: 2 },
      error: null,
    });
    let captured = null as Record<string, unknown> | null;
    mockUpdate.mockImplementationOnce((payload: Record<string, unknown>) => {
      captured = payload;
      return { eq: mockUpdateEq };
    });

    const { bumpConsecutiveFailures } = await import('./sync-state');
    await bumpConsecutiveFailures('invalid_grant: revoked');

    expect(mockFrom).toHaveBeenCalledWith('gmail_sync_state');
    const payload: Record<string, unknown> | null = captured;
    if (!payload) throw new Error('update not called');
    expect(payload.consecutive_failures).toBe(3);
    expect(payload.last_error).toBe('invalid_grant: revoked');
    expect(payload.last_error_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 1);
  });

  it('treats NULL current failures as 0 (new row)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { consecutive_failures: null },
      error: null,
    });
    let captured = null as Record<string, unknown> | null;
    mockUpdate.mockImplementationOnce((payload: Record<string, unknown>) => {
      captured = payload;
      return { eq: mockUpdateEq };
    });

    const { bumpConsecutiveFailures } = await import('./sync-state');
    await bumpConsecutiveFailures('err');
    const payload: Record<string, unknown> | null = captured;
    if (!payload) throw new Error('update not called');
    expect(payload.consecutive_failures).toBe(1);
  });

  it('truncates error messages >1000 chars', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { consecutive_failures: 0 },
      error: null,
    });
    let captured = null as Record<string, unknown> | null;
    mockUpdate.mockImplementationOnce((payload: Record<string, unknown>) => {
      captured = payload;
      return { eq: mockUpdateEq };
    });

    const long = 'x'.repeat(2000);
    const { bumpConsecutiveFailures } = await import('./sync-state');
    await bumpConsecutiveFailures(long);

    const payload: Record<string, unknown> | null = captured;
    if (!payload) throw new Error('update not called');
    const msg = payload.last_error as string;
    expect(msg.length).toBe(1000);
    expect(msg.endsWith('...')).toBe(true);
  });

  it('throws when singleton row is missing (migration issue)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { bumpConsecutiveFailures } = await import('./sync-state');
    await expect(bumpConsecutiveFailures('err')).rejects.toThrow(
      /singleton row missing/,
    );
  });

  it('throws when DB read errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'boom' },
    });
    const { bumpConsecutiveFailures } = await import('./sync-state');
    await expect(bumpConsecutiveFailures('err')).rejects.toThrow(
      /Failed to read gmail_sync_state/,
    );
    errorSpy.mockRestore();
  });

  it('throws when DB write errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockMaybeSingle.mockResolvedValueOnce({
      data: { consecutive_failures: 0 },
      error: null,
    });
    mockUpdateEq.mockResolvedValueOnce({ error: { message: 'boom' } });
    const { bumpConsecutiveFailures } = await import('./sync-state');
    await expect(bumpConsecutiveFailures('err')).rejects.toThrow(
      /Failed to update gmail_sync_state/,
    );
    errorSpy.mockRestore();
  });
});

describe('resetConsecutiveFailures', () => {
  it('writes consecutive_failures=0, clears last_error fields', async () => {
    let captured = null as Record<string, unknown> | null;
    mockUpdate.mockImplementationOnce((payload: Record<string, unknown>) => {
      captured = payload;
      return { eq: mockUpdateEq };
    });

    const { resetConsecutiveFailures } = await import('./sync-state');
    await resetConsecutiveFailures();

    const payload: Record<string, unknown> | null = captured;
    if (!payload) throw new Error('update not called');
    expect(payload.consecutive_failures).toBe(0);
    expect(payload.last_error).toBeNull();
    expect(payload.last_error_at).toBeNull();
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 1);
  });

  it('throws when DB update errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUpdateEq.mockResolvedValueOnce({ error: { message: 'boom' } });
    const { resetConsecutiveFailures } = await import('./sync-state');
    await expect(resetConsecutiveFailures()).rejects.toThrow(
      /Failed to reset gmail_sync_state/,
    );
    errorSpy.mockRestore();
  });
});

/* ============================================================================
 * tryAcquireSyncLock / releaseSyncLock (7.3.1)
 * ========================================================================== */

describe('tryAcquireSyncLock', () => {
  it('calls try_acquire_sync_lock RPC with defaults when options absent', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    const { tryAcquireSyncLock, DEFAULT_LOCK_STALE_MS } = await import(
      './sync-state'
    );
    const acquired = await tryAcquireSyncLock();
    expect(acquired).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('try_acquire_sync_lock', {
      p_locked_by: 'gmail-sync',
      p_stale_after_ms: DEFAULT_LOCK_STALE_MS,
    });
  });

  it('passes custom lockedBy + staleAfterMs through', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    const { tryAcquireSyncLock } = await import('./sync-state');
    await tryAcquireSyncLock({ lockedBy: 'manual-test', staleAfterMs: 60_000 });
    expect(mockRpc).toHaveBeenCalledWith('try_acquire_sync_lock', {
      p_locked_by: 'manual-test',
      p_stale_after_ms: 60_000,
    });
  });

  it('returns false when RPC reports lock held (data: false)', async () => {
    mockRpc.mockResolvedValueOnce({ data: false, error: null });
    const { tryAcquireSyncLock } = await import('./sync-state');
    expect(await tryAcquireSyncLock()).toBe(false);
  });

  it('throws on RPC error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const { tryAcquireSyncLock } = await import('./sync-state');
    await expect(tryAcquireSyncLock()).rejects.toThrow(
      /Failed to acquire sync lock/,
    );
    errorSpy.mockRestore();
  });
});

describe('releaseSyncLock', () => {
  it('calls release_sync_lock RPC', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    const { releaseSyncLock } = await import('./sync-state');
    await releaseSyncLock();
    expect(mockRpc).toHaveBeenCalledWith('release_sync_lock');
  });

  it('swallows RPC error (idempotent) — logs but does not throw', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRpc.mockResolvedValueOnce({ error: { message: 'boom' } });
    const { releaseSyncLock } = await import('./sync-state');
    await expect(releaseSyncLock()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

/* ============================================================================
 * getSyncState
 * ========================================================================== */

describe('getSyncState', () => {
  it('maps DB row to camelCase SyncState with Dates', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        last_history_id: '12345',
        last_synced_at: '2026-04-20T10:30:00Z',
        last_full_sync_at: '2026-04-19T03:00:00Z',
        emails_processed_total: 1000,
        consecutive_failures: 2,
        last_error: 'invalid_grant',
        last_error_at: '2026-04-20T09:00:00Z',
        locked_at: null,
        locked_by: null,
      },
      error: null,
    });
    const { getSyncState } = await import('./sync-state');
    const state = await getSyncState();
    expect(state.lastHistoryId).toBe('12345');
    expect(state.lastSyncedAt).toBeInstanceOf(Date);
    expect(state.lastFullSyncAt).toBeInstanceOf(Date);
    expect(state.emailsProcessedTotal).toBe(1000);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.lastError).toBe('invalid_grant');
    expect(state.lockedAt).toBeNull();
  });

  it('handles BIGINT numeric history_id (number instead of string)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        last_history_id: 99999,
        last_synced_at: null,
        last_full_sync_at: null,
        emails_processed_total: 0,
        consecutive_failures: 0,
        last_error: null,
        last_error_at: null,
        locked_at: null,
        locked_by: null,
      },
      error: null,
    });
    const { getSyncState } = await import('./sync-state');
    const state = await getSyncState();
    expect(state.lastHistoryId).toBe('99999'); // always normalized to string
  });

  it('null history_id → null (first-run sentinel)', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        last_history_id: null,
        last_synced_at: null,
        last_full_sync_at: null,
        emails_processed_total: 0,
        consecutive_failures: 0,
        last_error: null,
        last_error_at: null,
        locked_at: null,
        locked_by: null,
      },
      error: null,
    });
    const { getSyncState } = await import('./sync-state');
    const state = await getSyncState();
    expect(state.lastHistoryId).toBeNull();
  });

  it('throws when singleton row missing', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { getSyncState } = await import('./sync-state');
    await expect(getSyncState()).rejects.toThrow(/singleton row missing/);
  });
});

/* ============================================================================
 * advanceSyncState
 * ========================================================================== */

describe('advanceSyncState', () => {
  function stubReadReturn(total: number) {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        last_history_id: '1',
        last_synced_at: null,
        last_full_sync_at: null,
        emails_processed_total: total,
        consecutive_failures: 0,
        last_error: null,
        last_error_at: null,
        locked_at: null,
        locked_by: null,
      },
      error: null,
    });
  }

  it('INCREMENTAL: writes new history_id + bumped total + last_synced_at (no last_full_sync_at)', async () => {
    stubReadReturn(100);
    let captured = null as Record<string, unknown> | null;
    mockUpdate.mockImplementationOnce((payload: Record<string, unknown>) => {
      captured = payload;
      return { eq: mockUpdateEq };
    });
    const { advanceSyncState } = await import('./sync-state');
    await advanceSyncState({
      mode: 'INCREMENTAL',
      newHistoryId: '2000',
      processedCount: 5,
    });
    const p: Record<string, unknown> | null = captured;
    if (!p) throw new Error('update not called');
    expect(p.last_history_id).toBe('2000');
    expect(p.emails_processed_total).toBe(105); // 100 + 5
    expect(p.last_synced_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(p.last_full_sync_at).toBeUndefined();
  });

  it('FALLBACK: also stamps last_full_sync_at', async () => {
    stubReadReturn(0);
    let captured = null as Record<string, unknown> | null;
    mockUpdate.mockImplementationOnce((payload: Record<string, unknown>) => {
      captured = payload;
      return { eq: mockUpdateEq };
    });
    const { advanceSyncState } = await import('./sync-state');
    await advanceSyncState({
      mode: 'FALLBACK',
      newHistoryId: '3000',
      processedCount: 10,
    });
    const p: Record<string, unknown> | null = captured;
    if (!p) throw new Error('update not called');
    expect(p.last_history_id).toBe('3000');
    expect(p.last_full_sync_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('null newHistoryId: stamps timestamps but leaves last_history_id untouched', async () => {
    stubReadReturn(0);
    let captured = null as Record<string, unknown> | null;
    mockUpdate.mockImplementationOnce((payload: Record<string, unknown>) => {
      captured = payload;
      return { eq: mockUpdateEq };
    });
    const { advanceSyncState } = await import('./sync-state');
    await advanceSyncState({
      mode: 'INCREMENTAL',
      newHistoryId: null,
      processedCount: 0,
    });
    const p: Record<string, unknown> | null = captured;
    if (!p) throw new Error('update not called');
    expect(p.last_history_id).toBeUndefined();
  });

  it('throws on DB write error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubReadReturn(0);
    mockUpdateEq.mockResolvedValueOnce({ error: { message: 'boom' } });
    const { advanceSyncState } = await import('./sync-state');
    await expect(
      advanceSyncState({
        mode: 'INCREMENTAL',
        newHistoryId: '1',
        processedCount: 0,
      }),
    ).rejects.toThrow(/Failed to advance/);
    errorSpy.mockRestore();
  });
});

/* ============================================================================
 * recordSyncFailure
 * ========================================================================== */

describe('recordSyncFailure', () => {
  it('bumps counter + stamps last_error + last_synced_at; does NOT advance history_id', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        last_history_id: '12345',
        last_synced_at: null,
        last_full_sync_at: null,
        emails_processed_total: 0,
        consecutive_failures: 1,
        last_error: null,
        last_error_at: null,
        locked_at: null,
        locked_by: null,
      },
      error: null,
    });
    let captured = null as Record<string, unknown> | null;
    mockUpdate.mockImplementationOnce((payload: Record<string, unknown>) => {
      captured = payload;
      return { eq: mockUpdateEq };
    });
    const { recordSyncFailure } = await import('./sync-state');
    await recordSyncFailure('Gmail 500');

    const p: Record<string, unknown> | null = captured;
    if (!p) throw new Error('update not called');
    expect(p.consecutive_failures).toBe(2);
    expect(p.last_error).toBe('Gmail 500');
    expect(p.last_error_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(p.last_synced_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Must NOT include last_history_id — the cursor stays put so the
    // next tick re-fetches the same batch.
    expect(p.last_history_id).toBeUndefined();
  });

  it('truncates long error messages at 1000 chars', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        last_history_id: null,
        last_synced_at: null,
        last_full_sync_at: null,
        emails_processed_total: 0,
        consecutive_failures: 0,
        last_error: null,
        last_error_at: null,
        locked_at: null,
        locked_by: null,
      },
      error: null,
    });
    let captured = null as Record<string, unknown> | null;
    mockUpdate.mockImplementationOnce((payload: Record<string, unknown>) => {
      captured = payload;
      return { eq: mockUpdateEq };
    });
    const { recordSyncFailure } = await import('./sync-state');
    await recordSyncFailure('x'.repeat(2000));
    const p: Record<string, unknown> | null = captured;
    if (!p) throw new Error('update not called');
    const msg = p.last_error as string;
    expect(msg.length).toBe(1000);
    expect(msg.endsWith('...')).toBe(true);
  });
});

/* ============================================================================
 * insertSyncLog
 * ========================================================================== */

describe('insertSyncLog', () => {
  it('inserts with all provided stats + defaults tickets_* to 0', async () => {
    let captured = null as Record<string, unknown> | null;
    mockInsert.mockImplementationOnce(async (payload: Record<string, unknown>) => {
      captured = payload;
      return { error: null };
    });
    const { insertSyncLog } = await import('./sync-state');
    await insertSyncLog({
      syncMethod: 'INCREMENTAL',
      durationMs: 8453,
      emailsFetched: 12,
      emailsClassified: 10,
      emailsUnclassified: 1,
      emailsDropped: 1,
      emailsErrored: 0,
    });
    const p: Record<string, unknown> | null = captured;
    if (!p) throw new Error('insert not called');
    expect(p.sync_method).toBe('INCREMENTAL');
    expect(p.duration_ms).toBe(8453);
    expect(p.emails_fetched).toBe(12);
    expect(p.emails_classified).toBe(10);
    expect(p.emails_unclassified).toBe(1);
    expect(p.emails_dropped).toBe(1);
    expect(p.emails_errored).toBe(0);
    expect(p.tickets_created).toBe(0);
    expect(p.tickets_updated).toBe(0);
    expect(p.error_message).toBeNull();
  });

  it('swallows DB error (audit log failure must not fail the sync)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockInsert.mockResolvedValueOnce({ error: { message: 'boom' } });
    const { insertSyncLog } = await import('./sync-state');
    await expect(
      insertSyncLog({
        syncMethod: 'INCREMENTAL',
        durationMs: 0,
        emailsFetched: 0,
        emailsClassified: 0,
        emailsUnclassified: 0,
        emailsDropped: 0,
        emailsErrored: 0,
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
