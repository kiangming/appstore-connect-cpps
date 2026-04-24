import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  listTickets,
} from './tickets';

// --------------------------------------------------------------------------
// Mock builder — records every chainable call, terminates on await via
// `.then()`. Mirrors the surface area of the Supabase query chain used in
// `listTickets` / `getTicketWithEntries` without pulling in real PostgREST.
// --------------------------------------------------------------------------

interface MockCall {
  method: string;
  args: unknown[];
}

class MockBuilder {
  public calls: MockCall[] = [];
  constructor(
    private readonly result: { data?: unknown; error?: unknown; count?: number } = {
      data: [],
      error: null,
    },
  ) {}

  then<T>(resolve: (v: unknown) => T): T {
    return resolve(this.result);
  }
}

const CHAIN_METHODS = [
  'select',
  'eq',
  'in',
  'is',
  'not',
  'or',
  'order',
  'limit',
  'ilike',
  'gte',
  'lte',
] as const;

for (const m of CHAIN_METHODS) {
  (MockBuilder.prototype as unknown as Record<string, unknown>)[m] = function (
    this: MockBuilder,
    ...args: unknown[]
  ) {
    this.calls.push({ method: m, args });
    return this;
  };
}

(MockBuilder.prototype as unknown as Record<string, unknown>).maybeSingle = function (
  this: MockBuilder,
) {
  this.calls.push({ method: 'maybeSingle', args: [] });
  return Promise.resolve((this as unknown as { result: unknown }).result);
};

// --------------------------------------------------------------------------
// Mock storeDb — maintains a per-test FIFO queue of builders keyed by table.
// --------------------------------------------------------------------------

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock('../db', () => ({
  storeDb: () => ({ from: mockFrom }),
}));

type BuilderQueue = Map<string, MockBuilder[]>;

function registerBuilders(queue: BuilderQueue) {
  mockFrom.mockImplementation((table: string) => {
    const bucket = queue.get(table);
    if (!bucket || bucket.length === 0) {
      throw new Error(`[test] no more mock builders queued for table "${table}"`);
    }
    return bucket.shift()!;
  });
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    display_id: 'TK-001',
    app_id: '22222222-2222-2222-2222-222222222222',
    platform_id: '33333333-3333-3333-3333-333333333333',
    type_id: '44444444-4444-4444-4444-444444444444',
    state: 'NEW',
    latest_outcome: null,
    priority: 'NORMAL',
    assigned_to: null,
    type_payloads: [],
    submission_ids: [],
    opened_at: '2026-04-23T00:00:00Z',
    closed_at: null,
    resolution_type: null,
    due_date: null,
    created_at: '2026-04-23T00:00:00Z',
    updated_at: '2026-04-23T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockFrom.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ==========================================================================
// A — Cursor encode / decode (pure functions)
// ==========================================================================

describe('encodeCursor / decodeCursor', () => {
  it('roundtrips opened_at + id through base64url', () => {
    const opened_at = '2026-04-23T10:00:00Z';
    const id = 'abcd-1234';
    const cursor = encodeCursor(opened_at, id);

    // base64url: no padding `=`, no `+` or `/`
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ opened_at, id });
  });

  it('decodeCursor throws InvalidCursorError on non-base64 garbage', () => {
    expect(() => decodeCursor('@@@not-base64@@@')).toThrow(InvalidCursorError);
  });

  it('decodeCursor throws InvalidCursorError on missing fields', () => {
    const bad = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(InvalidCursorError);
  });

  it('decodeCursor throws InvalidCursorError on invalid opened_at date', () => {
    const bad = Buffer.from(
      JSON.stringify({ opened_at: 'not-a-date', id: 'x' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(InvalidCursorError);
  });
});

// ==========================================================================
// B — Cursor scope (only default sort supports keyset)
// ==========================================================================

describe('listTickets cursor/sort compatibility', () => {
  it('accepts cursor when sort=opened_at_desc', async () => {
    const queue: BuilderQueue = new Map([
      ['tickets', [new MockBuilder({ data: [], error: null })]],
    ]);
    registerBuilders(queue);

    const cursor = encodeCursor('2026-04-23T00:00:00Z', 'some-id');
    await expect(
      listTickets({ cursor, limit: 50, sort: 'opened_at_desc' }),
    ).resolves.toEqual({ tickets: [], next_cursor: null, has_more: false });
  });

  it('rejects cursor with non-default sort (InvalidCursorError)', async () => {
    // No builders needed — the error throws before any DB call.
    mockFrom.mockImplementation(() => {
      throw new Error('[test] from() should not be reached');
    });

    const cursor = encodeCursor('2026-04-23T00:00:00Z', 'some-id');
    await expect(
      listTickets({ cursor, limit: 50, sort: 'updated_at_desc' }),
    ).rejects.toThrow(InvalidCursorError);
  });
});

// ==========================================================================
// C — Filter logic
// ==========================================================================

describe('listTickets filters', () => {
  it('applies state array via .in("state", [...])', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    await listTickets({
      state: ['NEW', 'IN_REVIEW'],
      limit: 50,
      sort: 'opened_at_desc',
    });

    const stateCall = ticketsBuilder.calls.find((c) => c.method === 'in');
    expect(stateCall).toEqual({
      method: 'in',
      args: ['state', ['NEW', 'IN_REVIEW']],
    });
  });

  it('resolves platform_key via separate lookup then applies .eq("platform_id", ...)', async () => {
    const platformBuilder = new MockBuilder({
      data: { id: 'platform-apple-uuid' },
      error: null,
    });
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(
      new Map([
        ['platforms', [platformBuilder]],
        ['tickets', [ticketsBuilder]],
      ]),
    );

    await listTickets({
      platform_key: 'apple',
      limit: 50,
      sort: 'opened_at_desc',
    });

    // Platform lookup: .select('id').eq('key', 'apple').maybeSingle()
    expect(platformBuilder.calls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['key', 'apple'] },
        { method: 'maybeSingle', args: [] },
      ]),
    );

    // Tickets query: .eq('platform_id', 'platform-apple-uuid')
    expect(ticketsBuilder.calls).toEqual(
      expect.arrayContaining([{ method: 'eq', args: ['platform_id', 'platform-apple-uuid'] }]),
    );
  });

  it('short-circuits to empty result when platform_key is unknown', async () => {
    const platformBuilder = new MockBuilder({ data: null, error: null });
    registerBuilders(new Map([['platforms', [platformBuilder]]]));

    const result = await listTickets({
      platform_key: 'facebook',
      limit: 50,
      sort: 'opened_at_desc',
    });

    expect(result).toEqual({ tickets: [], next_cursor: null, has_more: false });
    // No tickets fetch attempted.
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith('platforms');
  });

  it('bucket=classified → NOT NULL on app_id AND type_id', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    await listTickets({ bucket: 'classified', limit: 50, sort: 'opened_at_desc' });

    const notCalls = ticketsBuilder.calls.filter((c) => c.method === 'not');
    expect(notCalls).toEqual([
      { method: 'not', args: ['app_id', 'is', null] },
      { method: 'not', args: ['type_id', 'is', null] },
    ]);
  });

  it('bucket=unclassified_app → IS NULL on app_id', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    await listTickets({
      bucket: 'unclassified_app',
      limit: 50,
      sort: 'opened_at_desc',
    });

    const isCalls = ticketsBuilder.calls.filter((c) => c.method === 'is');
    expect(isCalls).toEqual([{ method: 'is', args: ['app_id', null] }]);
  });

  it('bucket=unclassified_type → app_id NOT NULL AND type_id IS NULL', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    await listTickets({
      bucket: 'unclassified_type',
      limit: 50,
      sort: 'opened_at_desc',
    });

    const notCalls = ticketsBuilder.calls.filter((c) => c.method === 'not');
    const isCalls = ticketsBuilder.calls.filter((c) => c.method === 'is');
    expect(notCalls).toEqual([{ method: 'not', args: ['app_id', 'is', null] }]);
    expect(isCalls).toEqual([{ method: 'is', args: ['type_id', null] }]);
  });

  it('applies cursor as composite or() filter', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    const cursor = encodeCursor('2026-04-20T00:00:00Z', 'ticket-xyz');
    await listTickets({ cursor, limit: 50, sort: 'opened_at_desc' });

    const orCall = ticketsBuilder.calls.find((c) => c.method === 'or');
    expect(orCall).toBeDefined();
    expect(orCall!.args[0]).toBe(
      'opened_at.lt.2026-04-20T00:00:00Z,and(opened_at.eq.2026-04-20T00:00:00Z,id.lt.ticket-xyz)',
    );
  });
});

// ==========================================================================
// D — Pagination & has_more
// ==========================================================================

describe('listTickets pagination', () => {
  it('empty result → tickets=[], next_cursor=null, has_more=false', async () => {
    registerBuilders(
      new Map([['tickets', [new MockBuilder({ data: [], error: null })]]]),
    );

    const result = await listTickets({ limit: 50, sort: 'opened_at_desc' });
    expect(result).toEqual({ tickets: [], next_cursor: null, has_more: false });
  });

  it('exactly limit rows returned → has_more=false, next_cursor=null', async () => {
    // limit+1 fetch returns only `limit` rows ⇒ no more.
    const rows = [makeRow({ id: 'a', opened_at: '2026-04-20T00:00:00Z' })];
    const ticketsBuilder = new MockBuilder({ data: rows, error: null });
    const platformsBuilder = new MockBuilder({
      data: [{ id: '33333333-3333-3333-3333-333333333333', key: 'apple', display_name: 'Apple' }],
      error: null,
    });
    const appsBuilder = new MockBuilder({
      data: [{ id: '22222222-2222-2222-2222-222222222222', name: 'App', slug: 'app' }],
      error: null,
    });
    const typesBuilder = new MockBuilder({
      data: [{ id: '44444444-4444-4444-4444-444444444444', name: 'Type', slug: 'type' }],
      error: null,
    });
    const entriesBuilder = new MockBuilder({ data: [], error: null });

    registerBuilders(
      new Map([
        ['tickets', [ticketsBuilder]],
        ['apps', [appsBuilder]],
        ['types', [typesBuilder]],
        ['platforms', [platformsBuilder]],
        ['ticket_entries', [entriesBuilder]],
      ]),
    );

    const result = await listTickets({ limit: 1, sort: 'opened_at_desc' });
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
    expect(result.tickets).toHaveLength(1);
  });

  it('limit+1 rows returned → has_more=true, next_cursor=encoded last visible row', async () => {
    // Two rows fetched for limit=1 means there's a next page.
    const rows = [
      makeRow({ id: 'row-1', opened_at: '2026-04-22T00:00:00Z' }),
      makeRow({ id: 'row-2', opened_at: '2026-04-21T00:00:00Z' }),
    ];
    registerBuilders(
      new Map([
        ['tickets', [new MockBuilder({ data: rows, error: null })]],
        [
          'apps',
          [
            new MockBuilder({
              data: [{ id: '22222222-2222-2222-2222-222222222222', name: 'App', slug: 'app' }],
              error: null,
            }),
          ],
        ],
        [
          'types',
          [
            new MockBuilder({
              data: [{ id: '44444444-4444-4444-4444-444444444444', name: 'T', slug: 't' }],
              error: null,
            }),
          ],
        ],
        [
          'platforms',
          [
            new MockBuilder({
              data: [
                {
                  id: '33333333-3333-3333-3333-333333333333',
                  key: 'apple',
                  display_name: 'Apple',
                },
              ],
              error: null,
            }),
          ],
        ],
        ['ticket_entries', [new MockBuilder({ data: [], error: null })]],
      ]),
    );

    const result = await listTickets({ limit: 1, sort: 'opened_at_desc' });
    expect(result.has_more).toBe(true);
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0].id).toBe('row-1');

    // next_cursor encodes row-1 (the last visible row), not row-2 (the sentinel).
    expect(result.next_cursor).toBe(encodeCursor('2026-04-22T00:00:00Z', 'row-1'));
  });
});

// ==========================================================================
// E — Sort order
// ==========================================================================

describe('listTickets sort', () => {
  it('opened_at_desc → .order("opened_at", desc) then .order("id", desc)', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    await listTickets({ limit: 50, sort: 'opened_at_desc' });

    const orderCalls = ticketsBuilder.calls.filter((c) => c.method === 'order');
    expect(orderCalls).toEqual([
      { method: 'order', args: ['opened_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
    ]);
  });

  it('priority_desc → priority first, tiebreak opened_at then id', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    await listTickets({ limit: 50, sort: 'priority_desc' });

    const orderCalls = ticketsBuilder.calls.filter((c) => c.method === 'order');
    expect(orderCalls).toEqual([
      { method: 'order', args: ['priority', { ascending: false }] },
      { method: 'order', args: ['opened_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
    ]);
  });
});
