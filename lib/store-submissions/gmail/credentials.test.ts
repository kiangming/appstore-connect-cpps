import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';

let originalKey: string | undefined;
let originalClientId: string | undefined;
let originalClientSecret: string | undefined;

beforeAll(() => {
  originalKey = process.env.GMAIL_ENCRYPTION_KEY;
  originalClientId = process.env.GOOGLE_CLIENT_ID;
  originalClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  process.env.GMAIL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.GMAIL_ENCRYPTION_KEY;
  else process.env.GMAIL_ENCRYPTION_KEY = originalKey;
  if (originalClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = originalClientId;
  if (originalClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = originalClientSecret;
});

const {
  mockMaybeSingle,
  mockEq,
  mockSelect,
  mockUpsert,
  mockDelete,
  mockUpdate,
  mockUpdateEq,
  mockFrom,
  mockBumpCounter,
  mockResetCounter,
} = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockEq: vi.fn(),
  mockSelect: vi.fn(),
  mockUpsert: vi.fn(),
  mockDelete: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateEq: vi.fn(),
  mockFrom: vi.fn(),
  mockBumpCounter: vi.fn(),
  mockResetCounter: vi.fn(),
}));

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

// Sync-state helpers are unit-tested separately in sync-state.test.ts;
// mock them here so `ensureFreshToken` tests stay focused on the refresh
// flow and don't depend on DB-layer invariants of a sibling module.
vi.mock('./sync-state', () => ({
  bumpConsecutiveFailures: mockBumpCounter,
  resetConsecutiveFailures: mockResetCounter,
}));

beforeEach(() => {
  const chain = {
    select: mockSelect,
    eq: mockEq,
    maybeSingle: mockMaybeSingle,
    upsert: mockUpsert,
    delete: mockDelete,
    update: mockUpdate,
  };
  mockFrom.mockReturnValue(chain);
  mockSelect.mockReturnValue(chain);
  mockEq.mockReturnValue(chain);
  mockDelete.mockReturnValue(chain);
  // `update()` returns a DIFFERENT chainable whose `.eq()` resolves to a
  // promise — separating it from the select/delete chain's `eq` avoids
  // the ambiguity of a single `mockEq` that must sometimes chain and
  // sometimes resolve.
  mockUpdate.mockReturnValue({ eq: mockUpdateEq });
  mockUpdateEq.mockResolvedValue({ error: null });
  mockBumpCounter.mockResolvedValue(undefined);
  mockResetCounter.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('isTokenExpired', () => {
  it('returns true when token is already past expiry', async () => {
    const { isTokenExpired } = await import('./credentials');
    const now = new Date('2026-04-20T12:00:00Z');
    const past = new Date('2026-04-20T11:59:00Z');
    expect(isTokenExpired(past, now)).toBe(true);
  });

  it('returns true when token expires within 5-min buffer', async () => {
    const { isTokenExpired } = await import('./credentials');
    const now = new Date('2026-04-20T12:00:00Z');
    // expires in 4 minutes — within buffer
    const soon = new Date(now.getTime() + 4 * 60 * 1000);
    expect(isTokenExpired(soon, now)).toBe(true);
  });

  it('returns false when token has >5-min remaining', async () => {
    const { isTokenExpired } = await import('./credentials');
    const now = new Date('2026-04-20T12:00:00Z');
    // expires in 6 minutes — outside buffer
    const later = new Date(now.getTime() + 6 * 60 * 1000);
    expect(isTokenExpired(later, now)).toBe(false);
  });

  it('returns true at the exact buffer boundary (<=)', async () => {
    const { isTokenExpired } = await import('./credentials');
    const now = new Date('2026-04-20T12:00:00Z');
    const boundary = new Date(now.getTime() + 5 * 60 * 1000);
    expect(isTokenExpired(boundary, now)).toBe(true);
  });
});

describe('getGmailCredentials', () => {
  it('returns null when row does not exist', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { getGmailCredentials } = await import('./credentials');
    await expect(getGmailCredentials()).resolves.toBeNull();
    expect(mockFrom).toHaveBeenCalledWith('gmail_credentials');
    expect(mockEq).toHaveBeenCalledWith('id', 1);
  });

  it('decrypts tokens and returns plaintext shape', async () => {
    const { encryptToken } = await import('../crypto');
    const { getGmailCredentials } = await import('./credentials');
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        email: 'shared@studio.com',
        access_token_encrypted: encryptToken('access-abc'),
        refresh_token_encrypted: encryptToken('refresh-xyz'),
        token_expires_at: '2026-04-20T13:00:00Z',
        scopes: ['https://www.googleapis.com/auth/gmail.modify'],
        connected_at: '2026-04-20T12:00:00Z',
        connected_by: 'user-1',
        last_refreshed_at: null,
      },
      error: null,
    });
    const creds = await getGmailCredentials();
    if (creds === null) throw new Error('expected credentials, got null');
    expect(creds.access_token).toBe('access-abc');
    expect(creds.refresh_token).toBe('refresh-xyz');
    expect(creds.email).toBe('shared@studio.com');
    expect(creds.token_expires_at).toBeInstanceOf(Date);
    expect(creds.connected_at).toBeInstanceOf(Date);
    expect(creds.last_refreshed_at).toBeNull();
  });

  it('throws when DB returns an error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'boom' },
    });
    const { getGmailCredentials } = await import('./credentials');
    await expect(getGmailCredentials()).rejects.toThrow(
      /Failed to read Gmail credentials/,
    );
    errorSpy.mockRestore();
  });
});

describe('saveGmailCredentials', () => {
  it('upserts singleton id=1 with encrypted tokens', async () => {
    mockUpsert.mockResolvedValueOnce({ error: null });
    const { saveGmailCredentials } = await import('./credentials');

    await saveGmailCredentials({
      email: 'shared@studio.com',
      access_token: 'access-123',
      refresh_token: 'refresh-456',
      token_expires_at: new Date('2026-04-20T13:00:00Z'),
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      connected_by: 'user-1',
    });

    expect(mockFrom).toHaveBeenCalledWith('gmail_credentials');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [payload, opts] = mockUpsert.mock.calls[0];
    expect(opts).toEqual({ onConflict: 'id' });
    expect(payload.id).toBe(1);
    expect(payload.email).toBe('shared@studio.com');
    expect(payload.connected_by).toBe('user-1');
    expect(payload.scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.modify',
    ]);
    // tokens should be encrypted, not plaintext
    expect(payload.access_token_encrypted).not.toBe('access-123');
    expect(payload.refresh_token_encrypted).not.toBe('refresh-456');
    // round-trip: encrypted form must decrypt back to original plaintext
    const { decryptToken } = await import('../crypto');
    expect(decryptToken(payload.access_token_encrypted)).toBe('access-123');
    expect(decryptToken(payload.refresh_token_encrypted)).toBe('refresh-456');
  });

  it('throws when DB upsert fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUpsert.mockResolvedValueOnce({ error: { message: 'boom' } });
    const { saveGmailCredentials } = await import('./credentials');
    await expect(
      saveGmailCredentials({
        email: 'x@y.com',
        access_token: 'a',
        refresh_token: 'r',
        token_expires_at: new Date(),
        scopes: [],
        connected_by: null,
      }),
    ).rejects.toThrow(/Failed to save Gmail credentials/);
    errorSpy.mockRestore();
  });
});

describe('deleteGmailCredentials', () => {
  it('deletes singleton row and is idempotent on no-row', async () => {
    mockEq.mockResolvedValueOnce({ error: null });
    const { deleteGmailCredentials } = await import('./credentials');
    await expect(deleteGmailCredentials()).resolves.toBeUndefined();
    expect(mockFrom).toHaveBeenCalledWith('gmail_credentials');
    expect(mockDelete).toHaveBeenCalled();
    expect(mockEq).toHaveBeenCalledWith('id', 1);
  });

  it('throws when DB delete errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockEq.mockResolvedValueOnce({ error: { message: 'boom' } });
    const { deleteGmailCredentials } = await import('./credentials');
    await expect(deleteGmailCredentials()).rejects.toThrow(
      /Failed to disconnect Gmail/,
    );
    errorSpy.mockRestore();
  });
});

describe('save → get round-trip (transparent encryption)', () => {
  it('stores encrypted, retrieves plaintext', async () => {
    const { encryptToken } = await import('../crypto');
    const { saveGmailCredentials, getGmailCredentials } = await import(
      './credentials'
    );

    type StoredRow = {
      id: number;
      email: string;
      access_token_encrypted: string;
      refresh_token_encrypted: string;
      token_expires_at: string;
      scopes: string[];
      connected_at: string;
      connected_by: string | null;
      last_refreshed_at: string;
    };
    const capture: { row?: StoredRow } = {};
    mockUpsert.mockImplementationOnce(async (payload: StoredRow) => {
      capture.row = payload;
      return { error: null };
    });
    await saveGmailCredentials({
      email: 'shared@studio.com',
      access_token: 'plaintext-access',
      refresh_token: 'plaintext-refresh',
      token_expires_at: new Date('2026-04-20T13:00:00Z'),
      scopes: ['gmail.modify'],
      connected_by: 'user-1',
    });

    const storedRow = capture.row;
    if (!storedRow) throw new Error('upsert was not called');
    expect(storedRow.access_token_encrypted).not.toBe('plaintext-access');

    mockMaybeSingle.mockResolvedValueOnce({ data: storedRow, error: null });
    const creds = await getGmailCredentials();
    if (creds === null) throw new Error('expected credentials, got null');
    expect(creds.access_token).toBe('plaintext-access');
    expect(creds.refresh_token).toBe('plaintext-refresh');
    void encryptToken;
  });
});

/* ============================================================================
 * saveRefreshedTokens
 * ========================================================================== */

describe('saveRefreshedTokens', () => {
  it('updates access_token/refresh_token/expiry/last_refreshed_at only', async () => {
    const { saveRefreshedTokens } = await import('./credentials');
    const { decryptToken } = await import('../crypto');

    let captured: Record<string, unknown> | null = null;
    mockUpdate.mockImplementationOnce((payload: Record<string, unknown>) => {
      captured = payload;
      return { eq: mockUpdateEq };
    });

    await saveRefreshedTokens({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      token_expires_at: new Date('2026-04-20T13:00:00Z'),
    });

    expect(mockFrom).toHaveBeenCalledWith('gmail_credentials');
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 1);
    if (!captured) throw new Error('update not called');
    // Connection lineage must NOT be touched by a refresh.
    expect((captured as Record<string, unknown>).connected_at).toBeUndefined();
    expect((captured as Record<string, unknown>).connected_by).toBeUndefined();
    expect((captured as Record<string, unknown>).email).toBeUndefined();
    expect((captured as Record<string, unknown>).scopes).toBeUndefined();

    // Tokens are encrypted at rest.
    expect(decryptToken((captured as Record<string, string>).access_token_encrypted)).toBe(
      'new-access',
    );
    expect(
      decryptToken((captured as Record<string, string>).refresh_token_encrypted),
    ).toBe('new-refresh');
    expect((captured as Record<string, string>).token_expires_at).toBe(
      '2026-04-20T13:00:00.000Z',
    );
    expect((captured as Record<string, string>).last_refreshed_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  it('throws when DB update errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUpdateEq.mockResolvedValueOnce({ error: { message: 'boom' } });
    const { saveRefreshedTokens } = await import('./credentials');
    await expect(
      saveRefreshedTokens({
        access_token: 'a',
        refresh_token: 'r',
        token_expires_at: new Date(),
      }),
    ).rejects.toThrow(/Failed to persist refreshed Gmail tokens/);
    errorSpy.mockRestore();
  });
});

/* ============================================================================
 * ensureFreshToken
 * ========================================================================== */

describe('ensureFreshToken', () => {
  const now = new Date('2026-04-20T12:00:00Z');

  function freshRow() {
    return {
      email: 'shared@studio.com',
      // Encrypted on the way in; the getter decrypts transparently.
      access_token_encrypted: '__ACCESS_CIPHERTEXT__',
      refresh_token_encrypted: '__REFRESH_CIPHERTEXT__',
      token_expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), // +1h
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      connected_at: '2026-04-15T00:00:00Z',
      connected_by: 'user-1',
      last_refreshed_at: null,
    };
  }

  function expiredRow() {
    return {
      ...freshRow(),
      token_expires_at: new Date(now.getTime() - 60 * 1000).toISOString(), // -1m
    };
  }

  async function mockRow(row: ReturnType<typeof freshRow>) {
    const { encryptToken } = await import('../crypto');
    return {
      ...row,
      access_token_encrypted: encryptToken('old-access'),
      refresh_token_encrypted: encryptToken('old-refresh'),
    };
  }

  beforeEach(async () => {
    const { __resetInFlightRefreshForTests } = await import('./credentials');
    __resetInFlightRefreshForTests();
  });

  it('returns current credentials unchanged when not expired', async () => {
    const row = await mockRow(freshRow());
    mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { ensureFreshToken } = await import('./credentials');
    const creds = await ensureFreshToken(now);

    expect(creds.access_token).toBe('old-access');
    expect(creds.refresh_token).toBe('old-refresh');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockBumpCounter).not.toHaveBeenCalled();
    expect(mockResetCounter).not.toHaveBeenCalled();
  });

  it('throws GmailNotConnectedError when no credentials row exists', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { ensureFreshToken } = await import('./credentials');
    const { GmailNotConnectedError } = await import('./errors');
    await expect(ensureFreshToken(now)).rejects.toBeInstanceOf(
      GmailNotConnectedError,
    );
  });

  it('refreshes token when expired, persists new access_token, resets failure counter', async () => {
    const row = await mockRow(expiredRow());
    mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'NEW-ACCESS',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/gmail.modify',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const { ensureFreshToken } = await import('./credentials');
    const creds = await ensureFreshToken(now);

    expect(creds.access_token).toBe('NEW-ACCESS');
    // Refresh token unchanged because Google didn't rotate it.
    expect(creds.refresh_token).toBe('old-refresh');
    expect(creds.token_expires_at.getTime()).toBeGreaterThan(now.getTime());

    // fetch hit Google's token endpoint with correct form body.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    const body = String(init.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_id=test-client-id');
    expect(body).toContain('client_secret=test-client-secret');
    expect(body).toContain('refresh_token=old-refresh');

    // Persistence went through saveRefreshedTokens (not upsert).
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpsert).not.toHaveBeenCalled();

    // Success path resets the failure counter.
    expect(mockResetCounter).toHaveBeenCalledTimes(1);
    expect(mockBumpCounter).not.toHaveBeenCalled();
  });

  it('adopts a rotated refresh_token when Google returns a new one', async () => {
    const row = await mockRow(expiredRow());
    mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'NEW-ACCESS',
          expires_in: 3600,
          refresh_token: 'NEW-REFRESH',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const { ensureFreshToken } = await import('./credentials');
    const creds = await ensureFreshToken(now);
    expect(creds.refresh_token).toBe('NEW-REFRESH');
  });

  it('bumps consecutive_failures + throws RefreshTokenInvalidError on invalid_grant', async () => {
    const row = await mockRow(expiredRow());
    mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );

    const { ensureFreshToken } = await import('./credentials');
    const { RefreshTokenInvalidError } = await import('./errors');

    await expect(ensureFreshToken(now)).rejects.toBeInstanceOf(
      RefreshTokenInvalidError,
    );
    expect(mockBumpCounter).toHaveBeenCalledTimes(1);
    expect(mockBumpCounter.mock.calls[0][0]).toMatch(/invalid_grant/i);
    expect(mockResetCounter).not.toHaveBeenCalled();
    // Credentials are NOT updated on a failed refresh.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('surfaces non-invalid_grant errors unchanged (no counter bump)', async () => {
    const row = await mockRow(expiredRow());
    mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"error":"server_error"}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { ensureFreshToken } = await import('./credentials');
    await expect(ensureFreshToken(now)).rejects.toThrow(/server_error|500/);
    expect(mockBumpCounter).not.toHaveBeenCalled();
    expect(mockResetCounter).not.toHaveBeenCalled();
  });

  it('swallows a failure to bump the counter (primary error is still thrown)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = await mockRow(expiredRow());
    mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    mockBumpCounter.mockRejectedValueOnce(new Error('DB down'));

    const { ensureFreshToken } = await import('./credentials');
    const { RefreshTokenInvalidError } = await import('./errors');

    await expect(ensureFreshToken(now)).rejects.toBeInstanceOf(
      RefreshTokenInvalidError,
    );
    errorSpy.mockRestore();
  });

  it('concurrent callers share a single refresh (single-flight)', async () => {
    const row = await mockRow(expiredRow());
    // Both callers will read credentials independently before checking
    // expiry — queue 2 reads.
    mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });
    mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });

    // Slow fetch so caller B reaches the single-flight gate while A is
    // still in-flight.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({
                    access_token: 'NEW-ACCESS',
                    expires_in: 3600,
                    token_type: 'Bearer',
                  }),
                  { status: 200 },
                ),
              ),
            10,
          ),
        ),
    );

    const { ensureFreshToken } = await import('./credentials');
    const [c1, c2] = await Promise.all([
      ensureFreshToken(now),
      ensureFreshToken(now),
    ]);

    expect(c1.access_token).toBe('NEW-ACCESS');
    expect(c2.access_token).toBe('NEW-ACCESS');
    // The whole point: one fetch, not two.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // One update for the one successful refresh.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('releases the single-flight slot after a failed refresh so retry works', async () => {
    const row = await mockRow(expiredRow());

    // First attempt: network error. Second attempt (fresh call): success.
    mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });
    mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'NEW-ACCESS',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
      );

    const { ensureFreshToken } = await import('./credentials');
    await expect(ensureFreshToken(now)).rejects.toThrow(/ECONNRESET/);
    const creds = await ensureFreshToken(now);
    expect(creds.access_token).toBe('NEW-ACCESS');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
