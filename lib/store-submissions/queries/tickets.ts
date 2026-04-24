/**
 * Server-side read queries for Store Management tickets.
 *
 * Read-only, safe to call from Server Components or Server Actions.
 * Mutations live in Server Actions under
 *   app/(dashboard)/store-submissions/inbox/actions.ts
 *   app/(dashboard)/store-submissions/tickets/[id]/actions.ts
 * (both land in PR-10c).
 *
 * Returned shapes denormalize joined entities (app / platform / type /
 * assignee) so the Inbox list and detail renderers can consume a single
 * payload without secondary lookups.
 *
 * Pagination model:
 *   - Cursor-based keyset on `(opened_at DESC, id DESC)` per spec §A.8.
 *   - Cursor is an opaque base64url-encoded JSON string — validated as
 *     `z.string()` at the schema boundary, decoded here.
 *   - Cursor is **only honored for the default sort** (`opened_at_desc`).
 *     For `updated_at_desc` / `priority_desc`, we return all rows up to
 *     `limit` with `next_cursor: null` — passing a cursor with a
 *     non-default sort throws `InvalidCursorError`. Rationale: keyset
 *     keys must match the sort; supporting multi-sort cursors adds
 *     complexity with no MVP payoff (total row count stays <5k).
 */

import { storeDb } from '../db';
import type { TicketRow } from '../tickets/types';
import type {
  TicketBucket,
  TicketEntryType,
  TicketOutcome,
  TicketPriority,
  TicketSort,
  TicketState,
  TicketsQuery,
} from '../schemas/ticket';

// -- Returned shapes --------------------------------------------------------

/**
 * Denormalized row for the Inbox list view. Fields joined eagerly so the
 * client can render without secondary fetches.
 *
 * Nullability reflects grouping-key matrix (invariant #8):
 *   - app_id / app_* → null for UNCLASSIFIED_APP bucket
 *   - type_id / type_* → null for UNCLASSIFIED_TYPE bucket
 *   - assigned_to / assigned_to_* → null when unassigned
 */
export interface TicketListRow {
  id: string;
  display_id: string;
  state: TicketState;
  latest_outcome: TicketOutcome | null;
  priority: TicketPriority;
  opened_at: string;
  updated_at: string;
  closed_at: string | null;
  due_date: string | null;

  app_id: string | null;
  app_name: string | null;
  app_slug: string | null;

  type_id: string | null;
  type_name: string | null;
  type_slug: string | null;

  platform_id: string;
  platform_key: string;
  platform_display_name: string;

  assigned_to: string | null;
  assigned_to_display_name: string | null;
  assigned_to_email: string | null;

  entry_count: number;
  submission_ids: string[];
  type_payload_count: number;
}

export interface ListTicketsResult {
  tickets: TicketListRow[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface TicketEntryRow {
  id: string;
  ticket_id: string;
  entry_type: TicketEntryType;
  author_user_id: string | null;
  author_display_name: string | null;
  author_email: string | null;
  content: string | null;
  metadata: Record<string, unknown>;
  email_message_id: string | null;
  attachment_refs: unknown[];
  edited_at: string | null;
  created_at: string;
}

export interface TicketWithEntries {
  ticket: TicketRow;
  entries: TicketEntryRow[];
  app: { id: string; name: string; slug: string } | null;
  type: { id: string; name: string; slug: string } | null;
  platform: { id: string; key: string; display_name: string };
  assignee: { id: string; display_name: string | null; email: string } | null;
}

// -- Cursor helpers ---------------------------------------------------------

export class InvalidCursorError extends Error {
  constructor(message = 'Cursor is malformed or incompatible with sort') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

interface DecodedCursor {
  opened_at: string;
  id: string;
}

/**
 * Encode the keyset tuple `(opened_at, id)` as base64url. Exposed for
 * test visibility — production callers only see `next_cursor: string`.
 */
export function encodeCursor(opened_at: string, id: string): string {
  return Buffer.from(JSON.stringify({ opened_at, id }), 'utf8').toString('base64url');
}

/**
 * Decode and validate shape. Throws InvalidCursorError on any parse
 * failure or missing fields — callers should surface this as a 400.
 */
export function decodeCursor(cursor: string): DecodedCursor {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidCursorError();
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as DecodedCursor).opened_at !== 'string' ||
    typeof (parsed as DecodedCursor).id !== 'string'
  ) {
    throw new InvalidCursorError();
  }

  const c = parsed as DecodedCursor;
  if (Number.isNaN(Date.parse(c.opened_at))) throw new InvalidCursorError();
  return c;
}

// -- Internal helpers -------------------------------------------------------

const TICKET_COLUMNS =
  'id, display_id, app_id, platform_id, type_id, state, latest_outcome, ' +
  'priority, assigned_to, type_payloads, submission_ids, opened_at, ' +
  'closed_at, resolution_type, due_date, created_at, updated_at';

const ENTRY_COLUMNS =
  'id, ticket_id, entry_type, author_user_id, content, metadata, ' +
  'email_message_id, attachment_refs, edited_at, created_at';

interface FilterableQuery<T> {
  is(column: string, value: null): T;
  not(column: string, operator: string, value: null): T;
  or(filter: string): T;
}

function applyBucketFilter<T extends FilterableQuery<T>>(
  q: T,
  bucket: TicketBucket,
): T {
  switch (bucket) {
    case 'classified':
      return q.not('app_id', 'is', null).not('type_id', 'is', null);
    case 'unclassified_app':
      return q.is('app_id', null);
    case 'unclassified_type':
      return q.not('app_id', 'is', null).is('type_id', null);
    case 'unclassified_any':
      // Union of unclassified_app + unclassified_type, expressed via
      // PostgREST's .or(): app_id IS NULL OR type_id IS NULL.
      return q.or('app_id.is.null,type_id.is.null');
  }
}

function sortOrderColumns(sort: TicketSort): Array<{ col: string; ascending: boolean }> {
  switch (sort) {
    case 'opened_at_desc':
      return [
        { col: 'opened_at', ascending: false },
        { col: 'id', ascending: false },
      ];
    case 'updated_at_desc':
      return [
        { col: 'updated_at', ascending: false },
        { col: 'id', ascending: false },
      ];
    case 'priority_desc':
      // Priority is TEXT; Postgres sort is lexicographic: 'LOW'<'NORMAL'<'HIGH'
      // — that gives LOW before HIGH on DESC which is wrong. We apply a
      // CASE in SQL would be ideal; Supabase JS lacks expression-sort, so
      // we fall back to ordering by priority DESC (HIGH>NORMAL>LOW by string
      // — 'NORMAL'>'LOW' but 'LOW'>'HIGH' fails). Document limitation and
      // tiebreak by opened_at. TODO: add a numeric priority_rank column or
      // a GENERATED helper expression if priority sort becomes important.
      return [
        { col: 'priority', ascending: false },
        { col: 'opened_at', ascending: false },
        { col: 'id', ascending: false },
      ];
  }
}

// -- listTickets ------------------------------------------------------------

/**
 * List tickets with denormalized joined fields.
 *
 * Performance notes:
 *   - Primary query uses `(state, opened_at DESC)` index (migration
 *     20260101100000) when `state` is filtered — the common case for Inbox
 *     tabs. Without state, `opened_at DESC` index covers the sort.
 *   - Joined entities are fetched in parallel via keyed maps after the
 *     main query, same pattern as rules.ts. Keeps the primary query
 *     simple and sidesteps Supabase FK auto-detection fragility.
 *   - `entry_count` requires a second query grouped by ticket_id. One
 *     round-trip regardless of page size, so negligible at limit≤100.
 *
 * Filter scale assumptions: total ticket count stays <5k for the first
 * year (200/month × 24mo). Any full-table scan is still sub-100ms on
 * current workload. Revisit if volume grows.
 */
export async function listTickets(filters: TicketsQuery): Promise<ListTicketsResult> {
  const db = storeDb();

  // Cursor validation: only the default sort supports keyset pagination.
  let cursor: DecodedCursor | null = null;
  if (filters.cursor) {
    if (filters.sort !== 'opened_at_desc') {
      throw new InvalidCursorError(
        `Cursor pagination is only supported with sort=opened_at_desc (got ${filters.sort})`,
      );
    }
    cursor = decodeCursor(filters.cursor);
  }

  // Resolve platform key → id upfront. Skipping when not filtered so we
  // don't pay a round-trip for the no-filter case.
  let platformIdFilter: string | null = null;
  if (filters.platform_key) {
    const { data: platform, error } = await db
      .from('platforms')
      .select('id')
      .eq('key', filters.platform_key)
      .maybeSingle();
    if (error) {
      console.error('[store-tickets] platform lookup failed:', error);
      throw new Error('Failed to filter tickets by platform');
    }
    if (!platform) {
      // Platform key unknown → no rows will match; short-circuit.
      return { tickets: [], next_cursor: null, has_more: false };
    }
    platformIdFilter = (platform as { id: string }).id;
  }

  // Build primary query.
  let q = db.from('tickets').select(TICKET_COLUMNS);

  if (filters.state) {
    if (Array.isArray(filters.state)) {
      q = q.in('state', filters.state);
    } else {
      q = q.eq('state', filters.state);
    }
  }
  if (filters.bucket) q = applyBucketFilter(q, filters.bucket);
  if (platformIdFilter) q = q.eq('platform_id', platformIdFilter);
  if (filters.app_id) q = q.eq('app_id', filters.app_id);
  if (filters.type_id) q = q.eq('type_id', filters.type_id);
  if (filters.priority) q = q.eq('priority', filters.priority);
  if (filters.assigned_to) q = q.eq('assigned_to', filters.assigned_to);
  if (filters.opened_from) q = q.gte('opened_at', filters.opened_from);
  if (filters.opened_to) q = q.lte('opened_at', filters.opened_to);

  // Search: MVP matches display_id only. App-name search deferred — requires
  // a two-pass subquery (resolve apps by name → filter tickets by app_id)
  // and is not worth the complexity until the dataset grows.
  if (filters.search && filters.search.trim() !== '') {
    const needle = filters.search.trim();
    const escaped = needle.replace(/[%_]/g, (ch) => `\\${ch}`);
    q = q.ilike('display_id', `%${escaped}%`);
  }

  // Keyset pagination: `(opened_at, id) < (cursor.opened_at, cursor.id)`.
  // PostgREST `.or()` supports nested `and(...)` grouping.
  if (cursor) {
    const { opened_at, id } = cursor;
    q = q.or(
      `opened_at.lt.${opened_at},and(opened_at.eq.${opened_at},id.lt.${id})`,
    );
  }

  for (const { col, ascending } of sortOrderColumns(filters.sort)) {
    q = q.order(col, { ascending });
  }

  // Fetch one extra to detect `has_more` without a separate count query.
  q = q.limit(filters.limit + 1);

  const { data: rawTickets, error: ticketsErr } = await q;
  if (ticketsErr) {
    console.error('[store-tickets] listTickets fetch failed:', ticketsErr);
    throw new Error('Failed to load tickets');
  }

  const page = ((rawTickets ?? []) as unknown) as TicketRow[];
  const hasMore = page.length > filters.limit;
  const pageRows = hasMore ? page.slice(0, filters.limit) : page;

  if (pageRows.length === 0) {
    return { tickets: [], next_cursor: null, has_more: false };
  }

  // Parallel fan-out for denormalized fields.
  const appIds = Array.from(
    new Set(pageRows.map((t) => t.app_id).filter((v): v is string => v !== null)),
  );
  const typeIds = Array.from(
    new Set(pageRows.map((t) => t.type_id).filter((v): v is string => v !== null)),
  );
  const platformIds = Array.from(new Set(pageRows.map((t) => t.platform_id)));
  const assigneeIds = Array.from(
    new Set(pageRows.map((t) => t.assigned_to).filter((v): v is string => v !== null)),
  );
  const ticketIds = pageRows.map((t) => t.id);

  const [appsRes, typesRes, platformsRes, usersRes, entryCountsRes] = await Promise.all([
    appIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db.from('apps').select('id, name, slug').in('id', appIds),
    typeIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db.from('types').select('id, name, slug').in('id', typeIds),
    db
      .from('platforms')
      .select('id, key, display_name')
      .in('id', platformIds),
    assigneeIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : db.from('users').select('id, email, display_name').in('id', assigneeIds),
    db
      .from('ticket_entries')
      .select('ticket_id')
      .in('ticket_id', ticketIds),
  ]);

  for (const r of [appsRes, typesRes, platformsRes, usersRes, entryCountsRes]) {
    if (r.error) {
      console.error('[store-tickets] listTickets join fetch failed:', r.error);
      throw new Error('Failed to load ticket details');
    }
  }

  const appById = new Map<string, { name: string; slug: string }>();
  for (const row of (appsRes.data ?? []) as Array<{
    id: string;
    name: string;
    slug: string;
  }>) {
    appById.set(row.id, { name: row.name, slug: row.slug });
  }

  const typeById = new Map<string, { name: string; slug: string }>();
  for (const row of (typesRes.data ?? []) as Array<{
    id: string;
    name: string;
    slug: string;
  }>) {
    typeById.set(row.id, { name: row.name, slug: row.slug });
  }

  const platformById = new Map<string, { key: string; display_name: string }>();
  for (const row of (platformsRes.data ?? []) as Array<{
    id: string;
    key: string;
    display_name: string;
  }>) {
    platformById.set(row.id, { key: row.key, display_name: row.display_name });
  }

  const userById = new Map<string, { email: string; display_name: string | null }>();
  for (const row of (usersRes.data ?? []) as Array<{
    id: string;
    email: string;
    display_name: string | null;
  }>) {
    userById.set(row.id, { email: row.email, display_name: row.display_name });
  }

  const entryCountByTicket = new Map<string, number>();
  for (const row of (entryCountsRes.data ?? []) as Array<{ ticket_id: string }>) {
    entryCountByTicket.set(row.ticket_id, (entryCountByTicket.get(row.ticket_id) ?? 0) + 1);
  }

  const tickets: TicketListRow[] = pageRows.map((t) => {
    const app = t.app_id ? appById.get(t.app_id) ?? null : null;
    const type = t.type_id ? typeById.get(t.type_id) ?? null : null;
    const platform = platformById.get(t.platform_id);
    const assignee = t.assigned_to ? userById.get(t.assigned_to) ?? null : null;

    return {
      id: t.id,
      display_id: t.display_id,
      state: t.state,
      latest_outcome: t.latest_outcome as TicketOutcome | null,
      priority: t.priority as TicketPriority,
      opened_at: t.opened_at,
      updated_at: t.updated_at,
      closed_at: t.closed_at,
      due_date: t.due_date,

      app_id: t.app_id,
      app_name: app?.name ?? null,
      app_slug: app?.slug ?? null,

      type_id: t.type_id,
      type_name: type?.name ?? null,
      type_slug: type?.slug ?? null,

      platform_id: t.platform_id,
      platform_key: platform?.key ?? '',
      platform_display_name: platform?.display_name ?? '',

      assigned_to: t.assigned_to,
      assigned_to_display_name: assignee?.display_name ?? null,
      assigned_to_email: assignee?.email ?? null,

      entry_count: entryCountByTicket.get(t.id) ?? 0,
      submission_ids: t.submission_ids,
      type_payload_count: Array.isArray(t.type_payloads) ? t.type_payloads.length : 0,
    };
  });

  const next_cursor =
    hasMore && filters.sort === 'opened_at_desc'
      ? encodeCursor(pageRows[pageRows.length - 1].opened_at, pageRows[pageRows.length - 1].id)
      : null;

  return { tickets, next_cursor, has_more: hasMore };
}

// -- getTicketWithEntries ---------------------------------------------------

/**
 * Fetch a single ticket plus its full event-log timeline.
 *
 * Returns `null` when the ticket is not found (caller surfaces 404).
 *
 * Entries are ordered by `created_at ASC` — timeline UIs render oldest
 * first so the reader scrolls top-down through history. Index
 * `(ticket_id, created_at DESC)` still answers this efficiently (direction
 * is free on a b-tree index).
 */
export async function getTicketWithEntries(id: string): Promise<TicketWithEntries | null> {
  const db = storeDb();

  const { data: ticket, error: ticketErr } = await db
    .from('tickets')
    .select(TICKET_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (ticketErr) {
    console.error('[store-tickets] getTicketWithEntries ticket fetch failed:', ticketErr);
    throw new Error('Failed to load ticket');
  }
  if (!ticket) return null;

  const t = ticket as unknown as TicketRow;

  const [entriesRes, appRes, typeRes, platformRes, assigneeRes] = await Promise.all([
    db
      .from('ticket_entries')
      .select(ENTRY_COLUMNS)
      .eq('ticket_id', t.id)
      .order('created_at', { ascending: true }),
    t.app_id
      ? db.from('apps').select('id, name, slug').eq('id', t.app_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    t.type_id
      ? db.from('types').select('id, name, slug').eq('id', t.type_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db
      .from('platforms')
      .select('id, key, display_name')
      .eq('id', t.platform_id)
      .maybeSingle(),
    t.assigned_to
      ? db
          .from('users')
          .select('id, email, display_name')
          .eq('id', t.assigned_to)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  for (const r of [entriesRes, appRes, typeRes, platformRes, assigneeRes]) {
    if (r.error) {
      console.error('[store-tickets] getTicketWithEntries join failed:', r.error);
      throw new Error('Failed to load ticket details');
    }
  }

  const rawEntries = ((entriesRes.data ?? []) as unknown) as Array<{
    id: string;
    ticket_id: string;
    entry_type: TicketEntryType;
    author_user_id: string | null;
    content: string | null;
    metadata: Record<string, unknown> | null;
    email_message_id: string | null;
    attachment_refs: unknown[] | null;
    edited_at: string | null;
    created_at: string;
  }>;

  // Hydrate entry authors in one round-trip rather than per-entry.
  const authorIds = Array.from(
    new Set(rawEntries.map((e) => e.author_user_id).filter((v): v is string => v !== null)),
  );
  let authorById = new Map<string, { email: string; display_name: string | null }>();
  if (authorIds.length > 0) {
    const { data: authors, error: authorErr } = await db
      .from('users')
      .select('id, email, display_name')
      .in('id', authorIds);
    if (authorErr) {
      console.error('[store-tickets] entry author fetch failed:', authorErr);
      throw new Error('Failed to load entry authors');
    }
    authorById = new Map(
      ((authors ?? []) as Array<{ id: string; email: string; display_name: string | null }>).map(
        (u) => [u.id, { email: u.email, display_name: u.display_name }],
      ),
    );
  }

  const entries: TicketEntryRow[] = rawEntries.map((e) => {
    const author = e.author_user_id ? authorById.get(e.author_user_id) ?? null : null;
    return {
      id: e.id,
      ticket_id: e.ticket_id,
      entry_type: e.entry_type,
      author_user_id: e.author_user_id,
      author_display_name: author?.display_name ?? null,
      author_email: author?.email ?? null,
      content: e.content,
      metadata: e.metadata ?? {},
      email_message_id: e.email_message_id,
      attachment_refs: e.attachment_refs ?? [],
      edited_at: e.edited_at,
      created_at: e.created_at,
    };
  });

  const platform = platformRes.data as { id: string; key: string; display_name: string } | null;
  if (!platform) {
    // Ticket without a platform would violate the NOT NULL FK; treat as
    // a data-integrity error rather than returning a malformed payload.
    console.error('[store-tickets] ticket has no platform join:', { ticket_id: t.id });
    throw new Error('Ticket missing platform');
  }

  return {
    ticket: t,
    entries,
    app: (appRes.data as { id: string; name: string; slug: string } | null) ?? null,
    type: (typeRes.data as { id: string; name: string; slug: string } | null) ?? null,
    platform,
    assignee:
      (assigneeRes.data as {
        id: string;
        display_name: string | null;
        email: string;
      } | null) ?? null,
  };
}
