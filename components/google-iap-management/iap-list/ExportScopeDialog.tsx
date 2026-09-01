"use client";

/**
 * X2 — step 1 of "Export list": WHICH ITEMS. Step 2 is the shared
 * `ExportOptionsDialog` (which countries), unmodified.
 *
 * ⚠ CHANGING THE FILTER COSTS ZERO GOOGLE REQUESTS, and that is the feature,
 * not a side effect. The counts come from `items` — the list the page already
 * rendered from the mirror — so every option is priced before the operator
 * commits to anything. A version that fetched per click would make the cheap
 * act of looking expensive.
 *
 * ⚠ AND THE EXPORT ITSELF IS STILL ONE REQUEST WHATEVER IS CHOSEN. Unlike the
 * Apple export (~3 requests per item, where narrowing the batch is how the
 * operator saves money), Google's list is a single paginated call for the
 * whole app. So there is deliberately NO "estimated cost" copy here: quoting a
 * number that does not move would be worse than quoting none.
 *
 * ⚠ THE LABEL DOES NOT SAY "ACTIVE" AND STOP. `STATUS_FILTER_NOTE` is rendered
 * beside the options because the tool's "Active" covers two of Google's states
 * — see the note's own docblock. A control that quietly means something wider
 * than its label is the defect this note exists to prevent.
 *
 * ⚠ THIS COMPONENT IS THE SEAM FOR X3. The per-item checkbox list lands here,
 * beside the status filter, reusing `BulkStatusModal`'s selection list (T1) —
 * which is why this is a scope dialog and not a "status filter dialog". Do not
 * grow a second selection surface elsewhere.
 */
import { X } from "lucide-react";

import {
  countByStatus,
  STATUS_FILTER_NOTE,
  type ExportStatusFilter,
} from "@/lib/google-iap-management/export-status-filter";

export interface ExportScopeDialogProps {
  open: boolean;
  /** Live (not soft-deleted) items from the mirror — the page's own prop. */
  items: readonly { status: string | null | undefined }[];
  value: ExportStatusFilter;
  onChange: (next: ExportStatusFilter) => void;
  onCancel: () => void;
  onNext: () => void;
}

const OPTIONS: ReadonlyArray<{ value: ExportStatusFilter; label: string }> = [
  { value: "all", label: "All items" },
  { value: "active", label: "Active only" },
  { value: "inactive", label: "Inactive only" },
];

export function ExportScopeDialog({
  open,
  items,
  value,
  onChange,
  onCancel,
  onNext,
}: ExportScopeDialogProps) {
  if (!open) return null;

  const counts = countByStatus(items);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl">
        <div className="px-5 pt-[18px] pb-3.5 border-b border-slate-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900">
              Export list — items to include
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Step 1 of 2 · countries are chosen next
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="flex-shrink-0 text-slate-400 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <div
            role="radiogroup"
            aria-label="Item status"
            className="rounded-lg border border-slate-200 divide-y divide-slate-100"
          >
            {OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-slate-50"
              >
                <input
                  type="radio"
                  name="export-status-filter"
                  value={opt.value}
                  checked={value === opt.value}
                  onChange={() => onChange(opt.value)}
                  className="h-3.5 w-3.5 accent-emerald-600"
                />
                <span className="flex-1 text-[13px] text-slate-900">
                  {opt.label}
                </span>
                <span className="text-[11px] font-semibold text-slate-500 tabular-nums">
                  {counts[opt.value]}
                </span>
              </label>
            ))}
          </div>

          <p className="mt-2.5 text-[11px] leading-relaxed text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {STATUS_FILTER_NOTE}
          </p>

          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            These counts come from the list on screen, which was last synced
            from Google by Refresh. The file is built from Google live, so if
            an item changed since then the file follows Google — and the result
            message says so.
          </p>
        </div>

        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 rounded-b-2xl flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={counts[value] === 0}
            className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {counts[value] === 0
              ? "No items match"
              : `Next — choose countries (${counts[value]})`}
          </button>
        </div>
      </div>
    </div>
  );
}
