import Link from 'next/link';
import type { RecentRejected } from '@/lib/store-submissions/queries/reports';

interface Props {
  rows: RecentRejected[];
}

/**
 * "Top reject reasons" mockup section, substituted with a recent-events
 * list per Q6 (deferred categorized taxonomy lives in Phase-3 scope).
 *
 * Each row is the most recent N `ticket_entries` of type REJECT_REASON
 * on Apple tickets, free-text excerpt truncated for readability. Click
 * routes to the Inbox detail panel via the existing `?ticket=<uuid>`
 * convention.
 */
export function RecentRejectedList({ rows }: Props) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="text-[13.5px] font-semibold text-slate-900">Recent rejected</div>
      <div className="text-[11.5px] text-slate-500 mb-3">
        Manually logged reject reasons — most recent first
      </div>

      {rows.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-slate-400">
          No rejected tickets recently
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((row) => (
            <li key={row.ticket_id + row.rejected_at}>
              <Link
                href={`/store-submissions/inbox?ticket=${row.ticket_id}`}
                className="block py-3 hover:bg-slate-50 -mx-2 px-2 rounded-md transition-colors"
              >
                <div className="flex items-center justify-between gap-3 mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[12.5px] font-medium text-slate-900 truncate">
                      {row.app_name ?? 'Unknown app'}
                    </span>
                    <span className="text-[11px] text-slate-400 font-mono">
                      {row.display_id}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-400 flex-shrink-0">
                    {formatRelative(row.rejected_at)}
                  </span>
                </div>
                <div className="text-[12px] text-slate-600 leading-relaxed line-clamp-2">
                  {row.excerpt || <span className="italic text-slate-400">No content</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days < 1) {
    const hours = Math.floor(diffMs / (60 * 60 * 1000));
    if (hours < 1) return 'just now';
    return `${hours}h ago`;
  }
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
