/**
 * Per-territory availability — the selection model, as pure data.
 *
 * WHY THIS MODULE EXISTS (LAYER-GAP)
 * The client decides what to *show* ("12 items will change"); the server
 * decides what to *write*. If those two answers come from two
 * implementations they will drift, and the feature stops existing for the
 * user in exactly the cases that matter. So both sides import THIS file:
 * the picker's live count, the replace-warning's change list, the audit
 * payload, and the orchestrator's own pre-write re-derivation are one
 * function each, used everywhere.
 *
 * Pure by construction — no Apple client, no React, no `iapFetch`. It is
 * imported by client components, so it must stay free of anything that
 * drags `lib/logger` (→ Node `fs`) into the browser bundle. Same
 * constraint `availability-classify.ts` documents.
 *
 * ⚠ NEVER TRANSFORM VALUES RECEIVED FROM APPLE. Territory ids are opaque
 * strings from `/v1/territories`. Nothing here upper-cases, trims,
 * normalises or re-encodes them; comparison sorts a *copy* so even the
 * caller's array order survives untouched. What Apple gave us is what we
 * send back.
 *
 * ⚠ THE FLAG IS NOT DERIVABLE FROM THE LIST (KB §4.13). Apple has no
 * `availableInAllTerritories`. `availableInNewTerritories` is
 * FORWARD-looking, so "All countries or regions" and "all 175 ticked by
 * hand" carry the SAME ids and DIFFERENT flags — two distinct requests.
 * That is why `TerritorySelection` carries the flag as its own field
 * rather than computing it from `territoryIds.length === allIds.length`.
 */

import type { AvailabilityForIap } from "./availabilities";

/** Exactly what a POST /v1/inAppPurchaseAvailabilities body needs. */
export interface TerritorySelection {
  /** Apple territory ids, verbatim. Order is not significant to Apple. */
  readonly territoryIds: readonly string[];
  /** Forward-looking flag — auto-include markets Apple launches later. */
  readonly availableInNewTerritories: boolean;
}

/**
 * The four shapes a selection can take, as Manager sees them.
 *
 * `ALL` and `ALL_FROZEN` hold the same ids and differ only in the flag —
 * they are deliberately distinct so a UI cannot render them identically
 * without that being a visible bug (KB §4.13).
 */
export type SelectionKind = "ALL" | "ALL_FROZEN" | "SUBSET" | "NONE";

/** "All countries or regions" — every territory, plus future markets. */
export function allTerritoriesSelection(
  allTerritoryIds: readonly string[],
): TerritorySelection {
  return {
    territoryIds: [...allTerritoryIds],
    availableInNewTerritories: true,
  };
}

/** "Remove from Sales" — zero territories, no future auto-include. */
export function noTerritoriesSelection(): TerritorySelection {
  return { territoryIds: [], availableInNewTerritories: false };
}

/**
 * An explicit hand-picked set. Defaults the flag to `false`: a Manager who
 * enumerated territories chose *these*, and silently opting them into
 * every future Apple market would be a decision the tool made for them.
 * Callers that genuinely want the flag pass it.
 */
export function subsetSelection(
  territoryIds: readonly string[],
  availableInNewTerritories = false,
): TerritorySelection {
  return { territoryIds: [...territoryIds], availableInNewTerritories };
}

/** Sorted copy — never mutates, never rewrites an id. */
function sortedCopy(ids: readonly string[]): string[] {
  return [...ids].sort();
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = sortedCopy(a);
  const sb = sortedCopy(b);
  return sa.every((id, i) => id === sb[i]);
}

/**
 * Classify against Apple's current catalogue.
 *
 * NB `ALL` vs `ALL_FROZEN` is the whole point — see the module header. A
 * caller that collapses them back into one bucket has reintroduced the
 * bug this module exists to prevent.
 */
export function classifySelection(
  selection: TerritorySelection,
  allTerritoryIds: readonly string[],
): SelectionKind {
  if (selection.territoryIds.length === 0) return "NONE";
  if (sameIdSet(selection.territoryIds, allTerritoryIds)) {
    return selection.availableInNewTerritories ? "ALL" : "ALL_FROZEN";
  }
  return "SUBSET";
}

/** True when two selections would produce byte-equal Apple request bodies. */
export function selectionsEqual(
  a: TerritorySelection,
  b: TerritorySelection,
): boolean {
  return (
    a.availableInNewTerritories === b.availableInNewTerritories &&
    sameIdSet(a.territoryIds, b.territoryIds)
  );
}

/** What replacing `current` with `next` actually does to one item. */
export interface SelectionDiff {
  /** False ⇒ the POST would be a no-op; skip the call entirely. */
  willChange: boolean;
  /** Territory ids present in `next` but not `current`. */
  added: string[];
  /** Territory ids present in `current` but not `next`. */
  removed: string[];
  /** The forward-looking flag alone changed. */
  flagChanged: boolean;
  /** Item count before, for the warning's "175 → 12" line. */
  previousCount: number;
  /** Item count after. */
  nextCount: number;
}

/**
 * Diff a live Apple read against an intended selection.
 *
 * `current === null` is Apple's "no availability resource" — the
 * Removed-from-Sale surface — and is treated as zero territories with the
 * flag off, matching `classifyAvailability`'s bucketing.
 *
 * ⚠ This does NOT model "unknown". A failed read is not `null`; callers
 * must keep those items in their own bucket rather than passing `null`
 * here, which would silently assert "it was removed" about an item nobody
 * managed to read. See `AvailabilitiesBulkModal.filterEligible`.
 */
export function diffSelection(
  current: AvailabilityForIap | null,
  next: TerritorySelection,
): SelectionDiff {
  const currentIds = current?.territoryIds ?? [];
  const currentFlag = current?.availableInNewTerritories ?? false;

  const nextSet = new Set(next.territoryIds);
  const currentSet = new Set(currentIds);

  const added = next.territoryIds.filter((id) => !currentSet.has(id));
  const removed = currentIds.filter((id) => !nextSet.has(id));
  const flagChanged = currentFlag !== next.availableInNewTerritories;

  return {
    willChange: added.length > 0 || removed.length > 0 || flagChanged,
    added,
    removed,
    flagChanged,
    previousCount: currentIds.length,
    nextCount: next.territoryIds.length,
  };
}

/**
 * Does this selection exclude the territory the item's prices are
 * calculated from? (Manager decision 4 — WARN, never block.)
 *
 * ⚠ The base is the item's own `iap_mgmt.iaps.base_territory`, NOT the
 * literal "USA". The column defaults to 'USA' but is per-item and every
 * real caller threads it (update-on-apple:269, create-on-apple:223,
 * custom-prices/baseline:214) — hardcoding USA here would be wrong for
 * any item whose base differs.
 *
 * ⚠ What this justifies saying is a CONFIGURATION fact ("prices are
 * calculated from X, which this selection excludes") and nothing more.
 * Whether Apple rejects, ignores or silently accepts a price in an
 * excluded territory is UNPROVEN (design gate G6, spec is silent). Copy
 * built on this predicate must not imply a consequence we cannot show.
 */
export function excludesBaseTerritory(
  selection: TerritorySelection,
  baseTerritory: string | null | undefined,
): boolean {
  if (!baseTerritory) return false;
  if (selection.territoryIds.length === 0) return false; // Remove-from-Sales is its own story
  return !selection.territoryIds.includes(baseTerritory);
}
