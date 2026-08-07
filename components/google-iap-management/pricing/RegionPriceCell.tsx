"use client";

/**
 * Shared editable per-country price cell — the single choke point for
 * "type a price for one region" across the Google IAP module (P1).
 *
 * Extracted verbatim from UnifiedPricingTable's PricingRow (the item
 * detail view) so the Bulk Import custom-prices dialog renders the SAME
 * control rather than a second one. Two editors would drift; the module
 * already carries one such divergence (the detail view treats currency as
 * display-only, the older create-mode block lets you type it — see
 * design-bulk-import-custom-prices.md §1.1/§1.5), and this is the fix for
 * that class of problem, not another instance of it.
 *
 * ⚠ THIS COMPONENT PERFORMS NO VALIDATION — deliberately (§1.1).
 * It renders an `error` it is handed and nothing more. Validation comes
 * from `lib/google-iap-management/google/currency-precision.ts`
 * (validateDecimalForCurrency) and the throwing `decimalToMicros` on the
 * write path. Callers own that call. If validation were added here, a
 * caller that forgot to render the cell would silently skip it — the
 * detail view's own history: the form validates, the cell only displays.
 *
 * CURRENCY IS DISPLAY-ONLY. Each Google Play country has one fixed billing
 * currency, so it renders as a chip, never an input. Callers derive it
 * (template entry first, then Google's catalog); see §1.5.
 */
import { Trash2 } from "lucide-react";

interface Props {
  /** ISO 3166-1 alpha-2. Used for the default accessible labels. */
  regionCode: string;
  /** Derived from the country — rendered as a chip, never editable. */
  currency: string;
  priceDecimal: string;
  /** Pre-computed message from the caller's validation pass. */
  error?: string;
  onChange: (priceDecimal: string) => void;
  /** When provided, renders the trash affordance. Omit for surfaces where
   *  clearing isn't meaningful. */
  onClear?: () => void;
  disabled?: boolean;
  /** Defaults preserve the detail view's existing strings verbatim so the
   *  extraction is behaviour-neutral there; the bulk-import dialog passes
   *  its own wording. */
  ariaLabel?: string;
  clearAriaLabel?: string;
  placeholder?: string;
}

export function RegionPriceCell({
  regionCode,
  currency,
  priceDecimal,
  error,
  onChange,
  onClear,
  disabled = false,
  ariaLabel,
  clearAriaLabel,
  placeholder = "add override",
}: Props) {
  return (
    <>
      <div className="flex items-center gap-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded-lg border bg-white px-2 py-1 ${
            error ? "border-red-400" : "border-slate-300"
          }`}
        >
          <span className="text-[11px] font-semibold text-slate-500">
            {currency.toUpperCase()}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={priceDecimal}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="w-20 border-0 bg-transparent p-0 text-xs font-mono text-slate-900 placeholder:text-slate-300 focus:outline-none disabled:text-slate-400"
            aria-label={ariaLabel ?? `Tool price for ${regionCode}`}
          />
        </span>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="text-slate-300 hover:text-red-500 transition disabled:hover:text-slate-300"
            aria-label={clearAriaLabel ?? `Remove override for ${regionCode}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-[11px] text-red-500">{error}</p>}
    </>
  );
}
