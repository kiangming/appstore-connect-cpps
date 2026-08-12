"use client";

/**
 * Custom-prices block inside the form's Pricing section.
 *
 * Design §F: custom must NEVER be opaque. The count is always accompanied by
 * actual values (first four inline, the rest one click away), and the dialog
 * re-opens pre-filled with the real set — not a fresh baseline.
 *
 * Also carries the stale banner (§D), so staleness is visible in all three
 * places the design requires: here, on the dialog's rows, and in the count
 * badge. Submit blocking is SC3; this renders the state and the two one-click
 * resolutions.
 */
import { AlertTriangle } from "lucide-react";
import {
  describeBaselineDrift,
  isCustomBaselineStale,
  type CustomPriceBaseline,
  type CustomPriceEntry,
} from "@/lib/iap-management/custom-prices/model";
import {
  NO_DONOR_REASON,
  NO_TIER_REASON,
} from "@/lib/iap-management/custom-prices/baseline";

const INLINE_PREVIEW_COUNT = 4;

export interface CustomPricesSummaryProps {
  entries: readonly CustomPriceEntry[];
  /** Fingerprint of the CURRENT form values. */
  currentBaseline: CustomPriceBaseline | null;
  /** Fingerprint the stored set was built against. */
  storedBaseline: CustomPriceBaseline | null;
  /** False ⇒ no synced IAP in this app to read Apple's catalog through (J-1). */
  donorAvailable: boolean;
  /** False on the New form — there is no persisted draft to attach customs to. */
  persistedDraft: boolean;
  onOpen: () => void;
  onClearAll: () => void;
  onKeepReviewed: () => void;
}

export function CustomPricesSummary({
  entries,
  currentBaseline,
  storedBaseline,
  donorAvailable,
  persistedDraft,
  onOpen,
  onClearAll,
  onKeepReviewed,
}: CustomPricesSummaryProps) {
  const count = entries.length;
  const stale = count > 0 && isCustomBaselineStale(currentBaseline, storedBaseline);
  const drift = describeBaselineDrift(currentBaseline, storedBaseline);

  // Rule CP-3 — the server silently drops a set with no tier
  // (`skipped-no-tier`), so the client must state the requirement instead of
  // letting the Manager build a set that quietly evaporates.
  const disabledReason = !currentBaseline?.tier_id
    ? NO_TIER_REASON
    : !persistedDraft
      ? "Save as draft first — custom prices are stored against the saved IAP."
      : !donorAvailable
        ? NO_DONOR_REASON
        : null;

  return (
    <div className="mt-4 space-y-3">
      {stale && (
        <div
          data-testid="custom-prices-form-stale-banner"
          className="rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-900/20 p-3"
        >
          <div className="flex gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                {count} custom price{count === 1 ? "" : "s"} {count === 1 ? "was" : "were"} set
                against a different base
              </p>
              <p className="text-[11px] text-amber-800 dark:text-amber-300/90 mt-1">
                {drift.length > 0 ? `Changed: ${drift.join(" · ")}. ` : ""}
                Nothing has been deleted — review them before pushing to Apple.
              </p>
              <div className="flex flex-wrap gap-2 mt-2.5">
                <button
                  type="button"
                  onClick={onKeepReviewed}
                  className="px-3 py-1.5 rounded-md bg-white border border-amber-400 text-amber-900 text-[11px] font-medium"
                >
                  Keep them (reviewed)
                </button>
                <button
                  type="button"
                  onClick={onClearAll}
                  className="px-3 py-1.5 rounded-md bg-white border border-red-300 text-red-700 text-[11px] font-medium"
                >
                  Clear all custom prices
                </button>
                <button
                  type="button"
                  onClick={onOpen}
                  className="px-3 py-1.5 rounded-md text-amber-800 text-[11px] font-medium hover:bg-amber-100"
                >
                  Review in dialog →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        className={`rounded-lg border p-3 ${
          count > 0
            ? "border-amber-300 bg-amber-50/60 dark:bg-amber-900/10"
            : "border-slate-200 dark:border-slate-700"
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Custom territory prices
              </p>
              {count > 0 && (
                <span
                  data-testid="custom-prices-count-badge"
                  className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                    stale
                      ? "bg-amber-300 text-amber-950"
                      : "bg-amber-200 text-amber-900"
                  }`}
                >
                  {count} custom{stale ? " · stale" : ""}
                </span>
              )}
            </div>

            {count === 0 ? (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                No custom prices — Apple&apos;s template/auto pricing applies to every
                territory.
              </p>
            ) : (
              <>
                <p className="text-[11px] text-slate-600 dark:text-slate-300 mt-1">
                  {count} territor{count === 1 ? "y carries" : "ies carry"} a custom price,
                  overriding the template for those territories.
                </p>
                {/* §F — never a bare count. */}
                <p
                  data-testid="custom-prices-inline-values"
                  className="text-[11px] text-slate-800 dark:text-slate-200 mt-1 leading-relaxed"
                >
                  {entries.slice(0, INLINE_PREVIEW_COUNT).map((e, i) => (
                    <span key={e.territory_code}>
                      {i > 0 && " · "}
                      <span className="font-mono">
                        {e.territory_code} {e.customer_price} {e.currency_code}
                      </span>
                    </span>
                  ))}
                  {count > INLINE_PREVIEW_COUNT && (
                    <span className="text-slate-500">
                      {" "}
                      + {count - INLINE_PREVIEW_COUNT} more
                    </span>
                  )}
                </p>
              </>
            )}

            {disabledReason && (
              <p
                data-testid="custom-prices-disabled-reason"
                className="text-[11px] text-amber-800 dark:text-amber-300 mt-1.5"
              >
                {disabledReason}
              </p>
            )}
          </div>

          <div className="flex-shrink-0 flex flex-col gap-1.5 items-end">
            <button
              type="button"
              onClick={onOpen}
              disabled={disabledReason !== null}
              title={disabledReason ?? undefined}
              className="px-3 py-1.5 rounded-md bg-[#0071E3] text-white text-[11px] font-medium whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {count > 0 ? "Edit custom prices" : "Set custom prices"}
            </button>
            {count > 0 && (
              // §C revertibility exit #2 — reachable without opening the dialog.
              <button
                type="button"
                onClick={onClearAll}
                className="px-2 py-1 rounded text-[11px] text-red-600 hover:bg-red-50 whitespace-nowrap"
              >
                Clear all custom prices
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
