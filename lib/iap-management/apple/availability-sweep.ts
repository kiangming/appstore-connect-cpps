/**
 * [EXPORT-availability-filter] C4 — the availability sweep behind
 * "Refresh from Apple".
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Census M3 caught the tool and its Manager describing the same button
 * differently. The Manager's model was "Refresh from Apple re-fetches
 * everything, including Available/Removed". The code fetched Apple's IAP list
 * and wrote `state` — availability was never asked for, on that path or any
 * other. The list column filled in one row at a time as the Manager scrolled,
 * kept nothing, and re-read Apple on the next visit.
 *
 * This module makes the button do what it was already believed to do, and in
 * doing so gives `[Q-EXPORT-avail.mirror]` the thing it needs to stand up: an
 * explicit refresh action. Without one, "as of last sync" would only ever be
 * able to say "very old", because nothing would ever make it new.
 *
 * ─── THE COST, STATED PLAINLY ──────────────────────────────────────────────
 *
 * `ceil(N/200)` list requests (already paid by the state sync — this rides on
 * the same call) **+ 1 request per item**. For N=500 that is ~503 requests,
 * about 14% of the measured 3,600/hour budget (KB §4.9).
 *
 * One request per item, not two, because the list is asked for
 * `?include=inAppPurchaseAvailability`, which hands over the availability
 * resource id and the `availableInNewTerritories` flag for free — the two
 * things `getAvailabilityForIap`'s Step A exists to fetch
 * ([EXPORT-avail-read-halving], measured 9/9 in design PART 1.5).
 *
 * ⚠ It is not free, and this is not an optimisation of something that used to
 * be cheaper. It converts a cost that was being paid repeatedly and thrown
 * away into one paid deliberately and kept.
 *
 * ⚠ AND THE INCLUDE STILL CANNOT CLASSIFY. See
 * `availabilityIdFromListedIap` — presence of the relationship says nothing
 * about availability, and reading it as "available" is the U3 defect. Every
 * verdict below comes from a territory count.
 *
 * ─── STOP AND PRESERVE ─────────────────────────────────────────────────────
 *
 * Decision 3, the same rule the write side and A′'s read phase already follow.
 * A 429 that survives `withRetry`'s whole backoff curve predicts that the next
 * call fails too, so the sweep stops dispatching rather than spending the rest
 * of the hour proving it. Three outcomes, and they mean different things:
 *
 *   read      → we know this item's territories. Mirror gets written.
 *   failed    → Apple was asked and refused. NOT written. The item keeps its
 *               previous verdict and its previous timestamp, however old.
 *   notRead   → nothing was sent, because the sweep had already stopped.
 *               Safe to retry blindly, and equally untouched.
 *
 * ⚠ THE ONLY ITEMS THAT GET A NEW TIMESTAMP ARE THE ONES ACTUALLY READ. There
 * is no "mark the rest as checked" branch and there must never be one: an
 * as-of label is a claim about when Apple was asked, and stamping it on an
 * item nobody asked about is the label lying about exactly the data it exists
 * to date. A stopped sweep leaving half the app on yesterday's timestamp is
 * the correct, visible outcome.
 */

import type { AscCredentials } from "@/lib/asc-jwt";
import { runStoppablePool } from "@/lib/iap-management/stoppable-pool";
import { withRetry, AppleRateLimitError } from "./fetch";
import {
  availabilityFlagsFromIncluded,
  availabilityIdFromListedIap,
  getAvailabilityByIdForIap,
  getAvailabilityForIap,
  type AvailabilityForIap,
} from "./availabilities";
import type { AscApiResponse, InAppPurchase } from "@/types/iap-management/apple";

/**
 * Matches `bulk-availability`'s DEFAULT_CONCURRENCY and Hotfix 26's Bulk
 * Import. Not an independent judgement — the same Apple budget, so the same
 * number, and a comment here rather than a second opinion.
 */
const DEFAULT_CONCURRENCY = 2;

export interface SweepTarget {
  /** Internal `iap_mgmt.iaps.id` — what the mirror is keyed on. */
  iapId: string;
  appleIapId: string;
  /**
   * The availability resource id, if the list handed it over. `null` means we
   * did not get it cheaply and the item costs the full 2-request read — NOT
   * that the item has no availability.
   */
  availabilityId: string | null;
  /** From `included[]`; false when unknown, and only ever used as a value to
   *  carry through, never as evidence of anything. */
  availableInNewTerritories: boolean;
}

export interface SweepOutcome {
  iapId: string;
  appleIapId: string;
  status: "READ" | "FAILED" | "NOT_ATTEMPTED";
  observed?: AvailabilityForIap | null;
  error?: string;
}

export interface AvailabilitySweepResult {
  outcomes: SweepOutcome[];
  /** Items whose verdict is known and may be written to the mirror. */
  read: Array<{ iapId: string; observed: AvailabilityForIap | null }>;
  readCount: number;
  failedCount: number;
  notAttemptedCount: number;
  /** True when rate-limit exhaustion ended the sweep early. */
  stoppedByRateLimit: boolean;
}

/**
 * Turn a list response (fetched WITH `includeAvailability`) into sweep targets.
 * PURE.
 *
 * ⚠ Items with no internal row are dropped, because the mirror is keyed on the
 * internal id and there is nowhere to put their answer. On the IAP list page
 * this set is empty in practice — the page seeds a stub for every Apple item
 * before rendering (`seedMissingIapStubs`) — but dropping is still the right
 * behaviour rather than an assumption that it never happens.
 */
export function buildSweepTargets(args: {
  listed: readonly InAppPurchase[];
  included: AscApiResponse<InAppPurchase[]>["included"];
  /** Apple IAP id → internal `iaps.id`. */
  internalByAppleId: ReadonlyMap<string, string>;
}): SweepTarget[] {
  const flags = availabilityFlagsFromIncluded(args.included);
  const targets: SweepTarget[] = [];
  for (const iap of args.listed) {
    const iapId = args.internalByAppleId.get(iap.id);
    if (!iapId) continue;
    const availabilityId = availabilityIdFromListedIap(iap);
    targets.push({
      iapId,
      appleIapId: iap.id,
      availabilityId,
      availableInNewTerritories: availabilityId
        ? (flags.get(availabilityId) ?? false)
        : false,
    });
  }
  return targets;
}

export interface RunAvailabilitySweepArgs {
  creds: AscCredentials;
  targets: readonly SweepTarget[];
  concurrency?: number;
  /**
   * Injected for tests. Defaults to the real Apple read: Step B alone when the
   * list supplied an availability id, the full 2-request read otherwise.
   */
  readOne?: (target: SweepTarget) => Promise<AvailabilityForIap | null>;
}

export async function runAvailabilitySweep(
  args: RunAvailabilitySweepArgs,
): Promise<AvailabilitySweepResult> {
  const { creds, targets } = args;
  const concurrency = args.concurrency ?? DEFAULT_CONCURRENCY;
  const readOne = args.readOne ?? ((target) => defaultReadOne(creds, target));

  if (targets.length === 0) {
    return {
      outcomes: [],
      read: [],
      readCount: 0,
      failedCount: 0,
      notAttemptedCount: 0,
      stoppedByRateLimit: false,
    };
  }

  const { results, stopped } = await runStoppablePool<SweepTarget, SweepOutcome>({
    items: targets,
    concurrency,
    // ⚠ Narrow on purpose. Only a 429 that already survived `withRetry`'s full
    //   curve stops the sweep; an ordinary Apple error is this item's problem
    //   and says nothing about the next one (Q-K fail-soft).
    shouldStop: (err) => err instanceof AppleRateLimitError,
    skipped: (target) => ({
      iapId: target.iapId,
      appleIapId: target.appleIapId,
      status: "NOT_ATTEMPTED",
    }),
    run: async (target) => {
      const observed = await readOne(target);
      return {
        iapId: target.iapId,
        appleIapId: target.appleIapId,
        status: "READ",
        observed,
      };
    },
    onError: async (target, err) => {
      if (err instanceof AppleRateLimitError) {
        console.warn(
          `[availability-sweep] STOP — Apple rate limit exhausted on iap=${target.appleIapId}; remaining items will not be read`,
        );
      }
      return {
        iapId: target.iapId,
        appleIapId: target.appleIapId,
        status: "FAILED",
        error: err instanceof Error ? err.message : String(err),
      };
    },
  });

  // ⚠ `read` carries ONLY the READ rows. FAILED and NOT_ATTEMPTED are absent
  //   from it by construction, which is how the caller is prevented from
  //   accidentally stamping a timestamp on an item Apple never answered for.
  const read = results
    .filter((r) => r.status === "READ")
    .map((r) => ({ iapId: r.iapId, observed: r.observed ?? null }));

  return {
    outcomes: results,
    read,
    readCount: read.length,
    failedCount: results.filter((r) => r.status === "FAILED").length,
    notAttemptedCount: results.filter((r) => r.status === "NOT_ATTEMPTED").length,
    stoppedByRateLimit: stopped,
  };
}

/**
 * One item's read.
 *
 * ⚠ EXACTLY ONE `withRetry`, over retry-naive leaves. Both
 * `getAvailabilityByIdForIap` and `getAvailabilityForIap` call `iapFetch`,
 * which throws `AppleRateLimitError` and never retries itself
 * (fetch.ts:13-17). A second wrapper here would turn 4 attempts into 16 and
 * make "rate limited" mean something different on this path than everywhere
 * else — which is the one thing the stop latch depends on.
 *
 * ⚠ The `availabilityId === null` fallback pays 2 requests rather than
 * guessing. Apple has never been observed to omit the relationship (0/29), so
 * this branch is expected to be dead — but a dead branch that reads correctly
 * costs nothing, and the alternative is inventing a verdict from a missing id.
 */
async function defaultReadOne(
  creds: AscCredentials,
  target: SweepTarget,
): Promise<AvailabilityForIap | null> {
  if (target.availabilityId) {
    return withRetry(() =>
      getAvailabilityByIdForIap(
        creds,
        target.availabilityId!,
        target.availableInNewTerritories,
      ),
    );
  }
  return withRetry(() => getAvailabilityForIap(creds, target.appleIapId));
}
