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
  // ./html-extractor
  mockExtractApple: vi.fn(),
  // ../queries/rules
  mockGetRulesSnapshot: vi.fn(),
  // ../classifier
  mockClassify: vi.fn(),
  // ../tickets/wire
  mockAssociateEmailWithTicket: vi.fn(),
  // @sentry/nextjs
  mockSentryCaptureMessage: vi.fn(),
  mockSentryCaptureException: vi.fn(),
  // ../db
  mockFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockEq: vi.fn(),
  mockLimit: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockInsert: vi.fn(),
  // INSERT chain terminals: `.insert(...).select('id').single()`
  mockInsertSelect: vi.fn(),
  mockInsertSingle: vi.fn(),
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

vi.mock('./html-extractor', () => ({
  extractApple: hoisted.mockExtractApple,
}));

vi.mock('../queries/rules', () => ({
  getRulesSnapshotForPlatform: hoisted.mockGetRulesSnapshot,
}));

vi.mock('../classifier', () => ({
  classify: hoisted.mockClassify,
}));

vi.mock('../tickets/wire', () => ({
  associateEmailWithTicket: hoisted.mockAssociateEmailWithTicket,
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: hoisted.mockSentryCaptureMessage,
  captureException: hoisted.mockSentryCaptureException,
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
  // Default extractor: empty payload (no items section detected).
  // Tests that exercise the extractor branch override per-call.
  hoisted.mockExtractApple.mockReturnValue({ outcome: null, items: [] });
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
  //     → dedup check (uses chain.select → chain.eq → chain.limit → chain.maybeSingle)
  //   - `.from('email_messages').insert(...).select('id').single()`
  //     → INSERT (uses chain.insert → mockInsertSelect → mockInsertSingle)
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
  // Default: no dedup collision.
  hoisted.mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  // INSERT chain: insert() → {select()} → {single()} → Promise<{data, error}>
  hoisted.mockInsert.mockReturnValue({ select: hoisted.mockInsertSelect });
  hoisted.mockInsertSelect.mockReturnValue({ single: hoisted.mockInsertSingle });
  hoisted.mockInsertSingle.mockResolvedValue({
    data: { id: 'email-row-uuid' },
    error: null,
  });
  // Wire default: every call returns a ticket association. Tests that
  // need failure/null use mockResolvedValueOnce / mockRejectedValueOnce.
  hoisted.mockAssociateEmailWithTicket.mockResolvedValue({
    ticketId: 'ticket-mock-uuid',
  });
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

/**
 * PR-23: queue multiple `listHistory` page responses in order. Each page
 * shape mirrors `HistoryDelta` from `./client`.
 */
function mockHistoryPages(
  pages: Array<{
    messageIds: string[];
    nextHistoryId?: string | null;
    nextPageToken?: string | null;
  }>,
) {
  for (const p of pages) {
    hoisted.mockListHistory.mockResolvedValueOnce({
      messageIds: p.messageIds,
      nextHistoryId: p.nextHistoryId ?? null,
      nextPageToken: p.nextPageToken ?? null,
    });
  }
}

function mockFallback(messageIds: string[], nextHistoryId = '2000') {
  hoisted.mockListMessages.mockResolvedValueOnce({
    messageIds,
    nextPageToken: null,
    resultSizeEstimate: messageIds.length,
  });
  hoisted.mockGetCurrentHistoryId.mockResolvedValueOnce(nextHistoryId);
}

/**
 * PR-23: queue multiple `listMessages` page responses + a current
 * historyId. Used for fallback pagination tests.
 */
function mockFallbackPages(
  pages: Array<{ messageIds: string[]; nextPageToken?: string | null }>,
  nextHistoryId = '2000',
) {
  for (const p of pages) {
    hoisted.mockListMessages.mockResolvedValueOnce({
      messageIds: p.messageIds,
      nextPageToken: p.nextPageToken ?? null,
      resultSizeEstimate: p.messageIds.length,
    });
  }
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
    bodyHtml: overrides.bodyHtml ?? '<html><body>html</body></html>',
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
 * Regression: SUBJECT_NOT_TRACKED must not drift the failure counter
 *
 * Prior to 2026-04-22, sender-matched emails whose subject missed every
 * whitelist pattern classified as ERROR/NO_SUBJECT_MATCH. That bumped
 * `stats.errors`, which blocked `advanceSyncState` and triggered
 * `recordSyncFailure` → `consecutive_failures++` on every sync batch
 * that contained one — pure operational noise (Apple sends ~daily
 * "Status Update" / "Ready for Distribution" / "IAP Approved" mails
 * that are not in the tracked whitelist). These tests assert that
 * DROPPED SUBJECT_NOT_TRACKED now counts under `stats.dropped` and lets
 * the cursor advance.
 * ========================================================================== */

describe('runSync — SUBJECT_NOT_TRACKED does not block cursor advance', () => {
  function primeSubjectNotTracked(n: number): void {
    const ids = Array.from({ length: n }, (_, i) => `m${i + 1}`);
    mockHistoryDelta(ids, '1100');
    for (let i = 0; i < n; i++) {
      hoisted.mockGetMessage.mockResolvedValueOnce({
        id: ids[i],
        threadId: `t${i + 1}`,
      });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: ids[i], threadId: `t${i + 1}` }),
      );
      hoisted.mockClassify.mockReturnValueOnce({
        status: 'DROPPED',
        reason: 'SUBJECT_NOT_TRACKED',
        platform_id: 'apple-uuid',
        platform_key: 'apple',
        matched_sender: 'no-reply@apple.com',
        matched_rules: [
          {
            step: 'sender',
            matched: true,
            details: { platform_key: 'apple' },
          },
        ],
      });
    }
    // Sender resolves for every message in the batch.
    hoisted.mockCreateSenderResolver.mockReturnValue(() => ({
      platformId: 'apple-uuid',
      platformKey: 'apple',
    }));
    hoisted.mockGetRulesSnapshot.mockResolvedValue({
      platform_id: 'apple-uuid',
      platform_key: 'apple',
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
      apps_with_aliases: [],
    });
  }

  it('batch of 5 SUBJECT_NOT_TRACKED → stats.dropped=5, stats.errors=0, cursor advances, no failure recorded', async () => {
    primeSubjectNotTracked(5);

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(result.stats.dropped).toBe(5);
    expect(result.stats.errors).toBe(0);
    expect(result.success).toBe(true);

    // Cursor MUST advance — the regression bug was that stats.errors>0
    // blocked this call, leaving consecutive_failures++ as the tail effect.
    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledTimes(1);
    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledWith({
      mode: 'INCREMENTAL',
      newHistoryId: '1100',
      processedCount: 5,
    });
    expect(hoisted.mockRecordSyncFailure).not.toHaveBeenCalled();

    // All 5 rows persisted as DROPPED with the new reason.
    expect(hoisted.mockInsert).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      const payload = hoisted.mockInsert.mock.calls[i][0];
      expect(payload.classification_status).toBe('DROPPED');
      expect(payload.classification_result.reason).toBe('SUBJECT_NOT_TRACKED');
      expect(payload.error_message).toBeNull();
    }
  });

  it('mixed batch: 3 SUBJECT_NOT_TRACKED + 1 true PARSE_ERROR → errors=1 blocks cursor, dropped=3 unaffected', async () => {
    const { EmailParseError } = await import('./errors');
    mockHistoryDelta(['m1', 'm2', 'm3', 'm4'], '1100');

    // m1, m2, m3 → parse ok, resolve ok, classify → DROPPED SUBJECT_NOT_TRACKED
    for (const msgId of ['m1', 'm2', 'm3']) {
      hoisted.mockGetMessage.mockResolvedValueOnce({ id: msgId, threadId: 't' });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: msgId }),
      );
      hoisted.mockClassify.mockReturnValueOnce({
        status: 'DROPPED',
        reason: 'SUBJECT_NOT_TRACKED',
        platform_id: 'apple-uuid',
        platform_key: 'apple',
        matched_sender: 'no-reply@apple.com',
        matched_rules: [],
      });
    }
    // m4 → parser throws EmailParseError (true processing failure).
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm4', threadId: 't4' });
    hoisted.mockParseGmailMessage.mockImplementationOnce(() => {
      throw new EmailParseError('m4', 'Malformed MIME');
    });

    hoisted.mockCreateSenderResolver.mockReturnValue(() => ({
      platformId: 'apple-uuid',
      platformKey: 'apple',
    }));
    hoisted.mockGetRulesSnapshot.mockResolvedValue({
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

    expect(result.stats.dropped).toBe(3);
    expect(result.stats.errors).toBe(1);
    expect(result.success).toBe(false);

    // True error still blocks the cursor — contract preserved.
    expect(hoisted.mockAdvanceSyncState).not.toHaveBeenCalled();
    expect(hoisted.mockRecordSyncFailure).toHaveBeenCalledTimes(1);
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
    hoisted.mockInsertSingle.mockResolvedValueOnce({
      data: null,
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
 * PR-8: Ticket wire integration
 *
 * Verifies sync.ts calls associateEmailWithTicket() iff the classification
 * is ticketable (CLASSIFIED, UNCLASSIFIED_APP, UNCLASSIFIED_TYPE) AND the
 * INSERT succeeded with a returned id. Wire failures (throw or null
 * return) must NOT abort the sync batch — PR-8 "graceful degradation"
 * contract.
 * ========================================================================== */

describe('runSync — ticket wire integration (PR-8)', () => {
  /** Shared setup for a single-message batch with resolvable sender + rules. */
  function primeSingleMessage(
    msgId: string,
    classification: Record<string, unknown>,
  ) {
    mockHistoryDelta([msgId], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: msgId, threadId: 't1' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(
      mockParsedEmail({ messageId: msgId }),
    );
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
    hoisted.mockClassify.mockReturnValueOnce(classification);
  }

  it('CLASSIFIED → wire invoked with inserted id + full classification', async () => {
    const classified = {
      status: 'CLASSIFIED',
      platform_id: 'apple-uuid',
      app_id: 'app-1',
      type_id: 'type-1',
      outcome: 'APPROVED',
      type_payload: {},
      submission_id: 'sub-1',
      extracted_app_name: 'Skyline Runners',
      matched_rules: [],
    };
    primeSingleMessage('m1', classified);
    hoisted.mockInsertSingle.mockResolvedValueOnce({
      data: { id: 'email-uuid-classified' },
      error: null,
    });

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockAssociateEmailWithTicket).toHaveBeenCalledTimes(1);
    const [emailId, passedClass] =
      hoisted.mockAssociateEmailWithTicket.mock.calls[0];
    expect(emailId).toBe('email-uuid-classified');
    // classification_version is stamped in sync.ts before INSERT; wire
    // receives the pre-stamp classification object directly from classify().
    expect(passedClass.status).toBe('CLASSIFIED');
    expect(passedClass.app_id).toBe('app-1');
    expect(passedClass.type_id).toBe('type-1');
  });

  it('UNCLASSIFIED_APP → wire invoked (bucket ticket per invariant #8)', async () => {
    primeSingleMessage('m2', {
      status: 'UNCLASSIFIED_APP',
      platform_id: 'apple-uuid',
      outcome: 'APPROVED',
      extracted_app_name: 'Unknown App',
      matched_rules: [],
    });
    hoisted.mockInsertSingle.mockResolvedValueOnce({
      data: { id: 'email-uuid-uncl-app' },
      error: null,
    });

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockAssociateEmailWithTicket).toHaveBeenCalledTimes(1);
    const [emailId, passedClass] =
      hoisted.mockAssociateEmailWithTicket.mock.calls[0];
    expect(emailId).toBe('email-uuid-uncl-app');
    expect(passedClass.status).toBe('UNCLASSIFIED_APP');
  });

  it('UNCLASSIFIED_TYPE → wire invoked (bucket ticket per invariant #8)', async () => {
    primeSingleMessage('m3', {
      status: 'UNCLASSIFIED_TYPE',
      platform_id: 'apple-uuid',
      app_id: 'app-1',
      outcome: 'APPROVED',
      extracted_app_name: 'Skyline Runners',
      matched_rules: [],
    });
    hoisted.mockInsertSingle.mockResolvedValueOnce({
      data: { id: 'email-uuid-uncl-type' },
      error: null,
    });

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockAssociateEmailWithTicket).toHaveBeenCalledTimes(1);
    const [emailId, passedClass] =
      hoisted.mockAssociateEmailWithTicket.mock.calls[0];
    expect(emailId).toBe('email-uuid-uncl-type');
    expect(passedClass.status).toBe('UNCLASSIFIED_TYPE');
  });

  it('DROPPED (SUBJECT_NOT_TRACKED) → wire NOT invoked (gated before call)', async () => {
    primeSingleMessage('m4', {
      status: 'DROPPED',
      reason: 'SUBJECT_NOT_TRACKED',
      platform_id: 'apple-uuid',
      platform_key: 'apple',
      matched_sender: 'no-reply@apple.com',
      matched_rules: [],
    });

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockAssociateEmailWithTicket).not.toHaveBeenCalled();
  });

  it('DROPPED (NO_SENDER_MATCH early-return) → wire NOT invoked', async () => {
    mockHistoryDelta(['m5'], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm5', threadId: 't1' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(
      mockParsedEmail({ fromEmail: 'spam@unknown.com' }),
    );
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockAssociateEmailWithTicket).not.toHaveBeenCalled();
    expect(hoisted.mockClassify).not.toHaveBeenCalled();
  });

  it('ERROR (PARSE_ERROR early-return) → wire NOT invoked', async () => {
    const { EmailParseError } = await import('./errors');
    mockHistoryDelta(['m6'], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm6', threadId: 't1' });
    hoisted.mockParseGmailMessage.mockImplementationOnce(() => {
      throw new EmailParseError('m6', 'Malformed MIME');
    });

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockAssociateEmailWithTicket).not.toHaveBeenCalled();
  });

  it('ERROR (NO_RULES early-return) → wire NOT invoked', async () => {
    mockHistoryDelta(['m7'], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm7', threadId: 't1' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(mockParsedEmail());
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => ({
      platformId: 'google-uuid',
      platformKey: 'google',
    }));
    hoisted.mockGetRulesSnapshot.mockResolvedValueOnce(null); // no rules

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockAssociateEmailWithTicket).not.toHaveBeenCalled();
    expect(hoisted.mockClassify).not.toHaveBeenCalled();
  });

  it('ERROR (classifier-produced REGEX_TIMEOUT) → wire NOT invoked (gated)', async () => {
    primeSingleMessage('m8', {
      status: 'ERROR',
      error_code: 'REGEX_TIMEOUT',
      error_message: 'regex exceeded 100ms',
      matched_rules: [],
    });

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    // Classifier ERROR goes through the success-path INSERT, but the
    // `isTicketableClassification` pre-gate blocks the wire call.
    expect(hoisted.mockAssociateEmailWithTicket).not.toHaveBeenCalled();
  });

  it('dedup race (INSERT returns null via UNIQUE violation) → wire NOT invoked', async () => {
    primeSingleMessage('m9', {
      status: 'CLASSIFIED',
      platform_id: 'apple-uuid',
      app_id: 'app-1',
      type_id: 'type-1',
      outcome: 'APPROVED',
      type_payload: {},
      submission_id: null,
      extracted_app_name: 'X',
      matched_rules: [],
    });
    hoisted.mockInsertSingle.mockResolvedValueOnce({
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint',
      },
    });

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    // The winning run handles the wire; this run bails silently.
    expect(hoisted.mockAssociateEmailWithTicket).not.toHaveBeenCalled();
    expect(result.stats.errors).toBe(0);
  });

  it('wire returns null (engine/UPDATE failed) → batch continues, no error', async () => {
    primeSingleMessage('m10', {
      status: 'CLASSIFIED',
      platform_id: 'apple-uuid',
      app_id: 'app-1',
      type_id: 'type-1',
      outcome: 'APPROVED',
      type_payload: {},
      submission_id: null,
      extracted_app_name: 'X',
      matched_rules: [],
    });
    hoisted.mockAssociateEmailWithTicket.mockResolvedValueOnce(null);

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    // Wire failure is graceful — batch succeeds, cursor advances.
    expect(result.success).toBe(true);
    expect(result.stats.errors).toBe(0);
    expect(result.stats.classified).toBe(1);
    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledTimes(1);
  });

  it('wire throws (contract violation) → swallowed, cursor still advances', async () => {
    // Wire's contract is "never throw" (it swallows + returns null on
    // failure). Defense-in-depth: sync.ts wraps the call in try/catch
    // anyway. Why it matters: without the wrap, a wire throw would
    // bump `stats.errors`, block cursor advance, and cause dedup to
    // permanently skip the row on retry → orphan with NULL ticket_id
    // and a wedged cursor. With the wrap: email is persisted, stats
    // are clean, cursor advances, orphan is Manager-recoverable.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const classified = {
      status: 'CLASSIFIED',
      platform_id: 'apple-uuid',
      app_id: 'app-1',
      type_id: 'type-1',
      outcome: 'APPROVED',
      type_payload: {},
      submission_id: null,
      extracted_app_name: 'X',
      matched_rules: [],
    };
    mockHistoryDelta(['m11', 'm12'], '1100');
    for (const id of ['m11', 'm12']) {
      hoisted.mockGetMessage.mockResolvedValueOnce({ id, threadId: 't' });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: id }),
      );
      hoisted.mockClassify.mockReturnValueOnce(classified);
    }
    hoisted.mockCreateSenderResolver.mockReturnValue(() => ({
      platformId: 'apple-uuid',
      platformKey: 'apple',
    }));
    hoisted.mockGetRulesSnapshot.mockResolvedValue({
      platform_id: 'apple-uuid',
      platform_key: 'apple',
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
      apps_with_aliases: [],
    });
    hoisted.mockAssociateEmailWithTicket
      .mockRejectedValueOnce(new Error('wire blew up unexpectedly'))
      .mockResolvedValueOnce({ ticketId: 'ticket-ok' });

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    // Both messages fully classified; wire throw did NOT bump errors.
    expect(result.stats.classified).toBe(2);
    expect(result.stats.errors).toBe(0);
    expect(result.success).toBe(true);
    expect(hoisted.mockAssociateEmailWithTicket).toHaveBeenCalledTimes(2);
    // Cursor advanced — critical invariant: wire failure doesn't wedge sync.
    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledTimes(1);
    // Contract violation logged for observability.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('wire contract violation'),
      expect.objectContaining({ emailId: 'email-row-uuid' }),
    );
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
 * PR-23: pagination + Bug C (no slice)
 *
 * Three production data-loss bugs fixed:
 *   Bug A — INCREMENTAL: orchestrator called listHistory once and
 *           ignored nextPageToken; pages 2+ silently skipped while
 *           cursor advanced past them.
 *   Bug B — FALLBACK: listMessages('in:inbox') had no pagination loop
 *           and no date anchor; 50-newest cap dropped older messages
 *           in the failure window.
 *   Bug C — slice(0, maxBatch): IDs 51-100 of a single-page response
 *           silently discarded; cursor still advanced past them.
 * ========================================================================== */

describe('runSync — Bug C (no slice)', () => {
  it('processes ALL IDs from a single page (100 IDs, default maxBatch=50)', async () => {
    // Pre-PR-23: slice(0, 50) discarded IDs 50-99 with cursor advancing.
    // Post-PR-23: all 100 are processed in one tick.
    const ids = Array.from({ length: 100 }, (_, i) => `m${i}`);
    mockHistoryDelta(ids, '9999');
    for (let i = 0; i < 100; i++) {
      hoisted.mockGetMessage.mockResolvedValueOnce({ id: `m${i}`, threadId: 't' });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: `m${i}` }),
      );
    }
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(result.stats.fetched).toBe(100);
    expect(result.stats.dropped).toBe(100);
    expect(hoisted.mockGetMessage).toHaveBeenCalledTimes(100);
    // Single page, no nextPageToken → not stopped early → cursor advances.
    expect(result.stoppedEarly).toBe(false);
    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledWith({
      mode: 'INCREMENTAL',
      newHistoryId: '9999',
      processedCount: 100,
    });
  });
});

describe('runSync — Bug A INCREMENTAL pagination', () => {
  it('drains all pages when nextPageToken is set on early pages', async () => {
    mockHistoryPages([
      {
        messageIds: ['m1', 'm2'],
        nextHistoryId: '1100',
        nextPageToken: 'page2-token',
      },
      {
        messageIds: ['m3', 'm4'],
        nextHistoryId: '1200',
        nextPageToken: null,
      },
    ]);
    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      hoisted.mockGetMessage.mockResolvedValueOnce({ id, threadId: 't' });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: id }),
      );
    }
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    const result = await runSync({
      gmailClient: { __brand: 'gmail' } as never,
      maxBatch: 200, // high enough to allow draining
    });

    expect(hoisted.mockListHistory).toHaveBeenCalledTimes(2);
    // Page 2 must be requested with the page-1 token threaded through.
    // listHistory(client, params, retryOptions?) — params at index [1].
    expect(hoisted.mockListHistory.mock.calls[1][1]).toMatchObject({
      pageToken: 'page2-token',
    });
    expect(result.stats.fetched).toBe(4);
    expect(result.pagesFetched).toBe(2);
    expect(result.stoppedEarly).toBe(false);
    // Cursor advances to FINAL page's historyId, not page-1's.
    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledWith({
      mode: 'INCREMENTAL',
      newHistoryId: '1200',
      processedCount: 4,
    });
  });

  it('preserves cursor (newHistoryId=null) when stopped early on maxBatch', async () => {
    // Page 1 returns 100 IDs + still has pageToken; maxBatch=50 hits cap.
    const idsP1 = Array.from({ length: 100 }, (_, i) => `m${i}`);
    mockHistoryPages([
      { messageIds: idsP1, nextHistoryId: '1100', nextPageToken: 'page2-token' },
    ]);
    for (const id of idsP1) {
      hoisted.mockGetMessage.mockResolvedValueOnce({ id, threadId: 't' });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: id }),
      );
    }
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    const result = await runSync({
      gmailClient: { __brand: 'gmail' } as never,
      maxBatch: 50,
    });

    // Only 1 page fetched — break triggered before page 2.
    expect(hoisted.mockListHistory).toHaveBeenCalledTimes(1);
    expect(result.pagesFetched).toBe(1);
    expect(result.stoppedEarly).toBe(true);
    expect(result.stats.fetched).toBe(100);

    // Cursor preserved — next tick re-fetches from same lastHistoryId,
    // dedup absorbs the redundant page-1 messages, walks to page 2+.
    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledWith({
      mode: 'INCREMENTAL',
      newHistoryId: null,
      processedCount: 100,
    });
  });

  it('safety cap: stops after SYNC_MAX_PAGES (10) even if pageToken keeps coming', async () => {
    // 11 pages all advertise nextPageToken=keep — we must stop at 10.
    const pages = Array.from({ length: 11 }, (_, i) => ({
      messageIds: [] as string[],
      nextHistoryId: String(2000 + i),
      nextPageToken: 'keep',
    }));
    mockHistoryPages(pages);
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    const result = await runSync({
      gmailClient: { __brand: 'gmail' } as never,
      maxBatch: 200, // never triggers the maxBatch break
    });

    expect(hoisted.mockListHistory).toHaveBeenCalledTimes(10);
    expect(result.pagesFetched).toBe(10);
    expect(result.stoppedEarly).toBe(true);
    // Conservative cursor: stoppedEarly + INCREMENTAL → cursor preserved.
    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledWith({
      mode: 'INCREMENTAL',
      newHistoryId: null,
      processedCount: 0,
    });
  });
});

describe('runSync — Bug B FALLBACK pagination + recovery', () => {
  it('first-run uses plain "in:inbox" query (no recovery_since)', async () => {
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
    mockFallback([], '5000');

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(result.mode).toBe('FALLBACK');
    expect(result.recoverySince).toBeNull();
    // listMessages(client, params, retryOptions?) — params at index [1].
    const callArgs = hoisted.mockListMessages.mock.calls[0][1];
    expect(callArgs.query).toBe('in:inbox');
    expect(callArgs.pageToken).toBeUndefined();
  });

  it('recovery uses date-bounded query when listHistory throws GmailHistoryExpiredError', async () => {
    const { GmailHistoryExpiredError } = await import('./errors');
    // last_synced_at = 2026-04-22T10:00:00Z. Recovery anchor =
    // last_synced_at - 1 day = 2026-04-21 → query 'in:inbox after:2026/04/21'.
    hoisted.mockGetSyncState.mockResolvedValueOnce({
      lastHistoryId: '1000',
      lastSyncedAt: new Date('2026-04-22T10:00:00Z'),
      lastFullSyncAt: null,
      emailsProcessedTotal: 0,
      consecutiveFailures: 215,
      lastError: 'expired',
      lastErrorAt: null,
      lockedAt: null,
      lockedBy: null,
    });
    hoisted.mockListHistory.mockRejectedValueOnce(
      new GmailHistoryExpiredError(new Error('404')),
    );
    mockFallback([], '5000');

    const { runSync } = await import('./sync');
    const result = await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(result.mode).toBe('FALLBACK');
    expect(result.recoverySince).toEqual(new Date('2026-04-21T10:00:00Z'));
    const callArgs = hoisted.mockListMessages.mock.calls[0][1];
    expect(callArgs.query).toBe('in:inbox after:2026/04/21');
  });

  it('paginates listMessages when nextPageToken is set', async () => {
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
    mockFallbackPages(
      [
        { messageIds: ['m1', 'm2'], nextPageToken: 'page2' },
        { messageIds: ['m3'], nextPageToken: null },
      ],
      '5000',
    );
    for (const id of ['m1', 'm2', 'm3']) {
      hoisted.mockGetMessage.mockResolvedValueOnce({ id, threadId: 't' });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: id }),
      );
    }
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    const result = await runSync({
      gmailClient: { __brand: 'gmail' } as never,
      maxBatch: 200,
    });

    expect(hoisted.mockListMessages).toHaveBeenCalledTimes(2);
    expect(hoisted.mockListMessages.mock.calls[1][1]).toMatchObject({
      pageToken: 'page2',
    });
    expect(result.stats.fetched).toBe(3);
    expect(result.pagesFetched).toBe(2);
    // FALLBACK ALWAYS advances cursor — even if stopped early
    // (multi-page recovery is the BACKFILL action's job).
    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledWith({
      mode: 'FALLBACK',
      newHistoryId: '5000',
      processedCount: 3,
    });
  });

  it('FALLBACK with stoppedEarly STILL advances cursor (multi-page recovery → BACKFILL)', async () => {
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
    const idsP1 = Array.from({ length: 100 }, (_, i) => `m${i}`);
    mockFallbackPages(
      [{ messageIds: idsP1, nextPageToken: 'page2' }],
      '5000',
    );
    for (const id of idsP1) {
      hoisted.mockGetMessage.mockResolvedValueOnce({ id, threadId: 't' });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: id }),
      );
    }
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    const result = await runSync({
      gmailClient: { __brand: 'gmail' } as never,
      maxBatch: 50, // forces stop early
    });

    expect(result.stoppedEarly).toBe(true);
    // Despite stopping early, FALLBACK still advances to "now".
    expect(hoisted.mockAdvanceSyncState).toHaveBeenCalledWith({
      mode: 'FALLBACK',
      newHistoryId: '5000',
      processedCount: 100,
    });
  });
});

/* ============================================================================
 * runBackfill — Manager-triggered recovery (PR-23)
 * ========================================================================== */

describe('runBackfill', () => {
  it('processes messages from date-bounded query without touching cursor', async () => {
    hoisted.mockListMessages.mockResolvedValueOnce({
      messageIds: ['m1', 'm2'],
      nextPageToken: null,
      resultSizeEstimate: 2,
    });
    for (const id of ['m1', 'm2']) {
      hoisted.mockGetMessage.mockResolvedValueOnce({ id, threadId: 't' });
      hoisted.mockParseGmailMessage.mockReturnValueOnce(
        mockParsedEmail({ messageId: id }),
      );
    }
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const recoverySince = new Date('2026-04-22T00:00:00Z');
    const { runBackfill } = await import('./sync');
    const result = await runBackfill({
      recoverySince,
      gmailClient: { __brand: 'gmail' } as never,
    });

    expect(result.complete).toBe(true);
    expect(result.stats.fetched).toBe(2);
    expect(result.stats.dropped).toBe(2);
    expect(result.recoverySince).toEqual(recoverySince);

    // Critical: backfill must NEVER advance the cron cursor or stamp
    // last_synced_at. Both functions are invariant against backfill.
    expect(hoisted.mockAdvanceSyncState).not.toHaveBeenCalled();
    expect(hoisted.mockRecordSyncFailure).not.toHaveBeenCalled();

    // Must NOT call listHistory — backfill is anchored by date, not cursor.
    expect(hoisted.mockListHistory).not.toHaveBeenCalled();

    // Date-bounded query format check.
    expect(hoisted.mockListMessages.mock.calls[0][1]).toMatchObject({
      query: 'in:inbox after:2026/04/22',
    });

    // sync_logs entry stamped with sync_method='BACKFILL'.
    expect(hoisted.mockInsertSyncLog).toHaveBeenCalledTimes(1);
    expect(hoisted.mockInsertSyncLog.mock.calls[0][0]).toMatchObject({
      syncMethod: 'BACKFILL',
      emailsFetched: 2,
      emailsDropped: 2,
      pagesFetched: 1,
      stoppedEarly: false,
      recoverySince,
    });
  });

  it('returns complete=false when paginated past BACKFILL_MAX_PAGES (20)', async () => {
    // 21 pages all set nextPageToken — must stop at 20.
    for (let i = 0; i < 21; i++) {
      hoisted.mockListMessages.mockResolvedValueOnce({
        messageIds: [],
        nextPageToken: 'keep-going',
        resultSizeEstimate: 0,
      });
    }
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runBackfill } = await import('./sync');
    const result = await runBackfill({
      recoverySince: new Date('2026-04-22T00:00:00Z'),
      gmailClient: { __brand: 'gmail' } as never,
    });

    expect(hoisted.mockListMessages).toHaveBeenCalledTimes(20);
    expect(result.complete).toBe(false);
    expect(result.pagesFetched).toBe(20);
  });

  it('throws SyncInProgressError when lock is busy', async () => {
    hoisted.mockTryAcquireSyncLock.mockResolvedValueOnce(false);
    const { runBackfill, SyncInProgressError } = await import('./sync');
    await expect(
      runBackfill({
        recoverySince: new Date('2026-04-22T00:00:00Z'),
        gmailClient: { __brand: 'gmail' } as never,
      }),
    ).rejects.toBeInstanceOf(SyncInProgressError);
    // Failed acquire → no release.
    expect(hoisted.mockReleaseSyncLock).not.toHaveBeenCalled();
  });

  it('releases lock + writes sync_logs even when processing throws', async () => {
    hoisted.mockListMessages.mockRejectedValueOnce(new Error('boom-from-gmail'));
    const { runBackfill } = await import('./sync');
    await expect(
      runBackfill({
        recoverySince: new Date('2026-04-22T00:00:00Z'),
        gmailClient: { __brand: 'gmail' } as never,
      }),
    ).rejects.toThrow(/boom-from-gmail/);
    expect(hoisted.mockReleaseSyncLock).toHaveBeenCalledTimes(1);
    expect(hoisted.mockInsertSyncLog).toHaveBeenCalledTimes(1);
    expect(hoisted.mockInsertSyncLog.mock.calls[0][0]).toMatchObject({
      syncMethod: 'BACKFILL',
      errorMessage: expect.stringMatching(/boom-from-gmail/),
    });
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

/* ============================================================================
 * PR-11: HTML extractor wire
 *
 * Verifies sync.ts:
 *   - Calls extractApple(parsed.bodyHtml) iff sender resolves to apple.
 *   - Threads extracted_payload into both the classifier EmailInput and
 *     the email_messages INSERT row.
 *   - Fires Sentry warning when the extractor surfaces UNKNOWN headings
 *     (early-warning signal that Apple changed the template).
 *   - Persists `null` for non-Apple senders + DROPPED-pre-resolution.
 * ========================================================================== */

describe('runSync — HTML extractor wire (PR-11)', () => {
  /** Helper: prime the mocks for a single Apple-sender CLASSIFIED message. */
  function primeApple(msgId: string) {
    mockHistoryDelta([msgId], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: msgId, threadId: 't1' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(
      mockParsedEmail({
        messageId: msgId,
        bodyHtml: '<html><body>apple html</body></html>',
      }),
    );
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
      extracted_app_name: 'X',
      matched_rules: [],
    });
  }

  it('calls extractApple with parsed.bodyHtml + subject when sender is Apple', async () => {
    primeApple('m1');
    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockExtractApple).toHaveBeenCalledTimes(1);
    // PR-12: subject threaded so the extractor can detect rejection
    // template ("There's an issue with..."). `mockParsedEmail` defaults
    // subject to 'subj'.
    expect(hoisted.mockExtractApple).toHaveBeenCalledWith(
      '<html><body>apple html</body></html>',
      'subj',
    );
  });

  it('threads extracted_payload into classifier EmailInput', async () => {
    const payload = {
      outcome: 'ACCEPTED' as const,
      items: [
        {
          type: 'APP_VERSION' as const,
          raw_heading: 'App Version',
          raw_body: '1.0.13 for iOS',
          version: '1.0.13',
          platform: 'iOS',
        },
      ],
    };
    primeApple('m1');
    hoisted.mockExtractApple.mockReturnValueOnce(payload);

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockClassify).toHaveBeenCalledTimes(1);
    const classifierInput = hoisted.mockClassify.mock.calls[0][0];
    expect(classifierInput.extracted_payload).toEqual(payload);
  });

  it('persists extracted_payload on email_messages INSERT', async () => {
    const payload = { outcome: null, items: [] };
    primeApple('m1');
    hoisted.mockExtractApple.mockReturnValueOnce(payload);

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockInsert).toHaveBeenCalledTimes(1);
    const insertRow = hoisted.mockInsert.mock.calls[0][0];
    expect(insertRow.extracted_payload).toEqual(payload);
  });

  it('fires Sentry warning when extractor surfaces UNKNOWN heading', async () => {
    primeApple('m1');
    hoisted.mockExtractApple.mockReturnValueOnce({
      outcome: 'ACCEPTED' as const,
      items: [
        {
          type: 'UNKNOWN' as const,
          raw_heading: 'Future Apple Type',
          raw_body: 'some new payload',
        },
      ],
    });

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockSentryCaptureMessage).toHaveBeenCalledTimes(1);
    const [message, context] =
      hoisted.mockSentryCaptureMessage.mock.calls[0];
    expect(message).toMatch(/Future Apple Type/);
    expect(context.level).toBe('warning');
    expect(context.tags.component).toBe('html-extractor');
    expect(context.tags.gmail_msg_id).toBe('m1');
  });

  it('does not alert Sentry when items is empty', async () => {
    primeApple('m1');
    // Default mockReturnValue is { outcome: null, items: [] } — no override needed.
    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockSentryCaptureMessage).not.toHaveBeenCalled();
  });

  it('does not alert Sentry when only known types are present', async () => {
    primeApple('m1');
    hoisted.mockExtractApple.mockReturnValueOnce({
      outcome: 'ACCEPTED' as const,
      items: [
        {
          type: 'APP_VERSION' as const,
          raw_heading: 'App Version',
          raw_body: '2.0.0 for iOS',
          version: '2.0.0',
          platform: 'iOS',
        },
      ],
    });

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockSentryCaptureMessage).not.toHaveBeenCalled();
  });

  it('does not run extractor for non-Apple platforms', async () => {
    mockHistoryDelta(['m1'], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm1', threadId: 't1' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(mockParsedEmail());
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => ({
      platformId: 'google-uuid',
      platformKey: 'google',
    }));
    hoisted.mockGetRulesSnapshot.mockResolvedValueOnce({
      platform_id: 'google-uuid',
      platform_key: 'google',
      senders: [],
      subject_patterns: [],
      types: [],
      submission_id_patterns: [],
      apps_with_aliases: [],
    });
    hoisted.mockClassify.mockReturnValueOnce({
      status: 'CLASSIFIED',
      platform_id: 'google-uuid',
      app_id: 'app-1',
      type_id: 'type-1',
      outcome: 'APPROVED',
      type_payload: {},
      submission_id: null,
      extracted_app_name: 'X',
      matched_rules: [],
    });

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockExtractApple).not.toHaveBeenCalled();

    // INSERT row: extracted_payload null (not the empty-array signal —
    // null means extraction was not attempted for this platform).
    const insertRow = hoisted.mockInsert.mock.calls[0][0];
    expect(insertRow.extracted_payload).toBeNull();

    // Classifier input also receives null (typed as nullable).
    const classifierInput = hoisted.mockClassify.mock.calls[0][0];
    expect(classifierInput.extracted_payload).toBeNull();
  });

  it('skips extractor on NO_SENDER_MATCH and persists null', async () => {
    mockHistoryDelta(['m1'], '1100');
    hoisted.mockGetMessage.mockResolvedValueOnce({ id: 'm1', threadId: 't1' });
    hoisted.mockParseGmailMessage.mockReturnValueOnce(
      mockParsedEmail({ fromEmail: 'spam@unknown.com' }),
    );
    hoisted.mockCreateSenderResolver.mockReturnValueOnce(() => null);

    const { runSync } = await import('./sync');
    await runSync({ gmailClient: { __brand: 'gmail' } as never });

    expect(hoisted.mockExtractApple).not.toHaveBeenCalled();
    const insertRow = hoisted.mockInsert.mock.calls[0][0];
    expect(insertRow.extracted_payload).toBeNull();
  });
});
