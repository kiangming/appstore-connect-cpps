/**
 * Apple Reports — pure aggregator unit tests.
 *
 * PR-Reports.A: counting source flipped to email_messages with
 * Apple-burst-aware aggregation. Approved = COUNT(DISTINCT ticket_id);
 * Rejected = burst-dedup count with BURST_DEDUP_WINDOW_MS window.
 * Two-clock window model: KPI counts use received_at, avg review time
 * uses opened_at.
 *
 * Aggregator logic is extracted from the DB fetchers so we can drive
 * synthetic rows without mocking the Supabase client chain. End-to-end
 * fetcher behavior (platform-id resolution, JOIN unfolding, JSONB
 * extraction) is validated via Manager UAT MV17 post-deploy.
 */

import { describe, expect, it } from 'vitest';

import {
  BURST_DEDUP_WINDOW_MS,
  aggregateKpis,
  bucketTrendByDay,
  dedupBurstByTicket,
  groupByApp,
  truncateExcerpt,
} from './reports';
import type {
  EmailEntryInputRow,
  ReviewTimeInputRow,
} from './reports';
import type { TicketOutcome, TicketState } from '../schemas/ticket';

type ResolutionType = 'APPROVED' | 'DONE' | 'ARCHIVED' | null;

function emailRow(opts: {
  ticket_id: string;
  outcome: TicketOutcome | null;
  received_at: string;
}): EmailEntryInputRow {
  return {
    ticket_id: opts.ticket_id,
    outcome: opts.outcome,
    received_at: opts.received_at,
  };
}

function reviewRow(opts: {
  opened: string;
  closed: string;
}): ReviewTimeInputRow {
  return { opened_at: opts.opened, closed_at: opts.closed };
}

describe('dedupBurstByTicket', () => {
  it('returns empty for empty input', () => {
    expect(dedupBurstByTicket([])).toEqual([]);
  });

  it('keeps a single entry as-is', () => {
    const rows = [
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:00:00Z' }),
    ];
    const out = dedupBurstByTicket(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.received_at).toBe('2026-04-10T12:00:00Z');
  });

  it('collapses two same-ticket entries within 60s window', () => {
    const rows = [
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:00:00Z' }),
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:00:24Z' }),
    ];
    const out = dedupBurstByTicket(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.received_at).toBe('2026-04-10T12:00:00Z'); // earliest kept
  });

  it('keeps two same-ticket entries spaced beyond 60s window', () => {
    const rows = [
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:00:00Z' }),
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:01:01Z' }),
    ];
    const out = dedupBurstByTicket(rows);
    expect(out).toHaveLength(2);
  });

  it('boundary: exactly 60000ms gap collapses (gap not > windowMs)', () => {
    const rows = [
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:00:00.000Z' }),
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:01:00.000Z' }),
    ];
    const out = dedupBurstByTicket(rows);
    expect(out).toHaveLength(1);
  });

  it('boundary: 60001ms gap is preserved as separate event', () => {
    const rows = [
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:00:00.000Z' }),
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:01:00.001Z' }),
    ];
    const out = dedupBurstByTicket(rows);
    expect(out).toHaveLength(2);
  });

  it('mixed pattern: TICKET-10021 production scenario (4 entries → 2 cycles)', () => {
    // 2 bursts on same ticket, 3 days apart — each burst collapses to 1.
    const rows = [
      emailRow({ ticket_id: 'T21', outcome: 'REJECTED', received_at: '2026-04-28T18:55:05Z' }),
      emailRow({ ticket_id: 'T21', outcome: 'REJECTED', received_at: '2026-04-28T18:55:29Z' }),
      emailRow({ ticket_id: 'T21', outcome: 'REJECTED', received_at: '2026-05-01T09:56:08Z' }),
      emailRow({ ticket_id: 'T21', outcome: 'REJECTED', received_at: '2026-05-01T09:56:17Z' }),
    ];
    const out = dedupBurstByTicket(rows);
    expect(out).toHaveLength(2);
    expect(out[0]?.received_at).toBe('2026-04-28T18:55:05Z');
    expect(out[1]?.received_at).toBe('2026-05-01T09:56:08Z');
  });

  it('isolates ticket buckets — same-time entries on different tickets all kept', () => {
    const rows = [
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:00:00Z' }),
      emailRow({ ticket_id: 'T2', outcome: 'REJECTED', received_at: '2026-04-10T12:00:00Z' }),
      emailRow({ ticket_id: 'T3', outcome: 'REJECTED', received_at: '2026-04-10T12:00:00Z' }),
    ];
    const out = dedupBurstByTicket(rows);
    expect(out).toHaveLength(3);
  });

  it('handles unsorted input by sorting per-ticket internally', () => {
    const rows = [
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:00:24Z' }),
      emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-04-10T12:00:00Z' }),
    ];
    const out = dedupBurstByTicket(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.received_at).toBe('2026-04-10T12:00:00Z');
  });

  it('exposes BURST_DEDUP_WINDOW_MS = 60000 (calibrated against May 2026 production)', () => {
    expect(BURST_DEDUP_WINDOW_MS).toBe(60_000);
  });
});

describe('aggregateKpis', () => {
  const winStart = new Date('2026-04-04T00:00:00Z');
  const winEnd = new Date('2026-05-04T00:00:00Z'); // 30d window

  it('counts approved as DISTINCT ticket_id (Manager A2 enforced — Apple bursts collapse)', () => {
    // TICKET-A: 3 APPROVED emails (Apple burst pattern from production
    // Q-Anomaly-1, e.g. CookieRun TICKET-10010). DISTINCT collapses to 1.
    // TICKET-B: 1 APPROVED email. Counts as 1.
    // Total APPROVED entries = 4, but DISTINCT tickets = 2.
    const emails: EmailEntryInputRow[] = [
      emailRow({ ticket_id: 'A', outcome: 'APPROVED', received_at: '2026-04-10T09:40:11Z' }),
      emailRow({ ticket_id: 'A', outcome: 'APPROVED', received_at: '2026-04-10T09:40:55Z' }),
      emailRow({ ticket_id: 'A', outcome: 'APPROVED', received_at: '2026-04-10T09:40:56Z' }),
      emailRow({ ticket_id: 'B', outcome: 'APPROVED', received_at: '2026-04-15T12:00:00Z' }),
    ];
    const out = aggregateKpis(emails, [], winStart, winEnd);
    expect(out.approved).toBe(2);
    expect(out.total).toBe(2);
  });

  it('counts rejected as burst-dedupped events (Manager A2 cycle semantic)', () => {
    // TICKET-21 production scenario: 4 entries → 2 cycles (burst dedup).
    // TICKET-16 burst: 2 entries → 1 cycle.
    // TICKET-18 spread: 2 entries → 2 cycles (>60s apart).
    // TICKET-S single reject: 1 cycle.
    // Total entries = 9, dedupped = 6.
    const emails: EmailEntryInputRow[] = [
      emailRow({ ticket_id: 'T21', outcome: 'REJECTED', received_at: '2026-04-28T18:55:05Z' }),
      emailRow({ ticket_id: 'T21', outcome: 'REJECTED', received_at: '2026-04-28T18:55:29Z' }),
      emailRow({ ticket_id: 'T21', outcome: 'REJECTED', received_at: '2026-05-01T09:56:08Z' }),
      emailRow({ ticket_id: 'T21', outcome: 'REJECTED', received_at: '2026-05-01T09:56:17Z' }),
      emailRow({ ticket_id: 'T16', outcome: 'REJECTED', received_at: '2026-04-24T17:39:52Z' }),
      emailRow({ ticket_id: 'T16', outcome: 'REJECTED', received_at: '2026-04-24T17:40:16Z' }),
      emailRow({ ticket_id: 'T18', outcome: 'REJECTED', received_at: '2026-04-30T10:19:52Z' }),
      emailRow({ ticket_id: 'T18', outcome: 'REJECTED', received_at: '2026-05-02T18:48:49Z' }),
      emailRow({ ticket_id: 'TS', outcome: 'REJECTED', received_at: '2026-04-15T08:00:00Z' }),
    ];
    const out = aggregateKpis(emails, [], winStart, winEnd);
    expect(out.rejected).toBe(6);
    expect(out.total).toBe(4); // 4 distinct tickets touched
  });

  it('total = COUNT(DISTINCT ticket_id) across both APPROVED + REJECTED entries (Q2 Option A)', () => {
    const emails: EmailEntryInputRow[] = [
      emailRow({ ticket_id: 'A', outcome: 'APPROVED', received_at: '2026-04-10T12:00:00Z' }),
      emailRow({ ticket_id: 'A', outcome: 'REJECTED', received_at: '2026-04-09T12:00:00Z' }), // same ticket
      emailRow({ ticket_id: 'B', outcome: 'APPROVED', received_at: '2026-04-12T12:00:00Z' }),
      emailRow({ ticket_id: 'C', outcome: 'REJECTED', received_at: '2026-04-13T12:00:00Z' }),
    ];
    const out = aggregateKpis(emails, [], winStart, winEnd);
    expect(out.total).toBe(3); // A, B, C
  });

  it('IN_REVIEW outcome filtered out of all count predicates', () => {
    const emails: EmailEntryInputRow[] = [
      emailRow({ ticket_id: 'A', outcome: 'IN_REVIEW', received_at: '2026-04-10T12:00:00Z' }),
      emailRow({ ticket_id: 'B', outcome: 'IN_REVIEW', received_at: '2026-04-11T12:00:00Z' }),
    ];
    const out = aggregateKpis(emails, [], winStart, winEnd);
    expect(out.approved).toBe(0);
    expect(out.rejected).toBe(0);
    expect(out.total).toBe(0);
  });

  it('null outcome (DROPPED/ERROR rows that slipped through SQL filter) ignored', () => {
    const emails: EmailEntryInputRow[] = [
      emailRow({ ticket_id: 'A', outcome: null, received_at: '2026-04-10T12:00:00Z' }),
      emailRow({ ticket_id: 'B', outcome: 'APPROVED', received_at: '2026-04-11T12:00:00Z' }),
    ];
    const out = aggregateKpis(emails, [], winStart, winEnd);
    expect(out.approved).toBe(1);
    expect(out.total).toBe(1);
  });

  it('avg review time uses opened_at clock, latest_outcome=APPROVED filtered SQL-side', () => {
    // Caller passes only APPROVED-state review rows; aggregator just averages.
    const reviews: ReviewTimeInputRow[] = [
      reviewRow({ opened: '2026-04-10T00:00:00Z', closed: '2026-04-12T00:00:00Z' }), // 2d
      reviewRow({ opened: '2026-04-15T00:00:00Z', closed: '2026-04-19T00:00:00Z' }), // 4d
    ];
    const out = aggregateKpis([], reviews, winStart, winEnd);
    expect(out.avgReviewTimeMs).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it('two-clock independence: emails partitioned by received_at, reviews by opened_at', () => {
    // Email arrives in current window for a ticket opened in previous window.
    // Approved KPI: counts the email (current window).
    // Avg review time: ticket falls in previous window (opened_at), so its
    // review time is excluded from the current-window avg.
    const emails: EmailEntryInputRow[] = [
      emailRow({ ticket_id: 'A', outcome: 'APPROVED', received_at: '2026-04-15T00:00:00Z' }),
    ];
    const reviews: ReviewTimeInputRow[] = [
      reviewRow({ opened: '2026-03-10T00:00:00Z', closed: '2026-04-15T00:00:00Z' }),
    ];
    const out = aggregateKpis(emails, reviews, winStart, winEnd);
    expect(out.approved).toBe(1);
    expect(out.avgReviewTimeMs).toBeNull(); // ticket opened outside current window
  });

  it('computes deltas vs previous equally-sized window (email clock)', () => {
    const emails: EmailEntryInputRow[] = [
      emailRow({ ticket_id: 'A', outcome: 'APPROVED', received_at: '2026-04-10T12:00:00Z' }),
      emailRow({ ticket_id: 'B', outcome: 'APPROVED', received_at: '2026-04-20T12:00:00Z' }),
      emailRow({ ticket_id: 'C', outcome: 'APPROVED', received_at: '2026-03-15T12:00:00Z' }),
    ];
    const out = aggregateKpis(emails, [], winStart, winEnd);
    expect(out.deltas.approved).toBe(100); // 2 vs 1 = +100%
  });

  it('returns null delta when previous window is empty (avoid /0)', () => {
    const emails: EmailEntryInputRow[] = [
      emailRow({ ticket_id: 'A', outcome: 'APPROVED', received_at: '2026-04-10T12:00:00Z' }),
    ];
    const out = aggregateKpis(emails, [], winStart, winEnd);
    expect(out.deltas.approved).toBeNull();
    expect(out.deltas.total).toBeNull();
  });

  it('empty inputs produce zero KPIs and null deltas', () => {
    const out = aggregateKpis([], [], winStart, winEnd);
    expect(out.total).toBe(0);
    expect(out.approved).toBe(0);
    expect(out.rejected).toBe(0);
    expect(out.avgReviewTimeMs).toBeNull();
    expect(out.deltas.total).toBeNull();
  });

  it('avg review time delta computed when both windows have approved tickets', () => {
    const reviews: ReviewTimeInputRow[] = [
      // current: avg = 4d
      reviewRow({ opened: '2026-04-10T00:00:00Z', closed: '2026-04-14T00:00:00Z' }),
      // previous: avg = 2d
      reviewRow({ opened: '2026-03-15T00:00:00Z', closed: '2026-03-17T00:00:00Z' }),
    ];
    const out = aggregateKpis([], reviews, winStart, winEnd);
    expect(out.deltas.avgReviewTime).toBe(100); // 4d vs 2d = +100%
  });

  it('approved Manager Play Together scenario (production validation)', () => {
    // TICKET-10018 received reject → reject (cycle) → approve cumulative.
    // PR-Reports.A intent: Reject KPI counts both reject events
    // (resubmit cycle visibility); Approve KPI counts the ticket once.
    const emails: EmailEntryInputRow[] = [
      emailRow({ ticket_id: 'PT', outcome: 'REJECTED', received_at: '2026-04-30T10:19:52Z' }),
      emailRow({ ticket_id: 'PT', outcome: 'REJECTED', received_at: '2026-05-02T18:48:49Z' }),
      emailRow({ ticket_id: 'PT', outcome: 'APPROVED', received_at: '2026-05-03T15:00:00Z' }),
    ];
    const out = aggregateKpis(emails, [], winStart, winEnd);
    expect(out.rejected).toBe(2); // both spread cycles count
    expect(out.approved).toBe(1); // single distinct ticket
    expect(out.total).toBe(1); // one distinct submission
  });
});

describe('bucketTrendByDay', () => {
  // Trend chart source preserved at tickets.latest_outcome (PR-19/21);
  // PR-Reports.B will switch this clock to email timeline. Tests below
  // exercise the legacy semantic that's still in production after PR-Reports.A.

  const winStart = new Date('2026-05-01T00:00:00Z');
  const winEnd = new Date('2026-05-04T00:00:00Z'); // 3-day window

  it('seeds zero buckets for empty days and routes outcomes correctly', () => {
    const rows = [
      {
        opened_at: '2026-05-01T03:00:00Z',
        state: 'DONE' as TicketState,
        resolution_type: 'APPROVED' as ResolutionType,
        latest_outcome: 'APPROVED' as TicketOutcome,
      },
      {
        opened_at: '2026-05-01T15:00:00Z',
        state: 'REJECTED' as TicketState,
        resolution_type: null,
        latest_outcome: 'REJECTED' as TicketOutcome,
      },
      {
        opened_at: '2026-05-03T08:00:00Z',
        state: 'NEW' as TicketState,
        resolution_type: null,
        latest_outcome: null,
      },
    ];

    const out = bucketTrendByDay(rows, winStart, winEnd);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ date: '2026-05-01', approved: 1, in_review: 0, rejected: 1 });
    expect(out[1]).toEqual({ date: '2026-05-02', approved: 0, in_review: 0, rejected: 0 });
    expect(out[2]).toEqual({ date: '2026-05-03', approved: 0, in_review: 1, rejected: 0 });
  });

  it('routes Manager-terminal-without-Apple-verdict rows to in_review (PR-21)', () => {
    const rows = [
      {
        opened_at: '2026-05-01T10:00:00Z',
        state: 'APPROVED' as TicketState,
        resolution_type: 'APPROVED' as ResolutionType,
        latest_outcome: null,
      },
      {
        opened_at: '2026-05-02T10:00:00Z',
        state: 'DONE' as TicketState,
        resolution_type: 'DONE' as ResolutionType,
        latest_outcome: null,
      },
    ];

    const out = bucketTrendByDay(rows, winStart, winEnd);
    expect(out[0]).toEqual({ date: '2026-05-01', approved: 0, in_review: 1, rejected: 0 });
    expect(out[1]).toEqual({ date: '2026-05-02', approved: 0, in_review: 1, rejected: 0 });
  });
});

describe('groupByApp', () => {
  it('submits = COUNT(DISTINCT ticket_id), rejects = burst-dedupped count', () => {
    // App-A: 2 distinct tickets, ticket-1 has burst (2 within 60s) +
    // spread (3rd email >60s later) — 1 burst-collapse + 1 spread = 2 rejects.
    // ticket-2 has 1 approve (no rejects). Submits for App-A: 2.
    // Total App-A rejects: 2. Rate = 2/2 = 1.0.
    const rows = [
      {
        ticket_id: 't1',
        app_id: 'app-a',
        app_name: 'Skyline',
        outcome: 'REJECTED' as TicketOutcome,
        received_at: '2026-04-10T12:00:00Z',
      },
      {
        ticket_id: 't1',
        app_id: 'app-a',
        app_name: 'Skyline',
        outcome: 'REJECTED' as TicketOutcome,
        received_at: '2026-04-10T12:00:24Z', // burst — collapses
      },
      {
        ticket_id: 't1',
        app_id: 'app-a',
        app_name: 'Skyline',
        outcome: 'REJECTED' as TicketOutcome,
        received_at: '2026-04-12T12:00:00Z', // spread — separate
      },
      {
        ticket_id: 't2',
        app_id: 'app-a',
        app_name: 'Skyline',
        outcome: 'APPROVED' as TicketOutcome,
        received_at: '2026-04-15T12:00:00Z',
      },
    ];
    const out = groupByApp(rows, 5);
    expect(out.total_apps).toBe(1);
    expect(out.rows[0]).toMatchObject({
      app_id: 'app-a',
      app_name: 'Skyline',
      submits: 2,
      rejects: 2,
      rate: 1,
    });
  });

  it('rate can exceed 1.0 when a single ticket has multiple reject cycles', () => {
    // 1 distinct ticket with 3 cycles of rejects (well-spread) + no approve.
    // submits=1, rejects=3, rate=3.0 (Manager domain semantic).
    const rows = [
      {
        ticket_id: 't1',
        app_id: 'app-x',
        app_name: 'HighRework',
        outcome: 'REJECTED' as TicketOutcome,
        received_at: '2026-04-10T12:00:00Z',
      },
      {
        ticket_id: 't1',
        app_id: 'app-x',
        app_name: 'HighRework',
        outcome: 'REJECTED' as TicketOutcome,
        received_at: '2026-04-13T12:00:00Z',
      },
      {
        ticket_id: 't1',
        app_id: 'app-x',
        app_name: 'HighRework',
        outcome: 'REJECTED' as TicketOutcome,
        received_at: '2026-04-16T12:00:00Z',
      },
    ];
    const out = groupByApp(rows, 5);
    expect(out.rows[0]).toMatchObject({ submits: 1, rejects: 3, rate: 3 });
  });

  it('drops unclassified (app_id=null) rows', () => {
    const rows = [
      {
        ticket_id: 't1',
        app_id: 'app-a',
        app_name: 'Skyline',
        outcome: 'APPROVED' as TicketOutcome,
        received_at: '2026-04-10T12:00:00Z',
      },
      {
        ticket_id: 't0',
        app_id: null,
        app_name: null,
        outcome: 'APPROVED' as TicketOutcome,
        received_at: '2026-04-11T12:00:00Z',
      },
    ];
    const out = groupByApp(rows, 5);
    expect(out.total_apps).toBe(1);
    expect(out.rows[0]?.app_id).toBe('app-a');
  });

  it('drops IN_REVIEW and null-outcome rows from app counts', () => {
    const rows = [
      {
        ticket_id: 't1',
        app_id: 'app-a',
        app_name: 'Skyline',
        outcome: 'IN_REVIEW' as TicketOutcome,
        received_at: '2026-04-10T12:00:00Z',
      },
      {
        ticket_id: 't2',
        app_id: 'app-a',
        app_name: 'Skyline',
        outcome: null,
        received_at: '2026-04-11T12:00:00Z',
      },
    ];
    const out = groupByApp(rows, 5);
    expect(out.total_apps).toBe(0); // bucket never created — no APPROVED/REJECTED rows
  });

  it('respects limit (top N) while preserving total_apps for "View all N"', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      ticket_id: `t-${i}`,
      app_id: `app-${i}`,
      app_name: `App ${i}`,
      outcome: 'APPROVED' as TicketOutcome,
      received_at: '2026-04-10T12:00:00Z',
    }));
    const out = groupByApp(rows, 5);
    expect(out.rows).toHaveLength(5);
    expect(out.total_apps).toBe(8);
  });

  it('sorts by submits desc, ties broken by app_name asc', () => {
    const rows = [
      // app-b: 2 submits
      {
        ticket_id: 'b1',
        app_id: 'app-b',
        app_name: 'Beta',
        outcome: 'APPROVED' as TicketOutcome,
        received_at: '2026-04-10T12:00:00Z',
      },
      {
        ticket_id: 'b2',
        app_id: 'app-b',
        app_name: 'Beta',
        outcome: 'APPROVED' as TicketOutcome,
        received_at: '2026-04-11T12:00:00Z',
      },
      // app-a: 1 submit
      {
        ticket_id: 'a1',
        app_id: 'app-a',
        app_name: 'Alpha',
        outcome: 'APPROVED' as TicketOutcome,
        received_at: '2026-04-12T12:00:00Z',
      },
      // app-c: 1 submit (tie with app-a; sort by name)
      {
        ticket_id: 'c1',
        app_id: 'app-c',
        app_name: 'Charlie',
        outcome: 'APPROVED' as TicketOutcome,
        received_at: '2026-04-13T12:00:00Z',
      },
    ];
    const out = groupByApp(rows, 5);
    expect(out.rows.map((r) => r.app_name)).toEqual(['Beta', 'Alpha', 'Charlie']);
  });
});

describe('truncateExcerpt', () => {
  it('passes short content through and collapses whitespace', () => {
    expect(truncateExcerpt('  hello\n\n  world  ')).toBe('hello world');
  });

  it('truncates at word boundary with ellipsis', () => {
    const longText = 'word '.repeat(100); // 500 chars
    const out = truncateExcerpt(longText, 50);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.slice(0, -1).endsWith(' ')).toBe(false);
    expect(out.slice(0, -1).split(' ').every((w) => w === 'word' || w === '')).toBe(true);
  });
});
