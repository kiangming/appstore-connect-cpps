'use client';

/**
 * Thin client wrapper around TicketListTable for the dedicated
 * /inbox/auto-completed view (PR-16b Q1.E).
 *
 * Server Component fetches the rows; this client adds the row-click
 * navigation that opens the standard TicketDetailPanel via the main
 * Inbox route. Reusing the panel (rather than rendering a duplicate
 * one here) keeps reopen / reclassify / comment affordances on a
 * single canonical surface.
 */

import { useRouter } from 'next/navigation';

import type { TicketListRow } from '@/lib/store-submissions/queries/tickets';

import { TicketListTable } from './TicketListTable';

export interface AutoCompletedListClientProps {
  tickets: TicketListRow[];
}

export function AutoCompletedListClient({
  tickets,
}: AutoCompletedListClientProps) {
  const router = useRouter();

  return (
    <TicketListTable
      tickets={tickets}
      onRowClick={(ticket) => {
        router.push(
          `/store-submissions/inbox?ticket=${encodeURIComponent(ticket.id)}`,
        );
      }}
      emptyMessage="No auto-completed tickets in the last 7 days."
    />
  );
}
