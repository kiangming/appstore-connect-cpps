import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';

let originalKey: string | undefined;

beforeAll(() => {
  originalKey = process.env.GMAIL_ENCRYPTION_KEY;
  process.env.GMAIL_ENCRYPTION_KEY = randomBytes(32).toString('hex');
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.GMAIL_ENCRYPTION_KEY;
  else process.env.GMAIL_ENCRYPTION_KEY = originalKey;
});

const {
  mockMaybeSingle,
  mockEq,
  mockSelect,
  mockUpsert,
  mockDelete,
  mockFrom,
} = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockEq: vi.fn(),
  mockSelect: vi.fn(),
  mockUpsert: vi.fn(),
  mockDelete: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

beforeEach(() => {
  const chain = {
    select: mockSelect,
    eq: mockEq,
    maybeSingle: mockMaybeSingle,
    upsert: mockUpsert,
    delete: mockDelete,
  };
  mockFrom.mockReturnValue(chain);
  mockSelect.mockReturnValue(chain);
  mockEq.mockReturnValue(chain);
  mockDelete.mockReturnValue(chain);
});

afterEach(() => {
  vi.clearAllMocks();
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
