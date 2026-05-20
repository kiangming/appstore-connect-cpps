// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  GuidelineBreakdown,
  RejectReasonBreakdownResult,
  UnparseableEntry,
} from '@/lib/store-submissions/queries/reports';

import { GuidelineBreakdownTable } from './GuidelineBreakdownTable';

function guideline(code: string, total = 1): GuidelineBreakdown {
  return { code, description: `${code} desc`, total, types: [] };
}

function entry(n: number): UnparseableEntry {
  return {
    entry_id: `E-${n}`,
    ticket_id: `T-${n}`,
    ticket_display_id: `TICKET-${10000 + n}`,
    content_preview: `Free-text reject reason ${n}`,
  };
}

function result(
  guidelines: GuidelineBreakdown[],
  unparseableEntries: UnparseableEntry[],
): RejectReasonBreakdownResult {
  return {
    guidelines,
    totalReasons: guidelines.length + unparseableEntries.length,
    unparseableReasons: unparseableEntries.length,
    unparseableEntries,
  };
}

describe('GuidelineBreakdownTable — IAP.q.3 pagination integration', () => {
  // -- SQ1: hide-when-≤20 threshold --------------------------------------

  it('Main Guidelines: NO pagination controls when guidelines ≤ 20', () => {
    const guidelines = Array.from({ length: 20 }, (_, i) =>
      guideline(`4.${i}`, 20 - i),
    );
    const { queryByLabelText } = render(
      <GuidelineBreakdownTable result={result(guidelines, [])} />,
    );
    expect(queryByLabelText('Previous page')).toBeNull();
    expect(queryByLabelText('Next page')).toBeNull();
  });

  it('Main Guidelines: pagination controls visible when guidelines > 20', () => {
    const guidelines = Array.from({ length: 25 }, (_, i) =>
      guideline(`4.${i}`, 25 - i),
    );
    const { getByLabelText, getByText } = render(
      <GuidelineBreakdownTable result={result(guidelines, [])} />,
    );
    expect(getByLabelText('Previous page')).toBeInTheDocument();
    expect(getByLabelText('Next page')).toBeInTheDocument();
    expect(getByText(/Page 1 of 2/)).toBeInTheDocument();
    expect(getByText(/25 items total/)).toBeInTheDocument();
  });

  it('Main Guidelines: clicking Next advances to page 2 of slicing', () => {
    const guidelines = Array.from({ length: 25 }, (_, i) =>
      guideline(`4.${i}`, 25 - i),
    );
    const { getByLabelText, getByText, queryByText } = render(
      <GuidelineBreakdownTable result={result(guidelines, [])} />,
    );
    // Page 1 shows first 20 codes (4.0..4.19); 4.20..4.24 are hidden.
    expect(queryByText('4.24')).toBeNull();
    fireEvent.click(getByLabelText('Next page'));
    expect(getByText(/Page 2 of 2/)).toBeInTheDocument();
    expect(getByText('4.24')).toBeInTheDocument();
  });

  // -- UnparseableFooter pagination + SQ3: preserve on collapse ---------

  it('UnparseableFooter: NO pagination controls when entries ≤ 20', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(i));
    const { getByText, queryByLabelText } = render(
      <GuidelineBreakdownTable result={result([], entries)} />,
    );
    fireEvent.click(getByText(/Show details/));
    expect(queryByLabelText('Previous page')).toBeNull();
    expect(queryByLabelText('Next page')).toBeNull();
  });

  it('UnparseableFooter: pagination controls visible when entries > 20', () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry(i));
    const { getByText, getByLabelText } = render(
      <GuidelineBreakdownTable result={result([], entries)} />,
    );
    fireEvent.click(getByText(/Show details/));
    expect(getByLabelText('Previous page')).toBeInTheDocument();
    expect(getByLabelText('Next page')).toBeInTheDocument();
    expect(getByText(/Page 1 of 2/)).toBeInTheDocument();
    expect(getByText(/25 items total/)).toBeInTheDocument();
  });

  it('UnparseableFooter: page state preserved across collapse/reopen (SQ3)', () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry(i));
    const { getByText, getByLabelText, queryByText } = render(
      <GuidelineBreakdownTable result={result([], entries)} />,
    );
    // Open + advance to page 2.
    fireEvent.click(getByText(/Show details/));
    fireEvent.click(getByLabelText('Next page'));
    expect(getByText(/Page 2 of 2/)).toBeInTheDocument();
    expect(getByText('TICKET-10024')).toBeInTheDocument();

    // Collapse.
    fireEvent.click(getByText(/Hide details/));
    expect(queryByText('TICKET-10024')).toBeNull();

    // Reopen — page state must still be page 2 (entries 21-25 visible).
    fireEvent.click(getByText(/Show details/));
    expect(getByText(/Page 2 of 2/)).toBeInTheDocument();
    expect(getByText('TICKET-10024')).toBeInTheDocument();
  });
});
