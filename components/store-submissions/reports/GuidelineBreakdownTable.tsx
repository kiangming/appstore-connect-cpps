'use client';

import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { useState } from 'react';

import type {
  GuidelineBreakdown,
  RejectReasonBreakdownResult,
} from '@/lib/store-submissions/queries/reports';

interface Props {
  result: RejectReasonBreakdownResult;
}

const TOOLTIP_COPY =
  'Apple Guideline headers extracted from reject-reason text. Same Guideline cited across resubmit cycles counts each instance separately (Manager Phase E). Inline lowercase mentions inside email bodies are excluded — only the standalone "Guideline X.X[.X] - …" header line is counted.';

/**
 * Apple Guideline frequency analytics — PR-Reports.RejectReasons
 * (Phase E commitment, Manager directive).
 *
 * Rows: one per distinct Guideline code, sorted by total instance count
 * (descending). Click a row to expand Type → App breakdown. Inherits
 * date-range + type filters from the page URL — no additional controls.
 *
 * Empty state: production corpus May 2026 is tiny (Q-RejectReason-2 = 2
 * entries), so the empty path is the common case for new windows.
 *
 * Transparency footer: `unparseableReasons` surfaces entries that the
 * regex couldn't extract a Guideline header from. Expected sources:
 * pre-formatted reject reasons that don't cite a Guideline at all
 * (rare), or Apple format changes that should prompt regex revision.
 */
export function GuidelineBreakdownTable({ result }: Props) {
  const { guidelines, totalReasons, unparseableReasons } = result;
  const parseableReasons = totalReasons - unparseableReasons;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-1.5">
            <div className="text-[13.5px] font-semibold text-slate-900">
              Top Apple Guidelines
            </div>
            <span
              className="inline-flex items-center text-slate-400 hover:text-slate-600 cursor-help"
              title={TOOLTIP_COPY}
              aria-label="What counts as a Guideline instance?"
            >
              <Info className="h-3.5 w-3.5" strokeWidth={1.8} />
            </span>
          </div>
          <div className="text-[11.5px] text-slate-500">
            {totalReasons === 0
              ? 'No reject reasons logged in this period'
              : `${guidelines.length} Guideline${guidelines.length === 1 ? '' : 's'} across ${parseableReasons} reason${parseableReasons === 1 ? '' : 's'}`}
          </div>
        </div>
      </div>

      {guidelines.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-slate-400">
          {totalReasons === 0
            ? 'No data yet — log reject reasons via ticket comments to start tracking.'
            : 'No parseable Guideline headers in this period.'}
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {guidelines.map((g) => (
            <GuidelineRow key={g.code} guideline={g} />
          ))}
        </ul>
      )}

      {unparseableReasons > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-100 text-[11px] text-slate-400">
          {unparseableReasons} reason{unparseableReasons === 1 ? '' : 's'} couldn&apos;t be parsed (no Guideline header detected).
        </div>
      )}
    </div>
  );
}

function GuidelineRow({ guideline }: { guideline: GuidelineBreakdown }) {
  const [expanded, setExpanded] = useState(false);
  const hasBreakdown = guideline.types.length > 0;

  return (
    <li>
      <button
        type="button"
        onClick={() => hasBreakdown && setExpanded((v) => !v)}
        disabled={!hasBreakdown}
        className={`w-full text-left py-2.5 px-2 -mx-2 rounded-md flex items-start gap-2 transition-colors ${
          hasBreakdown ? 'hover:bg-slate-50' : 'cursor-default'
        }`}
        aria-expanded={hasBreakdown ? expanded : undefined}
      >
        <span className="flex-shrink-0 mt-0.5 text-slate-400">
          {hasBreakdown ? (
            expanded ? (
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
            )
          ) : (
            <span className="inline-block w-3.5" aria-hidden />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-mono font-medium text-slate-900">
              {guideline.code}
            </span>
            <span className="text-[12.5px] text-slate-700 truncate">
              {guideline.description}
            </span>
          </div>
        </div>
        <span className="flex-shrink-0 text-[13px] font-mono font-semibold text-slate-900 tabular-nums">
          {guideline.total}
        </span>
      </button>

      {expanded && hasBreakdown && (
        <div className="ml-6 mb-2 mr-2 mt-0.5 pl-3 border-l border-slate-100">
          <ul className="space-y-1.5 py-1">
            {guideline.types.map((t) => (
              <li key={t.type_id}>
                <div className="flex items-baseline justify-between gap-2 py-0.5">
                  <span className="text-[11.5px] font-medium text-slate-600 uppercase tracking-wider">
                    {t.type_name}
                  </span>
                  <span className="text-[11.5px] font-mono text-slate-500 tabular-nums">
                    {t.count}
                  </span>
                </div>
                <ul className="ml-2 mt-0.5 space-y-0.5">
                  {t.apps.map((a) => (
                    <li
                      key={a.app_id}
                      className="flex items-baseline justify-between gap-2 text-[12px]"
                    >
                      <span className="text-slate-600 truncate">{a.app_name}</span>
                      <span className="font-mono text-slate-400 tabular-nums">
                        {a.count}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
