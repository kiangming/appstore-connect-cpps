"use client";

/**
 * Availability section of the Edit Item form — surface C of per-territory
 * availability.
 *
 * Design: docs/iap-management/design-apple-per-territory-availability.md §G7.
 *
 * WHAT CHANGED IN SC5. Cycle 39 shipped two radios here: "Publish — all 175"
 * and "Remove from Sales". That surface could not express what Apple actually
 * held for a subset item, and the Edit page's derivation gave up and returned
 * null in exactly that case — so an item genuinely sold in 12 territories
 * rendered as though the state were unknown. The picker replaces the radios;
 * "all" and "none" are now two points on the same control rather than the only
 * two points that exist.
 *
 * ⚠ DEFAULT IS THE ITEM'S CURRENT TERRITORIES, not ALL (Manager decision 2 —
 * surfaces A and B default to ALL; C defaults to what the item already has).
 * Defaulting to ALL here would mean a Manager who opened the form to fix a
 * display name and pressed Update would silently widen the item to every
 * market.
 *
 * ⚠ THE TERRITORY LIST IS THREADED FROM THE SERVER, not read locally. The
 * Edit page already fetches both Apple's catalogue and the item's current
 * territories to render this section, so this costs no extra request — and it
 * guarantees the list shown is the list that will be sent.
 */

import { Loader2 } from "lucide-react";
import { TerritoryAvailabilityPicker } from "@/components/iap-management/territory/TerritoryAvailabilityPicker";
import {
  classifySelection,
  selectionsEqual,
  type TerritorySelection,
} from "@/lib/iap-management/apple/territory-selection";

export interface AvailabilitiesSectionProps {
  /** Current value in the form state. Null while the Apple read is unknown. */
  value: TerritorySelection | null;
  onChange: (next: TerritorySelection) => void;
  /**
   * The item's Apple-side selection as read at page render — the "Reset to
   * current" target and the comparison base for the pending-change note.
   * Null means Apple has no availability resource (Removed from Sale).
   */
  cached: TerritorySelection | null;
  /**
   * False when the Apple-side read FAILED. The section then refuses to render
   * a picker: pre-filling a guess that the Manager might push is worse than
   * saying we could not read it.
   */
  previousKnown: boolean;
  /** Apple's catalogue, threaded from the server component. */
  allTerritoryIds: readonly string[];
  /** The item's own base_territory, for the §G6 advisory. Never literal USA. */
  baseTerritory?: string | null;
}

export function AvailabilitiesSection({
  value,
  onChange,
  cached,
  previousKnown,
  allTerritoryIds,
  baseTerritory,
}: AvailabilitiesSectionProps) {
  const shell = (children: React.ReactNode) => (
    <section
      data-testid="availabilities-section"
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
    >
      <div className="px-6 pt-6 pb-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1 pb-2 border-b border-slate-100 dark:border-slate-800">
          Availability
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-2 mt-2">
          Where this in-app purchase can be sold. Changes here only push to
          Apple when you click <span className="font-medium">Update on Apple</span>.
        </p>
      </div>
      {children}
    </section>
  );

  // The read failed — say so rather than offering a control whose starting
  // point would be invented.
  if (!previousKnown) {
    return shell(
      <p
        data-testid="availabilities-unknown"
        className="mx-6 mb-6 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-3 text-[11px] text-amber-900 dark:text-amber-200"
      >
        Could not read this item&apos;s current availability from Apple, so
        there is nothing to edit against. Reload the page to try again — pushing
        a selection built on an unknown starting point could remove territories
        without showing you which.
      </p>,
    );
  }

  // Known, but Apple's catalogue is empty (the /v1/territories read failed).
  // Selecting from an empty list would show "0 of 0 selected" and send an
  // empty body — a Remove-from-Sale nobody asked for.
  if (allTerritoryIds.length === 0) {
    return shell(
      <p
        data-testid="availabilities-no-catalogue"
        className="mx-6 mb-6 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-3 text-[11px] text-amber-900 dark:text-amber-200"
      >
        Could not load Apple&apos;s country and region list, so territories
        cannot be chosen right now. Availability is unchanged. Reload to retry.
      </p>,
    );
  }

  if (!value) {
    return shell(
      <p className="mx-6 mb-6 flex items-center gap-2 text-[11px] text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading territories…
      </p>,
    );
  }

  const pending = cached
    ? !selectionsEqual(value, cached)
    : value.territoryIds.length > 0 || value.availableInNewTerritories;

  return shell(
    <div className="flex flex-col">
      <TerritoryAvailabilityPicker
        territoryIds={allTerritoryIds}
        value={value}
        onChange={onChange}
        resetTo={cached ?? { territoryIds: [], availableInNewTerritories: false }}
        baseTerritory={baseTerritory}
      />
      {pending && (
        <p
          data-testid="availabilities-pending"
          className="px-6 py-3 text-[11px] text-amber-600 dark:text-amber-400 font-medium border-t border-slate-100 dark:border-slate-800"
        >
          Change pending — {describeChange(cached, value, allTerritoryIds)} will
          be pushed to Apple on the next{" "}
          <span className="underline">Update on Apple</span>.
        </p>
      )}
    </div>,
  );
}

/**
 * A one-line "from → to", using the SelectionKind vocabulary so ALL and
 * ALL_FROZEN cannot read alike (KB §4.13).
 */
function describeChange(
  from: TerritorySelection | null,
  to: TerritorySelection,
  allIds: readonly string[],
): string {
  const label = (sel: TerritorySelection | null) => {
    if (!sel) return "no availability on Apple";
    switch (classifySelection(sel, allIds)) {
      case "ALL":
        return `all ${sel.territoryIds.length} (plus future markets)`;
      case "ALL_FROZEN":
        return `all ${sel.territoryIds.length} (future markets NOT included)`;
      case "NONE":
        return "removed from sale";
      case "SUBSET":
        return `${sel.territoryIds.length} of ${allIds.length}`;
    }
  };
  return `${label(from)} → ${label(to)}`;
}
