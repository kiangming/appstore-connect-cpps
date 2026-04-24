/**
 * Inline badge + icon components for the Inbox ticket list.
 *
 * Colour scheme + pill styling match the existing StatusBadge
 * convention (see `components/store-submissions/apps/AppsClient.tsx:589`).
 *
 * **PlatformIcon duplication note:** the Apple / Google / Huawei /
 * Facebook SVG set here mirrors the one in AppsClient. Leaving as a
 * local copy for now (2 usages); promote to a shared
 * `components/store-submissions/shared/PlatformIcon.tsx` on the third
 * usage to follow the codebase's "abstract on 3" rule. Flagged in
 * TODO.md.
 */

import { AlertTriangle, Apple, Facebook } from 'lucide-react';

import type {
  TicketOutcome,
  TicketPriority,
  TicketState,
} from '@/lib/store-submissions/schemas/ticket';

// -- State ------------------------------------------------------------------

const STATE_CLASSES: Record<TicketState, string> = {
  NEW: 'bg-slate-100 text-slate-700 border-slate-200',
  IN_REVIEW: 'bg-amber-50 text-amber-700 border-amber-200',
  REJECTED: 'bg-red-50 text-red-700 border-red-200',
  APPROVED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  DONE: 'bg-blue-50 text-blue-700 border-blue-200',
  ARCHIVED: 'bg-slate-50 text-slate-500 border-slate-200',
};

const STATE_LABEL: Record<TicketState, string> = {
  NEW: 'New',
  IN_REVIEW: 'In review',
  REJECTED: 'Rejected',
  APPROVED: 'Approved',
  DONE: 'Done',
  ARCHIVED: 'Archived',
};

export function StateBadge({ state }: { state: TicketState }) {
  return (
    <span
      className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${STATE_CLASSES[state]}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

// -- Outcome ----------------------------------------------------------------

export function OutcomeBadge({ outcome }: { outcome: TicketOutcome | null }) {
  if (outcome === null) {
    return <span className="text-slate-300 text-[12px]">—</span>;
  }

  const cls =
    outcome === 'APPROVED'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : outcome === 'REJECTED'
        ? 'bg-red-50 text-red-700 border-red-200'
        : 'bg-amber-50 text-amber-700 border-amber-200';

  return (
    <span
      className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${cls}`}
    >
      {outcome === 'IN_REVIEW' ? 'In review' : outcome.toLowerCase()}
    </span>
  );
}

// -- Priority ---------------------------------------------------------------

/**
 * Priority signal — only HIGH renders. LOW/NORMAL are the common case
 * and would add visual noise to every row. Users who need to see full
 * priority distribution switch the Sort pill to "Priority" and scan
 * the natural ordering.
 */
export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  if (priority !== 'HIGH') return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border bg-red-50 text-red-700 border-red-200"
      title="High priority"
    >
      <AlertTriangle className="w-2.5 h-2.5" strokeWidth={2} />
      High
    </span>
  );
}

// -- Platform icon ----------------------------------------------------------

type PlatformKeyLike = 'apple' | 'google' | 'huawei' | 'facebook' | string;

export function PlatformIcon({
  platform,
  label,
}: {
  platform: PlatformKeyLike;
  label?: string;
}) {
  const tooltip = label ?? platform;
  const iconProps = {
    className: 'w-3.5 h-3.5 text-slate-700',
    strokeWidth: 1.8,
  } as const;

  let icon: React.ReactNode;
  switch (platform) {
    case 'apple':
      icon = <Apple {...iconProps} />;
      break;
    case 'google':
      icon = (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          className="w-3.5 h-3.5 text-slate-700"
        >
          <path d="M3 20.5V3.5c0-.59.34-1.11.84-1.35l13.69 9.85-13.69 9.85c-.5-.25-.84-.76-.84-1.35Z" />
        </svg>
      );
      break;
    case 'facebook':
      icon = <Facebook {...iconProps} />;
      break;
    case 'huawei':
      icon = (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          className="w-3.5 h-3.5 text-slate-700"
          strokeWidth="1.8"
        >
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
      break;
    default:
      icon = <span className="text-slate-400 text-[11px]">?</span>;
  }

  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      className="inline-flex items-center justify-center w-5 h-5"
    >
      {icon}
    </span>
  );
}
