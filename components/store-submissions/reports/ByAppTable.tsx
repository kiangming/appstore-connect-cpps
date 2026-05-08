import Link from 'next/link';

import type { ByAppResult } from '@/lib/store-submissions/queries/reports';

interface Props {
  data: ByAppResult;
  /**
   * PR-22: when the Reports surface is filtered by a type, per-app
   * deep links into the Inbox preserve that scope so Manager keeps
   * filter context across surfaces.
   */
  typeId?: string;
}

/**
 * All apps with submissions in window for the Apple platform. Each row
 * drills into the Inbox filtered to that app. PR-Reports.A.1 dropped the
 * top-N truncation + the "View all N" CTA — list now fits all apps
 * inline (production scale ~14-25/30d).
 */
export function ByAppTable({ data, typeId }: Props) {
  const typeQs = typeId ? `&type_id=${typeId}` : '';
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-[13.5px] font-semibold text-slate-900">By app</div>
          <div className="text-[11.5px] text-slate-500">Submit volume & reject rate</div>
        </div>
      </div>

      {data.rows.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-slate-400">
          No Apple apps in this period
        </div>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="text-[11px] text-slate-500 uppercase tracking-wider">
            <tr className="border-b border-slate-100">
              <th className="text-left font-medium py-2">App</th>
              <th className="text-right font-medium">Submits</th>
              <th className="text-right font-medium">Rejects</th>
              <th
                className="text-right font-medium"
                title="Counts rework cycles (Apple notification bursts dedupped). Rate may exceed 100% when tickets have multiple resubmissions."
              >
                Rate
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => {
              const ratePct = row.rate * 100;
              const rateHigh = ratePct > 20;
              return (
                <tr key={row.app_id} className="border-b border-slate-100 last:border-b-0">
                  <td className="py-2">
                    <Link
                      href={`/store-submissions/inbox?platform_key=apple&app_id=${row.app_id}${typeQs}`}
                      className="text-slate-700 hover:text-slate-900 hover:underline"
                    >
                      {row.app_name}
                    </Link>
                  </td>
                  <td className="text-right font-mono text-slate-700">{row.submits}</td>
                  <td
                    className={`text-right font-mono ${row.rejects > 0 ? 'text-rose-700' : 'text-slate-400'}`}
                  >
                    {row.rejects}
                  </td>
                  <td
                    className={`text-right font-mono ${rateHigh ? 'text-rose-700 font-semibold' : 'text-slate-500'}`}
                  >
                    {ratePct.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
