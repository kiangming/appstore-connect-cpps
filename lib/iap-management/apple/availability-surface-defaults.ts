/**
 * What each availability surface starts with. PURE.
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN THE PAGE
 * Manager decision 2 gives the three surfaces DIFFERENT defaults — A (bulk Set
 * Availabilities) and B (Bulk Import) open on ALL; C (Edit item) opens on the
 * item's CURRENT territories. That asymmetry is a policy, and it was living as
 * an inline expression inside an untested server component, which made the
 * single most consequential behaviour in the feature unreachable by any test:
 * if it silently became ALL, a Manager who opened the Edit form to fix a
 * display name and pressed Update would widen a 12-territory item to every
 * market, and nothing in the flow would say so — "no change" is exactly what
 * they would expect from not touching the section.
 *
 * Keeping it here means the default is asserted, and a mutation to it fails a
 * test rather than shipping.
 */

import {
  allTerritoriesSelection,
  type TerritorySelection,
} from "./territory-selection";

/**
 * Surface C — the individual Edit form.
 *
 * Opens on exactly what the item already has, so an untouched section pushes
 * nothing. A known-absent availability (Apple has no resource — Removed from
 * Sale) is the EMPTY selection, which is a real, editable starting point.
 *
 * Returns `null` when the Apple-side read FAILED. That is deliberately not a
 * selection: there is nothing honest to pre-fill, and the section renders the
 * unknown state instead of a guess the Manager might then push.
 */
export function editSurfaceDefaultSelection(
  current: TerritorySelection | null,
  previousKnown: boolean,
): TerritorySelection | null {
  if (!previousKnown) return null;
  return current ?? { territoryIds: [], availableInNewTerritories: false };
}

/**
 * Surfaces A and B — bulk Set Availabilities and Bulk Import.
 *
 * These open on ALL, which is safe there for a reason that does NOT apply to
 * surface C: both are explicit, deliberate acts on a chosen set of items, and
 * both put a confirm gate in front of the write. Surface C is a form a Manager
 * opens to change something else.
 */
export function bulkSurfaceDefaultSelection(
  allTerritoryIds: readonly string[],
): TerritorySelection {
  return allTerritoriesSelection(allTerritoryIds);
}
