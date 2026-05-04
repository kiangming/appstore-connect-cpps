/**
 * PR-19 Apple Reports — pure aggregator unit tests.
 *
 * Aggregator logic is extracted from the DB fetchers so we can drive
 * synthetic rows without mocking the Supabase client chain. End-to-end
 * fetcher behavior (platform-id resolution, JOIN unfolding) is
 * validated via Manager UAT MV8 post-deploy.
 */

import { describe, expect, it } from 'vitest';

import {
  aggregateKpis,
  bucketTrendByDay,
  groupByApp,
  truncateExcerpt,
} from './reports';
import type { TicketOutcome, TicketState } from '../schemas/ticket';

type ResolutionType = 'APPROVED' | 'DONE' | 'ARCHIVED' | null;

function row(opts: {
  opened: string;
  state?: TicketState;
  latest_outcome?: TicketOutcome | null;
  resolution_type?: ResolutionType;
  closed?: string | null;
  app_id?: string | null;
  app_name?: string | null;
}) {
  return {
    state: opts.state ?? 'NEW',
    latest_outcome: opts.latest_outcome ?? null,
    opened_at: opts.opened,
    closed_at: opts.closed ?? null,
    resolution_type: opts.resolution_type ?? null,
    app_id: opts.app_id ?? null,
    app_name: opts.app_name ?? null,
  };
}

describe('aggregateKpis', () => {
  const winStart = new Date('2026-04-04T00:00:00Z');
  const winEnd = new Date('2026-05-04T00:00:00Z'); // 30d window

  it('counts total / approved / rejected and computes avg review time', () => {
    const rows = [
      // Current window
      row({
        opened: '2026-04-10T00:00:00Z',
        state: 'APPROVED',
        resolution_type: 'APPROVED',
        closed: '2026-04-12T00:00:00Z', // 2-day review
      }),
      row({
        opened: '2026-04-15T00:00:00Z',
        state: 'DONE',
        resolution_type: 'APPROVED',
        closed: '2026-04-19T00:00:00Z', // 4-day review — Q2: counts as approved via resolution_type
      }),
      row({
        opened: '2026-04-20T00:00:00Z',
        state: 'REJECTED',
        latest_outcome: 'REJECTED',
      }),
      row({
        opened: '2026-04-22T00:00:00Z',
        state: 'NEW',
        latest_outcome: null,
      }),
      // Previous window — exercised by deltas test below
      row({
        opened: '2026-03-10T00:00:00Z',
        state: 'APPROVED',
        resolution_type: 'APPROVED',
        closed: '2026-03-13T00:00:00Z',
      }),
      row({
        opened: '2026-03-20T00:00:00Z',
        state: 'REJECTED',
        latest_outcome: 'REJECTED',
      }),
    ];

    const out = aggregateKpis(rows, winStart, winEnd);
    expect(out.total).toBe(4);
    expect(out.approved).toBe(2); // state=APPROVED + resolution_type=APPROVED-via-DONE
    expect(out.rejected).toBe(1);
    // Avg of (2d + 4d) = 3 days = 3 * 86400000 ms
    expect(out.avgReviewTimeMs).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it('computes deltas vs previous equally-sized window', () => {
    const rows = [
      // Current: 2 total
      row({ opened: '2026-04-10T00:00:00Z' }),
      row({ opened: '2026-04-20T00:00:00Z' }),
      // Previous: 1 total — 100% increase
      row({ opened: '2026-03-15T00:00:00Z' }),
    ];
    const out = aggregateKpis(rows, winStart, winEnd);
    expect(out.deltas.total).toBe(100);
  });

  it('returns null delta when previous window is empty (avoid /0)', () => {
    const rows = [row({ opened: '2026-04-10T00:00:00Z' })];
    const out = aggregateKpis(rows, winStart, winEnd);
    expect(out.deltas.total).toBeNull();
  });

  it('empty rows produce zero KPIs and null deltas', () => {
    const out = aggregateKpis([], winStart, winEnd);
    expect(out.total).toBe(0);
    expect(out.approved).toBe(0);
    expect(out.rejected).toBe(0);
    expect(out.avgReviewTimeMs).toBeNull();
    expect(out.deltas.total).toBeNull();
  });
});

describe('bucketTrendByDay', () => {
  const winStart = new Date('2026-05-01T00:00:00Z');
  const winEnd = new Date('2026-05-04T00:00:00Z'); // 3-day window

  it('seeds zero buckets for empty days and routes outcomes correctly', () => {
    const rows = [
      // Day 1: 1 approved (via resolution_type), 1 rejected
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
      // Day 2: empty (zero bucket)
      // Day 3: 1 in-review (latest_outcome=null routes to in_review)
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
});

describe('groupByApp', () => {
  it('groups by app_id, computes rate, sorts by submits desc, drops unclassified', () => {
    const rows = [
      { app_id: 'app-a', app_name: 'Skyline', latest_outcome: 'APPROVED' as TicketOutcome },
      { app_id: 'app-a', app_name: 'Skyline', latest_outcome: 'REJECTED' as TicketOutcome },
      { app_id: 'app-a', app_name: 'Skyline', latest_outcome: null },
      { app_id: 'app-b', app_name: 'Dragon', latest_outcome: 'REJECTED' as TicketOutcome },
      // Unclassified — must be dropped
      { app_id: null, app_name: null, latest_outcome: null },
    ];
    const out = groupByApp(rows, 5);
    expect(out.total_apps).toBe(2);
    expect(out.rows[0]).toMatchObject({
      app_id: 'app-a',
      app_name: 'Skyline',
      submits: 3,
      rejects: 1,
      rate: 1 / 3,
    });
    expect(out.rows[1]).toMatchObject({
      app_id: 'app-b',
      submits: 1,
      rejects: 1,
      rate: 1,
    });
  });

  it('respects limit (top N) while preserving total_apps for "View all N"', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      app_id: `app-${i}`,
      app_name: `App ${i}`,
      latest_outcome: null,
    }));
    const out = groupByApp(rows, 5);
    expect(out.rows).toHaveLength(5);
    expect(out.total_apps).toBe(8);
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
    // Confirm it cut at a space, not mid-word.
    expect(out.slice(0, -1).endsWith(' ')).toBe(false);
    expect(out.slice(0, -1).split(' ').every((w) => w === 'word' || w === '')).toBe(true);
  });
});
