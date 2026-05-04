import { BarChart3 } from 'lucide-react';

import { requireStoreSession } from '@/lib/store-submissions/session-guard';
import {
  getAppleByAppTable,
  getAppleRecentRejected,
  getAppleReportsKpis,
  getAppleTrendByDay,
} from '@/lib/store-submissions/queries/reports';
import { KpiCards } from '@/components/store-submissions/reports/KpiCards';
import { TrendChart } from '@/components/store-submissions/reports/TrendChart';
import { ByAppTable } from '@/components/store-submissions/reports/ByAppTable';
import { RecentRejectedList } from '@/components/store-submissions/reports/RecentRejectedList';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 30;

export default async function AppleReportsPage() {
  await requireStoreSession();

  // Window: today midnight UTC, going back 30 days. UTC-aligned so daily
  // buckets are stable regardless of where the server runs.
  const now = new Date();
  const windowEnd = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1, // make end exclusive on tomorrow midnight so today is included
  ));
  const windowStart = new Date(windowEnd.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [kpis, trend, byApp, recentRejected] = await Promise.all([
    getAppleReportsKpis(windowStart, windowEnd),
    getAppleTrendByDay(windowStart, windowEnd),
    getAppleByAppTable(windowStart, windowEnd, 5),
    getAppleRecentRejected(5),
  ]);

  return (
    <div className="px-8 py-10">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
            <BarChart3 className="h-5 w-5 text-[#0071E3]" strokeWidth={1.8} />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">
              Apple Reports
            </h1>
            <p className="text-[13px] text-slate-500">
              Last {WINDOW_DAYS} days · {kpis.total} submission{kpis.total === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        <KpiCards kpis={kpis} windowDays={WINDOW_DAYS} />

        <TrendChart buckets={trend} />

        {/* Mockup order: reject-reason surface on the left, by-app summary on the right. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RecentRejectedList rows={recentRejected} />
          <ByAppTable data={byApp} />
        </div>
      </div>
    </div>
  );
}
