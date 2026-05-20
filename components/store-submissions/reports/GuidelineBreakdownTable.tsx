'use client';

import { ChevronDown, ChevronRight, ExternalLink, Info } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { usePagination } from '@/lib/store-submissions/reports/use-pagination';
import type {
  GuidelineBreakdown,
  RejectReasonBreakdownResult,
  UnparseableEntry,
} from '@/lib/store-submissions/queries/reports';
import { PaginationControls } from './PaginationControls';

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
  const { guidelines, totalReasons, unparseableReasons, unparseableEntries } =
    result;
  const parseableReasons = totalReasons - unparseableReasons;

  // IAP.q.3 — 20-per-page client-side pagination. Identity-based reset
  // when `result.guidelines` flips reference (date-range / type filter
  // refetch). Hook is safe for empty arrays — `pagedItems=[]`,
  // `shouldRenderControls=false`.
  const guidelinesPagination = usePagination(guidelines);

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
        <>
          <ul className="divide-y divide-slate-100">
            {guidelinesPagination.pagedItems.map((g) => (
              <GuidelineRow key={g.code} guideline={g} />
            ))}
          </ul>
          {guidelinesPagination.shouldRenderControls && (
            <PaginationControls
              currentPage={guidelinesPagination.currentPage}
              totalPages={guidelinesPagination.totalPages}
              totalItems={guidelinesPagination.totalItems}
              hasPrev={guidelinesPagination.hasPrev}
              hasNext={guidelinesPagination.hasNext}
              onPrev={guidelinesPagination.goToPrev}
              onNext={guidelinesPagination.goToNext}
            />
          )}
        </>
      )}

      {unparseableReasons > 0 && (
        <UnparseableFooter
          count={unparseableReasons}
          entries={unparseableEntries}
        />
      )}
    </div>
  );
}

/**
 * IAP.q.2.V — expandable transparency footer. Default collapsed; clicking
 * "Show details" reveals a compact table of the unparseable rows so
 * Manager can triage the format mismatch (typo, paraphrase, deeper Apple
 * format change) and deep-link to the Inbox detail panel via the ticket
 * link.
 *
 * If `entries.length === 0` but `count > 0` (defensive — shouldn't happen
 * once the SQL select wires entry_id/display_id through), we render the
 * static message without a toggle so the footer doesn't claim a feature
 * that has nothing to show.
 */
function UnparseableFooter({
  count,
  entries,
}: {
  count: number;
  entries: UnparseableEntry[];
}) {
  const [open, setOpen] = useState(false);
  // IAP.q.3 — pagination state lives at the footer level (not inside the
  // `{open && …}` block), so collapsing + re-opening preserves the page
  // the Manager last viewed. SQ3 verbatim. Reset still fires on `entries`
  // identity flip (date-range / type filter refetch).
  const entriesPagination = usePagination(entries);

  const message = `${count} reason${count === 1 ? '' : 's'} couldn’t be parsed (no Guideline header detected).`;

  if (entries.length === 0) {
    return (
      <div className="mt-3 pt-3 border-t border-slate-100 text-[11px] text-slate-400">
        {message}
      </div>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" strokeWidth={2} />
        ) : (
          <ChevronRight className="h-3 w-3" strokeWidth={2} />
        )}
        <span>{message}</span>
        <span className="text-slate-500 underline-offset-2 hover:underline">
          {open ? 'Hide' : 'Show'} details
        </span>
      </button>

      {open && (
        <>
          <ul className="mt-2 space-y-1.5">
            {entriesPagination.pagedItems.map((e) => (
              <li
                key={e.entry_id}
                className="flex items-start gap-2 text-[11.5px] leading-snug"
              >
                <Link
                  href={`/store-submissions/inbox?ticket=${encodeURIComponent(e.ticket_id)}`}
                  className="flex-shrink-0 inline-flex items-center gap-0.5 font-mono text-slate-600 hover:text-blue-600 hover:underline"
                  aria-label={`Open ${e.ticket_display_id} in Inbox`}
                >
                  {e.ticket_display_id}
                  <ExternalLink className="h-2.5 w-2.5" strokeWidth={2} />
                </Link>
                <span className="flex-1 min-w-0 text-slate-500 break-words">
                  {e.content_preview}
                </span>
              </li>
            ))}
          </ul>
          {entriesPagination.shouldRenderControls && (
            <PaginationControls
              currentPage={entriesPagination.currentPage}
              totalPages={entriesPagination.totalPages}
              totalItems={entriesPagination.totalItems}
              hasPrev={entriesPagination.hasPrev}
              hasNext={entriesPagination.hasNext}
              onPrev={entriesPagination.goToPrev}
              onNext={entriesPagination.goToNext}
            />
          )}
        </>
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
