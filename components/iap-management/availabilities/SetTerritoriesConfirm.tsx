"use client";

/**
 * The Set-Territories confirm gate (design §C).
 *
 * Destructive, so it asks BEFORE — never a toast afterwards. Apple exposes no
 * PATCH on the availability resource (KB §4.12), so every push is a full
 * REPLACE: territories absent from the selection are removed. The verb is
 * stated unhedged for that reason.
 *
 * ⚠ ALL THREE BUCKETS ARE SHOWN, and the third is the honest one.
 * `filterEligible` already drops items whose Apple read errored
 * (AvailabilitiesBulkModal.tsx:734, shipped behaviour) — they will NOT be
 * written. Folding them into "already matches", or reporting them as a bare
 * count, is how a Manager comes to believe 50 items were updated when 48 were.
 * They are named individually.
 *
 * ⚠ The buckets are computed by `buildConfirmBuckets` (which uses
 * `diffSelection`), never here. A local comparison would call "all ticked by
 * hand" equal to "all territories" — identical ids, different flag, different
 * request (KB §4.13) — and hide a real write behind "nothing to do".
 */

import { AlertTriangle, X } from "lucide-react";
import type {
  BaseAdvisoryGroup,
  ConfirmBuckets,
} from "@/lib/iap-management/apple/bulk-availability-view";
import { classifySelection } from "@/lib/iap-management/apple/territory-selection";
import type { TerritorySelection } from "@/lib/iap-management/apple/territory-selection";

export interface SetTerritoriesConfirmProps {
  buckets: ConfirmBuckets;
  selection: TerritorySelection;
  /** Apple's catalogue, for the ALL vs ALL_FROZEN wording. */
  allTerritoryIds: readonly string[];
  /** Items whose own base territory sits outside the selection, per base. */
  advisory: readonly BaseAdvisoryGroup[];
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function SetTerritoriesConfirm({
  buckets,
  selection,
  allTerritoryIds,
  advisory,
  submitting,
  onCancel,
  onConfirm,
}: SetTerritoriesConfirmProps) {
  const changeCount = buckets.willChange.length;
  const kind = classifySelection(selection, allTerritoryIds);
  const n = selection.territoryIds.length;

  /** ⚠ ALL and ALL_FROZEN must not read alike — they send different bodies. */
  const scopeLine =
    kind === "ALL"
      ? `all ${n} countries or regions, plus any new market Apple launches later`
      : kind === "ALL_FROZEN"
        ? `all ${n} countries or regions — new Apple markets will NOT be added automatically`
        : kind === "NONE"
          ? "no countries or regions (removed from sale)"
          : `${n} of ${allTerritoryIds.length} countries or regions`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm availability replacement"
    >
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-4">
          <div>
            <h3
              data-testid="confirm-headline"
              className="text-base font-semibold text-red-900 dark:text-red-300"
            >
              Replace availability on {changeCount} item
              {changeCount === 1 ? "" : "s"}?
            </h3>
            <p className="text-[11px] text-slate-600 dark:text-slate-300 mt-1">
              Each item&apos;s availability will be{" "}
              <strong>replaced</strong> with {scopeLine}. Territories not in
              your selection will be removed.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-600 flex-shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Bucket 1 — the complete list, scrollable, never "and 40 more". */}
          <section data-testid="confirm-will-change">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
              Will change ({changeCount})
            </h4>
            <ul className="space-y-1">
              {buckets.willChange.map((c) => (
                <li
                  key={c.appleIapId}
                  data-testid={`confirm-change-${c.appleIapId}`}
                  className="text-[11px] text-slate-700 dark:text-slate-200 flex items-baseline gap-2"
                >
                  <span className="font-medium">{c.name}</span>
                  <span className="font-mono text-slate-400">{c.productId}</span>
                  <span className="ml-auto tabular-nums text-slate-500">
                    {c.previousCount} → {c.nextCount}
                    {(c.added > 0 || c.removed > 0) && (
                      <span className="ml-1.5">
                        {c.added > 0 && (
                          <span className="text-emerald-700">+{c.added}</span>
                        )}
                        {c.added > 0 && c.removed > 0 && " / "}
                        {c.removed > 0 && (
                          <span className="text-red-700">−{c.removed}</span>
                        )}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {/* Bucket 2 — a count is enough: no call will be made for these. */}
          {buckets.alreadyMatches.length > 0 && (
            <p
              data-testid="confirm-already-matches"
              className="text-[11px] text-slate-500 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 px-3 py-2"
            >
              {buckets.alreadyMatches.length} item
              {buckets.alreadyMatches.length === 1 ? "" : "s"} already
              {buckets.alreadyMatches.length === 1 ? " has" : " have"} exactly
              this set — no call will be made for{" "}
              {buckets.alreadyMatches.length === 1 ? "it" : "them"}.
            </p>
          )}

          {/* Bucket 3 — ⚠ named, never counted, never folded in. */}
          {buckets.unknownExcluded.length > 0 && (
            <section
              data-testid="confirm-unknown-excluded"
              className="rounded-lg border-2 border-amber-300 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5"
            >
              <h4 className="text-xs font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                {buckets.unknownExcluded.length} item
                {buckets.unknownExcluded.length === 1 ? "" : "s"} left out —
                current availability could not be read
              </h4>
              <p className="text-[11px] text-amber-800 dark:text-amber-300/90 mt-1">
                These will NOT be changed. Because their state on Apple is
                unknown, the tool cannot tell whether writing would be a change,
                so it does not write them at all.
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {buckets.unknownExcluded.map((i) => (
                  <li
                    key={i.appleIapId}
                    data-testid={`confirm-unknown-${i.appleIapId}`}
                    className="text-[11px] text-amber-900 dark:text-amber-200 flex items-baseline gap-2"
                  >
                    <span className="font-medium">{i.name}</span>
                    <span className="font-mono text-amber-700/70">
                      {i.productId}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* §G6 advisory — a configuration fact, grouped by each item's own
              base. Non-blocking, and deliberately silent on consequences. */}
          {advisory.length > 0 && (
            <section
              data-testid="confirm-base-advisory"
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 px-3 py-2.5"
            >
              <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                {advisory.reduce((n2, g) => n2 + g.items.length, 0)} item
                {advisory.reduce((n2, g) => n2 + g.items.length, 0) === 1
                  ? ""
                  : "s"}{" "}
                price from a territory this selection excludes
              </h4>
              <p className="text-[11px] text-slate-600 dark:text-slate-300 mt-1">
                This action changes availability only — it does not touch
                prices. Noting it so you can review those items&apos; price
                schedules separately if you want to.
              </p>
              <ul className="mt-1.5 space-y-1">
                {advisory.map((g) => (
                  <li key={g.baseTerritory} className="text-[11px]">
                    <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                      {g.baseTerritory}
                    </span>
                    <span className="text-slate-500">
                      {" "}
                      — {g.items.map((i) => i.name).join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* What the warning can and cannot promise (§C). */}
          <p className="text-[11px] text-slate-400">
            Based on each item&apos;s availability as read a moment ago. If
            someone changed it on App Store Connect since, this list may be out
            of date.
          </p>
        </div>

        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            autoFocus
            className="px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 text-xs disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            data-testid="confirm-submit"
            className="px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-medium disabled:opacity-50"
          >
            Replace availability on {changeCount} item
            {changeCount === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}
