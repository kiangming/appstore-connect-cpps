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
 * ⚠ X3 LANDED HERE, AS PLANNED — the per-item checkbox list sits beside the
 * status filter in this same step, rendered by `IapSelectionList`, the
 * component extracted from `BulkStatusModal` (T1). There is exactly ONE item
 * selection surface in the export flow and this is it. A second one would be
 * P1 twin-path: two "select all" scopes for one behaviour.
 *
 * ⚠ THE TWO CONTROLS COMPOSE IN ONE DIRECTION ONLY. The status filter chooses
 * the CANDIDATE set; the checkboxes narrow it. Changing the filter therefore
 * resets the selection to "all candidates" — a selection built against a
 * different candidate set is not a selection the operator made. That reset is
 * the caller's, since the caller owns the state.
 *
 * ⚠ EVERYTHING SELECTED MEANS "NO SELECTION", DELIBERATELY. The caller sends
 * `null` rather than a list of every SKU, so the untouched path stays exactly
 * the pre-X3 request. It also means the route's `[]`→400 and unknown-SKU→409
 * rules only ever fire on a list somebody actually narrowed.
 */
import { X } from "lucide-react";

import type { IapWithDefaultLocale } from "@/lib/google-iap-management/repository/iaps";
import {
  countByStatus,
  matchesStatusFilter,
  STATUS_FILTER_NOTE,
  type ExportStatusFilter,
} from "@/lib/google-iap-management/export-status-filter";
import { IapSelectionList } from "./IapSelectionList";

export interface ExportScopeDialogProps {
  open: boolean;
  /** Live (not soft-deleted) items from the mirror — the page's own prop. */
  items: readonly IapWithDefaultLocale[];
  value: ExportStatusFilter;
  onChange: (next: ExportStatusFilter) => void;
  onCancel: () => void;
  onNext: () => void;
  /** Controlled selection, by SKU. Owned by the caller so the reset rules
   *  (open, and filter change) live in one place. */
  selected: ReadonlySet<string>;
  onToggleSku: (sku: string) => void;
  onToggleAll: (matchingSkus: string[]) => void;
  query: string;
  onQueryChange: (q: string) => void;
  windowSize: number;
  onShowMore: () => void;
  /** Chunk 1 — shift-click ranges. Threaded through rather than defaulted
   *  here, so the ONE place that decides the write path stays plain is the
   *  caller (C2). */
  onSelectionChange: (next: Set<string>) => void;
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
  selected,
  onToggleSku,
  onToggleAll,
  query,
  onQueryChange,
  windowSize,
  onShowMore,
  onSelectionChange,
}: ExportScopeDialogProps) {
  if (!open) return null;

  const counts = countByStatus(items);
  // The candidate set: what the status filter admits. The checkboxes narrow
  // THIS, never the whole app.
  const candidates = items.filter((i) => matchesStatusFilter(i.status, value));
  const selectedInScope = candidates.filter((i) => selected.has(i.sku)).length;

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

          <div className="mt-4 pt-3 border-t border-slate-200">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-2">
              Items ({selectedInScope} of {candidates.length} selected)
            </p>
            <div className="max-h-[280px] overflow-y-auto pr-1">
              <IapSelectionList
                items={candidates}
                selected={selected}
                onToggleOne={onToggleSku}
                onToggleAll={onToggleAll}
                query={query}
                onQueryChange={onQueryChange}
                windowSize={windowSize}
                onShowMore={onShowMore}
                rangeSelect
                onSelectionChange={onSelectionChange}
                selectAllLabel={(n) => `Select all (${n})`}
                renderTrailing={(iap) => (
                  <span
                    className={`inline-flex items-center gap-1.5 text-[11px] font-medium flex-shrink-0 ${
                      iap.status === "active" ? "text-emerald-700" : "text-slate-500"
                    }`}
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${
                        iap.status === "active" ? "bg-emerald-500" : "bg-slate-400"
                      }`}
                    />
                    {iap.status === "active" ? "active" : "inactive"}
                  </span>
                )}
              />
            </div>
          </div>
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
            disabled={selectedInScope === 0}
            className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {/* ⚠ DISABLED AT ZERO, NOT SILENTLY WIDENED TO "ALL". An empty
                selection is refused by the route with a 400; letting the
                operator through here would trade a clear stop for a confusing
                server error, and widening it to "everything" would export a
                file they did not ask for. */}
            {selectedInScope === 0
              ? "Select at least 1 item"
              : `Next — choose countries (${selectedInScope})`}
          </button>
        </div>
      </div>
    </div>
  );
}
