/**
 * Integration-ish tests for the Gmail sync cron endpoint.
 *
 * We mock `runSync` (the orchestrator has its own deep tests in
 * sync.test.ts) and exercise only the HTTP concerns: auth, method
 * gating, response shape, error → status mapping, logging discipline.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  mockRunSync: vi.fn(),
}));

vi.mock('@/lib/store-submissions/gmail/sync', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/gmail/sync')
  >('@/lib/store-submissions/gmail/sync');
  return {
    ...actual,
    runSync: hoisted.mockRunSync,
  };
});

const CRON_SECRET = 'c'.repeat(48); // 48 hex chars ≈ 192 bits

let originalSecret: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = CRON_SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

/* ----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function buildRequest(
  overrides: {
    method?: string;
    secret?: string | null;
    ip?: string;
    userAgent?: string;
  } = {},
): NextRequest {
  const headers = new Headers();
  if (overrides.secret !== null && overrides.secret !== undefined) {
    headers.set('x-cron-secret', overrides.secret);
  }
  if (overrides.ip) headers.set('x-forwarded-for', overrides.ip);
  if (overrides.userAgent) headers.set('user-agent', overrides.userAgent);
  return {
    headers,
    method: overrides.method ?? 'POST',
    nextUrl: new URL('http://localhost/api/store-submissions/sync/gmail'),
  } as unknown as NextRequest;
}

function happyResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    success: true,
    mode: 'INCREMENTAL' as const,
    durationMs: 2345,
    stats: {
      fetched: 5,
      classified: 3,
      unclassified: 1,
      dropped: 1,
      errors: 0,
    },
    nextHistoryId: '9999',
    ...overrides,
  };
}

/* ============================================================================
 * Auth
 * ========================================================================== */

describe('POST auth', () => {
  it('missing X-Cron-Secret header → 401 UNAUTHORIZED', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: null }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      success: false,
      error: 'UNAUTHORIZED',
    });
    expect(warnSpy).toHaveBeenCalled();
    expect(hoisted.mockRunSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('wrong secret of SAME length → 401', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('./route');
    const wrong = 'd'.repeat(CRON_SECRET.length); // same length, different bytes
    const res = await POST(buildRequest({ secret: wrong }));
    expect(res.status).toBe(401);
    expect(hoisted.mockRunSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('wrong secret of DIFFERENT length → 401 (length check before timingSafeEqual)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: 'short' }));
    expect(res.status).toBe(401);
    warnSpy.mockRestore();
  });

  it('correct secret → proceeds to runSync', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    hoisted.mockRunSync.mockResolvedValueOnce(happyResult());
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: CRON_SECRET }));
    expect(res.status).toBe(200);
    expect(hoisted.mockRunSync).toHaveBeenCalledTimes(1);
  });

  it('CRON_SECRET env missing → 500 INTERNAL_ERROR (refuses to authenticate)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.CRON_SECRET;
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: 'anything' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      success: false,
      error: 'INTERNAL_ERROR',
    });
    expect(hoisted.mockRunSync).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('CRON_SECRET env var is missing'),
    );
    errorSpy.mockRestore();
  });

  it('CRON_SECRET env empty string → 500 (not empty-match fallback)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CRON_SECRET = '';
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: '' }));
    expect(res.status).toBe(500);
    errorSpy.mockRestore();
  });

  it('never logs the attempted secret VALUE, only its length', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('./route');
    const bogusSecret = 'ZZZ-very-secret-attempt-ZZZ';
    await POST(buildRequest({ secret: bogusSecret }));
    for (const call of warnSpy.mock.calls) {
      const joined = call.map(String).join(' ');
      expect(joined).not.toContain(bogusSecret);
      expect(joined).toContain(`attempted_len=${bogusSecret.length}`);
    }
    warnSpy.mockRestore();
  });

  it('logs IP + user-agent on auth failure for security audit', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('./route');
    await POST(
      buildRequest({
        secret: 'wrong-but-same-length-fake-000000000000000000000',
        ip: '203.0.113.42',
        userAgent: 'curl/8.0.0',
      }),
    );
    const logCall = warnSpy.mock.calls[0].map(String).join(' ');
    expect(logCall).toContain('203.0.113.42');
    expect(logCall).toContain('curl/8.0.0');
    warnSpy.mockRestore();
  });
});

/* ============================================================================
 * Method gating
 * ========================================================================== */

describe('method gating', () => {
  it('GET → 405 with Allow: POST', async () => {
    const { GET } = await import('./route');
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('PUT / DELETE / PATCH → 405', async () => {
    const { PUT, DELETE, PATCH } = await import('./route');
    expect(PUT().status).toBe(405);
    expect(DELETE().status).toBe(405);
    expect(PATCH().status).toBe(405);
  });
});

/* ============================================================================
 * Happy path + response shape
 * ========================================================================== */

describe('happy path', () => {
  it('returns 200 with the full SyncResult shape', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    hoisted.mockRunSync.mockResolvedValueOnce(happyResult());
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: CRON_SECRET }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      mode: 'INCREMENTAL',
      durationMs: 2345,
      stats: {
        fetched: 5,
        classified: 3,
        unclassified: 1,
        dropped: 1,
        errors: 0,
      },
      nextHistoryId: '9999',
    });
  });

  it('passes lockedBy="cron-sync" to runSync (debug tag on the lock row)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    hoisted.mockRunSync.mockResolvedValueOnce(happyResult());
    const { POST } = await import('./route');
    await POST(buildRequest({ secret: CRON_SECRET }));
    expect(hoisted.mockRunSync).toHaveBeenCalledWith({ lockedBy: 'cron-sync' });
  });

  it('success: false (partial failure) still returns 200 with success=false in body', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    hoisted.mockRunSync.mockResolvedValueOnce(
      happyResult({ success: false, stats: {
        fetched: 5,
        classified: 3,
        unclassified: 1,
        dropped: 0,
        errors: 1,
      }, nextHistoryId: null }),
    );
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: CRON_SECRET }));
    // Per-message failure is not a sync-level failure — the orchestrator
    // still returned cleanly, so the endpoint surfaces 200.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.stats.errors).toBe(1);
    expect(body.nextHistoryId).toBeNull();
  });

  it('logs a one-line summary on success', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    hoisted.mockRunSync.mockResolvedValueOnce(happyResult());
    const { POST } = await import('./route');
    await POST(buildRequest({ secret: CRON_SECRET }));
    const logLine = infoSpy.mock.calls[0][0];
    expect(logLine).toContain('OK');
    expect(logLine).toContain('mode=INCREMENTAL');
    expect(logLine).toContain('classified=3');
    infoSpy.mockRestore();
  });
});

/* ============================================================================
 * Error mapping
 * ========================================================================== */

describe('error mapping', () => {
  it('SyncInProgressError → 409 SYNC_IN_PROGRESS', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { SyncInProgressError } = await import(
      '@/lib/store-submissions/gmail/errors'
    );
    hoisted.mockRunSync.mockRejectedValueOnce(new SyncInProgressError());
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: CRON_SECRET }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      error: 'SYNC_IN_PROGRESS',
    });
  });

  it('GmailNotConnectedError → 412 GMAIL_NOT_CONNECTED', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { GmailNotConnectedError } = await import(
      '@/lib/store-submissions/gmail/errors'
    );
    hoisted.mockRunSync.mockRejectedValueOnce(new GmailNotConnectedError());
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: CRON_SECRET }));
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({
      success: false,
      error: 'GMAIL_NOT_CONNECTED',
    });
  });

  it('RefreshTokenInvalidError → 401 REFRESH_TOKEN_INVALID', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { RefreshTokenInvalidError } = await import(
      '@/lib/store-submissions/gmail/errors'
    );
    hoisted.mockRunSync.mockRejectedValueOnce(
      new RefreshTokenInvalidError(new Error('invalid_grant')),
    );
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: CRON_SECRET }));
    // Note: 401 is shared with auth failures intentionally — callers
    // distinguish via the `error` code in the body. `UNAUTHORIZED`
    // means "bad cron secret"; `REFRESH_TOKEN_INVALID` means "Gmail
    // side".
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      success: false,
      error: 'REFRESH_TOKEN_INVALID',
    });
  });

  it('unknown error → 500 INTERNAL_ERROR (no details leak)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    hoisted.mockRunSync.mockRejectedValueOnce(
      new Error('leaky internal message with credentials'),
    );
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: CRON_SECRET }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'INTERNAL_ERROR' });
    // Body must NOT echo the internal error message.
    expect(JSON.stringify(body)).not.toContain('leaky internal message');
    expect(JSON.stringify(body)).not.toContain('credentials');
    // But it WAS logged server-side for debugging.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('non-Error throw (string) → 500 INTERNAL_ERROR', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hoisted.mockRunSync.mockRejectedValueOnce('bare string rejection');
    const { POST } = await import('./route');
    const res = await POST(buildRequest({ secret: CRON_SECRET }));
    expect(res.status).toBe(500);
  });
});
