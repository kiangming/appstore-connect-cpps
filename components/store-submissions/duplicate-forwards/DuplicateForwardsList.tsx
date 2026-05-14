import Link from 'next/link';

import type { DuplicateForwardListRow } from '@/lib/store-submissions/queries/duplicate-forwards';

interface Props {
  rows: DuplicateForwardListRow[];
  appNameById: Map<string, string>;
  selectedId: string | null;
  /** Preserves the date window in row click hrefs so the selection
   *  doesn't reset the filter. */
  queryParams: URLSearchParams;
}

/**
 * Tabular list of DUPLICATE_FORWARD email rows, newest-first. Each
 * row is a Link to `?selected=<email_id>` so detail-panel selection
 * survives a page reload (and shareable URLs). The selected row gets
 * a subtle highlight; the rest stay neutral.
 *
 * Empty state copies Manager's "đẹp và trực quan" — a short, clear
 * message (no big graphic) so absence of duplicates feels like a
 * good thing, not a missing feature.
 */
export function DuplicateForwardsList({
  rows,
  appNameById,
  selectedId,
  queryParams,
}: Props) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200">
        <div className="text-[13.5px] font-semibold text-slate-900">
          Forwarded duplicates
        </div>
        <div className="text-[11.5px] text-slate-500">
          Apple emails the gate dedupped — click a row for detail
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="py-16 text-center">
          <div className="text-[14px] font-medium text-slate-700">
            Chưa có forwarded duplicates
          </div>
          <div className="text-[12px] text-slate-500 mt-1">
            No forwarded copies dedupped in this window.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="bg-slate-50 text-[11.5px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Received</th>
                <th className="text-left font-medium px-4 py-2.5">Forwarder</th>
                <th className="text-left font-medium px-4 py-2.5">App</th>
                <th className="text-left font-medium px-4 py-2.5">Outcome</th>
                <th className="text-left font-medium px-4 py-2.5">Original ticket</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const selected = row.id === selectedId;
                const href = buildSelectHref(queryParams, row.id);
                return (
                  <tr
                    key={row.id}
                    className={
                      selected
                        ? 'bg-blue-50/60'
                        : 'hover:bg-slate-50 transition-colors'
                    }
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700 font-mono">
                      <Link
                        href={href}
                        className="block"
                        aria-current={selected ? 'true' : undefined}
                      >
                        {formatDateTime(row.received_at)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-700">
                      <Link href={href} className="block">
                        {row.sender_email}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-900 font-medium">
                      <Link href={href} className="block">
                        {appLabel(row.app_id, appNameById)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Link href={href} className="block">
                        <OutcomePill outcome={row.outcome} />
                      </Link>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {row.original?.ticket_id ? (
                        <Link
                          href={`/store-submissions/inbox?ticket=${row.original.ticket_id}`}
                          className="text-[#0071E3] hover:underline"
                        >
                          View ticket →
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function buildSelectHref(
  base: URLSearchParams,
  id: string,
): string {
  const next = new URLSearchParams(base);
  next.set('selected', id);
  return `/store-submissions/duplicate-forwards?${next.toString()}`;
}

function appLabel(
  appId: string | null,
  appNameById: Map<string, string>,
): React.ReactNode {
  if (!appId) return <span className="text-slate-400 italic">Unclassified</span>;
  const name = appNameById.get(appId);
  if (!name) return <span className="text-slate-400 italic">Unknown app</span>;
  return name;
}

function OutcomePill({ outcome }: { outcome: string | null }) {
  if (!outcome) {
    return <span className="text-slate-400 text-[11.5px]">—</span>;
  }
  const tone =
    outcome === 'APPROVED'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : outcome === 'REJECTED'
        ? 'bg-rose-50 text-rose-700 ring-rose-200'
        : 'bg-slate-50 text-slate-600 ring-slate-200';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ${tone}`}
    >
      {outcome}
    </span>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
