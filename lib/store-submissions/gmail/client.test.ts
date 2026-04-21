import {
  afterEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

/**
 * Tests for `lib/store-submissions/gmail/client.ts`.
 *
 * We exercise `withRetry` + the thin wrappers (`listHistory`,
 * `listMessages`, `getMessage`, `getCurrentHistoryId`) directly, passing
 * a hand-built mock gmail client instead of going through `googleapis`.
 * This avoids coupling tests to the SDK's internals and keeps the retry
 * semantics + response-narrowing logic honest.
 */

// `createGmailClient` is tested via an integration-style spec at the
// bottom: it just wires `ensureFreshToken` → `getOAuthClient` →
// `google.gmail(...)`, so we mock those two dependencies and assert the
// wiring.

const { mockEnsureFreshToken, mockGetOAuthClient, mockGoogleGmail } =
  vi.hoisted(() => ({
    mockEnsureFreshToken: vi.fn(),
    mockGetOAuthClient: vi.fn(),
    mockGoogleGmail: vi.fn(),
  }));

vi.mock('./credentials', () => ({
  ensureFreshToken: mockEnsureFreshToken,
}));

vi.mock('./oauth', () => ({
  getOAuthClient: mockGetOAuthClient,
}));

vi.mock('googleapis', () => ({
  google: {
    gmail: mockGoogleGmail,
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* withRetry                                                                  */
/* -------------------------------------------------------------------------- */

describe('withRetry', () => {
  it('returns the successful result with no sleeps on first try', async () => {
    const { withRetry } = await import('./client');
    const sleep = vi.fn();
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { sleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on 429 and succeeds after backoff', async () => {
    const { withRetry } = await import('./client');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = Object.assign(new Error('rate'), {
      code: 429,
      response: { status: 429, headers: {} },
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, { sleep, backoffMs: [100, 200, 400] });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('honors Retry-After header when present (capped at 10s)', async () => {
    const { withRetry } = await import('./client');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = Object.assign(new Error('rate'), {
      code: 429,
      response: { status: 429, headers: { 'retry-after': '3' } },
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');
    await withRetry(fn, { sleep, backoffMs: [100] });
    expect(sleep).toHaveBeenCalledWith(3000); // 3s from header
  });

  it('caps absurd Retry-After values at 10s', async () => {
    const { withRetry } = await import('./client');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = Object.assign(new Error('rate'), {
      code: 429,
      response: { status: 429, headers: { 'retry-after': '3600' } }, // 1 hour
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');
    await withRetry(fn, { sleep, backoffMs: [100] });
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it('throws GmailRateLimitError after retries exhausted', async () => {
    const { withRetry } = await import('./client');
    const { GmailRateLimitError } = await import('./errors');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = Object.assign(new Error('rate'), {
      code: 429,
      response: { status: 429, headers: { 'retry-after': '2' } },
    });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { sleep, backoffMs: [50, 100] }),
    ).rejects.toBeInstanceOf(GmailRateLimitError);
    // 3 attempts total (initial + 2 retries) against backoff length = 2.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry on non-429 errors', async () => {
    const { withRetry } = await import('./client');
    const sleep = vi.fn();
    const err = Object.assign(new Error('unauth'), {
      code: 401,
      response: { status: 401, headers: {} },
    });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('translates 404 into GmailHistoryExpiredError immediately (no retry)', async () => {
    const { withRetry } = await import('./client');
    const { GmailHistoryExpiredError } = await import('./errors');
    const sleep = vi.fn();
    const err = Object.assign(new Error('history expired'), {
      code: 404,
      response: { status: 404 },
    });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { sleep })).rejects.toBeInstanceOf(
      GmailHistoryExpiredError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* listHistory                                                                */
/* -------------------------------------------------------------------------- */

function buildMockClient(): {
  client: {
    users: {
      history: { list: Mock };
      messages: { list: Mock; get: Mock };
      getProfile: Mock;
    };
  };
  spies: {
    historyList: Mock;
    messagesList: Mock;
    messagesGet: Mock;
    getProfile: Mock;
  };
} {
  const historyList = vi.fn();
  const messagesList = vi.fn();
  const messagesGet = vi.fn();
  const getProfile = vi.fn();
  return {
    client: {
      users: {
        history: { list: historyList },
        messages: { list: messagesList, get: messagesGet },
        getProfile,
      },
    },
    spies: { historyList, messagesList, messagesGet, getProfile },
  };
}

describe('listHistory', () => {
  it('dedupes messageIds across multiple history entries', async () => {
    const { listHistory } = await import('./client');
    const { client, spies } = buildMockClient();
    spies.historyList.mockResolvedValueOnce({
      data: {
        historyId: '9999',
        nextPageToken: null,
        history: [
          {
            messagesAdded: [
              { message: { id: 'm1' } },
              { message: { id: 'm2' } },
            ],
          },
          {
            messagesAdded: [
              { message: { id: 'm2' } }, // duplicate
              { message: { id: 'm3' } },
            ],
          },
        ],
      },
    });

    const result = await listHistory(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      { startHistoryId: '9000' },
      { sleep: vi.fn() },
    );
    expect(result.messageIds).toEqual(['m1', 'm2', 'm3']);
    expect(result.nextHistoryId).toBe('9999');
    expect(result.nextPageToken).toBeNull();
    expect(spies.historyList).toHaveBeenCalledWith({
      userId: 'me',
      startHistoryId: '9000',
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
      maxResults: 100,
      pageToken: undefined,
    });
  });

  it('returns empty messageIds when history is absent', async () => {
    const { listHistory } = await import('./client');
    const { client, spies } = buildMockClient();
    spies.historyList.mockResolvedValueOnce({ data: { historyId: '1000' } });
    const result = await listHistory(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      { startHistoryId: '500' },
      { sleep: vi.fn() },
    );
    expect(result.messageIds).toEqual([]);
    expect(result.nextHistoryId).toBe('1000');
  });

  it('maps 404 to GmailHistoryExpiredError', async () => {
    const { listHistory } = await import('./client');
    const { GmailHistoryExpiredError } = await import('./errors');
    const { client, spies } = buildMockClient();
    spies.historyList.mockRejectedValueOnce(
      Object.assign(new Error('history not found'), { code: 404 }),
    );
    await expect(
      listHistory(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client as any,
        { startHistoryId: '0' },
        { sleep: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(GmailHistoryExpiredError);
  });
});

/* -------------------------------------------------------------------------- */
/* listMessages                                                               */
/* -------------------------------------------------------------------------- */

describe('listMessages', () => {
  it('extracts message IDs + pagination cursor', async () => {
    const { listMessages } = await import('./client');
    const { client, spies } = buildMockClient();
    spies.messagesList.mockResolvedValueOnce({
      data: {
        messages: [{ id: 'a' }, { id: 'b' }, { id: undefined }, {}],
        nextPageToken: 'next',
        resultSizeEstimate: 2,
      },
    });
    const result = await listMessages(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      { query: 'in:inbox -label:Processed', maxResults: 50 },
      { sleep: vi.fn() },
    );
    expect(result.messageIds).toEqual(['a', 'b']); // IDs without `id` dropped
    expect(result.nextPageToken).toBe('next');
    expect(result.resultSizeEstimate).toBe(2);
    expect(spies.messagesList).toHaveBeenCalledWith({
      userId: 'me',
      q: 'in:inbox -label:Processed',
      maxResults: 50,
      pageToken: undefined,
    });
  });

  it('returns empty list when messages is undefined', async () => {
    const { listMessages } = await import('./client');
    const { client, spies } = buildMockClient();
    spies.messagesList.mockResolvedValueOnce({ data: {} });
    const result = await listMessages(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      { query: '' },
      { sleep: vi.fn() },
    );
    expect(result.messageIds).toEqual([]);
    expect(result.nextPageToken).toBeNull();
    expect(result.resultSizeEstimate).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* getMessage + getCurrentHistoryId                                           */
/* -------------------------------------------------------------------------- */

describe('getMessage', () => {
  it('requests format=full and returns raw payload', async () => {
    const { getMessage } = await import('./client');
    const { client, spies } = buildMockClient();
    const payload = { id: 'mid', payload: { mimeType: 'text/plain' } };
    spies.messagesGet.mockResolvedValueOnce({ data: payload });
    const result = await getMessage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      'mid',
      { sleep: vi.fn() },
    );
    expect(result).toEqual(payload);
    expect(spies.messagesGet).toHaveBeenCalledWith({
      userId: 'me',
      id: 'mid',
      format: 'full',
    });
  });
});

describe('getCurrentHistoryId', () => {
  it('returns the profile historyId', async () => {
    const { getCurrentHistoryId } = await import('./client');
    const { client, spies } = buildMockClient();
    spies.getProfile.mockResolvedValueOnce({ data: { historyId: '1234' } });
    const result = await getCurrentHistoryId(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      { sleep: vi.fn() },
    );
    expect(result).toBe('1234');
  });

  it('returns null when profile lacks historyId', async () => {
    const { getCurrentHistoryId } = await import('./client');
    const { client, spies } = buildMockClient();
    spies.getProfile.mockResolvedValueOnce({ data: {} });
    const result = await getCurrentHistoryId(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      { sleep: vi.fn() },
    );
    expect(result).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* createGmailClient (wiring smoke test)                                      */
/* -------------------------------------------------------------------------- */

describe('createGmailClient', () => {
  it('calls ensureFreshToken, sets credentials on the OAuth2 client, returns gmail client', async () => {
    const setCredentials = vi.fn();
    const fakeOAuthClient = { setCredentials };
    mockGetOAuthClient.mockReturnValue(fakeOAuthClient);

    const fakeCreds = {
      email: 'shared@studio.com',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_expires_at: new Date('2026-04-20T13:00:00Z'),
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      connected_at: new Date('2026-04-15'),
      connected_by: null,
      last_refreshed_at: null,
    };
    mockEnsureFreshToken.mockResolvedValue(fakeCreds);

    const fakeGmailClient = { __brand: 'gmail' };
    mockGoogleGmail.mockReturnValue(fakeGmailClient);

    const { createGmailClient } = await import('./client');
    const client = await createGmailClient();

    expect(mockEnsureFreshToken).toHaveBeenCalledTimes(1);
    expect(setCredentials).toHaveBeenCalledWith({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry_date: fakeCreds.token_expires_at.getTime(),
      scope: 'https://www.googleapis.com/auth/gmail.modify',
      token_type: 'Bearer',
    });
    expect(mockGoogleGmail).toHaveBeenCalledWith({
      version: 'v1',
      auth: fakeOAuthClient,
    });
    expect(client).toBe(fakeGmailClient);
  });
});
