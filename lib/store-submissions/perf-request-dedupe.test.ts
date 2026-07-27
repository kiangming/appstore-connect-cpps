/**
 * Perf batch (review 2026-07-27) — request-scoped dedupe proof for T1-1(a) +
 * T1-2.
 *
 * In production React's `cache()` (react-server build) dedupes calls within one
 * request render. The client React build used by Vitest does NOT export
 * `cache`, so `lib/react-request-cache` degrades to identity there and no
 * dedupe would be observable. To prove the WIRING — that both call sites route
 * through the SAME cached function, so a request-scoped cache collapses them —
 * we mock `@/lib/react-request-cache` with a faithful request-scoped memoizer
 * (fresh cache per "request", keyed by the wrapped fn + its args), exactly the
 * contract React's `cache()` provides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Request-scoped memoizer stand-in for React's RSC cache(). `store` is a fresh
// WeakMap per simulated request; __newRequest() rotates it (what the framework
// does between requests).
vi.mock('@/lib/react-request-cache', () => {
  let store = new WeakMap<object, Map<string, unknown>>();
  const requestScopedCache = <T extends (...a: never[]) => unknown>(fn: T): T =>
    ((...args: never[]) => {
      let m = store.get(fn);
      if (!m) {
        m = new Map();
        store.set(fn, m);
      }
      const key = JSON.stringify(args);
      if (!m.has(key)) m.set(key, fn(...args));
      return m.get(key);
    }) as T;
  const __newRequest = () => {
    store = new WeakMap();
  };
  return { requestScopedCache, __newRequest };
});

const { mockMaybeSingle, mockIlike, mockEq, mockSelect, mockFrom } = vi.hoisted(
  () => ({
    mockMaybeSingle: vi.fn(),
    mockIlike: vi.fn(),
    mockEq: vi.fn(),
    mockSelect: vi.fn(),
    mockFrom: vi.fn(),
  }),
);

// Both auth.ts (`./db`) and queries/reports.ts (`../db`) resolve to the same
// module id, so this single mock intercepts both.
vi.mock('./db', () => ({ storeDb: () => ({ from: mockFrom }) }));

import * as requestCache from '@/lib/react-request-cache';
import { getStoreUser } from './auth';
import { getApplePlatformId } from './queries/reports';

// The mock augments the module with a test-only reset; the real module has no
// such export, so reach it through one documented cast.
const newRequest = (requestCache as unknown as { __newRequest: () => void })
  .__newRequest;

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
  newRequest(); // start every test in a fresh request scope
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('T1-1(a) getStoreUser request-scoped dedupe', () => {
  it('(i) layout + page within ONE request → a single DB query', async () => {
    mockMaybeSingle.mockResolvedValue({ data: ACTIVE_MANAGER, error: null });

    // Two call sites (layout + requireStoreSession) resolving the same email.
    const [a, b] = await Promise.all([
      getStoreUser('manager@company.com'),
      getStoreUser('manager@company.com'),
    ]);

    expect(a).toEqual(ACTIVE_MANAGER);
    expect(b).toEqual(ACTIVE_MANAGER);
    // Deduped: the underlying SELECT executed once, not twice.
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });

  it('(ii) dedupe is REQUEST-SCOPED — a separate request re-queries', async () => {
    mockMaybeSingle.mockResolvedValue({ data: ACTIVE_MANAGER, error: null });

    await getStoreUser('manager@company.com');
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);

    newRequest(); // a fresh request (React clears cache between requests)
    await getStoreUser('manager@company.com');

    // Re-queried, not served from the previous request's result — this is the
    // guard against a P6 cross-request cache (a disabled user must take effect
    // immediately, session-guard.ts:5-6).
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
  });
});

describe('T1-2 getApplePlatformId request-scoped dedupe', () => {
  it('(iv) resolves once per render even when all 6 callers ask', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: 'apple-1' }, error: null });

    // Page + the 5 aggregation fetchers all resolve the platform id.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => getApplePlatformId()),
    );

    expect(results).toEqual(Array.from({ length: 6 }, () => 'apple-1'));
    // 6 → 1: the `platforms` lookup executed once for the whole render.
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1);
  });
});
