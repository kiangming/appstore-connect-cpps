import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StoreForbiddenError,
  StoreUnauthorizedError,
  getStoreUser,
  requireStoreAccess,
  requireStoreRole,
} from './auth';

const { mockMaybeSingle, mockIlike, mockEq, mockSelect, mockFrom } = vi.hoisted(
  () => ({
    mockMaybeSingle: vi.fn(),
    mockIlike: vi.fn(),
    mockEq: vi.fn(),
    mockSelect: vi.fn(),
    mockFrom: vi.fn(),
  })
);

vi.mock('./db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

function setQueryResult(result: { data: unknown; error: unknown }) {
  mockMaybeSingle.mockResolvedValueOnce(result);
}

const ACTIVE_MANAGER = {
  id: 'user-1',
  email: 'manager@company.com',
  role: 'MANAGER',
  display_name: 'Manager One',
  avatar_url: null,
  status: 'active',
};

beforeEach(() => {
  const chain = {
    select: mockSelect,
    ilike: mockIlike,
    eq: mockEq,
    maybeSingle: mockMaybeSingle,
  };
  mockFrom.mockReturnValue(chain);
  mockSelect.mockReturnValue(chain);
  mockIlike.mockReturnValue(chain);
  mockEq.mockReturnValue(chain);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getStoreUser', () => {
  it('returns the user when row exists', async () => {
    setQueryResult({ data: ACTIVE_MANAGER, error: null });
    const user = await getStoreUser('manager@company.com');
    expect(user).toEqual(ACTIVE_MANAGER);
  });

  it('returns null when no row matches', async () => {
    setQueryResult({ data: null, error: null });
    const user = await getStoreUser('ghost@company.com');
    expect(user).toBeNull();
  });

  it('returns null and logs when the query errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setQueryResult({ data: null, error: { message: 'boom' } });
    const user = await getStoreUser('manager@company.com');
    expect(user).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[store-auth] Failed to query user:',
      { message: 'boom' }
    );
    errorSpy.mockRestore();
  });

  it('normalizes email to lowercase + trims whitespace before querying', async () => {
    setQueryResult({ data: ACTIVE_MANAGER, error: null });
    await getStoreUser('  Manager@Company.COM  ');
    expect(mockIlike).toHaveBeenCalledWith('email', 'manager@company.com');
  });

  it('filters by status=active', async () => {
    setQueryResult({ data: null, error: null });
    await getStoreUser('manager@company.com');
    expect(mockEq).toHaveBeenCalledWith('status', 'active');
  });
});

describe('requireStoreAccess', () => {
  it('throws StoreUnauthorizedError when session email is missing', async () => {
    await expect(requireStoreAccess(null)).rejects.toBeInstanceOf(
      StoreUnauthorizedError
    );
    await expect(requireStoreAccess(undefined)).rejects.toBeInstanceOf(
      StoreUnauthorizedError
    );
    await expect(requireStoreAccess('')).rejects.toBeInstanceOf(
      StoreUnauthorizedError
    );
  });

  it('throws StoreForbiddenError when email is not whitelisted', async () => {
    setQueryResult({ data: null, error: null });
    await expect(
      requireStoreAccess('ghost@company.com')
    ).rejects.toBeInstanceOf(StoreForbiddenError);
  });

  it('returns the store user when whitelisted and active', async () => {
    setQueryResult({ data: ACTIVE_MANAGER, error: null });
    const user = await requireStoreAccess('manager@company.com');
    expect(user.role).toBe('MANAGER');
    expect(user.email).toBe('manager@company.com');
  });
});

describe('requireStoreRole', () => {
  it('returns user when role matches a single required role', async () => {
    setQueryResult({ data: ACTIVE_MANAGER, error: null });
    const user = await requireStoreRole('manager@company.com', 'MANAGER');
    expect(user.role).toBe('MANAGER');
  });

  it('returns user when role is in the required array', async () => {
    setQueryResult({ data: ACTIVE_MANAGER, error: null });
    const user = await requireStoreRole('manager@company.com', [
      'MANAGER',
      'DEV',
    ]);
    expect(user.role).toBe('MANAGER');
  });

  it('throws StoreForbiddenError when role does not match', async () => {
    setQueryResult({ data: { ...ACTIVE_MANAGER, role: 'VIEWER' }, error: null });
    await expect(
      requireStoreRole('viewer@company.com', 'MANAGER')
    ).rejects.toBeInstanceOf(StoreForbiddenError);
  });

  it('throws StoreForbiddenError when role is not in required array', async () => {
    setQueryResult({ data: { ...ACTIVE_MANAGER, role: 'VIEWER' }, error: null });
    await expect(
      requireStoreRole('viewer@company.com', ['MANAGER', 'DEV'])
    ).rejects.toBeInstanceOf(StoreForbiddenError);
  });
});
