/**
 * PR-19 — Apple Reports MVP query module.
 *
 * Per-platform dashboard. Manager domain insight: each platform = its own
 * dashboard, no cross-platform aggregation (spec lock Q7). This module
 * is Apple-only by design; Google / Huawei follow the same pattern in
 * future PRs once their extractors ship.
 *
 * Data flow:
 *   page.tsx → server-side Promise.all of the four exported queries
 *            → React Server Components render KPIs + chart + tables
 *
 * Aggregation strategy: client-side (TS, in-process) on a small row
 * count. Production scale per CLAUDE.md is ~200 submissions/month total
 * across 4 platforms — Apple is <120 rows / 30d. SQL `GROUP BY` is
 * unnecessary at this scale and would split logic across the type-
 * checked TS layer and the untyped SQL layer.
 *
 * Pure aggregators (`aggregateKpis`, `bucketTrendByDay`, `groupByApp`,
 * `truncateExcerpt`) are exported separately so unit tests can exercise
 * them with synthetic rows without mocking Supabase chains. The
 * `getApple*` wrappers compose them on top of a single DB fetch.
 */

import type { TicketOutcome, TicketState } from '../schemas/ticket';

import { storeDb } from '../db';

// ---------------------------------------------------------------------------
// Public types — page.tsx + components/store-submissions/reports/* consume.
// ---------------------------------------------------------------------------

export interface ReportsKpis {
  total: number;
  approved: number;
  rejected: number;
  /** Average review time (closed_at - opened_at) for approved tickets, in milliseconds. `null` when no approved tickets in window. */
  avgReviewTimeMs: number | null;
  /** Percent change vs previous equally-sized window. `null` when previous window was empty (division by zero). */
  deltas: {
    total: number | null;
    approved: number | null;
    rejected: number | null;
    avgReviewTime: number | null;
  };
}

export interface TrendBucket {
  /** YYYY-MM-DD in the server's timezone (UTC for Railway). */
  date: string;
  approved: number;
  in_review: number;
  rejected: number;
}

export interface AppRow {
  app_id: string;
  app_name: string;
  submits: number;
  rejects: number;
  /** rejects / submits, in [0, 1]. */
  rate: number;
}

export interface ByAppResult {
  rows: AppRow[];
  /** Total distinct apps with submissions in window — used for "View all N" CTA copy. */
  total_apps: number;
}

export interface RecentRejected {
  ticket_id: string;
  display_id: string;
  app_id: string | null;
  app_name: string | null;
  rejected_at: string;
  excerpt: string;
}

// ---------------------------------------------------------------------------
// Pure aggregators — testable with synthetic rows.
// ---------------------------------------------------------------------------

interface KpiInputRow {
  state: TicketState;
  latest_outcome: TicketOutcome | null;
  opened_at: string;
  closed_at: string | null;
  resolution_type: 'APPROVED' | 'DONE' | 'ARCHIVED' | null;
}

/**
 * Compute KPIs over the current window plus deltas vs the previous
 * equally-sized window. Pure: takes rows that span both windows and
 * partitions by `opened_at`.
 *
 * PR-21 semantic lock — Apple verdict view, symmetric across all KPIs:
 *   Approved = `latest_outcome='APPROVED'`
 *   Rejected = `latest_outcome='REJECTED'`
 * Reports surface = Apple analytics view (counts what Apple decided).
 * Manager workflow view (state/resolution-based) lives in the Inbox
 * state-chip filter (PR-13 surface), not here. Two surfaces, two
 * intentional semantics. Avg review time uses the same predicate as
 * Approved so the metric matches the count.
 *
 * Tradeoff vs the prior PR-19 lock: a ticket where Apple said APPROVED
 * but Manager hasn't moved it terminal still counts in Approved here
 * (Apple reality, not workflow progress). A ticket Manager marked DONE
 * post-approval but where `latest_outcome` is somehow null does NOT
 * count.
 */
export function aggregateKpis(
  rows: KpiInputRow[],
  windowStart: Date,
  windowEnd: Date,
): ReportsKpis {
  const windowSpanMs = windowEnd.getTime() - windowStart.getTime();
  const prevStart = new Date(windowStart.getTime() - windowSpanMs);

  const isApproved = (r: KpiInputRow): boolean =>
    r.latest_outcome === 'APPROVED';

  const reviewMs = (r: KpiInputRow): number | null => {
    if (!isApproved(r) || !r.closed_at) return null;
    const ms = new Date(r.closed_at).getTime() - new Date(r.opened_at).getTime();
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  };

  const summarize = (subset: KpiInputRow[]) => {
    const total = subset.length;
    const approved = subset.filter(isApproved).length;
    const rejected = subset.filter((r) => r.latest_outcome === 'REJECTED').length;
    const reviewMsValues = subset.map(reviewMs).filter((v): v is number => v !== null);
    const avgReviewTimeMs = reviewMsValues.length
      ? reviewMsValues.reduce((a, b) => a + b, 0) / reviewMsValues.length
      : null;
    return { total, approved, rejected, avgReviewTimeMs };
  };

  const inWindow = (r: KpiInputRow, start: Date, end: Date): boolean => {
    const t = new Date(r.opened_at).getTime();
    return t >= start.getTime() && t < end.getTime();
  };

  const cur = summarize(rows.filter((r) => inWindow(r, windowStart, windowEnd)));
  const prev = summarize(rows.filter((r) => inWindow(r, prevStart, windowStart)));

  const pctDelta = (current: number, previous: number): number | null => {
    if (previous === 0) return null;
    return ((current - previous) / previous) * 100;
  };

  return {
    total: cur.total,
    approved: cur.approved,
    rejected: cur.rejected,
    avgReviewTimeMs: cur.avgReviewTimeMs,
    deltas: {
      total: pctDelta(cur.total, prev.total),
      approved: pctDelta(cur.approved, prev.approved),
      rejected: pctDelta(cur.rejected, prev.rejected),
      avgReviewTime:
        cur.avgReviewTimeMs !== null && prev.avgReviewTimeMs !== null && prev.avgReviewTimeMs > 0
          ? ((cur.avgReviewTimeMs - prev.avgReviewTimeMs) / prev.avgReviewTimeMs) * 100
          : null,
    },
  };
}

interface TrendInputRow {
  opened_at: string;
  latest_outcome: TicketOutcome | null;
  state: TicketState;
  resolution_type: 'APPROVED' | 'DONE' | 'ARCHIVED' | null;
}

/**
 * Bucket rows into N daily buckets between windowStart (inclusive) and
 * windowEnd (exclusive). Each bucket is keyed by YYYY-MM-DD in UTC.
 *
 * PR-21 semantic lock — same Apple-verdict view as `aggregateKpis`:
 *   - approved  if latest_outcome='APPROVED' (priority 1)
 *   - rejected  if latest_outcome='REJECTED' (priority 2)
 *   - else      in_review (covers latest_outcome=null + 'IN_REVIEW')
 *
 * NULL latest_outcome → in_review by convention (Manager sees all open
 * tickets as "in review" until an email signals otherwise). Note that
 * `state` and `resolution_type` are not consulted here: a ticket
 * Manager moved terminal but lacking an Apple outcome stacks as
 * in_review, not approved. That mirrors the KPI predicate.
 */
export function bucketTrendByDay(
  rows: TrendInputRow[],
  windowStart: Date,
  windowEnd: Date,
): TrendBucket[] {
  const buckets = new Map<string, TrendBucket>();

  // Pre-seed every day in window so empty days render as zero bars.
  const dayMs = 24 * 60 * 60 * 1000;
  for (let t = windowStart.getTime(); t < windowEnd.getTime(); t += dayMs) {
    const key = isoDate(new Date(t));
    buckets.set(key, { date: key, approved: 0, in_review: 0, rejected: 0 });
  }

  for (const r of rows) {
    const date = isoDate(new Date(r.opened_at));
    const bucket = buckets.get(date);
    if (!bucket) continue;
    if (r.latest_outcome === 'APPROVED') bucket.approved++;
    else if (r.latest_outcome === 'REJECTED') bucket.rejected++;
    else bucket.in_review++;
  }

  return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface ByAppInputRow {
  app_id: string | null;
  app_name: string | null;
  latest_outcome: TicketOutcome | null;
}

/**
 * Group rows by app, count submits + rejects, sort by submits desc, slice
 * to top N. Rows with `app_id=null` (unclassified) are dropped — Reports
 * is about classified Apple submissions per app.
 */
export function groupByApp(rows: ByAppInputRow[], limit: number): ByAppResult {
  const map = new Map<string, AppRow>();
  for (const r of rows) {
    if (!r.app_id || !r.app_name) continue;
    const existing = map.get(r.app_id);
    if (existing) {
      existing.submits++;
      if (r.latest_outcome === 'REJECTED') existing.rejects++;
    } else {
      map.set(r.app_id, {
        app_id: r.app_id,
        app_name: r.app_name,
        submits: 1,
        rejects: r.latest_outcome === 'REJECTED' ? 1 : 0,
        rate: 0,
      });
    }
  }
  const all = Array.from(map.values()).map((row) => ({
    ...row,
    rate: row.submits > 0 ? row.rejects / row.submits : 0,
  }));
  all.sort((a, b) => b.submits - a.submits || a.app_name.localeCompare(b.app_name));
  return { rows: all.slice(0, limit), total_apps: all.length };
}

/**
 * Truncate a free-text reject-reason excerpt to N chars on a word boundary
 * with a trailing ellipsis. Whitespace-collapsed for compact rendering.
 */
export function truncateExcerpt(content: string, maxChars = 200): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  const sliced = collapsed.slice(0, maxChars);
  const lastSpace = sliced.lastIndexOf(' ');
  const cut = lastSpace > maxChars * 0.6 ? sliced.slice(0, lastSpace) : sliced;
  return `${cut}…`;
}

// ---------------------------------------------------------------------------
// DB fetchers — compose pure aggregators on top of a single Supabase fetch.
// ---------------------------------------------------------------------------

const APPLE_PLATFORM_KEY = 'apple';

async function getApplePlatformId(): Promise<string | null> {
  const { data, error } = await storeDb()
    .from('platforms')
    .select('id')
    .eq('key', APPLE_PLATFORM_KEY)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

/**
 * Fetch + aggregate the 4 KPI metrics for a window plus deltas vs the
 * previous equally-sized window. Single Supabase query covers both
 * windows (60-day span when window=30d) — partitioning happens in JS.
 *
 * `typeId` (PR-22): when provided, scopes results to tickets of that
 * type. Manager flow `Type → App → counts` uses this to dimension
 * the dashboard. Undefined = all Apple types (legacy default).
 */
export async function getAppleReportsKpis(
  windowStart: Date,
  windowEnd: Date,
  typeId?: string,
): Promise<ReportsKpis> {
  const apple = await getApplePlatformId();
  if (!apple) return emptyKpis();

  const span = windowEnd.getTime() - windowStart.getTime();
  const prevStart = new Date(windowStart.getTime() - span);

  let q = storeDb()
    .from('tickets')
    .select('state, latest_outcome, opened_at, closed_at, resolution_type')
    .eq('platform_id', apple)
    .gte('opened_at', prevStart.toISOString())
    .lt('opened_at', windowEnd.toISOString());
  if (typeId) q = q.eq('type_id', typeId);

  const { data, error } = await q;
  if (error || !data) return emptyKpis();
  return aggregateKpis(data as KpiInputRow[], windowStart, windowEnd);
}

function emptyKpis(): ReportsKpis {
  return {
    total: 0,
    approved: 0,
    rejected: 0,
    avgReviewTimeMs: null,
    deltas: { total: null, approved: null, rejected: null, avgReviewTime: null },
  };
}

/**
 * Daily trend chart data for the current window only (no comparison
 * window — KPI deltas already convey period-over-period change).
 * `typeId` (PR-22) scopes the same way as `getAppleReportsKpis`.
 */
export async function getAppleTrendByDay(
  windowStart: Date,
  windowEnd: Date,
  typeId?: string,
): Promise<TrendBucket[]> {
  const apple = await getApplePlatformId();
  if (!apple) return bucketTrendByDay([], windowStart, windowEnd);

  let q = storeDb()
    .from('tickets')
    .select('opened_at, latest_outcome, state, resolution_type')
    .eq('platform_id', apple)
    .gte('opened_at', windowStart.toISOString())
    .lt('opened_at', windowEnd.toISOString());
  if (typeId) q = q.eq('type_id', typeId);

  const { data, error } = await q;
  if (error || !data) return bucketTrendByDay([], windowStart, windowEnd);
  return bucketTrendByDay(data as TrendInputRow[], windowStart, windowEnd);
}

/**
 * Top N apps by submit volume in window. Excludes unclassified tickets
 * (app_id IS NULL). `typeId` (PR-22) scopes to a single type so the
 * "Type → App" dimension realizes the Manager flow.
 */
export async function getAppleByAppTable(
  windowStart: Date,
  windowEnd: Date,
  limit = 5,
  typeId?: string,
): Promise<ByAppResult> {
  const apple = await getApplePlatformId();
  if (!apple) return { rows: [], total_apps: 0 };

  let q = storeDb()
    .from('tickets')
    .select('app_id, latest_outcome, apps!inner(name)')
    .eq('platform_id', apple)
    .not('app_id', 'is', null)
    .gte('opened_at', windowStart.toISOString())
    .lt('opened_at', windowEnd.toISOString());
  if (typeId) q = q.eq('type_id', typeId);

  const { data, error } = await q;
  if (error || !data) return { rows: [], total_apps: 0 };

  // Supabase nests `apps` as either an object or array depending on join
  // semantics; flatten to the rows shape `groupByApp` expects.
  const flat: ByAppInputRow[] = (data as Array<{
    app_id: string | null;
    latest_outcome: TicketOutcome | null;
    apps: { name: string } | { name: string }[] | null;
  }>).map((r) => {
    const apps = Array.isArray(r.apps) ? r.apps[0] : r.apps;
    return {
      app_id: r.app_id,
      app_name: apps?.name ?? null,
      latest_outcome: r.latest_outcome,
    };
  });

  return groupByApp(flat, limit);
}

/**
 * Most recent N reject-reason entries on Apple tickets. Sourced from
 * `ticket_entries.entry_type='REJECT_REASON'` (manually logged free
 * text — no taxonomy yet, that's the deferred Phase-3 scope).
 * `typeId` (PR-22) scopes through the `tickets!inner` join.
 */
export async function getAppleRecentRejected(
  limit = 5,
  typeId?: string,
): Promise<RecentRejected[]> {
  const apple = await getApplePlatformId();
  if (!apple) return [];

  let q = storeDb()
    .from('ticket_entries')
    .select(
      'id, content, created_at, ticket_id, tickets!inner(display_id, platform_id, app_id, apps(name))',
    )
    .eq('entry_type', 'REJECT_REASON')
    .eq('tickets.platform_id', apple)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (typeId) q = q.eq('tickets.type_id', typeId);

  const { data, error } = await q;
  if (error || !data) return [];

  return (data as Array<{
    id: string;
    content: string | null;
    created_at: string;
    ticket_id: string;
    tickets:
      | { display_id: string; app_id: string | null; apps: { name: string } | { name: string }[] | null }
      | { display_id: string; app_id: string | null; apps: { name: string } | { name: string }[] | null }[]
      | null;
  }>).map((r) => {
    const ticket = Array.isArray(r.tickets) ? r.tickets[0] : r.tickets;
    const apps = ticket?.apps ? (Array.isArray(ticket.apps) ? ticket.apps[0] : ticket.apps) : null;
    return {
      ticket_id: r.ticket_id,
      display_id: ticket?.display_id ?? '—',
      app_id: ticket?.app_id ?? null,
      app_name: apps?.name ?? null,
      rejected_at: r.created_at,
      excerpt: truncateExcerpt(r.content ?? ''),
    };
  });
}
