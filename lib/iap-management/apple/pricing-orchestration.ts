/**
 * Pricing-schedule orchestration shared by single-IAP /create-on-apple and
 * the bulk-import /execute route (IAP.o.9a).
 *
 * Apple's price-schedule POST needs two round-trips: list the IAP's price
 * points, find the one matching the local tier_id, then POST the schedule.
 * This helper bundles those into one typed result.
 *
 * Failures are NEVER fatal — Manager workflow is "IAP created on Apple,
 * Manager fixes pricing later if needed." The orchestrator's job is to set
 * the price when possible, otherwise surface a precise reason so audit logs
 * + UI can show why.
 */
import type { AscCredentials } from "@/lib/asc-jwt";
import {
  listPricePointsForIap,
  findPricePointByTier,
} from "./price-points";
import { setPriceSchedule } from "./price-schedules";
import { AppleApiError } from "./fetch";

export type PricingOutcome =
  | { kind: "set"; price_point_id: string; schedule_id: string }
  | { kind: "skipped-no-tier" }
  | { kind: "skipped-no-match"; tier_id: string }
  | { kind: "failed-lookup"; error: string }
  | { kind: "failed-set"; tier_id: string; price_point_id: string; error: string };

export interface ApplyPricingArgs {
  creds: AscCredentials;
  appleIapId: string;
  localTierId: string | null | undefined;
  baseTerritory?: string;
}

/**
 * Apply the local `tier_id` as Apple's manual price for the IAP. The result
 * `kind` discriminates the outcome — callers map it to an audit log row +
 * UI badge without rerunning Apple state transitions.
 */
export async function applyPricingSchedule(
  args: ApplyPricingArgs,
): Promise<PricingOutcome> {
  if (!args.localTierId) {
    return { kind: "skipped-no-tier" };
  }

  let pricePoints;
  try {
    pricePoints = await listPricePointsForIap(
      args.creds,
      args.appleIapId,
      args.baseTerritory ?? "USA",
    );
  } catch (err) {
    return {
      kind: "failed-lookup",
      error: err instanceof AppleApiError
        ? `${err.status}: ${err.body.slice(0, 300)}`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }

  const match = findPricePointByTier(pricePoints, args.localTierId);
  if (!match) {
    return { kind: "skipped-no-match", tier_id: args.localTierId };
  }

  const setResult = await setPriceSchedule(args.creds, {
    appleIapId: args.appleIapId,
    applePricePointId: match.id,
    baseTerritory: args.baseTerritory ?? "USA",
  });
  if (!setResult.ok) {
    return {
      kind: "failed-set",
      tier_id: args.localTierId,
      price_point_id: match.id,
      error: setResult.error,
    };
  }
  return {
    kind: "set",
    price_point_id: match.id,
    schedule_id: setResult.schedule_id,
  };
}
