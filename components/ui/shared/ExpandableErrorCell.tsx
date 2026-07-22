"use client";

/**
 * Reusable table-cell disclosure: a 2-line human-readable summary + a
 * "Detail"/"Close" text-button toggle that reveals the complete underlying
 * text, pretty-printed as JSON when it parses as such. Built for Apple Bulk
 * Import's result table Notes column; props-driven so Google's result
 * table can adopt it later with no rewrite.
 *
 * Each instance owns its own open/closed state, so multiple rows expand
 * independently — no shared/global toggle state needed.
 */
import { useState } from "react";

export interface ExpandableErrorCellProps {
  /** Collapsed 2-line summary. Always shown. */
  summary: string;
  /** Full text to pretty-print when expanded. Omit (or empty) to render a
   *  plain summary with no Detail button. */
  detail?: string;
  className?: string;
}

function prettyPrint(detail: string): string {
  try {
    return JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    return detail;
  }
}

export function ExpandableErrorCell({
  summary,
  detail,
  className,
}: ExpandableErrorCellProps) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(detail && detail.trim().length > 0);

  return (
    <div className={className}>
      <div className="line-clamp-2">{summary}</div>
      {hasDetail && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1 text-[11px] font-medium text-[#0071E3] hover:underline"
        >
          {open ? "Close" : "Detail"}
        </button>
      )}
      {open && hasDetail && (
        <pre className="mt-1.5 max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
          {prettyPrint(detail as string)}
        </pre>
      )}
    </div>
  );
}
