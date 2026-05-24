"use client";

/**
 * IAP.o.12b — Confirmation modal that previews exactly which fields will be
 * pushed to Apple before the Manager clicks Confirm. Computes the diff
 * client-side via the same `detectIapChanges` the route uses, so the modal
 * is precisely consistent with what the orchestrator will attempt.
 *
 * Visible sections render conditionally based on diff buckets — an empty
 * bucket simply isn't shown. Manager Q-IAP.o.12.A locked the maximum
 * editable scope (attributes + localizations + screenshot + pricing).
 */
import { useMemo } from "react";
import { Loader2, UploadCloud, X } from "lucide-react";
import {
  detectIapChanges,
  isEmptyDiff,
  type CachedIapState,
  type IapDiff,
} from "@/lib/iap-management/apple/diff-detector";
import type { IapFormState } from "@/lib/iap-management/validation";
import type { PriceTierRow } from "@/lib/iap-management/queries/price-tiers";

export interface UpdateChangesPreviewModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  confirmInFlight: boolean;
  form: IapFormState;
  cached: CachedIapState;
  hasNewScreenshotFile: boolean;
  tiers: PriceTierRow[];
}

export function UpdateChangesPreviewModal(props: UpdateChangesPreviewModalProps) {
  const {
    open,
    onClose,
    onConfirm,
    confirmInFlight,
    form,
    cached,
    hasNewScreenshotFile,
    tiers,
  } = props;

  const diff: IapDiff = useMemo(
    () => detectIapChanges({ form, cached, hasNewScreenshotFile }),
    [form, cached, hasNewScreenshotFile],
  );
  const empty = isEmptyDiff(diff);

  const tierName = (id: string | null | undefined): string | null => {
    if (id === null || id === undefined) return null;
    const row = tiers.find((t) => String(t.tier_id) === String(id));
    if (!row) return id;
    const price = row.usd_price !== null ? ` ($${row.usd_price.toFixed(2)})` : "";
    return `${row.tier_name}${price}`;
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-h-[80vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Push changes to Apple?
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-sm text-slate-700 dark:text-slate-200">
          {empty && (
            <p className="text-slate-500 dark:text-slate-400">
              No changes detected. Close this dialog and edit fields first.
            </p>
          )}

          {/* Attributes */}
          {diff.attributes_changed && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                IAP attributes
              </h3>
              <ul className="space-y-1">
                {diff.attributes_changed.name !== undefined && (
                  <li>
                    <span className="text-slate-500">Name:</span>{" "}
                    <span className="font-medium">{diff.attributes_changed.name}</span>
                  </li>
                )}
                {diff.attributes_changed.reviewNote !== undefined && (
                  <li>
                    <span className="text-slate-500">Review note:</span>{" "}
                    <span className="font-medium">
                      {diff.attributes_changed.reviewNote === null
                        ? <em className="text-slate-400">cleared</em>
                        : diff.attributes_changed.reviewNote}
                    </span>
                  </li>
                )}
                {diff.attributes_changed.familySharable !== undefined && (
                  <li>
                    <span className="text-slate-500">Family Sharing:</span>{" "}
                    <span className="font-medium">
                      {diff.attributes_changed.familySharable ? "Enabled" : "Disabled"}
                    </span>
                  </li>
                )}
              </ul>
            </section>
          )}

          {/* Localizations */}
          {diff.localizations_changed && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                Localizations
              </h3>
              <ul className="space-y-1.5">
                {diff.localizations_changed.updated.map((u) => (
                  <li key={`upd-${u.locale}`} className="text-xs">
                    <span className="inline-block px-1.5 py-0.5 mr-1.5 rounded bg-blue-50 text-blue-700 border border-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900">
                      update {u.locale}
                    </span>
                    {u.name !== undefined && <span>name → <span className="font-medium">{u.name}</span></span>}
                    {u.name !== undefined && u.description !== undefined && " · "}
                    {u.description !== undefined && (
                      <span>description → <span className="font-medium">{truncate(u.description, 60)}</span></span>
                    )}
                  </li>
                ))}
                {diff.localizations_changed.added.map((a) => (
                  <li key={`add-${a.locale}`} className="text-xs">
                    <span className="inline-block px-1.5 py-0.5 mr-1.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900">
                      add {a.locale}
                    </span>
                    <span className="font-medium">{a.name}</span>
                  </li>
                ))}
                {diff.localizations_changed.removed.map((r) => (
                  <li key={`rem-${r.locale}`} className="text-xs">
                    <span className="inline-block px-1.5 py-0.5 mr-1.5 rounded bg-red-50 text-red-700 border border-red-100 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900">
                      remove {r.locale}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Screenshot */}
          {diff.screenshot_changed && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                Screenshot
              </h3>
              <p className="text-xs">
                Replace existing review screenshot with{" "}
                <span className="font-medium">{form.screenshot_filename}</span>.
              </p>
            </section>
          )}

          {/* Pricing */}
          {diff.tier_changed && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                Pricing tier
              </h3>
              <p className="text-xs">
                {tierName(diff.tier_changed.old_tier_id) ??
                  <em className="text-slate-400">unset</em>}{" "}
                →{" "}
                <span className="font-medium">
                  {tierName(diff.tier_changed.new_tier_id) ?? diff.tier_changed.new_tier_id}
                </span>
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                Apple price schedule is replace-all per IAP.o.11d — all territories will re-equalize.
              </p>
            </section>
          )}

          {/* Cycle 39 Phase 1 — Availability change. Red-tinted when the
              target is NONE (Remove from Sales) so the destructive choice
              stays visible in the confirmation. */}
          {diff.availability_changed && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                Availability
              </h3>
              <p
                className={
                  diff.availability_changed.new_target === "NONE"
                    ? "text-xs font-medium text-red-700 dark:text-red-300"
                    : "text-xs text-slate-700 dark:text-slate-200"
                }
              >
                {availabilityLabel(diff.availability_changed.old_target)} →{" "}
                <span className="font-semibold">
                  {availabilityLabel(diff.availability_changed.new_target)}
                </span>
              </p>
              {diff.availability_changed.new_target === "NONE" && (
                <p className="text-[11px] text-red-600 dark:text-red-400 mt-1">
                  Customers will be unable to purchase this in-app purchase
                  in any country or region once Apple acknowledges the change.
                </p>
              )}
            </section>
          )}

          {/* IAP.p1.h — pricing source banner. Surfaces when Manager picked a
              template-backed source so they know per-territory overrides
              will be re-applied even if tier didn't change. APPLE source
              with no tier change → nothing to show. */}
          {(form.pricing_source === "DEFAULT_TEMPLATE" ||
            form.pricing_source === "APP_TEMPLATE") && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
                Pricing source
              </h3>
              <p className="text-xs">
                <span className="font-medium">
                  {form.pricing_source === "APP_TEMPLATE"
                    ? "App-specific template"
                    : "Default Template"}
                </span>{" "}
                will be applied — per-territory overrides re-POSTed for the
                current tier.
              </p>
              {!diff.tier_changed && (
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                  Tier unchanged; pricing stage still runs because the source
                  is template-backed.
                </p>
              )}
            </section>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
          <button
            type="button"
            onClick={onClose}
            disabled={confirmInFlight}
            className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={empty || confirmInFlight}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-[#0071E3] hover:bg-[#0077ED] text-white rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {confirmInFlight ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            {confirmInFlight ? "Pushing…" : "Push to Apple"}
          </button>
        </div>
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function availabilityLabel(t: "ALL" | "NONE" | null): string {
  if (t === "ALL") return "Publish — Available in all countries or regions";
  if (t === "NONE") return "Remove from Sales";
  return "Unknown (Apple-side state pre-Cycle-37)";
}
