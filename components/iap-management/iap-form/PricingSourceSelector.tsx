"use client";

import type { PricingSourceKind } from "@/lib/iap-management/validation";

interface Props {
  value: PricingSourceKind;
  onChange: (next: PricingSourceKind) => void;
  /** Manager uploaded a global Default Template (Settings → Pricing Templates). */
  defaultTemplateAvailable: boolean;
  /** This app has its own template (App detail page → Pricing Template section). */
  appTemplateAvailable: boolean;
  /** Entry counts surfaced in helper copy so Manager can gauge sparsity. */
  defaultTemplateEntryCount?: number;
  appTemplateEntryCount?: number;
}

/**
 * Q-D most-specific resolver: pick the most specific source the Manager has
 * actually uploaded. Used to initialise the form when neither caller passes
 * a prior selection. Returns "APPLE" when nothing is configured.
 */
export function defaultPricingSource(
  defaultTemplateAvailable: boolean,
  appTemplateAvailable: boolean,
): PricingSourceKind {
  if (appTemplateAvailable) return "APP_TEMPLATE";
  if (defaultTemplateAvailable) return "DEFAULT_TEMPLATE";
  return "APPLE";
}

/**
 * 3-radio pricing source selector. Gray-out disabled options with a helper
 * line explaining why; clicking a disabled radio is a no-op so the
 * keyboard-only path matches click semantics.
 */
export function PricingSourceSelector({
  value,
  onChange,
  defaultTemplateAvailable,
  appTemplateAvailable,
  defaultTemplateEntryCount,
  appTemplateEntryCount,
}: Props) {
  return (
    <fieldset className="space-y-2">
      <legend className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
        Pricing source *
      </legend>
      <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-2">
        Per-territory price overrides come from the selected source. Apple
        auto-equalizes territories that no template covers.
      </p>

      <Option
        kind="APPLE"
        title="Apple base data"
        helper="Single USA price-point POST. Apple auto-equalizes every other territory."
        checked={value === "APPLE"}
        onChange={onChange}
        disabled={false}
      />
      <Option
        kind="DEFAULT_TEMPLATE"
        title="Default Template"
        helper={
          defaultTemplateAvailable
            ? `Override per territory using the global Default Template (${defaultTemplateEntryCount ?? 0} entries).`
            : "No Default Template uploaded. Add one in Settings → Pricing Templates."
        }
        checked={value === "DEFAULT_TEMPLATE"}
        onChange={onChange}
        disabled={!defaultTemplateAvailable}
      />
      <Option
        kind="APP_TEMPLATE"
        title="App-specific template"
        helper={
          appTemplateAvailable
            ? `Override per territory using this app's custom template (${appTemplateEntryCount ?? 0} entries).`
            : "No template uploaded for this app yet. Add one on the app detail page."
        }
        checked={value === "APP_TEMPLATE"}
        onChange={onChange}
        disabled={!appTemplateAvailable}
      />
    </fieldset>
  );
}

function Option({
  kind,
  title,
  helper,
  checked,
  onChange,
  disabled,
}: {
  kind: PricingSourceKind;
  title: string;
  helper: string;
  checked: boolean;
  onChange: (next: PricingSourceKind) => void;
  disabled: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 rounded-lg border p-3 transition ${
        disabled
          ? "border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 cursor-not-allowed opacity-60"
          : checked
            ? "border-[#0071E3] bg-[#0071E3]/5 cursor-pointer"
            : "border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 cursor-pointer"
      }`}
    >
      <input
        type="radio"
        name="pricing_source"
        value={kind}
        checked={checked}
        disabled={disabled}
        onChange={() => !disabled && onChange(kind)}
        className="mt-0.5 accent-[#0071E3]"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {title}
        </div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
          {helper}
        </div>
      </div>
    </label>
  );
}
