'use client';

import { ChevronDown } from 'lucide-react';

/**
 * Shared filter pill — label / value / chevron with a wrapped <select>
 * (or other interactive child) absolutely positioned over the surface.
 *
 * Extracted from inline copies in InboxClient (PR-17.1), AppsClient,
 * and ReportsFilters (PR-22) once a third copy accumulated. Two
 * orthogonal mute states are preserved as distinct props because they
 * encode different concerns:
 *
 *   - `disabled`: persistent unusable state — e.g. a dependent filter
 *     whose parent has no selection. Adds `cursor-not-allowed` and
 *     surfaces `disabledHint` as a tooltip via `title`. Callers should
 *     also disable the wrapped `<select>` so keyboard tabbing skips it.
 *
 *   - `dim`: transient pending state — e.g. a router transition is in
 *     flight. Stays interactive (no `cursor-not-allowed`, no tooltip);
 *     just mutes the colors briefly while RSC re-renders.
 *
 * Style precedence: `disabled` > `dim` > enabled. When both are true,
 * disabled wins (harder mute + tooltip). This case doesn't currently
 * occur in callers but is well-defined so consumers can compose freely.
 */
export interface FilterPillProps {
  label: string;
  value: string;
  children: React.ReactNode;
  disabled?: boolean;
  disabledHint?: string;
  dim?: boolean;
}

export function FilterPill({
  label,
  value,
  children,
  disabled = false,
  disabledHint,
  dim = false,
}: FilterPillProps) {
  const containerClasses = disabled
    ? 'text-slate-300 border-slate-100 bg-slate-50 cursor-not-allowed'
    : dim
      ? 'text-slate-400 border-slate-100 bg-slate-50 cursor-pointer'
      : 'text-slate-600 hover:text-slate-900 border-slate-200 hover:border-slate-300 bg-white cursor-pointer';

  const valueClasses = disabled
    ? 'text-slate-300 font-normal'
    : 'text-slate-400 font-normal';

  const chevronClasses = disabled ? 'text-slate-200' : 'text-slate-400';

  return (
    <label
      className={`relative inline-flex items-center gap-1.5 text-[13px] border rounded-lg px-3 py-1.5 ${containerClasses}`}
      title={disabled ? disabledHint : undefined}
    >
      <span className="font-medium">{label}</span>
      <span className={valueClasses}>{value}</span>
      <ChevronDown className={`w-3 h-3 ${chevronClasses}`} strokeWidth={1.8} />
      {children}
    </label>
  );
}
