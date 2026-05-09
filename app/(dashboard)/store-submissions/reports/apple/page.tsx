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
import { DateRangePicker } from '@/components/store-submissions/reports/DateRangePicker';

export const dynamic = 'force-dynamic';

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 730;
const DAY_MS = 24 * 60 * 60 * 1000;
const uuidSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function firstOfStr(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Midnight UTC of a YYYY-MM-DD string. */
function utcMidnight(yyyymmdd: string): Date {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

interface ResolvedWindow {
  windowStart: Date;
  windowEnd: Date;
  /** Cleaned YYYY-MM-DD strings (post-clamp) for header copy + picker mirroring. */
  fromStr: string;
  toStr: string;
  windowDays: number;
  /** True when the resolver fell back to the default range (no params or unusable params). */
  isDefault: boolean;
}

/**
 * Parse + validate ?from / ?to with PR-Reports.C graceful fallback ladder:
 *   1. bad format         → default last 30 days
 *   2. from > to          → default
 *   3. to > today         → clamp to = today
 *   4. (to-from) > 730d   → clamp from = to - 730d
 *
 * windowEnd is exclusive on the day AFTER `to` (matches PR-22 "today is
 * included" convention). Aligns with the UTC-midnight model used by
 * `bucketTrendByDay` so daily buckets are stable regardless of server TZ.
 */
function resolveWindow(
  rawFrom: string | undefined,
  rawTo: string | undefined,
): ResolvedWindow {
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayStr = new Date(todayMs).toISOString().slice(0, 10);
  const defaultFromStr = new Date(todayMs - DEFAULT_WINDOW_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);

  function defaultRange(): ResolvedWindow {
    return {
      windowStart: utcMidnight(defaultFromStr),
      windowEnd: new Date(todayMs + DAY_MS),
      fromStr: defaultFromStr,
      toStr: todayStr,
      windowDays: DEFAULT_WINDOW_DAYS,
      isDefault: true,
    };
  }

  // No params → default. Either-only present is treated as ill-formed → default.
  if (!rawFrom || !rawTo) return defaultRange();

  const fromCheck = dateSchema.safeParse(rawFrom);
  const toCheck = dateSchema.safeParse(rawTo);
  // Step 1: bad format → default
  if (!fromCheck.success || !toCheck.success) return defaultRange();

  let fromStr = fromCheck.data;
  let toStr = toCheck.data;

  // Step 2: from > to → default
  if (fromStr > toStr) return defaultRange();

  // Step 3: to > today → clamp
  if (toStr > todayStr) toStr = todayStr;

  // Step 4: range > 730 days → clamp from
  const toMs = Date.parse(toStr + 'T00:00:00Z');
  const fromMs = Date.parse(fromStr + 'T00:00:00Z');
  if ((toMs - fromMs) / DAY_MS > MAX_WINDOW_DAYS) {
    fromStr = new Date(toMs - MAX_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  }

  const windowStart = utcMidnight(fromStr);
  const windowEnd = new Date(utcMidnight(toStr).getTime() + DAY_MS);
  const windowDays = Math.round((windowEnd.getTime() - windowStart.getTime()) / DAY_MS);

  return { windowStart, windowEnd, fromStr, toStr, windowDays, isDefault: false };
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

  // PR-Reports.C: ?from / ?to URL-driven with graceful clamp.
  const rawFrom = firstOfStr(searchParams.from);
  const rawTo = firstOfStr(searchParams.to);
  const { windowStart, windowEnd, fromStr, toStr, windowDays, isDefault } =
    resolveWindow(rawFrom, rawTo);

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

  const submissionCopy = `${kpis.total} submission${kpis.total === 1 ? '' : 's'}`;
  const headerSubtitle = isDefault
    ? `Last ${windowDays} days · ${submissionCopy}`
    : `${fromStr} → ${toStr} · ${submissionCopy}`;

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
              <p className="text-[13px] text-slate-500">{headerSubtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <DateRangePicker
              from={isDefault ? undefined : fromStr}
              to={isDefault ? undefined : toStr}
            />
            <ReportsFilters types={appleTypes} selectedTypeId={typeId} />
          </div>
        </div>

        <KpiCards kpis={kpis} windowDays={windowDays} />

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
