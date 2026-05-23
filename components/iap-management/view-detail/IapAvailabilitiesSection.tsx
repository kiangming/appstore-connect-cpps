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
 * Phase 2 (deferred) will add the Edit affordance + territory picker; the
 * trailing slot stays empty for now per Q4.C.
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
    };
  }
  const availability = view?.availability ?? null;
  if (!availability) {
    return {
      icon: MinusCircle,
      iconClass: "text-slate-400",
      primary: "Removed from Sale",
      secondary:
        "No availability set on Apple. Customers cannot purchase this in-app purchase in any country or region.",
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
  };
}

export function IapAvailabilitiesSection({
  availabilityView,
  availabilityError,
}: IapAvailabilitiesSectionProps) {
  const { icon: Icon, iconClass, primary, secondary } = pickDisplayState(
    availabilityView,
    availabilityError,
  );
  return (
    <SectionShell
      title="Availability"
      description="Where this in-app purchase can be sold. Managed on Apple App Store Connect."
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-slate-50 ${iconClass}`}
        >
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">{primary}</p>
          <p className="text-xs text-slate-500 mt-0.5">{secondary}</p>
        </div>
      </div>
    </SectionShell>
  );
}
