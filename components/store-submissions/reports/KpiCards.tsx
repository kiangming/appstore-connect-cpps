import { ArrowDown, ArrowUp, Info } from 'lucide-react';
import type { ReportsKpis } from '@/lib/store-submissions/queries/reports';

interface Props {
  kpis: ReportsKpis;
  /** Days in the comparison window — used in the "vs previous Nd" subtitle copy. */
  windowDays: number;
}

/**
 * Manager-education tooltips (PR-Reports.Tooltips, MV17 preventive).
 *
 * Copy is grounded against the aggregator semantics in
 * `lib/store-submissions/queries/reports.ts:190-202` + `BURST_DEDUP_WINDOW_MS`
 * + migration `20260502` (`opened_at = v_now`) + CLAUDE.md Invariant 6
 * (`closed_at ↔ state IN (DONE, ARCHIVED)` covers auto-done + Manager
 * Mark Done paths). Verified before ship — Pattern 10 reuse #18.
 */
const TOOLTIP_TOTAL =
  'Tickets with outcome (APPROVED or REJECTED) in window. DISTINCT ticket count — IN_REVIEW and no-outcome tickets excluded.';
const TOOLTIP_APPROVED =
  'Apple may send multiple approval emails per ticket. Counted as 1 per ticket (DISTINCT ticket_id).';
const TOOLTIP_REJECTED =
  'Apple may retry rejection emails within seconds. 60-second burst dedup collapses each burst to 1; separate resubmit rejections count as separate cycles.';
const TOOLTIP_AVG_REVIEW =
  'Mean time from ticket open (opened_at) to Mark Done (closed_at). APPROVED tickets only — closed_at = auto-done moment or Manager Mark Done click.';

/**
 * 4 KPI cards: Total / Approved / Rejected / Avg review time.
 *
 * Delta semantics — "higher is better" or "lower is better" depends on
 * the metric, so the arrow + color flips per card. Approved up = good
 * (emerald), Rejected up = bad (rose), Avg review time up = bad.
 */
export function KpiCards({ kpis, windowDays }: Props) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Card
        label="Total submissions"
        value={kpis.total.toLocaleString()}
        delta={kpis.deltas.total}
        deltaSemantic="higher-is-better"
        subtitle={`vs previous ${windowDays}d`}
        tooltip={TOOLTIP_TOTAL}
      />
      <Card
        label="Approved"
        value={kpis.approved.toLocaleString()}
        delta={kpis.deltas.approved}
        deltaSemantic="higher-is-better"
        subtitle={
          kpis.total > 0
            ? `${((kpis.approved / kpis.total) * 100).toFixed(1)}% approval rate`
            : 'no data'
        }
        tooltip={TOOLTIP_APPROVED}
      />
      <Card
        label="Rejected"
        value={kpis.rejected.toLocaleString()}
        valueColor={kpis.rejected > 0 ? 'text-rose-700' : undefined}
        delta={kpis.deltas.rejected}
        deltaSemantic="lower-is-better"
        subtitle={
          kpis.total > 0
            ? `${((kpis.rejected / kpis.total) * 100).toFixed(1)}% reject rate`
            : 'no data'
        }
        tooltip={TOOLTIP_REJECTED}
      />
      <Card
        label="Avg. review time"
        value={kpis.avgReviewTimeMs !== null ? formatDuration(kpis.avgReviewTimeMs) : '—'}
        delta={kpis.deltas.avgReviewTime}
        deltaSemantic="lower-is-better"
        subtitle="submit → approved"
        tooltip={TOOLTIP_AVG_REVIEW}
      />
    </div>
  );
}

interface CardProps {
  label: string;
  value: string;
  valueColor?: string;
  delta: number | null;
  deltaSemantic: 'higher-is-better' | 'lower-is-better';
  subtitle: string;
  /** Optional Manager-education tooltip; renders an Info icon next to the label. */
  tooltip?: string;
}

function Card({
  label,
  value,
  valueColor,
  delta,
  deltaSemantic,
  subtitle,
  tooltip,
}: CardProps) {
  const deltaDisplay = formatDelta(delta, deltaSemantic);
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-center gap-1 text-[11.5px] text-slate-500 uppercase tracking-wider">
        <span>{label}</span>
        {tooltip && (
          <span
            title={tooltip}
            aria-label={tooltip}
            className="cursor-help inline-flex"
          >
            <Info className="h-3 w-3 text-slate-400" strokeWidth={2} />
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <div className={`text-[34px] leading-none font-semibold ${valueColor ?? ''}`}>
          {value}
        </div>
        {deltaDisplay && (
          <div className={`text-[12px] font-medium flex items-center gap-0.5 ${deltaDisplay.color}`}>
            {deltaDisplay.direction === 'up' && <ArrowUp className="h-3 w-3" strokeWidth={2.4} />}
            {deltaDisplay.direction === 'down' && <ArrowDown className="h-3 w-3" strokeWidth={2.4} />}
            {deltaDisplay.text}
          </div>
        )}
      </div>
      <div className="text-[11.5px] text-slate-400 mt-1">{subtitle}</div>
    </div>
  );
}

interface DeltaDisplay {
  text: string;
  color: string;
  direction: 'up' | 'down' | 'flat';
}

function formatDelta(
  pct: number | null,
  semantic: 'higher-is-better' | 'lower-is-better',
): DeltaDisplay | null {
  if (pct === null) return null;
  const rounded = Math.round(pct);
  if (rounded === 0) {
    return { text: '0%', color: 'text-slate-500', direction: 'flat' };
  }
  const direction = rounded > 0 ? 'up' : 'down';
  const isGood = semantic === 'higher-is-better' ? rounded > 0 : rounded < 0;
  const color = isGood ? 'text-emerald-600' : 'text-rose-600';
  const sign = rounded > 0 ? '+' : '';
  return { text: `${sign}${rounded}%`, color, direction };
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 60) return totalMinutes < 1 ? '<1m' : `${totalMinutes}m`;
  const totalHours = Math.round(ms / (60 * 60 * 1000));
  if (totalHours < 24) return `${totalHours}h`;
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const remainingHours = Math.round((ms - days * 24 * 60 * 60 * 1000) / (60 * 60 * 1000));
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}
