// @vitest-environment jsdom

/**
 * Renderer tests for KpiCards Manager-education tooltips
 * (PR-Reports.Tooltips, MV17 preventive).
 *
 * Tooltips surface via native HTML `title=` on a small Info icon next to
 * each card label — matches the codebase precedent (FilterPill + TicketBadges).
 * Copy is grounded against `lib/store-submissions/queries/reports.ts`
 * aggregator semantics and verified before ship (Pattern 10 reuse #18).
 *
 * Tests assert presence + exact text of all four tooltips and include a
 * regression guard for the Card component's `tooltip?: string` optional
 * contract.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { KpiCards } from './KpiCards';
import type { ReportsKpis } from '@/lib/store-submissions/queries/reports';

const TOOLTIP_TOTAL =
  'Tickets with outcome (APPROVED or REJECTED) in window. DISTINCT ticket count — IN_REVIEW and no-outcome tickets excluded.';
const TOOLTIP_APPROVED =
  'Apple may send multiple approval emails per ticket. Counted as 1 per ticket (DISTINCT ticket_id).';
const TOOLTIP_REJECTED =
  'Apple may retry rejection emails within seconds. 60-second burst dedup collapses each burst to 1; separate resubmit rejections count as separate cycles.';
const TOOLTIP_AVG_REVIEW =
  'Mean time from ticket open (opened_at) to Mark Done (closed_at). APPROVED tickets only — closed_at = auto-done moment or Manager Mark Done click.';

function makeKpis(): ReportsKpis {
  return {
    total: 42,
    approved: 30,
    rejected: 12,
    avgReviewTimeMs: 3 * 60 * 60 * 1000,
    deltas: {
      total: 5,
      approved: 10,
      rejected: -3,
      avgReviewTime: -8,
    },
  };
}

describe('KpiCards · Manager-education tooltips', () => {
  it('renders Total tooltip with DISTINCT (APPROVED or REJECTED) semantic', () => {
    render(<KpiCards kpis={makeKpis()} windowDays={30} />);
    expect(screen.getByTitle(TOOLTIP_TOTAL)).toBeInTheDocument();
  });

  it('renders Approved tooltip with DISTINCT ticket_id semantic', () => {
    render(<KpiCards kpis={makeKpis()} windowDays={30} />);
    expect(screen.getByTitle(TOOLTIP_APPROVED)).toBeInTheDocument();
  });

  it('renders Rejected tooltip with 60-second burst dedup semantic', () => {
    render(<KpiCards kpis={makeKpis()} windowDays={30} />);
    expect(screen.getByTitle(TOOLTIP_REJECTED)).toBeInTheDocument();
  });

  it('renders Avg. review time tooltip with opened_at → closed_at semantic', () => {
    render(<KpiCards kpis={makeKpis()} windowDays={30} />);
    expect(screen.getByTitle(TOOLTIP_AVG_REVIEW)).toBeInTheDocument();
  });

  it('renders all four cards (one Info affordance per card)', () => {
    // Regression guard: the Card component's `tooltip?: string` is optional;
    // KpiCards itself passes one to each of its four instances. If a tooltip
    // is dropped from a card or the Card stops rendering the Info icon when
    // `tooltip` is provided, this count drops.
    const { container } = render(<KpiCards kpis={makeKpis()} windowDays={30} />);
    const tooltipSpans = container.querySelectorAll('span[title]');
    expect(tooltipSpans).toHaveLength(4);
  });
});
