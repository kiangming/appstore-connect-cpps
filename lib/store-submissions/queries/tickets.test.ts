import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  getTicketWithEntries,
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
  it('roundtrips value + id + sort through base64url (opened_at_desc)', () => {
    const v = '2026-04-23T10:00:00Z';
    const id = 'abcd-1234';
    const cursor = encodeCursor(v, id, 'opened_at_desc');

    // base64url: no padding `=`, no `+` or `/`
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ v, id, s: 'opened_at_desc' });
  });

  it('roundtrips value + id + sort through base64url (updated_at_desc)', () => {
    const v = '2026-05-01T10:00:00Z';
    const id = 'wxyz-9999';
    const cursor = encodeCursor(v, id, 'updated_at_desc');

    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({ v, id, s: 'updated_at_desc' });
  });

  it('legacy {opened_at, id} cursor decodes as opened_at_desc (PR-17.1 backward compat)', () => {
    // Cursor minted by pre-PR-17.1 code — no `s` discriminator, uses
    // the old field name. We accept it gracefully so Manager bookmarks
    // and mid-flight pagination URLs survive the deploy.
    const legacy = Buffer.from(
      JSON.stringify({ opened_at: '2026-04-22T00:00:00Z', id: 'legacy-id' }),
      'utf8',
    ).toString('base64url');

    expect(decodeCursor(legacy)).toEqual({
      v: '2026-04-22T00:00:00Z',
      id: 'legacy-id',
      s: 'opened_at_desc',
    });
  });

  it('decodeCursor throws InvalidCursorError on non-base64 garbage', () => {
    expect(() => decodeCursor('@@@not-base64@@@')).toThrow(InvalidCursorError);
  });

  it('decodeCursor throws InvalidCursorError on missing fields', () => {
    const bad = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(InvalidCursorError);
  });

  it('decodeCursor throws InvalidCursorError on invalid date in v', () => {
    const bad = Buffer.from(
      JSON.stringify({ v: 'not-a-date', id: 'x', s: 'opened_at_desc' }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeCursor(bad)).toThrow(InvalidCursorError);
  });

  it('decodeCursor throws InvalidCursorError on unknown sort discriminator', () => {
    const bad = Buffer.from(
      JSON.stringify({
        v: '2026-04-22T00:00:00Z',
        id: 'x',
        s: 'priority_desc',
      }),
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

    const cursor = encodeCursor('2026-04-23T00:00:00Z', 'some-id', 'opened_at_desc');
    await expect(
      listTickets({ cursor, limit: 50, sort: 'opened_at_desc' }),
    ).resolves.toEqual({ tickets: [], next_cursor: null, has_more: false });
  });

  it('accepts cursor when sort=updated_at_desc (PR-17.1 keyset extension)', async () => {
    const queue: BuilderQueue = new Map([
      ['tickets', [new MockBuilder({ data: [], error: null })]],
    ]);
    registerBuilders(queue);

    const cursor = encodeCursor('2026-05-01T00:00:00Z', 'some-id', 'updated_at_desc');
    await expect(
      listTickets({ cursor, limit: 50, sort: 'updated_at_desc' }),
    ).resolves.toEqual({ tickets: [], next_cursor: null, has_more: false });
  });

  it('rejects cursor when its sort discriminator does not match active sort', async () => {
    // No builders needed — the error throws before any DB call.
    mockFrom.mockImplementation(() => {
      throw new Error('[test] from() should not be reached');
    });

    // Cursor encoded for opened_at_desc but caller is paginating
    // updated_at_desc — keysets are incompatible.
    const cursor = encodeCursor('2026-04-23T00:00:00Z', 'some-id', 'opened_at_desc');
    await expect(
      listTickets({ cursor, limit: 50, sort: 'updated_at_desc' }),
    ).rejects.toThrow(InvalidCursorError);
  });

  it('rejects cursor when sort is not a keyset-supporting sort', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('[test] from() should not be reached');
    });

    const cursor = encodeCursor('2026-04-23T00:00:00Z', 'some-id', 'opened_at_desc');
    await expect(
      listTickets({ cursor, limit: 50, sort: 'priority_desc' }),
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

  it('bucket=unclassified_any → .or("app_id.is.null,type_id.is.null")', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    await listTickets({
      bucket: 'unclassified_any',
      limit: 50,
      sort: 'opened_at_desc',
    });

    const orCalls = ticketsBuilder.calls.filter((c) => c.method === 'or');
    expect(orCalls).toEqual([
      { method: 'or', args: ['app_id.is.null,type_id.is.null'] },
    ]);
  });

  // -- PR-13 outcome filter --------------------------------------------------

  it('outcome=APPROVED → .eq("latest_outcome", "APPROVED")', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    await listTickets({ outcome: 'APPROVED', limit: 50, sort: 'opened_at_desc' });

    const eqCalls = ticketsBuilder.calls.filter((c) => c.method === 'eq');
    expect(eqCalls).toEqual(
      expect.arrayContaining([{ method: 'eq', args: ['latest_outcome', 'APPROVED'] }]),
    );
  });

  it('outcome="none" → .is("latest_outcome", null)', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    await listTickets({ outcome: 'none', limit: 50, sort: 'opened_at_desc' });

    const isCalls = ticketsBuilder.calls.filter((c) => c.method === 'is');
    expect(isCalls).toEqual([{ method: 'is', args: ['latest_outcome', null] }]);
  });

  it('omits outcome predicate when filter is absent', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    await listTickets({ limit: 50, sort: 'opened_at_desc' });

    const touchedOutcome = ticketsBuilder.calls.some(
      (c) =>
        (c.method === 'eq' || c.method === 'is') &&
        Array.isArray(c.args) &&
        c.args[0] === 'latest_outcome',
    );
    expect(touchedOutcome).toBe(false);
  });

  it('combines state + outcome (both filters AND together)', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    await listTickets({
      state: ['NEW', 'IN_REVIEW', 'REJECTED'],
      outcome: 'REJECTED',
      limit: 50,
      sort: 'opened_at_desc',
    });

    expect(ticketsBuilder.calls).toEqual(
      expect.arrayContaining([
        { method: 'in', args: ['state', ['NEW', 'IN_REVIEW', 'REJECTED']] },
        { method: 'eq', args: ['latest_outcome', 'REJECTED'] },
      ]),
    );
  });

  it('applies cursor as composite or() filter', async () => {
    const ticketsBuilder = new MockBuilder({ data: [], error: null });
    registerBuilders(new Map([['tickets', [ticketsBuilder]]]));

    const cursor = encodeCursor('2026-04-20T00:00:00Z', 'ticket-xyz', 'opened_at_desc');
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
    expect(result.next_cursor).toBe(
      encodeCursor('2026-04-22T00:00:00Z', 'row-1', 'opened_at_desc'),
    );
  });

  it('next_cursor uses updated_at value when sort=updated_at_desc (PR-17.1)', async () => {
    const rows = [
      makeRow({
        id: 'row-1',
        opened_at: '2026-04-22T00:00:00Z',
        updated_at: '2026-05-02T10:00:00Z',
      }),
      makeRow({
        id: 'row-2',
        opened_at: '2026-04-21T00:00:00Z',
        updated_at: '2026-05-02T09:00:00Z',
      }),
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

    const result = await listTickets({ limit: 1, sort: 'updated_at_desc' });
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBe(
      encodeCursor('2026-05-02T10:00:00Z', 'row-1', 'updated_at_desc'),
    );
  });
});

// ==========================================================================
// E — Sort order
// ==========================================================================

// ==========================================================================
// F — First-EMAIL hydration (includeFirstEmail option)
// ==========================================================================

describe('listTickets includeFirstEmail option', () => {
  function makeHydrationMocks(opts: {
    tickets: ReturnType<typeof makeRow>[];
    firstEmails?: Array<{
      ticket_id: string;
      metadata: unknown;
      created_at: string;
      email_message?: { ticket_id: string | null };
    }>;
  }) {
    const ticketsBuilder = new MockBuilder({ data: opts.tickets, error: null });
    const platformsBuilder = new MockBuilder({
      data: [
        { id: '33333333-3333-3333-3333-333333333333', key: 'apple', display_name: 'Apple' },
      ],
      error: null,
    });
    const appsBuilder = new MockBuilder({ data: [], error: null });
    const typesBuilder = new MockBuilder({ data: [], error: null });
    const entriesBuilder = new MockBuilder({ data: [], error: null });
    const firstEmailsBuilder = new MockBuilder({
      data: opts.firstEmails ?? [],
      error: null,
    });

    const queue = new Map<string, MockBuilder[]>([
      ['tickets', [ticketsBuilder]],
      ['apps', [appsBuilder]],
      ['types', [typesBuilder]],
      ['platforms', [platformsBuilder]],
      // Two ticket_entries calls when includeFirstEmail=true:
      // 1) entry_count aggregation (unconditional), 2) first-email per ticket.
      ['ticket_entries', [entriesBuilder, firstEmailsBuilder]],
    ]);

    return {
      queue,
      builders: {
        tickets: ticketsBuilder,
        firstEmails: firstEmailsBuilder,
      },
    };
  }

  it('skips the first-email fetch by default', async () => {
    registerBuilders(
      new Map([
        ['tickets', [new MockBuilder({ data: [], error: null })]],
      ]),
    );

    await listTickets({ limit: 50, sort: 'opened_at_desc' });

    // Only the tickets query hit — no join fan-out because pageRows.length===0.
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith('tickets');
  });

  it('omits first_email on rows when option is off', async () => {
    const row = makeRow({
      id: 'ticket-a',
      app_id: null,
      type_id: null,
    });
    const { queue } = makeHydrationMocks({ tickets: [row] });
    // Drop the firstEmailsBuilder since we won't request it.
    queue.set('ticket_entries', [new MockBuilder({ data: [], error: null })]);
    registerBuilders(queue);

    const result = await listTickets({ limit: 50, sort: 'opened_at_desc' });

    expect(result.tickets[0].first_email).toBeUndefined();
  });

  it('fetches EMAIL entries + hydrates first_email when option is on', async () => {
    const row = makeRow({
      id: 'ticket-a',
      app_id: null,
      type_id: null,
    });

    const { queue, builders } = makeHydrationMocks({
      tickets: [row],
      firstEmails: [
        {
          ticket_id: 'ticket-a',
          metadata: {
            email_snapshot: {
              subject: 'Your TestFlight build crashed',
              sender: 'no-reply@apple.com',
              received_at: '2026-04-22T10:00:00Z',
            },
          },
          created_at: '2026-04-22T10:00:05Z',
          email_message: { ticket_id: 'ticket-a' },
        },
      ],
    });
    registerBuilders(queue);

    const result = await listTickets(
      { limit: 50, sort: 'opened_at_desc' },
      { includeFirstEmail: true },
    );

    // Verify the extra query was configured correctly.
    const calls = builders.firstEmails.calls;
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['entry_type', 'EMAIL'] },
        { method: 'order', args: ['ticket_id', { ascending: true }] },
        { method: 'order', args: ['created_at', { ascending: true }] },
      ]),
    );

    // Verify the hydration worked end-to-end.
    expect(result.tickets[0].first_email).toEqual({
      subject: 'Your TestFlight build crashed',
      sender: 'no-reply@apple.com',
      received_at: '2026-04-22T10:00:00Z',
    });
  });

  it('picks earliest EMAIL per ticket when multiple rows match (first-write-wins)', async () => {
    const row = makeRow({ id: 'ticket-a', app_id: null, type_id: null });

    const { queue } = makeHydrationMocks({
      tickets: [row],
      firstEmails: [
        {
          ticket_id: 'ticket-a',
          metadata: {
            email_snapshot: { subject: 'First', sender: 'a@x.com' },
          },
          created_at: '2026-04-20T10:00:00Z',
          email_message: { ticket_id: 'ticket-a' },
        },
        {
          ticket_id: 'ticket-a',
          metadata: {
            email_snapshot: { subject: 'Second', sender: 'b@x.com' },
          },
          created_at: '2026-04-21T10:00:00Z',
          email_message: { ticket_id: 'ticket-a' },
        },
      ],
    });
    registerBuilders(queue);

    const result = await listTickets(
      { limit: 50, sort: 'opened_at_desc' },
      { includeFirstEmail: true },
    );

    expect(result.tickets[0].first_email?.subject).toBe('First');
  });
});

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

// ==========================================================================
// G — PR-15.5: stale-EMAIL filter (reclassify audit history hidden)
// --------------------------------------------------------------------------
// `reclassify_email_tx` deliberately leaves the original EMAIL entry on
// the old (UNCLASSIFIED) ticket as audit history per invariant #2 and
// inserts a fresh EMAIL entry on the new ticket. Without filtering at
// read time, the same email surfaces twice in the UI.
//
// Filter rule: an EMAIL entry on ticket X is "current" iff
// `email_message.ticket_id === X`. Non-EMAIL entries (STATE_CHANGE,
// COMMENT, PAYLOAD_ADDED) are unaffected.
// ==========================================================================

describe('getTicketWithEntries · stale-EMAIL filter (PR-15.5)', () => {
  const TICKET_ID = '11111111-1111-1111-1111-111111111111';
  const OTHER_TICKET_ID = '99999999-9999-9999-9999-999999999999';

  function setupTicketDetailMocks(opts: {
    ticketRow: ReturnType<typeof makeRow>;
    entries: Array<Record<string, unknown>>;
  }) {
    const ticketBuilder = new MockBuilder({ data: opts.ticketRow, error: null });
    const entriesBuilder = new MockBuilder({ data: opts.entries, error: null });
    const platformBuilder = new MockBuilder({
      data: {
        id: '33333333-3333-3333-3333-333333333333',
        key: 'apple',
        display_name: 'Apple',
      },
      error: null,
    });
    const appBuilder = new MockBuilder({ data: null, error: null });
    const typeBuilder = new MockBuilder({ data: null, error: null });
    const assigneeBuilder = new MockBuilder({ data: null, error: null });

    return new Map<string, MockBuilder[]>([
      ['tickets', [ticketBuilder]],
      ['ticket_entries', [entriesBuilder]],
      ['platforms', [platformBuilder]],
      ['apps', [appBuilder]],
      ['types', [typeBuilder]],
      ['users', [assigneeBuilder]],
    ]);
  }

  it('hides EMAIL entries whose email_message has since been reclassified out', async () => {
    const ticketRow = makeRow({
      id: TICKET_ID,
      app_id: null,
      type_id: null,
    });

    // Fixture order mirrors what PostgREST returns under
    // `.order('created_at', { ascending: false })` (PR-17.2): newest
    // first. The mock builder echoes the array as-is — it does not
    // re-sort — so seeding in the production sort order keeps the
    // test honest about the contract callers actually see.
    const queue = setupTicketDetailMocks({
      ticketRow,
      entries: [
        // STATE_CHANGE 'reclassify_out': newest (11:00:01). Audit
        // annotation that should stay visible regardless of any
        // email_message embed (EMAIL filter must not affect non-EMAIL
        // entries).
        {
          id: 'entry-reclassify-out',
          ticket_id: TICKET_ID,
          entry_type: 'STATE_CHANGE',
          author_user_id: null,
          content: null,
          metadata: { type: 'reclassify_out' },
          email_message_id: 'email-stale',
          attachment_refs: null,
          edited_at: null,
          created_at: '2026-04-23T11:00:01Z',
          email_message: { ticket_id: OTHER_TICKET_ID },
        },
        // STALE EMAIL: same row's email has since been reclassified to
        // OTHER_TICKET_ID. Should be filtered out (11:00:00).
        {
          id: 'entry-stale-email',
          ticket_id: TICKET_ID,
          entry_type: 'EMAIL',
          author_user_id: null,
          content: null,
          metadata: { email_snapshot: { subject: 'reclassified out' } },
          email_message_id: 'email-stale',
          attachment_refs: null,
          edited_at: null,
          created_at: '2026-04-23T11:00:00Z',
          email_message: { ticket_id: OTHER_TICKET_ID },
        },
        // CURRENT EMAIL: oldest (10:00:00), still attached to
        // TICKET_ID. Should be visible.
        {
          id: 'entry-current-email',
          ticket_id: TICKET_ID,
          entry_type: 'EMAIL',
          author_user_id: null,
          content: null,
          metadata: { email_snapshot: { subject: 'still here' } },
          email_message_id: 'email-current',
          attachment_refs: null,
          edited_at: null,
          created_at: '2026-04-23T10:00:00Z',
          email_message: { ticket_id: TICKET_ID },
        },
      ],
    });
    registerBuilders(queue);

    const result = await getTicketWithEntries(TICKET_ID);

    expect(result).not.toBeNull();
    const entryIds = result!.entries.map((e) => e.id);
    // PR-17.2: entries returned in DESC order (newest first), so
    // `entry-reclassify-out` (11:00:01) precedes `entry-current-email`
    // (10:00:00). The stale `entry-stale-email` (11:00:00) is filtered
    // out regardless of sort direction.
    expect(entryIds).toEqual(['entry-reclassify-out', 'entry-current-email']);
    expect(entryIds).not.toContain('entry-stale-email');
  });

  it('also hides EMAIL entries whose email_message.ticket_id is null (DROPPED reclassify)', async () => {
    const ticketRow = makeRow({ id: TICKET_ID, app_id: null, type_id: null });

    const queue = setupTicketDetailMocks({
      ticketRow,
      entries: [
        {
          id: 'entry-dropped-email',
          ticket_id: TICKET_ID,
          entry_type: 'EMAIL',
          author_user_id: null,
          content: null,
          metadata: { email_snapshot: { subject: 'dropped' } },
          email_message_id: 'email-dropped',
          attachment_refs: null,
          edited_at: null,
          created_at: '2026-04-23T10:00:00Z',
          email_message: { ticket_id: null },
        },
      ],
    });
    registerBuilders(queue);

    const result = await getTicketWithEntries(TICKET_ID);
    expect(result!.entries).toHaveLength(0);
  });

  it('keeps EMAIL entries when email_message.ticket_id matches (regression — normal case unchanged)', async () => {
    const ticketRow = makeRow({
      id: TICKET_ID,
      app_id: '22222222-2222-2222-2222-222222222222',
      type_id: '44444444-4444-4444-4444-444444444444',
    });

    const queue = setupTicketDetailMocks({
      ticketRow,
      entries: [
        {
          id: 'entry-classified-email',
          ticket_id: TICKET_ID,
          entry_type: 'EMAIL',
          author_user_id: null,
          content: null,
          metadata: { email_snapshot: { subject: 'normal' } },
          email_message_id: 'email-classified',
          attachment_refs: null,
          edited_at: null,
          created_at: '2026-04-23T10:00:00Z',
          email_message: { ticket_id: TICKET_ID },
        },
      ],
    });
    queue.set('apps', [
      new MockBuilder({
        data: { id: '22222222-2222-2222-2222-222222222222', name: 'App', slug: 'app' },
        error: null,
      }),
    ]);
    queue.set('types', [
      new MockBuilder({
        data: { id: '44444444-4444-4444-4444-444444444444', name: 'Type', slug: 'type' },
        error: null,
      }),
    ]);
    registerBuilders(queue);

    const result = await getTicketWithEntries(TICKET_ID);
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0].id).toBe('entry-classified-email');
  });
});

describe('listTickets · stale-EMAIL filter on first_email preview (PR-15.5)', () => {
  const TICKET_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const TICKET_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  it('skips stale rows when picking earliest current EMAIL per ticket', async () => {
    // Ticket A is the catch-all. It has TWO EMAIL entries:
    //   1. earliest, but reclassified out (email_message.ticket_id = TICKET_B)
    //   2. later, still attached (email_message.ticket_id = TICKET_A)
    // The filter must skip (1) and pick (2) as the preview.
    const rowA = makeRow({ id: TICKET_A, app_id: null, type_id: null });
    const ticketsBuilder = new MockBuilder({ data: [rowA], error: null });
    const platformsBuilder = new MockBuilder({
      data: [
        { id: '33333333-3333-3333-3333-333333333333', key: 'apple', display_name: 'Apple' },
      ],
      error: null,
    });
    const entryCountsBuilder = new MockBuilder({ data: [], error: null });
    const firstEmailsBuilder = new MockBuilder({
      data: [
        {
          ticket_id: TICKET_A,
          metadata: { email_snapshot: { subject: 'reclassified out earlier' } },
          created_at: '2026-04-22T10:00:00Z',
          email_message: { ticket_id: TICKET_B },
        },
        {
          ticket_id: TICKET_A,
          metadata: { email_snapshot: { subject: 'still attached' } },
          created_at: '2026-04-22T11:00:00Z',
          email_message: { ticket_id: TICKET_A },
        },
      ],
      error: null,
    });

    registerBuilders(
      new Map([
        ['tickets', [ticketsBuilder]],
        ['apps', [new MockBuilder({ data: [], error: null })]],
        ['types', [new MockBuilder({ data: [], error: null })]],
        ['platforms', [platformsBuilder]],
        ['ticket_entries', [entryCountsBuilder, firstEmailsBuilder]],
      ]),
    );

    const result = await listTickets(
      { limit: 50, sort: 'opened_at_desc' },
      { includeFirstEmail: true },
    );

    expect(result.tickets[0].first_email?.subject).toBe('still attached');
  });

  it('returns first_email=null when every EMAIL entry on the ticket is stale', async () => {
    const rowA = makeRow({ id: TICKET_A, app_id: null, type_id: null });
    const ticketsBuilder = new MockBuilder({ data: [rowA], error: null });
    const platformsBuilder = new MockBuilder({
      data: [
        { id: '33333333-3333-3333-3333-333333333333', key: 'apple', display_name: 'Apple' },
      ],
      error: null,
    });
    const entryCountsBuilder = new MockBuilder({ data: [], error: null });
    const firstEmailsBuilder = new MockBuilder({
      data: [
        {
          ticket_id: TICKET_A,
          metadata: { email_snapshot: { subject: 'all reclassified out' } },
          created_at: '2026-04-22T10:00:00Z',
          email_message: { ticket_id: TICKET_B },
        },
      ],
      error: null,
    });

    registerBuilders(
      new Map([
        ['tickets', [ticketsBuilder]],
        ['apps', [new MockBuilder({ data: [], error: null })]],
        ['types', [new MockBuilder({ data: [], error: null })]],
        ['platforms', [platformsBuilder]],
        ['ticket_entries', [entryCountsBuilder, firstEmailsBuilder]],
      ]),
    );

    const result = await listTickets(
      { limit: 50, sort: 'opened_at_desc' },
      { includeFirstEmail: true },
    );

    expect(result.tickets[0].first_email).toBeNull();
  });
});
