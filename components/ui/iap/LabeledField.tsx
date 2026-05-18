/**
 * IAP.p2.b — label + tooltip + value row.
 *
 * The atomic "field readout" used across the header, review section, and
 * any place where a single piece of Apple data needs a label + tooltip.
 * Right-side `hint` slot powers the character-counter pattern from the
 * mockup (e.g. "44 / 64" next to Reference Name).
 *
 * Server-renderable.
 */
import type { ReactNode } from "react";
import { TooltipBadge } from "./TooltipBadge";

export interface LabeledFieldProps {
  label: string;
  /** Optional "?" tooltip text shown next to the label. */
  tip?: string;
  /** Right-aligned hint (character counter, status pill, etc.). */
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function LabeledField({
  label,
  tip,
  hint,
  children,
  className = "",
}: LabeledFieldProps) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <label className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            {label}
          </label>
          {tip && <TooltipBadge tip={tip} />}
        </div>
        {hint !== undefined && hint !== null && (
          <span className="text-[10px] text-slate-400 tabular-nums">{hint}</span>
        )}
      </div>
      <div className="text-sm text-slate-900">{children}</div>
    </div>
  );
}
