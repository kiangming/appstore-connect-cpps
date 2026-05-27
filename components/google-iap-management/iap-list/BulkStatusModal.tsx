"use client";

/**
 * Cycle 41 — Bulk Activate / Bulk Deactivate modal (Google IAP).
 *
 * One component, two modes. The mode prop drives:
 *   • Eligibility filter (Activate → inactive items; Deactivate → active)
 *   • Title + subtitle + primary button copy
 *   • Color palette (emerald success / red destructive)
 *   • Confirm dialog gate (Deactivate only — Manager directive verbatim)
 *
 * UX flow per the Cycle 41 mockup (docs/google-iap-management/design/
 * bulk-status-mockup.html):
 *   1. Selection — checkbox list of eligible items + Select all toggle
 *   2. Confirm (Deactivate only) — count display + Confirm/Cancel
 *   3. Executing — spinner + progress (no real progress events, just
 *      the wait UI; orchestrator is server-side sequential batches)
 *   4. Result — per-row outcome + summary chip; failed rows in red
 *   5. Empty — surfaced when no items match the mode's eligibility
 *
 * Submit POSTs to `/api/google-iap-management/apps/{packageName}/iaps/
 * bulk-{activate|deactivate}` and renders the per-row response. List
 * page refreshes after the modal closes so the row statuses reflect
 * the new state.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Loader2,
  X,
  AlertTriangle,
  MinusCircle,
} from "lucide-react";

import type { IapWithDefaultLocale } from "@/lib/google-iap-management/repository/iaps";

export type BulkStatusMode = "activate" | "deactivate";

interface RowResult {
  sku: string;
  ok: boolean;
  error?: string;
}

interface BulkStatusResponse {
  action: BulkStatusMode;
  total: number;
  succeeded: number;
  failed: number;
  results: RowResult[];
  overall: "SUCCESS" | "PARTIAL" | "FAILURE" | "NO_OP";
  summary: string;
  batches: number;
}

export interface BulkStatusModalProps {
  open: boolean;
  mode: BulkStatusMode;
  packageName: string;
  /** Full IAP list (rendered or paginated) — modal filters internally. */
  iaps: IapWithDefaultLocale[];
  onClose: () => void;
  /** Called after a successful run so the parent can refresh the list. */
  onComplete?: () => void;
}

export function BulkStatusModal({
  open,
  mode,
  packageName,
  iaps,
  onClose,
  onComplete,
}: BulkStatusModalProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<RowResult[] | null>(null);
  const [overall, setOverall] = useState<BulkStatusResponse["overall"] | null>(
    null,
  );
  const [summaryText, setSummaryText] = useState<string | null>(null);

  const eligible = useMemo(() => {
    const target: "active" | "inactive" =
      mode === "activate" ? "inactive" : "active";
    return iaps.filter((i) => i.status === target);
  }, [iaps, mode]);

  if (!open) return null;

  const destructive = mode === "deactivate";

  function handleClose() {
    setSelected(new Set());
    setConfirmOpen(false);
    setResults(null);
    setOverall(null);
    setSummaryText(null);
    onClose();
  }

  function toggleOne(sku: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  function toggleAll() {
    if (eligible.every((e) => selected.has(e.sku))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(eligible.map((e) => e.sku)));
    }
  }

  async function submit() {
    const skus = Array.from(selected);
    if (skus.length === 0) {
      toast.error("No items selected.");
      return;
    }
    setSubmitting(true);
    setConfirmOpen(false);
    try {
      const endpoint =
        mode === "activate"
          ? `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps/bulk-activate`
          : `/api/google-iap-management/apps/${encodeURIComponent(packageName)}/iaps/bulk-deactivate`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skus }),
      });
      const data = (await res.json()) as
        | BulkStatusResponse
        | { error: string };
      if (!res.ok) {
        toast.error(
          "error" in data ? data.error : `Request failed (${res.status})`,
        );
        return;
      }
      if ("overall" in data) {
        setResults(data.results);
        setOverall(data.overall);
        setSummaryText(data.summary);
        const verb = mode === "activate" ? "Bulk Activate" : "Bulk Deactivate";
        if (data.overall === "SUCCESS") {
          toast.success(`${verb} · ${data.summary}`);
        } else if (data.overall === "PARTIAL") {
          toast.warning(`${verb} · ${data.summary}`);
        } else if (data.overall === "FAILURE") {
          toast.error(`${verb} failed · ${data.summary}`);
        } else {
          toast.message(data.summary);
        }
        if (onComplete) onComplete();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  function onPrimaryClick() {
    if (destructive) setConfirmOpen(true);
    else void submit();
  }

  const allSelected =
    eligible.length > 0 && eligible.every((e) => selected.has(e.sku));
  const someSelected = selected.size > 0 && !allSelected;

  const title = mode === "activate" ? "Bulk Activate items" : "Bulk Deactivate items";
  const subtitle =
    mode === "activate"
      ? "Mark selected items as available for purchase on Google Play."
      : "Stop selected items from being purchased on Google Play. Existing entitlements stay intact.";
  const filterCopy =
    mode === "activate"
      ? `Showing ${eligible.length} ${plural(eligible.length, "item", "items")} currently inactive. Items already active are filtered out.`
      : `Showing ${eligible.length} ${plural(eligible.length, "item", "items")} currently active. Items already inactive are filtered out.`;
  const emptyTitle =
    mode === "activate"
      ? "All items are already active."
      : "All items are already inactive.";
  const emptySub =
    mode === "activate"
      ? "Nothing to activate — every IAP in this app is already on sale on Google Play."
      : "Nothing to deactivate — every IAP in this app is already off sale.";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={handleClose}
    >
      <div
        className={`w-full max-w-[580px] max-h-[80vh] flex flex-col rounded-xl bg-white border border-slate-200 shadow-xl ${
          destructive ? "border-t-4 border-t-red-500" : ""
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className={`flex items-start justify-between px-5 py-4 border-b border-slate-100 ${
            destructive ? "bg-red-50/40" : ""
          }`}
        >
          <div>
            <h2
              className={`text-base font-semibold ${destructive ? "text-red-900" : "text-slate-900"}`}
            >
              {results ? `${title.replace(" items", "")} complete` : title}
            </h2>
            {!results && (
              <p
                className={`text-xs mt-0.5 ${destructive ? "text-red-700" : "text-slate-500"}`}
              >
                {subtitle}
              </p>
            )}
            {results && summaryText && overall && (
              <div className="mt-2">
                <span className={summaryChipClass(overall)}>
                  {summaryChipPrefix(overall)} {summaryText}
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="text-slate-400 hover:text-slate-600 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {submitting ? (
            <ExecutingState destructive={destructive} count={selected.size} />
          ) : results ? (
            <ResultList results={results} />
          ) : eligible.length === 0 ? (
            <EmptyState
              destructive={destructive}
              title={emptyTitle}
              subtitle={emptySub}
            />
          ) : (
            <SelectionState
              destructive={destructive}
              filterCopy={filterCopy}
              eligible={eligible}
              selected={selected}
              allSelected={allSelected}
              someSelected={someSelected}
              onToggleOne={toggleOne}
              onToggleAll={toggleAll}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100 bg-slate-50/70">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition disabled:opacity-50"
          >
            {results ? "Close" : "Cancel"}
          </button>
          {!results && eligible.length > 0 && (
            <button
              type="button"
              onClick={onPrimaryClick}
              disabled={selected.size === 0 || submitting}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed ${
                destructive
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-emerald-600 hover:bg-emerald-700 text-white"
              }`}
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {destructive
                ? `Deactivate (${selected.size} selected)`
                : `OK (${selected.size} selected)`}
            </button>
          )}
        </div>
      </div>

      {/* Confirm dialog — Deactivate only */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="w-full max-w-[440px] rounded-xl bg-white border border-slate-200 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-5 pb-2 flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-600 flex-shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold text-slate-900">
                  Confirm bulk deactivate
                </h3>
                <p className="text-sm text-slate-700 mt-1.5 leading-snug">
                  This will stop sales for the following number of items on
                  Google Play. Continue?
                </p>
                <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-2xl font-bold text-red-700 leading-none">
                    {selected.size}
                  </p>
                  <p className="text-xs text-slate-600 mt-1">
                    {plural(selected.size, "item", "items")} will become{" "}
                    <strong>inactive</strong>. Existing customer entitlements
                    stay intact; only new purchases stop.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100 bg-slate-50/70 mt-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                className="px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function SelectionState({
  destructive,
  filterCopy,
  eligible,
  selected,
  allSelected,
  someSelected,
  onToggleOne,
  onToggleAll,
}: {
  destructive: boolean;
  filterCopy: string;
  eligible: IapWithDefaultLocale[];
  selected: Set<string>;
  allSelected: boolean;
  someSelected: boolean;
  onToggleOne: (sku: string) => void;
  onToggleAll: () => void;
}) {
  return (
    <>
      <p
        className={`text-xs px-3 py-2 rounded-md mb-3 ${
          destructive ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-600"
        }`}
      >
        {filterCopy}
      </p>

      <div className="flex items-center justify-between pb-2 border-b border-slate-200 mb-2">
        <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected;
            }}
            onChange={onToggleAll}
            className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
            aria-label="Select all"
          />
          Select all ({eligible.length})
        </label>
        <span className="text-[11px] text-slate-400">{selected.size} selected</span>
      </div>

      <ul className="divide-y divide-slate-100">
        {eligible.map((iap) => {
          const checked = selected.has(iap.sku);
          return (
            <li
              key={iap.sku}
              className="flex items-center gap-3 py-2 text-sm"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggleOne(iap.sku)}
                className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer flex-shrink-0"
                aria-label={`Select ${iap.sku}`}
              />
              <div className="min-w-0 flex-1">
                <p className="text-slate-800 font-medium truncate">
                  {iap.default_title ?? (
                    <span className="text-slate-400 italic">— no title —</span>
                  )}
                </p>
                <p className="font-mono text-[11px] text-slate-500 truncate">
                  {iap.sku}
                </p>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 text-[11px] font-medium flex-shrink-0 ${
                  destructive ? "text-emerald-700" : "text-slate-500"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${destructive ? "bg-emerald-500" : "bg-slate-400"}`}
                />
                {destructive ? "active" : "inactive"}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ExecutingState({
  destructive,
  count,
}: {
  destructive: boolean;
  count: number;
}) {
  const verb = destructive ? "Deactivating" : "Activating";
  return (
    <div className="py-6 text-center">
      <div
        className={`inline-flex h-12 w-12 items-center justify-center rounded-full mb-3 ${
          destructive ? "bg-red-50" : "bg-emerald-50"
        }`}
      >
        <Loader2
          className={`h-6 w-6 animate-spin ${destructive ? "text-red-600" : "text-emerald-600"}`}
        />
      </div>
      <p className="text-sm font-medium text-slate-800">
        {verb} {count} {plural(count, "item", "items")} on Google Play …
      </p>
      <p className="text-[11px] text-slate-500 mt-1">
        batchUpdateStates · sequential ≤100-item chunks
      </p>
    </div>
  );
}

function ResultList({ results }: { results: RowResult[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {results.map((r) => (
        <li
          key={r.sku}
          className="grid grid-cols-[24px_1fr_auto] gap-3 items-center py-2 text-xs"
        >
          <span
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
              r.ok ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
            }`}
          >
            {r.ok ? "✓" : "!"}
          </span>
          <span className="font-mono text-slate-600 truncate">{r.sku}</span>
          <span
            className={`text-[11px] truncate max-w-[260px] text-right ${
              r.ok ? "text-emerald-700" : "text-red-700"
            }`}
            title={r.error ?? undefined}
          >
            {r.ok ? "Updated on Google Play" : (r.error ?? "Failed")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  destructive,
  title,
  subtitle,
}: {
  destructive: boolean;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="py-8 text-center">
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 mb-3 text-slate-500">
        {destructive ? (
          <MinusCircle className="h-6 w-6" />
        ) : (
          <CheckCircle2 className="h-6 w-6" />
        )}
      </div>
      <p className="font-medium text-slate-700">{title}</p>
      <p className="text-[11px] text-slate-500 mt-1 max-w-sm mx-auto">{subtitle}</p>
    </div>
  );
}

function summaryChipClass(overall: BulkStatusResponse["overall"]): string {
  const base =
    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium";
  if (overall === "SUCCESS") return `${base} bg-emerald-100 text-emerald-800`;
  if (overall === "PARTIAL") return `${base} bg-amber-100 text-amber-800`;
  if (overall === "FAILURE") return `${base} bg-red-100 text-red-800`;
  return `${base} bg-slate-100 text-slate-700`;
}

function summaryChipPrefix(overall: BulkStatusResponse["overall"]): string {
  if (overall === "SUCCESS") return "✓";
  if (overall === "PARTIAL") return "⚠";
  if (overall === "FAILURE") return "✕";
  return "·";
}

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}
