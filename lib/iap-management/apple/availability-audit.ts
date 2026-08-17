/**
 * Availability audit provenance — action type + payload, in one place.
 *
 * ⚠ THE STATUS PRINCIPLE (P5). A tracking value must reflect the real
 * outcome, never the button that was clicked. Before per-territory
 * availability there were two buttons and two action types and the
 * mapping was trivial. Now a single "Choose territories" button can
 * produce any of three action types depending on what was actually sent,
 * so the decision is derived from the SELECTION — never from the caller's
 * UI mode. This module is the only place that decision is made.
 *
 * Why the odd-looking `const action_type = …` binding below: the P2
 * audit-guard scans source for action-type emissions, and
 * `action-type-binding` is one of the three shapes it recognises
 * (lib/audit-constraints/registry.ts). Returning the literals directly
 * from a `return` would be invisible to the scanner — the value would sit
 * in the CHECK constraint and in IAP_ACTION_TYPES, look fully wired, and
 * be reported as "declared but never emitted". Keeping the binding keeps
 * the guard honest.
 */

import type { IapActionType } from "@/lib/iap-management/action-types";
import {
  classifySelection,
  type TerritorySelection,
} from "./territory-selection";

/**
 * Which action_type this selection really is.
 *
 *   NONE        → AVAILABILITY_REMOVE_FROM_SALES
 *   ALL         → AVAILABILITY_SET_ALL_TERRITORIES  (full catalogue AND
 *                 availableInNewTerritories true — the genuine "All
 *                 countries or regions" case, so pre-existing rows keep
 *                 meaning exactly what they meant)
 *   ALL_FROZEN  → AVAILABILITY_SET_TERRITORIES      (every territory ticked
 *                 by hand: same ids, flag false — a DIFFERENT Apple
 *                 request, KB §4.13, so it must not borrow the "ALL" label)
 *   SUBSET      → AVAILABILITY_SET_TERRITORIES
 */
export function availabilityActionType(
  selection: TerritorySelection,
  allTerritoryIds: readonly string[],
): IapActionType {
  const kind = classifySelection(selection, allTerritoryIds);
  // ⚠ The kind comparisons are hoisted OUT of the binding below on
  // purpose. The P2 guard's `action-type-binding` shape harvests every
  // SCREAMING_SNAKE literal in the statement, so an inline
  // `kind === "NONE" ? …` makes it report "NONE" as an undeclared action
  // type — a false violation, which erodes trust in the guard exactly as
  // much as a missed one (the registry documents the same hazard for the
  // writeAuditRow window). Keeping the binding statement free of any
  // literal that is not an action type is the fix; widening the guard is
  // not.
  const isNone = kind === "NONE";
  const isGenuinelyAll = kind === "ALL";
  const action_type: IapActionType = isNone
    ? "AVAILABILITY_REMOVE_FROM_SALES"
    : isGenuinelyAll
      ? "AVAILABILITY_SET_ALL_TERRITORIES"
      : "AVAILABILITY_SET_TERRITORIES";
  return action_type;
}

/** What the caller knew about the item's availability BEFORE the write. */
export interface PreviousAvailability {
  territoryCount: number;
  availableInNewTerritories: boolean;
}

export interface AvailabilityAuditProvenance {
  /** The full list SENT, verbatim — not a diff, not a summary. */
  territories: string[];
  territory_count: number;
  available_in_new_territories: boolean;
  /** Absent when the pre-read failed or never happened. */
  previous_territory_count?: number;
  previous_available_in_new_territories?: boolean;
  /**
   * ⚠ HONESTY FLAG. `false` means nobody successfully read this item's
   * availability before the write, so the row cannot claim what changed.
   * It is never defaulted to a plausible number — a reader who sees
   * `previous_known: false` knows the delta is genuinely unknown rather
   * than silently reading 175 and believing it.
   */
  previous_known: boolean;
}

/**
 * Build the provenance block for an actions_log payload.
 *
 * Records the SENT list rather than a diff because the sent list is what
 * Apple applied; a diff would need the pre-read to be trustworthy, and
 * sometimes it isn't (see `previous_known`).
 */
export function availabilityAuditProvenance(
  selection: TerritorySelection,
  previous: PreviousAvailability | null | undefined,
): AvailabilityAuditProvenance {
  const base: AvailabilityAuditProvenance = {
    territories: [...selection.territoryIds],
    territory_count: selection.territoryIds.length,
    available_in_new_territories: selection.availableInNewTerritories,
    previous_known: previous != null,
  };
  if (previous == null) return base;
  return {
    ...base,
    previous_territory_count: previous.territoryCount,
    previous_available_in_new_territories: previous.availableInNewTerritories,
  };
}
