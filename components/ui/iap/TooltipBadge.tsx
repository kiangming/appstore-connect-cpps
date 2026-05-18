/**
 * IAP.p2.b — "?" badge with hover tooltip.
 *
 * Server-renderable: the popover is pure CSS via Tailwind's group-hover —
 * no React state, no client bundle cost. Mirrors the mockup's `.tip`
 * pattern but uses utility classes so we don't ship a global stylesheet.
 *
 * Accessibility: the tooltip text is mirrored into `aria-label` so screen
 * readers announce it whether or not hover fires.
 */
export interface TooltipBadgeProps {
  tip: string;
  className?: string;
}

export function TooltipBadge({ tip, className = "" }: TooltipBadgeProps) {
  return (
    <span
      role="img"
      aria-label={tip}
      className={`group relative inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-slate-300 text-[9px] font-semibold text-slate-500 ${className}`}
    >
      ?
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-[11px] font-normal text-white opacity-0 transition-opacity group-hover:opacity-100"
      >
        {tip}
      </span>
    </span>
  );
}
