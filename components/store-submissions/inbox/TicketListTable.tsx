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
 * headers are descriptive labels. (Tracked in TODO.md PR-10 post-MVP.)
 *
 * Visual polish (PR-10.2.4):
 *   - StateBadge / OutcomeBadge / PriorityBadge from ./TicketBadges
 *   - PlatformIcon glyph + label (Apple / Google / Huawei / Facebook)
 *   - Relative time via date-fns `formatDistanceToNow` with absolute
 *     timestamp in the hover title
 */

import { useEffect, useRef } from 'react';

import { formatDistanceToNow } from 'date-fns';

import type { TicketListRow } from '@/lib/store-submissions/queries/tickets';
import {
  OutcomeBadge,
  PlatformIcon,
  PriorityBadge,
  StateBadge,
} from './TicketBadges';

const GRID = 'grid-cols-[140px_1fr_100px_110px_110px_120px_60px]';

export interface TicketListTableProps {
  tickets: TicketListRow[];
  onRowClick?: (ticket: TicketListRow) => void;
  /**
   * When set, the matching row renders with a blue left accent + tinted
   * background to signal "this is the ticket open in the side panel".
   * Implemented with a constant-width left border (transparent when
   * unselected, colored when selected) so row width never shifts —
   * matters for grid column alignment.
   */
  selectedTicketId?: string | null;
  /**
   * Index of the keyboard-focused row (j/k navigation). Distinct from
   * `selectedTicketId` (which tracks the open panel). Renders a subtle
   * inset ring; the focused row also auto-scrolls into view. Null = no
   * keyboard focus active.
   */
  focusedIndex?: number | null;
  /**
   * Override the default empty-state copy. The Inbox passes context-
   * aware messages (per-tab wording, filter-aware fallback) — see
   * `getEmptyMessage` in InboxClient.
   */
  emptyMessage?: string;
}

export function TicketListTable({
  tickets,
  onRowClick,
  selectedTicketId,
  focusedIndex,
  emptyMessage = 'No tickets match the current filters.',
}: TicketListTableProps) {
  if (tickets.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-slate-500 text-[13px]">
        {emptyMessage}
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

      {tickets.map((ticket, index) => (
        <TicketRow
          key={ticket.id}
          ticket={ticket}
          onRowClick={onRowClick}
          isSelected={ticket.id === selectedTicketId}
          isFocused={index === focusedIndex}
        />
      ))}
    </div>
  );
}

function TicketRow({
  ticket,
  onRowClick,
  isSelected,
  isFocused,
}: {
  ticket: TicketListRow;
  onRowClick?: (ticket: TicketListRow) => void;
  isSelected: boolean;
  isFocused: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the keyboard-focused row into view. `block: 'nearest'`
  // avoids unnecessary scrolling when the row is already visible.
  useEffect(() => {
    if (isFocused) {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [isFocused]);

  const handleClick = () => onRowClick?.(ticket);

  // Left border is always 2px to prevent column-width jitter between
  // selected/unselected states. Color swaps based on selection.
  const selectionClasses = isSelected
    ? 'bg-blue-50/70 border-l-[#0071E3]'
    : 'border-l-transparent hover:bg-slate-50/70';
  const focusClasses = isFocused
    ? 'ring-2 ring-blue-500/30 ring-inset'
    : '';

  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      className={`grid ${GRID} gap-3 items-center px-5 py-3 border-b border-slate-100 last:border-b-0 border-l-2 cursor-pointer text-[13px] ${selectionClasses} ${focusClasses}`}
      data-testid="ticket-row"
      data-ticket-id={ticket.id}
      data-selected={isSelected}
      data-focused={isFocused}
      aria-current={isSelected ? 'true' : undefined}
    >
      <div className="flex items-center gap-2 min-w-0">
        <code className="font-mono text-[12px] text-slate-500 truncate">
          {ticket.display_id}
        </code>
        <PriorityBadge priority={ticket.priority} />
      </div>

      <div className="min-w-0">
        {ticket.app_name ? (
          <>
            <div className="text-slate-900 truncate">{ticket.app_name}</div>
            {ticket.type_name && (
              <div className="text-[11px] text-slate-400 truncate">
                {ticket.type_name}
              </div>
            )}
          </>
        ) : ticket.first_email ? (
          <>
            <div
              className="text-[12px] text-slate-700 truncate"
              title={ticket.first_email.sender ?? undefined}
            >
              <span className="text-slate-400">From: </span>
              {ticket.first_email.sender ?? (
                <em className="italic text-slate-400">unknown sender</em>
              )}
            </div>
            <div
              className="text-[11px] text-slate-500 truncate"
              title={ticket.first_email.subject ?? undefined}
            >
              {ticket.first_email.subject ?? (
                <em className="italic text-slate-400">(no subject)</em>
              )}
            </div>
          </>
        ) : (
          <em className="text-slate-400 italic">Unclassified</em>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-[12px] text-slate-600 truncate">
        <PlatformIcon
          platform={ticket.platform_key}
          label={ticket.platform_display_name || ticket.platform_key}
        />
        <span className="truncate">
          {ticket.platform_display_name || ticket.platform_key}
        </span>
      </div>

      <div>
        <StateBadge state={ticket.state} />
      </div>

      <div>
        <OutcomeBadge outcome={ticket.latest_outcome} />
      </div>

      <div
        className="text-slate-500 text-[12px]"
        title={new Date(ticket.opened_at).toLocaleString()}
      >
        {formatRelativeTime(ticket.opened_at)}
      </div>

      <div className="text-right text-slate-400 text-[12px] tabular-nums">
        {ticket.entry_count}
      </div>
    </div>
  );
}

/**
 * Human-readable relative time via date-fns.
 *
 * Covers the common case ("5 minutes ago", "about 2 hours ago",
 * "3 days ago"). For >30d, `formatDistanceToNow` still produces
 * reasonable output ("about 2 months ago") — tickets older than that
 * are uncommon in triage, so no absolute-date fallback for MVP.
 * Hover title shows absolute timestamp.
 */
function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDistanceToNow(d, { addSuffix: true });
}
