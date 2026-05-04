'use client';

import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TrendBucket } from '@/lib/store-submissions/queries/reports';

interface Props {
  buckets: TrendBucket[];
}

/**
 * Daily stacked bar chart, last 30 days, stacked by outcome.
 * Color hierarchy session-wide: emerald (approved) / sky (in_review) / rose (rejected).
 */
export function TrendChart({ buckets }: Props) {
  const total = buckets.reduce(
    (acc, b) => acc + b.approved + b.in_review + b.rejected,
    0,
  );

  if (total === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <Header />
        <div className="h-[200px] flex items-center justify-center text-[13px] text-slate-400">
          No submissions in this period
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <Header />
      <div className="h-[200px] mt-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
            <XAxis
              dataKey="date"
              tickFormatter={shortDay}
              interval={Math.floor(buckets.length / 5)}
              tick={{ fontSize: 10, fill: '#A8A29E' }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#A8A29E' }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ fill: 'rgba(15, 23, 42, 0.04)' }}
              content={<CustomTooltip />}
            />
            <Bar dataKey="approved" stackId="status" fill="#059669" radius={[0, 0, 0, 0]} />
            <Bar dataKey="in_review" stackId="status" fill="#0284C7" />
            <Bar dataKey="rejected" stackId="status" fill="#BE123C" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-[13.5px] font-semibold text-slate-900">Submissions by day</div>
        <div className="text-[11.5px] text-slate-500">Last 30 days, stacked by outcome</div>
      </div>
      <div className="flex items-center gap-3 text-[11.5px] text-slate-500">
        <LegendDot color="#059669" label="Approved" />
        <LegendDot color="#0284C7" label="In Review" />
        <LegendDot color="#BE123C" label="Rejected" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

interface TooltipPayload {
  active?: boolean;
  label?: string;
  payload?: Array<{ value: number; dataKey: string }>;
}

function CustomTooltip({ active, label, payload }: TooltipPayload) {
  if (!active || !payload?.length) return null;
  const byKey = Object.fromEntries(payload.map((p) => [p.dataKey, p.value]));
  return (
    <div className="bg-white border border-slate-200 rounded-md shadow-sm px-3 py-2 text-[12px]">
      <div className="font-medium text-slate-900 mb-1">{label}</div>
      <div className="space-y-0.5 text-slate-600">
        <div>Approved: <span className="font-mono text-slate-900">{byKey.approved ?? 0}</span></div>
        <div>In Review: <span className="font-mono text-slate-900">{byKey.in_review ?? 0}</span></div>
        <div>Rejected: <span className="font-mono text-slate-900">{byKey.rejected ?? 0}</span></div>
      </div>
    </div>
  );
}
