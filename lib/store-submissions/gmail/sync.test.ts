/**
 * Unit tests for the Gmail sync orchestrator.
 *
 * Strategy: mock every dependency (Gmail client, sync-state helpers,
 * sender-resolver, rules query, classifier, storeDb) so the test asserts
 * the orchestration logic in isolation — mode selection, per-message
 * routing, lock discipline, state transitions, error handling.
 *
 * Each helper has its own tests (sender-resolver.test.ts,
 * sync-state.test.ts, client.test.ts, parser.test.ts); those cover the
 * correctness of the mocked surfaces and aren't duplicated here.
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
  // ./client
  mockCreateGmailClient: vi.fn(),
  mockListHistory: vi.fn(),
  mockListMessages: vi.fn(),
  mockGetMessage: vi.fn(),
  mockGetCurrentHistoryId: vi.fn(),
  // ./sync-state
  mockTryAcquireSyncLock: vi.fn(),
  mockReleaseSyncLock: vi.fn(),
  mockGetSyncState: vi.fn(),
  mockAdvanceSyncState: vi.fn(),
  mockRecordSyncFailure: vi.fn(),
  mockInsertSyncLog: vi.fn(),
  // ./sender-resolver
  mockLoadActiveSenders: vi.fn(),
  mockCreateSenderResolver: vi.fn(),
  // ./parser
  mockParseGmailMessage: vi.fn(),
  // ../queries/rules
  mockGetRulesSnapshot: vi.fn(),
  // ../classifier
  mockClassify: vi.fn(),
  // ../db
  mockFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockEq: vi.fn(),
  mockLimit: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock('./client', () => ({
  createGmailClient: hoisted.mockCreateGmailClient,
  listHistory: hoisted.mockListHistory,
  listMessages: hoisted.mockListMessages,
  getMessage: hoisted.mockGetMessage,
  getCurrentHistoryId: hoisted.mockGetCurrentHistoryId,
}));

vi.mock('./sync-state', () => ({
  tryAcquireSyncLock: hoisted.mockTryAcquireSyncLock,
  releaseSyncLock: hoisted.mockReleaseSyncLock,
  getSyncState: hoisted.mockGetSyncState,
  advanceSyncState: hoisted.mockAdvanceSyncState,
  recordSyncFailure: hoisted.mockRecordSyncFailure,
  insertSyncLog: hoisted.mockInsertSyncLog,
}));

vi.mock('./sender-resolver', () => ({
  loadActiveSenders: hoisted.mockLoadActiveSenders,
  createSenderResolver: hoisted.mockCreateSenderResolver,
}));

vi.mock('./parser', () => ({
  parseGmailMessage: hoisted.mockParseGmailMessage,
  MAX_BODY_CHARS: 100_000,
  TRUNCATION_MARKER: '\n\n[... truncated at 100KB]',
}));

vi.mock('../queries/rules', () => ({
  getRulesSnapshotForPlatform: hoisted.mockGetRulesSnapshot,
}));

vi.mock('../classifier', () => ({
  classify: hoisted.mockClassify,
}));

vi.mock('../db', () => ({
  storeDb: () => ({ from: hoisted.mockFrom }),
}));

beforeEach(() => {
  // Reset BEFORE configuring defaults. `clearAllMocks` only wipes call
  // history; `mockImplementationOnce` / `mockReturnValueOnce` queues
  // from prior tests that returned early (e.g. SyncInProgress) would
  // otherwise leak into this test and consume ahead of the new queue.
  vi.resetAllMocks();

  // Happy-path defaults — individual tests override with mockResolvedValueOnce.
  hoisted.mockTryAcquireSyncLock.mockResolvedValue(true);
  hoisted.mockReleaseSyncLock.mockResolvedValue(undefined);
  hoisted.mockAdvanceSyncState.mockResolvedValue(undefined);
  hoisted.mockRecordSyncFailure.mockResolvedValue(undefined);
  hoisted.mockInsertSyncLog.mockResolvedValue(undefined);
  hoisted.mockCreateGmailClient.mockResolvedValue({ __brand: 'gmail' });
  hoisted.mockLoadActiveSenders.mockResolvedValue([]);
  hoisted.mockCreateSenderResolver.mockReturnValue(() => null); // default: drop everything
  hoisted.mockGetSyncState.mockResolvedValue({
    lastHistoryId: '1000',
    lastSyncedAt: null,
    lastFullSyncAt: null,
    emailsProcessedTotal: 0,
    consecutiveFailures: 0,
    lastError: null,
    lastErrorAt: null,
    lockedAt: null,
    lockedBy: null,
  });

  // storeDb chain for emailAlreadyPersisted + insertEmailMessageRow.
  //   - `.from('email_messages').select('id').eq(...).limit(1).maybeSingle()`
  //     → dedup check
  //   - `.from('email_messages').insert(...)` → INSERT
  const chain = {
    select: hoisted.mockSelect,
    eq: hoisted.mockEq,
    limit: hoisted.mockLimit,
    maybeSingle: hoisted.mockMaybeSingle,
    insert: hoisted.mockInsert,
  };
  hoisted.mockFrom.mockReturnValue(chain);
  hoisted.mockSelect.mockReturnValue(chain);
  hoisted.mockEq.mockReturnValue(chain);
  hoisted.mockLimit.mockReturnValue(chain);
  // Default: no dedup collision, no insert errors.
  hoisted.mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  hoisted.mockInsert.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

/* ----------------------------------------------------------------------------
 * Test helpers
 * -------------------------------------------------------------------------- */

function mockHistoryDelta(messageIds: string[], nextHistoryId = '1100') {
  hoisted.mockListHistory.mockResolvedValueOnce({
    messageIds,
    nextHistoryId,
    nextPageToken: null,
  });
}

function mockFallback(messageIds: string[], nextHistoryId = '2000') {
  hoisted.mockListMessages.mockResolvedValueOnce({
    messageIds,
    nextPageToken: null,
    resultSizeEstimate: messageIds.length,
  });
  hoisted.mockGetCurrentHistoryId.mockResolvedValueOnce(nextHistoryId);
}

function mockParsedEmail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    messageId: overrides.messageId ?? 'm1',
    threadId: overrides.threadId ?? 't1',
    fromEmail: overrides.fromEmail ?? 'no-reply@apple.com',
    fromName: overrides.fromName ?? 'Apple',
    to: overrides.to ?? ['team@studio.com'],
    subject: overrides.subject ?? 'subj',
    body: overrides.body ?? 'body',
    receivedAt: overrides.receivedAt ?? new Date('2026-04-20T10:00:00Z'),
    labels: overrides.labels ?? ['INBOX'],
  };
}

/* ============================================================================
 * Lock discipline
 * ========================================================================== */

describe('runSync — lock discipline', () => {
  it('throws SyncInProgressError when lock is busy', async () => {
    hoisted.mockTryAcquireSyncLock.mockResolvedValueOnce(false);
    const { runSync } = await import('./sync');
    const { SyncInProgressError } = await import('./errors');
    await expect(runSync()).rejects.toBeInstanceOf(SyncInProgressError);
    // Failed acquisition must NOT cause a release call.
    expect(hoisted.mockReleaseSyncLock).not.toHaveBeenCalled();
  });

  it('releases the lock even when processing throws', async () => {
    hoisted.mockCreateGmailClient.mockRejectedValueOnce(new Error('boom'));
    const { runSync } = await import('./sync');
    await expect(runSync()).rejects.toThrow(/boom/);
    expect(hoisted.mockReleaseSyncLock).toHaveBeenCalledTimes(1);
  });

  it('writes sync_logs row even when processing throws', async () => {
    hoisted.mockCreateGmailClient.mockRejectedValueOnce(new Error('boom'));
    const { runSync } = await import('./sync');
    await expect(runSync()).rejects.toThrow(/boom/);
    expect(hoisted.mockInsertSyncLog).toHaveBeenCalledTimes(1);
    const logArgs = hoisted.mockInsertSyncLog.mock.calls[0][0];
    expect(logArgs.errorMessage).toMatch(/boom/);
  });
});

/* ============================================================================
 * Mode selection (INCREMENTAL vs FALLBACK)
 * ========================================================================== */

describe('runSync — mode selection', () => {
  it('uses INCREMENTAL when last_history_id is set', async () => {
    mockHistoryDelta([], '1200');
    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });
    expect(result.mode).toBe('INCREMENTAL');
    expect(hoisted.mockListHistory).toHaveBeenCalledTimes(1);
    expect(hoisted.mockListMessages).not.toHaveBeenCalled();
  });

  it('uses FALLBACK when last_history_id is null', async () => {
    hoisted.mockGetSyncState.mockResolvedValueOnce({
      lastHistoryId: null,
      lastSyncedAt: null,
      lastFullSyncAt: null,
      emailsProcessedTotal: 0,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorAt: null,
      lockedAt: null,
      lockedBy: null,
    });
    mockFallback([]);
    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });
    expect(result.mode).toBe('FALLBACK');
    expect(hoisted.mockListHistory).not.toHaveBeenCalled();
    expect(hoisted.mockListMessages).toHaveBeenCalledTimes(1);
  });

  it('auto-falls back when listHistory throws GmailHistoryExpiredError', async () => {
    const { GmailHistoryExpiredError } = await import('./errors');
    hoisted.mockListHistory.mockRejectedValueOnce(
      new GmailHistoryExpiredError(new Error('404')),
    );
    mockFallback([]);
    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });
    expect(result.mode).toBe('FALLBACK');
    expect(hoisted.mockListHistory).toHaveBeenCalledTimes(1);
    expect(hoisted.mockListMessages).toHaveBeenCalledTimes(1);
  });

  it('propagates non-404 listHistory errors', async () => {
    hoisted.mockListHistory.mockRejectedValueOnce(new Error('500 server'));
    const { runSync } = await import('./sync');
    await expect(
      runSync({ gmailClient: { __brand: 'gmail' } as never }),
    ).rejects.toThrow(/500 server/);
  });
});

/* ============================================================================
 * Per-message processing
 * ========================================================================== */

describe('runSync — per-message routing', () => {
  it('CLASSIFIED: classify() → insert row with classifier_version + advance cursor', async () => {
    mockHistoryDelta(['m1'], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm1', threadId: 't1' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(mockParsedEmail());
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => ({
      platformId: 'apple-uuid',
      platformKey: 'apple',
    }));
    hoisted.mockGetRulesSnapshot.mockResolvedValueOnce({
      platform_id: 'apple-uuid',
      platform_key: 'apple',
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
      apps_with_aliases: [],
    });
    hoisted.mockClassify.mockReturnValueOnce({
      status: 'CLASSIFIED',
      platform_id: 'apple-uuid',
      app_id: 'app-1',
      type_id: 'type-1',
      outcome: 'APPROVED',
      type_payload: {},
      submission_id: null,
      extracted_app_name: 'Skyline Runners',
      matched_rules: [],
    });

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(result.success).toBe(true);
    expect(result.stats.classified).toBe(1);
    expect(result.stats.fetched).toBe(1);

    // INSERT happened with classifier_version embedded in JSONB.
    expect(hoisted.mockInsert).toHaveBeenCalledTimes(1);
    const insertPayload = hoisted.mockInsert.mock.calls[0][0];
    expect(insertPayload.classification_status).toBe('CLASSIFIED');
    expect(insertPayload.classification_result.classifier_version).toBe('1.0');
    expect(insertPayload.ticket_id).toBeNull();
    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledWith({
      mode: 'INCREMENTAL',
      newHistoryId: '1100',
      processedCount: 1,
    });
    expect(hoisted.mockRecordSyncFailure).not.toHaveBeenCalled();
  });

  it('DROPPED: no sender match → insert DROPPED row, skip classifier', async () => {
    mockHistoryDelta(['m1'], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm1', threadId: 't1' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(
      mockParsedEmail({ fromEmail: 'spam@unknown.com' }),
    );
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(result.stats.dropped).toBe(1);
    expect(result.stats.classified).toBe(0);
    // Classifier must NOT be invoked when sender doesn't match.
    expect(hoisted.mockClassify).not.toHaveBeenCalled();
    // Rules snapshot must NOT be loaded (skips the DB cost).
    expect(hoisted.mockGetRulesSnapshot).not.toHaveBeenCalled();

    const insertPayload = hoisted.mockInsert.mock.calls[0][0];
    expect(insertPayload.classification_status).toBe('DROPPED');
    expect(insertPayload.classification_result.reason).toBe('NO_SENDER_MATCH');
  });

  it('ERROR from parser: EmailParseError → ERROR row + stats.errors++', async () => {
    const { EmailParseError } = await import('./errors');
    mockHistoryDelta(['m1'], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm1', threadId: 't9' });
    hoisted.mockParseGmailMessage.mockImplementationOnce(() => {
      throw new EmailParseError('m1', 'Missing From header');
    });

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(result.stats.errors).toBe(1);
    expect(result.success).toBe(false);

    const insertPayload = hoisted.mockInsert.mock.calls[0][0];
    expect(insertPayload.classification_status).toBe('ERROR');
    expect(insertPayload.classification_result.error_code).toBe('PARSE_ERROR');
    expect(insertPayload.gmail_msg_id).toBe('m1');
    // Thread id captured from raw Gmail response (parser didn't reach it).
    expect(insertPayload.gmail_thread_id).toBe('t9');

    // Cursor NOT advanced when any error occurred.
    expect(hoisted.mockAdvanceSyncState).not.toHaveBeenCalled();
    expect(hoisted.mockRecordSyncFailure).toHaveBeenCalledTimes(1);
  });

  it('ERROR when platform has no rules configured', async () => {
    mockHistoryDelta(['m1'], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm1', threadId: 't1' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(mockParsedEmail());
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => ({
      platformId: 'google-uuid',
      platformKey: 'google',
    }));
    hoisted.mockGetRulesSnapshot.mockResolvedValueOnce(null); // no rules

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(result.stats.errors).toBe(1);
    const insertPayload = hoisted.mockInsert.mock.calls[0][0];
    expect(insertPayload.classification_status).toBe('ERROR');
    expect(insertPayload.classification_result.error_code).toBe('NO_RULES');
    expect(hoisted.mockClassify).not.toHaveBeenCalled();
  });

  it('UNCLASSIFIED_APP classifier output → stats.unclassified++', async () => {
    mockHistoryDelta(['m1'], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm1', threadId: 't1' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(mockParsedEmail());
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => ({
      platformId: 'apple-uuid',
      platformKey: 'apple',
    }));
    hoisted.mockGetRulesSnapshot.mockResolvedValueOnce({
      platform_id: 'apple-uuid',
      platform_key: 'apple',
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
      apps_with_aliases: [],
    });
    hoisted.mockClassify.mockReturnValueOnce({
      status: 'UNCLASSIFIED_APP',
      platform_id: 'apple-uuid',
      outcome: 'APPROVED',
      extracted_app_name: 'Unknown App',
      matched_rules: [],
    });
    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });
    expect(result.stats.unclassified).toBe(1);
    expect(result.success).toBe(true); // UNCLASSIFIED is NOT an error
  });
});

/* ============================================================================
 * Dedup
 * ========================================================================== */

describe('runSync — dedup', () => {
  it('skips messages already in email_messages', async () => {
    mockHistoryDelta(['m1'], '1100');
    // First call (dedup check) returns an existing row → skip.
    hoisted.mockMaybeSingle.mockResolvedValueOnce({
      data: { id: 'existing-uuid' },
      error: null,
    });

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    // Nothing fetched or inserted — message was already persisted.
    expect(hoisted.mockGetMessage).not.toHaveBeenCalled();
    expect(hoisted.mockInsert).not.toHaveBeenCalled();
    // Still counts toward `fetched` for sync_logs audit.
    expect(result.stats.fetched).toBe(1);
    expect(result.stats.classified).toBe(0);
  });

  it('swallows UNIQUE(gmail_msg_id) violations (race with parallel run)', async () => {
    mockHistoryDelta(['m1'], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm1', threadId: 't1' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(
      mockParsedEmail({ fromEmail: 'spam@unknown.com' }),
    );
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);
    hoisted.mockInsert.mockResolvedValueOnce({
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    // UNIQUE violation must not bump errors — another run already
    // persisted the same row, which is a benign dedup collision.
    expect(result.stats.errors).toBe(0);
  });
});

/* ============================================================================
 * Memoization
 * ========================================================================== */

describe('runSync — memoization', () => {
  it('loads rules snapshot once per platform, reuses across messages', async () => {
    mockHistoryDelta(['m1', 'm2', 'm3'], '1200');
    for (let i = 0; i < 3; i++) {
      hoisted.mockGetMessage.mockResolvedValueOnce({
        id: `m${i + 1}`,
        threadId: 't',
      });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: `m${i + 1}` }),
      );
      hoisted.mockClassify.mockReturnValueOnce({
        status: 'CLASSIFIED',
        platform_id: 'apple-uuid',
        app_id: 'app',
        type_id: 'type',
        outcome: 'APPROVED',
        type_payload: {},
        submission_id: null,
        extracted_app_name: 'X',
        matched_rules: [],
      });
    }
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => ({
      platformId: 'apple-uuid',
      platformKey: 'apple',
    }));
    hoisted.mockGetRulesSnapshot.mockResolvedValueOnce({
      platform_id: 'apple-uuid',
      platform_key: 'apple',
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
      apps_with_aliases: [],
    });

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    // 3 messages same platform → rules fetched exactly once.
    expect(hoisted.mockGetRulesSnapshot).toHaveBeenCalledTimes(1);
    expect(hoisted.mockClassify).toHaveBeenCalledTimes(3);
    expect(result.stats.classified).toBe(3);
  });

  it('loads active senders exactly once per run, regardless of message count', async () => {
    mockHistoryDelta(['m1', 'm2'], '1200');
    hoisted.mockGetMessage
      .mockResolvedValueOnce({ id: 'm1', threadId: 't' })
      .mockResolvedValueOnce({ id: 'm2', threadId: 't' });
    hoisted.mockParseGmailMessage
      .mockReturnValueOnce(mockParsedEmail())
      .mockReturnValueOnce(mockParsedEmail({ messageId: 'm2' }));
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockLoadActiveSenders).toHaveBeenCalledTimes(1);
    expect(hoisted.mockCreateSenderResolver).toHaveBeenCalledTimes(1);
  });
});

/* ============================================================================
 * Cursor advancement
 * ========================================================================== */

describe('runSync — cursor advancement', () => {
  it('advances history_id when all messages succeed', async () => {
    mockHistoryDelta(['m1'], '9999');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm1', threadId: 't' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(mockParsedEmail());
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledWith({
      mode: 'INCREMENTAL',
      newHistoryId: '9999',
      processedCount: 1,
    });
    expect(hoisted.mockRecordSyncFailure).not.toHaveBeenCalled();
  });

  it('does NOT advance when any per-message error occurs', async () => {
    const { EmailParseError } = await import('./errors');
    mockHistoryDelta(['m1', 'm2'], '9999');
    // m1 succeeds (DROPPED), m2 parse-errors.
    hoisted.mockGetMessage
      .mockResolvedValueOnce({ id: 'm1', threadId: 't' })
      .mockResolvedValueOnce({ id: 'm2', threadId: 't' });
    hoisted.mockParseGmailMessage
      .mockReturnValueOnce(mockParsedEmail({ messageId: 'm1' }))
      .mockImplementationOnce(() => {
        throw new EmailParseError('m2', 'Missing From');
      });
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(result.stats.errors).toBe(1);
    expect(result.stats.dropped).toBe(1);
    // History not advanced — next tick will retry m1+m2. m1 dedup will skip;
    // m2 will attempt again.
    expect(hoisted.mockAdvanceSyncState).not.toHaveBeenCalled();
    expect(hoisted.mockRecordSyncFailure).toHaveBeenCalledTimes(1);
  });
});

/* ============================================================================
 * maxBatch handling
 * ========================================================================== */

describe('runSync — maxBatch', () => {
  it('caps batch at default 50 when 100 IDs available', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `m${i}`);
    mockHistoryDelta(ids, '9999');
    for (let i = 0; i < 100; i++) {
      hoisted.mockGetMessage.mockResolvedValueOnce({
        id: `m${i}`,
        threadId: 't',
      });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: `m${i}` }),
      );
    }
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(result.stats.fetched).toBe(50);
    expect(result.stats.dropped).toBe(50);
    expect(hoisted.mockGetMessage).toHaveBeenCalledTimes(50);
  });

  it('honors explicit maxBatch up to 200', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
    mockHistoryDelta(ids, '9999');
    for (let i = 0; i < 200; i++) {
      hoisted.mockGetMessage.mockResolvedValueOnce({
        id: `m${i}`,
        threadId: 't',
      });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: `m${i}` }),
      );
    }
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    const result = await runSync({
      gmailClient: { __brand: 'gmail' } as never,
      maxBatch: 500, // clamped to 200
    });

    expect(result.stats.fetched).toBe(200);
  });

  it('treats maxBatch < 1 as default 50', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `m${i}`);
    mockHistoryDelta(ids, '9999');
    for (let i = 0; i < 50; i++) {
      hoisted.mockGetMessage.mockResolvedValueOnce({
        id: `m${i}`,
        threadId: 't',
      });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: `m${i}` }),
      );
    }
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    const result = await runSync({
      gmailClient: { __brand: 'gmail' } as never,
      maxBatch: 0, // invalid → default
    });
    expect(result.stats.fetched).toBe(50);
  });
});

/* ============================================================================
 * Refresh-token-invalid special case
 * ========================================================================== */

describe('runSync — RefreshTokenInvalidError', () => {
  it('rethrows without re-bumping counter (ensureFreshToken already did)', async () => {
    const { RefreshTokenInvalidError } = await import('./errors');
    hoisted.mockCreateGmailClient.mockRejectedValueOnce(
      new RefreshTokenInvalidError(new Error('invalid_grant')),
    );
    const { runSync } = await import('./sync');
    await expect(runSync()).rejects.toBeInstanceOf(RefreshTokenInvalidError);
    expect(hoisted.mockRecordSyncFailure).not.toHaveBeenCalled();
    // But insertSyncLog + releaseSyncLock still run.
    expect(hoisted.mockInsertSyncLog).toHaveBeenCalledTimes(1);
    expect(hoisted.mockReleaseSyncLock).toHaveBeenCalledTimes(1);
  });
});

/* ============================================================================
 * sync_logs accuracy
 * ========================================================================== */

describe('runSync — sync_logs', () => {
  it('aggregates stats correctly in the log row', async () => {
    const { EmailParseError } = await import('./errors');
    mockHistoryDelta(['m1', 'm2', 'm3', 'm4', 'm5'], '9999');
    // m1: CLASSIFIED
    // m2: UNCLASSIFIED_TYPE
    // m3: DROPPED (no sender)
    // m4: ERROR (parser)
    // m5: CLASSIFIED
    hoisted.mockGetMessage
      .mockResolvedValueOnce({ id: 'm1', threadId: 't' })
      .mockResolvedValueOnce({ id: 'm2', threadId: 't' })
      .mockResolvedValueOnce({ id: 'm3', threadId: 't' })
      .mockResolvedValueOnce({ id: 'm4', threadId: 't' })
      .mockResolvedValueOnce({ id: 'm5', threadId: 't' });
    // Use mockImplementationOnce uniformly — mixing with
    // mockReturnValueOnce on the same mock has version-sensitive queue
    // order in vitest. Uniform mockImplementationOnce avoids the trap.
    hoisted.mockParseGmailMessage
      .mockImplementationOnce(() => mockParsedEmail({ messageId: 'm1' }))
      .mockImplementationOnce(() => mockParsedEmail({ messageId: 'm2' }))
      .mockImplementationOnce(() =>
        mockParsedEmail({ messageId: 'm3', fromEmail: 'spam@x.com' }),
      )
      .mockImplementationOnce(() => {
        throw new EmailParseError('m4', 'Missing From');
      })
      .mockImplementationOnce(() => mockParsedEmail({ messageId: 'm5' }));

    // Resolver: matches m1, m2, m5 → apple; m3 → null (DROPPED).
    hoisted.mockCreateSenderResolver.mockImplementationOnce(
      () => (email: string) => {
        if (email === 'spam@x.com') return null;
        return { platformId: 'apple-uuid', platformKey: 'apple' };
      },
    );
    hoisted.mockGetRulesSnapshot.mockResolvedValueOnce({
      platform_id: 'apple-uuid',
      platform_key: 'apple',
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
      apps_with_aliases: [],
    });
    hoisted.mockClassify
      .mockReturnValueOnce({
        status: 'CLASSIFIED',
        platform_id: 'apple-uuid',
        app_id: 'a',
        type_id: 't',
        outcome: 'APPROVED',
        type_payload: {},
        submission_id: null,
        extracted_app_name: 'X',
        matched_rules: [],
      })
      .mockReturnValueOnce({
        status: 'UNCLASSIFIED_TYPE',
        platform_id: 'apple-uuid',
        app_id: 'a',
        outcome: 'APPROVED',
        extracted_app_name: 'X',
        matched_rules: [],
      })
      .mockReturnValueOnce({
        status: 'CLASSIFIED',
        platform_id: 'apple-uuid',
        app_id: 'a',
        type_id: 't',
        outcome: 'APPROVED',
        type_payload: {},
        submission_id: null,
        extracted_app_name: 'X',
        matched_rules: [],
      });

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(result.stats).toEqual({
      fetched: 5,
      classified: 2,
      unclassified: 1,
      dropped: 1,
      errors: 1,
    });

    const logRow = hoisted.mockInsertSyncLog.mock.calls[0][0];
    expect(logRow).toMatchObject({
      syncMethod: 'INCREMENTAL',
      emailsFetched: 5,
      emailsClassified: 2,
      emailsUnclassified: 1,
      emailsDropped: 1,
      emailsErrored: 1,
    });
  });
});
