import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

// === Hoisted mocks ===

const {
  mockGetServerSession,
  mockRevalidatePath,
  mockRpc,
  mockFrom,
  mockInsert,
  mockSelect,
  mockSingle,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockInsert: vi.fn(),
  mockSelect: vi.fn(),
  mockSingle: vi.fn(),
}));

vi.mock('next-auth', () => ({
  getServerSession: mockGetServerSession,
}));

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
}));

// Control what requireStoreRole resolves to (happy path) or throws (authz fail)
const { mockRequireStoreRole } = vi.hoisted(() => ({
  mockRequireStoreRole: vi.fn(),
}));

vi.mock('@/lib/store-submissions/auth', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/auth')
  >('@/lib/store-submissions/auth');
  return {
    ...actual,
    requireStoreRole: mockRequireStoreRole,
  };
});

vi.mock('@/lib/store-submissions/db', () => ({
  storeDb: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

// === Imports AFTER mocks ===

import { StoreForbiddenError, StoreUnauthorizedError } from '@/lib/store-submissions/auth';
import { createUser, disableUser, updateUser } from './actions';

// === Helpers ===

function setSessionManager() {
  mockGetServerSession.mockResolvedValue({
    user: { email: 'mgr@company.com' },
  });
  mockRequireStoreRole.mockResolvedValue({
    id: 'mgr-1',
    email: 'mgr@company.com',
    role: 'MANAGER',
    status: 'active',
  });
}

function setNoSession() {
  mockGetServerSession.mockResolvedValue(null);
  mockRequireStoreRole.mockRejectedValue(
    new StoreUnauthorizedError('No session')
  );
}

function setSessionDev() {
  mockGetServerSession.mockResolvedValue({
    user: { email: 'dev@company.com' },
  });
  mockRequireStoreRole.mockRejectedValue(
    new StoreForbiddenError('Required role: MANAGER. Current role: DEV.')
  );
}

function wireInsertChain(result: {
  data: { id: string } | null;
  error: unknown;
}) {
  mockSingle.mockResolvedValueOnce(result);
  mockSelect.mockReturnValue({ single: mockSingle });
  mockInsert.mockReturnValue({ select: mockSelect });
  mockFrom.mockReturnValue({ insert: mockInsert });
}

beforeEach(() => {
  mockGetServerSession.mockReset();
  mockRequireStoreRole.mockReset();
  mockRevalidatePath.mockReset();
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockInsert.mockReset();
  mockSelect.mockReset();
  mockSingle.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// Authorization
// ============================================================

describe('authorization', () => {
  it('createUser returns UNAUTHORIZED when no session', async () => {
    setNoSession();
    const result = await createUser({
      email: 'new@company.com',
      role: 'DEV',
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'No session' },
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('createUser returns FORBIDDEN when caller is DEV', async () => {
    setSessionDev();
    const result = await createUser({
      email: 'new@company.com',
      role: 'DEV',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('FORBIDDEN');
    }
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('updateUser returns FORBIDDEN when caller is VIEWER', async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: 'viewer@company.com' },
    });
    mockRequireStoreRole.mockRejectedValue(
      new StoreForbiddenError('viewer rejected')
    );
    const result = await updateUser({ id: VALID_UUID, role: 'DEV' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('disableUser returns FORBIDDEN for non-managers', async () => {
    setSessionDev();
    const result = await disableUser({ id: VALID_UUID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ============================================================
// Validation
// ============================================================

describe('validation', () => {
  beforeEach(setSessionManager);

  it('createUser rejects invalid email', async () => {
    const result = await createUser({ email: 'not-an-email', role: 'DEV' });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('createUser rejects invalid role', async () => {
    const result = await createUser({
      email: 'x@company.com',
      role: 'OWNER',
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });

  it('updateUser rejects non-UUID id', async () => {
    const result = await updateUser({ id: 'not-uuid', role: 'DEV' });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('disableUser rejects missing id', async () => {
    const result = await disableUser({});
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });
});

// ============================================================
// createUser happy + DB errors
// ============================================================

describe('createUser', () => {
  beforeEach(setSessionManager);

  it('inserts and revalidates on success', async () => {
    wireInsertChain({ data: { id: 'u-new' }, error: null });

    const result = await createUser({
      email: '  New@Company.COM  ',
      role: 'DEV',
      display_name: ' Alice ',
    });

    expect(result).toEqual({ ok: true, data: { id: 'u-new' } });
    expect(mockFrom).toHaveBeenCalledWith('users');
    expect(mockInsert).toHaveBeenCalledWith({
      email: 'new@company.com',
      role: 'DEV',
      display_name: 'Alice',
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      '/store-submissions/config/team'
    );
  });

  it('returns EMAIL_TAKEN on unique violation (23505)', async () => {
    wireInsertChain({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });

    const result = await createUser({
      email: 'dup@company.com',
      role: 'DEV',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'EMAIL_TAKEN' },
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it('returns DB_ERROR on other DB failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    wireInsertChain({
      data: null,
      error: { code: 'XX000', message: 'boom' },
    });

    const result = await createUser({
      email: 'x@company.com',
      role: 'DEV',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DB_ERROR' },
    });
    errorSpy.mockRestore();
  });
});

// ============================================================
// updateUser — invariant coverage (LAST_MANAGER)
// ============================================================

describe('updateUser — LAST_MANAGER invariant', () => {
  beforeEach(setSessionManager);

  it('succeeds when demoting a manager while ≥1 other remains', async () => {
    mockRpc.mockResolvedValueOnce({ error: null });

    const result = await updateUser({
      id: VALID_UUID,
      role: 'DEV',
    });

    expect(result).toEqual({ ok: true, data: undefined });
    expect(mockRpc).toHaveBeenCalledWith('update_user_guarded', {
      p_id: VALID_UUID,
      p_role: 'DEV',
      p_status: null,
      p_display_name: null,
    });
    expect(mockRevalidatePath).toHaveBeenCalled();
  });

  it('rejects with LAST_MANAGER when demoting the last active MANAGER', async () => {
    mockRpc.mockResolvedValueOnce({
      error: {
        message:
          'LAST_MANAGER: cannot demote or disable the last active MANAGER',
      },
    });

    const result = await updateUser({
      id: VALID_UUID,
      role: 'DEV',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'LAST_MANAGER' },
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it('rejects with LAST_MANAGER when disabling the last active MANAGER', async () => {
    mockRpc.mockResolvedValueOnce({
      error: { message: 'LAST_MANAGER: ...' },
    });

    const result = await disableUser({ id: VALID_UUID });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'LAST_MANAGER' },
    });
    expect(mockRpc).toHaveBeenCalledWith('update_user_guarded', {
      p_id: VALID_UUID,
      p_role: null,
      p_status: 'disabled',
      p_display_name: null,
    });
  });

  it('maps NOT_FOUND rpc error', async () => {
    mockRpc.mockResolvedValueOnce({
      error: { message: 'NOT_FOUND: user does not exist' },
    });

    const result = await updateUser({ id: VALID_UUID, role: 'DEV' });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('returns DB_ERROR on unknown rpc failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRpc.mockResolvedValueOnce({
      error: { message: 'some other rpc failure' },
    });

    const result = await updateUser({ id: VALID_UUID, role: 'DEV' });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DB_ERROR' },
    });
    errorSpy.mockRestore();
  });
});

// ============================================================
// disableUser happy path
// ============================================================

describe('disableUser', () => {
  beforeEach(setSessionManager);

  it('disables user and revalidates on success', async () => {
    mockRpc.mockResolvedValueOnce({ error: null });

    const result = await disableUser({ id: VALID_UUID });

    expect(result).toEqual({ ok: true, data: undefined });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      '/store-submissions/config/team'
    );
  });
});
