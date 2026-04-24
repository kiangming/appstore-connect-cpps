'use client';

/**
 * Inbox ticket list table — CSS-grid based (matches AppsClient row
 * layout, not native <table>). Rows are click-targets that will open
 * the ticket detail panel in PR-10b; for now they're no-op with cursor
 * pointer + hover so the affordance is visible.
 *
 * Column decisions:
 *   - display_id, app, platform, state, latest_outcome, opened_at,
 *     entry count
 *   - No assignee column (ASSIGN action deferred post-MVP per scope trim)
 *   - No updated_at / priority column — `Sort` FilterPill in InboxClient
 *     already exposes those sort modes without dedicating screen real
 *     estate to the column
 *
 * Sortable headers: **intentionally not implemented**. The Sort pill in
 * InboxClient is the single source of truth for sort; adding arrow
 * indicators on headers introduces two UI surfaces for the same state
 * and raises "should arrow click re-sort, or just indicate?" friction.
 * Revisit if usability testing shows users expect header sort. For now,
 * headers are descriptive labels.
 *
 * State / latest_outcome / opened_at render as raw strings here.
 * PR-10.2.4 swaps in proper badges + relative-time formatting.
 */

import type { TicketListRow } from '@/lib/store-submissions/queries/tickets';

const GRID = 'grid-cols-[120px_1fr_100px_110px_110px_120px_60px]';

export interface TicketListTableProps {
  tickets: TicketListRow[];
  onRowClick?: (ticket: TicketListRow) => void;
}

export function TicketListTable({ tickets, onRowClick }: TicketListTableProps) {
  if (tickets.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-500 text-[13px]">
        No tickets match the current filters.
      </div>
    );
  }

  return (
    <div
      className="bg-white border border-slate-200 rounded-xl overflow-hidden"
      data-testid="ticket-list-table"
    >
      <div
        className={`grid ${GRID} gap-3 px-5 py-3 border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500`}
      >
        <div>Ticket</div>
        <div>App</div>
        <div>Platform</div>
        <div>State</div>
        <div>Outcome</div>
        <div>Opened</div>
        <div className="text-right">Entries</div>
      </div>

      {tickets.map((ticket) => (
        <TicketRow key={ticket.id} ticket={ticket} onRowClick={onRowClick} />
      ))}
    </div>
  );
}

function TicketRow({
  ticket,
  onRowClick,
}: {
  ticket: TicketListRow;
  onRowClick?: (ticket: TicketListRow) => void;
}) {
  const handleClick = () => onRowClick?.(ticket);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      className={`grid ${GRID} gap-3 items-center px-5 py-3 border-b border-slate-100 last:border-b-0 hover:bg-slate-50/70 cursor-pointer text-[13px]`}
      data-testid="ticket-row"
      data-ticket-id={ticket.id}
    >
      <code className="font-mono text-[12px] text-slate-500 truncate">
        {ticket.display_id}
      </code>

      <div className="min-w-0">
        {ticket.app_name ? (
          <div className="text-slate-900 truncate">{ticket.app_name}</div>
        ) : (
          <em className="text-slate-400 italic">Unclassified</em>
        )}
        {ticket.type_name && (
          <div className="text-[11px] text-slate-400 truncate">
            {ticket.type_name}
          </div>
        )}
      </div>

      <div className="text-slate-600 text-[12px] truncate">
        {ticket.platform_display_name || ticket.platform_key}
      </div>

      <div className="text-slate-700 text-[12px] font-medium">
        {ticket.state}
      </div>

      <div className="text-slate-500 text-[12px]">
        {ticket.latest_outcome ?? '—'}
      </div>

      <div className="text-slate-500 text-[12px]">
        {formatOpenedAt(ticket.opened_at)}
      </div>

      <div className="text-right text-slate-400 text-[12px] tabular-nums">
        {ticket.entry_count}
      </div>
    </div>
  );
}

/**
 * Minimal locale-neutral date formatter. PR-10.2.4 replaces this with
 * a relative-time formatter ("2h ago", "3 days ago", etc).
 */
function formatOpenedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
