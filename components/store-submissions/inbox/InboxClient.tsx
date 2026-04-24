'use client';

/**
 * Client-side interactive shell for the Inbox.
 *
 * **PR-10.2.1 stub** — renders a plain count of tickets so the page
 * end-to-end works. State tabs, filter row, and the list table arrive in
 * PR-10.2.2 / 10.2.3. The `InboxClientProps` shape is the stable
 * boundary between the Server Component (page.tsx) and the interactive
 * layer; later sub-chunks replace the body, not the signature.
 */

import type {
  ListTicketsResult,
  TicketListRow,
} from '@/lib/store-submissions/queries/tickets';
import type { TicketsQuery } from '@/lib/store-submissions/schemas/ticket';
import type { StoreRole } from '@/lib/store-submissions/auth';

export interface InboxClientProps {
  initialData: ListTicketsResult;
  initialQuery: TicketsQuery;
  /** Role-gated actions (state transitions) land in PR-10c. */
  role: StoreRole;
}

export function InboxClient({ initialData, initialQuery, role }: InboxClientProps) {
  const { tickets, has_more } = initialData;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6">
      <p className="text-[12px] text-slate-400 uppercase tracking-wide mb-2">
        PR-10.2.1 shell — interactive filters + table land in next sub-chunks
      </p>
      <div className="flex items-baseline gap-2 mb-4">
        <span className="text-[22px] font-semibold text-slate-900">
          {tickets.length}
        </span>
        <span className="text-[13px] text-slate-500">
          ticket{tickets.length === 1 ? '' : 's'}
          {has_more ? ' (more available)' : ''}
          {' — '}sort: <code className="font-mono">{initialQuery.sort}</code>
          {' — '}role: <code className="font-mono">{role}</code>
        </span>
      </div>

      {tickets.length === 0 ? (
        <div className="py-12 text-center text-[13px] text-slate-400">
          No tickets match the current filters.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {tickets.slice(0, 10).map((t) => (
            <InboxRowPreview key={t.id} ticket={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function InboxRowPreview({ ticket }: { ticket: TicketListRow }) {
  return (
    <li className="py-3 flex items-center gap-3 text-[13px]">
      <code className="font-mono text-slate-500 w-32 shrink-0">
        {ticket.display_id}
      </code>
      <span className="text-slate-700 flex-1 truncate">
        {ticket.app_name ?? <em className="text-slate-400">no app</em>}
      </span>
      <span className="text-slate-400 text-[12px] w-20 shrink-0">
        {ticket.platform_key}
      </span>
      <span className="text-slate-500 text-[12px] w-20 shrink-0">
        {ticket.state}
      </span>
    </li>
  );
}
