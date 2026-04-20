import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// === Hoisted mocks =========================================================

const {
  mockGetServerSession,
  mockRevalidatePath,
  mockRequireStoreRole,
  mockRequireStoreAccess,
  mockCookiesSet,
  mockCookiesGet,
  mockCookiesDelete,
  mockGenerateAuthUrl,
  mockRevokeTokens,
  mockGetGmailCredentials,
  mockDeleteGmailCredentials,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockRequireStoreRole: vi.fn(),
  mockRequireStoreAccess: vi.fn(),
  mockCookiesSet: vi.fn(),
  mockCookiesGet: vi.fn(),
  mockCookiesDelete: vi.fn(),
  mockGenerateAuthUrl: vi.fn(),
  mockRevokeTokens: vi.fn(),
  mockGetGmailCredentials: vi.fn(),
  mockDeleteGmailCredentials: vi.fn(),
}));

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }));
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }));
vi.mock('next/headers', () => ({
  cookies: () => ({
    set: mockCookiesSet,
    get: mockCookiesGet,
    delete: mockCookiesDelete,
  }),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/store-submissions/auth', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/auth')
  >('@/lib/store-submissions/auth');
  return {
    ...actual,
    requireStoreRole: mockRequireStoreRole,
    requireStoreAccess: mockRequireStoreAccess,
  };
});

vi.mock('@/lib/store-submissions/gmail/oauth', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/gmail/oauth')
  >('@/lib/store-submissions/gmail/oauth');
  return {
    ...actual,
    generateAuthUrl: mockGenerateAuthUrl,
    revokeTokens: mockRevokeTokens,
  };
});

vi.mock('@/lib/store-submissions/gmail/credentials', () => ({
  getGmailCredentials: mockGetGmailCredentials,
  deleteGmailCredentials: mockDeleteGmailCredentials,
}));

// === Imports AFTER mocks ===================================================

import { StoreForbiddenError, StoreUnauthorizedError } from '@/lib/store-submissions/auth';
import {
  disconnectGmailAction,
  getGmailConnectUrlAction,
  getGmailStatusAction,
} from './actions';

const MANAGER = {
  id: 'user-1',
  email: 'manager@studio.com',
  role: 'MANAGER' as const,
  display_name: 'Manager',
  avatar_url: null,
  status: 'active' as const,
};

function setSessionManager() {
  mockGetServerSession.mockResolvedValue({ user: { email: MANAGER.email } });
  mockRequireStoreRole.mockResolvedValue(MANAGER);
  mockRequireStoreAccess.mockResolvedValue(MANAGER);
}

beforeEach(() => {
  mockGenerateAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?mocked=1');
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// getGmailConnectUrlAction
// ============================================================================

describe('getGmailConnectUrlAction', () => {
  it('returns UNAUTHORIZED when no session', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    mockRequireStoreRole.mockRejectedValueOnce(new StoreUnauthorizedError());
    const res = await getGmailConnectUrlAction();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNAUTHORIZED');
  });

  it('returns FORBIDDEN when user is not MANAGER', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { email: 'dev@x.com' } });
    mockRequireStoreRole.mockRejectedValueOnce(
      new StoreForbiddenError('Required role: MANAGER'),
    );
    const res = await getGmailConnectUrlAction();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });

  it('sets the state cookie with correct attributes', async () => {
    setSessionManager();
    const res = await getGmailConnectUrlAction();
    expect(res.ok).toBe(true);
    expect(mockCookiesSet).toHaveBeenCalledTimes(1);
    const [name, value, opts] = mockCookiesSet.mock.calls[0];
    expect(name).toBe('gmail_oauth_state');
    expect(typeof value).toBe('string');
    expect(value).toHaveLength(32); // 16 bytes hex
    expect(opts).toEqual(
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 10 * 60,
      }),
    );
    expect(typeof opts.secure).toBe('boolean');
  });

  it('passes the cookie state into generateAuthUrl', async () => {
    setSessionManager();
    await getGmailConnectUrlAction();
    const cookieValue = mockCookiesSet.mock.calls[0][1];
    expect(mockGenerateAuthUrl).toHaveBeenCalledWith(cookieValue);
  });

  it('returns the generated URL to the caller', async () => {
    setSessionManager();
    const res = await getGmailConnectUrlAction();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.url).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth?mocked=1',
      );
    }
  });
});

// ============================================================================
// disconnectGmailAction
// ============================================================================

describe('disconnectGmailAction', () => {
  it('returns FORBIDDEN when not MANAGER', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { email: 'dev@x.com' } });
    mockRequireStoreRole.mockRejectedValueOnce(
      new StoreForbiddenError('Required role: MANAGER'),
    );
    const res = await disconnectGmailAction();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    expect(mockDeleteGmailCredentials).not.toHaveBeenCalled();
  });

  it('calls revoke then delete when credentials exist', async () => {
    setSessionManager();
    mockGetGmailCredentials.mockResolvedValueOnce({
      refresh_token: 'refresh-xyz',
      access_token: 'a',
      email: 'shared@studio.com',
      token_expires_at: new Date(),
      scopes: [],
      connected_at: new Date(),
      connected_by: null,
      last_refreshed_at: null,
    });
    mockRevokeTokens.mockResolvedValueOnce(undefined);
    mockDeleteGmailCredentials.mockResolvedValueOnce(undefined);

    const res = await disconnectGmailAction();
    expect(res.ok).toBe(true);
    expect(mockRevokeTokens).toHaveBeenCalledWith('refresh-xyz');
    expect(mockDeleteGmailCredentials).toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      '/store-submissions/config/settings',
    );
  });

  it('continues with delete even when revoke fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setSessionManager();
    mockGetGmailCredentials.mockResolvedValueOnce({
      refresh_token: 'refresh-xyz',
      access_token: 'a',
      email: 'shared@studio.com',
      token_expires_at: new Date(),
      scopes: [],
      connected_at: new Date(),
      connected_by: null,
      last_refreshed_at: null,
    });
    mockRevokeTokens.mockRejectedValueOnce(new Error('Google 400'));
    mockDeleteGmailCredentials.mockResolvedValueOnce(undefined);

    const res = await disconnectGmailAction();
    expect(res.ok).toBe(true);
    expect(mockDeleteGmailCredentials).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('is idempotent when no credentials exist (no revoke call)', async () => {
    setSessionManager();
    mockGetGmailCredentials.mockResolvedValueOnce(null);
    mockDeleteGmailCredentials.mockResolvedValueOnce(undefined);

    const res = await disconnectGmailAction();
    expect(res.ok).toBe(true);
    expect(mockRevokeTokens).not.toHaveBeenCalled();
    expect(mockDeleteGmailCredentials).toHaveBeenCalled();
  });
});

// ============================================================================
// getGmailStatusAction
// ============================================================================

describe('getGmailStatusAction', () => {
  it('returns {connected: false} when no credentials row', async () => {
    setSessionManager();
    mockGetGmailCredentials.mockResolvedValueOnce(null);
    const res = await getGmailStatusAction();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ connected: false });
  });

  it('reports connected with email + connected_at + last_refreshed_at', async () => {
    setSessionManager();
    const now = Date.now();
    mockGetGmailCredentials.mockResolvedValueOnce({
      email: 'shared@studio.com',
      access_token: 'a',
      refresh_token: 'r',
      token_expires_at: new Date(now + 3600_000),
      scopes: [],
      connected_at: new Date(now - 60_000),
      connected_by: 'user-1',
      last_refreshed_at: new Date(now - 60_000),
    });
    const res = await getGmailStatusAction();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        connected: true,
        email: 'shared@studio.com',
        connected_at: expect.any(String),
        last_refreshed_at: expect.any(String),
      });
    }
  });

  it('reports connected with last_refreshed_at=null when never refreshed', async () => {
    setSessionManager();
    const now = Date.now();
    mockGetGmailCredentials.mockResolvedValueOnce({
      email: 'shared@studio.com',
      access_token: 'a',
      refresh_token: 'r',
      token_expires_at: new Date(now + 3600_000),
      scopes: [],
      connected_at: new Date(now - 3600_000),
      connected_by: null,
      last_refreshed_at: null,
    });
    const res = await getGmailStatusAction();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.connected).toBe(true);
      expect(res.data.last_refreshed_at).toBeNull();
    }
  });

  it('allows DEV role (not MANAGER-only)', async () => {
    const DEV = { ...MANAGER, role: 'DEV' as const };
    mockGetServerSession.mockResolvedValue({ user: { email: DEV.email } });
    mockRequireStoreAccess.mockResolvedValue(DEV);
    mockGetGmailCredentials.mockResolvedValueOnce(null);
    const res = await getGmailStatusAction();
    expect(res.ok).toBe(true);
  });

  it('returns FORBIDDEN when user is not whitelisted at all', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { email: 'ghost@x.com' } });
    mockRequireStoreAccess.mockRejectedValueOnce(
      new StoreForbiddenError('Not whitelisted'),
    );
    const res = await getGmailStatusAction();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
  });
});
