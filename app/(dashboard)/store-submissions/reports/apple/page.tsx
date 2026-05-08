import { BarChart3 } from 'lucide-react';
import { z } from 'zod';

import { requireStoreSession } from '@/lib/store-submissions/session-guard';
import {
  getAppleByAppTable,
  getAppleRecentRejected,
  getAppleReportsKpis,
  getAppleTrendByDay,
} from '@/lib/store-submissions/queries/reports';
import { listAllTypes } from '@/lib/store-submissions/queries/types';
import { storeDb } from '@/lib/store-submissions/db';
import { KpiCards } from '@/components/store-submissions/reports/KpiCards';
import { TrendChart } from '@/components/store-submissions/reports/TrendChart';
import { ByAppTable } from '@/components/store-submissions/reports/ByAppTable';
import { RecentRejectedList } from '@/components/store-submissions/reports/RecentRejectedList';
import { ReportsFilters } from '@/components/store-submissions/reports/ReportsFilters';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 30;
const uuidSchema = z.string().uuid();

function firstOfStr(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export default async function AppleReportsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireStoreSession();

  // PR-22: type filter is URL-driven. Bad input (malformed UUID, stale
  // param after type deletion) falls back to "All types" so the page
  // never errors on a copy/pasted link.
  const rawTypeId = firstOfStr(searchParams.type_id);
  const typeIdCheck = rawTypeId ? uuidSchema.safeParse(rawTypeId) : null;
  const typeId = typeIdCheck?.success ? typeIdCheck.data : undefined;

  // Window: today midnight UTC, going back 30 days. UTC-aligned so daily
  // buckets are stable regardless of where the server runs.
  const now = new Date();
  const windowEnd = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1, // make end exclusive on tomorrow midnight so today is included
  ));
  const windowStart = new Date(windowEnd.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Resolve Apple platform id once for the types-list filter. The
  // 4 aggregation queries each resolve it again internally — that
  // mirrors PR-19's existing pattern and keeps each fetcher
  // self-contained (premature optimization avoided per PR-22 lock).
  const applePlatformIdRow = await storeDb()
    .from('platforms')
    .select('id')
    .eq('key', 'apple')
    .maybeSingle();
  const applePlatformId = (applePlatformIdRow.data as { id: string } | null)?.id ?? null;

  const [kpis, trend, byApp, recentRejected, allTypes] = await Promise.all([
    getAppleReportsKpis(windowStart, windowEnd, typeId),
    getAppleTrendByDay(windowStart, windowEnd, typeId),
    getAppleByAppTable(windowStart, windowEnd, typeId),
    getAppleRecentRejected(5, typeId),
    listAllTypes(),
  ]);

  const appleTypes = applePlatformId
    ? allTypes.filter((t) => t.platform_id === applePlatformId)
    : [];

  return (
    <div className="px-8 py-10">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
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
          <ReportsFilters types={appleTypes} selectedTypeId={typeId} />
        </div>

        <KpiCards kpis={kpis} windowDays={WINDOW_DAYS} />

        <TrendChart buckets={trend} />

        {/* Mockup order: reject-reason surface on the left, by-app summary on the right. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RecentRejectedList rows={recentRejected} />
          <ByAppTable data={byApp} typeId={typeId} />
        </div>
      </div>
    </div>
  );
}
