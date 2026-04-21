import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { mockFrom, mockSelect, mockEq } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockEq: vi.fn(),
}));

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

beforeEach(() => {
  const chain = { select: mockSelect, eq: mockEq };
  mockFrom.mockReturnValue(chain);
  mockSelect.mockReturnValue(chain);
  mockEq.mockReturnValue(chain);
});

afterEach(() => {
  vi.clearAllMocks();
});

/* ============================================================================
 * loadActiveSenders
 * ========================================================================== */

describe('loadActiveSenders', () => {
  it('normalizes email to lowercase + trimmed', async () => {
    mockEq.mockResolvedValueOnce({
      data: [
        {
          email: '  NO-REPLY@APPLE.COM ',
          platform_id: 'apple-uuid',
          platforms: { key: 'apple' },
        },
      ],
      error: null,
    });
    const { loadActiveSenders } = await import('./sender-resolver');
    const senders = await loadActiveSenders();
    expect(senders).toEqual([
      {
        email: 'no-reply@apple.com',
        platformId: 'apple-uuid',
        platformKey: 'apple',
      },
    ]);
  });

  it('filters !active via the DB query', async () => {
    mockEq.mockResolvedValueOnce({ data: [], error: null });
    const { loadActiveSenders } = await import('./sender-resolver');
    await loadActiveSenders();
    expect(mockEq).toHaveBeenCalledWith('active', true);
  });

  it('handles both object + array shapes for platforms join', async () => {
    mockEq.mockResolvedValueOnce({
      data: [
        {
          email: 'a@apple.com',
          platform_id: 'apple-uuid',
          platforms: [{ key: 'apple' }], // array form
        },
        {
          email: 'b@google.com',
          platform_id: 'google-uuid',
          platforms: { key: 'google' }, // object form
        },
      ],
      error: null,
    });
    const { loadActiveSenders } = await import('./sender-resolver');
    const senders = await loadActiveSenders();
    expect(senders.map((s) => s.platformKey).sort()).toEqual([
      'apple',
      'google',
    ]);
  });

  it('skips rows missing platform key (defensive)', async () => {
    mockEq.mockResolvedValueOnce({
      data: [
        { email: 'a@x.com', platform_id: 'uuid-1', platforms: null },
        { email: 'b@x.com', platform_id: 'uuid-2', platforms: { key: 'apple' } },
      ],
      error: null,
    });
    const { loadActiveSenders } = await import('./sender-resolver');
    const senders = await loadActiveSenders();
    expect(senders.map((s) => s.email)).toEqual(['b@x.com']);
  });

  it('throws when DB returns an error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockEq.mockResolvedValueOnce({
      data: null,
      error: { message: 'boom' },
    });
    const { loadActiveSenders } = await import('./sender-resolver');
    await expect(loadActiveSenders()).rejects.toThrow(
      /Failed to load active senders/,
    );
    errorSpy.mockRestore();
  });

  it('returns empty when data is null', async () => {
    mockEq.mockResolvedValueOnce({ data: null, error: null });
    const { loadActiveSenders } = await import('./sender-resolver');
    await expect(loadActiveSenders()).resolves.toEqual([]);
  });
});

/* ============================================================================
 * createSenderResolver (pure)
 * ========================================================================== */

describe('createSenderResolver', () => {
  const senders = [
    {
      email: 'no-reply@apple.com',
      platformId: 'apple-uuid',
      platformKey: 'apple' as const,
    },
    {
      email: 'googleplay-noreply@google.com',
      platformId: 'google-uuid',
      platformKey: 'google' as const,
    },
    {
      email: 'noreply@partner.huawei.com',
      platformId: 'huawei-uuid',
      platformKey: 'huawei' as const,
    },
  ];

  it('exact match (lowercase) → returns platform', async () => {
    const { createSenderResolver } = await import('./sender-resolver');
    const resolve = createSenderResolver(senders);
    expect(resolve('no-reply@apple.com')).toEqual({
      platformId: 'apple-uuid',
      platformKey: 'apple',
    });
  });

  it('case-insensitive match', async () => {
    const { createSenderResolver } = await import('./sender-resolver');
    const resolve = createSenderResolver(senders);
    expect(resolve('No-Reply@APPLE.com')).toEqual({
      platformId: 'apple-uuid',
      platformKey: 'apple',
    });
  });

  it('trims whitespace', async () => {
    const { createSenderResolver } = await import('./sender-resolver');
    const resolve = createSenderResolver(senders);
    expect(resolve('  no-reply@apple.com\n')).toEqual({
      platformId: 'apple-uuid',
      platformKey: 'apple',
    });
  });

  it('unknown sender → null (dropped)', async () => {
    const { createSenderResolver } = await import('./sender-resolver');
    const resolve = createSenderResolver(senders);
    expect(resolve('random@spam.com')).toBeNull();
  });

  it('empty / whitespace input → null', async () => {
    const { createSenderResolver } = await import('./sender-resolver');
    const resolve = createSenderResolver(senders);
    expect(resolve('')).toBeNull();
    expect(resolve('   ')).toBeNull();
  });

  it('is pure — no I/O after construction', async () => {
    const { createSenderResolver } = await import('./sender-resolver');
    const resolve = createSenderResolver(senders);
    // Calling resolve() many times must never touch the DB mock.
    const fromCallsBefore = mockFrom.mock.calls.length;
    for (let i = 0; i < 100; i++) {
      resolve('no-reply@apple.com');
      resolve('random@spam.com');
    }
    expect(mockFrom.mock.calls.length).toBe(fromCallsBefore);
  });
});
