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
  aggregateByGuideline,
  aggregateKpis,
  bucketTrendByDay,
  dedupBurstByTicket,
  extractGuidelines,
  groupByApp,
  truncateExcerpt,
} from './reports';
import type {
  EmailEntryInputRow,
  RejectReasonInputRow,
  ReviewTimeInputRow,
} from './reports';
import type { TicketOutcome } from '../schemas/ticket';

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
  // PR-Reports.B — Trend bucket clock switched from tickets.opened_at to
  // email_messages.received_at (4th PR-21 site flipped). Aggregation
  // mirrors KPI semantic from PR-Reports.A:
  //   - Approved: first-seen-per-ticket across window (Manager A2 DISTINCT)
  //   - Rejected: 60s burst-dedupped per ticket (Pattern 10 reuse #15)
  //   - IN_REVIEW: raw entry count (Manager A5 literal "count by entry")
  //   - null outcome: skipped
  //
  // Granularity adapts to range: ≤90d daily / ≤365d weekly / >365d monthly.

  describe('daily granularity (range ≤ 90 days)', () => {
    const winStart = new Date('2026-05-01T00:00:00Z');
    const winEnd = new Date('2026-05-04T00:00:00Z'); // 3-day window

    it('seeds zero buckets for empty days and routes outcomes correctly', () => {
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: 'APPROVED', received_at: '2026-05-01T03:00:00Z' }),
        emailRow({ ticket_id: 'T2', outcome: 'REJECTED', received_at: '2026-05-01T15:00:00Z' }),
        emailRow({ ticket_id: 'T3', outcome: 'IN_REVIEW', received_at: '2026-05-03T08:00:00Z' }),
      ];

      const out = bucketTrendByDay(rows, winStart, winEnd);
      expect(out).toHaveLength(3);
      expect(out[0]).toEqual({ date: '2026-05-01', approved: 1, in_review: 0, rejected: 1 });
      expect(out[1]).toEqual({ date: '2026-05-02', approved: 0, in_review: 0, rejected: 0 });
      expect(out[2]).toEqual({ date: '2026-05-03', approved: 0, in_review: 1, rejected: 0 });
    });

    it('skips null-outcome entries (DROPPED rows never appear in trend)', () => {
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: null, received_at: '2026-05-01T03:00:00Z' }),
        emailRow({ ticket_id: 'T2', outcome: 'APPROVED', received_at: '2026-05-02T03:00:00Z' }),
      ];
      const out = bucketTrendByDay(rows, winStart, winEnd);
      expect(out[0]).toEqual({ date: '2026-05-01', approved: 0, in_review: 0, rejected: 0 });
      expect(out[1]).toEqual({ date: '2026-05-02', approved: 1, in_review: 0, rejected: 0 });
    });

    it('dedups approves to first-seen per ticket across window (Manager A2 DISTINCT)', () => {
      // Same ticket, 2 APPROVED emails on different days → 1 approved
      // attributed to the EARLIER day. Apple bursts collapse; legitimate
      // re-approve on same ticket would be a data anomaly anyway.
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: 'APPROVED', received_at: '2026-05-03T10:00:00Z' }),
        emailRow({ ticket_id: 'T1', outcome: 'APPROVED', received_at: '2026-05-01T10:00:00Z' }),
      ];
      const out = bucketTrendByDay(rows, winStart, winEnd);
      expect(out[0]).toEqual({ date: '2026-05-01', approved: 1, in_review: 0, rejected: 0 });
      expect(out[2]).toEqual({ date: '2026-05-03', approved: 0, in_review: 0, rejected: 0 });
    });

    it('counts approves on different tickets separately (cross-ticket distinct)', () => {
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: 'APPROVED', received_at: '2026-05-01T10:00:00Z' }),
        emailRow({ ticket_id: 'T2', outcome: 'APPROVED', received_at: '2026-05-01T11:00:00Z' }),
      ];
      const out = bucketTrendByDay(rows, winStart, winEnd);
      expect(out[0]).toEqual({ date: '2026-05-01', approved: 2, in_review: 0, rejected: 0 });
    });

    it('burst-dedups rejects within 60s on same ticket and bucket', () => {
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-05-01T12:00:00Z' }),
        emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-05-01T12:00:30Z' }),
      ];
      const out = bucketTrendByDay(rows, winStart, winEnd);
      expect(out[0]).toEqual({ date: '2026-05-01', approved: 0, in_review: 0, rejected: 1 });
    });

    it('keeps reject events spaced > 60s as distinct bucket entries', () => {
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-05-01T12:00:00Z' }),
        emailRow({ ticket_id: 'T1', outcome: 'REJECTED', received_at: '2026-05-01T12:05:00Z' }),
      ];
      const out = bucketTrendByDay(rows, winStart, winEnd);
      expect(out[0]).toEqual({ date: '2026-05-01', approved: 0, in_review: 0, rejected: 2 });
    });

    it('counts IN_REVIEW raw per entry (Manager A5 — no dedup applied)', () => {
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: 'IN_REVIEW', received_at: '2026-05-01T03:00:00Z' }),
        emailRow({ ticket_id: 'T1', outcome: 'IN_REVIEW', received_at: '2026-05-01T03:00:10Z' }),
        emailRow({ ticket_id: 'T1', outcome: 'IN_REVIEW', received_at: '2026-05-01T04:00:00Z' }),
      ];
      const out = bucketTrendByDay(rows, winStart, winEnd);
      expect(out[0]).toEqual({ date: '2026-05-01', approved: 0, in_review: 3, rejected: 0 });
    });
  });

  describe('granularity threshold boundaries', () => {
    it('uses daily granularity at exactly 90 days', () => {
      // 2026-02-01 → 2026-05-02 = 90 days exactly.
      const winStart = new Date('2026-02-01T00:00:00Z');
      const winEnd = new Date('2026-05-02T00:00:00Z');
      const out = bucketTrendByDay([], winStart, winEnd);
      expect(out).toHaveLength(90); // one bucket per day
      expect(out[0]?.date).toBe('2026-02-01');
      expect(out[out.length - 1]?.date).toBe('2026-05-01');
    });

    it('uses weekly granularity at 91 days (just past daily threshold)', () => {
      // 2026-02-01 → 2026-05-03 = 91 days. Weekly buckets Monday-aligned.
      const winStart = new Date('2026-02-01T00:00:00Z'); // Sunday
      const winEnd = new Date('2026-05-03T00:00:00Z');
      const out = bucketTrendByDay([], winStart, winEnd);
      // Span Mondays inclusive: 2026-01-26, 02-02, 02-09, ..., 04-27 — 14 weeks
      expect(out).toHaveLength(14);
      // First bucket = Monday containing windowStart (Sunday Feb 1 → Mon Jan 26).
      expect(out[0]?.date).toBe('2026-01-26');
    });

    it('uses monthly granularity at 366 days (just past weekly threshold)', () => {
      // 2025-05-01 → 2026-05-02 = 366 days.
      const winStart = new Date('2025-05-01T00:00:00Z');
      const winEnd = new Date('2026-05-02T00:00:00Z');
      const out = bucketTrendByDay([], winStart, winEnd);
      // Months May 2025 through May 2026 = 13 buckets
      expect(out).toHaveLength(13);
      expect(out[0]?.date).toBe('2025-05-01');
      expect(out[out.length - 1]?.date).toBe('2026-05-01');
    });
  });

  describe('weekly granularity Monday-alignment (range > 90 days)', () => {
    const winStart = new Date('2026-02-01T00:00:00Z');
    const winEnd = new Date('2026-05-03T00:00:00Z'); // 91 days → weekly

    it('attributes a Wednesday entry to the Monday-aligned bucket', () => {
      // 2026-04-15 is a Wednesday. Monday of that week = 2026-04-13.
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: 'APPROVED', received_at: '2026-04-15T10:00:00Z' }),
      ];
      const out = bucketTrendByDay(rows, winStart, winEnd);
      const bucket = out.find((b) => b.date === '2026-04-13');
      expect(bucket).toEqual({ date: '2026-04-13', approved: 1, in_review: 0, rejected: 0 });
    });

    it('counts entries in the same week into one bucket (cross-day aggregation)', () => {
      // Mon 2026-04-13 + Wed 2026-04-15 + Fri 2026-04-17 — all attribute to
      // 2026-04-13 bucket. Different tickets to bypass approve dedup.
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: 'APPROVED', received_at: '2026-04-13T10:00:00Z' }),
        emailRow({ ticket_id: 'T2', outcome: 'APPROVED', received_at: '2026-04-15T10:00:00Z' }),
        emailRow({ ticket_id: 'T3', outcome: 'APPROVED', received_at: '2026-04-17T10:00:00Z' }),
      ];
      const out = bucketTrendByDay(rows, winStart, winEnd);
      const bucket = out.find((b) => b.date === '2026-04-13');
      expect(bucket?.approved).toBe(3);
    });
  });

  describe('monthly granularity 1st-of-month alignment (range > 365 days)', () => {
    const winStart = new Date('2025-05-01T00:00:00Z');
    const winEnd = new Date('2026-05-02T00:00:00Z'); // 366 days → monthly

    it('attributes a mid-month entry to the 1st-of-month bucket', () => {
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: 'APPROVED', received_at: '2025-08-15T10:00:00Z' }),
      ];
      const out = bucketTrendByDay(rows, winStart, winEnd);
      const bucket = out.find((b) => b.date === '2025-08-01');
      expect(bucket).toEqual({ date: '2025-08-01', approved: 1, in_review: 0, rejected: 0 });
    });

    it('aggregates within-month entries into one bucket', () => {
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: 'IN_REVIEW', received_at: '2025-08-01T03:00:00Z' }),
        emailRow({ ticket_id: 'T2', outcome: 'IN_REVIEW', received_at: '2025-08-15T10:00:00Z' }),
        emailRow({ ticket_id: 'T3', outcome: 'IN_REVIEW', received_at: '2025-08-31T23:00:00Z' }),
      ];
      const out = bucketTrendByDay(rows, winStart, winEnd);
      const bucket = out.find((b) => b.date === '2025-08-01');
      expect(bucket?.in_review).toBe(3);
    });

    it('handles month-boundary correctly (Aug 31 → Aug, Sep 1 → Sep)', () => {
      const rows = [
        emailRow({ ticket_id: 'T1', outcome: 'APPROVED', received_at: '2025-08-31T23:59:59Z' }),
        emailRow({ ticket_id: 'T2', outcome: 'APPROVED', received_at: '2025-09-01T00:00:00Z' }),
      ];
      const out = bucketTrendByDay(rows, winStart, winEnd);
      expect(out.find((b) => b.date === '2025-08-01')?.approved).toBe(1);
      expect(out.find((b) => b.date === '2025-09-01')?.approved).toBe(1);
    });
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
    const out = groupByApp(rows);
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
    const out = groupByApp(rows);
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
    const out = groupByApp(rows);
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
    const out = groupByApp(rows);
    expect(out.total_apps).toBe(0); // bucket never created — no APPROVED/REJECTED rows
  });

  it('returns all apps without truncation; total_apps equals rows.length (PR-Reports.A.1)', () => {
    // PR-Reports.A.1 dropped the top-N limit after Manager UAT MV17
    // surfaced KPI/by-app inconsistency: reject-having apps with low
    // submit volume were ranked outside the top-5 view, hiding the only
    // apps with rejects. At production scale (~14-25 apps/30d) the
    // unbounded list fits cleanly.
    const rows = Array.from({ length: 8 }, (_, i) => ({
      ticket_id: `t-${i}`,
      app_id: `app-${i}`,
      app_name: `App ${i}`,
      outcome: 'APPROVED' as TicketOutcome,
      received_at: '2026-04-10T12:00:00Z',
    }));
    const out = groupByApp(rows);
    expect(out.rows).toHaveLength(8);
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
    const out = groupByApp(rows);
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

// ---------------------------------------------------------------------------
// PR-Reports.RejectReasons — extractGuidelines + aggregateByGuideline
// ---------------------------------------------------------------------------

describe('extractGuidelines', () => {
  it('extracts 3-level X.X.X with ASCII hyphen (Manager spec)', () => {
    const text = 'Guideline 4.7.4 - Design - Mini apps, mini games';
    expect(extractGuidelines(text)).toEqual([
      { code: '4.7.4', description: 'Design - Mini apps, mini games' },
    ]);
  });

  it('extracts 2-level X.X', () => {
    const text = 'Guideline 4.7 - Design - Hardware Compatibility';
    expect(extractGuidelines(text)).toEqual([
      { code: '4.7', description: 'Design - Hardware Compatibility' },
    ]);
  });

  it('accepts en-dash and em-dash separators', () => {
    expect(extractGuidelines('Guideline 2.3.10 – Metadata')).toEqual([
      { code: '2.3.10', description: 'Metadata' },
    ]);
    expect(extractGuidelines('Guideline 2.3.10 — Metadata')).toEqual([
      { code: '2.3.10', description: 'Metadata' },
    ]);
  });

  it('handles variable whitespace around the dash', () => {
    expect(extractGuidelines('Guideline  4.7.4    -    Design')).toEqual([
      { code: '4.7.4', description: 'Design' },
    ]);
  });

  it('does NOT match inline lowercase mentions (Apple email body prose)', () => {
    const text = 'comply with the requirements in guideline 4.7';
    expect(extractGuidelines(text)).toEqual([]);
  });

  it('does NOT match the word Guideline without a numeric code on the line', () => {
    expect(extractGuidelines('Guideline 4.7.4 details in the next section')).toEqual(
      [],
    );
  });

  it('matches only on standalone lines (multi-paragraph email body)', () => {
    // Real-shape Apple email body excerpt (Q-RejectReason-1 TICKET-10012).
    const body = `Hello,

Review Environment

Submission ID: 2e45dd5f-acb5-4d00-b927-70bd3eca962f
Review date: April 24, 2026
Version reviewed: 1.4.5 (3)

Guideline 4.7.4 - Design - Mini apps, mini games, streaming games, chatbots, plug-ins, and game emulators


Issue Description

The app includes code for games or software not embedded in the binary, but the index you previously provided for the non-embedded games or software is insufficient.

Learn more about requirements for mini apps, mini games, streaming games, chatbots, plug-ins, and game emulators in guideline 4.7.4.`;
    const out = extractGuidelines(body);
    expect(out).toEqual([
      {
        code: '4.7.4',
        description:
          'Design - Mini apps, mini games, streaming games, chatbots, plug-ins, and game emulators',
      },
    ]);
  });

  it('extracts multiple Guidelines cited in one reason', () => {
    const text = `Guideline 2.3.10 - Performance - Accurate Metadata
Some prose here.

Guideline 4.7.4 - Design - Mini apps`;
    const out = extractGuidelines(text);
    expect(out).toHaveLength(2);
    expect(out.map((g) => g.code).sort()).toEqual(['2.3.10', '4.7.4']);
  });

  it('returns empty array on malformed (no Guideline header)', () => {
    expect(
      extractGuidelines('Just some rejection text without a header.'),
    ).toEqual([]);
  });

  it('handles empty and whitespace-only input', () => {
    expect(extractGuidelines('')).toEqual([]);
    expect(extractGuidelines('   \n\n   ')).toEqual([]);
  });

  // -- IAP.q.2.I — widened format scope (1-3 levels + sub-letter) ---------

  it('extracts bare top-level Guideline (1 level, e.g. "Guideline 3")', () => {
    expect(extractGuidelines('Guideline 3 - Business')).toEqual([
      { code: '3', description: 'Business' },
    ]);
  });

  it('extracts 2-level with sub-letter (e.g. "Guideline 2.1(b)")', () => {
    expect(extractGuidelines('Guideline 2.1(b) - Information Needed')).toEqual(
      [{ code: '2.1(b)', description: 'Information Needed' }],
    );
    expect(extractGuidelines('Guideline 4.3(a) - Design - Spam')).toEqual([
      { code: '4.3(a)', description: 'Design - Spam' },
    ]);
  });

  it('extracts 3-level with sub-letter (e.g. "Guideline 3.1.2(c)")', () => {
    expect(
      extractGuidelines(
        'Guideline 3.1.2(c) - Business - Payments - Subscriptions',
      ),
    ).toEqual([
      {
        code: '3.1.2(c)',
        description: 'Business - Payments - Subscriptions',
      },
    ]);
  });

  it('rejects uppercase sub-letter (Apple uses lowercase by convention)', () => {
    // Defensive: surfaces accidental copy-paste typo as "unparseable" so
    // Manager can see + correct. If Apple ever ships uppercase, regex
    // should be relaxed deliberately rather than silently accepted.
    expect(extractGuidelines('Guideline 2.1(B) - Information Needed')).toEqual(
      [],
    );
  });

  it('preserves sub-letter in canonical code (aggregation key fidelity)', () => {
    // 2.1(b) and 2.1(c) are semantically distinct Apple sub-clauses;
    // they MUST aggregate as separate buckets, not collapse onto 2.1.
    const text = `Guideline 2.1(b) - Information Needed
Guideline 2.1(c) - Information Needed
Guideline 2.1 - Information Needed`;
    const out = extractGuidelines(text);
    expect(out.map((g) => g.code).sort()).toEqual(['2.1', '2.1(b)', '2.1(c)']);
  });

  it('does NOT match 4-level numeric (defensive against accidental over-match)', () => {
    // Apple has not used 4+ levels in any observed email; keep the upper
    // bound at 3 to avoid swallowing version strings like "4.7.4.5" that
    // could appear in unrelated copy.
    expect(extractGuidelines('Guideline 4.7.4.5 - Some description')).toEqual(
      [],
    );
  });

  it('matches sub-letter formats inline among multi-paragraph email body', () => {
    // Real-shape blob mirroring TICKET-10021 Entry 2: three distinct
    // Apple citations interleaved with prose. All three must parse.
    const body = `Hello,

Guideline 2.1(b) - Information Needed

Issue Description: please provide additional info.

Guideline 4.3(a) - Design - Spam

Continue with cleanup steps below.

Guideline 3.1.2(c) - Business - Payments - Subscriptions
`;
    const out = extractGuidelines(body);
    expect(out).toHaveLength(3);
    expect(out.map((g) => g.code)).toEqual([
      '2.1(b)',
      '4.3(a)',
      '3.1.2(c)',
    ]);
  });
});

describe('aggregateByGuideline', () => {
  function rrRow(opts: {
    entry_id?: string;
    ticket_id?: string;
    ticket_display_id?: string;
    content: string;
    type_id?: string | null;
    type_name?: string | null;
    app_id?: string | null;
    app_name?: string | null;
  }): RejectReasonInputRow {
    // Note: explicit null must be preserved (used by attribution test) —
    // can't use `??` since it collapses null AND undefined to the default.
    const ticketId = opts.ticket_id ?? 'T1';
    return {
      entry_id: opts.entry_id ?? `E-${ticketId}-${Math.random().toString(36).slice(2, 8)}`,
      ticket_id: ticketId,
      ticket_display_id: opts.ticket_display_id ?? `TICKET-${ticketId}`,
      content: opts.content,
      type_id: 'type_id' in opts ? (opts.type_id ?? null) : 'type-app',
      type_name: 'type_name' in opts ? (opts.type_name ?? null) : 'App',
      app_id: 'app_id' in opts ? (opts.app_id ?? null) : 'app-1',
      app_name: 'app_name' in opts ? (opts.app_name ?? null) : 'App Alpha',
    };
  }

  it('counts each entry separately even on same ticket (Manager E.1 verbatim)', () => {
    // TICKET-10012 production case: 2 entries both citing 4.7.4 → total = 2.
    const rows = [
      rrRow({
        ticket_id: 'T10012',
        content: 'Guideline 4.7.4 - Design - Mini apps',
      }),
      rrRow({
        ticket_id: 'T10012',
        content: 'Guideline 4.7.4 - Design - Mini apps',
      }),
    ];
    const out = aggregateByGuideline(rows);
    expect(out.guidelines).toHaveLength(1);
    expect(out.guidelines[0].code).toBe('4.7.4');
    expect(out.guidelines[0].total).toBe(2);
    expect(out.totalReasons).toBe(2);
    expect(out.unparseableReasons).toBe(0);
  });

  it('dedups same code within a single entry (count = 1 for that row)', () => {
    const rows = [
      rrRow({
        content: `Guideline 4.7.4 - Design - Mini apps
Then later in the same email:
Guideline 4.7.4 - Design - Mini apps`,
      }),
    ];
    const out = aggregateByGuideline(rows);
    expect(out.guidelines[0].total).toBe(1);
  });

  it('counts multi-Guideline entries against each code independently', () => {
    const rows = [
      rrRow({
        content: `Guideline 2.3.10 - Performance - Accurate Metadata
Guideline 4.7.4 - Design - Mini apps`,
      }),
    ];
    const out = aggregateByGuideline(rows);
    expect(out.guidelines).toHaveLength(2);
    expect(out.guidelines.find((g) => g.code === '2.3.10')?.total).toBe(1);
    expect(out.guidelines.find((g) => g.code === '4.7.4')?.total).toBe(1);
  });

  it('groups by Type → App hierarchy', () => {
    const rows = [
      rrRow({
        content: 'Guideline 4.7.4 - Design - X',
        type_id: 'app',
        type_name: 'App',
        app_id: 'a1',
        app_name: 'Alpha',
      }),
      rrRow({
        content: 'Guideline 4.7.4 - Design - X',
        type_id: 'app',
        type_name: 'App',
        app_id: 'a1',
        app_name: 'Alpha',
      }),
      rrRow({
        content: 'Guideline 4.7.4 - Design - X',
        type_id: 'app',
        type_name: 'App',
        app_id: 'a2',
        app_name: 'Beta',
      }),
      rrRow({
        content: 'Guideline 4.7.4 - Design - X',
        type_id: 'game',
        type_name: 'Game',
        app_id: 'a3',
        app_name: 'Gamma',
      }),
    ];
    const out = aggregateByGuideline(rows);
    expect(out.guidelines[0].total).toBe(4);
    expect(out.guidelines[0].types).toHaveLength(2);
    // App (count=3) sorts before Game (count=1).
    expect(out.guidelines[0].types[0].type_name).toBe('App');
    expect(out.guidelines[0].types[0].count).toBe(3);
    // Within App: Alpha (2) before Beta (1).
    expect(out.guidelines[0].types[0].apps[0].app_name).toBe('Alpha');
    expect(out.guidelines[0].types[0].apps[0].count).toBe(2);
    expect(out.guidelines[0].types[0].apps[1].app_name).toBe('Beta');
    expect(out.guidelines[0].types[0].apps[1].count).toBe(1);
  });

  it('sorts guidelines by total DESC, then code ASC', () => {
    const rows = [
      rrRow({ content: 'Guideline 4.7.4 - X' }),
      rrRow({ content: 'Guideline 4.7.4 - X' }),
      rrRow({ content: 'Guideline 2.3.10 - Y' }),
      rrRow({ content: 'Guideline 4.7 - Z' }),
      rrRow({ content: 'Guideline 4.7 - Z' }),
    ];
    const out = aggregateByGuideline(rows);
    // 4.7.4 = 2, 4.7 = 2 (tied), 2.3.10 = 1. Tie-break by code ASC.
    expect(out.guidelines.map((g) => g.code)).toEqual(['4.7', '4.7.4', '2.3.10']);
  });

  it('counts unparseable rows separately (transparency footer)', () => {
    const rows = [
      rrRow({ content: 'Guideline 4.7.4 - X' }),
      rrRow({ content: 'No guideline header here' }),
      rrRow({ content: 'Another reason without header' }),
    ];
    const out = aggregateByGuideline(rows);
    expect(out.guidelines).toHaveLength(1);
    expect(out.unparseableReasons).toBe(2);
    expect(out.totalReasons).toBe(3);
  });

  it('skips Type/App attribution when ids are missing but counts code-level total', () => {
    const rows = [
      rrRow({
        content: 'Guideline 4.7.4 - X',
        type_id: null,
        app_id: null,
        type_name: null,
        app_name: null,
      }),
      rrRow({
        content: 'Guideline 4.7.4 - X',
        type_id: 'app',
        type_name: 'App',
        app_id: 'a1',
        app_name: 'Alpha',
      }),
    ];
    const out = aggregateByGuideline(rows);
    expect(out.guidelines[0].total).toBe(2);
    // Only the row with attribution shows in types breakdown.
    expect(out.guidelines[0].types).toHaveLength(1);
    expect(out.guidelines[0].types[0].count).toBe(1);
  });

  it('picks canonical description by frequency, tiebreak longest', () => {
    const rows = [
      rrRow({ content: 'Guideline 4.7.4 - Short' }),
      rrRow({ content: 'Guideline 4.7.4 - Longer description here' }),
      rrRow({ content: 'Guideline 4.7.4 - Longer description here' }),
    ];
    const out = aggregateByGuideline(rows);
    expect(out.guidelines[0].description).toBe('Longer description here');
  });

  it('returns empty result on empty input', () => {
    const out = aggregateByGuideline([]);
    expect(out).toEqual({
      guidelines: [],
      totalReasons: 0,
      unparseableReasons: 0,
      unparseableEntries: [],
    });
  });

  // -- IAP.q.2.V — unparseable entry surfacing ----------------------------

  it('surfaces unparseable rows with entry identity + content preview', () => {
    const rows = [
      rrRow({
        entry_id: 'E1',
        ticket_id: 'T-A',
        ticket_display_id: 'TICKET-10021',
        content: 'Free-text reject reason without any Guideline header',
      }),
      rrRow({
        entry_id: 'E2',
        ticket_id: 'T-B',
        ticket_display_id: 'TICKET-10022',
        content: 'Guideline 4.7.4 - Design - Mini apps', // parseable
      }),
      rrRow({
        entry_id: 'E3',
        ticket_id: 'T-A',
        ticket_display_id: 'TICKET-10021',
        content: 'Another paraphrased rejection in Vietnamese',
      }),
    ];
    const out = aggregateByGuideline(rows);
    expect(out.unparseableReasons).toBe(2);
    expect(out.unparseableEntries).toHaveLength(2);
    expect(out.unparseableEntries.map((e) => e.entry_id)).toEqual(['E1', 'E3']);
    expect(out.unparseableEntries[0]).toMatchObject({
      entry_id: 'E1',
      ticket_id: 'T-A',
      ticket_display_id: 'TICKET-10021',
    });
    // content_preview is the truncated raw text (truncateExcerpt default).
    expect(out.unparseableEntries[0].content_preview).toContain(
      'Free-text reject reason',
    );
  });

  it('preserves invariant unparseableReasons === unparseableEntries.length', () => {
    const rows = [
      rrRow({ content: 'No header A' }),
      rrRow({ content: 'No header B' }),
      rrRow({ content: 'No header C' }),
      rrRow({ content: 'Guideline 4.7.4 - X' }),
    ];
    const out = aggregateByGuideline(rows);
    expect(out.unparseableReasons).toBe(out.unparseableEntries.length);
    expect(out.unparseableReasons).toBe(3);
  });

  // -- IAP.q.2.I — multi-Guideline blob counting (TICKET-10021 Entry 2) ---

  it('counts each Guideline in a multi-blob entry as +1 independently', () => {
    // TICKET-10021 Entry 2 production case: a single reject_reason row
    // citing 3 distinct Guidelines → each contributes 1 to its bucket.
    const rows = [
      rrRow({
        ticket_id: 'T10021',
        ticket_display_id: 'TICKET-10021',
        content: `Guideline 2.1(b) - Information Needed
Some prose paragraph between citations.

Guideline 4.3(a) - Design - Spam
More prose.

Guideline 3.1.2(c) - Business - Payments - Subscriptions`,
      }),
    ];
    const out = aggregateByGuideline(rows);
    expect(out.guidelines).toHaveLength(3);
    expect(out.guidelines.map((g) => g.code).sort()).toEqual([
      '2.1(b)',
      '3.1.2(c)',
      '4.3(a)',
    ]);
    // Each cited once in the single row → total = 1 per code.
    for (const g of out.guidelines) {
      expect(g.total).toBe(1);
    }
    expect(out.totalReasons).toBe(1);
    expect(out.unparseableReasons).toBe(0);
  });
});
