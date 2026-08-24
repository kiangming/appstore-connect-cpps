"use client";

/**
 * What the export actually did — shown after the file downloads, whenever
 * there is something a toast cannot carry honestly.
 *
 * Design: docs/iap-management/design-export-list-item-selection.md PART 3.
 *
 * ⚠ NOT `BulkResultsView`, and not because of style. That component takes
 * `results: BulkRowResult[]` — PER-ITEM rows — and owns a retry affordance
 * that re-posts the same `TerritorySelection`. Export has neither: its
 * response body IS the .xlsx, so the outcome rides back as four scalar
 * headers, and there is no selection object to re-post. Routing export
 * through it would mean either a dead button or teaching it a second retry
 * shape. That is the same call `AvailabilitiesBulkModal.tsx:1791-1797` already
 * made for the two all-or-nothing modes, for the same reason.
 *
 * ⚠ WHAT *IS* SHARED IS THE VOCABULARY, from `bulk-availability-view.ts`:
 * `BulkRowStatus` names the three states here rather than this file spelling
 * them again as strings. `partitionResults` / `resumableIds` are deliberately
 * NOT called — they take per-item rows, and manufacturing rows from counts to
 * satisfy a helper signature would be inventing data the response never
 * carried.
 *
 * ⚠ A STOPPED RUN IS NOT A FAILED RUN (P5). Amber, never red, and it says so
 * in words: most items may already have exported cleanly, and painting that
 * red tells the operator to redo work that already landed.
 *
 * ⚠ THE THREE OUTCOMES STAY APART. "Partially exported" is IN the file with
 * prices missing; "failed" is not in the main sheet at all; "not attempted"
 * was never sent. They lead to three different next actions, and one merged
 * number leads to none of them.
 *
 * ⚠ NO "EXPORT THE N NOT-ATTEMPTED" BUTTON — see PART 3's mockup, which shows
 * one. It cannot be built honestly from what the response carries: the
 * remainder arrives as a COUNT, and pre-ticking "only those N" needs their
 * IDS. Re-exporting the whole selection instead would re-send the FAILED
 * items too, which SC3 locked against — a human reads the reason first. The
 * remainder is not lost; it is named, per item, in the workbook's
 * "Export Failures" sheet, which is a better home than a view that dies on
 * close. Backlog: `[EXPORT-resume-not-attempted]`.
 */

import { AlertTriangle, CheckCircle2, PauseCircle } from "lucide-react";

import type { BulkRowStatus } from "@/lib/iap-management/apple/bulk-availability-view";

/** The workbook sheet that names every non-clean row, per item. */
const FAILURE_SHEET_NAME = "Export Failures";

export interface ExportResultSummaryProps {
  /** Rows in the main sheet. Includes the partial ones. */
  exported: number;
  /** In the main sheet, prices missing. A PROPERTY of exported rows — never
   *  added to the other counts. */
  partial: number;
  /** Asked and refused. */
  failed: number;
  /** Nothing was sent. */
  notAttempted: number;
  /** The pool's own latch, read from `X-Export-Stopped` — never re-derived
   *  from the counts. */
  stopped: boolean;
  /** How many items the operator picked, when they picked. `null` on the
   *  export-all path, where there is no denominator to speak of. */
  selectedCount: number | null;
  onClose: () => void;
}

/** Names the three buckets with the shared vocabulary rather than free text,
 *  so a rename upstream reaches this surface too. */
const STATUS_TITLE: Record<BulkRowStatus, string> = {
  SUCCESS: "exported",
  FAILED: "failed — Apple was asked and refused",
  NOT_ATTEMPTED: "not attempted — nothing was sent",
};

export function ExportResultSummary({
  exported,
  partial,
  failed,
  notAttempted,
  stopped,
  selectedCount,
  onClose,
}: ExportResultSummaryProps) {
  const attempted = exported + failed;
  const total = exported + failed + notAttempted;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4">
      <div
        data-testid="export-result-summary"
        data-stopped={stopped ? "rate_limit" : "no"}
        className="w-full max-w-lg rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl"
      >
        <div
          className={`px-5 py-3 border-b flex items-start gap-2 ${
            stopped
              ? "border-amber-300 bg-amber-50 dark:bg-amber-900/20"
              : failed > 0
                ? "border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30"
                : "border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30"
          }`}
        >
          {stopped ? (
            <PauseCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />
          )}
          <div className="flex-1">
            <p
              data-testid="export-result-title"
              className={`text-xs font-semibold ${
                stopped
                  ? "text-amber-900 dark:text-amber-200"
                  : "text-slate-800 dark:text-slate-100"
              }`}
            >
              {stopped
                ? `Export stopped — Apple's rate limit ran out after ${attempted} of ${total} items`
                : failed > 0
                  ? "Export finished, with some items missing"
                  : "Export finished"}
            </p>
            {stopped && (
              <p className="text-[11px] text-amber-800 dark:text-amber-300/90 mt-0.5">
                This is not a failure — {exported} item
                {exported === 1 ? "" : "s"} already exported. The rest was left
                untouched rather than spending a budget that was gone.
              </p>
            )}
          </div>
        </div>

        <ul className="px-5 py-3 space-y-1.5 text-[12px]">
          <li data-testid="result-exported" className="text-slate-700 dark:text-slate-200">
            ▸ <strong>{exported}</strong> {STATUS_TITLE.SUCCESS}
          </li>
          {partial > 0 && (
            <li data-testid="result-partial" className="text-slate-700 dark:text-slate-200">
              {/* ⚠ A SUBSET of the exported count, never an extra bucket. The
                  row IS in the file; only its prices are missing. */}
              ▸ <strong>{partial}</strong> of those partially exported — prices
              missing, and the reason is recorded
            </li>
          )}
          {failed > 0 && (
            <li data-testid="result-failed" className="text-red-700 dark:text-red-300">
              ▸ <strong>{failed}</strong> {STATUS_TITLE.FAILED}
            </li>
          )}
          {notAttempted > 0 && (
            <li
              data-testid="result-not-attempted"
              className="text-amber-800 dark:text-amber-200"
            >
              ▸ <strong>{notAttempted}</strong> {STATUS_TITLE.NOT_ATTEMPTED}.
              Safe to export again.
            </li>
          )}
          {selectedCount !== null && (
            <li
              data-testid="result-of-selected"
              className="text-slate-500 dark:text-slate-400 pt-1"
            >
              You selected {selectedCount} item
              {selectedCount === 1 ? "" : "s"}.
            </li>
          )}
        </ul>

        {/* ⚠ WHERE THE REMAINDER LIVES. Export's advantage over the
            availability modal is exactly this: closing does not lose it. */}
        {(failed > 0 || notAttempted > 0 || partial > 0) && (
          <p
            data-testid="failure-sheet-pointer"
            className="mx-5 mb-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 px-3 py-2 text-[11px] text-slate-600 dark:text-slate-300 flex items-start gap-1.5"
          >
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
            <span>
              The file has downloaded. Its &ldquo;{FAILURE_SHEET_NAME}&rdquo;
              sheet names every one of these {failed + notAttempted + partial}{" "}
              rows individually, with its own reason — closing this does not
              lose them.
            </span>
          </p>
        )}

        <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            data-testid="export-result-close"
            className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
