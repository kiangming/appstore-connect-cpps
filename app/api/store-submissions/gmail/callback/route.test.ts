import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// === Hoisted mocks =========================================================

const {
  mockGetServerSession,
  mockRequireStoreRole,
  mockCookiesGet,
  mockCookiesDelete,
  mockExchangeCodeForTokens,
  mockFetchGmailUserEmail,
  mockSaveGmailCredentials,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRequireStoreRole: vi.fn(),
  mockCookiesGet: vi.fn(),
  mockCookiesDelete: vi.fn(),
  mockExchangeCodeForTokens: vi.fn(),
  mockFetchGmailUserEmail: vi.fn(),
  mockSaveGmailCredentials: vi.fn(),
}));

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }));
vi.mock('next/headers', () => ({
  cookies: () => ({
    get: mockCookiesGet,
    delete: mockCookiesDelete,
  }),
}));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/store-submissions/auth', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/auth')
  >('@/lib/store-submissions/auth');
  return { ...actual, requireStoreRole: mockRequireStoreRole };
});

vi.mock('@/lib/store-submissions/gmail/oauth', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/gmail/oauth')
  >('@/lib/store-submissions/gmail/oauth');
  return {
    ...actual,
    exchangeCodeForTokens: mockExchangeCodeForTokens,
    fetchGmailUserEmail: mockFetchGmailUserEmail,
  };
});

vi.mock('@/lib/store-submissions/gmail/credentials', () => ({
  saveGmailCredentials: mockSaveGmailCredentials,
}));

// === Imports AFTER mocks ===================================================

import { StoreForbiddenError } from '@/lib/store-submissions/auth';
import {
  InsufficientScopeError,
  MissingRefreshTokenError,
} from '@/lib/store-submissions/gmail/oauth';
import { GET } from './route';

const MANAGER = {
  id: 'user-1',
  email: 'manager@studio.com',
  role: 'MANAGER' as const,
  display_name: 'Manager',
  avatar_url: null,
  status: 'active' as const,
};

const GOOD_TOKENS = {
  access_token: 'access-abc',
  refresh_token: 'refresh-xyz',
  expiry_date: 1_717_000_000_000,
  scope: 'https://www.googleapis.com/auth/gmail.modify',
  token_type: 'Bearer',
};

function mkRequest(params: Record<string, string | undefined>) {
  const url = new URL('https://studio.example.com/api/store-submissions/gmail/callback');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  return new Request(url.toString()) as unknown as import('next/server').NextRequest;
}

function setStateCookie(value: string | null) {
  mockCookiesGet.mockReturnValue(value === null ? undefined : { value });
}

function setSessionManager() {
  mockGetServerSession.mockResolvedValue({ user: { email: MANAGER.email } });
  mockRequireStoreRole.mockResolvedValue(MANAGER);
}

beforeEach(() => {
  setSessionManager();
  setStateCookie('csrf-state-123');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/store-submissions/gmail/callback', () => {
  // --- CSRF / error-param guards ------------------------------------------

  it('redirects with access_denied when Google sends ?error=access_denied', async () => {
    const res = await GET(mkRequest({ error: 'access_denied' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain(
      '/store-submissions/config/settings?gmail=error&reason=access_denied',
    );
    expect(mockCookiesDelete).toHaveBeenCalledWith('gmail_oauth_state');
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('redirects with invalid_params when code or state missing', async () => {
    const res = await GET(mkRequest({ code: 'c' })); // no state
    expect(res.headers.get('location')).toContain('reason=invalid_params');
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('redirects with invalid_state when cookie is missing', async () => {
    setStateCookie(null);
    const res = await GET(mkRequest({ code: 'c', state: 'csrf-state-123' }));
    expect(res.headers.get('location')).toContain('reason=invalid_state');
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('redirects with invalid_state when cookie does not match', async () => {
    setStateCookie('different-state');
    const res = await GET(mkRequest({ code: 'c', state: 'csrf-state-123' }));
    expect(res.headers.get('location')).toContain('reason=invalid_state');
  });

  it('always clears the state cookie, even on failure', async () => {
    await GET(mkRequest({ error: 'access_denied' }));
    expect(mockCookiesDelete).toHaveBeenCalledWith('gmail_oauth_state');
  });

  // --- Auth --------------------------------------------------------------

  it('redirects with unauthorized when user is not MANAGER', async () => {
    mockRequireStoreRole.mockRejectedValueOnce(
      new StoreForbiddenError('Required role: MANAGER'),
    );
    const res = await GET(mkRequest({ code: 'c', state: 'csrf-state-123' }));
    expect(res.headers.get('location')).toContain('reason=unauthorized');
    expect(mockExchangeCodeForTokens).not.toHaveBeenCalled();
  });

  // --- Exchange failures --------------------------------------------------

  it('redirects with exchange_failed on generic googleapis error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExchangeCodeForTokens.mockRejectedValueOnce(
      new Error('redirect_uri_mismatch'),
    );
    const res = await GET(mkRequest({ code: 'c', state: 'csrf-state-123' }));
    expect(res.headers.get('location')).toContain('reason=exchange_failed');
    errorSpy.mockRestore();
  });

  it('redirects with missing_refresh_token on MissingRefreshTokenError', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExchangeCodeForTokens.mockRejectedValueOnce(new MissingRefreshTokenError());
    const res = await GET(mkRequest({ code: 'c', state: 'csrf-state-123' }));
    expect(res.headers.get('location')).toContain('reason=missing_refresh_token');
    errorSpy.mockRestore();
  });

  it('redirects with insufficient_scope on InsufficientScopeError', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExchangeCodeForTokens.mockRejectedValueOnce(
      new InsufficientScopeError('openid'),
    );
    const res = await GET(mkRequest({ code: 'c', state: 'csrf-state-123' }));
    expect(res.headers.get('location')).toContain('reason=insufficient_scope');
    errorSpy.mockRestore();
  });

  // --- Profile + save ----------------------------------------------------

  it('redirects with profile_fetch_failed when Gmail profile fetch errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExchangeCodeForTokens.mockResolvedValueOnce(GOOD_TOKENS);
    mockFetchGmailUserEmail.mockRejectedValueOnce(new Error('gmail 500'));
    const res = await GET(mkRequest({ code: 'c', state: 'csrf-state-123' }));
    expect(res.headers.get('location')).toContain('reason=profile_fetch_failed');
    expect(mockSaveGmailCredentials).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('redirects with save_failed when DB write errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExchangeCodeForTokens.mockResolvedValueOnce(GOOD_TOKENS);
    mockFetchGmailUserEmail.mockResolvedValueOnce('shared@studio.com');
    mockSaveGmailCredentials.mockRejectedValueOnce(new Error('db'));
    const res = await GET(mkRequest({ code: 'c', state: 'csrf-state-123' }));
    expect(res.headers.get('location')).toContain('reason=save_failed');
    errorSpy.mockRestore();
  });

  // --- Happy path --------------------------------------------------------

  it('happy path: exchange → profile → save → redirect gmail=connected', async () => {
    mockExchangeCodeForTokens.mockResolvedValueOnce(GOOD_TOKENS);
    mockFetchGmailUserEmail.mockResolvedValueOnce('shared@studio.com');
    mockSaveGmailCredentials.mockResolvedValueOnce(undefined);

    const res = await GET(mkRequest({ code: 'one-time', state: 'csrf-state-123' }));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain(
      '/store-submissions/config/settings?gmail=connected',
    );
    expect(mockExchangeCodeForTokens).toHaveBeenCalledWith('one-time');
    expect(mockFetchGmailUserEmail).toHaveBeenCalledWith('access-abc');
    expect(mockSaveGmailCredentials).toHaveBeenCalledTimes(1);
    const savedPayload = mockSaveGmailCredentials.mock.calls[0][0];
    expect(savedPayload).toEqual(
      expect.objectContaining({
        email: 'shared@studio.com',
        access_token: 'access-abc',
        refresh_token: 'refresh-xyz',
        connected_by: MANAGER.id,
        scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      }),
    );
    expect(savedPayload.token_expires_at).toBeInstanceOf(Date);
    expect(mockCookiesDelete).toHaveBeenCalledWith('gmail_oauth_state');
  });
});
