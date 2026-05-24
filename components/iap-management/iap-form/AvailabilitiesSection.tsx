"use client";

/**
 * Cycle 39 Phase 1 Unit B — Availabilities Section 5 for the Edit Item form.
 *
 * Manager Q3.A locked the 2-radio surface to mirror Apple Connect's "Pricing
 * & Availability" tab:
 *   • Publish — Available in all 175 Apple countries / regions
 *   • Remove from Sales — Not available in any territory
 *
 * Pre-fill comes from the Apple-side availability fetch on the Edit page
 * server component (see `app/(dashboard)/.../iaps/[iapId]/page.tsx`). The
 * Manager's choice is isolated in `form.availability_target` so editing any
 * other field on the form does not implicitly touch availability — only an
 * explicit radio flip enters the diff.
 *
 * The orchestrator's Stage 5 (Availability) fires only when
 * `availability_target` differs from the cached Apple-side state, mirroring
 * the per-stage discipline of the other 4 IAP.o.12 stages. Manager's
 * confirmation modal surfaces the change before any Apple call is made.
 */

import { Globe, MinusCircle } from "lucide-react";
import type { AvailabilityTarget } from "@/lib/iap-management/validation";

export interface AvailabilitiesSectionProps {
  /** Current value in the form state. */
  value: AvailabilityTarget;
  /** The Apple-side state as last fetched — used to render a "current
   *  Apple state" subline under each radio so Manager sees both pre-fill +
   *  what would change. */
  cached: AvailabilityTarget;
  onChange: (next: AvailabilityTarget) => void;
}

export function AvailabilitiesSection({
  value,
  cached,
  onChange,
}: AvailabilitiesSectionProps) {
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1 pb-2 border-b border-slate-100 dark:border-slate-800">
        Availability
      </h2>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-4 mt-2">
        Where this in-app purchase can be sold. Changes here only push to
        Apple when you click <span className="font-medium">Update on Apple</span>.
      </p>

      <div className="space-y-2">
        <AvailabilityRadio
          id="availability-all"
          name="availability_target"
          checked={value === "ALL"}
          onSelect={() => onChange("ALL")}
          icon={Globe}
          iconClass="text-emerald-600"
          primary="Publish — Available in all countries or regions"
          secondary="Sell in every Apple territory plus any new market Apple launches in the future."
          currentBadge={cached === "ALL"}
        />
        <AvailabilityRadio
          id="availability-removed"
          name="availability_target"
          checked={value === "NONE"}
          onSelect={() => onChange("NONE")}
          icon={MinusCircle}
          iconClass="text-red-600"
          primary="Remove from Sales"
          secondary="Not available in any territory. Customers will be unable to purchase this in-app purchase."
          currentBadge={cached === "NONE"}
          tone="red"
        />
      </div>

      {value !== cached && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-3 font-medium">
          Change pending — will be pushed to Apple on the next{" "}
          <span className="underline">Update on Apple</span>.
        </p>
      )}
    </section>
  );
}

interface AvailabilityRadioProps {
  id: string;
  name: string;
  checked: boolean;
  onSelect: () => void;
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  primary: string;
  secondary: string;
  currentBadge: boolean;
  tone?: "red";
}

function AvailabilityRadio({
  id,
  name,
  checked,
  onSelect,
  icon: Icon,
  iconClass,
  primary,
  secondary,
  currentBadge,
  tone,
}: AvailabilityRadioProps) {
  const isRed = tone === "red";
  return (
    <label
      htmlFor={id}
      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition ${
        checked
          ? isRed
            ? "border-red-400 bg-red-50 dark:bg-red-950/30"
            : "border-[#0071E3] bg-blue-50/50 dark:bg-blue-950/20"
          : "border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40"
      }`}
    >
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="mt-1 h-4 w-4 cursor-pointer text-[#0071E3] focus:ring-[#0071E3]"
      />
      <div className={`flex h-7 w-7 items-center justify-center rounded-full bg-slate-50 dark:bg-slate-800 ${iconClass}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`text-sm font-medium ${
              isRed
                ? "text-red-700 dark:text-red-300"
                : "text-slate-900 dark:text-slate-100"
            }`}
          >
            {primary}
          </span>
          {currentBadge && (
            <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
              CURRENT
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          {secondary}
        </p>
      </div>
    </label>
  );
}
