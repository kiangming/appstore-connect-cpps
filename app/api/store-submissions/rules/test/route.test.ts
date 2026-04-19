import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AppWithAliases,
  RulesSnapshot,
} from '@/lib/store-submissions/classifier/types';

const PLATFORM_ID = '11111111-1111-4111-8111-111111111111';
const APP_ID = '22222222-2222-4222-8222-222222222222';

// ------------------------------------------------------------------
// Hoisted mocks
// ------------------------------------------------------------------

const {
  mockGetServerSession,
  mockRequireStoreRole,
  mockGetRulesSnapshot,
  mockStoreDbRpc,
  mockStoreDbFrom,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRequireStoreRole: vi.fn(),
  mockGetRulesSnapshot: vi.fn(),
  mockStoreDbRpc: vi.fn(),
  mockStoreDbFrom: vi.fn(),
}));

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/store-submissions/auth', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/auth')
  >('@/lib/store-submissions/auth');
  return { ...actual, requireStoreRole: mockRequireStoreRole };
});

vi.mock('@/lib/store-submissions/queries/rules', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/store-submissions/queries/rules')
  >('@/lib/store-submissions/queries/rules');
  return { ...actual, getRulesSnapshotForPlatform: mockGetRulesSnapshot };
});

// If the route handler somehow bypasses the helper and reaches storeDb
// directly, these spies catch it. The zero-side-effects assertion below
// proves no mutation method was called.
vi.mock('@/lib/store-submissions/db', () => ({
  storeDb: () => ({ from: mockStoreDbFrom, rpc: mockStoreDbRpc }),
}));

// ------------------------------------------------------------------
// Imports AFTER mocks
// ------------------------------------------------------------------

import { StoreForbiddenError, StoreUnauthorizedError } from '@/lib/store-submissions/auth';

import { POST } from './route';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function setManager() {
  mockGetServerSession.mockResolvedValue({ user: { email: 'mgr@company.com' } });
  mockRequireStoreRole.mockResolvedValue({
    id: 'mgr-1',
    email: 'mgr@company.com',
    role: 'MANAGER',
    status: 'active',
  });
}

function setNoSession() {
  mockGetServerSession.mockResolvedValue(null);
  mockRequireStoreRole.mockRejectedValue(new StoreUnauthorizedError('No session'));
}

function setDev() {
  mockGetServerSession.mockResolvedValue({ user: { email: 'dev@company.com' } });
  mockRequireStoreRole.mockRejectedValue(
    new StoreForbiddenError('Required role: MANAGER. Current role: DEV.'),
  );
}

function makeRequest(body: unknown, { method = 'POST' }: { method?: string } = {}) {
  return new Request('http://localhost/api/store-submissions/rules/test', {
    method,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }) as unknown as import('next/server').NextRequest;
}

function appleApp(aliases: AppWithAliases['aliases'] = []): AppWithAliases {
  return {
    id: APP_ID,
    name: 'Skyline Runners',
    aliases,
    platform_bindings: [{ platform_id: PLATFORM_ID }],
  };
}

function appleRules(overrides: Partial<RulesSnapshot> = {}): RulesSnapshot {
  return {
    platform_id: PLATFORM_ID,
    platform_key: 'apple',
    senders: [
      { id: 's1', email: 'no-reply@apple.com', is_primary: true, active: true },
    ],
    subject_patterns: [
      {
        id: 'sp1',
        outcome: 'APPROVED',
        regex: 'Review of your (?<app_name>.+) submission is complete\\.',
        priority: 10,
        active: true,
      },
    ],
    types: [
      {
        id: 't1',
        name: 'App',
        slug: 'app',
        body_keyword: 'App Version',
        payload_extract_regex:
          'App Version\\s*\\n\\s*(?<version>[\\d.]+) for (?<os>\\w+)',
        sort_order: 10,
        active: true,
      },
    ],
    submission_id_patterns: [],
    apps_with_aliases: [
      appleApp([
        { alias_text: 'Skyline Runners', alias_regex: null, source_type: 'AUTO_CURRENT' },
      ]),
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mockGetServerSession.mockReset();
  mockRequireStoreRole.mockReset();
  mockGetRulesSnapshot.mockReset();
  mockStoreDbRpc.mockReset();
  mockStoreDbFrom.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ------------------------------------------------------------------
// Authorization
// ------------------------------------------------------------------

describe('POST /api/store-submissions/rules/test — authorization', () => {
  it('returns 401 when no session', async () => {
    setNoSession();
    const res = await POST(
      makeRequest({
        sender: 'x@y.com',
        subject: 'x',
        body: 'x',
        platform_id: PLATFORM_ID,
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(mockGetRulesSnapshot).not.toHaveBeenCalled();
  });

  it('returns 403 when caller is DEV', async () => {
    setDev();
    const res = await POST(
      makeRequest({
        sender: 'x@y.com',
        subject: 'x',
        body: 'x',
        platform_id: PLATFORM_ID,
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect(mockGetRulesSnapshot).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------
// Input validation
// ------------------------------------------------------------------

describe('POST — input validation', () => {
  beforeEach(setManager);

  it('returns 400 when body is not valid JSON', async () => {
    const res = await POST(makeRequest('not-json-text'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when platform_id is missing', async () => {
    const res = await POST(
      makeRequest({ sender: 'x', subject: 'x', body: 'x' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('VALIDATION');
  });

  it('returns 400 when platform_id is not a UUID', async () => {
    const res = await POST(
      makeRequest({
        sender: 'x',
        subject: 'x',
        body: 'x',
        platform_id: 'not-a-uuid',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when platform lookup yields null', async () => {
    mockGetRulesSnapshot.mockResolvedValue(null);
    const res = await POST(
      makeRequest({
        sender: 'x@y.com',
        subject: 'x',
        body: 'x',
        platform_id: PLATFORM_ID,
      }),
    );
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------------------------
// 5 classification outcomes end-to-end
// ------------------------------------------------------------------

describe('POST — classification outcomes', () => {
  beforeEach(() => {
    setManager();
    mockGetRulesSnapshot.mockResolvedValue(appleRules());
  });

  it('DROPPED when sender does not match', async () => {
    const res = await POST(
      makeRequest({
        sender: 'unknown@gmail.com',
        subject: 'Review of your X submission is complete.',
        body: 'App Version\n1.0 for iOS',
        platform_id: PLATFORM_ID,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { result: { status: string }; trace: unknown[] };
    };
    expect(body.data.result.status).toBe('DROPPED');
    expect(body.data.trace).toEqual([]);
  });

  it('ERROR when sender matches but no subject pattern matches', async () => {
    const res = await POST(
      makeRequest({
        sender: 'no-reply@apple.com',
        subject: 'Weekly digest',
        body: 'anything',
        platform_id: PLATFORM_ID,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { result: { status: string; error_code?: string }; trace: unknown[] };
    };
    expect(body.data.result.status).toBe('ERROR');
    expect(body.data.result.error_code).toBe('NO_SUBJECT_MATCH');
    expect(body.data.trace).toHaveLength(1);
  });

  it('UNCLASSIFIED_APP when subject parses but app unknown', async () => {
    mockGetRulesSnapshot.mockResolvedValue(
      appleRules({ apps_with_aliases: [] }),
    );

    const res = await POST(
      makeRequest({
        sender: 'no-reply@apple.com',
        subject: 'Review of your Unknown App submission is complete.',
        body: 'App Version\n1.0 for iOS',
        platform_id: PLATFORM_ID,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: {
        result: { status: string; extracted_app_name?: string | null };
        trace: unknown[];
      };
    };
    expect(body.data.result.status).toBe('UNCLASSIFIED_APP');
    expect(body.data.result.extracted_app_name).toBe('Unknown App');
  });

  it('UNCLASSIFIED_TYPE when app matches but no body keyword hits', async () => {
    mockGetRulesSnapshot.mockResolvedValue(
      appleRules({
        types: [
          {
            id: 't1',
            name: 'App',
            slug: 'app',
            body_keyword: 'App Version',
            payload_extract_regex: null,
            sort_order: 10,
            active: true,
          },
        ],
      }),
    );

    const res = await POST(
      makeRequest({
        sender: 'no-reply@apple.com',
        subject: 'Review of your Skyline Runners submission is complete.',
        body: 'Body without the expected keyword',
        platform_id: PLATFORM_ID,
      }),
    );

    const body = (await res.json()) as {
      ok: true;
      data: { result: { status: string } };
    };
    expect(body.data.result.status).toBe('UNCLASSIFIED_TYPE');
  });

  it('CLASSIFIED when all steps match', async () => {
    const res = await POST(
      makeRequest({
        sender: 'no-reply@apple.com',
        subject: 'Review of your Skyline Runners submission is complete.',
        body: 'App Version\n2.4.1 for iOS',
        platform_id: PLATFORM_ID,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: {
        result: {
          status: string;
          app_id?: string;
          outcome?: string;
          type_payload?: Record<string, string>;
        };
        trace: unknown[];
      };
    };
    expect(body.data.result.status).toBe('CLASSIFIED');
    expect(body.data.result.app_id).toBe(APP_ID);
    expect(body.data.result.outcome).toBe('APPROVED');
    expect(body.data.result.type_payload).toEqual({ version: '2.4.1', os: 'iOS' });
    expect(body.data.trace).toHaveLength(5);
  });

  it('ERROR PARSE_ERROR when override_rules carries an RE2-incompatible regex (Manager debugging draft)', async () => {
    const res = await POST(
      makeRequest({
        sender: 'no-reply@apple.com',
        subject: 'Review of your X submission is complete.',
        body: 'App Version\n1.0 for iOS',
        platform_id: PLATFORM_ID,
        override_rules: {
          subject_patterns: [
            {
              outcome: 'APPROVED',
              // lookbehind — rejected by RE2
              regex: '(?<=Review )(?<app_name>.+)',
              priority: 10,
              active: true,
            },
          ],
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { result: { status: string; error_code?: string } };
    };
    expect(body.data.result.status).toBe('ERROR');
    expect(body.data.result.error_code).toBe('PARSE_ERROR');
  });
});

// ------------------------------------------------------------------
// override_rules — replace semantics
// ------------------------------------------------------------------

describe('POST — override_rules replace semantics', () => {
  beforeEach(() => {
    setManager();
    mockGetRulesSnapshot.mockResolvedValue(appleRules());
  });

  it('empty senders array wipes base senders → DROPPED', async () => {
    const res = await POST(
      makeRequest({
        sender: 'no-reply@apple.com', // would match base
        subject: 'x',
        body: 'x',
        platform_id: PLATFORM_ID,
        override_rules: { senders: [] },
      }),
    );
    const body = (await res.json()) as { ok: true; data: { result: { status: string } } };
    expect(body.data.result.status).toBe('DROPPED');
  });

  it('override types replaces base types entirely (no merge)', async () => {
    const res = await POST(
      makeRequest({
        sender: 'no-reply@apple.com',
        subject: 'Review of your Skyline Runners submission is complete.',
        body: 'CUSTOM KEYWORD\nhello',
        platform_id: PLATFORM_ID,
        override_rules: {
          types: [
            {
              name: 'Custom',
              slug: 'custom',
              body_keyword: 'CUSTOM KEYWORD',
              sort_order: 10,
              active: true,
            },
          ],
        },
      }),
    );
    const body = (await res.json()) as {
      ok: true;
      data: { result: { status: string; type_id?: string } };
    };
    expect(body.data.result.status).toBe('CLASSIFIED');
    // base type id would have been 't1' — override synthesizes 'type-override-0'
    expect(body.data.result.type_id).toBe('type-override-0');
  });

  it('undefined override section falls back to base', async () => {
    const res = await POST(
      makeRequest({
        sender: 'no-reply@apple.com',
        subject: 'Review of your Skyline Runners submission is complete.',
        body: 'App Version\n2.4.1 for iOS',
        platform_id: PLATFORM_ID,
        override_rules: { senders: undefined },
      }),
    );
    const body = (await res.json()) as { ok: true; data: { result: { status: string } } };
    expect(body.data.result.status).toBe('CLASSIFIED');
  });
});

// ------------------------------------------------------------------
// Zero side effects — the critical contract
// ------------------------------------------------------------------

describe('POST — zero side effects', () => {
  beforeEach(() => {
    setManager();
    mockGetRulesSnapshot.mockResolvedValue(appleRules());
  });

  it('never invokes storeDb().rpc() or storeDb().from() directly (only reads go through the mocked helper)', async () => {
    // Run all 5 outcome paths back-to-back.
    const commonBase = {
      sender: 'no-reply@apple.com',
      platform_id: PLATFORM_ID,
    };
    const scenarios = [
      { ...commonBase, sender: 'unknown@x', subject: 'x', body: 'x' }, // DROPPED
      { ...commonBase, subject: 'Weekly digest', body: 'x' }, // ERROR
      {
        ...commonBase,
        subject: 'Review of your Unknown submission is complete.',
        body: 'App Version\n1.0 for iOS',
      }, // UNCLASSIFIED_APP path (but apps_with_aliases is non-empty here so it does match)
      {
        ...commonBase,
        subject: 'Review of your Skyline Runners submission is complete.',
        body: 'no keyword',
      }, // UNCLASSIFIED_TYPE
      {
        ...commonBase,
        subject: 'Review of your Skyline Runners submission is complete.',
        body: 'App Version\n2.4.1 for iOS',
      }, // CLASSIFIED
    ];

    for (const s of scenarios) {
      const res = await POST(makeRequest(s));
      expect(res.status).toBe(200);
    }

    expect(mockStoreDbRpc).not.toHaveBeenCalled();
    expect(mockStoreDbFrom).not.toHaveBeenCalled();
  });
});
