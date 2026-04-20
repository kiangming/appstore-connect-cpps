import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PLATFORM_ID = '00000000-0000-4000-a000-000000000001';
const USER_ID = 'mgr-1';

// === Hoisted mocks ===

const {
  mockGetServerSession,
  mockRevalidatePath,
  mockRpc,
  mockRequireStoreRole,
  mockListRuleVersions,
  mockGetRuleVersion,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockRpc: vi.fn(),
  mockRequireStoreRole: vi.fn(),
  mockListRuleVersions: vi.fn(),
  mockGetRuleVersion: vi.fn(),
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

vi.mock('@/lib/store-submissions/db', () => ({
  storeDb: () => ({ rpc: mockRpc }),
}));

vi.mock('@/lib/store-submissions/queries/rules', () => ({
  listRuleVersions: mockListRuleVersions,
  getRuleVersion: mockGetRuleVersion,
}));

// === Imports AFTER mocks ===

import { StoreForbiddenError, StoreUnauthorizedError } from '@/lib/store-submissions/auth';

import {
  getRuleVersionAction,
  listRuleVersionsAction,
  rollbackRulesAction,
  saveRulesAction,
} from './actions';

// === Helpers ===

function setSessionManager() {
  mockGetServerSession.mockResolvedValue({ user: { email: 'mgr@company.com' } });
  mockRequireStoreRole.mockResolvedValue({
    id: USER_ID,
    email: 'mgr@company.com',
    role: 'MANAGER',
    status: 'active',
  });
}

function setNoSession() {
  mockGetServerSession.mockResolvedValue(null);
  mockRequireStoreRole.mockRejectedValue(new StoreUnauthorizedError('No session'));
}

function setSessionDev() {
  mockGetServerSession.mockResolvedValue({ user: { email: 'dev@company.com' } });
  mockRequireStoreRole.mockRejectedValue(
    new StoreForbiddenError('Required role: MANAGER. Current role: DEV.'),
  );
}

function validSavePayload(overrides: Record<string, unknown> = {}) {
  return {
    platform_id: PLATFORM_ID,
    expected_version_number: 12,
    senders: [{ email: 'no-reply@apple.com', is_primary: true, active: true }],
    subject_patterns: [
      {
        outcome: 'APPROVED' as const,
        regex: 'Review of your (?<app_name>.+) submission is complete\\.',
        priority: 10,
        active: true,
      },
    ],
    types: [
      {
        name: 'App',
        slug: 'app',
        body_keyword: 'App Version',
        sort_order: 10,
        active: true,
      },
    ],
    submission_id_patterns: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockGetServerSession.mockReset();
  mockRequireStoreRole.mockReset();
  mockRevalidatePath.mockReset();
  mockRpc.mockReset();
  mockListRuleVersions.mockReset();
  mockGetRuleVersion.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// Authorization
// ============================================================

describe('authorization', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['saveRulesAction', () => saveRulesAction(validSavePayload())],
    [
      'rollbackRulesAction',
      () => rollbackRulesAction({ platform_id: PLATFORM_ID, target_version: 5 }),
    ],
  ])('%s returns UNAUTHORIZED when no session', async (_, run) => {
    setNoSession();
    const result = (await run()) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each<[string, () => Promise<unknown>]>([
    ['saveRulesAction', () => saveRulesAction(validSavePayload())],
    [
      'rollbackRulesAction',
      () => rollbackRulesAction({ platform_id: PLATFORM_ID, target_version: 5 }),
    ],
  ])('%s returns FORBIDDEN when caller is DEV', async (_, run) => {
    setSessionDev();
    const result = (await run()) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ============================================================
// saveRulesAction — happy path + validation
// ============================================================

describe('saveRulesAction', () => {
  beforeEach(setSessionManager);

  it('returns VALIDATION when expected_version_number is missing', async () => {
    const { expected_version_number, ...payload } = validSavePayload();
    void expected_version_number;
    const result = await saveRulesAction(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns VALIDATION when regex fails RE2 + app_name named group check', async () => {
    const result = await saveRulesAction(
      validSavePayload({
        subject_patterns: [
          { outcome: 'APPROVED', regex: '(?<=foo)(.+)', priority: 10 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('dispatches save_rules_tx with normalized sender email + threads expected_version_number', async () => {
    mockRpc.mockResolvedValueOnce({ data: 13, error: null });

    const result = await saveRulesAction(
      validSavePayload({
        senders: [{ email: '  No-Reply@APPLE.com  ', is_primary: true }],
      }),
    );

    expect(result).toEqual({ ok: true, data: { version_number: 13 } });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const call = mockRpc.mock.calls[0];
    if (!call) throw new Error('expected mockRpc to have been called');
    const [fn, args] = call;
    expect(fn).toBe('save_rules_tx');
    expect(args).toMatchObject({
      p_platform_id: PLATFORM_ID,
      p_expected_version_number: 12,
      p_saved_by: USER_ID,
    });
    // email was trimmed + lowercased by the zod schema before the RPC call
    expect(args.p_senders).toEqual([
      { email: 'no-reply@apple.com', is_primary: true, active: true },
    ]);
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      '/store-submissions/config/email-rules',
    );
  });

  it('passes expected_version_number=null for truly first save', async () => {
    mockRpc.mockResolvedValueOnce({ data: 1, error: null });
    await saveRulesAction(validSavePayload({ expected_version_number: null }));
    const call = mockRpc.mock.calls[0];
    if (!call) throw new Error('expected mockRpc to have been called');
    expect(call[1].p_expected_version_number).toBeNull();
  });

  // ----------------------------------------------------------------
  // Optimistic-lock conflict — the exercise is verifying that the
  // action correctly parses the sqlerrm emitted by save_rules_tx so
  // the client can render a helpful toast.
  // ----------------------------------------------------------------

  it('maps VERSION_CONFLICT sqlerrm → structured error with actual + expected versions', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'VERSION_CONFLICT: expected v12, actual v14' },
    });

    const result = await saveRulesAction(validSavePayload());
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'VERSION_CONFLICT') {
      expect(result.error.expectedVersion).toBe(12);
      expect(result.error.actualVersion).toBe(14);
      expect(result.error.message).toMatch(/concurrently/i);
    } else {
      throw new Error('expected VERSION_CONFLICT');
    }
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it('handles VERSION_CONFLICT where expected was null (first-save raced)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'VERSION_CONFLICT: expected vnone, actual v1' },
    });

    const result = await saveRulesAction(
      validSavePayload({ expected_version_number: null }),
    );
    if (!result.ok && result.error.code === 'VERSION_CONFLICT') {
      expect(result.error.expectedVersion).toBeNull();
      expect(result.error.actualVersion).toBe(1);
    } else {
      throw new Error('expected VERSION_CONFLICT');
    }
  });

  // ----------------------------------------------------------------
  // Concurrent save simulation.
  //
  // The RPC itself serializes via FOR UPDATE on the platforms row, so a
  // Postgres-level race can't violate the UNIQUE(platform_id, version_number)
  // constraint. At the action layer we can only simulate the outcome: the
  // first save wins (returns new version_number), the second save sees
  // a stale expected and gets VERSION_CONFLICT back from the RPC.
  //
  // Full DB-level race testing would require a real Postgres and is noted
  // as integration-test follow-up in TODO.md (PR-5 integration).
  // ----------------------------------------------------------------
  it('simulates two concurrent saves on the same expected version — second gets VERSION_CONFLICT', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: 13, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'VERSION_CONFLICT: expected v12, actual v13' },
      });

    const [r1, r2] = await Promise.all([
      saveRulesAction(validSavePayload()),
      saveRulesAction(validSavePayload()),
    ]);

    const successes = [r1, r2].filter((r) => r.ok);
    const failures = [r1, r2].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const conflict = failures[0] as { ok: false; error: { code: string; actualVersion: number } };
    expect(conflict.error.code).toBe('VERSION_CONFLICT');
    expect(conflict.error.actualVersion).toBe(13);
  });

  it('maps NOT_FOUND sqlerrm → structured error', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'NOT_FOUND: platform ... does not exist' },
    });
    const result = await saveRulesAction(validSavePayload());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('maps unrecognized Postgres error → DB_ERROR', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'some other Postgres error' },
    });
    const result = await saveRulesAction(validSavePayload());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DB_ERROR');
  });
});

// ============================================================
// rollbackRulesAction
// ============================================================

describe('rollbackRulesAction', () => {
  beforeEach(setSessionManager);

  it('dispatches rollback_rules_tx with target_version + user note', async () => {
    mockRpc.mockResolvedValueOnce({ data: 14, error: null });

    const result = await rollbackRulesAction({
      platform_id: PLATFORM_ID,
      target_version: 10,
      note: 'reverting bad Apple regex',
    });

    expect(result).toEqual({ ok: true, data: { version_number: 14 } });
    expect(mockRpc).toHaveBeenCalledWith('rollback_rules_tx', {
      p_platform_id: PLATFORM_ID,
      p_target_version: 10,
      p_saved_by: USER_ID,
      p_note: 'reverting bad Apple regex',
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      '/store-submissions/config/email-rules',
    );
  });

  it('returns VALIDATION when target_version is 0', async () => {
    const result = await rollbackRulesAction({
      platform_id: PLATFORM_ID,
      target_version: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('maps NOT_FOUND (unknown version) → NOT_FOUND', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'NOT_FOUND: version 999 not found for platform ...' },
    });
    const result = await rollbackRulesAction({
      platform_id: PLATFORM_ID,
      target_version: 999,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });
});

// ============================================================
// listRuleVersionsAction — metadata-only version list
// ============================================================

describe('listRuleVersionsAction', () => {
  it('returns UNAUTHORIZED when no session', async () => {
    setNoSession();
    const res = await listRuleVersionsAction(PLATFORM_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNAUTHORIZED');
    expect(mockListRuleVersions).not.toHaveBeenCalled();
  });

  it('returns FORBIDDEN for DEV', async () => {
    setSessionDev();
    const res = await listRuleVersionsAction(PLATFORM_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    expect(mockListRuleVersions).not.toHaveBeenCalled();
  });

  describe('when caller is MANAGER', () => {
    beforeEach(setSessionManager);

    it('returns VALIDATION when platformId is empty', async () => {
      const res = await listRuleVersionsAction('');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('VALIDATION');
      expect(mockListRuleVersions).not.toHaveBeenCalled();
    });

    it('forwards the 50-row limit and maps rows to VersionSummary', async () => {
      mockListRuleVersions.mockResolvedValueOnce([
        {
          id: 'v-1',
          platform_id: PLATFORM_ID,
          version_number: 12,
          saved_by: 'u-1',
          saved_at: '2026-04-18T10:00:00Z',
          note: 'Added IN_REVIEW pattern',
          saved_by_email: 'mgr@company.com',
          saved_by_display_name: 'Linh Tran',
        },
      ]);

      const res = await listRuleVersionsAction(PLATFORM_ID);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('expected ok');
      expect(res.data).toEqual([
        {
          id: 'v-1',
          version_number: 12,
          saved_at: '2026-04-18T10:00:00Z',
          saved_by_email: 'mgr@company.com',
          saved_by_display_name: 'Linh Tran',
          note: 'Added IN_REVIEW pattern',
        },
      ]);
      expect(mockListRuleVersions).toHaveBeenCalledWith(PLATFORM_ID, 50);
    });

    it('returns DB_ERROR when the query throws', async () => {
      mockListRuleVersions.mockRejectedValueOnce(new Error('boom'));
      const res = await listRuleVersionsAction(PLATFORM_ID);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('DB_ERROR');
    });
  });
});

// ============================================================
// getRuleVersionAction — version detail + count computation
// ============================================================

describe('getRuleVersionAction', () => {
  it('returns UNAUTHORIZED when no session', async () => {
    setNoSession();
    const res = await getRuleVersionAction({
      platform_id: PLATFORM_ID,
      version_number: 12,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNAUTHORIZED');
    expect(mockGetRuleVersion).not.toHaveBeenCalled();
  });

  it('returns FORBIDDEN for DEV', async () => {
    setSessionDev();
    const res = await getRuleVersionAction({
      platform_id: PLATFORM_ID,
      version_number: 12,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('FORBIDDEN');
    expect(mockGetRuleVersion).not.toHaveBeenCalled();
  });

  describe('when caller is MANAGER', () => {
    beforeEach(setSessionManager);

    it.each<[string, { platform_id: string; version_number: number }]>([
      ['empty platform_id', { platform_id: '', version_number: 12 }],
      [
        'version_number=0',
        { platform_id: PLATFORM_ID, version_number: 0 },
      ],
      [
        'fractional version_number',
        { platform_id: PLATFORM_ID, version_number: 1.5 },
      ],
    ])('returns VALIDATION when input is %s', async (_, input) => {
      const res = await getRuleVersionAction(input);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('VALIDATION');
      expect(mockGetRuleVersion).not.toHaveBeenCalled();
    });

    it('returns NOT_FOUND when the query yields null', async () => {
      mockGetRuleVersion.mockResolvedValueOnce(null);
      const res = await getRuleVersionAction({
        platform_id: PLATFORM_ID,
        version_number: 999,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('NOT_FOUND');
    });

    it('returns summary + computed counts from config_snapshot', async () => {
      mockGetRuleVersion.mockResolvedValueOnce({
        id: 'v-2',
        platform_id: PLATFORM_ID,
        version_number: 12,
        saved_by: 'u-1',
        saved_at: '2026-04-18T10:00:00Z',
        note: 'Apple cleanup',
        saved_by_email: 'mgr@company.com',
        saved_by_display_name: 'Linh Tran',
        config_snapshot: {
          schema_version: 1,
          senders: [
            {
              id: '00000000-0000-4000-a000-000000000001',
              email: 'x@y.com',
              is_primary: true,
              active: true,
            },
          ],
          subject_patterns: [],
          types: [
            {
              id: '00000000-0000-4000-a000-000000000002',
              name: 'App',
              slug: 'app',
              body_keyword: 'App Version',
              payload_extract_regex: null,
              sort_order: 10,
              active: true,
            },
          ],
          submission_id_patterns: [],
        },
      });

      const res = await getRuleVersionAction({
        platform_id: PLATFORM_ID,
        version_number: 12,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('expected ok');
      expect(res.data).toEqual({
        id: 'v-2',
        version_number: 12,
        saved_at: '2026-04-18T10:00:00Z',
        saved_by_email: 'mgr@company.com',
        saved_by_display_name: 'Linh Tran',
        note: 'Apple cleanup',
        counts: {
          senders: 1,
          subject_patterns: 0,
          types: 1,
          submission_id_patterns: 0,
        },
      });
      expect(mockGetRuleVersion).toHaveBeenCalledWith(PLATFORM_ID, 12);
    });

    it('returns DB_ERROR on query exception', async () => {
      mockGetRuleVersion.mockRejectedValueOnce(new Error('boom'));
      const res = await getRuleVersionAction({
        platform_id: PLATFORM_ID,
        version_number: 12,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('DB_ERROR');
    });
  });
});
