/**
 * Unit tests for backfill Server Actions (PR-12.6).
 *
 * Strategy mirrors `reclassify-actions.test.ts`: mock everything below
 * the action layer — auth, DB chain, Gmail client + parser, extractor,
 * the reclassify core helper, Sentry. Tests assert action-level
 * behavior:
 *   - role gating (MANAGER required)
 *   - Apple-sender filter applied at SQL layer
 *   - per-row pipeline ordering (load → fetch → extract → update →
 *     reclassify)
 *   - continue-on-error semantics (one failure doesn't abort batch)
 *   - aggregate stats accuracy
 *
 * Reclassify core's correctness is covered by `reclassify-actions.test.ts`
 * and integration tests; here we mock `reclassifyOne` to a deterministic
 * resolved/rejected value and focus on the orchestration above it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetServerSession,
  mockRevalidatePath,
  mockRequireStoreRole,
  mockLoadActiveSenders,
  mockCreateSenderResolver,
  mockCreateGmailClient,
  mockGetMessage,
  mockParseGmailMessage,
  mockExtractApple,
  mockReclassifyOne,
  mockFrom,
  mockSentryCaptureException,
  mockSentryAddBreadcrumb,
  mockSentrySetUser,
  mockSentrySetTag,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockRequireStoreRole: vi.fn(),
  mockLoadActiveSenders: vi.fn(),
  mockCreateSenderResolver: vi.fn(),
  mockCreateGmailClient: vi.fn(),
  mockGetMessage: vi.fn(),
  mockParseGmailMessage: vi.fn(),
  mockExtractApple: vi.fn(),
  mockReclassifyOne: vi.fn(),
  mockFrom: vi.fn(),
  mockSentryCaptureException: vi.fn(),
  mockSentryAddBreadcrumb: vi.fn(),
  mockSentrySetUser: vi.fn(),
  mockSentrySetTag: vi.fn(),
}));

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }));
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/store-submissions/auth', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/auth')
  >('@/lib/store-submissions/auth');
  return { ...actual, requireStoreRole: mockRequireStoreRole };
});

vi.mock('@/lib/store-submissions/gmail/sender-resolver', () => ({
  loadActiveSenders: mockLoadActiveSenders,
  createSenderResolver: mockCreateSenderResolver,
}));

vi.mock('@/lib/store-submissions/gmail/client', () => ({
  createGmailClient: mockCreateGmailClient,
  getMessage: mockGetMessage,
}));

vi.mock('@/lib/store-submissions/gmail/parser', () => ({
  parseGmailMessage: mockParseGmailMessage,
}));

vi.mock('@/lib/store-submissions/gmail/html-extractor', () => ({
  extractApple: mockExtractApple,
}));

vi.mock('@/lib/store-submissions/reclassify/core', async () => {
  // Preserve real error classes (action code uses instanceof checks).
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/reclassify/core')
  >('@/lib/store-submissions/reclassify/core');
  return { ...actual, reclassifyOne: mockReclassifyOne };
});

vi.mock('@/lib/store-submissions/db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: mockSentryCaptureException,
  addBreadcrumb: mockSentryAddBreadcrumb,
  setUser: mockSentrySetUser,
  setTag: mockSentrySetTag,
}));

import { StoreForbiddenError } from '@/lib/store-submissions/auth';
import {
  backfillSingleEmailAction,
  backfillUnclassifiedAction,
} from './backfill-actions';

const EMAIL_1 = '11111111-1111-4111-8111-111111111111';
const EMAIL_2 = '22222222-2222-4222-8222-222222222222';
const EMAIL_3 = '33333333-3333-4333-8333-333333333333';
const APPLE_PLATFORM_ID = 'apple-uuid';
const APPLE_SENDER_1 = 'no-reply@apple.com';
const APPLE_SENDER_2 = 'no_reply@email.apple.com';
const GOOGLE_SENDER_1 = 'noreply-play@google.com';

// -- Helpers ---------------------------------------------------------------

function setSessionManager() {
  mockGetServerSession.mockResolvedValue({
    user: { email: 'mgr@company.com' },
  });
  mockRequireStoreRole.mockResolvedValue({
    id: 'user-mgr',
    email: 'mgr@company.com',
    role: 'MANAGER',
    display_name: 'Mgr',
    avatar_url: null,
    status: 'active',
  });
}

function setSessionViewer() {
  mockGetServerSession.mockResolvedValue({
    user: { email: 'viewer@company.com' },
  });
  mockRequireStoreRole.mockRejectedValue(
    new StoreForbiddenError('Required role: MANAGER. Current role: VIEWER.'),
  );
}

/**
 * Build a thenable Supabase-style query builder. All chain methods
 * return the builder itself; awaiting any chain step (or `.maybeSingle()`)
 * resolves to the configured `{ data, error }`.
 */
function makeQueryBuilder(result: {
  data?: unknown;
  error?: { message: string } | null;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {};
  for (const method of [
    'select',
    'eq',
    'in',
    'is',
    'order',
    'limit',
    'update',
    'maybeSingle',
  ]) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }
  builder.then = (
    onFulfilled: (v: { data?: unknown; error: unknown }) => unknown,
  ) => Promise.resolve({ data: result.data, error: result.error ?? null }).then(onFulfilled);
  return builder;
}

/** Default Apple resolver: any email → Apple platform. */
function primeAppleSenders() {
  mockLoadActiveSenders.mockResolvedValue([
    {
      email: APPLE_SENDER_1,
      platformId: APPLE_PLATFORM_ID,
      platformKey: 'apple',
    },
    {
      email: APPLE_SENDER_2,
      platformId: APPLE_PLATFORM_ID,
      platformKey: 'apple',
    },
  ]);
  mockCreateSenderResolver.mockReturnValue((email: string) => {
    if (email === APPLE_SENDER_1 || email === APPLE_SENDER_2) {
      return { platformId: APPLE_PLATFORM_ID, platformKey: 'apple' };
    }
    return null;
  });
}

/** Default Gmail client (opaque mock object). */
function primeGmailClient() {
  mockCreateGmailClient.mockResolvedValue({ __brand: 'gmail-client' });
}

/** Default extractor + parser + reclassify success path. */
function primeHappyPipeline() {
  mockGetMessage.mockResolvedValue({ id: 'm', threadId: 't' });
  mockParseGmailMessage.mockReturnValue({
    messageId: 'm',
    threadId: 't',
    fromEmail: APPLE_SENDER_1,
    subject: "There's an issue with your X submission",
    body: 'Submission ID: ...',
    bodyHtml: '<html>...</html>',
    receivedAt: new Date('2026-04-25T00:00:00Z'),
    to: ['team@x.com'],
    labels: ['INBOX'],
  });
  mockExtractApple.mockReturnValue({
    outcome: 'REJECTED',
    items: [
      {
        type: 'APP_VERSION',
        raw_heading: 'App Version',
        raw_body: '1.0.0 for iOS',
        version: '1.0.0',
        platform: 'iOS',
      },
    ],
  });
  mockReclassifyOne.mockResolvedValue({
    emailMessageId: 'placeholder',
    changed: true,
    previousStatus: 'UNCLASSIFIED_TYPE',
    newStatus: 'CLASSIFIED',
    previousTicketId: 'old-ticket',
    newTicketId: 'new-ticket',
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  primeAppleSenders();
  primeGmailClient();
  primeHappyPipeline();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// 1. Single backfill — happy path
// ============================================================================

describe('backfillSingleEmailAction — happy path', () => {
  it('runs full pipeline and returns BackfillResult.ok', async () => {
    setSessionManager();

    // Two .from() calls: row load (maybeSingle) + UPDATE (eq terminal).
    const loadBuilder = makeQueryBuilder({
      data: {
        id: EMAIL_1,
        gmail_msg_id: 'gmail-abc',
        sender_email: APPLE_SENDER_1,
      },
      error: null,
    });
    const updateBuilder = makeQueryBuilder({ data: null, error: null });
    mockFrom
      .mockReturnValueOnce(loadBuilder)
      .mockReturnValueOnce(updateBuilder);

    const result = await backfillSingleEmailAction(EMAIL_1);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.emailMessageId).toBe(EMAIL_1);
    expect(result.data.outcome).toBe('REJECTED');
    expect(result.data.itemsCount).toBe(1);
    expect(result.data.reclassify.changed).toBe(true);
    expect(result.data.reclassify.newStatus).toBe('CLASSIFIED');

    // Pipeline assertions: each leaf called exactly once + with right args.
    expect(mockCreateGmailClient).toHaveBeenCalledTimes(1);
    expect(mockGetMessage).toHaveBeenCalledWith(
      expect.objectContaining({ __brand: 'gmail-client' }),
      'gmail-abc',
    );
    expect(mockExtractApple).toHaveBeenCalledWith(
      '<html>...</html>',
      "There's an issue with your X submission",
    );
    // UPDATE chain receives the freshly-extracted payload.
    expect(updateBuilder.update).toHaveBeenCalledWith({
      extracted_payload: {
        outcome: 'REJECTED',
        items: expect.arrayContaining([
          expect.objectContaining({ type: 'APP_VERSION' }),
        ]),
      },
    });
    expect(mockReclassifyOne).toHaveBeenCalledWith(EMAIL_1, 'user-mgr');
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      '/store-submissions/inbox',
    );
  });
});

// ============================================================================
// 2. Bulk backfill — happy path
// ============================================================================

describe('backfillUnclassifiedAction — happy path', () => {
  it('processes 3 candidates sequentially and aggregates stats', async () => {
    setSessionManager();

    const candidatesBuilder = makeQueryBuilder({
      data: [{ id: EMAIL_1 }, { id: EMAIL_2 }, { id: EMAIL_3 }],
      error: null,
    });
    // Per-row: load + update each. 3 rows × 2 calls = 6 builders after candidates.
    const perRow = (id: string) => [
      makeQueryBuilder({
        data: { id, gmail_msg_id: `gmail-${id}`, sender_email: APPLE_SENDER_1 },
        error: null,
      }),
      makeQueryBuilder({ data: null, error: null }),
    ];
    mockFrom
      .mockReturnValueOnce(candidatesBuilder)
      .mockReturnValueOnce(perRow(EMAIL_1)[0])
      .mockReturnValueOnce(perRow(EMAIL_1)[1])
      .mockReturnValueOnce(perRow(EMAIL_2)[0])
      .mockReturnValueOnce(perRow(EMAIL_2)[1])
      .mockReturnValueOnce(perRow(EMAIL_3)[0])
      .mockReturnValueOnce(perRow(EMAIL_3)[1]);

    const result = await backfillUnclassifiedAction({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      total: 3,
      processed: 3,
      reclassified: 3,
      unchanged: 0,
      errors: [],
    });
    expect(mockReclassifyOne).toHaveBeenCalledTimes(3);
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
  });

  it('returns empty stats when no candidates match', async () => {
    setSessionManager();
    mockFrom.mockReturnValueOnce(makeQueryBuilder({ data: [], error: null }));

    const result = await backfillUnclassifiedAction({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      total: 0,
      processed: 0,
      reclassified: 0,
      unchanged: 0,
      errors: [],
    });
    // No Gmail work when there's nothing to process.
    expect(mockCreateGmailClient).not.toHaveBeenCalled();
    expect(mockReclassifyOne).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 3. Role gate — VIEWER blocked on both actions
// ============================================================================

describe('Role gate — VIEWER blocked', () => {
  it('backfillSingleEmailAction returns FORBIDDEN without touching Gmail/RPC', async () => {
    setSessionViewer();

    const result = await backfillSingleEmailAction(EMAIL_1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FORBIDDEN');
    // Critical: gate fires before any pipeline work.
    expect(mockCreateGmailClient).not.toHaveBeenCalled();
    expect(mockGetMessage).not.toHaveBeenCalled();
    expect(mockExtractApple).not.toHaveBeenCalled();
    expect(mockReclassifyOne).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('backfillUnclassifiedAction returns FORBIDDEN without candidate fetch', async () => {
    setSessionViewer();

    const result = await backfillUnclassifiedAction({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FORBIDDEN');
    expect(mockCreateGmailClient).not.toHaveBeenCalled();
    expect(mockReclassifyOne).not.toHaveBeenCalled();
    // SQL candidate query also gated — no .from() before auth passes.
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 4. Per-row error resilience — Gmail fetch failure on row 2 of 3
// ============================================================================

describe('backfillUnclassifiedAction — per-row error resilience', () => {
  it('continues batch when one row fails Gmail fetch', async () => {
    setSessionManager();

    const candidatesBuilder = makeQueryBuilder({
      data: [{ id: EMAIL_1 }, { id: EMAIL_2 }, { id: EMAIL_3 }],
      error: null,
    });
    const loadBuilder = (id: string) =>
      makeQueryBuilder({
        data: { id, gmail_msg_id: `gmail-${id}`, sender_email: APPLE_SENDER_1 },
        error: null,
      });
    const updateBuilder = () =>
      makeQueryBuilder({ data: null, error: null });
    // Row 2's UPDATE never fires (fetch fails before update).
    mockFrom
      .mockReturnValueOnce(candidatesBuilder)
      .mockReturnValueOnce(loadBuilder(EMAIL_1))
      .mockReturnValueOnce(updateBuilder())
      .mockReturnValueOnce(loadBuilder(EMAIL_2)) // load OK
      .mockReturnValueOnce(loadBuilder(EMAIL_3))
      .mockReturnValueOnce(updateBuilder());

    // getMessage throws on the 2nd call.
    mockGetMessage
      .mockResolvedValueOnce({ id: 'm1', threadId: 't1' })
      .mockRejectedValueOnce(new Error('Gmail 503'))
      .mockResolvedValueOnce({ id: 'm3', threadId: 't3' });

    const result = await backfillUnclassifiedAction({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(3);
    expect(result.data.processed).toBe(2);
    expect(result.data.reclassified).toBe(2);
    expect(result.data.errors).toHaveLength(1);
    expect(result.data.errors[0].emailMessageId).toBe(EMAIL_2);
    expect(result.data.errors[0].error).toMatch(/Gmail 503/);

    // Reclassify only ran for the 2 successful rows.
    expect(mockReclassifyOne).toHaveBeenCalledTimes(2);

    // Sentry telemetry: gmail-fetch stage capture + bulk-row stage capture
    // (action wraps + re-captures for stage tagging).
    const stages = mockSentryCaptureException.mock.calls.map(
      (c) => (c[1] as { tags?: { stage?: string } } | undefined)?.tags?.stage,
    );
    expect(stages).toContain('gmail-fetch');
    expect(stages).toContain('bulk-row');
  });
});

// ============================================================================
// 5. Apple-only filter — SQL .in() argument
// ============================================================================

describe('backfillUnclassifiedAction — Apple-only filter', () => {
  it('passes only Apple sender emails to the SQL .in() filter', async () => {
    setSessionManager();
    // Mixed sender registry: 2 Apple + 1 Google.
    mockLoadActiveSenders.mockResolvedValue([
      {
        email: APPLE_SENDER_1,
        platformId: APPLE_PLATFORM_ID,
        platformKey: 'apple',
      },
      {
        email: APPLE_SENDER_2,
        platformId: APPLE_PLATFORM_ID,
        platformKey: 'apple',
      },
      {
        email: GOOGLE_SENDER_1,
        platformId: 'google-uuid',
        platformKey: 'google',
      },
    ]);
    mockCreateSenderResolver.mockReturnValue((email: string) => {
      if (email === APPLE_SENDER_1 || email === APPLE_SENDER_2) {
        return { platformId: APPLE_PLATFORM_ID, platformKey: 'apple' };
      }
      if (email === GOOGLE_SENDER_1) {
        return { platformId: 'google-uuid', platformKey: 'google' };
      }
      return null;
    });

    const candidatesBuilder = makeQueryBuilder({ data: [], error: null });
    mockFrom.mockReturnValueOnce(candidatesBuilder);

    await backfillUnclassifiedAction({});

    // First .in() call: classification_status filter.
    // Second .in() call: sender_email filter — must be Apple-only.
    const inCalls = candidatesBuilder.in.mock.calls;
    expect(inCalls).toHaveLength(2);
    expect(inCalls[0][0]).toBe('classification_status');
    expect(inCalls[1][0]).toBe('sender_email');
    expect(inCalls[1][1]).toEqual([APPLE_SENDER_1, APPLE_SENDER_2]);
    // Google sender must not appear.
    expect(inCalls[1][1]).not.toContain(GOOGLE_SENDER_1);
  });

  it('returns empty stats when no Apple senders are configured', async () => {
    setSessionManager();
    mockLoadActiveSenders.mockResolvedValue([
      {
        email: GOOGLE_SENDER_1,
        platformId: 'google-uuid',
        platformKey: 'google',
      },
    ]);
    mockCreateSenderResolver.mockReturnValue(() => ({
      platformId: 'google-uuid',
      platformKey: 'google',
    }));

    const result = await backfillUnclassifiedAction({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(0);
    // No SQL candidate fetch when Apple filter is empty (early return).
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
