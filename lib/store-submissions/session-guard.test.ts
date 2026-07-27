/**
 * Perf batch (review 2026-07-27) — T1-1(b): `syncStoreProfile` telemetry write
 * must be fire-and-forget (off the render critical path) with a mandatory
 * `.catch`, so a failing write neither blocks the page nor surfaces an
 * unhandled rejection. Its own contract: telemetry "must never break login".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetServerSession,
  mockRedirect,
  mockGetStoreUser,
  mockSyncStoreProfile,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRedirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  mockGetStoreUser: vi.fn(),
  mockSyncStoreProfile: vi.fn(),
}));

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }));
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('./auth', () => ({
  getStoreUser: mockGetStoreUser,
  syncStoreProfile: mockSyncStoreProfile,
}));

import { requireStoreSession } from './session-guard';

const SESSION = {
  user: { email: 'm@x.com', id: 'g-1', name: 'M', image: null },
};
const STORE_USER = {
  id: 'u1',
  email: 'm@x.com',
  role: 'MANAGER' as const,
  display_name: 'M',
  avatar_url: null,
  status: 'active' as const,
};

afterEach(() => vi.clearAllMocks());

describe('requireStoreSession — telemetry is fire-and-forget (T1-1b)', () => {
  it('(iii) invokes syncStoreProfile but does NOT await it; a rejection neither throws nor blocks', async () => {
    mockGetServerSession.mockResolvedValue(SESSION);
    mockGetStoreUser.mockResolvedValue(STORE_USER);

    // A telemetry write that stays pending until we reject it. If the guard
    // awaited it, requireStoreSession below would hang instead of resolving.
    let rejectWrite!: (e: unknown) => void;
    const pendingWrite = new Promise<void>((_, reject) => {
      rejectWrite = reject;
    });
    mockSyncStoreProfile.mockReturnValue(pendingWrite);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Resolves WITHOUT the write settling → proves not awaited (non-blocking).
    const ctx = await requireStoreSession();
    expect(ctx.storeUser).toEqual(STORE_USER);
    expect(mockSyncStoreProfile).toHaveBeenCalledTimes(1);
    expect(mockSyncStoreProfile).toHaveBeenCalledWith({
      userId: 'u1',
      googleSub: 'g-1',
      displayName: 'M',
      avatarUrl: null,
    });

    // Fail the telemetry write: the mandatory `.catch` must swallow + log it,
    // never rethrow, no unhandled rejection.
    rejectWrite(new Error('telemetry down'));
    await Promise.resolve();
    await Promise.resolve();
    expect(errSpy).toHaveBeenCalledWith(
      '[store-auth] syncStoreProfile (non-blocking) failed:',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('resolves normally when the telemetry write succeeds', async () => {
    mockGetServerSession.mockResolvedValue(SESSION);
    mockGetStoreUser.mockResolvedValue(STORE_USER);
    mockSyncStoreProfile.mockResolvedValue(undefined);

    const ctx = await requireStoreSession();
    expect(ctx.storeUser.role).toBe('MANAGER');
    expect(mockGetStoreUser).toHaveBeenCalledWith('m@x.com');
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
