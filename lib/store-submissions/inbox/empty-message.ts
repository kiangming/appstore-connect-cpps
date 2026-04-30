/**
 * Empty-state copy resolver for the Inbox ticket list.
 *
 * Pure helper extracted from `InboxClient` (PR-13.3) so the state ×
 * outcome combo matrix is unit-testable without mounting the React tree.
 * Hybrid Option C: tab-specific copy for the default chip ("All"), a
 * generic combined message for non-default chips with a "clear the chip"
 * hint, and a single fallback when other filters (platform/app/search/
 * dates/sort) are also active — that hint takes precedence because the
 * Manager set those filters explicitly and is the most likely culprit
 * for a zero-result page.
 *
 * The `hasOtherFilters` boolean intentionally **excludes** the outcome
 * chip — outcome is part of the primary dimension matrix, not a
 * secondary filter, so it gets first-class wording instead of being
 * folded into the generic "current filters" copy.
 */
import type { OutcomeFilter } from '../schemas/ticket';

export type InboxTabKey =
  | 'open'
  | 'approved'
  | 'done'
  | 'archived'
  | 'unclassified';

export interface EmptyMessageInput {
  activeTab: InboxTabKey;
  /** `undefined` means the "All" chip is active (no outcome filter). */
  outcome: OutcomeFilter | undefined;
  /**
   * True when any non-outcome filter is set (platform / app / search /
   * date range / non-default sort). Outcome is reported separately via
   * the `outcome` field above.
   */
  hasOtherFilters: boolean;
}

const TAB_NOUN: Record<InboxTabKey, string> = {
  open: 'open',
  approved: 'approved',
  done: 'done',
  archived: 'archived',
  unclassified: 'unclassified',
};

const OUTCOME_LABEL: Record<Exclude<OutcomeFilter, 'none'>, string> = {
  APPROVED: 'Approve',
  REJECTED: 'Reject',
  IN_REVIEW: 'In review',
};

export function getEmptyMessage({
  activeTab,
  outcome,
  hasOtherFilters,
}: EmptyMessageInput): string {
  // Other filters take precedence — they're explicit Manager intent and
  // the most actionable thing to clear when the list comes back empty.
  if (hasOtherFilters) {
    return 'No tickets match the current filters.';
  }

  // Unclassified tab hides chips entirely (they'd be dead UI), so any
  // outcome value here is unreachable from the live UI but kept type-
  // safe for the helper's contract.
  if (activeTab === 'unclassified') {
    return 'All caught up — no tickets need classification right now.';
  }

  if (outcome === 'none') {
    return `All ${TAB_NOUN[activeTab]} tickets have an outcome assigned.`;
  }

  if (outcome) {
    return `No ${TAB_NOUN[activeTab]} tickets with outcome '${OUTCOME_LABEL[outcome]}'. Try clearing the chip filter.`;
  }

  switch (activeTab) {
    case 'open':
      return 'No open tickets. Everything is triaged.';
    case 'approved':
      return 'No approved tickets yet.';
    case 'done':
      return 'No tickets marked done.';
    case 'archived':
      return 'No archived tickets.';
  }
}
