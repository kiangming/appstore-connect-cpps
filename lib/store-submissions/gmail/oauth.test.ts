import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGenerateAuthUrl,
  mockGetToken,
  mockRevokeToken,
  mockSetCredentials,
  mockGetProfile,
} = vi.hoisted(() => ({
  mockGenerateAuthUrl: vi.fn(),
  mockGetToken: vi.fn(),
  mockRevokeToken: vi.fn(),
  mockSetCredentials: vi.fn(),
  mockGetProfile: vi.fn(),
}));

class FakeOAuth2 {
  generateAuthUrl = mockGenerateAuthUrl;
  getToken = mockGetToken;
  revokeToken = mockRevokeToken;
  setCredentials = mockSetCredentials;
}

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: FakeOAuth2 },
    gmail: () => ({
      users: { getProfile: mockGetProfile },
    }),
  },
}));

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    VERCEL_URL: process.env.VERCEL_URL,
    RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN,
  };
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.NEXTAUTH_URL = 'https://studio.example.com';
  delete process.env.VERCEL_URL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  mockGenerateAuthUrl.mockReturnValue(
    'https://accounts.google.com/o/oauth2/v2/auth?mocked=1',
  );
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.clearAllMocks();
});

describe('resolveBaseUrl / buildCallbackUrl', () => {
  it('uses NEXTAUTH_URL when set, stripping trailing slash', async () => {
    process.env.NEXTAUTH_URL = 'https://studio.example.com/';
    const { buildCallbackUrl } = await import('./oauth');
    expect(buildCallbackUrl()).toBe(
      'https://studio.example.com/api/store-submissions/gmail/callback',
    );
  });

  it('falls back to VERCEL_URL when NEXTAUTH_URL missing', async () => {
    delete process.env.NEXTAUTH_URL;
    process.env.VERCEL_URL = 'preview-abc.vercel.app';
    const { buildCallbackUrl } = await import('./oauth');
    expect(buildCallbackUrl()).toBe(
      'https://preview-abc.vercel.app/api/store-submissions/gmail/callback',
    );
  });

  it('falls back to RAILWAY_PUBLIC_DOMAIN', async () => {
    delete process.env.NEXTAUTH_URL;
    process.env.RAILWAY_PUBLIC_DOMAIN = 'store.up.railway.app';
    const { buildCallbackUrl } = await import('./oauth');
    expect(buildCallbackUrl()).toBe(
      'https://store.up.railway.app/api/store-submissions/gmail/callback',
    );
  });

  it('falls back to localhost in dev', async () => {
    delete process.env.NEXTAUTH_URL;
    const { buildCallbackUrl } = await import('./oauth');
    expect(buildCallbackUrl()).toBe(
      'http://localhost:3000/api/store-submissions/gmail/callback',
    );
  });
});

describe('getOAuthClient', () => {
  it('throws when client id/secret are missing', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const { getOAuthClient } = await import('./oauth');
    expect(() => getOAuthClient()).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it('constructs an OAuth2 instance otherwise', async () => {
    const { getOAuthClient } = await import('./oauth');
    expect(getOAuthClient()).toBeInstanceOf(FakeOAuth2);
  });
});

describe('generateAuthUrl', () => {
  it('passes the required scopes, access_type, prompt, and state', async () => {
    const { generateAuthUrl } = await import('./oauth');
    const url = generateAuthUrl('abc123');
    expect(url).toBe('https://accounts.google.com/o/oauth2/v2/auth?mocked=1');
    expect(mockGenerateAuthUrl).toHaveBeenCalledTimes(1);
    const opts = mockGenerateAuthUrl.mock.calls[0][0];
    expect(opts.access_type).toBe('offline');
    expect(opts.prompt).toBe('consent');
    expect(opts.include_granted_scopes).toBe(true);
    expect(opts.state).toBe('abc123');
    expect(opts.scope).toEqual([
      'https://www.googleapis.com/auth/gmail.modify',
    ]);
  });
});

describe('exchangeCodeForTokens', () => {
  it('returns normalized tokens on success', async () => {
    mockGetToken.mockResolvedValueOnce({
      tokens: {
        access_token: 'access-abc',
        refresh_token: 'refresh-xyz',
        expiry_date: 1_717_000_000_000,
        scope: 'https://www.googleapis.com/auth/gmail.modify openid',
        token_type: 'Bearer',
      },
    });
    const { exchangeCodeForTokens } = await import('./oauth');
    const out = await exchangeCodeForTokens('one-time-code');
    expect(out).toEqual({
      access_token: 'access-abc',
      refresh_token: 'refresh-xyz',
      expiry_date: 1_717_000_000_000,
      scope: 'https://www.googleapis.com/auth/gmail.modify openid',
      token_type: 'Bearer',
    });
    expect(mockGetToken).toHaveBeenCalledWith('one-time-code');
  });

  it('throws MissingRefreshTokenError when no refresh_token returned', async () => {
    mockGetToken.mockResolvedValueOnce({
      tokens: {
        access_token: 'access-abc',
        expiry_date: 1_717_000_000_000,
        scope: 'https://www.googleapis.com/auth/gmail.modify',
      },
    });
    const { exchangeCodeForTokens, MissingRefreshTokenError } = await import(
      './oauth'
    );
    await expect(exchangeCodeForTokens('code')).rejects.toBeInstanceOf(
      MissingRefreshTokenError,
    );
  });

  it('throws InsufficientScopeError when gmail.modify missing', async () => {
    mockGetToken.mockResolvedValueOnce({
      tokens: {
        access_token: 'access-abc',
        refresh_token: 'refresh-xyz',
        expiry_date: 1_717_000_000_000,
        scope: 'openid email',
      },
    });
    const { exchangeCodeForTokens, InsufficientScopeError } = await import(
      './oauth'
    );
    await expect(exchangeCodeForTokens('code')).rejects.toBeInstanceOf(
      InsufficientScopeError,
    );
  });

  it('rethrows googleapis errors (e.g. redirect_uri_mismatch)', async () => {
    mockGetToken.mockRejectedValueOnce(
      new Error('redirect_uri_mismatch'),
    );
    const { exchangeCodeForTokens } = await import('./oauth');
    await expect(exchangeCodeForTokens('code')).rejects.toThrow(
      /redirect_uri_mismatch/,
    );
  });

  it('throws when access_token missing in response', async () => {
    mockGetToken.mockResolvedValueOnce({
      tokens: {
        refresh_token: 'refresh-xyz',
        expiry_date: 1,
        scope: 'https://www.googleapis.com/auth/gmail.modify',
      },
    });
    const { exchangeCodeForTokens } = await import('./oauth');
    await expect(exchangeCodeForTokens('code')).rejects.toThrow(
      /no access_token/,
    );
  });

  it('throws when expiry_date missing', async () => {
    mockGetToken.mockResolvedValueOnce({
      tokens: {
        access_token: 'a',
        refresh_token: 'r',
        scope: 'https://www.googleapis.com/auth/gmail.modify',
      },
    });
    const { exchangeCodeForTokens } = await import('./oauth');
    await expect(exchangeCodeForTokens('code')).rejects.toThrow(
      /no expiry_date/,
    );
  });
});

describe('fetchGmailUserEmail', () => {
  it('returns emailAddress from gmail profile', async () => {
    mockGetProfile.mockResolvedValueOnce({
      data: { emailAddress: 'shared@studio.com' },
    });
    const { fetchGmailUserEmail } = await import('./oauth');
    await expect(fetchGmailUserEmail('access-abc')).resolves.toBe(
      'shared@studio.com',
    );
    expect(mockSetCredentials).toHaveBeenCalledWith({
      access_token: 'access-abc',
    });
    expect(mockGetProfile).toHaveBeenCalledWith({ userId: 'me' });
  });

  it('throws when Gmail returns no emailAddress', async () => {
    mockGetProfile.mockResolvedValueOnce({ data: {} });
    const { fetchGmailUserEmail } = await import('./oauth');
    await expect(fetchGmailUserEmail('access')).rejects.toThrow(
      /no emailAddress/,
    );
  });
});

describe('revokeTokens', () => {
  it('delegates to OAuth2.revokeToken', async () => {
    mockRevokeToken.mockResolvedValueOnce(undefined);
    const { revokeTokens } = await import('./oauth');
    await revokeTokens('refresh-xyz');
    expect(mockRevokeToken).toHaveBeenCalledWith('refresh-xyz');
  });
});
