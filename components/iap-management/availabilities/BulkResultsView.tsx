"use client";

/**
 * Bulk availability results (design §D — the display side of stop-and-resume).
 *
 * ⚠ THREE STATES, RENDERED SEPARATELY. succeeded / failed / NOT_ATTEMPTED.
 * Merging the last two is invisible in a screenshot and destroys the only
 * bucket a resume can safely re-run: NOT_ATTEMPTED means nothing was sent, so
 * re-sending is harmless, while FAILED means Apple was asked and refused and
 * SC3 locked the decision that a human reads the reason first.
 *
 * ⚠ A STOPPED RUN IS NOT A FAILED RUN (P5). `STOPPED_RATE_LIMITED` means the
 * retry budget was spent, so the orchestrator stopped dispatching rather than
 * burning it further — most items may already have succeeded. Painting that
 * red would tell the Manager to redo work that already landed.
 *
 * ⚠ THE REMAINDER LIVES ONLY HERE (Manager decision 6). Closing this view
 * loses it, so the view SAYS so, with the count, BEFORE the dialog can be
 * closed — not as a toast afterwards, which arrives when the list is already
 * gone.
 *
 * The partition and the resumable set come from `bulk-availability-view.ts`;
 * this file renders them and owns no filtering of its own.
 */

import { AlertTriangle, CheckCircle2, PauseCircle, XCircle } from "lucide-react";
import {
  isStoppedRun,
  partitionResults,
  resumableIds,
  type BulkRowResult,
} from "@/lib/iap-management/apple/bulk-availability-view";

export interface BulkResultsViewProps {
  results: readonly BulkRowResult[];
  overall: string;
  summary: string;
  /** Apple IAP id / internal id → display label, for naming rows. */
  labelFor: (iapId: string) => string;
  retrying: boolean;
  onRetryNotAttempted: (iapIds: string[]) => void;
  /** Called when the Manager confirms they accept losing the remainder. */
  onCloseConfirmed: () => void;
}

export function BulkResultsView({
  results,
  overall,
  summary,
  labelFor,
  retrying,
  onRetryNotAttempted,
  onCloseConfirmed,
}: BulkResultsViewProps) {
  const { succeeded, failed, notAttempted } = partitionResults(results);
  const resumable = resumableIds(results);
  const stopped = isStoppedRun(overall);

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Headline. A stopped run gets its own amber treatment — never the red
          reserved for "this failed". */}
      <div
        data-testid="results-headline"
        data-overall={overall}
        className={`px-5 py-3 border-b flex items-start gap-2 ${
          stopped
            ? "border-amber-300 bg-amber-50 dark:bg-amber-900/20"
            : failed.length > 0 && succeeded.length === 0
              ? "border-red-300 bg-red-50 dark:bg-red-900/20"
              : "border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30"
        }`}
      >
        {stopped ? (
          <PauseCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
        ) : failed.length > 0 && succeeded.length === 0 ? (
          <XCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />
        )}
        <div className="flex-1">
          <p
            data-testid="results-title"
            className={`text-xs font-semibold ${
              stopped
                ? "text-amber-900 dark:text-amber-200"
                : "text-slate-800 dark:text-slate-100"
            }`}
          >
            {stopped
              ? "Stopped early — Apple's rate limit was exhausted"
              : failed.length > 0 && succeeded.length === 0
                ? "No items were updated"
                : failed.length > 0
                  ? "Finished with some failures"
                  : "Finished"}
          </p>
          {stopped && (
            <p className="text-[11px] text-amber-800 dark:text-amber-300/90 mt-0.5">
              This is not a failure — {succeeded.length} item
              {succeeded.length === 1 ? "" : "s"} already went through. The rest
              was left untouched rather than spending a budget that was gone.
            </p>
          )}
          <p className="text-[11px] text-slate-500 mt-0.5">{summary}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-3 space-y-4">
        {/* 1 — succeeded */}
        <section data-testid="results-succeeded" data-count={succeeded.length}>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-emerald-700 mb-1.5">
            Updated ({succeeded.length})
          </h4>
          {succeeded.length === 0 ? (
            <p className="text-[11px] text-slate-400">None.</p>
          ) : (
            <ul className="space-y-0.5">
              {succeeded.map((r) => (
                <li
                  key={r.iapId}
                  data-testid={`result-success-${r.iapId}`}
                  className="text-[11px] text-slate-700 dark:text-slate-200"
                >
                  {labelFor(r.iapId)}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 2 — failed, with each item's OWN reason. Never one summary. */}
        {failed.length > 0 && (
          <section data-testid="results-failed" data-count={failed.length}>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-red-700 mb-1.5">
              Failed ({failed.length})
            </h4>
            <p className="text-[11px] text-slate-500 mb-1.5">
              These were sent and Apple refused them. They are not retried
              automatically — read the reason first, then fix and re-run.
            </p>
            <ul className="space-y-1">
              {failed.map((r) => (
                <li
                  key={r.iapId}
                  data-testid={`result-failed-${r.iapId}`}
                  className="text-[11px]"
                >
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {labelFor(r.iapId)}
                  </span>
                  <span className="text-red-700 dark:text-red-300">
                    {" "}
                    — {r.error ?? "no reason reported"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 3 — NOT_ATTEMPTED, its own state, and the only resumable one. */}
        {notAttempted.length > 0 && (
          <section
            data-testid="results-not-attempted"
            data-count={notAttempted.length}
            className="rounded-lg border-2 border-amber-300 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5"
          >
            <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200 mb-1">
              Not attempted ({notAttempted.length})
            </h4>
            <p className="text-[11px] text-amber-800 dark:text-amber-300/90">
              Nothing was sent for these, so nothing about them has changed.
              They can be retried safely.
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {notAttempted.map((r) => (
                <li
                  key={r.iapId}
                  data-testid={`result-not-attempted-${r.iapId}`}
                  className="text-[11px] text-amber-900 dark:text-amber-200"
                >
                  {labelFor(r.iapId)}
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={retrying || resumable.length === 0}
              onClick={() => onRetryNotAttempted(resumable)}
              data-testid="results-retry"
              className="mt-2 px-3 py-1.5 rounded-md bg-amber-600 text-white text-[11px] font-medium disabled:opacity-50"
            >
              {retrying
                ? "Retrying…"
                : `Retry the ${resumable.length} not-attempted item${resumable.length === 1 ? "" : "s"}`}
            </button>
          </section>
        )}
      </div>

      {/* ⚠ The remainder-loss warning, BEFORE the close affordance — decision 6. */}
      <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30">
        {notAttempted.length > 0 && (
          <p
            data-testid="remainder-loss-warning"
            className="text-[11px] text-amber-900 dark:text-amber-200 flex items-start gap-1.5 mb-2"
          >
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
            <span>
              Closing this loses the list of{" "}
              <strong>
                {notAttempted.length} not-attempted item
                {notAttempted.length === 1 ? "" : "s"}
              </strong>
              . It is not saved anywhere — retry them now, or note them down
              before you close.
            </span>
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onCloseConfirmed}
            data-testid="results-close"
            className="px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 text-xs"
          >
            {notAttempted.length > 0 ? "Close and discard the list" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
