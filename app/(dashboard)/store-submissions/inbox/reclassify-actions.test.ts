/**
 * Unit tests for reclassify Server Actions (PR-11.5).
 *
 * Strategy: mock everything below the action — auth, DB, classifier,
 * RPC. Tests assert action-level behavior: role gating, error mapping,
 * RPC argument shape, bulk aggregation. The RPC's own correctness is
 * covered by integration tests against migration-applied schema.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetServerSession,
  mockRevalidatePath,
  mockRequireStoreRole,
  mockClassify,
  mockLoadActiveSenders,
  mockCreateSenderResolver,
  mockGetRulesSnapshot,
  mockFrom,
  mockSelect,
  mockEq,
  mockIn,
  mockMaybeSingle,
  mockRpc,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockRequireStoreRole: vi.fn(),
  mockClassify: vi.fn(),
  mockLoadActiveSenders: vi.fn(),
  mockCreateSenderResolver: vi.fn(),
  mockGetRulesSnapshot: vi.fn(),
  mockFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockEq: vi.fn(),
  mockIn: vi.fn(),
  mockMaybeSingle: vi.fn(),
  mockRpc: vi.fn(),
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

vi.mock('@/lib/store-submissions/classifier', () => ({
  classify: mockClassify,
}));

vi.mock('@/lib/store-submissions/gmail/sender-resolver', () => ({
  loadActiveSenders: mockLoadActiveSenders,
  createSenderResolver: mockCreateSenderResolver,
}));

vi.mock('@/lib/store-submissions/queries/rules', () => ({
  getRulesSnapshotForPlatform: mockGetRulesSnapshot,
}));

vi.mock('@/lib/store-submissions/gmail/sync', () => ({
  CLASSIFIER_VERSION: '1.0',
}));

vi.mock('@/lib/store-submissions/db', () => ({
  storeDb: () => ({ from: mockFrom, rpc: mockRpc }),
}));

import { StoreForbiddenError, StoreUnauthorizedError } from '@/lib/store-submissions/auth';
import {
  reclassifyEmailMessageAction,
  reclassifyUnclassifiedAction,
} from './reclassify-actions';

const EMAIL_ID = '11111111-1111-4111-8111-111111111111';
const APPLE_PLATFORM_ID = '22222222-2222-4222-8222-222222222222';

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

function setSessionDev() {
  mockGetServerSession.mockResolvedValue({
    user: { email: 'dev@company.com' },
  });
  mockRequireStoreRole.mockRejectedValue(
    new StoreForbiddenError('Required role: MANAGER. Current role: DEV.'),
  );
}

function setSessionViewer() {
  mockGetServerSession.mockResolvedValue({
    user: { email: 'viewer@company.com' },
  });
  mockRequireStoreRole.mockRejectedValue(
    new StoreForbiddenError(
      'Required role: MANAGER. Current role: VIEWER.',
    ),
  );
}

function setNoSession() {
  mockGetServerSession.mockResolvedValue(null);
  mockRequireStoreRole.mockRejectedValue(
    new StoreUnauthorizedError('No session'),
  );
}

/** Wire up storeDb chain so .from('email_messages').select(...).eq(...).maybeSingle()
 *  returns the configured row, and .from(...).select(...).in(...) returns
 *  the configured rows[]. */
function primeDbChain(opts: {
  emailRow?: Record<string, unknown> | null;
  bulkRows?: { id: string }[];
}) {
  const chain = {
    select: mockSelect,
    eq: mockEq,
    in: mockIn,
    maybeSingle: mockMaybeSingle,
  };
  mockFrom.mockReturnValue(chain);
  mockSelect.mockReturnValue(chain);
  mockEq.mockReturnValue(chain);
  // .in() returns the bulk rows directly (Promise<{data, error}>)
  mockIn.mockResolvedValue({ data: opts.bulkRows ?? [], error: null });
  // .maybeSingle() returns the single row
  mockMaybeSingle.mockResolvedValue({
    data: opts.emailRow === undefined ? null : opts.emailRow,
    error: null,
  });
}

beforeEach(() => {
  vi.resetAllMocks();

  // Sender resolver default: Apple match.
  mockLoadActiveSenders.mockResolvedValue([]);
  mockCreateSenderResolver.mockReturnValue(() => ({
    platformId: APPLE_PLATFORM_ID,
    platformKey: 'apple',
  }));

  // Rules snapshot default: present (so we don't fall into NO_RULES).
  mockGetRulesSnapshot.mockResolvedValue({
    platform_id: APPLE_PLATFORM_ID,
    platform_key: 'apple',
    senders: [],
    subject_patterns: [],
    types: [],
    submission_id_patterns: [],
    apps_with_aliases: [],
  });

  // Classifier default: returns CLASSIFIED.
  mockClassify.mockReturnValue({
    status: 'CLASSIFIED',
    platform_id: APPLE_PLATFORM_ID,
    app_id: 'app-1',
    type_id: 'type-1',
    outcome: 'APPROVED',
    type_payload: { version: '1.0.0' },
    submission_id: null,
    extracted_app_name: 'Test App',
    matched_rules: [],
  });

  // RPC default: changed=true.
  mockRpc.mockResolvedValue({
    data: {
      changed: true,
      previous_status: 'UNCLASSIFIED_APP',
      new_status: 'CLASSIFIED',
      previous_ticket_id: 'old-ticket-uuid',
      new_ticket_id: 'new-ticket-uuid',
    },
    error: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// reclassifyEmailMessageAction — input validation + auth
// ============================================================================

describe('reclassifyEmailMessageAction — input validation', () => {
  it('rejects empty emailMessageId with VALIDATION error (no auth check)', async () => {
    const result = await reclassifyEmailMessageAction('');
    expect(result).toEqual({
      ok: false,
      error: { code: 'VALIDATION', message: 'emailMessageId is required' },
    });
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });
});

describe('reclassifyEmailMessageAction — auth gating', () => {
  it('rejects no session with UNAUTHORIZED', async () => {
    setNoSession();
    const result = await reclassifyEmailMessageAction(EMAIL_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('rejects DEV role with FORBIDDEN (MANAGER-only feature)', async () => {
    setSessionDev();
    const result = await reclassifyEmailMessageAction(EMAIL_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
      expect(result.error.message).toMatch(/MANAGER/);
    }
    // RPC must not be invoked.
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects VIEWER role with FORBIDDEN', async () => {
    setSessionViewer();
    const result = await reclassifyEmailMessageAction(EMAIL_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ============================================================================
// reclassifyEmailMessageAction — happy paths
// ============================================================================

describe('reclassifyEmailMessageAction — happy paths', () => {
  function primeRow(over: Record<string, unknown> = {}) {
    primeDbChain({
      emailRow: {
        id: EMAIL_ID,
        sender_email: 'no-reply@apple.com',
        subject: 'Review of your X submission is complete.',
        raw_body_text: 'Submission ID: ...',
        extracted_payload: { accepted_items: [] },
        classification_result: { status: 'UNCLASSIFIED_APP' },
        ticket_id: 'old-ticket-uuid',
        ...over,
      },
    });
  }

  it('UNCLASSIFIED_APP → CLASSIFIED: invokes RPC + returns changed result', async () => {
    setSessionManager();
    primeRow();

    const result = await reclassifyEmailMessageAction(EMAIL_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.changed).toBe(true);
      expect(result.data.previousStatus).toBe('UNCLASSIFIED_APP');
      expect(result.data.newStatus).toBe('CLASSIFIED');
      expect(result.data.newTicketId).toBe('new-ticket-uuid');
    }

    // RPC arguments check.
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [rpcName, rpcArgs] = mockRpc.mock.calls[0];
    expect(rpcName).toBe('reclassify_email_tx');
    expect(rpcArgs.p_email_message_id).toBe(EMAIL_ID);
    expect(rpcArgs.p_actor_id).toBe('user-mgr');
    expect(rpcArgs.p_new_classification.classifier_version).toBe('1.0');
    expect(rpcArgs.p_new_classification.status).toBe('CLASSIFIED');

    // Cache revalidated.
    expect(mockRevalidatePath).toHaveBeenCalledWith('/store-submissions/inbox');
  });

  it('returns changed=false when RPC reports no change', async () => {
    setSessionManager();
    primeRow();
    mockRpc.mockResolvedValueOnce({
      data: {
        changed: false,
        previous_status: 'CLASSIFIED',
        new_status: 'CLASSIFIED',
        previous_ticket_id: 'same-ticket',
        new_ticket_id: 'same-ticket',
      },
      error: null,
    });

    const result = await reclassifyEmailMessageAction(EMAIL_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.changed).toBe(false);
      expect(result.data.previousTicketId).toBe('same-ticket');
      expect(result.data.newTicketId).toBe('same-ticket');
    }
  });

  it('Sender no longer registered → DROPPED classification passed to RPC', async () => {
    setSessionManager();
    primeRow();
    mockCreateSenderResolver.mockReturnValueOnce(() => null);

    await reclassifyEmailMessageAction(EMAIL_ID);

    // Classifier must NOT run when sender doesn't resolve.
    expect(mockClassify).not.toHaveBeenCalled();

    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(rpcArgs.p_new_classification.status).toBe('DROPPED');
    expect(rpcArgs.p_new_classification.reason).toBe('NO_SENDER_MATCH');
  });

  it('Platform has no rules → ERROR NO_RULES classification', async () => {
    setSessionManager();
    primeRow();
    mockGetRulesSnapshot.mockResolvedValueOnce(null);

    await reclassifyEmailMessageAction(EMAIL_ID);

    expect(mockClassify).not.toHaveBeenCalled();
    const rpcArgs = mockRpc.mock.calls[0][1];
    expect(rpcArgs.p_new_classification.status).toBe('ERROR');
    expect(rpcArgs.p_new_classification.error_code).toBe('NO_RULES');
  });
});

// ============================================================================
// reclassifyEmailMessageAction — error mapping
// ============================================================================

describe('reclassifyEmailMessageAction — error mapping', () => {
  it('email row missing → NOT_FOUND', async () => {
    setSessionManager();
    primeDbChain({ emailRow: null });

    const result = await reclassifyEmailMessageAction(EMAIL_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
    // RPC must not be invoked when email row is missing.
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('RPC INVALID_ARG → VALIDATION ActionError', async () => {
    setSessionManager();
    primeDbChain({
      emailRow: {
        id: EMAIL_ID,
        sender_email: 'no-reply@apple.com',
        subject: 's',
        raw_body_text: 'b',
        extracted_payload: null,
        classification_result: null,
        ticket_id: null,
      },
    });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'INVALID_ARG: app_id must be UUID' },
    });

    const result = await reclassifyEmailMessageAction(EMAIL_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
  });

  it('unknown DB error → DB_ERROR (and Sentry would capture)', async () => {
    setSessionManager();
    primeDbChain({
      emailRow: {
        id: EMAIL_ID,
        sender_email: 'no-reply@apple.com',
        subject: 's',
        raw_body_text: 'b',
        extracted_payload: null,
        classification_result: null,
        ticket_id: null,
      },
    });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'some unknown postgres error' },
    });

    const result = await reclassifyEmailMessageAction(EMAIL_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });
});

// ============================================================================
// reclassifyUnclassifiedAction — bulk
// ============================================================================

describe('reclassifyUnclassifiedAction — bulk', () => {
  function primeBulkRows(ids: string[]) {
    // Single chain that handles both .in() (bulk fetch) and .eq().maybeSingle()
    // (per-row fetch inside reclassifyOne). Bulk fetch returns ids; per-row
    // fetch returns a synthetic email row matching the id.
    primeDbChain({
      bulkRows: ids.map((id) => ({ id })),
      emailRow: {
        id: 'placeholder',
        sender_email: 'no-reply@apple.com',
        subject: 's',
        raw_body_text: 'b',
        extracted_payload: null,
        classification_result: null,
        ticket_id: null,
      },
    });
  }

  it('rejects invalid bucket with VALIDATION', async () => {
    const result = await reclassifyUnclassifiedAction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'invalid' as any,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'bucket must be app, type, or any',
      },
    });
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  it('VIEWER blocked', async () => {
    setSessionViewer();
    const result = await reclassifyUnclassifiedAction('any');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
  });

  it('empty bucket → total=0, no RPC calls', async () => {
    setSessionManager();
    primeBulkRows([]);

    const result = await reclassifyUnclassifiedAction('any');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        total: 0,
        reclassified: 0,
        unchanged: 0,
        errors: 0,
      });
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('aggregates reclassified/unchanged across rows', async () => {
    setSessionManager();
    primeBulkRows(['e1', 'e2', 'e3']);

    // 3 RPC calls: 2 changed + 1 unchanged.
    mockRpc
      .mockResolvedValueOnce({
        data: {
          changed: true,
          previous_status: 'UNCLASSIFIED_APP',
          new_status: 'CLASSIFIED',
          previous_ticket_id: null,
          new_ticket_id: 'new-1',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          changed: false,
          previous_status: 'UNCLASSIFIED_APP',
          new_status: 'UNCLASSIFIED_APP',
          previous_ticket_id: 'same',
          new_ticket_id: 'same',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          changed: true,
          previous_status: 'UNCLASSIFIED_APP',
          new_status: 'CLASSIFIED',
          previous_ticket_id: null,
          new_ticket_id: 'new-3',
        },
        error: null,
      });

    const result = await reclassifyUnclassifiedAction('any');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        total: 3,
        reclassified: 2,
        unchanged: 1,
        errors: 0,
      });
    }
  });

  it('per-row failure → counted, batch continues', async () => {
    setSessionManager();
    primeBulkRows(['e1', 'e2']);

    // First row fails at RPC; second succeeds.
    mockRpc
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'unexpected DB outage' },
      })
      .mockResolvedValueOnce({
        data: {
          changed: true,
          previous_status: 'UNCLASSIFIED_APP',
          new_status: 'CLASSIFIED',
          previous_ticket_id: null,
          new_ticket_id: 'new-2',
        },
        error: null,
      });

    const result = await reclassifyUnclassifiedAction('any');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        total: 2,
        reclassified: 1,
        unchanged: 0,
        errors: 1,
      });
    }
  });

  it('bucket=app filters to UNCLASSIFIED_APP only', async () => {
    setSessionManager();
    primeBulkRows([]);

    await reclassifyUnclassifiedAction('app');

    expect(mockIn).toHaveBeenCalledWith('classification_status', [
      'UNCLASSIFIED_APP',
    ]);
  });

  it('bucket=type filters to UNCLASSIFIED_TYPE only', async () => {
    setSessionManager();
    primeBulkRows([]);

    await reclassifyUnclassifiedAction('type');

    expect(mockIn).toHaveBeenCalledWith('classification_status', [
      'UNCLASSIFIED_TYPE',
    ]);
  });

  it('bucket=any filters to both UNCLASSIFIED_* statuses', async () => {
    setSessionManager();
    primeBulkRows([]);

    await reclassifyUnclassifiedAction('any');

    expect(mockIn).toHaveBeenCalledWith('classification_status', [
      'UNCLASSIFIED_APP',
      'UNCLASSIFIED_TYPE',
    ]);
  });
});
