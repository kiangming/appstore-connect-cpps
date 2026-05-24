/**
 * Cycle 37 Phase 1 — Availabilities section for the View Detail page.
 *
 * Read-only count badge per Manager Q3.C. Mirrors Apple Connect's
 * pricing-page "Availability" row: a single line showing either
 *   • "All countries or regions"            (count === total, flag true)
 *   • "N of M countries or regions"         (subset)
 *   • "Removed from Sale"                   (no availability resource — 404)
 *   • "Couldn't fetch availability"         (non-404 Apple error)
 *
 * Cycle 39 Phase 1 — "Remove from Sales" red highlight per Manager Unit A:
 * when Apple reports the IAP has no salable territories, the section
 * renders with a red left border + red text so it's impossible to miss
 * at-a-glance. Other states keep the existing slate / emerald palette.
 *
 * Phase 2 (Unit C bulk modal) will add toolbar-level multi-select; the
 * trailing slot here stays empty per Cycle 37 Q4.C (Unit B Edit lives on
 * the Edit Item form, not this read-only view).
 */
import { Globe, AlertTriangle, MinusCircle } from "lucide-react";
import { SectionShell } from "@/components/ui/iap";
import type { AvailabilityView } from "@/lib/iap-management/queries/iap-detail";

export interface IapAvailabilitiesSectionProps {
  availabilityView: AvailabilityView | null;
  availabilityError: string | null;
}

interface DisplayState {
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  primary: string;
  secondary: string;
  /** Cycle 39 Phase 1 — true when state is "Removed from Sale". Drives
   *  the red border + red text emphasis. */
  removed: boolean;
}

/** Pure helper exported for unit-testing. Maps the resolved availability
 *  state to the visible icon + copy. */
export function pickDisplayState(
  view: AvailabilityView | null,
  error: string | null,
): DisplayState {
  if (error) {
    return {
      icon: AlertTriangle,
      iconClass: "text-amber-500",
      primary: "Couldn't fetch availability",
      secondary: error,
      removed: false,
    };
  }
  const availability = view?.availability ?? null;
  // "Removed from Sale" surface: either no availability resource (404 →
  // null) OR Apple returned an availability with zero territories.
  const removed =
    !availability ||
    (availability.territoryCount === 0 &&
      !availability.availableInNewTerritories);
  if (!availability) {
    return {
      icon: MinusCircle,
      iconClass: "text-red-600",
      primary: "Remove from Sales",
      secondary:
        "No availability set on Apple. Customers cannot purchase this in-app purchase in any country or region.",
      removed: true,
    };
  }
  const total = view?.totalTerritoryCount ?? 0;
  const count = availability.territoryCount;
  const allSelected =
    total > 0 && count >= total && availability.availableInNewTerritories;
  if (allSelected) {
    return {
      icon: Globe,
      iconClass: "text-emerald-600",
      primary: "All countries or regions",
      secondary: `Available in all ${total} Apple territories${
        availability.availableInNewTerritories
          ? " — including new markets Apple launches in the future"
          : ""
      }.`,
      removed: false,
    };
  }
  if (removed) {
    return {
      icon: MinusCircle,
      iconClass: "text-red-600",
      primary: "Remove from Sales",
      secondary:
        "Apple-side availability has zero salable territories. Customers cannot purchase this in-app purchase in any country or region.",
      removed: true,
    };
  }
  const denom = total > 0 ? total : Math.max(count, 1);
  return {
    icon: Globe,
    iconClass: "text-slate-500",
    primary: `${count} of ${denom} countries or regions`,
    secondary: availability.availableInNewTerritories
      ? "New Apple markets will be auto-included as Apple launches them."
      : "Excluded territories will remain unavailable unless added manually.",
    removed: false,
  };
}

export function IapAvailabilitiesSection({
  availabilityView,
  availabilityError,
}: IapAvailabilitiesSectionProps) {
  const { icon: Icon, iconClass, primary, secondary, removed } =
    pickDisplayState(availabilityView, availabilityError);
  return (
    <SectionShell
      title="Availability"
      description="Where this in-app purchase can be sold. Managed on Apple App Store Connect."
    >
      <div
        className={
          removed
            ? "flex items-start gap-3 rounded-lg border-l-4 border-red-500 bg-red-50 dark:bg-red-950/30 p-3"
            : "flex items-start gap-3"
        }
      >
        <div
          className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-full ${
            removed ? "bg-red-100 dark:bg-red-900/40" : "bg-slate-50"
          } ${iconClass}`}
        >
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0">
          <p
            className={
              removed
                ? "text-sm font-semibold text-red-700 dark:text-red-300"
                : "text-sm font-semibold text-slate-900"
            }
          >
            {primary}
          </p>
          <p
            className={
              removed
                ? "text-xs text-red-600 dark:text-red-400 mt-0.5"
                : "text-xs text-slate-500 mt-0.5"
            }
          >
            {secondary}
          </p>
        </div>
      </div>
    </SectionShell>
  );
}
