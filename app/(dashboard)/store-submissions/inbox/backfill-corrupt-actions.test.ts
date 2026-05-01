/**
 * Unit tests for `backfillCorruptPayloadAction` (PR-14.4).
 *
 * Strategy: mock at the action's collaborators — auth, the shared
 * backfill core (`backfillOne` + filter loaders + Gmail-client factory),
 * the Supabase chain, Sentry. Tests verify orchestration only:
 *   - role gate (MANAGER required)
 *   - candidate filter shape (.or regex + Apple-only sender + non-DROPPED)
 *   - per-row pipeline call ordering (load → backfillOne)
 *   - continue-on-error semantics
 *   - aggregate stats accuracy
 *
 * The per-row pipeline (`backfillOne`) is owned by
 * `lib/store-submissions/backfill/core.ts` and exercised through the
 * existing `backfill-actions.test.ts`. We mock it here to a deterministic
 * resolved/rejected value and stay focused on the corrupt-payload
 * orchestration above it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetServerSession,
  mockRevalidatePath,
  mockRequireStoreRole,
  mockLoadAppleSenderFilter,
  mockCreateBackfillGmailClient,
  mockBackfillOne,
  mockFrom,
  mockSentryCaptureException,
  mockSentryAddBreadcrumb,
  mockSentrySetUser,
  mockSentrySetTag,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockRequireStoreRole: vi.fn(),
  mockLoadAppleSenderFilter: vi.fn(),
  mockCreateBackfillGmailClient: vi.fn(),
  mockBackfillOne: vi.fn(),
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

vi.mock('@/lib/store-submissions/backfill/core', async () => {
  // Preserve real error classes (action code uses instanceof checks
  // through the shared `mapErrorToActionError`, which we don't mock).
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/backfill/core')
  >('@/lib/store-submissions/backfill/core');
  return {
    ...actual,
    loadAppleSenderFilter: mockLoadAppleSenderFilter,
    createBackfillGmailClient: mockCreateBackfillGmailClient,
    backfillOne: mockBackfillOne,
  };
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
import { NotApplePlatformError } from '@/lib/store-submissions/backfill/core';
import { backfillCorruptPayloadAction } from './backfill-corrupt-actions';

const EMAIL_1 = '11111111-1111-4111-8111-111111111111';
const EMAIL_2 = '22222222-2222-4222-8222-222222222222';
const EMAIL_3 = '33333333-3333-4333-8333-333333333333';
const APPLE_SENDER_1 = 'no-reply@apple.com';
const APPLE_SENDER_2 = 'no_reply@email.apple.com';

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
 * Thenable Supabase-style query builder. All chain methods return the
 * builder; awaiting any chain step resolves to `{ data, error }`.
 */
function makeQueryBuilder(result: {
  data?: unknown;
  error?: { message: string } | null;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {};
  for (const method of [
    'select',
    'or',
    'eq',
    'in',
    'is',
    'not',
    'order',
    'limit',
  ]) {
    builder[method] = vi.fn().mockReturnValue(builder);
  }
  builder.then = (
    onFulfilled: (v: { data?: unknown; error: unknown }) => unknown,
  ) => Promise.resolve({ data: result.data, error: result.error ?? null }).then(onFulfilled);
  return builder;
}

function primeAppleFilter() {
  mockLoadAppleSenderFilter.mockResolvedValue({
    isAppleSender: (email: string) =>
      email === APPLE_SENDER_1 || email === APPLE_SENDER_2,
    appleEmails: [APPLE_SENDER_1, APPLE_SENDER_2],
  });
}

function primeGmailClient() {
  mockCreateBackfillGmailClient.mockResolvedValue({
    client: { __brand: 'gmail-client' },
  });
}

function primeBackfillSuccess() {
  mockBackfillOne.mockImplementation(async (emailId: string) => ({
    emailMessageId: emailId,
    outcome: 'ACCEPTED' as const,
    itemsCount: 1,
    reclassify: {
      emailMessageId: emailId,
      changed: true,
      previousStatus: 'CLASSIFIED',
      newStatus: 'CLASSIFIED',
      previousTicketId: 'old',
      newTicketId: 'new',
    },
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  primeAppleFilter();
  primeGmailClient();
  primeBackfillSuccess();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// 1. MANAGER single corrupt row — happy path
// ============================================================================

describe('backfillCorruptPayloadAction — single corrupt row', () => {
  it('runs the per-row pipeline and returns aggregated stats', async () => {
    setSessionManager();

    const candidatesBuilder = makeQueryBuilder({
      data: [{ id: EMAIL_1 }],
      error: null,
    });
    mockFrom.mockReturnValueOnce(candidatesBuilder);

    const result = await backfillCorruptPayloadAction({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      total: 1,
      processed: 1,
      reclassified: 1,
      unchanged: 0,
      errors: [],
    });

    // Candidate filter shape: control-byte regex .or() + Apple-only sender +
    // non-NULL payload + non-DROPPED status.
    expect(candidatesBuilder.or).toHaveBeenCalledTimes(1);
    const orArg = (candidatesBuilder.or.mock.calls[0] as unknown[])[0] as string;
    expect(orArg).toMatch(/extracted_payload->>app_name\.match\./);
    expect(orArg).toMatch(/raw_body_text\.match\./);
    expect(orArg).toMatch(/\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F/);

    // .not() and .in() applied
    const notCalls = candidatesBuilder.not.mock.calls;
    expect(notCalls).toContainEqual(['extracted_payload', 'is', null]);
    expect(notCalls).toContainEqual(['classification_status', 'eq', 'DROPPED']);
    expect(candidatesBuilder.in).toHaveBeenCalledWith('sender_email', [
      APPLE_SENDER_1,
      APPLE_SENDER_2,
    ]);

    expect(mockBackfillOne).toHaveBeenCalledWith(
      EMAIL_1,
      'user-mgr',
      expect.objectContaining({
        gmailClient: expect.objectContaining({ __brand: 'gmail-client' }),
        isAppleSender: expect.any(Function),
      }),
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      '/store-submissions/inbox',
    );
  });
});

// ============================================================================
// 2. MANAGER bulk 3 corrupt rows — aggregate stats
// ============================================================================

describe('backfillCorruptPayloadAction — bulk happy path', () => {
  it('processes 3 candidates sequentially and aggregates stats', async () => {
    setSessionManager();

    const candidatesBuilder = makeQueryBuilder({
      data: [{ id: EMAIL_1 }, { id: EMAIL_2 }, { id: EMAIL_3 }],
      error: null,
    });
    mockFrom.mockReturnValueOnce(candidatesBuilder);

    const result = await backfillCorruptPayloadAction({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      total: 3,
      processed: 3,
      reclassified: 3,
      unchanged: 0,
      errors: [],
    });
    expect(mockBackfillOne).toHaveBeenCalledTimes(3);
    expect(mockBackfillOne).toHaveBeenNthCalledWith(
      1,
      EMAIL_1,
      'user-mgr',
      expect.anything(),
    );
    expect(mockBackfillOne).toHaveBeenNthCalledWith(
      2,
      EMAIL_2,
      'user-mgr',
      expect.anything(),
    );
    expect(mockBackfillOne).toHaveBeenNthCalledWith(
      3,
      EMAIL_3,
      'user-mgr',
      expect.anything(),
    );
  });
});

// ============================================================================
// 3. VIEWER blocked — FORBIDDEN with no side effects
// ============================================================================

describe('backfillCorruptPayloadAction — VIEWER blocked', () => {
  it('returns FORBIDDEN without touching DB / Gmail / pipeline', async () => {
    setSessionViewer();

    const result = await backfillCorruptPayloadAction({});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FORBIDDEN');

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockCreateBackfillGmailClient).not.toHaveBeenCalled();
    expect(mockBackfillOne).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 4. Apple-only filter — non-Apple row in batch errored, batch continues
// ============================================================================

describe('backfillCorruptPayloadAction — Apple-only filter respected', () => {
  it('a non-Apple row produces NotApplePlatformError; batch continues', async () => {
    setSessionManager();

    // Candidate query returns 3 IDs; backfillOne throws on the 2nd
    // (simulating a non-Apple row that slipped past the SQL filter,
    // e.g. a sender that re-bound platforms after the page loaded).
    const candidatesBuilder = makeQueryBuilder({
      data: [{ id: EMAIL_1 }, { id: EMAIL_2 }, { id: EMAIL_3 }],
      error: null,
    });
    mockFrom.mockReturnValueOnce(candidatesBuilder);

    mockBackfillOne
      .mockResolvedValueOnce({
        emailMessageId: EMAIL_1,
        outcome: 'ACCEPTED' as const,
        itemsCount: 1,
        reclassify: {
          emailMessageId: EMAIL_1,
          changed: true,
          previousStatus: 'CLASSIFIED',
          newStatus: 'CLASSIFIED',
          previousTicketId: 'old',
          newTicketId: 'new',
        },
      })
      .mockRejectedValueOnce(new NotApplePlatformError(EMAIL_2))
      .mockResolvedValueOnce({
        emailMessageId: EMAIL_3,
        outcome: 'ACCEPTED' as const,
        itemsCount: 1,
        reclassify: {
          emailMessageId: EMAIL_3,
          changed: true,
          previousStatus: 'CLASSIFIED',
          newStatus: 'CLASSIFIED',
          previousTicketId: 'old',
          newTicketId: 'new',
        },
      });

    const result = await backfillCorruptPayloadAction({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBe(3);
    expect(result.data.processed).toBe(2);
    expect(result.data.reclassified).toBe(2);
    expect(result.data.errors).toHaveLength(1);
    expect(result.data.errors[0].emailMessageId).toBe(EMAIL_2);
    expect(result.data.errors[0].error).toMatch(/not from an Apple sender/);

    // Sentry telemetry includes the corrupt-payload variant tag.
    const tags = mockSentryCaptureException.mock.calls.map(
      (c) => (c[1] as { tags?: Record<string, string> } | undefined)?.tags,
    );
    expect(tags).toContainEqual(
      expect.objectContaining({
        component: 'backfill-action',
        variant: 'corrupt-payload',
        stage: 'bulk-row',
      }),
    );
  });
});

// ============================================================================
// 5. Empty result — no candidates, graceful zero-row OK
// ============================================================================

describe('backfillCorruptPayloadAction — empty result', () => {
  it('returns zeroed stats with no Gmail / pipeline calls', async () => {
    setSessionManager();
    mockFrom.mockReturnValueOnce(makeQueryBuilder({ data: [], error: null }));

    const result = await backfillCorruptPayloadAction({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      total: 0,
      processed: 0,
      reclassified: 0,
      unchanged: 0,
      errors: [],
    });
    expect(mockCreateBackfillGmailClient).not.toHaveBeenCalled();
    expect(mockBackfillOne).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
