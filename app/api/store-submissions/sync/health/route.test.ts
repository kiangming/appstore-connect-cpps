/**
 * Healthcheck endpoint tests. `getSyncState` + `countRecentSyncLogs` are
 * mocked so we exercise status-classification + response-shape logic in
 * isolation from the DB layer (the helpers have their own tests in
 * sync-state.test.ts).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const hoisted = vi.hoisted(() => ({
  mockGetSyncState: vi.fn(),
  mockCountRecentSyncLogs: vi.fn(),
}));

vi.mock('@/lib/store-submissions/gmail/sync-state', () => ({
  getSyncState: hoisted.mockGetSyncState,
  countRecentSyncLogs: hoisted.mockCountRecentSyncLogs,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

function stateSnapshot(overrides: {
  lastSyncedAt?: Date | null;
  consecutiveFailures?: number;
} = {}) {
  return {
    lastHistoryId: '12345',
    lastSyncedAt: overrides.lastSyncedAt ?? null,
    lastFullSyncAt: null,
    emailsProcessedTotal: 0,
    consecutiveFailures: overrides.consecutiveFailures ?? 0,
    lastError: null,
    lastErrorAt: null,
    lockedAt: null,
    lockedBy: null,
  };
}

describe('GET /api/store-submissions/sync/health', () => {
  it('UNCONFIGURED when last_synced_at is null → 200', async () => {
    hoisted.mockGetSyncState.mockResolvedValueOnce(
      stateSnapshot({ lastSyncedAt: null }),
    );
    hoisted.mockCountRecentSyncLogs.mockResolvedValueOnce(0);

    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: 'UNCONFIGURED',
      last_synced_at: null,
      consecutive_failures: 0,
      stale_ms: null,
      recent_sync_count_24h: 0,
    });
  });

  it('OK when last sync was within the threshold → 200', async () => {
    const now = new Date('2026-04-21T10:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const lastSynced = new Date(now.getTime() - 2 * 60 * 1000); // 2 min ago
    hoisted.mockGetSyncState.mockResolvedValueOnce(
      stateSnapshot({ lastSyncedAt: lastSynced }),
    );
    hoisted.mockCountRecentSyncLogs.mockResolvedValueOnce(288);

    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('OK');
    expect(body.last_synced_at).toBe('2026-04-21T09:58:00.000Z');
    expect(body.stale_ms).toBe(2 * 60 * 1000);
    expect(body.recent_sync_count_24h).toBe(288);
  });

  it('STALE when last sync > 15 min ago → 503', async () => {
    const now = new Date('2026-04-21T10:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const stale = new Date(now.getTime() - 20 * 60 * 1000); // 20 min ago
    hoisted.mockGetSyncState.mockResolvedValueOnce(
      stateSnapshot({ lastSyncedAt: stale, consecutiveFailures: 4 }),
    );
    hoisted.mockCountRecentSyncLogs.mockResolvedValueOnce(50);

    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('STALE');
    expect(body.consecutive_failures).toBe(4);
    expect(body.stale_ms).toBe(20 * 60 * 1000);
  });

  it('boundary: 15 min exactly is still OK (strict > threshold for STALE)', async () => {
    const now = new Date('2026-04-21T10:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const boundary = new Date(now.getTime() - 15 * 60 * 1000); // exactly 15 min
    hoisted.mockGetSyncState.mockResolvedValueOnce(
      stateSnapshot({ lastSyncedAt: boundary }),
    );
    hoisted.mockCountRecentSyncLogs.mockResolvedValueOnce(1);

    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('OK');
  });

  it('surfaces consecutive_failures for admin visibility', async () => {
    const now = new Date('2026-04-21T10:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    hoisted.mockGetSyncState.mockResolvedValueOnce(
      stateSnapshot({
        lastSyncedAt: new Date(now.getTime() - 60_000),
        consecutiveFailures: 7,
      }),
    );
    hoisted.mockCountRecentSyncLogs.mockResolvedValueOnce(100);

    const { GET } = await import('./route');
    const body = await (await GET()).json();
    // Healthcheck still says OK (sync is running) but surfaces the
    // failure count so ops can investigate.
    expect(body.status).toBe('OK');
    expect(body.consecutive_failures).toBe(7);
  });

  it('DB failure → 503 STALE, no error details leaked', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    hoisted.mockGetSyncState.mockRejectedValueOnce(
      new Error('connection timeout to postgres pool'),
    );
    hoisted.mockCountRecentSyncLogs.mockResolvedValueOnce(0);

    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('STALE');
    // Must NOT leak internal error details.
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('connection timeout');
    expect(bodyStr).not.toContain('postgres');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('never includes last_error (internal state leak)', async () => {
    const now = new Date('2026-04-21T10:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    hoisted.mockGetSyncState.mockResolvedValueOnce({
      lastHistoryId: '100',
      lastSyncedAt: new Date(now.getTime() - 60_000),
      lastFullSyncAt: null,
      emailsProcessedTotal: 0,
      consecutiveFailures: 3,
      lastError: 'invalid_grant: token revoked by user acme@studio.com',
      lastErrorAt: new Date(),
      lockedAt: null,
      lockedBy: null,
    });
    hoisted.mockCountRecentSyncLogs.mockResolvedValueOnce(1);

    const { GET } = await import('./route');
    const body = await (await GET()).json();
    // last_error contains PII + credential hint — must not appear.
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('invalid_grant');
    expect(bodyStr).not.toContain('acme@studio.com');
    expect(bodyStr).not.toContain('revoked');
    // But consecutive_failures IS exposed (count-only).
    expect(body.consecutive_failures).toBe(3);
  });
});

describe('method gating', () => {
  it('POST → 405 with Allow: GET', async () => {
    const { POST } = await import('./route');
    const res = POST();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('PUT / DELETE / PATCH → 405', async () => {
    const { PUT, DELETE, PATCH } = await import('./route');
    expect(PUT().status).toBe(405);
    expect(DELETE().status).toBe(405);
    expect(PATCH().status).toBe(405);
  });
});
