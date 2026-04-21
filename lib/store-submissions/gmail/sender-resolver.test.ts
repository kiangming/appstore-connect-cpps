import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const {
  mockFrom,
  mockSendersSelect,
  mockSendersEq,
  mockPlatformsSelect,
  mockPlatformsEq,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockSendersSelect: vi.fn(),
  mockSendersEq: vi.fn(),
  mockPlatformsSelect: vi.fn(),
  mockPlatformsEq: vi.fn(),
}));

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

beforeEach(() => {
  // loadActiveSenders issues TWO `.from()` calls — one for `senders`,
  // one for `platforms`. Branch the mock on the table name so each
  // query gets its own chain + its own resolved payload.
  vi.resetAllMocks();
  const sendersChain = { select: mockSendersSelect, eq: mockSendersEq };
  const platformsChain = { select: mockPlatformsSelect, eq: mockPlatformsEq };
  mockSendersSelect.mockReturnValue(sendersChain);
  mockPlatformsSelect.mockReturnValue(platformsChain);
  // Default: queries resolve to empty so tests that don't override
  // explicit data still complete cleanly.
  mockSendersEq.mockResolvedValue({ data: [], error: null });
  mockPlatformsEq.mockResolvedValue({ data: [], error: null });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'senders') return sendersChain;
    if (table === 'platforms') return platformsChain;
    throw new Error(`unexpected table: ${table}`);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

/* ============================================================================
 * loadActiveSenders
 * ========================================================================== */

describe('loadActiveSenders', () => {
  it('normalizes email to lowercase + trimmed, joins via in-memory Map', async () => {
    mockSendersEq.mockResolvedValueOnce({
      data: [
        { email: '  NO-REPLY@APPLE.COM ', platform_id: 'apple-uuid' },
      ],
      error: null,
    });
    mockPlatformsEq.mockResolvedValueOnce({
      data: [{ id: 'apple-uuid', key: 'apple' }],
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

  it('filters active=true on BOTH senders AND platforms', async () => {
    mockSendersEq.mockResolvedValueOnce({ data: [], error: null });
    mockPlatformsEq.mockResolvedValueOnce({ data: [], error: null });
    const { loadActiveSenders } = await import('./sender-resolver');
    await loadActiveSenders();
    // Each chain's `.eq` should have been called once with active=true.
    expect(mockSendersEq).toHaveBeenCalledWith('active', true);
    expect(mockPlatformsEq).toHaveBeenCalledWith('active', true);
  });

  it('merges across multiple platforms correctly', async () => {
    mockSendersEq.mockResolvedValueOnce({
      data: [
        { email: 'a@apple.com', platform_id: 'apple-uuid' },
        { email: 'b@google.com', platform_id: 'google-uuid' },
      ],
      error: null,
    });
    mockPlatformsEq.mockResolvedValueOnce({
      data: [
        { id: 'apple-uuid', key: 'apple' },
        { id: 'google-uuid', key: 'google' },
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

  // REGRESSION: original bug was that the `platforms!inner(key)` embedded
  // select returned unexpected shapes under `.schema('store_mgmt')` and
  // the defensive `if (!key) continue` skipped every row. The new
  // 2-query implementation makes the "skip" path explicit — platform
  // missing from the lookup Map → row dropped — which is the correct
  // semantic here (inactive platform or FK orphan).
  it('skips senders whose platform is INACTIVE (absent from platforms query result)', async () => {
    mockSendersEq.mockResolvedValueOnce({
      data: [
        { email: 'a@apple.com', platform_id: 'apple-uuid' }, // active=true sender
        { email: 'b@google.com', platform_id: 'google-uuid' }, // also active sender
      ],
      error: null,
    });
    // Platforms query returns ONLY active platforms. Apple is inactive
    // in this scenario, so only google is returned — google sender
    // kept, apple sender silently dropped.
    mockPlatformsEq.mockResolvedValueOnce({
      data: [{ id: 'google-uuid', key: 'google' }],
      error: null,
    });
    const { loadActiveSenders } = await import('./sender-resolver');
    const senders = await loadActiveSenders();
    expect(senders.map((s) => s.email)).toEqual(['b@google.com']);
  });

  it('skips senders pointing to a non-existent platform (FK orphan defense)', async () => {
    mockSendersEq.mockResolvedValueOnce({
      data: [
        { email: 'orphan@x.com', platform_id: 'does-not-exist' },
        { email: 'ok@apple.com', platform_id: 'apple-uuid' },
      ],
      error: null,
    });
    mockPlatformsEq.mockResolvedValueOnce({
      data: [{ id: 'apple-uuid', key: 'apple' }],
      error: null,
    });
    const { loadActiveSenders } = await import('./sender-resolver');
    const senders = await loadActiveSenders();
    expect(senders.map((s) => s.email)).toEqual(['ok@apple.com']);
  });

  it('runs senders + platforms queries in parallel', async () => {
    // Both queries issue before either resolves — verify via call
    // timing: if serial, the second `.from` would wait for the first
    // `.eq` to resolve. Promise.all in the implementation should
    // trigger both `.from` calls synchronously.
    let sendersEqResolve: (v: unknown) => void = () => {};
    mockSendersEq.mockImplementationOnce(
      () => new Promise((res) => { sendersEqResolve = res; }),
    );
    mockPlatformsEq.mockImplementationOnce(async () => ({
      data: [{ id: 'apple-uuid', key: 'apple' }],
      error: null,
    }));

    const { loadActiveSenders } = await import('./sender-resolver');
    const promise = loadActiveSenders();

    // Give both queries a tick to initiate before resolving senders.
    await new Promise((res) => setImmediate(res));
    expect(mockFrom).toHaveBeenCalledWith('senders');
    expect(mockFrom).toHaveBeenCalledWith('platforms');

    sendersEqResolve({ data: [], error: null });
    await promise;
  });

  it('throws when senders query errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSendersEq.mockResolvedValueOnce({
      data: null,
      error: { message: 'senders boom' },
    });
    mockPlatformsEq.mockResolvedValueOnce({ data: [], error: null });
    const { loadActiveSenders } = await import('./sender-resolver');
    await expect(loadActiveSenders()).rejects.toThrow(
      /Failed to load active senders/,
    );
    errorSpy.mockRestore();
  });

  it('throws when platforms query errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSendersEq.mockResolvedValueOnce({ data: [], error: null });
    mockPlatformsEq.mockResolvedValueOnce({
      data: null,
      error: { message: 'platforms boom' },
    });
    const { loadActiveSenders } = await import('./sender-resolver');
    await expect(loadActiveSenders()).rejects.toThrow(
      /Failed to load active senders/,
    );
    errorSpy.mockRestore();
  });

  it('returns empty when both queries return null data (first-run edge case)', async () => {
    mockSendersEq.mockResolvedValueOnce({ data: null, error: null });
    mockPlatformsEq.mockResolvedValueOnce({ data: null, error: null });
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
