/**
 * Apple Reports query module.
 *
 * Per-platform dashboard. Manager domain insight: each platform = its own
 * dashboard, no cross-platform aggregation (spec lock Q7). This module
 * is Apple-only by design; Google / Huawei follow the same pattern in
 * future PRs once their extractors ship.
 *
 * Counting source — production-aware (PR-Reports.A):
 *   KPI counts read from `email_messages.classification_result` (Apple
 *   verdict timeline view) instead of `tickets.latest_outcome` (which
 *   only retains the most-recent verdict and hides resubmit cycles).
 *   Two-surface separation strict: Inbox keeps reading
 *   `tickets.latest_outcome` for state-chip filters (PR-13 surface);
 *   `find_or_create_ticket_tx` write paths are unchanged.
 *
 * Apple-burst-aware aggregation (PR-Reports.A):
 *   Diagnostic Q-Anomaly-1 + Q-Reject-Dedup-1 (production data, May
 *   2026) revealed Apple sends notification bursts: same ticket, same
 *   outcome, 2–4 emails within 9–75 seconds. Manager domain rules ("max
 *   1 approve per ticket"; "rejects count cycles, not notifications")
 *   are enforced by the aggregator, not assumed of the data:
 *     Approved = COUNT(DISTINCT ticket_id) where any email outcome=APPROVED
 *     Rejected = burst-dedup with BURST_DEDUP_WINDOW_MS window per ticket
 *   Both sides are Apple-burst-aware; the asymmetry is in cycle-counting
 *   intent (Manager A2): approve has a domain ceiling of 1, rejects do
 *   not (resubmit cycles all count separately, just not their burst
 *   notifications).
 *
 * Two-clock window model (PR-Reports.A):
 *   KPI counts use `email_messages.received_at` (Apple verdict timeline,
 *   Manager Q5). Avg review time uses `tickets.opened_at` (preserves
 *   PR-19 ticket-lifecycle clock per Manager Q3 Option A). Each clock
 *   matches the metric's semantic.
 *
 * Trend chart + by-platform-id resolution preserved from PR-19/21 —
 * trend chart bucket clock is deferred to PR-Reports.B.
 *
 * Aggregation strategy: client-side (TS, in-process) on a small row
 * count. Production scale per CLAUDE.md is ~200 submissions/month total
 * across 4 platforms — Apple is <120 tickets / 30d, ~2-3× emails per
 * ticket. SQL `GROUP BY` is unnecessary at this scale and would split
 * logic across the type-checked TS layer and the untyped SQL layer.
 *
 * Pure aggregators (`aggregateKpis`, `bucketTrendByDay`, `groupByApp`,
 * `truncateExcerpt`, `dedupBurstByTicket`) are exported separately so
 * unit tests can exercise them with synthetic rows without mocking
 * Supabase chains. The `getApple*` wrappers compose them on top of
 * Supabase fetches.
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
  /** rejects / submits. Can exceed 1.0 when tickets have multiple resubmit-cycle rejects (Manager A2 cycle-count semantic). */
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
// Tunables.
// ---------------------------------------------------------------------------

/**
 * Time window per ticket within which same-outcome emails collapse to a
 * single event during burst dedup. Calibrated against May 2026 production
 * data: observed Apple retry bursts had 9–75s spans; smallest legitimate
 * spread (genuine resubmit cycle) was 30 minutes. 60s sits cleanly in
 * that gap. The 75s edge case (TICKET-10019 approve burst) collapses
 * intentionally — better to trim a single legitimate cycle than to leak
 * Apple noise into a metric Manager uses for capacity planning.
 */
export const BURST_DEDUP_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Pure aggregators — testable with synthetic rows.
// ---------------------------------------------------------------------------

/**
 * One row per email_messages entry projected to just what aggregators read.
 * Source: email_messages joined to tickets (platform/type filters happen
 * SQL-side). `outcome` is extracted from `classification_result->>'outcome'`
 * and may be null (DROPPED/ERROR rows have no outcome field).
 */
export interface EmailEntryInputRow {
  ticket_id: string;
  outcome: TicketOutcome | null;
  received_at: string;
}

/**
 * One row per ticket projected to the avg-review-time path. Sourced from
 * `tickets`, filtered to `latest_outcome='APPROVED'` SQL-side. Separate
 * clock from email entries (Manager Q3 Option A: avg review measures
 * ticket lifecycle, not email timeline).
 */
export interface ReviewTimeInputRow {
  opened_at: string;
  closed_at: string;
}

/**
 * Burst dedup utility: collapse Apple notification bursts on a single
 * ticket to a single event. For each ticket_id, sort entries by
 * received_at and keep an entry only if its predecessor on the same
 * ticket was more than `windowMs` ago.
 *
 * Caller MUST pre-filter to a single outcome — the dedup is outcome-
 * blind, since Apple bursts only occur within same-outcome notifications.
 * Two opposite-outcome emails arriving within the window represent a
 * legitimate verdict flip and must NOT collapse.
 */
export function dedupBurstByTicket(
  entries: EmailEntryInputRow[],
  windowMs: number = BURST_DEDUP_WINDOW_MS,
): EmailEntryInputRow[] {
  const byTicket = new Map<string, EmailEntryInputRow[]>();
  for (const r of entries) {
    const list = byTicket.get(r.ticket_id);
    if (list) list.push(r);
    else byTicket.set(r.ticket_id, [r]);
  }
  const kept: EmailEntryInputRow[] = [];
  for (const list of byTicket.values()) {
    list.sort(
      (a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime(),
    );
    let prevMs = -Infinity;
    for (const r of list) {
      const t = new Date(r.received_at).getTime();
      if (t - prevMs > windowMs) kept.push(r);
      prevMs = t;
    }
  }
  return kept;
}

/**
 * Compute KPIs over the current window plus deltas vs the previous
 * equally-sized window. Pure: takes rows that span both windows and
 * partitions by their respective clocks (emails by received_at,
 * review-times by opened_at).
 *
 * Production-aware enforcement (Pattern 10 reuse #15):
 *   Approved = COUNT(DISTINCT ticket_id) where outcome=APPROVED in window
 *     — Manager A2 ("max 1 approve per ticket") query-enforced. Apple
 *     sends redundant APPROVED notifications (Q-Anomaly-1).
 *   Rejected = burst-dedup count of outcome=REJECTED entries in window
 *     — Manager A2 ("multiple rejects per ticket count separately as
 *     resubmit cycles") preserved; Apple notification-burst noise
 *     filtered via BURST_DEDUP_WINDOW_MS (Q-Reject-Dedup-1).
 *   Total = COUNT(DISTINCT ticket_id) where any outcome'd email in window
 *     (Q2 Option A — "submissions worked on").
 *   AvgReviewTime = mean of (closed_at - opened_at) on review-time rows
 *     opened in window (Q3 Option A — separate ticket-lifecycle clock).
 *
 * Outcomes other than APPROVED / REJECTED (IN_REVIEW, null) are ignored
 * by the count predicates. Avg review time is uncoupled from the email
 * count source by design — `latest_outcome='APPROVED'` filtering lives
 * SQL-side on the review query.
 */
export function aggregateKpis(
  emailRows: EmailEntryInputRow[],
  reviewTimeRows: ReviewTimeInputRow[],
  windowStart: Date,
  windowEnd: Date,
): ReportsKpis {
  const windowSpanMs = windowEnd.getTime() - windowStart.getTime();
  const prevStart = new Date(windowStart.getTime() - windowSpanMs);

  const inWindow = (tIso: string, start: Date, end: Date): boolean => {
    const t = new Date(tIso).getTime();
    return t >= start.getTime() && t < end.getTime();
  };

  const summarizeEmails = (subset: EmailEntryInputRow[]) => {
    const approvedTickets = new Set<string>();
    const outcomedTickets = new Set<string>();
    const rejectedRows: EmailEntryInputRow[] = [];
    for (const r of subset) {
      if (r.outcome === 'APPROVED') {
        approvedTickets.add(r.ticket_id);
        outcomedTickets.add(r.ticket_id);
      } else if (r.outcome === 'REJECTED') {
        rejectedRows.push(r);
        outcomedTickets.add(r.ticket_id);
      }
      // outcome === 'IN_REVIEW' or null: not counted in KPI predicates.
    }
    return {
      total: outcomedTickets.size,
      approved: approvedTickets.size,
      rejected: dedupBurstByTicket(rejectedRows).length,
    };
  };

  const summarizeAvgReviewMs = (subset: ReviewTimeInputRow[]): number | null => {
    if (subset.length === 0) return null;
    const ms = subset
      .map((r) => new Date(r.closed_at).getTime() - new Date(r.opened_at).getTime())
      .filter((v) => Number.isFinite(v) && v >= 0);
    if (ms.length === 0) return null;
    return ms.reduce((a, b) => a + b, 0) / ms.length;
  };

  const curEmails = emailRows.filter((r) =>
    inWindow(r.received_at, windowStart, windowEnd),
  );
  const prevEmails = emailRows.filter((r) =>
    inWindow(r.received_at, prevStart, windowStart),
  );
  const curReview = reviewTimeRows.filter((r) =>
    inWindow(r.opened_at, windowStart, windowEnd),
  );
  const prevReview = reviewTimeRows.filter((r) =>
    inWindow(r.opened_at, prevStart, windowStart),
  );

  const cur = summarizeEmails(curEmails);
  const prev = summarizeEmails(prevEmails);
  const curAvgMs = summarizeAvgReviewMs(curReview);
  const prevAvgMs = summarizeAvgReviewMs(prevReview);

  const pctDelta = (current: number, previous: number): number | null => {
    if (previous === 0) return null;
    return ((current - previous) / previous) * 100;
  };

  return {
    total: cur.total,
    approved: cur.approved,
    rejected: cur.rejected,
    avgReviewTimeMs: curAvgMs,
    deltas: {
      total: pctDelta(cur.total, prev.total),
      approved: pctDelta(cur.approved, prev.approved),
      rejected: pctDelta(cur.rejected, prev.rejected),
      avgReviewTime:
        curAvgMs !== null && prevAvgMs !== null && prevAvgMs > 0
          ? ((curAvgMs - prevAvgMs) / prevAvgMs) * 100
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
 * PR-21 semantic lock — Apple verdict view:
 *   - approved  if latest_outcome='APPROVED' (priority 1)
 *   - rejected  if latest_outcome='REJECTED' (priority 2)
 *   - else      in_review (covers latest_outcome=null + 'IN_REVIEW')
 *
 * NULL latest_outcome → in_review by convention. Note that `state` and
 * `resolution_type` are not consulted here: a ticket Manager moved
 * terminal but lacking an Apple outcome stacks as in_review.
 *
 * This trend-chart aggregator still reads from `tickets.latest_outcome`
 * (PR-19/21 source). Switching the trend bucket clock to email entries
 * is deferred to PR-Reports.B per the multi-PR sequential ship plan.
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

interface ByAppEmailInputRow {
  ticket_id: string;
  app_id: string | null;
  app_name: string | null;
  outcome: TicketOutcome | null;
  received_at: string;
}

/**
 * Group rows by app, count distinct submissions + burst-dedupped rejects,
 * sort by submits desc, slice to top N. Rows with `app_id=null`
 * (unclassified) are dropped — Reports is about classified Apple
 * submissions per app. Rows whose outcome is not APPROVED or REJECTED
 * (IN_REVIEW, null) do not contribute to either count and are filtered.
 *
 *   submits(app) = COUNT(DISTINCT ticket_id) where any email outcome'd
 *   rejects(app) = burst-dedupped REJECTED entries on that app
 *   rate(app)    = rejects / submits — can exceed 1.0 (Manager A2 cycle
 *                  semantic; UI tooltip explains)
 */
export function groupByApp(rows: ByAppEmailInputRow[], limit: number): ByAppResult {
  interface Bucket {
    app_id: string;
    app_name: string;
    ticketIds: Set<string>;
    rejectRows: EmailEntryInputRow[];
  }
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    if (!r.app_id || !r.app_name) continue;
    if (r.outcome !== 'APPROVED' && r.outcome !== 'REJECTED') continue;
    let b = buckets.get(r.app_id);
    if (!b) {
      b = {
        app_id: r.app_id,
        app_name: r.app_name,
        ticketIds: new Set<string>(),
        rejectRows: [],
      };
      buckets.set(r.app_id, b);
    }
    b.ticketIds.add(r.ticket_id);
    if (r.outcome === 'REJECTED') {
      b.rejectRows.push({
        ticket_id: r.ticket_id,
        outcome: r.outcome,
        received_at: r.received_at,
      });
    }
  }
  const all: AppRow[] = Array.from(buckets.values()).map((b) => {
    const submits = b.ticketIds.size;
    const rejects = dedupBurstByTicket(b.rejectRows).length;
    return {
      app_id: b.app_id,
      app_name: b.app_name,
      submits,
      rejects,
      rate: submits > 0 ? rejects / submits : 0,
    };
  });
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
// DB fetchers — compose pure aggregators on top of Supabase fetches.
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
 * Two-clock window model:
 *   (1) Email-entry rows for KPI counts — clock = received_at.
 *   (2) Ticket rows for avg review time — clock = opened_at, filter
 *       latest_outcome='APPROVED' SQL-side (Q3 Option A preserved).
 *
 * `typeId` (PR-22) scopes both queries through the tickets relation
 * (direct on the ticket query, via inner join on the email query).
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

  let qEmails = storeDb()
    .from('email_messages')
    .select(
      'ticket_id, classification_result, received_at, tickets!inner(platform_id, type_id)',
    )
    .eq('tickets.platform_id', apple)
    .gte('received_at', prevStart.toISOString())
    .lt('received_at', windowEnd.toISOString())
    .not('classification_result', 'is', null);
  if (typeId) qEmails = qEmails.eq('tickets.type_id', typeId);

  let qReview = storeDb()
    .from('tickets')
    .select('opened_at, closed_at')
    .eq('platform_id', apple)
    .eq('latest_outcome', 'APPROVED')
    .not('closed_at', 'is', null)
    .gte('opened_at', prevStart.toISOString())
    .lt('opened_at', windowEnd.toISOString());
  if (typeId) qReview = qReview.eq('type_id', typeId);

  const [emailRes, reviewRes] = await Promise.all([qEmails, qReview]);
  if (emailRes.error || !emailRes.data) return emptyKpis();
  if (reviewRes.error || !reviewRes.data) return emptyKpis();

  const emailRows: EmailEntryInputRow[] = (
    emailRes.data as Array<{
      ticket_id: string;
      classification_result: { outcome?: TicketOutcome } | null;
      received_at: string;
    }>
  ).map((r) => ({
    ticket_id: r.ticket_id,
    outcome: (r.classification_result?.outcome ?? null) as TicketOutcome | null,
    received_at: r.received_at,
  }));

  const reviewRows = reviewRes.data as ReviewTimeInputRow[];

  return aggregateKpis(emailRows, reviewRows, windowStart, windowEnd);
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
 *
 * Source preserved at `tickets.latest_outcome` (PR-19/21). Switching
 * to email-entry timeline is the PR-Reports.B scope.
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
 * Top N apps by submit volume in window, sourced from email entries
 * (PR-Reports.A). Excludes unclassified tickets (`tickets.app_id IS
 * NULL`). `typeId` (PR-22) scopes through `tickets!inner` join so the
 * "Type → App" Manager flow lands on the same dimension as the KPIs.
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
    .from('email_messages')
    .select(
      'ticket_id, classification_result, received_at, tickets!inner(platform_id, app_id, type_id, apps!inner(name))',
    )
    .eq('tickets.platform_id', apple)
    .not('tickets.app_id', 'is', null)
    .gte('received_at', windowStart.toISOString())
    .lt('received_at', windowEnd.toISOString())
    .not('classification_result', 'is', null);
  if (typeId) q = q.eq('tickets.type_id', typeId);

  const { data, error } = await q;
  if (error || !data) return { rows: [], total_apps: 0 };

  // Supabase nests `tickets` + `apps` as either object or array
  // depending on join semantics; flatten to `groupByApp`'s shape.
  const flat: ByAppEmailInputRow[] = (
    data as Array<{
      ticket_id: string;
      classification_result: { outcome?: TicketOutcome } | null;
      received_at: string;
      tickets:
        | {
            app_id: string | null;
            apps: { name: string } | { name: string }[] | null;
          }
        | {
            app_id: string | null;
            apps: { name: string } | { name: string }[] | null;
          }[]
        | null;
    }>
  ).map((r) => {
    const ticket = Array.isArray(r.tickets) ? r.tickets[0] : r.tickets;
    const apps = ticket?.apps
      ? Array.isArray(ticket.apps)
        ? ticket.apps[0]
        : ticket.apps
      : null;
    return {
      ticket_id: r.ticket_id,
      app_id: ticket?.app_id ?? null,
      app_name: apps?.name ?? null,
      outcome: (r.classification_result?.outcome ?? null) as TicketOutcome | null,
      received_at: r.received_at,
    };
  });

  return groupByApp(flat, limit);
}

/**
 * Most recent N reject-reason entries on Apple tickets. Sourced from
 * `ticket_entries.entry_type='REJECT_REASON'` (manually logged free
 * text — no taxonomy yet, that's the deferred Phase-3 scope). Distinct
 * surface from the email-derived Reject KPI: this is what Managers
 * typed, not what Apple sent.
 *
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

  return (
    data as Array<{
      id: string;
      content: string | null;
      created_at: string;
      ticket_id: string;
      tickets:
        | {
            display_id: string;
            app_id: string | null;
            apps: { name: string } | { name: string }[] | null;
          }
        | {
            display_id: string;
            app_id: string | null;
            apps: { name: string } | { name: string }[] | null;
          }[]
        | null;
    }>
  ).map((r) => {
    const ticket = Array.isArray(r.tickets) ? r.tickets[0] : r.tickets;
    const apps = ticket?.apps
      ? Array.isArray(ticket.apps)
        ? ticket.apps[0]
        : ticket.apps
      : null;
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
