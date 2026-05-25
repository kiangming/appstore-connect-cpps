"use client";

/**
 * Cycle 39 Phase 2 Unit C — Bulk Availabilities modal.
 *
 * Hotfix 25 — Strategy A → D pivot: the modal no longer relies on a
 * Server-Component-prefetched availability Map. On open, it fetches
 * each visible IAP's Apple availability through the per-IAP API route
 * (Hotfix 25 Step 2) via the shared client-fetch-queue (concurrency 3)
 * so the bulk path inherits the same rate-limit protection as the row
 * cells. Manager workflow tolerates the explicit wait — opening this
 * modal is an explicit bulk action, not a passive page render.
 *
 * Two modes, one component (mode-aware filter + footer):
 *   • "set-all"  → list only items currently Removed from Sales.
 *   • "remove"   → list only items currently Available; confirm popup
 *                  before submit (destructive Q5.C).
 *
 * Submit posts to /api/iap-management/iaps/bulk-availability and renders
 * the per-row progress view (mockup State 6). Q-K fail-soft preserved.
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Globe, MinusCircle, Loader2, X, AlertTriangle } from "lucide-react";
import type { AvailabilityForIap } from "@/lib/iap-management/apple/availabilities";
import { classifyAvailability } from "@/lib/iap-management/apple/availability-classify";
import {
  acquireSlot,
  releaseSlot,
} from "@/lib/iap-management/client-fetch-queue";
import type { InAppPurchase } from "@/types/iap-management/apple";

export type BulkMode = "set-all" | "remove";

export interface AvailabilitiesBulkModalProps {
  open: boolean;
  mode: BulkMode;
  /** Full filtered IAP list visible in the table (post search/type/state filters). */
  iaps: InAppPurchase[];
  /** Apple-IAP-id → internal-UUID map. Internal UUIDs are what the API expects. */
  appleToInternal: Record<string, string>;
  onClose: () => void;
  /** Called after a successful bulk action so the parent can refresh the list. */
  onComplete?: () => void;
}

interface RowResult {
  iapId: string;
  apple_iap_id?: string;
  ok: boolean;
  error?: string;
}

/** Cycle 40 Phase A — batch-level 429 telemetry surfaced from the
 *  orchestrator response. Shape mirrors the Hotfix 26 Bulk Import wizard
 *  so the amber chip renders consistently cross-flow. */
interface RateLimitTotal {
  rate429_count: number;
  retry_attempts: number;
  backoff_total_ms: number;
  longest_backoff_ms: number;
  rows_throttled: number;
}

interface ApiAvailabilityResponse {
  state: AvailabilityForIap | null;
  error?: "rate_limited" | "fetch_failed" | "iap_not_found" | "not_synced";
}

export function AvailabilitiesBulkModal({
  open,
  mode,
  iaps,
  appleToInternal,
  onClose,
  onComplete,
}: AvailabilitiesBulkModalProps) {
  const [states, setStates] = useState<Map<string, AvailabilityForIap | null>>(
    new Map(),
  );
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState({ done: 0, total: 0 });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<RowResult[] | null>(null);
  const [rateLimitTotal, setRateLimitTotal] = useState<RateLimitTotal | null>(
    null,
  );

  // Hotfix 25 — Fetch availability for every visible (filtered) IAP that
  // has a local UUID, on modal open. Bounded by the shared queue.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const targets = iaps
      .map((i) => ({ appleId: i.id, internalId: appleToInternal[i.id] }))
      .filter((r): r is { appleId: string; internalId: string } =>
        Boolean(r.internalId),
      );

    setStates(new Map());
    setErrors(new Map());
    setFetching(true);
    setFetchProgress({ done: 0, total: targets.length });

    (async () => {
      const nextStates = new Map<string, AvailabilityForIap | null>();
      const nextErrors = new Map<string, string>();
      await Promise.all(
        targets.map(async ({ appleId, internalId }) => {
          await acquireSlot();
          if (cancelled) {
            releaseSlot();
            return;
          }
          try {
            const res = await fetch(
              `/api/iap-management/iaps/${internalId}/availability`,
              { cache: "no-store" },
            );
            const data = (await res.json()) as ApiAvailabilityResponse;
            if (cancelled) return;
            if (data.error === "rate_limited") {
              nextErrors.set(appleId, "rate_limited");
            } else if (data.error) {
              nextErrors.set(appleId, data.error);
            } else {
              nextStates.set(appleId, data.state ?? null);
            }
          } catch (err) {
            if (!cancelled) {
              nextErrors.set(
                appleId,
                err instanceof Error ? err.message : String(err),
              );
            }
          } finally {
            releaseSlot();
            if (!cancelled) {
              setFetchProgress((p) => ({ ...p, done: p.done + 1 }));
            }
          }
        }),
      );
      if (!cancelled) {
        setStates(nextStates);
        setErrors(nextErrors);
        setFetching(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, iaps, appleToInternal]);

  const eligible = useMemo(
    () => filterEligible(iaps, states, errors, mode, appleToInternal),
    [iaps, states, errors, mode, appleToInternal],
  );

  if (!open) return null;

  // Reset state when the modal closes via parent.
  function handleClose() {
    setSelected(new Set());
    setConfirmOpen(false);
    setResults(null);
    setRateLimitTotal(null);
    onClose();
  }

  function toggleOne(appleIapId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(appleIapId)) next.delete(appleIapId);
      else next.add(appleIapId);
      return next;
    });
  }

  function toggleAll() {
    if (eligible.every((e) => selected.has(e.appleIapId))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(eligible.map((e) => e.appleIapId)));
    }
  }

  async function submit() {
    const internalIds: string[] = [];
    for (const appleId of selected) {
      const internal = appleToInternal[appleId];
      if (internal) internalIds.push(internal);
    }
    if (internalIds.length === 0) {
      toast.error(
        "No selected items resolve to a local IAP row — try Refresh from Apple.",
      );
      return;
    }
    setSubmitting(true);
    setConfirmOpen(false);
    try {
      const res = await fetch("/api/iap-management/iaps/bulk-availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ iapIds: internalIds, action: mode }),
      });
      const data = (await res.json()) as
        | {
            overall: "SUCCESS" | "PARTIAL" | "FAILURE" | "NO_OP";
            succeeded: number;
            failed: number;
            summary: string;
            results: RowResult[];
            /** Cycle 40 Phase A — batch-level 429 telemetry. Absent on
             *  responses from older deploys; treat missing as "no
             *  throttling occurred" so the chip simply doesn't render. */
            rate_limit_total?: RateLimitTotal;
          }
        | { error: string };
      if (!res.ok) {
        toast.error(
          "error" in data ? data.error : `Bulk action failed (${res.status})`,
        );
        return;
      }
      if ("overall" in data) {
        setResults(data.results);
        setRateLimitTotal(data.rate_limit_total ?? null);
        const verb =
          mode === "set-all" ? "Set Availabilities" : "Remove from Sales";
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
    if (mode === "remove") {
      setConfirmOpen(true);
    } else {
      void submit();
    }
  }

  const allSelected =
    eligible.length > 0 && eligible.every((e) => selected.has(e.appleIapId));
  const someSelected = selected.size > 0 && !allSelected;
  const destructive = mode === "remove";

  const title =
    mode === "set-all" ? "Set Availabilities for items" : "Remove from Sales";
  const subtitle =
    mode === "set-all"
      ? "Mark selected items as available in all Apple territories."
      : "Mark selected items as unavailable in all territories.";
  const filterCount = eligible.length;
  const filterCopy =
    mode === "set-all"
      ? `Showing ${filterCount} ${plural(filterCount, "item", "items")} currently in Remove from Sales. Items already Available are filtered out.`
      : `Showing ${filterCount} ${plural(filterCount, "item", "items")} currently Available. Items already Removed from Sales are filtered out.`;
  const emptyTitle =
    mode === "set-all"
      ? "All items are currently Available."
      : "All items are currently Removed from Sales.";
  const emptySub =
    mode === "set-all"
      ? "Nothing to enable — every IAP in this app already sells in all territories."
      : "Nothing to remove — every IAP in this app is already unavailable.";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60"
      role="dialog"
      aria-modal="true"
      onClick={handleClose}
    >
      <div
        className={`w-[560px] max-h-[80vh] flex flex-col rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl ${
          destructive ? "border-t-4 border-t-red-500" : ""
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className={`flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800 ${
            destructive ? "bg-red-50/50 dark:bg-red-950/20" : ""
          }`}
        >
          <div>
            <h2
              className={`text-base font-semibold ${
                destructive
                  ? "text-red-900 dark:text-red-100"
                  : "text-slate-900 dark:text-slate-100"
              }`}
            >
              {title}
            </h2>
            <p
              className={`text-xs mt-0.5 ${
                destructive
                  ? "text-red-700 dark:text-red-300"
                  : "text-slate-500 dark:text-slate-400"
              }`}
            >
              {subtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {fetching ? (
            <FetchingState progress={fetchProgress} destructive={destructive} />
          ) : results ? (
            <>
              {/* Cycle 40 Phase A — amber rate-limit chip mirrors the
                  Hotfix 26 Bulk Import wizard surface. Renders only when
                  Apple actually throttled this run; clean runs stay
                  quiet. */}
              {rateLimitTotal && rateLimitTotal.rate429_count > 0 && (
                <div className="mb-3 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                  <p className="font-medium">
                    Apple ASC throttled this batch — every row that hit a 429
                    recovered via exponential backoff.
                  </p>
                  <p className="text-[11px] mt-0.5 text-amber-700 dark:text-amber-300/80">
                    {rateLimitTotal.rows_throttled} of {results.length} rows
                    hit 429 · {rateLimitTotal.rate429_count} retries total
                    ·{" "}
                    {Math.round(rateLimitTotal.backoff_total_ms / 1000)}s
                    cumulative backoff · longest{" "}
                    {Math.round(rateLimitTotal.longest_backoff_ms / 1000)}s.
                  </p>
                </div>
              )}
              <ProgressList results={results} />
            </>
          ) : eligible.length === 0 ? (
            <EmptyState
              destructive={destructive}
              title={emptyTitle}
              subtitle={emptySub}
            />
          ) : (
            <>
              <p
                className={`text-xs px-3 py-2 rounded-md mb-3 ${
                  destructive
                    ? "bg-red-50 text-red-700 dark:bg-red-950/20 dark:text-red-300"
                    : "bg-slate-50 text-slate-600 dark:bg-slate-800/40 dark:text-slate-400"
                }`}
              >
                {filterCopy}
              </p>

              <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800 mb-2">
                <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
                    aria-label="Select all"
                  />
                  Select all ({eligible.length})
                </label>
                <span className="text-[11px] text-slate-400 dark:text-slate-500">
                  {selected.size} selected
                </span>
              </div>

              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {eligible.map((row) => {
                  const checked = selected.has(row.appleIapId);
                  return (
                    <li
                      key={row.appleIapId}
                      className="flex items-center gap-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOne(row.appleIapId)}
                        className="h-3.5 w-3.5 rounded border-slate-300 cursor-pointer"
                        aria-label={`Select ${row.productId}`}
                      />
                      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate w-44">
                        {row.productId}
                      </span>
                      <span className="text-slate-800 dark:text-slate-200 flex-1 truncate">
                        {row.name}
                      </span>
                      {destructive ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                          <Globe className="h-3 w-3" /> Available
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400">
                          <MinusCircle className="h-3 w-3" /> Removed
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition disabled:opacity-50"
          >
            {results ? "Close" : "Cancel"}
          </button>
          {!results && (
            <button
              type="button"
              onClick={onPrimaryClick}
              disabled={
                selected.size === 0 ||
                submitting ||
                fetching ||
                eligible.length === 0
              }
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed ${
                destructive
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-[#0071E3] hover:bg-[#0077ED] text-white"
              }`}
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {destructive
                ? `Remove (${selected.size} selected)`
                : `OK (${selected.size} selected)`}
            </button>
          )}
        </div>
      </div>

      {/* Confirm popup — destructive Q5.C, layered above the selection modal. */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
          role="dialog"
          aria-modal="true"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="w-[440px] rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-5 pb-2 flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-300">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Confirm Remove from Sales
                </h3>
                <p className="text-sm text-slate-700 dark:text-slate-200 mt-1.5 leading-snug">
                  This action will perform the remove from sales for items,
                  do you confirm?
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-2">
                  <strong>{selected.size}</strong>{" "}
                  {plural(selected.size, "item", "items")} will become
                  unavailable in every Apple territory. Customers will be
                  unable to purchase them until you re-enable availability.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/40 mt-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg transition"
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

// ─── Filter + classify ──────────────────────────────────────────────────────

interface EligibleRow {
  appleIapId: string;
  productId: string;
  name: string;
}

/** Pure helper exported for unit tests — given the table's filtered IAP
 *  list + the fetched Apple state Map, produce the subset eligible for
 *  the requested bulk action. Rows whose Apple fetch errored are
 *  excluded from BOTH modes so Manager doesn't act on stale state. */
export function filterEligible(
  iaps: InAppPurchase[],
  states: Map<string, AvailabilityForIap | null>,
  errors: Map<string, string>,
  mode: BulkMode,
  appleToInternal: Record<string, string>,
): EligibleRow[] {
  const out: EligibleRow[] = [];
  for (const iap of iaps) {
    if (!appleToInternal[iap.id]) continue;
    if (errors.has(iap.id)) continue;
    // A successfully-fetched row that's missing from `states` is impossible
    // (the modal effect populates both Maps atomically), but defensively
    // exclude it the same way as an error so filter semantics are robust
    // under partial mid-fetch states.
    if (!states.has(iap.id)) continue;
    const bucket = classifyAvailability(states.get(iap.id) ?? null, false);
    if (mode === "set-all" && bucket !== "removed") continue;
    if (mode === "remove" && bucket !== "available") continue;
    out.push({
      appleIapId: iap.id,
      productId: iap.attributes.productId,
      name: iap.attributes.name,
    });
  }
  return out;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function FetchingState({
  progress,
  destructive,
}: {
  progress: { done: number; total: number };
  destructive: boolean;
}) {
  const pct = progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : 0;
  return (
    <div className="py-6">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Fetching Apple availability for {progress.total}{" "}
        {plural(progress.total, "item", "items")}…
      </p>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
        {progress.done}/{progress.total} ({pct}%) · concurrency 3 — keeps
        Apple ASC well under the 250 req/hour cap.
      </p>
      <div className="mt-3 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div
          className={`h-full transition-[width] duration-200 ${
            destructive ? "bg-red-500" : "bg-[#0071E3]"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
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
      <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 mb-3 text-slate-500 dark:text-slate-400">
        {destructive ? (
          <MinusCircle className="h-6 w-6" />
        ) : (
          <Globe className="h-6 w-6" />
        )}
      </div>
      <p className="font-medium text-slate-700 dark:text-slate-200">{title}</p>
      <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1 max-w-sm mx-auto">
        {subtitle}
      </p>
    </div>
  );
}

function ProgressList({ results }: { results: RowResult[] }) {
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {results.map((r) => (
        <li
          key={r.iapId}
          className="flex items-center gap-3 py-2 text-xs"
        >
          <span
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
              r.ok
                ? "bg-emerald-100 text-emerald-700"
                : "bg-red-100 text-red-700"
            }`}
          >
            {r.ok ? "✓" : "!"}
          </span>
          <span className="font-mono text-slate-500 truncate flex-1">
            {r.apple_iap_id ?? r.iapId}
          </span>
          <span
            className={`text-[11px] truncate max-w-[220px] ${
              r.ok
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-red-700 dark:text-red-400"
            }`}
          >
            {r.ok ? "Updated on Apple" : (r.error ?? "Failed")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}
