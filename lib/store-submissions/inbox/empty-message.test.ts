import { describe, expect, it } from 'vitest';

import { getEmptyMessage } from './empty-message';

describe('getEmptyMessage', () => {
  it('returns the generic message when other filters are active (regardless of outcome chip)', () => {
    expect(
      getEmptyMessage({
        activeTab: 'open',
        outcome: 'APPROVED',
        hasOtherFilters: true,
      }),
    ).toBe('No tickets match the current filters.');
  });

  it('returns tab-specific copy when chip="All" (outcome undefined)', () => {
    expect(
      getEmptyMessage({
        activeTab: 'open',
        outcome: undefined,
        hasOtherFilters: false,
      }),
    ).toBe('No open tickets. Everything is triaged.');

    expect(
      getEmptyMessage({
        activeTab: 'approved',
        outcome: undefined,
        hasOtherFilters: false,
      }),
    ).toBe('No approved tickets yet.');

    expect(
      getEmptyMessage({
        activeTab: 'archived',
        outcome: undefined,
        hasOtherFilters: false,
      }),
    ).toBe('No archived tickets.');
  });

  it('combines tab + outcome label and adds clearing hint when chip is an enum value', () => {
    expect(
      getEmptyMessage({
        activeTab: 'open',
        outcome: 'APPROVED',
        hasOtherFilters: false,
      }),
    ).toBe(
      "No open tickets with outcome 'Approve'. Try clearing the chip filter.",
    );

    expect(
      getEmptyMessage({
        activeTab: 'done',
        outcome: 'REJECTED',
        hasOtherFilters: false,
      }),
    ).toBe(
      "No done tickets with outcome 'Reject'. Try clearing the chip filter.",
    );
  });

  it('explains the null branch when chip="No outcome"', () => {
    expect(
      getEmptyMessage({
        activeTab: 'approved',
        outcome: 'none',
        hasOtherFilters: false,
      }),
    ).toBe('All approved tickets have an outcome assigned.');
  });

  it('Unclassified tab returns the triage message regardless of outcome (chips hidden in UI)', () => {
    expect(
      getEmptyMessage({
        activeTab: 'unclassified',
        outcome: undefined,
        hasOtherFilters: false,
      }),
    ).toBe('All caught up — no tickets need classification right now.');

    expect(
      getEmptyMessage({
        activeTab: 'unclassified',
        outcome: 'REJECTED',
        hasOtherFilters: false,
      }),
    ).toBe('All caught up — no tickets need classification right now.');
  });
});
