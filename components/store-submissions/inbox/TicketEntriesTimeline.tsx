'use client';

/**
 * Chronological timeline for `ticket_entries`.
 *
 * Layout:
 *   ┌─ ● (dot) ──────────────────┐
 *   │  │                          │
 *   │  │  [entry card content]    │
 *   │  │                          │
 *   │  ● ──────────────────────   │
 *
 * Left gutter: type-colored dot + vertical connecting line between
 * entries (the last entry omits the line so the chain visibly ends).
 *
 * PR-10b scope: renders EMAIL / STATE_CHANGE / PAYLOAD_ADDED cards.
 * Unknown / forthcoming types (COMMENT, REJECT_REASON from PR-10c.3;
 * ASSIGNMENT, PRIORITY_CHANGE deferred) fall through to a minimal
 * placeholder card — adding real rendering later won't break the
 * dispatcher.
 *
 * **Security:** every content field (subject, sender, body_excerpt,
 * payload JSON) is rendered via `{value}` interpolation. React auto-
 * escapes; we never touch `dangerouslySetInnerHTML`. Bodies are
 * pre-truncated plain text per invariant #3, so there's no HTML input
 * even before React's guard.
 *
 * **Metadata typing:** entries come from our own RPC (see
 * supabase/migrations/20260423000000_store_mgmt_ticket_engine_rpc.sql),
 * so the JSON shapes are known. Cards cast `entry.metadata` to an
 * expected-shape interface with all fields optional, then fall back to
 * "(no data)" placeholders when a field is missing. No zod per card —
 * would double-validate data we produce ourselves.
 */

import { formatDistanceToNow } from 'date-fns';
import {
  ArrowRight,
  HelpCircle,
  Mail,
  PackagePlus,
} from 'lucide-react';

import type { TicketEntryRow } from '@/lib/store-submissions/queries/tickets';
import type {
  TicketOutcome,
  TicketState,
} from '@/lib/store-submissions/schemas/ticket';
import { OutcomeBadge, StateBadge } from './TicketBadges';

// -- Metadata shapes (runtime-unchecked) -----------------------------------

interface EmailSnapshot {
  subject?: string;
  sender?: string;
  sender_name?: string | null;
  received_at?: string;
  body_excerpt?: string;
}

interface EmailMetadata {
  email_snapshot?: EmailSnapshot;
  outcome?: TicketOutcome;
  classification_status?:
    | 'CLASSIFIED'
    | 'UNCLASSIFIED_APP'
    | 'UNCLASSIFIED_TYPE'
    | string;
}

interface StateChangeMetadata {
  from?: TicketState;
  to?: TicketState;
  trigger?: 'email' | 'user';
  email_message_id?: string;
}

interface PayloadAddedMetadata {
  payload?: unknown;
}

// -- Top-level timeline ----------------------------------------------------

export interface TicketEntriesTimelineProps {
  entries: TicketEntryRow[];
}

export function TicketEntriesTimeline({ entries }: TicketEntriesTimelineProps) {
  if (entries.length === 0) {
    return (
      <p className="text-[12px] text-slate-400 italic">
        No entries yet.
      </p>
    );
  }

  return (
    <ol className="space-y-0">
      {entries.map((entry, i) => (
        <li key={entry.id} className="flex gap-3">
          <LeftGutter
            entryType={entry.entry_type}
            isLast={i === entries.length - 1}
          />
          <div className="flex-1 min-w-0 pb-5">
            <EntryCard entry={entry} />
          </div>
        </li>
      ))}
    </ol>
  );
}

// -- Gutter ----------------------------------------------------------------

const DOT_COLORS: Record<string, string> = {
  EMAIL: 'bg-blue-500',
  STATE_CHANGE: 'bg-amber-500',
  PAYLOAD_ADDED: 'bg-slate-400',
  COMMENT: 'bg-emerald-500',
  REJECT_REASON: 'bg-red-500',
  ASSIGNMENT: 'bg-purple-500',
  PRIORITY_CHANGE: 'bg-indigo-500',
};

function LeftGutter({
  entryType,
  isLast,
}: {
  entryType: string;
  isLast: boolean;
}) {
  return (
    <div className="flex flex-col items-center flex-shrink-0 pt-1">
      <div
        className={`w-2 h-2 rounded-full ${DOT_COLORS[entryType] ?? 'bg-slate-300'}`}
        aria-hidden
      />
      {!isLast && <div className="w-px flex-1 bg-slate-200 mt-1" />}
    </div>
  );
}

// -- Dispatcher ------------------------------------------------------------

function EntryCard({ entry }: { entry: TicketEntryRow }) {
  switch (entry.entry_type) {
    case 'EMAIL':
      return <EmailEntryCard entry={entry} />;
    case 'STATE_CHANGE':
      return <StateChangeEntryCard entry={entry} />;
    case 'PAYLOAD_ADDED':
      return <PayloadAddedEntryCard entry={entry} />;
    default:
      return <UnknownEntryCard entry={entry} />;
  }
}

// -- EMAIL card ------------------------------------------------------------

function EmailEntryCard({ entry }: { entry: TicketEntryRow }) {
  const md = entry.metadata as EmailMetadata;
  const snap = md.email_snapshot ?? {};
  const outcome = md.outcome ?? null;
  const classification = md.classification_status;

  return (
    <EntryShell
      icon={<Mail className="w-3.5 h-3.5 text-blue-600" strokeWidth={1.8} />}
      label="Email received"
      entry={entry}
      trailing={outcome ? <OutcomeBadge outcome={outcome} /> : null}
    >
      <div className="space-y-1.5">
        <div className="text-[13px] font-medium text-slate-900 break-words">
          {snap.subject ?? <span className="text-slate-400 italic">(no subject)</span>}
        </div>
        <div className="text-[12px] text-slate-500 truncate">
          {snap.sender_name ? (
            <>
              {snap.sender_name}{' '}
              <span className="font-mono text-slate-400">
                &lt;{snap.sender ?? 'unknown'}&gt;
              </span>
            </>
          ) : (
            <span className="font-mono">{snap.sender ?? 'unknown sender'}</span>
          )}
        </div>
        {classification && (
          <div className="pt-0.5">
            <ClassificationChip status={classification} />
          </div>
        )}
        {snap.body_excerpt && snap.body_excerpt.trim() !== '' && (
          <details className="group pt-1">
            <summary className="cursor-pointer select-none text-[11px] text-slate-500 hover:text-slate-700 list-none inline-flex items-center gap-1">
              <ArrowRight
                className="w-3 h-3 transition-transform group-open:rotate-90"
                strokeWidth={1.8}
              />
              Body preview
            </summary>
            <pre className="mt-2 text-[11px] font-sans bg-slate-50 border border-slate-200 rounded p-2 text-slate-700 whitespace-pre-wrap break-words">
              {snap.body_excerpt}
            </pre>
          </details>
        )}
      </div>
    </EntryShell>
  );
}

function ClassificationChip({ status }: { status: string }) {
  const cls =
    status === 'CLASSIFIED'
      ? 'bg-slate-100 text-slate-700 border-slate-200'
      : 'bg-amber-50 text-amber-700 border-amber-200';
  const label =
    status === 'CLASSIFIED'
      ? 'Classified'
      : status === 'UNCLASSIFIED_APP'
        ? 'Unclassified — app unknown'
        : status === 'UNCLASSIFIED_TYPE'
          ? 'Unclassified — type unknown'
          : status;
  return (
    <span
      className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${cls}`}
    >
      {label}
    </span>
  );
}

// -- STATE_CHANGE card -----------------------------------------------------

function StateChangeEntryCard({ entry }: { entry: TicketEntryRow }) {
  const md = entry.metadata as StateChangeMetadata;

  return (
    <EntryShell
      icon={<ArrowRight className="w-3.5 h-3.5 text-amber-600" strokeWidth={1.8} />}
      label="State changed"
      entry={entry}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {md.from ? (
          <StateBadge state={md.from} />
        ) : (
          <span className="text-[12px] text-slate-400 italic">(unknown)</span>
        )}
        <ArrowRight className="w-3 h-3 text-slate-400" strokeWidth={1.8} />
        {md.to ? (
          <StateBadge state={md.to} />
        ) : (
          <span className="text-[12px] text-slate-400 italic">(unknown)</span>
        )}
      </div>
      <p className="text-[11px] text-slate-500 mt-1.5">
        {md.trigger === 'user'
          ? 'Triggered by user action'
          : md.trigger === 'email'
            ? 'Triggered by incoming email'
            : 'Trigger unknown'}
      </p>
    </EntryShell>
  );
}

// -- PAYLOAD_ADDED card ----------------------------------------------------

function PayloadAddedEntryCard({ entry }: { entry: TicketEntryRow }) {
  const md = entry.metadata as PayloadAddedMetadata;
  const payload = md.payload;

  return (
    <EntryShell
      icon={<PackagePlus className="w-3.5 h-3.5 text-slate-500" strokeWidth={1.8} />}
      label="Payload recorded"
      entry={entry}
    >
      {payload === undefined || payload === null ? (
        <p className="text-[12px] text-slate-400 italic">No payload data.</p>
      ) : (
        <details className="group">
          <summary className="cursor-pointer select-none text-[11px] text-slate-500 hover:text-slate-700 list-none inline-flex items-center gap-1">
            <ArrowRight
              className="w-3 h-3 transition-transform group-open:rotate-90"
              strokeWidth={1.8}
            />
            Payload details
          </summary>
          <pre className="mt-2 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded p-2 text-slate-700 whitespace-pre-wrap break-all overflow-x-auto">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </details>
      )}
    </EntryShell>
  );
}

// -- Unknown / forthcoming fallback ----------------------------------------

function UnknownEntryCard({ entry }: { entry: TicketEntryRow }) {
  return (
    <EntryShell
      icon={<HelpCircle className="w-3.5 h-3.5 text-slate-400" strokeWidth={1.8} />}
      label={entry.entry_type}
      entry={entry}
    >
      <p className="text-[12px] text-slate-500">
        {entry.content ?? (
          <span className="italic text-slate-400">
            No renderer yet for entry type{' '}
            <code className="font-mono">{entry.entry_type}</code>.
          </span>
        )}
      </p>
    </EntryShell>
  );
}

// -- Shared card shell -----------------------------------------------------

function EntryShell({
  icon,
  label,
  entry,
  trailing,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  entry: TicketEntryRow;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5 text-[11px] text-slate-500">
        {icon}
        <span className="font-semibold uppercase tracking-wider">{label}</span>
        <span className="text-slate-300">·</span>
        <span title={absoluteTs(entry.created_at)}>
          {formatRelative(entry.created_at)}
        </span>
        {entry.author_display_name && (
          <>
            <span className="text-slate-300">·</span>
            <span className="truncate">{entry.author_display_name}</span>
          </>
        )}
        {trailing && <span className="ml-auto">{trailing}</span>}
      </div>
      {children}
    </div>
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
