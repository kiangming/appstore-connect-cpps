"use client";

/**
 * IAP.p2.b — disclosure/expand panel.
 *
 * Client component — controls open/close state. Used by the Price Schedule
 * section to wrap "In-App Purchase Pricing" with a chevron toggle. Default
 * open in the mockup, but the prop is configurable so other call sites can
 * default closed (e.g. an "Advanced" subsection later).
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export interface ExpandablePanelProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
  /** Right-aligned slot inside the toggle row (e.g. small action icon). */
  trailing?: ReactNode;
}

export function ExpandablePanel({
  title,
  defaultOpen = false,
  children,
  trailing,
}: ExpandablePanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-slate-100">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-6 py-3 text-left hover:bg-slate-50"
      >
        <ChevronRight
          aria-hidden
          className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="text-sm font-medium text-slate-900">{title}</span>
        {trailing && <span className="ml-auto">{trailing}</span>}
      </button>
      {open && <div className="px-6 pb-5 space-y-5">{children}</div>}
    </div>
  );
}
