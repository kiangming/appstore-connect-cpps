"use client";

import { X, AlertCircle, ArrowRight } from "lucide-react";

import type { IapDiff } from "@/lib/google-iap-management/orchestration/iap-diff";
import { microsToDecimal } from "@/lib/google-iap-management/google/price-conversion";

interface Props {
  diff: IapDiff;
  submitting: boolean;
  submitError: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

function tryDecimal(micros: string): string {
  try {
    return microsToDecimal(micros, 2);
  } catch {
    return micros;
  }
}

function ChangePill({ label, tone }: { label: string; tone: "add" | "mod" | "rem" }) {
  const cls =
    tone === "add"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : tone === "mod"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-red-50 text-red-700 border-red-200";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${cls}`}
    >
      {label}
    </span>
  );
}

function BeforeAfter({
  before,
  after,
  mono,
}: {
  before: string;
  after: string;
  mono?: boolean;
}) {
  const cls = mono ? "font-mono" : "";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`px-2 py-0.5 rounded bg-red-50 text-red-700 line-through ${cls}`}>
        {before || <em className="italic">empty</em>}
      </span>
      <ArrowRight className="h-3 w-3 text-slate-400 flex-shrink-0" />
      <span className={`px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 ${cls}`}>
        {after || <em className="italic">empty</em>}
      </span>
    </div>
  );
}

export function UpdateChangesPreviewModal({
  diff,
  submitting,
  submitError,
  onConfirm,
  onCancel,
}: Props) {
  const { attributes, listings, prices, hasChanges } = diff;

  const attrEntries = Object.entries(attributes);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Review changes
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Confirm to push these updates to Google Play.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="text-slate-400 hover:text-slate-600 transition disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {!hasChanges && (
            <p className="text-sm text-slate-500 italic">
              No changes detected. Close this dialog and edit the form.
            </p>
          )}

          {/* Attributes */}
          {attrEntries.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">
                Attributes
              </h3>
              <ul className="space-y-2">
                {attrEntries.map(([key, change]) => {
                  if (!change) return null;
                  const isPriceMicros = key === "basePriceMicros";
                  const label =
                    key === "basePriceMicros"
                      ? "Base price"
                      : key === "baseCurrency"
                        ? "Base currency"
                        : key === "defaultLanguage"
                          ? "Default language"
                          : key === "purchaseType"
                            ? "Purchase type"
                            : key === "status"
                              ? "Status"
                              : key;
                  const before = isPriceMicros
                    ? tryDecimal(change.before)
                    : change.before;
                  const after = isPriceMicros
                    ? tryDecimal(change.after)
                    : change.after;
                  return (
                    <li key={key} className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-slate-700 flex-shrink-0">
                        {label}
                      </span>
                      <BeforeAfter
                        before={before}
                        after={after}
                        mono={isPriceMicros}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* Listings */}
          {(listings.added.length > 0 ||
            listings.removed.length > 0 ||
            listings.modified.length > 0) && (
            <section>
              <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">
                Listings
              </h3>
              <ul className="space-y-2">
                {listings.added.map((l) => (
                  <li
                    key={`add-${l.locale}`}
                    className="flex items-start gap-2 p-2 rounded border border-emerald-200 bg-emerald-50/50"
                  >
                    <ChangePill label="Add" tone="add" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-emerald-800">
                        {l.locale}
                      </p>
                      <p className="text-xs text-slate-700 mt-0.5 truncate">
                        {l.title}
                      </p>
                    </div>
                  </li>
                ))}
                {listings.modified.map((m) => (
                  <li
                    key={`mod-${m.locale}`}
                    className="p-2 rounded border border-amber-200 bg-amber-50/50 space-y-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <ChangePill label="Edit" tone="mod" />
                      <p className="text-xs font-mono text-amber-800">
                        {m.locale}
                      </p>
                    </div>
                    {m.title && (
                      <div className="flex items-start gap-2 ml-1">
                        <span className="text-[10px] uppercase font-medium text-slate-500 w-20 flex-shrink-0 pt-1">
                          Title
                        </span>
                        <BeforeAfter before={m.title.before} after={m.title.after} />
                      </div>
                    )}
                    {m.description && (
                      <div className="flex items-start gap-2 ml-1">
                        <span className="text-[10px] uppercase font-medium text-slate-500 w-20 flex-shrink-0 pt-1">
                          Description
                        </span>
                        <BeforeAfter
                          before={m.description.before}
                          after={m.description.after}
                        />
                      </div>
                    )}
                  </li>
                ))}
                {listings.removed.map((l) => (
                  <li
                    key={`rem-${l.locale}`}
                    className="flex items-start gap-2 p-2 rounded border border-red-200 bg-red-50/50"
                  >
                    <ChangePill label="Remove" tone="rem" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-red-800">{l.locale}</p>
                      <p className="text-xs text-slate-600 mt-0.5 line-through truncate">
                        {l.title}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Prices */}
          {(prices.added.length > 0 ||
            prices.removed.length > 0 ||
            prices.modified.length > 0) && (
            <section>
              <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">
                Region pricing
              </h3>
              <ul className="space-y-2">
                {prices.added.map((p) => (
                  <li
                    key={`add-${p.region}`}
                    className="flex items-center justify-between gap-2 p-2 rounded border border-emerald-200 bg-emerald-50/50"
                  >
                    <div className="flex items-center gap-2">
                      <ChangePill label="Add" tone="add" />
                      <span className="text-xs font-mono text-emerald-800">
                        {p.region}
                      </span>
                    </div>
                    <span className="text-xs font-mono text-emerald-800">
                      {tryDecimal(p.priceMicros)} {p.currency}
                    </span>
                  </li>
                ))}
                {prices.modified.map((m) => (
                  <li
                    key={`mod-${m.region}`}
                    className="p-2 rounded border border-amber-200 bg-amber-50/50 space-y-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <ChangePill label="Edit" tone="mod" />
                      <span className="text-xs font-mono text-amber-800">
                        {m.region}
                      </span>
                    </div>
                    {m.priceMicros && (
                      <div className="flex items-center gap-2 ml-1">
                        <span className="text-[10px] uppercase font-medium text-slate-500 w-16 flex-shrink-0">
                          Price
                        </span>
                        <BeforeAfter
                          before={tryDecimal(m.priceMicros.before)}
                          after={tryDecimal(m.priceMicros.after)}
                          mono
                        />
                      </div>
                    )}
                    {m.currency && (
                      <div className="flex items-center gap-2 ml-1">
                        <span className="text-[10px] uppercase font-medium text-slate-500 w-16 flex-shrink-0">
                          Currency
                        </span>
                        <BeforeAfter before={m.currency.before} after={m.currency.after} mono />
                      </div>
                    )}
                  </li>
                ))}
                {prices.removed.map((p) => (
                  <li
                    key={`rem-${p.region}`}
                    className="flex items-center justify-between gap-2 p-2 rounded border border-red-200 bg-red-50/50"
                  >
                    <div className="flex items-center gap-2">
                      <ChangePill label="Remove" tone="rem" />
                      <span className="text-xs font-mono text-red-800">
                        {p.region}
                      </span>
                    </div>
                    <span className="text-xs font-mono text-red-700 line-through">
                      {tryDecimal(p.priceMicros)} {p.currency}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {submitError && (
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting || !hasChanges}
            className="px-4 py-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
          >
            {submitting ? "Updating…" : "Confirm update"}
          </button>
        </div>
      </div>
    </div>
  );
}
