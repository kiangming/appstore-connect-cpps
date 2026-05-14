import { Filter } from 'lucide-react';
import { z } from 'zod';

import { DateRangePicker } from '@/components/store-submissions/reports/DateRangePicker';
import { DuplicateForwardDetailPanel } from '@/components/store-submissions/duplicate-forwards/DuplicateForwardDetailPanel';
import { DuplicateForwardsList } from '@/components/store-submissions/duplicate-forwards/DuplicateForwardsList';
import { storeDb } from '@/lib/store-submissions/db';
import {
  getDuplicateForwardPair,
  listDuplicateForwards,
  type DuplicateForwardDetailPair,
} from '@/lib/store-submissions/queries/duplicate-forwards';
import { requireStoreSession } from '@/lib/store-submissions/session-guard';

export const dynamic = 'force-dynamic';

/**
 * /duplicate-forwards — audit dashboard for emails the
 * PR-Inbox.ForwardDedup gate deduplicated. Two-pane: list of
 * forwarded copies on top, detail panel side-by-side below.
 *
 * URL contract:
 *   ?from=YYYY-MM-DD  - window start (inclusive, midnight UTC)
 *   ?to=YYYY-MM-DD    - window end (inclusive, picker model)
 *   ?selected=<uuid>  - duplicate email id for detail-pane fetch
 *
 * Both `from`/`to` follow the PR-Reports.C graceful clamp ladder
 * (bad format → default last 30d, from>to → default,
 * to>today → clamp, range>730d → clamp from). Mirrors the Reports
 * page exactly so the shared DateRangePicker round-trips the same
 * params.
 */

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 730;
const DAY_MS = 24 * 60 * 60 * 1000;
const uuidSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function firstOfStr(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function utcMidnight(yyyymmdd: string): Date {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

interface ResolvedWindow {
  windowStart: Date;
  windowEnd: Date;
  fromStr: string;
  toStr: string;
  windowDays: number;
  isDefault: boolean;
}

function resolveWindow(
  rawFrom: string | undefined,
  rawTo: string | undefined,
): ResolvedWindow {
  const now = new Date();
  const todayMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
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

  if (!rawFrom || !rawTo) return defaultRange();
  const fromCheck = dateSchema.safeParse(rawFrom);
  const toCheck = dateSchema.safeParse(rawTo);
  if (!fromCheck.success || !toCheck.success) return defaultRange();

  let fromStr = fromCheck.data;
  let toStr = toCheck.data;
  if (fromStr > toStr) return defaultRange();
  if (toStr > todayStr) toStr = todayStr;

  const toMs = Date.parse(toStr + 'T00:00:00Z');
  const fromMs = Date.parse(fromStr + 'T00:00:00Z');
  if ((toMs - fromMs) / DAY_MS > MAX_WINDOW_DAYS) {
    fromStr = new Date(toMs - MAX_WINDOW_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
  }

  const windowStart = utcMidnight(fromStr);
  const windowEnd = new Date(utcMidnight(toStr).getTime() + DAY_MS);
  const windowDays = Math.round(
    (windowEnd.getTime() - windowStart.getTime()) / DAY_MS,
  );

  return {
    windowStart,
    windowEnd,
    fromStr,
    toStr,
    windowDays,
    isDefault: false,
  };
}

export default async function DuplicateForwardsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireStoreSession();

  const { windowStart, windowEnd, fromStr, toStr, windowDays, isDefault } =
    resolveWindow(firstOfStr(searchParams.from), firstOfStr(searchParams.to));

  const rawSelected = firstOfStr(searchParams.selected);
  const selectedCheck = rawSelected
    ? uuidSchema.safeParse(rawSelected)
    : null;
  const selectedId = selectedCheck?.success ? selectedCheck.data : null;

  const [rows, pair] = await Promise.all([
    listDuplicateForwards(windowStart, windowEnd),
    selectedId
      ? safelyLoadPair(selectedId)
      : Promise.resolve<DuplicateForwardDetailPair | null>(null),
  ]);

  // Hydrate app names. Collect all app_ids referenced (list rows +
  // selected pair) and batch-fetch in one query.
  const appIds = collectAppIds(rows, pair);
  const appNameById = await loadAppNames(appIds);

  const queryParams = buildBaseParams(isDefault ? null : fromStr, isDefault ? null : toStr);

  const headerSubtitle = isDefault
    ? `Last ${windowDays} days · ${rows.length} forwarded ${rows.length === 1 ? 'copy' : 'copies'}`
    : `${fromStr} → ${toStr} · ${rows.length} forwarded ${rows.length === 1 ? 'copy' : 'copies'}`;

  return (
    <div className="px-8 py-10">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center">
              <Filter className="h-5 w-5 text-indigo-600" strokeWidth={1.8} />
            </div>
            <div>
              <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">
                Forwarded duplicates
              </h1>
              <p className="text-[13px] text-slate-500">{headerSubtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <DateRangePicker
              from={isDefault ? undefined : fromStr}
              to={isDefault ? undefined : toStr}
            />
          </div>
        </div>

        <DuplicateForwardsList
          rows={rows}
          appNameById={appNameById}
          selectedId={selectedId}
          queryParams={queryParams}
        />

        <DuplicateForwardDetailPanel pair={pair} appNameById={appNameById} />
      </div>
    </div>
  );
}

/**
 * Catch errors from pair-load so a stale `?selected=<id>` from a
 * deleted email doesn't 500 the page. Logs + falls through to null
 * (detail panel renders empty state).
 */
async function safelyLoadPair(
  id: string,
): Promise<DuplicateForwardDetailPair | null> {
  try {
    return await getDuplicateForwardPair(id);
  } catch (err) {
    console.error('[duplicate-forwards] pair load failed:', err);
    return null;
  }
}

function collectAppIds(
  rows: Awaited<ReturnType<typeof listDuplicateForwards>>,
  pair: DuplicateForwardDetailPair | null,
): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.app_id) ids.add(r.app_id);
    if (r.original?.app_id) ids.add(r.original.app_id);
  }
  if (pair) {
    const dupAppId = readAppId(pair.duplicate.classification_result);
    if (dupAppId) ids.add(dupAppId);
    if (pair.original) {
      const origAppId = readAppId(pair.original.classification_result);
      if (origAppId) ids.add(origAppId);
    }
  }
  return Array.from(ids);
}

function readAppId(
  result: Record<string, unknown> | null,
): string | null {
  if (!result) return null;
  const v = result['app_id'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

async function loadAppNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await storeDb()
    .from('apps')
    .select('id, name')
    .in('id', ids);
  if (error) {
    console.error('[duplicate-forwards] app names fetch failed:', error);
    return new Map();
  }
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; name: string }>) {
    map.set(row.id, row.name);
  }
  return map;
}

function buildBaseParams(
  fromStr: string | null,
  toStr: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  if (fromStr) params.set('from', fromStr);
  if (toStr) params.set('to', toStr);
  return params;
}
