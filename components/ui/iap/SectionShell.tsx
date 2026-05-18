/**
 * IAP.p2.b — outer card wrapper for every IAP view section.
 *
 * Three slots:
 *   - title row    : title + optional adornment (e.g. "+" affordance)
 *   - description  : helper line under the title
 *   - trailing     : right-aligned slot (e.g. "All Prices and Currencies →")
 *
 * Layout matches the mockup: rounded-xl card with the title row in 6px
 * horizontal padding and the body either flush or padded depending on the
 * children. Tables look better flush; key/value grids look better padded.
 */
import type { ReactNode } from "react";

export interface SectionShellProps {
  title: string;
  description?: ReactNode;
  /** Right-side slot (link, button, count badge, …). */
  trailing?: ReactNode;
  /** Inline element rendered next to the title (e.g. "+" add affordance). */
  titleAdornment?: ReactNode;
  /** Edge-to-edge body (no horizontal padding). Tables prefer this. */
  flushBody?: boolean;
  children: ReactNode;
  className?: string;
}

export function SectionShell({
  title,
  description,
  trailing,
  titleAdornment,
  flushBody = false,
  children,
  className = "",
}: SectionShellProps) {
  return (
    <section
      className={`bg-white rounded-xl border border-slate-200 overflow-hidden ${className}`}
    >
      <div className="px-6 pt-5 pb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {titleAdornment}
          </div>
          {description && (
            <p className="text-xs text-slate-500 mt-0.5">{description}</p>
          )}
        </div>
        {trailing && <div className="shrink-0">{trailing}</div>}
      </div>
      <div className={flushBody ? "" : "px-6 pb-5"}>{children}</div>
    </section>
  );
}
