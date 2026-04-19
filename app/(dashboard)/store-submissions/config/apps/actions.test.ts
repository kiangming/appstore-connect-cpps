import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';
const ALIAS_UUID = '33333333-3333-4333-8333-333333333333';

// === Hoisted mocks ===

const {
  mockGetServerSession,
  mockRevalidatePath,
  mockRpc,
  mockFrom,
  mockRequireStoreRole,
  mockListAliasesForApp,
  mockCountOpenTickets,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockRequireStoreRole: vi.fn(),
  mockListAliasesForApp: vi.fn(),
  mockCountOpenTickets: vi.fn(),
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
  storeDb: () => ({ from: mockFrom, rpc: mockRpc }),
}));

vi.mock('@/lib/store-submissions/queries/apps', () => ({
  listAliasesForApp: mockListAliasesForApp,
  countOpenTicketsForApp: mockCountOpenTickets,
}));

// === Imports AFTER mocks ===

import { StoreForbiddenError, StoreUnauthorizedError } from '@/lib/store-submissions/auth';
import {
  addAliasAction,
  createAppAction,
  deleteAppAction,
  exportAppsCsvAction,
  importAppsCsvAction,
  removeAliasAction,
  removePlatformBindingAction,
  renameAppAction,
  setPlatformBindingAction,
  updateAppAction,
} from './actions';

// === Helpers ===

function setSessionManager() {
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

function setSessionDev() {
  mockGetServerSession.mockResolvedValue({ user: { email: 'dev@company.com' } });
  mockRequireStoreRole.mockRejectedValue(
    new StoreForbiddenError('Required role: MANAGER. Current role: DEV.'),
  );
}

/**
 * Route each .from(table) call through a dispatcher. Tests register handlers
 * per table so they can shape the chain independently of each other.
 */
type TableHandler = () => unknown;
const tableHandlers = new Map<string, TableHandler>();

function onTable(name: string, handler: TableHandler): void {
  tableHandlers.set(name, handler);
}

function resetFromDispatcher(): void {
  tableHandlers.clear();
  mockFrom.mockImplementation((name: string) => {
    const h = tableHandlers.get(name);
    if (!h) throw new Error(`No handler registered for table "${name}"`);
    return h();
  });
}

beforeEach(() => {
  mockGetServerSession.mockReset();
  mockRequireStoreRole.mockReset();
  mockRevalidatePath.mockReset();
  mockRpc.mockReset();
  mockFrom.mockReset();
  mockListAliasesForApp.mockReset();
  mockCountOpenTickets.mockReset();
  resetFromDispatcher();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// Authorization — every action guards MANAGER (except export: MANAGER/DEV/VIEWER)
// ============================================================

describe('authorization', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['createAppAction', () => createAppAction({ name: 'X' })],
    ['updateAppAction', () => updateAppAction({ id: VALID_UUID, active: false })],
    ['renameAppAction', () => renameAppAction({ id: VALID_UUID, new_name: 'X' })],
    ['deleteAppAction', () => deleteAppAction({ id: VALID_UUID })],
    ['addAliasAction', () => addAliasAction({ app_id: VALID_UUID, alias_text: 'X', source_type: 'MANUAL' })],
    ['removeAliasAction', () => removeAliasAction({ id: VALID_UUID })],
    ['setPlatformBindingAction', () => setPlatformBindingAction({ app_id: VALID_UUID, platform: 'apple' })],
    ['removePlatformBindingAction', () => removePlatformBindingAction({ app_id: VALID_UUID, platform: 'apple' })],
    ['importAppsCsvAction', () => importAppsCsvAction({ csv_text: 'name,active\nX,true', confirm: false })],
  ])('%s returns UNAUTHORIZED when no session', async (_, run) => {
    setNoSession();
    const result = (await run()) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNAUTHORIZED');
  });

  it.each<[string, () => Promise<unknown>]>([
    ['createAppAction', () => createAppAction({ name: 'X' })],
    ['renameAppAction', () => renameAppAction({ id: VALID_UUID, new_name: 'X' })],
    ['deleteAppAction', () => deleteAppAction({ id: VALID_UUID })],
    ['addAliasAction', () => addAliasAction({ app_id: VALID_UUID, alias_text: 'X', source_type: 'MANUAL' })],
  ])('%s returns FORBIDDEN when caller is DEV', async (_, run) => {
    setSessionDev();
    const result = (await run()) as { ok: boolean; error?: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
  });

  it('exportAppsCsvAction allows VIEWER role', async () => {
    mockGetServerSession.mockResolvedValue({ user: { email: 'viewer@company.com' } });
    mockRequireStoreRole.mockResolvedValue({
      id: 'v-1',
      email: 'viewer@company.com',
      role: 'VIEWER',
      status: 'active',
    });
    const emptyArray = Promise.resolve({ data: [], error: null });
    onTable('apps', () => ({
      select: () => ({ order: () => emptyArray }),
    }));
    onTable('app_aliases', () => ({ select: () => ({ in: () => emptyArray }) }));
    onTable('app_platform_bindings', () => ({ select: () => emptyArray }));
    onTable('platforms', () => ({ select: () => emptyArray }));
    onTable('users', () => ({ select: () => emptyArray }));

    const result = await exportAppsCsvAction();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.csv.split('\n')[0]).toContain('name,display_name,aliases');
      expect(result.data.filename).toMatch(/^app-registry-\d{4}-\d{2}-\d{2}\.csv$/);
    }
  });
});

// ============================================================
// createAppAction
// ============================================================

describe('createAppAction', () => {
  beforeEach(setSessionManager);

  it('rejects empty name (VALIDATION)', async () => {
    const result = await createAppAction({ name: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects name that produces no slug (VALIDATION via InvalidSlugError)', async () => {
    onTable('apps', () => ({ select: () => ({ or: () => Promise.resolve({ data: [], error: null }) }) }));
    const result = await createAppAction({ name: '!!!' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
  });

  it('auto-generates slug from name and dispatches RPC', async () => {
    onTable('apps', () => ({
      select: () => ({ or: () => Promise.resolve({ data: [], error: null }) }),
    }));
    mockRpc.mockResolvedValueOnce({ data: VALID_UUID, error: null });

    const result = await createAppAction({
      name: 'Skyline Runners',
      platform_bindings: [{ platform: 'apple', platform_ref: 'com.studio.skyline' }],
    });

    expect(result).toEqual({ ok: true, data: { id: VALID_UUID, slug: 'skyline-runners' } });
    expect(mockRpc).toHaveBeenCalledWith('create_app_tx', expect.objectContaining({
      p_slug: 'skyline-runners',
      p_name: 'Skyline Runners',
      p_platform_bindings: [
        { platform_key: 'apple', platform_ref: 'com.studio.skyline', console_url: null },
      ],
    }));
    expect(mockRevalidatePath).toHaveBeenCalledWith('/store-submissions/config/apps');
  });

  it('suggests -2 suffix when the base slug is already taken', async () => {
    onTable('apps', () => ({
      select: () => ({
        or: () => Promise.resolve({
          data: [{ slug: 'skyline-runners' }],
          error: null,
        }),
      }),
    }));
    mockRpc.mockResolvedValueOnce({ data: VALID_UUID, error: null });

    const result = await createAppAction({ name: 'Skyline Runners' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.slug).toBe('skyline-runners-2');
  });

  it('retries with next slug on SLUG_TAKEN RPC race (23505 path)', async () => {
    // Probe 1: base taken → suggest -2. RPC returns SLUG_TAKEN (concurrent insert).
    // Probe 2: base + -2 taken → suggest -3. RPC succeeds.
    const dbState: string[] = ['skyline-runners'];
    onTable('apps', () => ({
      select: () => ({
        or: () => Promise.resolve({
          data: dbState.map((s) => ({ slug: s })),
          error: null,
        }),
      }),
    }));
    mockRpc
      .mockImplementationOnce(() => {
        dbState.push('skyline-runners-2');
        return Promise.resolve({ data: null, error: { message: 'SLUG_TAKEN: ...' } });
      })
      .mockImplementationOnce(() => Promise.resolve({ data: VALID_UUID, error: null }));

    const result = await createAppAction({ name: 'Skyline Runners' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.slug).toBe('skyline-runners-3');
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('maps UNKNOWN_PLATFORM from RPC error', async () => {
    onTable('apps', () => ({
      select: () => ({ or: () => Promise.resolve({ data: [], error: null }) }),
    }));
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'UNKNOWN_PLATFORM: "nintendo" is not a registered platform' },
    });

    const result = await createAppAction({
      name: 'X',
      platform_bindings: [{ platform: 'apple' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_PLATFORM');
  });
});

// ============================================================
// renameAppAction
// ============================================================

describe('renameAppAction', () => {
  beforeEach(setSessionManager);

  it('returns empty changes when name is unchanged (noop)', async () => {
    onTable('apps', () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { name: 'Skyline' }, error: null }) }) }),
    }));
    mockListAliasesForApp.mockResolvedValueOnce([]);

    const result = await renameAppAction({ id: VALID_UUID, new_name: 'Skyline' });

    expect(result).toEqual({ ok: true, data: { changes: [] } });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when app does not exist', async () => {
    onTable('apps', () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    }));
    const result = await renameAppAction({ id: VALID_UUID, new_name: 'Whatever' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('dispatches a PROMOTE change when a manual alias already matches the new name', async () => {
    onTable('apps', () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { name: 'Skyline' }, error: null }) }) }),
    }));
    mockListAliasesForApp.mockResolvedValueOnce([
      {
        id: 'a-current',
        app_id: VALID_UUID,
        alias_text: 'Skyline',
        alias_regex: null,
        source_type: 'AUTO_CURRENT',
        previous_name: null,
        created_at: '2026-01-01',
      },
      {
        id: 'a-manual',
        app_id: VALID_UUID,
        alias_text: 'Skyline Runners',
        alias_regex: null,
        source_type: 'MANUAL',
        previous_name: null,
        created_at: '2026-01-01',
      },
    ]);
    mockRpc.mockResolvedValueOnce({ data: 'Skyline Runners', error: null });

    const result = await renameAppAction({ id: VALID_UUID, new_name: 'Skyline Runners' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.changes).toEqual([
        { kind: 'DEMOTE', aliasId: 'a-current', previousName: 'Skyline' },
        { kind: 'PROMOTE', aliasId: 'a-manual' },
      ]);
    }
    expect(mockRpc).toHaveBeenCalledWith('rename_app_tx', expect.objectContaining({
      p_app_id: VALID_UUID,
      p_new_name: 'Skyline Runners',
      p_changes: expect.arrayContaining([
        expect.objectContaining({ kind: 'PROMOTE' }),
      ]),
    }));
  });

  it('maps ALIAS_MISSING from RPC into a NOT_FOUND result', async () => {
    onTable('apps', () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { name: 'Old' }, error: null }) }) }),
    }));
    mockListAliasesForApp.mockResolvedValueOnce([
      {
        id: 'a-current',
        app_id: VALID_UUID,
        alias_text: 'Old',
        alias_regex: null,
        source_type: 'AUTO_CURRENT',
        previous_name: null,
        created_at: '2026-01-01',
      },
    ]);
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'ALIAS_MISSING: alias not found under app' },
    });

    const result = await renameAppAction({ id: VALID_UUID, new_name: 'New' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });
});

// ============================================================
// deleteAppAction
// ============================================================

describe('deleteAppAction', () => {
  beforeEach(setSessionManager);

  it('soft-archives (active=false) by default', async () => {
    mockCountOpenTickets.mockResolvedValueOnce(0);
    onTable('apps', () => ({
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }));
    const result = await deleteAppAction({ id: VALID_UUID });
    expect(result.ok).toBe(true);
  });

  it('blocks hard-delete when the app has open tickets', async () => {
    mockCountOpenTickets.mockResolvedValueOnce(3);
    const result = await deleteAppAction({ id: VALID_UUID, hard: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('APP_HAS_TICKETS');
      expect(result.error.message).toContain('3');
    }
  });

  it('hard-deletes when no open tickets', async () => {
    mockCountOpenTickets.mockResolvedValueOnce(0);
    onTable('apps', () => ({
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }));
    const result = await deleteAppAction({ id: VALID_UUID, hard: true });
    expect(result.ok).toBe(true);
  });
});

// ============================================================
// Aliases — last AUTO_CURRENT protection
// ============================================================

describe('removeAliasAction', () => {
  beforeEach(setSessionManager);

  it('refuses to remove the last AUTO_CURRENT alias', async () => {
    const reads = {
      first: Promise.resolve({
        data: { app_id: OTHER_UUID, source_type: 'AUTO_CURRENT' },
        error: null,
      }),
      count: Promise.resolve({ count: 1, error: null }),
    };
    let callNo = 0;
    onTable('app_aliases', () => {
      callNo++;
      if (callNo === 1) {
        return { select: () => ({ eq: () => ({ maybeSingle: () => reads.first }) }) };
      }
      // count query with head:true returns the count in the promise resolution
      return {
        select: () => ({
          eq: () => ({
            eq: () => reads.count,
          }),
        }),
      };
    });

    const result = await removeAliasAction({ id: ALIAS_UUID });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.message).toContain('AUTO_CURRENT');
    }
  });

  it('deletes a MANUAL alias without counting AUTO_CURRENT rows', async () => {
    onTable('app_aliases', () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({
            data: { app_id: OTHER_UUID, source_type: 'MANUAL' },
            error: null,
          }),
        }),
      }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }));

    const result = await removeAliasAction({ id: ALIAS_UUID });
    expect(result.ok).toBe(true);
  });
});

describe('addAliasAction', () => {
  beforeEach(setSessionManager);

  it('rejects when neither alias_text nor alias_regex is provided (VALIDATION)', async () => {
    const result = await addAliasAction({ app_id: VALID_UUID, source_type: 'MANUAL' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
  });

  it('maps 23505 unique violation to ALIAS_DUPLICATE', async () => {
    onTable('app_aliases', () => ({
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({
            data: null,
            error: { code: '23505', message: 'duplicate' },
          }),
        }),
      }),
    }));
    const result = await addAliasAction({
      app_id: VALID_UUID,
      alias_text: 'Skyline',
      source_type: 'MANUAL',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ALIAS_DUPLICATE');
  });
});

// ============================================================
// Platform bindings
// ============================================================

describe('setPlatformBindingAction', () => {
  beforeEach(setSessionManager);

  it('returns UNKNOWN_PLATFORM when key is not in store_mgmt.platforms', async () => {
    onTable('platforms', () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    }));
    const result = await setPlatformBindingAction({ app_id: VALID_UUID, platform: 'apple' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_PLATFORM');
  });

  it('upserts binding with resolved platform_id', async () => {
    const upsertSpy = vi.fn(() => Promise.resolve({ error: null }));
    onTable('platforms', () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'plat-apple' }, error: null }) }) }),
    }));
    onTable('app_platform_bindings', () => ({ upsert: upsertSpy }));

    const result = await setPlatformBindingAction({
      app_id: VALID_UUID,
      platform: 'apple',
      platform_ref: 'com.studio.x',
    });

    expect(result.ok).toBe(true);
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        app_id: VALID_UUID,
        platform_id: 'plat-apple',
        platform_ref: 'com.studio.x',
        console_url: null,
      }),
      { onConflict: 'app_id,platform_id' },
    );
  });
});

// ============================================================
// CSV import — 2-step preview / commit
// ============================================================

describe('importAppsCsvAction', () => {
  beforeEach(setSessionManager);

  it('rejects CSV larger than 2MB (CSV_FATAL)', async () => {
    const big = 'name,active\n' + 'x,true\n'.repeat(1);
    const huge = big + 'x'.repeat(3 * 1024 * 1024);
    const result = await importAppsCsvAction({ csv_text: huge, confirm: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CSV_FATAL');
  });

  it('preview mode returns existing_slugs and row-level errors without touching RPC', async () => {
    onTable('apps', () => ({
      select: () => ({ in: () => Promise.resolve({ data: [{ slug: 'dragon-guild' }], error: null }) }),
    }));
    onTable('users', () => ({
      select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }),
    }));

    const csv = [
      'name,active',
      'Skyline Runners,true',
      'Dragon Guild,true',
      ',true', // invalid: empty name
    ].join('\n');

    const result = await importAppsCsvAction({ csv_text: csv, confirm: false });
    expect(result.ok).toBe(true);
    if (result.ok && result.data.mode === 'preview') {
      expect(result.data.existing_slugs).toContain('dragon-guild');
      expect(result.data.error_rows.length).toBeGreaterThan(0);
    } else {
      throw new Error('expected preview mode');
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('commit mode dispatches import_apps_csv_tx with resolved owner + platform bindings', async () => {
    onTable('apps', () => ({
      select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }),
    }));
    onTable('users', () => ({
      select: () => ({
        in: () => Promise.resolve({
          data: [{ id: 'user-linh', email: 'linh@company.com' }],
          error: null,
        }),
      }),
    }));
    mockRpc.mockResolvedValueOnce({
      data: {
        created: [{ rowNumber: 1, app_id: VALID_UUID, slug: 'skyline-runners' }],
        skipped: [],
        errors: [],
      },
      error: null,
    });

    const csv = [
      'name,display_name,aliases,apple_bundle_id,google_package_name,huawei_app_id,facebook_app_id,team_owner_email,active',
      'Skyline Runners,,Skyline|SKY,com.studio.skyline,,,9284715620,linh@company.com,true',
    ].join('\n');

    const result = await importAppsCsvAction({
      csv_text: csv,
      confirm: true,
      strategy: 'SKIP_EXISTING',
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.data.mode === 'commit') {
      expect(result.data.created).toHaveLength(1);
    } else {
      throw new Error('expected commit mode');
    }
    const rpcCall = mockRpc.mock.calls[0];
    expect(rpcCall[0]).toBe('import_apps_csv_tx');
    const rows = (rpcCall[1] as { p_rows: Array<Record<string, unknown>> }).p_rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: 'skyline-runners',
      name: 'Skyline Runners',
      team_owner_id: 'user-linh',
      platform_bindings: [
        { platform_key: 'apple', platform_ref: 'com.studio.skyline' },
        { platform_key: 'facebook', platform_ref: '9284715620' },
      ],
    });
  });

  it('surfaces CSV_FATAL when the header is missing required columns', async () => {
    const result = await importAppsCsvAction({
      csv_text: 'slug,other\nfoo,bar',
      confirm: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CSV_FATAL');
  });
});

// ============================================================
// updateAppAction — non-name patch only
// ============================================================

describe('updateAppAction', () => {
  beforeEach(setSessionManager);

  it('applies display_name + active without touching name', async () => {
    const updateSpy = vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) }));
    onTable('apps', () => ({ update: updateSpy }));

    const result = await updateAppAction({
      id: VALID_UUID,
      display_name: 'New Display',
      active: false,
      name: 'ignored here — goes through renameAppAction',
    });

    expect(result.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledWith({
      display_name: 'New Display',
      active: false,
    });
  });

  it('is a no-op when no patchable fields are present', async () => {
    const updateSpy = vi.fn();
    onTable('apps', () => ({ update: updateSpy }));
    const result = await updateAppAction({ id: VALID_UUID });
    expect(result.ok).toBe(true);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('maps 23505 on slug update to SLUG_TAKEN', async () => {
    onTable('apps', () => ({
      update: () => ({
        eq: () => Promise.resolve({ error: { code: '23505', message: 'dup slug' } }),
      }),
    }));
    const result = await updateAppAction({ id: VALID_UUID, slug: 'existing-slug' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SLUG_TAKEN');
  });
});
