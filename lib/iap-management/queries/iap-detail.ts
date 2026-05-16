/**
 * Apple real-time detail composer (IAP.o.8c).
 *
 * Used by the /view detail route — Manager wants the canonical Apple state
 * (not the local cache) when inspecting an IAP. The wrapped endpoint already
 * includes localizations + appStoreReviewScreenshot via `?include=...`, so
 * this helper just unpacks the JSON:API `included` array into typed buckets.
 *
 * Pricing schedule is intentionally not fetched here — its endpoint isn't
 * wrapped yet (Risk F4 deferral). The view page surfaces the local cached
 * tier_id, which is sufficient for Manager's current workflow.
 */

import type { AscCredentials } from "@/lib/asc-jwt";
import { getInAppPurchase } from "@/lib/iap-management/apple/client";
import type {
  InAppPurchase,
  InAppPurchaseLocalization,
  InAppPurchaseAppStoreReviewScreenshot,
  AscApiResponse,
} from "@/types/iap-management/apple";

export interface IapDetailFromApple {
  iap: InAppPurchase;
  localizations: InAppPurchaseLocalization[];
  screenshot: InAppPurchaseAppStoreReviewScreenshot | null;
}

export async function getIapDetailFromApple(
  creds: AscCredentials,
  appleIapId: string,
): Promise<IapDetailFromApple> {
  const res = await getInAppPurchase(creds, appleIapId);
  return splitIncluded(res);
}

/**
 * Pure helper exported for unit-testing — partitions `included` by type
 * with a defensive fallback when Apple returns the relationship object
 * without the matching `included` entry (links-only mode).
 */
export function splitIncluded(
  res: AscApiResponse<InAppPurchase>,
): IapDetailFromApple {
  const localizations: InAppPurchaseLocalization[] = [];
  let screenshot: InAppPurchaseAppStoreReviewScreenshot | null = null;

  for (const item of res.included ?? []) {
    if (item.type === "inAppPurchaseLocalizations") {
      localizations.push(item as unknown as InAppPurchaseLocalization);
    } else if (item.type === "inAppPurchaseAppStoreReviewScreenshots") {
      screenshot = item as unknown as InAppPurchaseAppStoreReviewScreenshot;
    }
  }

  return { iap: res.data, localizations, screenshot };
}
