import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countActiveManagers, getUserById, listUsers } from './users';

const {
  mockFrom,
  mockSelect,
  mockOrder,
  mockEq1,
  mockEq2,
  mockMaybeSingle,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockOrder: vi.fn(),
  mockEq1: vi.fn(),
  mockEq2: vi.fn(),
  mockMaybeSingle: vi.fn(),
}));

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

beforeEach(() => {
  mockFrom.mockReset();
  mockSelect.mockReset();
  mockOrder.mockReset();
  mockEq1.mockReset();
  mockEq2.mockReset();
  mockMaybeSingle.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('listUsers', () => {
  it('returns rows sorted by created_at', async () => {
    const rows = [
      { id: 'u1', email: 'a@x.com', role: 'MANAGER' },
      { id: 'u2', email: 'b@x.com', role: 'DEV' },
    ];
    mockOrder.mockResolvedValueOnce({ data: rows, error: null });
    mockSelect.mockReturnValue({ order: mockOrder });
    mockFrom.mockReturnValue({ select: mockSelect });

    const result = await listUsers();

    expect(mockFrom).toHaveBeenCalledWith('users');
    expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(result).toEqual(rows);
  });

  it('returns empty array when data is null', async () => {
    mockOrder.mockResolvedValueOnce({ data: null, error: null });
    mockSelect.mockReturnValue({ order: mockOrder });
    mockFrom.mockReturnValue({ select: mockSelect });

    expect(await listUsers()).toEqual([]);
  });

  it('throws on error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockOrder.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    mockSelect.mockReturnValue({ order: mockOrder });
    mockFrom.mockReturnValue({ select: mockSelect });

    await expect(listUsers()).rejects.toThrow('Failed to load users');
    errorSpy.mockRestore();
  });
});

describe('getUserById', () => {
  it('returns the row when found', async () => {
    const row = { id: 'u1', email: 'a@x.com', role: 'MANAGER' };
    mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });
    mockEq1.mockReturnValue({ maybeSingle: mockMaybeSingle });
    mockSelect.mockReturnValue({ eq: mockEq1 });
    mockFrom.mockReturnValue({ select: mockSelect });

    const result = await getUserById('u1');

    expect(mockEq1).toHaveBeenCalledWith('id', 'u1');
    expect(result).toEqual(row);
  });

  it('returns null when row not found', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mockEq1.mockReturnValue({ maybeSingle: mockMaybeSingle });
    mockSelect.mockReturnValue({ eq: mockEq1 });
    mockFrom.mockReturnValue({ select: mockSelect });

    expect(await getUserById('missing')).toBeNull();
  });

  it('throws on error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'boom' },
    });
    mockEq1.mockReturnValue({ maybeSingle: mockMaybeSingle });
    mockSelect.mockReturnValue({ eq: mockEq1 });
    mockFrom.mockReturnValue({ select: mockSelect });

    await expect(getUserById('u1')).rejects.toThrow('Failed to load user');
    errorSpy.mockRestore();
  });
});

describe('countActiveManagers', () => {
  function setupCountChain(result: { count: number | null; error: unknown }) {
    mockEq2.mockResolvedValueOnce(result);
    mockEq1.mockReturnValue({ eq: mockEq2 });
    mockSelect.mockReturnValue({ eq: mockEq1 });
    mockFrom.mockReturnValue({ select: mockSelect });
  }

  it('returns count of active managers', async () => {
    setupCountChain({ count: 3, error: null });

    const result = await countActiveManagers();

    expect(mockSelect).toHaveBeenCalledWith('id', {
      count: 'exact',
      head: true,
    });
    expect(mockEq1).toHaveBeenCalledWith('role', 'MANAGER');
    expect(mockEq2).toHaveBeenCalledWith('status', 'active');
    expect(result).toBe(3);
  });

  it('returns 0 when count is null', async () => {
    setupCountChain({ count: null, error: null });
    expect(await countActiveManagers()).toBe(0);
  });

  it('throws on error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setupCountChain({ count: null, error: { message: 'boom' } });

    await expect(countActiveManagers()).rejects.toThrow(
      'Failed to count managers'
    );
    errorSpy.mockRestore();
  });
});
