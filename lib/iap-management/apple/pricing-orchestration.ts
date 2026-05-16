/**
 * Pricing-schedule orchestration shared by single-IAP /create-on-apple and
 * the bulk-import /execute route.
 *
 * IAP.o.10a refactor: match by USD `customerPrice` (string from Apple,
 * number locally) instead of Apple's `priceTier` integer. Apple changed
 * priceTier numbering from "1,2,3..." to "10000,10001,..." in 2024 (dev
 * forum thread 728081) and legacy IAPs still return the old numbering —
 * `customerPrice` is the only stable join key.
 *
 * Apple's price-schedule POST needs two round-trips: list the IAP's price
 * points, find the one matching our USD price, then POST the schedule.
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
  findPricePointByUsdPrice,
} from "./price-points";
import { setPriceSchedule } from "./price-schedules";
import { AppleApiError } from "./fetch";

export type PricingOutcome =
  | {
      kind: "set";
      price_point_id: string;
      schedule_id: string;
      usd_price: number;
      attempts: number;
    }
  | { kind: "skipped-no-tier" }
  | { kind: "skipped-no-usd-price"; tier_id: string }
  | { kind: "skipped-no-match"; tier_id: string; usd_price: number }
  | { kind: "failed-lookup"; error: string }
  | {
      kind: "failed-set";
      tier_id: string;
      price_point_id: string;
      usd_price: number;
      error: string;
      attempts: number;
    };

export interface ApplyPricingArgs {
  creds: AscCredentials;
  appleIapId: string;
  /** Local tier id surfaced in audit log only — not the match key. */
  localTierId: string | null | undefined;
  /** USA/USD customer_price resolved by the caller from
   *  iap_mgmt.price_tier_territories. Canonical match key against Apple's
   *  customerPrice attribute. Null when the tier isn't in the local cache. */
  usdPrice: number | null | undefined;
  baseTerritory?: string;
}

/**
 * Apply the resolved USD price as Apple's manual price for the IAP. The
 * result `kind` discriminates the outcome — callers map it to an audit log
 * row + UI badge without rerunning Apple state transitions.
 */
export async function applyPricingSchedule(
  args: ApplyPricingArgs,
): Promise<PricingOutcome> {
  if (!args.localTierId) {
    return { kind: "skipped-no-tier" };
  }
  if (args.usdPrice === null || args.usdPrice === undefined) {
    return { kind: "skipped-no-usd-price", tier_id: args.localTierId };
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

  const match = findPricePointByUsdPrice(pricePoints, args.usdPrice);
  if (!match) {
    return {
      kind: "skipped-no-match",
      tier_id: args.localTierId,
      usd_price: args.usdPrice,
    };
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
      usd_price: args.usdPrice,
      error: setResult.error,
      attempts: setResult.attempts,
    };
  }
  return {
    kind: "set",
    price_point_id: match.id,
    schedule_id: setResult.schedule_id,
    usd_price: args.usdPrice,
    attempts: setResult.attempts,
  };
}
