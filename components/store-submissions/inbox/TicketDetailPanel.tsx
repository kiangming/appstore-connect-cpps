'use client';

/**
 * Ticket detail — right slide-over panel.
 *
 * **Pattern choice (slide-over, not centered modal):** CppDetailPanel
 * uses a centered modal because it's a single-concern edit session.
 * Inbox triage is the opposite — users open → skim → close → open next
 * rapidly. A centered modal hides the list behind an opaque backdrop,
 * costing scroll position + active-row context on every open. The
 * slide-over keeps the list visible so the filter + selected row stay
 * as workflow anchors. Deliberate codebase inconsistency, documented
 * for future contributors.
 *
 * Built on Radix `Dialog` even though Radix defaults to centered
 * positioning — Content positioning is entirely className-driven, so
 * we pin right + full-height. Using Radix buys focus trap, Esc close,
 * body scroll lock, aria-modal, and backdrop-click close for free.
 *
 * **Animation**: no slide/fade transitions. `tailwindcss-animate` is
 * not installed (existing Radix dialogs also render without animation).
 * Tracked post-MVP; visual polish, not functional.
 *
 * Implementation progression:
 *   - PR-10.3.1: shell + URL sync + header placeholder
 *   - PR-10.3.2: header badges + metadata grid + submission IDs +
 *     type payloads
 *   - PR-10.3.3: timeline entries (EMAIL / STATE_CHANGE / PAYLOAD_ADDED
 *     — fallback for unknown/future entry types)
 *   - PR-10c.2: action footer (archive / follow-up / mark-done / unarchive)
 *   - PR-10c.3: COMMENT / REJECT_REASON cards inside the timeline
 */

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { formatDistanceToNow } from 'date-fns';
import { Check, ChevronRight, Copy, X } from 'lucide-react';

import type { TicketWithEntries } from '@/lib/store-submissions/queries/tickets';
import {
  OutcomeBadge,
  PlatformIcon,
  PriorityBadge,
  StateBadge,
} from './TicketBadges';
import { TicketEntriesTimeline } from './TicketEntriesTimeline';

export interface TicketDetailPanelProps {
  /**
   * null when the URL specifies a ticket that was not found (or user
   * pasted a bad id). Panel renders a "not found" state.
   */
  ticket: TicketWithEntries | null;
  /** Controlled open state — derived from URL `?ticket=<id>`. */
  isOpen: boolean;
  /** Called for any close trigger (Esc, backdrop, X). URL is cleared by caller. */
  onClose: () => void;
}

export function TicketDetailPanel({ ticket, isOpen, onClose }: TicketDetailPanelProps) {
  return (
    <Dialog.Root open={isOpen} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-900/40 z-40" />
        <Dialog.Content
          className="fixed right-0 top-0 bottom-0 w-full md:w-[520px] bg-white shadow-xl z-50 flex flex-col focus:outline-none"
          aria-describedby={undefined}
        >
          {/* Header */}
          <PanelHeader ticket={ticket} />

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto">
            {ticket === null ? (
              <NotFoundState />
            ) : (
              <>
                <MetadataSection ticket={ticket} />
                <SubmissionIdsSection ids={ticket.ticket.submission_ids} />
                <TypePayloadsSection payloads={ticket.ticket.type_payloads} />

                {/* Timeline */}
                <section className="px-5 py-4">
                  <SectionLabel>Timeline</SectionLabel>
                  <div className="mt-3">
                    <TicketEntriesTimeline entries={ticket.entries} />
                  </div>
                </section>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// -- Header ----------------------------------------------------------------

function PanelHeader({ ticket }: { ticket: TicketWithEntries | null }) {
  if (!ticket) {
    return (
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
        <Dialog.Title asChild>
          <h2 className="text-[15px] font-semibold text-slate-900">Ticket not found</h2>
        </Dialog.Title>
        <CloseButton />
      </div>
    );
  }

  const t = ticket.ticket;
  return (
    <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-100 flex-shrink-0">
      <div className="min-w-0 flex-1 space-y-2">
        <Dialog.Title asChild>
          <h2 className="text-[15px] font-mono font-semibold text-slate-900 truncate">
            {t.display_id}
          </h2>
        </Dialog.Title>

        <div className="flex items-center gap-1.5 flex-wrap">
          <StateBadge state={t.state} />
          <OutcomeBadge outcome={t.latest_outcome} />
          <PriorityBadge priority={t.priority} />
        </div>

        <div className="flex items-center gap-1.5 text-[13px] text-slate-600 min-w-0">
          <PlatformIcon platform={ticket.platform.key} label={ticket.platform.display_name} />
          <span className="truncate">{ticket.platform.display_name}</span>
          <span className="text-slate-300">·</span>
          <span className="truncate">
            {ticket.app?.name ?? (
              <em className="text-slate-400 italic">Unclassified</em>
            )}
          </span>
          {ticket.type && (
            <>
              <span className="text-slate-300">·</span>
              <span className="text-slate-500 truncate">{ticket.type.name}</span>
            </>
          )}
        </div>
      </div>

      <CloseButton />
    </div>
  );
}

function CloseButton() {
  return (
    <Dialog.Close
      className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 flex-shrink-0"
      aria-label="Close ticket detail"
    >
      <X className="w-4 h-4" strokeWidth={1.8} />
    </Dialog.Close>
  );
}

// -- Sections --------------------------------------------------------------

function NotFoundState() {
  return (
    <div className="p-8 text-center text-[13px] text-slate-500">
      This ticket could not be found. The link may be stale, or the ticket
      was archived and your current filters hide it.
    </div>
  );
}

function MetadataSection({ ticket }: { ticket: TicketWithEntries }) {
  const t = ticket.ticket;
  const assigneeLabel =
    ticket.assignee?.display_name ?? ticket.assignee?.email ?? 'Unassigned';

  return (
    <section className="px-5 py-4 border-b border-slate-100">
      <SectionLabel>Metadata</SectionLabel>
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-[12px] mt-3">
        <MetaField label="Priority" value={t.priority} />
        <MetaField label="Assignee" value={assigneeLabel} />
        <MetaField
          label="Opened"
          value={formatRelative(t.opened_at)}
          title={absoluteTs(t.opened_at)}
        />
        <MetaField
          label="Updated"
          value={formatRelative(t.updated_at)}
          title={absoluteTs(t.updated_at)}
        />
        {t.closed_at && (
          <MetaField
            label="Closed"
            value={formatRelative(t.closed_at)}
            title={absoluteTs(t.closed_at)}
          />
        )}
        {t.resolution_type && (
          <MetaField label="Resolution" value={t.resolution_type} />
        )}
        {t.due_date && <MetaField label="Due date" value={t.due_date} />}
      </dl>
    </section>
  );
}

function SubmissionIdsSection({ ids }: { ids: string[] }) {
  return (
    <section className="px-5 py-4 border-b border-slate-100">
      <SectionLabel>Submission IDs ({ids.length})</SectionLabel>
      {ids.length === 0 ? (
        <p className="text-[12px] text-slate-400 italic mt-2">
          No submission IDs recorded yet.
        </p>
      ) : (
        <ul className="space-y-1 mt-2">
          {ids.map((id) => (
            <li key={id} className="flex items-center gap-2 group">
              <code className="font-mono text-[12px] text-slate-700 truncate flex-1">
                {id}
              </code>
              <CopyButton value={id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TypePayloadsSection({ payloads }: { payloads: unknown[] }) {
  if (payloads.length === 0) {
    return (
      <section className="px-5 py-4 border-b border-slate-100">
        <SectionLabel>Type payloads</SectionLabel>
        <p className="text-[12px] text-slate-400 italic mt-2">
          No type payloads extracted.
        </p>
      </section>
    );
  }

  return (
    <section className="px-5 py-4 border-b border-slate-100">
      <details className="group">
        <summary className="flex items-center gap-1.5 cursor-pointer select-none list-none text-[10px] uppercase tracking-wider text-slate-400 font-semibold hover:text-slate-600">
          <ChevronRight
            className="w-3 h-3 transition-transform group-open:rotate-90"
            strokeWidth={1.8}
          />
          Type payloads ({payloads.length})
        </summary>
        <ul className="mt-3 space-y-2 pl-4">
          {payloads.map((p, i) => (
            <li key={i}>
              <pre className="text-[11px] font-mono bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto text-slate-700 whitespace-pre-wrap break-all">
                {JSON.stringify(p, null, 2)}
              </pre>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

// -- Private helpers -------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
      {children}
    </p>
  );
}

function MetaField({
  label,
  value,
  title,
}: {
  label: string;
  value: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-slate-400 text-[11px] mb-0.5">{label}</dt>
      <dd className="text-slate-700 truncate" title={title}>
        {value}
      </dd>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    try {
      navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (insecure context, old browser) — silent fail
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
      className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 flex-shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-emerald-600" strokeWidth={2} />
      ) : (
        <Copy className="w-3.5 h-3.5" strokeWidth={1.8} />
      )}
    </button>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDistanceToNow(d, { addSuffix: true });
}

function absoluteTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
