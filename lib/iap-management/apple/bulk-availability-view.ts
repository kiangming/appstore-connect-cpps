/**
 * Surface A view logic — the confirm buckets, the result partition, and what a
 * manual retry is allowed to touch. PURE.
 *
 * Design: docs/iap-management/design-apple-per-territory-availability.md
 * §C (confirm / replace warning) and §D (stop-and-resume).
 *
 * WHY THIS IS A MODULE AND NOT INLINE IN THE MODAL
 * Three of these decisions are the kind that pass every visual review and are
 * wrong anyway:
 *
 *   1. Whether an item "really changes" — computed with `diffSelection`, never
 *      a hand-rolled comparison (P1). A local id-length check would call
 *      "all ticked by hand" equal to "all territories" and hide a real write.
 *   2. Whether NOT_ATTEMPTED is its own state — merging it into `failed` is
 *      invisible in a screenshot and destroys the only safely-resumable
 *      bucket.
 *   3. What a retry re-sends — including a succeeded row would re-POST a
 *      write that already landed.
 *
 * Inline in an 850-line modal none of those are reachable by a test. Here each
 * is asserted, and the SC6 mutation-checks land on them.
 */

import { diffSelection, type TerritorySelection } from "./territory-selection";
import type { AvailabilityForIap } from "./availabilities";

/** Per-row outcome as the orchestrator reports it (bulk-availability.ts). */
export type BulkRowStatus = "SUCCESS" | "FAILED" | "NOT_ATTEMPTED";

export interface BulkRowResult {
  iapId: string;
  apple_iap_id?: string;
  status: BulkRowStatus;
  error?: string;
}

/**
 * The three result states, kept apart.
 *
 * ⚠ THESE MUST NEVER BE MERGED. `NOT_ATTEMPTED` means nothing was sent for
 * that item — it is the only bucket a blind resume can safely re-run. `FAILED`
 * means Apple was asked and refused, and SC3 locked the decision that those do
 * NOT auto-resume: a human reads the reason first. Folding them together makes
 * a retry either dangerously broad (re-sending failures nobody diagnosed) or
 * uselessly narrow (abandoning work that was never attempted).
 */
export interface ResultPartition {
  succeeded: BulkRowResult[];
  failed: BulkRowResult[];
  notAttempted: BulkRowResult[];
}

export function partitionResults(
  results: readonly BulkRowResult[],
): ResultPartition {
  return {
    succeeded: results.filter((r) => r.status === "SUCCESS"),
    failed: results.filter((r) => r.status === "FAILED"),
    notAttempted: results.filter((r) => r.status === "NOT_ATTEMPTED"),
  };
}

/**
 * What a manual retry may re-send: NOT_ATTEMPTED only.
 *
 * ⚠ Deliberately not "everything that isn't a success". A FAILED row carries a
 * reason (state guard, bad territory, Apple validation) that a blind re-send
 * would simply hit again — and SC3 requires a person to read it first.
 */
export function resumableIds(results: readonly BulkRowResult[]): string[] {
  return results
    .filter((r) => r.status === "NOT_ATTEMPTED")
    .map((r) => r.iapId);
}

/**
 * True when the run stopped early rather than finishing.
 *
 * ⚠ A stopped run is NOT a failed run (P5). Most of its items may have
 * succeeded; the remainder was abandoned on purpose to stop burning a spent
 * rate-limit budget. Rendering it as FAILED would tell the Manager to redo
 * work that already landed.
 */
export function isStoppedRun(overall: string): boolean {
  return overall === "STOPPED_RATE_LIMITED";
}

// ─── Confirm dialog buckets (§C) ─────────────────────────────────────────────

export interface ConfirmItem {
  appleIapId: string;
  productId: string;
  name: string;
}

export interface ConfirmChange extends ConfirmItem {
  previousCount: number;
  nextCount: number;
  added: number;
  removed: number;
}

/**
 * §C's three buckets, all of which are shown.
 *
 * `unknownExcluded` is the honest one. `filterEligible` already drops items
 * whose Apple read errored (AvailabilitiesBulkModal.tsx:734, shipped
 * behaviour) — so they are NOT written. The confirm dialog must SAY that,
 * naming them individually: silently narrowing the batch is how a Manager
 * comes to believe 50 items were updated when 48 were.
 */
export interface ConfirmBuckets {
  /** Items whose availability would actually change, with the numbers. */
  willChange: ConfirmChange[];
  /** Items already holding exactly this selection — no call will be made. */
  alreadyMatches: ConfirmItem[];
  /** Items excluded from the run because their Apple state could not be read. */
  unknownExcluded: ConfirmItem[];
}

export interface BuildConfirmBucketsArgs {
  /** The items `filterEligible` kept — the ones that will be written. */
  eligible: readonly ConfirmItem[];
  /** Items dropped because their Apple read failed. Named, never counted. */
  readErrored: readonly ConfirmItem[];
  /** Apple-side state per item, as read on open. */
  states: ReadonlyMap<string, AvailabilityForIap | null>;
  /** The one selection every targeted item will receive. */
  selection: TerritorySelection;
}

export function buildConfirmBuckets({
  eligible,
  readErrored,
  states,
  selection,
}: BuildConfirmBucketsArgs): ConfirmBuckets {
  const willChange: ConfirmChange[] = [];
  const alreadyMatches: ConfirmItem[] = [];

  for (const item of eligible) {
    // `diffSelection` owns the comparison — including the flag, which is not
    // derivable from the id list (KB §4.13).
    const d = diffSelection(states.get(item.appleIapId) ?? null, selection);
    if (!d.willChange) {
      alreadyMatches.push(item);
      continue;
    }
    willChange.push({
      ...item,
      previousCount: d.previousCount,
      nextCount: d.nextCount,
      added: d.added.length,
      removed: d.removed.length,
    });
  }

  return { willChange, alreadyMatches, unknownExcluded: [...readErrored] };
}

/** Nothing to do ⇒ offer no write at all (§C skip-when-nothing-to-do). */
export function hasWorkToConfirm(buckets: ConfirmBuckets): boolean {
  return buckets.willChange.length > 0;
}

// ─── Base-territory advisory (§G6) ───────────────────────────────────────────

export interface BaseAdvisoryGroup {
  /** The base territory these items price from. */
  baseTerritory: string;
  items: ConfirmItem[];
}

/**
 * Items whose OWN base territory falls outside the chosen selection, grouped
 * by that base.
 *
 * ⚠ `base_territory` is a per-item column, so a bulk batch can hold several
 * different bases. Grouping (rather than reporting one number, or assuming
 * "USA") is what lets the Manager know WHICH price schedules to look at — a
 * bare count is unactionable.
 *
 * ⚠ What this justifies SAYING is a configuration fact and nothing more.
 * Whether Apple rejects, ignores or parks a price in an excluded territory is
 * UNPROVEN (gate G6, the spec is silent), and surface A does not push prices
 * at all — so copy built on this must not imply an outcome.
 */
export function baseTerritoryAdvisory(
  items: readonly ConfirmItem[],
  selection: TerritorySelection,
  baseByAppleId: Readonly<Record<string, string>>,
): BaseAdvisoryGroup[] {
  // Remove-from-sale is its own story; an empty selection excludes every base
  // trivially and warning about it would be noise on top of a louder warning.
  if (selection.territoryIds.length === 0) return [];

  const chosen = new Set(selection.territoryIds);
  const byBase = new Map<string, ConfirmItem[]>();

  for (const item of items) {
    const base = baseByAppleId[item.appleIapId];
    // No recorded base ⇒ say nothing. Defaulting to "USA" would warn about a
    // territory we invented for this item.
    if (!base) continue;
    if (chosen.has(base)) continue;
    const bucket = byBase.get(base);
    if (bucket) bucket.push(item);
    else byBase.set(base, [item]);
  }

  return [...byBase.entries()]
    .map(([baseTerritory, group]) => ({ baseTerritory, items: group }))
    .sort((a, b) => a.baseTerritory.localeCompare(b.baseTerritory));
}

// ─── The request body (the LAYER-GAP seam) ───────────────────────────────────

export interface BulkAvailabilityRequestBody {
  iapIds: string[];
  action: "set-all" | "remove" | "set-territories";
  /** Present ONLY for "set-territories" — the route rejects it missing. */
  selection?: TerritorySelection;
  hub_run_id?: string | null;
}

/**
 * Build exactly what the modal POSTs.
 *
 * ⚠ WHY THIS IS A FUNCTION AND NOT AN INLINE OBJECT LITERAL.
 * SC6 part 1 found the fifth LAYER-GAP in this project: SC2's selection-driven
 * orchestrator and SC3's stop-and-resume were complete, and unreachable,
 * because the route's zod enum still listed two actions. Nothing caught it —
 * every test below the route called the orchestrator directly, so no test ever
 * put a body through the schema.
 *
 * Extracting the body makes that seam testable: a test can build the body the
 * modal really sends and push it through the real `POST`. If the selection goes
 * missing here, or the route stops accepting it, that test fails. An inline
 * literal inside the modal's `submit()` is reachable only by rendering the
 * modal AND stubbing fetch, which is exactly the setup that hid the gap.
 */
export function buildBulkAvailabilityRequestBody(args: {
  mode: "set-all" | "remove" | "set-territories";
  iapIds: string[];
  /** Required when mode === "set-territories". */
  selection: TerritorySelection | null;
  hubRunId: string | null;
}): BulkAvailabilityRequestBody {
  const { mode, iapIds, selection, hubRunId } = args;
  const body: BulkAvailabilityRequestBody = {
    iapIds,
    action: mode,
    hub_run_id: hubRunId,
  };
  if (mode === "set-territories") {
    if (!selection) {
      // Fail loudly here rather than posting a body the route will 400 on with
      // a message about a field the Manager never saw.
      throw new Error(
        'buildBulkAvailabilityRequestBody: "set-territories" requires a selection',
      );
    }
    // Verbatim — the ids are Apple's and the flag is not derivable from them.
    body.selection = {
      territoryIds: selection.territoryIds,
      availableInNewTerritories: selection.availableInNewTerritories,
    };
  }
  return body;
}
