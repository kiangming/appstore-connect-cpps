'use client';

/**
 * Date range picker for the Apple Reports surface (PR-Reports.C).
 *
 * URL is the source of truth (mirrors PR-22 type filter convention).
 * Two FilterPills wrap native <input type="date"> for from/to selection;
 * five preset shortcuts ({7d, 30d, 90d, 1y, 2y}) cover Manager priority
 * common ranges; "Reset to last 30 days" surfaces when the range is
 * custom. The 30d preset clears params (clean default URL); other
 * presets / manual edits set ?from + ?to explicitly.
 *
 * Native <input type="date"> is intentional (Pattern 8 minimum blast
 * radius): zero new dependency, mobile pickers built-in, browser-native
 * `max=today` future-date prevention. Server-side clamp in page.tsx is
 * the authoritative validation; this component is the convenience
 * layer.
 *
 * Active preset detection: a preset is highlighted when `to === today`
 * AND the day-difference matches the preset. The default state (no
 * params) implicitly satisfies the 30d preset (effectiveFrom is 30d
 * ago, effectiveTo is today).
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { FilterPill } from '@/components/store-submissions/ui/FilterPill';

const DAY_MS = 24 * 60 * 60 * 1000;

interface DateRangePickerProps {
  /** YYYY-MM-DD URL-driven; undefined means default (last 30 days). */
  from?: string;
  /** YYYY-MM-DD URL-driven; undefined means default (today). */
  to?: string;
}

interface Preset {
  label: string;
  days: number;
}

const PRESETS: Preset[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '1y', days: 365 },
  { label: '2y', days: 730 },
];

function todayUtcStr(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

function daysAgoUtcStr(days: number): string {
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayMs - days * DAY_MS).toISOString().slice(0, 10);
}

function diffDays(fromStr: string, toStr: string): number {
  return Math.round(
    (Date.parse(toStr + 'T00:00:00Z') - Date.parse(fromStr + 'T00:00:00Z')) / DAY_MS,
  );
}

/**
 * Programmatically open the native date picker on input click.
 *
 * PR-Reports.C.1 — Manager UAT MV20 found that desktop
 * <input type="date"> only opens its picker on the small calendar
 * icon, not the field area. Since our inputs are absolute inset-0
 * opacity-0 (covering the full FilterPill surface), Manager could
 * only hit a tiny invisible target. showPicker() forces the picker
 * open in any user-gesture click. try/catch swallows
 * SecurityError/NotSupportedError on the <1% browsers without API
 * support — focus fallback still works there.
 */
function openPicker(e: React.MouseEvent<HTMLInputElement>) {
  try {
    e.currentTarget.showPicker();
  } catch {
    /* unsupported / no user activation — native focus is the fallback */
  }
}

export function DateRangePicker({ from, to }: DateRangePickerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const today = todayUtcStr();
  const isDefault = !from && !to;
  const effectiveFrom = from ?? daysAgoUtcStr(30);
  const effectiveTo = to ?? today;
  const activePresetDays =
    effectiveTo === today ? diffDays(effectiveFrom, effectiveTo) : null;

  function pushRange(nextFrom: string | undefined, nextTo: string | undefined) {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (nextFrom) params.set('from', nextFrom);
    else params.delete('from');
    if (nextTo) params.set('to', nextTo);
    else params.delete('to');
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `?${qs}` : '?');
    });
  }

  function handleFromChange(value: string) {
    if (!value) return;
    pushRange(value, effectiveTo);
  }

  function handleToChange(value: string) {
    if (!value) return;
    pushRange(effectiveFrom, value);
  }

  function handlePreset(days: number) {
    // 30d = default behavior — clear params for clean URL.
    if (days === 30) {
      pushRange(undefined, undefined);
      return;
    }
    pushRange(daysAgoUtcStr(days), today);
  }

  function handleReset() {
    pushRange(undefined, undefined);
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1 flex-wrap">
        {PRESETS.map((p) => {
          const isActive = activePresetDays === p.days;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => handlePreset(p.days)}
              disabled={isPending}
              className={`text-[12px] px-2 py-1 rounded-md border transition ${
                isActive
                  ? 'bg-blue-50 border-blue-300 text-[#0071E3] font-medium'
                  : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900'
              } ${isPending ? 'opacity-50' : ''}`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <FilterPill label="From" value={effectiveFrom} dim={isPending}>
        <input
          type="date"
          value={effectiveFrom}
          max={effectiveTo}
          onChange={(e) => handleFromChange(e.target.value)}
          onClick={openPicker}
          aria-label="From date"
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
      </FilterPill>
      <FilterPill label="To" value={effectiveTo} dim={isPending}>
        <input
          type="date"
          value={effectiveTo}
          min={effectiveFrom}
          max={today}
          onChange={(e) => handleToChange(e.target.value)}
          onClick={openPicker}
          aria-label="To date"
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
      </FilterPill>
      {!isDefault && (
        <button
          type="button"
          onClick={handleReset}
          disabled={isPending}
          className="text-[12px] text-slate-500 hover:text-slate-700 underline-offset-2 hover:underline disabled:opacity-50"
        >
          Reset to last 30 days
        </button>
      )}
    </div>
  );
}
